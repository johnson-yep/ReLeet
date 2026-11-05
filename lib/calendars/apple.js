// iCloud Calendar over CalDAV (RFC 4791 on top of WebDAV, RFC 4918). Uses
// fetch only — no chrome.* APIs — so it can be tested with a fake fetch.
//
// Sign-in is HTTP Basic with the Apple ID and an app-specific password: iCloud
// has no OAuth for CalDAV, and its 401 offers Basic alongside a private scheme.
//
// iCloud quirks handled here (seen in python-caldav's iCloud profile and issue
// tracker, and vdirsyncer's iCloud notes):
//   - each account lives on a partition host (pNN-caldav.icloud.com). The
//     calendar home on caldav.icloud.com points there, as an absolute URL that
//     may carry ":443";
//   - responses from the partition host may still give hrefs on
//     caldav.icloud.com, so those are moved onto the home's host;
//   - collection names have a minimum length, which a UUID meets;
//   - a UID clash is answered with a bare 412, like an href that is taken.

import { buildEventIcs } from '../calendar.js';
import { CalendarError } from './errors.js';

export const APPLE_CALDAV_URL = 'https://caldav.icloud.com';

const CALENDAR_NAME = 'ReLeet';
const TIMEOUT_MS = 30 * 1000;
const REJECTED = 'Apple ID or app-specific password was rejected.';

const DAV_NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';
const XML_HEADERS = { 'Content-Type': 'application/xml; charset=utf-8' };

const propfindBody = (props) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<d:propfind ${DAV_NS}><d:prop>${props
    .map((p) => `<${p}/>`)
    .join('')}</d:prop></d:propfind>`;

// RFC 4791 §5.3.1. Limiting the calendar to events keeps it out of Reminders.
const MKCALENDAR_BODY = `<?xml version="1.0" encoding="utf-8"?>
<c:mkcalendar ${DAV_NS}>
  <d:set>
    <d:prop>
      <d:displayname>${CALENDAR_NAME}</d:displayname>
      <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
    </d:prop>
  </d:set>
</c:mkcalendar>`;

const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

// RFC 4791 §7.8: the calendar's events that end after `from`. Only hrefs are
// needed: ReLeet's own events are named releet-….ics (see newUid).
const eventsAfterBody = (from) => `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query ${DAV_NS}>
  <d:prop><d:getetag/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT"><c:time-range start="${utcStamp(from)}"/></c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

// ---------------------------------------------------------------------------
// Multistatus parsing. Service workers have no DOMParser, so this is a small
// XML reader, just enough for WebDAV responses. Elements are matched by local
// name, so the prefix a server picks (d:, D:, none with a default xmlns)
// doesn't matter; the resolved namespace is kept on each node anyway.

// One alternative per token. Comments, <?...?> and <!DOCTYPE> have no groups, so they're skipped.
// No tag pattern can run past a "<" (XML never has one inside a tag), and every
// part has only one way to match, so broken or hostile input can't make it crawl.
const XML_TOKEN = new RegExp(
  [
    /<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)/, // 1: CDATA text, taken as-is (an unclosed one runs to the end)
    /<!--[\s\S]*?(?:-->|$)/,
    /<[?!][^<>]*>/,
    /<\/\s*([^\s<>]+)\s*>/, // 2: close tag name
    // 3: open tag name, 4: attributes, 5: "/" if self-closing
    /<([^\s<>/!?"'=]+)(?=[\s/>])((?:[^<>"']|"[^"<]*"|'[^'<]*')*?)(\/?)>/,
    /([^<]+)/, // 6: text
  ]
    .map((part) => part.source)
    .join('|'),
  'g',
);
// Anchored on the whitespace before each name, so a long run without "=" is scanned once.
const ATTRIBUTE = /\s([^\s="']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITY = /&(?:#x([0-9a-f]+)|#(\d+)|(lt|gt|amp|quot|apos));/gi;
const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(text) {
  return text.replace(ENTITY, (whole, hex, dec, named) => {
    if (named) return NAMED_ENTITIES[named.toLowerCase()];
    try {
      return String.fromCodePoint(hex ? parseInt(hex, 16) : Number(dec));
    } catch {
      return whole; // out-of-range code point: keep the text as sent
    }
  });
}

// Node: { name /* local name */, ns, attrs, text /* own text, decoded */, children }.
// Lenient on purpose: a stray close tag is ignored and unclosed tags end at EOF,
// so a slightly broken response still yields what it can.
function parseXml(xml) {
  const root = { name: '#document', ns: null, attrs: {}, text: '', children: [] };
  const stack = [{ node: root, scope: {}, qname: null }];
  for (const [, cdata, closeName, openName, rawAttrs, selfClose, text] of String(xml ?? '').matchAll(XML_TOKEN)) {
    const top = stack[stack.length - 1];
    if (cdata !== undefined) top.node.text += cdata;
    else if (text !== undefined) top.node.text += decodeEntities(text);
    else if (closeName) {
      const at = stack.findLastIndex((frame) => frame.qname === closeName);
      if (at > 0) stack.length = at;
    } else if (openName) {
      const attrs = {};
      for (const [, key, double, single] of rawAttrs.matchAll(ATTRIBUTE)) attrs[key] = decodeEntities(double ?? single);
      const scope = { ...top.scope };
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'xmlns') scope[''] = value;
        else if (key.startsWith('xmlns:')) scope[key.slice(6)] = value;
      }
      const colon = openName.indexOf(':');
      const prefix = colon === -1 ? '' : openName.slice(0, colon);
      const node = { name: openName.slice(colon + 1), ns: scope[prefix] ?? null, attrs, text: '', children: [] };
      top.node.children.push(node);
      if (!selfClose) stack.push({ node, scope, qname: openName });
    }
  }
  return root;
}

const childrenNamed = (node, name) => (node?.children ?? []).filter((c) => c.name === name);
const childNamed = (node, name) => node?.children.find((c) => c.name === name);
const textOf = (node) => (node ? node.text.trim() : '');
const childNames = (node) => (node?.children ?? []).map((c) => c.name);
const hrefOf = (node) => textOf(childNamed(node, 'href'));

function findAll(node, name, out = []) {
  for (const child of node.children) {
    if (child.name === name) out.push(child);
    else findAll(child, name, out);
  }
  return out;
}

// "HTTP/1.1 404 Not Found" → 404
function statusCode(node) {
  const match = /\b([1-5]\d\d)\b/.exec(textOf(node));
  return match ? Number(match[1]) : null;
}

// Reads a 207 Multi-Status body into
//   [{ href, status /* response-level, or null */, props: { [localName]: node }, propStatus: { [localName]: code } }]
// Only props with a 2xx propstat are in `props`; ones the server lacks (404) are
// only in `propStatus`. A prop node has `.text`, `.children` and `.attrs`.
export function parseMultistatus(xml) {
  const doc = parseXml(xml);
  const roots = findAll(doc, 'multistatus');
  const responses = (roots.length ? roots : [doc]).flatMap((root) => findAll(root, 'response'));
  return responses.map((response) => {
    const props = {};
    const propStatus = {};
    for (const propstat of childrenNamed(response, 'propstat')) {
      const code = statusCode(childNamed(propstat, 'status')) ?? 200;
      for (const prop of childrenNamed(propstat, 'prop')) {
        for (const node of prop.children) {
          if (code >= 200 && code < 300) {
            props[node.name] = node;
            propStatus[node.name] = code;
          } else if (!(node.name in props)) {
            propStatus[node.name] = code;
          }
        }
      }
    }
    return { href: hrefOf(response), status: statusCode(childNamed(response, 'status')), props, propStatus };
  });
}

// ---------------------------------------------------------------------------
// URLs

const withSlash = (url) => (url.endsWith('/') ? url : `${url}/`);

function resolveUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

// iCloud may answer from the partition host with hrefs on the generic host.
// Keep everything on the host that serves the calendar home.
function onHomeHost(url, home, genericHost) {
  const target = new URL(url);
  const homeUrl = new URL(home);
  if (target.host === genericHost && homeUrl.host !== genericHost) {
    target.protocol = homeUrl.protocol;
    target.host = homeUrl.host;
  }
  return target.href;
}

// The resource name doubles as the UID, so it must be URL-safe without escaping.
function newUid(slot) {
  const slug =
    String(slot?.problemId ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'problem';
  return `${UID_PREFIX}${slug}-${crypto.randomUUID()}`;
}

function uidFromHref(href) {
  try {
    const name = new URL(href).pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(name).replace(/\.ics$/i, '') || null;
  } catch {
    return null;
  }
}

// HTTP Basic is base64 of bytes, and btoa only takes Latin-1, so encode as UTF-8 first.
function basicAuth(user, password) {
  let binary = '';
  for (const byte of new TextEncoder().encode(`${user}:${password}`)) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

// Messages name the cause only. Settings and the popup add what happens next
// (a retry, or Reconnect), which depends on where the message is shown.
function httpError(status, action) {
  if (status === 401) return new CalendarError(REJECTED, { status, reconnect: true });
  if (status === 429) return new CalendarError('iCloud is limiting requests right now.', { status });
  if (status >= 500) {
    return new CalendarError(`iCloud Calendar is having trouble (HTTP ${status}).`, { status });
  }
  if (status === 403) return new CalendarError(`iCloud refused to ${action} (HTTP 403).`, { status });
  return new CalendarError(`Couldn't ${action} in iCloud Calendar (HTTP ${status}).`, { status });
}

const UID_PREFIX = 'releet-';
const isOk = (status) => status >= 200 && status < 300;
const isGone = (status) => status === 404 || status === 410;

const calendarMissing = (status = null) =>
  new CalendarError('The ReLeet calendar is missing from iCloud.', { status, calendarMissing: true });
const eventMissing = (status = null) =>
  new CalendarError('The review event is missing from iCloud.', { status, notFound: true });

// Event ops get the calendar id that ensureCalendar returned; without one there's nowhere to write.
function calendarUrlOf(calendarId) {
  if (!calendarId) throw calendarMissing();
  return withSlash(String(calendarId));
}

// Only ever PUT or DELETE an event resource: a bad ref must never touch a whole collection.
function isEventHref(href) {
  try {
    return /\.ics$/i.test(new URL(href).pathname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Provider

export function createAppleProvider({
  appleId,
  appPassword,
  fetch: fetchFn = globalThis.fetch,
  serverUrl = APPLE_CALDAV_URL,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const user = String(appleId ?? '').trim();
  const password = String(appPassword ?? '').trim();
  const rootUrl = withSlash(String(serverUrl));
  const genericHost = new URL(rootUrl).host;
  let principalUrl = null;
  let homeUrl = null;
  // Calendars this provider made itself: known to be empty, so there's nothing to list.
  const madeHere = new Set();

  async function attempt(url, init) {
    try {
      // credentials: 'omit' keeps the user's icloud.com browser cookies out of it
      // and stops Chrome from showing a login prompt on 401; our header still goes.
      return await fetchFn(url, {
        ...init,
        credentials: 'omit',
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (e) {
      if (e?.name === 'TimeoutError') {
        throw new CalendarError("iCloud Calendar didn't respond in time.");
      }
      throw new CalendarError("Couldn't reach iCloud Calendar.");
    }
  }

  // → { res, answeredBy }: answeredBy is the URL that gave the response, which
  // relative hrefs in it are resolved against.
  async function request(url, { method, depth, headers = {}, body } = {}) {
    if (!user || !password) {
      throw new CalendarError('Enter your Apple ID and an app-specific password.', { reconnect: true });
    }
    const init = {
      method,
      headers: {
        Authorization: basicAuth(user, password),
        ...(depth == null ? {} : { Depth: String(depth) }),
        ...headers,
      },
      body,
    };
    let target = url;
    let res = await attempt(target, init);
    // fetch drops Authorization when a redirect crosses origins (e.g. onto a
    // partition host), so the server sees no credentials. Ask the new URL directly.
    if (res.status === 401 && res.redirected && res.url && res.url !== url) {
      target = res.url;
      res = await attempt(target, init);
    }
    return { res, answeredBy: res.url || target };
  }

  const send = async (url, options) => (await request(url, options)).res;

  async function readText(res) {
    try {
      return await res.text();
    } catch {
      throw new CalendarError("Couldn't reach iCloud Calendar.");
    }
  }

  // → { status, entries, base } where base is the URL that answered (for relative hrefs).
  async function propfind(url, depth, props) {
    const { res, answeredBy: base } = await request(url, {
      method: 'PROPFIND',
      depth,
      headers: XML_HEADERS,
      body: propfindBody(props),
    });
    if (!isOk(res.status)) return { status: res.status, entries: [], base };
    return { status: res.status, entries: parseMultistatus(await readText(res)), base };
  }

  // The first href inside `prop` on any response, made absolute.
  async function findHref(url, prop, propName) {
    const { status, entries, base } = await propfind(url, 0, [prop]);
    if (!isOk(status)) throw httpError(status, 'find your calendars');
    for (const entry of entries) {
      const href = hrefOf(entry.props[propName]);
      const absolute = href && resolveUrl(href, base);
      if (absolute) return absolute;
    }
    throw new CalendarError("iCloud didn't say where your calendars are.");
  }

  // Remembered for the provider's lifetime (one sync or connect), so later calls skip it.
  async function discoverHome() {
    if (homeUrl) return homeUrl;
    principalUrl ??= await findHref(rootUrl, 'd:current-user-principal', 'current-user-principal');
    homeUrl = withSlash(await findHref(principalUrl, 'c:calendar-home-set', 'calendar-home-set'));
    return homeUrl;
  }

  // 'missing' | 'calendar' | 'other' (exists, not a calendar) | 'unknown' (no resourcetype given)
  async function calendarState(url) {
    const { status, entries } = await propfind(url, 0, ['d:resourcetype']);
    if (isGone(status)) return 'missing';
    if (!isOk(status)) throw httpError(status, 'find the ReLeet calendar');
    const entry = entries[0];
    if (!entry || (entry.status && entry.status >= 400)) return 'missing';
    const type = entry.props.resourcetype;
    if (!type) return 'unknown';
    return childNames(type).includes('calendar') ? 'calendar' : 'other';
  }

  async function findCalendar(home) {
    const props = ['d:resourcetype', 'd:displayname', 'c:supported-calendar-component-set'];
    const { status, entries, base } = await propfind(home, 1, props);
    if (!isOk(status)) throw httpError(status, 'find your calendars');
    for (const entry of entries) {
      if (!entry.href || (entry.status && entry.status >= 400)) continue;
      const resolved = resolveUrl(entry.href, base);
      if (!resolved) continue;
      const url = withSlash(onHomeHost(resolved, home, genericHost));
      if (url === home) continue;
      if (!childNames(entry.props.resourcetype).includes('calendar')) continue;
      if (textOf(entry.props.displayname) !== CALENDAR_NAME) continue;
      // Skip a Reminders list that happens to be called ReLeet. Servers that don't
      // report the component set at all are taken at their word.
      const comps = childrenNamed(entry.props['supported-calendar-component-set'], 'comp').map((c) =>
        String(c.attrs.name ?? '').toUpperCase(),
      );
      if (comps.length && !comps.includes('VEVENT')) continue;
      return url;
    }
    return null;
  }

  async function makeCalendar(home) {
    const url = `${home}${crypto.randomUUID()}/`;
    const res = await send(url, { method: 'MKCALENDAR', headers: XML_HEADERS, body: MKCALENDAR_BODY });
    if (!isOk(res.status)) throw httpError(res.status, 'create the ReLeet calendar');
    madeHere.add(url);
    return url;
  }

  // A PUT into a deleted calendar fails with 404 or 409 (no parent collection),
  // but so can other things. Look at the calendar before saying it's gone, since
  // calendarMissing makes the sync start over with a new calendar.
  async function eventFailure(status, calendarUrl, { update }) {
    if (status === 404 || status === 409 || status === 410) {
      const state = await calendarState(calendarUrl);
      if (state === 'missing' || state === 'other') return calendarMissing(status);
      if (update) return eventMissing(status);
    }
    return httpError(status, 'save a review event');
  }

  function putEvent(href, uid, slot, { create }) {
    return send(href, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', ...(create ? { 'If-None-Match': '*' } : {}) },
      body: buildEventIcs(slot, { uid, method: null, utc: true }),
    });
  }

  // iCloud doesn't always send an ETag on PUT (it's allowed not to), so it's optional.
  function eventRef(href, uid, res) {
    const etag = res.headers?.get?.('ETag');
    return etag ? { id: href, uid, etag } : { id: href, uid };
  }

  return {
    name: 'apple',

    describeAccount() {
      return user || null;
    },

    // Used by Connect: a wrong password fails here with a clear message
    // (reconnect: true) before anything is created.
    async verifyCredentials() {
      const home = await discoverHome();
      return { principalUrl, homeUrl: home };
    },

    async ensureCalendar(calendarId) {
      if (calendarId) {
        const state = await calendarState(withSlash(String(calendarId)));
        if (state === 'calendar' || state === 'unknown') return calendarId;
      }
      const home = await discoverHome();
      return (await findCalendar(home)) ?? (await makeCalendar(home));
    },

    async createEvent(calendarId, slot) {
      const calendarUrl = calendarUrlOf(calendarId);
      for (let tries = 1; ; tries += 1) {
        const uid = newUid(slot);
        const href = `${calendarUrl}${uid}.ics`;
        const res = await putEvent(href, uid, slot, { create: true });
        if (isOk(res.status)) return eventRef(href, uid, res);
        // 412: the name is taken, or iCloud's answer to a UID clash. A fresh UID fixes both.
        if (res.status === 412 && tries < 2) continue;
        throw await eventFailure(res.status, calendarUrl, { update: false });
      }
    },

    // ReLeet's events in the calendar that end after `from`, as { id, uid } refs
    // in the same form createEvent returns. Used to clear a "ReLeet" calendar
    // found again by name, and to find events whose create answer never arrived.
    // Events anyone else put there are left alone.
    async listEvents(calendarId, from) {
      const calendarUrl = calendarUrlOf(calendarId);
      if (madeHere.has(calendarUrl)) return [];
      const { res, answeredBy } = await request(calendarUrl, {
        method: 'REPORT',
        depth: 1,
        headers: XML_HEADERS,
        body: eventsAfterBody(from),
      });
      if (isGone(res.status)) throw calendarMissing(res.status);
      if (!isOk(res.status)) throw httpError(res.status, 'look through the ReLeet calendar');
      const refs = [];
      for (const entry of parseMultistatus(await readText(res))) {
        if (!entry.href || (entry.status && entry.status >= 400)) continue;
        const href = resolveUrl(entry.href, answeredBy);
        const uid = href && isEventHref(href) ? uidFromHref(href) : null;
        if (uid?.startsWith(UID_PREFIX)) refs.push({ id: `${calendarUrl}${uid}.ics`, uid });
      }
      return refs;
    },

    // A plain PUT on the same href (and UID) replaces the event in place.
    async updateEvent(calendarId, ref, slot) {
      const calendarUrl = calendarUrlOf(calendarId);
      const uid = ref?.uid || (ref?.id ? uidFromHref(ref.id) : null);
      const href = ref?.id || (uid ? `${calendarUrl}${uid}.ics` : null);
      // A ref that isn't one of our event resources can't be updated; the sync creates a new event instead.
      if (!uid || !isEventHref(href)) throw eventMissing();
      const res = await putEvent(href, uid, slot, { create: false });
      if (isOk(res.status)) return eventRef(href, uid, res);
      throw await eventFailure(res.status, calendarUrl, { update: true });
    },

    async deleteEvent(calendarId, ref) {
      const href = ref?.id || (ref?.uid && calendarId ? `${withSlash(String(calendarId))}${ref.uid}.ics` : null);
      if (!href || !isEventHref(href)) return; // nothing of ours to delete
      const res = await send(href, { method: 'DELETE' });
      if (isOk(res.status) || isGone(res.status)) return;
      throw httpError(res.status, 'delete a review event');
    },

    async deleteCalendar(calendarId) {
      if (!calendarId) return;
      const url = withSlash(String(calendarId));
      // DELETE on a collection removes everything in it. Check it's a calendar
      // first, so a wrong id can never delete the calendar home.
      const state = await calendarState(url);
      if (state === 'missing') return;
      if (state !== 'calendar') {
        throw new CalendarError("That iCloud address isn't a calendar, so ReLeet didn't delete it.");
      }
      const res = await send(url, { method: 'DELETE' });
      if (isOk(res.status) || isGone(res.status)) return;
      throw httpError(res.status, 'delete the ReLeet calendar');
    },
  };
}
