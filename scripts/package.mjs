// Builds dist/releet-<version>.zip for the Chrome Web Store. Node built-ins only.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const FILES = ['manifest.json', 'background.js'];
const FOLDERS = ['lib', 'content', 'popup', 'options', 'welcome', 'icons'];
const PLACEHOLDER_PREFIX = 'YOUR_';

const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01, keeps builds reproducible

function listFolder(abs, rel) {
  const found = [];
  for (const name of readdirSync(abs).sort()) {
    if (name.startsWith('.')) continue;
    const childAbs = join(abs, name);
    const childRel = `${rel}/${name}`;
    if (statSync(childAbs).isDirectory()) found.push(...listFolder(childAbs, childRel));
    else if (!name.toLowerCase().endsWith('.md')) found.push({ name: childRel, data: readFileSync(childAbs) });
  }
  return found;
}

function collect(root, manifestBytes) {
  const missing = [...FILES, ...FOLDERS].filter((entry) => !existsSync(join(root, entry)));
  if (missing.length) {
    throw new Error(`Cannot package: missing ${missing.join(', ')} in ${root}`);
  }
  const entries = [
    { name: 'manifest.json', data: manifestBytes },
    { name: 'background.js', data: readFileSync(join(root, 'background.js')) },
  ];
  for (const folder of FOLDERS) entries.push(...listFolder(join(root, folder), folder));
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export function buildPackage({ root, outDir = join(root, 'dist') }) {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const warnings = [];
  const clientId = manifest.oauth2?.client_id;
  if (typeof clientId !== 'string' || clientId.startsWith(PLACEHOLDER_PREFIX)) {
    warnings.push(
      `oauth2.client_id in manifest.json is still the placeholder (${clientId}). ` +
        'Google Calendar sign-in will not work in this build. See PUBLISHING.md.',
    );
  }
  delete manifest.key;
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);

  const entries = collect(root, manifestBytes);
  const zip = writeZip(entries);
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `releet-${manifest.version}.zip`);
  writeFileSync(path, zip);
  return { path, size: zip.length, files: entries.map((e) => e.name), warnings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const { path, size, files, warnings } = buildPackage({ root });
    for (const w of warnings) {
      process.stderr.write(`\n${'!'.repeat(72)}\nWARNING: ${w}\n${'!'.repeat(72)}\n\n`);
    }
    console.log(`${path} (${size} bytes, ${files.length} files)`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
