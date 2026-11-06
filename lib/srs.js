// Spaced-repetition logic. Pure functions only — no chrome.* APIs — so this
// module can be reused in a web app or swapped for a smarter scheduler later.
//
// Instants are stored as epoch milliseconds and review days as 'YYYY-MM-DD'
// strings, so records stay JSON-serializable.
//
// Problem: { id, title, url, rating, interval, solvedAt, dueAt, dueDay,
//            masteredAt?, commitSha, source, history: [{ at, rating, commitSha }] }
// `rating` is the latest rating and `interval` the days from that rating to
// `dueDay`. The history keeps every rating, for a smarter scheduler later.

// Days to the first review after a problem's first solve.
export const FIRST_INTERVAL = Object.freeze({ easy: 7, okay: 3, hard: 1 });
export const RATINGS = Object.freeze(Object.keys(FIRST_INTERVAL));
// Each later review multiplies the interval; Hard starts over at one day.
const GROWTH = Object.freeze({ easy: 2.5, okay: 1.5 });
export const MAX_INTERVAL = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

export function isValidRating(rating) {
  return Object.hasOwn(FIRST_INTERVAL, rating);
}

export const isMastered = (problem) => Number.isFinite(problem?.masteredAt);

// Local midnight of the given time. Review dates are day-granular: a problem
// due "in 3 days" becomes due at the start of that day, not at the same clock time.
export function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
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

// Whole days from one 'YYYY-MM-DD' day to another, unaffected by DST.
export function daysBetween(fromDay, toDay) {
  const utc = (day) => {
    const [y, m, d] = String(day).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(toDay) - utc(fromDay)) / DAY_MS);
}

export function addDaysToDay(day, days) {
  return dayKey(addDays(dayStartMs(day), days));
}

// The date a review is due. dueAt is an instant (local midnight where it was
// rated), so after a move to a zone further west it would fall on the day
// before; dueDay keeps the date itself. Problems saved before dueDay existed
// fall back to dueAt.
export function reviewDay(problem) {
  return typeof problem?.dueDay === 'string' ? problem.dueDay : dayKey(problem?.dueAt);
}

// The day of the last rating (or the first solve, for records without history).
function lastRatedDay(problem) {
  const at = Number(problem?.history?.at(-1)?.at ?? problem?.solvedAt);
  return Number.isFinite(at) ? dayKey(at) : null;
}

// The interval the problem is on. Problems saved before intervals were stored
// take the gap from their last rating to their review day.
export function currentInterval(problem) {
  const stored = Number(problem?.interval);
  if (Number.isInteger(stored) && stored >= 1) return Math.min(stored, MAX_INTERVAL);
  const from = lastRatedDay(problem);
  const gap = from ? daysBetween(from, reviewDay(problem)) : NaN;
  return Number.isFinite(gap) ? Math.min(Math.max(gap, 1), MAX_INTERVAL) : FIRST_INTERVAL.okay;
}

// The interval a rating would give: the first one for a problem not tracked
// yet, else the current interval grown (or Hard: back to one day), in whole
// days. `capped`: the rating reaches the longest interval, where ReLeet
// suggests marking the problem mastered.
export function nextInterval(problem, rating) {
  if (!isValidRating(rating)) throw new Error(`Unknown rating: ${rating}`);
  if (!problem) return { days: FIRST_INTERVAL[rating], capped: false };
  if (rating === 'hard') return { days: 1, capped: false };
  const days = Math.round(currentInterval(problem) * GROWTH[rating]);
  return { days: Math.min(days, MAX_INTERVAL), capped: days >= MAX_INTERVAL };
}

function scheduledAfter(at, days) {
  const dueAt = addDays(startOfDay(at), days);
  return { interval: days, dueAt, dueDay: dayKey(dueAt) };
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
  const { days } = nextInterval(null, rating);
  return {
    id,
    title,
    url,
    rating,
    solvedAt,
    ...scheduledAfter(solvedAt, days),
    commitSha,
    source,
    history: [{ at: solvedAt, rating, commitSha }],
  };
}

// Records a completed review and schedules the next one. Rating a mastered
// problem (re-adding it by hand) brings it back into review.
export function recordReview(problem, rating, { at = Date.now(), commitSha = null } = {}) {
  const { days } = nextInterval(problem, rating);
  const { masteredAt, ...rest } = problem;
  return {
    ...rest,
    rating,
    ...scheduledAfter(at, days),
    commitSha: commitSha ?? problem.commitSha,
    history: [...(problem.history ?? []), { at, rating, commitSha }],
  };
}

// Retires a problem from reviews. Its history and interval stay.
export function markMastered(problem, at = Date.now()) {
  return { ...problem, masteredAt: at };
}

// Back into review: due its last interval from today.
export function resumeProblem(problem, at = Date.now()) {
  const { masteredAt, ...rest } = problem;
  return { ...rest, ...scheduledAfter(at, currentInterval(problem)) };
}

// A solve of a problem: starts tracking it, or counts as a review if it's
// already tracked. Used for manual entries and for detected LeetCode solves.
export function applySolve(existing, { id, title, url, at = Date.now(), commitSha = null, source = 'manual' }, rating) {
  return existing
    ? recordReview(existing, rating, { at, commitSha })
    : createProblem({ id, title, url, rating, solvedAt: at, commitSha, source });
}
