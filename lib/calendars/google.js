// Google Calendar adapter (Calendar API v3). The provider itself is pure fetch;
// chrome.identity is only used by chromeGoogleAuth() at the bottom.
//
// Scope calendar.app.created lets ReLeet create its own calendars and manage
// events on them, nothing else. It does NOT allow calendarList.list, so an
// existing "ReLeet" calendar can't be looked up by name: without a stored id we
// always create a new one (disconnect deletes it again, so they don't pile up).

import { CalendarError } from './errors.js';

export const GOOGLE_API = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/calendar.app.created'];
export const GOOGLE_CLIENT_ID_PLACEHOLDER = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export const CALENDAR_NAME = 'ReLeet';
const CALENDAR_DESCRIPTION = 'Review blocks scheduled by ReLeet.';
const MAX_REMINDER_MINUTES = 40320; // API limit: 4 weeks
const TIMEOUT_MS = 20 * 1000;
const MAX_EVENT_PAGES = 10;

// Reasons Google uses (with 403) for quota and rate limits: retry later, not a sign-in problem.
const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
]);
// 403 reasons that mean the token lacks the calendar permission: only reconnecting fixes it.
const PERMISSION_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);

const seg = encodeURIComponent;
const isGone = (status) => status === 404 || status === 410;
const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;

// Messages name the cause only. Settings and the popup add what happens next
// (a retry every 15 minutes, or Reconnect), which depends on where they're shown.
const signInExpired = () => new CalendarError('Google sign-in expired.', { status: 401, reconnect: true });

// Google errors look like { error: { code, message, status,
//   errors: [{ reason, domain }], details: [{ reason }] } }.
function httpError(res, data) {
  const status = res.status;
  const err = data?.error ?? {};
  const list = (value) => (Array.isArray(value) ? value : []);
  const reasons = [...list(err.errors), ...list(err.details)].map((e) => e?.reason);
  const rateLimited =
    reasons.some((r) => RATE_LIMIT_REASONS.has(r)) || list(err.errors).some((e) => e?.domain === 'usageLimits');
  if (status === 429 || (status === 403 && rateLimited)) {
    return new CalendarError('Google Calendar is limiting requests.', { status });
  }
  if (status === 403 && reasons.some((r) => PERMISSION_REASONS.has(r))) {
    return new CalendarError('ReLeet no longer has access to Google Calendar.', {
      status,
      reconnect: true,
    });
  }
  if (status >= 500) return new CalendarError(`Google Calendar is having trouble (HTTP ${status}).`, { status });
  const detail = typeof err.message === 'string' && err.message ? `: ${err.message}` : ` (HTTP ${status})`;
  return new CalendarError(`Google Calendar request failed${detail}`, { status });
}

// The event as Google stores it. The same body is used for insert and patch,
// so a patch rewrites every field ReLeet owns.
export function googleEventBody(slot) {
  // null/undefined means no reminder (Number(null) would be 0, i.e. "at start").
  const minutes = slot.reminderMinutes == null ? NaN : Number(slot.reminderMinutes);
  const hasReminder = Number.isFinite(minutes) && minutes >= 0;
  const body = {
    summary: slot.title,
    description: slot.description,
    start: { dateTime: new Date(slot.start).toISOString() },
    end: { dateTime: new Date(slot.end).toISOString() },
    reminders: {
      useDefault: false,
      overrides: hasReminder ? [{ method: 'popup', minutes: Math.min(Math.round(minutes), MAX_REMINDER_MINUTES) }] : [],
    },
    transparency: 'opaque', // shows as busy
    extendedProperties: { private: { releetProblemId: String(slot.problemId) } },
  };
  // Google only accepts http(s) source URLs.
  if (/^https?:\/\//i.test(slot.url ?? '')) body.source = { title: 'ReLeet', url: slot.url };
  return body;
}

// getToken(interactive) → access token (throw CalendarError{reconnect} when signed out).
// removeToken(token) drops a rejected token from the cache so getToken returns a fresh one.
// getAccount() (optional) → email for the UI when the calendar doesn't name its owner.
export function createGoogleProvider({
  getToken,
  removeToken = async () => {},
  fetch: fetchFn = globalThis.fetch,
  timeZone = localTimeZone(),
  getAccount = null,
  timeoutMs = TIMEOUT_MS,
}) {
  let token = null;
  // Calendars this provider made itself: known to be empty, so there's nothing to list.
  const madeHere = new Set();
  // Email of the account that owns the ReLeet calendar, from the calendar
  // itself (dataOwner, set on secondary calendars). Needs no extra permission,
  // unlike chrome.identity's profile email.
  let owner = null;

  async function freshToken() {
    try {
      return await getToken(false);
    } catch (err) {
      if (err instanceof CalendarError) throw err;
      throw signInExpired();
    }
  }

  async function send(method, path, body) {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await fetchFn(GOOGLE_API + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // A hung request would stall the whole calendar sync.
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (e) {
      if (e?.name === 'TimeoutError') throw new CalendarError("Google Calendar didn't respond in time.");
      throw new CalendarError("Couldn't reach Google Calendar.");
    }
  }

  // → { status, data }. Statuses in `allow` are returned instead of thrown, so
  // each operation decides what a 404/410 means for it.
  async function request(method, path, body, allow = []) {
    token ??= await freshToken();
    let res = await send(method, path, body);
    if (res.status === 401) {
      // Cached tokens can be revoked or expire early: drop it and try once more.
      await removeToken(token).catch(() => {});
      token = await freshToken();
      res = await send(method, path, body);
      if (res.status === 401) {
        await removeToken(token).catch(() => {});
        token = null;
        throw signInExpired();
      }
    }
    let data = null;
    try {
      data = res.status === 204 ? null : await res.json();
    } catch {}
    if (res.ok || allow.includes(res.status)) return { status: res.status, data };
    throw httpError(res, data);
  }

  async function createCalendar() {
    const body = { summary: CALENDAR_NAME, description: CALENDAR_DESCRIPTION };
    if (timeZone) body.timeZone = timeZone;
    const { data } = await request('POST', '/calendars', body);
    if (!data?.id) throw new CalendarError('Google Calendar sent an unexpected response.');
    madeHere.add(data.id);
    owner = data.dataOwner || owner;
    return data.id;
  }

  const calendarGone = (status) =>
    new CalendarError('The ReLeet calendar is gone from Google Calendar.', { status, calendarMissing: true });

  const eventsPath = (calendarId) => `/calendars/${seg(calendarId)}/events`;

  return {
    name: 'google',

    async ensureCalendar(calendarId) {
      if (calendarId) {
        const { status, data } = await request('GET', `/calendars/${seg(calendarId)}`, undefined, [404, 410]);
        if (!isGone(status)) {
          owner = data?.dataOwner || owner;
          return calendarId;
        }
      }
      return createCalendar();
    },

    async createEvent(calendarId, slot) {
      const { status, data } = await request('POST', eventsPath(calendarId), googleEventBody(slot), [404, 410]);
      if (isGone(status)) throw calendarGone(status);
      if (!data?.id) throw new CalendarError('Google Calendar sent an unexpected response.');
      return { id: data.id };
    },

    // ReLeet's events (they carry releetProblemId) that end after `from`, as
    // { id } refs. Used to find events whose create answer never arrived.
    async listEvents(calendarId, from) {
      if (madeHere.has(calendarId)) return [];
      const refs = [];
      let pageToken = null;
      for (let page = 0; page < MAX_EVENT_PAGES; page++) {
        // timeMin filters on the event's end time.
        const params = new URLSearchParams({ timeMin: new Date(from).toISOString(), maxResults: '250' });
        if (pageToken) params.set('pageToken', pageToken);
        const { status, data } = await request('GET', `${eventsPath(calendarId)}?${params}`, undefined, [404, 410]);
        if (isGone(status)) throw calendarGone(status);
        for (const item of data?.items ?? []) {
          if (item?.id && item.status !== 'cancelled' && item.extendedProperties?.private?.releetProblemId != null) {
            refs.push({ id: item.id });
          }
        }
        pageToken = data?.nextPageToken ?? null;
        if (!pageToken) break;
      }
      return refs;
    },

    async updateEvent(calendarId, ref, slot) {
      const path = `${eventsPath(calendarId)}/${seg(ref.id)}`;
      const { status, data } = await request('PATCH', path, googleEventBody(slot), [404, 410]);
      // Events deleted in Google Calendar linger as status "cancelled"; treat them as gone.
      if (isGone(status) || data?.status === 'cancelled') {
        throw new CalendarError('The calendar event was deleted.', { status, notFound: true });
      }
      return { id: data?.id ?? ref.id };
    },

    async deleteEvent(calendarId, ref) {
      await request('DELETE', `${eventsPath(calendarId)}/${seg(ref.id)}`, undefined, [404, 410]);
    },

    async deleteCalendar(calendarId) {
      await request('DELETE', `/calendars/${seg(calendarId)}`, undefined, [404, 410]);
    },

    // Known once ensureCalendar has run (Connect calls it first).
    async describeAccount() {
      if (owner) return owner;
      if (!getAccount) return null;
      try {
        return (await getAccount()) || null;
      } catch {
        return null;
      }
    },
  };
}

export function isGoogleClientIdConfigured(clientId) {
  const id = String(clientId ?? '').trim();
  return Boolean(id) && id !== GOOGLE_CLIENT_ID_PLACEHOLDER && !id.startsWith('YOUR_');
}

// ---- Chrome glue -----------------------------------------------------------
// chrome.identity keeps the refresh token and caches access tokens itself, so
// calling getToken(false) before every sync is cheap.

// Network failures and Google-side hiccups shouldn't send the user to
// Settings; everything else (not signed in, access revoked, consent declined)
// needs a reconnect. The hiccups are the errors Chrome itself counts as worth
// retrying (GoogleServiceAuthError::IsTransientError), which reach us as
// "OAuth2 request failed: Service unavailable; try again later (…)." and the
// like. Unknown errors still mean reconnect, so a real revocation is never
// hidden behind "will retry". Interactive means Connect: nothing retries
// that by itself, so those messages say to try again.
function identityError(err, interactive) {
  const message = String(err?.message ?? err ?? '');
  if (/connection failed|net::|timed? ?out|network/i.test(message)) {
    return new CalendarError(
      `Couldn't reach Google to sign in.${interactive ? ' Check your connection and try again.' : ''}`,
    );
  }
  if (/service unavailable|request canceled|token binding challenge/i.test(message)) {
    return new CalendarError(`Google sign-in is having trouble right now.${interactive ? ' Try again in a moment.' : ''}`);
  }
  if (interactive) {
    return new CalendarError(`Google sign-in didn't complete${message ? `: ${message}` : '.'}`, { reconnect: true });
  }
  return signInExpired();
}

export function chromeGoogleAuth({ fetch: fetchFn = globalThis.fetch } = {}) {
  const identity = () => globalThis.chrome.identity;

  async function getToken(interactive = false) {
    let result;
    try {
      result = await identity().getAuthToken({ interactive, scopes: GOOGLE_SCOPES });
    } catch (err) {
      throw identityError(err, interactive);
    }
    // The Promise form resolves to { token, grantedScopes } (Chrome 105+).
    const token = typeof result === 'string' ? result : result?.token;
    if (!token) throw identityError(null, interactive);
    const granted = result?.grantedScopes;
    // With granular consent the user can untick the calendar permission.
    if (Array.isArray(granted) && !GOOGLE_SCOPES.every((s) => granted.includes(s))) {
      await removeToken(token);
      throw new CalendarError(
        "Calendar access wasn't granted: allow ReLeet to manage its calendar when you connect.",
        {
          reconnect: true,
        },
      );
    }
    return token;
  }

  async function removeToken(token) {
    if (!token) return;
    try {
      await identity().removeCachedAuthToken({ token });
    } catch {}
  }

  return {
    getToken,
    removeToken,

    // Best effort, never throws: revokes the grant at Google (so the next
    // connect asks for consent again) and drops the token from Chrome's cache.
    async revoke(token = null) {
      try {
        token ??= (await identity().getAuthToken({ interactive: false, scopes: GOOGLE_SCOPES }))?.token ?? null;
      } catch {}
      if (!token) return;
      try {
        await fetchFn(`${REVOKE_URL}?token=${seg(token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
      } catch {}
      await removeToken(token);
    },

    isConfigured() {
      try {
        return isGoogleClientIdConfigured(globalThis.chrome.runtime.getManifest()?.oauth2?.client_id);
      } catch {
        return false;
      }
    },

    // Email of the Chrome profile's account (normally the one getAuthToken
    // uses). Chrome only fills it in with the "identity.email" permission,
    // which ReLeet doesn't ask for, so this is a fallback: the provider names
    // the calendar's owner instead (dataOwner).
    async getAccount() {
      try {
        const info = await identity().getProfileUserInfo({ accountStatus: 'ANY' });
        return info?.email || null;
      } catch {
        return null;
      }
    },
  };
}
