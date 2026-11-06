import {
  getCalendars,
  getLeetCodeState,
  getPendingMap,
  getProblemMap,
  getSchedule,
  getSettings,
  onCalendarsChanged,
  onLeetCodeStateChanged,
  onPendingChanged,
  onProblemsChanged,
  onScheduleChanged,
  onSettingsChanged,
} from '../lib/storage.js';
import { RATINGS } from '../lib/srs.js';
import { popupView } from '../lib/views.js';
import { addSolved, master, ratePending, rateReview, resume, stopTracking, undo } from '../lib/actions.js';
import { claimMainComputer, computerRole, onRoleChanged } from '../lib/computer.js';
import { createLeetCodeClient } from '../lib/leetcode.js';
import { parseProblemInput } from '../lib/problem.js';
import { createReviewInvite } from '../lib/calendar.js';
import {
  dayName,
  formatDate,
  formatTime,
  minutesText,
  overdueText,
  plural,
  ratingLabel,
  reviewWhen,
  timeAgo,
} from '../lib/format.js';

const $ = (id) => document.getElementById(id);
// Opened in a tab (a notification click when Chrome couldn't show the popup).
if (new URLSearchParams(location.search).has('tab')) document.body.classList.add('in-tab');

const TOAST_MS = 10 * 1000;
const CALENDAR_NAMES = { google: 'Google Calendar', apple: 'Apple Calendar' };

const state = {
  role: null,
  problems: {},
  pending: {},
  settings: null,
  leetcode: {},
  schedule: null,
  calendars: {},
  openMenu: null, // problem id whose ⋯ menu is open
  showAll: false,
};

// Small DOM builder. Text always goes in as text nodes, never as HTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

const connectedCalendars = () => Object.keys(CALENDAR_NAMES).filter((name) => state.calendars[name]?.connected);
const openSettings = () => chrome.runtime.openOptionsPage();

// ---- Rows --------------------------------------------------------------------

function ratingButtons(title, intervals, onRate) {
  return h(
    'div',
    { class: 'ratings', role: 'group', 'aria-label': `Rate ${title}` },
    RATINGS.map((rating) =>
      h(
        'button',
        {
          type: 'button',
          class: `rate ${rating}`,
          'data-action': `rate-${rating}`,
          'aria-label': `Rate ${title}: ${ratingLabel(rating)}, next review in ${plural(intervals[rating].days, 'day')}`,
          onclick: () => onRate(rating),
        },
        ratingLabel(rating),
        h('span', { class: 'days' }, ` · ${intervals[rating].days}d`),
      ),
    ),
  );
}

// item: { id, title, url, tooltip, status, statusClass, ratings, menu: [{ label, action, run, danger }], button }
function row(item) {
  const menuOpen = state.openMenu === item.id;
  const menuButton = item.menu?.length
    ? h(
        'button',
        {
          type: 'button',
          class: 'icon-btn menu-btn',
          'data-action': 'menu',
          'aria-label': `More for ${item.title}`,
          'aria-haspopup': 'menu',
          'aria-expanded': String(menuOpen),
          onclick: (event) => {
            event.stopPropagation();
            state.openMenu = menuOpen ? null : item.id;
            render();
            if (!menuOpen) document.querySelector(`li[data-id="${CSS.escape(item.id)}"] .menu button`)?.focus();
          },
        },
        '⋯',
      )
    : null;
  const menu = menuOpen
    ? h(
        'div',
        { class: 'menu', role: 'menu', 'aria-label': `More for ${item.title}` },
        item.menu.map((entry) =>
          h(
            'button',
            {
              type: 'button',
              role: 'menuitem',
              class: entry.danger ? 'danger' : null,
              'data-action': entry.action,
              onclick: () => {
                state.openMenu = null;
                render();
                entry.run();
              },
            },
            entry.label,
          ),
        ),
      )
    : null;

  return h(
    'li',
    { class: `row${item.waiting ? ' waiting' : ''}`, 'data-id': item.id },
    h(
      'div',
      { class: 'row-main' },
      h('a', { class: 'title', href: item.url, target: '_blank', rel: 'noopener', title: item.tooltip }, item.title),
      h('span', { class: `status${item.statusClass ? ` ${item.statusClass}` : ''}` }, item.status),
      item.button ?? menuButton,
    ),
    item.ratings,
    menu,
  );
}

// "Two Sum · solved Nov 2 · 3 reviews", for the title's tooltip.
function tooltip(problem, title) {
  if (!problem) return title;
  const reviews = Math.max(0, (problem.history?.length ?? 1) - 1);
  return `${title} · solved ${formatDate(problem.solvedAt)}${reviews ? ` · ${plural(reviews, 'review')}` : ''}`;
}

function trackedMenu(problem, slot) {
  const items = [{ label: 'Mark mastered', action: 'master', run: () => markMastered(problem) }];
  // A connected calendar already gets the block; the download is for everyone else.
  if (slot && !connectedCalendars().length) {
    items.push({ label: 'Add to calendar (.ics)', action: 'download', run: () => downloadInvite(slot) });
  }
  items.push({ label: 'Stop tracking', action: 'stop', danger: true, run: () => stop(problem.id, problem.title) });
  return items;
}

function toRateRow({ solve, problem, intervals }) {
  const solved = solve.submittedAt ? `solved ${timeAgo(solve.submittedAt)}` : 'imported';
  return row({
    id: solve.id,
    title: solve.title,
    url: solve.url,
    tooltip: problem ? `${tooltip(problem, solve.title)} · this solve counts as a review` : solve.title,
    status: solved,
    waiting: true,
    ratings: ratingButtons(solve.title, intervals, (rating) => rateSolve(solve, rating)),
    menu: [
      { label: 'Mark mastered', action: 'master', run: () => markMastered({ id: solve.id, title: solve.title }) },
      { label: 'Stop tracking', action: 'stop', danger: true, run: () => stop(solve.id, solve.title) },
    ],
  });
}

function dueRow({ slot, problem, intervals }) {
  const overdue = Boolean(slot.overdueSince);
  return row({
    id: problem.id,
    title: problem.title,
    url: problem.url,
    tooltip: tooltip(problem, problem.title),
    status: overdue ? overdueText(slot.overdueSince) : `Today · ${formatTime(slot.start)}`,
    statusClass: overdue ? 'overdue' : null,
    ratings: ratingButtons(problem.title, intervals, (rating) => rateDue(problem, rating)),
    menu: trackedMenu(problem, slot),
  });
}

function upcomingRow({ slot, problem }) {
  return row({
    id: problem.id,
    title: problem.title,
    url: problem.url,
    tooltip: tooltip(problem, problem.title),
    status: formatTime(slot.start),
    menu: trackedMenu(problem, slot),
  });
}

function masteredRow(problem) {
  return row({
    id: problem.id,
    title: problem.title,
    url: problem.url,
    tooltip: tooltip(problem, problem.title),
    status: `since ${formatDate(problem.masteredAt)}`,
    button: h(
      'button',
      {
        type: 'button',
        class: 'btn-link',
        'data-action': 'resume',
        'aria-label': `Resume reviewing ${problem.title}`,
        onclick: () => resumeReviews(problem),
      },
      'Resume',
    ),
  });
}

// ---- Render ------------------------------------------------------------------

// The lists are rebuilt on every change, which drops keyboard focus. Remember
// the focused control by problem and action, and focus its replacement.
function focusedControl() {
  const el = document.activeElement;
  const li = el?.closest?.('li[data-id]');
  return li && el.dataset.action ? { id: li.dataset.id, action: el.dataset.action } : null;
}

function refocus(key) {
  if (!key || document.activeElement !== document.body) return;
  const li = document.querySelector(`li[data-id="${CSS.escape(key.id)}"]`);
  li?.querySelector(`[data-action="${key.action}"]`)?.focus();
}

function view() {
  return popupView(state);
}

function renderStats(stats) {
  const parts = [`${stats.tracked} tracked`, `${stats.dueToday} due today`];
  if (stats.mastered) parts.push(`${stats.mastered} mastered`);
  if (stats.streak) parts.push(`${stats.streak}-day streak`);
  $('stats').textContent = parts.join(' · ');
}

function renderBanners() {
  const banners = connectedCalendars()
    .filter((name) => state.calendars[name].needsReconnect || state.calendars[name].lastError)
    .map((name) => {
      const calendar = state.calendars[name];
      const text = calendar.needsReconnect
        ? `${CALENDAR_NAMES[name]} needs you to sign in again.`
        : `Couldn't update ${CALENDAR_NAMES[name]}. Retrying every 15 minutes.`;
      return h(
        'p',
        { class: 'banner', role: 'status' },
        h('span', {}, text),
        h('button', { type: 'button', class: 'btn-link', onclick: openSettings }, calendar.needsReconnect ? 'Reconnect' : 'Details'),
      );
    });
  $('banners').replaceChildren(...banners);
}

function renderList(section, items, makeRow, title) {
  $(section).hidden = items.length === 0;
  if (title) $(`${section}-title`).textContent = title;
  $(section).querySelector('.problem-list').replaceChildren(...items.map(makeRow));
}

function renderUpcoming(groups, count) {
  const shown = state.showAll ? groups : groups.filter((g) => g.soon);
  $('upcoming').hidden = groups.length === 0;
  $('upcoming-days').replaceChildren(
    ...shown.map((group) =>
      h(
        'div',
        { class: 'day' },
        h(
          'p',
          { class: 'day-head', id: `day-${group.day}` },
          dayName(group.day),
          h('span', { class: 'muted' }, ` · ${plural(group.items.length, 'review')} · ${minutesText(group.minutes)}`),
        ),
        h('ul', { class: 'problem-list', 'aria-labelledby': `day-${group.day}` }, group.items.map(upcomingRow)),
      ),
    ),
  );
  const hidden = groups.length - shown.length;
  $('show-all').hidden = hidden === 0;
  $('show-all').textContent = `Show all (${count})`;
}

function renderLeetCodeStatus() {
  const username = String(state.settings?.leetcodeUsername ?? '').trim();
  const status = $('leetcode-status');
  $('sync-now').hidden = !username;
  if (!username) {
    status.className = '';
    status.replaceChildren(
      h('a', { href: 'https://leetcode.com/accounts/login/', target: '_blank', rel: 'noopener' }, 'LeetCode not connected'),
      h('span', { class: 'muted' }, ': sign in on leetcode.com'),
    );
  } else if (state.leetcode.lastError && state.leetcode.username === username) {
    status.className = 'error';
    status.textContent = String(state.leetcode.lastError);
  } else {
    const { lastSyncAt } = state.leetcode;
    const checked = state.leetcode.username === username && lastSyncAt ? timeAgo(lastSyncAt) : 'not yet';
    status.className = 'muted';
    status.textContent = `@${username} · checked ${checked}`;
  }
}

function render() {
  const idle = state.role === 'idle';
  $('idle').hidden = !idle;
  $('main').hidden = idle;
  $('footer').hidden = idle;
  if (idle) return;

  const focused = focusedControl();
  const v = view();
  renderStats(v.stats);
  $('stats').hidden = v.empty;
  renderBanners();
  $('empty').hidden = !v.empty;
  renderList('to-rate', v.toRate, toRateRow, `To rate (${v.toRate.length})`);
  renderList('due', v.due.items, dueRow, `Due today (${v.due.items.length} · ${minutesText(v.due.minutes)})`);
  renderUpcoming(v.upcoming, v.upcomingCount);
  $('mastered').hidden = v.mastered.length === 0;
  $('mastered-title').textContent = `Mastered (${v.mastered.length})`;
  $('mastered').querySelector('.problem-list').replaceChildren(...v.mastered.map(masteredRow));
  renderLeetCodeStatus();
  refocus(focused);
}

// ---- Toast with Undo ---------------------------------------------------------

let toastTimer = null;

// parts: [text, bold?][]; actions: [{ label, run }]
function toast(parts, actions = []) {
  clearTimeout(toastTimer);
  $('toast-text').replaceChildren(...parts.map(([text, bold]) => (bold ? h('strong', {}, text) : text)));
  $('toast').querySelector('.toast-actions').replaceChildren(
    ...actions.map(({ label, run }) =>
      h(
        'button',
        {
          type: 'button',
          class: 'btn-link',
          onclick: () => {
            hideToast();
            run();
          },
        },
        label,
      ),
    ),
  );
  $('toast').hidden = false;
  toastTimer = setTimeout(hideToast, TOAST_MS);
}

function hideToast() {
  clearTimeout(toastTimer);
  $('toast').hidden = true;
}

function undoAction(id, change) {
  return {
    label: 'Undo',
    run: async () => {
      if (!(await undo(id, change))) toast([["Couldn't undo: it changed since.", false]]);
    },
  };
}

async function reload() {
  [state.problems, state.pending, state.schedule] = await Promise.all([getProblemMap(), getPendingMap(), getSchedule()]);
}

// "Saved: Okay. Next review Mon, Nov 9 at 9:00 AM." and, at the longest
// interval, an offer to mark it mastered.
async function confirmRating(id, title, rating, change) {
  if (!change) return;
  await reload();
  const slot = view().plan.entries[id];
  const parts = [[`Saved: ${ratingLabel(rating)}.`, true]];
  if (slot) parts.push([` Next review ${reviewWhen(slot.day, slot.start)}.`, false]);
  const actions = [undoAction(id, change)];
  if (change.capped) {
    parts.push([" That's the longest interval.", false]);
    actions.unshift({ label: 'Mark mastered', run: () => markMastered({ id, title }) });
  }
  toast(parts, actions);
}

async function rateSolve(solve, rating) {
  await confirmRating(solve.id, solve.title, rating, await ratePending(solve.id, rating));
}

async function rateDue(problem, rating) {
  const change = await rateReview(problem.id, rating, { seen: problem.history?.length ?? 0 });
  await confirmRating(problem.id, problem.title, rating, change);
}

async function markMastered({ id, title }) {
  const change = await master(id);
  if (change) toast([[`${title}`, true], [' is mastered. No more reviews.', false]], [undoAction(id, change)]);
}

async function stop(id, title) {
  const change = await stopTracking(id);
  if (change) toast([['Stopped tracking ', false], [title, true], ['.', false]], [undoAction(id, change)]);
}

async function resumeReviews(problem) {
  const change = await resume(problem.id);
  if (!change) return;
  await reload();
  const slot = view().plan.entries[problem.id];
  toast(
    [[problem.title, true], [slot ? ` is back. Next review ${reviewWhen(slot.day, slot.start)}.` : ' is back.', false]],
    [undoAction(problem.id, change)],
  );
}

function downloadInvite(slot) {
  const { contents, filename } = createReviewInvite(slot);
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/calendar;charset=utf-8' }));
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Add a problem -----------------------------------------------------------

// LeetCode's own title ("LRU Cache" for lru-cache). Offline or unknown: the
// title made from the input.
async function lookUpTitle(parsed) {
  if (!/leetcode\.com/.test(parsed.url)) return parsed.title;
  try {
    return (await createLeetCodeClient().questionTitle(parsed.id)) ?? parsed.title;
  } catch {
    return parsed.title;
  }
}

$('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('add-error');
  const rating = event.submitter?.value;
  const parsed = parseProblemInput($('problem-input').value);
  if (!parsed) {
    error.textContent = 'Enter a LeetCode link, a problem name or a slug.';
    error.hidden = false;
    return;
  }
  error.hidden = true;
  const buttons = [...$('add-form').querySelectorAll('button')];
  for (const b of buttons) b.disabled = true;
  try {
    const title = await lookUpTitle(parsed);
    const change = await addSolved({ ...parsed, title }, rating);
    $('problem-input').value = '';
    await confirmRating(parsed.id, title, rating, change);
  } finally {
    for (const b of buttons) b.disabled = false;
  }
});

// ---- Other controls ----------------------------------------------------------

$('open-settings').addEventListener('click', openSettings);

$('show-all').addEventListener('click', () => {
  state.showAll = true;
  render();
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

$('empty-import').addEventListener('click', async () => {
  const status = $('empty-status');
  status.textContent = 'Importing…';
  const result = await chrome.runtime.sendMessage({ type: 'import-recent' }).catch(() => null);
  if (result?.status === 'ok') {
    status.textContent = result.added ? '' : 'Nothing to import: no recent accepted solves.';
  } else if (result?.status === 'unconfigured') {
    status.textContent = 'Sign in on leetcode.com first, then try again.';
  } else {
    status.textContent = result?.error ?? "Couldn't import. Try again.";
  }
});

$('use-here').addEventListener('click', () => {
  $('idle-ask').hidden = true;
  $('idle-confirm').hidden = false;
  $('use-here-confirm').focus();
});
$('use-here-cancel').addEventListener('click', () => {
  $('idle-confirm').hidden = true;
  $('idle-ask').hidden = false;
  $('use-here').focus();
});
$('use-here-confirm').addEventListener('click', () => claimMainComputer());

// A click anywhere else, or Escape, closes an open ⋯ menu.
document.addEventListener('click', (event) => {
  if (state.openMenu && !event.target.closest?.('.menu')) {
    state.openMenu = null;
    render();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !state.openMenu) return;
  const id = state.openMenu;
  state.openMenu = null;
  render();
  document.querySelector(`li[data-id="${CSS.escape(id)}"] [data-action="menu"]`)?.focus();
  event.preventDefault();
});

// ---- Start -------------------------------------------------------------------

const update = (key) => (value) => {
  state[key] = value;
  render();
};
onProblemsChanged((list) => update('problems')(Object.fromEntries(list.map((p) => [p.id, p]))));
onPendingChanged((list) => update('pending')(Object.fromEntries(list.map((s) => [s.id, s]))));
onScheduleChanged(update('schedule'));
onSettingsChanged(update('settings'));
onLeetCodeStateChanged(update('leetcode'));
onCalendarsChanged(update('calendars'));
onRoleChanged(update('role'));

[state.role, state.problems, state.pending, state.settings, state.leetcode, state.schedule, state.calendars] =
  await Promise.all([
    computerRole(),
    getProblemMap(),
    getPendingMap(),
    getSettings(),
    getLeetCodeState(),
    getSchedule(),
    getCalendars(),
  ]);
render();
if (state.role !== 'idle') chrome.runtime.sendMessage({ type: 'sync-if-stale' }).catch(() => {}); // results arrive via storage listeners
