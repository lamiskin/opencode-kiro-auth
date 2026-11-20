/**
 * Dynamic model catalog with credit multipliers fetched from Kiro docs.
 *
 * Credit multipliers are scraped from the Kiro models documentation page.
 * The data is cached locally with a 24-hour TTL and a bundled fallback
 * for offline/error scenarios.
 */

import { TIERS } from './model-tiers.js'
import { resolveKiroModel } from './models.js'

const MODEL_CATALOG_URL = 'https://kiro.dev/docs/models.md'
const MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

export interface ModelCatalogEntry {
  /** Model ID as used in OpenCode (e.g., 'claude-opus-5') */
  id: string
  /** Display name (e.g., 'Claude Opus 5') */
  name: string
  /** Credit multiplier (e.g., '2.2x') */
  rate: string
  /** Context window size */
  context: number
}

type CatalogCacheEntry = {
  expiresAt: number
  catalog: Map<string, ModelCatalogEntry>
}

// Cache for fetched catalog
let catalogCache: CatalogCacheEntry | null = null
let activeCatalog = new Map<string, ModelCatalogEntry>()

/**
 * Bundled fallback data extracted from kiro.dev/docs/models.md
 * Last updated: November 2026
 * This serves as a fallback when the remote fetch fails.
 *
 * Includes both hyphenated and dot-notation variants to handle all model ID formats.
 */
const BUNDLED_MODEL_CATALOG: ModelCatalogEntry[] = [
  // GPT-5.6 uses two-tier pricing: short-context (≤272K) and long-context (>272K)
  // The rates shown are for short-context. Long-context is 2x these rates.
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    rate: '4.4x',
    context: 1000000
  },
  { id: 'gpt-5.6-sol-272k', name: 'GPT-5.6 Sol 272K', rate: '4.4x', context: 272000 },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    rate: '2.2x',
    context: 1000000
  },
  { id: 'gpt-5.6-terra-272k', name: 'GPT-5.6 Terra 272K', rate: '2.2x', context: 272000 },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    rate: '0.6x',
    context: 1000000
  },
  { id: 'gpt-5.6-luna-272k', name: 'GPT-5.6 Luna 272K', rate: '0.6x', context: 272000 },

  // Claude Opus
  { id: 'claude-opus-5', name: 'Claude Opus 5', rate: '2.2x', context: 1000000 },
  { id: 'claude-opus-5.5', name: 'Claude Opus 5.5', rate: '2.0x', context: 1000000 },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', rate: '2.2x', context: 1000000 },
  { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', rate: '2.2x', context: 1000000 },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', rate: '2.2x', context: 1000000 },
  { id: 'claude-opus-4.7', name: 'Claude Opus 4.7', rate: '2.2x', context: 1000000 },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', rate: '2.2x', context: 1000000 },
  { id: 'claude-opus-4.6', name: 'Claude Opus 4.6', rate: '2.2x', context: 1000000 },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', rate: '2.2x', context: 200000 },
  { id: 'claude-opus-4.5', name: 'Claude Opus 4.5', rate: '2.2x', context: 200000 },

  // Claude Sonnet
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', rate: '1.3x', context: 1000000 },
  { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', rate: '1.3x', context: 1000000 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', rate: '1.3x', context: 1000000 },
  { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', rate: '1.3x', context: 1000000 },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', rate: '1.3x', context: 200000 },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', rate: '1.3x', context: 200000 },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4.0', rate: '1.3x', context: 200000 },

  // Claude Fable
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', rate: '6x', context: 1000000 },
  { id: 'claude-fable-5.1', name: 'Claude Fable 5.1', rate: '6x', context: 1000000 },

  // Claude Haiku
  { id: 'auto', name: 'Auto', rate: '1.0x', context: 200000 },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', rate: '0.4x', context: 200000 },
  {
    id: 'claude-haiku-5-5',
    name: 'Claude Haiku 5.5',
    rate: '0.06x',
    context: 1000000
  },
  { id: 'claude-haiku-5-5-100k', name: 'Claude Haiku 5.5 100K', rate: '0.06x', context: 100000 },

  // Open-weight models
  { id: 'deepseek-3.2', name: 'DeepSeek 3.2', rate: '0.25x', context: 128000 },
  { id: 'minimax-m2.5', name: 'MiniMax M2.5', rate: '0.25x', context: 200000 },
  { id: 'glm-5', name: 'GLM-5', rate: '0.5x', context: 200000 },
  { id: 'minimax-m2.1', name: 'MiniMax M2.1', rate: '0.15x', context: 200000 },
  { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next', rate: '0.05x', context: 256000 },

  // Kimi
  { id: 'kimi-k3', name: 'Kimi K3', rate: '2.4x', context: 1000000 },

  // Grok: two-tier pricing, 2x above 200K
  {
    id: 'grok-4.7',
    name: 'Grok 4.7',
    rate: '2.7x',
    context: 500000
  },

  // Thinking variants resolve to their base models in the catalog,
  // but we include them here for direct lookups by thinking variant ID
  {
    id: 'claude-haiku-4-5-thinking',
    name: 'Claude Haiku 4.5 Thinking',
    rate: '0.4x',
    context: 200000
  },
  {
    id: 'claude-haiku-5-5-thinking',
    name: 'Claude Haiku 5.5 Thinking',
    rate: '0.06x',
    context: 1000000
  },
  {
    id: 'claude-haiku-5-5-100k-thinking',
    name: 'Claude Haiku 5.5 100K Thinking',
    rate: '0.06x',
    context: 100000
  },
  {
    id: 'claude-sonnet-4-5-thinking',
    name: 'Claude Sonnet 4.5 Thinking',
    rate: '1.3x',
    context: 200000
  },
  {
    id: 'claude-opus-4-5-thinking',
    name: 'Claude Opus 4.5 Thinking',
    rate: '2.2x',
    context: 200000
  },

  {
    id: 'claude-sonnet-4-6-thinking',
    name: 'Claude Sonnet 4.6 Thinking',
    rate: '1.3x',
    context: 1000000
  },
  {
    id: 'claude-sonnet-5-thinking',
    name: 'Claude Sonnet 5 Thinking',
    rate: '1.3x',
    context: 1000000
  },
  {
    id: 'claude-sonnet-5-5-thinking',
    name: 'Claude Sonnet 5.5 Thinking',
    rate: '1.3x',
    context: 1000000
  },
  {
    id: 'claude-opus-4-6-thinking',
    name: 'Claude Opus 4.6 Thinking',
    rate: '2.2x',
    context: 1000000
  },
  {
    id: 'claude-opus-4-7-thinking',
    name: 'Claude Opus 4.7 Thinking',
    rate: '2.2x',
    context: 1000000
  },
  {
    id: 'claude-opus-4-8-thinking',
    name: 'Claude Opus 4.8 Thinking',
    rate: '2.2x',
    context: 1000000
  },
  { id: 'claude-opus-5-thinking', name: 'Claude Opus 5 Thinking', rate: '2.2x', context: 1000000 },
  {
    id: 'claude-opus-5-5-thinking',
    name: 'Claude Opus 5.5 Thinking',
    rate: '2.0x',
    context: 1000000
  },
  {
    id: 'claude-fable-5-1-thinking',
    name: 'Claude Fable 5.1 Thinking',
    rate: '6x',
    context: 1000000
  },

  {
    id: 'qwen3-coder-next-thinking',
    name: 'Qwen3 Coder Next Thinking',
    rate: '0.05x',
    context: 256000
  },
  { id: 'kimi-k3-thinking', name: 'Kimi K3 Thinking', rate: '2.4x', context: 1000000 },
  { id: 'gpt-5.6-sol-thinking', name: 'GPT-5.6 Sol Thinking', rate: '4.4x', context: 1000000 },
  {
    id: 'gpt-5.6-sol-thinking-272k',
    name: 'GPT-5.6 Sol Thinking 272K',
    rate: '4.4x',
    context: 272000
  },
  { id: 'gpt-5.6-terra-thinking', name: 'GPT-5.6 Terra Thinking', rate: '2.2x', context: 1000000 },
  {
    id: 'gpt-5.6-terra-thinking-272k',
    name: 'GPT-5.6 Terra Thinking 272K',
    rate: '2.2x',
    context: 272000
  },
  { id: 'gpt-5.6-luna-thinking', name: 'GPT-5.6 Luna Thinking', rate: '0.6x', context: 1000000 },
  {
    id: 'gpt-5.6-luna-thinking-272k',
    name: 'GPT-5.6 Luna Thinking 272K',
    rate: '0.6x',
    context: 272000
  },

  // GPT-5.6 272K variants (two-tier pricing, short context tier)
  { id: 'gpt-5.6-sol-272k', name: 'GPT-5.6 Sol 272K', rate: '4.4x', context: 272000 },
  { id: 'gpt-5.6-terra-272k', name: 'GPT-5.6 Terra 272K', rate: '2.2x', context: 272000 },
  { id: 'gpt-5.6-luna-272k', name: 'GPT-5.6 Luna 272K', rate: '0.6x', context: 272000 }
]

/**
 * Single id form for comparisons: version dots become hyphens (claude-haiku-4.5 and claude-haiku-4-5 both map to claude-haiku-4-5).
 */
export function canonicalModelId(id: string): string {
  return id.replace(/(\d)\.(\d)/g, '$1-$2')
}

/** "64K" -> 64000, "1M" / "1.0M" -> 1000000; undefined when the cell has no size token. */
export function parseContextTokens(cell: string): number | undefined {
  const m = cell.match(/(\d+(?:\.\d+)?)\s*([KM])\b/i)
  if (!m) return undefined
  return Math.round(parseFloat(m[1]!) * (m[2]!.toUpperCase() === 'M' ? 1_000_000 : 1_000))
}

/**
 * Parse the markdown table from kiro.dev/docs/models.md
 *
 * The table format is:
 * | Model | Context | Cost | Regions | ... |
 * |-------|:-------:|:----:|:-------:| ... |
 * | **GPT-5.6 Sol** | 1M | 4.4x* | US, EU | ... |
 */
export function parseModelsMarkdown(markdown: string): Map<string, ModelCatalogEntry> {
  const catalog = new Map<string, ModelCatalogEntry>()

  // Find the quick comparison table
  const tableMatch = markdown.match(/\| Model \| Context \| Cost \|[\s\S]*?(?=\n\n|\n##|$)/)
  if (!tableMatch) {
    return catalog
  }

  const tableContent = tableMatch[0]
  const lines = tableContent.split('\n').filter((line) => line.trim().startsWith('|'))

  // Skip header and separator lines
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue

    const cells = line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim())

    if (cells.length < 3) continue

    // Parse model name (remove bold markdown if present)
    const modelNameRaw = cells[0]
    if (!modelNameRaw) continue
    const modelName = modelNameRaw
      .replace(/<[^>]*>/g, '')
      .replace(/\*\*/g, '')
      .trim()

    const contextRaw = cells[1] ?? ''
    const rateRaw = cells[2]
    if (!rateRaw) continue

    const id = modelNameToId(modelName)
    const bundled = BUNDLED_MODEL_CATALOG.find(
      (e) => canonicalModelId(e.id) === canonicalModelId(id)
    )

    // Parse credit multiplier (remove asterisks for footnotes)
    const rateMatch = rateRaw.match(/(\d+\.?\d*)x/)
    if (!rateMatch) {
      console.warn(`Model catalog: unparseable cost '${rateRaw}' for ${modelName}, row skipped`)
      continue
    }
    const rate = `${rateMatch[1]}x`

    const parsedContext = parseContextTokens(contextRaw)
    if (parsedContext === undefined && contextRaw !== '—') {
      console.warn(`Model catalog: unparseable context '${contextRaw}' for ${modelName}`)
    }
    const context = parsedContext ?? bundled?.context ?? 200000

    // Two-tier surcharges come from TIERS, which the table does not carry
    if (rateRaw.includes('*') && !TIERS.some((t) => t.test.test(id))) {
      console.warn(
        `Model catalog: ${modelName} has two-tier pricing (*) but no TIERS entry; surcharge not applied`
      )
    }

    catalog.set(id, {
      id,
      name: modelName,
      rate,
      context
    })
  }

  return catalog
}

/**
 * Convert a display name to a model ID.
 * E.g., "Claude Opus 5" -> "claude-opus-5"
 * E.g., "GPT-5.6 Sol" -> "gpt-5.6-sol"
 */
function modelNameToId(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/-+/g, '-')
    .replace(/\.0(?=-|$)/, '') // "claude-sonnet-4.0" -> "claude-sonnet-4"
}

/**
 * Fetch the model catalog from kiro.dev/docs/models.md
 */
export async function refreshModelCatalog(): Promise<void> {
  // Check cache
  if (catalogCache && catalogCache.expiresAt > Date.now()) {
    activeCatalog = new Map(catalogCache.catalog)
    return
  }

  try {
    const response = await fetch(MODEL_CATALOG_URL, {
      signal: AbortSignal.timeout(10_000)
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch model catalog: ${response.status}`)
    }

    const markdown = await response.text()
    const catalog = parseModelsMarkdown(markdown)

    if (catalog.size === 0) {
      throw new Error('No models parsed from catalog')
    }

    // Cache the result
    catalogCache = {
      expiresAt: Date.now() + MODEL_CATALOG_TTL_MS,
      catalog
    }
    activeCatalog = new Map(catalog)
  } catch (error) {
    // On error, use bundled fallback
    console.warn('Failed to fetch model catalog, using bundled fallback:', error)
    activeCatalog = new Map(BUNDLED_MODEL_CATALOG.map((entry) => [entry.id, entry]))
  }
}

/**
 * Get a model's catalog entry by ID.
 * Falls back to bundled data if not in active catalog.
 */
export function getModelCatalogEntry(modelId: string): ModelCatalogEntry | undefined {
  const candidates = rateLookupCandidates(modelId)
  // Live data wins: search every candidate in the active catalog before bundled data
  const sources = [Array.from(activeCatalog.values()), BUNDLED_MODEL_CATALOG]
  for (const entries of sources) {
    const lookup = (id: string) =>
      entries.find((e) => canonicalModelId(e.id) === canonicalModelId(id))
    for (const id of candidates) {
      const entry = lookup(id)
      if (entry) return entry
      try {
        const mapped = lookup(resolveKiroModel(id))
        if (mapped) return mapped
      } catch {
        // Model not in mapping
      }
    }
  }
  return undefined
}

/**
 * Ids to try for a model: itself, its dot/hyphen spelling (claude-haiku-4.5 <-> claude-haiku-4-5),
 * then each with -thinking/-272k/-100k/-1m suffixes stripped (rate is the same as the base model).
 * Kiro responses use dot ids while MODEL_MAPPING keys are hyphenated, so both must resolve.
 */
export function rateLookupCandidates(modelId: string): string[] {
  const out: string[] = []
  const add = (id: string) => out.includes(id) || out.push(id)
  const alias = (id: string) =>
    id.includes('.') ? id.replace(/(\d)\.(\d)/g, '$1-$2') : id.replace(/(\d)-(\d)(?=$|-)/g, '$1.$2')
  let id = modelId
  for (;;) {
    add(id)
    add(alias(id))
    const stripped = id.replace(/-(thinking|272k|100k|1m)$/, '')
    if (stripped === id) break
    id = stripped
  }
  return out
}

/**
 * Get the credit multiplier for a model.
 * Returns '1.0x' as default if not found.
 */
export function getModelRate(modelId: string): string {
  return getModelCatalogEntry(modelId)?.rate ?? '1.0x'
}

/**
 * Get the context window size for a model from the catalog.
 * Returns 200000 as default if not found.
 */
export function getModelContextWindow(modelId: string): number {
  return getModelCatalogEntry(modelId)?.context ?? 200000
}

/**
 * Get all available model IDs.
 */
export function getAvailableModelIds(): string[] {
  return Array.from(new Set([...activeCatalog.keys(), ...BUNDLED_MODEL_CATALOG.map((e) => e.id)]))
}

/**
 * Clear the model catalog cache.
 */
export function clearModelCatalog(): void {
  catalogCache = null
  activeCatalog = new Map()
}

/**
 * Initialize the catalog with bundled data immediately.
 * Call this at startup to ensure data is available before async fetch completes.
 */
export function initializeModelCatalog(): void {
  activeCatalog = new Map(BUNDLED_MODEL_CATALOG.map((entry) => [entry.id, entry]))
}
