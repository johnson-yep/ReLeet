# ReLeet

A Chrome extension (Manifest V3, vanilla JS) for spaced repetition of LeetCode / NeetCode problems.

## Load it

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → select this folder.
3. After editing code, click the reload icon on the extension card.

## Layout

| Path | Role |
| --- | --- |
| `lib/srs.js` | Scheduling logic. Pure JS, no `chrome.*` (reusable elsewhere). |
| `lib/problem.js` | Parse titles / slugs / URLs into problem ids. Pure JS. |
| `lib/calendar.js` | Generate user-approved `.ics` review invites. Pure JS. |
| `lib/github.js` | GitHub REST client (fetch only, public repos, no auth). |
| `lib/storage.js` | `chrome.storage.local` wrapper. |
| `lib/github-sync.js` | Detects new submissions since the last processed commit. |
| `background.js` | Service worker: alarms, sync, notifications, badge. |
| `content/neetcode.js` | Content script on neetcode.io problem pages: tells the worker when you hit Submit. |
| `popup/` | Popup UI: rate new submissions, due today, upcoming, manual add. |
| `options/` | Settings: GitHub repo, sync now, import existing problems. |

## Scheduling (V1)

Easy → 7 days, Medium → 3 days, Hard → 1 day. Review dates are whole days: a problem
becomes due at local midnight of its review date. Rating a due problem in the popup
(E / M / H) counts as a review and reschedules it.

## Calendar invites

Click 📅 beside a tracked problem to download a standard `.ics` calendar invite for its next review.
The invite schedules a 30-minute review at 9:00 AM local time with a reminder 15 minutes beforehand.
Open the file in Google Calendar, Apple Calendar, Outlook, or another calendar app and approve it there.
ReLeet does not receive access to the calendar, and later rescheduling in ReLeet does not modify an
invite that was already imported.

## GitHub sync

1. Open the extension's **Settings** (popup footer, or right-click the icon → Options).
2. Enter the public repo NeetCode pushes to (`owner/repo` or its URL) and save.
3. The first sync records the latest commit as a baseline. Each sync
   compares from the last processed commit (`sync.lastSha`) to the branch head, reads each
   new commit's changed files, and queues paths matching
   `<Topic>/<problem-slug>/submission-<n>.<ext>` under **Rate new submissions** in the popup.
4. Rating a submission starts tracking the problem, or counts as a review if it's already tracked.
   Its solve date is the commit date.

**Import existing problems** (Settings) queues every problem already in the repo for rating.

**How often it checks:** right after you submit on NeetCode. A content script on
`neetcode.io/problems/*` sees the Submit click (or Ctrl/Cmd+Enter) and the worker syncs about 8 seconds later,
then again at 30 s, 1, 2 and 5 minutes. It stops as soon as a new commit is found. As a fallback
for submissions made elsewhere (another browser or device), it also polls every 15 minutes without a token
and every minute with one, and syncs when the popup opens (unless a sync ran in the last 30 seconds).
A sync is 1 request plus 1 per new commit, capped at 20 commits per sync. Unauthenticated requests are limited to
60/hour, and conditional (ETag/304) requests still count against that. An optional fine-grained token
(Settings → "Faster updates"; public repos read-only, no permissions) raises it to 5,000/hour.
True push updates would need a webhook receiver, which means a server, so they aren't supported.

Note: GitHub-detected problems use NeetCode slugs (e.g. `two-integer-sum`), which can differ
from LeetCode slugs (`two-sum`) used when adding by LeetCode URL. They are tracked separately.

## Testing notifications

On an upcoming problem, click ⏰ to make it due now. A notification should appear
within a few seconds; clicking it opens the problem.
Service worker logs: `chrome://extensions` → ReLeet → "service worker".
