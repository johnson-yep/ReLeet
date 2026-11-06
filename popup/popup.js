import {
  getProblems,
  updateProblemMap,
  deleteProblem,
  getPending,
  dismissPending,
  getSettings,
  getLeetCodeState,
  getSchedule,
  getCalendars,
  onProblemsChanged,
  onPendingChanged,
  onSettingsChanged,
  onLeetCodeStateChanged,
  onScheduleChanged,
  onCalendarsChanged,
} from '../lib/storage.js';
import {
  applySolve,
  recordReview,
  groupByDue,
  startOfDay,
  dayStartMs,
  reviewDay,
  RATINGS,
} from '../lib/srs.js';
import { parseProblemInput } from '../lib/problem.js';
import { createReviewInvite, slotForProblem } from '../lib/calendar.js';
import { ratePending } from '../lib/rating.js';

const $ = (id) => document.getElementById(id);
// Opened in a tab (a notification click when Chrome couldn't show the popup).
if (new URLSearchParams(location.search).has('tab')) document.body.classList.add('in-tab');
const template = $('problem-template');
const DAY_MS = 24 * 60 * 60 * 1000;
const CALENDAR_NAMES = { google: 'Google', apple: 'Apple' };
const CALENDAR_FULL_NAMES = { google: 'Google Calendar', apple: 'iCloud Calendar' };

let problems = [];
let pending = [];
let settings = null;
let leetcode = {};
let schedule = { layoutKey: null, entries: {} };
let calendars = {};

function label(rating) {
  return rating[0].toUpperCase() + rating.slice(1);
}

function daysFromToday(ms) {
  return Math.round((startOfDay(ms) - startOfDay(Date.now())) / DAY_MS);
}

// Local midnight of the problem's review day, for dates shown in the list.
const reviewDate = (problem) => dayStartMs(reviewDay(problem));

function relativeDay(problem) {
  const days = daysFromToday(reviewDate(problem));
  if (days < -1) return `${-days} days overdue`;
  if (days === -1) return 'overdue since yesterday';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

function formatDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function timeAgo(ms) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : formatDate(ms);
}

// `action` names what the button does, so focus can find it again after a re-render.
function button(text, className, onClick, title, action = null) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.className = className;
  if (title) b.title = title;
  if (action) b.dataset.action = action;
  b.addEventListener('click', onClick);
  return b;
}

function problemItem({ id, title, url }, meta, actions) {
  const li = template.content.firstElementChild.cloneNode(true);
  li.dataset.id = id;
  const link = li.querySelector('.problem-title');
  link.textContent = title;
  link.href = url;
  li.querySelector('.problem-meta').textContent = meta;
  li.querySelector('.problem-actions').append(...actions);
  return li;
}

function ratingButtons(onRate, verb) {
  return RATINGS.map((rating) =>
    button(label(rating)[0], `rating ${rating}`, () => onRate(rating), `${verb} — felt ${rating}`, rating),
  );
}

const connectedCalendars = () => Object.keys(CALENDAR_NAMES).filter((name) => calendars[name]?.connected);

// The planned block, if it's still ahead (or today). An overdue review's block
// is history, so its time isn't shown.
function plannedBlock(problem) {
  const slot = schedule.entries?.[problem.id];
  return slot && daysFromToday(slot.start) >= 0 ? slot : null;
}

function renderPendingItem(s) {
  const tracked = problems.some((p) => p.id === s.id);
  const meta = [
    s.submittedAt ? `submitted ${formatDate(s.submittedAt)}` : 'imported',
    s.topic, // only on rows left over from v0.2's NeetCode / GitHub sync
    tracked ? 'counts as a review' : null,
  ].filter(Boolean).join(' · ');
  return problemItem(s, meta, [
    ...ratingButtons((rating) => ratePending(s.id, rating), 'Rate'),
    button('✕', 'icon-btn', () => dismissPending([s.id]), 'Dismiss without tracking', 'dismiss'),
  ]);
}

function renderProblem(problem, isDueToday) {
  const reviews = (problem.history?.length ?? 1) - 1;
  const block = plannedBlock(problem);
  const meta =
    `${label(problem.rating)} · solved ${formatDate(problem.solvedAt)} · due ${relativeDay(problem)}` +
    (block ? ` · ${formatTime(block.start)}` : '') +
    (reviews ? ` · ${reviews} review${reviews > 1 ? 's' : ''}` : '');

  // Rating a due problem counts as completing the review and reschedules it.
  const actions = isDueToday ? ratingButtons((rating) => review(problem.id, rating), 'Reviewed') : [];
  // A connected calendar already gets the block; the download is for everyone else.
  if (!connectedCalendars().length) {
    actions.push(
      button(
        '📅',
        'icon-btn',
        () => downloadCalendarInvite(problem),
        `Add review on ${formatDate(reviewDate(problem))} to a calendar`,
        'download',
      ),
    );
  }
  actions.push(button('✕', 'icon-btn', () => remove(problem), 'Delete', 'delete'));

  const li = problemItem(problem, meta, actions);
  li.title = `Review date: ${formatDate(reviewDate(problem))}` + (block ? ` at ${formatTime(block.start)}` : '');
  return li;
}

function downloadCalendarInvite(problem) {
  const slot = schedule.entries?.[problem.id] ?? slotForProblem(problem, settings);
  if (!slot) return;
  const { contents, filename } = createReviewInvite(slot);
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderList(listEl, emptyEl, items, renderItem) {
  listEl.replaceChildren(...items.map(renderItem));
  if (emptyEl) emptyEl.hidden = items.length > 0;
}

// The lists are rebuilt on every change, which drops keyboard focus. Remember
// the focused button by list, problem and action, and focus its replacement.
function focusedRowButton() {
  const el = document.activeElement;
  const li = el?.closest?.('li[data-id]');
  return li && el.dataset.action ? { list: li.parentElement.id, id: li.dataset.id, action: el.dataset.action } : null;
}

function refocus(key) {
  if (!key || document.activeElement !== document.body) return;
  const row = [...$(key.list).children].find((li) => li.dataset.id === key.id);
  row?.querySelector(`button[data-action="${key.action}"]`)?.focus();
}

function render() {
  const focused = focusedRowButton();
  const { dueToday, upcoming } = groupByDue(problems);
  const newestFirst = [...pending].sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0));
  $('pending-section').hidden = pending.length === 0;
  $('dismiss-all').hidden = pending.length < 2;
  renderList($('pending-list'), null, newestFirst, renderPendingItem);
  renderList($('due-list'), $('due-empty'), dueToday, (p) => renderProblem(p, true));
  renderList($('upcoming-list'), $('upcoming-empty'), upcoming, (p) => renderProblem(p, false));
  $('summary').textContent = `${dueToday.length} due · ${problems.length} tracked`;
  refocus(focused);
}

function setStatus(el, text, className = 'muted') {
  el.textContent = text;
  el.className = className;
}

function renderLeetCodeStatus() {
  const username = String(settings?.leetcodeUsername ?? '').trim();
  const status = $('sync-status');
  $('sync-now').hidden = !username;
  if (!username) {
    setStatus(status, 'LeetCode not connected: open leetcode.com while signed in');
  } else if (leetcode.lastError) {
    // LeetCode's own messages already say "LeetCode".
    const error = String(leetcode.lastError);
    setStatus(status, /leetcode/i.test(error) ? error : `LeetCode: ${error}`, 'error');
  } else {
    const checked = leetcode.username === username && leetcode.lastSyncAt ? timeAgo(leetcode.lastSyncAt) : 'never';
    setStatus(status, `@${username} · checked ${checked}`);
  }
}

function openSettings() {
  chrome.runtime.openOptionsPage();
}

const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

function calendarWarning(name, state) {
  const p = document.createElement('p');
  p.className = 'banner';
  const text = document.createElement('span');
  const calendar = CALENDAR_FULL_NAMES[name];
  // A sign-in problem needs the user; anything else (offline, server trouble)
  // retries on its own. Error messages give the cause only; the next step is added here.
  if (state.needsReconnect) {
    text.textContent = state.lastError
      ? `${calendar}: ${sentence(String(state.lastError))}`
      : `${calendar} needs you to sign in again.`;
  } else {
    text.textContent = `Couldn't update ${calendar}: ${sentence(String(state.lastError))} Retrying every 15 minutes.`;
  }
  p.append(text, button(state.needsReconnect ? 'Reconnect' : 'Settings', 'link-btn', openSettings));
  return p;
}

function renderCalendarStatus() {
  const names = connectedCalendars();
  const status = $('calendar-status');
  status.hidden = names.length === 0;
  status.textContent = `Calendar: ${names.map((name) => CALENDAR_NAMES[name]).join(', ')}`;
  const failing = names.filter((name) => calendars[name].needsReconnect || calendars[name].lastError);
  $('calendar-warnings').replaceChildren(...failing.map((name) => calendarWarning(name, calendars[name])));
}

// Read and write under one lock, so a rating saved from the leetcode.com
// prompt at the same moment isn't overwritten.
function review(id, rating) {
  return updateProblemMap((map) => {
    if (!map[id]) return null;
    map[id] = recordReview(map[id], rating);
    return map;
  });
}

async function remove(problem) {
  if (confirm(`Stop tracking "${problem.title}"?`)) await deleteProblem(problem.id);
}

$('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('form-error');
  const rating = event.submitter?.value;
  const parsed = parseProblemInput($('problem-input').value);
  if (!parsed) {
    error.textContent = 'Enter a problem title, slug, or LeetCode URL.';
    error.hidden = false;
    return;
  }
  error.hidden = true;

  // Re-adding a tracked problem counts as another review rather than a reset.
  await updateProblemMap((map) => {
    map[parsed.id] = applySolve(map[parsed.id] ?? null, parsed, rating);
    return map;
  });
  $('problem-input').value = '';
});

$('dismiss-all').addEventListener('click', () => {
  if (confirm(`Dismiss all ${pending.length} submissions without tracking them?`)) {
    dismissPending(pending.map((s) => s.id));
  }
});

$('sync-now').addEventListener('click', async () => {
  const btn = $('sync-now');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    await chrome.runtime.sendMessage({ type: 'sync-now' }); // the result arrives via storage listeners
  } catch {
    // The worker failed to answer; the status line still shows the last check.
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check now';
  }
});

$('open-settings').addEventListener('click', openSettings);

onProblemsChanged((list) => { problems = list; render(); });
onPendingChanged((list) => { pending = list; render(); });
onScheduleChanged((next) => { schedule = next; render(); });
onSettingsChanged((next) => { settings = next; renderLeetCodeStatus(); });
onLeetCodeStateChanged((next) => { leetcode = next; renderLeetCodeStatus(); });
// A sync saves the calendars key after every event it writes. The lists only
// care which calendars are connected (for 📅), so most saves skip them.
onCalendarsChanged((next) => {
  const before = connectedCalendars().join();
  calendars = next;
  renderCalendarStatus();
  if (connectedCalendars().join() !== before) render();
});

[problems, pending, settings, leetcode, schedule, calendars] = await Promise.all([
  getProblems(),
  getPending(),
  getSettings(),
  getLeetCodeState(),
  getSchedule(),
  getCalendars(),
]);
render();
renderLeetCodeStatus();
renderCalendarStatus();
chrome.runtime.sendMessage({ type: 'sync-if-stale' }).catch(() => {}); // results arrive via storage listeners
