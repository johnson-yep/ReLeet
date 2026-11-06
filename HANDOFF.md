# Handoff: get ReLeet 1.0 ready for the Chrome Web Store

**For:** a new Claude Code session on the owner's own computer.
**Branch:** this file lives on `claude/busy-volta-aao2k3`, 6 commits ahead of `main` (glossary, decision records,
browser tests and this file). Start from it: `git fetch && git checkout claude/busy-volta-aao2k3`, then create your
own working branch (e.g. `release-1.0`).
**When everything below is done:** delete this file.

Every decision below was agreed with the owner in a question-by-question review. **Don't reopen them.** If something
turns out to be impossible, stop and ask the owner. The owner prefers short, plain-language explanations.

## Read first

1. `CONTEXT.md`: the glossary. Use its terms in code, comments and UI copy: *Problem, Solve, Pending solve,
   Rating (Easy/Okay/Hard), Difficulty, Review, Review day, Interval, Mastered, Overdue, Streak, In-page prompt,
   Background check, Baseline, Block, ReLeet calendar, Connected calendar, Start time, Daily limit, Daily summary,
   Main computer, Export*.
2. `docs/adr/`: 0001 one main computer, 0002 Google sign-in through Chrome, 0003 no Outlook.
3. `README.md`: how the extension works today (v0.3.0).

## Where the code is today (v0.3.0)

Manifest V3 extension: vanilla JS ES modules, no build step, no runtime dependencies.

| Area | Files |
|---|---|
| Scheduling (pure) | `lib/srs.js` (fixed intervals 7/3/1, review days), `lib/schedule.js` (`planSchedule` places blocks, `diffEvents`) |
| Calendar sync | `lib/calendar-sync.js` (orchestrator, connect/disconnect, stray cleanup), `lib/calendars/{google,apple,outlook}.js`, `lib/calendar.js` (.ics) |
| LeetCode detection | `content/leetcode.js` (in-page prompt, classic script), `lib/leetcode.js` (GraphQL client), `lib/leetcode-sync.js` (background check) |
| Storage | `lib/storage.js` (keys: problems, pending, settings, leetcode, schedule, calendars; `withStorageLock` via Web Locks), `lib/rating.js` |
| Worker | `background.js` (alarms, messages: content scripts may only send `leetcode-user`, `leetcode-accepted`, `rate-pending`) |
| UI | `popup/`, `options/` |

Tests (Node 22+):
- `npm test`: 309 unit tests, no install needed.
- `npm run test:browser`: the in-page prompt tests plus a full smoke test that loads the unpacked extension in
  Chromium with a fake leetcode.com. First run `npm install` and then `npx playwright install chromium`.
  Screenshots go to `test/browser/out/`. Look at them after UI changes.

Keep all tests green, and add tests for every new piece of logic. Update `test/browser/smoke.cjs` when UI text or
flows change.

## What to build (agreed decisions)

### 1. Remove Outlook entirely
Delete `lib/calendars/outlook.js`, `test/outlook.test.js`, `OUTLOOK_CLIENT_ID` in `lib/config.js`, the Outlook card
and wiring, `launchWebAuthFlow` use, and the hosts `login.microsoftonline.com` and `graph.microsoft.com` in
`manifest.json`. On update, drop any stored `calendars.outlook` state. See ADR 0003.

### 2. Ratings: Easy / Okay / Hard
- Rename Medium to **Okay** everywhere users see it: popup, in-page prompt, Settings, notifications, README. The
  question stays "How hard did it feel?".
- Rename the stored value `medium` to `okay` too, with a one-time migration on update. The data is small.

### 3. Intervals that grow (simple rule, not FSRS)
- **First solve:** Easy 7 days, Okay 3, Hard 1.
- **Each review after that:** Easy → previous interval × 2.5, Okay → × 1.5, Hard → back to 1 day. Round to whole
  days.
- **Maximum interval 180 days.** When a rating would hit the cap, ReLeet suggests **Mastered** (in the prompt's and
  the popup's confirmation).
- Store each problem's current interval. For existing problems that don't have one, derive it from the gap
  between their last rating and their current review day.
- Keep the full history on every problem: a later switch to FSRS will run on it.
- **Existing problems keep their current review days.** Growth starts at their next review.

### 4. Mastered
- Mark it from a popup row (in the ⋯ menu) or with a small "Mastered — stop reviewing" link in the in-page prompt.
- Mastered problems keep their history but get no review days, blocks or notifications. If a mastered problem
  still has an upcoming block, delete the block.
- The popup has a collapsed "▸ Mastered (n)" list, with **Resume** on each problem. Resume gives the problem a
  review day of today plus its last interval, capped at 180.
- **Solving a mastered problem again on LeetCode is ignored**: no prompt and no pending solve.

### 5. Daily limit (default 60 minutes, editable)
- A review's block length is still set by its current rating: Easy 20, Okay 40, Hard 60 minutes, editable.
- Reviews whose blocks don't fit within a day's limit **move to the next day with room**. Their **review day itself
  moves**, so the popup, badge, daily summary and calendar always agree.
- Fill order on a day: overdue reviews first (oldest first), then that day's reviews in the existing stable order.
- A day always gets at least one review, even if that one alone exceeds the limit.
- **Missed reviews are re-booked automatically, first in line on the next day with room.** This reverses the old
  "a missed block stays in the past" rule. The old block that already started stays on the calendar as history,
  and a new block is created.
- Today's blocks never start before now (rounded up to 5 minutes), as today.
- With no calendar connected, the same rules still decide review days.

### 6. Daily summary instead of per-problem notifications
- Replace the midnight burst of one notification per due problem (`checkDue` in `background.js`) with **one
  notification at the start time**: "5 reviews due today". It counts overdue reviews re-booked to today.
- Send it at most once per day, and not at all when nothing is due. Clicking it opens the popup, as now.
- Add a Settings switch "Daily summary", on by default, plus the existing "Send a test notification" button.
- Keep the separate "New submission detected" notification for solves found by the background check.

### 7. One main computer, plus Export / Import (ADR 0001)
- Chrome Sync installs ReLeet on every computer where the user is signed in to Chrome, but its data lives in
  `chrome.storage.local`. Only one computer may be active.
- Each install has a local random id. The main computer's id goes in `chrome.storage.sync` (key e.g.
  `mainComputer`). The first install to finish the welcome page or rate something claims it.
- **On other computers:**
  - No background check, no calendar sync, no in-page prompt, no daily summary.
  - The popup shows only an idle card: "ReLeet is active on another computer. Reviews and calendar updates happen
    there." [Use this computer instead], with a confirmation step.
  - Switching makes this computer the main one. The old one notices through `storage.sync.onChanged`, or on its
    next start, and goes idle. It keeps its data so it can still export.
- **Export:** one JSON file with problems (with history), pending solves, settings, LeetCode state (username,
  baseline, seen ids), and each calendar's calendar id and event map. **No sign-ins:** no tokens and no Apple
  password.
- **Import:** merge, keeping the copy of each problem with the more recent history entry. Imported settings
  replace local ones.
  - After an import, the user reconnects calendars. Connect must reuse the imported calendar id and event map
    (`connectCalendar` already keeps events when the id matches).
  - Google's `calendar.app.created` scope can read calendars the same app created, so the new computer keeps
    using the same Google ReLeet calendar instead of creating a duplicate.
- Without Chrome Sync, `storage.sync` behaves like local storage and each copy thinks it's the main one. This is
  accepted and documented in ADR 0001.

### 8. Welcome page on install
- Open `welcome/welcome.html` on `onInstalled` with reason `install`, not on updates.
- **Intro:** one sentence on what ReLeet does, plus a picture of the in-page prompt.
- **Steps:**
  1. "Sign in to LeetCode". An [Open LeetCode] button, then "Signed in as @alice ✓" once the username is detected
     (watch storage).
  2. "Import your recent solves (up to 20)".
  3. Optional: "Connect a calendar" (Google, Apple) or Skip.
  4. Start time and daily limit.
- **Finish:** [Done, go to LeetCode]. Say that everything stays in this browser. Finishing claims the main computer.

### 9. Popup redesign
```
ReLeet                                   ⚙
40 tracked · 9 due today · 12 mastered · 4-day streak
[! Google Calendar needs you to sign in again.  Reconnect]
TO RATE (1)
 Word Break                  solved 10 min ago  ⋯
 [ Easy · 7d ]  [ Okay · 3d ]  [ Hard · 1d ]
DUE TODAY (3 · 80 min)
 Two Sum                       9 days overdue   ⋯
 [ Easy · 18d ] [ Okay · 7d ] [ Hard · 1d ]
 3Sum                           Today · 9:40 AM ⋯
UPCOMING
 Tomorrow · 3 reviews · 100 min
   Coin Change                         9:00 AM  ⋯
 Thu, Nov 12 · 1 review
   …                                Show all (31)
▸ Mastered (12)
+ Add a problem
@alice · checked 4 min ago · Check now
```
- **Stats line:** tracked counts only problems that aren't mastered. Hide the streak at 0. Streak = consecutive
  local days with at least one rating (solve or review). Today doesn't break the streak until the day is over.
- **Rating buttons on Due today and To rate rows:** always visible, with words, and showing each problem's real
  next interval (computed per problem).
- **Rows:** title (opens the problem; ellipsis plus full title on hover), one short status ("9 days overdue",
  "Today · 9:40 AM", "Tomorrow · 9:00 AM", "Thu, Nov 12"), and a ⋯ menu with Mark mastered, Add to calendar (.ics,
  only when no calendar is connected) and Stop tracking. The solved date and review count go in the tooltip.
- **Upcoming:** grouped by day with review count and minutes, showing the next 7 days, then "Show all (n)".
- **Undo:** about 10 seconds after a rating, Mastered or Stop tracking, in the popup and the in-page prompt. Remove
  the `confirm()` dialogs for these. The in-page prompt's undo needs a new message type (worker keeps the previous
  state briefly, e.g. in `chrome.storage.session`). Add it to the content-script whitelist in `background.js`, along
  with the Mastered one.
- "+ Add a problem" is collapsed by default. Fetch the real title from LeetCode when a link or slug is added, so
  `lru-cache` becomes "LRU Cache" (the `question(titleSlug)` GraphQL query).
- **Header:** a ⚙ gear opens Settings.
- **Empty state (new user):** one card, "Solve a problem on LeetCode and ReLeet will ask how it felt.", with [Open
  LeetCode] and [Import recent solves].
- **Badge:** due today (including overdue) plus solves waiting to be rated, each problem counted once.

### 10. In-page prompt
```
ReLeet                          Alt+Shift+R
✓ Accepted: Two Sum
How hard did it feel?
[ Easy · 18d ] [ Okay · 7d ] [ Hard · 1d ]
Mastered — stop reviewing             Later
```
- The worker's `leetcode-accepted` response must include each button's next interval.
- After rating, show "**Saved: Okay.** Next review Mon, Nov 9 at 9:00 AM. **Undo**", with the bold parts as
  marked. Today "Saved" is grey and the date is bold, which is the wrong way round.
- Give it a visible focus ring after Alt+Shift+R. None showed in headless Chromium; check in real Chrome.
- Keep the no-focus-stealing behaviour.

### 11. Settings
- **Changes save automatically,** with a small "Saved" note and inline validation. No Save buttons.
- **Sections, in order:**
  1. **LeetCode**: username (auto-detected or typed), last check, Check now, Import recent.
  2. **Schedule**: start time, daily limit, block length for Easy / Okay / Hard, and the reminder shown as plain
     text "15 minutes before" (not field-like).
  3. **Calendars**: Google and Apple cards.
  4. **Notifications**: Daily summary on/off, test button.
  5. **This computer**: main-computer status, Export, Import.
  6. **Privacy & data**: what's stored where, in plain words, and **Delete all my ReLeet data**. That deletes the
     ReLeet calendars from connected accounts, then clears `storage.local` and the main-computer claim. Keep a
     confirm dialog here: it can't be undone.
- **Plain language:** no "SETUP.md", "CalDAV", "chrome://…" or "Last error: none". Use bigger section headings,
  and make disabled buttons look disabled in dark mode.

### 12. Calendars
- **Google** (ADR 0002, keep `chrome.identity.getAuthToken`):
  - Hide the Google card when `oauth2.client_id` is still the placeholder.
  - In browsers without working `getAuthToken` (Edge, Brave, Opera), show "Google Calendar needs Google Chrome.
    Use Apple Calendar here.".
  - Fix the stuck "Connecting… / Waiting for Google sign-in" state when the user closes Chrome's sign-in window:
    add a Cancel button and handle "The user did not approve access.".
  - Replace "chrome://settings/people" with "the Google account Chrome is signed in to".
  - Show a clear message when Google refuses sign-ins (the unverified app's 100-user cap, access_denied).
- **Apple:**
  - **Encrypt the app-specific password at rest.** The Chrome Web Store user-data FAQ requires strong encryption
    for credentials. Use AES-GCM with a non-extractable `CryptoKey` kept in IndexedDB, and migrate any plaintext
    password.
  - Move `https://*.icloud.com/*` to `optional_host_permissions`. Request it in the Settings or welcome-page click
    handler (user gesture) right before connecting Apple, and handle a refusal.
- Keep `https://leetcode.com/*`, the Google API hosts, `storage`, `alarms`, `notifications`, `identity` and
  `scripting` (used only to inject the content script into leetcode.com tabs already open at install or update).

### 13. UX fixes (no decision needed)
- **Long titles push the popup's buttons off-screen.** Fix: `.problem-list { grid-template-columns: minmax(0, 1fr) }`
  plus `text-overflow: ellipsis`.
- **Row status reads like "due overdue since yesterday".** Use the one-line statuses from section 9.
- **A re-solved tracked problem appears in both To rate and Due today, and the badge counts it twice.** Show it once.
- **Letter and emoji buttons** (E/M/H, 📅, ✕) have no accessible labels. Give every button a label, e.g.
  `aria-label="Rate Two Sum: Easy"`.
- **The light-mode link colour `#3b6ef5` fails contrast** (4.44:1, needs 4.5:1). Darken it.
- **Use the same labels and colours** in the popup, Settings and prompt.
- **"LeetCode not connected" in the popup is plain text.** Make it a link.

### 14. Publishing support
- **Version** `1.0.0`. English only. leetcode.com only. **No analytics or telemetry of any kind.**
- **Packaging script** `npm run package` (e.g. `scripts/package.mjs`, Node built-ins only; Node 22 has
  `zlib.crc32`, enough for a small zip writer). It writes `dist/releet-<version>.zip`:
  - **Include:** `manifest.json`, `background.js`, `lib/`, `content/`, `popup/`, `options/`, `welcome/`, `icons/`.
  - **Leave out:** tests, docs, markdown, `package.json`.
  - **Remove** any `"key"` line from the packaged manifest: the store rejects it.
  - **Warn loudly** if the Google client id is still the placeholder.
- **Replace `SETUP.md` with `PUBLISHING.md`,** a short guide for the owner:
  1. Create a Chrome Web Store developer account (one-time fee).
  2. `npm run package`, then upload the zip as a draft to get the store item ID and public key.
  3. In Google Cloud, enable the Calendar API, set up the consent screen with scope `calendar.app.created`, and
     create an OAuth client of type **Chrome Extension** with that item ID. Put the client id in
     `manifest.json`.
  4. Optional: put the store's public key in `manifest.json` as `"key"` for local development, so the local ID
     matches the store's. The package script strips it.
  5. Rebuild, upload, and fill in the privacy tab. Include suggested justification text for each permission and
     the data disclosures: sign-in info, Apple ID email, LeetCode username and solves, problem titles sent to
     Google or iCloud as event text.
  6. Google verification: until verified, max 100 users ever and an "unverified app" screen. It needs a homepage,
     privacy policy and terms on a domain you own, plus a short YouTube demo. Free; takes days to weeks.
- **Update `README.md`** for users and contributors: features, data stays in the browser, tests.
- **Privacy-policy sentence for the owner:** "Review history is stored locally in your browser and is never sent
  to the developer."

### 15. Icon (waiting on the owner)
The owner is generating the icon with another tool from the prompt below and will provide a 1024×1024 PNG. Turn it
into `icons/icon16.png`, `icon32.png`, `icon48.png` and `icon128.png`, and add 32 to the manifest. Check it's
legible at 16 px on light and dark toolbars. Until then, keep the placeholder icons.

> Design a browser-extension icon for "ReLeet", a tool that schedules spaced-repetition reviews of coding-interview
> problems in your calendar. One bold, simple symbol: a circular "repeat" arrow combined with a small calendar
> page. Flat vector, no text or letters. Deep indigo/violet (~#5B5BD6) with white; no orange, yellow or amber, and
> nothing resembling the LeetCode logo. A filled rounded square (~22% corner radius) holding the white symbol, on a
> transparent background, filling only the central 75% of a 1024×1024 canvas. Must read clearly at 16×16; also
> deliver a simplified 16×16 version if needed.

## Accepted limitations (document, don't fix)
- More than 20 solves made while Chrome is closed can't all be noticed: LeetCode only returns the 20 most recent.
- Google Calendar works in Google Chrome only.
- No multi-computer sync. Export / Import only.

## Facts from the audits (for context)
- **Why growing intervals and the daily limit matter:** simulated with the current fixed intervals, a user adding
  2.5 problems a day has about 28 reviews (14 h of blocks) on day 60 and 87 reviews a day by day 180.
- **Storage:** about 1 MB after 6 months. The 10 MB local quota is fine, so `unlimitedStorage` isn't needed.
- **Calendar write volume (optional optimisation):** every calendar operation rewrites the whole `calendars`
  storage key (`lib/calendar-sync.js`), which adds up at scale. Batching the writes is welcome but not required.
- **Google:** with `calendar.app.created`, `calendarList.list` is not allowed, so ReLeet can't find a ReLeet
  calendar by name. It must remember the calendar id (hence exporting it).
- **Store rules (archived Chrome docs):**
  - A privacy policy is required when handling sign-in info.
  - Per-permission justifications and a single-purpose statement are required.
  - No remote code: there is none today, so keep it that way.
  - `*.icloud.com` is not one of the broad patterns that trigger long reviews.

## Done means
- Everything in "What to build" is in place.
- `npm test` and `npm run test:browser` both pass.
- You've reviewed screenshots of the popup (empty, busy, idle computer), Settings, the welcome page and the
  in-page prompt in light and dark.
- `npm run package` produces a zip that loads as an unpacked extension.
- README and PUBLISHING.md are updated, and this file is deleted.
- Show the owner a short summary and the screenshots.
