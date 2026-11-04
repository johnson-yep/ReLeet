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

const signInExpired = () =>
  new CalendarError('Google sign-in expired. Reconnect Google Calendar in Settings.', { status: 401, reconnect: true });

function retryAfter(res) {
  const seconds = Number(res.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? ` Retrying in about ${Math.ceil(seconds)} s.` : '';
}

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
    return new CalendarError(`Google Calendar is limiting requests.${retryAfter(res) || ' Will retry later.'}`, {
      status,
    });
  }
  if (status === 403 && reasons.some((r) => PERMISSION_REASONS.has(r))) {
    return new CalendarError('ReLeet no longer has access to Google Calendar. Reconnect it in Settings.', {
      status,
      reconnect: true,
    });
  }
  if (status >= 500)
    return new CalendarError(`Google Calendar is having trouble (HTTP ${status}). Will retry later.`, { status });
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
// getAccount() (optional) → email for the UI.
export function createGoogleProvider({
  getToken,
  removeToken = async () => {},
  fetch: fetchFn = globalThis.fetch,
  timeZone = localTimeZone(),
  getAccount = null,
  timeoutMs = TIMEOUT_MS,
}) {
  let token = null;

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
      if (e?.name === 'TimeoutError')
        throw new CalendarError("Google Calendar didn't respond in time. Will retry later.");
      throw new CalendarError("Couldn't reach Google Calendar. Will retry when you're online.");
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
    if (!data?.id) throw new CalendarError('Google Calendar sent an unexpected response. Will retry later.');
    return data.id;
  }

  const eventsPath = (calendarId) => `/calendars/${seg(calendarId)}/events`;

  return {
    name: 'google',

    async ensureCalendar(calendarId) {
      if (calendarId) {
        const { status } = await request('GET', `/calendars/${seg(calendarId)}`, undefined, [404, 410]);
        if (!isGone(status)) return calendarId;
      }
      return createCalendar();
    },

    async createEvent(calendarId, slot) {
      const { status, data } = await request('POST', eventsPath(calendarId), googleEventBody(slot), [404, 410]);
      if (isGone(status)) {
        throw new CalendarError('The ReLeet calendar is gone from Google Calendar.', { status, calendarMissing: true });
      }
      if (!data?.id) throw new CalendarError('Google Calendar sent an unexpected response. Will retry later.');
      return { id: data.id };
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

    async describeAccount() {
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

// Network failures shouldn't send the user to Settings; everything else
// (not signed in, access revoked, consent declined) needs a reconnect.
function identityError(err, interactive) {
  const message = String(err?.message ?? err ?? '');
  if (/connection failed|net::|timed? ?out|network/i.test(message)) {
    return new CalendarError("Couldn't reach Google to sign in. Will retry when you're online.");
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
        'Calendar access was not granted. Connect again and allow ReLeet to manage its calendar.',
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

    // Email of the Chrome profile's account (the one getAuthToken uses).
    // Empty unless the manifest has the "identity.email" permission.
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
