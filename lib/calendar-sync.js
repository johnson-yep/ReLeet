// Keeps every connected calendar in line with the review schedule. Worker only:
// the service worker is the single writer of the 'calendars' storage key.
//
// A sync plans the blocks (schedule.js), then for each connected provider
// compares the plan with the events ReLeet created there and applies the
// difference. The worker can be stopped at any moment, so each event created,
// moved or deleted is recorded in storage straight away; the next sync carries
// on from there instead of creating duplicates.

import { getCalendars, getProblems, getSchedule, getSettings, saveSchedule, updateCalendarState } from './storage.js';
import { diffEvents, planSchedule, slotHash } from './schedule.js';
import { chromeGoogleAuth, createGoogleProvider } from './calendars/google.js';
import { createOutlookAuth, createOutlookProvider } from './calendars/outlook.js';
import { createAppleProvider } from './calendars/apple.js';
import { OUTLOOK_CLIENT_ID } from './config.js';

export const PROVIDER_NAMES = ['google', 'outlook', 'apple'];

const UNCONFIGURED = {
  google: "Google Calendar isn't set up yet: add your Google OAuth client ID to manifest.json (see SETUP.md).",
  outlook: "Outlook isn't set up yet: add your Microsoft app's client ID to lib/config.js (see SETUP.md).",
};

const errorMessage = (err) => String(err?.message || err || 'Something went wrong.');
const unknownProvider = (name) => ({ status: 'error', error: `Unknown calendar: ${name}` });

// Runs async steps one at a time, in call order. A failed step doesn't block later ones.
function serial() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

// JSON with object keys sorted, so a schedule read back from storage compares
// equal to the same plan built fresh.
function canonical(value) {
  return JSON.stringify(value ?? null, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

async function describe(provider) {
  try {
    return (await provider.describeAccount?.()) || null;
  } catch {
    return null;
  }
}

// deps:
//   storage       { getProblems, getSettings, getSchedule, saveSchedule, getCalendars, updateCalendarState }
//   makeProvider  async (name, state, { interactive, updateState }) → provider (see calendars/*.js).
//                 interactive: sign in first (may show a window). It may set state.auth
//                 (e.g. new tokens); Connect stores whatever is there. updateState(updater)
//                 persists a change to this provider's stored state, during a sync only.
//   signOut       async (name, state), best effort, after a disconnect
//   isConfigured  (name) → boolean
//   planSchedule, diffEvents, slotHash, now
export function createCalendarSync({
  storage,
  makeProvider,
  signOut = async () => {},
  isConfigured = () => true,
  planSchedule: plan = planSchedule,
  diffEvents: diff = diffEvents,
  slotHash: hash = slotHash,
  now = Date.now,
}) {
  // Sync runs, Connect's save and Disconnect never interleave, so none of them
  // works from a provider state another one is halfway through changing.
  const exclusive = serial();
  const planning = serial();
  // Providers sync in parallel, and updateCalendarState is a read-modify-write
  // of the whole 'calendars' key, so its calls must not overlap.
  const writing = serial();

  const writeState = (name, updater) => writing(() => storage.updateCalendarState(name, updater));
  // Only touches a provider that is still connected, so a late write can never
  // bring back a calendar that was just disconnected.
  const patchState = (name, fn) => writeState(name, (prev) => (prev?.connected ? fn(prev) : prev));
  // makeProvider options for sync and disconnect: no sign-in window, and token
  // changes are stored right away.
  const unattended = (name) => ({ interactive: false, updateState: (fn) => patchState(name, fn) });

  const eventRef = (result, slot) => ({
    ...result,
    day: slot.day,
    start: slot.start,
    end: slot.end,
    hash: hash(slot),
  });

  // Plans the blocks and saves them only if something changed: an identical
  // write would still wake every schedule listener (popup, content script).
  function refreshSchedule(at = now()) {
    return planning(async () => {
      const [problems, settings, prev] = await Promise.all([
        storage.getProblems(),
        storage.getSettings(),
        storage.getSchedule(),
      ]);
      const next = plan(prev, problems, settings, at);
      if (canonical(prev) !== canonical(next)) await storage.saveSchedule(next);
      return next;
    });
  }

  async function syncProvider(name, state, entries, at) {
    const result = { created: 0, updated: 0, removed: 0, forgotten: 0, error: null };
    let calendarId = state.calendarId ?? null;
    let events = { ...(state.events ?? {}) };

    // ref null forgets the problem's event.
    const record = (problemId, ref) => {
      if (ref) events[problemId] = ref;
      else delete events[problemId];
      return patchState(name, (prev) => {
        const next = { ...(prev.events ?? {}) };
        if (ref) next[problemId] = ref;
        else delete next[problemId];
        return { ...prev, events: next };
      });
    };

    const useCalendar = async (id) => {
      calendarId = id;
      events = {};
      await patchState(name, (prev) => ({ ...prev, calendarId: id, events: {} }));
    };

    async function apply(provider) {
      const id = await provider.ensureCalendar(calendarId);
      // A different id means the old calendar is gone, and its events with it.
      if (id !== calendarId) await useCalendar(id);

      const ops = diff(entries, events, at);
      for (const problemId of ops.forget) {
        await record(problemId, null);
        result.forgotten++;
      }
      for (const { problemId, ref } of ops.remove) {
        await provider.deleteEvent(calendarId, ref);
        await record(problemId, null);
        result.removed++;
      }
      for (const { slot, ref } of ops.update) {
        let saved;
        try {
          saved = await provider.updateEvent(calendarId, ref, slot);
          result.updated++;
        } catch (err) {
          if (!err?.notFound) throw err;
          // Deleted by hand in the calendar app: put it back.
          saved = await provider.createEvent(calendarId, slot);
          result.created++;
        }
        await record(slot.problemId, eventRef(saved, slot));
      }
      for (const slot of ops.create) {
        const saved = await provider.createEvent(calendarId, slot);
        await record(slot.problemId, eventRef(saved, slot));
        result.created++;
      }
    }

    try {
      const provider = await makeProvider(name, { ...state }, unattended(name));
      try {
        await apply(provider);
      } catch (err) {
        if (!err?.calendarMissing) throw err;
        // The ReLeet calendar was deleted mid-sync: start over once with a new one.
        await useCalendar(null);
        await apply(provider);
      }
      await patchState(name, (prev) => ({ ...prev, lastSyncAt: now(), lastError: null, needsReconnect: false }));
    } catch (err) {
      // Stop this provider only; the next sync (15 min, or the next change) retries.
      result.error = errorMessage(err);
      await patchState(name, (prev) => ({
        ...prev,
        lastError: result.error,
        needsReconnect: Boolean(err?.reconnect),
      })).catch(() => {});
    }
    return result;
  }

  async function runSync() {
    try {
      const at = now();
      const schedule = await refreshSchedule(at);
      const calendars = await storage.getCalendars();
      const names = PROVIDER_NAMES.filter((name) => calendars[name]?.connected);
      // In parallel, so one slow or broken calendar doesn't hold up the others.
      const outcomes = await Promise.all(
        names.map((name) => syncProvider(name, calendars[name], schedule.entries, at)),
      );
      return {
        status: outcomes.some((r) => r.error) ? 'error' : 'ok',
        plan: { entries: Object.keys(schedule.entries).length },
        results: Object.fromEntries(names.map((name, i) => [name, outcomes[i]])),
      };
    } catch (err) {
      return { status: 'error', error: errorMessage(err), plan: null, results: {} };
    }
  }

  let running = null;
  let queued = null;

  function start() {
    running = exclusive(runSync).finally(() => {
      running = null;
    });
    return running;
  }

  // One run at a time. Calls during a run share a single rerun after it, which
  // sees every change made in the meantime.
  function syncCalendars() {
    if (queued) return queued;
    if (!running) return start();
    queued = running
      .catch(() => {})
      .then(() => {
        queued = null;
        return start();
      });
    return queued;
  }

  // Also used to reconnect: the same calendar (and its events) is kept when it still exists.
  async function connectCalendar(name, credentials) {
    if (!PROVIDER_NAMES.includes(name)) return unknownProvider(name);
    if (!isProviderConfigured(name)) return { status: 'unconfigured', error: UNCONFIGURED[name] };

    const prev = (await storage.getCalendars())[name] ?? null;
    // Nothing is stored until sign-in and the calendar both work, so a failure
    // (or the worker stopping) can't leave a half-connected calendar behind.
    const draft = { ...(prev ?? {}) };
    if (name === 'apple' && credentials) {
      draft.auth = {
        appleId: String(credentials.appleId ?? '').trim(),
        appPassword: String(credentials.appPassword ?? '').trim(),
      };
    }
    // Another Apple ID can't see the old account's calendar.
    const sameAppleId = name !== 'apple' || prev?.auth?.appleId === draft.auth?.appleId;
    const knownCalendarId = sameAppleId ? (prev?.calendarId ?? null) : null;

    let calendarId;
    let account;
    try {
      const provider = await makeProvider(name, draft, { interactive: true, updateState: async () => {} });
      calendarId = await provider.ensureCalendar(knownCalendarId);
      account = await describe(provider);
    } catch (err) {
      return { status: 'error', error: errorMessage(err) };
    }

    await exclusive(() =>
      writeState(name, (current) => {
        const sameCalendar = Boolean(current?.connected) && current.calendarId === calendarId;
        const next = {
          connected: true,
          calendarId,
          events: sameCalendar ? { ...(current.events ?? {}) } : {},
          lastSyncAt: sameCalendar ? (current.lastSyncAt ?? null) : null,
          lastError: null,
          needsReconnect: false,
          account,
        };
        if (draft.auth !== undefined) next.auth = draft.auth;
        return next;
      }),
    );
    // A failed first sync doesn't undo the connection: it shows as lastError and retries.
    await syncCalendars();
    return { status: 'connected', account };
  }

  async function disconnectCalendar(name, { force = false } = {}) {
    if (!PROVIDER_NAMES.includes(name)) return unknownProvider(name);
    return exclusive(async () => {
      const state = (await storage.getCalendars())[name] ?? null;
      if (!state) return { status: 'disconnected' };
      // Delete the calendar first: once the state is gone, ReLeet can't find it again.
      if (state.connected && state.calendarId) {
        try {
          const provider = await makeProvider(name, { ...state }, unattended(name));
          await provider.deleteCalendar(state.calendarId);
        } catch (err) {
          if (!force) return { status: 'error', error: errorMessage(err) };
        }
      }
      await writeState(name, () => null);
      try {
        await signOut(name, state);
      } catch {}
      return { status: 'disconnected' };
    });
  }

  function isProviderConfigured(name) {
    if (!PROVIDER_NAMES.includes(name)) return false;
    try {
      return Boolean(isConfigured(name));
    } catch {
      return false;
    }
  }

  return { syncCalendars, connectCalendar, disconnectCalendar, isProviderConfigured, refreshSchedule };
}

// ---- Chrome glue -------------------------------------------------------------

async function makeChromeProvider(name, state, { interactive = false, updateState = async () => {} } = {}) {
  if (name === 'google') {
    const auth = chromeGoogleAuth();
    // Shows Google's consent window; afterwards getToken(false) gets Chrome's cached token.
    if (interactive) await auth.getToken(true);
    return createGoogleProvider({
      getToken: auth.getToken,
      removeToken: auth.removeToken,
      getAccount: auth.getAccount,
    });
  }
  if (name === 'outlook') {
    // Tokens live on `state` so this run always has the newest refresh token
    // (Microsoft replaces it on every use). A sync also stores each new one at
    // once; during Connect they're saved with the rest of the connection.
    const auth = createOutlookAuth({
      clientId: OUTLOOK_CLIENT_ID,
      redirectUri: chrome.identity.getRedirectURL(),
      launchWebAuthFlow: (details) => chrome.identity.launchWebAuthFlow(details),
      loadAuth: async () => state.auth ?? null,
      saveAuth: async (next) => {
        state.auth = next;
        await updateState((prev) => ({ ...prev, auth: next }));
      },
    });
    if (interactive) await auth.signIn(true);
    return createOutlookProvider({ getAccessToken: auth.getAccessToken, getAccount: auth.getAccount });
  }
  if (name === 'apple') {
    const provider = createAppleProvider({ appleId: state.auth?.appleId, appPassword: state.auth?.appPassword });
    // A wrong password fails here with a clear message, before any calendar is made.
    if (interactive) await provider.verifyCredentials();
    return provider;
  }
  throw new Error(`Unknown calendar: ${name}`);
}

// Revokes ReLeet's Google grant and drops Chrome's cached token, so the next
// Connect asks again. Outlook and Apple keep their secrets in the removed state.
async function chromeSignOut(name) {
  if (name === 'google') await chromeGoogleAuth().revoke();
}

function isChromeProviderConfigured(name) {
  if (name === 'google') return chromeGoogleAuth().isConfigured();
  if (name === 'outlook') return String(OUTLOOK_CLIENT_ID ?? '').trim() !== '';
  return name === 'apple';
}

const chromeCalendarSync = createCalendarSync({
  storage: { getProblems, getSettings, getSchedule, saveSchedule, getCalendars, updateCalendarState },
  makeProvider: makeChromeProvider,
  signOut: chromeSignOut,
  isConfigured: isChromeProviderConfigured,
  planSchedule,
  diffEvents,
  slotHash,
  now: () => Date.now(),
});

export const { syncCalendars, connectCalendar, disconnectCalendar, isProviderConfigured, refreshSchedule } =
  chromeCalendarSync;
