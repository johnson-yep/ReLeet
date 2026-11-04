// Minimal in-memory stand-in for the chrome.* APIs that lib/storage.js uses,
// so worker modules can be tested under `node --test` without a browser.
//
//   import { installFakeChrome } from './helpers/fake-chrome.js';
//   const chrome = installFakeChrome({ problems: {...} }); // sets globalThis.chrome
//   chrome.dump() → current storage contents

export function installFakeChrome(initial = {}, extra = {}) {
  let data = structuredClone(initial);
  const listeners = new Set();

  const local = {
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
      for (const fn of listeners) fn(structuredClone(changes), 'local');
    },
    async remove(keys) {
      const changes = {};
      for (const k of [].concat(keys)) {
        changes[k] = { oldValue: data[k] };
        delete data[k];
      }
      for (const fn of listeners) fn(changes, 'local');
    },
    async clear() {
      data = {};
    },
  };

  const chrome = {
    storage: {
      local,
      onChanged: {
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn),
      },
    },
    runtime: { getManifest: () => ({ oauth2: { client_id: 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com' } }) },
    ...extra,
    dump: () => structuredClone(data),
    reset: (next = {}) => {
      data = structuredClone(next);
    },
  };
  globalThis.chrome = chrome;
  return chrome;
}
