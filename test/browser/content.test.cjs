// Real-browser check of content/leetcode.js. Serves a fake leetcode.com problem
// page through Playwright routing, fakes LeetCode's GraphQL and the extension's
// chrome.runtime, then drives the submit → poll → prompt → rate flow.
//
//   npm run test:browser                              (runs this and smoke.cjs)
//   node --test test/browser/content.test.cjs         just this file
//   SHOTS=1 node --test test/browser/content.test.cjs also writes prompt-*.png to test/browser/out/
//   CHANNEL=chrome node --test test/browser/content.test.cjs   runs in the installed Google Chrome

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const SCRIPT = process.env.CONTENT_SCRIPT || path.resolve(__dirname, '..', '..', 'content', 'leetcode.js');
const PAGE_HTML = fs.readFileSync(path.join(__dirname, 'fake-page.html'), 'utf8');
const OUT = path.join(__dirname, 'out');
if (process.env.SHOTS) fs.mkdirSync(OUT, { recursive: true });
const PROBLEM_URL = 'https://leetcode.com/problems/two-sum/description/';

let browser;
before(async () => {
  browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {});
});
after(async () => {
  await browser?.close();
});

// Stubs chrome.runtime in the page: records messages, answers from window.__responses.
function chromeStub() {
  window.__messages = [];
  window.__responses = {
    'leetcode-user': { changed: true },
    'leetcode-accepted': { status: 'queued', pendingId: 'two-sum', tracked: false, intervals: { easy: 7, okay: 3, hard: 1 } },
    'rate-pending': {
      status: 'ok',
      day: '2026-11-05',
      start: new Date(2026, 10, 5, 9, 0).getTime(),
      capped: false,
      undoToken: 'undo-rate',
    },
    'master-pending': { status: 'ok', undoToken: 'undo-master' },
    undo: { status: 'ok' },
  };
  window.chrome = window.chrome || {};
  window.chrome.runtime = {
    id: 'releet-test',
    sendMessage(message) {
      window.__messages.push(JSON.parse(JSON.stringify(message)));
      return Promise.resolve(structuredClone(window.__responses[message.type]));
    },
  };
}

// Opens the fake problem page with the content script injected.
// server.ac is what recentAcSubmissionList returns (newest first).
// skewMs: how far LeetCode's clock is ahead of this machine's (its Date header
// and the timestamps of accepted submissions).
async function open({ colorScheme = 'light', signedIn = true, responses = {}, setup = null, skewMs = 0 } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    colorScheme,
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  await context.addCookies([{ name: 'csrftoken', value: 'csrf-abc', domain: 'leetcode.com', path: '/', secure: true }]);
  const server = { ac: [], requests: [] };
  const serverNow = () => Date.now() + skewMs;

  await context.route('https://leetcode.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'POST' && url.pathname.replace(/\/$/, '') === '/graphql') {
      const body = JSON.parse(req.postData() || '{}');
      server.requests.push({ body, headers: req.headers(), at: Date.now() });
      let data;
      if (/userStatus/.test(body.query)) {
        data = { userStatus: signedIn ? { username: 'alice', isSignedIn: true } : { username: '', isSignedIn: false } };
      } else if (/recentAcSubmissionList/.test(body.query)) {
        data = { recentAcSubmissionList: server.ac.slice(0, body.variables?.limit ?? 20) };
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { date: new Date(serverNow()).toUTCString() },
        body: JSON.stringify({ data }),
      });
    }
    if (req.method() === 'GET' && url.pathname.startsWith('/problems/')) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE_HTML });
    }
    return route.fulfill({ status: 404, body: '' });
  });

  await context.addInitScript(chromeStub);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e));
  await page.goto(PROBLEM_URL);
  if (Object.keys(responses).length) {
    await page.evaluate((r) => Object.assign(window.__responses, r), responses);
  }
  if (setup) await page.evaluate(setup);
  await page.addScriptTag({ path: SCRIPT });

  const messages = () => page.evaluate(() => window.__messages);
  const ofType = async (type) => (await messages()).filter((m) => m.type === type);
  const acPolls = () => server.requests.filter((r) => /recentAcSubmissionList/.test(r.body.query));
  // Simulates LeetCode accepting a new submission now.
  const accept = (id, slug = 'two-sum', title = 'Two Sum', agoMs = 0) =>
    server.ac.unshift({ id: String(id), title, titleSlug: slug, timestamp: String(Math.floor((serverNow() - agoMs) / 1000)) });
  const waitFor = async (fn, timeout = 8000, label = 'condition') => {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const prompt = page.locator('releet-prompt');
  // The element focused inside the prompt, or null.
  const promptFocus = () =>
    page.evaluate(() => {
      const el = document.querySelector('releet-prompt')?.shadowRoot.activeElement;
      return el ? el.dataset.rating ?? el.className : null;
    });
  return { context, page, server, errors, messages, ofType, acPolls, accept, waitFor, prompt, promptFocus };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('content/leetcode.js', { concurrency: true }, () => {
  test('click → accepted → prompt → Okay → confirmation → auto-hide; no duplicate', async () => {
    const t = await open();
    try {
      // Username detection on load, with the CSRF header.
      await t.waitFor(async () => (await t.ofType('leetcode-user')).length, 5000, 'leetcode-user');
      assert.deepEqual(await t.ofType('leetcode-user'), [{ type: 'leetcode-user', username: 'alice' }]);
      const userReq = t.server.requests.find((r) => /userStatus/.test(r.body.query));
      assert.equal(userReq.headers['x-csrftoken'], 'csrf-abc');
      assert.equal(userReq.headers['content-type'], 'application/json');

      // An older accepted submission of this problem must not count.
      t.server.ac.push({ id: '900', title: 'Two Sum', titleSlug: 'two-sum', timestamp: String(Math.floor(Date.now() / 1000) - 3600) });
      await t.page.click('[data-e2e-locator="console-submit-button"]');
      t.accept(1001);

      await t.waitFor(async () => (await t.ofType('leetcode-accepted')).length, 6000, 'leetcode-accepted');
      const [accepted] = await t.ofType('leetcode-accepted');
      assert.equal(accepted.submission.submissionId, '1001');
      assert.equal(accepted.submission.slug, 'two-sum');
      assert.equal(accepted.submission.title, 'Two Sum');
      assert.ok(Math.abs(accepted.submission.timestamp - Date.now()) < 10000);
      assert.equal(t.acPolls()[0].body.variables.limit, 10);
      assert.equal(t.acPolls()[0].body.variables.username, 'alice');
      assert.equal(t.acPolls()[0].headers['x-csrftoken'], 'csrf-abc');

      await t.prompt.locator('.card').waitFor();
      assert.equal(await t.prompt.locator('.title').textContent(), '✓ Accepted: Two Sum');
      assert.equal(await t.prompt.locator('.question').textContent(), 'How hard did it feel?');
      assert.deepEqual(await t.prompt.locator('button.rate').allTextContents(), ['Easy · 7d', 'Okay · 3d', 'Hard · 1d']);
      assert.equal(await t.prompt.locator('button.mastered').textContent(), 'Mastered — stop reviewing');
      assert.equal(await t.prompt.locator('.note').count(), 0); // not tracked
      // The prompt doesn't take focus; the shortcut to reach it is shown and announced.
      assert.equal(await t.promptFocus(), null);
      assert.equal(await t.page.evaluate(() => document.activeElement.dataset.e2eLocator), 'console-submit-button');
      assert.equal(await t.prompt.locator('.card').getAttribute('role'), 'region');
      assert.equal(await t.prompt.locator('.shortcut').textContent(), 'Alt+Shift+R');
      assert.equal(await t.prompt.locator('button.rate.easy').getAttribute('aria-keyshortcuts'), 'Alt+Shift+R');
      await t.waitFor(async () => (await t.prompt.locator('.sr-only').textContent()) !== '', 2000, 'announcement');
      assert.equal(
        await t.prompt.locator('.sr-only').textContent(),
        'ReLeet: Accepted, Two Sum. Press Alt+Shift+R to rate how hard it felt.',
      );

      if (process.env.SHOTS) {
        await sleep(300); // let the entry animation finish
        await t.page.screenshot({ path: path.join(OUT, 'prompt-light-page.png') });
        await t.prompt.screenshot({ path: path.join(OUT, 'prompt-light.png') });
      }

      await t.prompt.locator('button.rate.okay').click();
      await t.waitFor(async () => (await t.ofType('rate-pending')).length, 3000, 'rate-pending');
      assert.deepEqual(await t.ofType('rate-pending'), [{ type: 'rate-pending', id: 'two-sum', rating: 'okay' }]);
      await t.waitFor(async () => (await t.prompt.locator('.outcome').textContent()) !== '', 3000, 'confirmation');
      assert.equal(await t.prompt.locator('.outcome').textContent(), 'Saved: Okay. Next review Thu, Nov 5 at 9:00 AM. Undo');
      // Bold: what was saved, and the Undo.
      assert.equal(await t.prompt.locator('.outcome strong').textContent(), 'Saved: Okay.');
      assert.equal(await t.prompt.locator('.outcome button.action').textContent(), 'Undo');
      assert.equal(await t.prompt.locator('.question').isVisible(), false);
      assert.equal(await t.prompt.locator('.sr-only').textContent(), '', 'stale "press … to rate" cleared');
      if (process.env.SHOTS) await t.prompt.screenshot({ path: path.join(OUT, 'prompt-confirm.png') });

      // A second trigger for the same submission: polls again, but no new report or prompt.
      const pollsBefore = t.acPolls().length;
      await t.page.click('[data-e2e-locator="console-submit-button"]');
      await sleep(4600);
      assert.ok(t.acPolls().length > pollsBefore, 'polled again');
      assert.equal((await t.ofType('leetcode-accepted')).length, 1);

      // Auto-hide about 10 s after the confirmation.
      await t.waitFor(async () => (await t.prompt.count()) === 0, 10000, 'auto-hide');
      assert.equal((await t.ofType('leetcode-user')).length, 1, 'username sent once');
      assert.deepEqual(t.errors, []);
    } finally {
      await t.context.close();
    }
  });

  test('a second trigger while polling restarts the clock instead of a second loop', async () => {
    const t = await open();
    try {
      await t.page.click('[data-e2e-locator="console-submit-button"]');
      await sleep(1000);
      await t.page.click('[data-e2e-locator="console-submit-button"]');
      await sleep(3500); // 4.5 s after the first click
      // One loop restarted at 1 s → one poll (at 3 s). Two loops would have polled at 2, 3 and 4 s.
      assert.equal(t.acPolls().length, 1);
      await sleep(1200); // restarted loop's second step at 1 + 4 = 5 s
      assert.equal(t.acPolls().length, 2);
    } finally {
      await t.context.close();
    }
  });

  test('Ctrl+Enter path; a confirmation without a block time has no time', async () => {
    const t = await open({ responses: { 'rate-pending': { status: 'ok', day: '2026-11-05', start: null, capped: false, undoToken: 'u' } } });
    try {
      await t.page.focus('#editor');
      await t.page.keyboard.press('Shift+Control+Enter'); // not a submit
      await sleep(2500);
      assert.equal(t.acPolls().length, 0);

      await t.page.keyboard.press('Control+Enter');
      t.accept(2002);
      await t.prompt.locator('.card').waitFor({ timeout: 6000 });
      assert.equal((await t.ofType('leetcode-accepted'))[0].submission.submissionId, '2002');
      assert.equal(await t.page.evaluate(() => document.activeElement.id), 'editor', 'focus stays in the editor');
      // Keyboard: Alt+Shift+R → Easy; Tab twice → Hard, Enter rates.
      const before = await t.page.$eval('#editor', (e) => e.value);
      await t.page.keyboard.press('Alt+Shift+R');
      assert.equal(await t.promptFocus(), 'easy');
      assert.equal(await t.page.$eval('#editor', (e) => e.value), before, 'shortcut not typed into the editor');
      await t.page.keyboard.press('Tab');
      await t.page.keyboard.press('Tab');
      await t.page.keyboard.press('Enter');
      await t.waitFor(async () => (await t.ofType('rate-pending')).length, 3000, 'rate-pending');
      assert.equal((await t.ofType('rate-pending'))[0].rating, 'hard');
      await t.waitFor(async () => (await t.prompt.locator('.outcome').textContent()) !== '', 3000, 'confirmation');
      assert.equal(await t.prompt.locator('.outcome').textContent(), 'Saved: Hard. Next review Thu, Nov 5. Undo');
      // Focus went back to the editor.
      assert.equal(await t.page.evaluate(() => document.activeElement.id), 'editor');
      assert.deepEqual(t.errors, []);
    } finally {
      await t.context.close();
    }
  });

  test("Meta+Enter; follows the page's dark theme; typing on in the editor never rates", async () => {
    const t = await open(); // system is light
    try {
      await t.page.evaluate(() => document.documentElement.classList.add('dark')); // LeetCode's own dark mode
      await t.page.focus('#editor');
      await t.page.keyboard.press('Control+End');
      await t.page.keyboard.press('Meta+Enter');
      t.accept(2003);
      // Keep typing while the judge runs and after the prompt appears.
      let typed = '';
      const end = Date.now() + 6000;
      while ((await t.prompt.count()) === 0 && Date.now() < end) {
        await t.page.keyboard.type('x');
        typed += 'x';
        await sleep(150);
      }
      await t.prompt.locator('.card').waitFor({ timeout: 1000 });
      const bg = await t.prompt.locator('.card').evaluate((el) => getComputedStyle(el).backgroundColor);
      assert.equal(bg, 'rgb(34, 35, 38)');
      await sleep(800);
      // Spaces and Enter would click a focused rating button; here they're text.
      await t.page.keyboard.type(' # tidy up', { delay: 40 });
      await t.page.keyboard.press('Enter');
      await t.page.keyboard.type('pass', { delay: 40 });
      typed += ' # tidy up\npass';
      const value = await t.page.$eval('#editor', (e) => e.value);
      assert.ok(value.endsWith(typed), `every key reached the editor: ${JSON.stringify(value.slice(-40))}`);
      assert.equal(await t.page.evaluate(() => document.activeElement.id), 'editor');
      assert.equal(await t.promptFocus(), null);
      assert.equal((await t.ofType('rate-pending')).length, 0, 'nothing rated');
      assert.equal(await t.prompt.locator('.question').textContent(), 'How hard did it feel?');

      // Rating from the keyboard is still one shortcut away.
      await t.page.keyboard.press('Alt+Shift+R');
      await t.page.keyboard.press('Enter');
      await t.waitFor(async () => (await t.ofType('rate-pending')).length, 3000, 'rate-pending');
      assert.equal((await t.ofType('rate-pending'))[0].rating, 'easy');
      await t.waitFor(async () => (await t.prompt.locator('.outcome').textContent()) !== '', 3000, 'confirmation');
      assert.equal(await t.page.evaluate(() => document.activeElement.id), 'editor', 'focus handed back');
      assert.deepEqual(t.errors, []);
    } finally {
      await t.context.close();
    }
  });

  test('Alt+Shift+R with no prompt open is left to the page', async () => {
    const t = await open();
    try {
      await t.page.focus('#editor');
      const prevented = await t.page.evaluate(() => {
        const e = new KeyboardEvent('keydown', { key: 'R', code: 'KeyR', altKey: true, shiftKey: true, bubbles: true, cancelable: true });
        document.getElementById('editor').dispatchEvent(e);
        return e.defaultPrevented;
      });
      assert.equal(prevented, false);
    } finally {
      await t.context.close();
    }
  });

  test("this machine's clock 3 minutes fast: the new solve still matches", async () => {
    const t = await open({ skewMs: -180 * 1000 });
    try {
      await t.page.click('[data-e2e-locator="console-submit-button"]');
      t.accept(7007);
      await t.prompt.locator('.card').waitFor({ timeout: 6000 });
      assert.equal((await t.ofType('leetcode-accepted'))[0].submission.submissionId, '7007');
    } finally {
      await t.context.close();
    }
  });

  test("this machine's clock 3 minutes slow: an older solve doesn't match a new submit", async () => {
    const t = await open({ skewMs: 180 * 1000 });
    try {
      // Accepted 3.5 min ago by LeetCode's clock: in our time that's 30 s in the
      // future, which a local-clock comparison would take for the new solve.
      t.accept(8008, 'two-sum', 'Two Sum', 210 * 1000);
      await t.page.click('[data-e2e-locator="console-submit-button"]'); // e.g. Wrong Answer this time
      await t.waitFor(() => t.acPolls().length >= 2, 6000, 'two polls');
      await sleep(200);
      assert.equal((await t.ofType('leetcode-accepted')).length, 0);
      // The real new solve does match.
      t.accept(8009);
      await t.prompt.locator('.card').waitFor({ timeout: 6000 });
      assert.equal((await t.ofType('leetcode-accepted'))[0].submission.submissionId, '8009');
    } finally {
      await t.context.close();
    }
  });

  test('Accepted result in the DOM triggers on its own', async () => {
    const t = await open();
    try {
      await sleep(300);
      // A non-accepted result first: no trigger.
      await t.page.evaluate(() => {
        const s = document.createElement('span');
        s.dataset.e2eLocator = 'submission-result';
        s.textContent = 'Wrong Answer';
        document.getElementById('result-area').append(s);
      });
      await sleep(2800);
      assert.equal(t.acPolls().length, 0);

      t.accept(3003);
      await t.page.evaluate(() => {
        document.querySelector('[data-e2e-locator="submission-result"]').textContent = 'Accepted';
      });
      await t.prompt.locator('.card').waitFor({ timeout: 6000 });
      assert.equal((await t.ofType('leetcode-accepted'))[0].submission.submissionId, '3003');
      assert.deepEqual(t.errors, []);
    } finally {
      await t.context.close();
    }
  });

  for (const status of ['already-rated', 'mastered', 'idle']) {
    test(`'${status}' → no prompt`, async () => {
      const t = await open({ responses: { 'leetcode-accepted': { status, pendingId: 'two-sum', tracked: true } } });
      try {
        await t.page.click('[data-e2e-locator="console-submit-button"]');
        t.accept(4004);
        await t.waitFor(async () => (await t.ofType('leetcode-accepted')).length, 6000, 'leetcode-accepted');
        await sleep(500);
        assert.equal(await t.prompt.count(), 0);
      } finally {
        await t.context.close();
      }
    });
  }

  test('Undo after a rating puts the question back; Alt+Shift+R reaches Undo from the editor', async () => {
    const t = await open();
    try {
      await t.page.focus('#editor');
      await t.page.keyboard.press('Control+Enter');
      t.accept(9101);
      await t.prompt.locator('.card').waitFor({ timeout: 6000 });
      await t.page.keyboard.press('Alt+Shift+R');
      await t.page.keyboard.press('Enter'); // Easy
      await t.waitFor(async () => /Undo/.test(await t.prompt.locator('.outcome').textContent()), 3000, 'confirmation');
      assert.equal(await t.page.evaluate(() => document.activeElement.id), 'editor');
      // The shortcut now goes to Undo.
      await t.page.keyboard.press('Alt+Shift+R');
      assert.equal(await t.promptFocus(), 'action');
      await t.page.keyboard.press('Enter');
      await t.waitFor(async () => (await t.ofType('undo')).length, 3000, 'undo');
      assert.deepEqual(await t.ofType('undo'), [{ type: 'undo', token: 'undo-rate' }]);
      await t.waitFor(async () => await t.prompt.locator('.question').isVisible(), 3000, 'asking again');
      assert.equal(await t.prompt.locator('.outcome').textContent(), '');
      assert.equal(await t.promptFocus(), 'easy');
      assert.equal(await t.prompt.locator('button.rate.easy').getAttribute('aria-disabled'), null);
      // And it can be rated again.
      await t.prompt.locator('button.rate.hard').click();
      await t.waitFor(async () => (await t.ofType('rate-pending')).length === 2, 3000, 'second rating');
      assert.deepEqual(t.errors, []);
    } finally {
      await t.context.close();
    }
  });

  test('"Mastered — stop reviewing" marks it mastered, with Undo', async () => {
    const t = await open();
    try {
      await t.page.click('[data-e2e-locator="console-submit-button"]');
      t.accept(9202);
      await t.prompt.locator('.card').waitFor({ timeout: 6000 });
      await t.prompt.locator('button.mastered').click();
      await t.waitFor(async () => (await t.ofType('master-pending')).length, 3000, 'master-pending');
      assert.deepEqual(await t.ofType('master-pending'), [{ type: 'master-pending', id: 'two-sum' }]);
      await t.waitFor(async () => (await t.prompt.locator('.outcome').textContent()) !== '', 3000, 'confirmation');
      assert.equal(await t.prompt.locator('.outcome').textContent(), 'Mastered. No more reviews of Two Sum. Undo');
      if (process.env.SHOTS) await t.prompt.screenshot({ path: path.join(OUT, 'prompt-mastered.png') });
      await t.prompt.locator('.outcome button.action').click();
      await t.waitFor(async () => (await t.ofType('undo')).length, 3000, 'undo');
      assert.deepEqual(await t.ofType('undo'), [{ type: 'undo', token: 'undo-master' }]);
    } finally {
      await t.context.close();
    }
  });

  test('a rating that reaches the longest interval offers Mastered', async () => {
    const t = await open({
      responses: { 'rate-pending': { status: 'ok', day: '2027-05-04', start: null, capped: true, undoToken: 'u1' } },
    });
    try {
      await t.page.click('[data-e2e-locator="console-submit-button"]');
      t.accept(9303);
      await t.prompt.locator('.card').waitFor({ timeout: 6000 });
      await t.prompt.locator('button.rate.easy').click();
      await t.waitFor(async () => (await t.prompt.locator('.outcome').textContent()) !== '', 3000, 'confirmation');
      assert.equal(
        await t.prompt.locator('.outcome').textContent(),
        "Saved: Easy. Next review Tue, May 4. That's the longest interval. Mark mastered · Undo",
      );
      if (process.env.SHOTS) await t.prompt.screenshot({ path: path.join(OUT, 'prompt-capped.png') });
      await t.prompt.locator('.outcome button.action', { hasText: 'Mark mastered' }).click();
      await t.waitFor(async () => (await t.ofType('master-pending')).length, 3000, 'master-pending');
      await t.waitFor(async () => /^Mastered\./.test(await t.prompt.locator('.outcome').textContent()), 3000, 'mastered');
      // Undoing Mastered goes back to the rating's confirmation, not to the buttons: the solve is rated.
      await t.prompt.locator('.outcome button.action', { hasText: 'Undo' }).click();
      await t.waitFor(async () => /^Saved: Easy\./.test(await t.prompt.locator('.outcome').textContent()), 3000, 'back to saved');
      assert.deepEqual(await t.ofType('undo'), [{ type: 'undo', token: 'undo-master' }]);
      assert.equal(await t.prompt.locator('.question').isVisible(), false);
      // And that confirmation's Undo still undoes the rating.
      await t.prompt.locator('.outcome button.action', { hasText: 'Undo' }).click();
      await t.waitFor(async () => (await t.ofType('undo')).length === 2, 3000, 'second undo');
      assert.deepEqual((await t.ofType('undo'))[1], { type: 'undo', token: 'u1' });
      await t.waitFor(async () => await t.prompt.locator('.question').isVisible(), 3000, 'asking again');
    } finally {
      await t.context.close();
    }
  });

  test('Alt+Shift+R shows a focus ring on the button it focuses', async () => {
    const t = await open();
    try {
      await t.page.focus('#editor');
      await t.page.keyboard.press('Control+Enter');
      t.accept(9404);
      await t.prompt.locator('.card').waitFor({ timeout: 6000 });
      await t.page.keyboard.press('Alt+Shift+R');
      const outline = await t.prompt.locator('button.rate.easy').evaluate((el) => getComputedStyle(el).outlineStyle);
      assert.equal(outline, 'solid');
      if (process.env.SHOTS) await t.prompt.screenshot({ path: path.join(OUT, 'prompt-focus.png') });
      // A mouse click doesn't leave the keyboard ring on.
      await t.prompt.locator('button.later').hover();
      await t.page.mouse.down();
      assert.equal(await t.prompt.locator('.card').getAttribute('class'), 'card');
      await t.page.mouse.up();
    } finally {
      await t.context.close();
    }
  });

  test('tracked shows "Counts as a review"; Escape closes without rating', async () => {
    const t = await open({
      colorScheme: 'dark',
      responses: { 'leetcode-accepted': { status: 'queued', pendingId: 'two-sum', tracked: true, intervals: { easy: 18, okay: 11, hard: 1 } } },
    });
    try {
      await t.page.click('[data-e2e-locator="console-submit-button"]');
      t.accept(5005);
      await t.prompt.locator('.card').waitFor({ timeout: 6000 });
      assert.equal(await t.prompt.locator('.note').textContent(), 'Counts as a review.');
      // Each button shows this problem's own next interval.
      assert.deepEqual(await t.prompt.locator('button.rate').allTextContents(), ['Easy · 18d', 'Okay · 11d', 'Hard · 1d']);
      assert.equal(await t.prompt.locator('button.rate.easy').getAttribute('aria-label'), 'Easy, review again in 18 days');
      if (process.env.SHOTS) {
        await sleep(300);
        await t.page.screenshot({ path: path.join(OUT, 'prompt-dark-page.png') });
        await t.prompt.screenshot({ path: path.join(OUT, 'prompt-dark.png') });
      }
      // Escape on the page isn't ours (LeetCode and the editor use it)...
      await t.page.keyboard.press('Escape');
      await sleep(200);
      assert.equal(await t.prompt.count(), 1);
      // ...but inside the prompt it means Later.
      await t.page.keyboard.press('Alt+Shift+R');
      await t.page.keyboard.press('Escape');
      await t.waitFor(async () => (await t.prompt.count()) === 0, 1000, 'prompt closed');
      assert.equal((await t.ofType('rate-pending')).length, 0);
      // Focus returns to where it was (the Submit button).
      assert.equal(await t.page.evaluate(() => document.activeElement.dataset.e2eLocator), 'console-submit-button');
    } finally {
      await t.context.close();
    }
  });

  test('Later hides; SPA navigation uses the slug at trigger time', async () => {
    const t = await open();
    try {
      await t.page.evaluate(() => history.pushState({}, '', '/problems/add-two-numbers/description/'));
      await t.page.click('[data-e2e-locator="console-submit-button"]');
      t.accept(6006, 'add-two-numbers', 'Add Two Numbers');
      await t.prompt.locator('.card').waitFor({ timeout: 6000 });
      const [msg] = await t.ofType('leetcode-accepted');
      assert.equal(msg.submission.slug, 'add-two-numbers');
      assert.match(await t.prompt.locator('.title').textContent(), /Add Two Numbers/);
      await t.prompt.locator('button.later').click();
      await t.waitFor(async () => (await t.prompt.count()) === 0, 1000, 'prompt closed');
      assert.equal((await t.ofType('rate-pending')).length, 0);
    } finally {
      await t.context.close();
    }
  });

  test('text-only Submit button; "Submissions" and non-problem pages ignored', async () => {
    const t = await open();
    try {
      await t.page.evaluate(() => {
        for (const [id, text] of [['plain', 'Submit'], ['subs', 'Submissions']]) {
          const b = document.createElement('button');
          b.id = id;
          b.textContent = text;
          document.body.append(b);
        }
      });
      await t.page.evaluate(() => history.pushState({}, '', '/problemset/'));
      await t.page.click('[data-e2e-locator="console-submit-button"]'); // no problem in the URL
      await t.page.evaluate(() => history.pushState({}, '', '/problems/two-sum/'));
      await t.page.click('#subs'); // "Submissions" isn't a submit
      await sleep(2400);
      assert.equal(t.acPolls().length, 0);
      await t.page.click('#plain');
      await t.waitFor(() => t.acPolls().length === 1, 3500, 'poll');
    } finally {
      await t.context.close();
    }
  });

  test('signed out: no leetcode-user, submit stops after the user check', async () => {
    const t = await open({ signedIn: false });
    try {
      await sleep(800);
      assert.equal((await t.ofType('leetcode-user')).length, 0);
      await t.page.click('[data-e2e-locator="console-submit-button"]');
      await sleep(4600);
      assert.equal(t.acPolls().length, 0);
      const userChecks = t.server.requests.filter((r) => /userStatus/.test(r.body.query)).length;
      assert.equal(userChecks, 2); // on load, then once at the first poll; the loop stopped
    } finally {
      await t.context.close();
    }
  });

  // The worker adds the script to tabs open at install/update, which can race
  // the manifest's own injection: the second copy must do nothing.
  test('a second copy of the script in the same tab does nothing (one lookup, one prompt)', async () => {
    const t = await open();
    try {
      await t.page.addScriptTag({ path: SCRIPT });
      await t.waitFor(async () => (await t.ofType('leetcode-user')).length, 5000, 'leetcode-user');
      await sleep(500);
      assert.equal((await t.ofType('leetcode-user')).length, 1);
      assert.equal(t.server.requests.filter((r) => /userStatus/.test(r.body.query)).length, 1);
      await t.page.click('[data-e2e-locator="console-submit-button"]');
      t.accept(1001);
      await t.prompt.locator('.card').waitFor();
      await sleep(2500);
      assert.equal(await t.prompt.count(), 1);
      assert.equal((await t.ofType('leetcode-accepted')).length, 1);
      assert.deepEqual(t.errors, []);
    } finally {
      await t.context.close();
    }
  });

  test('orphaned script (chrome.runtime gone) does nothing and throws nothing', async () => {
    const t = await open();
    try {
      await t.page.evaluate(() => {
        Object.defineProperty(window.chrome, 'runtime', {
          get() {
            throw new Error('Extension context invalidated.');
          },
        });
      });
      const n = t.server.requests.length;
      await t.page.click('[data-e2e-locator="console-submit-button"]');
      await sleep(2400);
      assert.equal(t.server.requests.length, n);
      assert.deepEqual(t.errors, []);
    } finally {
      await t.context.close();
    }
  });
});
