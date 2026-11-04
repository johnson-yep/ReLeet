import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome } from './helpers/fake-chrome.js';

const chrome = installFakeChrome();
const storage = await import('../lib/storage.js');
const schedule = await import('../lib/schedule.js');
const { recordReview } = await import('../lib/srs.js');
const { CalendarError } = await import('../lib/calendars/errors.js');
const calendarSync = await import('../lib/calendar-sync.js');
const { createCalendarSync, PROVIDER_NAMES } = calendarSync;

// Local times around Tue 10 Nov 2026, so plans don't depend on the real clock.
const at = (days, hours = 0, minutes = 0) => new Date(2026, 10, 10 + days, hours, minutes).getTime();
let clock;

const problem = (id, rating, dueDay, { ratedAt = at(dueDay - 3, 12) } = {}) => ({
  id,
  title: id,
  url: `https://leetcode.com/problems/${id}/`,
  rating,
  solvedAt: ratedAt,
  dueAt: at(dueDay),
  commitSha: null,
  source: 'leetcode',
  history: [{ at: ratedAt, rating, commitSha: null }],
});

const setProblems = (...list) => storage.saveProblemMap(Object.fromEntries(list.map((p) => [p.id, p])));
const stored = (name) => chrome.dump().calendars?.[name];

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

async function until(check) {
  for (let i = 0; i < 1000 && !check(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(check(), 'condition never became true');
}

// One fake account per provider: calendars (id → Map(eventId → slot)) and a
// call log. `before(op, ...args)` runs before every call; throw or return a
// promise from it to make that call fail or wait. `reuseByName`: like Outlook
// and iCloud, ensureCalendar without a usable id picks up an existing calendar.
function fakeAccount(name) {
  const account = {
    calendars: new Map(),
    calls: [],
    before: null,
    signedIn: true,
    makeProvider: null,
    reuseByName: false,
  };
  let nextId = 1;
  const call = async (op, ...args) => {
    account.calls.push([op, ...args]);
    await account.before?.(op, ...args);
  };
  const calendar = (id) => {
    const found = account.calendars.get(id);
    if (!found) throw new CalendarError('The ReLeet calendar is gone.', { calendarMissing: true });
    return found;
  };
  account.provider = {
    name,
    async ensureCalendar(id) {
      await call('ensureCalendar', id);
      if (id && account.calendars.has(id)) return id;
      if (account.reuseByName && account.calendars.size) return [...account.calendars.keys()][0];
      const created = `${name}-cal-${nextId++}`;
      account.calendars.set(created, new Map());
      return created;
    },
    async createEvent(calendarId, slot) {
      await call('createEvent', calendarId, slot);
      const id = `${name}-ev-${nextId++}`;
      calendar(calendarId).set(id, slot);
      return { id };
    },
    async updateEvent(calendarId, ref, slot) {
      await call('updateEvent', calendarId, ref, slot);
      const events = calendar(calendarId);
      if (!events.has(ref.id)) throw new CalendarError('The calendar event was deleted.', { notFound: true });
      events.set(ref.id, slot);
      return { id: ref.id };
    },
    async deleteEvent(calendarId, ref) {
      await call('deleteEvent', calendarId, ref);
      account.calendars.get(calendarId)?.delete(ref.id);
    },
    // Events that haven't ended by `from`.
    async listEvents(calendarId, from) {
      await call('listEvents', calendarId, from);
      return [...calendar(calendarId)].filter(([, slot]) => slot.end > from).map(([id]) => ({ id }));
    },
    async deleteCalendar(calendarId) {
      await call('deleteCalendar', calendarId);
      account.calendars.delete(calendarId);
    },
    async describeAccount() {
      return `me@${name}.test`;
    },
  };
  // Every event in every calendar, by id.
  account.events = () => new Map([...account.calendars.values()].flatMap((events) => [...events]));
  account.ops = (op) => account.calls.filter(([name]) => name === op);
  return account;
}

let accounts;
let counts;

function makeSync({ isConfigured = () => true, updateCalendarState = storage.updateCalendarState } = {}) {
  return createCalendarSync({
    storage: {
      getProblems: storage.getProblems,
      getSettings: storage.getSettings,
      getSchedule: storage.getSchedule,
      saveSchedule: (s) => {
        counts.saveSchedule++;
        return storage.saveSchedule(s);
      },
      getCalendars: storage.getCalendars,
      updateCalendarState,
    },
    async makeProvider(name, state, options) {
      counts.makeProvider.push({ name, interactive: options.interactive, state: structuredClone(state) });
      const account = accounts[name];
      if (account.makeProvider) return account.makeProvider(state, options);
      if (!account.signedIn) throw new CalendarError('Sign-in expired. Reconnect in Settings.', { reconnect: true });
      return account.provider;
    },
    async signOut(name) {
      counts.signOut.push(name);
    },
    isConfigured,
    planSchedule: (...args) => {
      counts.plan++;
      return schedule.planSchedule(...args);
    },
    diffEvents: schedule.diffEvents,
    slotHash: schedule.slotHash,
    now: () => clock,
  });
}

beforeEach(() => {
  chrome.reset();
  clock = at(0, 8);
  accounts = Object.fromEntries(PROVIDER_NAMES.map((name) => [name, fakeAccount(name)]));
  counts = { plan: 0, saveSchedule: 0, makeProvider: [], signOut: [] };
});

// Stored refs must match the planned slots and the events on the fake calendar.
function assertInSync(name) {
  const state = stored(name);
  const { entries } = chrome.dump().schedule;
  const events = accounts[name].calendars.get(state.calendarId);
  for (const [problemId, ref] of Object.entries(state.events)) {
    const slot = entries[problemId];
    assert.deepEqual(ref, {
      id: ref.id,
      day: slot.day,
      start: slot.start,
      end: slot.end,
      hash: schedule.slotHash(slot),
    });
    assert.deepEqual(events.get(ref.id), slot);
  }
}

// Connect

test('first connect creates an event for every upcoming review, none for overdue ones', async () => {
  const sync = makeSync();
  await setProblems(
    problem('two-sum', 'easy', 1),
    problem('lru-cache', 'hard', 1),
    problem('jump-game', 'medium', 3),
    problem('overdue', 'medium', -2),
  );

  const res = await sync.connectCalendar('google');

  assert.deepEqual(res, { status: 'connected', account: 'me@google.test' });
  assert.equal(counts.makeProvider[0].interactive, true);
  const state = stored('google');
  assert.equal(state.connected, true);
  assert.equal(state.account, 'me@google.test');
  assert.equal(state.lastError, null);
  assert.equal(state.needsReconnect, false);
  assert.equal(state.lastSyncAt, clock);
  assert.deepEqual(Object.keys(state.events).sort(), ['jump-game', 'lru-cache', 'two-sum']);
  assert.equal(accounts.google.calendars.size, 1);
  assert.equal(accounts.google.events().size, 3);
  assertInSync('google');
  // Same day → back to back.
  assert.equal(state.events['two-sum'].start, state.events['lru-cache'].end);
});

test('connect stores Apple credentials (trimmed) and tokens a provider set during sign-in', async () => {
  const sync = makeSync();
  await setProblems(problem('two-sum', 'easy', 1));
  accounts.outlook.makeProvider = async (state, { interactive }) => {
    if (interactive) state.auth = { accessToken: 'a1', refreshToken: 'r1', expiresAt: 1, account: 'me@outlook.test' };
    return accounts.outlook.provider;
  };

  assert.equal(
    (await sync.connectCalendar('apple', { appleId: ' me@icloud.com ', appPassword: ' abcd-efgh ' })).status,
    'connected',
  );
  assert.equal((await sync.connectCalendar('outlook')).status, 'connected');

  assert.deepEqual(counts.makeProvider[0].state.auth, { appleId: 'me@icloud.com', appPassword: 'abcd-efgh' });
  assert.deepEqual(stored('apple').auth, { appleId: 'me@icloud.com', appPassword: 'abcd-efgh' });
  assert.equal(stored('outlook').auth.refreshToken, 'r1');
  assert.equal(stored('google'), undefined);
  assert.equal(accounts.apple.events().size, 1);
  assert.equal(accounts.outlook.events().size, 1);
});

test('a provider can persist new tokens during a sync through updateState', async () => {
  const sync = makeSync();
  accounts.outlook.makeProvider = async (state, { interactive, updateState }) => {
    if (interactive) state.auth = { refreshToken: 'r1' };
    else await updateState((prev) => ({ ...prev, auth: { refreshToken: 'r2' } }));
    return accounts.outlook.provider;
  };
  await sync.connectCalendar('outlook');
  assert.equal(stored('outlook').auth.refreshToken, 'r2');
});

test('connect failure (sign-in or calendar creation) leaves no state behind', async () => {
  const sync = makeSync();
  await setProblems(problem('two-sum', 'easy', 1));

  accounts.google.makeProvider = async () => {
    throw new CalendarError("Google sign-in didn't complete.", { reconnect: true });
  };
  assert.deepEqual(await sync.connectCalendar('google'), {
    status: 'error',
    error: "Google sign-in didn't complete.",
  });

  // Tokens from a sign-in that worked aren't kept when the calendar can't be made.
  accounts.outlook.makeProvider = async (state) => {
    state.auth = { accessToken: 'a1', refreshToken: 'r1' };
    return accounts.outlook.provider;
  };
  accounts.outlook.before = (op) => {
    if (op === 'ensureCalendar') throw new CalendarError("Couldn't reach Outlook.");
  };
  assert.deepEqual(await sync.connectCalendar('outlook'), { status: 'error', error: "Couldn't reach Outlook." });

  assert.deepEqual(chrome.dump().calendars ?? {}, {});
  assert.equal(accounts.google.events().size + accounts.outlook.events().size, 0);
});

test('a failed reconnect leaves the previous connection exactly as it was', async () => {
  const sync = makeSync();
  await setProblems(problem('two-sum', 'easy', 1));
  await sync.connectCalendar('google');
  await storage.updateCalendarState('google', (s) => ({ ...s, needsReconnect: true, lastError: 'expired' }));
  const before = stored('google');

  accounts.google.makeProvider = async () => {
    throw new CalendarError('Sign-in cancelled.', { reconnect: true });
  };
  assert.equal((await sync.connectCalendar('google')).status, 'error');
  assert.deepEqual(stored('google'), before);
});

test('reconnecting keeps the calendar and its events, so nothing is duplicated', async () => {
  const sync = makeSync();
  await setProblems(problem('two-sum', 'easy', 1), problem('jump-game', 'medium', 2));
  await sync.connectCalendar('google');
  const before = stored('google');
  await storage.updateCalendarState('google', (s) => ({ ...s, needsReconnect: true, lastError: 'expired' }));

  assert.equal((await sync.connectCalendar('google')).status, 'connected');

  const after = stored('google');
  assert.equal(after.calendarId, before.calendarId);
  assert.deepEqual(after.events, before.events);
  assert.equal(after.needsReconnect, false);
  assert.equal(after.lastError, null);
  assert.equal(accounts.google.ops('createEvent').length, 2);
  assert.equal(accounts.google.calendars.size, 1);
});

for (const name of ['outlook', 'apple', 'google']) {
  test(`reconnecting ${name} after "Disconnect anyway" picks up the calendar it left, without doubling events`, async () => {
    const sync = makeSync();
    // Outlook and iCloud find an existing "ReLeet" calendar by name; Google can't.
    accounts[name].reuseByName = name !== 'google';
    const credentials = name === 'apple' ? { appleId: 'me@icloud.com', appPassword: 'x' } : undefined;
    await setProblems(problem('a', 'easy', 1), problem('b', 'medium', 2), problem('c', 'hard', 3));
    await sync.connectCalendar(name, credentials);
    const before = stored(name);

    // Sign-in expired, so the calendar can't be deleted: the user forces it.
    accounts[name].signedIn = false;
    assert.equal((await sync.disconnectCalendar(name)).status, 'error');
    assert.equal((await sync.disconnectCalendar(name, { force: true })).status, 'disconnected');
    assert.equal(stored(name).connected, false);
    assert.deepEqual(stored(name).auth, name === 'apple' ? { appleId: 'me@icloud.com' } : undefined);

    accounts[name].signedIn = true;
    accounts[name].calls = [];
    assert.equal((await sync.connectCalendar(name, credentials)).status, 'connected');
    assert.equal(stored(name).calendarId, before.calendarId);
    assert.deepEqual(stored(name).events, before.events);
    assert.equal(accounts[name].calendars.size, 1);
    assert.equal(accounts[name].events().size, 3);
    assert.equal(accounts[name].ops('createEvent').length, 0);
  });
}

test('a "ReLeet" calendar found again without a stored map gets its upcoming events replaced, not doubled', async () => {
  const sync = makeSync();
  accounts.outlook.reuseByName = true;
  const problems = [problem('a', 'easy', 0), problem('b', 'medium', 1), problem('c', 'hard', 2)];
  await setProblems(...problems);
  await sync.connectCalendar('outlook');
  const calendarId = stored('outlook').calendarId;
  // A finished review from last week is history.
  accounts.outlook.calendars.get(calendarId).set('history', { problemId: 'a', start: at(-7, 9), end: at(-7, 9, 20) });

  // Reinstalled at 09:10, while a's 09:00 block runs: storage is gone, the calendar isn't.
  clock = at(0, 9, 10);
  chrome.reset();
  await setProblems(...problems);
  accounts.outlook.calls = [];
  assert.equal((await sync.connectCalendar('outlook')).status, 'connected');

  assert.equal(stored('outlook').calendarId, calendarId);
  assert.equal(accounts.outlook.calendars.size, 1);
  assert.equal(accounts.outlook.ops('deleteEvent').length, 3); // a (running), b, c
  assert.equal(accounts.outlook.events().size, 4); // history + one block per problem
  assert.ok(accounts.outlook.events().has('history'));
  assertInSync('outlook');
});

test('a calendar left behind that can no longer be opened does not block connecting again', async () => {
  const sync = makeSync();
  await setProblems(problem('a', 'easy', 1));
  await sync.connectCalendar('google');
  const old = stored('google').calendarId;
  accounts.google.before = (op) => {
    if (op === 'deleteCalendar') throw new CalendarError("Couldn't reach Google Calendar.");
  };
  await sync.disconnectCalendar('google', { force: true });

  // Offline: just an error, the leftover is kept for the next try.
  accounts.google.before = (op) => {
    if (op === 'ensureCalendar') throw new CalendarError("Couldn't reach Google Calendar.");
  };
  assert.equal((await sync.connectCalendar('google')).status, 'error');
  assert.equal(stored('google').calendarId, old);

  // Access to it went with the old sign-in: start with a new calendar.
  accounts.google.before = (op, id) => {
    if (op === 'ensureCalendar' && id === old) throw new CalendarError('Google Calendar request failed.', { status: 403 });
  };
  assert.equal((await sync.connectCalendar('google')).status, 'connected');
  assert.notEqual(stored('google').calendarId, old);
  assert.deepEqual(Object.keys(stored('google').events), ['a']);
  assertInSync('google');
});

test("connecting later on a review day still books today's review", async () => {
  const sync = makeSync();
  await setProblems(problem('lru-cache', 'hard', 0));
  clock = at(0, 7);
  await sync.syncCalendars(); // planned for 09:00 while no calendar is connected
  assert.equal(chrome.dump().schedule.entries['lru-cache'].start, at(0, 9));

  clock = at(0, 15, 2);
  await sync.connectCalendar('google');
  assert.equal(stored('google').events['lru-cache'].start, at(0, 15, 5));
  assertInSync('google');
});

test('a calendar connected later leaves a block another calendar holds where it is', async () => {
  const sync = makeSync();
  await setProblems(problem('lru-cache', 'hard', 0));
  await sync.connectCalendar('google'); // 09:00
  clock = at(0, 15);
  accounts.google.calls = [];
  await sync.connectCalendar('outlook');
  assert.equal(chrome.dump().schedule.entries['lru-cache'].start, at(0, 9));
  assert.equal(accounts.google.ops('updateEvent').length, 0);
  assert.equal(accounts.outlook.ops('createEvent').length, 0); // already over
});

test('an unconfigured provider explains what is missing and never signs in', async () => {
  const sync = makeSync({ isConfigured: (name) => name === 'apple' });
  const res = await sync.connectCalendar('google');
  assert.equal(res.status, 'unconfigured');
  assert.match(res.error, /manifest\.json.*SETUP\.md/);
  assert.match((await sync.connectCalendar('outlook')).error, /config\.js/);
  assert.equal(counts.makeProvider.length, 0);
  assert.equal(sync.isProviderConfigured('google'), false);
  assert.equal(sync.isProviderConfigured('apple'), true);
  assert.equal(sync.isProviderConfigured('yahoo'), false);
  assert.equal((await sync.connectCalendar('yahoo')).status, 'error');
});

// Sync

test('re-rating moves the event in place', async () => {
  const sync = makeSync();
  const p = problem('two-sum', 'easy', 3);
  await setProblems(p, problem('jump-game', 'medium', 2));
  await sync.connectCalendar('google');
  const before = stored('google').events['two-sum'];

  await setProblems({ ...p, rating: 'hard', dueAt: at(1) }, problem('jump-game', 'medium', 2));
  const res = await sync.syncCalendars();

  assert.equal(res.status, 'ok');
  assert.deepEqual(res.results.google, { created: 0, updated: 1, removed: 0, forgotten: 0, error: null });
  const after = stored('google').events['two-sum'];
  assert.equal(after.id, before.id);
  assert.equal(after.day, schedule.dayKey(at(1)));
  assert.equal(accounts.google.events().size, 2);
  assertInSync('google');
});

test('deleting a problem deletes its event', async () => {
  const sync = makeSync();
  await setProblems(problem('two-sum', 'easy', 1), problem('jump-game', 'medium', 2));
  await sync.connectCalendar('google');
  const ref = stored('google').events['jump-game'];

  await storage.deleteProblem('jump-game');
  const res = await sync.syncCalendars();

  assert.deepEqual(res.results.google, { created: 0, updated: 0, removed: 1, forgotten: 0, error: null });
  assert.deepEqual(Object.keys(stored('google').events), ['two-sum']);
  assert.equal(accounts.google.events().has(ref.id), false);
  assert.equal(accounts.google.events().size, 1);
});

test('a finished review leaves its started event as history and creates the next one', async () => {
  const sync = makeSync();
  const p = problem('two-sum', 'easy', 0); // due today, block at 09:00
  await setProblems(p);
  await sync.connectCalendar('google');
  const old = stored('google').events['two-sum'];
  assert.equal(old.start, at(0, 9));

  clock = at(0, 9, 10); // the block has started; the review is done
  await setProblems(recordReview(p, 'medium', { at: clock }));
  const res = await sync.syncCalendars();

  assert.deepEqual(res.results.google, { created: 1, updated: 0, removed: 0, forgotten: 1, error: null });
  const next = stored('google').events['two-sum'];
  assert.notEqual(next.id, old.id);
  assert.equal(next.day, schedule.dayKey(at(3)));
  // The old event stays on the calendar untouched.
  assert.equal(accounts.google.events().get(old.id).start, at(0, 9));
  assert.equal(accounts.google.events().size, 2);
  assert.equal(accounts.google.ops('updateEvent').length + accounts.google.ops('deleteEvent').length, 0);
});

test('an event deleted in the calendar app is recreated when it needs an update', async () => {
  const sync = makeSync();
  const p = problem('two-sum', 'easy', 3);
  await setProblems(p);
  await sync.connectCalendar('google');
  const old = stored('google').events['two-sum'];
  accounts.google.calendars.get(stored('google').calendarId).delete(old.id);

  await setProblems({ ...p, dueAt: at(2) });
  const res = await sync.syncCalendars();

  assert.deepEqual(res.results.google, { created: 1, updated: 0, removed: 0, forgotten: 0, error: null });
  assert.equal(accounts.google.ops('updateEvent').length, 1);
  assert.notEqual(stored('google').events['two-sum'].id, old.id);
  assertInSync('google');
});

test('a calendar deleted mid-sync is recreated once with every event', async () => {
  const sync = makeSync();
  await setProblems(problem('two-sum', 'easy', 1), problem('jump-game', 'medium', 2));
  await sync.connectCalendar('google');
  const oldCalendar = stored('google').calendarId;

  // The user deletes the calendar right after ensureCalendar said it exists.
  await setProblems(problem('two-sum', 'easy', 1), problem('jump-game', 'medium', 2), problem('lru-cache', 'hard', 3));
  accounts.google.before = (op) => {
    if (op === 'createEvent') {
      accounts.google.calendars.delete(oldCalendar);
      accounts.google.before = null;
    }
  };
  accounts.google.calls = [];
  const res = await sync.syncCalendars();

  assert.deepEqual(res.results.google, { created: 3, updated: 0, removed: 0, forgotten: 0, error: null });
  // The retry asks about the same calendar first, and only then replaces it.
  assert.deepEqual(accounts.google.ops('ensureCalendar'), [
    ['ensureCalendar', oldCalendar],
    ['ensureCalendar', oldCalendar],
  ]);
  const state = stored('google');
  assert.notEqual(state.calendarId, oldCalendar);
  assert.deepEqual(Object.keys(state.events).sort(), ['jump-game', 'lru-cache', 'two-sum']);
  assertInSync('google');
});

test('a calendar that keeps going missing is retried only once, then reported', async () => {
  const sync = makeSync();
  await setProblems(problem('two-sum', 'easy', 1));
  await sync.connectCalendar('google');
  await setProblems(problem('two-sum', 'easy', 1), problem('jump-game', 'medium', 2));

  accounts.google.before = (op) => {
    if (op === 'createEvent') throw new CalendarError('The ReLeet calendar is gone.', { calendarMissing: true });
  };
  accounts.google.calls = [];
  const res = await sync.syncCalendars();

  assert.equal(res.status, 'error');
  assert.equal(res.results.google.error, 'The ReLeet calendar is gone.');
  assert.equal(accounts.google.ops('ensureCalendar').length, 2);
  assert.equal(stored('google').lastError, 'The ReLeet calendar is gone.');
  assert.equal(stored('google').needsReconnect, false);
});

test('a stray "calendar gone" answer for a calendar that still exists keeps its events', async () => {
  const sync = makeSync();
  accounts.outlook.reuseByName = true;
  await setProblems(problem('a', 'easy', 1), problem('b', 'medium', 2));
  await sync.connectCalendar('outlook');
  const calendarId = stored('outlook').calendarId;

  await setProblems(problem('a', 'easy', 1), problem('b', 'medium', 2), problem('c', 'hard', 3));
  let once = true;
  accounts.outlook.before = (op) => {
    if (op === 'createEvent' && once) {
      once = false;
      throw new CalendarError('The ReLeet calendar is gone from Outlook.', { calendarMissing: true });
    }
  };
  const res = await sync.syncCalendars();

  assert.deepEqual(res.results.outlook, { created: 1, updated: 0, removed: 0, forgotten: 0, error: null });
  assert.equal(stored('outlook').calendarId, calendarId);
  assert.equal(accounts.outlook.calendars.size, 1);
  assert.equal(accounts.outlook.events().size, 3);
  assertInSync('outlook');
});

test('an event whose create answer was lost is deleted before the next sync creates it again', async () => {
  const sync = makeSync();
  await setProblems(problem('a', 'easy', 1), problem('b', 'medium', 2));
  await sync.connectCalendar('google');
  const real = accounts.google.provider;
  accounts.google.makeProvider = async () => ({
    ...real,
    async createEvent(calendarId, slot) {
      await real.createEvent(calendarId, slot); // the server has it…
      throw new CalendarError("Google Calendar didn't respond in time."); // …but the answer never came
    },
  });
  await setProblems(problem('a', 'easy', 1), problem('b', 'medium', 2), problem('c', 'hard', 3));
  assert.equal((await sync.syncCalendars()).results.google.error, "Google Calendar didn't respond in time.");
  assert.equal(stored('google').checkStrays, true);
  assert.equal(accounts.google.events().size, 3);

  // Also after a worker restart: the flag is in storage.
  accounts.google.makeProvider = null;
  const res = await makeSync().syncCalendars();
  assert.deepEqual(res.results.google, { created: 1, updated: 0, removed: 1, forgotten: 0, error: null });
  assert.equal(accounts.google.events().size, 3);
  assert.equal(stored('google').checkStrays, false);
  assertInSync('google');

  // Nothing to look for once a run went through.
  accounts.google.calls = [];
  await sync.syncCalendars();
  assert.equal(accounts.google.ops('listEvents').length, 0);
});

test('a calendar that was failing while a block moved catches up, even after the old time passed', async () => {
  const sync = makeSync();
  clock = at(0, 7);
  await setProblems(problem('a', 'medium', 0), problem('b', 'easy', 0));
  await sync.connectCalendar('google');
  await sync.connectCalendar('outlook');
  assert.equal(stored('outlook').events.a.start, at(0, 9));

  // 07:05: the start time moves to 13:00 and b is deleted while Outlook is signed out.
  clock = at(0, 7, 5);
  accounts.outlook.signedIn = false;
  await storage.updateSettings({ startTime: '13:00' });
  await setProblems(problem('a', 'medium', 0));
  await sync.syncCalendars();
  assert.equal(stored('google').events.a.start, at(0, 13));

  // 10:00: Outlook is back. Its 09:00 event had "started", but it's the stale one.
  clock = at(0, 10);
  accounts.outlook.signedIn = true;
  const res = await sync.syncCalendars();
  assert.equal(res.results.outlook.updated, 1);
  assert.equal(accounts.outlook.events().get(stored('outlook').events.a.id).start, at(0, 13));
  assertInSync('outlook');
});

test('a sign-in error marks only that provider for reconnect; the others keep syncing', async () => {
  const sync = makeSync();
  await setProblems(problem('two-sum', 'easy', 1));
  await sync.connectCalendar('google');
  await sync.connectCalendar('apple', { appleId: 'me@icloud.com', appPassword: 'x' });
  const lastGoodSync = stored('google').lastSyncAt;

  clock += 60 * 1000;
  accounts.google.signedIn = false;
  await setProblems(problem('two-sum', 'easy', 1), problem('jump-game', 'medium', 2));
  const res = await sync.syncCalendars();

  assert.equal(res.status, 'error');
  assert.equal(res.results.google.error, 'Sign-in expired. Reconnect in Settings.');
  assert.deepEqual(res.results.apple, { created: 1, updated: 0, removed: 0, forgotten: 0, error: null });
  assert.equal(stored('google').needsReconnect, true);
  assert.equal(stored('google').lastError, 'Sign-in expired. Reconnect in Settings.');
  assert.equal(stored('google').lastSyncAt, lastGoodSync);
  assert.equal(stored('apple').lastError, null);
  assert.equal(stored('apple').lastSyncAt, clock);
  assertInSync('apple');

  // Once sign-in works again, it catches up and clears the flag.
  accounts.google.signedIn = true;
  const retry = await sync.syncCalendars();
  assert.equal(retry.status, 'ok');
  assert.equal(retry.results.google.created, 1);
  assert.equal(stored('google').needsReconnect, false);
  assert.equal(stored('google').lastError, null);
  assertInSync('google');
});

test('one provider throwing inside an op does not stop another provider', async () => {
  const sync = makeSync();
  await sync.connectCalendar('google');
  await sync.connectCalendar('outlook');
  accounts.google.before = (op) => {
    if (op === 'createEvent') throw new Error('boom');
  };
  await setProblems(problem('two-sum', 'easy', 1));
  const res = await sync.syncCalendars();
  assert.equal(res.results.google.error, 'boom');
  assert.equal(res.results.outlook.created, 1);
});

test('every applied op is stored at once, so a stopped run resumes without duplicates', async () => {
  const sync = makeSync();
  await setProblems(problem('a', 'easy', 1), problem('b', 'easy', 1), problem('c', 'easy', 1));

  let creates = 0;
  accounts.google.before = (op) => {
    if (op !== 'createEvent') return;
    creates++;
    // Before the second create, the first is already in storage.
    if (creates === 2) assert.equal(Object.keys(stored('google').events).length, 1);
    if (creates === 3) throw new CalendarError("Couldn't reach Google Calendar.");
  };
  const res = await sync.connectCalendar('google');

  assert.equal(res.status, 'connected'); // the connection stands; the sync retries
  const state = stored('google');
  assert.deepEqual(Object.keys(state.events).sort(), ['a', 'b']);
  assert.equal(state.lastError, "Couldn't reach Google Calendar.");
  assert.equal(state.needsReconnect, false);
  assert.equal(accounts.google.events().size, 2);
  assertInSync('google');

  // A fresh instance (as after a worker restart) picks up where it stopped.
  accounts.google.before = null;
  const restarted = await makeSync().syncCalendars();
  assert.deepEqual(restarted.results.google, { created: 1, updated: 0, removed: 0, forgotten: 0, error: null });
  assert.equal(accounts.google.events().size, 3);
  assertInSync('google');
});

test('calls during a run share one rerun, which sees the changes made meanwhile', async () => {
  const sync = makeSync();
  await setProblems(problem('two-sum', 'easy', 1));
  await sync.connectCalendar('google');
  const plansBefore = counts.plan;

  const gate = deferred();
  accounts.google.before = (op) => (op === 'ensureCalendar' ? gate.promise : undefined);
  accounts.google.calls = [];
  const first = sync.syncCalendars();
  await until(() => accounts.google.calls.length === 1);

  await setProblems(problem('two-sum', 'easy', 1), problem('jump-game', 'medium', 2));
  const second = sync.syncCalendars();
  const third = sync.syncCalendars();
  assert.equal(second, third);
  assert.notEqual(first, second);

  accounts.google.before = null;
  gate.resolve();
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.results.google.created, 0);
  assert.equal(r2.results.google.created, 1);
  assert.equal(counts.plan - plansBefore, 2);

  // Once idle, the next call starts a new run.
  await sync.syncCalendars();
  assert.equal(counts.plan - plansBefore, 3);
});

test('the schedule is saved only when the plan changed', async () => {
  const sync = makeSync();
  await setProblems(problem('two-sum', 'easy', 1), problem('jump-game', 'medium', 2));
  let writes = 0;
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.schedule) writes++;
  });

  const res = await sync.syncCalendars();
  assert.deepEqual(res, { status: 'ok', plan: { entries: 2 }, results: {} });
  assert.equal(counts.saveSchedule, 1);

  await sync.syncCalendars();
  clock += 60 * 1000;
  await sync.syncCalendars();
  assert.equal(counts.saveSchedule, 1);

  await setProblems(problem('two-sum', 'hard', 1), problem('jump-game', 'medium', 2));
  await sync.syncCalendars();
  assert.equal(counts.saveSchedule, 2);
  assert.equal(writes, 2);
});

test('refreshSchedule plans without touching calendars', async () => {
  const sync = makeSync();
  await sync.connectCalendar('google');
  accounts.google.calls = [];
  await setProblems(problem('two-sum', 'easy', 1));
  const planned = await sync.refreshSchedule();
  assert.equal(planned.entries['two-sum'].start, at(1, 9));
  assert.deepEqual(chrome.dump().schedule, planned);
  assert.equal(accounts.google.calls.length, 0);
});

// Disconnect

test('disconnect deletes the calendar, forgets the provider and signs out', async () => {
  const sync = makeSync();
  await setProblems(problem('two-sum', 'easy', 1));
  await sync.connectCalendar('google');
  await sync.connectCalendar('apple', { appleId: 'me@icloud.com', appPassword: 'x' });
  const calendarId = stored('google').calendarId;

  assert.deepEqual(await sync.disconnectCalendar('google'), { status: 'disconnected' });

  assert.deepEqual(accounts.google.ops('deleteCalendar'), [['deleteCalendar', calendarId]]);
  assert.equal(accounts.google.calendars.size, 0);
  assert.equal(stored('google'), undefined);
  assert.equal(stored('apple').connected, true);
  assert.deepEqual(counts.signOut, ['google']);
  // Later syncs leave it alone.
  assert.deepEqual(Object.keys((await sync.syncCalendars()).results), ['apple']);
});

test('disconnect keeps the connection when the calendar cannot be deleted, unless forced', async () => {
  const sync = makeSync();
  await setProblems(problem('two-sum', 'easy', 1));
  await sync.connectCalendar('google');
  const before = stored('google');
  accounts.google.before = (op) => {
    if (op === 'deleteCalendar') throw new CalendarError("Couldn't reach Google Calendar.");
  };

  assert.deepEqual(await sync.disconnectCalendar('google'), {
    status: 'error',
    error: "Couldn't reach Google Calendar.",
  });
  assert.deepEqual(stored('google'), before);
  assert.deepEqual(counts.signOut, []);

  assert.deepEqual(await sync.disconnectCalendar('google', { force: true }), { status: 'disconnected' });
  // The calendar stays in the account, so its id and events are remembered for
  // a later Connect; nothing that signs in is kept.
  assert.deepEqual(stored('google'), {
    connected: false,
    calendarId: before.calendarId,
    events: before.events,
    checkStrays: false,
    account: 'me@google.test',
  });
  assert.deepEqual(counts.signOut, ['google']);
  assert.deepEqual((await sync.syncCalendars()).results, {});
});

test('disconnect with sign-in gone needs force; disconnecting nothing is fine', async () => {
  const sync = makeSync();
  await sync.connectCalendar('outlook');
  accounts.outlook.signedIn = false;
  assert.deepEqual(await sync.disconnectCalendar('outlook'), {
    status: 'error',
    error: 'Sign-in expired. Reconnect in Settings.',
    reconnect: true,
  });
  // Settings now offers Reconnect, after which Disconnect can delete the calendar.
  assert.equal(stored('outlook').needsReconnect, true);
  assert.equal(stored('outlook').connected, true);
  assert.equal(stored('outlook').disconnecting, undefined);
  assert.equal((await sync.disconnectCalendar('outlook', { force: true })).status, 'disconnected');
  assert.equal(stored('outlook').connected, false);
  assert.equal(stored('outlook').auth, undefined);

  counts.makeProvider = [];
  assert.deepEqual(await sync.disconnectCalendar('apple'), { status: 'disconnected' });
  assert.equal(counts.makeProvider.length, 0);
});

test('a disconnect stopped after the calendar was deleted is finished by the next sync, not undone', async () => {
  await setProblems(problem('a', 'easy', 1));
  await makeSync().connectCalendar('google');
  // The worker stops after the calendar is deleted, before the state is removed.
  const dying = makeSync({
    updateCalendarState: (name, updater) =>
      storage.updateCalendarState(name, (prev) => {
        const next = updater(prev);
        if (next === null) throw new Error('worker stopped');
        return next;
      }),
  });
  await assert.rejects(dying.disconnectCalendar('google'), /worker stopped/);
  assert.equal(accounts.google.calendars.size, 0);
  assert.equal(stored('google').disconnecting, true);

  // The restarted worker finishes it; offline, it waits for the next sync.
  const restarted = makeSync();
  accounts.google.before = (op) => {
    if (op === 'deleteCalendar') throw new CalendarError("Couldn't reach Google Calendar.");
  };
  assert.deepEqual((await restarted.syncCalendars()).results, {});
  assert.equal(stored('google').disconnecting, true);
  assert.equal(stored('google').lastError, "Couldn't reach Google Calendar.");

  accounts.google.before = null;
  assert.deepEqual((await restarted.syncCalendars()).results, {});
  assert.equal(stored('google'), undefined);
  assert.equal(accounts.google.calendars.size, 0);
  assert.equal(accounts.google.ops('createEvent').length, 1);
  assert.deepEqual(counts.signOut, ['google']);
});

test('a sync that finishes after a disconnect does not bring the provider back', async () => {
  const sync = makeSync();
  await sync.connectCalendar('google');
  await setProblems(problem('two-sum', 'easy', 1));
  // Simulates the state disappearing while a write from the sync is on its way.
  accounts.google.before = async (op) => {
    if (op === 'createEvent') await storage.updateCalendarState('google', () => null);
  };
  await sync.syncCalendars();
  assert.equal(stored('google'), undefined);
});

// Real wiring (chrome glue). The fake manifest has the placeholder Google client
// ID and config.js has no Outlook client ID, so only Apple is usable.

test('the chrome-wired instance reports configuration and syncs with nothing connected', async () => {
  assert.equal(calendarSync.isProviderConfigured('google'), false);
  assert.equal(calendarSync.isProviderConfigured('outlook'), false);
  assert.equal(calendarSync.isProviderConfigured('apple'), true);
  assert.equal((await calendarSync.connectCalendar('google')).status, 'unconfigured');
  assert.equal((await calendarSync.connectCalendar('outlook')).status, 'unconfigured');
  assert.deepEqual(await calendarSync.syncCalendars(), { status: 'ok', plan: { entries: 0 }, results: {} });
});

// A tiny iCloud stand-in: enough CalDAV for discovery, MKCALENDAR, PUT and DELETE.
function fakeCalDav({ password = 'app-pass' } = {}) {
  const server = { requests: [], resources: new Map(), calendars: new Set() };
  const ns = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';
  const ms = (body) =>
    new Response(`<?xml version="1.0"?><d:multistatus ${ns}>${body}</d:multistatus>`, {
      status: 207,
      headers: { 'Content-Type': 'application/xml' },
    });
  const ok = (href, prop) =>
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop>` +
    '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
  server.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    server.requests.push(`${method} ${url.pathname}`);
    if (init.headers?.Authorization !== `Basic ${btoa(`me@icloud.com:${password}`)}`)
      return new Response('', { status: 401 });
    const path = url.pathname;
    if (method === 'PROPFIND' && path === '/')
      return ms(ok('/', '<d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal>'));
    if (method === 'PROPFIND' && path === '/123/principal/')
      return ms(
        ok(
          path,
          '<c:calendar-home-set><d:href>https://p01-caldav.icloud.com/123/calendars/</d:href></c:calendar-home-set>',
        ),
      );
    if (method === 'PROPFIND' && path === '/123/calendars/' && init.headers.Depth === '1')
      return ms(ok(path, '<d:resourcetype><d:collection/></d:resourcetype>'));
    if (method === 'PROPFIND' && server.calendars.has(path))
      return ms(ok(path, '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'));
    if (method === 'PROPFIND') return new Response('', { status: 404 });
    if (method === 'MKCALENDAR') {
      server.calendars.add(path);
      return new Response('', { status: 201 });
    }
    if (method === 'PUT') {
      server.resources.set(path, init.body);
      return new Response('', { status: 201, headers: { ETag: '"1"' } });
    }
    if (method === 'DELETE') {
      server.calendars.delete(path);
      for (const key of server.resources.keys()) if (key.startsWith(path)) server.resources.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response('', { status: 405 });
  };
  return server;
}

test('the chrome-wired instance connects, syncs and disconnects Apple over CalDAV', async () => {
  const realFetch = globalThis.fetch;
  const server = fakeCalDav();
  globalThis.fetch = server.fetch;
  try {
    const due = Date.now() + 3 * 24 * 60 * 60 * 1000;
    await storage.saveProblemMap({
      'two-sum': { ...problem('two-sum', 'easy', 0), dueAt: new Date(due).setHours(0, 0, 0, 0) },
    });

    const wrong = await calendarSync.connectCalendar('apple', { appleId: 'me@icloud.com', appPassword: 'nope' });
    assert.deepEqual(wrong, { status: 'error', error: 'Apple ID or app-specific password was rejected.' });
    assert.equal(stored('apple'), undefined);
    assert.equal(server.calendars.size, 0);

    const res = await calendarSync.connectCalendar('apple', { appleId: 'me@icloud.com', appPassword: 'app-pass' });
    assert.deepEqual(res, { status: 'connected', account: 'me@icloud.com' });
    const state = stored('apple');
    assert.match(state.calendarId, /^https:\/\/p01-caldav\.icloud\.com\/123\/calendars\/[0-9a-f-]+\/$/);
    const ref = state.events['two-sum'];
    assert.ok(ref.id.startsWith(state.calendarId) && ref.id.endsWith('.ics'));
    assert.equal(ref.etag, '"1"');
    assert.match(server.resources.get(new URL(ref.id).pathname), /SUMMARY:Review: two-sum/);
    assert.equal(state.lastError, null);

    assert.deepEqual(await calendarSync.disconnectCalendar('apple'), { status: 'disconnected' });
    assert.equal(server.calendars.size, 0);
    assert.equal(server.resources.size, 0);
    assert.equal(stored('apple'), undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});
