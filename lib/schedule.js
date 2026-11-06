// Plans the review day and calendar block of every review. Pure — no chrome.*
// APIs — so the popup, the badge, the daily summary and every calendar provider
// agree, and the rules are testable.
//
// Slot = one planned block, the same for every provider:
//   { problemId, day, start, end, title, description, url, rating, reminderMinutes,
//     dueDay, overdueSince? }
// `day` is the day the review is booked for ('YYYY-MM-DD', local). It is the
// problem's review day (`dueDay`) unless the daily limit or a missed review
// moved it later. `overdueSince` is the booked day that passed without a
// review, kept while the review is re-booked. `start`/`end` are epoch ms.

import { RATINGS, addDaysToDay, dayKey, isDayKey, isMastered, reviewDay } from './srs.js';

export { dayKey };

const MINUTE = 60 * 1000;
const ROUND_MINUTES = 5;

// Only used when a settings field is missing or invalid, so a bad value never
// turns into NaN times on a calendar. Same values as DEFAULT_SETTINGS in storage.js.
const FALLBACK = Object.freeze({
  startTime: { hours: 9, minutes: 0 },
  durations: Object.freeze({ easy: 20, okay: 40, hard: 60 }),
  otherDuration: 30,
  dailyLimit: 60,
  reminderMinutes: 15,
});

const pad = (value) => String(value).padStart(2, '0');

// Accepts 'HH:MM' (and 'HH:MM:SS', which some time inputs produce).
function parseStartTime(value) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value ?? '').trim());
  if (!match) return FALLBACK.startTime;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? { hours, minutes } : FALLBACK.startTime;
}

function durationMinutes(settings, rating) {
  const value = Number(settings?.durations?.[rating]);
  if (Number.isFinite(value) && value > 0) return Math.max(1, Math.round(value));
  return FALLBACK.durations[rating] ?? FALLBACK.otherDuration;
}

function dailyLimitMinutes(settings) {
  const value = Number(settings?.dailyLimit);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : FALLBACK.dailyLimit;
}

function reminderMinutes(settings) {
  const value = Number(settings?.reminderMinutes ?? NaN);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : FALLBACK.reminderMinutes;
}

// Covers only the settings that decide where blocks go. The reminder isn't part
// of it: changing it updates events in place instead of re-placing them.
export function layoutKey(settings) {
  const { hours, minutes } = parseStartTime(settings?.startTime);
  const durations = RATINGS.map((rating) => `${rating}=${durationMinutes(settings, rating)}`).join(',');
  return `${pad(hours)}:${pad(minutes)}|${durations}|limit=${dailyLimitMinutes(settings)}`;
}

// Everything a provider writes to the calendar. Stored with each event, so a
// sync only touches events whose content actually changed.
export function slotHash(slot) {
  return JSON.stringify([slot.start, slot.end, slot.title, slot.description, slot.url, slot.reminderMinutes]);
}

// The first block of a day starts at the configured local time. Building the
// date from its parts (not midnight + hours) keeps it right on DST days.
function dayStart(day, settings) {
  const [y, m, d] = day.split('-').map(Number);
  const { hours, minutes } = parseStartTime(settings?.startTime);
  return new Date(y, m - 1, d, hours, minutes).getTime();
}

// Rounds up to the next 5 minutes of local clock time (unchanged if already on one).
function roundUp(ms) {
  const d = new Date(ms);
  const past = (d.getMinutes() % ROUND_MINUTES) * MINUTE + d.getSeconds() * 1000 + d.getMilliseconds();
  return past === 0 ? ms : ms - past + ROUND_MINUTES * MINUTE;
}

const capitalize = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);

function makeSlot(problem, settings, day, start, end, dueDay, overdueSince) {
  const slot = {
    problemId: problem.id,
    day,
    start,
    end,
    title: `Review: ${problem.title}`,
    description: `Review ${problem.title} (last rated ${capitalize(String(problem.rating ?? ''))}).\n${problem.url}\n\nScheduled by ReLeet.`,
    url: problem.url,
    rating: problem.rating,
    reminderMinutes: reminderMinutes(settings),
    dueDay,
  };
  if (overdueSince) slot.overdueSince = overdueSince;
  return slot;
}

function lastRatedAt(problem) {
  const history = Array.isArray(problem.history) ? problem.history : [];
  return Number(history.at(-1)?.at ?? problem.solvedAt) || 0;
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The order reviews claim room in: overdue ones first (missed longest ago
// first), then by review day, the earlier due time, the earlier rating, and id,
// so the same problems always land the same way whatever order they're stored in.
function comparePriority(a, b) {
  return (
    Number(b.overdueSince !== null) - Number(a.overdueSince !== null) ||
    compareText(a.overdueSince ?? a.dueDay, b.overdueSince ?? b.dueDay) ||
    a.problem.dueAt - b.problem.dueAt ||
    lastRatedAt(a.problem) - lastRatedAt(b.problem) ||
    compareText(String(a.problem.id), String(b.problem.id))
  );
}

// Earliest start >= cursor where `length` fits between the occupied intervals
// (sorted by start).
function firstFit(occupied, cursor, length) {
  let start = cursor;
  for (const busy of occupied) {
    if (busy.start >= start + length) break;
    if (busy.end > start) start = busy.end;
  }
  return start;
}

function occupy(occupied, interval) {
  const index = occupied.findIndex((busy) => busy.start > interval.start);
  occupied.splice(index === -1 ? occupied.length : index, 0, interval);
}

// One review to plan: the problem, its review day, the previous plan's entry
// for this same review (null after a new rating), and its block length.
//   started  the entry's block has begun
//   missed   its booked day is over and its block ended without a review
function describe(problem, prevEntries, settings, today, now) {
  const dueDay = reviewDay(problem);
  const prev = Object.hasOwn(prevEntries, problem.id) ? prevEntries[problem.id] : null;
  // Entries from before dueDay was stored were always booked on the review day.
  const entry = prev && (prev.dueDay ?? prev.day) === dueDay ? prev : null;
  const started = Boolean(entry) && entry.start <= now;
  const missed = Boolean(entry) && entry.day < today && entry.end <= now;
  let overdueSince = null;
  if (entry) overdueSince = missed ? (entry.overdueSince ?? entry.day) : (entry.overdueSince ?? null);
  else if (dueDay < today) overdueSince = dueDay;
  const length = durationMinutes(settings, problem.rating) * MINUTE;
  return { problem, dueDay, entry, started, missed, overdueSince, length };
}

// Blocks booked for today whose reviews were done today: the ones the last
// plan already carried, and today's entries whose problem has since been rated
// today. A problem no longer tracked, or mastered without a review, gave its
// time back. → [{ problemId, day, start, end }]
function doneTodayBlocks(prev, reviews, problems, today) {
  const ratedToday = new Set(
    problems.filter((p) => p && dayKey(Number(p.history?.at(-1)?.at)) === today).map((p) => p.id),
  );
  const planned = new Set(reviews.map((r) => r.entry).filter(Boolean));
  const blocks = (prev?.doneToday ?? []).filter((b) => b?.day === today && b.end > b.start);
  for (const entry of Object.values(prev?.entries ?? {})) {
    if (entry?.day !== today || planned.has(entry) || !(entry.end > entry.start)) continue;
    if (!ratedToday.has(entry.problemId)) continue;
    if (blocks.some((b) => b.problemId === entry.problemId && b.start === entry.start)) continue;
    blocks.push({ problemId: entry.problemId, day: today, start: entry.start, end: entry.end });
  }
  return blocks;
}

// Works out the day and block of every review that isn't mastered. `prev` is
// the last plan ({ layoutKey, entries }) or null.
//
// Days: reviews claim room in priority order (see comparePriority), each on
// the first day from its review day (or today) whose booked minutes leave room
// under the daily limit. A day with nothing booked always takes one review,
// however long. A missed review is booked again, first in line.
//
// Times: blocks stay put while their day is unchanged, so events don't jump
// around on every sync; the rest go into the free time of their day. A started
// block is frozen: it may already be on someone's calendar as "now". Unless no
// connected calendar has it (planned while none was connected, or every write
// failed): then today's review is placed again from now, so a calendar
// connected or fixed later in the day still gets a block for it.
//
// `booked` is the set of problem ids whose planned block some connected
// calendar holds an event for (on the block's day), or null when no calendar
// is connected.
export function planSchedule(prev, problems, settings, now = Date.now(), { booked = null } = {}) {
  const key = layoutKey(settings);
  const layoutChanged = prev?.layoutKey !== key;
  const prevEntries = prev?.entries ?? {};
  const today = dayKey(now);
  const limit = dailyLimitMinutes(settings) * MINUTE;

  // Last one wins on a duplicate id, like a stored { [id]: Problem } map.
  const list = Array.isArray(problems) ? problems : Object.values(problems ?? {});
  // A review day that isn't a real date would send the day loop below on forever.
  const active = list.filter((p) => p && Number.isFinite(p.dueAt) && !isMastered(p) && isDayKey(reviewDay(p)));
  const reviews = [...new Map(active.map((p) => [p.id, p])).values()]
    .map((p) => describe(p, prevEntries, settings, today, now))
    .sort(comparePriority);

  const frozen = (r) => r.started && !r.missed && (r.entry.day < today || !booked || booked.has(r.problem.id));
  // A block that runs past midnight belongs to the day before until it ends.
  const keepsDay = (r) => Boolean(r.entry) && !r.missed && (r.entry.day < today || frozen(r));
  const days = new Map(); // review → booked day
  const used = new Map(); // day → booked ms
  const book = (r, day) => {
    days.set(r, day);
    used.set(day, (used.get(day) ?? 0) + r.length);
  };
  const hasRoom = (day, length) => !used.get(day) || used.get(day) + length <= limit;
  const occupied = [];

  // Today's blocks for reviews done today used today's time: they keep
  // counting toward the limit, so the next review doesn't move into today
  // after every rating, and a started one keeps its place so nothing is booked
  // over it. The plan carries them (doneToday) until the day is over.
  const doneToday = doneTodayBlocks(prev, reviews, list, today);
  for (const block of doneToday) {
    used.set(today, (used.get(today) ?? 0) + (block.end - block.start));
    if (block.start <= now) occupy(occupied, { start: block.start, end: block.end });
  }

  for (const r of reviews) if (keepsDay(r)) book(r, r.entry.day);
  for (const r of reviews) {
    if (days.has(r)) continue;
    let day = r.dueDay > today ? r.dueDay : today;
    while (!hasRoom(day, r.length)) day = addDaysToDay(day, 1);
    book(r, day);
  }

  const blocks = new Map(); // review → { start, end }
  for (const r of reviews) {
    const { entry } = r;
    const sameDay = entry?.day === days.get(r);
    const unchanged = sameDay && !r.started && !layoutChanged && entry.end - entry.start === r.length;
    if (frozen(r) || unchanged) {
      blocks.set(r, { start: entry.start, end: entry.end });
      occupy(occupied, { start: entry.start, end: entry.end });
    }
  }
  for (const r of reviews) {
    if (blocks.has(r)) continue;
    const day = days.get(r);
    const cursor = Math.max(dayStart(day, settings), roundUp(now));
    const start = firstFit(occupied, cursor, r.length);
    blocks.set(r, { start, end: start + r.length });
    occupy(occupied, blocks.get(r));
  }

  const entries = {};
  for (const r of reviews) {
    const { start, end } = blocks.get(r);
    entries[r.problem.id] = makeSlot(r.problem, settings, days.get(r), start, end, r.dueDay, r.overdueSince);
  }
  const plan = { layoutKey: key, entries };
  if (doneToday.length) plan.doneToday = doneToday;
  return plan;
}

// Problem ids whose planned block some connected calendar has an event for, on
// that block's day; null when no calendar is connected (see planSchedule).
export function bookedProblems(schedule, calendars) {
  const states = Object.values(calendars ?? {}).filter((state) => state?.connected);
  if (!states.length) return null;
  const entries = schedule?.entries ?? {};
  const booked = new Set();
  for (const state of states) {
    for (const [problemId, ref] of Object.entries(state.events ?? {})) {
      if (Object.hasOwn(entries, problemId) && entries[problemId].day === ref?.day) booked.add(problemId);
    }
  }
  return booked;
}

// Compares the plan with what a provider has on its calendar and returns the
// operations that bring the calendar in line. Started events are history: they
// are never moved or deleted, only forgotten, so a missed or finished review
// still shows where it was.
export function diffEvents(entries, events, now = Date.now()) {
  const desired = entries ?? {};
  const stored = events ?? {};
  const create = [];
  const update = [];
  const remove = [];
  const forget = [];

  for (const [problemId, ref] of Object.entries(stored)) {
    const slot = Object.hasOwn(desired, problemId) ? desired[problemId] : null;
    if (slot && ref.hash === slotHash(slot)) continue;
    // A started event on the block's day is normally that block. At another
    // start time, this calendar missed a move (it was failing when the block
    // moved), so it's moved like any upcoming event while the block isn't over.
    const missedMove = slot && slot.day === ref.day && slot.start !== ref.start && slot.end > now;
    if (ref.start <= now && !missedMove) {
      if (slot && slot.day === ref.day) continue;
      forget.push(problemId);
      if (slot && slot.end > now) create.push(slot);
    } else if (slot) {
      update.push({ slot, ref });
    } else {
      remove.push({ problemId, ref });
    }
  }

  // Never create a block that is already over.
  for (const [problemId, slot] of Object.entries(desired)) {
    if (!Object.hasOwn(stored, problemId) && slot.end > now) create.push(slot);
  }

  return { create, update, remove, forget };
}
