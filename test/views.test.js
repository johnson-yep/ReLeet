import { test } from 'node:test';
import assert from 'node:assert/strict';
import { popupView, streak } from '../lib/views.js';
import { dayName, overdueText, plural, reviewWhen, timeAgo } from '../lib/format.js';
import { addDays, createProblem, dayKey, markMastered, recordReview, startOfDay } from '../lib/srs.js';

const NOW = new Date(2026, 10, 10, 8).getTime(); // Tue Nov 10, 08:00
const day = (offset, hour = 12) => addDays(startOfDay(NOW), offset) + hour * 3600000;
const SETTINGS = { startTime: '09:00', durations: { easy: 20, okay: 40, hard: 60 }, dailyLimit: 600, reminderMinutes: 15 };
// Rated `rating` so that its review falls `offset` days from today.
function tracked(id, offset, rating = 'okay') {
  const days = { easy: 7, okay: 3, hard: 1 }[rating];
  return createProblem({ id, title: id.toUpperCase(), url: `https://leetcode.com/problems/${id}/`, rating, solvedAt: day(offset - days) });
}
const solve = (id, minutesAgo) => ({ id, title: id, url: `https://leetcode.com/problems/${id}/`, submittedAt: NOW - minutesAgo * 60000 });
const view = (problems, pending = {}, extra = {}) =>
  popupView({ problems: Object.fromEntries(problems.map((p) => [p.id, p])), pending, settings: SETTINGS, ...extra }, NOW);

test('due today lists overdue reviews first, then by time, with each button\'s next interval', () => {
  const v = view([tracked('a', 0), tracked('late', -9, 'easy'), tracked('b', 0, 'hard')]);
  assert.deepEqual(v.due.items.map((i) => i.problem.id), ['late', 'a', 'b']);
  assert.equal(v.due.items[0].slot.overdueSince, dayKey(day(-9)));
  assert.equal(v.due.minutes, (20 + 40 + 60) * 60000);
  // Easy 7 days ago → × 2.5 → 18 days; Okay → 11; Hard → 1.
  assert.deepEqual(
    Object.fromEntries(Object.entries(v.due.items[0].intervals).map(([r, i]) => [r, i.days])),
    { easy: 18, okay: 11, hard: 1 },
  );
});

test('a tracked problem solved again shows once, under To rate, counted in due today', () => {
  const v = view([tracked('a', 0), tracked('b', 0)], { a: solve('a', 10), c: solve('c', 5) });
  assert.deepEqual(v.toRate.map((r) => r.solve.id), ['c', 'a']); // newest first
  assert.equal(v.toRate[1].problem.id, 'a');
  assert.equal(v.toRate[0].intervals.easy.days, 7); // not tracked yet
  assert.deepEqual(v.due.items.map((i) => i.problem.id), ['b']);
  assert.equal(v.stats.dueToday, 1); // the same count as the Due today header
});

test('upcoming reviews are grouped by day, the next seven shown first', () => {
  const v = view([tracked('a', 1), tracked('b', 1, 'easy'), tracked('c', 3), tracked('far', 12)]);
  assert.deepEqual(
    v.upcoming.map((g) => [g.day, g.items.map((i) => i.problem.id), g.minutes / 60000, g.soon]),
    [
      [dayKey(day(1)), ['b', 'a'], 60, true], // b was rated first
      [dayKey(day(3)), ['c'], 40, true],
      [dayKey(day(12)), ['far'], 40, false],
    ],
  );
  assert.equal(v.upcomingCount, 4);
});

test('stats: tracked leaves out mastered problems; the empty state is only for a new user', () => {
  const v = view([tracked('a', 1), markMastered(tracked('m', 2)), markMastered(tracked('n', 2))]);
  assert.deepEqual(v.stats, { tracked: 1, dueToday: 0, mastered: 2, streak: 2 }); // first solves yesterday and the day before
  assert.deepEqual(v.mastered.map((p) => p.id), ['m', 'n']);
  assert.equal(v.empty, false);
  assert.equal(view([]).empty, true);
  assert.equal(view([], { a: solve('a', 1) }).empty, false);
});

test('the streak counts days in a row with a rating; today only adds once it has one', () => {
  let p = tracked('a', 5);
  p = recordReview(p, 'easy', { at: day(-2) });
  p = recordReview(p, 'easy', { at: day(-1) });
  assert.equal(streak([p], NOW), 2); // yesterday and the day before; today isn't over
  assert.equal(streak([recordReview(p, 'okay', { at: day(0, 7) })], NOW), 3);
  const gap = recordReview(tracked('b', 5), 'easy', { at: day(-3) });
  assert.equal(streak([gap], NOW), 0);
});

test('format: day names, overdue text, time ago, review times', () => {
  assert.equal(dayName(dayKey(NOW), NOW), 'Today');
  assert.equal(dayName(dayKey(day(1)), NOW), 'Tomorrow');
  assert.match(dayName(dayKey(day(2)), NOW), /Thu/);
  assert.equal(overdueText(dayKey(day(-1)), NOW), '1 day overdue');
  assert.equal(overdueText(dayKey(day(-9)), NOW), '9 days overdue');
  assert.equal(timeAgo(NOW - 10 * 60000, NOW), '10 min ago');
  assert.equal(plural(1, 'review'), '1 review');
  assert.match(reviewWhen(dayKey(day(1)), day(1, 9), NOW), /^tomorrow at 9:00/);
  assert.match(reviewWhen(dayKey(day(6)), null, NOW), /^Mon, Nov 16$/);
});
