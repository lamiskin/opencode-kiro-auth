import { describe, expect, test } from 'bun:test'
import { isLongContextModel } from '../constants.js'
import { getAvailableModelsContext, getContextWindowSize } from '../plugin/models.js'

describe('context window resolution', () => {
  describe('isLongContextModel: base vs explicit -1m distinction', () => {
    test('returns true for explicit -1m variant IDs', () => {
      const explicit1m = [
        'claude-opus-4-6-1m',
        'claude-opus-4-6-1m-thinking',
        'claude-sonnet-4-5-1m',
        'claude-sonnet-4-5-1m-thinking',
        'claude-sonnet-5-1m',
        'claude-sonnet-5-1m-thinking'
      ]
      for (const model of explicit1m) {
        expect(isLongContextModel(model), `${model} should be long context`).toBe(true)
      }
    })

    test('returns true for base Claude IDs with 1M context (not -1m suffixed)', () => {
      const base1m = [
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
      for (const model of base1m) {
        expect(isLongContextModel(model), `${model} (base 1M) should be long context`).toBe(true)
      }
    })

    test('returns false for base Claude IDs with standard (200K) context', () => {
      const base200k = [
        'claude-opus-4-5',
        'claude-opus-4-5-thinking',
        'claude-sonnet-4-5',
        'claude-sonnet-4-5-thinking',
        'claude-sonnet-4',
        'claude-haiku-4-5'
      ]
      for (const model of base200k) {
        expect(isLongContextModel(model), `${model} (base 200K) should not be long context`).toBe(
          false
        )
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
        'qwen3-coder-next'
      ]
      for (const model of nonClaude) {
        expect(isLongContextModel(model), `${model} (non-Claude) should not be long context`).toBe(
          false
        )
      }
    })
  })

  describe('getContextWindowSize: runtime vs static fallback', () => {
    test('prefers runtime context from ListAvailableModels when available', () => {
      // Simulate runtime context being set (normally done by refreshContextWindowSizes)
      // For now, we just verify the function exists and can be called
      const ctx = getAvailableModelsContext()
      expect(ctx).toBeDefined()
      expect(ctx instanceof Map).toBe(true)
    })

    test('falls back to static catalog for models without runtime context', () => {
      // Base 1M Clauds should return 1M from static fallback
      expect(getContextWindowSize('claude-opus-5')).toBe(1000000)
      expect(getContextWindowSize('claude-sonnet-5')).toBe(1000000)
      expect(getContextWindowSize('claude-fable-5-1')).toBe(1000000)

      // Base 200K Clauds should return 200K
      expect(getContextWindowSize('claude-opus-4-5')).toBe(200000)
      expect(getContextWindowSize('claude-sonnet-4-5')).toBe(200000)
      expect(getContextWindowSize('claude-haiku-4-5')).toBe(200000)
    })

    test('explicit -1m variants advertise 1M context', () => {
      expect(getContextWindowSize('claude-opus-4-6-1m')).toBe(1000000)
      expect(getContextWindowSize('claude-sonnet-4-5-1m')).toBe(1000000)
      expect(getContextWindowSize('claude-sonnet-5-1m')).toBe(1000000)
    })

    test('returns 200K default for unknown models', () => {
      expect(getContextWindowSize('unknown-model')).toBe(200000)
    })
  })
})
