// Brings data saved by older versions of ReLeet up to date. The worker runs it
// after every update; each step leaves already-current data alone, so running
// it twice changes nothing.

import { getSettings, saveSettings, withStorageLock } from './storage.js';

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
    await dropGitHubSync();
    await dropOutlook();
  });
}
