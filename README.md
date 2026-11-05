# ReLeet

A Chrome extension (Manifest V3, vanilla JS, no build step) for spaced repetition of LeetCode problems.
It notices when a LeetCode submission is Accepted, asks how hard it felt, schedules the next review,
and can put a review block for it in Google Calendar, Outlook / Microsoft 365 or Apple iCloud Calendar.

## Load it

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → select this folder.
3. After editing code, click the reload icon on the extension card.

Detection, ratings, the popup and the `.ics` download work right away. Chrome only adds content scripts to
pages loaded after an install or update, so ReLeet adds its script to leetcode.com tabs that are already open
when it's installed, updated or reloaded (a tab Chrome put to sleep gets it when it reloads). Google and
Outlook calendars need a one-time setup (your own client IDs); Apple needs an app-specific password. See
[SETUP.md](SETUP.md). To share your copy or use it on a second computer, pin its ID first (SETUP.md, step 1).

## Layout

| Path | Role |
| --- | --- |
| `lib/srs.js` | Review intervals. Pure JS, no `chrome.*` (reusable elsewhere). |
| `lib/problem.js` | Parse titles / slugs / URLs into problem ids. Pure JS. |
| `lib/schedule.js` | Plans the calendar block for every upcoming review, and diffs the plan against existing events. Pure JS. |
| `lib/calendar.js` | Builds `.ics` events: the popup's 📅 download and iCloud's CalDAV events. Pure JS. |
| `lib/leetcode.js` | LeetCode GraphQL client (fetch only, public data, no cookies). |
| `lib/leetcode-sync.js` | Worker side of detection: background checks, page reports, username auto-detect, "Import recent". |
| `lib/calendars/google.js` | Google Calendar API v3 provider + `chrome.identity` sign-in. |
| `lib/calendars/outlook.js` | Microsoft Graph provider + sign-in (auth code with PKCE through `launchWebAuthFlow`). |
| `lib/calendars/apple.js` | iCloud CalDAV provider (Basic auth with an app-specific password, small multistatus parser). |
| `lib/calendars/errors.js` | `CalendarError` and its flags (reconnect, calendar missing, event not found). |
| `lib/calendar-sync.js` | Keeps every connected calendar in line with the plan. Worker only. |
| `lib/rating.js` | Rating a detected solve (popup and in-page prompt). |
| `lib/storage.js` | `chrome.storage.local` wrapper (keys are listed at the top of the file). |
| `lib/config.js` | Values filled in during setup (the Microsoft client ID). |
| `background.js` | Service worker: alarms, LeetCode checks, calendar sync, messages, notifications, badge. |
| `content/leetcode.js` | Content script on leetcode.com: spots Accepted submissions and shows the rating prompt. |
| `popup/` | Popup: rate new submissions, due today, upcoming, manual add, LeetCode / calendar status. |
| `options/` | Settings: LeetCode username, calendars, schedule, test notification. |

## How detection works

ReLeet only uses LeetCode (leetcode.com, not leetcode.cn), and only **Accepted** submissions count.

- **Instantly, in this browser.** The content script on leetcode.com watches for Submit (the button,
  Ctrl/Cmd+Enter, or an "Accepted" result appearing). The page's look can change, so those are only triggers:
  it then asks LeetCode's own API (`recentAcSubmissionList`, same-origin, as you) for a new accepted
  submission of that problem, at about 2, 4, 7, 11, 16, 25, 40 and 60 seconds, and stops at the first match.
- **Every 15 minutes, in the background** (while Chrome runs), the worker reads your public recent accepted
  submissions. That catches solves on other devices. It also checks when you open the popup, unless a check
  ran in the last minute.

The **username** is picked up automatically when you're signed in on leetcode.com. You can type it in
Settings instead; a typed username is never replaced by auto-detection.

The **first check** for a username only notes what's already there, so past solves aren't queued.
**Import recent** (Settings) queues your most recent accepted problems (LeetCode returns about 20) that
aren't tracked yet. It also queues anything a background check would have (such as a review solved on
another device since the last check).

Several accepted submissions of one problem on the same day count once. Solving a problem you already
track counts as a review of it.

## Rating

Right after an Accepted submission, a small prompt on leetcode.com asks how hard it felt:
**Easy · 7d**, **Medium · 3d**, **Hard · 1d**, or **Later**. The prompt never takes keyboard focus, so you can
keep typing in the editor; press **Alt+Shift+R** (**Option+Shift+R** on a Mac) to move focus to it, then
Tab / Enter to rate or Escape for Later. Ignored or "Later" solves, and solves found by
the background check, wait under **Rate new submissions** in the popup. Solves found in the background also
raise a system notification (clicking it opens the popup, or the same list in a tab when Chrome can't show
the popup); solves on this page don't, the prompt is enough.
A solve from the last couple of minutes on a problem that's open in a tab is left to that tab's prompt too.

Problems tracked before v0.3 (including ones detected from NeetCode) stay as they are.

## Scheduling

Easy → 7 days, Medium → 3 days, Hard → 1 day. Review dates are whole days: a problem becomes due at local
midnight of its review date. The date is kept as a date, so travelling to another time zone doesn't move a
review to the day before or after. Rating a due problem in the popup (E / M / H) counts as a review and
reschedules it.

Each upcoming review also gets a planned **block**, shown in the popup (e.g. "due tomorrow · 9:00 AM"):

- on the review day, starting at a fixed time (default 09:00 local, every day including weekends);
- lasting by the last rating: Easy 20, Medium 40, Hard 60 minutes;
- several reviews on one day are placed back to back; today's never start in the past;
- a reminder pops up 15 minutes before.

Start time and lengths are in Settings → Schedule. Changing them moves upcoming blocks; blocks that already
started stay put. If no calendar holds today's block yet when one is connected (or starts working again)
after its time has passed, today's review is booked from the current time instead.

## Calendars

Connect any combination of **Google Calendar**, **Outlook / Microsoft 365** and **Apple iCloud** in Settings.
Each connected account gets its own calendar named **ReLeet**, created by the extension, and every connected
calendar gets the same events: title `Review: <problem>`, the problem link in the description, shown as busy,
with the reminder.

- Connecting adds events for all upcoming reviews. If the account already has a ReLeet calendar from an
  earlier connection (Outlook and iCloud find it by name), its upcoming ReLeet events are replaced rather
  than added a second time; past ones stay as history.
- Re-rating or re-solving a problem moves its event; deleting the problem deletes it.
- Completing a review leaves the old event as history and adds the next one. A missed review's event stays
  in the past; the popup shows the problem as overdue.
- Disconnecting deletes the ReLeet calendar from that account (after asking). If that fails because sign-in
  expired, Reconnect first and then Disconnect. Otherwise (e.g. offline) you can disconnect anyway and delete
  the calendar yourself; ReLeet remembers it (without any sign-in), so connecting again later picks it up
  instead of filling it twice.
- If you delete the ReLeet calendar in the calendar app instead, the next sync makes a new one with all
  upcoming reviews. In Outlook that includes a calendar sitting in Deleted Items, which nobody sees. To stop
  syncing, Disconnect.
- If an update fails (offline, expired sign-in), it's retried every 15 minutes and on the next change. When
  sign-in is needed, the popup shows a **Reconnect** link.

The service worker is the only thing that writes calendar state. Each event it creates, moves or deletes is
saved straight away, so a worker stopped mid-sync carries on next time without duplicates. When a create's
answer never arrived (a timeout, or the worker stopped), the next sync looks for ReLeet events the calendar
has but ReLeet doesn't know about and deletes them before creating anything. A calendar that was failing
while a block moved catches up when it works again, even if the old time has passed.

Without a connected calendar, click 📅 beside a problem to download a standard `.ics` file for its next block
and import it into any calendar app yourself. Later changes in ReLeet don't update an imported file.

### What is stored and sent where

Everything stays in this browser's `chrome.storage.local`. Microsoft tokens and the Apple app-specific
password are stored there **unencrypted**. The worker limits that storage to ReLeet's own pages and itself
(`setAccessLevel('TRUSTED_CONTEXTS')`), so the content script on leetcode.com can't read it; it only sends
the worker messages, and only of three kinds (signed-in user, accepted solve, rating). Requests go only to
leetcode.com, Google's, Microsoft's and Apple's calendar and sign-in endpoints.

## Testing

```
npm test
```

Runs every `test/*.test.js` with Node's built-in runner (Node 22+, no dependencies, no network: `fetch` and
`chrome.*` are faked, see `test/helpers/fake-chrome.js`).

To test notifications, use Settings → **Notifications** → **Send a test notification**. It shows the
reminder for the review due soonest (clicking it opens the problem) without changing its due date or
calendar block.
Service worker logs: `chrome://extensions` → ReLeet → "service worker".
