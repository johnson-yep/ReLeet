// Thin wrapper over chrome.storage.local.
//
// Keys:
//   problems  { [id]: Problem }            tracked problems (see srs.js)
//   pending   { [id]: Submission }         detected submissions awaiting a rating
//   settings  { owner, repo, branch, token? }  GitHub repo to watch; token is optional
//   sync      { repoKey, lastSha, lastSyncAt, lastError }

const KEYS = { problems: 'problems', pending: 'pending', settings: 'settings', sync: 'sync' };

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

export async function saveProblem(problem) {
  const map = await getProblemMap();
  map[problem.id] = problem;
  await saveProblemMap(map);
}

export async function deleteProblem(id) {
  const map = await getProblemMap();
  delete map[id];
  await saveProblemMap(map);
}

// Pending submissions

export const getPendingMap = () => read(KEYS.pending, {});
export const savePendingMap = (map) => write(KEYS.pending, map);

export async function getPending() {
  return Object.values(await getPendingMap());
}

// Merges detected submissions into the pending queue. Multiple submissions of
// the same problem collapse into the latest one. Submissions whose commit is
// already in a problem's history are skipped.
export async function addPending(submissions) {
  if (!submissions.length) return 0;
  const [pending, problems] = await Promise.all([getPendingMap(), getProblemMap()]);
  let added = 0;
  for (const s of submissions) {
    const seen = s.commitSha && problems[s.id]?.history?.some((h) => h.commitSha === s.commitSha);
    if (seen) continue;
    if (!pending[s.id]) added++;
    pending[s.id] = s;
  }
  await savePendingMap(pending);
  return added;
}

export async function dismissPending(ids) {
  const pending = await getPendingMap();
  for (const id of ids) delete pending[id];
  await savePendingMap(pending);
}

// Saves the rated problem and removes its pending entry in a single write.
export async function resolvePending(id, problem) {
  const [pending, problems] = await Promise.all([getPendingMap(), getProblemMap()]);
  delete pending[id];
  problems[problem.id] = problem;
  await chrome.storage.local.set({ [KEYS.pending]: pending, [KEYS.problems]: problems });
}

// Settings and sync state

export const getSettings = () => read(KEYS.settings, {});
export const saveSettings = (settings) => write(KEYS.settings, settings);
export const getSyncState = () => read(KEYS.sync, {});
export const saveSyncState = (state) => write(KEYS.sync, state);

// Change listeners

function onKeyChanged(key, callback, fallback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[key]) callback(changes[key].newValue ?? fallback);
  });
}

export function onProblemsChanged(callback) {
  onKeyChanged(KEYS.problems, (map) => callback(Object.values(map)), {});
}

export function onPendingChanged(callback) {
  onKeyChanged(KEYS.pending, (map) => callback(Object.values(map)), {});
}

export function onSettingsChanged(callback) {
  onKeyChanged(KEYS.settings, callback, {});
}

export function onSyncStateChanged(callback) {
  onKeyChanged(KEYS.sync, callback, {});
}
