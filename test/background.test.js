import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';

const EXTENSION_PAGE = { id: 'ext', url: 'chrome-extension://ext/options/options.html' };
const LEETCODE_PAGE = { id: 'ext', url: 'https://leetcode.com/problems/two-sum/' };

// Chrome match pattern ("https://leetcode.com/*") → RegExp, enough for tabs.query.
const patternToRegExp = (pattern) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let loads = 0;

// Loads a fresh copy of background.js against fake chrome.* APIs. Listeners
// are collected so tests can fire them; `log` records what the worker did.
async function loadWorker({ storage = {}, sync = {}, tabs = [], api = {} } = {}) {
  const event = () => {
    const fns = [];
    return { addListener: (fn) => fns.push(fn), fire: (...args) => Promise.all(fns.map((fn) => fn(...args))), fns };
  };
  const log = { accessLevel: [], injected: [], notifications: [], tabsCreated: [], focused: [], popups: [], lastFocused: [], badge: [] };
  const alarms = new Map();
  const chrome = installFakeChrome(storage, {
    runtime: {
      id: 'ext',
      getURL: (path) => `chrome-extension://ext/${path}`,
      getManifest: () => ({ oauth2: { client_id: 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com' } }),
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
    },
    alarms: {
      create: async (name, options) => void alarms.set(name, { name, ...options }),
      get: async (name) => alarms.get(name),
      getAll: async () => [...alarms.values()],
      clear: async (name) => alarms.delete(name),
      onAlarm: event(),
    },
    notifications: {
      create: async (id, options) => {
        log.notifications.push({ id, ...options });
        return id;
      },
      clear: async () => true,
      onClicked: event(),
    },
    action: {
      setBadgeText: async ({ text }) => void log.badge.push(text),
      setBadgeBackgroundColor: async () => {},
      openPopup: async (options) => void log.popups.push(options),
    },
    tabs: {
      query: async ({ url }) => tabs.filter((tab) => patternToRegExp(url).test(tab.url)),
      create: async (options) => {
        log.tabsCreated.push(options);
        return { id: 100, ...options };
      },
    },
    scripting: {
      executeScript: async (details) => {
        log.injected.push(details);
        return [];
      },
    },
    windows: {
      getLastFocused: async (options) => {
        log.lastFocused.push(options);
        return { id: 7 };
      },
      update: async (id, options) => {
        log.focused.push({ id, ...options });
        return { id };
      },
    },
    identity: { getRedirectURL: () => 'https://ext.chromiumapp.org/' },
  });
  chrome.storage.local.setAccessLevel = async (options) => void log.accessLevel.push(options);
  chrome.storage.sync.reset(sync);
  // api: { 'action.openPopup': fn } replaces a fake; undefined removes it (older Chrome).
  for (const [path, value] of Object.entries(api)) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((obj, key) => obj[key], chrome);
    if (value === undefined) delete target[last];
    else target[last] = value;
  }
  await import(`../background.js?load=${++loads}`);

  const send = (message, sender = EXTENSION_PAGE) =>
    new Promise((resolve) => {
      if (!chrome.runtime.onMessage.fns[0](message, sender, resolve)) resolve(undefined);
    });
  return { chrome, log, alarms, send };
}

// ---- Storage access --------------------------------------------------------------

test('the worker closes chrome.storage.local to content scripts as it starts', async () => {
  const { log } = await loadWorker();
  assert.deepEqual(log.accessLevel, [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
});

test("the worker still starts where storage access can't be restricted", async () => {
  // Chrome before 102 has no setAccessLevel; some versions reject it for local storage.
  const missing = await loadWorker({ api: { 'storage.local.setAccessLevel': undefined } });
  assert.equal(missing.chrome.runtime.onMessage.fns.length, 1);
  const rejected = await loadWorker({
    api: { 'storage.local.setAccessLevel': async () => Promise.reject(new Error('Unsupported')) },
  });
  assert.equal(rejected.chrome.runtime.onMessage.fns.length, 1);
  await settle();
});

// ---- Content script in tabs that were already open --------------------------------

const TABS = [
  { id: 1, url: 'https://leetcode.com/problems/two-sum/description/' },
  { id: 2, url: 'https://example.com/' },
  { id: 3, url: 'https://leetcode.com/' },
];

test('install and update add the content script to leetcode.com tabs that are already open', async () => {
  for (const reason of ['install', 'update']) {
    const { chrome, log, alarms } = await loadWorker({ tabs: TABS });
    await chrome.runtime.onInstalled.fire({ reason });
    await settle();
    assert.deepEqual(
      log.injected,
      [1, 3].map((tabId) => ({ target: { tabId }, files: ['content/leetcode.js'] })),
      reason,
    );
    assert.ok(alarms.has('calendar-sync'), `${reason}: init still ran`);
  }
});

test("a Chrome update doesn't inject: the tabs' scripts are still running", async () => {
  const { chrome, log } = await loadWorker({ tabs: TABS });
  await chrome.runtime.onInstalled.fire({ reason: 'chrome_update' });
  await settle();
  assert.deepEqual(log.injected, []);
});

test('a tab that refuses the script (discarded, error page) skips only that tab', async () => {
  const injected = [];
  const { chrome, alarms } = await loadWorker({
    tabs: TABS,
    api: {
      'scripting.executeScript': async ({ target }) => {
        if (target.tabId === 1) throw new Error('Frame with ID 0 is showing error page');
        injected.push(target.tabId);
        return [];
      },
    },
  });
  await chrome.runtime.onInstalled.fire({ reason: 'install' });
  await settle();
  assert.deepEqual(injected, [3]);
  assert.ok(alarms.has('calendar-sync'));
  assert.ok(alarms.has('due-check'));
});

test("install still finishes when the tabs can't be listed", async () => {
  const { chrome, log, alarms } = await loadWorker({
    api: {
      'tabs.query': async () => {
        throw new Error('nope');
      },
    },
  });
  await chrome.runtime.onInstalled.fire({ reason: 'install' });
  await settle();
  assert.deepEqual(log.injected, []);
  assert.ok(alarms.has('calendar-sync'));
});

// ---- "New submission detected" notification click ---------------------------------

test('clicking the new-submission notification focuses a Chrome window and opens the popup there', async () => {
  const { chrome, log } = await loadWorker();
  await chrome.notifications.onClicked.fire('pending');
  // A click from another app leaves Chrome unfocused, and openPopup needs a focused window.
  assert.deepEqual(log.lastFocused, [{ windowTypes: ['normal'] }]);
  assert.deepEqual(log.focused, [{ id: 7, focused: true }]);
  assert.deepEqual(log.popups, [{ windowId: 7 }]);
  assert.deepEqual(log.tabsCreated, []);
});

test("when the popup can't open, the click opens the same list in a tab", async () => {
  const popupTab = [{ url: 'chrome-extension://ext/popup/popup.html?tab' }];
  // Focus refused, so Chrome says "Cannot show popup for an inactive window".
  const refused = await loadWorker({
    api: { 'action.openPopup': async () => Promise.reject(new Error('Cannot show popup for an inactive window.')) },
  });
  await refused.chrome.notifications.onClicked.fire('pending');
  assert.deepEqual(refused.log.tabsCreated, popupTab);

  // Chrome before 127 has no openPopup.
  const old = await loadWorker({ api: { 'action.openPopup': undefined } });
  await old.chrome.notifications.onClicked.fire('pending');
  assert.deepEqual(old.log.tabsCreated, popupTab);

  // No Chrome window at all.
  const noWindow = await loadWorker({
    api: { 'windows.getLastFocused': async () => Promise.reject(new Error('No last-focused window')) },
  });
  await noWindow.chrome.notifications.onClicked.fire('pending');
  assert.deepEqual(noWindow.log.tabsCreated, popupTab);
  assert.deepEqual(noWindow.log.popups, []);
});

// ---- Daily summary, badge ------------------------------------------------------------

const { dayKey, addDays, startOfDay } = await import('../lib/srs.js');
const DAY = 86400000;

// A tracked problem whose review day is `offset` days from today.
function problem(id, offset, rating = 'okay') {
  const dueAt = addDays(startOfDay(Date.now()), offset);
  const ratedAt = addDays(dueAt, -3) + 12 * 3600000;
  return {
    id,
    title: id.toUpperCase(),
    url: `https://leetcode.com/problems/${id}/`,
    rating,
    interval: 3,
    solvedAt: ratedAt,
    dueAt,
    dueDay: dayKey(dueAt),
    commitSha: null,
    source: 'leetcode',
    history: [{ at: ratedAt, rating, commitSha: null }],
  };
}
const pendingSolve = (id) => ({ id, title: id, url: `https://leetcode.com/problems/${id}/`, submittedAt: Date.now() - 60000, submissionId: `s-${id}`, source: 'leetcode' });
const startedWorker = async (options) => {
  const worker = await loadWorker(options);
  await worker.chrome.runtime.onStartup.fire();
  await settle();
  return worker;
};
const summaries = (log) => log.notifications.filter((n) => n.id === 'daily-summary');
const late = () => new Date().getHours() === 23 && new Date().getMinutes() >= 58;

test('the daily summary counts reviews due today, overdue ones booked again today included, once a day', async () => {
  const problems = { a: problem('a', 0, 'easy'), b: problem('b', -2, 'easy'), later: problem('later', 3) };
  const { chrome, log, alarms } = await startedWorker({ storage: { problems, settings: { startTime: '00:00' } } });
  assert.equal(summaries(log).length, 1);
  assert.equal(summaries(log)[0].title, '2 reviews due today');
  assert.equal(chrome.dump().dailySummary.sentDay, dayKey(Date.now()));
  // The next one is due at tomorrow's start time.
  assert.equal(alarms.get('daily-summary').when, addDays(startOfDay(Date.now()), 1));

  // Another start the same day, or the alarm again: nothing new.
  await chrome.runtime.onStartup.fire();
  await chrome.alarms.onAlarm.fire({ name: 'daily-summary' });
  await settle();
  assert.equal(summaries(log).length, 1);
});

test('no daily summary when nothing is due, when it is switched off, or before the start time', async (t) => {
  const quiet = await startedWorker({ storage: { problems: { later: problem('later', 2) }, settings: { startTime: '00:00' } } });
  assert.deepEqual(summaries(quiet.log), []);

  const off = await startedWorker({
    storage: { problems: { a: problem('a', 0) }, settings: { startTime: '00:00', dailySummary: false } },
  });
  assert.deepEqual(summaries(off.log), []);
  assert.equal(off.chrome.dump().dailySummary, undefined);

  if (late()) return t.skip('too close to midnight');
  const early = await startedWorker({ storage: { problems: { a: problem('a', 0) }, settings: { startTime: '23:59' } } });
  assert.deepEqual(summaries(early.log), []);
  const today = new Date();
  today.setHours(23, 59, 0, 0);
  assert.equal(early.alarms.get('daily-summary').when, today.getTime());
});

test('the old one-notification-per-review is gone', async () => {
  const { log } = await startedWorker({ storage: { problems: { a: problem('a', 0), b: problem('b', -1) } } });
  assert.deepEqual(log.notifications.filter((n) => n.id.startsWith('review:')), []);
});

test('the badge counts reviews due today and solves to rate, each problem once', async () => {
  const problems = { a: problem('a', 0, 'easy'), b: problem('b', -1, 'easy'), c: problem('c', 1) };
  const pending = { a: pendingSolve('a'), d: pendingSolve('d') };
  const { log } = await startedWorker({ storage: { problems, pending } });
  assert.equal(log.badge.at(-1), '3'); // a, b, d
});

test('a test notification shows today\'s summary without using up the day\'s one, and only from ReLeet pages', async () => {
  const { chrome, log, send } = await loadWorker({ storage: { problems: { a: problem('a', 0) }, settings: { startTime: '23:59' } } });
  assert.equal(await send({ type: 'test-notification' }, LEETCODE_PAGE), undefined);
  assert.deepEqual(await send({ type: 'test-notification' }), { status: 'ok', count: 1 });
  assert.equal(summaries(log).length, 1);
  assert.equal(summaries(log)[0].title, '1 review due today');
  assert.equal(chrome.dump().dailySummary, undefined);
});

test('clicking the daily summary opens the popup', async () => {
  const { chrome, log } = await loadWorker();
  await chrome.notifications.onClicked.fire('daily-summary');
  assert.deepEqual(log.popups, [{ windowId: 7 }]);
});

// ---- Welcome page ---------------------------------------------------------------------

test('installing opens the welcome page; updating does not', async () => {
  const installed = await loadWorker();
  await installed.chrome.runtime.onInstalled.fire({ reason: 'install' });
  assert.deepEqual(installed.log.tabsCreated, [{ url: 'chrome-extension://ext/welcome/welcome.html' }]);
  const updated = await loadWorker();
  await updated.chrome.runtime.onInstalled.fire({ reason: 'update' });
  assert.deepEqual(updated.log.tabsCreated, []);
});

// ---- One main computer ------------------------------------------------------------------

const otherComputer = { mainComputer: { id: 'some-other-computer', claimedAt: 1 } };

test('on a computer that is not the main one, ReLeet stays idle', async () => {
  const { chrome, log, alarms, send } = await startedWorker({
    storage: { problems: { a: problem('a', 0) }, pending: { b: pendingSolve('b') }, settings: { startTime: '00:00', leetcodeUsername: 'alice' } },
    sync: otherComputer,
  });
  assert.deepEqual([...alarms.keys()], []);
  assert.deepEqual(summaries(log), []);
  assert.equal(log.badge.at(-1), '');
  // The leetcode.com page gets no prompt, and nothing is queued or rated.
  const accepted = { type: 'leetcode-accepted', submission: { submissionId: '9', slug: 'two-sum', title: 'Two Sum', timestamp: Date.now() } };
  assert.deepEqual(await send(accepted, LEETCODE_PAGE), { status: 'idle' });
  assert.deepEqual(await send({ type: 'rate-pending', id: 'b', rating: 'easy' }, LEETCODE_PAGE), { status: 'idle' });
  assert.deepEqual(Object.keys(chrome.dump().pending), ['b']);
  // Export still works, so the data can move.
  const exported = await send({ type: 'export-data' });
  assert.equal(exported.status, 'ok');
  assert.deepEqual(Object.keys(exported.data.problems), ['a']);
});

test('when another computer becomes the main one, this one goes idle; switching back starts it again', async () => {
  const { chrome, alarms } = await startedWorker({ storage: { problems: { a: problem('a', 2) } } });
  assert.ok(alarms.has('calendar-sync'));
  const { claimMainComputer } = await import('../lib/computer.js');
  await claimMainComputer(); // the first rating or the welcome page would do this
  await chrome.storage.sync.set(otherComputer);
  await settle();
  assert.deepEqual([...alarms.keys()], []);
  await claimMainComputer();
  await settle();
  assert.ok(alarms.has('calendar-sync'));
});

// ---- The in-page prompt's messages -----------------------------------------------------

test('rating on the page answers with the review day and an undo that puts the solve back', async () => {
  const { chrome, send } = await startedWorker({ storage: { pending: { 'two-sum': pendingSolve('two-sum') } } });
  const res = await send({ type: 'rate-pending', id: 'two-sum', rating: 'okay' }, LEETCODE_PAGE);
  assert.equal(res.status, 'ok');
  assert.equal(res.day, dayKey(addDays(startOfDay(Date.now()), 3)));
  assert.equal(typeof res.start, 'number');
  assert.equal(res.capped, false);
  assert.equal(chrome.dump().problems['two-sum'].rating, 'okay');
  // Rating counts as using ReLeet here: this computer becomes the main one.
  assert.ok((await chrome.storage.sync.get('mainComputer')).mainComputer);

  assert.deepEqual(await send({ type: 'undo', token: res.undoToken }, LEETCODE_PAGE), { status: 'ok' });
  assert.equal(chrome.dump().problems['two-sum'], undefined);
  assert.equal(chrome.dump().pending['two-sum'].submissionId, 's-two-sum');
  // A token works once.
  assert.deepEqual(await send({ type: 'undo', token: res.undoToken }, LEETCODE_PAGE), { status: 'expired' });
  assert.deepEqual(await send({ type: 'rate-pending', id: 'gone', rating: 'easy' }, LEETCODE_PAGE), { status: 'gone' });
});

test('"Mastered — stop reviewing" on the page counts the solve as Easy and retires the problem, with undo', async () => {
  const { chrome, send } = await startedWorker({ storage: { pending: { 'two-sum': pendingSolve('two-sum') } } });
  const res = await send({ type: 'master-pending', id: 'two-sum' }, LEETCODE_PAGE);
  assert.equal(res.status, 'ok');
  const p = chrome.dump().problems['two-sum'];
  assert.equal(p.rating, 'easy');
  assert.equal(typeof p.masteredAt, 'number');
  assert.equal(chrome.dump().schedule.entries['two-sum'], undefined);
  assert.deepEqual(await send({ type: 'undo', token: res.undoToken }, LEETCODE_PAGE), { status: 'ok' });
  assert.ok(chrome.dump().pending['two-sum']);
});

test('the page may not reach anything beyond its prompt', async () => {
  const { send } = await loadWorker();
  for (const type of ['export-data', 'import-data', 'delete-all-data', 'calendar-connect', 'sync-now']) {
    assert.equal(await send({ type }, LEETCODE_PAGE), undefined, type);
  }
});

// ---- Export, Import, Delete ----------------------------------------------------------

test('export leaves out every sign-in, and importing it on another computer merges and keeps the calendar', async () => {
  const appleState = {
    connected: true,
    calendarId: 'https://p01-caldav.icloud.com/1/calendars/cal/',
    events: { a: { id: 'ev-a', day: '2026-11-10', start: 1, end: 2, hash: 'h' } },
    account: 'me@icloud.com',
    auth: { appleId: 'me@icloud.com', appPassword: { iv: 'x', data: 'y' } },
  };
  const first = await startedWorker({
    storage: {
      problems: { a: problem('a', 2) },
      settings: { startTime: '07:30', dailyLimit: 45 },
      leetcode: { username: 'alice', baselineAt: 5, seenIds: ['1', '2'] },
      calendars: { apple: appleState },
    },
  });
  const { data } = await first.send({ type: 'export-data' });
  const text = JSON.stringify(data);
  assert.doesNotMatch(text, /appPassword|"iv"/);
  assert.equal(data.calendars.apple.appleId, 'me@icloud.com');

  const second = await startedWorker({ storage: { problems: { b: problem('b', 1) } } });
  const res = await second.send({ type: 'import-data', data: JSON.parse(text) });
  assert.deepEqual(res, { status: 'ok', problems: 1, added: 1, calendars: ['apple'] });
  const stored = second.chrome.dump();
  assert.deepEqual(Object.keys(stored.problems).sort(), ['a', 'b']);
  assert.equal(stored.settings.startTime, '07:30');
  assert.deepEqual(stored.leetcode.seenIds, ['1', '2']);
  assert.deepEqual(stored.calendars.apple, {
    connected: false,
    calendarId: appleState.calendarId,
    events: appleState.events,
    checkStrays: true,
    account: 'me@icloud.com',
    auth: { appleId: 'me@icloud.com' },
  });

  assert.deepEqual(await second.send({ type: 'import-data', data: { hello: 1 } }), {
    status: 'error',
    error: "This isn't a ReLeet export file.",
  });
});

test('delete all clears this browser and the main-computer claim', async () => {
  const { chrome, send } = await startedWorker({ storage: { problems: { a: problem('a', 1) }, pending: { b: pendingSolve('b') } } });
  const { claimMainComputer } = await import('../lib/computer.js');
  await claimMainComputer();
  assert.deepEqual(await send({ type: 'delete-all-data' }), { status: 'deleted', leftBehind: [], kept: [] });
  await settle();
  const left = chrome.dump();
  assert.equal(left.problems, undefined);
  assert.equal(left.pending, undefined);
  assert.equal((await chrome.storage.sync.get('mainComputer')).mainComputer, undefined);
});

test('on a computer that is not the main one, Disconnect and Delete all leave the shared calendar alone', async () => {
  const apple = {
    connected: true,
    calendarId: 'https://p01-caldav.icloud.com/1/calendars/shared/',
    events: { a: { id: 'ev-a', day: '2026-11-10', start: 1, end: 2, hash: 'h' } },
    account: 'me@icloud.com',
    auth: { appleId: 'me@icloud.com', appPassword: { iv: 'x', data: 'y' } },
  };
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    throw new Error('no network in this test');
  };
  try {
    const { chrome, send } = await startedWorker({ storage: { calendars: { apple } }, sync: otherComputer });
    const res = await send({ type: 'calendar-disconnect', provider: 'apple' });
    assert.deepEqual(res, { status: 'disconnected', keptCalendar: true });
    const left = chrome.dump().calendars.apple;
    assert.equal(left.connected, false);
    assert.equal(left.calendarId, apple.calendarId);
    assert.deepEqual(left.auth, { appleId: 'me@icloud.com' });

    await chrome.storage.local.set({ calendars: { apple } });
    assert.deepEqual(await send({ type: 'delete-all-data' }), { status: 'deleted', leftBehind: [], kept: ['apple'] });
    assert.deepEqual(requests, []);
    // Another computer's claim is never removed.
    assert.equal((await chrome.storage.sync.get('mainComputer')).mainComputer.id, 'some-other-computer');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a failed update migration still starts ReLeet', async () => {
  const { chrome, alarms } = await loadWorker({
    api: { 'alarms.getAll': async () => Promise.reject(new Error('alarms unavailable')) },
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await chrome.runtime.onInstalled.fire({ reason: 'update' });
  } finally {
    console.warn = warn;
  }
  assert.ok(alarms.has('calendar-sync'));
});

test('a computer that becomes the main one again checks its calendars for blocks it does not know', async () => {
  const google = { connected: true, calendarId: 'g1', events: { a: { id: 'e', day: '2026-11-10', start: 1, end: 2, hash: 'h' } }, checkStrays: false };
  const { chrome } = await startedWorker({ storage: { calendars: { google } }, sync: otherComputer });
  assert.ok(chrome.dump().idleSince);
  const { claimMainComputer } = await import('../lib/computer.js');
  await claimMainComputer();
  await settle();
  assert.equal(chrome.dump().calendars.google.checkStrays, true);
  assert.equal(chrome.dump().idleSince, undefined);
});

test("on a computer that is not the main one, a calendar only it used is deleted (without signing out)", async () => {
  const apple = { connected: true, calendarId: 'https://p01-caldav.icloud.com/1/calendars/mine/', events: {}, account: 'me@icloud.com', auth: { appleId: 'me@icloud.com', appPassword: 'x' } };
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    throw new Error('offline');
  };
  try {
    const sync = { ...otherComputer, mainCalendars: { apple: 'https://p01-caldav.icloud.com/1/calendars/theirs/' } };
    const { send } = await startedWorker({ storage: { calendars: { apple } }, sync });
    const res = await send({ type: 'calendar-disconnect', provider: 'apple' });
    // It tried to delete this computer's own calendar (and couldn't, offline), rather than just forgetting it.
    assert.equal(res.status, 'error');
    assert.ok(requests.some((url) => url.includes('icloud.com')));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('only the main computer publishes its calendar ids; an empty idle copy keeps no idle note', async () => {
  const google = { connected: true, calendarId: 'g1', events: {} };
  const main = await startedWorker({ storage: { calendars: { google } } });
  // Unclaimed (before its first rating) it says nothing, so it can't overwrite the real main computer's list.
  assert.equal((await main.chrome.storage.sync.get('mainCalendars')).mainCalendars, undefined);
  const { claimMainComputer } = await import('../lib/computer.js');
  await claimMainComputer();
  await settle();
  assert.deepEqual((await main.chrome.storage.sync.get('mainCalendars')).mainCalendars, { google: 'g1' });
  const empty = await startedWorker({ sync: otherComputer });
  assert.equal(empty.chrome.dump().idleSince, undefined);
});

test('an idle computer keeps its calendar while the new main computer has none of its own yet (before Import)', async () => {
  const apple = { connected: true, calendarId: 'https://p01-caldav.icloud.com/1/calendars/x/', events: {}, account: 'me@icloud.com', auth: { appleId: 'me@icloud.com', appPassword: 'x' } };
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    throw new Error('offline');
  };
  try {
    // The new main computer has just claimed and published an empty list.
    const { send } = await startedWorker({ storage: { calendars: { apple } }, sync: { ...otherComputer, mainCalendars: {} } });
    assert.deepEqual(await send({ type: 'delete-all-data' }), { status: 'deleted', leftBehind: [], kept: ['apple'] });
    assert.deepEqual(requests, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('when the page said the calendar stays, the worker keeps it even if the list changed meanwhile', async () => {
  const apple = { connected: true, calendarId: 'mine', events: {}, auth: { appleId: 'me@icloud.com' } };
  const { send } = await startedWorker({ storage: { calendars: { apple } }, sync: { ...otherComputer, mainCalendars: { apple: 'theirs' } } });
  assert.deepEqual(await send({ type: 'calendar-disconnect', provider: 'apple', keep: true }), { status: 'disconnected', keptCalendar: true });
});
