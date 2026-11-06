// Brings data saved by older versions of ReLeet up to date. The worker runs it
// after every update; each step leaves already-current data alone, so running
// it twice changes nothing.

import { getProblemMap, getSettings, saveProblemMap, saveSettings, withStorageLock } from './storage.js';
import { currentInterval, reviewDay } from './srs.js';

// Before 1.0 the middle rating was called Medium, which is LeetCode's word for difficulty.
const rename = (rating) => (rating === 'medium' ? 'okay' : rating);

// Pure. A stored problem in the current shape: ratings renamed, the interval
// stored (worked out from its last rating and review day), the review day kept
// as a date. `notifiedFor` belonged to the old one-notification-per-review.
export function upgradeProblem(problem) {
  const { notifiedFor, ...rest } = problem;
  const next = {
    ...rest,
    rating: rename(rest.rating),
    history: Array.isArray(rest.history) ? rest.history.map((h) => ({ ...h, rating: rename(h?.rating) })) : [],
  };
  if (typeof next.dueDay !== 'string' && Number.isFinite(next.dueAt)) next.dueDay = reviewDay(next);
  if (!Number.isInteger(next.interval)) next.interval = currentInterval(next);
  return next;
}

async function upgradeProblems() {
  const map = await getProblemMap();
  let changed = false;
  for (const [id, problem] of Object.entries(map)) {
    const next = upgradeProblem(problem);
    if (JSON.stringify(next) !== JSON.stringify(problem)) {
      map[id] = next;
      changed = true;
    }
  }
  if (changed) await saveProblemMap(map);
}

async function renameMediumDuration() {
  const { settings } = await chrome.storage.local.get('settings');
  const { medium, ...durations } = settings?.durations ?? {};
  if (medium === undefined) return;
  await saveSettings({ ...settings, durations: { ...durations, okay: durations.okay ?? medium } });
}

// v0.2 synced from a GitHub repo, optionally with a token. That's gone, so
// don't keep the token, its sync state or its alarms around.
async function dropGitHubSync() {
  const { owner, repo, branch, token, ...settings } = await getSettings();
  if ([owner, repo, branch, token].some((v) => v !== undefined)) await saveSettings(settings);
  await chrome.storage.local.remove('sync');
  const alarms = await chrome.alarms.getAll();
  const stale = alarms.filter((a) => a.name === 'github-sync' || a.name.startsWith('after-submit:'));
  await Promise.all(stale.map((a) => chrome.alarms.clear(a.name)));
}

// Outlook was removed before 1.0 (docs/adr/0003-no-outlook.md). Its stored
// tokens go with it.
async function dropOutlook() {
  const { calendars } = await chrome.storage.local.get('calendars');
  if (!calendars || !Object.hasOwn(calendars, 'outlook')) return;
  const { outlook, ...rest } = calendars;
  await chrome.storage.local.set({ calendars: rest });
}

export function migrateStoredData() {
  return withStorageLock(async () => {
    // Before dropGitHubSync, which saves settings with today's defaults filled in.
    await renameMediumDuration();
    await dropGitHubSync();
    await dropOutlook();
    await upgradeProblems();
  });
}
