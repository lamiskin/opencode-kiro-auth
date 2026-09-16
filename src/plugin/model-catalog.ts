/**
 * Dynamic model catalog with credit multipliers fetched from Kiro docs.
 *
 * Credit multipliers are scraped from the Kiro models documentation page.
 * The data is cached locally with a 24-hour TTL and a bundled fallback
 * for offline/error scenarios.
 */

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
 * Last updated: September 2026
 * This serves as a fallback when the remote fetch fails.
 */
const BUNDLED_MODEL_CATALOG: ModelCatalogEntry[] = [
  // GPT-5.6 uses two-tier pricing: short-context (≤272K) and long-context (>272K)
  // The rates shown are for short-context. Long-context is 2x these rates.
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', rate: '4.4x', context: 1000000 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', rate: '2.2x', context: 1000000 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', rate: '1.1x', context: 1000000 },
  { id: 'claude-opus-5', name: 'Claude Opus 5', rate: '2.2x', context: 1000000 },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', rate: '2.2x', context: 1000000 },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', rate: '2.2x', context: 1000000 },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', rate: '2.2x', context: 1000000 },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', rate: '2.2x', context: 200000 },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', rate: '1.3x', context: 1000000 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', rate: '1.3x', context: 1000000 },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', rate: '1.3x', context: 200000 },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4.0', rate: '1.3x', context: 200000 },
  { id: 'auto', name: 'Auto', rate: '1.0x', context: 200000 },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', rate: '0.4x', context: 200000 },
  { id: 'deepseek-3.2', name: 'DeepSeek 3.2', rate: '0.25x', context: 128000 },
  { id: 'minimax-m2.5', name: 'MiniMax M2.5', rate: '0.25x', context: 200000 },
  { id: 'glm-5', name: 'GLM-5', rate: '0.5x', context: 200000 },
  { id: 'minimax-m2.1', name: 'MiniMax M2.1', rate: '0.15x', context: 200000 },
  { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next', rate: '0.05x', context: 256000 }
]

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
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell)

    if (cells.length < 3) continue

    // Parse model name (remove bold markdown if present)
    const modelNameRaw = cells[0]
    if (!modelNameRaw) continue
    const modelName = modelNameRaw.replace(/\*\*/g, '').trim()

    // Parse context window
    const contextRaw = cells[1]
    if (!contextRaw) continue
    let context = 200000 // default
    if (contextRaw.includes('1M')) {
      context = 1000000
    } else if (contextRaw.includes('256K')) {
      context = 256000
    } else if (contextRaw.includes('200K')) {
      context = 200000
    } else if (contextRaw.includes('128K')) {
      context = 128000
    } else if (contextRaw.includes('272K')) {
      context = 272000
    }

    // Parse credit multiplier (remove asterisks for footnotes)
    const rateRaw = cells[2]
    if (!rateRaw) continue
    const rateMatch = rateRaw.match(/(\d+\.?\d*)x/)
    const rate = rateMatch ? `${rateMatch[1]}x` : '1.0x'

    // Convert display name to model ID
    const id = modelNameToId(modelName)

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
  // Try active catalog first
  const entry = activeCatalog.get(modelId)
  if (entry) return entry

  // Try to resolve via MODEL_MAPPING and look up again
  try {
    const resolvedId = resolveKiroModel(modelId)
    const resolvedEntry = activeCatalog.get(resolvedId)
    if (resolvedEntry) return resolvedEntry
  } catch {
    // Model not in mapping
  }

  // Fall back to bundled data
  return BUNDLED_MODEL_CATALOG.find((entry) => entry.id === modelId)
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
