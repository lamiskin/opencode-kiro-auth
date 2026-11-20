export interface Tier {
  test: RegExp
  /** Input tokens above which Kiro bills the higher tier. */
  threshold: number
  /** Over-threshold multiplier, given the base multiplier. */
  over: (base: number) => number
}

// Documented at kiro.dev/docs/models: GPT-5.6 doubles above 272K; Haiku 5.5 is 0.3x above 100K; Grok 4.7 doubles above 200K.
export const TIERS: Tier[] = [
  { test: /^gpt-5[.-]6-/, threshold: 272000, over: (b) => b * 2 },
  { test: /^claude-haiku-5[.-]5/, threshold: 100000, over: () => 0.3 },
  { test: /^grok-4[.-]7/, threshold: 200000, over: (b) => b * 2 }
]
