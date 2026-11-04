// Builds iCalendar (RFC 5545) events for review blocks. Pure — no chrome.* APIs.
//
// Two users of the same builder:
//   - the popup's 📅 download (floating local time, METHOD:PUBLISH), which the
//     user imports and approves in any calendar app;
//   - the iCloud CalDAV provider (UTC times, no METHOD, as CalDAV resources require).

import { dayKey, planSchedule } from './schedule.js';
import { startOfDay } from './srs.js';

const MAX_LINE_OCTETS = 75;
const DEFAULT_REMINDER_MINUTES = 15;

const pad = (value) => String(value).padStart(2, '0');

// Floating time: no zone, so the calendar shows it at this wall-clock time
// wherever it's imported. Fine for a file the user downloads on this machine.
function localDateTime(ms) {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function utcDateTime(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// TEXT values (RFC 5545 §3.3.11). Backslash goes first so later escapes aren't
// doubled; other control characters aren't allowed in TEXT at all.
function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/[\u0000-\u0008\u000A-\u001F\u007F]/g, '');
}

// URI values are written as-is (escaping a comma would change the link); only
// characters that would break the line are dropped.
function uriValue(value) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, '');
}

function utf8Length(char) {
  const code = char.codePointAt(0);
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

// Folds a content line to at most 75 octets per physical line (RFC 5545 §3.1).
// Splits only between whole characters, and never inside an escape like "\,",
// so even lenient parsers read it back correctly.
function foldLine(line) {
  const units = line.match(/\\.|[\s\S]/gu) ?? [];
  const lines = [];
  let current = '';
  let size = 0;
  for (const unit of units) {
    const length = [...unit].reduce((sum, char) => sum + utf8Length(char), 0);
    if (size + length > MAX_LINE_OCTETS) {
      lines.push(current);
      current = ' '; // continuation lines start with one space, which counts toward the limit
      size = 1;
    }
    current += unit;
    size += length;
  }
  lines.push(current);
  return lines.join('\r\n');
}

function reminderMinutes(value) {
  const minutes = Number(value ?? NaN);
  return Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes) : DEFAULT_REMINDER_MINUTES;
}

function safeFilename(value) {
  return (
    String(value ?? '')
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .replace(/-+$/, '') || 'problem'
  );
}

function slotDay(slot) {
  return slot.day ?? dayKey(slot.start);
}

// One UID per problem and review day, so importing the same download twice
// updates the event instead of duplicating it.
function defaultUid(slot) {
  return `${safeFilename(slot.problemId)}-${slotDay(slot).replace(/-/g, '')}@releet`;
}

// Full VCALENDAR text for one slot, CRLF line endings.
// utc: true writes DTSTART/DTEND in UTC (CalDAV); false writes floating local time.
// method: null leaves METHOD out, which CalDAV servers require for stored resources.
export function buildEventIcs(slot, { uid, createdAt = Date.now(), method = 'PUBLISH', utc = false } = {}) {
  const time = utc ? utcDateTime : localDateTime;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ReLeet//Review Reminder//EN',
    'CALSCALE:GREGORIAN',
    ...(method ? [`METHOD:${method}`] : []),
    'BEGIN:VEVENT',
    `UID:${escapeText(uid ?? defaultUid(slot))}`,
    `DTSTAMP:${utcDateTime(createdAt ?? Date.now())}`,
    `DTSTART:${time(slot.start)}`,
    `DTEND:${time(slot.end)}`,
    `SUMMARY:${escapeText(slot.title)}`,
    `DESCRIPTION:${escapeText(slot.description)}`,
    ...(slot.url ? [`URL:${uriValue(slot.url)}`] : []),
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE', // shows as busy
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeText(slot.title)}`,
    `TRIGGER:-PT${reminderMinutes(slot.reminderMinutes)}M`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

// The popup's 📅 download for one slot.
export function createReviewInvite(slot, { createdAt = Date.now() } = {}) {
  return {
    contents: buildEventIcs(slot, { uid: defaultUid(slot), createdAt, method: 'PUBLISH', utc: false }),
    filename: `${safeFilename(slot.problemId)}-review.ics`,
  };
}

// A slot for one problem when the schedule has none for it (e.g. it's overdue).
// Same placement rules as the schedule, ignoring other problems. An overdue
// problem is planned as if it were still its due day, so the block sits at the
// start time on that day rather than moving to today.
export function slotForProblem(problem, settings, now = Date.now()) {
  if (!Number.isFinite(problem?.dueAt)) return null;
  const overdue = dayKey(problem.dueAt) < dayKey(now);
  const planNow = overdue ? startOfDay(problem.dueAt) : now;
  const { entries } = planSchedule(null, [problem], settings, planNow);
  return Object.hasOwn(entries, problem.id) ? entries[problem.id] : null;
}
