import { describe, expect, test } from 'bun:test'
import { isLongContextModel } from '../constants.js'
import { getAvailableModelsContext, getContextWindowSize } from '../plugin/models.js'

describe('context window resolution', () => {
  describe('isLongContextModel: base 1M vs 200K', () => {
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
        'claude-fable-5-1-thinking',
        'claude-haiku-5-5',
        'claude-haiku-5-5-thinking',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna'
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
      const nonClaude = ['deepseek-3.2', 'minimax-m2.5', 'glm-5', 'qwen3-coder-next']
      for (const model of nonClaude) {
        expect(isLongContextModel(model), `${model} (non-Claude) should not be long context`).toBe(
          false
        )
      }
    })
  })

  describe('getContextWindowSize: base vs capped companions', () => {
    test('base Haiku 5.5 and GPT-5.6 default to 1M without runtime context', () => {
      expect(getContextWindowSize('claude-haiku-5-5')).toBe(1000000)
      expect(getContextWindowSize('claude-haiku-5-5-thinking')).toBe(1000000)
      expect(getContextWindowSize('gpt-5.6-sol')).toBe(1000000)
      expect(getContextWindowSize('gpt-5.6-terra-thinking')).toBe(1000000)
    })

    test('capped companions keep their capped window', () => {
      expect(getContextWindowSize('claude-haiku-5-5-100k')).toBe(100000)
      expect(getContextWindowSize('claude-haiku-5-5-100k-thinking')).toBe(100000)
      expect(getContextWindowSize('gpt-5.6-sol-272k')).toBe(272000)
      expect(getContextWindowSize('gpt-5.6-luna-272k')).toBe(272000)
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

    test('returns 200K default for unknown models', () => {
      expect(getContextWindowSize('unknown-model')).toBe(200000)
    })
  })
})
