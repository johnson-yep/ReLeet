// Generates a standard iCalendar event without talking to a calendar provider.
// Importing the downloaded .ics file leaves the final save under the user's
// control and works with Google Calendar, Apple Calendar, Outlook, and others.

const pad = (value) => String(value).padStart(2, '0');

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

function escapeText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function safeFilename(value) {
  return String(value).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'problem';
}

export function createReviewInvite(
  problem,
  { createdAt = Date.now(), hour = 9, minute = 0, durationMinutes = 30 } = {},
) {
  const start = new Date(problem.dueAt);
  start.setHours(hour, minute, 0, 0);
  const end = new Date(start);
  end.setMinutes(end.getMinutes() + durationMinutes);

  const dueDate = `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}`;
  const uid = `${safeFilename(problem.id)}-${dueDate}@releet`;
  const summary = `Review: ${problem.title}`;
  const description = `Review ${problem.title} in ReLeet.\n${problem.url}`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ReLeet//Review Reminder//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${utcDateTime(createdAt)}`,
    `DTSTART:${localDateTime(start.getTime())}`,
    `DTEND:${localDateTime(end.getTime())}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(description)}`,
    `URL:${problem.url}`,
    'STATUS:CONFIRMED',
    'TRANSP:TRANSPARENT',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeText(summary)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return {
    contents: `${lines.join('\r\n')}\r\n`,
    filename: `${safeFilename(problem.id)}-review.ics`,
  };
}
