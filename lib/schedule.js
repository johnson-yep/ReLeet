// Plans the calendar blocks for upcoming reviews. Pure — no chrome.* APIs — so
// every calendar provider gets exactly the same slots and the rules are testable.
//
// Slot = one planned block, the same for every provider:
//   { problemId, day, start, end, title, description, url, rating, reminderMinutes }
// `day` is the review day ('YYYY-MM-DD', local); `start`/`end` are epoch ms.

import { RATINGS } from './srs.js';

const MINUTE = 60 * 1000;
const ROUND_MINUTES = 5;

// Only used when a settings field is missing or invalid, so a bad value never
// turns into NaN times on a calendar. Same values as DEFAULT_SETTINGS in storage.js.
const FALLBACK = Object.freeze({
  startTime: { hours: 9, minutes: 0 },
  durations: Object.freeze({ easy: 20, medium: 40, hard: 60 }),
  otherDuration: 30,
  reminderMinutes: 15,
});

const pad = (value, size = 2) => String(value).padStart(size, '0');

// Local calendar day, e.g. '2026-11-01'. Sorts correctly as a plain string.
export function dayKey(ms) {
  const d = new Date(ms);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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

function reminderMinutes(settings) {
  const value = Number(settings?.reminderMinutes ?? NaN);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : FALLBACK.reminderMinutes;
}

// Covers only the settings that decide where blocks go. The reminder isn't part
// of it: changing it updates events in place instead of re-placing them.
export function layoutKey(settings) {
  const { hours, minutes } = parseStartTime(settings?.startTime);
  const durations = RATINGS.map((rating) => `${rating}=${durationMinutes(settings, rating)}`).join(',');
  return `${pad(hours)}:${pad(minutes)}|${durations}`;
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

function makeSlot(problem, settings, day, start, end) {
  return {
    problemId: problem.id,
    day,
    start,
    end,
    title: `Review: ${problem.title}`,
    description: `Review ${problem.title} (last rated ${capitalize(String(problem.rating ?? ''))}).\n${problem.url}\n\nScheduled by ReLeet.`,
    url: problem.url,
    rating: problem.rating,
    reminderMinutes: reminderMinutes(settings),
  };
}

function lastRatedAt(problem) {
  const history = Array.isArray(problem.history) ? problem.history : [];
  return Number(history.at(-1)?.at ?? problem.solvedAt) || 0;
}

// Soonest review first; ties go to the problem rated earlier, then by id, so the
// same problems always land in the same order whatever order they're stored in.
function compareProblems(a, b) {
  const id = String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  return a.dueAt - b.dueAt || lastRatedAt(a) - lastRatedAt(b) || id;
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

// Works out the blocks for every problem's upcoming review. `prev` is the last
// plan ({ layoutKey, entries }) or null; existing blocks stay put when they're
// still valid, so events don't jump around on every sync.
export function planSchedule(prev, problems, settings, now = Date.now()) {
  const key = layoutKey(settings);
  const layoutChanged = prev?.layoutKey !== key;
  const prevEntries = prev?.entries ?? {};
  const today = dayKey(now);

  // Last one wins on a duplicate id, like a stored { [id]: Problem } map.
  const list = Array.isArray(problems) ? problems : Object.values(problems ?? {});
  const byId = new Map(list.filter((p) => p && Number.isFinite(p.dueAt)).map((p) => [p.id, p]));
  const sorted = [...byId.values()].sort(compareProblems);

  const planned = new Map();
  const occupied = [];

  // Keep blocks that are still right. A started block is frozen: it may already
  // be on someone's calendar as "now", so it's never moved, even by new settings.
  for (const problem of sorted) {
    if (!Object.hasOwn(prevEntries, problem.id)) continue;
    const entry = prevEntries[problem.id];
    const day = dayKey(problem.dueAt);
    const started = entry.start <= now;
    const sameLength = entry.end - entry.start === durationMinutes(settings, problem.rating) * MINUTE;
    if (entry.day === day && (started || (!layoutChanged && sameLength))) {
      planned.set(problem.id, makeSlot(problem, settings, day, entry.start, entry.end));
      occupy(occupied, { start: entry.start, end: entry.end });
    }
  }

  // Place the rest into the free time of their day. A missed (overdue) review
  // gets no new block: its old one stays in the past and the popup shows it overdue.
  for (const problem of sorted) {
    if (planned.has(problem.id)) continue;
    const day = dayKey(problem.dueAt);
    if (day < today) continue;
    const length = durationMinutes(settings, problem.rating) * MINUTE;
    const cursor = Math.max(dayStart(day, settings), roundUp(now));
    const start = firstFit(occupied, cursor, length);
    occupy(occupied, { start, end: start + length });
    planned.set(problem.id, makeSlot(problem, settings, day, start, start + length));
  }

  // Build entries in sorted order so equal plans serialize identically.
  const entries = {};
  for (const problem of sorted) {
    if (planned.has(problem.id)) entries[problem.id] = planned.get(problem.id);
  }
  return { layoutKey: key, entries };
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
    if (ref.start <= now) {
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
