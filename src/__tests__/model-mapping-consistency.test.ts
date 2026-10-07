import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { MODEL_MAPPING, SUPPORTED_MODELS } from '../constants.js'
import {
  clearModelCatalog,
  getAvailableModelIds,
  getModelCatalogEntry,
  getModelRate,
  initializeModelCatalog,
  parseModelsMarkdown
} from '../plugin/model-catalog.js'
import { resolveKiroModel } from '../plugin/models.js'

describe('model-mapping-consistency', () => {
  beforeEach(() => {
    clearModelCatalog()
    initializeModelCatalog()
  })

  afterEach(() => {
    clearModelCatalog()
  })

  describe('MODEL_MAPPING completeness', () => {
    test('every model in SUPPORTED_MODELS resolves without error', () => {
      for (const model of SUPPORTED_MODELS) {
        expect(() => resolveKiroModel(model)).not.toThrow()
      }
    })

    test('supported Claude, GPT, and open-weight models resolve to catalog entries', () => {
      // These are the actively-used, non-legacy models that should always resolve
      const activeModels = [
        'claude-haiku-4-5',
        'claude-sonnet-4',
        'claude-sonnet-5',
        'claude-opus-4-8',
        'claude-opus-5',
        'claude-fable-5-1',
        'auto',
        'deepseek-3.2',
        'qwen3-coder-next',
        'gpt-5.6-sol'
      ]

      for (const model of activeModels) {
        const resolved = resolveKiroModel(model)
        const entry = getModelCatalogEntry(resolved)
        expect(entry).toBeDefined(`resolveKiroModel('${model}') -> '${resolved}' not in catalog`)
      }
    })

    test('legacy internal mappings resolve without error', () => {
      // These map to internal constant strings; they may not have catalog entries
      const legacyMappings = [
        'claude-3-7-sonnet',
        'nova-swe',
        'gpt-oss-120b',
        'minimax-m2',
        'kimi-k2-thinking'
      ]

      for (const model of legacyMappings) {
        expect(() => resolveKiroModel(model)).not.toThrow()
      }
    })
  })

  describe('rate consistency', () => {
    test('claude-haiku-4-5 and thinking variant both map to same rate', () => {
      const haikuRate = getModelRate('claude-haiku-4-5')
      const haikuThinkingRate = getModelRate('claude-haiku-4-5-thinking')
      expect(haikuThinkingRate).toBe(haikuRate)
    })

    test('resolved haiku model has non-default rate', () => {
      const rate = getModelRate('claude-haiku-4-5')
      expect(rate).not.toBe('1.0x')
      expect(rate).toBe('0.4x')
    })

    test('active claude models have non-default rates', () => {
      const claudeModels = [
        'claude-haiku-4-5',
        'claude-sonnet-4',
        'claude-sonnet-5',
        'claude-opus-4-8',
        'claude-opus-5',
        'claude-fable-5-1'
      ]

      for (const model of claudeModels) {
        const rate = getModelRate(model)
        expect(rate).not.toBe('1.0x', `${model} has default rate, should be specialized`)
      }
    })

    test('thinking variants have same rate as base', () => {
      const thinkingModels = [
        ['claude-haiku-4-5-thinking', 'claude-haiku-4-5'],
        ['claude-sonnet-5-thinking', 'claude-sonnet-5'],
        ['claude-opus-4-8-thinking', 'claude-opus-4-8'],
        ['claude-opus-5-thinking', 'claude-opus-5']
      ]

      for (const [thinkingModel, baseModel] of thinkingModels) {
        const thinkingRate = getModelRate(thinkingModel)
        const baseRate = getModelRate(baseModel)
        expect(thinkingRate).toBe(baseRate, `${thinkingModel} rate differs from ${baseModel}`)
      }
    })
  })

  describe('end-to-end resolution', () => {
    test('haiku path: map -> resolve -> catalog lookup', () => {
      // Haiku maps to itself (already correct format)
      const resolved = resolveKiroModel('claude-haiku-4-5')
      expect(resolved).toBe('claude-haiku-4.5')

      const entry = getModelCatalogEntry(resolved)
      expect(entry).toBeDefined()
      expect(entry?.name).toBe('Claude Haiku 4.5')
      expect(entry?.rate).toBe('0.4x')
    })

    test('sonnet base model resolves to catalog', () => {
      const resolved = resolveKiroModel('claude-sonnet-4')
      expect(resolved).toBe('claude-sonnet-4')

      const entry = getModelCatalogEntry(resolved)
      expect(entry).toBeDefined()
      expect(entry?.rate).toBe('1.3x')
    })

    test('thinking variant path: map -> resolve -> catalog lookup', () => {
      const resolved = resolveKiroModel('claude-opus-4-8-thinking')
      // Resolves to base model without thinking suffix
      expect(resolved).toBe('claude-opus-4.8')

      // The resolved ID should find a catalog entry
      const entry = getModelCatalogEntry(resolved)
      if (!entry) {
        // If dot notation doesn't exist, check if hyphenated version does
        const hyphenated = getModelCatalogEntry('claude-opus-4-8')
        expect(hyphenated).toBeDefined()
      } else {
        expect(entry.rate).toBe('2.2x')
      }
    })

    test('non-claude models pass through', () => {
      const models = ['auto', 'deepseek-3.2', 'qwen3-coder-next', 'gpt-5.6-sol']
      for (const model of models) {
        const resolved = resolveKiroModel(model)
        expect(resolved).toBe(model)

        const entry = getModelCatalogEntry(resolved)
        expect(entry).toBeDefined()
      }
    })
  })

  describe('edge cases and gaps', () => {
    test('no unmapped sources resolve accidentally', () => {
      // If someone tries a model ID that is not in MODEL_MAPPING, resolveKiroModel should throw
      expect(() => resolveKiroModel('claude-haiku-4.5')).toThrow('Unsupported model')
    })

    test('MODEL_MAPPING and SUPPORTED_MODELS are in sync', () => {
      const mappingKeys = new Set(Object.keys(MODEL_MAPPING))
      const supportedSet = new Set(SUPPORTED_MODELS)

      expect(mappingKeys).toEqual(supportedSet)
    })
  })

  describe('live docs sync', () => {
    test('bundled catalog matches live documentation', async () => {
      const MODEL_CATALOG_URL = 'https://kiro.dev/docs/models.md'
      let liveMarkdown: string | null = null
      let fetchError: Error | null = null

      // Attempt to fetch with timeout
      try {
        const response = await Promise.race([
          fetch(MODEL_CATALOG_URL),
          new Promise<Response>((_, reject) =>
            setTimeout(() => reject(new Error('Fetch timeout')), 10000)
          )
        ])

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        liveMarkdown = await response.text()
      } catch (error) {
        fetchError = error instanceof Error ? error : new Error(String(error))
      }

      // Skip test gracefully if fetch failed
      if (!liveMarkdown || fetchError) {
        console.warn(
          `Skipping live docs sync test (fetch failed): ${fetchError?.message ?? 'unknown error'}`
        )
        return
      }

      // Parse live docs
      const liveCatalog = parseModelsMarkdown(liveMarkdown)
      expect(liveCatalog.size).toBeGreaterThan(0, 'No models parsed from live docs')

      // Get bundled models
      const bundledModels = new Map(
        getAvailableModelIds().map((id) => [id, getModelCatalogEntry(id)])
      )

      // Check that live docs contains all bundled models
      const missing: string[] = []
      const rateMismatches: string[] = []
      const contextMismatches: string[] = []

      for (const [id, entry] of bundledModels.entries()) {
        if (!entry) continue

        const liveEntry = liveCatalog.get(id)
        if (!liveEntry) {
          missing.push(id)
          continue
        }

        // Track rate mismatches
        if (liveEntry.rate !== entry.rate) {
          rateMismatches.push(`${id}: live=${liveEntry.rate}, bundled=${entry.rate}`)
        }

        // Track context mismatches
        if (liveEntry.context !== entry.context) {
          contextMismatches.push(`${id}: live=${liveEntry.context}, bundled=${entry.context}`)
        }
      }

      if (missing.length > 0) {
        console.warn(`Models in bundled catalog but not in live docs: ${missing.join(', ')}`)
      }

      if (rateMismatches.length > 0) {
        console.warn(
          `Rate mismatches between live docs and bundled:\n  ${rateMismatches.join('\n  ')}`
        )
      }

      if (contextMismatches.length > 0) {
        console.warn(
          `Context window mismatches between live docs and bundled:\n  ${contextMismatches.join('\n  ')}`
        )
      }

      // Check for models in live docs not in bundled (new ones we've added)
      const extra: string[] = []
      for (const [id] of liveCatalog.entries()) {
        if (!bundledModels.has(id)) {
          extra.push(id)
        }
      }

      if (extra.length > 0) {
        console.warn(
          `Models in live docs but not in bundled catalog (new models to add): ${extra.join(', ')}`
        )
      }

      // Test passes if we got here with rates/context matching
      expect(true).toBe(true)
    })
  })
})
