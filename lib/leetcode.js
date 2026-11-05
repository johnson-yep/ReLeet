// Minimal client for LeetCode's GraphQL API (leetcode.com/graphql). Uses fetch
// only — no chrome.* APIs — so it can be tested and reused outside the extension.
//
// The API is unofficial. The queries below are the ones leetcode.com's own pages
// send and that maintained open-source clients use. recentAcSubmissionList is
// public, newest first, capped at about 20 entries, with `timestamp` in seconds
// (sent as a string).

export const LEETCODE_ORIGIN = 'https://leetcode.com';

export class LeetCodeError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'LeetCodeError';
    this.status = status;
  }
}

// matchedUser is asked for alongside the list because an unknown username can
// come back as an empty list; matchedUser is null (with an error) in that case.
const RECENT_ACCEPTED_QUERY = `query recentAcSubmissions($username: String!, $limit: Int!) {
  matchedUser(username: $username) { username }
  recentAcSubmissionList(username: $username, limit: $limit) { id title titleSlug timestamp }
}`;

const USER_STATUS_QUERY = `query globalData {
  userStatus { username isSignedIn }
}`;

const TIMEOUT_MS = 20 * 1000;

// The data we asked for is missing: show LeetCode's own error if it sent one.
const unexpected = (firstError, status) =>
  new LeetCodeError(firstError ? `LeetCode: ${firstError}` : 'LeetCode sent an unexpected response.', status);

function httpErrorMessage(status) {
  if (status === 429) return 'LeetCode is limiting requests right now. Try again in a few minutes.';
  if (status === 403) return 'LeetCode blocked the request. Try again later.';
  if (status >= 500) return `LeetCode is having trouble (HTTP ${status}). Try again later.`;
  return `LeetCode request failed (HTTP ${status}).`;
}

// credentials defaults to 'omit': the worker only reads public data, and
// sending session cookies would make LeetCode expect a CSRF token. Pass
// 'include' plus an x-csrftoken header to read signed-in data (signedInUser).
export function createLeetCodeClient({
  fetch: fetchFn = globalThis.fetch,
  origin = LEETCODE_ORIGIN,
  headers = {},
  credentials = 'omit',
  timeoutMs = TIMEOUT_MS,
} = {}) {
  async function graphql(query, variables = {}) {
    let res;
    let text;
    try {
      res = await fetchFn(`${origin}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ query, variables }),
        credentials,
        // A hung request would block every later sync, which shares the in-flight run.
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      text = await res.text();
    } catch (e) {
      if (e?.name === 'TimeoutError') throw new LeetCodeError("LeetCode didn't respond in time. Try again later.");
      throw new LeetCodeError("Couldn't reach LeetCode. Check your connection.");
    }

    // Cloudflare challenges and outages come back as HTML, not JSON.
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    const firstError = Array.isArray(json?.errors) ? json.errors[0]?.message : null;

    if (!res.ok) {
      const message = firstError && res.status < 500 ? `LeetCode: ${firstError}` : httpErrorMessage(res.status);
      throw new LeetCodeError(message, res.status);
    }
    if (!json || typeof json !== 'object') {
      throw new LeetCodeError('LeetCode sent an unexpected response. Try again later.', res.status);
    }
    return { data: json.data ?? null, firstError, status: res.status };
  }

  return {
    // → [{ submissionId, slug, title, timestamp (ms) }], newest first.
    async recentAccepted(username, limit = 20) {
      const name = String(username ?? '').trim();
      if (!name) throw new LeetCodeError('No LeetCode username set.');
      const { data, firstError, status } = await graphql(RECENT_ACCEPTED_QUERY, { username: name, limit });
      if ((data && data.matchedUser === null) || /not exist|not found/i.test(firstError ?? '')) {
        throw new LeetCodeError(`LeetCode user "${name}" not found.`, status);
      }

      const list = data?.recentAcSubmissionList;
      if (!Array.isArray(list)) throw unexpected(firstError, status);
      return list
        .map((s) => ({
          submissionId: String(s?.id ?? ''),
          slug: s?.titleSlug ?? '',
          title: s?.title || s?.titleSlug || '',
          timestamp: Number(s?.timestamp) * 1000,
        }))
        .filter((s) => s.submissionId && s.slug && Number.isFinite(s.timestamp));
    },

    // → { username, isSignedIn }. Only meaningful when cookies are sent.
    async signedInUser() {
      const { data, firstError, status } = await graphql(USER_STATUS_QUERY);
      const s = data?.userStatus;
      if (!s) throw unexpected(firstError, status);
      return { username: s.isSignedIn ? s.username || null : null, isSignedIn: Boolean(s.isSignedIn) };
    },
  };
}
