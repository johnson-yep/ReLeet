// Detects new Accepted LeetCode submissions and queues them as pending ratings.
// Runs in the background service worker. Two sources feed it:
//   - the content script on leetcode.com, right after a submission is Accepted
//     in this browser (recordAcceptedFromPage);
//   - a periodic check of the user's public recent accepted submissions, which
//     catches solves on other devices (syncLeetCode).

import { createLeetCodeClient } from './leetcode.js';
import { leetcodeUrl, titleFromSlug } from './problem.js';
import { startOfDay } from './srs.js';
import {
  addPending,
  getLeetCodeState,
  getPendingMap,
  getProblemMap,
  getSettings,
  saveLeetCodeState,
  updateSettings,
} from './storage.js';

export const SYNC_INTERVAL_MINUTES = 15;

const STALE_AFTER_MS = 60 * 1000;
const RECENT_LIMIT = 20; // LeetCode returns at most ~20 anyway
const MAX_SEEN_IDS = 200;
// How long after a solve a leetcode.com tab may still be confirming it: its
// checks run for a minute after Submit, plus slack for a slow judge.
const PAGE_CONFIRM_MS = 2 * 60 * 1000;

// Every function here reads and rewrites the 'leetcode' state and the pending
// queue. Running those steps one at a time keeps a page report and a sync that
// finish together from overwriting each other's seenIds. Network calls stay
// outside, so a slow LeetCode never delays the in-page prompt.
let queue = Promise.resolve();
function exclusive(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

const configuredUsername = (settings) => String(settings.leetcodeUsername ?? '').trim();

// Appends ids not seen yet and keeps only the latest MAX_SEEN_IDS.
function mergeSeen(seenIds = [], ids) {
  const seen = new Set(seenIds);
  const out = [...seenIds];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(-MAX_SEEN_IDS);
}

const idsOldestFirst = (recent) => [...recent].sort((a, b) => a.timestamp - b.timestamp).map((s) => s.submissionId);

// Where a new baseline starts. Every listed id is marked seen anyway, so just
// past the newest listed solve is as safe as now, and it's LeetCode's clock:
// with ours running fast, `now` would drop solves made right after connecting.
// The extra second keeps that newest solve itself new if this page reports it.
function baselineFrom(recent, now) {
  if (!recent.length) return now;
  return Math.min(now, Math.max(...recent.map((s) => s.timestamp)) + 1000);
}

// True if the problem already has a rating from the submission's local day or
// later, so this solve was already counted (in-page prompt, popup, manual add).
// "Or later" stops an older solve from another device rewinding a newer rating.
function ratedSince(problem, at) {
  const day = startOfDay(at);
  return (problem?.history ?? []).some((h) => startOfDay(h.at) >= day);
}

function toPending({ submissionId, slug, title, timestamp }, now) {
  return {
    id: slug,
    title: title || titleFromSlug(slug),
    url: leetcodeUrl(slug),
    // LeetCode's clock can run ahead of ours; a solve can't be in the future.
    submittedAt: Math.min(timestamp, now),
    submissionId: String(submissionId),
    source: 'leetcode',
  };
}

// Keeps the latest submission per problem.
function latestPerSlug(submissions) {
  const bySlug = new Map();
  for (const s of submissions) {
    if (!bySlug.has(s.slug) || s.timestamp > bySlug.get(s.slug).timestamp) bySlug.set(s.slug, s);
  }
  return [...bySlug.values()];
}

// Pure. Picks the submissions to queue from LeetCode's recent accepted list.
// `problems` is the tracked problem map. Every id in `recent` is marked seen,
// including skipped ones, so they're never reconsidered.
export function selectNewSubmissions(recent, state, problems = {}, now = Date.now()) {
  const { baselineAt = 0, seenIds = [] } = state ?? {};
  const seen = new Set(seenIds);
  const fresh = recent.filter((s) => s.timestamp >= baselineAt && !seen.has(s.submissionId));
  const submissions = latestPerSlug(fresh)
    .filter((s) => !ratedSince(problems[s.slug], s.timestamp))
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((s) => toPending(s, now));
  return { submissions, seenIds: mergeSeen(seenIds, idsOldestFirst(recent)) };
}

// Pure. The detections worth a system notification, given the problems open
// in leetcode.com tabs. A solve made moments ago on an open problem is left to
// that tab, which shows its own prompt a few seconds later: a check that just
// happened to run first shouldn't announce it twice.
export function detectionsToNotify(detected, openSlugs = new Set(), now = Date.now()) {
  return detected.filter((s) => !(openSlugs.has(s.id) && now - s.submittedAt < PAGE_CONFIRM_MS));
}

let inFlight = null; // { username, run }: the check in progress and whose it is

// Concurrent callers (alarm, popup, "Sync now") share a single run.
export async function syncLeetCode() {
  return startSync(configuredUsername(await getSettings()));
}

// A run for another username (it just changed) isn't shared: wait for it, then
// run once for the new one, so its baseline isn't left for the next alarm.
function startSync(username) {
  if (inFlight?.username === username) return inFlight.run;
  const previous = inFlight?.run.catch(() => {});
  const run = Promise.resolve(previous)
    .then(() => runSync(username))
    .finally(() => {
      if (inFlight?.run === run) inFlight = null;
    });
  inFlight = { username, run };
  return run;
}

// Used when the popup opens: check unless one just ran for this username.
export async function syncIfStale() {
  const [state, settings] = await Promise.all([getLeetCodeState(), getSettings()]);
  const username = configuredUsername(settings);
  const fresh = state.username === username && Date.now() - (state.lastSyncAt ?? 0) < STALE_AFTER_MS;
  if (!inFlight && fresh) return { status: 'fresh', added: 0, detected: [], error: null };
  return startSync(username);
}

async function runSync(username) {
  if (!username) return { status: 'unconfigured', added: 0, detected: [], error: null };

  let recent;
  try {
    recent = await createLeetCodeClient().recentAccepted(username, RECENT_LIMIT);
  } catch (e) {
    const error = e.message;
    await exclusive(async () => {
      await saveLeetCodeState({ ...(await getLeetCodeState()), lastSyncAt: Date.now(), lastError: error });
    });
    return { status: 'error', added: 0, detected: [], error };
  }

  return exclusive(async () => {
    const state = await getLeetCodeState();
    const now = Date.now();

    // First check for this username: remember what's there without queueing
    // past solves. "Import recent" in Settings covers those.
    if (state.username !== username || state.baselineAt == null) {
      await saveLeetCodeState({
        username,
        baselineAt: baselineFrom(recent, now),
        seenIds: mergeSeen([], idsOldestFirst(recent)),
        lastSyncAt: now,
        lastError: null,
      });
      return { status: 'baseline', added: 0, detected: [], error: null };
    }

    const [problems, pending] = await Promise.all([getProblemMap(), getPendingMap()]);
    const { submissions, seenIds } = selectNewSubmissions(recent, state, problems, now);
    // An update to an already-pending problem isn't news; don't notify for it.
    const detected = submissions.filter((s) => !pending[s.id]);
    const added = await addPending(submissions);
    await saveLeetCodeState({ ...state, seenIds, lastSyncAt: now, lastError: null });
    return { status: 'ok', added, detected, error: null };
  });
}

// Queues the latest accepted submission of every recent problem that isn't
// tracked yet. Also counts as a successful check (and a baseline if needed),
// so it first queues what a check would have: it marks every recent id seen,
// which would otherwise drop an unchecked review of a tracked problem for good.
export async function importRecent() {
  const username = configuredUsername(await getSettings());
  if (!username) return { status: 'unconfigured', added: 0 };

  let recent;
  try {
    recent = await createLeetCodeClient().recentAccepted(username, RECENT_LIMIT);
  } catch (e) {
    return { status: 'error', error: e.message, added: 0 };
  }

  return exclusive(async () => {
    const [state, problems] = await Promise.all([getLeetCodeState(), getProblemMap()]);
    const now = Date.now();
    // A new username starts from a baseline, so its past reviews stay ignored.
    const sameUser = state.username === username && state.baselineAt != null;
    const unchecked = sameUser ? selectNewSubmissions(recent, state, problems, now).submissions : [];
    const imports = latestPerSlug(recent)
      .filter((s) => !problems[s.slug])
      .map((s) => toPending(s, now));
    // A problem in both lists is counted once; its later submission is kept.
    const added = await addPending([...unchecked, ...imports]);

    await saveLeetCodeState({
      ...state,
      username,
      baselineAt: sameUser ? state.baselineAt : baselineFrom(recent, now),
      seenIds: mergeSeen(sameUser ? state.seenIds : [], idsOldestFirst(recent)),
      lastSyncAt: now,
      lastError: null,
    });
    return { status: 'ok', added };
  });
}

// The page sends milliseconds. Accept seconds too (LeetCode's own unit) so a
// slip there can't date a solve to 1970; fall back to now if it's missing.
function pageTimestamp(value, now) {
  const t = value == null || value === '' ? NaN : Number(value);
  if (!Number.isFinite(t) || t <= 0) return now;
  return t < 1e12 ? t * 1000 : t;
}

// Called by the content script once LeetCode's API confirms an Accepted
// submission in this browser. The page shows its rating prompt only for 'queued'.
//   queued        newly pending, or already pending (so the prompt shows again)
//   already-rated the problem already has a rating from that day
//   duplicate     this submission was already handled (e.g. dismissed in the popup)
export function recordAcceptedFromPage({ submissionId, slug, title, timestamp } = {}) {
  if (!slug || submissionId == null || submissionId === '') {
    return Promise.reject(new Error('Submission is missing its id or problem slug.'));
  }
  return exclusive(async () => {
    const [state, problems, pending, settings] = await Promise.all([
      getLeetCodeState(),
      getProblemMap(),
      getPendingMap(),
      getSettings(),
    ]);
    const now = Date.now();
    const submission = toPending({ submissionId, slug, title, timestamp: pageTimestamp(timestamp, now) }, now);
    const id = submission.submissionId;
    const at = submission.submittedAt;
    const tracked = Boolean(problems[slug]);

    // No baseline yet (no successful check so far): start it here so the
    // first check doesn't treat this solve as history.
    const next = { ...state };
    if (next.baselineAt == null) {
      next.baselineAt = at;
      next.username ??= configuredUsername(settings) || null;
    }

    // Ids a baseline marked seen were never offered to the user, so only
    // ids from after the baseline count as handled.
    const handled = (state.seenIds ?? []).includes(id) && at >= (state.baselineAt ?? 0);

    let status;
    if (pending[slug]) status = 'queued';
    else if (ratedSince(problems[slug], at)) status = 'already-rated';
    else if (handled) status = 'duplicate';
    else status = 'queued';

    if (status === 'queued') await addPending([submission]);
    next.seenIds = mergeSeen(state.seenIds, [id]);
    await saveLeetCodeState(next);
    return { status, pendingId: slug, tracked };
  });
}

// The content script reports who is signed in on leetcode.com. It may fill an
// empty username or replace one that was itself auto-detected, but never one
// the user typed in Settings.
export async function setDetectedUsername(username) {
  const name = String(username ?? '').trim();
  if (!name) return { changed: false };
  const settings = await getSettings();
  const current = configuredUsername(settings);
  const replaceable = !current || settings.leetcodeUsernameSource === 'auto';
  if (!replaceable || current === name) return { changed: false };
  await updateSettings({ leetcodeUsername: name, leetcodeUsernameSource: 'auto' });
  return { changed: true };
}
