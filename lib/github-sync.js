// Detects new NeetCode submissions in the configured GitHub repo and queues
// them as pending ratings. Runs in the background service worker.

import { createGitHubClient } from './github.js';
import { parseSubmissionPath } from './problem.js';
import { getSettings, getSyncState, saveSyncState, getProblemMap, addPending } from './storage.js';

// Each new commit costs one API request; cap per sync to stay well under the
// 60 requests/hour unauthenticated limit. Remaining commits are picked up next sync.
const MAX_COMMITS_PER_SYNC = 20;

// A sync costs at least one request, so polling speed depends on the rate limit:
// with a token (5,000/hour) poll every minute, without one (60/hour) every 15.
export function syncIntervalMinutes(settings) {
  return settings.token ? 1 : 15;
}

const STALE_AFTER_MS = 30 * 1000;

let inFlight = null;

// Concurrent callers (alarm, popup, "Sync now") share a single run.
export function syncGitHub() {
  inFlight ??= runSync().finally(() => (inFlight = null));
  return inFlight;
}

// Used when the popup opens: sync unless one just ran.
export async function syncIfStale() {
  const { lastSyncAt = 0 } = await getSyncState();
  if (!inFlight && Date.now() - lastSyncAt < STALE_AFTER_MS) return { status: 'fresh', added: 0 };
  return syncGitHub();
}

function repoKey({ owner, repo, branch }) {
  return `${owner}/${repo}@${branch}`;
}

async function runSync() {
  const settings = await getSettings();
  if (!settings.owner) return { status: 'unconfigured', added: 0 };
  const { owner, repo, branch } = settings;
  const { getBranchHead, compareCommits, getCommit } = createGitHubClient(settings);
  const state = await getSyncState();
  const key = repoKey(settings);

  // First sync for this repo: remember the current head without importing
  // history. "Import existing problems" on the options page covers that.
  if (!state.lastSha || state.repoKey !== key) {
    try {
      const head = await getBranchHead(owner, repo, branch);
      await saveSyncState({ repoKey: key, lastSha: head.sha, lastSyncAt: Date.now(), lastError: null });
      return { status: 'baseline', added: 0 };
    } catch (e) {
      await saveSyncState({ ...state, lastSyncAt: Date.now(), lastError: e.message });
      return { status: 'error', error: e.message, added: 0 };
    }
  }

  let comparison;
  try {
    comparison = await compareCommits(owner, repo, state.lastSha, branch);
  } catch (e) {
    // 404 here usually means the last processed commit no longer exists
    // (history rewritten). Start over from the current head on the next sync.
    const lastSha = e.status === 404 ? null : state.lastSha;
    await saveSyncState({ ...state, lastSha, lastSyncAt: Date.now(), lastError: e.message });
    return { status: 'error', error: e.message, added: 0 };
  }

  const commits = comparison.commits.slice(0, MAX_COMMITS_PER_SYNC);
  const detected = [];
  let lastSha = state.lastSha;
  let processed = 0;
  let error = null;

  for (const { sha } of commits) {
    try {
      const commit = await getCommit(owner, repo, sha);
      const at = Date.parse(commit.commit.committer?.date ?? commit.commit.author?.date) || Date.now();
      for (const file of commit.files ?? []) {
        if (file.status === 'removed') continue;
        const submission = parseSubmissionPath(file.filename);
        if (submission) detected.push({ ...submission, commitSha: sha, submittedAt: at });
      }
      lastSha = sha;
      processed++;
    } catch (e) {
      error = e.message; // keep progress made so far; retry the rest next sync
      break;
    }
  }

  const added = await addPending(detected);
  await saveSyncState({ ...state, lastSha, lastSyncAt: Date.now(), lastError: error });
  return { status: error ? 'error' : 'ok', error, added, detected, commits: processed };
}

// Queues every problem currently in the repo that isn't already tracked, and
// moves the sync baseline to the current head. Costs two API requests.
export async function importExisting() {
  const settings = await getSettings();
  if (!settings.owner) return { status: 'unconfigured', added: 0 };
  const { owner, repo, branch } = settings;
  const { getBranchHead, listFilePaths } = createGitHubClient(settings);

  try {
    const head = await getBranchHead(owner, repo, branch);
    const [paths, problems] = await Promise.all([listFilePaths(owner, repo, head.treeSha), getProblemMap()]);

    const byId = new Map();
    for (const path of paths) {
      const s = parseSubmissionPath(path);
      if (s && !problems[s.id] && (byId.get(s.id)?.submissionNumber ?? -1) < s.submissionNumber) byId.set(s.id, s);
    }
    // The tree doesn't say when each file was committed, so solve date
    // defaults to the moment you rate it.
    const added = await addPending([...byId.values()].map((s) => ({ ...s, commitSha: null, submittedAt: null })));
    await saveSyncState({ repoKey: repoKey(settings), lastSha: head.sha, lastSyncAt: Date.now(), lastError: null });
    return { status: 'ok', added };
  } catch (e) {
    return { status: 'error', error: e.message, added: 0 };
  }
}
