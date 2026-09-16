import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clearModelCatalog,
  getAvailableModelIds,
  getModelCatalogEntry,
  getModelContextWindow,
  getModelRate,
  initializeModelCatalog,
  parseModelsMarkdown
} from '../plugin/model-catalog.js'

describe('model-catalog', () => {
  beforeEach(() => {
    clearModelCatalog()
  })

  afterEach(() => {
    clearModelCatalog()
  })

  describe('initializeModelCatalog', () => {
    test('loads bundled fallback data', () => {
      initializeModelCatalog()

      const entry = getModelCatalogEntry('claude-opus-5')
      expect(entry).toBeDefined()
      expect(entry?.name).toBe('Claude Opus 5')
      expect(entry?.rate).toBe('2.2x')
    })
  })

  describe('getModelRate', () => {
    test('returns correct rate for known models', () => {
      initializeModelCatalog()

      expect(getModelRate('claude-opus-5')).toBe('2.2x')
      expect(getModelRate('claude-sonnet-5')).toBe('1.3x')
      expect(getModelRate('claude-haiku-4-5')).toBe('0.4x')
      expect(getModelRate('auto')).toBe('1.0x')
      expect(getModelRate('qwen3-coder-next')).toBe('0.05x')
    })

    test('returns 1.0x for unknown models', () => {
      expect(getModelRate('unknown-model')).toBe('1.0x')
    })
  })

  describe('getModelContextWindow', () => {
    test('returns correct context for known models', () => {
      initializeModelCatalog()

      expect(getModelContextWindow('claude-opus-5')).toBe(1000000)
      expect(getModelContextWindow('claude-sonnet-4-5')).toBe(200000)
      expect(getModelContextWindow('qwen3-coder-next')).toBe(256000)
    })

    test('returns 200000 for unknown models', () => {
      expect(getModelContextWindow('unknown-model')).toBe(200000)
    })
  })

  describe('getAvailableModelIds', () => {
    test('returns list of model IDs', () => {
      initializeModelCatalog()

      const ids = getAvailableModelIds()
      expect(ids).toContain('claude-opus-5')
      expect(ids).toContain('claude-sonnet-5')
      expect(ids).toContain('auto')
      expect(ids).toContain('gpt-5.6-sol')
      expect(ids).toContain('qwen3-coder-next')
    })
  })

  describe('parseModelsMarkdown', () => {
    test('parses the quick comparison table', () => {
      const markdown = `
# Models

## Quick comparison

| Model | Context | Cost | Regions | Free | Pro |
|-------|:-------:|:----:|:-------:|:----:|:---:|
| **GPT-5.6 Sol** | 1M | 4.4x* | US, EU | | ✓ |
| **Claude Opus 5** | 1M | 2.2x | US, EU | | ✓ |
| **Claude Sonnet 5** | 1M | 1.3x | US, EU | ✓ | ✓ |
| **Auto** | — | 1.0x | US, EU | ✓ | ✓ |
| **Qwen3 Coder Next** | 256K | 0.05x | US, EU | ✓ | ✓ |
`

      const catalog = parseModelsMarkdown(markdown)

      expect(catalog.size).toBeGreaterThan(0)

      const opus5 = catalog.get('claude-opus-5')
      expect(opus5).toBeDefined()
      expect(opus5?.name).toBe('Claude Opus 5')
      expect(opus5?.rate).toBe('2.2x')
      expect(opus5?.context).toBe(1000000)

      const qwen = catalog.get('qwen3-coder-next')
      expect(qwen).toBeDefined()
      expect(qwen?.rate).toBe('0.05x')
      expect(qwen?.context).toBe(256000)
    })

    test('handles empty markdown gracefully', () => {
      const catalog = parseModelsMarkdown('')
      expect(catalog.size).toBe(0)
    })

    test('handles markdown without table gracefully', () => {
      const markdown = `
# Models

Some text without a table.
`
      const catalog = parseModelsMarkdown(markdown)
      expect(catalog.size).toBe(0)
    })

    test('strips footnote markers from rates', () => {
      const markdown = `
| Model | Context | Cost |
|-------|:-------:|:----:|
| **GPT-5.6 Sol** | 1M | 4.4x* |
| **GPT-5.6 Terra** | 1M | 2.2x* |
`
      const catalog = parseModelsMarkdown(markdown)

      expect(catalog.get('gpt-5.6-sol')?.rate).toBe('4.4x')
      expect(catalog.get('gpt-5.6-terra')?.rate).toBe('2.2x')
    })
  })

  describe('bundled fallback data', () => {
    test('contains all expected models', () => {
      initializeModelCatalog()

      const requiredModels = [
        'auto',
        'claude-opus-5',
        'claude-opus-4-8',
        'claude-opus-4-7',
        'claude-opus-4-6',
        'claude-opus-4-5',
        'claude-sonnet-5',
        'claude-sonnet-4-6',
        'claude-sonnet-4-5',
        'claude-sonnet-4',
        'claude-haiku-4-5',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'deepseek-3.2',
        'minimax-m2.5',
        'minimax-m2.1',
        'glm-5',
        'qwen3-coder-next'
      ]

      for (const modelId of requiredModels) {
        expect(getModelCatalogEntry(modelId)).toBeDefined()
      }
    })

    test('has consistent Opus rates', () => {
      initializeModelCatalog()

      const opusRate = getModelRate('claude-opus-5')
      expect(getModelRate('claude-opus-4-8')).toBe(opusRate)
      expect(getModelRate('claude-opus-4-7')).toBe(opusRate)
      expect(getModelRate('claude-opus-4-6')).toBe(opusRate)
      expect(getModelRate('claude-opus-4-5')).toBe(opusRate)
    })

    test('has consistent Sonnet rates', () => {
      initializeModelCatalog()

      const sonnetRate = getModelRate('claude-sonnet-5')
      expect(getModelRate('claude-sonnet-4-6')).toBe(sonnetRate)
      expect(getModelRate('claude-sonnet-4-5')).toBe(sonnetRate)
      expect(getModelRate('claude-sonnet-4')).toBe(sonnetRate)
    })
  })
})
