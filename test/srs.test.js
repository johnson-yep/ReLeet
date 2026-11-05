import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProblem,
  dayKey,
  dayStartMs,
  groupByDue,
  isDue,
  nextDueAfter,
  recordReview,
  reviewDay,
} from '../lib/srs.js';

function withTimeZone(tz, fn) {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

// Rated Medium on Mon 9 Nov 2026 at 12:00 in Chicago → review on Thu 12 Nov.
const RATED = Date.UTC(2026, 10, 9, 18);
const make = () =>
  withTimeZone('America/Chicago', () =>
    createProblem({ id: 'two-sum', title: 'Two Sum', url: 'https://leetcode.com/problems/two-sum/', rating: 'medium', solvedAt: RATED }),
  );

test('createProblem and recordReview store the review day next to dueAt', () => {
  const p = make();
  assert.equal(p.dueDay, '2026-11-12');
  assert.equal(p.dueAt, Date.UTC(2026, 10, 12, 6)); // midnight in Chicago
  const reviewed = withTimeZone('Europe/London', () => recordReview(p, 'hard', { at: Date.UTC(2026, 10, 12, 23, 30) }));
  assert.equal(reviewed.dueDay, '2026-11-13');
  assert.equal(reviewed.dueAt, Date.UTC(2026, 10, 13));
});

test('the review day does not move with the time zone', () => {
  const p = make();
  for (const tz of ['America/Chicago', 'America/Los_Angeles', 'Pacific/Honolulu', 'Asia/Tokyo', 'UTC']) {
    withTimeZone(tz, () => {
      assert.equal(reviewDay(p), '2026-11-12', tz);
      // Wednesday evening locally: not due yet, even where dueAt is already past.
      const wednesdayEvening = new Date(2026, 10, 11, 23, 30).getTime();
      assert.equal(isDue(p, wednesdayEvening), false, tz);
      assert.deepEqual(groupByDue([p], wednesdayEvening).upcoming, [p], tz);
      assert.equal(nextDueAfter([p], wednesdayEvening), new Date(2026, 10, 12).getTime(), tz);
      // From local midnight of the review day on, it's due.
      const thursday = new Date(2026, 10, 12).getTime();
      assert.equal(isDue(p, thursday), true, tz);
      assert.deepEqual(groupByDue([p], thursday).dueToday, [p], tz);
      assert.equal(nextDueAfter([p], thursday), null, tz);
    });
  }
});

test('problems saved without dueDay fall back to dueAt in the current zone', () => {
  const { dueDay, ...legacy } = make();
  assert.equal(dueDay, '2026-11-12');
  withTimeZone('America/Chicago', () => assert.equal(reviewDay(legacy), '2026-11-12'));
  withTimeZone('America/Denver', () => assert.equal(reviewDay(legacy), '2026-11-11'));
  // "Make due now" style: dueAt set to an instant during the day.
  withTimeZone('UTC', () => {
    const now = Date.UTC(2026, 10, 4, 15);
    assert.equal(isDue({ ...legacy, dueAt: now }, now), true);
    assert.equal(isDue({ ...legacy, dueAt: now, dueDay: dayKey(now) }, now), true);
  });
});

test('groupByDue sorts by review day, then due time; nextDueAfter skips broken problems', () => {
  withTimeZone('UTC', () => {
    const now = Date.UTC(2026, 11, 1, 12);
    const a = { id: 'a', dueAt: Date.UTC(2026, 11, 3), dueDay: '2026-12-03' };
    const b = { id: 'b', dueAt: Date.UTC(2026, 11, 2, 6), dueDay: '2026-12-02' }; // rated further west
    const c = { id: 'c', dueAt: Date.UTC(2026, 11, 1, 18), dueDay: '2026-12-02' }; // rated further east
    const due = { id: 'due', dueAt: Date.UTC(2026, 10, 30), dueDay: '2026-11-30' };
    const { dueToday, upcoming } = groupByDue([a, b, due, c], now);
    assert.deepEqual(dueToday.map((p) => p.id), ['due']);
    assert.deepEqual(upcoming.map((p) => p.id), ['c', 'b', 'a']);
    assert.equal(nextDueAfter([a, b, due, { id: 'broken' }], now), Date.UTC(2026, 11, 2));
    assert.equal(dayStartMs('2026-12-02'), Date.UTC(2026, 11, 2));
    assert.equal(nextDueAfter([], now), null);
  });
});
