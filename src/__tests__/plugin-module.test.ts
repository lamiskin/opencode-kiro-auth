import { describe, expect, test } from 'bun:test'
import pluginModule from '../index.js'

describe('package plugin module', () => {
  test('uses the kiro provider id in the default export', () => {
    expect(pluginModule.id).toBe('kiro')
  })

  test('has server function for v1', () => {
    expect(typeof pluginModule.server).toBe('function')
  })

  test('has setup function for v2', () => {
    expect(typeof pluginModule.setup).toBe('function')
  })
})
