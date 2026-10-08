import {
  getProblemMap,
  getProblem,
  getPending,
  getSettings,
  saveProblemMap,
  onProblemsChanged,
  onPendingChanged,
  onSettingsChanged,
} from './lib/storage.js';
import { isDue, nextDueAfter } from './lib/srs.js';
import { syncGitHub, syncIfStale, importExisting, syncIntervalMinutes } from './lib/github-sync.js';

const PERIODIC_ALARM = 'due-check';   // safety net in case a one-shot alarm is missed
const NEXT_DUE_ALARM = 'next-due';    // fires exactly when the next problem becomes due
const SYNC_ALARM = 'github-sync';
const SUBMIT_ALARM_PREFIX = 'after-submit:';
const REVIEW_NOTIFICATION_PREFIX = 'review:';
const PENDING_NOTIFICATION = 'pending';

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

async function init() {
  await chrome.alarms.create(PERIODIC_ALARM, { periodInMinutes: 30 });
  await scheduleSync(await getSettings());
  await checkDue();
}

// Polling speed depends on whether a token is set (see syncIntervalMinutes).
async function scheduleSync(settings) {
  if (!settings.owner) return chrome.alarms.clear(SYNC_ALARM);
  const periodInMinutes = syncIntervalMinutes(settings);
  const existing = await chrome.alarms.get(SYNC_ALARM);
  if (existing?.periodInMinutes === periodInMinutes) return;
  await chrome.alarms.create(SYNC_ALARM, { delayInMinutes: 0.1, periodInMinutes });
}

onSettingsChanged(scheduleSync);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PERIODIC_ALARM || alarm.name === NEXT_DUE_ALARM) checkDue();
  if (alarm.name === SYNC_ALARM) runSync();
  if (alarm.name.startsWith(SUBMIT_ALARM_PREFIX)) syncAfterSubmit();
});

// After a NeetCode submit, the commit usually lands within seconds but can lag.
// Check quickly, then back off, and stop as soon as a new commit shows up.
// Alarms can't fire sooner than 30s, so the first check uses a timer; the
// worker is guaranteed to be awake for it because the message just woke it.
const FIRST_CHECK_MS = 8 * 1000;
const FOLLOW_UP_DELAYS_MS = [30, 60, 120, 300].map((s) => s * 1000);

async function onSubmissionStarted() {
  await clearSubmitAlarms();
  const now = Date.now();
  await Promise.all(
    FOLLOW_UP_DELAYS_MS.map((delay, i) => chrome.alarms.create(SUBMIT_ALARM_PREFIX + i, { when: now + delay })),
  );
  setTimeout(syncAfterSubmit, FIRST_CHECK_MS);
  return { status: 'watching' };
}

async function syncAfterSubmit() {
  const result = await runSync();
  if (result.commits) await clearSubmitAlarms();
}

async function clearSubmitAlarms() {
  const alarms = await chrome.alarms.getAll();
  await Promise.all(
    alarms.filter((a) => a.name.startsWith(SUBMIT_ALARM_PREFIX)).map((a) => chrome.alarms.clear(a.name)),
  );
}

// Messages from the popup, options page, and NeetCode content script.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handlers = {
    'sync-now': runSync,
    'sync-if-stale': () => runSync(syncIfStale),
    'import-existing': importExisting,
    'submission-started': onSubmissionStarted,
  };
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler().then(sendResponse, (e) => sendResponse({ status: 'error', error: e.message }));
  return true; // keep the channel open for the async response
});

// Any change to problems (popup add/review/delete) reschedules alarms and the badge.
onProblemsChanged(async (problems) => {
  await scheduleNextDue(problems);
  updateBadge();
  if (problems.some((p) => isDue(p) && p.notifiedFor !== p.dueAt)) checkDue();
});

onPendingChanged(() => updateBadge());

async function runSync(sync = syncGitHub) {
  const result = await sync();
  if (result.added) notifyPending(result.detected);
  return result;
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
  const map = await getProblemMap();
  const problems = Object.values(map);
  const now = Date.now();

  // notifiedFor remembers which due date we already notified about, so each
  // scheduled review notifies once and rescheduling naturally re-arms it.
  const due = problems.filter((p) => isDue(p, now) && p.notifiedFor !== p.dueAt);
  for (const p of due) {
    chrome.notifications.create(REVIEW_NOTIFICATION_PREFIX + p.id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Time to review',
      message: p.title,
      contextMessage: `Last rated ${p.rating}. Click to open the problem.`,
      priority: 2,
    });
    map[p.id] = { ...p, notifiedFor: p.dueAt };
  }
  if (due.length) await saveProblemMap(map); // triggers onProblemsChanged → reschedule

  await scheduleNextDue(problems);
  updateBadge();
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
    // openPopup needs Chrome 127+ and a focused window; the badge is the fallback.
    chrome.action.openPopup?.().catch(() => {});
    return;
  }
  if (!notificationId.startsWith(REVIEW_NOTIFICATION_PREFIX)) return;
  const problem = await getProblem(notificationId.slice(REVIEW_NOTIFICATION_PREFIX.length));
  if (problem?.url) chrome.tabs.create({ url: problem.url });
});
