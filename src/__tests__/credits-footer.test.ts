import { describe, expect, it } from 'bun:test'
import { buildHistory } from '../infrastructure/transformers/history-builder'
import { addStepCredits, creditKeyFor, resetCreditsTurn } from '../plugin/credits-footer'

describe('credits footer', () => {
  it('sums tool steps and emits the total on the final step only', () => {
    const key = 'ses-sum'
    expect(addStepCredits(key, 0.1, true)).toBe('')
    expect(addStepCredits(key, 0.2, true)).toBe('')
    expect(addStepCredits(key, 0.3, false)).toBe('\n\n_Credits Used: 0.60_')
  })

  it('a new turn resets the total so an aborted turn does not leak', () => {
    const key = 'ses-reset'
    addStepCredits(key, 5, true)
    resetCreditsTurn(key)
    expect(addStepCredits(key, 0.25, false)).toBe('\n\n_Credits Used: 0.25_')
  })

  it('falls back to one shared key when no session header is present', () => {
    expect(creditKeyFor(undefined)).toBe(creditKeyFor(''))
  })

  it('history strips footers from earlier assistant turns', () => {
    const history = buildHistory(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'answer\n\n_Credits Used: 0.12_' },
        { role: 'user', content: 'next' }
      ],
      'claude-sonnet-4.5'
    )
    const assistant = history.find((h) => h.assistantResponseMessage)
    expect(assistant?.assistantResponseMessage?.content).toBe('answer')
  })
})
