import {
  getProblemMap,
  getProblem,
  getPending,
  getSettings,
  updateProblemMap,
  onProblemsChanged,
  onPendingChanged,
  onSettingsChanged,
} from './lib/storage.js';
import { RATINGS, isDue, nextDueAfter, compareDue } from './lib/srs.js';
import { ratePending } from './lib/rating.js';
import {
  SYNC_INTERVAL_MINUTES,
  detectionsToNotify,
  syncLeetCode,
  syncIfStale,
  importRecent,
  recordAcceptedFromPage,
  setDetectedUsername,
} from './lib/leetcode-sync.js';
import { syncCalendars, connectCalendar, disconnectCalendar, refreshSchedule } from './lib/calendar-sync.js';
import { migrateStoredData } from './lib/migrate.js';

const PERIODIC_ALARM = 'due-check';   // safety net in case a one-shot alarm is missed
const NEXT_DUE_ALARM = 'next-due';    // fires exactly when the next problem becomes due
const LEETCODE_ALARM = 'leetcode-sync';
const CALENDAR_ALARM = 'calendar-sync'; // retries failed calendar updates
const CALENDAR_SYNC_MINUTES = 15;
const REVIEW_NOTIFICATION_PREFIX = 'review:';
const PENDING_NOTIFICATION = 'pending';
const TEST_NOTIFICATION = 'test';

// Every listener is registered synchronously at the top level, so Chrome can
// wake this worker for any of them. Nothing that must survive a restart is
// kept in memory: it all lives in chrome.storage and alarms.

// chrome.storage.local holds calendar sign-ins (the iCloud app-specific
// password), and by default content scripts can read and write
// it too. Ours only sends messages, so keep storage to ReLeet's own pages and
// this worker. Chrome remembers the setting; older versions without it skip it.
try {
  chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })?.catch(() => {});
} catch {}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // Not for a Chrome update: the tabs' scripts are still running then.
  if (reason === 'install' || reason === 'update') addToOpenLeetCodeTabs();
  if (reason === 'update') await migrateStoredData();
  await init();
});
chrome.runtime.onStartup.addListener(init);

// Chrome adds manifest content scripts only to pages loaded after an install
// or update. A leetcode.com tab that was already open (people keep it open all
// day) has no script, or one from before the update that has stopped working:
// no prompt, and at install not even the username for the background check.
// So add the script to those tabs now (it skips a second copy in a tab).
async function addToOpenLeetCodeTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://leetcode.com/*' });
    for (const tab of tabs) {
      // Discarded tabs and error pages refuse; they get it when they load.
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/leetcode.js'] }).catch(() => {});
    }
  } catch {
    // No tabs to reach. Detection starts on the next leetcode.com page load.
  }
}

async function init() {
  await chrome.alarms.create(PERIODIC_ALARM, { periodInMinutes: 30 });
  await ensurePeriodicAlarm(CALENDAR_ALARM, CALENDAR_SYNC_MINUTES);
  await scheduleLeetCodeSync(await getSettings());
  await checkDue();
  syncCalendars();
}

// Re-creating an alarm restarts its countdown, so leave a matching one alone.
async function ensurePeriodicAlarm(name, periodInMinutes, delayInMinutes = periodInMinutes) {
  const existing = await chrome.alarms.get(name);
  if (existing?.periodInMinutes === periodInMinutes) return;
  await chrome.alarms.create(name, { delayInMinutes, periodInMinutes });
}

const leetcodeUsername = (settings) => String(settings.leetcodeUsername ?? '').trim();

// The background check needs a username; without one there's nothing to poll.
async function scheduleLeetCodeSync(settings) {
  if (!leetcodeUsername(settings)) return chrome.alarms.clear(LEETCODE_ALARM);
  await ensurePeriodicAlarm(LEETCODE_ALARM, SYNC_INTERVAL_MINUTES);
}

// Only these settings move calendar blocks or change what's written to them.
function scheduleSettingsChanged(next, prev) {
  return (
    next.startTime !== prev.startTime ||
    next.reminderMinutes !== prev.reminderMinutes ||
    RATINGS.some((r) => next.durations[r] !== prev.durations[r])
  );
}

onSettingsChanged(async (next, prev) => {
  if (leetcodeUsername(next) !== leetcodeUsername(prev)) {
    await scheduleLeetCodeSync(next);
    // A new username starts with a baseline, so its past solves aren't queued.
    if (leetcodeUsername(next)) runLeetCodeSync(syncLeetCode);
  }
  if (scheduleSettingsChanged(next, prev)) syncCalendars();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PERIODIC_ALARM || alarm.name === NEXT_DUE_ALARM) checkDue();
  if (alarm.name === LEETCODE_ALARM) runLeetCodeSync(syncLeetCode);
  if (alarm.name === CALENDAR_ALARM) syncCalendars();
});

// Rated from the in-page prompt on leetcode.com. The answer carries the
// review's calendar block, so only the planning step is awaited here. Saving
// the problem also starts a full calendar sync (onProblemsChanged), whose
// network calls shouldn't hold up the prompt.
async function rateFromPage({ id, rating }) {
  const problem = await ratePending(id, rating);
  if (!problem) return { status: 'gone' };
  const schedule = await refreshSchedule();
  return { status: 'ok', dueAt: problem.dueAt, slot: schedule.entries[problem.id] ?? null };
}

// The content script on leetcode.com may only report solves and ratings.
// Everything else (calendar sign-in, imports) comes from ReLeet's own pages.
const PAGE_HANDLERS = {
  'leetcode-user': (m) => setDetectedUsername(m.username),
  'leetcode-accepted': (m) => recordAcceptedFromPage(m.submission ?? {}),
  'rate-pending': rateFromPage,
};

const EXTENSION_HANDLERS = {
  ...PAGE_HANDLERS,
  'sync-now': () => runLeetCodeSync(syncLeetCode),
  'sync-if-stale': () => runLeetCodeSync(syncIfStale),
  'import-recent': importRecent,
  'calendar-connect': (m) => connectCalendar(m.provider, m.credentials),
  'calendar-disconnect': (m) => disconnectCalendar(m.provider, { force: Boolean(m.force) }),
  'calendar-sync-now': syncCalendars,
  'test-notification': testNotification,
};

function fromExtensionPage(sender) {
  return sender.id === chrome.runtime.id && Boolean(sender.url?.startsWith(chrome.runtime.getURL('')));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = fromExtensionPage(sender) ? EXTENSION_HANDLERS : PAGE_HANDLERS;
  const handler = Object.hasOwn(handlers, message?.type) ? handlers[message.type] : null;
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message))
    .then(sendResponse, (e) => sendResponse({ status: 'error', error: e?.message ?? String(e) }));
  return true; // keep the channel open for the async response
});

// Any change to problems (popup add/review/delete, a rating) reschedules
// alarms, the badge and the calendar blocks.
onProblemsChanged(async (problems) => {
  syncCalendars();
  await scheduleNextDue(problems);
  updateBadge();
  if (problems.some((p) => isDue(p) && p.notifiedFor !== p.dueAt)) checkDue();
});

onPendingChanged(() => updateBadge());

// Solves found by the background check raise a notification. Ones detected on
// the page don't: the in-page prompt already asked. Never rejects, so alarm
// and settings callers don't need their own error handling.
async function runLeetCodeSync(sync) {
  try {
    const result = await sync();
    if (result.added && result.detected?.length) {
      // A check landing just before an open tab confirms the same solve.
      const detected = detectionsToNotify(result.detected, await openProblemSlugs());
      if (detected.length) notifyPending(detected);
    }
    return result;
  } catch (e) {
    return { status: 'error', added: 0, detected: [], error: e?.message ?? String(e) };
  }
}

// Problems open in leetcode.com tabs. The host permission is enough to see
// those tabs' URLs (no "tabs" permission); other tabs come back without one.
async function openProblemSlugs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://leetcode.com/problems/*' });
    return new Set(tabs.map((t) => t.url?.match(/^https:\/\/leetcode\.com\/problems\/([a-z0-9-]+)/i)?.[1].toLowerCase()));
  } catch {
    return new Set();
  }
}

function notifyPending(detected) {
  const titles = [...new Set(detected.map((s) => s.title))];
  chrome.notifications.create(PENDING_NOTIFICATION, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: titles.length === 1 ? 'New submission detected' : `${titles.length} new submissions detected`,
    message: titles.slice(0, 3).join(', ') + (titles.length > 3 ? ', …' : ''),
    contextMessage: 'Click to rate how hard it felt.',
    priority: 1,
  });
}

async function checkDue() {
  const now = Date.now();
  let problems = [];
  let due = [];

  // notifiedFor remembers which due date we already notified about, so each
  // scheduled review notifies once and rescheduling naturally re-arms it.
  // Marked under the storage lock, so a rating saved meanwhile isn't undone.
  await updateProblemMap((map) => {
    problems = Object.values(map);
    due = problems.filter((p) => isDue(p, now) && p.notifiedFor !== p.dueAt);
    for (const p of due) map[p.id] = { ...p, notifiedFor: p.dueAt };
    return due.length ? map : null; // a write triggers onProblemsChanged → reschedule
  });
  for (const p of due) notifyReview(p);

  await scheduleNextDue(problems);
  updateBadge();
}

function notifyReview(problem) {
  chrome.notifications.create(REVIEW_NOTIFICATION_PREFIX + problem.id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Time to review',
    message: problem.title,
    contextMessage: `Last rated ${problem.rating}. Click to open the problem.`,
    priority: 2,
  });
}

// Settings → "Send a test notification": what a due review looks like (for
// the problem due soonest), without touching its due date or calendar block.
async function testNotification() {
  const [next] = Object.values(await getProblemMap()).sort(compareDue);
  if (next) {
    notifyReview(next);
  } else {
    chrome.notifications.create(TEST_NOTIFICATION, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Time to review',
      message: 'Notifications from ReLeet work.',
      contextMessage: 'Reviews you track will look like this when they are due.',
      priority: 2,
    });
  }
  return { status: 'ok', problem: next?.title ?? null };
}

async function scheduleNextDue(problems) {
  const next = nextDueAfter(problems);
  if (next === null) await chrome.alarms.clear(NEXT_DUE_ALARM);
  else await chrome.alarms.create(NEXT_DUE_ALARM, { when: next });
}

// Badge counts everything needing attention: due reviews plus unrated submissions.
async function updateBadge() {
  const [map, pending] = await Promise.all([getProblemMap(), getPending()]);
  const count = Object.values(map).filter((p) => isDue(p)).length + pending.length;
  chrome.action.setBadgeText({ text: count ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  chrome.notifications.clear(notificationId);
  if (notificationId === PENDING_NOTIFICATION) {
    await openPendingList();
    return;
  }
  if (!notificationId.startsWith(REVIEW_NOTIFICATION_PREFIX)) return;
  const problem = await getProblem(notificationId.slice(REVIEW_NOTIFICATION_PREFIX.length));
  if (problem?.url) chrome.tabs.create({ url: problem.url });
});

// The toolbar popup only opens in a focused Chrome window, and clicking a
// system notification usually comes from another app, which doesn't focus
// one. So focus the last window first. If the popup still can't open (Chrome
// before 127, no window, focus refused), show the same page in a tab, so the
// click always leads to the list.
async function openPendingList() {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    await chrome.windows.update(win.id, { focused: true });
    await chrome.action.openPopup({ windowId: win.id });
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?tab') }).catch(() => {});
  }
}
