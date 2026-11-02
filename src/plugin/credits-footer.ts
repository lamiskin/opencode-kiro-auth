/**
 * Per-turn credit totals. The footer is shown once per turn, on the final step
 * (a step with no tool calls), and carries the sum of every step's metering usage.
 */
const DEFAULT_KEY = 'default'
const totals = new Map<string, number>()

/** Key for a session. Falls back to one shared key when the session header is absent. */
export function creditKeyFor(sessionID?: string): string {
  return sessionID || DEFAULT_KEY
}

/** Adds one step's credits. Returns the footer on the final step, '' for tool-call steps. */
export function addStepCredits(key: string, usage: number, hasToolCalls: boolean): string {
  const sum = (totals.get(key) ?? 0) + usage
  if (hasToolCalls) {
    totals.set(key, sum)
    return ''
  }
  totals.delete(key)
  return `\n\n_Credits Used: ${sum.toFixed(2)}_`
}

/** Called on a new user turn so an aborted turn cannot leak credits into the next one. */
export function resetCreditsTurn(key: string): void {
  totals.delete(key)
}

/** Matches footers from earlier turns so they are never replayed to Kiro. */
export const CREDITS_FOOTER_RE = /\n*\n*_Credits Used: [0-9.]+_/g
