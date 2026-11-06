import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';

const chrome = installFakeChrome();
const actions = await import('../lib/actions.js');
const computer = await import('../lib/computer.js');
const { createProblem, markMastered } = await import('../lib/srs.js');

const NOW = new Date(2026, 10, 10, 12).getTime();
const solve = (id) => ({ id, title: id, url: `https://leetcode.com/problems/${id}/`, submittedAt: NOW - 3600000, submissionId: '1', source: 'leetcode' });
const tracked = (id) => createProblem({ id, title: id, url: `https://leetcode.com/problems/${id}/`, rating: 'okay', solvedAt: NOW - 3 * 86400000 });
const dump = () => chrome.dump();

beforeEach(() => chrome.reset());

test('rating a solve starts tracking it from when it was submitted; undo puts the solve back', async () => {
  chrome.reset({ pending: { a: solve('a') } });
  const change = await actions.ratePending('a', 'hard');
  assert.equal(dump().problems.a.solvedAt, NOW - 3600000);
  assert.equal(dump().pending.a, undefined);
  assert.equal(change.capped, false);
  assert.equal(await actions.undo('a', change), true);
  assert.deepEqual(dump().pending.a, solve('a'));
  assert.equal(dump().problems.a, undefined);
});

test('a review is rated once, however many clicks reach it', async () => {
  chrome.reset({ problems: { a: tracked('a') } });
  const seen = tracked('a').history.length;
  const [first, second] = await Promise.all([
    actions.rateReview('a', 'easy', { seen, at: NOW }),
    actions.rateReview('a', 'hard', { seen, at: NOW }),
  ]);
  assert.ok(first);
  assert.equal(second, null);
  assert.deepEqual(dump().problems.a.history.map((h) => h.rating), ['okay', 'easy']);
});

test('undo refuses once the problem changed again', async () => {
  chrome.reset({ problems: { a: tracked('a') } });
  const change = await actions.rateReview('a', 'easy', { seen: 1, at: NOW });
  await actions.rateReview('a', 'okay', { seen: 2, at: NOW + 1000 });
  assert.equal(await actions.undo('a', change), false);
  assert.equal(dump().problems.a.history.length, 3);
});

test('reaching the longest interval is reported, so the confirmation can suggest Mastered', async () => {
  chrome.reset({ problems: { a: { ...tracked('a'), interval: 100 } } });
  const change = await actions.rateReview('a', 'easy', { seen: 1, at: NOW });
  assert.equal(change.capped, true);
  assert.equal(dump().problems.a.interval, 180);
});

test('mastering, resuming and stopping tracking', async () => {
  chrome.reset({ problems: { a: tracked('a') }, pending: { b: solve('b'), c: solve('c') } });
  const mastered = await actions.master('a', NOW);
  assert.equal(dump().problems.a.masteredAt, NOW);
  assert.equal(await actions.master('a', NOW), null); // already mastered

  await actions.resume('a', NOW);
  assert.equal(dump().problems.a.masteredAt, undefined);
  assert.equal(dump().problems.a.dueDay, '2026-11-13');
  assert.equal(await actions.resume('a', NOW), null);

  // Mastering a solve waiting to be rated counts it as Easy first.
  await actions.master('b', NOW);
  assert.equal(dump().problems.b.rating, 'easy');
  assert.equal(dump().pending.b, undefined);

  // Stop tracking forgets the problem and its waiting solve, with undo.
  chrome.reset({ problems: { c: tracked('c') }, pending: { c: solve('c') } });
  const stopped = await actions.stopTracking('c');
  assert.deepEqual(dump().problems, {});
  assert.deepEqual(dump().pending, {});
  await actions.undo('c', stopped);
  assert.ok(dump().problems.c && dump().pending.c);
  assert.ok(mastered);
});

test('adding a tracked problem by hand counts as a review and brings a mastered one back', async () => {
  chrome.reset({ problems: { a: markMastered(tracked('a'), NOW) } });
  await actions.addSolved({ id: 'a', title: 'a', url: 'u' }, 'okay', NOW);
  assert.equal(dump().problems.a.masteredAt, undefined);
  assert.equal(dump().problems.a.history.length, 2);
  await actions.addSolved({ id: 'new', title: 'New', url: 'u' }, 'easy', NOW);
  assert.equal(dump().problems.new.source, 'manual');
  assert.equal(dump().problems.new.interval, 7);
});

// Main computer

test('the first rating claims an unclaimed ReLeet; it never takes over from another computer', async () => {
  assert.equal(await computer.computerRole(), 'unclaimed');
  chrome.reset({ pending: { a: solve('a') } });
  await actions.ratePending('a', 'easy');
  assert.equal(await computer.computerRole(), 'main');

  chrome.reset({ pending: { a: solve('a') } }, { sync: { mainComputer: { id: 'elsewhere' } } });
  assert.equal(await computer.computerRole(), 'idle');
  await actions.ratePending('a', 'easy');
  assert.equal(await computer.computerRole(), 'idle');
});

test('each install keeps one id; claiming and releasing the main computer', async () => {
  const [a, b] = await Promise.all([computer.getComputerId(), computer.getComputerId()]);
  assert.equal(a, b);
  await computer.claimMainComputer(5);
  assert.deepEqual((await chrome.storage.sync.get('mainComputer')).mainComputer, { id: a, claimedAt: 5 });
  assert.equal(computer.isActive('main') && computer.isActive('unclaimed') && !computer.isActive('idle'), true);
  await computer.releaseMainComputer();
  assert.equal(await computer.computerRole(), 'unclaimed');
  // Releasing never removes another computer's claim.
  await chrome.storage.sync.set({ mainComputer: { id: 'elsewhere' } });
  await computer.releaseMainComputer();
  assert.equal((await chrome.storage.sync.get('mainComputer')).mainComputer.id, 'elsewhere');
});
