import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';

const chrome = installFakeChrome();
const storage = await import('../lib/storage.js');

test('getSettings fills defaults, including nested durations', async () => {
  chrome.reset({ settings: { startTime: '07:30', durations: { hard: 90 } } });
  const s = await storage.getSettings();
  assert.equal(s.startTime, '07:30');
  assert.deepEqual(s.durations, { easy: 20, okay: 40, hard: 90 });
  assert.equal(s.reminderMinutes, 15);
});

test('addPending keeps the latest submission per problem and counts only new problems', async () => {
  chrome.reset();
  assert.equal(await storage.addPending([{ id: 'two-sum', submittedAt: 1 }]), 1);
  assert.equal(await storage.addPending([{ id: 'two-sum', submittedAt: 5 }, { id: 'lru-cache', submittedAt: 2 }]), 1);
  assert.equal(await storage.addPending([{ id: 'two-sum', submittedAt: 3 }]), 0);
  const pending = await storage.getPendingMap();
  assert.equal(pending['two-sum'].submittedAt, 5);
});

test('updateCalendarState patches one provider without touching others', async () => {
  chrome.reset({ calendars: { google: { connected: true }, apple: { connected: true } } });
  await storage.updateCalendarState('google', (s) => ({ ...s, lastError: 'x' }));
  await storage.updateCalendarState('apple', () => null);
  assert.deepEqual(chrome.dump().calendars, { google: { connected: true, lastError: 'x' } });
});

// Slows every storage call down, so overlapping read-modify-writes would interleave.
async function withSlowStorage(fn) {
  const { get, set } = chrome.storage.local;
  const sleep = () => new Promise((r) => setTimeout(r, 3));
  chrome.storage.local.get = async (...args) => (await sleep(), get(...args));
  chrome.storage.local.set = async (...args) => (await sleep(), set(...args));
  try {
    return await fn();
  } finally {
    Object.assign(chrome.storage.local, { get, set });
  }
}

test('a rating and a newly detected solve at the same moment both land', async () => {
  const { ratePending } = await import('../lib/rating.js');
  const sub = (id, submittedAt) => ({
    id,
    title: id,
    url: `https://leetcode.com/problems/${id}/`,
    submittedAt,
    submissionId: id,
    source: 'leetcode',
  });
  for (let offset = 0; offset <= 14; offset++) {
    chrome.reset({ pending: { 'two-sum': sub('two-sum', 1000) } });
    await withSlowStorage(() =>
      Promise.all([
        ratePending('two-sum', 'easy'), // the popup
        new Promise((r) => setTimeout(r, offset)).then(() => storage.addPending([sub('lru-cache', 2000)])), // the background check
      ]),
    );
    const { pending, problems } = chrome.dump();
    assert.deepEqual(Object.keys(pending), ['lru-cache'], `offset ${offset}`);
    assert.deepEqual(Object.keys(problems), ['two-sum'], `offset ${offset}`);
  }
});

test('rating the same submission twice at once counts once; dismiss and delete wait their turn', async () => {
  const { ratePending } = await import('../lib/rating.js');
  const sub = (id) => ({ id, title: id.toUpperCase(), url: 'u', submittedAt: 1 });
  chrome.reset({ pending: { a: sub('a'), b: sub('b') } });
  const results = await withSlowStorage(() =>
    Promise.all([ratePending('a', 'easy'), ratePending('a', 'hard'), storage.dismissPending(['b'])]),
  );
  assert.equal(results.filter(Boolean).length, 1);
  const { pending, problems } = chrome.dump();
  assert.deepEqual(pending, {});
  assert.equal(problems.a.history.length, 1);

  await withSlowStorage(() =>
    Promise.all([storage.saveProblem({ id: 'c', title: 'C' }), storage.deleteProblem('a'), storage.saveProblem({ id: 'd' })]),
  );
  assert.deepEqual(Object.keys(chrome.dump().problems).sort(), ['c', 'd']);
});

test('withStorageLock uses Web Locks when the browser has them', async () => {
  const names = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: { request: async (name, fn) => (names.push(name), fn()) } },
  });
  try {
    assert.equal(await storage.withStorageLock(async () => 42), 42);
    chrome.reset();
    await storage.addPending([{ id: 'x', submittedAt: 1 }]);
    assert.deepEqual(names, ['releet-storage', 'releet-storage']);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
});
