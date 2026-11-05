// Thin wrapper over chrome.storage.local.
//
// Keys:
//   problems   { [id]: Problem }                tracked problems (see srs.js)
//   pending    { [id]: Submission }             detected solves awaiting a rating
//   settings   Settings (see DEFAULT_SETTINGS)   user preferences
//   leetcode   { username, baselineAt, seenIds, lastSyncAt, lastError }
//   schedule   { layoutKey, entries: { [problemId]: Slot } }   planned calendar blocks (see schedule.js)
//   calendars  { google?, outlook?, apple? }     per-provider connection + event mapping.
//              Written only by the service worker (calendar-sync.js), so writes don't race.

const KEYS = {
  problems: 'problems',
  pending: 'pending',
  settings: 'settings',
  leetcode: 'leetcode',
  schedule: 'schedule',
  calendars: 'calendars',
};

export const DEFAULT_SETTINGS = Object.freeze({
  leetcodeUsername: '',
  leetcodeUsernameSource: null, // 'auto' (picked up from leetcode.com) or 'manual' (typed in Settings)
  startTime: '09:00', // local time of the first review block each day
  durations: Object.freeze({ easy: 20, medium: 40, hard: 60 }), // block length in minutes, by rating
  reminderMinutes: 15,
});

// Read-modify-writes of the problems and pending maps run one at a time across
// the popup, the options page and the worker, so none of them writes back a
// map another has just changed (a rated problem coming back as pending, or a
// newly detected solve vanishing). Web Locks are shared by every page of the
// extension; where they don't exist (Node tests) a plain queue stands in.
// Not reentrant: never call a locked helper from inside withStorageLock.
const LOCK_NAME = 'releet-storage';
let localQueue = Promise.resolve();

export function withStorageLock(fn) {
  const locks = globalThis.navigator?.locks;
  if (typeof locks?.request === 'function') return locks.request(LOCK_NAME, () => fn());
  const run = localQueue.then(() => fn());
  localQueue = run.catch(() => {});
  return run;
}

async function read(key, fallback) {
  const { [key]: value = fallback } = await chrome.storage.local.get(key);
  return value;
}

function write(key, value) {
  return chrome.storage.local.set({ [key]: value });
}

// Problems

export const getProblemMap = () => read(KEYS.problems, {});
export const saveProblemMap = (map) => write(KEYS.problems, map);

export async function getProblems() {
  return Object.values(await getProblemMap());
}

export async function getProblem(id) {
  return (await getProblemMap())[id] ?? null;
}

// updater(map) returns the map to save (it may change the one it's given), or
// null to skip the write. → the saved map, or null.
export function updateProblemMap(updater) {
  return withStorageLock(async () => {
    const next = await updater(await getProblemMap());
    if (next) await saveProblemMap(next);
    return next ?? null;
  });
}

export function saveProblem(problem) {
  return updateProblemMap((map) => {
    map[problem.id] = problem;
    return map;
  });
}

export function deleteProblem(id) {
  return updateProblemMap((map) => {
    delete map[id];
    return map;
  });
}

// Pending submissions

export const getPendingMap = () => read(KEYS.pending, {});
export const savePendingMap = (map) => write(KEYS.pending, map);

export async function getPending() {
  return Object.values(await getPendingMap());
}

// Merges detected submissions into the pending queue. Multiple submissions of
// the same problem collapse into the latest one. Returns how many problems are
// newly pending (an update to an already-pending problem doesn't count).
export async function addPending(submissions) {
  if (!submissions.length) return 0;
  return withStorageLock(async () => {
    const pending = await getPendingMap();
    let added = 0;
    for (const s of submissions) {
      const existing = pending[s.id];
      if (!existing) added++;
      if (!existing || (s.submittedAt ?? 0) >= (existing.submittedAt ?? 0)) pending[s.id] = s;
    }
    await savePendingMap(pending);
    return added;
  });
}

export function dismissPending(ids) {
  return withStorageLock(async () => {
    const pending = await getPendingMap();
    for (const id of ids) delete pending[id];
    await savePendingMap(pending);
  });
}

// Rates a pending submission: rate(submission, trackedProblem | null) → the
// problem to save. Saves it and removes the pending entry in a single write,
// all under the lock, so rating twice at once (a double click, or the popup
// and the page) counts once. → the saved problem, or null if it's no longer pending.
export function resolvePending(id, rate) {
  return withStorageLock(async () => {
    const [pending, problems] = await Promise.all([getPendingMap(), getProblemMap()]);
    if (!Object.hasOwn(pending, id)) return null;
    const problem = rate(pending[id], Object.hasOwn(problems, id) ? problems[id] : null);
    delete pending[id];
    problems[problem.id] = problem;
    await chrome.storage.local.set({ [KEYS.pending]: pending, [KEYS.problems]: problems });
    return problem;
  });
}

// Settings. Always returns every field, with defaults filled in.

export function withDefaults(stored = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    durations: { ...DEFAULT_SETTINGS.durations, ...(stored.durations ?? {}) },
  };
}

export const getSettings = async () => withDefaults(await read(KEYS.settings, {}));
export const saveSettings = (settings) => write(KEYS.settings, settings);

export async function updateSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await saveSettings(next);
  return next;
}

// LeetCode detection state

export const getLeetCodeState = () => read(KEYS.leetcode, {});
export const saveLeetCodeState = (state) => write(KEYS.leetcode, state);

// Planned calendar blocks

export const getSchedule = () => read(KEYS.schedule, { layoutKey: null, entries: {} });
export const saveSchedule = (schedule) => write(KEYS.schedule, schedule);

// Calendar connections

export const getCalendars = () => read(KEYS.calendars, {});
export const saveCalendars = (calendars) => write(KEYS.calendars, calendars);

// Re-reads the latest value and replaces one provider's state, so a long sync
// never overwrites another provider's progress. Pass null to remove the provider.
export async function updateCalendarState(provider, updater) {
  const calendars = await getCalendars();
  const next = updater(calendars[provider] ?? null);
  if (next === null) delete calendars[provider];
  else calendars[provider] = next;
  await saveCalendars(calendars);
  return next;
}

// Change listeners

function onKeyChanged(key, callback, fallback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[key]) callback(changes[key].newValue ?? fallback, changes[key].oldValue ?? fallback);
  });
}

export function onProblemsChanged(callback) {
  onKeyChanged(KEYS.problems, (map) => callback(Object.values(map)), {});
}

export function onPendingChanged(callback) {
  onKeyChanged(KEYS.pending, (map) => callback(Object.values(map)), {});
}

// Callback receives (newSettings, oldSettings), both with defaults filled in.
export function onSettingsChanged(callback) {
  onKeyChanged(KEYS.settings, (next, prev) => callback(withDefaults(next), withDefaults(prev)), {});
}

export function onLeetCodeStateChanged(callback) {
  onKeyChanged(KEYS.leetcode, callback, {});
}

export function onScheduleChanged(callback) {
  onKeyChanged(KEYS.schedule, callback, { layoutKey: null, entries: {} });
}

export function onCalendarsChanged(callback) {
  onKeyChanged(KEYS.calendars, callback, {});
}
