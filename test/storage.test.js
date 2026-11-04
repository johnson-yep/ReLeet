import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';

const chrome = installFakeChrome();
const storage = await import('../lib/storage.js');

test('getSettings fills defaults, including nested durations', async () => {
  chrome.reset({ settings: { startTime: '07:30', durations: { hard: 90 } } });
  const s = await storage.getSettings();
  assert.equal(s.startTime, '07:30');
  assert.deepEqual(s.durations, { easy: 20, medium: 40, hard: 90 });
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
