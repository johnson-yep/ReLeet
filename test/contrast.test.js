// Every text colour must stay readable (WCAG AA, 4.5:1) on every background,
// in light and dark. Reads the real stylesheet, so a colour change can't slip by.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../lib/ui.css', import.meta.url), 'utf8');
const tokens = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map(([, k, v]) => [k, v]));
const light = tokens(css.slice(css.indexOf(':root'), css.indexOf('@media (prefers-color-scheme: dark)')));
const dark = { ...light, ...tokens(css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))) };

const luminance = (hex) => {
  const [r, g, b] = hex.slice(1).match(/../g).map((h) => parseInt(h, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const TEXT = ['fg', 'muted', 'accent', 'easy-text', 'okay-text', 'hard-text'];
const BACKGROUNDS = ['bg', 'card', 'tint'];

for (const [name, theme] of Object.entries({ light, dark })) {
  test(`${name}: every text colour reads on every background`, () => {
    const failures = [];
    for (const text of TEXT) {
      for (const bg of BACKGROUNDS) {
        const ratio = contrast(theme[text], theme[bg]);
        if (ratio < 4.5) failures.push(`${text} on ${bg}: ${ratio.toFixed(2)}`);
      }
    }
    assert.ok(contrast(theme['accent-fg'], theme.accent) >= 4.5, 'button text on the accent colour');
    assert.deepEqual(failures, []);
  });
}

test('the in-page prompt uses the same rating colours', () => {
  const prompt = readFileSync(new URL('../content/leetcode.js', import.meta.url), 'utf8');
  const lightPrompt = tokens(prompt.slice(prompt.indexOf('.card {'), prompt.indexOf('function darkVars')));
  const darkPrompt = tokens(prompt.slice(prompt.indexOf('function darkVars')));
  for (const key of ['easy-text', 'okay-text', 'hard-text', 'easy', 'okay', 'hard']) {
    assert.equal(lightPrompt[key], light[key], `light ${key}`);
  }
  for (const key of ['easy-text', 'okay-text', 'hard-text']) assert.equal(darkPrompt[key], dark[key], `dark ${key}`);
});
