import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { CalendarError } from '../lib/calendars/errors.js';
import {
  GOOGLE_API,
  GOOGLE_SCOPES,
  chromeGoogleAuth,
  createGoogleProvider,
  googleEventBody,
  isGoogleClientIdConfigured,
} from '../lib/calendars/google.js';

const CAL = 'abc123@group.calendar.google.com';
const CAL_PATH = `/calendars/${encodeURIComponent(CAL)}`;

const slot = {
  problemId: 'two-sum',
  day: '2026-11-05',
  start: Date.UTC(2026, 10, 5, 8, 0),
  end: Date.UTC(2026, 10, 5, 8, 20),
  title: 'Review: Two Sum',
  description: 'Review Two Sum (last rated Easy).\nhttps://leetcode.com/problems/two-sum/\n\nScheduled by ReLeet.',
  url: 'https://leetcode.com/problems/two-sum/',
  rating: 'easy',
  reminderMinutes: 15,
};

const expectedEventBody = {
  summary: 'Review: Two Sum',
  description: slot.description,
  start: { dateTime: '2026-11-05T08:00:00.000Z' },
  end: { dateTime: '2026-11-05T08:20:00.000Z' },
  reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
  transparency: 'opaque',
  extendedProperties: { private: { releetProblemId: 'two-sum' } },
  source: { title: 'ReLeet', url: 'https://leetcode.com/problems/two-sum/' },
};

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const empty = (status = 204) => new Response(null, { status });
const googleError = (status, reason, extra = {}) =>
  json(
    { error: { code: status, message: `${reason} message`, errors: [{ reason, domain: 'global' }], ...extra } },
    status,
  );

// Each step: { method, url, token?, json?, respond: Response | Error }. Asserts
// every request in order: method, URL, Authorization header and JSON body.
function scriptedFetch(steps) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const step = steps[calls.length];
    calls.push({ url, init });
    assert.ok(step, `unexpected request ${init.method} ${url}`);
    assert.equal(init.method, step.method);
    assert.equal(url, step.url);
    assert.equal(init.headers.Authorization, `Bearer ${step.token ?? 'tok-1'}`);
    assert.equal(init.headers.Accept, 'application/json');
    if ('json' in step) {
      assert.equal(init.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(init.body), step.json);
    } else {
      assert.equal(init.body, undefined);
      assert.equal(init.headers['Content-Type'], undefined);
    }
    if (step.respond instanceof Error) throw step.respond;
    return step.respond;
  };
  fn.calls = calls;
  fn.assertDone = () => assert.equal(calls.length, steps.length, 'not every expected request was made');
  return fn;
}

// Hands out tok-1, tok-2, … and records removals.
function tokenSource() {
  let n = 0;
  const auth = {
    requests: [],
    removed: [],
    getToken: async (interactive) => {
      auth.requests.push(interactive);
      return `tok-${++n}`;
    },
    removeToken: async (token) => {
      auth.removed.push(token);
    },
  };
  return auth;
}

function provider(steps, extra = {}) {
  const fetch = scriptedFetch(steps);
  const auth = tokenSource();
  const p = createGoogleProvider({
    getToken: auth.getToken,
    removeToken: auth.removeToken,
    fetch,
    timeZone: 'Europe/Berlin',
    ...extra,
  });
  return { p, fetch, auth };
}

const isCalendarError =
  (flags = {}) =>
  (err) => {
    assert.ok(err instanceof CalendarError, `expected CalendarError, got ${err}`);
    assert.equal(err.reconnect, flags.reconnect ?? false);
    assert.equal(err.calendarMissing, flags.calendarMissing ?? false);
    assert.equal(err.notFound, flags.notFound ?? false);
    if (flags.message) assert.match(err.message, flags.message);
    return true;
  };

test('scope is the narrow app-created one', () => {
  assert.deepEqual(GOOGLE_SCOPES, ['https://www.googleapis.com/auth/calendar.app.created']);
  assert.equal(GOOGLE_API, 'https://www.googleapis.com/calendar/v3');
});

test('ensureCalendar(null) creates a "ReLeet" calendar in the given time zone', async () => {
  const { p, fetch, auth } = provider([
    {
      method: 'POST',
      url: `${GOOGLE_API}/calendars`,
      json: { summary: 'ReLeet', description: 'Review blocks scheduled by ReLeet.', timeZone: 'Europe/Berlin' },
      respond: json({ id: CAL, summary: 'ReLeet' }),
    },
  ]);
  assert.equal(p.name, 'google');
  assert.equal(await p.ensureCalendar(null), CAL);
  fetch.assertDone();
  assert.deepEqual(auth.requests, [false]); // never interactive from the provider
});

test('ensureCalendar defaults the time zone to the local IANA zone', async () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fetch = scriptedFetch([
    {
      method: 'POST',
      url: `${GOOGLE_API}/calendars`,
      json: { summary: 'ReLeet', description: 'Review blocks scheduled by ReLeet.', timeZone: zone },
      respond: json({ id: CAL }),
    },
  ]);
  const p = createGoogleProvider({ getToken: async () => 'tok-1', fetch });
  assert.equal(await p.ensureCalendar(null), CAL);
});

test('ensureCalendar(id) keeps an existing calendar', async () => {
  const { p, fetch } = provider([{ method: 'GET', url: GOOGLE_API + CAL_PATH, respond: json({ id: CAL }) }]);
  assert.equal(await p.ensureCalendar(CAL), CAL);
  fetch.assertDone();
});

for (const status of [404, 410]) {
  test(`ensureCalendar(id) creates a new calendar when the old one is gone (${status})`, async () => {
    const { p, fetch } = provider([
      { method: 'GET', url: GOOGLE_API + CAL_PATH, respond: googleError(status, 'notFound') },
      {
        method: 'POST',
        url: `${GOOGLE_API}/calendars`,
        json: { summary: 'ReLeet', description: 'Review blocks scheduled by ReLeet.', timeZone: 'Europe/Berlin' },
        respond: json({ id: 'new@group.calendar.google.com' }),
      },
    ]);
    assert.equal(await p.ensureCalendar(CAL), 'new@group.calendar.google.com');
    fetch.assertDone();
  });
}

test('ensureCalendar does not recreate on server errors', async () => {
  const { p } = provider([{ method: 'GET', url: GOOGLE_API + CAL_PATH, respond: googleError(500, 'backendError') }]);
  await assert.rejects(p.ensureCalendar(CAL), isCalendarError({ message: /HTTP 500/ }));
});

test('createEvent posts the full event body', async () => {
  const { p, fetch } = provider([
    { method: 'POST', url: `${GOOGLE_API}${CAL_PATH}/events`, json: expectedEventBody, respond: json({ id: 'evt1' }) },
  ]);
  assert.deepEqual(await p.createEvent(CAL, slot), { id: 'evt1' });
  fetch.assertDone();
});

test('event start/end are RFC 3339 instants that round-trip', () => {
  const body = googleEventBody(slot);
  assert.equal(new Date(body.start.dateTime).getTime(), slot.start);
  assert.equal(new Date(body.end.dateTime).getTime(), slot.end);
});

test('event body leaves out a non-http source and clamps the reminder', () => {
  const body = googleEventBody({ ...slot, url: 'javascript:alert(1)', reminderMinutes: 99999 });
  assert.equal(body.source, undefined);
  assert.deepEqual(body.reminders.overrides, [{ method: 'popup', minutes: 40320 }]);
  assert.deepEqual(googleEventBody({ ...slot, reminderMinutes: null }).reminders, { useDefault: false, overrides: [] });
  assert.deepEqual(googleEventBody({ ...slot, reminderMinutes: 0 }).reminders.overrides, [
    { method: 'popup', minutes: 0 },
  ]);
});

test('createEvent on a deleted calendar → calendarMissing', async () => {
  const { p } = provider([
    {
      method: 'POST',
      url: `${GOOGLE_API}${CAL_PATH}/events`,
      json: expectedEventBody,
      respond: googleError(404, 'notFound'),
    },
  ]);
  await assert.rejects(p.createEvent(CAL, slot), isCalendarError({ calendarMissing: true }));
});

test('listEvents returns ReLeet events that have not ended, page by page', async () => {
  const FROM = Date.UTC(2026, 10, 4, 12);
  const base = `${GOOGLE_API}${CAL_PATH}/events?timeMin=2026-11-04T12%3A00%3A00.000Z&maxResults=250`;
  const mine = (id) => ({ id, status: 'confirmed', extendedProperties: { private: { releetProblemId: 'two-sum' } } });
  const { p, fetch } = provider([
    {
      method: 'GET',
      url: base,
      respond: json({ items: [mine('e1'), { id: 'theirs', status: 'confirmed' }], nextPageToken: 'pg2' }),
    },
    {
      method: 'GET',
      url: `${base}&pageToken=pg2`,
      respond: json({ items: [mine('e2'), { ...mine('gone'), status: 'cancelled' }] }),
    },
  ]);
  assert.deepEqual(await p.listEvents(CAL, FROM), [{ id: 'e1' }, { id: 'e2' }]);
  fetch.assertDone();
});

test('listEvents: nothing to ask about a calendar it just made; a deleted one is calendarMissing', async () => {
  const { p, fetch } = provider([
    {
      method: 'POST',
      url: `${GOOGLE_API}/calendars`,
      json: { summary: 'ReLeet', description: 'Review blocks scheduled by ReLeet.', timeZone: 'Europe/Berlin' },
      respond: json({ id: 'NEW' }),
    },
    {
      method: 'GET',
      url: `${GOOGLE_API}${CAL_PATH}/events?timeMin=1970-01-01T00%3A00%3A00.000Z&maxResults=250`,
      respond: googleError(404, 'notFound'),
    },
  ]);
  assert.equal(await p.ensureCalendar(null), 'NEW');
  assert.deepEqual(await p.listEvents('NEW', 0), []);
  await assert.rejects(p.listEvents(CAL, 0), isCalendarError({ calendarMissing: true }));
  fetch.assertDone();
});

test('updateEvent patches the event', async () => {
  const later = { ...slot, start: slot.start + 3600e3, end: slot.end + 3600e3 };
  const { p, fetch } = provider([
    {
      method: 'PATCH',
      url: `${GOOGLE_API}${CAL_PATH}/events/evt1`,
      json: {
        ...expectedEventBody,
        start: { dateTime: '2026-11-05T09:00:00.000Z' },
        end: { dateTime: '2026-11-05T09:20:00.000Z' },
      },
      respond: json({ id: 'evt1', status: 'confirmed' }),
    },
  ]);
  assert.deepEqual(await p.updateEvent(CAL, { id: 'evt1' }, later), { id: 'evt1' });
  fetch.assertDone();
});

for (const [label, respond] of [
  ['404', () => googleError(404, 'notFound')],
  ['410', () => googleError(410, 'deleted')],
  ['a cancelled event', () => json({ id: 'evt1', status: 'cancelled' })],
]) {
  test(`updateEvent on ${label} → notFound`, async () => {
    const { p } = provider([
      { method: 'PATCH', url: `${GOOGLE_API}${CAL_PATH}/events/evt1`, json: expectedEventBody, respond: respond() },
    ]);
    await assert.rejects(p.updateEvent(CAL, { id: 'evt1' }, slot), isCalendarError({ notFound: true }));
  });
}

for (const status of [204, 404, 410]) {
  test(`deleteEvent succeeds on ${status}`, async () => {
    const { p, fetch } = provider([
      {
        method: 'DELETE',
        url: `${GOOGLE_API}${CAL_PATH}/events/evt1`,
        respond: status === 204 ? empty() : googleError(status, 'deleted'),
      },
    ]);
    assert.equal(await p.deleteEvent(CAL, { id: 'evt1' }), undefined);
    fetch.assertDone();
  });

  test(`deleteCalendar succeeds on ${status}`, async () => {
    const { p, fetch } = provider([
      {
        method: 'DELETE',
        url: GOOGLE_API + CAL_PATH,
        respond: status === 204 ? empty() : googleError(status, 'notFound'),
      },
    ]);
    assert.equal(await p.deleteCalendar(CAL), undefined);
    fetch.assertDone();
  });
}

test('deleteEvent fails on other errors so sync retries', async () => {
  const { p } = provider([
    { method: 'DELETE', url: `${GOOGLE_API}${CAL_PATH}/events/evt1`, respond: googleError(503, 'backendError') },
  ]);
  await assert.rejects(p.deleteEvent(CAL, { id: 'evt1' }), isCalendarError({ message: /HTTP 503/ }));
});

test('401 drops the cached token and retries once with a fresh non-interactive one', async () => {
  const { p, fetch, auth } = provider([
    { method: 'GET', url: GOOGLE_API + CAL_PATH, token: 'tok-1', respond: googleError(401, 'authError') },
    { method: 'GET', url: GOOGLE_API + CAL_PATH, token: 'tok-2', respond: json({ id: CAL }) },
    { method: 'DELETE', url: `${GOOGLE_API}${CAL_PATH}/events/e`, token: 'tok-2', respond: empty() },
  ]);
  assert.equal(await p.ensureCalendar(CAL), CAL);
  await p.deleteEvent(CAL, { id: 'e' }); // the fresh token is reused
  fetch.assertDone();
  assert.deepEqual(auth.removed, ['tok-1']);
  assert.deepEqual(auth.requests, [false, false]);
});

test('401 twice → reconnect', async () => {
  const { p, auth } = provider([
    { method: 'GET', url: GOOGLE_API + CAL_PATH, token: 'tok-1', respond: googleError(401, 'authError') },
    { method: 'GET', url: GOOGLE_API + CAL_PATH, token: 'tok-2', respond: googleError(401, 'authError') },
  ]);
  await assert.rejects(p.ensureCalendar(CAL), isCalendarError({ reconnect: true }));
  assert.deepEqual(auth.removed, ['tok-1', 'tok-2']);
});

test('getToken failure → reconnect without any request', async () => {
  const fetch = scriptedFetch([]);
  const p = createGoogleProvider({
    getToken: async () => {
      throw new Error('OAuth2 not granted or revoked.');
    },
    fetch,
  });
  await assert.rejects(p.ensureCalendar(null), isCalendarError({ reconnect: true }));
  assert.equal(fetch.calls.length, 0);
});

test('a CalendarError from getToken passes through unchanged', async () => {
  const offline = new CalendarError('offline');
  const p = createGoogleProvider({
    getToken: async () => {
      throw offline;
    },
    fetch: scriptedFetch([]),
  });
  await assert.rejects(p.ensureCalendar(null), (err) => err === offline);
});

test('missing scope (403) → reconnect', async () => {
  const { p } = provider([
    {
      method: 'GET',
      url: GOOGLE_API + CAL_PATH,
      respond: googleError(403, 'insufficientPermissions', {
        status: 'PERMISSION_DENIED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
      }),
    },
  ]);
  await assert.rejects(p.ensureCalendar(CAL), isCalendarError({ reconnect: true }));
});

test('rate limits (403 rateLimitExceeded, 429) are plain errors that retry later', async () => {
  const { p } = provider([
    { method: 'GET', url: GOOGLE_API + CAL_PATH, respond: googleError(403, 'rateLimitExceeded') },
    {
      method: 'GET',
      url: GOOGLE_API + CAL_PATH,
      respond: json({ error: { code: 429, message: 'Too many' } }, 429, { 'Retry-After': '30' }),
    },
  ]);
  await assert.rejects(p.ensureCalendar(CAL), isCalendarError({ message: /limiting/ }));
  await assert.rejects(p.ensureCalendar(CAL), isCalendarError({ message: /30 s/ }));
});

test('network failure is a plain error', async () => {
  const { p } = provider([{ method: 'GET', url: GOOGLE_API + CAL_PATH, respond: new TypeError('Failed to fetch') }]);
  await assert.rejects(p.ensureCalendar(CAL), isCalendarError({ message: /Couldn't reach Google Calendar/ }));
});

test('400 shows Google’s message', async () => {
  const { p } = provider([
    {
      method: 'POST',
      url: `${GOOGLE_API}${CAL_PATH}/events`,
      json: expectedEventBody,
      respond: googleError(400, 'invalid'),
    },
  ]);
  await assert.rejects(p.createEvent(CAL, slot), isCalendarError({ message: /invalid message/ }));
});

test('describeAccount uses getAccount and never throws', async () => {
  const { p } = provider([], { getAccount: async () => 'me@gmail.com' });
  assert.equal(await p.describeAccount(), 'me@gmail.com');
  const { p: failing } = provider([], {
    getAccount: async () => {
      throw new Error('nope');
    },
  });
  assert.equal(await failing.describeAccount(), null);
  assert.equal(await provider([]).p.describeAccount(), null);
});

// ---- chrome glue ----

function fakeIdentity(getAuthToken) {
  const identity = {
    calls: [],
    removed: [],
    getAuthToken: async (details) => {
      identity.calls.push(details);
      return getAuthToken(details);
    },
    removeCachedAuthToken: async ({ token }) => {
      identity.removed.push(token);
    },
    getProfileUserInfo: async () => ({ email: 'me@gmail.com', id: '1' }),
  };
  return identity;
}

test('chromeGoogleAuth.getToken asks chrome.identity for the calendar scope', async () => {
  const identity = fakeIdentity(async () => ({ token: 'abc', grantedScopes: [...GOOGLE_SCOPES] }));
  installFakeChrome({}, { identity });
  const auth = chromeGoogleAuth();
  assert.equal(await auth.getToken(true), 'abc');
  assert.equal(await auth.getToken(), 'abc');
  assert.deepEqual(identity.calls, [
    { interactive: true, scopes: GOOGLE_SCOPES },
    { interactive: false, scopes: GOOGLE_SCOPES },
  ]);
});

test('chromeGoogleAuth.getToken rejects a token without the calendar scope', async () => {
  const identity = fakeIdentity(async () => ({ token: 'abc', grantedScopes: ['openid'] }));
  installFakeChrome({}, { identity });
  await assert.rejects(chromeGoogleAuth().getToken(true), isCalendarError({ reconnect: true, message: /not granted/ }));
  assert.deepEqual(identity.removed, ['abc']);
});

test('chromeGoogleAuth.getToken: revoked → reconnect, offline → plain error', async () => {
  let message = 'OAuth2 not granted or revoked.';
  installFakeChrome(
    {},
    {
      identity: fakeIdentity(async () => {
        throw new Error(message);
      }),
    },
  );
  const auth = chromeGoogleAuth();
  await assert.rejects(auth.getToken(false), isCalendarError({ reconnect: true }));
  message = 'The user did not approve access.';
  await assert.rejects(auth.getToken(true), isCalendarError({ reconnect: true, message: /did not approve/ }));
  message = 'OAuth2 request failed: Connection failed (-106).';
  await assert.rejects(auth.getToken(false), isCalendarError({ reconnect: false }));
});

test('chromeGoogleAuth.removeToken removes it from the cache', async () => {
  const identity = fakeIdentity(async () => ({ token: 'abc' }));
  installFakeChrome({}, { identity });
  await chromeGoogleAuth().removeToken('abc');
  assert.deepEqual(identity.removed, ['abc']);
});

test('chromeGoogleAuth.revoke posts to Google, clears the cache and never throws', async () => {
  const identity = fakeIdentity(async () => ({ token: 'cur/tok' }));
  installFakeChrome({}, { identity });
  const calls = [];
  const auth = chromeGoogleAuth({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return empty(200);
    },
  });
  await auth.revoke('abc');
  await auth.revoke(); // looks up the current token non-interactively
  assert.deepEqual(
    calls.map((c) => [c.init.method, c.url, c.init.headers['Content-Type']]),
    [
      ['POST', 'https://oauth2.googleapis.com/revoke?token=abc', 'application/x-www-form-urlencoded'],
      ['POST', 'https://oauth2.googleapis.com/revoke?token=cur%2Ftok', 'application/x-www-form-urlencoded'],
    ],
  );
  assert.deepEqual(identity.calls, [{ interactive: false, scopes: GOOGLE_SCOPES }]);
  assert.deepEqual(identity.removed, ['abc', 'cur/tok']);

  const offline = chromeGoogleAuth({
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await offline.revoke('xyz');
  assert.deepEqual(identity.removed, ['abc', 'cur/tok', 'xyz']);
});

test('chromeGoogleAuth.isConfigured checks the manifest client id', () => {
  installFakeChrome(); // helper's manifest has the placeholder id
  assert.equal(chromeGoogleAuth().isConfigured(), false);

  const manifest = (oauth2) => ({ runtime: { getManifest: () => ({ oauth2 }) } });
  installFakeChrome({}, manifest({ client_id: '123-abc.apps.googleusercontent.com' }));
  assert.equal(chromeGoogleAuth().isConfigured(), true);
  installFakeChrome({}, manifest(undefined));
  assert.equal(chromeGoogleAuth().isConfigured(), false);

  assert.equal(isGoogleClientIdConfigured(''), false);
  assert.equal(isGoogleClientIdConfigured('YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com'), false);
  assert.equal(isGoogleClientIdConfigured(' 42-x.apps.googleusercontent.com '), true);
});

test('chromeGoogleAuth.getAccount reads the profile email', async () => {
  const identity = fakeIdentity(async () => ({ token: 'abc' }));
  installFakeChrome({}, { identity });
  assert.equal(await chromeGoogleAuth().getAccount(), 'me@gmail.com');
  identity.getProfileUserInfo = async () => ({ email: '', id: '' }); // no identity.email permission
  assert.equal(await chromeGoogleAuth().getAccount(), null);
});
