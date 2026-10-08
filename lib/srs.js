// Spaced-repetition logic. Pure functions only — no chrome.* APIs — so this
// module can be reused in a web app or swapped for a smarter scheduler later.
//
// All dates are stored as epoch milliseconds so records stay JSON-serializable.

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
  return {
    id,
    title,
    url,
    rating,
    solvedAt,
    dueAt: nextReviewAt(rating, solvedAt),
    commitSha,
    source,
    history: [{ at: solvedAt, rating, commitSha }],
  };
}

// Records a completed review and reschedules. V1 uses fixed intervals per
// rating; history is kept so a future version can adapt intervals over time.
export function recordReview(problem, rating, { at = Date.now(), commitSha = null } = {}) {
  return {
    ...problem,
    rating,
    dueAt: nextReviewAt(rating, at),
    commitSha: commitSha ?? problem.commitSha,
    history: [...(problem.history ?? []), { at, rating, commitSha }],
  };
}

// A solve of a problem: starts tracking it, or counts as a review if it's
// already tracked. Used for both manual entries and GitHub submissions.
export function applySolve(existing, { id, title, url, at = Date.now(), commitSha = null, source = 'manual' }, rating) {
  return existing
    ? recordReview(existing, rating, { at, commitSha })
    : createProblem({ id, title, url, rating, solvedAt: at, commitSha, source });
}

export function isDue(problem, nowMs = Date.now()) {
  return problem.dueAt <= nowMs;
}

// Splits problems into those due by the end of today and those due later,
// each sorted soonest first.
export function groupByDue(problems, nowMs = Date.now()) {
  const cutoff = endOfDay(nowMs);
  const sorted = [...problems].sort((a, b) => a.dueAt - b.dueAt);
  return {
    dueToday: sorted.filter((p) => p.dueAt <= cutoff),
    upcoming: sorted.filter((p) => p.dueAt > cutoff),
  };
}

export function nextDueAfter(problems, nowMs = Date.now()) {
  let next = null;
  for (const p of problems) {
    if (p.dueAt > nowMs && (next === null || p.dueAt < next)) next = p.dueAt;
  }
  return next;
}
