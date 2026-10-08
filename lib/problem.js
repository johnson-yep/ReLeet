// Helpers for identifying problems. Pure — no chrome.* APIs.

const LEETCODE_PROBLEM_URL = /leetcode\.com\/problems\/([a-z0-9-]+)/i;
const NEETCODE_PROBLEM_URL = /neetcode\.io\/problems\/([a-z0-9-]+)/i;

export function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/^\d+[.\s-]+/, '') // drop a leading problem number like "1. " or "0001-"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function titleFromSlug(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

export function leetcodeUrl(slug) {
  return `https://leetcode.com/problems/${slug}/`;
}

export function neetcodeUrl(slug) {
  return `https://neetcode.io/problems/${slug}`;
}

// NeetCode GitHub sync writes "<Topic>/<problem-slug>/submission-<n>.<ext>",
// e.g. "Data Structures & Algorithms/two-integer-sum/submission-0.py".
const SUBMISSION_PATH = /^(?:(.+)\/)?([^/]+)\/submission-(\d+)\.[^/.]+$/;

// Returns { id, title, url, topic, submissionNumber } or null for unrelated files.
export function parseSubmissionPath(path) {
  const match = path.match(SUBMISSION_PATH);
  if (!match) return null;
  const [, topic = null, folder, n] = match;
  const slug = slugify(folder);
  if (!slug) return null;
  return { id: slug, title: titleFromSlug(slug), url: neetcodeUrl(slug), topic, submissionNumber: Number(n) };
}

// Accepts a LeetCode/NeetCode URL, a slug, or a plain title ("Two Sum").
// Returns { id, title, url } or null if nothing usable was given.
export function parseProblemInput(input) {
  const text = input.trim();
  if (!text) return null;

  const urlMatch = text.match(LEETCODE_PROBLEM_URL) ?? text.match(NEETCODE_PROBLEM_URL);
  if (urlMatch) {
    const slug = urlMatch[1].toLowerCase();
    const url = LEETCODE_PROBLEM_URL.test(text) ? leetcodeUrl(slug) : neetcodeUrl(slug);
    return { id: slug, title: titleFromSlug(slug), url };
  }

  const slug = slugify(text);
  if (!slug) return null;
  const looksLikeSlug = /^[a-z0-9-]+$/.test(text);
  return { id: slug, title: looksLikeSlug ? titleFromSlug(slug) : text, url: leetcodeUrl(slug) };
}
