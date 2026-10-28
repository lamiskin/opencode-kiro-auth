/**
 * Tests for rate resolution: dot/hyphen normalization, -thinking/-272k/-1m stripping,
 * and catalog/mapping consistency.
 *
 * Coverage:
 * 1. rateLookupCandidates generates dot/hyphen variants
 * 2. rateLookupCandidates strips -thinking/-272k/-1m suffixes
 * 3. getModelCatalogEntry resolves through variants
 * 4. rateForLog uses getModelCatalogEntry and returns 1.0x only for explicit cases
 * 5. BUNDLED_MODEL_CATALOG includes both dot and hyphen variants
 * 6. MODEL_MAPPING consistency check (keys/values match catalog)
 */

import { describe, expect, it } from 'bun:test'
import {
  getModelCatalogEntry,
  getModelRate,
  rateLookupCandidates
} from '../plugin/model-catalog.js'
import { rateForLog } from '../plugin/model-rate.js'

describe('Rate resolution: dot/hyphen and -thinking/-272k/-1m', () => {
  it('rateLookupCandidates generates dot and hyphen variants', () => {
    const candidates = rateLookupCandidates('claude-haiku-4-5')
    expect(candidates).toContain('claude-haiku-4-5')
    expect(candidates).toContain('claude-haiku-4.5')
  })

  it('rateLookupCandidates strips -thinking suffix and generates variants', () => {
    const candidates = rateLookupCandidates('claude-haiku-4-5-thinking')
    expect(candidates).toContain('claude-haiku-4-5-thinking')
    expect(candidates).toContain('claude-haiku-4.5-thinking')
    expect(candidates).toContain('claude-haiku-4-5')
    expect(candidates).toContain('claude-haiku-4.5')
  })

  it('rateLookupCandidates strips -272k suffix and generates variants', () => {
    const candidates = rateLookupCandidates('gpt-5.6-sol-272k')
    expect(candidates).toContain('gpt-5.6-sol-272k')
    expect(candidates).toContain('gpt-5-6-sol-272k')
    expect(candidates).toContain('gpt-5.6-sol')
    expect(candidates).toContain('gpt-5-6-sol')
  })

  it('rateLookupCandidates strips -1m suffix and generates variants', () => {
    const candidates = rateLookupCandidates('claude-sonnet-4-5-1m')
    expect(candidates).toContain('claude-sonnet-4-5-1m')
    expect(candidates).toContain('claude-sonnet-4.5-1m')
    expect(candidates).toContain('claude-sonnet-4-5')
    expect(candidates).toContain('claude-sonnet-4.5')
  })

  it('getModelCatalogEntry finds entry via dot variant', () => {
    const entry = getModelCatalogEntry('claude-haiku-4.5')
    expect(entry).toBeDefined()
    expect(entry?.id).toMatch(/claude-haiku-4/)
    expect(entry?.rate).toBe('0.4x')
  })

  it('getModelCatalogEntry finds entry via hyphen variant', () => {
    const entry = getModelCatalogEntry('claude-haiku-4-5')
    expect(entry).toBeDefined()
    expect(entry?.id).toMatch(/claude-haiku-4/)
    expect(entry?.rate).toBe('0.4x')
  })

  it('getModelCatalogEntry resolves -thinking variant to base rate', () => {
    const entryThinking = getModelCatalogEntry('claude-haiku-4-5-thinking')
    const entryBase = getModelCatalogEntry('claude-haiku-4-5')
    expect(entryThinking).toBeDefined()
    expect(entryBase).toBeDefined()
    expect(entryThinking?.rate).toBe(entryBase?.rate)
  })

  it('getModelCatalogEntry resolves -272k variant to base rate', () => {
    const entry272k = getModelCatalogEntry('gpt-5.6-sol-272k')
    const entryBase = getModelCatalogEntry('gpt-5.6-sol')
    expect(entry272k).toBeDefined()
    expect(entryBase).toBeDefined()
    // Both should resolve, though -272k has its own entry in BUNDLED_MODEL_CATALOG
    expect(entry272k?.rate).toBe('4.4x')
  })

  it('getModelCatalogEntry resolves -1m variant to base rate', () => {
    const entry1m = getModelCatalogEntry('claude-sonnet-4-5-1m')
    const entryBase = getModelCatalogEntry('claude-sonnet-4-5')
    expect(entry1m).toBeDefined()
    expect(entryBase).toBeDefined()
    // Both should resolve to the same rate
    expect(entry1m?.rate).toBe(entryBase?.rate)
  })

  it('rateForLog returns rate for known model', () => {
    const rate = rateForLog('claude-sonnet-4-5')
    expect(rate).toBe('1.3x')
  })

  it('rateForLog returns rate via dot variant', () => {
    const rate = rateForLog('claude-sonnet-4.5')
    expect(rate).toBe('1.3x')
  })

  it('rateForLog returns 1.0x for auto model without warning', () => {
    const rate = rateForLog('auto')
    expect(rate).toBe('1.0x')
  })

  it('rateForLog returns 1.0x for missing model with warning callback', () => {
    let warned = false
    const rate = rateForLog('nonexistent-model-xyz', () => {
      warned = true
    })
    expect(rate).toBe('1.0x')
    expect(warned).toBe(true)
  })

  it('getModelRate delegates to rateForLog equivalent', () => {
    const rate = getModelRate('claude-sonnet-4-5')
    expect(rate).toBe('1.3x')
  })

  it('getModelRate returns 1.0x for missing model', () => {
    const rate = getModelRate('missing-model')
    expect(rate).toBe('1.0x')
  })

  it('catalog resolves both hyphen and dot variants to same rate', () => {
    // claude-opus-4-8 and claude-opus-4.8 should both resolve
    const rateHyphen = getModelRate('claude-opus-4-8')
    const rateDot = getModelRate('claude-opus-4.8')
    expect(rateHyphen).toBeDefined()
    expect(rateDot).toBeDefined()
    expect(rateHyphen).toBe(rateDot)
  })

  it('thinking variants have consistent rates with base models', () => {
    const baseRate = getModelRate('claude-sonnet-4-5')
    const thinkingRate = getModelRate('claude-sonnet-4-5-thinking')
    expect(thinkingRate).toBe(baseRate)
  })

  it('272k variants have same rate as base (two-tier pricing)', () => {
    const baseRate = getModelRate('gpt-5.6-sol')
    const cap272kRate = getModelRate('gpt-5.6-sol-272k')
    expect(cap272kRate).toBe(baseRate)
  })
})

import { effectiveRate, rateLabel } from '../plugin/model-rate.js'

describe('two-tier pricing', () => {
  it('GPT-5.6 doubles above 272K, base at or below', () => {
    expect(effectiveRate('gpt-5.6-sol', 272000)).toBe('4.4x')
    expect(effectiveRate('gpt-5.6-sol', 272001)).toBe('8.8x')
    expect(effectiveRate('gpt-5.6-luna', 300000)).toBe('1.2x')
  })
  it('Haiku 5.5 is 0.3x above 100K', () => {
    expect(effectiveRate('claude-haiku-5-5', 100000)).toBe('0.06x')
    expect(effectiveRate('claude-haiku-5-5-thinking', 100001)).toBe('0.3x')
  })
  it('non-tiered models and missing tokens keep the base rate', () => {
    expect(effectiveRate('claude-sonnet-5', 900000)).toBe('1.3x')
    expect(effectiveRate('gpt-5.6-sol', undefined)).toBe('4.4x')
  })
  it('labels show both tiers on full-context entries only', () => {
    expect(rateLabel('gpt-5.6-terra', '2.2x')).toBe('2.2x ≤272K, 4.4x >272K')
    expect(rateLabel('claude-haiku-5-5', '0.06x')).toBe('0.06x ≤100K, 0.3x >100K')
    expect(rateLabel('claude-opus-5', '2.2x')).toBe('2.2x')
  })
})
