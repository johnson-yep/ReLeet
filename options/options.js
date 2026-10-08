import { getSettings, saveSettings, getSyncState, saveSyncState, onSyncStateChanged } from '../lib/storage.js';
import { parseRepo, createGitHubClient } from '../lib/github.js';
import { syncIntervalMinutes } from '../lib/github-sync.js';

const $ = (id) => document.getElementById(id);

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = kind || 'muted';
}

function renderSyncInfo(settings, state) {
  const rows = settings.owner
    ? [
        ['Repo', `${settings.owner}/${settings.repo} (${settings.branch})`],
        ['Checks', `every ${syncIntervalMinutes(settings) === 1 ? 'minute' : `${syncIntervalMinutes(settings)} minutes`}`],
        ['Last sync', state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : 'never'],
        ['Last processed commit', state.lastSha ? state.lastSha.slice(0, 7) : '—'],
        ['Last error', state.lastError ?? 'none'],
      ]
    : [['Repo', 'not configured']];
  $('sync-info').replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value;
      if (label === 'Last error' && state.lastError) dd.className = 'error';
      return [dt, dd];
    }),
  );
  $('sync-now').disabled = $('import-existing').disabled = !settings.owner;
}

async function refresh() {
  renderSyncInfo(await getSettings(), await getSyncState());
}

$('repo-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('repo-status');
  const parsed = parseRepo($('repo-input').value);
  if (!parsed) return setStatus(status, 'Enter owner/repo or a github.com URL.', 'error');

  setStatus(status, 'Checking repo…');
  try {
    const existing = await getSettings();
    const info = await createGitHubClient(existing).getRepo(parsed.owner, parsed.repo);
    if (info.private) return setStatus(status, 'That repo is private; only public repos are supported.', 'error');
    const settings = { ...existing, owner: info.owner.login, repo: info.name, branch: info.default_branch };
    await saveSettings(settings);
    await saveSyncState({}); // new repo: next sync sets a fresh baseline
    $('repo-input').value = `${settings.owner}/${settings.repo}`;
    setStatus(status, `Saved. Watching ${settings.owner}/${settings.repo} on ${settings.branch}.`, 'ok');
    await runAction('sync-now');
  } catch (e) {
    setStatus(status, e.status === 404 ? 'Repo not found (check the name, and that it is public).' : e.message, 'error');
  }
});

async function runAction(type) {
  const status = $('action-status');
  setStatus(status, type === 'sync-now' ? 'Syncing…' : 'Importing…');
  const result = await chrome.runtime.sendMessage({ type });
  const messages = {
    ok: `Done. ${result.added} new submission${result.added === 1 ? '' : 's'} to rate in the popup.`,
    baseline: 'Baseline set. New submissions from now on will be detected.',
    unconfigured: 'Save a repo first.',
    error: `Failed: ${result.error}`,
  };
  setStatus(status, messages[result.status] ?? result.status, result.status === 'error' ? 'error' : 'ok');
}

$('token-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('token-status');
  const token = $('token-input').value.trim();
  if (!token) return setStatus(status, 'Paste a token first.', 'error');

  setStatus(status, 'Checking token…');
  try {
    const { limit } = await createGitHubClient({ token }).getRateLimit();
    await saveSettings({ ...(await getSettings()), token });
    $('token-input').value = '';
    setStatus(status, `Token saved (${limit.toLocaleString()} requests/hour).`, 'ok');
    renderToken(true);
    await refresh();
  } catch (e) {
    setStatus(status, e.message, 'error');
  }
});

$('remove-token').addEventListener('click', async () => {
  const { token, ...rest } = await getSettings();
  await saveSettings(rest);
  setStatus($('token-status'), 'Token removed.', 'ok');
  renderToken(false);
  await refresh();
});

function renderToken(hasToken) {
  $('remove-token').hidden = !hasToken;
  $('token-input').placeholder = hasToken ? 'Token saved. Paste a new one to replace it' : 'github_pat_…';
}

$('sync-now').addEventListener('click', () => runAction('sync-now'));
$('import-existing').addEventListener('click', () => runAction('import-existing'));

onSyncStateChanged(refresh);
const settings = await getSettings();
if (settings.owner) $('repo-input').value = `${settings.owner}/${settings.repo}`;
renderToken(Boolean(settings.token));
await refresh();
