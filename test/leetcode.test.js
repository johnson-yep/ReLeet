import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeetCodeClient, LeetCodeError, LEETCODE_ORIGIN } from '../lib/leetcode.js';

// Records each request and answers with the given Response (or function → Response).
function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return typeof respond === 'function' ? respond(url, init) : respond.clone();
  };
  fn.calls = calls;
  return fn;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const html = (status) => new Response('<!DOCTYPE html><title>Just a moment...</title>', { status });

const recentBody = (list, matchedUser = { username: 'alice' }) => ({
  data: { matchedUser, recentAcSubmissionList: list },
});

test('recentAccepted posts the GraphQL query and maps fields', async () => {
  const fetch = fakeFetch(
    json(
      recentBody([
        { id: '1234567890', title: 'Two Sum', titleSlug: 'two-sum', timestamp: '1762250000' },
        { id: 99, title: 'LRU Cache', titleSlug: 'lru-cache', timestamp: '1762240000' },
      ]),
    ),
  );
  const client = createLeetCodeClient({ fetch });
  const list = await client.recentAccepted(' alice ', 10);

  assert.deepEqual(list, [
    { submissionId: '1234567890', slug: 'two-sum', title: 'Two Sum', timestamp: 1762250000000 },
    { submissionId: '99', slug: 'lru-cache', title: 'LRU Cache', timestamp: 1762240000000 },
  ]);
  const [{ url, init, body }] = fetch.calls;
  assert.equal(url, `${LEETCODE_ORIGIN}/graphql`);
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(body.variables, { username: 'alice', limit: 10 });
  assert.match(body.query, /recentAcSubmissionList\(username: \$username, limit: \$limit\)/);
  assert.match(body.query, /\{ id title titleSlug timestamp \}/);
});

test('recentAccepted defaults to 20 and honours origin, headers and credentials', async () => {
  const fetch = fakeFetch(json(recentBody([])));
  const client = createLeetCodeClient({
    fetch,
    origin: 'https://example.test',
    headers: { 'x-csrftoken': 'abc' },
    credentials: 'include',
  });
  assert.deepEqual(await client.recentAccepted('alice'), []);
  const [{ url, init, body }] = fetch.calls;
  assert.equal(url, 'https://example.test/graphql');
  assert.equal(init.headers['x-csrftoken'], 'abc');
  assert.equal(init.credentials, 'include');
  assert.equal(body.variables.limit, 20);
});

test('recentAccepted drops malformed entries', async () => {
  const fetch = fakeFetch(
    json(
      recentBody([
        { id: '1', title: 'Two Sum', titleSlug: 'two-sum', timestamp: '1762250000' },
        { id: '2', title: 'No slug', titleSlug: '', timestamp: '1762250000' },
        { id: null, title: 'No id', titleSlug: 'no-id', timestamp: '1762250000' },
        { id: '3', title: 'Bad time', titleSlug: 'bad-time', timestamp: 'soon' },
      ]),
    ),
  );
  const list = await createLeetCodeClient({ fetch }).recentAccepted('alice');
  assert.deepEqual(
    list.map((s) => s.slug),
    ['two-sum'],
  );
});

test('an unknown user is a clear LeetCodeError', async () => {
  const fetch = fakeFetch(
    json({
      errors: [{ message: 'That user does not exist.', path: ['matchedUser'] }],
      data: { matchedUser: null, recentAcSubmissionList: [] },
    }),
  );
  await assert.rejects(createLeetCodeClient({ fetch }).recentAccepted('nobody'), (e) => {
    assert.ok(e instanceof LeetCodeError);
    assert.equal(e.message, 'LeetCode user "nobody" not found.');
    return true;
  });

  // Same when LeetCode drops data entirely and only sends the error.
  const bare = fakeFetch(json({ errors: [{ message: 'That user does not exist.' }], data: null }));
  await assert.rejects(createLeetCodeClient({ fetch: bare }).recentAccepted('nobody'), /not found/);
});

test('other GraphQL errors surface their message', async () => {
  const fetch = fakeFetch(json({ errors: [{ message: 'Something broke' }], data: null }));
  await assert.rejects(createLeetCodeClient({ fetch }).recentAccepted('alice'), {
    name: 'LeetCodeError',
    message: 'LeetCode: Something broke',
  });
});

test('HTTP errors map to short messages with the status', async () => {
  const cases = [
    [html(403), 403, /blocked/],
    [json({}, 429), 429, /limiting requests/],
    [html(503), 503, /HTTP 503/],
    [json({ errors: [{ message: 'Bad query' }] }, 400), 400, /^LeetCode: Bad query$/],
    [html(404), 404, /HTTP 404/],
  ];
  for (const [response, status, message] of cases) {
    const client = createLeetCodeClient({ fetch: fakeFetch(response) });
    await assert.rejects(client.recentAccepted('alice'), (e) => {
      assert.ok(e instanceof LeetCodeError);
      assert.equal(e.status, status);
      assert.match(e.message, message);
      return true;
    });
  }
});

test('a non-JSON 200 (e.g. a Cloudflare page) is an unexpected response', async () => {
  const client = createLeetCodeClient({ fetch: fakeFetch(html(200)) });
  await assert.rejects(client.recentAccepted('alice'), { name: 'LeetCodeError', message: /unexpected response/ });
});

test('network failures and timeouts are LeetCodeErrors', async () => {
  const offline = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(createLeetCodeClient({ fetch: offline }).recentAccepted('alice'), {
    name: 'LeetCodeError',
    message: /Couldn't reach LeetCode/,
  });

  // Never answers; only the abort signal ends it. AbortSignal.timeout's timer
  // doesn't keep Node alive, so hold the event loop open meanwhile.
  const keepAlive = setTimeout(() => {}, 1000);
  const hang = (_url, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  await assert.rejects(createLeetCodeClient({ fetch: hang, timeoutMs: 20 }).recentAccepted('alice'), {
    name: 'LeetCodeError',
    message: /didn't respond in time/,
  });
  clearTimeout(keepAlive);
});

test('empty username is rejected without a request', async () => {
  const fetch = fakeFetch(json(recentBody([])));
  await assert.rejects(createLeetCodeClient({ fetch }).recentAccepted('  '), LeetCodeError);
  assert.equal(fetch.calls.length, 0);
});

test('signedInUser reads userStatus', async () => {
  const signedIn = fakeFetch(json({ data: { userStatus: { username: 'alice', isSignedIn: true } } }));
  assert.deepEqual(await createLeetCodeClient({ fetch: signedIn }).signedInUser(), {
    username: 'alice',
    isSignedIn: true,
  });
  assert.match(signedIn.calls[0].body.query, /userStatus \{ username isSignedIn \}/);

  const anonymous = fakeFetch(json({ data: { userStatus: { username: '', isSignedIn: false } } }));
  assert.deepEqual(await createLeetCodeClient({ fetch: anonymous }).signedInUser(), {
    username: null,
    isSignedIn: false,
  });

  const broken = fakeFetch(json({ data: {} }));
  await assert.rejects(createLeetCodeClient({ fetch: broken }).signedInUser(), LeetCodeError);
});

test('questionTitle looks up the real title of a problem, or null when there is none', async () => {
  const fetch = fakeFetch((url, init) => {
    const { variables } = JSON.parse(init.body);
    return json({ data: { question: variables.titleSlug === 'lru-cache' ? { title: 'LRU Cache', titleSlug: 'lru-cache' } : null } });
  });
  const client = createLeetCodeClient({ fetch });
  assert.equal(await client.questionTitle('lru-cache'), 'LRU Cache');
  assert.equal(await client.questionTitle('not-a-problem'), null);
  assert.match(fetch.calls[0].body.query, /question\(titleSlug: \$titleSlug\)/);
  assert.equal(fetch.calls[0].init.credentials, 'omit');
  await assert.rejects(createLeetCodeClient({ fetch: fakeFetch(html(503)) }).questionTitle('x'), LeetCodeError);
});
