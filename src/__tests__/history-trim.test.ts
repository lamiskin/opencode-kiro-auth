import { describe, expect, it } from 'bun:test'
import { trimHistory } from '../infrastructure/transformers/history-builder'
import type { CodeWhispererMessage } from '../plugin/types'

describe('trimHistory', () => {
  it('returns unchanged when under cap', () => {
    const history: CodeWhispererMessage[] = [
      { userInputMessage: { content: 'sys', modelId: 'model', origin: 'test' } },
      { assistantResponseMessage: { content: 'resp1' } },
      { userInputMessage: { content: 'q1', modelId: 'model', origin: 'test' } }
    ]
    const { history: result, dropped } = trimHistory(history, 100)
    expect(result).toBe(history)
    expect(dropped).toBe(0)
  })

  it('disables when cap is 0 or undefined', () => {
    const history: CodeWhispererMessage[] = [
      { userInputMessage: { content: 'sys', modelId: 'model', origin: 'test' } },
      ...Array.from({ length: 50 }, (_, i) => ({
        assistantResponseMessage: { content: `resp${i}` }
      }))
    ]
    const r1 = trimHistory(history, 0)
    expect(r1.dropped).toBe(0)
    expect(r1.history).toBe(history)

    const r2 = trimHistory(history, undefined)
    expect(r2.dropped).toBe(0)
    expect(r2.history).toBe(history)
  })

  it('enforces minimum floor of 10 entries', () => {
    const history: CodeWhispererMessage[] = [
      { userInputMessage: { content: 'sys', modelId: 'model', origin: 'test' } },
      ...Array.from({ length: 50 }, (_, i) =>
        i % 2 === 0
          ? { assistantResponseMessage: { content: `resp${i}` } }
          : { userInputMessage: { content: `q${i}`, modelId: 'model', origin: 'test' } }
      )
    ]
    const { history: result, dropped } = trimHistory(history, 5)
    expect(result.length).toBeGreaterThanOrEqual(10)
    expect(dropped).toBe(history.length - Math.max(10, 5))
  })

  it('keeps history[0] (system prompt)', () => {
    const sysMsg: CodeWhispererMessage = {
      userInputMessage: { content: 'SYSTEM', modelId: 'model', origin: 'test' }
    }
    const history: CodeWhispererMessage[] = [
      sysMsg,
      { assistantResponseMessage: { content: 'r1' } },
      { userInputMessage: { content: 'q1', modelId: 'model', origin: 'test' } },
      { assistantResponseMessage: { content: 'r2' } },
      { userInputMessage: { content: 'q2', modelId: 'model', origin: 'test' } }
    ]
    const { history: result } = trimHistory(history, 2)
    expect(result[0]?.userInputMessage?.content).toContain('SYSTEM')
  })

  it('drops oldest pairs and maintains u/a/u alternation', () => {
    const history: CodeWhispererMessage[] = [
      { userInputMessage: { content: 'sys', modelId: 'm', origin: 'test' } },
      { assistantResponseMessage: { content: 'a1' } },
      { userInputMessage: { content: 'u1', modelId: 'm', origin: 'test' } },
      { assistantResponseMessage: { content: 'a2' } },
      { userInputMessage: { content: 'u2', modelId: 'm', origin: 'test' } },
      { assistantResponseMessage: { content: 'a3' } },
      { userInputMessage: { content: 'u3', modelId: 'm', origin: 'test' } }
    ]
    // len=7, cap=4, low=max(10,4-60)=10, steps=ceil((7-10)/60)=0, toDrop=0 (no trim, under floor)
    // So result stays at 7; verify alternation holds
    const { history: result } = trimHistory(history, 4)
    expect(result.length).toBe(7) // stays as-is (capped to min floor of 10, but 7<10 so no drop)
    expect(result[0]?.userInputMessage?.content).toContain('sys')
    for (let i = 1; i < result.length - 1; i++) {
      const isAsst = !!result[i]?.assistantResponseMessage
      const nextIsAsst = !!result[i + 1]?.assistantResponseMessage
      expect(isAsst).not.toBe(nextIsAsst)
    }
  })

  // drop = ceil((len - cap) / 60) * 60: 181 -> 121, 200 -> 140, 201 -> 141, 250 -> 130
  it('hysteresis: len=181, cap=180 -> drop 60, result len=121', () => {
    const history: CodeWhispererMessage[] = [
      { userInputMessage: { content: 'sys', modelId: 'm', origin: 'test' } },
      ...Array.from({ length: 180 }, (_, i) =>
        i % 2 === 0
          ? { assistantResponseMessage: { content: `a${i}` } }
          : { userInputMessage: { content: `u${i}`, modelId: 'm', origin: 'test' } }
      )
    ]
    const { history: result, dropped, cap } = trimHistory(history, 180)
    expect(result.length).toBe(121)
    expect(dropped).toBe(60)
    expect(cap).toBe(180)
  })

  it('hysteresis: len=200, cap=180 -> drop 60, result len=140', () => {
    const history: CodeWhispererMessage[] = [
      { userInputMessage: { content: 'sys', modelId: 'm', origin: 'test' } },
      ...Array.from({ length: 199 }, (_, i) =>
        i % 2 === 0
          ? { assistantResponseMessage: { content: `a${i}` } }
          : { userInputMessage: { content: `u${i}`, modelId: 'm', origin: 'test' } }
      )
    ]
    const { history: result, dropped, cap } = trimHistory(history, 180)
    expect(result.length).toBe(140)
    expect(dropped).toBe(60)
    expect(cap).toBe(180)
  })

  it('hysteresis: len=250, cap=180 -> drop 120, result len=130', () => {
    const history: CodeWhispererMessage[] = [
      { userInputMessage: { content: 'sys', modelId: 'm', origin: 'test' } },
      ...Array.from({ length: 249 }, (_, i) =>
        i % 2 === 0
          ? { assistantResponseMessage: { content: `a${i}` } }
          : { userInputMessage: { content: `u${i}`, modelId: 'm', origin: 'test' } }
      )
    ]
    const { history: result, dropped, cap } = trimHistory(history, 180)
    expect(result.length).toBe(130)
    expect(dropped).toBe(120)
    expect(cap).toBe(180)
  })

  it('len=201, cap=180 -> drop 60, result len=141', () => {
    const history: CodeWhispererMessage[] = [
      { userInputMessage: { content: 'sys', modelId: 'm', origin: 'test' } },
      ...Array.from({ length: 200 }, (_, i) =>
        i % 2 === 0
          ? { assistantResponseMessage: { content: `a${i}` } }
          : { userInputMessage: { content: `u${i}`, modelId: 'm', origin: 'test' } }
      )
    ]
    const { history: result, dropped, cap } = trimHistory(history, 180)
    expect(result.length).toBe(141)
    expect(dropped).toBe(60)
  })

  it('exact mode trims to the cap without hysteresis', () => {
    const history: CodeWhispererMessage[] = [
      { userInputMessage: { content: 'sys', modelId: 'm', origin: 'test' } },
      ...Array.from({ length: 199 }, (_, i) =>
        i % 2 === 0
          ? { assistantResponseMessage: { content: `a${i}` } }
          : { userInputMessage: { content: `u${i}`, modelId: 'm', origin: 'test' } }
      )
    ]
    const { history: result, dropped } = trimHistory(history, 120, true)
    expect(result.length).toBe(120)
    expect(dropped).toBe(80)
  })

  it('appends truncation marker to history[0]', () => {
    const history: CodeWhispererMessage[] = [
      { userInputMessage: { content: 'system', modelId: 'm', origin: 'test' } },
      ...Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0
          ? { assistantResponseMessage: { content: `a${i}` } }
          : { userInputMessage: { content: `u${i}`, modelId: 'm', origin: 'test' } }
      )
    ]
    const { history: result, dropped } = trimHistory(history, 5)
    expect(result[0]?.userInputMessage?.content).toContain('[Earlier conversation truncated:')
    expect(result[0]?.userInputMessage?.content).toContain(`${dropped} messages omitted]`)
  })

  it('does not mutate input array', () => {
    const history: CodeWhispererMessage[] = [
      { userInputMessage: { content: 'sys', modelId: 'm', origin: 'test' } },
      { assistantResponseMessage: { content: 'a1' } },
      { userInputMessage: { content: 'u1', modelId: 'm', origin: 'test' } }
    ]
    const origLen = history.length
    const origFirst = history[0]?.userInputMessage?.content
    trimHistory(history, 2)
    expect(history.length).toBe(origLen)
    expect(history[0]?.userInputMessage?.content).toBe(origFirst)
  })

  it('handles tool use and tool result pairing across cut', () => {
    const history: CodeWhispererMessage[] = [
      { userInputMessage: { content: 'sys', modelId: 'm', origin: 'test' } },
      {
        assistantResponseMessage: {
          content: 'pair1-a',
          toolUses: [{ name: 't1', toolUseId: 'id1', input: {} }]
        }
      },
      {
        userInputMessage: {
          content: 'pair1-u',
          modelId: 'm',
          origin: 'test',
          userInputMessageContext: {
            toolResults: [{ toolUseId: 'id1', status: 'success', content: [] }]
          }
        }
      },
      {
        assistantResponseMessage: {
          content: 'pair2-a',
          toolUses: [{ name: 't2', toolUseId: 'id2', input: {} }]
        }
      },
      {
        userInputMessage: {
          content: 'pair2-u',
          modelId: 'm',
          origin: 'test',
          userInputMessageContext: {
            toolResults: [{ toolUseId: 'id2', status: 'success', content: [] }]
          }
        }
      }
    ]
    const { history: result } = trimHistory(history, 4)
    for (const entry of result) {
      if (entry.assistantResponseMessage?.toolUses) {
        for (const toolUse of entry.assistantResponseMessage.toolUses) {
          let found = false
          for (let i = result.indexOf(entry) + 1; i < result.length; i++) {
            const userMsg = result[i]?.userInputMessage
            if (userMsg?.userInputMessageContext?.toolResults) {
              found = userMsg.userInputMessageContext.toolResults.some(
                (tr) => tr.toolUseId === toolUse.toolUseId
              )
              if (found) break
            }
          }
          expect(found).toBe(true)
        }
      }
    }
  })

  it('gpt model not proactively trimmed', () => {
    // This is tested at the request.ts level in integration test
    // Proactive trim only fires for non-OpenAI models
  })
})
