import {
  getCalendars,
  getLeetCodeState,
  getPendingMap,
  getProblemMap,
  getSettings,
  onCalendarsChanged,
  onPendingChanged,
  onProblemsChanged,
  onSettingsChanged,
  withStorageLock,
} from './lib/storage.js';
import { RATINGS, dayKey } from './lib/srs.js';
import { master, ratePending, undo } from './lib/actions.js';
import {
  clearIdleNote,
  computerRole,
  isActive,
  mainComputerUses,
  onRoleChanged,
  publishCalendars,
  releaseMainComputer,
  rememberIdle,
  wasIdle,
} from './lib/computer.js';
import {
  SYNC_INTERVAL_MINUTES,
  detectionsToNotify,
  syncLeetCode,
  syncIfStale,
  importRecent,
  recordAcceptedFromPage,
  setDetectedUsername,
} from './lib/leetcode-sync.js';
import {
  PROVIDER_NAMES,
  adoptCalendars,
  syncCalendars,
  connectCalendar,
  disconnectCalendar,
  forgetCalendar,
  markCalendarsStale,
  refreshSchedule,
} from './lib/calendar-sync.js';
import { migrateStoredData } from './lib/migrate.js';
import { ImportError, buildExport, mergeImport, parseExport } from './lib/transfer.js';
import { forgetSecrets } from './lib/secret-box.js';

const PERIODIC_ALARM = 'due-check'; // safety net: badge and daily summary, in case a one-shot alarm is missed
const NEW_DAY_ALARM = 'new-day'; // local midnight: a new day's reviews are due
const SUMMARY_ALARM = 'daily-summary'; // the start time
const LEETCODE_ALARM = 'leetcode-sync';
const CALENDAR_ALARM = 'calendar-sync'; // retries failed calendar updates
const ALARMS = [PERIODIC_ALARM, NEW_DAY_ALARM, SUMMARY_ALARM, LEETCODE_ALARM, CALENDAR_ALARM];
const CALENDAR_SYNC_MINUTES = 15;
const PENDING_NOTIFICATION = 'pending';
const SUMMARY_NOTIFICATION = 'daily-summary';
const SUMMARY_KEY = 'dailySummary'; // { sentDay }: the summary goes out at most once a day
const UNDO_MS = 15 * 1000; // a little longer than the prompt shows Undo

// Every listener is registered synchronously at the top level, so Chrome can
// wake this worker for any of them. Nothing that must survive a restart is
// kept in memory: it all lives in chrome.storage and alarms.

// chrome.storage.local holds the (encrypted) iCloud app-specific password, and
// by default content scripts can read and write it too. Ours only sends
// messages, so keep storage to ReLeet's own pages and this worker. Chrome
// remembers the setting; older versions without it skip it.
try {
  chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })?.catch(() => {});
} catch {}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // Not for a Chrome update: the tabs' scripts are still running then.
  if (reason === 'install' || reason === 'update') addToOpenLeetCodeTabs();
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') }).catch(() => {});
  // A failed migration must not keep ReLeet from starting; it runs again on the next update.
  if (reason === 'update') await migrateStoredData().catch((e) => console.warn('ReLeet: migration failed', e));
  await init();
});
chrome.runtime.onStartup.addListener(init);
// Another computer became the main one (or this one did): start or stop.
onRoleChanged(() => init());

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

const active = async () => isActive(await computerRole());

// Starts ReLeet's regular work on the main computer, or stops it on another
// one (the data stays, for Export).
async function init() {
  if (!(await active())) {
    // A copy with data stays idle until it's claimed (see computer.js); an empty one has nothing out of date.
    const { problems, calendars } = await chrome.storage.local.get(['problems', 'calendars']);
    if (Object.keys(problems ?? {}).length || Object.keys(calendars ?? {}).length) await rememberIdle();
    await Promise.all(ALARMS.map((name) => chrome.alarms.clear(name)));
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  // Marked before the note goes, so a worker stopped in between still marks them next time.
  if (await wasIdle()) {
    await markCalendarsStale();
    await clearIdleNote();
  }
  if ((await computerRole()) === 'main') await publishCalendars(await getCalendars());
  await ensurePeriodicAlarm(PERIODIC_ALARM, 30);
  await ensurePeriodicAlarm(CALENDAR_ALARM, CALENDAR_SYNC_MINUTES);
  const settings = await getSettings();
  await scheduleLeetCodeSync(settings);
  await scheduleNewDay();
  await updateBadge();
  await checkDailySummary();
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

function nextMidnight(now = Date.now()) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

async function scheduleNewDay() {
  await chrome.alarms.create(NEW_DAY_ALARM, { when: nextMidnight() });
}

// Only these settings move calendar blocks or change what's written to them.
function scheduleSettingsChanged(next, prev) {
  return (
    next.startTime !== prev.startTime ||
    next.dailyLimit !== prev.dailyLimit ||
    next.reminderMinutes !== prev.reminderMinutes ||
    RATINGS.some((r) => next.durations[r] !== prev.durations[r])
  );
}

onSettingsChanged(async (next, prev) => {
  if (!(await active())) return;
  if (leetcodeUsername(next) !== leetcodeUsername(prev)) {
    await scheduleLeetCodeSync(next);
    // A new username starts with a baseline, so its past solves aren't queued.
    if (leetcodeUsername(next)) runLeetCodeSync(syncLeetCode);
  }
  if (scheduleSettingsChanged(next, prev)) {
    syncCalendars();
    updateBadge();
  }
  if (next.startTime !== prev.startTime || next.dailySummary !== prev.dailySummary) checkDailySummary();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!(await active())) return;
  if (alarm.name === PERIODIC_ALARM) {
    updateBadge();
    checkDailySummary();
  }
  if (alarm.name === NEW_DAY_ALARM) {
    await scheduleNewDay();
    updateBadge();
    syncCalendars(); // missed reviews get their new blocks
  }
  if (alarm.name === SUMMARY_ALARM) checkDailySummary();
  if (alarm.name === LEETCODE_ALARM) runLeetCodeSync(syncLeetCode);
  if (alarm.name === CALENDAR_ALARM) syncCalendars();
});

// ---- The in-page prompt ----------------------------------------------------------

// Undo for a rating or Mastered made on the page. The page gets a token; the
// change itself waits here (in session storage, which a restart clears).
async function rememberUndo(id, change) {
  const token = crypto.randomUUID();
  await chrome.storage.session.set({ [`undo:${token}`]: { id, change, until: Date.now() + UNDO_MS } });
  return token;
}

async function undoFromPage({ token }) {
  const key = `undo:${token}`;
  const { [key]: saved } = await chrome.storage.session.get(key);
  await chrome.storage.session.remove(key);
  if (!saved || saved.until < Date.now()) return { status: 'expired' };
  return { status: (await undo(saved.id, saved.change)) ? 'ok' : 'changed' };
}

// Rated from the in-page prompt. The answer carries the review's day and block,
// so only the planning step is awaited here. Saving the problem also starts a
// full calendar sync (onProblemsChanged), whose network calls shouldn't hold
// up the prompt.
async function rateFromPage({ id, rating }) {
  const change = await ratePending(id, rating);
  if (!change) return { status: 'gone' };
  const slot = (await refreshSchedule()).entries[id] ?? null;
  return {
    status: 'ok',
    day: slot?.day ?? change.after.problem.dueDay,
    start: slot?.start ?? null,
    capped: change.capped,
    undoToken: await rememberUndo(id, change),
  };
}

async function masterFromPage({ id }) {
  const change = await master(id);
  if (!change) return { status: 'gone' };
  return { status: 'ok', undoToken: await rememberUndo(id, change) };
}

// The content script on leetcode.com may only report solves and act on its
// prompt. Everything else (calendar sign-in, imports) comes from ReLeet's own
// pages. On a computer that isn't the main one, the page gets 'idle' and shows nothing.
const PAGE_HANDLERS = {
  'leetcode-user': (m) => setDetectedUsername(m.username),
  'leetcode-accepted': (m) => recordAcceptedFromPage(m.submission ?? {}),
  'rate-pending': rateFromPage,
  'master-pending': masterFromPage,
  undo: undoFromPage,
};

const EXTENSION_HANDLERS = {
  ...PAGE_HANDLERS,
  'sync-now': () => runLeetCodeSync(syncLeetCode),
  'sync-if-stale': () => runLeetCodeSync(syncIfStale),
  'import-recent': importRecent,
  'calendar-connect': (m) => connectCalendar(m.provider, m.credentials),
  'calendar-disconnect': (m) => disconnectHere(m.provider, { force: Boolean(m.force), keep: Boolean(m.keep) }),
  'calendar-sync-now': syncCalendars,
  'test-notification': testNotification,
  'export-data': exportData,
  'import-data': (m) => importData(m.data),
  'delete-all-data': (m) => deleteAllData({ force: Boolean(m.force) }),
};

// Work only the main computer does. Export, Import and Delete work anywhere.
const ACTIVE_ONLY = new Set([
  ...Object.keys(PAGE_HANDLERS),
  'sync-now',
  'sync-if-stale',
  'import-recent',
  'calendar-connect',
  'calendar-sync-now',
]);

function fromExtensionPage(sender) {
  return sender.id === chrome.runtime.id && Boolean(sender.url?.startsWith(chrome.runtime.getURL('')));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = fromExtensionPage(sender) ? EXTENSION_HANDLERS : PAGE_HANDLERS;
  const handler = Object.hasOwn(handlers, message?.type) ? handlers[message.type] : null;
  if (!handler) return false;
  Promise.resolve()
    .then(async () => {
      if (ACTIVE_ONLY.has(message.type) && !(await active())) return { status: 'idle' };
      return handler(message);
    })
    .then(sendResponse, (e) => sendResponse({ status: 'error', error: e?.message ?? String(e) }));
  return true; // keep the channel open for the async response
});

// Any change to problems (a rating, Mastered, Stop tracking) or to the solves
// waiting to be rated reschedules the calendar blocks and the badge.
onProblemsChanged(async () => {
  if (!(await active())) return;
  syncCalendars();
  updateBadge();
});

onPendingChanged(async () => {
  if (await active()) updateBadge();
});

// Tells other computers which calendars are the main computer's (computer.js).
// Writes only when an id changes, not on every event a sync stores.
onCalendarsChanged(async (calendars) => {
  if ((await computerRole()) === 'main') await publishCalendars(calendars);
});

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

// ---- Due today: the badge and the daily summary ---------------------------------

// Reviews booked for today (overdue ones booked again today included).
async function dueToday(now = Date.now()) {
  const plan = await refreshSchedule(now);
  const today = dayKey(now);
  return Object.values(plan.entries).filter((slot) => slot.day <= today);
}

// Reviews due today plus solves waiting to be rated, each problem counted once.
async function updateBadge() {
  const [due, pending] = await Promise.all([dueToday(), getPendingMap()]);
  const count = new Set([...due.map((slot) => slot.problemId), ...Object.keys(pending)]).size;
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
}

// Today at the start time, local.
function startTimeOn(now, settings) {
  const [hours, minutes] = String(settings.startTime ?? '09:00').split(':').map(Number);
  const d = new Date(now);
  d.setHours(Number.isFinite(hours) ? hours : 9, Number.isFinite(minutes) ? minutes : 0, 0, 0);
  return d.getTime();
}

const reviewsText = (n) => `${n} review${n === 1 ? '' : 's'} due today`;

// One notification at the start time: "5 reviews due today". At most once a
// day, and none when nothing is due. If Chrome wasn't running at the start
// time, it comes when it starts.
async function checkDailySummary(now = Date.now()) {
  const settings = await getSettings();
  const start = startTimeOn(now, settings);
  if (now < start) {
    await chrome.alarms.create(SUMMARY_ALARM, { when: start });
    return;
  }
  const tomorrow = new Date(start);
  tomorrow.setDate(tomorrow.getDate() + 1);
  await chrome.alarms.create(SUMMARY_ALARM, { when: tomorrow.getTime() });
  if (!settings.dailySummary) return;

  const today = dayKey(now);
  const { [SUMMARY_KEY]: state } = await chrome.storage.local.get(SUMMARY_KEY);
  if (state?.sentDay === today) return;
  await chrome.storage.local.set({ [SUMMARY_KEY]: { sentDay: today } });
  const due = await dueToday(now);
  if (due.length) await notifySummary(due.length);
}

function notifySummary(count, contextMessage = 'Click to see them.') {
  return chrome.notifications.create(SUMMARY_NOTIFICATION, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: reviewsText(count),
    message: count ? 'Your review blocks are in the ReLeet popup.' : 'Nothing to review right now.',
    contextMessage,
    priority: 1,
  });
}

// Settings → "Send a test notification": today's summary as it stands now,
// without counting as today's.
async function testNotification() {
  const count = (await dueToday()).length;
  await notifySummary(count, 'This is a test. ReLeet sends this at your start time.');
  return { status: 'ok', count };
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  chrome.notifications.clear(notificationId);
  if (notificationId === PENDING_NOTIFICATION || notificationId === SUMMARY_NOTIFICATION) await openPopup();
});

// The toolbar popup only opens in a focused Chrome window, and clicking a
// system notification usually comes from another app, which doesn't focus
// one. So focus the last window first. If the popup still can't open (Chrome
// before 127, no window, focus refused), show the same page in a tab, so the
// click always leads to the list.
async function openPopup() {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    await chrome.windows.update(win.id, { focused: true });
    await chrome.action.openPopup({ windowId: win.id });
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?tab') }).catch(() => {});
  }
}

// ---- Export, Import, Delete ---------------------------------------------------------

async function exportData() {
  const [problems, pending, settings, leetcode, calendars] = await Promise.all([
    getProblemMap(),
    getPendingMap(),
    getSettings(),
    getLeetCodeState(),
    getCalendars(),
  ]);
  return { status: 'ok', data: buildExport({ problems, pending, settings, leetcode, calendars }) };
}

// Runs where calendar syncs can't interleave (the worker writes the calendars key).
async function importData(data) {
  let imported;
  try {
    imported = parseExport(data);
  } catch (e) {
    if (e instanceof ImportError) return { status: 'error', error: e.message };
    throw e;
  }
  // Under the lock, so a rating made at the same moment isn't lost.
  const merged = await withStorageLock(async () => {
    const [problems, pending, leetcode, calendars] = await Promise.all([
      getProblemMap(),
      getPendingMap(),
      getLeetCodeState(),
      getCalendars(),
    ]);
    const result = mergeImport({ problems, pending, leetcode, calendars }, imported);
    await chrome.storage.local.set({
      problems: result.problems,
      pending: result.pending,
      settings: result.settings,
      leetcode: result.leetcode,
    });
    return result;
  });
  const adopted = Object.keys(imported.calendars).filter((name) => !merged.calendars[name]?.connected);
  await adoptCalendars(Object.fromEntries(adopted.map((name) => [name, merged.calendars[name]])));
  return { status: 'ok', problems: Object.keys(imported.problems).length, added: merged.added, calendars: adopted };
}

// On a computer that isn't the main one, a calendar the main computer also
// uses (after Export / Import) is only forgotten here; one only this computer
// used is deleted, but its Google grant, which the main computer shares, stays.
// `keep`: the page told the user the calendar stays, so it does.
async function disconnectHere(name, { force = false, keep = false } = {}) {
  if (await active()) return disconnectCalendar(name, { force });
  const state = (await getCalendars())[name];
  if (keep || (await mainComputerUses(name, state?.calendarId))) return forgetCalendar(name);
  return disconnectCalendar(name, { force, keepSignIn: true });
}

// "Delete all my ReLeet data": the ReLeet calendars in connected accounts
// first (that needs the sign-ins), then everything stored in this browser.
// `force` goes ahead when a calendar couldn't be deleted, leaving it behind.
// On a computer that isn't the main one, a calendar the main computer also
// uses stays (see disconnectHere).
async function deleteAllData({ force = false } = {}) {
  const calendars = await getCalendars();
  const connected = PROVIDER_NAMES.filter((n) => calendars[n]?.connected);
  const failed = [];
  const kept = [];
  for (const name of connected) {
    const result = await disconnectHere(name);
    if (result.keptCalendar) kept.push(name);
    else if (result.status !== 'disconnected') failed.push({ provider: name, error: result.error });
  }
  if (failed.length && !force) return { status: 'error', failed };
  await releaseMainComputer();
  await Promise.all(ALARMS.map((name) => chrome.alarms.clear(name)));
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  await forgetSecrets();
  await chrome.action.setBadgeText({ text: '' });
  return { status: 'deleted', leftBehind: failed.map((f) => f.provider), kept };
}
