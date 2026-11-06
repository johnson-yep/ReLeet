import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';

const alarms = new Map();
const chrome = installFakeChrome({}, {
  alarms: {
    getAll: async () => [...alarms.values()],
    clear: async (name) => alarms.delete(name),
  },
});
const { migrateStoredData, upgradeProblem } = await import('../lib/migrate.js');

test('an update drops stored Outlook state and keeps the other calendars', async () => {
  chrome.reset({
    calendars: {
      google: { connected: true, calendarId: 'g' },
      outlook: { connected: true, auth: { refreshToken: 'secret' } },
    },
  });
  await migrateStoredData();
  assert.deepEqual(chrome.dump().calendars, { google: { connected: true, calendarId: 'g' } });
});

test("an update drops v0.2's GitHub sync settings, state and alarms", async () => {
  chrome.reset({ settings: { startTime: '08:00', owner: 'me', repo: 'r', token: 't' }, sync: { at: 1 } });
  alarms.set('github-sync', { name: 'github-sync' });
  alarms.set('after-submit:1', { name: 'after-submit:1' });
  alarms.set('calendar-sync', { name: 'calendar-sync' });
  await migrateStoredData();
  const stored = chrome.dump();
  assert.equal(stored.sync, undefined);
  assert.equal(stored.settings.startTime, '08:00');
  for (const key of ['owner', 'repo', 'token']) assert.equal(Object.hasOwn(stored.settings, key), false, key);
  assert.deepEqual([...alarms.keys()], ['calendar-sync']);
});

test('migrating current data changes nothing', async () => {
  const current = { calendars: { apple: { connected: false } }, settings: { startTime: '09:00' } };
  chrome.reset(current);
  await migrateStoredData();
  await migrateStoredData();
  assert.deepEqual(chrome.dump(), current);
});

const day = (d, h = 12) => new Date(`2026-11-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00`).getTime();

// As v0.3 saved it: Medium, no interval, a notification marker.
const v03 = {
  id: 'two-sum',
  title: 'Two Sum',
  url: 'https://leetcode.com/problems/two-sum/',
  rating: 'medium',
  solvedAt: day(1),
  dueAt: day(9, 0),
  dueDay: '2026-11-09',
  commitSha: null,
  source: 'leetcode',
  history: [
    { at: day(1), rating: 'easy', commitSha: null },
    { at: day(6, 22), rating: 'medium', commitSha: null },
  ],
  notifiedFor: day(9, 0),
};

test('an update renames Medium to Okay everywhere and stores each problem\'s interval', async () => {
  chrome.reset({ problems: { 'two-sum': v03 }, settings: { durations: { easy: 15, medium: 45, hard: 60 } } });
  await migrateStoredData();
  const { problems, settings } = chrome.dump();
  const p = problems['two-sum'];
  assert.equal(p.rating, 'okay');
  assert.deepEqual(p.history.map((h) => h.rating), ['easy', 'okay']);
  assert.equal(p.interval, 3); // Nov 6 → Nov 9
  assert.equal(p.dueDay, '2026-11-09'); // existing review days stay
  assert.equal(Object.hasOwn(p, 'notifiedFor'), false);
  assert.deepEqual(settings.durations, { easy: 15, okay: 45, hard: 60 });
});

test('a custom Medium block length survives alongside the v0.2 cleanup', async () => {
  chrome.reset({ settings: { owner: 'me', durations: { medium: 50 } } });
  await migrateStoredData();
  assert.equal(chrome.dump().settings.durations.okay, 50);
  assert.equal(chrome.dump().settings.durations.medium, undefined);
});

test('upgradeProblem fills the review day from dueAt and leaves a current problem alone', () => {
  const { dueDay, ...noDay } = v03;
  assert.equal(upgradeProblem(noDay).dueDay, '2026-11-09');
  const current = upgradeProblem(v03);
  assert.deepEqual(upgradeProblem(current), current);
});
