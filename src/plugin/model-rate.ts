import { getModelCatalogEntry } from './model-catalog.js'
import { TIERS } from './model-tiers.js'

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

const fmt = (n: number) => `${+n.toFixed(2)}x`

/** Capped companions (`-272k`/`-100k`, optional `-thinking`) never exceed their cap, so no surcharge. */
const CAPPED_SUFFIX = /-(272k|100k)(-thinking)?$/

/**
 * Rate actually billed for a request. Kiro returns metered credits already tier-correct;
 * this only fixes the logged `rate` label. shortcut: inputTokens is derived from
 * contextUsagePercentage, so it is approximate near the threshold.
 */
export function effectiveRate(
  modelId: string,
  inputTokens: number | undefined,
  onMissing?: (message: string) => void
): string {
  const base = rateForLog(modelId, onMissing)
  const tier = TIERS.find((t) => t.test.test(modelId))
  if (!tier || CAPPED_SUFFIX.test(modelId) || !inputTokens || inputTokens <= tier.threshold) {
    return base
  }
  return fmt(tier.over(parseFloat(base)))
}

/** Picker label rate. Full-context entries show both tiers; capped `-272k`/`-100k` companions stay flat. */
export function rateLabel(modelId: string, rate: string): string {
  const tier = TIERS.find((t) => t.test.test(modelId))
  if (!tier || CAPPED_SUFFIX.test(modelId)) return rate
  const k = `${tier.threshold / 1000}K`
  return `${rate} ≤${k}, ${fmt(tier.over(parseFloat(rate)))} >${k}`
}
