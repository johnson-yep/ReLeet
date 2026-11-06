// Encrypts the secrets ReLeet keeps in chrome.storage.local (the iCloud
// app-specific password), as the Chrome Web Store asks for credentials.
//
// The key is an AES-GCM CryptoKey created non-extractable and kept in
// IndexedDB: this browser can encrypt and decrypt with it, but nothing can read
// the key itself out, so a copy of the extension's storage doesn't reveal the
// password. Only the service worker seals and opens secrets, so one key is
// never made twice at once.
//
// Sealed = { iv, data }, both base64.

const DB_NAME = 'releet-secrets';
const STORE = 'keys';
const KEY_ID = 'storage';

export const isSealed = (value) =>
  value !== null && typeof value === 'object' && typeof value.iv === 'string' && typeof value.data === 'string';

const toBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

// keyStore: { load() → CryptoKey | null, save(key) }.
export function createSecretBox(keyStore, subtle = globalThis.crypto.subtle) {
  let key = null;

  function getKey() {
    key ??= (async () => {
      const stored = await keyStore.load();
      if (stored) return stored;
      const made = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await keyStore.save(made);
      return made;
    })().catch((err) => {
      key = null;
      throw err;
    });
    return key;
  }

  return {
    async seal(text) {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const data = await subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(), new TextEncoder().encode(text));
      return { iv: toBase64(iv), data: toBase64(data) };
    },

    // Plain text saved before encryption existed passes through.
    async open(sealed) {
      if (!isSealed(sealed)) return sealed;
      const plain = await subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(sealed.iv) },
        await getKey(),
        fromBase64(sealed.data),
      );
      return new TextDecoder().decode(plain);
    },
  };
}

// ---- Chrome glue: the key lives in the extension's IndexedDB ---------------

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb() {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE);
  return request(req);
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await request(fn(db.transaction(STORE, mode).objectStore(STORE)));
  } finally {
    db.close();
  }
}

const indexedDbKeyStore = {
  load: async () => (await withStore('readonly', (store) => store.get(KEY_ID))) ?? null,
  save: (key) => withStore('readwrite', (store) => store.put(key, KEY_ID)),
};

let chromeBox = null;
export const secretBox = () => (chromeBox ??= createSecretBox(indexedDbKeyStore));

// "Delete all my ReLeet data". Best effort: nothing is left to decrypt anyway.
export async function forgetSecrets() {
  chromeBox = null;
  if (typeof indexedDB === 'undefined') return;
  await request(indexedDB.deleteDatabase(DB_NAME)).catch(() => {});
}
