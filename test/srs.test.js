import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_INTERVAL,
  createProblem,
  currentInterval,
  daysBetween,
  isMastered,
  markMastered,
  nextInterval,
  resumeProblem,
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

// Rated Okay on Mon 9 Nov 2026 at 12:00 in Chicago → review on Thu 12 Nov.
const RATED = Date.UTC(2026, 10, 9, 18);
const make = () =>
  withTimeZone('America/Chicago', () =>
    createProblem({ id: 'two-sum', title: 'Two Sum', url: 'https://leetcode.com/problems/two-sum/', rating: 'okay', solvedAt: RATED }),
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

// Intervals

const at = (day, hour = 12) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`).getTime();
const tracked = (interval, rating = 'okay') =>
  withTimeZone('UTC', () => ({
    ...createProblem({ id: 'p', title: 'P', url: 'u', rating, solvedAt: at('2026-01-01') }),
    interval,
  }));

test('a first solve gets 7, 3 or 1 days', () => {
  assert.deepEqual(nextInterval(null, 'easy'), { days: 7, capped: false });
  assert.deepEqual(nextInterval(null, 'okay'), { days: 3, capped: false });
  assert.deepEqual(nextInterval(null, 'hard'), { days: 1, capped: false });
  assert.throws(() => nextInterval(null, 'medium'), /Unknown rating/);
});

test('reviews grow the interval: Easy × 2.5, Okay × 1.5, Hard back to 1, rounded to whole days', () => {
  assert.equal(nextInterval(tracked(3), 'easy').days, 8); // 7.5
  assert.equal(nextInterval(tracked(3), 'okay').days, 5); // 4.5
  assert.equal(nextInterval(tracked(1), 'okay').days, 2); // 1.5
  assert.equal(nextInterval(tracked(1), 'easy').days, 3); // 2.5
  assert.equal(nextInterval(tracked(40), 'hard').days, 1);
});

test('intervals stop at 180 days, and reaching it is flagged so ReLeet can suggest Mastered', () => {
  assert.deepEqual(nextInterval(tracked(71), 'easy'), { days: 178, capped: false });
  assert.deepEqual(nextInterval(tracked(72), 'easy'), { days: 180, capped: true });
  assert.deepEqual(nextInterval(tracked(150), 'okay'), { days: 180, capped: true });
  assert.deepEqual(nextInterval(tracked(MAX_INTERVAL), 'hard'), { days: 1, capped: false });
});

test('createProblem and recordReview store the interval and keep every rating in the history', () => {
  withTimeZone('UTC', () => {
    const p = createProblem({ id: 'p', title: 'P', url: 'u', rating: 'okay', solvedAt: at('2026-01-01') });
    assert.equal(p.interval, 3);
    assert.equal(p.dueDay, '2026-01-04');
    const easy = recordReview(p, 'easy', { at: at('2026-01-04', 20) });
    assert.equal(easy.interval, 8);
    assert.equal(easy.dueDay, '2026-01-12');
    const hard = recordReview(easy, 'hard', { at: at('2026-01-13') });
    assert.equal(hard.interval, 1);
    assert.deepEqual(hard.history.map((h) => h.rating), ['okay', 'easy', 'hard']);
  });
});

test('problems saved without an interval take the gap from their last rating to their review day', () => {
  const legacy = { rating: 'easy', solvedAt: at('2026-03-01'), dueDay: '2026-03-16', history: [
    { at: at('2026-03-01'), rating: 'okay' },
    { at: at('2026-03-09', 23), rating: 'easy' },
  ] };
  assert.equal(currentInterval(legacy), 7);
  assert.equal(nextInterval(legacy, 'okay').days, 11); // 10.5
  // A review day on or before the rating day still counts as a one-day interval.
  assert.equal(currentInterval({ ...legacy, dueDay: '2026-03-09' }), 1);
  assert.equal(currentInterval({ ...legacy, interval: 400 }), MAX_INTERVAL);
});

test('daysBetween counts calendar days across DST changes', () => {
  withTimeZone('America/Denver', () => {
    assert.equal(daysBetween('2026-10-31', '2026-11-02'), 2);
    assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2);
    assert.equal(daysBetween('2026-03-09', '2026-03-07'), -2);
  });
});

test('mastering keeps history and interval; resuming gives today plus the last interval, capped at 180', () => {
  withTimeZone('UTC', () => {
    const p = tracked(120);
    const mastered = markMastered(p, at('2026-02-01'));
    assert.equal(isMastered(mastered), true);
    assert.deepEqual(mastered.history, p.history);
    assert.equal(mastered.interval, 120);

    const resumed = resumeProblem(mastered, at('2026-06-01', 18));
    assert.equal(isMastered(resumed), false);
    assert.equal(Object.hasOwn(resumed, 'masteredAt'), false);
    assert.equal(resumed.dueDay, '2026-09-29'); // June 1 + 120 days
    assert.equal(resumeProblem(markMastered(tracked(400)), at('2026-06-01')).dueDay, '2026-11-28');
  });
});

test('rating a mastered problem brings it back into review', () => {
  const reviewed = recordReview(markMastered(tracked(10)), 'okay', { at: at('2026-05-01') });
  assert.equal(isMastered(reviewed), false);
  assert.equal(reviewed.interval, 15);
});
