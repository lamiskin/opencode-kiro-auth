import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = mkdtempSync(join(tmpdir(), 'kiro-logger-'))
process.env.XDG_CONFIG_HOME = base
const logDir = join(base, 'opencode', 'kiro-logs')
mkdirSync(logDir, { recursive: true })

// query string bypasses other test files' mock.module('../plugin/logger.js')
const logger: typeof import('../plugin/logger.js') = await import(
  '../plugin/logger.js?real' as string
)

const OLD = '2020-01-01T00-00-00-000Z'
const NEW = '2099-01-01T00-00-00-000Z'

describe('logger diagnostics', () => {
  test('computeHistoryShape reads role and tool counts from real entry shapes', () => {
    const shape = logger.computeHistoryShape([
      { userInputMessage: { content: 'hi' } },
      {
        assistantResponseMessage: {
          content: 'x',
          toolUses: [{ toolUseId: '1' }, { toolUseId: '2' }]
        }
      },
      { userInputMessage: { content: '', userInputMessageContext: { toolResults: [{}, {}] } } }
    ])
    expect(shape.map((s) => [s[0], s[2], s[3]])).toEqual([
      ['u', 0, 0],
      ['a', 2, 0],
      ['u', 0, 2]
    ])
    expect(shape[0][1]).toBeGreaterThan(0)
  })

  test('computeHistoryHashes returns 8-char hex without content', () => {
    const h = logger.computeHistoryHashes([{ userInputMessage: { content: 'secret' } }])
    expect(h[0]).toMatch(/^[0-9a-f]{8}$/)
  })

  test('redactRequestContent hides email and message text, keeps length', () => {
    const out = logger.redactRequestContent({
      email: 'a@b.com',
      body: {
        conversationState: { currentMessage: { userInputMessage: { content: 'topsecret' } } }
      }
    })
    const s = JSON.stringify(out)
    expect(s).not.toContain('a@b.com')
    expect(s).not.toContain('topsecret')
    expect(s).toContain('len=9#')
  })

  test('logApiResponse writes plain <ts>_response.json (panel contract), shape goes to _shape.json', () => {
    logger.logApiResponse({ status: 400, error: 'Kiro Error: 400 - Input is too long' }, NEW)
    logger.logShape({ model: 'm' }, NEW)
    const files = readdirSync(logDir)
    expect(files).toContain(`${NEW}_response.json`)
    expect(files).toContain(`${NEW}_shape.json`)
    expect(files.some((f) => f.startsWith('error_'))).toBe(false)
  })

  test('initializeLogs prunes only old timestamped logs; retention 0 prunes nothing', () => {
    writeFileSync(join(logDir, `${OLD}_request.json`), '{}')
    writeFileSync(join(logDir, 'plugin.log'), 'keep')
    writeFileSync(join(logDir, 'notes.txt'), 'keep')
    const past = new Date('2020-01-02')
    utimesSync(join(logDir, `${OLD}_request.json`), past, past)
    logger.initializeLogs(30)
    expect(existsSync(join(logDir, `${OLD}_request.json`))).toBe(false)
    expect(existsSync(join(logDir, `${NEW}_response.json`))).toBe(true)
    expect(existsSync(join(logDir, 'plugin.log'))).toBe(true)
    expect(existsSync(join(logDir, 'notes.txt'))).toBe(true)
  })
})
