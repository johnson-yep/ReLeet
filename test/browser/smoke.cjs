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
    if (req.method() === 'GET' && url.pathname.startsWith('/problemset')) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Problems</title>' });
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
    // Installing opened the welcome page (the reload in the next step closes it).
    const welcome = await waitFor(() => ctx.pages().find((p) => p.url() === `${base}/welcome/welcome.html`), 10000, 'welcome tab');
    watchPage(welcome, 'welcome');
    await welcome.setViewportSize({ width: 900, height: 1300 });
    await welcome.locator('#leetcode-status').waitFor();
    assert.equal(await welcome.locator('#leetcode-status').innerText(), 'Waiting for you to sign in…');
    assert.equal(await welcome.locator('#import').isDisabled(), true);
    assert.equal(await welcome.locator('#card-google').isHidden(), true); // placeholder client id
    assert.equal(await welcome.locator('#daily-limit').inputValue(), '60');
    await welcome.screenshot({ path: SHOT('welcome'), fullPage: true });
    await welcome.close();
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
  const send = (page, message) => page.evaluate((m) => chrome.runtime.sendMessage(m), message);
  const localTime = (ms) => sw.evaluate((ms) => { const d = new Date(ms); return [d.getHours(), d.getMinutes()]; }, ms);
  const dayFromToday = (n) => sw.evaluate((n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }, n);

  let popup;
  await step('a new user sees one card in the popup', async () => {
    popup = await ctx.newPage();
    watchPage(popup, 'popup');
    await popup.setViewportSize({ width: 380, height: 640 });
    await popup.goto(`${base}/popup/popup.html`);
    await popup.locator('#empty').waitFor();
    assert.match(await popup.locator('#empty').innerText(), /Solve a problem on LeetCode and ReLeet will ask how it felt\./);
    assert.equal(await popup.locator('#stats').isHidden(), true);
    assert.equal(await popup.locator('#leetcode-status a').innerText(), 'LeetCode not connected');
    await popup.screenshot({ path: SHOT('popup-empty'), fullPage: true });
  });

  await step('seeded problems get review days under the daily limit; overdue ones are booked today', async () => {
    await sw.evaluate((DAY) => {
      const sod = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
      const add = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
      const key = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
      const now = Date.now();
      const mk = (id, title, rating, solvedDaysAgo, interval) => {
        const solvedAt = now - solvedDaysAgo * DAY;
        const dueAt = add(sod(solvedAt), interval);
        return { id, title, url: `https://leetcode.com/problems/${id}/`, rating, interval, solvedAt, dueAt, dueDay: key(dueAt), commitSha: null, source: 'leetcode', history: [{ at: solvedAt, rating, commitSha: null }] };
      };
      const problems = Object.fromEntries([
        mk('two-sum', 'Two Sum', 'okay', 2, 3), // due tomorrow
        mk('climbing-stairs', 'Climbing Stairs', 'hard', 0, 1), // due tomorrow, rated later: no room left, so the day after
        mk('valid-anagram', 'Valid Anagram', 'easy', 0, 7),
        mk('lru-cache', 'LRU Cache', 'hard', 3, 1), // two days overdue: booked today, first in line
      ].map((p) => [p.id, p]));
      const pending = { 'merge-intervals': { id: 'merge-intervals', title: 'Merge Intervals', url: 'https://leetcode.com/problems/merge-intervals/', submittedAt: Math.max(sod(now), now - 3600e3) /* today, even just after midnight */, submissionId: '555', source: 'leetcode' } };
      return chrome.storage.local.set({ problems, pending });
    }, DAY);
    const { schedule } = await waitFor(async () => {
      const s = await getStore('schedule');
      return s.schedule?.entries?.['lru-cache'] && s;
    }, 10000, 'schedule');
    const e = schedule.entries;
    assert.deepEqual(Object.keys(e).sort(), ['climbing-stairs', 'lru-cache', 'two-sum', 'valid-anagram']);
    assert.deepEqual(await localTime(e['two-sum'].start), [9, 0]);
    assert.equal(e['two-sum'].day, await dayFromToday(1));
    assert.equal(e['two-sum'].end - e['two-sum'].start, 40 * 60e3);
    assert.equal(e['climbing-stairs'].day, await dayFromToday(2)); // 40 + 60 minutes don't fit in 60
    assert.equal(e['climbing-stairs'].dueDay, await dayFromToday(1));
    assert.equal(e['lru-cache'].day, await dayFromToday(0));
    assert.equal(e['lru-cache'].overdueSince, await dayFromToday(-2));
    assert.equal(e['two-sum'].title, 'Review: Two Sum');
    assert.equal(e['two-sum'].reminderMinutes, 15);
    const badge = await waitFor(async () => (await sw.evaluate(() => chrome.action.getBadgeText({}))) || null, 5000, 'badge');
    assert.equal(badge, '2'); // LRU Cache due today + Merge Intervals to rate
  });

  await step('popup: stats, To rate, Due today with real intervals, Upcoming by day', async () => {
    await popup.locator('#to-rate .row').first().waitFor();
    assert.equal(await popup.locator('#stats').innerText(), '4 tracked · 1 due today · 1-day streak');
    assert.equal(await popup.locator('#to-rate-title').innerText(), 'TO RATE (1)');
    assert.match(await popup.locator('#to-rate').innerText(), /Merge Intervals[\s\S]*solved/);
    const due = popup.locator('#due .row');
    assert.match(await due.innerText(), /LRU Cache\s*2 days overdue/);
    // Hard, 1-day interval: Easy × 2.5 = 3 (rounded), Okay × 1.5 = 2, Hard = 1.
    assert.deepEqual(await due.locator('button.rate').allInnerTexts(), ['Easy · 3d', 'Okay · 2d', 'Hard · 1d']);
    assert.equal(await due.locator('button.rate.easy').getAttribute('aria-label'), 'Rate LRU Cache: Easy, next review in 3 days');
    const upcoming = await popup.locator('#upcoming').innerText();
    assert.match(upcoming, /Tomorrow · 1 review · 40 min\s*Two Sum\s*9:00 AM/);
    assert.match(upcoming, /Climbing Stairs\s*9:00 AM/);
    assert.equal(await popup.locator('#leetcode-status a').innerText(), 'LeetCode not connected');
    // Every button has a name.
    const unnamed = await popup.evaluate(() => [...document.querySelectorAll('button')].filter((b) => !b.hidden && !(b.getAttribute('aria-label') || b.textContent.trim())).length);
    assert.equal(unnamed, 0);
    await popup.screenshot({ path: SHOT('popup-busy'), fullPage: true });
  });

  await step('popup: the ⋯ menu adds a review to a calendar app with its planned block', async () => {
    const row = popup.locator('#upcoming li', { hasText: 'Climbing Stairs' });
    await row.locator('button[data-action=menu]').click();
    assert.deepEqual(await row.locator('.menu button').allInnerTexts(), ['Mark mastered', 'Add to calendar (.ics)', 'Stop tracking']);
    const [download] = await Promise.all([popup.waitForEvent('download'), row.locator('.menu button[data-action=download]').click()]);
    const ics = fs.readFileSync(await download.path(), 'utf8');
    assert.equal(download.suggestedFilename(), 'climbing-stairs-review.ics');
    assert.match(ics, /DTSTART:\d{8}T090000\r\n/);
    assert.match(ics, /DTEND:\d{8}T100000\r\n/);
    assert.match(ics, /SUMMARY:Review: Climbing Stairs/);
  });

  await step('popup: rating shows "Saved" with Undo, and Undo puts the solve back', async () => {
    await popup.locator('#to-rate li', { hasText: 'Merge Intervals' }).locator('button.rate.okay').click();
    await popup.locator('#toast').waitFor();
    assert.match(await popup.locator('#toast').innerText(), /^Saved: Okay\. Next review \w{3}, \w{3} \d{1,2} at \d{1,2}:\d{2} [AP]M\.\s*Undo$/);
    assert.equal(await popup.locator('#toast strong').innerText(), 'Saved: Okay.');
    await waitFor(async () => popup.locator('#to-rate').isHidden(), 5000, 'To rate empty');
    await popup.screenshot({ path: SHOT('popup-toast'), fullPage: true });
    await popup.locator('#toast button', { hasText: 'Undo' }).click();
    await waitFor(async () => (await getStore('pending')).pending?.['merge-intervals'], 5000, 'pending back');
    assert.equal((await getStore('problems')).problems['merge-intervals'], undefined);
    await popup.locator('#to-rate li', { hasText: 'Merge Intervals' }).waitFor();
  });

  await step('popup: Mark mastered moves a problem to Mastered; Resume brings it back', async () => {
    const row = popup.locator('#upcoming li', { hasText: 'Valid Anagram' });
    await row.locator('button[data-action=menu]').click();
    await row.locator('.menu button[data-action=master]').click();
    await popup.locator('#mastered').waitFor();
    assert.match(await popup.locator('#toast').innerText(), /Valid Anagram is mastered/);
    assert.equal(await popup.locator('#mastered-title').innerText(), 'Mastered (1)');
    assert.match(await popup.locator('#stats').innerText(), /3 tracked · 1 due today · 1 mastered/);
    await waitFor(async () => !(await getStore('schedule')).schedule.entries['valid-anagram'], 5000, 'no block for a mastered problem');
    await popup.locator('#mastered summary').click();
    await popup.locator('#mastered button[data-action=resume]').click();
    await waitFor(async () => popup.locator('#mastered').isHidden(), 5000, 'mastered list gone');
    assert.match(await popup.locator('#toast').innerText(), /Valid Anagram is back\. Next review/);
    const p = (await getStore('problems')).problems['valid-anagram'];
    assert.equal(p.masteredAt, undefined);
    assert.equal(p.dueDay, await dayFromToday(7));
  });

  await step('popup: Stop tracking has Undo instead of a dialog', async () => {
    const row = popup.locator('#upcoming li', { hasText: 'Valid Anagram' });
    await row.locator('button[data-action=menu]').click();
    await row.locator('.menu button[data-action=stop]').click();
    await waitFor(async () => !(await getStore('problems')).problems['valid-anagram'], 5000, 'deleted');
    await popup.locator('#toast button', { hasText: 'Undo' }).click();
    await waitFor(async () => (await getStore('problems')).problems['valid-anagram'], 5000, 'restored');
  });

  await step('messages: rate-pending ok/gone, unconfigured Google, no Outlook, LeetCode not set', async () => {
    const rated = await send(popup, { type: 'rate-pending', id: 'merge-intervals', rating: 'okay' });
    assert.equal(rated.status, 'ok', JSON.stringify(rated));
    assert.equal(rated.day, await dayFromToday(3));
    assert.ok(Number.isFinite(rated.start));
    assert.equal(rated.capped, false);
    assert.equal(typeof rated.undoToken, 'string');
    assert.deepEqual(await send(popup, { type: 'rate-pending', id: 'merge-intervals', rating: 'okay' }), { status: 'gone' });
    const google = await send(popup, { type: 'calendar-connect', provider: 'google' });
    assert.equal(google.status, 'unconfigured');
    assert.match(google.error, /isn't available/);
    assert.equal((await send(popup, { type: 'calendar-connect', provider: 'outlook' })).status, 'error');
    assert.equal((await send(popup, { type: 'sync-now' })).status, 'unconfigured');
    assert.equal((await send(popup, { type: 'import-recent' })).status, 'unconfigured');
    const cal = await send(popup, { type: 'calendar-sync-now' });
    assert.equal(cal.status, 'ok');
    assert.equal(cal.plan.entries, 5);
    assert.equal((await send(popup, { type: 'nope' })) ?? null, null);
  });

  await step('apple connect without the iCloud permission fails cleanly and stores nothing', async () => {
    const r = await send(popup, { type: 'calendar-connect', provider: 'apple', credentials: { appleId: 'me@icloud.com', appPassword: 'abcd-efgh-ijkl-mnop' } });
    assert.deepEqual(r, { status: 'error', error: 'ReLeet needs your permission to reach iCloud.' });
    assert.equal((await getStore('calendars')).calendars ?? null, null);
  });

  await step('popup: a calendar that needs signing in shows Reconnect, and the .ics item goes', async () => {
    await sw.evaluate(() =>
      chrome.storage.local.set({
        calendars: {
          apple: { connected: true, calendarId: 'https://p01-caldav.icloud.com/1/calendars/abc/', events: {}, lastSyncAt: null, lastError: 'Apple ID or app-specific password was rejected.', needsReconnect: true, account: 'me@icloud.com', auth: { appleId: 'me@icloud.com', appPassword: 'x' } },
        },
      }),
    );
    await popup.locator('.banner').waitFor();
    assert.match(await popup.locator('.banner').innerText(), /Apple Calendar needs you to sign in again\.\s*Reconnect/);
    const row = popup.locator('#upcoming li', { hasText: 'Two Sum' });
    await row.locator('button[data-action=menu]').click();
    assert.deepEqual(await row.locator('.menu button').allInnerTexts(), ['Mark mastered', 'Stop tracking']);
    await popup.keyboard.press('Escape');
    await popup.screenshot({ path: SHOT('popup-calendar'), fullPage: true });
    const [options] = await Promise.all([ctx.waitForEvent('page'), popup.locator('.banner button').click()]);
    await options.waitForLoadState();
    assert.equal(new URL(options.url()).pathname, '/options/options.html');
    await options.close();
  });

  let options;
  await step('Settings: sections in order, Apple card, schedule defaults, plain words', async () => {
    options = await ctx.newPage();
    watchPage(options, 'options');
    await options.setViewportSize({ width: 900, height: 1000 });
    await options.goto(`${base}/options/options.html`);
    await options.locator('#card-apple').waitFor();
    assert.deepEqual(await options.locator('h2').allInnerTexts(), ['LeetCode', 'Schedule', 'Calendars', 'Notifications', 'This computer', 'Privacy and your data']);
    assert.equal(await options.locator('#card-google').isHidden(), true);
    const apple = options.locator('#card-apple');
    assert.match(await apple.innerText(), /Connected as me@icloud\.com/);
    assert.match(await apple.innerText(), /password was rejected\. Reconnect to keep this calendar up to date\./);
    assert.equal(await apple.locator('input[type=email]').inputValue(), 'me@icloud.com');
    assert.equal(await apple.locator('button[data-action=connect]').innerText(), 'Reconnect');
    assert.equal(await options.locator('#start-time').inputValue(), '09:00');
    assert.equal(await options.locator('#daily-limit').inputValue(), '60');
    assert.deepEqual(await Promise.all(['easy', 'okay', 'hard'].map((r) => options.locator(`#duration-${r}`).inputValue())), ['20', '40', '60']);
    assert.equal(await options.locator('#reminder-text').innerText(), '15 minutes before');
    assert.equal(await options.locator('#daily-summary').isChecked(), true);
    assert.equal(await options.locator('#sync-now').isDisabled(), true);
    assert.equal(await options.locator('#idle-banner').isHidden(), true);
    assert.equal(await options.locator('button[type=submit]').count(), 0); // no Save buttons
    const text = await options.locator('main').innerText();
    for (const word of ['SETUP.md', 'CalDAV', 'chrome://', 'Last error', 'Outlook']) assert.ok(!text.includes(word), word);
    await options.screenshot({ path: SHOT('options'), fullPage: true });
  });

  await step('Settings: the test notification is the daily summary, and changes nothing', async () => {
    const before = await getStore(['problems', 'schedule', 'dailySummary']);
    await options.click('#test-notification');
    await waitFor(async () => /^Sent/.test(await options.locator('#notification-status').innerText()), 5000, 'sent');
    await waitFor(async () => Object.hasOwn(await sw.evaluate(() => chrome.notifications.getAll()), 'daily-summary'), 5000, 'notification shown');
    assert.deepEqual(await getStore(['problems', 'schedule', 'dailySummary']), before);
  });

  await step('Settings: keyboard focus survives a calendar save during a sync', async () => {
    await options.locator('#card-apple button[data-action=disconnect]').focus();
    await sw.evaluate(async () => {
      const { calendars } = await chrome.storage.local.get('calendars');
      calendars.apple.events = { x: { id: 'x', day: '2026-01-01', start: 1, end: 2, hash: 'h' } };
      await chrome.storage.local.set({ calendars });
    });
    await sleep(300);
    assert.equal(await options.evaluate(() => document.activeElement?.dataset.action), 'disconnect');
    await sw.evaluate(async () => {
      const { calendars } = await chrome.storage.local.get('calendars');
      calendars.apple.lastSyncAt = Date.now();
      await chrome.storage.local.set({ calendars });
    });
    await waitFor(async () => /updated just now/.test(await options.locator('#card-apple').innerText()), 5000, 'rerender');
    assert.equal(await options.evaluate(() => document.activeElement?.dataset.action), 'disconnect');
    assert.equal(await options.locator('#card-apple p[role=status]').count(), 1);
  });

  await step('Settings: a typed username saves itself and starts the 15-minute check', async () => {
    server.ac = [{ id: '900', title: 'Two Sum', titleSlug: 'two-sum', timestamp: String(Math.floor(Date.now() / 1000) - 7200) }];
    await options.fill('#username-input', '@alice');
    const { settings } = await waitFor(async () => {
      const s = await getStore('settings');
      return s.settings?.leetcodeUsername === 'alice' && s;
    }, 5000, 'settings');
    assert.equal(settings.leetcodeUsernameSource, 'manual');
    await waitFor(async () => (await options.locator('.saved[data-for="username-input"]').innerText()) === 'Saved', 3000, 'Saved note');
    const alarm = await waitFor(() => sw.evaluate(() => chrome.alarms.get('leetcode-sync')), 5000, 'alarm');
    assert.equal(alarm.periodInMinutes, 15);
    await options.locator('#start-time').focus(); // leave the username field
    assert.match(await options.locator('#username-note').innerText(), /Typed here/);
  });

  await step('Settings: schedule changes save as they happen and move upcoming blocks', async () => {
    await options.fill('#start-time', '08:30');
    await options.locator('#start-time').dispatchEvent('change');
    await options.fill('#duration-okay', '45');
    const { schedule } = await waitFor(async () => {
      const s = await getStore('schedule');
      return s.schedule?.layoutKey?.startsWith('08:30|easy=20,okay=45') && s;
    }, 10000, 'replanned schedule');
    assert.deepEqual(await localTime(schedule.entries['two-sum'].start), [8, 30]);
    assert.equal(schedule.entries['two-sum'].end - schedule.entries['two-sum'].start, 45 * 60e3);
    await waitFor(async () => /Two Sum\s*8:30 AM/.test(await popup.locator('#upcoming').innerText()), 5000, 'popup follows');
    // A bad value is pointed out and not saved.
    await options.fill('#duration-easy', '2');
    await waitFor(async () => !(await options.locator('#durations-error').isHidden()), 3000, 'inline error');
    assert.match(await options.locator('#durations-error').innerText(), /whole minutes from 5 to 240/);
    assert.equal(await options.locator('#duration-easy').getAttribute('aria-invalid'), 'true');
    assert.equal((await getStore('settings')).settings.durations.easy, 20);
    await options.fill('#duration-easy', '20');
  });

  await step('Settings: a bigger daily limit brings a moved review back to its own day', async () => {
    assert.equal((await getStore('schedule')).schedule.entries['climbing-stairs'].day, await dayFromToday(2));
    await options.fill('#daily-limit', '120');
    const tomorrow = await dayFromToday(1);
    await waitFor(async () => (await getStore('schedule')).schedule.entries['climbing-stairs'].day === tomorrow, 10000, 'moved back');
  });

  await step('Settings: disconnect failure offers "Disconnect anyway" → force keeps only a leftover record', async () => {
    options.on('dialog', (d) => d.accept());
    await options.locator('#card-apple button[data-action=disconnect]').click();
    await options.locator('#card-apple button[data-action=force-disconnect]').waitFor({ timeout: 40000 });
    console.log('   disconnect error:', await options.locator('#card-apple p[role=status]').innerText());
    await options.locator('#card-apple button[data-action=force-disconnect]').click();
    const left = await waitFor(async () => {
      const apple = (await getStore('calendars')).calendars?.apple;
      return apple && apple.connected === false && apple;
    }, 10000, 'apple left behind');
    assert.equal(left.calendarId, 'https://p01-caldav.icloud.com/1/calendars/abc/');
    assert.deepEqual(left.auth, { appleId: 'me@icloud.com' });
    await waitFor(async () => (await options.locator('#card-apple button[data-action=connect]').innerText()) === 'Connect', 5000, 'card');
    assert.equal(await popup.locator('.banner').count(), 0);
  });

  await step('Settings: export has no sign-ins; importing it merges back', async () => {
    const [download] = await Promise.all([options.waitForEvent('download'), options.click('#export')]);
    assert.match(download.suggestedFilename(), /^releet-export-\d{4}-\d{2}-\d{2}\.json$/);
    const file = await download.path();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(data.format, 'releet-export');
    assert.deepEqual(Object.keys(data.problems).sort(), ['climbing-stairs', 'lru-cache', 'merge-intervals', 'two-sum', 'valid-anagram']);
    assert.equal(data.calendars.apple.calendarId, 'https://p01-caldav.icloud.com/1/calendars/abc/');
    assert.doesNotMatch(JSON.stringify(data), /appPassword|token/i);
    await options.setInputFiles('#import-file', file);
    await waitFor(async () => /^Imported 5 problems \(0 new/.test(await options.locator('#transfer-status').innerText()), 5000, 'imported');
  });

  await step('another computer becomes the main one: popup and Settings go idle; the page gets no prompt', async () => {
    await sw.evaluate(() => chrome.storage.sync.set({ mainComputer: { id: 'another-computer', claimedAt: Date.now() } }));
    await popup.locator('#idle').waitFor();
    assert.equal(await popup.locator('#main').isHidden(), true);
    await popup.screenshot({ path: SHOT('popup-idle'), fullPage: true });
    await options.locator('#idle-banner').waitFor();
    const accepted = await send(popup, { type: 'leetcode-accepted', submission: { submissionId: '1', slug: 'two-sum', title: 'Two Sum', timestamp: Date.now() } });
    assert.deepEqual(accepted, { status: 'idle' });
    await waitFor(async () => (await sw.evaluate(() => chrome.alarms.getAll())).length === 0, 5000, 'alarms cleared');
    // Use this computer instead, with a confirmation step.
    await popup.locator('#use-here').click();
    await popup.locator('#use-here-confirm').click();
    await popup.locator('#main').waitFor();
    await waitFor(() => sw.evaluate(() => chrome.alarms.get('calendar-sync')), 5000, 'active again');
    assert.equal(await options.locator('#idle-banner').isHidden(), true);
  });

  await step('content script on leetcode.com → worker → in-page prompt → rating → Undo', async () => {
    await sw.evaluate(() => chrome.storage.local.remove('pending'));
    const page = await ctx.newPage();
    watchPage(page, 'leetcode');
    page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('https://leetcode.com/problems/two-sum/description/');
    await waitFor(() => server.requests.some((r) => r.from === 'page' && /userStatus/.test(r.query)), 8000, 'userStatus');
    await page.click('[data-e2e-locator="console-submit-button"]');
    server.ac.unshift({ id: '1001', title: 'Two Sum', titleSlug: 'two-sum', timestamp: String(Math.floor(Date.now() / 1000)) });
    const prompt = page.locator('releet-prompt');
    await prompt.locator('.card').waitFor({ timeout: 15000 });
    assert.equal(await prompt.locator('.title').innerText(), '✓ Accepted: Two Sum');
    assert.match(await prompt.locator('.card').innerText(), /Counts as a review/);
    // Two Sum's interval is 3 days: Easy × 2.5 → 8, Okay × 1.5 → 5 (rounded), Hard → 1.
    assert.deepEqual(await prompt.locator('button.rate').allInnerTexts(), ['Easy · 8d', 'Okay · 5d', 'Hard · 1d']);
    assert.equal((await getStore('pending')).pending['two-sum']?.submissionId, '1001');
    await page.screenshot({ path: SHOT('leetcode-prompt') });
    assert.equal(await page.evaluate(() => document.querySelector('releet-prompt').shadowRoot.activeElement), null);
    // The worker sees this tab's problem with the host permission alone (no "tabs" permission).
    const tabUrls = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://leetcode.com/problems/two-sum/*' })).map((t) => t.url));
    assert.deepEqual(tabUrls, ['https://leetcode.com/problems/two-sum/description/']);
    // The content script's world can't read or write extension storage, or reach more than its prompt.
    const cdp = await ctx.newCDPSession(page);
    const contexts = [];
    cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
    await cdp.send('Runtime.enable');
    const isolated = await waitFor(() => contexts.find((c) => c.auxData?.type === 'isolated' && c.origin?.includes(id)) ?? contexts.find((c) => c.name === 'ReLeet'), 5000, 'isolated world');
    const probe = async (expression) => (await cdp.send('Runtime.evaluate', { contextId: isolated.id, expression, awaitPromise: true, returnByValue: true })).result.value;
    assert.match(await probe(`chrome.storage.local.get('calendars').then(() => 'read ok', (e) => String(e.message))`), /not allowed/i);
    assert.match(await probe(`chrome.storage.local.set({ x: 1 }).then(() => 'write ok', (e) => String(e.message))`), /not allowed/i);
    assert.equal(await probe(`chrome.runtime.sendMessage({ type: 'export-data' }).then((r) => JSON.stringify(r ?? null))`), 'null');
    await cdp.detach();
    await prompt.locator('button.rate.okay').click();
    await waitFor(async () => /Next review/.test(await prompt.locator('.card').innerText()), 8000, 'confirmation');
    const text = await prompt.locator('.outcome').innerText();
    console.log('   prompt says:', text.replace(/\s+/g, ' '));
    assert.match(text, /^Saved: Okay\. Next review \w{3}, \w{3} \d{1,2} at \d{1,2}:\d{2} [AP]M\.\s*Undo$/);
    const { problems } = await getStore('problems');
    assert.equal(problems['two-sum'].history.length, 2);
    assert.equal(problems['two-sum'].interval, 5);
    await page.screenshot({ path: SHOT('leetcode-confirm') });
    await prompt.locator('.outcome button.action').click();
    await waitFor(async () => (await getStore('pending')).pending?.['two-sum'], 5000, 'undone');
    assert.equal((await getStore('problems')).problems['two-sum'].history.length, 1);
    await prompt.locator('.question').waitFor();
    await page.close();
  });

  await step('the welcome page shows the detected username, and Done makes this the main computer', async () => {
    await sw.evaluate(() => chrome.storage.sync.remove('mainComputer'));
    const welcome = await ctx.newPage();
    watchPage(welcome, 'welcome');
    await welcome.setViewportSize({ width: 900, height: 1300 });
    await welcome.goto(`${base}/welcome/welcome.html`);
    await waitFor(async () => (await welcome.locator('#leetcode-status').innerText()) === 'Signed in as @alice ✓', 5000, 'signed in');
    assert.equal(await welcome.locator('#import').isDisabled(), false);
    await welcome.screenshot({ path: SHOT('welcome-signed-in'), fullPage: true });
    await welcome.click('#done');
    await waitFor(async () => (await sw.evaluate(() => chrome.storage.sync.get('mainComputer'))).mainComputer, 5000, 'claimed');
    await waitFor(() => welcome.url().startsWith('https://leetcode.com/problemset'), 5000, 'went to LeetCode');
    await welcome.close();
  });

  await step('Settings: Delete all my ReLeet data clears this browser', async () => {
    await options.click('#delete-all'); // the dialog handler accepts
    await waitFor(async () => /All ReLeet data in this browser is deleted\./.test(await options.locator('#delete-status').innerText()), 15000, 'deleted');
    const left = await sw.evaluate(() => chrome.storage.local.get(['problems', 'pending', 'calendars']));
    assert.deepEqual(left, {});
    await popup.locator('#empty').waitFor();
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
    for (const e of [...pageErrors, ...workerErrors]) console.log('   ', e);
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
