// What the user does to a problem, from the popup or the in-page prompt. Each
// action changes the problem and its pending solve together and returns the
// undo for it ({ before, after }, see storage.updateEntry), or null when there
// was nothing to do (already rated elsewhere, say).

import { revertEntry, updateEntry } from './storage.js';
import { applySolve, isMastered, isValidRating, markMastered, nextInterval, recordReview, resumeProblem } from './srs.js';
import { claimIfUnclaimed } from './computer.js';

// A pending solve counts from when it was submitted, not when it was rated.
const solveOf = (pending) => ({ ...pending, at: pending.submittedAt ?? Date.now(), source: pending.source ?? 'leetcode' });

// Rating anything makes an unclaimed ReLeet this computer's.
// → { before, after, capped } (capped: the longest interval, so suggest Mastered).
async function rateWith(id, rating, rateEntry) {
  if (!isValidRating(rating)) throw new Error(`Unknown rating: ${rating}`);
  let capped = false;
  const undo = await updateEntry(id, (entry) => {
    const problem = rateEntry(entry);
    if (!problem) return null;
    capped = nextInterval(entry.problem, rating).capped;
    return { problem, pending: null };
  });
  if (!undo) return null;
  await claimIfUnclaimed();
  return { ...undo, capped };
}

// Rates the solve waiting to be rated: it starts tracking the problem, or
// counts as a review of it. null once it's rated (a double click, or the
// popup and the page at once), so it counts once.
export function ratePending(id, rating) {
  return rateWith(id, rating, ({ problem, pending }) => pending && applySolve(problem, solveOf(pending), rating));
}

// Rates a tracked problem's review, done now. `seen` is how many ratings the
// problem had when its buttons were shown; once it has more, a second click
// changes nothing.
export function rateReview(id, rating, { seen, at = Date.now() }) {
  return rateWith(id, rating, ({ problem }) => problem?.history?.length === seen && recordReview(problem, rating, { at }));
}

// Mastered — stop reviewing. A solve waiting to be rated is counted first,
// as Easy: the user is saying it's easy for them.
export async function master(id, at = Date.now()) {
  const undo = await updateEntry(id, ({ problem, pending }) => {
    if (pending) return { problem: markMastered(applySolve(problem, solveOf(pending), 'easy'), at), pending: null };
    if (problem && !isMastered(problem)) return { problem: markMastered(problem, at), pending: null };
    return null;
  });
  if (undo) await claimIfUnclaimed();
  return undo;
}

export function resume(id, at = Date.now()) {
  return updateEntry(id, ({ problem, pending }) => (isMastered(problem) ? { problem: resumeProblem(problem, at), pending } : null));
}

// Forgets the problem and any solve of it waiting to be rated.
export function stopTracking(id) {
  return updateEntry(id, ({ problem, pending }) => (problem || pending ? { problem: null, pending: null } : null));
}

// "+ Add a problem": a solve made now. Adding a tracked problem counts as a review.
export async function addSolved({ id, title, url }, rating, at = Date.now()) {
  if (!isValidRating(rating)) throw new Error(`Unknown rating: ${rating}`);
  const undo = await updateEntry(id, ({ problem }) => ({
    problem: applySolve(problem, { id, title, url, at, source: 'manual' }, rating),
    pending: null,
  }));
  await claimIfUnclaimed();
  return undo;
}

// → true if the action was undone, false if the problem changed since.
export function undo(id, change) {
  return revertEntry(id, change);
}
