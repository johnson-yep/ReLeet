import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEventIcs, createReviewInvite, slotForProblem } from '../lib/calendar.js';
import { dayKey, planSchedule } from '../lib/schedule.js';

const MIN = 60_000;
const SETTINGS = Object.freeze({
  startTime: '09:00',
  durations: Object.freeze({ easy: 20, medium: 40, hard: 60 }),
  reminderMinutes: 15,
});
const CREATED_AT = Date.UTC(2026, 10, 4, 15, 4, 5);

const at = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();

function withTimeZone(tz, fn) {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

function makeSlot(overrides = {}) {
  const start = overrides.start ?? at(2026, 11, 5, 9, 0);
  return {
    problemId: 'two-sum',
    day: dayKey(start),
    start,
    end: start + 40 * MIN,
    title: 'Review: Two Sum',
    description: 'Review Two Sum (last rated Medium).\nhttps://leetcode.com/problems/two-sum/\n\nScheduled by ReLeet.',
    url: 'https://leetcode.com/problems/two-sum/',
    rating: 'medium',
    reminderMinutes: 15,
    ...overrides,
  };
}

const problem = (overrides = {}) => ({
  id: 'two-sum',
  title: 'Two Sum',
  url: 'https://leetcode.com/problems/two-sum/',
  rating: 'medium',
  solvedAt: at(2026, 11, 2, 12),
  dueAt: at(2026, 11, 5),
  commitSha: null,
  source: 'leetcode',
  history: [{ at: at(2026, 11, 2, 12), rating: 'medium', commitSha: null }],
  ...overrides,
});

// Physical lines (without the final empty string after the last CRLF).
const physicalLines = (ics) => ics.split('\r\n').slice(0, -1);
const unfold = (ics) => ics.replace(/\r\n[ \t]/g, '');
// Logical content lines after unfolding.
const contentLines = (ics) => physicalLines(unfold(ics));
// Value of the first property with this name (after unfolding), optionally inside a component.
function prop(ics, name, within = null) {
  let lines = contentLines(ics);
  if (within) lines = lines.slice(lines.indexOf(`BEGIN:${within}`), lines.indexOf(`END:${within}`));
  const line = lines.find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
  return line === undefined ? undefined : line.slice(line.indexOf(':') + 1);
}
const unescapeText = (value) => value.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
const octets = (text) => Buffer.byteLength(text, 'utf8');

// Structure and line endings

test('buildEventIcs writes a complete VCALENDAR with CRLF line endings', () => {
  const ics = buildEventIcs(makeSlot(), { uid: 'abc-123@releet', createdAt: CREATED_AT });
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.doesNotMatch(ics, /\r(?!\n)|(?<!\r)\n/, 'only CRLF line breaks');

  const lines = contentLines(ics);
  const names = lines.filter((l) => /^(BEGIN|END):/.test(l));
  assert.deepEqual(names, [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'BEGIN:VALARM',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
  for (const line of [
    'VERSION:2.0',
    'PRODID:-//ReLeet//Review Reminder//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'UID:abc-123@releet',
    'DTSTAMP:20261104T150405Z',
    'SUMMARY:Review: Two Sum',
    'DESCRIPTION:Review Two Sum (last rated Medium).\\nhttps://leetcode.com/problems/two-sum/\\n\\nScheduled by ReLeet.',
    'URL:https://leetcode.com/problems/two-sum/',
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'ACTION:DISPLAY',
    'TRIGGER:-PT15M',
  ]) {
    assert.ok(lines.includes(line), line);
  }
  assert.equal(prop(ics, 'DESCRIPTION', 'VALARM'), 'Review: Two Sum');
  assert.equal(lines.filter((l) => l.startsWith('TRANSP:')).length, 1);
});

test('METHOD is left out when method is null (CalDAV resources)', () => {
  const ics = buildEventIcs(makeSlot(), { uid: 'x', method: null, utc: true, createdAt: CREATED_AT });
  assert.equal(prop(ics, 'METHOD'), undefined);
  assert.doesNotMatch(ics, /METHOD/);
  // Defaults to PUBLISH when not given.
  assert.equal(prop(buildEventIcs(makeSlot(), { uid: 'x' }), 'METHOD'), 'PUBLISH');
  assert.equal(prop(buildEventIcs(makeSlot()), 'METHOD'), 'PUBLISH');
});

// Times

test('utc: true writes UTC times, utc: false writes floating local time', () => {
  const s = makeSlot();
  const utc = buildEventIcs(s, { uid: 'x', utc: true, createdAt: CREATED_AT });
  const iso = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  assert.equal(prop(utc, 'DTSTART'), iso(s.start));
  assert.equal(prop(utc, 'DTEND'), iso(s.end));
  assert.match(prop(utc, 'DTSTART'), /^\d{8}T\d{6}Z$/);

  const floating = buildEventIcs(s, { uid: 'x', createdAt: CREATED_AT });
  assert.equal(prop(floating, 'DTSTART'), '20261105T090000');
  assert.equal(prop(floating, 'DTEND'), '20261105T094000');
  assert.doesNotMatch(floating, /TZID/);
  assert.doesNotMatch(utc, /TZID/);
  // DTSTAMP is always UTC.
  assert.equal(prop(floating, 'DTSTAMP'), '20261104T150405Z');
  assert.equal(prop(utc, 'DTSTAMP'), '20261104T150405Z');
});

test('DTSTAMP defaults to now', () => {
  const before = Date.now();
  const stamp = prop(buildEventIcs(makeSlot(), { uid: 'x' }), 'DTSTAMP');
  const parsed = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(9, 11), +stamp.slice(11, 13), +stamp.slice(13, 15));
  assert.ok(parsed >= before - 1000 && parsed <= Date.now());
});

test('times are right across the US DST change (America/Denver, 2026-11-01)', () => {
  withTimeZone('America/Denver', () => {
    const nov1 = makeSlot({ start: at(2026, 11, 1, 9, 0) }); // 09:00 MST
    assert.equal(prop(buildEventIcs(nov1, { uid: 'x' }), 'DTSTART'), '20261101T090000');
    assert.equal(prop(buildEventIcs(nov1, { uid: 'x' }), 'DTEND'), '20261101T094000');
    assert.equal(prop(buildEventIcs(nov1, { uid: 'x', utc: true }), 'DTSTART'), '20261101T160000Z');
    assert.equal(prop(buildEventIcs(nov1, { uid: 'x', utc: true }), 'DTEND'), '20261101T164000Z');
    const oct31 = makeSlot({ start: at(2026, 10, 31, 9, 0) }); // 09:00 MDT
    assert.equal(prop(buildEventIcs(oct31, { uid: 'x', utc: true }), 'DTSTART'), '20261031T150000Z');
  });
});

test('times are right across the EU DST change (Europe/London, 2026-10-25)', () => {
  withTimeZone('Europe/London', () => {
    const oct25 = makeSlot({ start: at(2026, 10, 25, 9, 0) }); // 09:00 GMT
    assert.equal(prop(buildEventIcs(oct25, { uid: 'x' }), 'DTSTART'), '20261025T090000');
    assert.equal(prop(buildEventIcs(oct25, { uid: 'x', utc: true }), 'DTSTART'), '20261025T090000Z');
    const oct24 = makeSlot({ start: at(2026, 10, 24, 9, 0) }); // 09:00 BST
    assert.equal(prop(buildEventIcs(oct24, { uid: 'x' }), 'DTSTART'), '20261024T090000');
    assert.equal(prop(buildEventIcs(oct24, { uid: 'x', utc: true }), 'DTSTART'), '20261024T080000Z');
  });
});

// Escaping

test('escapes TEXT values per RFC 5545', () => {
  const s = makeSlot({
    title: 'Review: Sum, Product; Back\\slash',
    description: 'one\ntwo\r\nthree\rfour\ttab\u0007bell',
  });
  const ics = buildEventIcs(s, { uid: 'uid,with;chars', createdAt: CREATED_AT });
  assert.equal(prop(ics, 'SUMMARY'), 'Review: Sum\\, Product\\; Back\\\\slash');
  assert.equal(prop(ics, 'DESCRIPTION'), 'one\\ntwo\\nthree\\nfour\ttabbell');
  assert.equal(prop(ics, 'UID'), 'uid\\,with\\;chars');
  assert.equal(prop(ics, 'DESCRIPTION', 'VALARM'), 'Review: Sum\\, Product\\; Back\\\\slash');
  // And it reads back to the original text (minus the control character).
  assert.equal(unescapeText(prop(ics, 'SUMMARY')), s.title);
  assert.equal(unescapeText(prop(ics, 'DESCRIPTION')), 'one\ntwo\nthree\nfour\ttabbell');
});

test('URL is written as a URI, not escaped as text', () => {
  const ics = buildEventIcs(makeSlot({ url: 'https://leetcode.com/problems/a,b;c/?x=1,2' }), { uid: 'x' });
  assert.equal(prop(ics, 'URL'), 'https://leetcode.com/problems/a,b;c/?x=1,2');
  assert.equal(prop(buildEventIcs(makeSlot({ url: '' }), { uid: 'x' }), 'URL'), undefined);
});

test('line breaks in values cannot inject properties or components', () => {
  const ics = buildEventIcs(
    makeSlot({
      title: 'Review: x\r\nEND:VEVENT\r\nBEGIN:VEVENT',
      description: 'd\nATTENDEE:mailto:evil@example.com',
      url: 'https://leetcode.com/problems/x/\r\nX-EVIL:1',
    }),
    { uid: 'u\r\nX-UID:1' },
  );
  const lines = contentLines(ics);
  assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, 1);
  assert.equal(lines.filter((l) => l === 'END:VEVENT').length, 1);
  assert.ok(!lines.some((l) => /^(ATTENDEE|X-EVIL|X-UID)/.test(l)));
  assert.equal(prop(ics, 'URL'), 'https://leetcode.com/problems/x/X-EVIL:1');
  assert.doesNotMatch(ics, /\r(?!\n)|(?<!\r)\n/);
});

// Folding

test('folds long lines to at most 75 octets and unfolds back exactly', () => {
  const title = `Review: ${'Longest Substring Without Repeating Characters '.repeat(6).trim()}`;
  const ics = buildEventIcs(makeSlot({ title }), { uid: 'x' });
  for (const line of physicalLines(ics)) assert.ok(octets(line) <= 75, `${octets(line)}: ${line}`);
  const summary = physicalLines(ics).findIndex((l) => l.startsWith('SUMMARY:'));
  assert.equal(physicalLines(ics)[summary].length, 75); // filled to the limit
  assert.match(physicalLines(ics)[summary + 1], /^ [^ ]/); // continuation: exactly one leading space
  assert.equal(prop(ics, 'SUMMARY'), title);
});

test('a 75-octet line is not folded; a 76-octet line is', () => {
  const prefix = 'SUMMARY:Review: '; // 16 octets
  const fits = buildEventIcs(makeSlot({ title: `Review: ${'a'.repeat(75 - prefix.length)}` }), { uid: 'x' });
  const fitsLine = physicalLines(fits).find((l) => l.startsWith('SUMMARY:'));
  assert.equal(octets(fitsLine), 75);
  assert.ok(!physicalLines(fits)[physicalLines(fits).indexOf(fitsLine) + 1].startsWith(' '));

  const over = buildEventIcs(makeSlot({ title: `Review: ${'a'.repeat(76 - prefix.length)}` }), { uid: 'x' });
  const i = physicalLines(over).findIndex((l) => l.startsWith('SUMMARY:'));
  assert.equal(octets(physicalLines(over)[i]), 75);
  assert.equal(physicalLines(over)[i + 1], ' a');
});

test('folding never splits a multi-byte UTF-8 character (emoji, CJK, accents)', () => {
  const titles = [
    '🧠'.repeat(60), // 4 octets each
    '两数之和'.repeat(25), // 3 octets each
    'é'.repeat(80), // 2 octets each
    '🧑‍💻 Two Sum ✓ 两数之和 — Ünïcödé 🚀 '.repeat(6), // mixed, incl. a ZWJ sequence
  ];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const base of titles) {
    // Shift the text by 0–4 octets so every alignment against the fold point is tried.
    for (let shift = 0; shift < 5; shift++) {
      const title = `Review: ${'a'.repeat(shift)}${base}`;
      const ics = buildEventIcs(makeSlot({ title, description: title }), { uid: 'x', utc: true });
      const lines = physicalLines(ics);
      for (const line of lines) {
        assert.ok(line.isWellFormed(), 'no lone surrogate');
        assert.ok(octets(line) <= 75, `${octets(line)} octets`);
      }
      // Byte-level check: every physical line on its own is valid UTF-8.
      const bytes = Buffer.from(ics, 'utf8');
      let from = 0;
      for (let i = 0; i < bytes.length - 1; i++) {
        if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) {
          assert.doesNotThrow(() => decoder.decode(bytes.subarray(from, i)));
          from = i + 2;
        }
      }
      // Folds only when the next character really wouldn't fit.
      const summaryAt = lines.findIndex((l) => l.startsWith('SUMMARY:'));
      for (let i = summaryAt; lines[i + 1]?.startsWith(' '); i++) {
        const nextChar = [...lines[i + 1].slice(1)][0];
        assert.ok(octets(lines[i]) + octets(nextChar) > 75);
      }
      assert.equal(prop(ics, 'SUMMARY'), title);
      assert.equal(unescapeText(prop(ics, 'DESCRIPTION')), title);
    }
  }
});

test('folding never splits an escape sequence', () => {
  for (const base of [','.repeat(100), ';'.repeat(100), '\\'.repeat(100), 'a,\\;\n'.repeat(40)]) {
    for (let shift = 0; shift < 3; shift++) {
      const title = `Review: ${'a'.repeat(shift)}${base}`;
      const ics = buildEventIcs(makeSlot({ title, description: title }), { uid: 'x' });
      for (const line of physicalLines(ics)) {
        const trailing = /\\*$/.exec(line)[0].length;
        assert.equal(trailing % 2, 0, `line ends inside an escape: ${line}`);
        assert.ok(octets(line) <= 75);
      }
      assert.equal(unescapeText(prop(ics, 'SUMMARY')), title);
      assert.equal(unescapeText(prop(ics, 'DESCRIPTION')), title);
    }
  }
});

// Reminder

test('VALARM trigger follows reminderMinutes', () => {
  const trigger = (reminderMinutes) => prop(buildEventIcs(makeSlot({ reminderMinutes }), { uid: 'x' }), 'TRIGGER', 'VALARM');
  assert.equal(trigger(15), '-PT15M');
  assert.equal(trigger(30), '-PT30M');
  assert.equal(trigger(90), '-PT90M');
  assert.equal(trigger(0), '-PT0M');
  assert.equal(trigger(undefined), '-PT15M');
  assert.equal(trigger(-5), '-PT15M');
});

// UID

test('uses the given uid, or a stable one per problem and day', () => {
  assert.equal(prop(buildEventIcs(makeSlot(), { uid: 'given@releet' }), 'UID'), 'given@releet');
  assert.equal(prop(buildEventIcs(makeSlot()), 'UID'), 'two-sum-20261105@releet');
  assert.equal(prop(buildEventIcs(makeSlot({ problemId: '../x y' })), 'UID'), 'x-y-20261105@releet');
});

// createReviewInvite

test('createReviewInvite returns a floating-time PUBLISH invite with a stable UID', () => {
  const s = makeSlot();
  const { contents, filename } = createReviewInvite(s, { createdAt: CREATED_AT });
  assert.equal(filename, 'two-sum-review.ics');
  assert.equal(contents, buildEventIcs(s, { uid: 'two-sum-20261105@releet', createdAt: CREATED_AT, method: 'PUBLISH', utc: false }));
  assert.equal(prop(contents, 'METHOD'), 'PUBLISH');
  assert.equal(prop(contents, 'DTSTART'), '20261105T090000');
  assert.equal(prop(contents, 'TRANSP'), 'OPAQUE');
  assert.equal(prop(contents, 'TRIGGER', 'VALARM'), '-PT15M');
  // createdAt is optional.
  assert.equal(prop(createReviewInvite(s).contents, 'UID'), 'two-sum-20261105@releet');
});

test('download filenames are safe for any problem id', () => {
  const cases = [
    ['two-sum', 'two-sum-review.ics'],
    ['LRU_Cache', 'LRU_Cache-review.ics'],
    ['../../etc/passwd', 'etc-passwd-review.ics'],
    ['two sum', 'two-sum-review.ics'],
    ['a/b\\c:d*e?f"g<h>i|j', 'a-b-c-d-e-f-g-h-i-j-review.ics'],
    ['🧠', 'problem-review.ics'],
    ['', 'problem-review.ics'],
    [undefined, 'problem-review.ics'],
    ['---', 'problem-review.ics'],
  ];
  for (const [problemId, expected] of cases) {
    assert.equal(createReviewInvite(makeSlot({ problemId })).filename, expected, String(problemId));
  }
  const long = createReviewInvite(makeSlot({ problemId: 'x'.repeat(300) })).filename;
  assert.ok(long.length <= 80 + '-review.ics'.length);
  assert.match(long, /^[A-Za-z0-9_-]+-review\.ics$/);
});

// slotForProblem

test('slotForProblem matches the schedule for an upcoming review', () => {
  const p = problem();
  const now = at(2026, 11, 4, 8);
  const s = slotForProblem(p, SETTINGS, now);
  assert.deepEqual(s, planSchedule(null, [p], SETTINGS, now).entries['two-sum']);
  assert.equal(s.start, at(2026, 11, 5, 9, 0));
  assert.equal(s.end, at(2026, 11, 5, 9, 40));
  assert.equal(s.day, '2026-11-05');
  assert.equal(s.title, 'Review: Two Sum');
  assert.equal(s.description, 'Review Two Sum (last rated Medium).\nhttps://leetcode.com/problems/two-sum/\n\nScheduled by ReLeet.');
  assert.equal(s.reminderMinutes, 15);
});

test('slotForProblem uses the start time, duration and reminder from settings', () => {
  const settings = { startTime: '07:15', durations: { easy: 20, medium: 40, hard: 75 }, reminderMinutes: 5 };
  const s = slotForProblem(problem({ rating: 'hard' }), settings, at(2026, 11, 4, 8));
  assert.equal(s.start, at(2026, 11, 5, 7, 15));
  assert.equal(s.end, at(2026, 11, 5, 8, 30));
  assert.equal(s.reminderMinutes, 5);
  assert.equal(s.rating, 'hard');
});

test('slotForProblem places an overdue review at the start time on its due day', () => {
  const overdue = problem({ dueAt: at(2026, 11, 1) });
  const s = slotForProblem(overdue, SETTINGS, at(2026, 11, 4, 15, 22));
  assert.equal(s.day, '2026-11-01');
  assert.equal(s.start, at(2026, 11, 1, 9, 0));
  assert.equal(s.end, at(2026, 11, 1, 9, 40));
});

test('slotForProblem uses the stored review day, not dueAt in the current zone', () => {
  // Rated in a zone further east: dueAt is the evening before, locally.
  const p = problem({ dueAt: at(2026, 11, 4, 23), dueDay: '2026-11-05' });
  assert.equal(slotForProblem(p, SETTINGS, at(2026, 11, 4, 8)).start, at(2026, 11, 5, 9, 0));
  const overdue = problem({ dueAt: at(2026, 10, 31, 23), dueDay: '2026-11-01' });
  assert.equal(slotForProblem(overdue, SETTINGS, at(2026, 11, 4, 8)).start, at(2026, 11, 1, 9, 0));
});

test('slotForProblem today: never before now, rounded up to 5 minutes', () => {
  const today = problem({ dueAt: at(2026, 11, 4) });
  assert.equal(slotForProblem(today, SETTINGS, at(2026, 11, 4, 8)).start, at(2026, 11, 4, 9, 0));
  assert.equal(slotForProblem(today, SETTINGS, at(2026, 11, 4, 13, 21)).start, at(2026, 11, 4, 13, 25));
});

test('slotForProblem returns null without a due date', () => {
  assert.equal(slotForProblem(problem({ dueAt: undefined }), SETTINGS, at(2026, 11, 4)), null);
  assert.equal(slotForProblem(null, SETTINGS), null);
});

test('slotForProblem across the US DST change (America/Denver)', () => {
  withTimeZone('America/Denver', () => {
    const s = slotForProblem(problem({ dueAt: at(2026, 11, 1) }), SETTINGS, at(2026, 11, 4, 12));
    assert.equal(s.start, Date.UTC(2026, 10, 1, 16, 0)); // 09:00 MST, overdue on its due day
    const ics = createReviewInvite(s, { createdAt: CREATED_AT }).contents;
    assert.equal(prop(ics, 'DTSTART'), '20261101T090000');
    assert.equal(prop(ics, 'UID'), 'two-sum-20261101@releet');
  });
});

test('a planned slot round-trips through the ICS text', () => {
  const p = problem({ title: 'Two Sum, II; “Input Array Is Sorted” 🧠', url: 'https://leetcode.com/problems/two-sum-ii-input-array-is-sorted/' });
  const s = slotForProblem(p, SETTINGS, at(2026, 11, 4, 8));
  for (const options of [{ uid: 'u', utc: true, method: null }, { uid: 'u' }]) {
    const ics = buildEventIcs(s, options);
    assert.equal(unescapeText(prop(ics, 'SUMMARY')), s.title);
    assert.equal(unescapeText(prop(ics, 'DESCRIPTION')), s.description);
    assert.equal(prop(ics, 'URL'), s.url);
  }
});
