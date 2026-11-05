import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';

const chrome = installFakeChrome();
const sync = await import('../lib/leetcode-sync.js');
const {
  selectNewSubmissions,
  detectionsToNotify,
  syncLeetCode,
  syncIfStale,
  importRecent,
  recordAcceptedFromPage,
  setDetectedUsername,
} = sync;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// LeetCode's recent list as the client returns it (timestamp in ms).
const sub = (submissionId, slug, timestamp, title = slug) => ({ submissionId, slug, title, timestamp });

// Raw GraphQL shape for the fake fetch (timestamp in seconds, as a string).
const raw = (s) => ({ id: s.submissionId, title: s.title, titleSlug: s.slug, timestamp: String(s.timestamp / 1000) });

// Swaps globalThis.fetch for one that serves `list` as alice's recent accepted
// submissions, or `respond()` if given. Counts requests.
let requests = 0;
function serve(list, respond = null) {
  globalThis.fetch = async () => {
    requests++;
    if (respond) return respond();
    const body = { data: { matchedUser: { username: 'alice' }, recentAcSubmissionList: list.map(raw) } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

// Whole-second times, since LeetCode reports seconds.
const nowSec = () => Math.floor(Date.now() / 1000) * 1000;

const settings = (patch = {}) => ({ leetcodeUsername: 'alice', leetcodeUsernameSource: 'manual', ...patch });
const problem = (id, historyAts) => ({
  id,
  title: id,
  url: `https://leetcode.com/problems/${id}/`,
  rating: 'medium',
  solvedAt: historyAts[0],
  dueAt: historyAts.at(-1) + 3 * 24 * HOUR,
  commitSha: null,
  source: 'leetcode',
  history: historyAts.map((at) => ({ at, rating: 'medium', commitSha: null })),
});

beforeEach(() => {
  chrome.reset();
  requests = 0;
});

// selectNewSubmissions (pure)

test('selectNewSubmissions keeps submissions from the baseline on, minus seen ids', () => {
  const base = new Date(2026, 10, 4, 12, 0).getTime();
  const recent = [
    sub('4', 'four', base + 3 * MIN),
    sub('3', 'three', base + 2 * MIN),
    sub('2', 'two', base),
    sub('1', 'one', base - 1),
  ];
  const { submissions, seenIds } = selectNewSubmissions(recent, { baselineAt: base, seenIds: ['3'] }, {}, base + HOUR);
  assert.deepEqual(
    submissions.map((s) => s.submissionId),
    ['4', '2'],
  );
  assert.deepEqual(submissions[0], {
    id: 'four',
    title: 'four',
    url: 'https://leetcode.com/problems/four/',
    submittedAt: base + 3 * MIN,
    submissionId: '4',
    source: 'leetcode',
  });
  // Every id is remembered, including the skipped one before the baseline, oldest first.
  assert.deepEqual(seenIds, ['3', '1', '2', '4']);
});

test('selectNewSubmissions collapses several solves of one problem into the latest', () => {
  const t = new Date(2026, 10, 4, 9, 0).getTime();
  const recent = [sub('12', 'two-sum', t + 2 * HOUR), sub('11', 'two-sum', t), sub('13', 'two-sum', t + HOUR)];
  const { submissions, seenIds } = selectNewSubmissions(recent, { baselineAt: 0, seenIds: [] }, {}, t + 3 * HOUR);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].submissionId, '12');
  assert.equal(submissions[0].submittedAt, t + 2 * HOUR);
  assert.deepEqual(seenIds, ['11', '13', '12']);
});

test('selectNewSubmissions skips problems already rated that day, not the day before', () => {
  const before = new Date(2026, 10, 3, 23, 55).getTime(); // 5 min before local midnight
  const after = new Date(2026, 10, 4, 0, 5).getTime(); // 5 min after
  const late = new Date(2026, 10, 4, 23, 50).getTime();
  const state = { baselineAt: 0, seenIds: [] };
  const now = late + MIN;
  const pick = (submission, history) =>
    selectNewSubmissions([submission], state, { p: problem('p', history) }, now).submissions.length;

  assert.equal(pick(sub('1', 'p', after), [before]), 1, 'rated yesterday, solved today → new review');
  assert.equal(pick(sub('2', 'p', late), [after]), 0, 'rated earlier the same day → already counted');
  assert.equal(pick(sub('3', 'p', before), [after]), 0, 'rated on a later day → old solve ignored');
  assert.equal(pick(sub('4', 'untracked', after), [after]), 1, 'other problems unaffected');
});

test('selectNewSubmissions caps seenIds at the latest 200', () => {
  const old = Array.from({ length: 195 }, (_, i) => `old-${i}`);
  const t = Date.now() - HOUR;
  const recent = Array.from({ length: 10 }, (_, i) => sub(`new-${i}`, `p${i}`, t + i * MIN));
  const { seenIds, submissions } = selectNewSubmissions(recent, { baselineAt: 0, seenIds: old }, {});
  assert.equal(submissions.length, 10);
  assert.equal(seenIds.length, 200);
  assert.equal(seenIds[0], 'old-5');
  assert.equal(seenIds.at(-1), 'new-9');
});

test('selectNewSubmissions never dates a solve in the future', () => {
  const now = Date.now();
  const { submissions } = selectNewSubmissions([sub('1', 'p', now + 90 * 1000)], { baselineAt: 0 }, {}, now);
  assert.equal(submissions[0].submittedAt, now);
});

test('detectionsToNotify leaves a just-made solve to its open leetcode.com tab', () => {
  const now = Date.now();
  const d = (id, ago) => ({ id, title: id, submittedAt: now - ago });
  const detected = [d('open-new', 30 * 1000), d('open-old', 10 * MIN), d('closed-new', 30 * 1000)];
  const open = new Set(['open-new', 'open-old']);
  assert.deepEqual(
    detectionsToNotify(detected, open, now).map((s) => s.id),
    ['open-old', 'closed-new'],
  );
  assert.equal(detectionsToNotify(detected, new Set(), now).length, 3);
});

// syncLeetCode

test('sync without a username does nothing', async () => {
  chrome.reset({ settings: settings({ leetcodeUsername: '  ' }), leetcode: { username: 'old' } });
  serve([]);
  assert.deepEqual(await syncLeetCode(), { status: 'unconfigured', added: 0, detected: [], error: null });
  assert.equal(requests, 0);
  assert.deepEqual(chrome.dump().leetcode, { username: 'old' });
});

test('first sync records a baseline without queueing past solves', async () => {
  const t = nowSec() - HOUR;
  chrome.reset({ settings: settings() });
  serve([sub('2', 'lru-cache', t + MIN), sub('1', 'two-sum', t)]);

  const before = Date.now();
  const result = await syncLeetCode();
  assert.deepEqual(result, { status: 'baseline', added: 0, detected: [], error: null });

  const { leetcode, pending } = chrome.dump();
  assert.equal(pending, undefined);
  assert.equal(leetcode.username, 'alice');
  // Just past the newest listed solve, in LeetCode's time rather than ours.
  assert.equal(leetcode.baselineAt, t + MIN + 1000);
  assert.deepEqual(leetcode.seenIds, ['1', '2']);
  assert.ok(leetcode.lastSyncAt >= before && leetcode.lastSyncAt <= Date.now());
  assert.equal(leetcode.lastError, null);
});

test('a first sync with nothing listed starts the baseline now', async () => {
  chrome.reset({ settings: settings() });
  serve([]);
  const before = Date.now();
  assert.equal((await syncLeetCode()).status, 'baseline');
  const { baselineAt } = chrome.dump().leetcode;
  assert.ok(baselineAt >= before && baselineAt <= Date.now());
});

test("with this machine's clock fast, a solve right after the baseline is still queued", async () => {
  // LeetCode's clock is 3 minutes behind ours: its "just now" is our now - 3 min.
  const leetcodeNow = nowSec() - 3 * MIN;
  chrome.reset({ settings: settings() });
  serve([sub('1', 'two-sum', leetcodeNow - 10 * MIN)]);
  assert.equal((await syncLeetCode()).status, 'baseline');

  // Solved on another device a few seconds after connecting (LeetCode's time).
  serve([sub('2', 'lru-cache', leetcodeNow + 5000), sub('1', 'two-sum', leetcodeNow - 10 * MIN)]);
  const result = await syncLeetCode();
  assert.deepEqual(
    result.detected.map((d) => d.id),
    ['lru-cache'],
  );
});

test('changing the username starts a new baseline', async () => {
  chrome.reset({
    settings: settings({ leetcodeUsername: 'bob' }),
    leetcode: { username: 'alice', baselineAt: 1, seenIds: ['a1', 'a2'], lastSyncAt: 1, lastError: 'old' },
  });
  serve([sub('b1', 'two-sum', nowSec() - MIN)]);
  const result = await syncLeetCode();
  assert.equal(result.status, 'baseline');
  const { leetcode, pending } = chrome.dump();
  assert.equal(pending, undefined);
  assert.equal(leetcode.username, 'bob');
  assert.deepEqual(leetcode.seenIds, ['b1']);
  assert.ok(leetcode.baselineAt > 1);
  assert.equal(leetcode.lastError, null);
});

test('sync queues new accepted submissions and reports them as detected', async () => {
  const t0 = nowSec();
  const baselineAt = t0 - HOUR;
  chrome.reset({
    settings: settings(),
    leetcode: { username: 'alice', baselineAt, seenIds: ['1'], lastSyncAt: baselineAt, lastError: 'x' },
    pending: { 'lru-cache': { id: 'lru-cache', title: 'LRU Cache', submittedAt: baselineAt + MIN } },
    problems: { 'rated-today': problem('rated-today', [Date.now()]) },
  });
  serve([
    sub('5', 'rated-today', t0 - 2 * MIN),
    sub('4', 'lru-cache', t0 - 3 * MIN, 'LRU Cache'),
    sub('3', 'two-sum', t0 - 4 * MIN, 'Two Sum'),
    sub('2', 'old-one', baselineAt - MIN),
    sub('1', 'seen', baselineAt + MIN),
  ]);

  const result = await syncLeetCode();
  assert.equal(result.status, 'ok');
  assert.equal(result.error, null);
  assert.equal(result.added, 1);
  // lru-cache was already pending: refreshed, but not news.
  assert.deepEqual(
    result.detected.map((s) => s.id),
    ['two-sum'],
  );
  assert.equal(result.detected[0].title, 'Two Sum');

  const { pending, leetcode } = chrome.dump();
  assert.deepEqual(Object.keys(pending).sort(), ['lru-cache', 'two-sum']);
  assert.equal(pending['lru-cache'].submissionId, '4');
  assert.equal(pending['two-sum'].submittedAt, t0 - 4 * MIN);
  assert.deepEqual(new Set(leetcode.seenIds), new Set(['1', '2', '3', '4', '5']));
  assert.equal(leetcode.baselineAt, baselineAt);
  assert.equal(leetcode.lastError, null);
  assert.ok(leetcode.lastSyncAt > baselineAt);

  // Nothing new the second time round.
  const again = await syncLeetCode();
  assert.deepEqual([again.status, again.added, again.detected], ['ok', 0, []]);
});

test('a failed sync saves the error and keeps the baseline', async () => {
  const state = { username: 'alice', baselineAt: 1000, seenIds: ['1'], lastSyncAt: 1000, lastError: null };
  chrome.reset({ settings: settings(), leetcode: state });
  serve([], () => new Response('<html>Bad gateway</html>', { status: 502 }));

  const result = await syncLeetCode();
  assert.equal(result.status, 'error');
  assert.match(result.error, /HTTP 502/);
  assert.deepEqual([result.added, result.detected], [0, []]);

  const { leetcode } = chrome.dump();
  assert.equal(leetcode.lastError, result.error);
  assert.ok(leetcode.lastSyncAt > 1000);
  assert.deepEqual([leetcode.username, leetcode.baselineAt, leetcode.seenIds], ['alice', 1000, ['1']]);

  // The next good run clears the error.
  serve([]);
  assert.equal((await syncLeetCode()).status, 'ok');
  assert.equal(chrome.dump().leetcode.lastError, null);
});

test('a failed first sync does not set a baseline', async () => {
  chrome.reset({ settings: settings() });
  serve([], () => new Response(JSON.stringify({ errors: [{ message: 'That user does not exist.' }] })));
  const result = await syncLeetCode();
  assert.equal(result.status, 'error');
  assert.match(result.error, /not found/);
  const { leetcode } = chrome.dump();
  assert.equal(leetcode.username, undefined);
  assert.equal(leetcode.baselineAt, undefined);
  assert.equal(leetcode.lastError, result.error);
});

test('concurrent syncs share one run', async () => {
  chrome.reset({ settings: settings() });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  globalThis.fetch = async () => {
    requests++;
    await gate;
    return new Response(JSON.stringify({ data: { matchedUser: {}, recentAcSubmissionList: [] } }));
  };
  const a = syncLeetCode();
  const b = syncLeetCode();
  const c = syncIfStale(); // a run is in flight, so it joins it
  release();
  const results = await Promise.all([a, b, c]);
  assert.equal(requests, 1);
  assert.equal(results[0], results[1]);
  assert.equal(results[0], results[2]);

  // A later call starts a fresh run.
  serve([]);
  await syncLeetCode();
  assert.equal(requests, 2);
});

test('a username change during a check runs once more for the new user', async () => {
  chrome.reset({
    settings: settings({ leetcodeUsername: 'alice', leetcodeUsernameSource: 'auto' }),
    leetcode: { username: 'alice', baselineAt: 1, seenIds: [], lastSyncAt: 1, lastError: null },
  });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const asked = [];
  globalThis.fetch = async (_url, init) => {
    const { username } = JSON.parse(init.body).variables;
    asked.push(username);
    if (asked.length === 1) await gate; // alice's check is slow
    const body = { data: { matchedUser: { username }, recentAcSubmissionList: [] } };
    return new Response(JSON.stringify(body));
  };

  const alice = syncLeetCode();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setDetectedUsername('bob'); // signed in as bob on leetcode.com
  const bob = syncLeetCode(); // what the settings listener does
  const aliceAgain = syncLeetCode();
  release();

  assert.equal((await alice).status, 'ok');
  assert.equal((await bob).status, 'baseline');
  assert.equal(await aliceAgain, await bob, 'callers for the new user share its run');
  assert.deepEqual(asked, ['alice', 'bob']);
  assert.equal(chrome.dump().leetcode.username, 'bob');
});

test('syncIfStale checks when the last check was for another username', async () => {
  // E.g. the first check for bob failed and left alice's state behind.
  chrome.reset({
    settings: settings({ leetcodeUsername: 'bob' }),
    leetcode: { username: 'alice', baselineAt: 1, seenIds: [], lastSyncAt: Date.now() - 10 * 1000 },
  });
  serve([]);
  assert.equal((await syncIfStale()).status, 'baseline');
  assert.equal(requests, 1);
  assert.equal(chrome.dump().leetcode.username, 'bob');
});

test('syncIfStale skips when the last check was under a minute ago', async () => {
  chrome.reset({
    settings: settings(),
    leetcode: { username: 'alice', baselineAt: 1, seenIds: [], lastSyncAt: Date.now() - 30 * 1000 },
  });
  serve([]);
  assert.equal((await syncIfStale()).status, 'fresh');
  assert.equal(requests, 0);

  chrome.reset({
    settings: settings(),
    leetcode: { username: 'alice', baselineAt: 1, seenIds: [], lastSyncAt: Date.now() - 2 * MIN },
  });
  assert.equal((await syncIfStale()).status, 'ok');
  assert.equal(requests, 1);
});

// importRecent

test('importRecent queues recent problems that are not tracked yet', async () => {
  const baselineAt = nowSec() - MIN;
  chrome.reset({
    settings: settings(),
    leetcode: { username: 'alice', baselineAt, seenIds: ['x'], lastSyncAt: baselineAt, lastError: null },
    problems: { 'two-sum': problem('two-sum', [Date.now() - 48 * HOUR]) },
  });
  const t = nowSec() - 10 * 24 * HOUR;
  serve([
    sub('4', 'lru-cache', t + 2 * HOUR, 'LRU Cache'),
    sub('3', 'two-sum', t + HOUR),
    sub('2', 'lru-cache', t, 'LRU Cache'),
    sub('1', 'valid-anagram', t - HOUR, 'Valid Anagram'),
  ]);

  assert.deepEqual(await importRecent(), { status: 'ok', added: 2 });
  const { pending, leetcode } = chrome.dump();
  assert.deepEqual(Object.keys(pending).sort(), ['lru-cache', 'valid-anagram']);
  assert.equal(pending['lru-cache'].submittedAt, t + 2 * HOUR); // real submission time, latest solve
  assert.equal(pending['lru-cache'].submissionId, '4');
  assert.equal(pending['valid-anagram'].source, 'leetcode');
  assert.deepEqual(leetcode.seenIds, ['x', '1', '2', '3', '4']);
  assert.equal(leetcode.baselineAt, baselineAt);

  // Already imported ids are seen, so a sync doesn't queue them again.
  const result = await syncLeetCode();
  assert.deepEqual([result.status, result.added], ['ok', 0]);
});

test('importRecent also queues an unchecked review of a tracked problem', async () => {
  // Solved two-sum (tracked) on another device 10 minutes ago; no check since.
  const t0 = nowSec();
  chrome.reset({
    settings: settings(),
    leetcode: { username: 'alice', baselineAt: t0 - 60 * HOUR, seenIds: ['9'], lastSyncAt: t0 - 14 * MIN },
    problems: { 'two-sum': problem('two-sum', [t0 - 72 * HOUR]) },
  });
  serve([sub('10', 'two-sum', t0 - 10 * MIN, 'Two Sum'), sub('9', 'lru-cache', t0 - 50 * HOUR, 'LRU Cache')]);

  assert.deepEqual(await importRecent(), { status: 'ok', added: 2 });
  const { pending, leetcode } = chrome.dump();
  assert.deepEqual(Object.keys(pending).sort(), ['lru-cache', 'two-sum']);
  assert.equal(pending['two-sum'].submissionId, '10');
  assert.deepEqual(leetcode.seenIds, ['9', '10']);

  // A tracked problem's solve from before the baseline, or already rated, isn't queued.
  chrome.reset({
    settings: settings(),
    leetcode: { username: 'alice', baselineAt: t0 - 5 * MIN, seenIds: [] },
    problems: { 'two-sum': problem('two-sum', [t0 - 72 * HOUR]), 'rated-today': problem('rated-today', [t0]) },
  });
  serve([sub('12', 'rated-today', t0 - MIN), sub('11', 'two-sum', t0 - 10 * MIN)]);
  assert.deepEqual(await importRecent(), { status: 'ok', added: 0 });
});

test('importRecent for a new username keeps ignoring its past reviews', async () => {
  const t0 = nowSec();
  chrome.reset({
    settings: settings({ leetcodeUsername: 'alice' }),
    leetcode: { username: 'old', baselineAt: 1, seenIds: [] },
    problems: { 'two-sum': problem('two-sum', [t0 - 72 * HOUR]) },
  });
  serve([sub('10', 'two-sum', t0 - 10 * MIN), sub('9', 'lru-cache', t0 - HOUR)]);
  assert.deepEqual(await importRecent(), { status: 'ok', added: 1 });
  assert.deepEqual(Object.keys(chrome.dump().pending), ['lru-cache']);
  assert.equal(chrome.dump().leetcode.baselineAt, t0 - 10 * MIN + 1000);
});

test('importRecent before any sync also sets the baseline', async () => {
  chrome.reset({ settings: settings() });
  serve([sub('1', 'two-sum', nowSec() - HOUR)]);
  assert.deepEqual(await importRecent(), { status: 'ok', added: 1 });
  const { leetcode } = chrome.dump();
  assert.equal(leetcode.username, 'alice');
  assert.ok(leetcode.baselineAt > nowSec() - HOUR);
  assert.deepEqual(leetcode.seenIds, ['1']);
  assert.equal((await syncLeetCode()).status, 'ok'); // not another baseline
});

test('importRecent reports unconfigured and errors', async () => {
  chrome.reset({ settings: settings({ leetcodeUsername: '' }) });
  assert.deepEqual(await importRecent(), { status: 'unconfigured', added: 0 });

  chrome.reset({ settings: settings() });
  serve([], () => new Response('nope', { status: 429 }));
  const result = await importRecent();
  assert.equal(result.status, 'error');
  assert.match(result.error, /limiting/);
  assert.equal(chrome.dump().pending, undefined);
});

// recordAcceptedFromPage

const pageSubmission = (patch = {}) => ({
  submissionId: '777',
  slug: 'two-sum',
  title: 'Two Sum',
  timestamp: Date.now() - 5000,
  ...patch,
});

test('a new Accepted submission from the page is queued', async () => {
  const state = { username: 'alice', baselineAt: Date.now() - HOUR, seenIds: ['1'], lastSyncAt: 1, lastError: null };
  chrome.reset({ settings: settings(), leetcode: state });
  const s = pageSubmission();
  assert.deepEqual(await recordAcceptedFromPage(s), { status: 'queued', pendingId: 'two-sum', tracked: false });

  const { pending, leetcode } = chrome.dump();
  assert.deepEqual(pending['two-sum'], {
    id: 'two-sum',
    title: 'Two Sum',
    url: 'https://leetcode.com/problems/two-sum/',
    submittedAt: s.timestamp,
    submissionId: '777',
    source: 'leetcode',
  });
  assert.deepEqual(leetcode.seenIds, ['1', '777']);
  assert.equal(leetcode.baselineAt, state.baselineAt);

  // The background check later sees the same id and leaves it alone.
  serve([sub('777', 'two-sum', Math.floor(s.timestamp / 1000) * 1000)]);
  const result = await syncLeetCode();
  assert.deepEqual([result.status, result.added, result.detected], ['ok', 0, []]);
});

test('an already-pending problem is still queued so the page shows the prompt', async () => {
  const earlier = Date.now() - HOUR;
  chrome.reset({
    settings: settings(),
    leetcode: { username: 'alice', baselineAt: 1, seenIds: ['700'] },
    pending: { 'two-sum': { id: 'two-sum', title: 'Two Sum', submittedAt: earlier, submissionId: '700' } },
    problems: { 'two-sum': problem('two-sum', [Date.now() - 72 * HOUR]) },
  });
  // Same submission reported twice, then a newer one.
  assert.equal(
    (await recordAcceptedFromPage(pageSubmission({ submissionId: '700', timestamp: earlier }))).status,
    'queued',
  );
  const result = await recordAcceptedFromPage(pageSubmission());
  assert.deepEqual(result, { status: 'queued', pendingId: 'two-sum', tracked: true });
  assert.equal(chrome.dump().pending['two-sum'].submissionId, '777');
});

test('a problem already rated that day is reported as already-rated', async () => {
  const at = Date.now() - 5000;
  chrome.reset({
    settings: settings(),
    leetcode: { username: 'alice', baselineAt: 1, seenIds: [] },
    problems: { 'two-sum': problem('two-sum', [at - 48 * HOUR, at]) },
  });
  const result = await recordAcceptedFromPage(pageSubmission({ timestamp: at }));
  assert.deepEqual(result, { status: 'already-rated', pendingId: 'two-sum', tracked: true });
  assert.equal(chrome.dump().pending, undefined);
  assert.deepEqual(chrome.dump().leetcode.seenIds, ['777']);
});

test('a submission that was already handled and dismissed is a duplicate', async () => {
  chrome.reset({
    settings: settings(),
    leetcode: { username: 'alice', baselineAt: Date.now() - HOUR, seenIds: ['777'] },
  });
  const result = await recordAcceptedFromPage(pageSubmission());
  assert.deepEqual(result, { status: 'duplicate', pendingId: 'two-sum', tracked: false });
  assert.equal(chrome.dump().pending, undefined);
});

test('an id seen only by the baseline is still queued', async () => {
  // The baseline check ran just after the submission landed, so it marked it seen.
  const s = pageSubmission();
  chrome.reset({
    settings: settings(),
    leetcode: { username: 'alice', baselineAt: s.timestamp + 1000, seenIds: ['777'] },
  });
  assert.equal((await recordAcceptedFromPage(s)).status, 'queued');
});

test('with no baseline yet, the page submission starts one', async () => {
  chrome.reset({ settings: settings() });
  const s = pageSubmission();
  assert.equal((await recordAcceptedFromPage(s)).status, 'queued');
  const { leetcode } = chrome.dump();
  assert.deepEqual(leetcode, { username: 'alice', baselineAt: s.timestamp, seenIds: ['777'] });

  // The first background check keeps it, and picks up later solves only.
  serve([
    sub('900', 'lru-cache', Math.ceil((s.timestamp + 1000) / 1000) * 1000),
    sub('777', 'two-sum', Math.floor(s.timestamp / 1000) * 1000),
    sub('100', 'old', s.timestamp - HOUR),
  ]);
  const result = await syncLeetCode();
  assert.equal(result.status, 'ok');
  assert.deepEqual(
    result.detected.map((d) => d.id),
    ['lru-cache'],
  );
});

test('page timestamps in seconds or missing are handled', async () => {
  chrome.reset({ settings: settings(), leetcode: { username: 'alice', baselineAt: 1, seenIds: [] } });
  const sec = Math.floor(Date.now() / 1000) - 10;
  await recordAcceptedFromPage(pageSubmission({ timestamp: sec }));
  assert.equal(chrome.dump().pending['two-sum'].submittedAt, sec * 1000);

  const before = Date.now();
  await recordAcceptedFromPage(pageSubmission({ slug: 'lru-cache', submissionId: 5, timestamp: undefined, title: '' }));
  const p = chrome.dump().pending['lru-cache'];
  assert.ok(p.submittedAt >= before);
  assert.equal(p.submissionId, '5');
  assert.equal(p.title, 'Lru Cache');

  await assert.rejects(recordAcceptedFromPage({ submissionId: '1' }));
});

// setDetectedUsername

test('setDetectedUsername fills an empty username and marks it auto', async () => {
  chrome.reset({ settings: { leetcodeUsername: '', leetcodeUsernameSource: null } });
  assert.deepEqual(await setDetectedUsername(' alice '), { changed: true });
  const s = chrome.dump().settings;
  assert.deepEqual([s.leetcodeUsername, s.leetcodeUsernameSource], ['alice', 'auto']);
  assert.equal(s.startTime, '09:00'); // other settings filled in and kept
});

test('setDetectedUsername replaces an auto-detected username', async () => {
  chrome.reset({ settings: { leetcodeUsername: 'alice', leetcodeUsernameSource: 'auto', startTime: '07:00' } });
  assert.deepEqual(await setDetectedUsername('bob'), { changed: true });
  const s = chrome.dump().settings;
  assert.deepEqual([s.leetcodeUsername, s.leetcodeUsernameSource, s.startTime], ['bob', 'auto', '07:00']);
  assert.deepEqual(await setDetectedUsername('bob'), { changed: false });
});

test('setDetectedUsername never overwrites a typed username', async () => {
  chrome.reset({ settings: { leetcodeUsername: 'alice', leetcodeUsernameSource: 'manual' } });
  assert.deepEqual(await setDetectedUsername('bob'), { changed: false });
  assert.equal(chrome.dump().settings.leetcodeUsername, 'alice');

  // A username with no recorded source is treated as typed.
  chrome.reset({ settings: { leetcodeUsername: 'alice' } });
  assert.deepEqual(await setDetectedUsername('bob'), { changed: false });

  // But a cleared one may be filled.
  chrome.reset({ settings: { leetcodeUsername: '', leetcodeUsernameSource: 'manual' } });
  assert.deepEqual(await setDetectedUsername('bob'), { changed: true });

  chrome.reset({ settings: { leetcodeUsername: '' } });
  assert.deepEqual(await setDetectedUsername('  '), { changed: false });
  assert.equal(chrome.dump().settings.leetcodeUsername, '');
});
