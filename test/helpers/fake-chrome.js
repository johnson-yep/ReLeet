// Minimal in-memory stand-in for the chrome.* APIs that lib/storage.js uses,
// so worker modules can be tested under `node --test` without a browser.
//
//   import { installFakeChrome } from './helpers/fake-chrome.js';
//   const chrome = installFakeChrome({ problems: {...} }); // sets globalThis.chrome
//   chrome.dump() → current storage contents

export function installFakeChrome(initial = {}, extra = {}) {
  const listeners = new Set();

  // One storage area. `local` is the one tests seed and dump; sync and session start empty.
  function area(name, start = {}) {
    let data = structuredClone(start);
    const emit = (changes) => {
      for (const fn of listeners) fn(structuredClone(changes), name);
    };
    return {
      async get(keys) {
        if (keys == null) return structuredClone(data);
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = {};
        for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
        return out;
      },
      async set(items) {
        const changes = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
          data[k] = structuredClone(v);
        }
        emit(changes);
      },
      async remove(keys) {
        const changes = {};
        for (const k of [].concat(keys)) {
          changes[k] = { oldValue: data[k] };
          delete data[k];
        }
        emit(changes);
      },
      async clear() {
        const changes = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { oldValue: v }]));
        data = {};
        emit(changes);
      },
      dump: () => structuredClone(data),
      reset: (next = {}) => {
        data = structuredClone(next);
      },
    };
  }

  const local = area('local', initial);
  const sync = area('sync');
  const session = area('session');

  const chrome = {
    storage: {
      local,
      sync,
      session,
      onChanged: {
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn),
      },
    },
    runtime: { getManifest: () => ({ oauth2: { client_id: 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com' } }) },
    ...extra,
    dump: () => local.dump(),
    reset: (next = {}, { sync: syncData = {} } = {}) => {
      local.reset(next);
      sync.reset(syncData);
      session.reset();
    },
  };
  globalThis.chrome = chrome;
  return chrome;
}

// Just enough IndexedDB for lib/secret-box.js: one database with object
// stores of keyed values. Values are kept as-is (a CryptoKey can't be cloned
// in Node), like IndexedDB keeps a structured clone.
export function installFakeIndexedDB() {
  const databases = new Map(); // name → Map(store → Map(key → value))
  const later = (req, fn) =>
    setTimeout(() => {
      try {
        req.result = fn();
        req.onsuccess?.();
      } catch (error) {
        req.error = error;
        req.onerror?.();
      }
    });
  const indexedDB = {
    databases,
    open(name) {
      const req = {};
      later(req, () => {
        const isNew = !databases.has(name);
        if (isNew) databases.set(name, new Map());
        const stores = databases.get(name);
        const db = {
          createObjectStore: (store) => stores.set(store, new Map()),
          transaction: (store) => ({
            objectStore: () => ({
              get: (key) => {
                const r = {};
                later(r, () => stores.get(store).get(key));
                return r;
              },
              put: (value, key) => {
                const r = {};
                later(r, () => stores.get(store).set(key, value) && key);
                return r;
              },
            }),
          }),
          close() {},
        };
        if (isNew) {
          req.result = db;
          req.onupgradeneeded?.();
        }
        return db;
      });
      return req;
    },
    deleteDatabase(name) {
      const req = {};
      later(req, () => void databases.delete(name));
      return req;
    },
  };
  globalThis.indexedDB = indexedDB;
  return indexedDB;
}
