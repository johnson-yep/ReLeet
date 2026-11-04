import {
  getSettings,
  updateSettings,
  getLeetCodeState,
  getCalendars,
  onSettingsChanged,
  onLeetCodeStateChanged,
  onCalendarsChanged,
} from '../lib/storage.js';
import { chromeGoogleAuth, isGoogleClientIdConfigured } from '../lib/calendars/google.js';
import { isOutlookConfigured } from '../lib/calendars/outlook.js';

const $ = (id) => document.getElementById(id);

const MIN_DURATION = 5;
const MAX_DURATION = 240;
const RATINGS = ['easy', 'medium', 'hard'];

let settings = null;
let leetcode = {};
let calendars = {};

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = kind || 'muted';
}

// Small DOM builder. Text always goes in as text nodes, never as HTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);
const formatDateTime = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function timeAgo(ms) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : formatDateTime(ms);
}

// The worker does all network work and is the only writer of the calendars key.
async function send(message) {
  try {
    return (await chrome.runtime.sendMessage(message)) ?? { status: 'error', error: 'No answer from ReLeet.' };
  } catch (e) {
    // Chrome stopped the worker before it answered (restarted, or it waited too long).
    if (/message (channel|port) closed|receiving end does not exist/i.test(e?.message ?? '')) {
      return { status: 'error', error: 'ReLeet stopped before it finished. Try again.' };
    }
    return { status: 'error', error: e.message };
  }
}

// ---- LeetCode ----------------------------------------------------------------

const configuredUsername = () => String(settings?.leetcodeUsername ?? '').trim();

// Also accepts "@name" or a profile link like https://leetcode.com/u/name/.
function parseUsername(input) {
  const text = input.trim();
  const profile = text.match(/leetcode\.com\/(?:u\/)?([^/?#\s]+)/i);
  return (profile && profile[1].toLowerCase() !== 'problems' ? profile[1] : text).replace(/^@/, '');
}

// True while the username box holds unsaved text, which a re-render must keep.
let usernameDirty = false;

function renderLeetCode() {
  const username = configuredUsername();
  const source = settings?.leetcodeUsernameSource;
  if (!usernameDirty) $('username-input').value = username;

  $('username-note').textContent = !username
    ? "Not set. Visit leetcode.com while signed in and it's picked up automatically, or type it here."
    : source === 'auto'
      ? 'Detected automatically from leetcode.com. Saving it here keeps it fixed.'
      : "Typed here. Signing in to leetcode.com as someone else won't change it.";

  const checked = leetcode.username === username;
  const rows = username
    ? [
        ['Checks', 'right after you submit on leetcode.com, and every 15 minutes'],
        ['Last check', checked && leetcode.lastSyncAt ? formatDateTime(leetcode.lastSyncAt) : 'not yet'],
        ['Last error', (checked && leetcode.lastError) || 'none'],
      ]
    : [['Checks', 'off until a username is set']];
  $('leetcode-info').replaceChildren(
    ...rows.flatMap(([label, value]) => [
      h('dt', {}, label),
      h('dd', { class: label === 'Last error' && value !== 'none' ? 'error' : null }, value),
    ]),
  );
  $('sync-now').disabled = $('import-recent').disabled = !username;
}

function describeCheck(result) {
  const messages = {
    ok: () =>
      result.added
        ? `Done. ${plural(result.added, 'new submission')} to rate in the popup.`
        : 'Done. No new accepted submissions.',
    baseline: () => 'Connected. Accepted submissions from now on will be detected.',
    unconfigured: () => 'Save a username first.',
    error: () => `Failed: ${result.error}`,
  };
  return messages[result.status]?.() ?? 'Done.';
}

async function runCheck() {
  const status = $('leetcode-status');
  setStatus(status, 'Checking…');
  const result = await send({ type: 'sync-now' });
  setStatus(status, describeCheck(result), result.status === 'error' ? 'error' : 'ok');
}

$('username-input').addEventListener('input', () => {
  usernameDirty = true;
});

$('username-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('leetcode-status');
  const username = parseUsername($('username-input').value);
  // An empty name goes back to auto-detection.
  settings = await updateSettings({ leetcodeUsername: username, leetcodeUsernameSource: username ? 'manual' : null });
  usernameDirty = false;
  renderLeetCode();
  if (!username) {
    setStatus(status, 'Username cleared. It will be picked up the next time you visit leetcode.com signed in.', 'ok');
    return;
  }
  await runCheck();
});

$('sync-now').addEventListener('click', runCheck);

$('import-recent').addEventListener('click', async () => {
  const status = $('leetcode-status');
  setStatus(status, 'Importing…');
  const result = await send({ type: 'import-recent' });
  if (result.status === 'ok') {
    setStatus(
      status,
      result.added
        ? `Added ${plural(result.added, 'problem')} to rate in the popup.`
        : 'Nothing new: your recent accepted problems are already tracked or waiting in the popup.',
      'ok',
    );
  } else {
    setStatus(status, describeCheck(result), 'error');
  }
});

// ---- Calendars -----------------------------------------------------------------

const PROVIDERS = [
  {
    name: 'google',
    title: 'Google Calendar',
    about: 'Signs in with a Google account. ReLeet can only see the calendar it creates.',
    isConfigured: () => isGoogleClientIdConfigured(chrome.runtime.getManifest().oauth2?.client_id),
  },
  {
    name: 'outlook',
    title: 'Outlook / Microsoft 365',
    about: 'Personal Microsoft accounts (Outlook.com, Hotmail) and work or school accounts.',
    isConfigured: () => isOutlookConfigured(),
  },
  {
    name: 'apple',
    title: 'Apple iCloud',
    about: 'Connects over CalDAV with an app-specific password, not your Apple ID password.',
    isConfigured: () => true,
  },
];

// Per-card UI state that isn't in storage: what's in progress and the last message.
const ui = Object.fromEntries(PROVIDERS.map((p) => [p.name, { busy: null, message: '', kind: '', forceable: false }]));

// Created once and reused by every render, so what the user typed survives re-renders.
const appleFields = {
  appleId: h('input', { type: 'email', placeholder: 'Apple ID email', autocomplete: 'username', 'aria-label': 'Apple ID email' }),
  appPassword: h('input', {
    type: 'password',
    placeholder: 'App-specific password (xxxx-xxxx-xxxx-xxxx)',
    autocomplete: 'off',
    'aria-label': 'App-specific password',
  }),
};

function cardStatus(state) {
  if (!state?.connected) return [h('p', { class: 'muted' }, 'Not connected.')];
  const synced = state.lastSyncAt ? `last synced ${timeAgo(state.lastSyncAt)}` : 'not synced yet';
  const lines = [h('p', {}, state.account ? `Connected as ${state.account} · ${synced}` : `Connected · ${synced}`)];
  if (state.needsReconnect) {
    lines.push(h('p', { class: 'error' }, 'Sign-in expired or was revoked. Reconnect to keep this calendar up to date.'));
    if (state.lastError) lines.push(h('p', { class: 'muted' }, state.lastError));
  } else if (state.lastError) {
    lines.push(h('p', { class: 'error' }, `Last update failed: ${sentence(state.lastError)} Retrying every 15 minutes.`));
  }
  return lines;
}

function appleForm(state) {
  if (!appleFields.appleId.value && state?.account) appleFields.appleId.value = state.account;
  return h(
    'div',
    { class: 'fields' },
    appleFields.appleId,
    appleFields.appPassword,
    h(
      'p',
      { class: 'muted' },
      'Create one at ',
      h('a', { href: 'https://account.apple.com', target: '_blank', rel: 'noopener' }, 'account.apple.com'),
      ' → Sign-In and Security → App-Specific Passwords. It is stored unencrypted in this browser’s extension storage.',
    ),
  );
}

function renderCard(provider) {
  const { name, title, about } = provider;
  const state = calendars[name];
  const configured = provider.isConfigured();
  const connected = Boolean(state?.connected);
  const view = ui[name];
  const busy = Boolean(view.busy);

  const badge = connected
    ? state.needsReconnect || state.lastError
      ? h('span', { class: 'badge warn' }, state.needsReconnect ? 'Needs sign-in' : 'Retrying')
      : h('span', { class: 'badge on' }, 'Connected')
    : h('span', { class: 'badge' }, configured ? 'Off' : 'Setup needed');

  const buttons = [];
  if (!connected || state.needsReconnect) {
    buttons.push(
      h(
        'button',
        { type: 'button', class: 'connect', disabled: !configured || busy, onclick: () => connect(provider) },
        view.busy === 'connect' ? 'Connecting…' : connected ? 'Reconnect' : 'Connect',
      ),
    );
  }
  if (connected) {
    buttons.push(
      h(
        'button',
        { type: 'button', class: 'disconnect', disabled: busy, onclick: () => disconnect(provider) },
        view.busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect',
      ),
    );
    if (view.forceable) {
      buttons.push(
        h(
          'button',
          { type: 'button', class: 'force-disconnect', disabled: busy, onclick: () => disconnect(provider, true) },
          'Disconnect anyway',
        ),
      );
    }
  }

  const showAppleForm = name === 'apple' && (!connected || state.needsReconnect);
  return h(
    'article',
    { class: `calendar-card${connected && (state.needsReconnect || state.lastError) ? ' needs-attention' : ''}`, id: `card-${name}` },
    h('div', { class: 'card-head' }, h('h3', {}, title), badge),
    h('p', { class: 'muted' }, about),
    configured
      ? null
      : h('p', { class: 'setup-needed' }, h('strong', {}, 'One-time setup needed'), ' — see SETUP.md in the extension folder.'),
    cardStatus(state),
    showAppleForm ? appleForm(state) : null,
    h('div', { class: 'button-row' }, buttons),
    view.message ? h('p', { class: view.kind || 'muted', role: 'status' }, view.message) : null,
  );
}

function renderCalendars() {
  // Re-rendering moves the reused Apple inputs, which drops focus; put it back.
  const focused = document.activeElement;
  $('calendar-cards').replaceChildren(...PROVIDERS.map(renderCard));
  if (focused?.isConnected && focused !== document.activeElement) focused.focus();
  $('calendar-sync-now').hidden = !PROVIDERS.some((p) => calendars[p.name]?.connected);
}

function setCard(name, patch) {
  Object.assign(ui[name], patch);
  renderCalendars();
}

async function connect(provider) {
  const { name } = provider;
  let credentials;
  if (name === 'apple') {
    credentials = { appleId: appleFields.appleId.value.trim(), appPassword: appleFields.appPassword.value.trim() };
    if (!credentials.appleId || !credentials.appPassword) {
      setCard(name, { message: 'Enter your Apple ID email and an app-specific password.', kind: 'error' });
      return;
    }
  }
  // Google's consent runs from this page: with a Chrome sign-in and 2FA it can
  // take minutes, longer than Chrome keeps the worker waiting on one request.
  // The worker then gets the token Chrome cached. Started before any await,
  // while the click still counts as a user gesture.
  const googleSignIn = name === 'google' ? chromeGoogleAuth().getToken(true) : null;
  setCard(name, {
    busy: 'connect',
    forceable: false,
    message: name === 'apple' ? 'Checking the password…' : 'Finish signing in in the window that opened.',
    kind: '',
  });
  if (googleSignIn) {
    try {
      await googleSignIn;
    } catch (e) {
      setCard(name, { busy: null, message: e?.message || "Couldn't sign in to Google.", kind: 'error' });
      return;
    }
  }
  const result = await send({ type: 'calendar-connect', provider: name, credentials });
  if (result.status === 'connected') {
    if (name === 'apple') appleFields.appPassword.value = '';
    setCard(name, { busy: null, message: 'Connected. Upcoming reviews are in the “ReLeet” calendar.', kind: 'ok' });
  } else {
    setCard(name, { busy: null, message: result.error ?? "Couldn't connect.", kind: 'error' });
  }
}

async function disconnect(provider, force = false) {
  const { name, title } = provider;
  const account = calendars[name]?.account;
  if (
    !force &&
    !confirm(
      `Disconnect ${title}?\n\nThis deletes the “ReLeet” calendar and all of its review events from ` +
        `${account || 'that account'}. Your other calendars aren't touched.`,
    )
  ) {
    return;
  }
  setCard(name, { busy: 'disconnect', message: '', kind: '' });
  const result = await send({ type: 'calendar-disconnect', provider: name, force });
  if (result.status === 'disconnected') {
    setCard(name, {
      busy: null,
      forceable: false,
      message: force
        ? 'Disconnected. The “ReLeet” calendar is still in your account: delete it there, ' +
          'or connect again to pick it up.'
        : 'Disconnected.',
      kind: 'ok',
    });
  } else {
    // Usually offline or the sign-in expired. Forcing forgets the calendar
    // without deleting it, so the user is told it stays behind.
    const fix = result.reconnect ? 'Reconnect, then Disconnect again to delete it, or' : 'Try again later, or';
    setCard(name, {
      busy: null,
      forceable: true,
      message:
        `Couldn't delete the “ReLeet” calendar: ${sentence(result.error ?? 'unknown error')} ` +
        `${fix} “Disconnect anyway” to leave it in your account.`,
      kind: 'error',
    });
  }
}

$('calendar-sync-now').addEventListener('click', async () => {
  const status = $('calendar-sync-status');
  const btn = $('calendar-sync-now');
  btn.disabled = true;
  setStatus(status, 'Updating…');
  const result = await send({ type: 'calendar-sync-now' });
  btn.disabled = false;
  if (result.status === 'ok') {
    const totals = { created: 0, updated: 0, removed: 0 };
    for (const r of Object.values(result.results ?? {})) for (const k of Object.keys(totals)) totals[k] += r[k] ?? 0;
    const changes = [
      totals.created && `${totals.created} added`,
      totals.updated && `${totals.updated} moved`,
      totals.removed && `${totals.removed} removed`,
    ].filter(Boolean);
    setStatus(status, changes.length ? `Up to date (${changes.join(', ')}).` : 'Up to date. Nothing to change.', 'ok');
  } else {
    setStatus(status, result.error ? `Failed: ${result.error}` : 'Some calendars failed to update; see above.', 'error');
  }
});

// ---- Schedule ----------------------------------------------------------------

// True once the user edits the form, so a settings change from elsewhere
// doesn't overwrite what they're typing.
let scheduleDirty = false;

function renderSchedule({ force = false } = {}) {
  const minutes = Number(settings.reminderMinutes);
  $('reminder-text').textContent = minutes > 0 ? `${plural(minutes, 'minute')} before` : 'at the start';
  if (scheduleDirty && !force) return;
  $('start-time').value = settings.startTime;
  for (const rating of RATINGS) $(`duration-${rating}`).value = settings.durations[rating];
}

$('schedule-form').addEventListener('input', () => {
  scheduleDirty = true;
});

$('schedule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('schedule-status');
  const startTime = $('start-time').value;
  if (!/^\d{2}:\d{2}$/.test(startTime)) return setStatus(status, 'Pick a start time.', 'error');
  const durations = {};
  for (const rating of RATINGS) {
    const value = Number($(`duration-${rating}`).value);
    if (!Number.isInteger(value) || value < MIN_DURATION || value > MAX_DURATION) {
      return setStatus(status, `Block lengths must be whole minutes from ${MIN_DURATION} to ${MAX_DURATION}.`, 'error');
    }
    durations[rating] = value;
  }
  settings = await updateSettings({ startTime, durations });
  scheduleDirty = false;
  renderSchedule({ force: true });
  const anyCalendar = PROVIDERS.some((p) => calendars[p.name]?.connected);
  setStatus(status, anyCalendar ? 'Saved. Upcoming blocks will move to match.' : 'Saved.', 'ok');
});

// ---- Start ---------------------------------------------------------------------

onSettingsChanged((next) => {
  settings = next;
  renderLeetCode();
  renderSchedule();
});
onLeetCodeStateChanged((next) => {
  leetcode = next;
  renderLeetCode();
});
onCalendarsChanged((next) => {
  calendars = next;
  renderCalendars();
});

[settings, leetcode, calendars] = await Promise.all([getSettings(), getLeetCodeState(), getCalendars()]);
renderLeetCode();
renderCalendars();
renderSchedule({ force: true });
