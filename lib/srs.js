// Spaced-repetition logic. Pure functions only — no chrome.* APIs — so this
// module can be reused in a web app or swapped for a smarter scheduler later.
//
// Instants are stored as epoch milliseconds and review days as 'YYYY-MM-DD'
// strings, so records stay JSON-serializable.

export const INTERVAL_DAYS = Object.freeze({ easy: 7, medium: 3, hard: 1 });
export const RATINGS = Object.freeze(Object.keys(INTERVAL_DAYS));

export function isValidRating(rating) {
  return Object.hasOwn(INTERVAL_DAYS, rating);
}

// Local midnight of the given time. Review dates are day-granular: a problem
// due "in 3 days" becomes due at the start of that day, not at the same clock time.
export function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfDay(ms) {
  const d = new Date(ms);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

// Uses setDate rather than adding 24h multiples so DST shifts don't move the day.
export function addDays(ms, days) {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

const pad = (value, size = 2) => String(value).padStart(size, '0');

// Local calendar day, e.g. '2026-11-01'. Sorts correctly as a plain string.
export function dayKey(ms) {
  const d = new Date(ms);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Local midnight of a 'YYYY-MM-DD' day, in the current time zone.
export function dayStartMs(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

// The date a review is due. dueAt is an instant (local midnight where it was
// rated), so after a move to a zone further west it would fall on the day
// before; dueDay keeps the date itself. Problems saved before dueDay existed
// fall back to dueAt.
export function reviewDay(problem) {
  return typeof problem?.dueDay === 'string' ? problem.dueDay : dayKey(problem?.dueAt);
}

export function nextReviewAt(rating, fromMs = Date.now()) {
  if (!isValidRating(rating)) throw new Error(`Unknown rating: ${rating}`);
  return addDays(startOfDay(fromMs), INTERVAL_DAYS[rating]);
}

export function createProblem({
  id,
  title,
  url,
  rating,
  solvedAt = Date.now(),
  commitSha = null,
  source = 'manual',
}) {
  const dueAt = nextReviewAt(rating, solvedAt);
  return {
    id,
    title,
    url,
    rating,
    solvedAt,
    dueAt,
    dueDay: dayKey(dueAt),
    commitSha,
    source,
    history: [{ at: solvedAt, rating, commitSha }],
  };
}

// Records a completed review and reschedules. V1 uses fixed intervals per
// rating; history is kept so a future version can adapt intervals over time.
export function recordReview(problem, rating, { at = Date.now(), commitSha = null } = {}) {
  const dueAt = nextReviewAt(rating, at);
  return {
    ...problem,
    rating,
    dueAt,
    dueDay: dayKey(dueAt),
    commitSha: commitSha ?? problem.commitSha,
    history: [...(problem.history ?? []), { at, rating, commitSha }],
  };
}

// A solve of a problem: starts tracking it, or counts as a review if it's
// already tracked. Used for manual entries and for detected LeetCode solves.
export function applySolve(existing, { id, title, url, at = Date.now(), commitSha = null, source = 'manual' }, rating) {
  return existing
    ? recordReview(existing, rating, { at, commitSha })
    : createProblem({ id, title, url, rating, solvedAt: at, commitSha, source });
}

// Due from the start of its review day, in whatever zone the user is in now.
export function isDue(problem, nowMs = Date.now()) {
  return reviewDay(problem) <= dayKey(nowMs);
}

// Soonest review day first, then the earlier due time.
export function compareDue(a, b) {
  const dayA = reviewDay(a);
  const dayB = reviewDay(b);
  return (dayA < dayB ? -1 : dayA > dayB ? 1 : 0) || a.dueAt - b.dueAt;
}

// Splits problems into those due by the end of today and those due later,
// each sorted soonest first.
export function groupByDue(problems, nowMs = Date.now()) {
  const sorted = [...problems].sort(compareDue);
  return {
    dueToday: sorted.filter((p) => isDue(p, nowMs)),
    upcoming: sorted.filter((p) => !isDue(p, nowMs)),
  };
}

// When the next not-yet-due problem becomes due (local midnight of its day).
export function nextDueAfter(problems, nowMs = Date.now()) {
  let next = null;
  for (const p of problems) {
    if (isDue(p, nowMs)) continue;
    const at = dayStartMs(reviewDay(p));
    if (Number.isFinite(at) && (next === null || at < next)) next = at;
  }
  return next;
}
