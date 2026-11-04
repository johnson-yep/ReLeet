import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalendarError } from '../lib/calendars/errors.js';
import {
  EXPIRY_MARGIN_MS,
  GRAPH_API,
  OUTLOOK_SCOPES,
  accountFromIdToken,
  base64url,
  createOutlookAuth,
  createOutlookProvider,
  createPkcePair,
  decodeJwtPayload,
  isOutlookConfigured,
  outlookEventBody,
  pkceChallenge,
} from '../lib/calendars/outlook.js';

const CLIENT_ID = '00001111-aaaa-2222-bbbb-3333cccc4444';
const REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';
const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const SCOPE = 'Calendars.ReadWrite offline_access openid profile';
const NOW = 1_800_000_000_000;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const empty = (status = 204) => new Response(null, { status });

const isCalendarError =
  (flags = {}) =>
  (err) => {
    assert.ok(err instanceof CalendarError, `expected CalendarError, got ${err?.stack ?? err}`);
    assert.equal(err.reconnect, flags.reconnect ?? false, `reconnect flag (${err.message})`);
    assert.equal(err.calendarMissing, flags.calendarMissing ?? false);
    assert.equal(err.notFound, flags.notFound ?? false);
    if (flags.message) assert.match(err.message, flags.message);
    return true;
  };

// Unsigned JWT with the given claims (the code never verifies it).
const jwt = (claims) =>
  [{ alg: 'none', typ: 'JWT' }, claims].map((p) => base64url(new TextEncoder().encode(JSON.stringify(p)))).join('.') +
  '.sig';

// ---- PKCE and token helpers ----

test('PKCE matches the RFC 7636 Appendix B example', async () => {
  const bytes = new Uint8Array([
    116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91,
    88, 5, 88, 83, 132, 141, 121,
  ]);
  assert.deepEqual(await createPkcePair(bytes), {
    verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  });
  assert.equal(
    await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('createPkcePair makes a fresh 43-character base64url verifier each time', async () => {
  const a = await createPkcePair();
  const b = await createPkcePair();
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.verifier, b.verifier);
  assert.equal(a.challenge, await pkceChallenge(a.verifier));
});

test('id_token claims are decoded (UTF-8, base64url) for display only', () => {
  const token = jwt({ preferred_username: 'zoë@outlook.com', name: 'Zoë ~?>' });
  assert.equal(decodeJwtPayload(token).name, 'Zoë ~?>');
  assert.equal(accountFromIdToken(token), 'zoë@outlook.com');
  assert.equal(accountFromIdToken(jwt({ email: 'a@b.c' })), 'a@b.c');
  assert.equal(accountFromIdToken('not-a-jwt'), null);
  assert.equal(accountFromIdToken(undefined), null);
});

test('isOutlookConfigured needs a client id', () => {
  assert.equal(isOutlookConfigured(''), false);
  assert.equal(isOutlookConfigured('  '), false);
  assert.equal(isOutlookConfigured(CLIENT_ID), true);
  assert.equal(isOutlookConfigured(), false); // lib/config.js ships empty
  assert.deepEqual(OUTLOOK_SCOPES, ['Calendars.ReadWrite', 'offline_access', 'openid', 'profile']);
});

// ---- sign-in ----

// A Microsoft identity platform stand-in: launchWebAuthFlow answers with
// `redirect(params)` and the /token endpoint with `tokenReply(form)`.
function harness({ stored = null, redirect, tokenReply, clock = NOW } = {}) {
  const h = {
    stored,
    saved: [],
    flows: [],
    tokenRequests: [],
    time: clock,
  };
  h.auth = createOutlookAuth({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    now: () => h.time,
    loadAuth: async () => structuredClone(h.stored),
    saveAuth: async (auth) => {
      h.saved.push(auth);
      h.stored = structuredClone(auth);
    },
    launchWebAuthFlow: async (details) => {
      h.flows.push(details);
      const url = new URL(details.url);
      const params = Object.fromEntries(url.searchParams);
      const reply = await redirect(params, details);
      return typeof reply === 'string' ? reply : `${REDIRECT}?${new URLSearchParams(reply)}`;
    },
    fetch: async (url, init) => {
      assert.equal(url, `${AUTHORITY}/token`);
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(typeof init.body, 'string');
      const form = Object.fromEntries(new URLSearchParams(init.body));
      assert.equal(form.client_secret, undefined); // public client
      h.tokenRequests.push(form);
      return tokenReply(form);
    },
  });
  return h;
}

const okCode = (params) => ({ code: 'the-code', state: params.state });
const tokens = (n, extra = {}) =>
  json({
    token_type: 'Bearer',
    scope: SCOPE,
    expires_in: 3599,
    access_token: `at-${n}`,
    refresh_token: `rt-${n}`,
    id_token: jwt({ preferred_username: 'me@outlook.com', name: 'Me' }),
    ...extra,
  });

test('signIn runs auth code + PKCE and saves the tokens', async () => {
  const h = harness({ redirect: okCode, tokenReply: () => tokens(1) });
  assert.deepEqual(await h.auth.signIn(true), { account: 'me@outlook.com' });

  const [flow] = h.flows;
  assert.equal(flow.interactive, true);
  const url = new URL(flow.url);
  assert.equal(url.origin + url.pathname, `${AUTHORITY}/authorize`);
  const q = Object.fromEntries(url.searchParams);
  assert.equal(q.client_id, CLIENT_ID);
  assert.equal(q.response_type, 'code');
  assert.equal(q.redirect_uri, REDIRECT);
  assert.equal(q.response_mode, 'query');
  assert.equal(q.scope, SCOPE);
  assert.equal(q.code_challenge_method, 'S256');
  assert.equal(q.prompt, 'select_account');
  assert.match(q.state, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(q.login_hint, undefined);

  const [form] = h.tokenRequests;
  assert.deepEqual(Object.keys(form).sort(), [
    'client_id',
    'code',
    'code_verifier',
    'grant_type',
    'redirect_uri',
    'scope',
  ]);
  assert.equal(form.client_id, CLIENT_ID);
  assert.equal(form.grant_type, 'authorization_code');
  assert.equal(form.code, 'the-code');
  assert.equal(form.redirect_uri, REDIRECT);
  assert.equal(form.scope, SCOPE);
  assert.equal(await pkceChallenge(form.code_verifier), q.code_challenge); // verifier matches the challenge

  assert.deepEqual(h.saved, [
    {
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: NOW + 3599 * 1000 - EXPIRY_MARGIN_MS,
      account: 'me@outlook.com',
    },
  ]);
});

test('each sign-in uses a new state and verifier', async () => {
  const h = harness({ redirect: okCode, tokenReply: () => tokens(1) });
  await h.auth.signIn(true);
  await h.auth.signIn(true);
  const [a, b] = h.flows.map((f) => new URL(f.url).searchParams);
  assert.notEqual(a.get('state'), b.get('state'));
  assert.notEqual(a.get('code_challenge'), b.get('code_challenge'));
  assert.notEqual(h.tokenRequests[0].code_verifier, h.tokenRequests[1].code_verifier);
});

test('signIn rejects a response with the wrong state and never redeems the code', async () => {
  const h = harness({ redirect: () => ({ code: 'stolen', state: 'someone-elses' }), tokenReply: () => tokens(1) });
  await assert.rejects(h.auth.signIn(true), isCalendarError({ reconnect: true, message: /did not match/ }));
  assert.equal(h.tokenRequests.length, 0);
  assert.deepEqual(h.saved, []);
});

test('signIn rejects a response with no state', async () => {
  const h = harness({ redirect: () => ({ code: 'c' }), tokenReply: () => tokens(1) });
  await assert.rejects(h.auth.signIn(true), isCalendarError({ reconnect: true, message: /did not match/ }));
  assert.equal(h.tokenRequests.length, 0);
});

test('signIn surfaces error_description from the redirect (first line only)', async () => {
  const h = harness({
    redirect: (params) => ({
      error: 'invalid_request',
      error_description:
        "AADSTS50011: The redirect URI 'x' does not match.\r\nTrace ID: 1\r\nCorrelation ID: 2\r\nTimestamp: 2026-01-01",
      state: params.state,
    }),
    tokenReply: () => tokens(1),
  });
  await assert.rejects(h.auth.signIn(true), (err) => {
    isCalendarError({ reconnect: true })(err);
    assert.equal(err.message, "Microsoft sign-in failed: AADSTS50011: The redirect URI 'x' does not match.");
    return true;
  });
  assert.equal(h.tokenRequests.length, 0);
});

test('signIn reads a fragment response too', async () => {
  const h = harness({
    redirect: (params) => `${REDIRECT}#${new URLSearchParams({ code: 'frag-code', state: params.state })}`,
    tokenReply: () => tokens(1),
  });
  await h.auth.signIn(true);
  assert.equal(h.tokenRequests[0].code, 'frag-code');
});

test('signIn: closing the window → reconnect error', async () => {
  const h = harness({
    redirect: () => {
      throw new Error('The user did not approve access.');
    },
    tokenReply: () => tokens(1),
  });
  await assert.rejects(h.auth.signIn(true), isCalendarError({ reconnect: true, message: /did not approve/ }));
});

test('signIn: token endpoint error is shown', async () => {
  const h = harness({
    redirect: okCode,
    tokenReply: () =>
      json(
        {
          error: 'invalid_request',
          error_description:
            "AADSTS9002326: Cross-origin token redemption is permitted only for the 'Single-Page Application' client-type.\r\nTrace ID: x",
        },
        400,
      ),
  });
  await assert.rejects(
    h.auth.signIn(true),
    isCalendarError({ reconnect: true, message: /AADSTS9002326.*Single-Page Application/ }),
  );
  assert.deepEqual(h.saved, []);
});

test('signIn without a client id explains the setup step', async () => {
  const flows = [];
  const auth = createOutlookAuth({
    clientId: '',
    redirectUri: REDIRECT,
    launchWebAuthFlow: async (d) => flows.push(d),
    fetch: async () => assert.fail('no request expected'),
    loadAuth: async () => null,
    saveAuth: async () => {},
  });
  await assert.rejects(auth.signIn(true), isCalendarError({ message: /client ID.*SETUP\.md/ }));
  assert.equal(flows.length, 0);
});

// ---- access tokens ----

const fresh = { accessToken: 'at-0', refreshToken: 'rt-0', expiresAt: NOW + 60_000, account: 'me@outlook.com' };
const expired = { ...fresh, expiresAt: NOW - 1 };

test('getAccessToken returns the stored token while it is fresh', async () => {
  const h = harness({
    stored: fresh,
    redirect: () => assert.fail('no flow'),
    tokenReply: () => assert.fail('no request'),
  });
  assert.equal(await h.auth.getAccessToken(), 'at-0');
});

test('getAccessToken refreshes an expired token and saves the rotated refresh token', async () => {
  const h = harness({ stored: expired, redirect: () => assert.fail('no flow'), tokenReply: () => tokens(1) });
  assert.equal(await h.auth.getAccessToken(), 'at-1');
  assert.deepEqual(h.tokenRequests, [
    { client_id: CLIENT_ID, scope: SCOPE, grant_type: 'refresh_token', refresh_token: 'rt-0' },
  ]);
  assert.deepEqual(h.stored, {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: NOW + 3599 * 1000 - EXPIRY_MARGIN_MS,
    account: 'me@outlook.com',
  });
  // The new token is now used without another request.
  assert.equal(await h.auth.getAccessToken(), 'at-1');
  assert.equal(h.tokenRequests.length, 1);
});

test('getAccessToken treats a token inside the safety margin as expired', async () => {
  let n = 0;
  const h = harness({
    stored: { ...fresh, expiresAt: NOW },
    redirect: () => assert.fail('no flow'),
    tokenReply: () => tokens(++n),
  });
  assert.equal(await h.auth.getAccessToken(), 'at-1');
  // Saved expiry is moved earlier by the margin…
  assert.equal(h.stored.expiresAt, NOW + 3599e3 - EXPIRY_MARGIN_MS);
  h.time = h.stored.expiresAt - 1;
  assert.equal(await h.auth.getAccessToken(), 'at-1');
  h.time = h.stored.expiresAt; // …and from then on it refreshes.
  assert.equal(await h.auth.getAccessToken(), 'at-2');
  assert.equal(h.tokenRequests[1].refresh_token, 'rt-1'); // with the rotated refresh token
});

test('a short-lived token keeps half its lifetime instead of going negative', async () => {
  const h = harness({
    stored: expired,
    redirect: () => assert.fail('no flow'),
    tokenReply: () => tokens(1, { expires_in: 120 }),
  });
  await h.auth.getAccessToken();
  assert.equal(h.stored.expiresAt, NOW + 60_000);
});

test('refresh without a new refresh_token keeps the old one and the account', async () => {
  const h = harness({
    stored: expired,
    redirect: () => assert.fail('no flow'),
    tokenReply: () => tokens(1, { refresh_token: undefined, id_token: undefined }),
  });
  await h.auth.getAccessToken();
  assert.equal(h.stored.refreshToken, 'rt-0');
  assert.equal(h.stored.account, 'me@outlook.com');
});

test('forceRefresh refreshes even a fresh token (after a 401)', async () => {
  const h = harness({ stored: fresh, redirect: () => assert.fail('no flow'), tokenReply: () => tokens(1) });
  assert.equal(await h.auth.getAccessToken({ forceRefresh: true }), 'at-1');
  assert.equal(h.tokenRequests.length, 1);
});

test('concurrent callers share one refresh', async () => {
  const h = harness({ stored: expired, redirect: () => assert.fail('no flow'), tokenReply: () => tokens(1) });
  const results = await Promise.all([h.auth.getAccessToken(), h.auth.getAccessToken(), h.auth.getAccessToken()]);
  assert.deepEqual(results, ['at-1', 'at-1', 'at-1']);
  assert.equal(h.tokenRequests.length, 1);
});

const spaExpired = () =>
  json(
    {
      error: 'invalid_grant',
      error_description:
        'AADSTS700084: The refresh token was issued to a single page app (SPA), and therefore has a fixed, limited lifetime of 1.00:00:00.',
      error_codes: [700084],
    },
    400,
  );

test('expired SPA refresh token → silent re-auth (prompt=none) → new tokens', async () => {
  const h = harness({
    stored: expired,
    redirect: okCode,
    tokenReply: (form) => (form.grant_type === 'refresh_token' ? spaExpired() : tokens(2)),
  });
  assert.equal(await h.auth.getAccessToken(), 'at-2');

  const [flow] = h.flows;
  assert.equal(flow.interactive, false);
  assert.equal(flow.abortOnLoadForNonInteractive, false);
  assert.equal(typeof flow.timeoutMsForNonInteractive, 'number');
  const q = new URL(flow.url).searchParams;
  assert.equal(q.get('prompt'), 'none');
  assert.equal(q.get('login_hint'), 'me@outlook.com');
  assert.deepEqual(
    h.tokenRequests.map((f) => f.grant_type),
    ['refresh_token', 'authorization_code'],
  );
  assert.equal(h.stored.refreshToken, 'rt-2');
});

test('silent re-auth that needs the user → reconnect', async () => {
  const h = harness({
    stored: expired,
    redirect: (params) => ({
      error: 'login_required',
      error_description: 'AADSTS50058: no session',
      state: params.state,
    }),
    tokenReply: () => spaExpired(),
  });
  await assert.rejects(
    h.auth.getAccessToken(),
    isCalendarError({ reconnect: true, message: /Reconnect Outlook in Settings/ }),
  );
  assert.equal(h.tokenRequests.length, 1); // only the failed refresh
});

test('silent re-auth rejected by Chrome → reconnect', async () => {
  const h = harness({
    stored: expired,
    redirect: () => {
      throw new Error('User interaction required.');
    },
    tokenReply: () => spaExpired(),
  });
  await assert.rejects(h.auth.getAccessToken(), isCalendarError({ reconnect: true }));
});

test('silent re-auth also runs when there is no refresh token', async () => {
  const h = harness({ stored: { ...expired, refreshToken: null }, redirect: okCode, tokenReply: () => tokens(3) });
  assert.equal(await h.auth.getAccessToken(), 'at-3');
  assert.deepEqual(
    h.tokenRequests.map((f) => f.grant_type),
    ['authorization_code'],
  );
});

test('refresh that fails offline is a plain error and keeps the tokens', async () => {
  const auth = createOutlookAuth({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    now: () => NOW,
    loadAuth: async () => expired,
    saveAuth: async () => assert.fail('nothing to save'),
    launchWebAuthFlow: async () => assert.fail('no silent flow while offline'),
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await assert.rejects(
    auth.getAccessToken(),
    isCalendarError({ reconnect: false, message: /Couldn't reach Microsoft/ }),
  );
});

test('refresh that hits a Microsoft outage is a plain error', async () => {
  const h = harness({ stored: expired, redirect: () => assert.fail('no flow'), tokenReply: () => json({}, 503) });
  await assert.rejects(h.auth.getAccessToken(), isCalendarError({ reconnect: false, message: /HTTP 503/ }));
});

test('silent sign-in page that cannot load (offline) is a plain error', async () => {
  const h = harness({
    stored: expired,
    redirect: () => {
      throw new Error('Authorization page could not be loaded.');
    },
    tokenReply: () => spaExpired(),
  });
  await assert.rejects(h.auth.getAccessToken(), isCalendarError({ reconnect: false }));
});

test('getAccessToken with nothing stored → reconnect', async () => {
  const h = harness({ redirect: () => assert.fail('no flow'), tokenReply: () => assert.fail('no request') });
  await assert.rejects(h.auth.getAccessToken(), isCalendarError({ reconnect: true }));
});

test('getAccount and signOut', async () => {
  const h = harness({ stored: fresh, redirect: okCode, tokenReply: () => tokens(1) });
  assert.equal(await h.auth.getAccount(), 'me@outlook.com');
  await h.auth.signOut();
  assert.equal(h.stored, null);
  assert.equal(await h.auth.getAccount(), null);
});

test('createOutlookAuth defaults to chrome.identity for the flow and redirect URL', async () => {
  const flows = [];
  globalThis.chrome = {
    identity: {
      getRedirectURL: () => REDIRECT,
      launchWebAuthFlow: async (details) => {
        flows.push(details);
        return `${REDIRECT}?error=access_denied&state=${new URL(details.url).searchParams.get('state')}`;
      },
    },
  };
  try {
    const auth = createOutlookAuth({
      clientId: CLIENT_ID,
      fetch: async () => assert.fail('no request'),
      loadAuth: async () => null,
      saveAuth: async () => {},
    });
    await assert.rejects(auth.signIn(true), isCalendarError({ reconnect: true, message: /access_denied/ }));
    assert.equal(new URL(flows[0].url).searchParams.get('redirect_uri'), REDIRECT);
  } finally {
    delete globalThis.chrome;
  }
});

// ---- Graph provider ----

const CAL = 'AAMkAGI2TG93AAA=';
const slot = {
  problemId: 'two-sum',
  day: '2026-11-05',
  start: Date.UTC(2026, 10, 5, 8, 0),
  end: Date.UTC(2026, 10, 5, 8, 40),
  title: 'Review: Two Sum',
  description: 'Review Two Sum (last rated Medium).\nhttps://leetcode.com/problems/two-sum/\n\nScheduled by ReLeet.',
  url: 'https://leetcode.com/problems/two-sum/',
  rating: 'medium',
  reminderMinutes: 15,
};
const expectedEventBody = {
  subject: 'Review: Two Sum',
  body: { contentType: 'text', content: slot.description },
  start: { dateTime: '2026-11-05T08:00:00', timeZone: 'UTC' },
  end: { dateTime: '2026-11-05T08:40:00', timeZone: 'UTC' },
  isReminderOn: true,
  reminderMinutesBeforeStart: 15,
  showAs: 'busy',
};
const graphError = (status, code, headers = {}) =>
  json({ error: { code, message: `${code} message` } }, status, headers);

// Same idea as in google.test.js: every request is checked in order.
function scriptedFetch(steps) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const step = steps[calls.length];
    calls.push({ url, init });
    assert.ok(step, `unexpected request ${init.method} ${url}`);
    assert.equal(init.method, step.method);
    assert.equal(url, step.url);
    assert.equal(init.headers.Authorization, `Bearer ${step.token ?? 'gt-1'}`);
    assert.equal(init.headers.Accept, 'application/json');
    if ('json' in step) {
      assert.equal(init.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(init.body), step.json);
    } else {
      assert.equal(init.body, undefined);
    }
    if (step.respond instanceof Error) throw step.respond;
    return step.respond;
  };
  fn.calls = calls;
  fn.assertDone = () => assert.equal(calls.length, steps.length, 'not every expected request was made');
  return fn;
}

function provider(steps, extra = {}) {
  const fetch = scriptedFetch(steps);
  const tokenCalls = [];
  let n = 0;
  const p = createOutlookProvider({
    getAccessToken: async (opts) => {
      tokenCalls.push(opts);
      if (opts?.forceRefresh) n++;
      return `gt-${n + 1}`;
    },
    fetch,
    ...extra,
  });
  return { p, fetch, tokenCalls };
}

test('event body uses UTC date-times, a text body, a reminder and busy', () => {
  assert.deepEqual(outlookEventBody(slot), expectedEventBody);
  const noReminder = outlookEventBody({ ...slot, reminderMinutes: null });
  assert.equal(noReminder.isReminderOn, false);
  assert.equal('reminderMinutesBeforeStart' in noReminder, false);
});

test('ensureCalendar(null) creates the ReLeet calendar', async () => {
  const { p, fetch } = provider([
    {
      method: 'POST',
      url: `${GRAPH_API}/me/calendars`,
      json: { name: 'ReLeet' },
      respond: json({ id: CAL, name: 'ReLeet' }, 201),
    },
  ]);
  assert.equal(p.name, 'outlook');
  assert.equal(await p.ensureCalendar(null), CAL);
  fetch.assertDone();
});

test('ensureCalendar(id) keeps an existing calendar', async () => {
  const { p, fetch } = provider([
    {
      method: 'GET',
      url: `${GRAPH_API}/me/calendars/${encodeURIComponent(CAL)}?$select=id`,
      respond: json({ id: CAL }),
    },
  ]);
  assert.equal(await p.ensureCalendar(CAL), CAL);
  fetch.assertDone();
});

test('ensureCalendar(id) recreates a deleted calendar', async () => {
  const { p, fetch } = provider([
    {
      method: 'GET',
      url: `${GRAPH_API}/me/calendars/${encodeURIComponent(CAL)}?$select=id`,
      respond: graphError(404, 'ErrorItemNotFound'),
    },
    { method: 'POST', url: `${GRAPH_API}/me/calendars`, json: { name: 'ReLeet' }, respond: json({ id: 'NEW' }, 201) },
  ]);
  assert.equal(await p.ensureCalendar(CAL), 'NEW');
  fetch.assertDone();
});

for (const status of [409, 400]) {
  test(`ensureCalendar reuses an existing "ReLeet" calendar on ErrorFolderExists (${status})`, async () => {
    const { p, fetch } = provider([
      {
        method: 'POST',
        url: `${GRAPH_API}/me/calendars`,
        json: { name: 'ReLeet' },
        respond: graphError(status, 'ErrorFolderExists'),
      },
      {
        method: 'GET',
        url: `${GRAPH_API}/me/calendars?$select=id,name&$top=100`,
        respond: json({
          value: [{ id: 'A', name: 'Calendar' }],
          '@odata.nextLink': `${GRAPH_API}/me/calendars?$select=id,name&$top=100&$skip=100`,
        }),
      },
      {
        method: 'GET',
        url: `${GRAPH_API}/me/calendars?$select=id,name&$top=100&$skip=100`,
        respond: json({
          value: [
            { id: 'B', name: 'Birthdays' },
            { id: 'R', name: 'releet' },
          ],
        }),
      },
    ]);
    assert.equal(await p.ensureCalendar(null), 'R');
    fetch.assertDone();
  });
}

test('ensureCalendar: other 400s are errors', async () => {
  const { p } = provider([
    {
      method: 'POST',
      url: `${GRAPH_API}/me/calendars`,
      json: { name: 'ReLeet' },
      respond: graphError(400, 'ErrorInvalidRequest'),
    },
  ]);
  await assert.rejects(p.ensureCalendar(null), isCalendarError({ message: /ErrorInvalidRequest message/ }));
});

test('createEvent posts into the ReLeet calendar', async () => {
  const { p, fetch } = provider([
    {
      method: 'POST',
      url: `${GRAPH_API}/me/calendars/${encodeURIComponent(CAL)}/events`,
      json: expectedEventBody,
      respond: json({ id: 'EVT=' }, 201),
    },
  ]);
  assert.deepEqual(await p.createEvent(CAL, slot), { id: 'EVT=' });
  fetch.assertDone();
});

test('createEvent on a deleted calendar → calendarMissing', async () => {
  const { p } = provider([
    {
      method: 'POST',
      url: `${GRAPH_API}/me/calendars/${encodeURIComponent(CAL)}/events`,
      json: expectedEventBody,
      respond: graphError(404, 'ErrorItemNotFound'),
    },
  ]);
  await assert.rejects(p.createEvent(CAL, slot), isCalendarError({ calendarMissing: true }));
});

test('listEvents finds ReLeet events by their description, page by page, leaving others alone', async () => {
  const FROM = Date.UTC(2026, 10, 4, 12);
  const first =
    `${GRAPH_API}/me/calendars/${encodeURIComponent(CAL)}/calendarView` +
    '?startDateTime=2026-11-04T12%3A00%3A00.000Z&endDateTime=2027-12-09T12%3A00%3A00.000Z&$select=id,body&$top=100';
  const next = `${GRAPH_API}/me/calendars/${encodeURIComponent(CAL)}/calendarView?$skip=100`;
  const { p, fetch } = provider([
    {
      method: 'GET',
      url: first,
      respond: json({
        value: [
          { id: 'E1', body: { contentType: 'text', content: slot.description } },
          { id: 'MINE?', body: { contentType: 'text', content: 'Lunch with Sam' } },
        ],
        '@odata.nextLink': next,
      }),
    },
    {
      method: 'GET',
      url: next,
      respond: json({
        value: [
          // Graph may answer in HTML even when asked for text.
          {
            id: 'E2',
            body: { contentType: 'html', content: '<html><body><div>Review X<br><br>Scheduled&nbsp;by ReLeet.</div></body></html>' },
          },
        ],
      }),
    },
  ]);
  assert.deepEqual(await p.listEvents(CAL, FROM), [{ id: 'E1' }, { id: 'E2' }]);
  fetch.assertDone();
  for (const call of fetch.calls) assert.equal(call.init.headers.Prefer, 'outlook.body-content-type="text"');
});

test('listEvents: nothing to ask about a calendar it just made; a deleted one is calendarMissing', async () => {
  const { p, fetch } = provider([
    { method: 'POST', url: `${GRAPH_API}/me/calendars`, json: { name: 'ReLeet' }, respond: json({ id: 'NEW' }, 201) },
    {
      method: 'GET',
      url:
        `${GRAPH_API}/me/calendars/${encodeURIComponent(CAL)}/calendarView` +
        '?startDateTime=1970-01-01T00%3A00%3A00.000Z&endDateTime=1971-02-05T00%3A00%3A00.000Z&$select=id,body&$top=100',
      respond: graphError(404, 'ErrorItemNotFound'),
    },
  ]);
  assert.equal(await p.ensureCalendar(null), 'NEW');
  assert.deepEqual(await p.listEvents('NEW', 0), []);
  await assert.rejects(p.listEvents(CAL, 0), isCalendarError({ calendarMissing: true }));
  fetch.assertDone();
});

test('updateEvent patches /me/events/{id}', async () => {
  const { p, fetch } = provider([
    { method: 'PATCH', url: `${GRAPH_API}/me/events/EVT%3D`, json: expectedEventBody, respond: json({ id: 'EVT=' }) },
  ]);
  assert.deepEqual(await p.updateEvent(CAL, { id: 'EVT=' }, slot), { id: 'EVT=' });
  fetch.assertDone();
});

test('updateEvent on a deleted event → notFound', async () => {
  const { p } = provider([
    {
      method: 'PATCH',
      url: `${GRAPH_API}/me/events/EVT`,
      json: expectedEventBody,
      respond: graphError(404, 'ErrorItemNotFound'),
    },
  ]);
  await assert.rejects(p.updateEvent(CAL, { id: 'EVT' }, slot), isCalendarError({ notFound: true }));
});

for (const status of [204, 404]) {
  test(`deleteEvent and deleteCalendar succeed on ${status}`, async () => {
    const reply = () => (status === 204 ? empty() : graphError(404, 'ErrorItemNotFound'));
    const { p, fetch } = provider([
      { method: 'DELETE', url: `${GRAPH_API}/me/events/EVT`, respond: reply() },
      { method: 'DELETE', url: `${GRAPH_API}/me/calendars/${encodeURIComponent(CAL)}`, respond: reply() },
    ]);
    assert.equal(await p.deleteEvent(CAL, { id: 'EVT' }), undefined);
    assert.equal(await p.deleteCalendar(CAL), undefined);
    fetch.assertDone();
  });
}

test('401 → one retry with a force-refreshed token', async () => {
  const { p, fetch, tokenCalls } = provider([
    {
      method: 'DELETE',
      url: `${GRAPH_API}/me/events/EVT`,
      token: 'gt-1',
      respond: graphError(401, 'InvalidAuthenticationToken'),
    },
    { method: 'DELETE', url: `${GRAPH_API}/me/events/EVT`, token: 'gt-2', respond: empty() },
  ]);
  await p.deleteEvent(CAL, { id: 'EVT' });
  fetch.assertDone();
  assert.deepEqual(tokenCalls, [{ forceRefresh: false }, { forceRefresh: true }]);
});

test('401 twice → reconnect', async () => {
  const { p } = provider([
    {
      method: 'DELETE',
      url: `${GRAPH_API}/me/events/EVT`,
      token: 'gt-1',
      respond: graphError(401, 'InvalidAuthenticationToken'),
    },
    {
      method: 'DELETE',
      url: `${GRAPH_API}/me/events/EVT`,
      token: 'gt-2',
      respond: graphError(401, 'InvalidAuthenticationToken'),
    },
  ]);
  await assert.rejects(p.deleteEvent(CAL, { id: 'EVT' }), isCalendarError({ reconnect: true }));
});

test('a reconnect error from getAccessToken passes through', async () => {
  const signedOut = new CalendarError('Outlook sign-in expired.', { reconnect: true });
  const p = createOutlookProvider({
    getAccessToken: async () => {
      throw signedOut;
    },
    fetch: scriptedFetch([]),
  });
  await assert.rejects(p.ensureCalendar(null), (err) => err === signedOut);
});

test('429 and 503 are plain errors (with Retry-After in the message)', async () => {
  const { p } = provider([
    {
      method: 'DELETE',
      url: `${GRAPH_API}/me/events/EVT`,
      respond: graphError(429, 'TooManyRequests', { 'Retry-After': '12' }),
    },
    { method: 'DELETE', url: `${GRAPH_API}/me/events/EVT`, respond: graphError(503, 'ServiceUnavailable') },
    { method: 'DELETE', url: `${GRAPH_API}/me/events/EVT`, respond: graphError(500, 'InternalServerError') },
  ]);
  await assert.rejects(p.deleteEvent(CAL, { id: 'EVT' }), isCalendarError({ message: /about 12 s/ }));
  await assert.rejects(p.deleteEvent(CAL, { id: 'EVT' }), isCalendarError({ message: /limiting requests/ }));
  await assert.rejects(p.deleteEvent(CAL, { id: 'EVT' }), isCalendarError({ message: /HTTP 500/ }));
});

test('403 and accounts without a mailbox → reconnect', async () => {
  const { p } = provider([
    {
      method: 'POST',
      url: `${GRAPH_API}/me/calendars`,
      json: { name: 'ReLeet' },
      respond: graphError(403, 'ErrorAccessDenied'),
    },
    {
      method: 'POST',
      url: `${GRAPH_API}/me/calendars`,
      json: { name: 'ReLeet' },
      respond: graphError(404, 'MailboxNotEnabledForRESTAPI'),
    },
  ]);
  await assert.rejects(p.ensureCalendar(null), isCalendarError({ reconnect: true }));
  await assert.rejects(p.ensureCalendar(null), isCalendarError({ reconnect: true, message: /no Outlook calendar/ }));
});

test('network failure is a plain error', async () => {
  const { p } = provider([
    { method: 'DELETE', url: `${GRAPH_API}/me/events/EVT`, respond: new TypeError('Failed to fetch') },
  ]);
  await assert.rejects(p.deleteEvent(CAL, { id: 'EVT' }), isCalendarError({ message: /Couldn't reach Outlook/ }));
});

test('describeAccount uses getAccount', async () => {
  assert.equal(await provider([], { getAccount: async () => 'me@outlook.com' }).p.describeAccount(), 'me@outlook.com');
  assert.equal(await provider([]).p.describeAccount(), null);
});
