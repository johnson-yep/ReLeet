import {
  getProblems,
  getProblem,
  saveProblem,
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
import { applySolve, recordReview, groupByDue, startOfDay, RATINGS } from '../lib/srs.js';
import { parseProblemInput } from '../lib/problem.js';
import { createReviewInvite, slotForProblem } from '../lib/calendar.js';
import { ratePending } from '../lib/rating.js';

const $ = (id) => document.getElementById(id);
const template = $('problem-template');
const DAY_MS = 24 * 60 * 60 * 1000;
const CALENDAR_NAMES = { google: 'Google', outlook: 'Outlook', apple: 'Apple' };
const CALENDAR_FULL_NAMES = { google: 'Google Calendar', outlook: 'Outlook', apple: 'iCloud Calendar' };

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

function relativeDay(dueAt) {
  const days = daysFromToday(dueAt);
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

function button(text, className, onClick, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.className = className;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function problemItem({ title, url }, meta, actions) {
  const li = template.content.firstElementChild.cloneNode(true);
  const link = li.querySelector('.problem-title');
  link.textContent = title;
  link.href = url;
  li.querySelector('.problem-meta').textContent = meta;
  li.querySelector('.problem-actions').append(...actions);
  return li;
}

function ratingButtons(onRate, verb) {
  return RATINGS.map((rating) =>
    button(label(rating)[0], `rating ${rating}`, () => onRate(rating), `${verb} — felt ${rating}`),
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
    s.topic,
    tracked ? 'counts as a review' : null,
  ].filter(Boolean).join(' · ');
  return problemItem(s, meta, [
    ...ratingButtons((rating) => ratePending(s.id, rating), 'Rate'),
    button('✕', 'icon-btn', () => dismissPending([s.id]), 'Dismiss without tracking'),
  ]);
}

function renderProblem(problem, isDueToday) {
  const reviews = (problem.history?.length ?? 1) - 1;
  const block = plannedBlock(problem);
  const meta =
    `${label(problem.rating)} · solved ${formatDate(problem.solvedAt)} · due ${relativeDay(problem.dueAt)}` +
    (block ? ` · ${formatTime(block.start)}` : '') +
    (reviews ? ` · ${reviews} review${reviews > 1 ? 's' : ''}` : '');

  // Rating a due problem counts as completing the review and reschedules it.
  const actions = isDueToday
    ? ratingButtons((rating) => review(problem.id, rating), 'Reviewed')
    : [button('⏰', 'icon-btn', () => makeDueNow(problem.id), 'Make due now (for testing notifications)')];
  // A connected calendar already gets the block; the download is for everyone else.
  if (!connectedCalendars().length) {
    actions.push(
      button(
        '📅',
        'icon-btn',
        () => downloadCalendarInvite(problem),
        `Add review on ${formatDate(problem.dueAt)} to a calendar`,
      ),
    );
  }
  actions.push(button('✕', 'icon-btn', () => remove(problem), 'Delete'));

  const li = problemItem(problem, meta, actions);
  li.title = `Review date: ${formatDate(problem.dueAt)}` + (block ? ` at ${formatTime(block.start)}` : '');
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

function render() {
  const { dueToday, upcoming } = groupByDue(problems);
  const newestFirst = [...pending].sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0));
  $('pending-section').hidden = pending.length === 0;
  $('dismiss-all').hidden = pending.length < 2;
  renderList($('pending-list'), null, newestFirst, renderPendingItem);
  renderList($('due-list'), $('due-empty'), dueToday, (p) => renderProblem(p, true));
  renderList($('upcoming-list'), $('upcoming-empty'), upcoming, (p) => renderProblem(p, false));
  $('summary').textContent = `${dueToday.length} due · ${problems.length} tracked`;
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
    setStatus(status, 'LeetCode not connected');
  } else if (leetcode.lastError) {
    setStatus(status, `LeetCode: ${leetcode.lastError}`, 'error');
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
  // A sign-in problem needs the user; anything else (offline, server trouble) retries on its own.
  text.textContent = state.needsReconnect
    ? `${calendar} needs you to sign in again.`
    : `Couldn't update ${calendar}: ${sentence(String(state.lastError))} Retrying every 15 minutes.`;
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

async function review(id, rating) {
  const problem = await getProblem(id);
  if (problem) await saveProblem(recordReview(problem, rating));
}

async function makeDueNow(id) {
  const problem = await getProblem(id);
  if (problem) await saveProblem({ ...problem, dueAt: Date.now() });
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
  await saveProblem(applySolve(await getProblem(parsed.id), parsed, rating));
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
onCalendarsChanged((next) => { calendars = next; renderCalendarStatus(); render(); });

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
