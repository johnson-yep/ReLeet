import {
  getLeetCodeState,
  getSettings,
  onLeetCodeStateChanged,
  onSettingsChanged,
  updateSettings,
} from '../lib/storage.js';
import { RATINGS } from '../lib/srs.js';
import { claimMainComputer, computerRole, onRoleChanged } from '../lib/computer.js';
import { plural, timeAgo } from '../lib/format.js';
import { mountCalendarCards, send, sentence } from './calendar-cards.js';

const $ = (id) => document.getElementById(id);

const LIMITS = {
  dailyLimit: { min: 15, max: 600 },
  duration: { min: 5, max: 240 },
};

let settings = null;
let leetcode = {};
let role = null;

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = kind || 'muted';
}

// "Saved" beside a field for a moment after it saves.
const savedTimers = new Map();
function showSaved(key) {
  const el = document.querySelector(`.saved[data-for="${key}"]`);
  if (!el) return;
  el.textContent = 'Saved';
  clearTimeout(savedTimers.get(key));
  savedTimers.set(key, setTimeout(() => (el.textContent = ''), 2000));
}

async function save(key, patch) {
  settings = await updateSettings(patch);
  showSaved(key);
}

// ---- LeetCode ----------------------------------------------------------------

const configuredUsername = () => String(settings?.leetcodeUsername ?? '').trim();

// Also accepts "@name" or a profile link like https://leetcode.com/u/name/.
function parseUsername(input) {
  const text = input.trim();
  const profile = text.match(/leetcode\.com\/(?:u\/)?([^/?#\s]+)/i);
  return (profile && profile[1].toLowerCase() !== 'problems' ? profile[1] : text).replace(/^@/, '');
}

function renderLeetCode() {
  const username = configuredUsername();
  const input = $('username-input');
  if (document.activeElement !== input) input.value = username;

  $('username-note').textContent = !username
    ? 'Open leetcode.com while signed in and ReLeet picks it up, or type it here.'
    : settings.leetcodeUsernameSource === 'auto'
      ? 'Picked up from leetcode.com.'
      : "Typed here, so signing in to leetcode.com as someone else won't change it.";

  const checked = leetcode.username === username;
  const last = $('last-check');
  if (!username) {
    setStatus(last, 'ReLeet checks LeetCode once it knows your username.');
  } else if (checked && leetcode.lastError) {
    setStatus(last, `The last check failed: ${sentence(String(leetcode.lastError))}`, 'error');
  } else {
    setStatus(last, checked && leetcode.lastSyncAt ? `Last checked ${timeAgo(leetcode.lastSyncAt)}.` : 'Not checked yet.');
  }
  $('sync-now').disabled = $('import-recent').disabled = !username;
}

function describeCheck(result) {
  const messages = {
    ok: () => (result.added ? `Done. ${plural(result.added, 'new solve')} to rate in the popup.` : 'Done. Nothing new.'),
    baseline: () => 'Connected. ReLeet notices your accepted solves from now on.',
    unconfigured: () => 'Enter your username first.',
    idle: () => 'ReLeet is active on another computer.',
    error: () => `That didn't work: ${sentence(result.error ?? 'something went wrong')}`,
  };
  return messages[result.status]?.() ?? 'Done.';
}

async function runCheck() {
  const status = $('leetcode-status');
  setStatus(status, 'Checking…');
  const result = await send({ type: 'sync-now' });
  setStatus(status, describeCheck(result), ['error', 'idle'].includes(result.status) ? 'error' : 'ok');
}

let usernameTimer = null;
$('username-input').addEventListener('input', () => {
  clearTimeout(usernameTimer);
  usernameTimer = setTimeout(saveUsername, 700);
});
$('username-input').addEventListener('change', () => {
  clearTimeout(usernameTimer);
  saveUsername();
});

async function saveUsername() {
  const username = parseUsername($('username-input').value);
  if (username === configuredUsername()) return;
  // An empty name goes back to picking it up from leetcode.com.
  await save('username-input', { leetcodeUsername: username, leetcodeUsernameSource: username ? 'manual' : null });
  renderLeetCode();
}

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
        : 'Nothing new: your recent solves are already tracked or waiting in the popup.',
      'ok',
    );
  } else {
    setStatus(status, describeCheck(result), 'error');
  }
});

// ---- Schedule ----------------------------------------------------------------

function renderSchedule() {
  const minutes = Number(settings.reminderMinutes);
  $('reminder-text').textContent = minutes > 0 ? `${plural(minutes, 'minute')} before` : 'when it starts';
  const fill = (id, value) => {
    if (document.activeElement !== $(id) && $(id).getAttribute('aria-invalid') !== 'true') $(id).value = value;
  };
  fill('start-time', settings.startTime);
  fill('daily-limit', settings.dailyLimit);
  for (const rating of RATINGS) fill(`duration-${rating}`, settings.durations[rating]);
}

// Whole minutes in range, or an error message. Shown beside the field; nothing saves until it's right.
function checkMinutes(input, { min, max }, what) {
  const value = Number(input.value);
  const ok = input.value !== '' && Number.isInteger(value) && value >= min && value <= max;
  input.setAttribute('aria-invalid', String(!ok));
  return ok ? null : `${what} must be whole minutes from ${min} to ${max}.`;
}

function showError(id, message) {
  $(id).textContent = message ?? '';
  $(id).hidden = !message;
}

$('start-time').addEventListener('change', async () => {
  const startTime = $('start-time').value;
  if (/^\d{2}:\d{2}$/.test(startTime)) await save('start-time', { startTime });
});

$('daily-limit').addEventListener('input', async () => {
  const error = checkMinutes($('daily-limit'), LIMITS.dailyLimit, 'The daily limit');
  showError('daily-limit-error', error);
  if (!error) await save('daily-limit', { dailyLimit: Number($('daily-limit').value) });
});

for (const rating of RATINGS) {
  $(`duration-${rating}`).addEventListener('input', async () => {
    const errors = RATINGS.map((r) => checkMinutes($(`duration-${r}`), LIMITS.duration, 'Each review'));
    const error = errors.find(Boolean) ?? null;
    showError('durations-error', error);
    if (error) return;
    const durations = Object.fromEntries(RATINGS.map((r) => [r, Number($(`duration-${r}`).value)]));
    await save('durations', { durations });
  });
}

// ---- Calendars ---------------------------------------------------------------

const calendarCards = mountCalendarCards($('calendar-cards'), { onRender: () => renderCalendarExtras() });

function renderCalendarExtras() {
  $('calendar-sync-now').hidden = !calendarCards.anyConnected();
  $('no-calendars').hidden = calendarCards.anyAvailable();
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
    setStatus(status, result.error ? `That didn't work: ${sentence(result.error)}` : 'Some calendars failed to update; see above.', 'error');
  }
});

// ---- Notifications -------------------------------------------------------------

$('daily-summary').addEventListener('change', () => save('daily-summary', { dailySummary: $('daily-summary').checked }));

$('test-notification').addEventListener('click', async () => {
  const status = $('notification-status');
  const result = await send({ type: 'test-notification' });
  if (result.status !== 'ok') return setStatus(status, `That didn't work: ${sentence(result.error ?? 'unknown error')}`, 'error');
  setStatus(status, 'Sent. If nothing appeared, check that your computer allows notifications from Chrome.', 'ok');
});

// ---- This computer ---------------------------------------------------------------

function renderComputer() {
  const idle = role === 'idle';
  $('idle-banner').hidden = !idle;
  $('computer-status').textContent = idle
    ? 'ReLeet is active on another computer. This copy keeps its data but does nothing until you use it here.'
    : 'This is your main computer: ReLeet checks LeetCode and updates your calendars from here.';
  $('computer-switch').hidden = !idle || !$('computer-confirm').hidden;
}

$('use-here').addEventListener('click', () => {
  $('computer-confirm').hidden = false;
  renderComputer();
  $('use-here-confirm').focus();
});
$('use-here-cancel').addEventListener('click', () => {
  $('computer-confirm').hidden = true;
  renderComputer();
  $('use-here').focus();
});
$('use-here-confirm').addEventListener('click', async () => {
  await claimMainComputer();
  $('computer-confirm').hidden = true;
});

$('export').addEventListener('click', async () => {
  const status = $('transfer-status');
  const result = await send({ type: 'export-data' });
  if (result.status !== 'ok') return setStatus(status, `That didn't work: ${sentence(result.error ?? 'unknown error')}`, 'error');
  const day = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: `releet-export-${day}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(status, `Exported ${plural(Object.keys(result.data.problems).length, 'problem')}.`, 'ok');
});

$('import').addEventListener('click', () => $('import-file').click());

$('import-file').addEventListener('change', async () => {
  const status = $('transfer-status');
  const [file] = $('import-file').files;
  $('import-file').value = '';
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return setStatus(status, "That file isn't a ReLeet export.", 'error');
  }
  const result = await send({ type: 'import-data', data });
  if (result.status !== 'ok') return setStatus(status, result.error ?? "Couldn't import that file.", 'error');
  const names = { google: 'Google Calendar', apple: 'Apple Calendar' };
  const reconnect = (result.calendars ?? []).map((name) => names[name]).join(' and ');
  setStatus(
    status,
    `Imported ${plural(result.problems, 'problem')} (${result.added} new to this computer).` +
      (reconnect ? ` Connect ${reconnect} again above to keep using its “ReLeet” calendar.` : ''),
    'ok',
  );
});

// ---- Privacy and your data ---------------------------------------------------------

async function deleteAll(force) {
  const status = $('delete-status');
  setStatus(status, 'Deleting…');
  const result = await send({ type: 'delete-all-data', force });
  if (result.status === 'deleted') {
    $('delete-anyway').hidden = true;
    const left = result.leftBehind?.length ? ' The “ReLeet” calendar is still in your account: delete it there.' : '';
    setStatus(status, `All ReLeet data in this browser is deleted.${left}`, 'ok');
    return;
  }
  if (result.failed?.length) {
    const why = result.failed.map((f) => sentence(f.error ?? 'unknown error')).join(' ');
    $('delete-anyway').hidden = false;
    setStatus(
      status,
      `Nothing was deleted: ReLeet couldn't delete the “ReLeet” calendar. ${why} Try again later, or ` +
        '“Delete anyway” to leave the calendar in your account.',
      'error',
    );
    return;
  }
  setStatus(status, `That didn't work: ${sentence(result.error ?? 'unknown error')}`, 'error');
}

$('delete-all').addEventListener('click', () => {
  // Kept as a dialog: this can't be undone.
  const ok = confirm(
    'Delete all your ReLeet data?\n\nThis deletes the “ReLeet” calendars from your connected accounts, then every ' +
      "problem, rating and setting in this browser. It can't be undone. Export first if you want a copy.",
  );
  if (ok) deleteAll(false);
});
$('delete-anyway').addEventListener('click', () => deleteAll(true));

// ---- Start ---------------------------------------------------------------------

function renderAll() {
  renderLeetCode();
  renderSchedule();
  $('daily-summary').checked = Boolean(settings.dailySummary);
  renderCalendarExtras();
  renderComputer();
}

onSettingsChanged((next) => {
  settings = next;
  renderAll();
});
onLeetCodeStateChanged((next) => {
  leetcode = next;
  renderLeetCode();
});
onRoleChanged((next) => {
  role = next;
  renderComputer();
});

[settings, leetcode, role] = await Promise.all([getSettings(), getLeetCodeState(), computerRole()]);
renderAll();
