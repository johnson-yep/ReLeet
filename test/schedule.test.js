import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, layoutKey, slotHash, planSchedule, diffEvents } from '../lib/schedule.js';
import { createProblem, recordReview, startOfDay } from '../lib/srs.js';

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
  durations: Object.freeze({ easy: 20, medium: 40, hard: 60 }),
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
function problem(id, { due, rating = 'medium', ratedAt = due - 3 * DAY, title = titleCase(id), url } = {}) {
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
function slot(p, start, minutes, { reminderMinutes = 15, day: slotDay = dayKey(p.dueAt) } = {}) {
  return {
    problemId: p.id,
    day: slotDay,
    start,
    end: start + minutes * MIN,
    title: `Review: ${p.title}`,
    description: `Review ${p.title} (last rated ${label(p.rating)}).\n${p.url}\n\nScheduled by ReLeet.`,
    url: p.url,
    rating: p.rating,
    reminderMinutes,
  };
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

test('layoutKey changes with the start time and each duration, and nothing else', () => {
  const base = layoutKey(SETTINGS);
  assert.equal(layoutKey({ ...SETTINGS }), base);
  assert.equal(layoutKey(withSettings({ reminderMinutes: 5 })), base);
  assert.equal(layoutKey(withSettings({ leetcodeUsername: 'other', leetcodeUsernameSource: 'auto' })), base);
  assert.notEqual(layoutKey(withSettings({ startTime: '09:30' })), base);
  assert.notEqual(layoutKey(withSettings({ durations: { easy: 25 } })), base);
  assert.notEqual(layoutKey(withSettings({ durations: { medium: 45 } })), base);
  assert.notEqual(layoutKey(withSettings({ durations: { hard: 90 } })), base);
  // Same layout written differently is the same layout.
  assert.equal(layoutKey(withSettings({ startTime: '9:00' })), base);
  assert.equal(layoutKey(withSettings({ durations: { easy: '20', medium: '40', hard: '60' } })), base);
  // Missing settings fall back to the defaults.
  assert.equal(layoutKey({}), base);
  assert.equal(layoutKey(undefined), base);
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
  assert.equal(plan.entries['two-sum'].description, `Review Two Sum (last rated Medium).\nhttps://leetcode.com/problems/two-sum/\n\nScheduled by ReLeet.`);
});

test('stacks several reviews on one day back-to-back, each day from its start time', () => {
  const ratedAt = time(-2, 12);
  const problems = [
    problem('charlie', { due: day(1), rating: 'medium', ratedAt }),
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
  alpha.history = [{ at: t0, rating: 'medium', commitSha: null }, { at: t2, rating: 'medium', commitSha: null }];
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
    problem('c', { due: day(1), rating: 'medium', ratedAt: time(-2, 9) }),
    problem('d', { due: day(2), rating: 'medium', ratedAt: time(-1, 9) }),
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
  const a = problem('kept-a', { due, rating: 'medium', ratedAt: time(-3, 9) });
  const b = problem('kept-b', { due, rating: 'easy', ratedAt: time(-3, 9) });
  // Free on day 1: 09:00–09:40 (40 min), 10:20–10:40 (20 min), from 11:00.
  const prev = schedule([slot(a, time(1, 9, 40), 40), slot(b, time(1, 10, 40), 20)]);
  const x = problem('new-x', { due, rating: 'hard', ratedAt: time(-2, 9) });
  const y = problem('new-y', { due, rating: 'medium', ratedAt: time(-2, 10) });
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
  const p = problem('lru-cache', { due: day(0), rating: 'medium' });
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
  const settings = withSettings({ startTime: '08:00', durations: { medium: 30 } });

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
    problem('b', { due: day(1), rating: 'medium', ratedAt }),
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
    problem('c', { due: day(1), rating: 'medium' }),
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
  const q = problem('q', { due: day(5), rating: 'medium', ratedAt: time(-1, 9) });
  const prev = schedule([slot(p, time(5, 9), 20), slot(q, time(5, 9, 20), 40)]);
  // Solved again and rated Medium, landing on the same review day.
  const reRated = { ...p, rating: 'medium', history: [...p.history, { at: time(2, 9), rating: 'medium', commitSha: null }] };
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
  const p = problem('late', { due: day(0), rating: 'medium' });
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

test('overdue problems without a block get none', () => {
  const overdue = problem('overdue', { due: day(-1) });
  assert.deepEqual(planSchedule(null, [overdue], SETTINGS, time(0, 8)).entries, {});
  // A block on some other day doesn't count either.
  const prev = schedule([slot(overdue, time(-3, 9), 40, { day: dayKey(day(-3)) })]);
  assert.deepEqual(planSchedule(prev, [overdue], SETTINGS, time(0, 8)).entries, {});
});

test('an overdue problem keeps its started block, even after layout changes', () => {
  const overdue = problem('overdue', { due: day(-1), rating: 'medium' });
  const prev = schedule([slot(overdue, time(-1, 9), 40)]);
  const reRated = { ...overdue, rating: 'hard' };
  const plan = planSchedule(prev, [reRated], withSettings({ startTime: '06:00', durations: { hard: 90 } }), time(0, 8));
  assert.deepEqual(plan.entries.overdue, slot(reRated, time(-1, 9), 40));
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

  const plan = planSchedule(null, [...full, nextDay], SETTINGS, time(0, 8));
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
    problem('c', { due: day(1), rating: 'medium', ratedAt }),
    problem('d', { due: day(-1), rating: 'medium', ratedAt }),
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
  const expected = planSchedule(null, [p], SETTINGS, time(0, 8));
  assert.deepEqual(planSchedule(null, [p], {}, time(0, 8)), expected);
  assert.deepEqual(
    planSchedule(null, [p], { startTime: '25:99', durations: { hard: -5 }, reminderMinutes: 'soon' }, time(0, 8)),
    expected,
  );
});

test('works with problems from srs.js (createProblem / recordReview)', () => {
  const solvedAt = time(-2, 21, 15);
  const p = createProblem({ id: 'two-sum', title: 'Two Sum', url: 'https://leetcode.com/problems/two-sum/', rating: 'medium', solvedAt });
  const plan = planSchedule(null, [p], SETTINGS, time(0, 8));
  assert.equal(plan.entries['two-sum'].start, time(1, 9)); // 3 days after the solve day
  const reviewed = recordReview(p, 'easy', { at: time(1, 9, 20) });
  const next = planSchedule(plan, [reviewed], SETTINGS, time(1, 9, 25));
  assert.equal(next.entries['two-sum'].start, time(8, 9));
  assert.equal(next.entries['two-sum'].end - next.entries['two-sum'].start, 20 * MIN);
});

// planSchedule: time zones and DST

test('places blocks at the local start time across the US DST change (America/Denver)', () => {
  withTimeZone('America/Denver', () => {
    const now = at(2026, 10, 27, 12);
    // Solved at noon local; Medium is due 3 days later, Hard 1 day later.
    const solve = (id, d, rating = 'medium') =>
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
    const spring = createProblem({ id: 'spring', title: 'Spring', url: 'u', rating: 'medium', solvedAt: at(2026, 3, 5, 12) });
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
        problem('fits', { due: day(1), rating: 'medium', ratedAt: ratedAt + 1 }),
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
    a: problem('a', { due: day(1), rating: 'medium', ratedAt: time(-2, 9) }),
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
  const problems = [problem('a', { due: day(1), rating: 'medium' }), problem('b', { due: day(2), rating: 'easy' })];
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

  // a is never reviewed: two days later its block stays where it was, in the past.
  const aEvent = cal.stored.a.id;
  plan = planSchedule(plan, problems, settings, time(3, 12));
  assert.equal(plan.entries.a.start, time(1, 7));
  assert.deepEqual(diffEvents(plan.entries, cal.stored, time(3, 12)), EMPTY);
  assert.equal(cal.onCalendar.get(aEvent).start, time(1, 7));

  // Changing settings now doesn't touch the missed (started) block either.
  plan = planSchedule(plan, problems, withSettings({ startTime: '11:00' }), time(3, 12));
  assert.equal(plan.entries.a.start, time(1, 7));
  assert.deepEqual(diffEvents(plan.entries, cal.stored, time(3, 12)), EMPTY);
});
