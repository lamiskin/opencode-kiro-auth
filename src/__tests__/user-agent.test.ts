import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KIRO_CONSTANTS, getKiroIdeUserAgent, loadMachineId } from '../constants.js'
import { transformToCodeWhisperer } from '../plugin/request.js'

const auth: any = {
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 60_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

describe('Kiro user agent', () => {
  test('getKiroIdeUserAgent is KiroIDE-<IDE_VERSION>-<sha256 hex> and stable across calls', () => {
    const ua = getKiroIdeUserAgent()
    expect(ua).toMatch(new RegExp(`^KiroIDE-${KIRO_CONSTANTS.IDE_VERSION}-[0-9a-f]{64}$`))
    expect(getKiroIdeUserAgent()).toBe(ua)
  })

  test('loadMachineId creates, reuses, and recreates an invalid id file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kiro-mid-')), 'sub', 'kiro-machine-id')
    const first = loadMachineId(path)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(path, 'utf8')).toBe(first)
    expect(loadMachineId(path)).toBe(first)

    writeFileSync(path, 'garbage')
    const recreated = loadMachineId(path)
    expect(recreated).toMatch(/^[0-9a-f]{64}$/)
    expect(recreated).not.toBe(first)
    expect(readFileSync(path, 'utf8')).toBe(recreated)
  })

  test('CodeWhisperer request headers carry the SDK version and KiroIDE token', () => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
    const { init } = transformToCodeWhisperer('', body, 'claude-sonnet-4-5', auth)
    const headers = init.headers as Record<string, string>
    const sdkPrefix = `aws-sdk-js/${KIRO_CONSTANTS.SDK_VERSION}`
    const kiroIde = getKiroIdeUserAgent()

    expect(headers['user-agent']).toContain(sdkPrefix)
    expect(headers['user-agent']).toContain(kiroIde)
    expect(headers['x-amz-user-agent']).toBe(`${sdkPrefix} ${kiroIde}`)
  })
})
