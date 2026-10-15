import { describe, expect, test } from 'bun:test'
import { isLongContextModel, normalizeRegion, SUPPORTED_MODELS } from '../constants.js'

describe('isLongContextModel', () => {
  test('returns true for 1m model variants and 5.5 models', () => {
    const expected1m = [
      ...SUPPORTED_MODELS.filter((k) => k.includes('-1m')),
      'claude-opus-5-5',
      'claude-opus-5-5-thinking',
      'claude-opus-5.5',
      'claude-opus-5.5-thinking',
      'claude-sonnet-5-5',
      'claude-sonnet-5-5-thinking',
      'claude-sonnet-5.5',
      'claude-sonnet-5.5-thinking'
    ]
    expect(expected1m.length).toBeGreaterThan(0)
    for (const model of expected1m) {
      expect(isLongContextModel(model)).toBe(true)
    }
  })

  test('returns false for standard context models', () => {
    const standard = ['auto', 'claude-sonnet-4', 'claude-haiku-4-5', 'glm-5']
    for (const model of standard) {
      expect(isLongContextModel(model)).toBe(false)
    }
  })

  test('returns false for unknown model strings', () => {
    expect(isLongContextModel('unknown-model')).toBe(false)
    expect(isLongContextModel('')).toBe(false)
    expect(isLongContextModel('claude-sonnet-4-6')).toBe(false)
  })
})

describe('normalizeRegion', () => {
  test('accepts configured AWS regions with the installed Zod enum shape', () => {
    expect(normalizeRegion('us-west-2')).toBe('us-west-2')
  })
})
