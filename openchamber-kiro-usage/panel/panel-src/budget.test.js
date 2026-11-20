import { describe, it, expect } from 'bun:test';
import {
  earliestReset,
  resolveCycleEnd,
  workdaysRemaining,
  dailyBudget,
  todayCredits,
  dailyBudgetLine
} from './budget.js';

// Tests run with TZ=Australia/Sydney (see package.json test script / CI command).
// Epoch 1796083200 is 2026-12-01T00:00:00Z = 2026-12-01 11:00 Sydney (AEDT, UTC+11).
const RESET_EPOCH = 1796083200;
const at = (y, m, d, h = 0) => new Date(y, m - 1, d, h);

describe('earliestReset', () => {
  it('picks the earliest future reset across accounts', () => {
    const now = at(2026, 11, 20, 9);
    expect(earliestReset([RESET_EPOCH + 86400, RESET_EPOCH, undefined], now)).toBe(RESET_EPOCH);
  });

  it('ignores past, missing and invalid resets', () => {
    expect(earliestReset([1, undefined, NaN], at(2026, 11, 20))).toBeUndefined();
  });
});

describe('resolveCycleEnd', () => {
  it('uses nextDateReset when it is in the future', () => {
    const end = resolveCycleEnd(RESET_EPOCH, at(2026, 11, 20, 9));
    expect(end.getTime()).toBe(RESET_EPOCH * 1000);
  });

  it('falls back to next calendar month start when reset is missing', () => {
    expect(resolveCycleEnd(undefined, at(2026, 11, 20)).getTime()).toBe(at(2026, 12, 1).getTime());
  });

  it('falls back when reset is in the past', () => {
    const end = resolveCycleEnd(1, at(2026, 11, 20));
    expect(end.getTime()).toBe(at(2026, 12, 1).getTime());
  });
});

describe('workdaysRemaining', () => {
  it('counts Nov 20 plus Nov 23-27 and 30 for reset Dec 1 (7 workdays)', () => {
    expect(workdaysRemaining(at(2026, 11, 20, 9), new Date(RESET_EPOCH * 1000))).toBe(7);
  });

  it('excludes the reset day itself', () => {
    expect(workdaysRemaining(at(2026, 11, 27, 9), at(2026, 11, 30))).toBe(1);
  });

  it('is 0 on a weekend with no workday left before reset', () => {
    expect(workdaysRemaining(at(2026, 11, 28, 9), at(2026, 11, 30))).toBe(0);
  });

  it('is 0 when reset is today or earlier', () => {
    expect(workdaysRemaining(at(2026, 11, 20, 9), at(2026, 11, 20))).toBe(0);
  });
});

describe('dailyBudget', () => {
  it('spreads remaining credits over remaining workdays (limit 5000, used 3524.33, today 0, 7 days)', () => {
    expect(dailyBudget(5000, 3524.33, 0, 7)).toBeCloseTo(210.81, 2);
  });

  it('is invariant as today grows, when used grows by the same amount', () => {
    const start = dailyBudget(5000, 3524.33, 0, 7);
    expect(dailyBudget(5000, 3524.33 + 50, 50, 7)).toBeCloseTo(start, 10);
    expect(dailyBudget(5000, 3524.33 + 200, 200, 7)).toBeCloseTo(start, 10);
  });

  it('clamps to 0 when start-of-day usage already exceeds limit', () => {
    expect(dailyBudget(100, 150, 0, 5)).toBe(0);
  });

  it('keeps the budget at 0 when start-of-day usage already used the whole limit', () => {
    // start of day: 150 - 20 = 130 used of 100 limit -> nothing left, never negative
    expect(dailyBudget(100, 150, 20, 5)).toBe(0);
  });

  it('budget reflects remaining after start-of-day usage, not after today usage', () => {
    // start of day: 120 - 30 = 90 used of 100 -> 10 left over 5 days = 2
    expect(dailyBudget(100, 120, 30, 5)).toBeCloseTo(2, 10);
  });

  it('clamps today to not reduce start-of-day usage below zero', () => {
    // used < today should not produce a negative start-of-day usage.
    expect(dailyBudget(1000, 10, 50, 2)).toBeCloseTo(500, 10);
  });

  it('returns null without a limit or without workdays', () => {
    expect(dailyBudget(0, 0, 0, 5)).toBeNull();
    expect(dailyBudget(100, 10, 0, 0)).toBeNull();
  });
});

describe('todayCredits', () => {
  const now = at(2026, 11, 20, 14);
  const bucket = (h, total) => ({ start: at(2026, 11, 20, h).toISOString(), total });

  it('sums hourly buckets since local midnight only', () => {
    const yesterday = { start: at(2026, 11, 19, 23).toISOString(), total: 99 };
    expect(todayCredits([yesterday, bucket(0, 1), bucket(13, 2), bucket(14, 3)], now)).toBe(6);
  });

  it('returns 0 for empty input', () => {
    expect(todayCredits([], now)).toBe(0);
    expect(todayCredits(undefined, now)).toBe(0);
  });
});

describe('dailyBudgetLine', () => {
  const used = 3524.33 + 50;
  const limit = 5000;

  it('returns empty when today is unknown', () => {
    expect(dailyBudgetLine(null, limit, used, 7)).toBe('');
  });

  it('shows percent of budget and green below 75%', () => {
    const html = dailyBudgetLine(50, limit, used, 7);
    expect(html).toContain("Today (this machine's logs): 50.00 credits");
    expect(html).toContain('24% of daily budget');
    expect(html).toContain('class="daily-budget green"');
  });

  it('shows orange at 75-90%', () => {
    const html = dailyBudgetLine(160, limit, 3524.33 + 160, 7); // 160 / 210.81 = 76%
    expect(html).toContain('class="daily-budget orange"');
  });

  it('shows red at 90% and above', () => {
    const html = dailyBudgetLine(200, limit, 3524.33 + 200, 7); // 200 / 210.81 = 95%
    expect(html).toContain('class="daily-budget red"');
  });

  it('shows over limit in red when remaining is exhausted and today > 0', () => {
    const html = dailyBudgetLine(20, 100, 120, 5);
    expect(html).toContain('class="daily-budget red"');
    expect(html).toContain('over limit');
    expect(html).not.toContain('green');
    expect(html).not.toContain('% of daily budget');
  });

  it('shows neutral line with no percent when exhausted and no usage today', () => {
    const html = dailyBudgetLine(0, 100, 120, 5);
    expect(html).toContain('class="daily-budget"');
    expect(html).not.toContain('over limit');
    expect(html).not.toContain('% of daily budget');
  });

  it('shows no-workdays text when workdays is 0', () => {
    expect(dailyBudgetLine(12, limit, used, 0)).toContain('no workdays left in cycle');
  });
});
