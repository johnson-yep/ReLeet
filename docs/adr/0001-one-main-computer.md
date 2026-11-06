# ReLeet is active on one main computer

Chrome Sync installs an extension on every computer where the user is signed in to Chrome, but ReLeet's
problems live in that computer's local extension storage. If every copy ran, each would notice the same solves
and book its own blocks: Google would show every review twice (each copy creates its own ReLeet calendar), and
with Apple the copies would delete each other's blocks. So ReLeet is active only on one **main computer**; copies
on other computers stay idle and offer "Use this computer instead", and problems move between computers with
**Export / Import**.

## Considered options

- **Full sync of problems across computers** — rejected for now: `chrome.storage.sync` holds about 100 KB, and a
  few months of review history is several times that. It would need a server, which ReLeet doesn't have.
- **Let every copy run** — rejected: duplicate or deleted calendar blocks.

## Consequences

Switching main computer starts empty unless the user imports an export from the old one. Copies installed by hand
on computers without Chrome Sync can't see each other and would each think they are the main computer.
