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
//   'idle'       another computer is the main one, or was: a copy that has
//                been idle stays idle until it's claimed, even after the main
//                computer deletes its data and gives up the claim

import { withStorageLock } from './storage.js';

const ID_KEY = 'computerId';
const MAIN_KEY = 'mainComputer';
const IDLE_KEY = 'idleSince'; // local: when this copy last went idle

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
  const [id, main, { [IDLE_KEY]: idleSince }] = await Promise.all([
    getComputerId(),
    mainComputerId(),
    chrome.storage.local.get(IDLE_KEY),
  ]);
  if (!main) return idleSince ? 'idle' : 'unclaimed';
  return main === id ? 'main' : 'idle';
}

// The worker notes when this copy goes idle...
export async function rememberIdle(at = Date.now()) {
  const { [IDLE_KEY]: since } = await chrome.storage.local.get(IDLE_KEY);
  if (!since) await chrome.storage.local.set({ [IDLE_KEY]: at });
}

// ...and, once it's the main computer again, takes the note back. → true if
// this copy had been idle, so what it knows about its calendars may be out of date.
export function wasIdle() {
  return withStorageLock(async () => {
    const { [IDLE_KEY]: since } = await chrome.storage.local.get(IDLE_KEY);
    if (since) await chrome.storage.local.remove(IDLE_KEY);
    return Boolean(since);
  });
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

// The role depends on the claim (sync) and on this copy's idle note (local).
export function onRoleChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    const changed = area === 'sync' ? changes[MAIN_KEY] : area === 'local' && changes[IDLE_KEY];
    if (changed) computerRole().then(callback);
  });
}
