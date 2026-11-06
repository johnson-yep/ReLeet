import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExport, mergeImport, parseExport } from '../lib/transfer.js';
import { createProblem, recordReview } from '../lib/srs.js';

const at = (d) => new Date(2026, 10, d, 12).getTime();
const make = (id, day = 1) => createProblem({ id, title: id, url: `https://leetcode.com/problems/${id}/`, rating: 'okay', solvedAt: at(day) });
const roundTrip = (data) => parseExport(JSON.parse(JSON.stringify(buildExport(data, at(20)))));

test('an export reads back as it was written', () => {
  const problems = { a: make('a') };
  const pending = { b: { id: 'b', title: 'B', url: 'https://leetcode.com/problems/b/', submittedAt: 3 } };
  const parsed = roundTrip({ problems, pending, settings: { startTime: '08:00' }, leetcode: { username: 'al', baselineAt: 1, seenIds: ['9'], lastSyncAt: 5 } });
  assert.deepEqual(parsed.problems, problems);
  assert.deepEqual(parsed.pending, pending);
  assert.deepEqual(parsed.settings, { startTime: '08:00' });
  assert.deepEqual(parsed.leetcode, { username: 'al', baselineAt: 1, seenIds: ['9'] });
});

test('an export keeps each calendar id and its events, never a sign-in', () => {
  const data = buildExport({
    calendars: {
      google: { connected: true, calendarId: 'g1', events: { a: { id: 'e' } }, account: 'me@gmail.com', lastError: 'x' },
      apple: { connected: true, calendarId: 'c1', events: {}, auth: { appleId: 'me@icloud.com', appPassword: 'secret' } },
      broken: { connected: true },
    },
  });
  assert.deepEqual(data.calendars, {
    google: { calendarId: 'g1', events: { a: { id: 'e' } }, account: 'me@gmail.com' },
    apple: { calendarId: 'c1', events: {}, account: null, appleId: 'me@icloud.com' },
  });
  assert.doesNotMatch(JSON.stringify(data), /secret/);
});

test('an import from before 1.0 (Medium, no interval) is brought up to date', () => {
  const { interval, ...old } = { ...make('a'), rating: 'medium', history: [{ at: at(1), rating: 'medium' }] };
  const parsed = parseExport({ format: 'releet-export', version: 1, problems: { a: old } });
  assert.equal(parsed.problems.a.rating, 'okay');
  assert.equal(parsed.problems.a.interval, 3);
});

test('files that are not ReLeet exports, or are damaged, are refused with a reason', () => {
  assert.throws(() => parseExport(null), /isn't a ReLeet export/);
  assert.throws(() => parseExport({ format: 'releet-export', version: 2 }), /newer version/);
  const bad = (problem) => parseExport({ format: 'releet-export', version: 1, problems: { x: problem } });
  assert.throws(() => bad('x'), /problem "x"/);
  assert.throws(() => bad({ ...make('x'), url: 'javascript:alert(1)' }), /missing something/);
  assert.throws(() => bad({ ...make('x'), rating: 'meh' }), /missing something/);
  assert.throws(
    () => parseExport({ format: 'releet-export', version: 1, pending: { y: { title: 1 } } }),
    /solve of "y"/,
  );
});

test('merging keeps the copy of each problem with the later rating, and imported settings win', () => {
  const older = make('a', 1);
  const newer = recordReview(make('a', 1), 'easy', { at: at(5) });
  const local = { problems: { a: newer, b: make('b') }, pending: {}, leetcode: {}, calendars: {} };
  const imported = roundTrip({ problems: { a: older, c: make('c') }, settings: { dailyLimit: 90 } });
  const merged = mergeImport(local, imported);
  assert.equal(merged.problems.a, newer);
  assert.deepEqual(Object.keys(merged.problems).sort(), ['a', 'b', 'c']);
  assert.equal(merged.added, 1);
  assert.deepEqual(merged.settings, { dailyLimit: 90 });
  // The other way round the imported copy wins.
  assert.deepEqual(mergeImport({ ...local, problems: { a: older } }, roundTrip({ problems: { a: newer } })).problems.a, newer);
});

test('merging the LeetCode state: the same user keeps every seen solve; another user takes the import', () => {
  const imported = roundTrip({ leetcode: { username: 'al', baselineAt: 10, seenIds: ['1', '2'] } });
  const same = mergeImport({ problems: {}, pending: {}, calendars: {}, leetcode: { username: 'al', baselineAt: 50, seenIds: ['2', '3'], lastSyncAt: 7 } }, imported);
  assert.deepEqual(same.leetcode, { username: 'al', baselineAt: 10, seenIds: ['2', '3', '1'], lastSyncAt: 7 });
  const other = mergeImport({ problems: {}, pending: {}, calendars: {}, leetcode: { username: 'bo', baselineAt: 50, seenIds: ['x'] } }, imported);
  assert.deepEqual(other.leetcode, { username: 'al', baselineAt: 10, seenIds: ['1', '2'] });
});

test('an imported calendar waits to be connected again; one connected here is left alone', () => {
  const imported = roundTrip({
    calendars: {
      google: { calendarId: 'g1', events: { a: { id: 'e1' } } },
      apple: { calendarId: 'c1', events: {}, auth: { appleId: 'me@icloud.com' } },
    },
  });
  const here = { connected: true, calendarId: 'g-here', events: {} };
  const merged = mergeImport({ problems: {}, pending: {}, leetcode: {}, calendars: { google: here } }, imported);
  assert.equal(merged.calendars.google, here);
  assert.deepEqual(merged.calendars.apple, {
    connected: false,
    calendarId: 'c1',
    events: {},
    checkStrays: true,
    account: null,
    auth: { appleId: 'me@icloud.com' },
  });
});

test('an import with a review day that is not a real date is refused', () => {
  const bad = (dueDay) => parseExport({ format: 'releet-export', version: 1, problems: { x: { ...make('x'), dueDay } } });
  assert.throws(() => bad('soon'), /missing something/);
  assert.throws(() => bad('2026-02-30'), /missing something/);
});

test('imported settings keep only values Settings would save', () => {
  const settings = {
    startTime: '07:45',
    dailyLimit: 90,
    durations: { easy: 25, okay: 0, hard: '60', medium: 40 },
    reminderMinutes: 10,
    dailySummary: false,
    leetcodeUsername: ' alice ',
    leetcodeUsernameSource: 'manual',
    token: 'secret',
  };
  assert.deepEqual(parseExport({ format: 'releet-export', version: 1, settings }).settings, {
    startTime: '07:45',
    dailyLimit: 90,
    reminderMinutes: 10,
    dailySummary: false,
    leetcodeUsername: 'alice',
    leetcodeUsernameSource: 'manual',
    durations: { easy: 25 },
  });
  const wild = { startTime: '25:00', dailyLimit: 100000, durations: 'long', dailySummary: 'yes' };
  assert.deepEqual(parseExport({ format: 'releet-export', version: 1, settings: wild }).settings, {});
});
