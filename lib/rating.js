// Rating a detected solve. Shared by the popup and the service worker (which
// handles ratings from the in-page prompt on leetcode.com).

import { getPendingMap, getProblem, resolvePending } from './storage.js';
import { applySolve, isValidRating } from './srs.js';

// Starts tracking the problem, or counts as a review if it's already tracked.
// The solve date is when it was submitted, not when it was rated.
// Returns the saved problem, or null if the submission is no longer pending.
export async function ratePending(id, rating) {
  if (!isValidRating(rating)) throw new Error(`Unknown rating: ${rating}`);
  const s = (await getPendingMap())[id];
  if (!s) return null;
  const solve = { ...s, at: s.submittedAt ?? Date.now(), source: s.source ?? 'leetcode' };
  const problem = applySolve(await getProblem(id), solve, rating);
  await resolvePending(id, problem);
  return problem;
}
