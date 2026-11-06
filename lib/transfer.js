// Export / Import: moving ReLeet to another main computer (docs/adr/0001).
// Pure — no chrome.* APIs — the worker reads and writes storage around it.
//
// An export holds problems (with their history), solves waiting to be rated,
// settings, the LeetCode detection state, and each calendar's id and event
// map. It never holds a sign-in: no token and no Apple password. After an
// import the user connects each calendar again, and Connect picks up the same
// ReLeet calendar from the id instead of making a second one.

import { upgradeProblem } from './migrate.js';
import { RATINGS, isDayKey, isValidRating } from './srs.js';

const EXPORT_FORMAT = 'releet-export';
const EXPORT_VERSION = 1;
const MAX_SEEN_IDS = 200;

export class ImportError extends Error {}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isWebUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);

// What a calendar keeps across computers: where its blocks are, never how to sign in.
function exportCalendar(name, state) {
  const out = { calendarId: state.calendarId ?? null, events: { ...(state.events ?? {}) }, account: state.account ?? null };
  if (name === 'apple' && state.auth?.appleId) out.appleId = state.auth.appleId;
  return out;
}

export function buildExport({ problems = {}, pending = {}, settings = {}, leetcode = {}, calendars = {} }, now = Date.now()) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date(now).toISOString(),
    problems,
    pending,
    settings,
    leetcode: {
      username: leetcode.username ?? null,
      baselineAt: leetcode.baselineAt ?? null,
      seenIds: leetcode.seenIds ?? [],
    },
    calendars: Object.fromEntries(
      Object.entries(calendars)
        .filter(([, state]) => state?.calendarId)
        .map(([name, state]) => [name, exportCalendar(name, state)]),
    ),
  };
}

function checkProblem(id, raw) {
  const where = `problem "${id}"`;
  if (!isObject(raw)) throw new ImportError(`The file's ${where} isn't readable.`);
  const problem = upgradeProblem({ ...raw, id });
  const valid =
    typeof problem.title === 'string' &&
    isWebUrl(problem.url) &&
    isValidRating(problem.rating) &&
    Number.isFinite(problem.dueAt) &&
    isDayKey(problem.dueDay) &&
    problem.history.every((h) => Number.isFinite(h?.at) && isValidRating(h.rating));
  if (!valid) throw new ImportError(`The file's ${where} is missing something ReLeet needs.`);
  return problem;
}

function checkPending(id, raw) {
  if (!isObject(raw) || typeof raw.title !== 'string' || !isWebUrl(raw.url)) {
    throw new ImportError(`The file's solve of "${id}" isn't readable.`);
  }
  return { ...raw, id };
}

const wholeIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

// The settings an export may set, each only with a value Settings itself
// would save. Anything else keeps this computer's default.
function checkSettings(raw) {
  if (!isObject(raw)) return {};
  const out = {};
  const time = /^(\d{2}):(\d{2})$/.exec(raw.startTime ?? '');
  if (time && Number(time[1]) < 24 && Number(time[2]) < 60) out.startTime = raw.startTime;
  if (wholeIn(raw.dailyLimit, 15, 600)) out.dailyLimit = raw.dailyLimit;
  if (wholeIn(raw.reminderMinutes, 0, 24 * 60)) out.reminderMinutes = raw.reminderMinutes;
  if (typeof raw.dailySummary === 'boolean') out.dailySummary = raw.dailySummary;
  if (typeof raw.leetcodeUsername === 'string') out.leetcodeUsername = raw.leetcodeUsername.trim();
  if (['auto', 'manual'].includes(raw.leetcodeUsernameSource)) out.leetcodeUsernameSource = raw.leetcodeUsernameSource;
  const durations = isObject(raw.durations) ? raw.durations : {};
  const lengths = Object.fromEntries(RATINGS.filter((r) => wholeIn(durations[r], 5, 240)).map((r) => [r, durations[r]]));
  if (Object.keys(lengths).length) out.durations = lengths;
  return out;
}

// Checks a parsed export file (outside data) and brings it to the current shape.
export function parseExport(data) {
  if (!isObject(data) || data.format !== EXPORT_FORMAT) {
    throw new ImportError("This isn't a ReLeet export file.");
  }
  if (data.version !== EXPORT_VERSION) {
    throw new ImportError('This export comes from a newer version of ReLeet. Update ReLeet and try again.');
  }
  const map = (value) => (isObject(value) ? Object.entries(value) : []);
  const leetcode = isObject(data.leetcode) ? data.leetcode : {};
  return {
    problems: Object.fromEntries(map(data.problems).map(([id, p]) => [id, checkProblem(id, p)])),
    pending: Object.fromEntries(map(data.pending).map(([id, s]) => [id, checkPending(id, s)])),
    settings: checkSettings(data.settings),
    leetcode: {
      username: typeof leetcode.username === 'string' ? leetcode.username : null,
      baselineAt: Number.isFinite(leetcode.baselineAt) ? leetcode.baselineAt : null,
      seenIds: Array.isArray(leetcode.seenIds) ? leetcode.seenIds.map(String) : [],
    },
    calendars: Object.fromEntries(
      map(data.calendars)
        .filter(([name, c]) => ['google', 'apple'].includes(name) && isObject(c) && typeof c.calendarId === 'string')
        .map(([name, c]) => [name, { ...c, events: isObject(c.events) ? c.events : {} }]),
    ),
  };
}

const lastRatedAt = (problem) => Math.max(0, ...(problem.history ?? []).map((h) => Number(h.at) || 0));

// Merges an import into this computer's data. For each problem the copy with
// the later rating wins; imported settings replace these. A calendar connected
// here stays as it is; any other is remembered without a sign-in, ready to be
// connected again.
export function mergeImport(local, imported) {
  const problems = { ...local.problems };
  let added = 0;
  for (const [id, problem] of Object.entries(imported.problems)) {
    if (!problems[id]) added++;
    if (!problems[id] || lastRatedAt(problem) > lastRatedAt(problems[id])) problems[id] = problem;
  }

  const pending = { ...local.pending };
  for (const [id, solve] of Object.entries(imported.pending)) {
    if (!pending[id] || (solve.submittedAt ?? 0) > (pending[id].submittedAt ?? 0)) pending[id] = solve;
  }

  const here = local.leetcode ?? {};
  const theirs = imported.leetcode;
  const sameUser = theirs.username && here.username === theirs.username;
  const leetcode = sameUser
    ? {
        ...here,
        baselineAt: Math.min(here.baselineAt ?? Infinity, theirs.baselineAt ?? Infinity),
        seenIds: [...new Set([...(here.seenIds ?? []), ...theirs.seenIds])].slice(-MAX_SEEN_IDS),
      }
    : { username: theirs.username, baselineAt: theirs.baselineAt, seenIds: theirs.seenIds.slice(-MAX_SEEN_IDS) };
  if (!Number.isFinite(leetcode.baselineAt)) leetcode.baselineAt = null;

  const calendars = { ...local.calendars };
  for (const [name, c] of Object.entries(imported.calendars)) {
    if (calendars[name]?.connected) continue;
    calendars[name] = {
      connected: false,
      calendarId: c.calendarId,
      events: c.events,
      // The other computer may have changed the calendar after this export.
      checkStrays: true,
      account: c.account ?? null,
      ...(name === 'apple' && c.appleId ? { auth: { appleId: c.appleId } } : {}),
    };
  }

  return { problems, pending, settings: imported.settings, leetcode, calendars, added };
}
