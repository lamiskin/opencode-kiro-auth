import { describe, expect, test } from 'bun:test'
import { SUPPORTED_MODELS } from '../constants.js'
import type { Effort } from '../plugin/config/schema.js'
import { budgetToEffort, THINKING_BUDGETS } from '../plugin/effort.js'
import { isOpenAIModel } from '../plugin/effort.js'
import { buildModelRegistry } from '../plugin/model-registry.js'
import { resolveKiroModel } from '../plugin/models.js'

const registry = buildModelRegistry() as Record<string, any>

const thinkingIDs = Object.keys(registry).filter((id) => id.endsWith('-thinking'))
const XHIGH_MODELS = [
  'claude-opus-4-7-thinking',
  'claude-opus-4-8-thinking',
  'claude-opus-5-thinking',
  'claude-sonnet-5-thinking',
  'gpt-5.6-sol-thinking',
  'gpt-5.6-terra-thinking',
  'gpt-5.6-luna-thinking',
  'deepseek-3.2-thinking',
  'minimax-m2.5-thinking',
  'minimax-m2.1-thinking'
]

const CLAUDE_THINKING_IDS = [
  'claude-opus-4-5-thinking',
  'claude-opus-4-6-thinking',
  'claude-opus-4-7-thinking',
  'claude-opus-4-8-thinking',
  'claude-opus-5-thinking',
  'claude-sonnet-4-5-thinking',
  'claude-sonnet-4-6-thinking',
  'claude-sonnet-5-thinking'
]

describe('model registry', () => {
  test('every advertised model is resolvable to a Kiro model ID', () => {
    for (const modelID of Object.keys(registry)) {
      expect(SUPPORTED_MODELS).toContain(modelID)
    }
  })

  test('advertises a thinking companion for each effort-capable model', () => {
    // All models that support effort get a thinking companion, including Claude, GPT-5.6, and open-weight models
    const allExpectedThinking = [
      ...CLAUDE_THINKING_IDS,
      'gpt-5.6-sol-thinking',
      'gpt-5.6-terra-thinking',
      'gpt-5.6-luna-thinking',
      'deepseek-3.2-thinking',
      'minimax-m2.5-thinking',
      'minimax-m2.1-thinking'
    ]
    expect(thinkingIDs.sort()).toEqual(allExpectedThinking.sort())
  })

  describe('reasoning capability flags', () => {
    // Both are required: `reasoning` declares the capability, `interleaved.field`
    // tells OpenCode reasoning arrives as `reasoning_content` deltas. Missing
    // either one means reasoning chunks are silently dropped.
    test('every thinking model declares reasoning and the reasoning_content field', () => {
      for (const id of thinkingIDs) {
        expect(registry[id].reasoning).toBe(true)
        expect(registry[id].interleaved).toEqual({ field: 'reasoning_content' })
      }
    })

    test('non-thinking models declare neither', () => {
      for (const [id, model] of Object.entries(registry)) {
        if (id.endsWith('-thinking')) continue
        expect(model.reasoning).toBeUndefined()
        expect(model.interleaved).toBeUndefined()
      }
    })
  })

  describe('thinking variants', () => {
    test('offers xhigh only on models Kiro documents as xhigh-capable', () => {
      for (const id of thinkingIDs) {
        const hasXHigh = Object.keys(registry[id].variants).includes('xhigh')
        expect(hasXHigh).toBe(XHIGH_MODELS.includes(id))
      }
    })

    test('variant budgets map back to the effort level they are named for', () => {
      for (const id of thinkingIDs) {
        const kiroModel = resolveKiroModel(id)
        for (const [name, variant] of Object.entries<any>(registry[id].variants)) {
          const level = name as Effort
          // OpenAI models use reasoning.effort, Claude/open-weight use thinkingConfig.thinkingBudget
          if (isOpenAIModel(kiroModel)) {
            expect(variant.reasoning.effort).toBe(level)
          } else {
            const budget = variant.thinkingConfig.thinkingBudget
            expect(budget).toBe(THINKING_BUDGETS[level])
            expect(budgetToEffort(budget, kiroModel)).toBe(level)
          }
        }
      }
    })

    test('variants are ordered low to max', () => {
      for (const id of thinkingIDs) {
        const kiroModel = resolveKiroModel(id)
        if (isOpenAIModel(kiroModel)) {
          // OpenAI models use reasoning.effort string values
          const levels = Object.keys(registry[id].variants)
          expect(levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
        } else {
          // Claude/open-weight models use thinkingConfig.thinkingBudget numeric values
          const budgets = Object.values<any>(registry[id].variants).map(
            (v) => v.thinkingConfig.thinkingBudget
          )
          expect(budgets).toEqual([...budgets].sort((a, b) => a - b))
        }
      }
    })
  })

  test('carries limit and modalities through to both entries', () => {
    expect(registry['claude-opus-5'].limit).toEqual({ context: 1000000, output: 64000 })
    expect(registry['claude-opus-5-thinking'].limit).toEqual(registry['claude-opus-5'].limit)
    expect(registry['claude-opus-5-thinking'].modalities).toEqual(
      registry['claude-opus-5'].modalities
    )
  })
})
