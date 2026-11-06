// Keeps every connected calendar in line with the review schedule. Worker only:
// the service worker is the single writer of the 'calendars' storage key.
//
// A sync plans the blocks (schedule.js), then for each connected provider
// compares the plan with the events ReLeet created there and applies the
// difference. The worker can be stopped at any moment, so each event created,
// moved or deleted is recorded in storage straight away; the next sync carries
// on from there instead of creating duplicates. A create whose answer never
// arrived (timeout, worker stopped) can still leave an event ReLeet doesn't
// know about, so the next sync looks for such strays and deletes them first
// (see checkStrays below).

import { getCalendars, getProblems, getSchedule, getSettings, saveSchedule, updateCalendarState } from './storage.js';
import { bookedProblems, diffEvents, planSchedule, slotHash } from './schedule.js';
import { chromeGoogleAuth, createGoogleProvider } from './calendars/google.js';
import { createAppleProvider } from './calendars/apple.js';

export const PROVIDER_NAMES = ['google', 'apple'];

const UNCONFIGURED = {
  google: "Google Calendar isn't available in this copy of ReLeet yet.",
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

// What "Disconnect anyway" keeps when the calendar couldn't be deleted: its id
// and event map, but no sign-in or password. Connecting again then reuses the
// calendar and its events instead of adding every review a second time.
function leftover(name, state) {
  const kept = {
    connected: false,
    calendarId: state.calendarId ?? null,
    events: { ...(state.events ?? {}) },
    checkStrays: Boolean(state.checkStrays),
    account: state.account ?? null,
  };
  // The Apple ID (never the password) says whose calendar it is.
  if (name === 'apple' && state.auth?.appleId) kept.auth = { appleId: state.auth.appleId };
  return kept;
}

// A 4xx that isn't about sign-in or rate limits: the calendar can't be opened
// with this account, and asking again won't change that.
function unreachable(err) {
  const status = Number(err?.status);
  return status >= 400 && status < 500 && status !== 408 && status !== 429 && !err?.reconnect;
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
//   makeProvider  async (name, state, { interactive }) → provider (see calendars/*.js).
//                 interactive: sign in first (may show a window).
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
  // makeProvider options for sync and disconnect: no sign-in window.
  const unattended = { interactive: false };

  const eventRef = (result, slot) => ({
    ...result,
    day: slot.day,
    start: slot.start,
    end: slot.end,
    hash: hash(slot),
  });

  // Plans the blocks and saves them only if something changed: an identical
  // write would still wake every schedule listener (the popup).
  function refreshSchedule(at = now()) {
    return planning(async () => {
      const [problems, settings, prev, calendars] = await Promise.all([
        storage.getProblems(),
        storage.getSettings(),
        storage.getSchedule(),
        storage.getCalendars(),
      ]);
      const next = plan(prev, problems, settings, at, { booked: bookedProblems(prev, calendars) });
      if (canonical(prev) !== canonical(next)) await storage.saveSchedule(next);
      return next;
    });
  }

  // Deletes ReLeet's events in the calendar that haven't ended and that
  // `events` doesn't know. Providers without listEvents never need it.
  // → how many were deleted.
  async function deleteStrays(provider, calendarId, events, at) {
    if (typeof provider.listEvents !== 'function') return 0;
    const known = new Set(Object.values(events ?? {}).map((ref) => ref?.id));
    let deleted = 0;
    for (const ref of await provider.listEvents(calendarId, at)) {
      if (known.has(ref.id)) continue;
      await provider.deleteEvent(calendarId, ref);
      deleted++;
    }
    return deleted;
  }

  async function syncProvider(name, state, entries, at) {
    const result = { created: 0, updated: 0, removed: 0, forgotten: 0, error: null };
    let calendarId = state.calendarId ?? null;
    let events = { ...(state.events ?? {}) };
    // Stored, and true while the calendar may hold ReLeet events the map
    // doesn't: one found again by name, or after a create whose answer never
    // came. Cleared once a run gets through without that doubt.
    let checkStrays = Boolean(state.checkStrays);

    const setCheckStrays = async () => {
      checkStrays = true;
      await patchState(name, (prev) => ({ ...prev, checkStrays: true }));
    };

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

    // The calendar may be one found again by name, so it's checked for strays.
    const useCalendar = async (id) => {
      calendarId = id;
      events = {};
      checkStrays = true;
      await patchState(name, (prev) => ({ ...prev, calendarId: id, events: {}, checkStrays: true }));
    };

    // An event exists once the server says so, but its answer can get lost.
    const createEvent = async (provider, slot) => {
      if (!checkStrays) await setCheckStrays();
      return provider.createEvent(calendarId, slot);
    };

    async function apply(provider) {
      const id = await provider.ensureCalendar(calendarId);
      // A different id means the old calendar is gone, and its events with it.
      if (id !== calendarId) await useCalendar(id);
      if (checkStrays) result.removed += await deleteStrays(provider, calendarId, events, at);

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
          saved = await createEvent(provider, slot);
          result.created++;
        }
        await record(slot.problemId, eventRef(saved, slot));
      }
      for (const slot of ops.create) {
        const saved = await createEvent(provider, slot);
        await record(slot.problemId, eventRef(saved, slot));
        result.created++;
      }
    }

    try {
      const provider = await makeProvider(name, { ...state }, unattended);
      try {
        await apply(provider);
      } catch (err) {
        if (!err?.calendarMissing) throw err;
        // An event call says the calendar is gone: start over once. apply()
        // asks ensureCalendar first, so the calendar (and the map of its
        // events) is only replaced if it really is gone, not after a stray 404.
        await apply(provider);
      }
      await patchState(name, (prev) => ({
        ...prev,
        lastSyncAt: now(),
        lastError: null,
        needsReconnect: false,
        checkStrays: false,
      }));
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
      const connected = PROVIDER_NAMES.filter((name) => calendars[name]?.connected);
      // A disconnect the worker didn't get to finish: finish it now. Syncing
      // would make the deleted calendar again.
      for (const name of connected.filter((n) => calendars[n].disconnecting)) {
        await removeProvider(name, { resumed: true });
      }
      const names = connected.filter((name) => !calendars[name].disconnecting);
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

  // Opens the remembered calendar, or finds or makes one. A calendar left behind
  // by "Disconnect anyway" may be out of reach now (another account, access
  // revoked with the sign-in): then start afresh instead of failing.
  async function openCalendar(provider, calendarId, isLeftover) {
    try {
      return await provider.ensureCalendar(calendarId);
    } catch (err) {
      if (!isLeftover || !calendarId || !unreachable(err)) throw err;
      return provider.ensureCalendar(null);
    }
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

    let provider;
    try {
      provider = await makeProvider(name, draft, { interactive: true });
    } catch (err) {
      return { status: 'error', error: errorMessage(err) };
    }

    // After sign-in (which can take a while), the calendar is opened or made
    // and stored in one step, away from syncs, so a new calendar is never left
    // unrecorded while a sync runs.
    const result = await exclusive(async () => {
      const current = (await storage.getCalendars())[name] ?? null;
      // Another Apple ID can't see the old account's calendar.
      const sameAccount = name !== 'apple' || current?.auth?.appleId === draft.auth?.appleId;
      const knownCalendarId = sameAccount ? (current?.calendarId ?? null) : null;

      let calendarId;
      let account;
      try {
        calendarId = await openCalendar(provider, knownCalendarId, Boolean(current && !current.connected));
        // A calendar ReLeet has no event map for (found again by name, e.g.
        // after a reinstall) may still hold blocks from before. Clear the
        // upcoming ones, or every review would be on it twice.
        if (calendarId !== knownCalendarId) await deleteStrays(provider, calendarId, {}, now());
        account = await describe(provider);
      } catch (err) {
        return { status: 'error', error: errorMessage(err) };
      }

      const keep = calendarId === knownCalendarId;
      await writeState(name, () => {
        const next = {
          connected: true,
          calendarId,
          events: keep ? { ...(current.events ?? {}) } : {},
          lastSyncAt: keep && current.connected ? (current.lastSyncAt ?? null) : null,
          lastError: null,
          needsReconnect: false,
          checkStrays: keep ? Boolean(current.checkStrays) : false,
          account,
        };
        if (draft.auth !== undefined) next.auth = draft.auth;
        return next;
      });
      return { status: 'connected', account };
    });
    // A failed first sync doesn't undo the connection: it shows as lastError and retries.
    if (result.status === 'connected') await syncCalendars();
    return result;
  }

  // Runs inside exclusive(). `resumed`: finishing a disconnect the worker
  // stopped in the middle of (see runSync).
  async function removeProvider(name, { force = false, resumed = false } = {}) {
    const state = (await storage.getCalendars())[name] ?? null;
    if (!state) return { status: 'disconnected' };
    let leftBehind = false;
    // Delete the calendar first: once the state is gone, ReLeet can't find it again.
    if (state.connected && state.calendarId) {
      // Marked first, so if the worker stops after the calendar is deleted but
      // before the state is removed, the next sync finishes the disconnect
      // instead of making the calendar again.
      if (!state.disconnecting) await patchState(name, (prev) => ({ ...prev, disconnecting: true }));
      try {
        const provider = await makeProvider(name, { ...state }, unattended);
        await provider.deleteCalendar(state.calendarId);
      } catch (err) {
        if (!force) {
          const error = errorMessage(err);
          const reconnect = Boolean(err?.reconnect);
          await patchState(name, ({ disconnecting, ...prev }) => ({
            ...prev,
            // A resumed disconnect keeps its mark and is tried again on the next sync.
            ...(resumed ? { disconnecting, lastError: error, needsReconnect: reconnect } : {}),
            // Sign-in is the problem: Settings shows Reconnect, after which Disconnect works.
            ...(reconnect ? { lastError: error, needsReconnect: true } : {}),
          }));
          return reconnect ? { status: 'error', error, reconnect } : { status: 'error', error };
        }
        leftBehind = true;
      }
    }
    await writeState(name, () => (leftBehind ? leftover(name, state) : null));
    try {
      await signOut(name, state);
    } catch {}
    return { status: 'disconnected' };
  }

  async function disconnectCalendar(name, { force = false } = {}) {
    if (!PROVIDER_NAMES.includes(name)) return unknownProvider(name);
    return exclusive(() => removeProvider(name, { force }));
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

async function makeChromeProvider(name, state, { interactive = false } = {}) {
  if (name === 'google') {
    const auth = chromeGoogleAuth();
    // Settings runs the consent window itself (a long sign-in could outlast the
    // worker), so this normally just returns Chrome's cached token. Later calls
    // use getToken(false), which gets the same cached token.
    if (interactive) await auth.getToken(true);
    return createGoogleProvider({
      getToken: auth.getToken,
      removeToken: auth.removeToken,
      getAccount: auth.getAccount,
    });
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
// Connect asks again. Apple keeps its password in the removed state.
async function chromeSignOut(name) {
  if (name === 'google') await chromeGoogleAuth().revoke();
}

function isChromeProviderConfigured(name) {
  if (name === 'google') return chromeGoogleAuth().isConfigured();
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
