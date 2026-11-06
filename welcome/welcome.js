// The page ReLeet opens when it's installed: sign in to LeetCode, import recent
// solves, connect a calendar, pick the start time and daily limit. Finishing
// makes this computer the main one.

import { getSettings, onSettingsChanged, updateSettings } from '../lib/storage.js';
import { claimMainComputer } from '../lib/computer.js';
import { plural } from '../lib/format.js';
import { mountCalendarCards, send, sentence } from '../options/calendar-cards.js';

const $ = (id) => document.getElementById(id);
let settings = await getSettings();

function setStatus(el, text, kind = 'muted') {
  el.textContent = text;
  el.className = `status ${kind}`;
}

// Step 1: the content script on leetcode.com reports who is signed in.
function renderLeetCode() {
  const username = String(settings.leetcodeUsername ?? '').trim();
  $('step-leetcode').classList.toggle('complete', Boolean(username));
  setStatus($('leetcode-status'), username ? `Signed in as @${username} ✓` : 'Waiting for you to sign in…', username ? 'ok' : 'muted');
  $('import').disabled = !username;
  if (!username) setStatus($('import-status'), 'Sign in to LeetCode first.');
  else if ($('import-status').textContent === 'Sign in to LeetCode first.') setStatus($('import-status'), '');
}

$('import').addEventListener('click', async () => {
  setStatus($('import-status'), 'Importing…');
  const result = await send({ type: 'import-recent' });
  if (result.status === 'ok') {
    $('step-import').classList.add('complete');
    setStatus(
      $('import-status'),
      result.added ? `Added ${plural(result.added, 'problem')} to rate in the ReLeet popup.` : 'Nothing to import yet.',
      'ok',
    );
  } else {
    setStatus($('import-status'), `That didn't work: ${sentence(result.error ?? 'something went wrong')}`, 'error');
  }
});

// Step 3
mountCalendarCards($('calendar-cards'));

// Step 4: saved as it changes, like Settings.
const savedTimers = new Map();
function showSaved(key) {
  const el = document.querySelector(`.saved[data-for="${key}"]`);
  el.textContent = 'Saved';
  clearTimeout(savedTimers.get(key));
  savedTimers.set(key, setTimeout(() => (el.textContent = ''), 2000));
}

function renderSchedule() {
  if (document.activeElement !== $('start-time')) $('start-time').value = settings.startTime;
  if (document.activeElement !== $('daily-limit')) $('daily-limit').value = settings.dailyLimit;
}

$('start-time').addEventListener('change', async () => {
  if (!/^\d{2}:\d{2}$/.test($('start-time').value)) return;
  settings = await updateSettings({ startTime: $('start-time').value });
  showSaved('start-time');
});

$('daily-limit').addEventListener('input', async () => {
  const input = $('daily-limit');
  const value = Number(input.value);
  const ok = input.value !== '' && Number.isInteger(value) && value >= 15 && value <= 600;
  input.setAttribute('aria-invalid', String(!ok));
  $('daily-limit-error').hidden = ok;
  $('daily-limit-error').textContent = ok ? '' : 'The daily limit must be whole minutes from 15 to 600.';
  if (!ok) return;
  settings = await updateSettings({ dailyLimit: value });
  showSaved('daily-limit');
});

$('done').addEventListener('click', async () => {
  await claimMainComputer();
  location.href = 'https://leetcode.com/problemset/';
});

onSettingsChanged((next) => {
  settings = next;
  renderLeetCode();
  renderSchedule();
});
renderLeetCode();
renderSchedule();
