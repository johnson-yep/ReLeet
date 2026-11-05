// Runs on every leetcode.com page. LeetCode is a single-page app, so a problem
// page can be reached without a full load: the problem is read from the URL at
// the moment of submit, not when this script starts.
// Classic content script (not a module): no imports.
//
// A Submit click, Ctrl/Cmd+Enter or an "Accepted" result on screen is only a
// hint. LeetCode's recent accepted submissions are the source of truth, so after
// a hint we poll them until the new submission shows up, tell the worker, and
// ask for a rating in a small prompt on the page.

(() => {
  // This file can run twice in one tab: from the manifest, and from the worker,
  // which adds it to leetcode.com tabs already open when ReLeet is installed or
  // updated. Two copies would show two prompts per solve. A copy from before an
  // update ran in an older isolated world and can't see this flag, so it
  // doesn't stop the new copy (the old one has stopped working anyway).
  if (globalThis.__releetContentScript) return;
  globalThis.__releetContentScript = true;

  // When to check after a hint (ms since the hint). Judging usually takes a few
  // seconds; backing off keeps a wrong answer or a slow judge to 8 requests.
  const POLL_AT_MS = [2, 4, 7, 11, 16, 25, 40, 60].map((s) => s * 1000);
  // A submission this much older than the hint still counts (a slow judge, or
  // a result that showed up long after Submit). Compared in LeetCode's time.
  const MATCH_WINDOW_MS = 120 * 1000;
  // An "Accepted" result shortly after we reported that problem is the same solve.
  const RESULT_REPEAT_MS = 60 * 1000;
  const REQUEST_TIMEOUT_MS = 15 * 1000;
  const CONFIRM_HIDE_MS = 5000;

  // The prompt never takes focus by itself: it can appear while you're still
  // typing, and those keys would land on a rating button. This shortcut moves
  // focus into it instead (Tab doesn't help in the editor, it indents).
  const IS_MAC = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');
  const SHORTCUT_TEXT = IS_MAC ? 'Option+Shift+R' : 'Alt+Shift+R';
  const SHORTCUT_LABEL = IS_MAC ? '⌥⇧R' : 'Alt+Shift+R';

  const SUBMIT_BUTTON = '[data-e2e-locator="console-submit-button"]';
  const SUBMISSION_RESULT = '[data-e2e-locator="submission-result"]';

  const RATINGS = [
    { rating: 'easy', label: 'Easy', days: 7 },
    { rating: 'medium', label: 'Medium', days: 3 },
    { rating: 'hard', label: 'Hard', days: 1 },
  ];

  const USER_STATUS_QUERY = `query globalData {
  userStatus { username isSignedIn }
}`;

  const RECENT_AC_QUERY = `query recentAcSubmissions($username: String!, $limit: Int!) {
  recentAcSubmissionList(username: $username, limit: $limit) { id title titleSlug timestamp }
}`;

  // Extension messaging

  // The extension can be reloaded or updated while this tab stays open. This
  // script is then orphaned: chrome.runtime calls throw until the page reloads.
  function extensionAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return undefined; // orphaned, or the worker didn't answer
    }
  }

  // LeetCode GraphQL (same origin, so the session cookie goes along)

  // LeetCode's clock minus ours, from the Date header of its latest answer.
  // Submission timestamps are LeetCode's time: compared with ours directly, a
  // clock a few minutes fast would never match a new solve.
  let serverOffset = 0;

  function readCookie(name) {
    for (const part of document.cookie.split(';')) {
      const [key, ...rest] = part.trim().split('=');
      if (key !== name) continue;
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return rest.join('=');
      }
    }
    return null;
  }

  async function graphql(query, variables = {}) {
    const headers = { 'Content-Type': 'application/json' };
    // Django rejects cookie-authenticated POSTs without the CSRF token, which
    // LeetCode keeps in a readable cookie for its own requests.
    const csrf = readCookie('csrftoken');
    if (csrf) headers['x-csrftoken'] = csrf;
    const res = await fetch(`${location.origin}/graphql`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      credentials: 'same-origin',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`LeetCode HTTP ${res.status}`);
    const serverNow = Date.parse(res.headers.get('date') ?? '');
    if (Number.isFinite(serverNow)) serverOffset = serverNow - Date.now();
    const json = await res.json();
    return json?.data ?? null;
  }

  // Signed-in user

  let username = null;
  let userLookup = null; // shared in-flight userStatus request

  // → username, or null when signed out. Rejects if LeetCode can't be reached,
  // so a poll can try again instead of giving up.
  function detectUser() {
    if (username) return Promise.resolve(username);
    userLookup ??= graphql(USER_STATUS_QUERY)
      .then((data) => {
        const status = data?.userStatus;
        if (status?.isSignedIn && status.username) {
          username = status.username;
          send({ type: 'leetcode-user', username });
        }
        return username;
      })
      .finally(() => {
        userLookup = null;
      });
    return userLookup;
  }

  // Confirming a submission

  const reported = new Set(); // submission ids this page already told the worker about
  const lastReportedAt = new Map(); // slug → ms
  const watches = new Map(); // slug → polling state; one loop per problem

  function slugFromPath(pathname) {
    const match = pathname.match(/\/problems\/([a-z0-9-]+)/i);
    return match ? match[1].toLowerCase() : null;
  }

  function onSubmitHint(source) {
    const slug = slugFromPath(location.pathname);
    if (!slug || !extensionAlive()) return;
    // The result panel often renders after polling already found the solve.
    if (source === 'result' && Date.now() - (lastReportedAt.get(slug) ?? 0) < RESULT_REPEAT_MS) return;
    watch(slug);
  }

  function watch(slug) {
    const now = Date.now();
    const existing = watches.get(slug);
    if (existing) {
      // Already polling this problem: restart the clock so the newer submission
      // gets the quick early checks, rather than running a second loop.
      Object.assign(existing, { since: now, start: now, step: 0, generation: existing.generation + 1 });
      if (!existing.busy) schedule(slug, existing);
      return;
    }
    const state = { since: now, start: now, step: 0, generation: 0, timer: null, busy: false };
    watches.set(slug, state);
    schedule(slug, state);
  }

  function schedule(slug, state) {
    clearTimeout(state.timer);
    if (state.step >= POLL_AT_MS.length) {
      watches.delete(slug);
      return;
    }
    const delay = Math.max(0, state.start + POLL_AT_MS[state.step] - Date.now());
    state.timer = setTimeout(() => poll(slug, state), delay);
  }

  async function poll(slug, state) {
    state.timer = null;
    state.busy = true;
    const generation = state.generation;
    let outcome;
    try {
      outcome = await findAccepted(slug, state.since);
    } catch {
      outcome = { retry: true }; // network hiccup or rate limit: try at the next step
    }
    state.busy = false;
    if (outcome.submission || outcome.stop) {
      watches.delete(slug);
      if (outcome.submission) report(outcome.submission);
      return;
    }
    // A hint that arrived mid-request already reset the clock to step 0.
    if (state.generation === generation) state.step++;
    schedule(slug, state);
  }

  async function findAccepted(slug, since) {
    const user = await detectUser();
    if (!user || !extensionAlive()) return { stop: true }; // signed out, or nobody to tell
    const data = await graphql(RECENT_AC_QUERY, { username: user, limit: 10 });
    const list = Array.isArray(data?.recentAcSubmissionList) ? data.recentAcSubmissionList : [];
    // `since` is our clock; move it to LeetCode's before comparing.
    const from = since + serverOffset - MATCH_WINDOW_MS;
    // Newest first, so the first match is the latest accepted submission.
    const hit = list.find(
      (s) => s?.titleSlug === slug && Number(s.timestamp) * 1000 >= from && !reported.has(String(s.id)),
    );
    if (!hit) return { retry: true };
    return {
      submission: {
        submissionId: String(hit.id),
        slug,
        title: hit.title || slug,
        timestamp: Number(hit.timestamp) * 1000,
      },
    };
  }

  async function report(submission) {
    if (reported.has(submission.submissionId)) return;
    reported.add(submission.submissionId);
    lastReportedAt.set(submission.slug, Date.now());
    const res = await send({ type: 'leetcode-accepted', submission });
    // 'already-rated' (rated earlier today) gets no prompt.
    if (res?.status === 'queued' && res.pendingId) {
      showPrompt({ pendingId: res.pendingId, title: submission.title, tracked: Boolean(res.tracked) });
    }
  }

  // Hints

  // Capture phase so the page can't swallow the click before we see it.
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const button = target?.closest(`${SUBMIT_BUTTON}, button`);
      if (!button) return;
      if (button.matches(SUBMIT_BUTTON) || /^submit\b/i.test(button.textContent.trim())) onSubmitHint('click');
    },
    true,
  );

  // Ctrl/Cmd+Enter submits in LeetCode's editor (Shift is a different shortcut).
  // Alt+Shift+R moves focus to the rating prompt while one is open.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.repeat) {
        onSubmitHint('key');
      } else if (isPromptShortcut(event) && focusPrompt()) {
        // Ours alone: the editor shouldn't also act on it (on a Mac it would type "‰").
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );

  // event.code for macOS, where Option changes event.key to another character.
  function isPromptShortcut(event) {
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return false;
    return event.code === 'KeyR' || event.key?.toLowerCase() === 'r';
  }

  // The result panel catches submits the two hints above miss (a renamed button,
  // another shortcut). Checks are batched: the editor mutates the DOM on every key.
  function readResult() {
    const node = document.querySelector(SUBMISSION_RESULT);
    return { node, accepted: Boolean(node) && /^accepted\b/i.test(node.textContent.trim()) };
  }

  let lastResult = readResult(); // a result already on screen at load is an old one
  let resultCheck = null;

  const resultObserver = new MutationObserver(() => {
    resultCheck ??= setTimeout(() => {
      resultCheck = null;
      if (!extensionAlive()) {
        resultObserver.disconnect(); // orphaned: nobody to tell, stop watching the page
        return;
      }
      const result = readResult();
      const changed = result.node !== lastResult.node || result.accepted !== lastResult.accepted;
      lastResult = result;
      if (changed && result.accepted) onSubmitHint('result');
    }, 300);
  });
  resultObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // In-page rating prompt

  const PROMPT_CSS = `
    :host {
      all: initial !important;
      position: fixed !important;
      right: 16px !important;
      bottom: 16px !important;
      z-index: 2147483647 !important;
      display: block !important;
    }
    .card {
      --bg: #ffffff;
      --fg: #1c1d1f;
      --muted: #6b6f76;
      --border: #e4e5e7;
      --focus: #3b6ef5;
      --shadow: 0 12px 32px rgba(15, 17, 20, 0.16), 0 2px 6px rgba(15, 17, 20, 0.08);
      --easy: #1f9d55;
      --medium: #d08700;
      --hard: #e5484d;
      /* Darker label shades: the brand colors are too light for small text on white. */
      --easy-text: #177a42;
      --medium-text: #945f00;
      --hard-text: #c5282e;
      box-sizing: border-box;
      width: 304px;
      max-width: calc(100vw - 32px);
      padding: 12px 14px 12px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--bg);
      color: var(--fg);
      box-shadow: var(--shadow);
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
      animation: enter 160ms ease-out;
    }
    .card.leaving { opacity: 0; transform: translateY(6px); transition: opacity 150ms, transform 150ms; }
    @keyframes enter { from { opacity: 0; transform: translateY(8px); } }
    @media (prefers-reduced-motion: reduce) {
      .card { animation: none; }
      .card.leaving { transition: none; }
    }
    ${darkVars(':host(:not([data-theme="light"])) .card', true)}
    ${darkVars(':host([data-theme="dark"]) .card', false)}
    * { box-sizing: border-box; }
    p { margin: 0; }
    .brand {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      font-size: 10.5px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .shortcut { font-weight: 500; letter-spacing: 0; text-transform: none; }
    .card.done .shortcut { visibility: hidden; }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .title { font-weight: 600; overflow-wrap: anywhere; }
    .accepted { color: var(--easy-text); }
    .question { color: var(--muted); margin-top: 2px; }
    .ratings { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 10px; }
    button {
      font: inherit;
      cursor: pointer;
      color: inherit;
      background: none;
      border: 0;
      margin: 0;
    }
    button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    button[aria-disabled="true"] { cursor: default; opacity: 0.6; }
    .rate {
      min-height: 34px;
      padding: 6px 4px;
      border-radius: 8px;
      font-size: 12.5px;
      font-weight: 600;
      white-space: nowrap;
      color: var(--text);
      background: color-mix(in srgb, var(--tone) 9%, transparent);
      border: 1px solid color-mix(in srgb, var(--tone) 40%, transparent);
    }
    .rate:hover:not([aria-disabled="true"]) {
      background: color-mix(in srgb, var(--tone) 17%, transparent);
      border-color: var(--tone);
    }
    .rate:focus-visible { outline-color: var(--tone); }
    .rate .days { font-weight: 500; opacity: 0.8; }
    .easy { --tone: var(--easy); --text: var(--easy-text); }
    .medium { --tone: var(--medium); --text: var(--medium-text); }
    .hard { --tone: var(--hard); --text: var(--hard-text); }
    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 8px;
      min-height: 22px;
    }
    .note { color: var(--muted); font-size: 12px; }
    .later { color: var(--muted); font-size: 12px; padding: 2px 4px; margin-left: auto; border-radius: 4px; }
    .later:hover { color: var(--fg); text-decoration: underline; }
    .status { font-weight: 600; margin-top: 6px; }
    .status:empty { display: none; }
    .card.done .ratings, .card.done .footer { display: none; }
  `;

  // Dark colors either follow the system (media query) or are forced by the page's theme.
  function darkVars(selector, viaMedia) {
    const rule = `${selector} {
      --bg: #222326;
      --fg: #ececee;
      --muted: #9a9ea6;
      --border: #34363b;
      --focus: #7096ff;
      --shadow: 0 12px 32px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.3);
      --easy-text: #25a95c;
      --medium-text: var(--medium);
      --hard-text: #f5676b;
    }`;
    return viaMedia ? `@media (prefers-color-scheme: dark) { ${rule} }` : rule;
  }

  // LeetCode has its own light/dark switch; match it when the page says which
  // one is on, else fall back to the system setting.
  function pageTheme() {
    const root = document.documentElement;
    if (root.classList.contains('dark')) return 'dark';
    if (root.classList.contains('light')) return 'light';
    const scheme = getComputedStyle(root).colorScheme;
    return scheme === 'dark' || scheme === 'light' ? scheme : null;
  }

  // Builds elements without innerHTML: problem titles come from LeetCode.
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  }

  let prompt = null; // the prompt on screen: { host, card, pendingId, done, hideTimer, ... }

  function showPrompt({ pendingId, title, tracked }) {
    if (prompt && prompt.pendingId === pendingId && !prompt.done) return; // already asking
    hidePrompt({ animate: false });

    const host = document.createElement('releet-prompt');
    const theme = pageTheme();
    if (theme) host.setAttribute('data-theme', theme);
    // Open so tests and accessibility tools can see in; nothing here is secret.
    const root = host.attachShadow({ mode: 'open' });

    // Live, because it changes to the outcome after a rating.
    const question = h(
      'p',
      { class: 'question', id: 'releet-question', 'aria-live': 'polite' },
      'How hard did it feel?',
    );
    const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const buttons = RATINGS.map(({ rating, label, days }) =>
      h(
        'button',
        {
          type: 'button',
          class: `rate ${rating}`,
          'data-rating': rating,
          'aria-label': `${label}, review again in ${days} day${days === 1 ? '' : 's'}`,
          onclick: () => rate(current, rating, label),
        },
        h('span', {}, label),
        h('span', { class: 'days' }, ` · ${days}d`),
      ),
    );
    buttons[0].setAttribute('aria-keyshortcuts', 'Alt+Shift+R');
    const later = h('button', { type: 'button', class: 'later', onclick: () => hidePrompt() }, 'Later');
    // Screen readers hear about the prompt here, since focus stays where it was.
    const announce = h('p', { class: 'sr-only', role: 'status' });

    // A region, not a dialog: it doesn't take focus or block the page.
    const card = h(
      'div',
      {
        class: 'card',
        role: 'region',
        'aria-labelledby': 'releet-title',
        'aria-describedby': 'releet-question',
        onkeydown: (event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation(); // don't also close LeetCode's own panels
          hidePrompt(); // Escape = Later
        },
        // Focus only gets here by the user's doing (shortcut, Tab or a click).
        // Remember where it came from, to hand it back when the prompt is done.
        onfocusin: (event) => {
          if (!card.contains(event.relatedTarget)) current.returnFocus = event.relatedTarget;
        },
      },
      h(
        'p',
        { class: 'brand' },
        h('span', {}, 'ReLeet'),
        h('span', { class: 'shortcut', 'aria-hidden': 'true' }, `${SHORTCUT_LABEL} to rate`),
      ),
      h('p', { class: 'title', id: 'releet-title' }, h('span', { class: 'accepted' }, '✓ Accepted'), ` — ${title}`),
      question,
      h('div', { class: 'ratings', role: 'group', 'aria-label': 'Rate this solve' }, ...buttons),
      h('div', { class: 'footer' }, ...(tracked ? [h('span', { class: 'note' }, 'Counts as a review')] : []), later),
      status,
      announce,
    );

    const style = document.createElement('style');
    style.textContent = PROMPT_CSS;
    root.append(style, card);
    // <html> rather than <body>: a framework re-render of the body would drop it.
    document.documentElement.append(host);

    const current = {
      host,
      card,
      question,
      status,
      announce,
      buttons,
      pendingId,
      done: false,
      busy: false,
      hideTimer: null,
      returnFocus: null,
    };
    prompt = current;
    // Filled in a moment after insertion: a live region that arrives with its
    // text already in it often isn't read out.
    setTimeout(() => {
      if (prompt === current && !current.done) {
        announce.textContent = `ReLeet: Accepted, ${title}. Press ${SHORTCUT_TEXT} to rate how hard it felt.`;
      }
    }, 250);
  }

  // → true if there was a prompt to move focus to.
  function focusPrompt() {
    const current = prompt;
    if (!current || current.done) return false;
    current.buttons[0].focus({ preventScroll: true });
    return true;
  }

  async function rate(current, rating, label) {
    if (current !== prompt || current.busy || current.done) return;
    current.busy = true;
    // aria-disabled rather than disabled: a disabled button drops focus, and
    // focus should go back to the editor when the prompt finishes.
    for (const b of current.buttons) b.setAttribute('aria-disabled', 'true');

    const res = await send({ type: 'rate-pending', id: current.pendingId, rating });
    if (current !== prompt) return; // replaced or closed meanwhile
    if (res?.status === 'ok') finish(current, `Saved as ${label}.`, nextReviewText(res));
    else if (res?.status === 'gone') finish(current, 'Already rated in ReLeet.', '');
    else finish(current, "Couldn't save the rating.", 'Rate it from the ReLeet popup.');
  }

  function finish(current, message, detail) {
    current.done = true;
    current.busy = false;
    const hadFocus = current.host.shadowRoot.activeElement !== null;
    current.card.classList.add('done');
    current.question.textContent = message;
    current.status.textContent = detail;
    current.announce.textContent = ''; // "press … to rate" is out of date now
    // The focused button is now hidden; hand focus back so typing keeps working.
    if (hadFocus) restoreFocus(current);
    current.hideTimer = setTimeout(() => hidePrompt(), CONFIRM_HIDE_MS);
  }

  // "Next review Thu, Nov 5 · 9:00 AM". The time only when a calendar block exists.
  function nextReviewText({ dueAt, slot }) {
    const at = Number.isFinite(slot?.start) ? slot.start : dueAt;
    if (!Number.isFinite(at)) return '';
    const date = new Date(at);
    const day = date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (!Number.isFinite(slot?.start)) return `Next review ${day}`;
    return `Next review ${day} · ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }

  function restoreFocus(current) {
    const target = current.returnFocus;
    if (target instanceof HTMLElement && target.isConnected && target !== document.body) {
      target.focus({ preventScroll: true });
    } else {
      current.host.shadowRoot.activeElement?.blur();
    }
  }

  function hidePrompt({ animate = true } = {}) {
    const current = prompt;
    if (!current) return;
    prompt = null;
    clearTimeout(current.hideTimer);
    if (current.host.shadowRoot.activeElement) restoreFocus(current);
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reducedMotion) {
      current.host.remove();
      return;
    }
    current.card.classList.add('leaving');
    setTimeout(() => current.host.remove(), 160);
  }

  // Start: tell the worker who is signed in, so the background check knows whose
  // submissions to read. Signed out or unreachable: we'll ask again at submit.
  if (extensionAlive()) detectUser().catch(() => {});
})();
