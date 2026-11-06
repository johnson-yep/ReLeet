// The Google Calendar and Apple Calendar cards, shared by Settings and the
// welcome page. The worker does the network work and is the only writer of the
// calendars key; these cards ask it to connect or disconnect and show what it
// stored.

import { getCalendars, onCalendarsChanged } from '../lib/storage.js';
import { GOOGLE_NEEDS_CHROME, chromeGoogleAuth, isGoogleClientIdConfigured } from '../lib/calendars/google.js';
import { ICLOUD_ORIGINS } from '../lib/calendars/apple.js';
import { timeAgo } from '../lib/format.js';
import { mainComputerUses } from '../lib/computer.js';

// Small DOM builder. Text always goes in as text nodes, never as HTML.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

export const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

// The worker answers every page message. Chrome can stop it before it does.
export async function send(message) {
  try {
    return (await chrome.runtime.sendMessage(message)) ?? { status: 'error', error: 'No answer from ReLeet.' };
  } catch (e) {
    if (/message (channel|port) closed|receiving end does not exist/i.test(e?.message ?? '')) {
      return { status: 'error', error: 'ReLeet stopped before it finished. Try again.' };
    }
    return { status: 'error', error: e.message };
  }
}

// Edge, Brave and Opera install from the Chrome Web Store but can't sign in
// through Chrome's account (docs/adr/0002). Without brand data, assume Chrome.
function isGoogleChrome() {
  const brands = navigator.userAgentData?.brands;
  return !brands || brands.some((b) => b.brand === 'Google Chrome');
}

const PROVIDERS = [
  {
    name: 'google',
    title: 'Google Calendar',
    about: 'Uses the Google account Chrome is signed in to. ReLeet can only see the calendar it creates.',
    // Named in the Disconnect warning when Google didn't say whose calendar it is.
    accountFallback: 'the Google account Chrome is signed in to',
    // Hidden until the publisher sets up Google sign-in (PUBLISHING.md).
    available: () => isGoogleClientIdConfigured(chrome.runtime.getManifest().oauth2?.client_id),
    blocked: () => (isGoogleChrome() ? null : GOOGLE_NEEDS_CHROME),
  },
  {
    name: 'apple',
    title: 'Apple Calendar',
    about: 'Uses iCloud with an app-specific password, not your Apple ID password. ReLeet keeps it encrypted in this browser.',
    accountFallback: 'your iCloud account',
    available: () => true,
    blocked: () => null,
  },
];

// onRender() runs after every render, for what the page shows around the cards.
// isIdle() says ReLeet is active on another computer, which uses the same calendars.
export function mountCalendarCards(container, { onRender = () => {}, isIdle = () => false } = {}) {
  let calendars = {};
  // Per-card state that isn't in storage: what's in progress and the last
  // message. `attempt` tells a Connect the user cancelled from a later one.
  const ui = Object.fromEntries(
    PROVIDERS.map((p) => [p.name, { busy: null, message: '', kind: '', forceable: false, attempt: 0 }]),
  );

  // Created once and reused by every render, so what the user typed survives re-renders.
  const appleFields = {
    appleId: h('input', {
      type: 'email',
      placeholder: 'Apple ID email',
      autocomplete: 'username',
      'aria-label': 'Apple ID email',
      'data-action': 'apple-id',
    }),
    appPassword: h('input', {
      type: 'password',
      placeholder: 'App-specific password (xxxx-xxxx-xxxx-xxxx)',
      autocomplete: 'off',
      'aria-label': 'App-specific password',
      'data-action': 'apple-password',
    }),
  };

  // Each card is built once. A render swaps what's inside it, except the
  // message line: it stays the same element, so a screen reader reads out each
  // new message (a live region inserted with its text already in it often isn't).
  const cards = Object.fromEntries(
    PROVIDERS.map(({ name }) => {
      const body = h('div', {});
      const message = h('p', { role: 'status' });
      return [name, { article: h('article', { id: `card-${name}`, class: 'calendar-card card' }, body, message), body, message }];
    }),
  );
  container.append(...Object.values(cards).map((card) => card.article));

  function status(state) {
    if (!state?.connected) return [];
    const synced = state.lastSyncAt ? `updated ${timeAgo(state.lastSyncAt)}` : 'not updated yet';
    const lines = [h('p', {}, state.account ? `Connected as ${state.account} · ${synced}` : `Connected · ${synced}`)];
    // Error messages give the cause only; the next step is added here.
    if (state.needsReconnect) {
      const cause = state.lastError ? sentence(state.lastError) : 'The sign-in expired.';
      lines.push(h('p', { class: 'error' }, `${cause} Reconnect to keep this calendar up to date.`));
    } else if (state.lastError) {
      lines.push(h('p', { class: 'error' }, `The last update failed: ${sentence(state.lastError)} ReLeet tries again every 15 minutes.`));
    }
    return lines;
  }

  function appleForm(state) {
    if (!appleFields.appleId.value && state?.account) appleFields.appleId.value = state.account;
    return h(
      'div',
      { class: 'fields' },
      appleFields.appleId,
      appleFields.appPassword,
      h(
        'p',
        { class: 'muted' },
        'Make one at ',
        h('a', { href: 'https://account.apple.com', target: '_blank', rel: 'noopener', 'data-action': 'apple-link' }, 'account.apple.com'),
        ' → Sign-In and Security → App-Specific Passwords.',
      ),
    );
  }

  function button(action, label, onclick, { disabled = false, primary = false } = {}) {
    return h('button', { type: 'button', class: primary ? 'btn-primary' : null, 'data-action': action, disabled, onclick }, label);
  }

  function renderCard(provider) {
    const { name, title, about } = provider;
    const card = cards[name];
    card.article.hidden = !provider.available();
    if (card.article.hidden) return;

    const state = calendars[name];
    const connected = Boolean(state?.connected);
    const view = ui[name];
    const busy = Boolean(view.busy);
    const blocked = provider.blocked();
    const attention = connected && (state.needsReconnect || state.lastError);

    const badge = connected
      ? h('span', { class: `badge ${attention ? 'warn' : 'on'}` }, state.needsReconnect ? 'Needs sign-in' : state.lastError ? 'Retrying' : 'Connected')
      : null;

    const buttons = [];
    if (!blocked && (!connected || state.needsReconnect)) {
      const label = view.busy === 'connect' ? 'Connecting…' : connected ? 'Reconnect' : 'Connect';
      buttons.push(button('connect', label, () => connect(provider), { disabled: busy, primary: !connected }));
      // Chrome's sign-in window can be closed without telling ReLeet.
      if (view.busy === 'connect' && name === 'google') buttons.push(button('cancel', 'Cancel', () => cancel(provider)));
    }
    if (connected) {
      buttons.push(
        button('disconnect', view.busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect', () => disconnect(provider), {
          disabled: busy,
        }),
      );
      if (view.forceable) {
        buttons.push(button('force-disconnect', 'Disconnect anyway', () => disconnect(provider, true), { disabled: busy }));
      }
    }

    card.article.classList.toggle('needs-attention', Boolean(attention));
    card.body.replaceChildren(
      ...[
        // tabindex -1: where focus goes while the card's buttons are disabled.
        h('div', { class: 'card-head' }, h('h3', { tabindex: '-1', 'data-action': 'heading' }, title), badge),
        h('p', { class: 'muted' }, blocked ?? about),
        status(state),
        name === 'apple' && (!connected || state.needsReconnect) ? appleForm(state) : null,
        buttons.length ? h('div', { class: 'button-row' }, buttons) : null,
      ].flat(),
    );
    card.message.className = `card-message ${view.kind || 'muted'}`;
    if (card.message.textContent !== view.message) card.message.textContent = view.message;
  }

  // Rebuilding a card replaces its buttons, which drops keyboard focus. Find
  // the focused control again by card and action and focus its replacement, or
  // the card's heading while that control is disabled (e.g. "Connecting…").
  function render() {
    const el = document.activeElement;
    const cardEl = el?.closest?.('.calendar-card');
    const key = cardEl && el.dataset.action ? { card: cardEl.id, action: el.dataset.action } : null;
    for (const provider of PROVIDERS) renderCard(provider);
    onRender();
    if (!key || document.activeElement !== document.body) return;
    const card = document.getElementById(key.card);
    const target = card?.querySelector(`[data-action="${key.action}"]`);
    if (target && !target.disabled) target.focus();
    else card?.querySelector('h3')?.focus();
  }

  function setCard(name, patch) {
    Object.assign(ui[name], patch);
    render();
  }

  function cancel({ name }) {
    ui[name].attempt++;
    setCard(name, { busy: null, message: 'Google sign-in cancelled.', kind: '' });
  }

  async function connect(provider) {
    const { name } = provider;
    const attempt = ++ui[name].attempt;
    let credentials;
    // Both permission and sign-in prompts must start before any await, while
    // the click still counts as a user gesture.
    let allowed = Promise.resolve(true);
    let googleSignIn = null;
    if (name === 'apple') {
      credentials = { appleId: appleFields.appleId.value.trim(), appPassword: appleFields.appPassword.value.trim() };
      if (!credentials.appleId || !credentials.appPassword) {
        setCard(name, { message: 'Enter your Apple ID email and an app-specific password.', kind: 'error' });
        return;
      }
      allowed = chrome.permissions.request({ origins: ICLOUD_ORIGINS }).catch(() => false);
    } else {
      // Google's consent runs from this page: with a Chrome sign-in and 2FA it
      // can take minutes, longer than Chrome keeps the worker waiting on one
      // request. The worker then gets the token Chrome cached.
      googleSignIn = chromeGoogleAuth().getToken(true);
    }
    const waiting = name === 'google' ? 'Waiting for Google sign-in. A window opens if Google needs you.' : 'Checking the password…';
    setCard(name, { busy: 'connect', forceable: false, message: waiting, kind: '' });
    const current = () => ui[name].attempt === attempt;

    if (!(await allowed)) {
      setCard(name, {
        busy: null,
        message: 'ReLeet needs your permission to reach iCloud to add your reviews there. Connect again and allow it.',
        kind: 'error',
      });
      return;
    }
    if (googleSignIn) {
      try {
        await googleSignIn;
      } catch (e) {
        if (current()) setCard(name, { busy: null, message: e?.message || "Couldn't sign in to Google.", kind: 'error' });
        return;
      }
    }
    if (!current()) return; // cancelled meanwhile
    // The answer comes after the first update of the calendar, which can take a while.
    const result = await send({ type: 'calendar-connect', provider: name, credentials });
    if (result.status === 'connected') {
      if (name === 'apple') appleFields.appPassword.value = '';
      // That first update can fail (offline, say) without undoing the connection.
      const failed = (await getCalendars())[name]?.lastError;
      setCard(name, {
        busy: null,
        message: failed
          ? 'Connected, but adding your reviews failed (see above).'
          : 'Connected. Your reviews are in the “ReLeet” calendar.',
        kind: failed ? 'error' : 'ok',
      });
    } else if (result.status === 'idle') {
      setCard(name, { busy: null, message: 'ReLeet is active on another computer. Use this computer first.', kind: 'error' });
    } else {
      setCard(name, { busy: null, message: result.error ?? "Couldn't connect.", kind: 'error' });
    }
  }

  async function disconnect(provider, force = false) {
    const { name, title } = provider;
    const account = calendars[name]?.account;
    // The calendar of a computer that isn't the main one stays if the main computer uses it too.
    const shared = isIdle() && (await mainComputerUses(name, calendars[name]?.calendarId));
    const question = shared
      ? `Disconnect ${title} on this computer?\n\nReLeet is active on another computer, which uses the same ` +
        '“ReLeet” calendar, so the calendar stays in your account.'
      : `Disconnect ${title}?\n\nThis deletes the “ReLeet” calendar and all of its review events from ` +
        `${account || provider.accountFallback}. Your other calendars aren't touched.`;
    if (!force && !confirm(question)) return;
    setCard(name, { busy: 'disconnect', message: '', kind: '' });
    const result = await send({ type: 'calendar-disconnect', provider: name, force });
    if (result.status === 'disconnected') {
      setCard(name, {
        busy: null,
        forceable: false,
        message: result.keptCalendar
          ? 'Disconnected on this computer. The “ReLeet” calendar stays for the computer ReLeet is active on.'
          : force
          ? 'Disconnected. The “ReLeet” calendar is still in your account: delete it there, or connect again to pick it up.'
          : 'Disconnected.',
        kind: 'ok',
      });
    } else {
      // Usually offline or the sign-in expired. Forcing forgets the calendar
      // without deleting it, so the user is told it stays behind.
      const fix = result.reconnect ? 'Reconnect, then Disconnect again to delete it, or use' : 'Try again later, or use';
      setCard(name, {
        busy: null,
        forceable: true,
        message:
          `Couldn't delete the “ReLeet” calendar: ${sentence(result.error ?? 'something went wrong')} ` +
          `${fix} “Disconnect anyway” to leave it in your account.`,
        kind: 'error',
      });
    }
  }

  // What the cards show of a calendar's stored state. A sync saves the state
  // after every event it writes; those saves change nothing on screen.
  const visible = (state) => state && [state.connected, state.account, state.lastSyncAt, state.lastError, state.needsReconnect];

  onCalendarsChanged((next) => {
    const prev = calendars;
    calendars = next;
    let changed = false;
    for (const { name } of PROVIDERS) {
      // Connect saved the connection: sign-in is over, the first update is running.
      if (ui[name].busy === 'connect' && next[name]?.connected && !prev[name]?.connected) {
        Object.assign(ui[name], { message: 'Connected. Adding your reviews to the calendar…' });
        changed = true;
      }
      if (JSON.stringify(visible(next[name])) !== JSON.stringify(visible(prev[name]))) changed = true;
    }
    if (changed) render();
  });

  getCalendars().then((stored) => {
    calendars = stored;
    render();
  });

  return {
    anyConnected: () => PROVIDERS.some((p) => calendars[p.name]?.connected),
    anyAvailable: () => PROVIDERS.some((p) => p.available() && !p.blocked()),
  };
}
