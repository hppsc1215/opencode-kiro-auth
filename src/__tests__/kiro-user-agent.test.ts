import { describe, expect, test } from 'bun:test'
import {
  KIRO_IDE_VERSION,
  KIRO_RETIRED_FLOOR,
  buildKiroClientIdentity,
  kiroIdentitySeed
} from '../plugin/kiro-user-agent.js'
import { transformToCodeWhisperer } from '../plugin/request.js'
import type { KiroAuthDetails } from '../plugin/types.js'

function versionParts(value: string): number[] {
  return value.split('.').map((part) => Number.parseInt(part, 10))
}

function isAtLeast(actual: string, floor: string): boolean {
  const a = versionParts(actual)
  const b = versionParts(floor)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  return true
}

const MACHINE_ID = '[a-f0-9]{64}'
const FINGERPRINT = new RegExp(`KiroIDE-${KIRO_IDE_VERSION.replace(/\./g, '\\.')}-${MACHINE_ID}`)

function makeAuth(): KiroAuthDetails {
  return {
    refresh: 'refresh|desktop',
    access: 'access-token',
    expires: Date.now() + 3600_000,
    authMethod: 'idc',
    region: 'eu-central-1',
    email: 'user@example.com',
    profileArn: 'arn:aws:codewhisperer:eu-central-1:000000:profile/ABC'
  }
}

describe('Kiro client identity', () => {
  test('pins a Kiro IDE version above the retired floor', () => {
    expect(isAtLeast(KIRO_IDE_VERSION, KIRO_RETIRED_FLOOR)).toBe(true)
  })

  test('builds a versioned KiroIDE fingerprint with a stable machine id', () => {
    const first = buildKiroClientIdentity('connection-a')
    const second = buildKiroClientIdentity('connection-a')
    const other = buildKiroClientIdentity('connection-b')

    expect(first.userAgent).toMatch(FINGERPRINT)
    expect(first.amzUserAgent).toMatch(FINGERPRINT)
    expect(first.userAgent).toBe(second.userAgent)
    expect(first.amzUserAgent).toBe(second.amzUserAgent)
    expect(other.userAgent).not.toBe(first.userAgent)
  })

  test('keeps both headers on the same fingerprint token', () => {
    const identity = buildKiroClientIdentity('connection-a')
    expect(identity.userAgent.endsWith(identity.ideToken)).toBe(true)
    expect(identity.amzUserAgent.endsWith(identity.ideToken)).toBe(true)
    expect(identity.ideToken).toBe(`KiroIDE-${KIRO_IDE_VERSION}-${identity.machineId}`)
  })

  test('derives a stable seed from the connection identity', () => {
    expect(kiroIdentitySeed({ profileArn: 'arn:profile', email: 'a@b.c' })).toBe('arn:profile')
    expect(kiroIdentitySeed({ email: 'a@b.c', clientId: 'client' })).toBe('a@b.c')
    expect(kiroIdentitySeed({ clientId: 'client', authMethod: 'idc' })).toBe('client')
    expect(kiroIdentitySeed({ authMethod: 'desktop' })).toBe('desktop')
  })

  test('sends the fingerprint on the raw chat request path', () => {
    const auth = makeAuth()
    const prep = transformToCodeWhisperer(
      'https://q.eu-central-1.amazonaws.com/generateAssistantResponse',
      { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] },
      'claude-haiku-4-5',
      auth
    )

    const expected = buildKiroClientIdentity(kiroIdentitySeed(auth))
    const headers = prep.init.headers as Record<string, string>

    expect(headers['user-agent']).toBe(expected.userAgent)
    expect(headers['x-amz-user-agent']).toBe(expected.amzUserAgent)
    expect(headers['user-agent']).toMatch(FINGERPRINT)
  })
})
