import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome, installFakeIndexedDB } from './helpers/fake-chrome.js';

const chrome = installFakeChrome({}, { alarms: { getAll: async () => [], clear: async () => true } });
const indexedDB = installFakeIndexedDB();
const { createSecretBox, isSealed, secretBox, forgetSecrets } = await import('../lib/secret-box.js');
const { migrateStoredData } = await import('../lib/migrate.js');

const memoryStore = () => {
  let key = null;
  return { load: async () => key, save: async (k) => void (key = k), get key() { return key; } };
};

test('a sealed secret opens again with the same key and is never stored in the clear', async () => {
  const store = memoryStore();
  const box = createSecretBox(store);
  const sealed = await box.seal('abcd-efgh-ijkl-mnop');
  assert.equal(isSealed(sealed), true);
  assert.doesNotMatch(JSON.stringify(sealed), /abcd/);
  assert.equal(await box.open(sealed), 'abcd-efgh-ijkl-mnop');
  // Another box over the same stored key opens it too (a restarted worker).
  assert.equal(await createSecretBox(store).open(sealed), 'abcd-efgh-ijkl-mnop');
  // Each seal uses a fresh IV.
  assert.notEqual((await box.seal('same')).iv, (await box.seal('same')).iv);
});

test('the key cannot be exported', async () => {
  const store = memoryStore();
  await createSecretBox(store).seal('x');
  assert.equal(store.key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', store.key));
});

test('a different key cannot open it; plain text from before encryption passes through', async () => {
  const sealed = await createSecretBox(memoryStore()).seal('secret');
  await assert.rejects(createSecretBox(memoryStore()).open(sealed));
  assert.equal(await createSecretBox(memoryStore()).open('plain'), 'plain');
});

test('the Chrome box keeps its key in IndexedDB, and forgetting deletes it', async () => {
  const sealed = await secretBox().seal('pw');
  assert.ok(indexedDB.databases.get('releet-secrets').get('keys').get('storage'));
  assert.equal(await secretBox().open(sealed), 'pw');
  await forgetSecrets();
  assert.equal(indexedDB.databases.has('releet-secrets'), false);
  await assert.rejects(secretBox().open(sealed)); // a new key can't open the old secret
});

test('an update encrypts an Apple password stored as plain text', async () => {
  const box = createSecretBox(memoryStore());
  chrome.reset({ calendars: { apple: { connected: true, auth: { appleId: 'me@icloud.com', appPassword: 'abcd' } } } });
  await migrateStoredData({ box });
  const { auth } = chrome.dump().calendars.apple;
  assert.equal(auth.appleId, 'me@icloud.com');
  assert.equal(isSealed(auth.appPassword), true);
  assert.equal(await box.open(auth.appPassword), 'abcd');
  // Already sealed: left alone.
  const before = chrome.dump();
  await migrateStoredData({ box });
  assert.deepEqual(chrome.dump(), before);
});
