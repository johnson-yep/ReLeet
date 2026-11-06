import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookedProblems, dayKey, layoutKey, slotHash, planSchedule, diffEvents } from '../lib/schedule.js';
import { createProblem, markMastered, recordReview, startOfDay } from '../lib/srs.js';

// Every time below is local wall-clock time in whatever zone is active when the
// test body runs, so the suite passes under any TZ. DST tests pin their zone.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ZONES = ['America/Denver', 'Europe/London', 'Asia/Kolkata', 'UTC'];

const SETTINGS = Object.freeze({
  leetcodeUsername: 'someone',
  leetcodeUsernameSource: 'manual',
  startTime: '09:00',
  durations: Object.freeze({ easy: 20, okay: 40, hard: 60 }),
  // A whole day, so the placement tests below aren't split by the limit; the
  // daily limit has its own tests.
  dailyLimit: 24 * 60,
  reminderMinutes: 15,
});

const withSettings = (patch) => ({ ...SETTINGS, ...patch, durations: { ...SETTINGS.durations, ...patch.durations } });

const at = (y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) => new Date(y, m - 1, d, hh, mm, ss, ms).getTime();

// Today is Wednesday 2026-11-04 in these tests; "day(n)" is local midnight n days later.
const TODAY = [2026, 11, 4];
const day = (offset = 0) => at(TODAY[0], TODAY[1], TODAY[2] + offset);
const time = (offset, hh, mm = 0, ss = 0, ms = 0) => at(TODAY[0], TODAY[1], TODAY[2] + offset, hh, mm, ss, ms);

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

const titleCase = (id) => id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const label = (rating) => rating[0].toUpperCase() + rating.slice(1);

// A tracked problem due at local midnight of `due`, last rated at `ratedAt`.
function problem(id, { due, rating = 'okay', ratedAt = due - 3 * DAY, title = titleCase(id), url } = {}) {
  return {
    id,
    title,
    url: url ?? `https://leetcode.com/problems/${id}/`,
    rating,
    solvedAt: ratedAt,
    dueAt: due,
    commitSha: null,
    source: 'leetcode',
    history: [{ at: ratedAt, rating, commitSha: null }],
  };
}

// The slot planSchedule should produce for `p` at `start`.
function slot(p, start, minutes, { reminderMinutes = 15, day: slotDay = dayKey(p.dueAt), overdueSince } = {}) {
  const s = {
    problemId: p.id,
    day: slotDay,
    start,
    end: start + minutes * MIN,
    title: `Review: ${p.title}`,
    description: `Review ${p.title} (last rated ${label(p.rating)}).\n${p.url}\n\nScheduled by ReLeet.`,
    url: p.url,
    rating: p.rating,
    reminderMinutes,
    dueDay: dayKey(p.dueAt),
  };
  if (overdueSince) s.overdueSince = overdueSince;
  return s;
}

const schedule = (entries, settings = SETTINGS) => ({
  layoutKey: layoutKey(settings),
  entries: Object.fromEntries(entries.map((s) => [s.problemId, s])),
});

const pad = (n) => String(n).padStart(2, '0');
const clock = (ms) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;

// { id: 'YYYY-MM-DD HH:MM+min' } — readable placement summary in local time.
function placements(plan) {
  return Object.fromEntries(
    Object.values(plan.entries).map((s) => [s.problemId, `${dayKey(s.start)} ${clock(s.start)}+${(s.end - s.start) / MIN}`]),
  );
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// dayKey

test('dayKey returns the local calendar day, zero-padded', () => {
  assert.equal(dayKey(at(2026, 1, 5)), '2026-01-05');
  assert.equal(dayKey(at(2026, 1, 5, 23, 59, 59, 999)), '2026-01-05');
  assert.equal(dayKey(at(2026, 12, 31, 23, 59, 59, 999)), '2026-12-31');
  assert.equal(dayKey(at(2026, 12, 31, 23, 59, 59, 999) + 1), '2027-01-01');
});

test('dayKey follows local midnight in every zone', () => {
  const instant = Date.UTC(2026, 10, 4, 23, 0); // 23:00 UTC
  const expected = {
    'America/Denver': '2026-11-04', // 16:00 MST
    'Europe/London': '2026-11-04', // 23:00 GMT
    'Asia/Kolkata': '2026-11-05', // 04:30 IST next day
    UTC: '2026-11-04',
  };
  for (const tz of ZONES) {
    withTimeZone(tz, () => {
      assert.equal(dayKey(instant), expected[tz], tz);
      assert.equal(dayKey(at(2026, 11, 4)), '2026-11-04', tz);
      assert.equal(dayKey(at(2026, 11, 4) - 1), '2026-11-03', tz);
    });
  }
});

test('dayKey across the US DST change (America/Denver, 2026-11-01)', () => {
  withTimeZone('America/Denver', () => {
    assert.equal(dayKey(Date.UTC(2026, 10, 1, 5, 59)), '2026-10-31'); // 23:59 MDT
    assert.equal(dayKey(Date.UTC(2026, 10, 1, 6, 0)), '2026-11-01'); // 00:00 MDT
    assert.equal(dayKey(Date.UTC(2026, 10, 1, 7, 30)), '2026-11-01'); // 01:30 MDT
    assert.equal(dayKey(Date.UTC(2026, 10, 1, 8, 30)), '2026-11-01'); // 01:30 MST (repeated hour)
    assert.equal(dayKey(Date.UTC(2026, 10, 2, 6, 59)), '2026-11-01'); // 23:59 MST
    assert.equal(dayKey(Date.UTC(2026, 10, 2, 7, 0)), '2026-11-02'); // 00:00 MST
    assert.equal(at(2026, 11, 2) - at(2026, 11, 1), 25 * HOUR);
  });
});

test('dayKey across the EU DST change (Europe/London, 2026-10-25)', () => {
  withTimeZone('Europe/London', () => {
    assert.equal(dayKey(Date.UTC(2026, 9, 24, 22, 59)), '2026-10-24'); // 23:59 BST
    assert.equal(dayKey(Date.UTC(2026, 9, 24, 23, 0)), '2026-10-25'); // 00:00 BST
    assert.equal(dayKey(Date.UTC(2026, 9, 25, 0, 30)), '2026-10-25'); // 01:30 BST
    assert.equal(dayKey(Date.UTC(2026, 9, 25, 1, 30)), '2026-10-25'); // 01:30 GMT (repeated hour)
    assert.equal(dayKey(Date.UTC(2026, 9, 25, 23, 59)), '2026-10-25'); // 23:59 GMT
    assert.equal(dayKey(Date.UTC(2026, 9, 26, 0, 0)), '2026-10-26');
    assert.equal(at(2026, 10, 26) - at(2026, 10, 25), 25 * HOUR);
  });
});

// layoutKey / slotHash

test('layoutKey changes with the start time, each duration and the daily limit, and nothing else', () => {
  const base = layoutKey(SETTINGS);
  assert.equal(layoutKey({ ...SETTINGS }), base);
  assert.equal(layoutKey(withSettings({ reminderMinutes: 5 })), base);
  assert.equal(layoutKey(withSettings({ leetcodeUsername: 'other', leetcodeUsernameSource: 'auto' })), base);
  assert.notEqual(layoutKey(withSettings({ startTime: '09:30' })), base);
  assert.notEqual(layoutKey(withSettings({ durations: { easy: 25 } })), base);
  assert.notEqual(layoutKey(withSettings({ durations: { okay: 45 } })), base);
  assert.notEqual(layoutKey(withSettings({ durations: { hard: 90 } })), base);
  // Same layout written differently is the same layout.
  assert.equal(layoutKey(withSettings({ startTime: '9:00' })), base);
  assert.equal(layoutKey(withSettings({ durations: { easy: '20', okay: '40', hard: '60' } })), base);
  assert.notEqual(layoutKey(withSettings({ dailyLimit: 90 })), base);
  // Missing settings fall back to the defaults.
  const defaults = layoutKey(withSettings({ dailyLimit: 60 }));
  assert.equal(layoutKey({}), defaults);
  assert.equal(layoutKey(undefined), defaults);
});

test('slotHash covers exactly what is written to the calendar', () => {
  const p = problem('two-sum', { due: day(1) });
  const s = slot(p, time(1, 9), 40);
  const reordered = Object.fromEntries(Object.entries(s).reverse());
  assert.equal(slotHash(reordered), slotHash(s));
  assert.equal(typeof slotHash(s), 'string');

  for (const [field, value] of [
    ['start', s.start + MIN],
    ['end', s.end + MIN],
    ['title', 'Review: Other'],
    ['description', 'changed'],
    ['url', 'https://leetcode.com/problems/other/'],
    ['reminderMinutes', 30],
  ]) {
    assert.notEqual(slotHash({ ...s, [field]: value }), slotHash(s), field);
  }
  // Not written to the calendar by itself (the description carries the rating).
  assert.equal(slotHash({ ...s, rating: 'hard', problemId: 'x', day: '2030-01-01' }), slotHash(s));
});

// planSchedule: placement

test('places a single upcoming review at the start time on its due day', () => {
  const p = problem('two-sum', { due: day(1) });
  const plan = planSchedule(null, [p], SETTINGS, time(0, 8));
  assert.deepEqual(plan, {
    layoutKey: layoutKey(SETTINGS),
    entries: { 'two-sum': slot(p, time(1, 9), 40) },
  });
  assert.equal(plan.entries['two-sum'].day, dayKey(day(1)));
  assert.equal(plan.entries['two-sum'].description, `Review Two Sum (last rated Okay).\nhttps://leetcode.com/problems/two-sum/\n\nScheduled by ReLeet.`);
});

test('stacks several reviews on one day back-to-back, each day from its start time', () => {
  const ratedAt = time(-2, 12);
  const problems = [
    problem('charlie', { due: day(1), rating: 'okay', ratedAt }),
    problem('alpha', { due: day(1), rating: 'hard', ratedAt }),
    problem('bravo', { due: day(1), rating: 'easy', ratedAt }),
    problem('delta', { due: day(2), rating: 'easy', ratedAt }),
  ];
  const plan = planSchedule(null, problems, SETTINGS, time(0, 8));
  assert.deepEqual(placements(plan), {
    alpha: `${dayKey(day(1))} 09:00+60`,
    bravo: `${dayKey(day(1))} 10:00+20`,
    charlie: `${dayKey(day(1))} 10:20+40`,
    delta: `${dayKey(day(2))} 09:00+20`,
  });
  assert.deepEqual(Object.keys(plan.entries), ['alpha', 'bravo', 'charlie', 'delta']);
  assert.equal(plan.entries.alpha.end, plan.entries.bravo.start);
  assert.equal(plan.entries.bravo.end, plan.entries.charlie.start);
});

test('orders same-day reviews by due time, then last rating time, then id', () => {
  const t0 = time(-5, 10);
  const t1 = time(-4, 10);
  const t2 = time(-3, 10);
  const alpha = problem('alpha', { due: day(1), ratedAt: t2 });
  alpha.history = [{ at: t0, rating: 'okay', commitSha: null }, { at: t2, rating: 'okay', commitSha: null }];
  const problems = [
    alpha, // first id and earliest first rating, but its last rating is the latest
    problem('yankee', { due: day(1), ratedAt: t1 }),
    problem('xray', { due: day(1), ratedAt: t1 }), // ties with yankee → id order
    problem('aaron', { due: day(1) + 6 * HOUR, ratedAt: t0 }), // later due time on the same day
  ];
  const plan = planSchedule(null, problems, SETTINGS, time(0, 8));
  assert.deepEqual(Object.keys(plan.entries), ['xray', 'yankee', 'alpha', 'aaron']);
  assert.deepEqual(Object.values(placements(plan)).map((p) => p.slice(11)), ['09:00+40', '09:40+40', '10:20+40', '11:00+40']);
});

test('the plan does not depend on the order problems are given in', () => {
  const problems = [
    problem('a', { due: day(1), rating: 'easy', ratedAt: time(-1, 9) }),
    problem('b', { due: day(1), rating: 'hard', ratedAt: time(-1, 9) }),
    problem('c', { due: day(1), rating: 'okay', ratedAt: time(-2, 9) }),
    problem('d', { due: day(2), rating: 'okay', ratedAt: time(-1, 9) }),
    problem('e', { due: day(2), rating: 'easy', ratedAt: time(-1, 9) }),
    problem('f', { due: day(0), rating: 'hard', ratedAt: time(-1, 9) }),
  ];
  const now = time(0, 10, 3);
  const expected = planSchedule(null, problems, SETTINGS, now);
  const orders = [[...problems].reverse(), [problems[3], problems[0], problems[5], problems[1], problems[4], problems[2]]];
  for (const order of orders) {
    const plan = planSchedule(null, order, SETTINGS, now);
    assert.deepEqual(plan, expected);
    assert.equal(JSON.stringify(plan), JSON.stringify(expected)); // same key order too
  }
});

// planSchedule: keeping existing blocks

test('keeps existing blocks and first-fits new ones into the gaps around them', () => {
  const due = day(1);
  const a = problem('kept-a', { due, rating: 'okay', ratedAt: time(-3, 9) });
  const b = problem('kept-b', { due, rating: 'easy', ratedAt: time(-3, 9) });
  // Free on day 1: 09:00–09:40 (40 min), 10:20–10:40 (20 min), from 11:00.
  const prev = schedule([slot(a, time(1, 9, 40), 40), slot(b, time(1, 10, 40), 20)]);
  const x = problem('new-x', { due, rating: 'hard', ratedAt: time(-2, 9) });
  const y = problem('new-y', { due, rating: 'okay', ratedAt: time(-2, 10) });
  const z = problem('new-z', { due, rating: 'easy', ratedAt: time(-2, 11) });

  const plan = planSchedule(prev, [z, y, x, b, a], SETTINGS, time(0, 8));
  const d = dayKey(due);
  assert.deepEqual(placements(plan), {
    'kept-a': `${d} 09:40+40`, // unchanged
    'kept-b': `${d} 10:40+20`, // unchanged
    'new-x': `${d} 11:00+60`, // too long for either gap
    'new-y': `${d} 09:00+40`, // exactly fills the first gap
    'new-z': `${d} 10:20+20`, // exactly fills the second gap
  });
  assert.deepEqual(plan.entries['kept-a'], prev.entries['kept-a']);
});

test('kept blocks pick up a new title, url and reminder without moving', () => {
  const old = problem('two-sum', { due: day(2), title: 'Old Title', url: 'https://leetcode.com/problems/old/' });
  const prev = schedule([slot(old, time(2, 9), 40, { reminderMinutes: 10 })], withSettings({ reminderMinutes: 10 }));
  const renamed = { ...old, title: 'Two Sum', url: 'https://leetcode.com/problems/two-sum/' };
  const settings = withSettings({ reminderMinutes: 30 }); // not part of the layout

  const plan = planSchedule(prev, [renamed], settings, time(0, 8));
  assert.equal(plan.layoutKey, prev.layoutKey);
  assert.deepEqual(plan.entries['two-sum'], slot(renamed, time(2, 9), 40, { reminderMinutes: 30 }));
  assert.notEqual(slotHash(plan.entries['two-sum']), slotHash(prev.entries['two-sum']));
});

test('a started block is frozen but still picks up the new rating', () => {
  const p = problem('lru-cache', { due: day(0), rating: 'okay' });
  const prev = schedule([slot(p, time(0, 9), 40)]);
  const reRated = { ...p, rating: 'hard' }; // same day, different duration
  const plan = planSchedule(prev, [reRated], SETTINGS, time(0, 9, 10));
  assert.deepEqual(plan.entries['lru-cache'], slot(reRated, time(0, 9), 40));
  assert.match(plan.entries['lru-cache'].description, /last rated Hard/);
});

test('started blocks stay frozen when the layout changes; the rest are re-placed', () => {
  const ratedAt = time(-3, 9);
  const a = problem('started-a', { due: day(0), ratedAt });
  const b = problem('waiting-b', { due: day(0), ratedAt: ratedAt + 1 });
  const c = problem('tomorrow-c', { due: day(1), ratedAt });
  const prev = schedule([slot(a, time(0, 9), 40), slot(b, time(0, 9, 40), 40), slot(c, time(1, 9), 40)]);
  const settings = withSettings({ startTime: '08:00', durations: { okay: 30 } });

  const plan = planSchedule(prev, [a, b, c], settings, time(0, 9, 10));
  assert.notEqual(plan.layoutKey, prev.layoutKey);
  assert.deepEqual(placements(plan), {
    'started-a': `${dayKey(day(0))} 09:00+40`, // frozen, keeps its old length
    'waiting-b': `${dayKey(day(0))} 09:40+30`, // today's cursor is 09:10, then after the frozen block
    'tomorrow-c': `${dayKey(day(1))} 08:00+30`,
  });
});

test('a block starting exactly now counts as started', () => {
  const p = problem('two-sum', { due: day(0) });
  const prev = schedule([slot(p, time(0, 9), 40)]);
  const plan = planSchedule(prev, [p], withSettings({ startTime: '10:00' }), time(0, 9));
  assert.deepEqual(plan.entries['two-sum'], prev.entries['two-sum']);
});

test('a new start time or duration re-places every upcoming block', () => {
  const ratedAt = time(-1, 9);
  const problems = [
    problem('a', { due: day(1), rating: 'easy', ratedAt }),
    problem('b', { due: day(1), rating: 'okay', ratedAt }),
    problem('c', { due: day(3), rating: 'hard', ratedAt }),
  ];
  const now = time(0, 8);
  const prev = planSchedule(null, problems, SETTINGS, now);

  const earlier = planSchedule(prev, problems, withSettings({ startTime: '07:30' }), now);
  assert.deepEqual(Object.values(placements(earlier)).map((p) => p.slice(11)), ['07:30+20', '07:50+40', '07:30+60']);

  const longer = planSchedule(prev, problems, withSettings({ durations: { easy: 30 } }), now);
  assert.deepEqual(Object.values(placements(longer)).map((p) => p.slice(11)), ['09:00+30', '09:30+40', '09:00+60']);

  // A schedule saved without a layout key (storage default) is treated as stale.
  const stale = planSchedule({ ...prev, layoutKey: null }, problems, withSettings({ startTime: '07:30' }), now);
  assert.deepEqual(stale, earlier);
});

test('planning again with nothing changed returns the same plan', () => {
  const problems = [
    problem('a', { due: day(0), rating: 'hard' }),
    problem('b', { due: day(1), rating: 'easy' }),
    problem('c', { due: day(1), rating: 'okay' }),
  ];
  const first = planSchedule(null, problems, SETTINGS, time(0, 10, 7));
  assert.deepEqual(planSchedule(first, problems, SETTINGS, time(0, 10, 7)), first);
  // Later the same day (today's block hasn't started yet): still nothing moves.
  assert.deepEqual(planSchedule(first, problems, SETTINGS, time(0, 10, 9)), first);
  // After today's block started it's frozen, so still nothing moves.
  assert.deepEqual(planSchedule(first, problems, SETTINGS, time(0, 10, 30)), first);
});

test('a different duration on the same day re-places the block', () => {
  const p = problem('p', { due: day(5), rating: 'easy', ratedAt: time(-2, 9) });
  const q = problem('q', { due: day(5), rating: 'okay', ratedAt: time(-1, 9) });
  const prev = schedule([slot(p, time(5, 9), 20), slot(q, time(5, 9, 20), 40)]);
  // Solved again and rated Okay, landing on the same review day.
  const reRated = { ...p, rating: 'okay', history: [...p.history, { at: time(2, 9), rating: 'okay', commitSha: null }] };
  const plan = planSchedule(prev, [reRated, q], SETTINGS, time(2, 9, 30));
  assert.deepEqual(placements(plan), {
    q: `${dayKey(day(5))} 09:20+40`, // kept
    p: `${dayKey(day(5))} 10:00+40`, // 09:00–09:20 is now too short
  });
});

test('a re-rated problem moves to its new day; blocks left behind do not shift', () => {
  const p = problem('p', { due: day(1), ratedAt: time(-2, 9) });
  const q = problem('q', { due: day(1), ratedAt: time(-2, 10) });
  const r = problem('r', { due: day(4), rating: 'easy', ratedAt: time(-2, 9) });
  const prev = schedule([slot(p, time(1, 9), 40), slot(q, time(1, 9, 40), 40), slot(r, time(4, 9), 20)]);

  const moved = { ...p, dueAt: day(4) };
  const plan = planSchedule(prev, [moved, q, r], SETTINGS, time(0, 12));
  assert.deepEqual(placements(plan), {
    q: `${dayKey(day(1))} 09:40+40`, // stays put
    r: `${dayKey(day(4))} 09:00+20`,
    p: `${dayKey(day(4))} 09:20+40`, // after r on its new day
  });
  assert.equal(plan.entries.p.day, dayKey(day(4)));
});

// planSchedule: today

test("today's first block starts at the next 5 minutes after now, never earlier", () => {
  const p = problem('today', { due: day(0), rating: 'easy' });
  const cases = [
    [time(0, 8, 0), time(0, 9, 0)], // start time not reached yet
    [time(0, 10, 2, 30), time(0, 10, 5)],
    [time(0, 10, 5, 0, 0), time(0, 10, 5)], // already on a 5-minute mark
    [time(0, 10, 5, 0, 1), time(0, 10, 10)],
    [time(0, 10, 9, 59, 999), time(0, 10, 10)],
  ];
  for (const [now, start] of cases) {
    const s = planSchedule(null, [p], SETTINGS, now).entries.today;
    assert.equal(s.start, start, new Date(now).toString());
    assert.ok(s.start >= now);
    assert.equal(s.end - s.start, 20 * MIN);
  }
});

test('late in the day the block runs past midnight but keeps its review day', () => {
  const p = problem('late', { due: day(0), rating: 'okay' });
  const s = planSchedule(null, [p], SETTINGS, time(0, 23, 58)).entries.late;
  assert.equal(s.start, time(1, 0, 0));
  assert.equal(s.day, dayKey(day(0)));
});

test('today: gaps before now are never used', () => {
  const past = problem('past', { due: day(0), ratedAt: time(-3, 9) });
  const later = problem('later', { due: day(0), ratedAt: time(-3, 10) });
  const prev = schedule([slot(past, time(0, 9), 40), slot(later, time(0, 11), 40)]);
  const fresh = problem('fresh', { due: day(0), rating: 'easy', ratedAt: time(-2, 9) });

  // 09:40–11:00 is free, but only from now (10:47 → 10:50) and 10 minutes isn't enough.
  const plan = planSchedule(prev, [past, later, fresh], SETTINGS, time(0, 10, 47));
  assert.equal(plan.entries.fresh.start, time(0, 11, 40));

  // Earlier in the morning the same gap fits, starting at the rounded-up now.
  const early = planSchedule(prev, [past, later, fresh], SETTINGS, time(0, 9, 51));
  assert.equal(early.entries.fresh.start, time(0, 9, 55));
});

// planSchedule: overdue and removed problems

test('an overdue review is booked again today, first in line, and remembers the day it was due', () => {
  const overdue = problem('overdue', { due: day(-3) });
  const todays = problem('todays', { due: day(0), rating: 'easy', ratedAt: time(-9, 9) });
  const plan = planSchedule(null, [todays, overdue], SETTINGS, time(0, 8));
  assert.deepEqual(placements(plan), {
    overdue: `${dayKey(day(0))} 09:00+40`,
    todays: `${dayKey(day(0))} 09:40+20`,
  });
  assert.equal(plan.entries.overdue.day, dayKey(day(0)));
  assert.equal(plan.entries.overdue.dueDay, dayKey(day(-3)));
  assert.equal(plan.entries.overdue.overdueSince, dayKey(day(-3)));
  assert.equal(plan.entries.todays.overdueSince, undefined);
});

test('a missed block stays on the calendar as history and the review gets a new block, first in line', () => {
  const missed = problem('missed', { due: day(-1) });
  const todays = problem('todays', { due: day(0), rating: 'easy' });
  const prev = schedule([slot(missed, time(-1, 9), 40), slot(todays, time(0, 9), 20)]);
  const plan = planSchedule(prev, [missed, todays], SETTINGS, time(0, 8));
  assert.deepEqual(
    plan.entries.missed,
    slot(missed, time(0, 9, 20), 40, { day: dayKey(day(0)), overdueSince: dayKey(day(-1)) }),
  );
  assert.equal(plan.entries.todays.start, time(0, 9)); // keeps its time
  const ref = { id: 'ev', day: dayKey(day(-1)), start: time(-1, 9), end: time(-1, 9, 40), hash: slotHash(prev.entries.missed) };
  const ops = diffEvents(plan.entries, { missed: ref }, time(0, 8));
  assert.deepEqual(ops.forget, ['missed']);
  assert.deepEqual(ops.remove, []);
  assert.deepEqual(ops.create.map((s) => s.problemId), ['missed', 'todays']);

  // Missed again: still overdue since the first day it was missed.
  const later = planSchedule(plan, [missed, todays], SETTINGS, time(1, 8));
  assert.equal(later.entries.missed.day, dayKey(day(1)));
  assert.equal(later.entries.missed.overdueSince, dayKey(day(-1)));
});

test('a review planned in the previous version keeps its block and day', () => {
  const p = problem('p', { due: day(1) });
  const { dueDay, ...v03 } = slot(p, time(1, 9), 40);
  const prev = { layoutKey: layoutKey(SETTINGS), entries: { p: v03 } };
  assert.deepEqual(planSchedule(prev, [p], SETTINGS, time(0, 8)).entries.p, { ...v03, dueDay });
});

// planSchedule: daily limit

const limited = (minutes) => withSettings({ dailyLimit: minutes });

test('reviews that do not fit in the daily limit move to the next day with room', () => {
  const ratedAt = time(-5, 9);
  const a = problem('a', { due: day(1), rating: 'okay', ratedAt }); // 40
  const b = problem('b', { due: day(1), rating: 'easy', ratedAt: ratedAt + 1 }); // 20
  const c = problem('c', { due: day(1), rating: 'okay', ratedAt: ratedAt + 2 }); // 40
  const d = problem('d', { due: day(2), rating: 'easy', ratedAt }); // 20
  const plan = planSchedule(null, [a, b, c, d], limited(60), time(0, 8));
  assert.deepEqual(placements(plan), {
    a: `${dayKey(day(1))} 09:00+40`,
    b: `${dayKey(day(1))} 09:40+20`,
    c: `${dayKey(day(2))} 09:00+40`, // the review day itself moves
    d: `${dayKey(day(2))} 09:40+20`,
  });
  assert.equal(plan.entries.c.day, dayKey(day(2)));
  assert.equal(plan.entries.c.dueDay, dayKey(day(1)));
  assert.equal(plan.entries.c.overdueSince, undefined);
  // On its new day (a and b were reviewed) it's simply due, not overdue.
  const onTheDay = planSchedule(plan, [c, d], limited(60), time(2, 8));
  assert.equal(onTheDay.entries.c.day, dayKey(day(2)));
  assert.equal(onTheDay.entries.c.overdueSince, undefined);
});

test('a day always takes one review, even one longer than the limit', () => {
  const big = problem('big', { due: day(1), rating: 'hard' });
  const small = problem('small', { due: day(1), rating: 'easy' });
  const plan = planSchedule(null, [big, small], limited(30), time(0, 8));
  assert.deepEqual(placements(plan), { big: `${dayKey(day(1))} 09:00+60`, small: `${dayKey(day(2))} 09:00+20` });
});

test('a smaller review still fits where a larger one did not', () => {
  const ratedAt = time(-5, 9);
  const a = problem('a', { due: day(1), rating: 'okay', ratedAt }); // 40
  const b = problem('b', { due: day(1), rating: 'okay', ratedAt: ratedAt + 1 }); // 40: no room
  const c = problem('c', { due: day(1), rating: 'easy', ratedAt: ratedAt + 2 }); // 20: fits
  const plan = planSchedule(null, [a, b, c], limited(60), time(0, 8));
  assert.deepEqual(
    Object.fromEntries(Object.values(plan.entries).map((s) => [s.problemId, s.day])),
    { a: dayKey(day(1)), b: dayKey(day(2)), c: dayKey(day(1)) },
  );
});

test('overdue reviews fill a day first, oldest first, then that day\'s own in the usual order', () => {
  const ratedAt = time(-9, 9);
  const older = problem('older', { due: day(-4), rating: 'easy', ratedAt: ratedAt + 5 });
  const newer = problem('newer', { due: day(-1), rating: 'easy', ratedAt });
  const own1 = problem('own1', { due: day(0), rating: 'easy', ratedAt });
  const own2 = problem('own2', { due: day(0), rating: 'easy', ratedAt: ratedAt + 1 });
  const plan = planSchedule(null, [own2, own1, newer, older], limited(60), time(0, 8));
  assert.deepEqual(placements(plan), {
    older: `${dayKey(day(0))} 09:00+20`,
    newer: `${dayKey(day(0))} 09:20+20`,
    own1: `${dayKey(day(0))} 09:40+20`,
    own2: `${dayKey(day(1))} 09:00+20`,
  });
});

test("today's started blocks count toward its limit, so a missed review goes to the next day with room", () => {
  const ratedAt = time(-9, 9);
  const a = problem('a', { due: day(0), rating: 'okay', ratedAt });
  const b = problem('b', { due: day(0), rating: 'easy', ratedAt: ratedAt + 1 });
  const missed = problem('missed', { due: day(-1), rating: 'easy' });
  const prev = schedule([slot(a, time(0, 9), 40), slot(b, time(0, 9, 40), 20), slot(missed, time(-1, 9), 20)], limited(60));
  // Chrome was closed until 11:00: today's blocks are over but they're still today's reviews.
  const plan = planSchedule(prev, [a, b, missed], limited(60), time(0, 11));
  assert.equal(plan.entries.a.start, time(0, 9));
  assert.equal(plan.entries.b.start, time(0, 9, 40));
  assert.equal(plan.entries.missed.day, dayKey(day(1)));
  assert.equal(plan.entries.missed.start, time(1, 9));
  assert.equal(plan.entries.missed.overdueSince, dayKey(day(-1)));
});

test('a new limit is a new layout: moved reviews come back when there is room', () => {
  const ratedAt = time(-5, 9);
  const a = problem('a', { due: day(1), rating: 'okay', ratedAt });
  const b = problem('b', { due: day(1), rating: 'okay', ratedAt: ratedAt + 1 });
  const tight = planSchedule(null, [a, b], limited(60), time(0, 8));
  assert.equal(tight.entries.b.day, dayKey(day(2)));
  const roomy = planSchedule(tight, [a, b], limited(90), time(0, 9));
  assert.deepEqual(placements(roomy), { a: `${dayKey(day(1))} 09:00+40`, b: `${dayKey(day(1))} 09:40+40` });
});

test('mastered problems get no review day or block', () => {
  const p = problem('p', { due: day(1) });
  const mastered = markMastered(problem('m', { due: day(1) }), time(0, 7));
  const prev = planSchedule(null, [p, problem('m', { due: day(1) })], SETTINGS, time(0, 7));
  const plan = planSchedule(prev, [p, mastered], SETTINGS, time(0, 8));
  assert.deepEqual(Object.keys(plan.entries), ['p']);
  // Its upcoming block is deleted from the calendar.
  const ref = { id: 'ev-m', day: prev.entries.m.day, start: prev.entries.m.start, end: prev.entries.m.end, hash: slotHash(prev.entries.m) };
  assert.deepEqual(diffEvents(plan.entries, { m: ref }, time(0, 8)).remove, [{ problemId: 'm', ref }]);
});

test('bookedProblems lists reviews a connected calendar holds on their planned day', () => {
  const plan = { entries: { a: { day: '2026-11-04' }, b: { day: '2026-11-05' } } };
  assert.equal(bookedProblems(plan, {}), null);
  assert.equal(bookedProblems(plan, { google: { connected: false, events: { a: { day: '2026-11-04' } } } }), null);
  const booked = bookedProblems(plan, {
    google: { connected: true, events: { a: { day: '2026-11-04' }, b: { day: '2026-11-04' } } },
    apple: { connected: true, events: {} },
  });
  assert.deepEqual([...booked], ['a']);
});

test('a block that ran past midnight and has not started is re-placed after a layout change, not dropped', () => {
  const ratedAt = time(-4, 9);
  const p = problem('p', { due: day(-1), rating: 'hard', ratedAt });
  const q = problem('q', { due: day(-1), rating: 'hard', ratedAt: ratedAt + 1 });
  const r = problem('r', { due: day(-1), rating: 'hard', ratedAt: ratedAt + 2 });
  const prev = schedule([slot(p, time(-1, 23), 60), slot(q, time(0, 0), 60), slot(r, time(0, 1), 60)]);
  const settings = withSettings({ durations: { hard: 50 } });

  const plan = planSchedule(prev, [p, q, r], settings, time(0, 0, 30));
  assert.deepEqual(placements(plan), {
    p: `${dayKey(day(0))} 09:00+50`, // over at midnight without a review: missed, booked again today
    q: `${dayKey(day(0))} 00:00+60`, // started: frozen
    r: `${dayKey(day(0))} 01:00+50`, // not started: re-placed (after q), new length
  });
  assert.equal(plan.entries.p.overdueSince, dayKey(day(-1)));
  assert.equal(plan.entries.q.day, dayKey(day(-1)));
  assert.equal(plan.entries.r.day, dayKey(day(-1)));
  assert.equal(plan.entries.r.overdueSince, undefined);
  // So the calendar moves the event instead of deleting it.
  const old = prev.entries.r;
  const ref = { id: 'ev-r', day: old.day, start: old.start, end: old.end, hash: slotHash(old) };
  assert.deepEqual(diffEvents(plan.entries, { r: ref }, time(0, 0, 30)).update, [{ slot: plan.entries.r, ref }]);
  // Without a layout change, q and r don't move.
  const same = planSchedule(prev, [p, q, r], SETTINGS, time(0, 0, 30));
  assert.deepEqual(same.entries.q, prev.entries.q);
  assert.deepEqual(same.entries.r, prev.entries.r);
});

test("a started block that no connected calendar holds is placed again from now", () => {
  // Planned this morning while no calendar was connected; one is connected at 15:00.
  const p = problem('hard-one', { due: day(0), rating: 'hard' });
  const q = problem('later-one', { due: day(0), rating: 'easy', ratedAt: p.history[0].at + 1 });
  const morning = planSchedule(null, [p, q], SETTINGS, time(0, 7));
  assert.equal(morning.entries['hard-one'].start, time(0, 9));

  const plan = planSchedule(morning, [p, q], SETTINGS, time(0, 15, 2), { booked: new Set() });
  assert.deepEqual(placements(plan), {
    'hard-one': `${dayKey(day(0))} 15:05+60`,
    'later-one': `${dayKey(day(0))} 16:05+20`,
  });
  // diffEvents then books it; without the re-placement nothing would be created.
  assert.deepEqual(diffEvents(plan.entries, {}, time(0, 15, 2)).create.map((s) => s.problemId), ['hard-one', 'later-one']);
});

test('a started block stays frozen when a calendar holds it, or when none is connected', () => {
  const p = problem('a', { due: day(0), rating: 'okay' });
  const prev = schedule([slot(p, time(0, 9), 40)]);
  // Google has it; Apple, connected later, must not move it.
  assert.deepEqual(planSchedule(prev, [p], SETTINGS, time(0, 15), { booked: new Set(['a']) }), prev);
  // No calendar at all: the advisory time doesn't creep forward on every sync.
  for (const now of [time(0, 9, 30), time(0, 15), time(0, 22)]) {
    assert.deepEqual(planSchedule(prev, [p], SETTINGS, now), prev);
    assert.deepEqual(planSchedule(prev, [p], SETTINGS, now, { booked: null }), prev);
  }
  // A missed review from yesterday is booked again either way.
  const overdue = problem('old', { due: day(-1) });
  const old = schedule([slot(overdue, time(-1, 9), 40)]);
  for (const booked of [new Set(), new Set(['old']), null]) {
    assert.equal(planSchedule(old, [overdue], SETTINGS, time(0, 8), { booked }).entries.old.start, time(0, 9));
  }
});

test('a review keeps its day (and its block) when the time zone changes', () => {
  const rated = Date.UTC(2026, 10, 9, 18); // Mon 9 Nov, 12:00 in Chicago
  const p = withTimeZone('America/Chicago', () =>
    createProblem({ id: 'two-sum', title: 'Two Sum', url: 'https://leetcode.com/problems/two-sum/', rating: 'okay', solvedAt: rated }),
  );
  assert.equal(p.dueDay, '2026-11-12');
  const plan = withTimeZone('America/Chicago', () => planSchedule(null, [p], SETTINGS, rated + HOUR));
  const block = plan.entries['two-sum'];
  assert.equal(block.day, '2026-11-12');
  assert.equal(block.start, Date.UTC(2026, 10, 12, 15)); // Thu 09:00 CST
  const ref = { id: 'ev', day: block.day, start: block.start, end: block.end, hash: slotHash(block) };

  const checks = [
    ['America/Denver', Date.UTC(2026, 10, 9, 20)], // same day, an hour further west
    ['America/Denver', Date.UTC(2026, 10, 12, 13)], // review day, 06:00 MST, block not started yet
    ['America/Los_Angeles', Date.UTC(2026, 10, 12, 15, 30)], // block in progress
    ['America/Chicago', Date.UTC(2026, 10, 12, 16)], // back home
    ['Asia/Tokyo', Date.UTC(2026, 10, 12, 13)], // far east
  ];
  for (const [tz, now] of checks) {
    withTimeZone(tz, () => {
      const next = planSchedule(plan, [p], SETTINGS, now, { booked: new Set(['two-sum']) });
      assert.deepEqual(next, plan, `${tz} @ ${new Date(now).toISOString()}`);
      assert.deepEqual(diffEvents(next.entries, { 'two-sum': ref }, now), { create: [], update: [], remove: [], forget: [] });
    });
  }
});

test('removed problems lose their blocks and their time is free again', () => {
  const gonePast = problem('gone-past', { due: day(0) });
  const goneFuture = problem('gone-future', { due: day(1) });
  const prev = schedule([slot(gonePast, time(0, 9), 40), slot(goneFuture, time(1, 9), 40)]);
  const fresh = problem('fresh', { due: day(1), rating: 'easy' });

  const plan = planSchedule(prev, [fresh], SETTINGS, time(0, 9, 30));
  assert.deepEqual(Object.keys(plan.entries), ['fresh']);
  assert.equal(plan.entries.fresh.start, time(1, 9));
});

test('a very full day overflows past midnight instead of wrapping, and never overlaps the next day', () => {
  const ratedAt = time(-1, 9);
  const ids = Array.from({ length: 30 }, (_, i) => `p${pad(i)}`);
  const full = ids.map((id) => problem(id, { due: day(1), rating: 'hard', ratedAt }));
  const nextDay = problem('next-day', { due: day(2), rating: 'easy', ratedAt });

  const plan = planSchedule(null, [...full, nextDay], withSettings({ dailyLimit: 30 * 60 }), time(0, 8));
  assert.equal(plan.entries.p14.start, time(1, 23)); // 09:00 + 14 h
  assert.equal(plan.entries.p15.start, time(2, 0)); // runs on past midnight
  assert.equal(plan.entries.p29.end, time(2, 15));
  for (const id of ids) assert.equal(plan.entries[id].day, dayKey(day(1)));
  // Day 2's 09:00 is still taken by the overflow, so its review goes after it.
  assert.equal(plan.entries['next-day'].start, time(2, 15));

  // No two blocks overlap.
  const sorted = Object.values(plan.entries).sort((x, y) => x.start - y.start);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].start >= sorted[i - 1].end);
});

// planSchedule: purity

test('planSchedule is deterministic and does not mutate its inputs', () => {
  const ratedAt = time(-1, 9);
  const problems = [
    problem('a', { due: day(0), rating: 'easy', ratedAt }),
    problem('b', { due: day(1), rating: 'hard', ratedAt }),
    problem('c', { due: day(1), rating: 'okay', ratedAt }),
    problem('d', { due: day(-1), rating: 'okay', ratedAt }),
  ];
  const prev = schedule([slot(problems[1], time(1, 10), 60), slot(problems[3], time(-1, 9), 40)]);
  const snapshot = structuredClone({ prev, problems, settings: SETTINGS });
  deepFreeze(prev);
  deepFreeze(problems);

  const now = time(0, 11, 11);
  const first = planSchedule(prev, problems, SETTINGS, now); // frozen inputs would throw on a write
  const second = planSchedule(prev, problems, SETTINGS, now);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual({ prev, problems, settings: SETTINGS }, snapshot);
  assert.notEqual(first.entries.b, prev.entries.b); // a new object, not the stored one
  assert.notEqual(first.entries, prev.entries);
});

test('accepts a missing or empty previous schedule', () => {
  const p = problem('a', { due: day(1) });
  const expected = planSchedule(null, [p], SETTINGS, time(0, 8));
  assert.deepEqual(planSchedule(undefined, [p], SETTINGS, time(0, 8)), expected);
  assert.deepEqual(planSchedule({ layoutKey: null, entries: {} }, [p], SETTINGS, time(0, 8)), expected);
  assert.deepEqual(planSchedule({}, [p], SETTINGS, time(0, 8)), expected);
  assert.deepEqual(planSchedule(null, [], SETTINGS, time(0, 8)), { layoutKey: layoutKey(SETTINGS), entries: {} });
});

test('accepts a stored problem map and skips problems without a due date', () => {
  const a = problem('a', { due: day(1) });
  const broken = { ...problem('broken', { due: day(1) }), dueAt: undefined };
  const fromArray = planSchedule(null, [a], SETTINGS, time(0, 8));
  assert.deepEqual(planSchedule(null, { a, broken }, SETTINGS, time(0, 8)), fromArray);
  assert.deepEqual(planSchedule(null, [a, broken, null], SETTINGS, time(0, 8)), fromArray);
});

test('missing or invalid settings fall back to the defaults', () => {
  const p = problem('a', { due: day(1), rating: 'hard' });
  const expected = planSchedule(null, [p], withSettings({ dailyLimit: 60 }), time(0, 8));
  assert.deepEqual(planSchedule(null, [p], {}, time(0, 8)), expected);
  assert.deepEqual(
    planSchedule(null, [p], { startTime: '25:99', durations: { hard: -5 }, reminderMinutes: 'soon' }, time(0, 8)),
    expected,
  );
});

test('works with problems from srs.js (createProblem / recordReview)', () => {
  const solvedAt = time(-2, 21, 15);
  const p = createProblem({ id: 'two-sum', title: 'Two Sum', url: 'https://leetcode.com/problems/two-sum/', rating: 'okay', solvedAt });
  const plan = planSchedule(null, [p], SETTINGS, time(0, 8));
  assert.equal(plan.entries['two-sum'].start, time(1, 9)); // 3 days after the solve day
  const reviewed = recordReview(p, 'easy', { at: time(1, 9, 20) });
  const next = planSchedule(plan, [reviewed], SETTINGS, time(1, 9, 25));
  assert.equal(next.entries['two-sum'].start, time(9, 9)); // 3-day interval × 2.5 for Easy, rounded
  assert.equal(next.entries['two-sum'].end - next.entries['two-sum'].start, 20 * MIN);
});

// planSchedule: time zones and DST

test('places blocks at the local start time across the US DST change (America/Denver)', () => {
  withTimeZone('America/Denver', () => {
    const now = at(2026, 10, 27, 12);
    // Solved at noon local; Okay is due 3 days later, Hard 1 day later.
    const solve = (id, d, rating = 'okay') =>
      createProblem({ id, title: id, url: `https://leetcode.com/problems/${id}/`, rating, solvedAt: at(2026, 10, d, 12) });
    const problems = [solve('oct-31', 28), solve('nov-01-a', 29), solve('nov-01-b', 31, 'hard'), solve('nov-02', 30)];
    const plan = planSchedule(null, problems, SETTINGS, now);
    const e = plan.entries;

    assert.equal(e['oct-31'].day, '2026-10-31');
    assert.equal(e['oct-31'].start, Date.UTC(2026, 9, 31, 15, 0)); // 09:00 MDT
    assert.equal(e['nov-01-a'].day, '2026-11-01');
    assert.equal(e['nov-01-a'].start, Date.UTC(2026, 10, 1, 16, 0)); // 09:00 MST
    assert.equal(e['nov-01-a'].end, Date.UTC(2026, 10, 1, 16, 40));
    assert.equal(e['nov-01-b'].start, Date.UTC(2026, 10, 1, 16, 40)); // back-to-back
    assert.equal(e['nov-01-b'].end, Date.UTC(2026, 10, 1, 17, 40));
    assert.equal(e['nov-02'].start, Date.UTC(2026, 10, 2, 16, 0));

    // A start time inside the repeated hour still lands on that day, with real minutes.
    const repeated = planSchedule(null, problems, withSettings({ startTime: '01:30' }), now).entries['nov-01-a'];
    assert.equal(dayKey(repeated.start), '2026-11-01');
    assert.equal(clock(repeated.start), '01:30');
    assert.equal(repeated.end - repeated.start, 40 * MIN);

    // A start time skipped by spring-forward (2026-03-08 02:30) still gives a valid block that day.
    const spring = createProblem({ id: 'spring', title: 'Spring', url: 'u', rating: 'okay', solvedAt: at(2026, 3, 5, 12) });
    const skipped = planSchedule(null, [spring], withSettings({ startTime: '02:30' }), at(2026, 3, 1)).entries.spring;
    assert.equal(skipped.day, '2026-03-08');
    assert.equal(dayKey(skipped.start), '2026-03-08');
    assert.ok(Number.isFinite(skipped.start));
    assert.equal(skipped.end - skipped.start, 40 * MIN);
  });
});

test('places blocks at the local start time across the EU DST change (Europe/London, Europe/Berlin)', () => {
  withTimeZone('Europe/London', () => {
    const problems = [
      problem('oct-24', { due: at(2026, 10, 24) }),
      problem('oct-25', { due: at(2026, 10, 25) }),
      problem('oct-26', { due: at(2026, 10, 26) }),
    ];
    const e = planSchedule(null, problems, SETTINGS, at(2026, 10, 20)).entries;
    assert.equal(e['oct-24'].start, Date.UTC(2026, 9, 24, 8, 0)); // 09:00 BST
    assert.equal(e['oct-25'].start, Date.UTC(2026, 9, 25, 9, 0)); // 09:00 GMT
    assert.equal(e['oct-26'].start, Date.UTC(2026, 9, 26, 9, 0));
    assert.equal(e['oct-25'].day, '2026-10-25');
  });
  withTimeZone('Europe/Berlin', () => {
    const e = planSchedule(null, [problem('oct-25', { due: at(2026, 10, 25) })], SETTINGS, at(2026, 10, 20)).entries;
    assert.equal(e['oct-25'].start, Date.UTC(2026, 9, 25, 8, 0)); // 09:00 CET
  });
});

test("today's cursor during the repeated hour rounds up from the real now", () => {
  const midnight = withSettings({ startTime: '00:00' });
  withTimeZone('America/Denver', () => {
    const p = problem('dst', { due: at(2026, 11, 1) });
    const now = Date.UTC(2026, 10, 1, 8, 32); // 01:32 MST, the second 01:32 that night
    assert.equal(planSchedule(null, [p], midnight, now).entries.dst.start, Date.UTC(2026, 10, 1, 8, 35));
  });
  withTimeZone('Europe/London', () => {
    const p = problem('dst', { due: at(2026, 10, 25) });
    const now = Date.UTC(2026, 9, 25, 1, 2); // 01:02 GMT, the second 01:02 that night
    assert.equal(planSchedule(null, [p], midnight, now).entries.dst.start, Date.UTC(2026, 9, 25, 1, 5));
  });
});

test('rounds to 5 minutes of local clock time in half- and quarter-hour zones', () => {
  for (const tz of ['Asia/Kolkata', 'Asia/Kathmandu']) {
    withTimeZone(tz, () => {
      const p = problem('a', { due: day(0) });
      const s = planSchedule(null, [p], SETTINGS, time(0, 10, 2)).entries.a;
      assert.equal(s.start, time(0, 10, 5), tz);
      assert.equal(new Date(s.start).getMinutes() % 5, 0, tz);
    });
  }
});

test('the same local scenario plans identically in every zone', () => {
  const results = ZONES.map((tz) =>
    withTimeZone(tz, () => {
      const ratedAt = time(-1, 9);
      const kept = problem('kept', { due: day(1), ratedAt });
      const prev = schedule([slot(kept, time(1, 9, 40), 40)]);
      const problems = [
        kept,
        problem('today', { due: day(0), rating: 'easy', ratedAt }),
        problem('fits', { due: day(1), rating: 'okay', ratedAt: ratedAt + 1 }),
        problem('after', { due: day(1), rating: 'hard', ratedAt: ratedAt + 2 }),
      ];
      return placements(planSchedule(prev, problems, SETTINGS, time(0, 13, 21)));
    }),
  );
  for (const r of results) assert.deepEqual(r, results[0]);
  assert.deepEqual(results[0], {
    today: '2026-11-04 13:25+20',
    fits: '2026-11-05 09:00+40',
    kept: '2026-11-05 09:40+40',
    after: '2026-11-05 10:20+60',
  });
});

// diffEvents

const NOW = () => time(0, 12);

function makeSlot(id, startOffsetMin, minutes = 40, extra = {}) {
  const p = problem(id, { due: startOfDay(NOW() + startOffsetMin * MIN) });
  return { ...slot(p, NOW() + startOffsetMin * MIN, minutes), ...extra };
}

// What calendar-sync stores after writing `s`.
const refFor = (s, extra = {}) => ({ id: `ev-${s.problemId}`, day: s.day, start: s.start, end: s.end, hash: slotHash(s), ...extra });

const EMPTY = { create: [], update: [], remove: [], forget: [] };

test('diffEvents leaves events alone when their content is unchanged', () => {
  const upcoming = makeSlot('upcoming', 60);
  const started = makeSlot('started', -10);
  const entries = { upcoming, started };
  const events = { upcoming: refFor(upcoming), started: refFor(started) };
  assert.deepEqual(diffEvents(entries, events, NOW()), EMPTY);
});

test('diffEvents updates an upcoming event whose slot changed', () => {
  const before = makeSlot('a', 60);
  const after = { ...before, start: before.start + HOUR, end: before.end + HOUR };
  const ref = refFor(before, { etag: '"1"', uid: 'u-a' });
  const result = diffEvents({ a: after }, { a: ref }, NOW());
  assert.deepEqual(result, { ...EMPTY, update: [{ slot: after, ref }] });
  assert.equal(result.update[0].slot, after);
  assert.equal(result.update[0].ref, ref);
});

test('diffEvents updates an upcoming event when only its reminder or text changed', () => {
  const before = makeSlot('a', 60);
  for (const after of [{ ...before, reminderMinutes: 30 }, { ...before, title: 'Review: Renamed' }]) {
    assert.deepEqual(diffEvents({ a: after }, { a: refFor(before) }, NOW()).update, [{ slot: after, ref: refFor(before) }]);
  }
});

test('diffEvents removes an upcoming event whose problem is gone', () => {
  const ref = refFor(makeSlot('gone', 60));
  assert.deepEqual(diffEvents({}, { gone: ref }, NOW()), { ...EMPTY, remove: [{ problemId: 'gone', ref }] });
});

test('diffEvents never touches a started event on the same day', () => {
  const before = makeSlot('a', -10);
  const changed = { ...before, title: 'Review: Changed', reminderMinutes: 5, end: before.end + HOUR };
  assert.deepEqual(diffEvents({ a: changed }, { a: refFor(before) }, NOW()), EMPTY);
});

test('diffEvents moves a started event that missed a move on the same day', () => {
  // This calendar was failing while the block moved from 09:00 to a later time.
  const stale = refFor(makeSlot('a', -180));
  for (const moved of [makeSlot('a', 60), makeSlot('a', -10)]) {
    assert.equal(moved.day, stale.day);
    assert.deepEqual(diffEvents({ a: moved }, { a: stale }, NOW()), { ...EMPTY, update: [{ slot: moved, ref: stale }] });
  }
  // Once the planned block is over too, the old event is just history.
  const over = makeSlot('a', -100, 40);
  assert.deepEqual(diffEvents({ a: over }, { a: stale }, NOW()), EMPTY);
});

test('diffEvents forgets a started event whose review moved to another day, and creates the next one', () => {
  const old = makeSlot('a', -10);
  const next = makeSlot('a', 3 * DAY / MIN);
  assert.notEqual(next.day, old.day);
  assert.deepEqual(diffEvents({ a: next }, { a: refFor(old) }, NOW()), { ...EMPTY, forget: ['a'], create: [next] });
});

test('diffEvents forgets a started event without creating a block that is already over', () => {
  const old = makeSlot('a', -3 * DAY / MIN);
  const over = makeSlot('a', -60, 40); // ended 20 minutes ago, on another day than `old`
  const endsNow = makeSlot('a', -40, 40);
  for (const s of [over, endsNow]) {
    assert.deepEqual(diffEvents({ a: s }, { a: refFor(old) }, NOW()), { ...EMPTY, forget: ['a'] });
  }
});

test('diffEvents forgets (never deletes) a started event whose problem is gone', () => {
  assert.deepEqual(diffEvents({}, { gone: refFor(makeSlot('gone', -10)) }, NOW()), { ...EMPTY, forget: ['gone'] });
  assert.deepEqual(diffEvents({}, { gone: refFor(makeSlot('gone', -2 * DAY / MIN)) }, NOW()), { ...EMPTY, forget: ['gone'] });
});

test('diffEvents treats an event starting exactly now as started', () => {
  const s = makeSlot('a', 0);
  const changed = { ...s, title: 'Review: Changed' };
  assert.deepEqual(diffEvents({ a: changed }, { a: refFor(s) }, NOW()), EMPTY);
  assert.deepEqual(diffEvents({}, { a: refFor(s) }, NOW()), { ...EMPTY, forget: ['a'] });
});

test('diffEvents creates missing events unless they are already over', () => {
  const future = makeSlot('future', 60);
  const inProgress = makeSlot('in-progress', -10, 40);
  const endsNow = makeSlot('ends-now', -40, 40);
  const over = makeSlot('over', -2 * DAY / MIN);
  const result = diffEvents({ future, 'in-progress': inProgress, 'ends-now': endsNow, over }, {}, NOW());
  assert.deepEqual(result, { ...EMPTY, create: [future, inProgress] });
});

test('diffEvents handles empty and missing inputs', () => {
  assert.deepEqual(diffEvents({}, {}, NOW()), EMPTY);
  assert.deepEqual(diffEvents(undefined, undefined, NOW()), EMPTY);
  const s = makeSlot('a', 60);
  assert.deepEqual(diffEvents({ a: s }, null, NOW()), { ...EMPTY, create: [s] });
  assert.deepEqual(diffEvents(null, { a: refFor(s) }, NOW()), { ...EMPTY, remove: [{ problemId: 'a', ref: refFor(s) }] });
});

test('diffEvents returns each operation once across a mixed set, without mutating inputs', () => {
  const same = makeSlot('same', 60);
  const moved = makeSlot('moved', 120);
  const movedNow = { ...moved, start: moved.start + HOUR, end: moved.end + HOUR };
  const gone = makeSlot('gone', 90);
  const history = makeSlot('history', -30);
  const historyNext = makeSlot('history', 2 * DAY / MIN);
  const frozen = makeSlot('frozen', -5);
  const fresh = makeSlot('fresh', 4 * DAY / MIN);

  const entries = deepFreeze({ same, moved: movedNow, history: historyNext, frozen: { ...frozen, title: 'Review: X' }, fresh });
  const events = deepFreeze({
    same: refFor(same),
    moved: refFor(moved),
    gone: refFor(gone),
    history: refFor(history),
    frozen: refFor(frozen),
  });
  const snapshot = structuredClone({ entries, events });
  const result = diffEvents(entries, events, NOW());
  assert.deepEqual(result, {
    create: [historyNext, fresh],
    update: [{ slot: movedNow, ref: events.moved }],
    remove: [{ problemId: 'gone', ref: events.gone }],
    forget: ['history'],
  });
  assert.deepEqual({ entries, events }, snapshot);
  assert.deepEqual(diffEvents(entries, events, NOW()), result);
});

// planSchedule + diffEvents together, the way calendar-sync uses them.

function fakeCalendar() {
  const onCalendar = new Map(); // event id → slot as written (the "server")
  const stored = {}; // problemId → EventRef (what calendar-sync keeps)
  let next = 1;
  return {
    onCalendar,
    stored,
    apply({ create, update, remove, forget }) {
      for (const pid of forget) delete stored[pid];
      for (const { problemId, ref } of remove) {
        onCalendar.delete(ref.id);
        delete stored[problemId];
      }
      for (const { slot: s, ref } of update) {
        onCalendar.set(ref.id, s);
        stored[s.problemId] = { id: ref.id, day: s.day, start: s.start, end: s.end, hash: slotHash(s) };
      }
      for (const s of create) {
        const id = `ev-${next++}`;
        onCalendar.set(id, s);
        stored[s.problemId] = { id, day: s.day, start: s.start, end: s.end, hash: slotHash(s) };
      }
    },
  };
}

test('sync lifecycle: connect, re-rate, review, delete', () => {
  const cal = fakeCalendar();
  let problems = {
    a: problem('a', { due: day(1), rating: 'okay', ratedAt: time(-2, 9) }),
    b: problem('b', { due: day(3), rating: 'easy', ratedAt: time(-2, 10) }),
  };
  let settings = SETTINGS;
  let plan = null;
  const sync = (now) => {
    plan = planSchedule(plan, Object.values(problems), settings, now);
    const ops = diffEvents(plan.entries, cal.stored, now);
    cal.apply(ops);
    // A second pass right away has nothing left to do.
    assert.deepEqual(diffEvents(planSchedule(plan, Object.values(problems), settings, now).entries, cal.stored, now), EMPTY);
    return ops;
  };
  const counts = (ops) => Object.fromEntries(Object.entries(ops).map(([k, v]) => [k, v.length]));

  // Connect: every upcoming review gets an event.
  assert.deepEqual(counts(sync(time(0, 8))), { create: 2, update: 0, remove: 0, forget: 0 });
  assert.equal(cal.onCalendar.size, 2);

  // Re-rating b (not started yet) moves its event in place.
  problems = { ...problems, b: { ...problems.b, rating: 'hard', dueAt: day(2) } };
  const reRated = sync(time(0, 9));
  assert.deepEqual(counts(reRated), { create: 0, update: 1, remove: 0, forget: 0 });
  assert.equal(cal.onCalendar.get(cal.stored.b.id).start, time(2, 9));

  // Reviewing a during its block: the started event stays as history, the next one is created.
  const aFirstEvent = cal.stored.a.id;
  problems = { ...problems, a: recordReview(problems.a, 'hard', { at: time(1, 9, 20) }) };
  const reviewed = sync(time(1, 9, 25));
  assert.deepEqual(counts(reviewed), { create: 1, update: 0, remove: 0, forget: 1 });
  assert.ok(cal.onCalendar.has(aFirstEvent));
  assert.notEqual(cal.stored.a.id, aFirstEvent);
  assert.equal(cal.stored.a.start, time(2, 10)); // after b's hard block on day 2

  // Deleting b removes its upcoming event; a keeps its time instead of moving up.
  const bEvent = cal.stored.b.id;
  problems = { a: problems.a };
  assert.deepEqual(counts(sync(time(1, 10))), { create: 0, update: 0, remove: 1, forget: 0 });
  assert.equal(cal.onCalendar.has(bEvent), false);
  assert.equal(cal.stored.a.start, time(2, 10));
  assert.equal(cal.onCalendar.size, 2); // a's history block + a's next block
});

test('sync lifecycle: settings change and a missed review', () => {
  const cal = fakeCalendar();
  const counts = (ops) => Object.fromEntries(Object.entries(ops).map(([k, v]) => [k, v.length]));
  const problems = [problem('a', { due: day(1), rating: 'okay' }), problem('b', { due: day(2), rating: 'easy' })];
  let plan = planSchedule(null, problems, SETTINGS, time(0, 8));
  cal.apply(diffEvents(plan.entries, cal.stored, time(0, 8)));

  // New reminder: same times, events updated in place.
  let settings = withSettings({ reminderMinutes: 5 });
  plan = planSchedule(plan, problems, settings, time(0, 9));
  let ops = diffEvents(plan.entries, cal.stored, time(0, 9));
  assert.equal(ops.update.length, 2);
  assert.deepEqual(ops.update.map((u) => u.slot.start), [time(1, 9), time(2, 9)]);
  cal.apply(ops);

  // New start time: both move.
  settings = withSettings({ reminderMinutes: 5, startTime: '07:00' });
  plan = planSchedule(plan, problems, settings, time(0, 10));
  ops = diffEvents(plan.entries, cal.stored, time(0, 10));
  assert.deepEqual(ops.update.map((u) => u.slot.start), [time(1, 7), time(2, 7)]);
  cal.apply(ops);

  // Neither is reviewed: two days later their old blocks stay in the past as
  // history, and new blocks are booked, the longest missed first.
  const aEvent = cal.stored.a.id;
  plan = planSchedule(plan, problems, settings, time(3, 6));
  assert.equal(plan.entries.a.start, time(3, 7));
  assert.equal(plan.entries.a.overdueSince, dayKey(day(1)));
  assert.equal(plan.entries.b.start, time(3, 7, 40));
  ops = diffEvents(plan.entries, cal.stored, time(3, 6));
  assert.deepEqual(counts(ops), { create: 2, update: 0, remove: 0, forget: 2 });
  cal.apply(ops);
  assert.equal(cal.onCalendar.get(aEvent).start, time(1, 7));

  // Changing settings now moves the new block, never the old one.
  plan = planSchedule(plan, problems, withSettings({ startTime: '13:00' }), time(3, 6, 30));
  assert.equal(plan.entries.a.start, time(3, 13));
  ops = diffEvents(plan.entries, cal.stored, time(3, 6, 30));
  assert.deepEqual(counts(ops), { create: 0, update: 2, remove: 0, forget: 0 });
  cal.apply(ops);
  assert.equal(cal.onCalendar.get(aEvent).start, time(1, 7));
});
