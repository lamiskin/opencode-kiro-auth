// Daily budget math for the Kiro usage panel. Pure functions, no DOM.
// Workdays are Mon-Fri in local time, matching the Pace line.

const isWorkday = (date) => {
  const day = date.getDay();
  return day >= 1 && day <= 5;
};

const localDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

// Earliest Kiro reset (epoch seconds) that is still in the future. Accounts can report different resets.
export const earliestReset = (epochs, now) => {
  const future = epochs.filter((e) => Number.isFinite(e) && e > 0 && e > now.getTime() / 1000);
  return future.length ? Math.min(...future) : undefined;
};

// Cycle end is Kiro's nextDateReset (epoch seconds) when it is a future instant.
// Otherwise falls back to the first day of next calendar month, the Pace behaviour.
export const resolveCycleEnd = (nextDateReset, now) => {
  if (Number.isFinite(nextDateReset) && nextDateReset > 0) {
    const end = new Date(nextDateReset * 1000);
    if (end.getTime() > now.getTime()) return end;
  }
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
};

// Workdays from today (inclusive, when it is a workday) up to but excluding the cycle end day.
export const workdaysRemaining = (now, cycleEnd) => {
  const endDay = localDay(cycleEnd).getTime();
  let count = 0;
  for (let d = localDay(now); d.getTime() < endDay; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if (isWorkday(d)) count++;
  }
  return count;
};

// Start-of-day remaining credits spread over remaining workdays. Today's spend is backed out of
// `used`, so the budget stays fixed while the day's usage grows. Null when undefined.
export const dailyBudget = (limit, used, today, workdays) => {
  if (!(limit > 0) || !(workdays > 0)) return null;
  const startOfDayUsed = Math.max(0, used - today);
  return Math.max(0, limit - startOfDayUsed) / workdays;
};

// Sum of bucket totals starting at or after local midnight of `now`.
export const todayCredits = (buckets, now) => {
  const midnight = localDay(now).getTime();
  return (buckets || []).reduce((sum, b) => {
    const start = new Date(b.start).getTime();
    return start >= midnight ? sum + (b.total || 0) : sum;
  }, 0);
};

// HTML for the line under Pace. Returns '' when today is unknown or no budget can be computed.
export const dailyBudgetLine = (today, limit, used, workdays) => {
  if (today === null || today === undefined) return '';
  const label = "Today (this machine's logs)";
  const credits = today.toFixed(2);
  if (workdays === 0) {
    return `<div class="daily-budget">${label}: ${credits} credits · no workdays left in cycle</div>`;
  }
  const budget = dailyBudget(limit, used, today, workdays);
  if (budget === null) return '';
  if (budget === 0) {
    const over = today > 0;
    return `<div class="daily-budget${over ? ' red' : ''}">${label}: ${credits} credits${over ? ' · over limit' : ''} (budget 0.00/workday, ${workdays} workdays left)</div>`;
  }
  const pct = Math.round((today / budget) * 100);
  const colorClass = pct >= 90 ? 'red' : pct >= 75 ? 'orange' : 'green';
  return `<div class="daily-budget ${colorClass}">${label}: ${credits} credits · ${pct}% of daily budget (budget ${budget.toFixed(2)}/workday, ${workdays} workdays left)</div>`;
};
