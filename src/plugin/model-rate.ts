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

interface Tier {
  test: RegExp
  /** Input tokens above which Kiro bills the higher tier. */
  threshold: number
  /** Over-threshold multiplier, given the base multiplier. */
  over: (base: number) => number
}

// Documented at kiro.dev/docs/models: GPT-5.6 doubles above 272K; Haiku 5.5 is 0.3x above 100K.
const TIERS: Tier[] = [
  { test: /^gpt-5[.-]6-/, threshold: 272000, over: (b) => b * 2 },
  { test: /^claude-haiku-5[.-]5/, threshold: 100000, over: () => 0.3 }
]

const fmt = (n: number) => `${+n.toFixed(2)}x`

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
  if (!tier || !inputTokens || inputTokens <= tier.threshold) return base
  return fmt(tier.over(parseFloat(base)))
}

/** Picker label rate. Full-context entries show both tiers; capped `-272k`/`-100k` companions stay flat. */
export function rateLabel(modelId: string, rate: string): string {
  const tier = TIERS.find((t) => t.test.test(modelId))
  if (!tier || /-(272k|100k)(-thinking)?$/.test(modelId)) return rate
  const k = `${tier.threshold / 1000}K`
  return `${rate} ≤${k}, ${fmt(tier.over(parseFloat(rate)))} >${k}`
}
