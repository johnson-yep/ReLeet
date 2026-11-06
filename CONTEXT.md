# ReLeet

A Chrome extension for spaced repetition of LeetCode problems: it notices when you solve a problem, asks how
hard it felt, and books time in your calendar to review it again.

## Language

### Problems and reviews

**Problem**:
A LeetCode problem the user is tracking for review.
_Avoid_: question, card

**Solve**:
An accepted LeetCode submission of a problem, made by the user.
_Avoid_: completion, submission (only accepted ones count)

**Pending solve**:
A solve ReLeet has noticed but the user hasn't rated yet.
_Avoid_: new submission, pending submission

**Rating**:
The user's judgement of how hard a solve or review felt; it decides when the next review is.
_Avoid_: difficulty

**Difficulty**:
LeetCode's official Easy / Medium / Hard label for a problem. It plays no part in scheduling.
_Avoid_: rating

**Review**:
Solving a tracked problem again, on or after its review day.
_Avoid_: revision, repetition

**Review day**:
The date a problem is next due for review.
_Avoid_: due date, due time

**Overdue**:
A problem whose review day has passed without a review.

### Noticing solves

**In-page prompt**:
The rating buttons ReLeet shows on leetcode.com right after a solve is accepted.
_Avoid_: popup (that's the extension's toolbar window)

**Background check**:
ReLeet's regular look at the user's recent accepted submissions, which catches solves made on other devices.
_Avoid_: sync, poll

**Baseline**:
The moment detection starts for a LeetCode username; solves before it are ignored unless imported.

### Calendars

**Block**:
Time reserved on the user's calendar for one review of one problem.
_Avoid_: event, slot, session

**ReLeet calendar**:
The separate calendar ReLeet creates inside each connected calendar account to hold its blocks.

**Connected calendar**:
A calendar account (Google or Apple iCloud) the user has signed in to from ReLeet.

**Start time**:
The time of day the first block of any day begins.
