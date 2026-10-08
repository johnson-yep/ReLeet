import {
  getProblems,
  getProblem,
  saveProblem,
  deleteProblem,
  getPending,
  getPendingMap,
  dismissPending,
  resolvePending,
  getSettings,
  getSyncState,
  onProblemsChanged,
  onPendingChanged,
  onSyncStateChanged,
} from '../lib/storage.js';
import { applySolve, recordReview, groupByDue, startOfDay, RATINGS } from '../lib/srs.js';
import { parseProblemInput } from '../lib/problem.js';

const $ = (id) => document.getElementById(id);
const template = $('problem-template');
const DAY_MS = 24 * 60 * 60 * 1000;

let problems = [];
let pending = [];

function label(rating) {
  return rating[0].toUpperCase() + rating.slice(1);
}

function relativeDay(dueAt) {
  const days = Math.round((startOfDay(dueAt) - startOfDay(Date.now())) / DAY_MS);
  if (days < -1) return `${-days} days overdue`;
  if (days === -1) return 'overdue since yesterday';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

function formatDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
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
  const meta =
    `${label(problem.rating)} · solved ${formatDate(problem.solvedAt)} · due ${relativeDay(problem.dueAt)}` +
    (reviews ? ` · ${reviews} review${reviews > 1 ? 's' : ''}` : '');

  // Rating a due problem counts as completing the review and reschedules it.
  const actions = isDueToday
    ? ratingButtons((rating) => review(problem.id, rating), 'Reviewed')
    : [button('⏰', 'icon-btn', () => makeDueNow(problem.id), 'Make due now (for testing notifications)')];
  actions.push(button('✕', 'icon-btn', () => remove(problem), 'Delete'));

  const li = problemItem(problem, meta, actions);
  li.title = `Review date: ${formatDate(problem.dueAt)}`;
  return li;
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

async function renderSyncStatus() {
  const [settings, state] = await Promise.all([getSettings(), getSyncState()]);
  const status = $('sync-status');
  $('sync-now').hidden = !settings.owner;
  if (!settings.owner) {
    status.textContent = 'GitHub not connected';
    status.className = 'muted';
  } else if (state.lastError) {
    status.textContent = `Sync error: ${state.lastError}`;
    status.className = 'error';
  } else {
    status.textContent = `${settings.repo} · synced ${state.lastSyncAt ? timeAgo(state.lastSyncAt) : 'never'}`;
    status.className = 'muted';
  }
}

async function ratePending(id, rating) {
  const s = (await getPendingMap())[id];
  if (!s) return;
  const solve = { ...s, at: s.submittedAt ?? Date.now(), source: 'github' };
  await resolvePending(id, applySolve(await getProblem(id), solve, rating));
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
  btn.textContent = 'Syncing…';
  await chrome.runtime.sendMessage({ type: 'sync-now' });
  btn.disabled = false;
  btn.textContent = 'Sync now';
});

$('open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

onProblemsChanged((list) => { problems = list; render(); });
onPendingChanged((list) => { pending = list; render(); });
onSyncStateChanged(renderSyncStatus);

[problems, pending] = await Promise.all([getProblems(), getPending()]);
render();
renderSyncStatus();
chrome.runtime.sendMessage({ type: 'sync-if-stale' }); // results arrive via storage listeners
