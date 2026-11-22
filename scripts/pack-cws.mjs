import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const EXTENSION_FILES = [
  'manifest.json',
  'LICENSE',
  'NOTICE',
  'styles/tokens.css',
  'background/service-worker.js',
  'content/selector.js',
  'lib/auth.js',
  'lib/capture.js',
  'lib/drive.js',
  'lib/editor-core.js',
  'lib/errors.js',
  'lib/feedback.js',
  'lib/storage.js',
  'lib/ui.js',
  'popup/popup.css',
  'popup/popup.html',
  'popup/popup.js',
  'pages/editor.css',
  'pages/editor.html',
  'pages/editor.js',
  'pages/welcome.css',
  'pages/welcome.html',
  'pages/welcome.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

export function buildCwsZipBuffer(baseDir = rootDir) {
  const rawManifest = JSON.parse(
    fs.readFileSync(path.join(baseDir, 'manifest.json'), 'utf8')
  );
  // Strip local unpacked "key" if present so Chrome Web Store never rejects the upload
  const cwsManifest = { ...rawManifest };
  delete cwsManifest.key;

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const relPath of EXTENSION_FILES) {
    const absPath = path.join(baseDir, relPath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Missing required extension file: ${relPath}`);
    }

    const rawBytes =
      relPath === 'manifest.json'
        ? Buffer.from(`${JSON.stringify(cwsManifest, null, 2)}\n`, 'utf8')
        : fs.readFileSync(absPath);

    const compressed = zlib.deflateRawSync(rawBytes, { level: 9 });
    const useDeflate = compressed.length < rawBytes.length;
    const payload = useDeflate ? compressed : rawBytes;
    const method = useDeflate ? 8 : 0;
    const crc = zlib.crc32(rawBytes) >>> 0;
    const nameBuf = Buffer.from(relPath, 'utf8');

    // Deterministic DOS timestamp (2026-11-21 00:00:00) for reproducible builds
    const dosTime = 0;
    const dosDate = ((2026 - 1980) << 9) | (11 << 5) | 21;

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(rawBytes.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(rawBytes.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);

    localParts.push(localHeader, payload);
    centralParts.push(centralHeader);
    offset += localHeader.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(EXTENSION_FILES.length, 8);
  eocd.writeUInt16LE(EXTENSION_FILES.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return {
    version: cwsManifest.version,
    buffer: Buffer.concat([...localParts, centralDir, eocd]),
  };
}

export function findLatestCwsZipName(baseDir = rootDir, version = '1.1.1') {
  const assetsDir = path.join(baseDir, 'store-assets');
  const prefix = `saveshot-v${version}-`;
  const matches = fs
    .readdirSync(assetsDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('-cws.zip'))
    .sort();
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version, buffer } = buildCwsZipBuffer();
  const assetsDir = path.join(rootDir, 'store-assets');
  for (const entry of fs.readdirSync(assetsDir)) {
    if (entry.startsWith('saveshot-') && entry.endsWith('-cws.zip')) {
      fs.unlinkSync(path.join(assetsDir, entry));
    }
  }
  const epoch = Math.floor(Date.now() / 1000);
  const outPath = path.join(assetsDir, `saveshot-v${version}-${epoch}-cws.zip`);
  fs.writeFileSync(outPath, buffer);
  console.log(`Built Chrome Web Store package: ${path.relative(rootDir, outPath)} (${buffer.length} bytes)`);
}
