# ReLeet

ReLeet is a Chrome extension for spaced repetition of LeetCode problems. When a submission on leetcode.com is
accepted, ReLeet asks how hard it felt and books time to review the problem again: a day later if it was hard,
months later once it's easy. It can put those reviews in Google Calendar or Apple Calendar.

## What it does

- **Notices your solves.** Right after an accepted submission, a small prompt on leetcode.com asks
  **How hard did it feel?** with **Easy**, **Okay** and **Hard**. Every 15 minutes ReLeet also checks your recent
  accepted submissions, which catches solves made on another device.
- **Spaces your reviews.** Each rating sets the next review day (see [How reviews are scheduled](#how-reviews-are-scheduled)).
- **Keeps each day manageable.** A daily limit (60 minutes by default) caps the review time ReLeet books on any
  day. Reviews that don't fit move to the next day with room.
- **Books the time.** With a calendar connected, every review is a block in a calendar named "ReLeet", with a
  reminder 15 minutes before. Without one, the popup still shows what's due and can download a review as an
  `.ics` file.
- **Tells you once a day.** At your start time, one notification says how many reviews are due.
- **Lets you retire a problem.** Mark a problem **Mastered** and it gets no more reviews. Its history stays, and
  **Resume** brings it back.

Ratings, Mastered and Stop tracking can be undone for about 10 seconds, in the popup and on leetcode.com.

## Your data stays in this browser

ReLeet has no server and no analytics. Your problems, ratings and settings live in this browser's extension
storage. ReLeet talks to:

- leetcode.com, to notice your solves and look up problem titles;
- Google Calendar or iCloud, only if you connect them. Each review event carries the problem's name and link.

The Apple app-specific password is stored encrypted (AES-GCM, with a key that can't be read out of the browser).
Google sign-in goes through Chrome, so ReLeet never sees your Google password. The content script on leetcode.com
can't read extension storage, and can only send the worker five kinds of messages: who is signed in, an accepted
solve, a rating, Mastered, and Undo.

## Install from source

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. After editing code, click the reload icon on the ReLeet card.

The welcome page opens on install. It walks you through signing in to LeetCode, importing your recent solves,
connecting a calendar and choosing when reviews start.

## How reviews are scheduled

A problem's first solve sets its first interval. Each review after that grows or resets it:

| Rating | First solve | Each review after that |
| --- | --- | --- |
| Easy | 7 days | the last interval × 2.5 |
| Okay | 3 days | the last interval × 1.5 |
| Hard | 1 day | back to 1 day |

Intervals are rounded to whole days and stop at 180 days. When a rating reaches 180, ReLeet offers to mark the
problem mastered. Each rating button shows the interval it would give that problem, for example **Easy · 18d**.
Every rating is kept in the problem's history.

Review days are dates, so travelling to another time zone doesn't move a review to the day before or after.

### Blocks and the daily limit

Each review gets a block on its review day, starting at your start time (09:00 by default, weekends included).
A block lasts 20, 40 or 60 minutes for a problem last rated Easy, Okay or Hard. Reviews on the same day follow
each other. Today's blocks never start before the current time.

Reviews claim room in this order: overdue reviews first, the longest overdue first, then the day's own reviews.
A review whose block doesn't fit under the daily limit moves to the next day with room, and its review day moves
with it, so the popup, the badge, the daily summary and your calendar always agree. A day always takes at least
one review, even one longer than the limit.

A missed review is booked again, first in line on the next day with room. Its old block stays on the calendar as
history. Changing the start time, block lengths or daily limit moves upcoming blocks; blocks that already started
stay where they are.

## How solves are detected

ReLeet uses leetcode.com only (not leetcode.cn), and only accepted submissions count.

- **In this browser.** The content script watches for Submit (the button, Ctrl+Enter or Cmd+Enter, or an
  "Accepted" result appearing). Those are only hints: it then asks LeetCode's own API for a new accepted
  submission of that problem, about 2, 4, 7, 11, 16, 25, 40 and 60 seconds later, and stops at the first match.
- **In the background.** Every 15 minutes while Chrome runs, and when you open the popup, the worker reads your
  public recent accepted submissions.

ReLeet picks up your username when you visit leetcode.com signed in. You can type it in Settings instead; a typed
username is never replaced. The first check for a username only notes what's already there. **Import recent
solves** queues your most recent accepted problems that ReLeet doesn't track yet. Several accepted submissions of
one problem on the same day count once. Solving a tracked problem again counts as a review of it; solving a
mastered problem changes nothing.

The prompt never takes keyboard focus. Press **Alt+Shift+R** (**Option+Shift+R** on a Mac) to move focus to it,
then Tab and Enter to rate, or Escape for **Later**. Solves you leave unrated wait under **To rate** in the popup.

## Calendars

Connect Google Calendar, Apple Calendar or both in Settings. Each connected account gets its own calendar named
"ReLeet", created by the extension, with the same events: `Review: <problem>`, the problem's link, shown as busy,
with a reminder.

- Rating a problem moves its block. Stopping tracking or marking it mastered deletes its upcoming block.
- Disconnecting deletes the ReLeet calendar from that account, after asking. If that fails (offline, or the
  sign-in expired), you can disconnect anyway; ReLeet remembers the calendar without any sign-in, so connecting
  again later picks it up instead of filling it twice.
- A failed update retries every 15 minutes and on the next change. When a calendar needs you to sign in again,
  the popup shows **Reconnect**.

Google Calendar signs in with the Google account Chrome is signed in to, and works in Google Chrome only
(see [ADR 0002](docs/adr/0002-google-sign-in-through-chrome.md)). Apple Calendar uses an app-specific password and
asks for permission to reach iCloud when you connect it.

## One main computer

Chrome Sync installs ReLeet on every computer where you're signed in to Chrome, but your problems live on the
computer where you use it. ReLeet is active on one main computer; copies elsewhere stay idle and offer
**Use this computer instead** (see [ADR 0001](docs/adr/0001-one-main-computer.md)). To move, use
**Settings → This computer → Export my data**, then **Import** on the other computer and connect your calendars
there again. The export file holds no passwords or sign-ins. On a computer that isn't the main one, **Disconnect** and **Delete all
my ReLeet data** leave a ReLeet calendar the main computer may use in your account; they delete only one the main
computer has replaced with its own.

## Limitations

- LeetCode lists only your 20 most recent accepted submissions. If you solve more than 20 problems while Chrome is
  closed, ReLeet misses the older ones.
- Google Calendar works in Google Chrome only, not in Edge, Brave or Opera.
- There is no sync between computers, only Export and Import.

## For contributors

ReLeet is a Manifest V3 extension in plain JavaScript modules, with no build step and no runtime dependencies.
[CONTEXT.md](CONTEXT.md) defines the words the code and the UI use. [docs/adr/](docs/adr/) records the decisions.

| Path | Role |
| --- | --- |
| `lib/srs.js` | Ratings and intervals. Pure JS, no `chrome.*`. |
| `lib/schedule.js` | Plans every review's day and block under the daily limit, and diffs the plan against calendar events. Pure JS. |
| `lib/views.js` | What the popup shows (sections, statuses, streak). Pure JS. |
| `lib/format.js` | Shared wording for dates, statuses and ratings. Pure JS. |
| `lib/actions.js` | Rate, master, resume, stop tracking and add by hand, each with an undo. |
| `lib/storage.js` | `chrome.storage.local` wrapper. The keys are listed at the top of the file. |
| `lib/migrate.js` | Brings data saved by older versions up to date, after an update. |
| `lib/computer.js` | Which computer is the main one. |
| `lib/transfer.js` | Export and Import. Pure JS. |
| `lib/secret-box.js` | Encrypts the Apple app-specific password. |
| `lib/leetcode.js`, `lib/leetcode-sync.js` | LeetCode client, background checks, reports from the page, Import recent. |
| `lib/calendar-sync.js`, `lib/calendars/` | Keeps every connected calendar in line with the plan (worker only); Google and iCloud providers. |
| `lib/calendar.js` | Builds `.ics` events, for the download and for iCloud. |
| `lib/ui.css` | Colours, buttons and fields shared by the popup, Settings and the welcome page. |
| `background.js` | Service worker: alarms, messages, notifications, badge, idle on other computers. |
| `content/leetcode.js` | Content script on leetcode.com: spots accepted solves and shows the prompt. |
| `popup/`, `options/`, `welcome/` | The popup, Settings (with the calendar cards both pages share) and the welcome page. |

### Tests

Node 22 or newer.

```bash
npm test
```

`npm test` runs every `test/*.test.js` with Node's built-in runner. It needs no install and no network:
`fetch` and `chrome.*` are faked (see `test/helpers/fake-chrome.js`).

```bash
npm install && npx playwright install chromium
```

```bash
npm run test:browser
```

`npm run test:browser` runs the in-page prompt tests, then a smoke test that loads the unpacked extension in
Chromium with a fake leetcode.com. Screenshots go to `test/browser/out/`; run `DARK=1 node test/browser/smoke.cjs`
for dark mode. Look at them after UI changes.

Service worker logs are on `chrome://extensions` under ReLeet, **service worker**.

### Releasing

```bash
npm run package
```

`npm run package` writes `dist/releet-<version>.zip` for the Chrome Web Store, without tests, docs or any `"key"`
line, and warns if the Google client ID is still the placeholder. [PUBLISHING.md](PUBLISHING.md) walks through
the store listing, the Google Cloud setup and Google's verification.

To change the icon, replace `art/releet-icon-1024.png` and run `python3 scripts/make-icons.py` (needs Pillow).
