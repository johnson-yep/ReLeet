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
async function loadWorker({ storage = {}, tabs = [], api = {} } = {}) {
  const event = () => {
    const fns = [];
    return { addListener: (fn) => fns.push(fn), fire: (...args) => Promise.all(fns.map((fn) => fn(...args))), fns };
  };
  const log = { accessLevel: [], injected: [], notifications: [], tabsCreated: [], focused: [], popups: [], lastFocused: [] };
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
      setBadgeText: async () => {},
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

// ---- Test notification (Settings) ---------------------------------------------------

const problem = (id, title, dueAt) => ({
  id,
  title,
  url: `https://leetcode.com/problems/${id}/`,
  rating: 'okay',
  solvedAt: dueAt - 3 * 86400000,
  dueAt,
  commitSha: null,
  source: 'leetcode',
  history: [{ at: dueAt - 3 * 86400000, rating: 'okay', commitSha: null }],
});

test('a test notification shows the soonest review without changing it', async () => {
  const now = Date.now();
  const problems = {
    'two-sum': problem('two-sum', 'Two Sum', now + 3 * 86400000),
    'lru-cache': problem('lru-cache', 'LRU Cache', now + 86400000),
  };
  const { chrome, log, send } = await loadWorker({ storage: { problems } });
  assert.deepEqual(await send({ type: 'test-notification' }), { status: 'ok', problem: 'LRU Cache' });
  assert.equal(log.notifications.length, 1);
  assert.equal(log.notifications[0].id, 'review:lru-cache'); // clicking it opens the problem
  assert.equal(log.notifications[0].title, 'Time to review');
  assert.equal(log.notifications[0].message, 'LRU Cache');
  // Unlike the old ⏰ button, nothing moves: no due date, no calendar block.
  assert.deepEqual(chrome.dump().problems, problems);
  assert.equal(chrome.dump().schedule, undefined);
});

test('a test notification works with nothing tracked, and only from ReLeet pages', async () => {
  const { log, send } = await loadWorker();
  assert.equal(await send({ type: 'test-notification' }, LEETCODE_PAGE), undefined);
  assert.deepEqual(log.notifications, []);
  assert.deepEqual(await send({ type: 'test-notification' }), { status: 'ok', problem: null });
  assert.equal(log.notifications.length, 1);
  assert.equal(log.notifications[0].id, 'test');
});
