import { describe, expect, test } from 'bun:test'
import { isLongContextModel, normalizeRegion, SUPPORTED_MODELS } from '../constants.js'

describe('isLongContextModel', () => {
  test('returns true for all 1m model variants (explicit -1m suffix)', () => {
    const explicit1m = SUPPORTED_MODELS.filter((k) => k.includes('-1m'))
    expect(explicit1m.length).toBeGreaterThan(0)
    for (const model of explicit1m) {
      expect(isLongContextModel(model)).toBe(true)
    }
  })

  test('returns true for base Claude models with 1M context (not -1m suffixed)', () => {
    const base1mClaude = [
      'claude-opus-4-6',
      'claude-opus-4-6-thinking',
      'claude-opus-4-7',
      'claude-opus-4-7-thinking',
      'claude-opus-4-8',
      'claude-opus-4-8-thinking',
      'claude-opus-5',
      'claude-opus-5-thinking',
      'claude-opus-5-5',
      'claude-opus-5-5-thinking',
      'claude-sonnet-4-6',
      'claude-sonnet-4-6-thinking',
      'claude-sonnet-5',
      'claude-sonnet-5-thinking',
      'claude-sonnet-5-5',
      'claude-sonnet-5-5-thinking',
      'claude-fable-5-1',
      'claude-fable-5-1-thinking'
    ]
    for (const model of base1mClaude) {
      expect(isLongContextModel(model), `${model} has 1M context`).toBe(true)
    }
  })

  test('returns false for standard context models (base Clauds with 200K)', () => {
    const standard200k = [
      'claude-opus-4-5',
      'claude-opus-4-5-thinking',
      'claude-sonnet-4-5',
      'claude-sonnet-4-5-thinking',
      'claude-sonnet-4',
      'claude-haiku-4-5'
    ]
    for (const model of standard200k) {
      expect(isLongContextModel(model), `${model} has 200K context`).toBe(false)
    }
  })

  test('returns false for non-Claude models', () => {
    const nonClaude = [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'deepseek-3.2',
      'minimax-m2.5',
      'glm-5',
      'qwen3-coder-next',
      'auto'
    ]
    for (const model of nonClaude) {
      expect(isLongContextModel(model), `${model} should not be marked as long context`).toBe(false)
    }
  })

  test('returns false for unknown model strings', () => {
    expect(isLongContextModel('unknown-model')).toBe(false)
    expect(isLongContextModel('')).toBe(false)
  })
})

describe('normalizeRegion', () => {
  test('accepts configured AWS regions with the installed Zod enum shape', () => {
    expect(normalizeRegion('us-west-2')).toBe('us-west-2')
  })
})
