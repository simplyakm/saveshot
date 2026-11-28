import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_FILES } from './pack-cws.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export function normalizeManifestKey(raw) {
  const input = String(raw || '').trim();
  if (!input) return '';
  const stripped = input
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  if (stripped.length < 64 || stripped.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(stripped)) {
    throw new Error(
      'Invalid SAVESHOT_DEV_KEY. Provide the base64 public key from Chrome Web Store Developer Dashboard -> Package -> View public key.'
    );
  }
  return stripped;
}

function parseEnvFileForKey(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?SAVESHOT_DEV_KEY\s*=\s*(.*)$/);
    if (!match) continue;
    let val = match[1].trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, '').trim();
    }
    if (val) return val;
  }
  return '';
}

export function readDevKey({ baseDir = rootDir, env = process.env } = {}) {
  const fromEnv = String(env?.SAVESHOT_DEV_KEY || '').trim();
  if (fromEnv) return normalizeManifestKey(fromEnv);

  for (const filename of ['.env.local', '.env']) {
    const fromFile = parseEnvFileForKey(path.join(baseDir, filename));
    if (fromFile) return normalizeManifestKey(fromFile);
  }
  return '';
}

export function buildDevUnpacked({
  baseDir = rootDir,
  outDir = path.join(baseDir, 'dist-dev'),
  env = process.env,
  key,
} = {}) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedOut = path.resolve(outDir);
  if (resolvedOut === resolvedBase || resolvedBase.startsWith(`${resolvedOut}${path.sep}`)) {
    throw new Error('Refusing to clean outDir that overlaps repository root.');
  }

  const normalizedKey =
    key !== undefined ? normalizeManifestKey(key) : readDevKey({ baseDir: resolvedBase, env });

  fs.rmSync(resolvedOut, { recursive: true, force: true });
  fs.mkdirSync(resolvedOut, { recursive: true });

  const rawManifest = JSON.parse(
    fs.readFileSync(path.join(resolvedBase, 'manifest.json'), 'utf8')
  );
  const devManifest = { ...rawManifest };
  if (normalizedKey) {
    devManifest.key = normalizedKey;
  } else {
    delete devManifest.key;
  }

  for (const relPath of EXTENSION_FILES) {
    const src = path.join(resolvedBase, relPath);
    const dst = path.join(resolvedOut, relPath);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing required extension file: ${relPath}`);
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (relPath === 'manifest.json') {
      fs.writeFileSync(dst, `${JSON.stringify(devManifest, null, 2)}\n`, 'utf8');
    } else {
      fs.copyFileSync(src, dst);
    }
  }

  return {
    outDir: resolvedOut,
    version: String(devManifest.version || ''),
    fileCount: EXTENSION_FILES.length,
    hasKey: Boolean(normalizedKey),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const res = buildDevUnpacked();
    console.log(
      `Built unpacked dev extension v${res.version} (${res.fileCount} files) at ${path.relative(rootDir, res.outDir) || res.outDir}`
    );
    if (res.hasKey) {
      console.log('Injected SAVESHOT_DEV_KEY into dist-dev/manifest.json (tracked manifest.json untouched).');
    } else {
      console.log(
        'Note: SAVESHOT_DEV_KEY not set. To keep your production Extension ID for Google Drive OAuth, add SAVESHOT_DEV_KEY="<public key>" to .env.local (gitignored) and re-run npm run build:dev.'
      );
    }
  } catch (err) {
    console.error(`Dev build failed: ${err.message}`);
    process.exitCode = 1;
  }
}
