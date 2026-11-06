// Which computer ReLeet is active on (docs/adr/0001-one-main-computer.md).
//
// Chrome Sync installs ReLeet on every computer where the user is signed in to
// Chrome, but each copy keeps its problems in its own chrome.storage.local.
// Each copy has a random id in storage.local; the main computer's id is in
// storage.sync, which Chrome Sync shares. Without Chrome Sync, storage.sync
// stays on this computer and every copy thinks it's the main one.
//
// Role:
//   'main'       this computer claimed it
//   'unclaimed'  nobody has yet; ReLeet runs, and the first rating or the
//                finished welcome page claims it
//   'idle'       another computer is the main one; this copy does nothing

import { withStorageLock } from './storage.js';

const ID_KEY = 'computerId';
const MAIN_KEY = 'mainComputer';

export function getComputerId() {
  return withStorageLock(async () => {
    const { [ID_KEY]: stored } = await chrome.storage.local.get(ID_KEY);
    if (stored) return stored;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [ID_KEY]: id });
    return id;
  });
}

async function mainComputerId() {
  const { [MAIN_KEY]: main } = await chrome.storage.sync.get(MAIN_KEY);
  return main?.id ?? null;
}

export async function computerRole() {
  const [id, main] = await Promise.all([getComputerId(), mainComputerId()]);
  if (!main) return 'unclaimed';
  return main === id ? 'main' : 'idle';
}

export const isActive = (role) => role !== 'idle';

// Makes this computer the main one. The others notice through storage.sync
// and go idle.
export async function claimMainComputer(at = Date.now()) {
  await chrome.storage.sync.set({ [MAIN_KEY]: { id: await getComputerId(), claimedAt: at } });
}

// The first rating claims an unclaimed ReLeet; it never takes over from another computer.
export async function claimIfUnclaimed() {
  if ((await computerRole()) === 'unclaimed') await claimMainComputer();
}

// "Delete all my data": forget the claim if it's this computer's.
export async function releaseMainComputer() {
  if ((await computerRole()) === 'main') await chrome.storage.sync.remove(MAIN_KEY);
}

export function onRoleChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[MAIN_KEY]) computerRole().then(callback);
  });
}
