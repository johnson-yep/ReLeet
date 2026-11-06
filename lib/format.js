// Words and dates the popup, Settings, the welcome page and notifications
// share, so they all say the same thing. Pure — no chrome.* APIs.

import { addDaysToDay, dayKey, dayStartMs, daysBetween } from './srs.js';

const RATING_LABELS = Object.freeze({ easy: 'Easy', okay: 'Okay', hard: 'Hard' });
export const ratingLabel = (rating) => RATING_LABELS[rating] ?? String(rating ?? '');

export const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

export const formatTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export const formatDate = (ms) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

// 'Today', 'Tomorrow' or 'Thu, Nov 12' for a 'YYYY-MM-DD' day.
export function dayName(day, now = Date.now()) {
  const today = dayKey(now);
  if (day === today) return 'Today';
  if (day === addDaysToDay(today, 1)) return 'Tomorrow';
  return formatDate(dayStartMs(day));
}

export function overdueText(sinceDay, now = Date.now()) {
  return `${plural(Math.max(1, daysBetween(sinceDay, dayKey(now))), 'day')} overdue`;
}

export function timeAgo(ms, now = Date.now()) {
  const minutes = Math.round((now - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : formatDate(ms);
}

export const minutesText = (ms) => `${Math.round(ms / 60000)} min`;

// "Mon, Nov 9 at 9:00 AM", the time only when there is a block.
export function reviewWhen(day, start, now = Date.now()) {
  const date = dayName(day, now);
  const when = date === 'Today' || date === 'Tomorrow' ? date.toLowerCase() : date;
  return Number.isFinite(start) ? `${when} at ${formatTime(start)}` : when;
}
