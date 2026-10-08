// Minimal GitHub REST API client for public repos. Uses fetch only — no
// chrome.* APIs — so it can be reused outside the extension.
//
// Rate limits: 60 requests/hour unauthenticated (per IP), 5,000/hour with a token.
// Conditional (ETag) requests still count against the unauthenticated limit.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

const seg = encodeURIComponent;
const ref = (name) => name.split('/').map(seg).join('/');
const repoPath = (owner, repo) => `/repos/${seg(owner)}/${seg(repo)}`;

// Accepts "owner/repo" or any github.com URL pointing into the repo.
export function parseRepo(input) {
  const text = input.trim().replace(/\.git$/, '');
  const match =
    text.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i) ?? text.match(/^([\w.-]+)\/([\w.-]+)$/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

export function createGitHubClient({ token = null } = {}) {
  async function request(path) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(API + path, { headers });
    if (res.ok) return res.json();

    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = new Date(Number(res.headers.get('x-ratelimit-reset')) * 1000);
      throw new GitHubError(`GitHub rate limit reached. Resets at ${reset.toLocaleTimeString()}.`, res.status);
    }
    if (res.status === 401) throw new GitHubError('GitHub token is invalid or expired.', 401);
    let message = res.statusText;
    try {
      message = (await res.json()).message ?? message;
    } catch {}
    throw new GitHubError(`GitHub ${res.status}: ${message}`, res.status);
  }

  return {
    getRepo: (owner, repo) => request(repoPath(owner, repo)),

    async getBranchHead(owner, repo, branch) {
      const data = await request(`${repoPath(owner, repo)}/branches/${ref(branch)}`);
      return { sha: data.commit.sha, treeSha: data.commit.commit.tree.sha };
    },

    // Commits after `base` up to `head`, oldest first (GitHub returns at most 250).
    // These commit objects do not include changed files; use getCommit for that.
    compareCommits: (owner, repo, base, head) =>
      request(`${repoPath(owner, repo)}/compare/${seg(base)}...${ref(head)}`),

    getCommit: (owner, repo, sha) => request(`${repoPath(owner, repo)}/commits/${seg(sha)}`),

    async listFilePaths(owner, repo, treeSha) {
      const data = await request(`${repoPath(owner, repo)}/git/trees/${seg(treeSha)}?recursive=1`);
      return data.tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path);
    },

    // Core API limit for these credentials, e.g. { limit: 5000, remaining: 4990 }.
    async getRateLimit() {
      const data = await request('/rate_limit');
      return data.resources.core;
    },
  };
}
