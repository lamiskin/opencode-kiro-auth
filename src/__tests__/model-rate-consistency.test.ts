import { beforeEach, describe, expect, test } from 'bun:test'
import { MODEL_MAPPING } from '../constants.js'
import {
  clearModelCatalog,
  getAvailableModelIds,
  getModelCatalogEntry,
  getModelRate,
  initializeModelCatalog,
  rateLookupCandidates
} from '../plugin/model-catalog.js'
import { rateForLog } from '../plugin/model-rate.js'
import { MODEL_CAPABILITIES, buildModelRegistry } from '../plugin/model-registry.js'

// Model ids seen in real ~/.config/opencode/kiro-logs response files (Kiro returns dot-style ids).
const LOGGED_IDS = [
  'claude-haiku-4.5',
  'claude-opus-5',
  'claude-opus-5.5',
  'claude-sonnet-5',
  'claude-sonnet-5.5',
  'deepseek-3.2',
  'glm-5',
  'minimax-m2.1',
  'minimax-m2.5',
  'qwen3-coder-next',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra'
]
// Ids that are legitimately 1.0x. Anything else resolving to 1.0x is a missing-rate bug.
const EXPLICIT_1X = new Set(['auto'])

const rateOfName = (name: string) => /\(([\d.]+x)\)$/.exec(name)?.[1]

describe('model rate consistency', () => {
  beforeEach(() => {
    clearModelCatalog()
    initializeModelCatalog()
  })

  test('every catalog id: logger rate === catalog rate, and hyphen/dot aliases agree', () => {
    const bad: string[] = []
    for (const id of getAvailableModelIds()) {
      const catalogRate = getModelCatalogEntry(id)!.rate
      for (const candidate of rateLookupCandidates(id)) {
        const entry = getModelCatalogEntry(candidate)
        if (entry && entry.id === candidate && entry.rate !== catalogRate) {
          bad.push(`${id}=${catalogRate} vs alias ${candidate}=${entry.rate}`)
        }
      }
      if (rateForLog(id) !== catalogRate)
        bad.push(`${id}: logger ${rateForLog(id)} != ${catalogRate}`)
    }
    expect(bad).toEqual([])
  })

  test('every MODEL_MAPPING key (hyphen and dot spelling) resolves to a catalog entry', () => {
    const missing: string[] = []
    // Legacy upstream-id mappings (UPPER_SNAKE targets) are not user-facing models.
    const keys = Object.keys(MODEL_MAPPING).filter((k) => !/^[A-Z]/.test(MODEL_MAPPING[k] || ''))
    for (const id of keys) {
      for (const spelling of rateLookupCandidates(id)) {
        if (!getModelCatalogEntry(spelling) && !EXPLICIT_1X.has(spelling)) missing.push(spelling)
      }
    }
    expect(missing).toEqual([])
  })

  test('-thinking/-1m/-272k variants carry the same rate as their base model', () => {
    const bad: string[] = []
    for (const id of getAvailableModelIds()) {
      const base = id.replace(/(-thinking|-272k|-1m)+$/, '')
      if (base === id) continue
      const baseEntry = getModelCatalogEntry(base)
      const rate = getModelCatalogEntry(id)!.rate
      if (baseEntry && baseEntry.rate !== rate)
        bad.push(`${id}=${rate} != ${base}=${baseEntry.rate}`)
    }
    expect(bad).toEqual([])
  })

  test('registry display-name rate text matches the catalog for every emitted model', () => {
    const bad: string[] = []
    const registry = buildModelRegistry() as Record<string, { name: string }>
    for (const [id, m] of Object.entries(registry)) {
      if (rateOfName(m.name) !== getModelRate(id)) {
        bad.push(`${id}: name '${m.name}' vs catalog ${getModelRate(id)}`)
      }
    }
    expect(bad).toEqual([])
  })

  test('every MODEL_CAPABILITIES model has a real catalog entry (no silent 1.0x)', () => {
    const missing = Object.keys(MODEL_CAPABILITIES).filter(
      (id) => !getModelCatalogEntry(id) && !EXPLICIT_1X.has(id)
    )
    expect(missing).toEqual([])
  })

  test('ids seen in real logs never fall back to the default rate', () => {
    const defaults = LOGGED_IDS.filter((id) => !getModelCatalogEntry(id) && !EXPLICIT_1X.has(id))
    expect(defaults).toEqual([])
  })

  test('known rates stay pinned (haiku 0.4x was silently logged as 1.0x)', () => {
    expect(rateForLog('claude-haiku-4.5')).toBe('0.4x')
    expect(rateForLog('claude-sonnet-5.5')).toBe(getModelRate('claude-sonnet-5.5'))
    expect(rateForLog('claude-opus-5.5')).toBe(getModelRate('claude-opus-5.5'))
  })

  test('unknown ids still default to 1.0x', () => {
    expect(rateForLog('definitely-not-a-model')).toBe('1.0x')
  })
})
