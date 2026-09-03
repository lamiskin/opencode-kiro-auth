import { describe, expect, test } from 'bun:test'
import { buildModelRegistry } from '../plugin/model-registry.js'
import { resolveKiroModel } from '../plugin/models.js'
import { supportsEffort, supportsXHighEffort } from '../plugin/effort.js'

const KIRO_DOCS_MODELS = [
  { id: 'gpt-5.6-sol', context: 272000, rate: '2.4x', hasThinking: true, isOpenAI: true },
  { id: 'gpt-5.6-terra', context: 272000, rate: '1.0x', hasThinking: true, isOpenAI: true },
  { id: 'gpt-5.6-luna', context: 272000, rate: '0.1x', hasThinking: true, isOpenAI: true },
  { id: 'claude-opus-5', context: 1000000, rate: '2.2x', hasThinking: true, isOpenAI: false },
  { id: 'claude-opus-4-8', context: 1000000, rate: '2.2x', hasThinking: true, isOpenAI: false },
  { id: 'claude-opus-4-7', context: 1000000, rate: '2.2x', hasThinking: true, isOpenAI: false },
  { id: 'claude-opus-4-6', context: 1000000, rate: '2.2x', hasThinking: true, isOpenAI: false },
  { id: 'claude-opus-4-5', context: 200000, rate: '2.2x', hasThinking: true, isOpenAI: false },
  { id: 'claude-sonnet-5', context: 1000000, rate: '1.3x', hasThinking: true, isOpenAI: false },
  { id: 'claude-sonnet-4-6', context: 1000000, rate: '1.3x', hasThinking: true, isOpenAI: false },
  { id: 'claude-sonnet-4-5', context: 200000, rate: '1.3x', hasThinking: true, isOpenAI: false },
  { id: 'claude-sonnet-4', context: 200000, rate: '1.3x', hasThinking: false, isOpenAI: false },
  { id: 'claude-haiku-4-5', context: 200000, rate: '0.4x', hasThinking: false, isOpenAI: false },
  { id: 'deepseek-3.2', context: 128000, rate: '0.25x', hasThinking: true, isOpenAI: false },
  { id: 'minimax-m2.5', context: 196000, rate: '0.25x', hasThinking: true, isOpenAI: false },
  { id: 'glm-5', context: 200000, rate: '0.5x', hasThinking: false, isOpenAI: false },
  { id: 'minimax-m2.1', context: 196000, rate: '0.15x', hasThinking: true, isOpenAI: false },
  { id: 'qwen3-coder-next', context: 256000, rate: '0.05x', hasThinking: false, isOpenAI: false },
  { id: 'auto', context: null, rate: '1.0x', hasThinking: false, isOpenAI: false }
] as const

describe('kiro.dev documentation sync', () => {
  test('all documented models are present in the registry', () => {
    const registry = buildModelRegistry() as Record<string, any>

    const registryModelIDs = new Set(Object.keys(registry).filter(id => !id.endsWith('-thinking')))
    const documentedIDs = new Set(KIRO_DOCS_MODELS.map(m => m.id))

    const missingFromRegistry: string[] = []
    const extraInRegistry: string[] = []

    for (const docModel of KIRO_DOCS_MODELS) {
      if (!registryModelIDs.has(docModel.id)) {
        missingFromRegistry.push(docModel.id)
      }
    }

    for (const regModel of registryModelIDs) {
      if (!documentedIDs.has(regModel) && regModel !== 'auto') {
        extraInRegistry.push(regModel)
      }
    }

    expect(missingFromRegistry, `Models missing from registry: ${missingFromRegistry.join(', ')}`).toEqual([])
    expect(extraInRegistry, `Models in registry but not in docs: ${extraInRegistry.join(', ')}`).toEqual([])
  })

  test('registry context limits match documented values', () => {
    const registry = buildModelRegistry() as Record<string, any>

    for (const docModel of KIRO_DOCS_MODELS) {
      if (docModel.context === null) continue

      const regModel = registry[docModel.id]
      expect(regModel, `Model ${docModel.id} not found in registry`).toBeDefined()
      expect(
        regModel.limit.context,
        `Context mismatch for ${docModel.id}: expected ${docModel.context}, got ${regModel.limit.context}`
      ).toBe(docModel.context)
    }
  })

  test('registry rate multipliers match documented values', () => {
    const registry = buildModelRegistry() as Record<string, any>

    for (const docModel of KIRO_DOCS_MODELS) {
      const regModel = registry[docModel.id]
      expect(regModel, `Model ${docModel.id} not found in registry`).toBeDefined()

      const regRate = regModel.name.match(/\(([\d.]+x)\)/)?.[1]
      expect(
        regRate,
        `Rate mismatch for ${docModel.id}: expected ${docModel.rate}, name is ${regModel.name}`
      ).toBe(docModel.rate)
    }
  })

  test('thinking capability matches documented reasoning support', () => {
    const registry = buildModelRegistry() as Record<string, any>

    for (const docModel of KIRO_DOCS_MODELS) {
      if (docModel.isOpenAI) {
        const hasReasoning = registry[docModel.id]?.reasoning === true
        expect(
          hasReasoning,
          `GPT model ${docModel.id} should have reasoning: true on base model, got ${hasReasoning}`
        ).toBe(true)
      } else {
        const hasThinkingVariant = registry[`${docModel.id}-thinking`] !== undefined
        expect(
          hasThinkingVariant,
          `Thinking variant presence mismatch for ${docModel.id}: expected ${docModel.hasThinking}, got ${hasThinkingVariant}`
        ).toBe(docModel.hasThinking)
      }
    }
  })

  test('effort support aligns with thinking capability', () => {
    for (const docModel of KIRO_DOCS_MODELS) {
      const kiroModel = resolveKiroModel(docModel.id)
      const expectedEffortSupport = docModel.hasThinking
      const actualEffortSupport = supportsEffort(kiroModel)

      expect(
        actualEffortSupport,
        `Effort support mismatch for ${docModel.id}: expected ${expectedEffortSupport}, got ${actualEffortSupport}`
      ).toBe(expectedEffortSupport)
    }
  })

  test('xhigh effort support is documented correctly', () => {
    const expectedXHighModels = [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'claude-opus-4.7',
      'claude-opus-4.8',
      'claude-opus-5',
      'claude-sonnet-5',
      'deepseek-3.2',
      'minimax-m2.5',
      'minimax-m2.1'
    ]

    for (const modelId of expectedXHighModels) {
      expect(
        supportsXHighEffort(modelId),
        `Model ${modelId} should support xhigh effort`
      ).toBe(true)
    }
  })

  test('GPT-5.6 models are correctly identified as OpenAI', async () => {
    const { isOpenAIModel } = await import('../plugin/effort.js')

    const openAIModels = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']
    const nonOpenAIModels = [
      'claude-opus-5',
      'claude-sonnet-5',
      'deepseek-3.2',
      'minimax-m2.5',
      'qwen3-coder-next'
    ]

    for (const model of openAIModels) {
      expect(isOpenAIModel(model), `${model} should be identified as OpenAI`).toBe(true)
    }

    for (const model of nonOpenAIModels) {
      expect(isOpenAIModel(model), `${model} should NOT be identified as OpenAI`).toBe(false)
    }
  })
})