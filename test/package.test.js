import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { buildPackage } from '../scripts/package.mjs';

const SCRIPT = new URL('../scripts/package.mjs', import.meta.url).pathname;
const PLACEHOLDER = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';

function makeFixture({ clientId = '1234-abc.apps.googleusercontent.com', skip = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'releet-pkg-'));
  const put = (rel, content) => {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  };
  const manifest = { manifest_version: 3, name: 'X', version: '1.2.3', key: 'PUBLICKEY', oauth2: { client_id: clientId } };
  put('manifest.json', JSON.stringify(manifest));
  put('background.js', 'import "./lib/a.js";\n');
  put('lib/a.js', 'export const a = 1;\n'.repeat(50));
  put('lib/notes.md', 'docs');
  put('lib/.hidden', 'secret');
  put('content/leetcode.js', 'x');
  put('popup/popup.html', '<p>hi</p>');
  put('popup/deep/inner.css', 'a{}');
  put('options/options.html', '<p>o</p>');
  put('icons/icon16.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 250, 251]));
  put('welcome/welcome.html', '<p>w</p>');
  put('test/x.test.js', 'nope');
  put('README.md', 'nope');
  put('package.json', '{}');
  for (const s of skip) rmSync(join(root, s), { recursive: true });
  return root;
}

function readZip(file) {
  const buf = readFileSync(file);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let pos = buf.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const csize = buf.readUInt32LE(pos + 20);
    const nlen = buf.readUInt16LE(pos + 28);
    const xlen = buf.readUInt16LE(pos + 30);
    const clen = buf.readUInt16LE(pos + 32);
    const lho = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nlen);
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(zlib.crc32(data), crc, `crc of ${name}`);
    files.set(name, data);
    pos += 46 + nlen + xlen + clen;
  }
  return files;
}

test('packages exactly the runtime files, byte for byte, and strips the manifest key', () => {
  const root = makeFixture();
  const { path, warnings } = buildPackage({ root, outDir: join(root, 'dist') });
  assert.match(path, /releet-1\.2\.3\.zip$/);
  assert.deepEqual(warnings, []);
  const files = readZip(path);
  assert.deepEqual([...files.keys()].sort(), [
    'background.js',
    'content/leetcode.js',
    'icons/icon16.png',
    'lib/a.js',
    'manifest.json',
    'options/options.html',
    'popup/deep/inner.css',
    'popup/popup.html',
    'welcome/welcome.html',
  ]);
  for (const name of files.keys()) {
    if (name !== 'manifest.json') assert.deepEqual(files.get(name), readFileSync(join(root, name)), name);
  }
  const packaged = JSON.parse(files.get('manifest.json').toString());
  assert.equal('key' in packaged, false);
  assert.equal(packaged.version, '1.2.3');
  assert.equal(files.get('manifest.json').toString(), `${JSON.stringify(packaged, null, 2)}\n`);
  assert.ok(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).key, 'source manifest keeps its key');
});

test('fails with a clear error when a listed folder is missing', () => {
  const root = makeFixture({ skip: ['welcome'] });
  assert.throws(() => buildPackage({ root, outDir: join(root, 'dist') }), /missing welcome/);
});

test('warns about the placeholder client id but still builds', () => {
  const root = makeFixture({ clientId: PLACEHOLDER });
  const { path, warnings } = buildPackage({ root, outDir: join(root, 'dist') });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /placeholder/);
  assert.ok(readZip(path).has('manifest.json'));
});

test('the command line prints the zip path and warns on stderr', () => {
  const root = makeFixture({ clientId: PLACEHOLDER });
  mkdirSync(join(root, 'scripts'));
  copyFileSync(SCRIPT, join(root, 'scripts', 'package.mjs'));
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'package.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /dist\/releet-1\.2\.3\.zip/);
  assert.match(run.stderr, /WARNING/);
  assert.ok(readZip(join(root, 'dist', 'releet-1.2.3.zip')).size > 0);
});
