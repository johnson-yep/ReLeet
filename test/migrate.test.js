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
const { migrateStoredData } = await import('../lib/migrate.js');

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
