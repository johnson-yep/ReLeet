import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPLE_CALDAV_URL, createAppleProvider, parseMultistatus } from '../lib/calendars/apple.js';
import { CalendarError } from '../lib/calendars/errors.js';

const APPLE_ID = 'alice@icloud.com';
const APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
const ROOT = 'https://caldav.icloud.com/';
const PRINCIPAL = 'https://caldav.icloud.com/12345678/principal/';
const HOME = 'https://p49-caldav.icloud.com/12345678/calendars/';
const CAL = `${HOME}A1B2C3D4-0000-4000-8000-000000000001/`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const SLOT = Object.freeze({
  problemId: 'two-sum',
  day: '2026-11-05',
  start: Date.UTC(2026, 10, 5, 14, 0),
  end: Date.UTC(2026, 10, 5, 14, 20),
  title: 'Review: Two Sum',
  description: 'Review Two Sum (last rated Easy).\nhttps://leetcode.com/problems/two-sum/\n\nScheduled by ReLeet.',
  url: 'https://leetcode.com/problems/two-sum/',
  rating: 'easy',
  reminderMinutes: 15,
});

// A Response whose url/redirected can be set, like one fetch returns after a redirect.
function reply(status, body = null, { headers = {}, url = '', redirected = false } = {}) {
  const res = new Response(status === 204 ? null : body, { status, headers });
  Object.defineProperty(res, 'url', { value: url });
  Object.defineProperty(res, 'redirected', { value: redirected });
  return res;
}

// Fake fetch. `routes` maps "METHOD url" to a Response factory, or to a list of
// them used in turn; `fallback` answers the rest (URLs with random parts).
// Anything else gets 418 so a test fails visibly.
function fakeFetch(routes, fallback = null) {
  const calls = [];
  const used = {};
  const fn = async (url, init) => {
    const key = `${init.method} ${url}`;
    calls.push({ key, url, method: init.method, headers: init.headers, body: init.body, init });
    let route = routes[key];
    if (Array.isArray(route)) route = route[Math.min((used[key] = (used[key] ?? -1) + 1), route.length - 1)];
    if (route instanceof Error) throw route;
    if (route) return route({ url, init });
    return fallback ? fallback({ url, init }) : reply(418, 'unexpected request');
  };
  fn.calls = calls;
  return fn;
}

const multistatus = (body) => () => reply(207, body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });

// Shaped like iCloud's answers: default DAV: namespace, CalDAV elements with their own xmlns.
const ROOT_RESPONSE = multistatus(`<?xml version='1.0' encoding='UTF-8'?>
<multistatus xmlns='DAV:'><response><href>/</href><propstat><prop><current-user-principal><href>/12345678/principal/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`);

const PRINCIPAL_RESPONSE = multistatus(`<?xml version='1.0' encoding='UTF-8'?>
<multistatus xmlns='DAV:'><response><href>/12345678/principal/</href><propstat><prop><calendar-home-set xmlns='urn:ietf:params:xml:ns:caldav'><href xmlns='DAV:'>https://p49-caldav.icloud.com:443/12345678/calendars/</href></calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`);

function homeListing({ withReleet = true } = {}) {
  const calendar = (href, name, comps) => `
  <response>
    <href>${href}</href>
    <propstat><prop>
      <resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype>
      <displayname>${name}</displayname>
      <supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav">${comps
        .map((c) => `<comp name="${c}"/>`)
        .join('')}</supported-calendar-component-set>
    </prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>`;
  return multistatus(`<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/12345678/calendars/</href>
    <propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat>
    <propstat><prop><displayname/><supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav"/></prop><status>HTTP/1.1 404 Not Found</status></propstat>
  </response>
  <response>
    <href>/12345678/calendars/inbox/</href>
    <propstat><prop><resourcetype><collection/><schedule-inbox xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
  ${calendar('/12345678/calendars/home/', 'Home', ['VEVENT'])}
  ${calendar('/12345678/calendars/tasks/', 'ReLeet', ['VTODO'])}
  ${withReleet ? calendar('https://caldav.icloud.com:443/12345678/calendars/A1B2C3D4-0000-4000-8000-000000000001', '<![CDATA[ReLeet]]>', ['VEVENT']) : ''}
</multistatus>`);
}

const calendarProps = (href = CAL, type = '<collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/>') =>
  multistatus(`<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:"><response><href>${href}</href><propstat><prop><resourcetype>${type}</resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`);

const DISCOVERY = {
  [`PROPFIND ${ROOT}`]: ROOT_RESPONSE,
  [`PROPFIND ${PRINCIPAL}`]: PRINCIPAL_RESPONSE,
};

const provider = (fetch, extra = {}) =>
  createAppleProvider({ appleId: APPLE_ID, appPassword: APP_PASSWORD, fetch, ...extra });

const decodeBasic = (header) => {
  assert.match(header, /^Basic [A-Za-z0-9+/]+=*$/);
  return new TextDecoder().decode(Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0)));
};

async function rejectsWith(promise, check) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof CalendarError, `expected CalendarError, got ${e}`);
    check(e);
    return true;
  });
}

// --- parser ----------------------------------------------------------------

test('parseMultistatus handles prefixes, entities, CDATA and 404 propstats', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<!-- generated by a server -->
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">
  <D:response>
    <D:href>https://p49-caldav.icloud.com/12345678/calendars/work/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>Work &amp; Play &#x1F4C5; &#38; &lt;b&gt;</D:displayname>
        <D:resourcetype><D:collection/><C:calendar /></D:resourcetype>
        <C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name='VTODO'/></C:supported-calendar-component-set>
        <A:calendar-color data-x="a>b">#FF2968FF</A:calendar-color>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
    <D:propstat><D:prop><D:getetag/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>
  </D:response>
  <d:response xmlns:d="DAV:">
    <d:href>
      /12345678/calendars/gone/
    </d:href>
    <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:response>
  <response xmlns="DAV:">
    <href>/12345678/calendars/plain/</href>
    <propstat><prop><displayname><![CDATA[Fish & <Chips>]]></displayname></prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
</D:multistatus>`;
  const [work, gone, plain] = parseMultistatus(xml);

  assert.equal(work.href, 'https://p49-caldav.icloud.com/12345678/calendars/work/');
  assert.equal(work.status, null);
  assert.equal(work.props.displayname.text.trim(), 'Work & Play 📅 & <b>');
  assert.deepEqual(
    work.props.resourcetype.children.map((c) => [c.name, c.ns]),
    [
      ['collection', 'DAV:'],
      ['calendar', 'urn:ietf:params:xml:ns:caldav'],
    ],
  );
  assert.deepEqual(
    work.props['supported-calendar-component-set'].children.map((c) => c.attrs.name),
    ['VEVENT', 'VTODO'],
  );
  assert.equal(work.props['calendar-color'].text, '#FF2968FF');
  assert.equal(work.props['calendar-color'].ns, 'http://apple.com/ns/ical/');
  assert.equal('getetag' in work.props, false);
  assert.equal(work.propStatus.getetag, 404);
  assert.equal(work.propStatus.displayname, 200);

  assert.equal(gone.href, '/12345678/calendars/gone/');
  assert.equal(gone.status, 404);
  assert.deepEqual(gone.props, {});

  assert.equal(plain.href, '/12345678/calendars/plain/');
  assert.equal(plain.props.displayname.text, 'Fish & <Chips>');
});

test('parseMultistatus reads iCloud-style default-namespace answers', () => {
  const [entry] = parseMultistatus(`<?xml version='1.0' encoding='UTF-8'?>
<multistatus xmlns='DAV:'><response><href>/12345678/principal/</href><propstat><prop><calendar-home-set xmlns='urn:ietf:params:xml:ns:caldav'><href xmlns='DAV:'>https://p49-caldav.icloud.com:443/12345678/calendars/</href></calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`);
  const home = entry.props['calendar-home-set'];
  assert.equal(home.ns, 'urn:ietf:params:xml:ns:caldav');
  assert.equal(home.children[0].name, 'href');
  assert.equal(home.children[0].ns, 'DAV:');
  assert.equal(home.children[0].text, 'https://p49-caldav.icloud.com:443/12345678/calendars/');
});

test('parseMultistatus returns [] for empty or non-XML bodies instead of throwing', () => {
  assert.deepEqual(parseMultistatus(''), []);
  assert.deepEqual(parseMultistatus(null), []);
  assert.deepEqual(parseMultistatus('<!DOCTYPE html><html><body>Service Unavailable</body></html>'), []);
  assert.deepEqual(parseMultistatus('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/a/</d:href>'), [
    { href: '/a/', status: null, props: {}, propStatus: {} },
  ]);
});

test('parseMultistatus stays fast on broken input', () => {
  const x = 'x'.repeat(50000);
  const started = performance.now();
  for (const input of ['<'.repeat(50000), `<${x}`, `<a ${x}`, `<a b="${x}`, `</${x}`, '<!--'.repeat(50000), '<?'.repeat(20000)]) {
    assert.deepEqual(parseMultistatus(input), []);
  }
  // Used to take seconds on a few KB before tag patterns were kept from running past "<".
  assert.ok(performance.now() - started < 1000);
});

// --- discovery ---------------------------------------------------------------

test('verifyCredentials follows principal → calendar home onto the partition host', async () => {
  const fetch = fakeFetch(DISCOVERY);
  const result = await createAppleProvider({ appleId: APPLE_ID, appPassword: APP_PASSWORD, fetch }).verifyCredentials();

  assert.deepEqual(result, { principalUrl: PRINCIPAL, homeUrl: HOME });
  assert.deepEqual(
    fetch.calls.map((c) => c.key),
    [`PROPFIND ${ROOT}`, `PROPFIND ${PRINCIPAL}`],
  );
  const [first, second] = fetch.calls;
  assert.equal(first.headers.Depth, '0');
  assert.equal(second.headers.Depth, '0');
  assert.match(first.body, /<d:current-user-principal\/>/);
  assert.match(second.body, /<c:calendar-home-set\/>/);
  assert.match(first.headers['Content-Type'], /^application\/xml/);
  assert.equal(decodeBasic(first.headers.Authorization), `${APPLE_ID}:${APP_PASSWORD}`);
  assert.equal(first.init.credentials, 'omit');
  assert.ok(first.init.signal instanceof AbortSignal);
  assert.equal(APPLE_CALDAV_URL, 'https://caldav.icloud.com');
});

test('relative hrefs resolve against the URL that answered', async () => {
  const fetch = fakeFetch({
    [`PROPFIND ${ROOT}`]: ROOT_RESPONSE,
    // The principal request was redirected to the partition host, and the home is relative to it.
    [`PROPFIND ${PRINCIPAL}`]: () =>
      reply(
        207,
        `<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/12345678/principal/</d:href><d:propstat><d:prop><cal:calendar-home-set><d:href>/12345678/calendars</d:href></cal:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
        { url: 'https://p49-caldav.icloud.com/12345678/principal/', redirected: true },
      ),
  });
  const { homeUrl } = await provider(fetch).verifyCredentials();
  assert.equal(homeUrl, HOME); // trailing slash added so child names append cleanly
});

test('Basic auth is UTF-8 safe and trims pasted whitespace', async () => {
  const fetch = fakeFetch(DISCOVERY);
  const apple = createAppleProvider({ appleId: ' jürgen@example.com ', appPassword: 'pässwörd-✓\n', fetch });
  await apple.verifyCredentials();
  assert.equal(decodeBasic(fetch.calls[0].headers.Authorization), 'jürgen@example.com:pässwörd-✓');
});

test('missing credentials ask to reconnect without a request', async () => {
  const fetch = fakeFetch({});
  await rejectsWith(createAppleProvider({ appleId: APPLE_ID, appPassword: ' ', fetch }).verifyCredentials(), (e) => {
    assert.equal(e.reconnect, true);
  });
  assert.equal(fetch.calls.length, 0);
});

test('describeAccount shows the Apple ID', () => {
  assert.equal(provider(fakeFetch({})).describeAccount(), APPLE_ID);
  assert.equal(createAppleProvider({ fetch: fakeFetch({}) }).describeAccount(), null);
  assert.equal(provider(fakeFetch({})).name, 'apple');
});

// --- ensureCalendar -----------------------------------------------------------

test('ensureCalendar(null) reuses an existing ReLeet event calendar', async () => {
  const fetch = fakeFetch({ ...DISCOVERY, [`PROPFIND ${HOME}`]: homeListing() });
  const id = await provider(fetch).ensureCalendar(null);

  // The VTODO-only "ReLeet" list is skipped; the generic-host href is moved onto the home's host.
  assert.equal(id, CAL);
  const listing = fetch.calls[2];
  assert.equal(listing.key, `PROPFIND ${HOME}`);
  assert.equal(listing.headers.Depth, '1');
  assert.match(listing.body, /<d:displayname\/>/);
  assert.match(listing.body, /<d:resourcetype\/>/);
  assert.equal(
    fetch.calls.some((c) => c.method === 'MKCALENDAR'),
    false,
  );
});

test('ensureCalendar(null) creates the calendar with MKCALENDAR when none exists', async () => {
  const fetch = fakeFetch({ ...DISCOVERY, [`PROPFIND ${HOME}`]: homeListing({ withReleet: false }) }, ({ init }) =>
    reply(init.method === 'MKCALENDAR' ? 201 : 418),
  );
  const id = await provider(fetch).ensureCalendar(null);

  const mk = fetch.calls.find((c) => c.method === 'MKCALENDAR');
  assert.ok(mk, 'MKCALENDAR sent');
  assert.equal(id, mk.url);
  assert.ok(id.startsWith(HOME));
  assert.match(id.slice(HOME.length), new RegExp(`^${UUID.source}/$`));
  assert.match(mk.init.headers['Content-Type'], /^application\/xml/);
  assert.match(mk.init.body, /<c:mkcalendar [^>]*xmlns:c="urn:ietf:params:xml:ns:caldav"/);
  assert.match(mk.init.body, /<d:set>\s*<d:prop>/);
  assert.match(mk.init.body, /<d:displayname>ReLeet<\/d:displayname>/);
  assert.match(
    mk.init.body,
    /<c:supported-calendar-component-set><c:comp name="VEVENT"\/><\/c:supported-calendar-component-set>/,
  );
  assert.ok(mk.init.headers.Authorization.startsWith('Basic '));
});

test('ensureCalendar keeps a calendar that still exists (one request)', async () => {
  const fetch = fakeFetch({ [`PROPFIND ${CAL}`]: calendarProps() });
  assert.equal(await provider(fetch).ensureCalendar(CAL), CAL);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].headers.Depth, '0');
});

test('ensureCalendar finds or creates again when the stored calendar is gone', async () => {
  const OLD = `${HOME}OLD-CALENDAR-ID-0000/`;
  const fetch = fakeFetch({ ...DISCOVERY, [`PROPFIND ${OLD}`]: () => reply(404), [`PROPFIND ${HOME}`]: homeListing() });
  const apple = provider(fetch);
  assert.equal(await apple.ensureCalendar(OLD), CAL);

  // The home is remembered: another call doesn't repeat discovery.
  const before = fetch.calls.length;
  assert.equal(await apple.ensureCalendar(null), CAL);
  assert.deepEqual(
    fetch.calls.slice(before).map((c) => c.key),
    [`PROPFIND ${HOME}`],
  );
});

test('listEvents asks for events ending after a time and keeps only ReLeet resources', async () => {
  const FROM = Date.UTC(2026, 10, 4, 12, 0, 30);
  const answer = multistatus(`<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:">
  <response><href>/12345678/calendars/A1B2C3D4-0000-4000-8000-000000000001/releet-two-sum-1111.ics</href>
    <propstat><prop><getetag>"1"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>https://caldav.icloud.com:443/12345678/calendars/A1B2C3D4-0000-4000-8000-000000000001/releet-lru-cache-2222.ics</href>
    <propstat><prop><getetag>"2"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>/12345678/calendars/A1B2C3D4-0000-4000-8000-000000000001/DENTIST-3333.ics</href>
    <propstat><prop><getetag>"3"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>/12345678/calendars/A1B2C3D4-0000-4000-8000-000000000001/releet-gone-4444.ics</href>
    <status>HTTP/1.1 404 Not Found</status></response>
</multistatus>`);
  const fetch = fakeFetch({ [`REPORT ${CAL}`]: () => answer({}) });
  const refs = await provider(fetch).listEvents(CAL, FROM);

  assert.deepEqual(refs, [
    { id: `${CAL}releet-two-sum-1111.ics`, uid: 'releet-two-sum-1111' },
    { id: `${CAL}releet-lru-cache-2222.ics`, uid: 'releet-lru-cache-2222' },
  ]);
  const [call] = fetch.calls;
  assert.equal(call.headers.Depth, '1');
  assert.match(call.body, /<c:calendar-query /);
  assert.match(call.body, /<c:comp-filter name="VEVENT"><c:time-range start="20261104T120030Z"\/><\/c:comp-filter>/);
});

test('listEvents: nothing to ask about a calendar it just made; a deleted one is calendarMissing', async () => {
  const fetch = fakeFetch(
    { ...DISCOVERY, [`PROPFIND ${HOME}`]: homeListing({ withReleet: false }), [`REPORT ${CAL}`]: () => reply(404) },
    ({ init }) => reply(init.method === 'MKCALENDAR' ? 201 : 418),
  );
  const apple = provider(fetch);
  const made = await apple.ensureCalendar(null);
  const before = fetch.calls.length;
  assert.deepEqual(await apple.listEvents(made, 0), []);
  assert.equal(fetch.calls.length, before);
  await rejectsWith(apple.listEvents(CAL, 0), (e) => assert.equal(e.calendarMissing, true));
});

// --- events -------------------------------------------------------------------

test('createEvent PUTs a CalDAV resource with If-None-Match and UTC times', async () => {
  const fetch = fakeFetch({}, () => reply(201, null, { headers: { ETag: '"e1"' } }));
  const ref = await provider(fetch).createEvent(CAL, SLOT);

  assert.match(ref.uid, new RegExp(`^releet-two-sum-${UUID.source}$`));
  assert.deepEqual(ref, { id: `${CAL}${ref.uid}.ics`, uid: ref.uid, etag: '"e1"' });
  const [put] = fetch.calls;
  assert.equal(put.method, 'PUT');
  assert.equal(put.url, ref.id);
  assert.equal(put.headers['If-None-Match'], '*');
  assert.equal(put.headers['Content-Type'], 'text/calendar; charset=utf-8');
  assert.equal(decodeBasic(put.headers.Authorization), `${APPLE_ID}:${APP_PASSWORD}`);

  const ics = put.body;
  assert.equal(ics.replace(/\r\n/g, '').includes('\n'), false, 'CRLF line endings only');
  const lines = ics.replace(/\r\n /g, '').split('\r\n');
  assert.equal(lines.some((l) => l.startsWith('METHOD')), false, 'no METHOD in a CalDAV resource');
  assert.ok(lines.includes(`UID:${ref.uid}`));
  assert.ok(lines.includes('DTSTART:20261105T140000Z'));
  assert.ok(lines.includes('DTEND:20261105T142000Z'));
  assert.ok(lines.includes('SUMMARY:Review: Two Sum'));
  assert.ok(lines.includes('TRIGGER:-PT15M'));
});

test('createEvent leaves etag out when the server sends none', async () => {
  const apple = provider(async () => reply(201));
  const ref = await apple.createEvent(CAL.slice(0, -1), { ...SLOT, problemId: 'LRU Cache!' }); // id without slash
  assert.match(ref.uid, /^releet-lru-cache-/);
  assert.deepEqual(ref, { id: `${CAL}${ref.uid}.ics`, uid: ref.uid });
});

test('createEvent retries once with a fresh UID on 412', async () => {
  const fetch = fakeFetch({}, () => reply(fetch.calls.length === 1 ? 412 : 201));
  const ref = await provider(fetch).createEvent(CAL, SLOT);
  const urls = fetch.calls.map((c) => c.url);
  assert.equal(urls.length, 2);
  assert.notEqual(urls[0], urls[1]);
  assert.equal(ref.id, urls[1]);

  const stubborn = fakeFetch({}, () => reply(412));
  await rejectsWith(provider(stubborn).createEvent(CAL, SLOT), (e) => {
    assert.equal(e.status, 412);
    assert.equal(e.reconnect || e.calendarMissing || e.notFound, false);
  });
  assert.equal(stubborn.calls.length, 2);
  assert.ok(stubborn.calls.every((c) => c.headers['If-None-Match'] === '*'));
});

test('updateEvent PUTs the same href and UID without If-None-Match', async () => {
  const ref = { id: `${CAL}releet-two-sum-1234.ics`, uid: 'releet-two-sum-1234', etag: '"old"' };
  const fetch = fakeFetch({ [`PUT ${ref.id}`]: () => reply(204, null, { headers: { ETag: '"new"' } }) });
  const moved = { ...SLOT, start: SLOT.start + 3600e3, end: SLOT.end + 3600e3 };
  const next = await provider(fetch).updateEvent(CAL, ref, moved);

  assert.deepEqual(next, { id: ref.id, uid: ref.uid, etag: '"new"' });
  const [put] = fetch.calls;
  assert.equal('If-None-Match' in put.headers, false);
  assert.equal('If-Match' in put.headers, false);
  assert.ok(put.body.includes('\r\nUID:releet-two-sum-1234\r\n'));
  assert.ok(put.body.includes('\r\nDTSTART:20261105T150000Z\r\n'));
});

test('updateEvent takes the UID from the href when the ref has none', async () => {
  const id = `${CAL}releet-two-sum-abcd.ics`;
  const fetch = fakeFetch({ [`PUT ${id}`]: () => reply(201) });
  assert.deepEqual(await provider(fetch).updateEvent(CAL, { id }, SLOT), { id, uid: 'releet-two-sum-abcd' });
});

test('updateEvent refuses refs that are not event resources (notFound, no request)', async () => {
  const fetch = fakeFetch({});
  for (const ref of [{ id: CAL }, { id: 'garbage' }, {}, null]) {
    await rejectsWith(provider(fetch).updateEvent(CAL, ref, SLOT), (e) => assert.equal(e.notFound, true));
  }
  assert.equal(fetch.calls.length, 0);
});

test('updateEvent 404: notFound when the calendar is there, calendarMissing when not', async () => {
  const ref = { id: `${CAL}releet-two-sum-1234.ics`, uid: 'releet-two-sum-1234' };

  const stillThere = fakeFetch({ [`PUT ${ref.id}`]: () => reply(404), [`PROPFIND ${CAL}`]: calendarProps() });
  await rejectsWith(provider(stillThere).updateEvent(CAL, ref, SLOT), (e) => {
    assert.equal(e.notFound, true);
    assert.equal(e.calendarMissing, false);
  });

  const gone = fakeFetch({ [`PUT ${ref.id}`]: () => reply(404), [`PROPFIND ${CAL}`]: () => reply(404) });
  await rejectsWith(provider(gone).updateEvent(CAL, ref, SLOT), (e) => {
    assert.equal(e.calendarMissing, true);
    assert.equal(e.notFound, false);
  });
});

test('createEvent into a deleted calendar reports calendarMissing', async () => {
  const fetch = fakeFetch({ [`PROPFIND ${CAL}`]: () => reply(404) }, () => reply(409));
  await rejectsWith(provider(fetch).createEvent(CAL, SLOT), (e) => assert.equal(e.calendarMissing, true));
  assert.deepEqual(
    fetch.calls.map((c) => c.method),
    ['PUT', 'PROPFIND'],
  );

  // A 404 while the calendar still exists is a plain error (sync retries later).
  const exists = fakeFetch({ [`PROPFIND ${CAL}`]: calendarProps() }, () => reply(404));
  await rejectsWith(provider(exists).createEvent(CAL, SLOT), (e) => {
    assert.equal(e.calendarMissing || e.notFound || e.reconnect, false);
    assert.equal(e.status, 404);
  });

  await rejectsWith(provider(fetch).createEvent(null, SLOT), (e) => assert.equal(e.calendarMissing, true));
});

test('deleteEvent treats 404/410 as done and only deletes .ics resources', async () => {
  const id = `${CAL}releet-two-sum-1234.ics`;
  for (const status of [204, 200, 404, 410]) {
    const fetch = fakeFetch({ [`DELETE ${id}`]: () => reply(status) });
    await provider(fetch).deleteEvent(CAL, { id, uid: 'releet-two-sum-1234' });
    assert.deepEqual(
      fetch.calls.map((c) => c.key),
      [`DELETE ${id}`],
    );
  }

  const byUid = fakeFetch({ [`DELETE ${id}`]: () => reply(204) });
  await provider(byUid).deleteEvent(CAL, { uid: 'releet-two-sum-1234' });
  assert.equal(byUid.calls.length, 1);

  const none = fakeFetch({});
  await provider(none).deleteEvent(CAL, { id: CAL });
  await provider(none).deleteEvent(CAL, { id: 'not a url' });
  await provider(none).deleteEvent(CAL, {});
  assert.equal(none.calls.length, 0);

  const broken = fakeFetch({ [`DELETE ${id}`]: () => reply(500) });
  await rejectsWith(provider(broken).deleteEvent(CAL, { id }), (e) => {
    assert.equal(e.status, 500);
    assert.equal(e.reconnect, false);
  });
});

test('deleteCalendar deletes the collection, counts gone as done, refuses non-calendars', async () => {
  const fetch = fakeFetch({ [`PROPFIND ${CAL}`]: calendarProps(), [`DELETE ${CAL}`]: () => reply(204) });
  await provider(fetch).deleteCalendar(CAL);
  assert.deepEqual(
    fetch.calls.map((c) => c.key),
    [`PROPFIND ${CAL}`, `DELETE ${CAL}`],
  );

  const gone = fakeFetch({ [`PROPFIND ${CAL}`]: () => reply(404) });
  await provider(gone).deleteCalendar(CAL);
  assert.equal(gone.calls.length, 1);

  const raced = fakeFetch({ [`PROPFIND ${CAL}`]: calendarProps(), [`DELETE ${CAL}`]: () => reply(404) });
  await provider(raced).deleteCalendar(CAL);

  const home = fakeFetch({ [`PROPFIND ${HOME}`]: calendarProps(HOME, '<collection/>') });
  await rejectsWith(provider(home).deleteCalendar(HOME), () => {});
  assert.equal(
    home.calls.some((c) => c.method === 'DELETE'),
    false,
  );

  await provider(fakeFetch({})).deleteCalendar(null);
});

// --- errors -------------------------------------------------------------------

test('401 asks to reconnect with a clear message', async () => {
  const challenge = { headers: { 'WWW-Authenticate': 'X-MobileMe-AuthToken realm="MMCalDav", Basic realm="MMCalDav"' } };
  const fetch = fakeFetch({ [`PROPFIND ${ROOT}`]: () => reply(401, 'Unauthorized', challenge) });
  await rejectsWith(provider(fetch).verifyCredentials(), (e) => {
    assert.equal(e.reconnect, true);
    assert.equal(e.status, 401);
    assert.equal(e.message, 'Apple ID or app-specific password was rejected.');
  });
  assert.equal(fetch.calls.length, 1, 'no retry without a redirect');

  const events = fakeFetch({ [`PUT ${CAL}x.ics`]: () => reply(401) });
  await rejectsWith(provider(events).updateEvent(CAL, { id: `${CAL}x.ics`, uid: 'x' }, SLOT), (e) =>
    assert.equal(e.reconnect, true),
  );
});

test('a 401 after a cross-origin redirect is retried once at the final URL with credentials', async () => {
  const MOVED = 'https://p49-caldav.icloud.com/';
  const fetch = fakeFetch({
    [`PROPFIND ${ROOT}`]: () => reply(401, '', { url: MOVED, redirected: true }),
    [`PROPFIND ${MOVED}`]: multistatus(
      `<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><current-user-principal><href>/12345678/principal/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`,
    ),
    'PROPFIND https://p49-caldav.icloud.com/12345678/principal/': PRINCIPAL_RESPONSE,
  });
  const { principalUrl, homeUrl } = await provider(fetch).verifyCredentials();

  assert.deepEqual(
    fetch.calls.map((c) => c.key),
    [`PROPFIND ${ROOT}`, `PROPFIND ${MOVED}`, 'PROPFIND https://p49-caldav.icloud.com/12345678/principal/'],
  );
  const retry = fetch.calls[1];
  assert.equal(decodeBasic(retry.headers.Authorization), `${APPLE_ID}:${APP_PASSWORD}`);
  assert.equal(retry.headers.Depth, '0');
  assert.match(retry.body, /current-user-principal/);
  assert.equal(principalUrl, 'https://p49-caldav.icloud.com/12345678/principal/');
  assert.equal(homeUrl, HOME);
});

test('network failures, 403 and 5xx are plain errors the sync retries', async () => {
  const offline = provider(async () => {
    throw new TypeError('Failed to fetch');
  });
  // The cause only: the popup and Settings say what happens next (a retry, or try again).
  await rejectsWith(offline.createEvent(CAL, SLOT), (e) => {
    assert.equal(e.message, "Couldn't reach iCloud Calendar.");
    assert.equal(e.reconnect || e.calendarMissing || e.notFound, false);
  });

  const timeout = provider(async () => {
    throw new DOMException('timed out', 'TimeoutError');
  });
  await rejectsWith(timeout.deleteEvent(CAL, { id: `${CAL}x.ics` }), (e) => assert.match(e.message, /didn't respond/));

  for (const status of [403, 500, 503]) {
    const fetch = fakeFetch({ [`PROPFIND ${ROOT}`]: () => reply(status) });
    await rejectsWith(provider(fetch).verifyCredentials(), (e) => {
      assert.equal(e.status, status);
      assert.equal(e.reconnect, false);
      assert.ok(e.message.length < 90, e.message);
      assert.doesNotMatch(e.message, /try again|retry/i);
    });
  }
});

test('a principal answer without a calendar home is a clear error', async () => {
  const fetch = fakeFetch({
    [`PROPFIND ${ROOT}`]: ROOT_RESPONSE,
    [`PROPFIND ${PRINCIPAL}`]: multistatus(
      `<multistatus xmlns="DAV:"><response><href>/12345678/principal/</href><propstat><prop><calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response></multistatus>`,
    ),
  });
  await rejectsWith(provider(fetch).ensureCalendar(null), (e) => {
    assert.match(e.message, /iCloud didn't say where your calendars are/);
    assert.equal(e.reconnect, false);
  });
});
