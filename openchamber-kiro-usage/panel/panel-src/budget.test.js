import { describe, it, expect } from 'bun:test';
import { resolveCycleEnd, workdaysRemaining, dailyBudget, todayCredits } from './budget.js';

// Local-time constructor so the tests do not depend on the machine timezone.
const at = (y, m, d, h = 0) => new Date(y, m - 1, d, h);
const epoch = (date) => Math.floor(date.getTime() / 1000);

describe('resolveCycleEnd', () => {
  it('uses nextDateReset when it is in the future', () => {
    const now = at(2026, 11, 20, 9);
    const end = resolveCycleEnd(epoch(at(2026, 12, 1)), now);
    expect(end.getTime()).toBe(epoch(at(2026, 12, 1)) * 1000);
  });

  it('falls back to next calendar month start when reset is missing', () => {
    expect(resolveCycleEnd(undefined, at(2026, 11, 20)).getTime()).toBe(at(2026, 12, 1).getTime());
  });

  it('falls back when reset is in the past', () => {
    const end = resolveCycleEnd(epoch(at(2026, 11, 1)), at(2026, 11, 20));
    expect(end.getTime()).toBe(at(2026, 12, 1).getTime());
  });
});

describe('workdaysRemaining', () => {
  it('counts Nov 20 plus Nov 23-27 and 30 for reset Dec 1 (7 workdays)', () => {
    expect(workdaysRemaining(at(2026, 11, 20, 9), at(2026, 12, 1))).toBe(7);
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
  it('spreads remaining credits over remaining workdays (5000 limit, 3524.33 used, 7 days)', () => {
    expect(dailyBudget(5000, 3524.33, 7)).toBeCloseTo(210.8, 1);
  });

  it('clamps to 0 when usage exceeds limit', () => {
    expect(dailyBudget(100, 150, 5)).toBe(0);
  });

  it('returns null without a limit or without workdays', () => {
    expect(dailyBudget(0, 0, 5)).toBeNull();
    expect(dailyBudget(100, 10, 0)).toBeNull();
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
