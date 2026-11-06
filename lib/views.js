// What the popup shows, worked out from storage. Pure — no chrome.* APIs — so
// the rules (one row per problem, the streak, grouping by day) are testable.

import { bookedProblems, planSchedule } from './schedule.js';
import { RATINGS, addDaysToDay, dayKey, isMastered, nextInterval } from './srs.js';

// Upcoming reviews show day by day this far ahead, then "Show all".
const UPCOMING_DAYS = 7;

// { easy: { days, capped }, okay: …, hard: … } for a problem (null: not tracked yet).
const intervalsFor = (problem) => Object.fromEntries(RATINGS.map((r) => [r, nextInterval(problem, r)]));

// Days in a row with at least one rating (a solve or a review). Today counts
// once it has one, and doesn't break the streak until it's over.
export function streak(problems, now = Date.now()) {
  const rated = new Set(problems.flatMap((p) => (p.history ?? []).map((h) => dayKey(h.at))));
  let day = dayKey(now);
  if (!rated.has(day)) day = addDaysToDay(day, -1);
  let days = 0;
  while (rated.has(day)) {
    days++;
    day = addDaysToDay(day, -1);
  }
  return days;
}

const length = (slot) => slot.end - slot.start;
const sum = (slots) => slots.reduce((total, slot) => total + length(slot), 0);
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// storage: { problems: {id: Problem}, pending: {id: Submission}, schedule, settings, calendars }.
export function popupView({ problems = {}, pending = {}, schedule = null, settings, calendars = {} }, now = Date.now()) {
  const list = Object.values(problems);
  const byId = new Map(list.map((p) => [p.id, p]));
  // The same plan the worker saves, worked out now, so the popup is right
  // even before the worker's next sync.
  const plan = planSchedule(schedule, list, settings, now, { booked: bookedProblems(schedule, calendars) });
  const today = dayKey(now);
  const slots = Object.values(plan.entries);

  // A tracked problem solved again shows once, under To rate: rating it is its review.
  const toRate = Object.values(pending)
    .sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0))
    .map((solve) => {
      const problem = byId.get(solve.id) ?? null;
      return { solve, problem, intervals: intervalsFor(problem) };
    });
  const waiting = new Set(Object.keys(pending));

  const dueSlots = slots.filter((slot) => slot.day <= today);
  const due = dueSlots
    .filter((slot) => !waiting.has(slot.problemId))
    .sort(
      (a, b) =>
        Number(Boolean(b.overdueSince)) - Number(Boolean(a.overdueSince)) ||
        compareText(a.overdueSince ?? '', b.overdueSince ?? '') ||
        a.start - b.start,
    )
    .map((slot) => {
      const problem = byId.get(slot.problemId);
      return { slot, problem, intervals: intervalsFor(problem) };
    });

  const later = slots.filter((slot) => slot.day > today && !waiting.has(slot.problemId)).sort((a, b) => a.start - b.start);
  const days = new Map();
  for (const slot of later) {
    if (!days.has(slot.day)) days.set(slot.day, []);
    days.get(slot.day).push({ slot, problem: byId.get(slot.problemId) });
  }
  const lastShown = addDaysToDay(today, UPCOMING_DAYS);
  const upcoming = [...days].map(([day, items]) => ({
    day,
    items,
    minutes: sum(items.map((i) => i.slot)),
    soon: day <= lastShown,
  }));

  const mastered = list.filter(isMastered).sort((a, b) => compareText(a.title.toLowerCase(), b.title.toLowerCase()));

  return {
    plan,
    stats: {
      tracked: list.length - mastered.length,
      dueToday: due.length, // as under Due today: a solve to rate shows (and counts) under To rate
      mastered: mastered.length,
      streak: streak(list, now),
    },
    toRate,
    due: { items: due, minutes: sum(due.map((i) => i.slot)) },
    upcoming,
    upcomingCount: later.length,
    mastered,
    empty: list.length === 0 && toRate.length === 0,
  };
}

