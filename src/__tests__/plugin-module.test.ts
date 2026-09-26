import { describe, expect, test } from 'bun:test'
import pluginModule from '../index.js'

describe('package plugin module', () => {
  test('uses the kiro provider id in the default export', () => {
    expect(pluginModule.id).toBe('kiro')
  })

  test('has server function for v1', () => {
    expect(typeof pluginModule.server).toBe('function')
  })

  // Note: setup is no longer exported from v1 entry (src/index.ts)
  // v2 loads via src/v2.ts directly through the v2-plugin/ wrapper
})
