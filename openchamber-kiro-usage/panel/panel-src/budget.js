// Daily budget math for the Kiro usage panel. Pure functions, no DOM.
// Workdays are Mon-Fri in local time, matching the Pace line.

const isWorkday = (date) => {
  const day = date.getDay();
  return day >= 1 && day <= 5;
};

const localDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

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

// Rolling budget per workday: remaining credits spread over remaining workdays. Null when undefined.
export const dailyBudget = (limit, used, workdays) => {
  if (!(limit > 0) || !(workdays > 0)) return null;
  return Math.max(0, limit - used) / workdays;
};

// Sum of bucket totals starting at or after local midnight of `now`.
export const todayCredits = (buckets, now) => {
  const midnight = localDay(now).getTime();
  return (buckets || []).reduce((sum, b) => {
    const start = new Date(b.start).getTime();
    return start >= midnight ? sum + (b.total || 0) : sum;
  }, 0);
};
