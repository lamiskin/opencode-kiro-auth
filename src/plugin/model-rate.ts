import { getModelCatalogEntry } from './model-catalog.js'

const warned = new Set<string>()

/**
 * Rate for a model id, from the catalog.
 * Attempts all dot/hyphen variants and -thinking/-272k/-1m suffixes via getModelCatalogEntry.
 * Falls back to 1.0x only for 'auto' model (which has no deterministic cost).
 * For other models missing from catalog, logs warning and returns 1.0x (caller must decide if this is an error).
 */
export function rateForLog(modelId: string, onMissing?: (message: string) => void): string {
  const entry = getModelCatalogEntry(modelId)
  if (!entry) {
    // Only warn for non-auto models. 'auto' is expected to fall back to 1.0x.
    if (modelId !== 'auto' && !warned.has(modelId)) {
      warned.add(modelId)
      onMissing?.(`No catalog rate for model '${modelId}', using default 1.0x`)
    }
  }
  return entry?.rate ?? '1.0x'
}
