// Smoke test: loads the extension (this repo) unpacked into Chromium and drives the
// worker, popup, options page and the leetcode.com content script.
//   npm run test:browser   (or: node test/browser/smoke.cjs; DARK=1 for dark-mode screenshots)
//   Screenshots go to test/browser/out/ (git-ignored).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const EXT = path.resolve(__dirname, '..', '..');
const DIR = path.join(__dirname, 'out');
fs.mkdirSync(DIR, { recursive: true });
const SHOT = (name) => path.join(DIR, `${name}${process.env.DARK ? '-dark' : ''}.png`);
// A fresh browser profile outside the extension folder for every run.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'releet-smoke-'));
const PAGE_HTML = fs.readFileSync(path.join(__dirname, 'fake-page.html'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 10000, label = 'condition') {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(150);
  }
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
    console.log('PASS', name);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
    console.log('FAIL', name, '\n   ', e.stack.split('\n').slice(0, 3).join('\n    '));
  }
}

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 420, height: 760 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    colorScheme: process.env.DARK ? 'dark' : 'light',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });

  const workerErrors = [];
  const pageErrors = [];
  const watchWorker = (w) =>
    w.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') workerErrors.push(`${m.type()}: ${m.text()}`);
    });
  ctx.on('serviceworker', watchWorker);
  const watchPage = (page, label) => {
    page.on('console', (m) => m.type() === 'error' && pageErrors.push(`${label} console: ${m.text()}`));
    page.on('pageerror', (e) => pageErrors.push(`${label} pageerror: ${e.message}`));
  };

  let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
  watchWorker(sw);
  const id = new URL(sw.url()).host;
  const base = `chrome-extension://${id}`;
  console.log('extension id', id);
  const getStore = (keys) => sw.evaluate((k) => chrome.storage.local.get(k), keys);

  // Fake leetcode.com for the content script part (and the worker, if routed).
  const server = { ac: [], requests: [] };
  await ctx.route('https://leetcode.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'POST' && url.pathname.replace(/\/$/, '') === '/graphql') {
      const body = JSON.parse(req.postData() || '{}');
      server.requests.push({ query: body.query, variables: body.variables, from: req.serviceWorker() ? 'worker' : 'page', frame: (() => { try { return req.frame().url(); } catch { return null; } })(), at: Date.now() });
      let data;
      if (/userStatus/.test(body.query)) data = { userStatus: { username: 'alice', isSignedIn: true } };
      else if (/recentAcSubmissionList/.test(body.query)) {
        data = { matchedUser: { username: 'alice' }, recentAcSubmissionList: server.ac.slice(0, body.variables?.limit ?? 20) };
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
    }
    if (req.method() === 'GET' && url.pathname.startsWith('/problems/')) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE_HTML });
    }
    return route.fulfill({ status: 404, body: '' });
  });

  await step('worker starts: install-time alarms exist, no leetcode alarm without username', async () => {
    const alarms = await waitFor(async () => {
      const list = await sw.evaluate(() => chrome.alarms.getAll());
      return list.some((a) => a.name === 'calendar-sync') && list;
    }, 10000, 'alarms');
    const names = alarms.map((a) => a.name).sort();
    assert.ok(names.includes('due-check'), names.join());
    assert.ok(names.includes('calendar-sync'), names.join());
    assert.ok(!names.includes('leetcode-sync'), names.join());
    assert.equal(alarms.find((a) => a.name === 'calendar-sync').periodInMinutes, 15);
  });

  await step('chrome://extensions reports no manifest/runtime errors', async () => {
    const page = await ctx.newPage();
    await page.goto('chrome://extensions');
    const info = await page.evaluate(async (extId) => {
      await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
      await chrome.developerPrivate.reload(extId, { failQuietly: true });
      await new Promise((r) => setTimeout(r, 2500));
      const i = await chrome.developerPrivate.getExtensionInfo(extId);
      return { manifestErrors: i.manifestErrors, runtimeErrors: i.runtimeErrors, installWarnings: i.installWarnings, state: i.state, permissions: i.permissions };
    }, id);
    await page.close();
    console.log('   extension state', info.state, 'install warnings', JSON.stringify(info.installWarnings));
    console.log('   permission messages', JSON.stringify(info.permissions?.simplePermissions?.map((p) => p.message)));
    assert.deepEqual(info.manifestErrors, []);
    assert.deepEqual(info.installWarnings, []);
    assert.deepEqual(info.runtimeErrors, []);
    // The reload replaced the worker.
    sw = await waitFor(() => ctx.serviceWorkers().find((w) => w.url().startsWith(base) && w !== sw), 10000, 'new worker');
  });

  const DAY = 24 * 3600 * 1000;
  await step('seeded problems get planned slots (back to back on a shared day)', async () => {
    await sw.evaluate((DAY) => {
      const sod = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
      const add = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
      const now = Date.now();
      const mk = (id, title, rating, solvedDaysAgo, interval) => {
        const solvedAt = now - solvedDaysAgo * DAY;
        return { id, title, url: `https://leetcode.com/problems/${id}/`, rating, solvedAt, dueAt: add(sod(solvedAt), interval), commitSha: null, source: 'leetcode', history: [{ at: solvedAt, rating, commitSha: null }] };
      };
      const problems = Object.fromEntries([
        mk('two-sum', 'Two Sum', 'medium', 2, 3), // due tomorrow
        mk('climbing-stairs', 'Climbing Stairs', 'hard', 0, 1), // due tomorrow, rated later → second block
        mk('valid-anagram', 'Valid Anagram', 'easy', 0, 7),
        mk('lru-cache', 'LRU Cache', 'hard', 3, 1), // overdue → no block
      ].map((p) => [p.id, p]));
      const pending = { 'merge-intervals': { id: 'merge-intervals', title: 'Merge Intervals', url: 'https://leetcode.com/problems/merge-intervals/', submittedAt: Math.max(sod(now), now - 3600e3) /* today, even just after midnight */, submissionId: '555', source: 'leetcode' } };
      return chrome.storage.local.set({ problems, pending });
    }, DAY);
    const { schedule } = await waitFor(async () => {
      const s = await getStore('schedule');
      return s.schedule?.entries?.['climbing-stairs'] && s;
    }, 10000, 'schedule');
    const e = schedule.entries;
    assert.deepEqual(Object.keys(e).sort(), ['climbing-stairs', 'two-sum', 'valid-anagram']);
    const local = await sw.evaluate((ms) => { const d = new Date(ms); return [d.getHours(), d.getMinutes()]; }, e['two-sum'].start);
    assert.deepEqual(local, [9, 0]);
    assert.equal(e['two-sum'].end - e['two-sum'].start, 40 * 60e3);
    assert.equal(e['climbing-stairs'].start, e['two-sum'].end);
    assert.equal(e['climbing-stairs'].end - e['climbing-stairs'].start, 60 * 60e3);
    assert.equal(e['two-sum'].title, 'Review: Two Sum');
    assert.equal(e['two-sum'].reminderMinutes, 15);
    const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
    assert.equal(badge, '2'); // 1 overdue + 1 pending
  });

  let popup;
  await step('popup renders lists, block times, download buttons, LeetCode status', async () => {
    popup = await ctx.newPage();
    watchPage(popup, 'popup');
    await popup.goto(`${base}/popup/popup.html`);
    await popup.locator('#pending-list .problem').first().waitFor();
    assert.match(await popup.locator('#pending-list').innerText(), /Merge Intervals/);
    const upcoming = await popup.locator('#upcoming-list').innerText();
    assert.match(upcoming, /Two Sum[\s\S]*due tomorrow · 9:00 AM/);
    assert.match(upcoming, /Climbing Stairs[\s\S]*due tomorrow · 9:40 AM/);
    assert.match(await popup.locator('#due-list').innerText(), /LRU Cache[\s\S]*2 days overdue/);
    assert.doesNotMatch(await popup.locator('#due-list').innerText(), /AM|PM/);
    assert.equal(await popup.locator('button:has-text("📅")').count(), 4);
    assert.match(await popup.locator('#sync-status').innerText(), /^LeetCode not connected: open leetcode\.com while signed in$/);
    // The old ⏰ "make due now" testing button is gone (Settings has a test notification instead).
    assert.equal(await popup.locator('button:has-text("⏰")').count(), 0);
    assert.equal(await popup.locator('#sync-now').isHidden(), true);
    assert.equal(await popup.locator('#calendar-status').isHidden(), true);
    await popup.screenshot({ path: SHOT('popup'), fullPage: true });
  });

  await step('📅 download uses the planned slot', async () => {
    const [download] = await Promise.all([
      popup.waitForEvent('download'),
      popup.locator('#upcoming-list li', { hasText: 'Climbing Stairs' }).locator('button:has-text("📅")').click(),
    ]);
    const file = await download.path();
    const ics = fs.readFileSync(file, 'utf8');
    assert.equal(download.suggestedFilename(), 'climbing-stairs-review.ics');
    assert.match(ics, /DTSTART:\d{8}T094000\r\n/);
    assert.match(ics, /DTEND:\d{8}T104000\r\n/);
    assert.match(ics, /SUMMARY:Review: Climbing Stairs/);
  });

  const send = (page, message) => page.evaluate((m) => chrome.runtime.sendMessage(m), message);

  await step('messages: rate-pending ok/gone, unconfigured calendars and LeetCode', async () => {
    const rated = await send(popup, { type: 'rate-pending', id: 'merge-intervals', rating: 'medium' });
    assert.equal(rated.status, 'ok', JSON.stringify(rated));
    assert.ok(Number.isFinite(rated.dueAt));
    assert.equal(rated.slot?.problemId, 'merge-intervals');
    assert.ok(Number.isFinite(rated.slot.start));
    assert.deepEqual(await send(popup, { type: 'rate-pending', id: 'merge-intervals', rating: 'medium' }), { status: 'gone' });
    const google = await send(popup, { type: 'calendar-connect', provider: 'google' });
    assert.equal(google.status, 'unconfigured');
    assert.match(google.error, /manifest\.json/);
    const outlook = await send(popup, { type: 'calendar-connect', provider: 'outlook' });
    assert.equal(outlook.status, 'unconfigured');
    assert.match(outlook.error, /lib\/config\.js/);
    assert.equal((await send(popup, { type: 'sync-now' })).status, 'unconfigured');
    assert.equal((await send(popup, { type: 'import-recent' })).status, 'unconfigured');
    const cal = await send(popup, { type: 'calendar-sync-now' });
    assert.equal(cal.status, 'ok');
    assert.equal(cal.plan.entries, 4);
    assert.equal((await send(popup, { type: 'nope' })) ?? null, null);
    await waitFor(async () => !(await popup.locator('#pending-section').isVisible()), 5000, 'pending hidden');
    assert.match(await popup.locator('#upcoming-list').innerText(), /Merge Intervals/);
  });

  await step('apple connect with unreachable iCloud fails cleanly and stores nothing', async () => {
    const r = await send(popup, { type: 'calendar-connect', provider: 'apple', credentials: { appleId: 'me@icloud.com', appPassword: 'abcd-efgh-ijkl-mnop' } });
    console.log('   apple connect →', JSON.stringify(r));
    assert.equal(r.status, 'error');
    assert.equal((await getStore('calendars')).calendars ?? null, null);
  });

  await step('popup: connected calendar hides 📅, shows status and Reconnect banner', async () => {
    await sw.evaluate(() =>
      chrome.storage.local.set({
        calendars: {
          apple: { connected: true, calendarId: 'https://p01-caldav.icloud.com/1/calendars/abc/', events: {}, lastSyncAt: null, lastError: 'Apple ID or app-specific password was rejected.', needsReconnect: true, account: 'me@icloud.com', auth: { appleId: 'me@icloud.com', appPassword: 'x' } },
        },
      }),
    );
    await popup.locator('.banner').waitFor();
    // The banner names the actual cause, not a generic "sign in again".
    assert.match(await popup.locator('.banner').innerText(), /iCloud Calendar: Apple ID or app-specific password was rejected\.\s*Reconnect/);
    assert.equal(await popup.locator('#calendar-status').innerText(), 'Calendar: Apple');
    assert.equal(await popup.locator('button:has-text("📅")').count(), 0);
    await popup.screenshot({ path: SHOT('popup-calendar'), fullPage: true });
    const [options] = await Promise.all([ctx.waitForEvent('page'), popup.locator('.banner button').click()]);
    await options.waitForLoadState();
    assert.equal(new URL(options.url()).pathname, '/options/options.html');
    await options.close();
  });

  let options;
  await step('options renders sections, setup-needed cards, schedule defaults', async () => {
    options = await ctx.newPage();
    watchPage(options, 'options');
    options.setViewportSize({ width: 900, height: 1000 });
    await options.goto(`${base}/options/options.html`);
    await options.locator('#card-apple').waitFor();
    for (const h of ['LeetCode', 'Calendars', 'Schedule']) assert.equal(await options.locator(`h2:text-is("${h}")`).count(), 1, h);
    for (const name of ['google', 'outlook']) {
      const card = options.locator(`#card-${name}`);
      assert.match(await card.innerText(), /One-time setup needed — see SETUP\.md/);
      assert.equal(await card.locator('button.connect').isDisabled(), true);
    }
    const apple = options.locator('#card-apple');
    assert.match(await apple.innerText(), /Connected as me@icloud\.com/);
    assert.match(await apple.innerText(), /password was rejected\. Reconnect to keep this calendar up to date\./);
    assert.doesNotMatch(await apple.innerText(), /Sign-in expired/);
    assert.equal(await apple.locator('input[type=email]').inputValue(), 'me@icloud.com');
    assert.equal(await apple.locator('button.connect').innerText(), 'Reconnect');
    assert.equal(await apple.locator('a[href="https://account.apple.com"]').count(), 1);
    assert.equal(await options.locator('#start-time').inputValue(), '09:00');
    assert.deepEqual(
      await Promise.all(['easy', 'medium', 'hard'].map((r) => options.locator(`#duration-${r}`).inputValue())),
      ['20', '40', '60'],
    );
    assert.equal(await options.locator('#reminder-text').innerText(), '15 minutes before');
    assert.match(await options.locator('#username-note').innerText(), /Not set\. Open \(or reload\) a leetcode\.com page/);
    assert.equal(await options.locator('#sync-now').isDisabled(), true);
    await options.screenshot({ path: SHOT('options'), fullPage: true });
  });

  await step('options: test notification shows the soonest review and changes nothing', async () => {
    const before = await getStore(['problems', 'schedule']);
    await options.click('#test-notification');
    await waitFor(async () => /^Sent/.test(await options.locator('#notification-status').innerText()), 5000, 'sent');
    assert.match(await options.locator('#notification-status').innerText(), /reminder for “LRU Cache”.*Nothing was changed/);
    const shown = await sw.evaluate(() => chrome.notifications.getAll());
    assert.ok(Object.hasOwn(shown, 'review:lru-cache'), JSON.stringify(shown));
    assert.deepEqual(await getStore(['problems', 'schedule']), before);
  });

  await step('options: keyboard focus survives a calendar save during a sync', async () => {
    await options.locator('#card-apple button.disconnect').focus();
    // A sync saves the calendars key after each event; here a save that changes only the event map.
    await sw.evaluate(async () => {
      const { calendars } = await chrome.storage.local.get('calendars');
      calendars.apple.events = { x: { id: 'x', day: '2026-01-01', start: 1, end: 2, hash: 'h' } };
      await chrome.storage.local.set({ calendars });
    });
    await sleep(300);
    assert.equal(await options.evaluate(() => document.activeElement?.dataset.action), 'disconnect');
    // A save the card does show (lastSyncAt) rebuilds it; focus goes to the new button.
    await sw.evaluate(async () => {
      const { calendars } = await chrome.storage.local.get('calendars');
      calendars.apple.lastSyncAt = Date.now();
      await chrome.storage.local.set({ calendars });
    });
    await waitFor(async () => /last synced just now/.test(await options.locator('#card-apple').innerText()), 5000, 'rerender');
    assert.equal(await options.evaluate(() => document.activeElement?.dataset.action), 'disconnect');
    assert.equal(await options.evaluate(() => document.activeElement?.closest('.calendar-card')?.id), 'card-apple');
    // The message line is one element for the card's lifetime (a live region that's kept).
    assert.equal(await options.locator('#card-apple p[role=status]').count(), 1);
  });

  await step('options: saving a username sets source manual, starts the 15-min check', async () => {
    server.ac = [{ id: '900', title: 'Two Sum', titleSlug: 'two-sum', timestamp: String(Math.floor(Date.now() / 1000) - 7200) }];
    await options.fill('#username-input', '@alice');
    await options.click('#username-form button[type=submit]');
    const { settings } = await waitFor(async () => {
      const s = await getStore('settings');
      return s.settings?.leetcodeUsername === 'alice' && s;
    }, 5000, 'settings');
    assert.equal(settings.leetcodeUsernameSource, 'manual');
    const status = await waitFor(async () => {
      const t = await options.locator('#leetcode-status').innerText();
      return t && t !== 'Checking…' && t;
    }, 30000, 'check result');
    console.log('   check result:', status, '| worker requests to leetcode routed:', server.requests.filter((r) => r.from === 'worker').length);
    const alarm = await sw.evaluate(() => chrome.alarms.get('leetcode-sync'));
    assert.equal(alarm?.periodInMinutes, 15);
    assert.match(await options.locator('#username-note').innerText(), /Typed here/);
  });

  await step('options: schedule change moves upcoming blocks', async () => {
    await options.fill('#start-time', '08:30');
    await options.fill('#duration-medium', '45');
    await options.click('#schedule-form button[type=submit]');
    await waitFor(async () => (await options.locator('#schedule-status').innerText()).startsWith('Saved'), 5000, 'saved');
    const { schedule } = await waitFor(async () => {
      const s = await getStore('schedule');
      return s.schedule?.layoutKey?.startsWith('08:30') && s;
    }, 10000, 'replanned schedule');
    const e = schedule.entries;
    const local = await sw.evaluate((ms) => { const d = new Date(ms); return [d.getHours(), d.getMinutes()]; }, e['two-sum'].start);
    assert.deepEqual(local, [8, 30]);
    assert.equal(e['two-sum'].end - e['two-sum'].start, 45 * 60e3);
    assert.equal(e['climbing-stairs'].start, e['two-sum'].end);
    assert.match(await popup.locator('#upcoming-list').innerText(), /Two Sum[\s\S]*due tomorrow · 8:30 AM/);
    const bad = await options.evaluate(() => {
      document.querySelector('#duration-easy').value = '2';
      document.querySelector('#schedule-form').requestSubmit();
      return new Promise((r) => setTimeout(() => r(document.querySelector('#duration-easy').validationMessage), 300));
    });
    assert.ok(bad, 'native validation blocks 2 minutes');
  });

  await step('options: disconnect failure offers "Disconnect anyway" → force keeps only a leftover record', async () => {
    options.on('dialog', (d) => d.accept());
    await options.locator('#card-apple button.disconnect').click();
    await options.locator('#card-apple button.force-disconnect').waitFor({ timeout: 40000 });
    console.log('   disconnect error:', await options.locator('#card-apple p[role=status]').innerText());
    await options.locator('#card-apple button.force-disconnect').click();
    // The calendar couldn't be deleted, so its id and events are kept (no password) for a later Connect.
    const left = await waitFor(async () => {
      const apple = (await getStore('calendars')).calendars?.apple;
      return apple && apple.connected === false && apple;
    }, 10000, 'apple left behind');
    assert.equal(left.calendarId, 'https://p01-caldav.icloud.com/1/calendars/abc/');
    assert.deepEqual(left.auth, { appleId: 'me@icloud.com' });
    await waitFor(async () => /Not connected/.test(await options.locator('#card-apple').innerText()), 5000, 'card');
    await waitFor(async () => (await popup.locator('button:has-text("📅")').count()) > 0, 5000, 'popup 📅 back');
    assert.equal(await popup.locator('.banner').count(), 0);
  });

  await step('content script on leetcode.com → worker → in-page prompt → rating with slot', async () => {
    const page = await ctx.newPage();
    watchPage(page, 'leetcode');
    page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('https://leetcode.com/problems/two-sum/description/');
    await waitFor(() => server.requests.some((r) => r.from === 'page' && /userStatus/.test(r.query)), 8000, 'userStatus');
    await page.click('[data-e2e-locator="console-submit-button"]');
    server.ac.unshift({ id: '1001', title: 'Two Sum', titleSlug: 'two-sum', timestamp: String(Math.floor(Date.now() / 1000)) });
    const prompt = page.locator('releet-prompt');
    await prompt.locator('.card').waitFor({ timeout: 15000 });
    assert.match(await prompt.locator('.title').innerText(), /Accepted — Two Sum/);
    assert.match(await prompt.locator('.card').innerText(), /Counts as a review/);
    const { pending } = await getStore('pending');
    assert.equal(pending['two-sum']?.submissionId, '1001');
    await page.screenshot({ path: SHOT('leetcode-prompt') });
    // The prompt doesn't take focus from the page.
    assert.equal(await page.evaluate(() => document.querySelector('releet-prompt').shadowRoot.activeElement), null);
    // The worker sees this tab's problem with the host permission alone (no "tabs"
    // permission), so a background check can leave this solve to the page's prompt.
    const tabUrls = await sw.evaluate(async () =>
      (await chrome.tabs.query({ url: 'https://leetcode.com/problems/*' })).map((t) => t.url),
    );
    assert.deepEqual(tabUrls, ['https://leetcode.com/problems/two-sum/description/']);
    // The content script's world can't read or write extension storage (calendar sign-ins live there);
    // its messages still work.
    const cdp = await ctx.newCDPSession(page);
    const contexts = [];
    cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
    await cdp.send('Runtime.enable');
    const isolated = await waitFor(() => contexts.find((c) => c.auxData?.type === 'isolated' && c.origin?.includes(id)) ?? contexts.find((c) => c.name === 'ReLeet'), 5000, 'isolated world');
    const probe = async (expression) => (await cdp.send('Runtime.evaluate', { contextId: isolated.id, expression, awaitPromise: true, returnByValue: true })).result.value;
    const read = await probe(`chrome.storage.local.get('calendars').then(() => 'read ok', (e) => String(e.message))`);
    console.log('   content script storage read →', read);
    assert.match(read, /not allowed/i);
    assert.match(await probe(`chrome.storage.local.set({ x: 1 }).then(() => 'write ok', (e) => String(e.message))`), /not allowed/i);
    assert.equal(await probe(`chrome.runtime.sendMessage({ type: 'leetcode-user', username: 'alice' }).then((r) => JSON.stringify(r))`), '{"changed":false}');
    await cdp.detach();
    await prompt.locator('button.rate.medium').click();
    await waitFor(async () => /Next review/.test(await prompt.locator('.card').innerText()), 8000, 'confirmation');
    const text = await prompt.locator('.card').innerText();
    console.log('   prompt says:', text.replace(/\s+/g, ' '));
    assert.match(text, /Saved as Medium\./);
    if (!/9:15 AM/.test(text)) console.log('   schedule:', JSON.stringify((await getStore('schedule')).schedule.entries, null, 0), JSON.stringify((await getStore('calendars')).calendars));
    assert.match(text, /Next review \w{3}, \w{3} \d{1,2} · 9:15 AM/);
    const { problems } = await getStore('problems');
    assert.equal(problems['two-sum'].history.length, 2);
    // Merge Intervals (rated earlier, same review day) holds 8:30–9:15, so Two Sum follows it.
    const { schedule } = await getStore('schedule');
    assert.equal(schedule.entries['two-sum'].start, schedule.entries['merge-intervals'].end);
    assert.equal((await getStore('pending')).pending['two-sum'], undefined);
    await page.screenshot({ path: SHOT('leetcode-confirm') });
    await page.close();
  });

  await step('a leetcode.com tab open across an extension reload gets a working script (one prompt)', async () => {
    const page = await ctx.newPage();
    watchPage(page, 'leetcode-old-tab');
    page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('https://leetcode.com/problems/house-robber/description/');
    // This tab's lookups only (the earlier two-sum tab made one too).
    const userLookups = () =>
      server.requests.filter((r) => r.from === 'page' && /userStatus/.test(r.query) && /house-robber/.test(r.frame ?? '')).length;
    await waitFor(() => userLookups() > 0, 8000, 'userStatus');
    const before = userLookups();
    // Same as the reload button on chrome://extensions (and what an update does).
    const ext = await ctx.newPage();
    await ext.goto('chrome://extensions');
    await ext.evaluate((extId) => chrome.developerPrivate.reload(extId, { failQuietly: true }), id);
    await ext.close();
    const old = sw;
    sw = await waitFor(() => ctx.serviceWorkers().find((w) => w.url().startsWith(base) && w !== old), 10000, 'new worker');
    watchWorker(sw);
    // onInstalled ('update') added a fresh copy to the open tab: it looks up the user as it starts.
    await waitFor(() => userLookups() > before, 10000, 'injected copy');
    // Injecting again (e.g. racing the manifest's own injection) is a no-op.
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://leetcode.com/problems/house-robber/*' }))[0].id);
    await sw.evaluate((tabId) => chrome.scripting.executeScript({ target: { tabId }, files: ['content/leetcode.js'] }), tabId);
    await sleep(500);
    if (userLookups() !== before + 1) console.log('   lookups:', JSON.stringify(server.requests.filter((r) => /userStatus/.test(r.query)).map((r) => [r.from, r.frame, r.at])));
    assert.equal(userLookups(), before + 1);
    await page.bringToFront();
    await page.click('[data-e2e-locator="console-submit-button"]');
    server.ac.unshift({ id: '2002', title: 'House Robber', titleSlug: 'house-robber', timestamp: String(Math.floor(Date.now() / 1000)) });
    await page.locator('releet-prompt .card').waitFor({ timeout: 15000 });
    await sleep(1000);
    assert.equal(await page.locator('releet-prompt').count(), 1);
    assert.equal((await getStore('pending')).pending?.['house-robber']?.submissionId, '2002');
    await page.close();
  });

  await step('no worker or page console errors', async () => {
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(workerErrors, []);
  });

  await ctx.close();
  const failed = results.filter((r) => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
