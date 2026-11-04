import {
  getProblemMap,
  getProblem,
  getPending,
  getSettings,
  saveSettings,
  saveProblemMap,
  onProblemsChanged,
  onPendingChanged,
  onSettingsChanged,
} from './lib/storage.js';
import { isDue, nextDueAfter } from './lib/srs.js';
import { ratePending } from './lib/rating.js';
import {
  SYNC_INTERVAL_MINUTES,
  syncLeetCode,
  syncIfStale,
  importRecent,
  recordAcceptedFromPage,
  setDetectedUsername,
} from './lib/leetcode-sync.js';
import { syncCalendars, connectCalendar, disconnectCalendar, refreshSchedule } from './lib/calendar-sync.js';

const PERIODIC_ALARM = 'due-check';   // safety net in case a one-shot alarm is missed
const NEXT_DUE_ALARM = 'next-due';    // fires exactly when the next problem becomes due
const LEETCODE_ALARM = 'leetcode-sync';
const CALENDAR_ALARM = 'calendar-sync'; // retries failed calendar updates
const CALENDAR_SYNC_MINUTES = 15;
const REVIEW_NOTIFICATION_PREFIX = 'review:';
const PENDING_NOTIFICATION = 'pending';

// Every listener is registered synchronously at the top level, so Chrome can
// wake this worker for any of them. Nothing that must survive a restart is
// kept in memory: it all lives in chrome.storage and alarms.

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'update') await dropGitHubSettings();
  await init();
});
chrome.runtime.onStartup.addListener(init);

async function init() {
  await chrome.alarms.create(PERIODIC_ALARM, { periodInMinutes: 30 });
  await ensurePeriodicAlarm(CALENDAR_ALARM, CALENDAR_SYNC_MINUTES);
  await scheduleLeetCodeSync(await getSettings());
  await checkDue();
  syncCalendars();
}

// v0.2 synced from a GitHub repo, optionally with a token. That's gone, so
// don't keep the token, its sync state or its alarms around.
async function dropGitHubSettings() {
  const { owner, repo, branch, token, ...settings } = await getSettings();
  if ([owner, repo, branch, token].some((v) => v !== undefined)) await saveSettings(settings);
  await chrome.storage.local.remove('sync');
  const alarms = await chrome.alarms.getAll();
  const stale = alarms.filter((a) => a.name === 'github-sync' || a.name.startsWith('after-submit:'));
  await Promise.all(stale.map((a) => chrome.alarms.clear(a.name)));
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
    ['easy', 'medium', 'hard'].some((r) => next.durations[r] !== prev.durations[r])
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
    if (result.added && result.detected?.length) notifyPending(result.detected);
    return result;
  } catch (e) {
    return { status: 'error', added: 0, detected: [], error: e?.message ?? String(e) };
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
