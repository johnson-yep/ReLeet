// Outlook / Microsoft 365 adapter (Microsoft Graph v1.0) plus the sign-in that
// feeds it. The provider and the auth are pure fetch with everything injected;
// chrome.identity is only touched by the defaults of createOutlookAuth().
//
// Sign-in is the OAuth 2.0 auth code flow with PKCE against the /common
// endpoints (personal and work/school accounts), with the extension's
// https://<id>.chromiumapp.org/ URL registered as a "Single-page application"
// redirect: public client, no client secret, token requests are form-encoded.
// Refresh tokens issued to SPA redirects expire 24 h after sign-in no matter how
// often they're used, so once a day we re-run the flow silently (prompt=none,
// works while the Microsoft session cookie is alive) before asking the user.

import { CalendarError } from './errors.js';
import { OUTLOOK_CLIENT_ID } from '../config.js';

export const GRAPH_API = 'https://graph.microsoft.com/v1.0';
export const MICROSOFT_AUTHORITY = 'https://login.microsoftonline.com/common';
// Calendars.ReadWrite has no "only calendars this app created" variant. The
// OpenID scopes give us the account name for the UI and a refresh token.
export const OUTLOOK_SCOPES = ['Calendars.ReadWrite', 'offline_access', 'openid', 'profile'];

export const CALENDAR_NAME = 'ReLeet';
const TIMEOUT_MS = 20 * 1000;
const SILENT_TIMEOUT_MS = 15 * 1000;
// Treat an access token as expired a little early so it doesn't lapse mid-sync.
export const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const MAX_CALENDAR_PAGES = 10;

const seg = encodeURIComponent;

const signInExpired = () =>
  new CalendarError('Outlook sign-in expired. Reconnect Outlook in Settings.', { status: 401, reconnect: true });

// ---- PKCE (RFC 7636) and token helpers ---------------------------------------

export function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// 32 random bytes → a 43-character verifier (the RFC's recommended size).
// Pass `bytes` only in tests.
export async function createPkcePair(bytes = crypto.getRandomValues(new Uint8Array(32))) {
  const verifier = base64url(bytes);
  return { verifier, challenge: await pkceChallenge(verifier) };
}

// Reads a JWT's claims WITHOUT verifying it. Only for showing the account name;
// never use the result for access decisions.
export function decodeJwtPayload(jwt) {
  try {
    const part = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(part.padEnd(Math.ceil(part.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

export function accountFromIdToken(idToken) {
  const claims = idToken ? decodeJwtPayload(idToken) : null;
  return claims?.preferred_username || claims?.email || claims?.upn || null;
}

// Entra descriptions run on with trace and correlation ids; keep the first line,
// which has the AADSTS code and the readable reason.
function describeOAuthError(data, fallback) {
  const description = String(data?.error_description ?? '')
    .split(/\r?\n|\s+Trace ID:/)[0]
    .trim();
  return description || data?.error || fallback;
}

export function isOutlookConfigured(clientId = OUTLOOK_CLIENT_ID) {
  return Boolean(String(clientId ?? '').trim());
}

// ---- Sign-in ------------------------------------------------------------------

// loadAuth() → { accessToken, refreshToken, expiresAt, account } | null
// saveAuth(auth | null) persists it (null on sign-out).
export function createOutlookAuth({
  clientId = OUTLOOK_CLIENT_ID,
  redirectUri = null, // defaults to chrome.identity.getRedirectURL()
  launchWebAuthFlow = (details) => globalThis.chrome.identity.launchWebAuthFlow(details),
  fetch: fetchFn = globalThis.fetch,
  loadAuth,
  saveAuth,
  now = Date.now,
  scopes = OUTLOOK_SCOPES,
  authority = MICROSOFT_AUTHORITY,
  createPkce = createPkcePair,
  timeoutMs = TIMEOUT_MS,
}) {
  const scope = scopes.join(' ');
  const redirect = () => redirectUri ?? globalThis.chrome.identity.getRedirectURL();
  let renewing = null;

  async function postToken(params, previous) {
    let res;
    let data = null;
    try {
      res = await fetchFn(`${authority}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, scope, ...params }).toString(),
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      data = await res.json().catch(() => null);
    } catch {
      throw new CalendarError("Couldn't reach Microsoft to sign in. Will retry when you're online.");
    }
    if (!res.ok || !data?.access_token) {
      if (res.status === 429 || res.status >= 500) {
        throw new CalendarError(`Microsoft sign-in is having trouble (HTTP ${res.status}). Will retry later.`, {
          status: res.status,
        });
      }
      // invalid_grant (expired/revoked refresh token, bad code), interaction_required, …
      throw new CalendarError(`Microsoft sign-in failed: ${describeOAuthError(data, `HTTP ${res.status}`)}`, {
        status: res.status,
        reconnect: true,
      });
    }

    const lifetimeMs = (Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600) * 1000;
    const auth = {
      accessToken: data.access_token,
      // Microsoft hands out a new refresh token on every use; keep the newest.
      refreshToken: data.refresh_token ?? previous?.refreshToken ?? null,
      expiresAt: now() + Math.max(lifetimeMs - EXPIRY_MARGIN_MS, lifetimeMs / 2),
      account: accountFromIdToken(data.id_token) ?? previous?.account ?? null,
    };
    await saveAuth(auth);
    return auth;
  }

  // Runs the browser part of the flow and redeems the code → saved auth.
  async function authorize(interactive, previous = null) {
    if (!isOutlookConfigured(clientId)) {
      throw new CalendarError(
        "Outlook isn't set up yet: add your Microsoft app's client ID to lib/config.js (see SETUP.md).",
      );
    }
    const { verifier, challenge } = await createPkce();
    const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirect(),
      response_mode: 'query',
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      // Silent: fail fast with an error redirect instead of showing a page.
      prompt: interactive ? 'select_account' : 'none',
    });
    if (!interactive && previous?.account) params.set('login_hint', previous.account);

    const details = { url: `${authority}/oauth2/v2.0/authorize?${params}`, interactive };
    if (!interactive) {
      // Microsoft personal accounts can hop through script redirects, so give
      // the hidden flow a moment instead of aborting on the first page load.
      details.abortOnLoadForNonInteractive = false;
      details.timeoutMsForNonInteractive = SILENT_TIMEOUT_MS;
    }

    let responseUrl;
    try {
      responseUrl = await launchWebAuthFlow(details);
    } catch (err) {
      // Chrome reports an offline sign-in page as "could not be loaded": not the user's job to fix.
      if (/could not be loaded|net::|connection/i.test(String(err?.message ?? ''))) {
        throw new CalendarError("Couldn't reach Microsoft to sign in. Will retry when you're online.");
      }
      if (!interactive) throw signInExpired();
      throw new CalendarError(`Microsoft sign-in didn't complete${err?.message ? `: ${err.message}` : '.'}`, {
        reconnect: true,
      });
    }

    let url;
    try {
      url = new URL(responseUrl);
    } catch {
      throw new CalendarError("Microsoft sign-in didn't complete.", { reconnect: true });
    }
    const result =
      url.searchParams.has('code') || url.searchParams.has('error')
        ? url.searchParams
        : new URLSearchParams(url.hash.slice(1));

    if (result.get('error')) {
      if (!interactive) throw signInExpired(); // login_required, interaction_required, …
      throw new CalendarError(
        `Microsoft sign-in failed: ${describeOAuthError(Object.fromEntries(result), 'unknown error')}`,
        {
          reconnect: true,
        },
      );
    }
    // Guards against a response that belongs to a different (forged or stale) request.
    if (result.get('state') !== state) {
      throw new CalendarError('Microsoft sign-in failed: the response did not match the request. Try again.', {
        reconnect: true,
      });
    }
    const code = result.get('code');
    if (!code)
      throw new CalendarError('Microsoft sign-in failed: no authorization code was returned.', { reconnect: true });

    return postToken(
      { grant_type: 'authorization_code', code, redirect_uri: redirect(), code_verifier: verifier },
      previous,
    );
  }

  async function renew(auth) {
    if (auth.refreshToken) {
      try {
        return await postToken({ grant_type: 'refresh_token', refresh_token: auth.refreshToken }, auth);
      } catch (err) {
        if (!err.reconnect) throw err; // offline or Microsoft down: retry later, keep the tokens
      }
    }
    try {
      return await authorize(false, auth);
    } catch (err) {
      throw err.reconnect ? signInExpired() : err;
    }
  }

  return {
    // Interactive from the Connect button. → { account }
    // A fresh interactive sign-in may pick another account, so it starts clean.
    async signIn(interactive = true) {
      const auth = await authorize(interactive, interactive ? null : await loadAuth());
      return { account: auth.account };
    },

    // Cached token while it's fresh, otherwise refresh token, otherwise silent
    // sign-in, otherwise CalendarError{reconnect}. forceRefresh after a 401.
    async getAccessToken({ forceRefresh = false } = {}) {
      const auth = await loadAuth();
      if (!auth) throw signInExpired();
      if (!forceRefresh && auth.accessToken && now() < (auth.expiresAt ?? 0)) return auth.accessToken;
      // Concurrent callers share one renewal.
      renewing ??= renew(auth).finally(() => {
        renewing = null;
      });
      return (await renewing).accessToken;
    },

    async getAccount() {
      return (await loadAuth())?.account ?? null;
    },

    // Forgets the tokens. Microsoft has no token-revocation endpoint for public
    // clients; access can be removed at account.microsoft.com / myapps.
    async signOut() {
      await saveAuth(null);
    },
  };
}

// ---- Graph provider ----------------------------------------------------------

// Graph wants local-looking date-times plus a zone name; we always send UTC.
const graphDateTime = (ms) => ({ dateTime: new Date(ms).toISOString().slice(0, 19), timeZone: 'UTC' });

export function outlookEventBody(slot) {
  // null/undefined means no reminder (Number(null) would be 0, i.e. "at start").
  const minutes = slot.reminderMinutes == null ? NaN : Number(slot.reminderMinutes);
  const hasReminder = Number.isFinite(minutes) && minutes >= 0;
  const body = {
    subject: slot.title,
    body: { contentType: 'text', content: slot.description ?? '' },
    start: graphDateTime(slot.start),
    end: graphDateTime(slot.end),
    isReminderOn: hasReminder,
    showAs: 'busy',
  };
  if (hasReminder) body.reminderMinutesBeforeStart = Math.round(minutes);
  return body;
}

function retryAfter(res) {
  const seconds = Number(res.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? ` Retrying in about ${Math.ceil(seconds)} s.` : '';
}

// Graph errors look like { error: { code: 'ErrorItemNotFound', message } }.
function httpError(res, data) {
  const status = res.status;
  const code = data?.error?.code ?? '';
  if (status === 429 || status === 503 || status === 504) {
    return new CalendarError(`Outlook is limiting requests.${retryAfter(res) || ' Will retry later.'}`, { status });
  }
  if (code === 'MailboxNotEnabledForRESTAPI' || code === 'MailboxNotSupportedForRESTAPI') {
    return new CalendarError('This Microsoft account has no Outlook calendar. Connect a different account.', {
      status,
      reconnect: true,
    });
  }
  if (status === 403) {
    return new CalendarError('ReLeet no longer has access to your Outlook calendar. Reconnect it in Settings.', {
      status,
      reconnect: true,
    });
  }
  if (status >= 500)
    return new CalendarError(`Outlook is having trouble (HTTP ${status}). Will retry later.`, { status });
  const message = data?.error?.message;
  return new CalendarError(`Outlook request failed${message ? `: ${message}` : ` (HTTP ${status})`}`, { status });
}

// getAccessToken({ forceRefresh }) → Graph access token (createOutlookAuth().getAccessToken).
// getAccount() (optional) → email for the UI.
export function createOutlookProvider({
  getAccessToken,
  fetch: fetchFn = globalThis.fetch,
  getAccount = null,
  timeoutMs = TIMEOUT_MS,
}) {
  async function token(forceRefresh) {
    try {
      return await getAccessToken({ forceRefresh });
    } catch (err) {
      if (err instanceof CalendarError) throw err;
      throw signInExpired();
    }
  }

  async function send(method, url, accessToken, body) {
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await fetchFn(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (e) {
      if (e?.name === 'TimeoutError') throw new CalendarError("Outlook didn't respond in time. Will retry later.");
      throw new CalendarError("Couldn't reach Outlook. Will retry when you're online.");
    }
  }

  // → { status, data }. Statuses in `allow` are returned instead of thrown.
  // `path` may be a full URL (Graph's @odata.nextLink).
  async function request(method, path, body, allow = []) {
    const url = path.startsWith('https://') ? path : GRAPH_API + path;
    let res = await send(method, url, await token(false), body);
    if (res.status === 401) {
      // The token may have been revoked before its expiry: get a new one once.
      res = await send(method, url, await token(true), body);
      if (res.status === 401) throw signInExpired();
    }
    let data = null;
    try {
      data = res.status === 204 ? null : await res.json();
    } catch {}
    if (res.ok || allow.includes(res.status)) return { status: res.status, data, res };
    throw httpError(res, data);
  }

  const unexpected = () => new CalendarError('Outlook sent an unexpected response. Will retry later.');

  // Outlook folder names are unique per mailbox (compared case-insensitively),
  // so after ErrorFolderExists there is exactly one to reuse.
  async function findCalendarByName(name) {
    let next = '/me/calendars?$select=id,name&$top=100';
    for (let page = 0; next && page < MAX_CALENDAR_PAGES; page++) {
      const { data } = await request('GET', next);
      const match = (data?.value ?? []).find((c) => String(c?.name ?? '').toLowerCase() === name.toLowerCase());
      if (match?.id) return match.id;
      next = data?.['@odata.nextLink'] ?? null;
    }
    return null;
  }

  async function createCalendar() {
    // Graph has answered a duplicate name with both 409 and 400, always with ErrorFolderExists.
    const { status, data, res } = await request('POST', '/me/calendars', { name: CALENDAR_NAME }, [400, 409]);
    if (status === 409 || data?.error?.code === 'ErrorFolderExists') {
      const id = await findCalendarByName(CALENDAR_NAME);
      if (id) return id;
      throw new CalendarError('A calendar named ReLeet exists in Outlook but could not be opened.', { status });
    }
    if (status === 400) throw httpError(res, data);
    if (!data?.id) throw unexpected();
    return data.id;
  }

  return {
    name: 'outlook',

    async ensureCalendar(calendarId) {
      if (calendarId) {
        const { status } = await request('GET', `/me/calendars/${seg(calendarId)}?$select=id`, undefined, [404]);
        if (status !== 404) return calendarId;
      }
      return createCalendar();
    },

    async createEvent(calendarId, slot) {
      const path = `/me/calendars/${seg(calendarId)}/events`;
      const { status, data } = await request('POST', path, outlookEventBody(slot), [404]);
      if (status === 404) {
        throw new CalendarError('The ReLeet calendar is gone from Outlook.', { status, calendarMissing: true });
      }
      if (!data?.id) throw unexpected();
      return { id: data.id };
    },

    async updateEvent(calendarId, ref, slot) {
      const { status, data } = await request('PATCH', `/me/events/${seg(ref.id)}`, outlookEventBody(slot), [404]);
      if (status === 404) throw new CalendarError('The calendar event was deleted.', { status, notFound: true });
      return { id: data?.id ?? ref.id };
    },

    async deleteEvent(calendarId, ref) {
      await request('DELETE', `/me/events/${seg(ref.id)}`, undefined, [404]);
    },

    async deleteCalendar(calendarId) {
      await request('DELETE', `/me/calendars/${seg(calendarId)}`, undefined, [404]);
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
