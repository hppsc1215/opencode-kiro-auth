import { createHash } from 'node:crypto'
import { hostname, platform, release, userInfo } from 'node:os'
import { KIRO_CONSTANTS } from '../constants.js'

/**
 * Kiro IDE client identity (CodeWhisperer / Amazon Q runtime).
 *
 * AWS gates the runtime endpoints on the Kiro IDE version embedded in the
 * `User-Agent` header: it must carry `KiroIDE-<version>-<machineId>`. Builds
 * below the retirement floor are answered with
 *
 *   HTTP 403 {"message":"This version of Kiro is no longer supported.
 *             Please update to the latest version of Kiro to continue.",
 *             "reason":"FEATURE_NOT_SUPPORTED"}
 *
 * The November 2026 retirement wave removed every build below 0.11.133. An
 * unversioned `KiroIDE` suffix is rejected the same way, because it carries no
 * parsable version at all.
 *
 * `x-amz-user-agent` is not gated, but it is kept in the same fingerprint
 * shape so both headers stay consistent.
 *
 * Keep KIRO_IDE_VERSION at (or above) the newest published Kiro IDE release
 * from https://kiro.dev/downloads. A stale value breaks chat, usage requests
 * and the credit badge at the same time.
 */
export const KIRO_IDE_VERSION = '1.4.121'

/** Lowest Kiro IDE build AWS has retired; the pin must stay above it. */
export const KIRO_RETIRED_FLOOR = '0.11.133'

const MACHINE_ID_SALT = 'opencode-kiro-auth'

export interface KiroClientIdentity {
  /** Full `User-Agent` value for Kiro runtime requests. */
  userAgent: string
  /** Matching `x-amz-user-agent` value. */
  amzUserAgent: string
  /** The versioned `KiroIDE-<version>-<machineId>` token. */
  ideToken: string
  /** Stable per-connection machine id. */
  machineId: string
}

export interface KiroIdentitySeedSource {
  email?: string
  profileArn?: string
  clientId?: string
  authMethod?: string
}

/**
 * Derive a stable seed for one Kiro connection. profileArn survives re-auth
 * (the IdC clientId rotates), so it wins over the email fallback.
 */
export function kiroIdentitySeed(auth: KiroIdentitySeedSource): string {
  return auth.profileArn || auth.email || auth.clientId || auth.authMethod || 'default'
}

function safeUsername(): string {
  try {
    return userInfo().username || 'unknown'
  } catch {
    return 'unknown'
  }
}

function stableMachineId(seed?: string): string {
  const source = seed || `${hostname()}:${safeUsername()}`
  return createHash('sha256').update(`${MACHINE_ID_SALT}:${source}`).digest('hex')
}

function runtimeOs(): string {
  const p = platform()
  const osName = p === 'win32' ? 'windows' : p === 'darwin' ? 'macos' : p
  return `${osName}#${release()}`
}

/**
 * Build the versioned client fingerprint for one connection. Same seed yields
 * the same machine id across restarts, so Kiro sees a stable client.
 */
export function buildKiroClientIdentity(seed?: string): KiroClientIdentity {
  const machineId = stableMachineId(seed)
  const ideToken = `KiroIDE-${KIRO_IDE_VERSION}-${machineId}`
  const sdkVersion = KIRO_CONSTANTS.SDK_VERSION
  const nodeVersion = process.version.replace(/^v/, '')

  return {
    machineId,
    ideToken,
    userAgent:
      `aws-sdk-js/${sdkVersion} ua/2.1 os/${runtimeOs()} ` +
      `lang/js md/nodejs#${nodeVersion} api/codewhisperer#${sdkVersion} ` +
      `m/E ${ideToken}`,
    amzUserAgent: `aws-sdk-js/${sdkVersion} ${ideToken}`
  }
}

/** Convenience wrapper for call sites that already hold a connection. */
export function buildKiroClientIdentityFor(auth: KiroIdentitySeedSource): KiroClientIdentity {
  return buildKiroClientIdentity(kiroIdentitySeed(auth))
}
