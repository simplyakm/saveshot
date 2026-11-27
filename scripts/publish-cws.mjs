import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildCwsZipBuffer } from './pack-cws.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export const CWS_API_BASE = 'https://chromewebstore.googleapis.com';
export const CWS_SCOPES = Object.freeze({
  WRITE: 'https://www.googleapis.com/auth/chromewebstore',
  READONLY: 'https://www.googleapis.com/auth/chromewebstore.readonly',
});
export const ALLOWED_TOKEN_URIS = Object.freeze([
  'https://oauth2.googleapis.com/token',
  'https://www.googleapis.com/oauth2/v4/token',
]);
export const VALID_MODES = Object.freeze(['status', 'draft', 'staged', 'publish', 'cancel']);

const ALLOWED_TOKEN_URI_SET = new Set(ALLOWED_TOKEN_URIS);
const VALID_MODE_SET = new Set(VALID_MODES);

const PUBLISHER_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const ITEM_ID_RE = /^[a-p]{32}$/;
const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SERVICE_ACCOUNT_FILE_BYTES = 65_536;
const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 40;

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function maskSecretForCi(secretValue, env = process.env) {
  if (env?.GITHUB_ACTIONS === 'true' && typeof secretValue === 'string' && secretValue.length > 0) {
    process.stdout.write(`::add-mask::${secretValue.replace(/[\r\n]/g, '')}\n`);
  }
}

export function validatePublisherId(publisherId) {
  const value = String(publisherId || '').trim();
  if (
    !PUBLISHER_ID_RE.test(value) ||
    value === '.' ||
    value.includes('..') ||
    !/[A-Za-z0-9]/.test(value)
  ) {
    throw new Error(
      'Invalid CWS_PUBLISHER_ID. Copy your Publisher ID from Chrome Web Store Developer Dashboard -> Account.'
    );
  }
  return value;
}

export function validateItemId(itemId) {
  const value = String(itemId || '').trim();
  if (!ITEM_ID_RE.test(value)) {
    throw new Error(
      'Invalid CWS_ITEM_ID. Expected a 32-character lowercase Chrome extension ID (characters a-p).'
    );
  }
  return value;
}

export function compareVersions(a, b) {
  const parse = (v) =>
    String(v || '')
      .trim()
      .split('.')
      .map((part) => {
        if (!/^\d+$/.test(part)) {
          throw new Error(`Invalid dotted numeric version: "${v}"`);
        }
        return Number(part);
      });
  const partsA = parse(a);
  const partsB = parse(b);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (partsA[i] || 0) - (partsB[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function sanitizeApiErrorBody(rawText) {
  const cleaned = String(rawText || '')
    .replace(
      /"(access_token|refresh_token|id_token|client_secret|private_key|assertion)"\s*:\s*"(?:\\.|[^"\\])*"/gi,
      '"$1":"[REDACTED]"'
    )
    .replace(
      /\b(access_token|refresh_token|id_token|client_secret|assertion)=[^&\s"']+/gi,
      '$1=[REDACTED]'
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:ya29\.[A-Za-z0-9._~+/-]+|1\/\/[A-Za-z0-9._~+/-]+|GOCSPX-[A-Za-z0-9._~+/-]+)\b/g, '[REDACTED_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= 600) return cleaned;
  return `${cleaned.slice(0, 600)}...`;
}

/**
 * Extract manifest.json directly from a PKZIP buffer (supports stored method 0 and deflate method 8).
 * Ensures --zip uploads are validated against the exact manifest inside the ZIP, not the working tree.
 */
export function extractManifestFromZipBuffer(zipBuffer) {
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length < 22) {
    throw new Error('ZIP package buffer is empty or truncated.');
  }
  if (
    zipBuffer[0] !== 0x50 ||
    zipBuffer[1] !== 0x4b ||
    zipBuffer[2] !== 0x03 ||
    zipBuffer[3] !== 0x04
  ) {
    throw new Error('Upload payload does not have a valid ZIP signature.');
  }

  // Locate End of Central Directory (EOCD) record from end of file
  const minEocdOffset = Math.max(0, zipBuffer.length - 65_557);
  let eocdOffset = -1;
  for (let i = zipBuffer.length - 22; i >= minEocdOffset; i -= 1) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('ZIP package is missing an End of Central Directory header.');
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
  let cursor = cdOffset;

  for (let idx = 0; idx < totalEntries; idx += 1) {
    if (cursor + 46 > zipBuffer.length || zipBuffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Corrupt ZIP central directory header.');
    }
    const compressionMethod = zipBuffer.readUInt16LE(cursor + 10);
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20);
    const nameLen = zipBuffer.readUInt16LE(cursor + 28);
    const extraLen = zipBuffer.readUInt16LE(cursor + 30);
    const commentLen = zipBuffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(cursor + 42);
    const entryName = zipBuffer.toString('utf8', cursor + 46, cursor + 46 + nameLen);
    cursor += 46 + nameLen + extraLen + commentLen;

    if (entryName !== 'manifest.json') continue;

    if (
      localHeaderOffset + 30 > zipBuffer.length ||
      zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50
    ) {
      throw new Error('Corrupt local file header for manifest.json in ZIP.');
    }
    const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zipBuffer.length) {
      throw new Error('Truncated manifest.json entry inside ZIP.');
    }
    const rawSlice = zipBuffer.subarray(dataStart, dataEnd);
    let manifestBytes;
    if (compressionMethod === 0) {
      manifestBytes = rawSlice;
    } else if (compressionMethod === 8) {
      manifestBytes = zlib.inflateRawSync(rawSlice, { maxOutputLength: 256 * 1024 });
    } else {
      throw new Error(`Unsupported ZIP compression method (${compressionMethod}) for manifest.json.`);
    }
    try {
      return JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      throw new Error('manifest.json inside ZIP is not valid JSON.');
    }
  }

  throw new Error('ZIP package does not contain a root manifest.json.');
}

function validateManifestForCwsUpload(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Extension manifest.json must be a JSON object.');
  }
  const version = String(manifest.version || '').trim();
  if (!version) {
    throw new Error('Extension manifest.json is missing a valid version.');
  }
  compareVersions(version, '0');
  if (Object.prototype.hasOwnProperty.call(manifest, 'key')) {
    throw new Error(
      'Refusing to upload: manifest.json inside ZIP contains a local "key" property (Chrome Web Store rejects uploads with "key").'
    );
  }
  const oauthClientId = String(manifest?.oauth2?.client_id || '');
  if (oauthClientId.includes('YOUR_CHROME_OAUTH')) {
    throw new Error(
      'Refusing to upload: manifest.json still contains placeholder oauth2.client_id.'
    );
  }
  return version;
}

export function createServiceAccountJwt(
  serviceAccount,
  { scope = CWS_SCOPES.WRITE, nowSec = Math.floor(Date.now() / 1000) } = {}
) {
  if (!serviceAccount || typeof serviceAccount !== 'object') {
    throw new Error('Service account credentials must be a JSON object.');
  }
  const clientEmail = String(serviceAccount.client_email || '').trim();
  const privateKey = String(serviceAccount.private_key || '').trim();
  const privateKeyId = String(serviceAccount.private_key_id || '').trim();
  const tokenUri = String(
    serviceAccount.token_uri || 'https://oauth2.googleapis.com/token'
  ).trim();

  if (!clientEmail || !clientEmail.includes('@')) {
    throw new Error('Service account JSON is missing a valid client_email.');
  }
  if (!privateKey || !privateKey.includes('BEGIN')) {
    throw new Error('Service account JSON is missing a valid PEM private_key.');
  }
  if (!ALLOWED_TOKEN_URI_SET.has(tokenUri)) {
    throw new Error(`Untrusted service account token_uri: "${tokenUri}"`);
  }

  const headerObj = { alg: 'RS256', typ: 'JWT' };
  if (privateKeyId) headerObj.kid = privateKeyId;
  const header = base64UrlEncode(JSON.stringify(headerObj));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: clientEmail,
      scope,
      aud: tokenUri,
      iat: nowSec,
      exp: nowSec + 3600,
    })
  );
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(signingInput, 'utf8'),
    privateKey
  );
  return {
    assertion: `${signingInput}.${base64UrlEncode(signature)}`,
    tokenUri,
  };
}

function parseServiceAccountFromEnv(env) {
  const inlineJson = String(env.CWS_SERVICE_ACCOUNT_JSON || '').trim();
  if (inlineJson) {
    try {
      return JSON.parse(inlineJson);
    } catch {
      throw new Error('CWS_SERVICE_ACCOUNT_JSON is not valid JSON.');
    }
  }
  const filePath = String(env.CWS_SERVICE_ACCOUNT_FILE || '').trim();
  if (filePath) {
    const resolved = path.resolve(filePath);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new Error(`Service account path is not a regular file: ${filePath}`);
    }
    if (stat.size <= 0 || stat.size > MAX_SERVICE_ACCOUNT_FILE_BYTES) {
      throw new Error(
        `Service account file size must be between 1 and ${MAX_SERVICE_ACCOUNT_FILE_BYTES} bytes.`
      );
    }
    const raw = fs.readFileSync(resolved, 'utf8');
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`Service account file is not valid JSON: ${filePath}`);
    }
  }
  return null;
}

async function fetchJsonWithTimeout(
  url,
  options,
  { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS } = {}
) {
  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  const res = await fetchImpl(url, {
    ...options,
    redirect: 'error',
    ...(signal ? { signal } : {}),
  });
  const rawText = await res.text();
  let json = null;
  if (rawText) {
    try {
      json = JSON.parse(rawText);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const detail = sanitizeApiErrorBody(
      json?.error?.message || json?.error_description || rawText || res.statusText
    );
    const err = new Error(`HTTP ${res.status} from ${new URL(url).pathname}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return json || {};
}

export async function getAccessToken({
  env = process.env,
  scope = CWS_SCOPES.WRITE,
  fetchImpl = globalThis.fetch,
  nowSec = Math.floor(Date.now() / 1000),
} = {}) {
  const serviceAccount = parseServiceAccountFromEnv(env);
  if (serviceAccount) {
    const { assertion, tokenUri } = createServiceAccountJwt(serviceAccount, {
      scope,
      nowSec,
    });
    maskSecretForCi(assertion, env);
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });
    const data = await fetchJsonWithTimeout(
      tokenUri,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      { fetchImpl, timeoutMs: 30_000 }
    );
    if (!data.access_token || typeof data.access_token !== 'string') {
      throw new Error('OAuth token endpoint did not return an access_token for service account.');
    }
    maskSecretForCi(data.access_token, env);
    return data.access_token;
  }

  const clientId = String(env.CWS_CLIENT_ID || '').trim();
  const clientSecret = String(env.CWS_CLIENT_SECRET || '').trim();
  const refreshToken = String(env.CWS_REFRESH_TOKEN || '').trim();
  if (clientId && clientSecret && refreshToken) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const data = await fetchJsonWithTimeout(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      { fetchImpl, timeoutMs: 30_000 }
    );
    if (!data.access_token || typeof data.access_token !== 'string') {
      throw new Error('OAuth token endpoint did not return an access_token for refresh token.');
    }
    maskSecretForCi(data.access_token, env);
    return data.access_token;
  }

  throw new Error(
    'Missing Chrome Web Store credentials. Provide CWS_SERVICE_ACCOUNT_JSON (recommended) or CWS_CLIENT_ID + CWS_CLIENT_SECRET + CWS_REFRESH_TOKEN.'
  );
}

function itemResourcePath(publisherId, itemId) {
  const safePub = validatePublisherId(publisherId);
  const safeItem = validateItemId(itemId);
  return `publishers/${safePub}/items/${safeItem}`;
}

export async function cwsFetchStatus({
  publisherId,
  itemId,
  accessToken,
  fetchImpl = globalThis.fetch,
}) {
  const url = `${CWS_API_BASE}/v2/${itemResourcePath(publisherId, itemId)}:fetchStatus`;
  return fetchJsonWithTimeout(
    url,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    { fetchImpl }
  );
}

function getHighestChannelVersion(revisionStatus) {
  const channels = Array.isArray(revisionStatus?.distributionChannels)
    ? revisionStatus.distributionChannels
    : [];
  let highest = '';
  for (const ch of channels) {
    const ver = String(ch?.crxVersion || '').trim();
    if (!ver) continue;
    if (!highest || compareVersions(ver, highest) > 0) {
      highest = ver;
    }
  }
  return highest || null;
}

function isInProgressUploadState(state) {
  return (
    state === 'IN_PROGRESS' ||
    state === 'UPLOAD_IN_PROGRESS' ||
    state === 'UPLOAD_STATE_UNSPECIFIED'
  );
}

export async function cwsUploadPackage({
  publisherId,
  itemId,
  accessToken,
  zipBuffer,
  fetchImpl = globalThis.fetch,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length < 22) {
    throw new Error('ZIP package buffer is empty or truncated.');
  }
  if (zipBuffer.length > MAX_ZIP_BYTES) {
    throw new Error('ZIP package exceeds Chrome Web Store 2 GB upload limit.');
  }
  if (
    zipBuffer[0] !== 0x50 ||
    zipBuffer[1] !== 0x4b ||
    zipBuffer[2] !== 0x03 ||
    zipBuffer[3] !== 0x04
  ) {
    throw new Error('Upload payload does not have a valid ZIP signature.');
  }

  const url = `${CWS_API_BASE}/upload/v2/${itemResourcePath(publisherId, itemId)}:upload`;
  const uploadRes = await fetchJsonWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/zip',
        'X-Goog-Upload-Protocol': 'raw',
      },
      body: zipBuffer,
    },
    { fetchImpl, timeoutMs: DEFAULT_UPLOAD_TIMEOUT_MS }
  );

  let uploadState = uploadRes.uploadState || 'UPLOAD_STATE_UNSPECIFIED';
  if (uploadState === 'IN_PROGRESS' || uploadState === 'UPLOAD_IN_PROGRESS') {
    let transientErrors = 0;
    for (let attempt = 1; attempt <= maxPollAttempts; attempt += 1) {
      await sleepImpl(pollIntervalMs);
      let status;
      try {
        status = await cwsFetchStatus({
          publisherId,
          itemId,
          accessToken,
          fetchImpl,
        });
        transientErrors = 0;
      } catch (err) {
        const isTransient = err?.status === 429 || (err?.status >= 500 && err?.status < 600);
        if (isTransient && transientErrors < 3 && attempt < maxPollAttempts) {
          transientErrors += 1;
          continue;
        }
        throw err;
      }
      uploadState = status.lastAsyncUploadState || 'UPLOAD_STATE_UNSPECIFIED';
      if (uploadState === 'SUCCEEDED') {
        break;
      }
      if (!isInProgressUploadState(uploadState)) {
        throw new Error(`Async upload ended with unexpected state: ${uploadState}`);
      }
    }
    if (uploadState !== 'SUCCEEDED') {
      throw new Error(
        `Timed out waiting for async upload to finish (last state: ${uploadState}).`
      );
    }
  } else if (uploadState !== 'SUCCEEDED') {
    throw new Error(`Chrome Web Store upload failed with state: ${uploadState}`);
  }

  return {
    ...uploadRes,
    uploadState,
  };
}

export async function cwsPublishItem({
  publisherId,
  itemId,
  accessToken,
  publishType = 'DEFAULT_PUBLISH',
  skipReview = false,
  deployPercentage,
  blockOnWarnings = false,
  fetchImpl = globalThis.fetch,
}) {
  if (publishType !== 'DEFAULT_PUBLISH' && publishType !== 'STAGED_PUBLISH') {
    throw new Error(`Invalid publishType: "${publishType}"`);
  }
  const payload = { publishType };
  if (skipReview) payload.skipReview = true;
  if (blockOnWarnings) payload.blockOnWarnings = true;
  if (deployPercentage !== undefined && deployPercentage !== null) {
    const pct = Number(deployPercentage);
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
      throw new Error('deployPercentage must be an integer between 1 and 100.');
    }
    payload.deployInfos = [{ deployPercentage: pct }];
  }

  const url = `${CWS_API_BASE}/v2/${itemResourcePath(publisherId, itemId)}:publish`;
  return fetchJsonWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
    { fetchImpl }
  );
}

export async function cwsCancelSubmission({
  publisherId,
  itemId,
  accessToken,
  fetchImpl = globalThis.fetch,
}) {
  const url = `${CWS_API_BASE}/v2/${itemResourcePath(publisherId, itemId)}:cancelSubmission`;
  return fetchJsonWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    },
    { fetchImpl }
  );
}

export function buildDashboardUrl(publisherId, itemId) {
  return `https://chrome.google.com/webstore/devconsole/${validatePublisherId(publisherId)}/${validateItemId(itemId)}/edit/package`;
}

export async function runCwsCommand({
  mode = 'draft',
  publisherId,
  itemId,
  env = process.env,
  baseDir = rootDir,
  zipPath = '',
  skipReview = false,
  deployPercentage,
  blockOnWarnings = false,
  cancelPending = false,
  allowSameVersion = false,
  fetchImpl = globalThis.fetch,
  sleepImpl,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
  logger = console,
} = {}) {
  const normalizedMode = String(mode || 'draft').trim().toLowerCase();
  if (!VALID_MODE_SET.has(normalizedMode)) {
    throw new Error(
      `Invalid mode "${mode}". Expected one of: ${VALID_MODES.join(', ')}.`
    );
  }
  if (
    (normalizedMode === 'status' || normalizedMode === 'cancel' || normalizedMode === 'draft') &&
    (skipReview || (deployPercentage !== undefined && deployPercentage !== null))
  ) {
    throw new Error(
      `Flags --skip-review and --deploy-percentage are only valid in staged or publish modes (current mode: ${normalizedMode}).`
    );
  }

  const safePublisherId = validatePublisherId(publisherId ?? env.CWS_PUBLISHER_ID);
  const safeItemId = validateItemId(itemId ?? env.CWS_ITEM_ID);
  const dashboardUrl = buildDashboardUrl(safePublisherId, safeItemId);
  const scope = normalizedMode === 'status' ? CWS_SCOPES.READONLY : CWS_SCOPES.WRITE;
  const accessToken = await getAccessToken({ env, scope, fetchImpl });

  if (normalizedMode === 'status') {
    const status = await cwsFetchStatus({
      publisherId: safePublisherId,
      itemId: safeItemId,
      accessToken,
      fetchImpl,
    });
    return {
      mode: normalizedMode,
      publisherId: safePublisherId,
      itemId: safeItemId,
      publishedVersion: getHighestChannelVersion(status.publishedItemRevisionStatus),
      publishedState: status.publishedItemRevisionStatus?.state || null,
      submittedVersion: getHighestChannelVersion(status.submittedItemRevisionStatus),
      submittedState: status.submittedItemRevisionStatus?.state || null,
      lastAsyncUploadState: status.lastAsyncUploadState || null,
      takenDown: Boolean(status.takenDown),
      warned: Boolean(status.warned),
      dashboardUrl,
    };
  }

  if (normalizedMode === 'cancel') {
    await cwsCancelSubmission({
      publisherId: safePublisherId,
      itemId: safeItemId,
      accessToken,
      fetchImpl,
    });
    return {
      mode: normalizedMode,
      publisherId: safePublisherId,
      itemId: safeItemId,
      cancelled: true,
      dashboardUrl,
    };
  }

  // Upload modes: draft, staged, publish
  let zipBuffer;
  if (zipPath) {
    const resolvedZip = path.resolve(zipPath);
    if (!resolvedZip.toLowerCase().endsWith('.zip')) {
      throw new Error(`--zip path must end with .zip: ${zipPath}`);
    }
    const stat = fs.statSync(resolvedZip);
    if (!stat.isFile()) {
      throw new Error(`--zip path is not a regular file: ${zipPath}`);
    }
    if (stat.size < 22 || stat.size > MAX_ZIP_BYTES) {
      throw new Error(
        `--zip file size (${stat.size} bytes) is outside valid ZIP bounds (22 bytes to 2 GB).`
      );
    }
    zipBuffer = fs.readFileSync(resolvedZip);
  } else {
    const built = buildCwsZipBuffer(baseDir);
    zipBuffer = built.buffer;
  }

  // Always validate the exact manifest.json embedded inside the ZIP payload
  const embeddedManifest = extractManifestFromZipBuffer(zipBuffer);
  const version = validateManifestForCwsUpload(embeddedManifest);

  const preStatus = await cwsFetchStatus({
    publisherId: safePublisherId,
    itemId: safeItemId,
    accessToken,
    fetchImpl,
  });

  if (preStatus.takenDown) {
    throw new Error(
      `Refusing to upload: Chrome Web Store reports item is taken down. Check ${dashboardUrl}`
    );
  }

  const publishedVersion = getHighestChannelVersion(preStatus.publishedItemRevisionStatus);
  if (!allowSameVersion && publishedVersion && compareVersions(version, publishedVersion) <= 0) {
    throw new Error(
      `Manifest version (${version}) must be higher than currently published Chrome Web Store version (${publishedVersion}). Bump manifest.json version first.`
    );
  }

  const submittedState = preStatus.submittedItemRevisionStatus?.state || '';
  if (submittedState === 'PENDING_REVIEW' || submittedState === 'STAGED') {
    if (!cancelPending) {
      throw new Error(
        `An existing submission is currently ${submittedState}. Re-run with --cancel-pending (or cancel it first) before uploading a new package.`
      );
    }
    logger?.log?.(`Cancelling existing ${submittedState} submission before uploading...`);
    await cwsCancelSubmission({
      publisherId: safePublisherId,
      itemId: safeItemId,
      accessToken,
      fetchImpl,
    });
  }

  logger?.log?.(
    `Uploading SaveShot v${version} (${zipBuffer.length} bytes) to Chrome Web Store...`
  );
  const uploadResult = await cwsUploadPackage({
    publisherId: safePublisherId,
    itemId: safeItemId,
    accessToken,
    zipBuffer,
    fetchImpl,
    pollIntervalMs,
    maxPollAttempts,
    sleepImpl,
  });

  if (normalizedMode === 'draft') {
    return {
      mode: normalizedMode,
      publisherId: safePublisherId,
      itemId: safeItemId,
      version: uploadResult.crxVersion || version,
      zipBytes: zipBuffer.length,
      uploadState: uploadResult.uploadState,
      published: false,
      publishState: 'DRAFT',
      warnings: [],
      warned: Boolean(preStatus.warned),
      dashboardUrl,
    };
  }

  const publishType = normalizedMode === 'staged' ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH';
  logger?.log?.(`Submitting SaveShot v${version} with publishType=${publishType}...`);
  const publishResult = await cwsPublishItem({
    publisherId: safePublisherId,
    itemId: safeItemId,
    accessToken,
    publishType,
    skipReview,
    deployPercentage,
    blockOnWarnings,
    fetchImpl,
  });

  const warnings = Array.isArray(publishResult.warningInfo?.warnings)
    ? publishResult.warningInfo.warnings
    : [];

  return {
    mode: normalizedMode,
    publisherId: safePublisherId,
    itemId: safeItemId,
    version: uploadResult.crxVersion || version,
    zipBytes: zipBuffer.length,
    uploadState: uploadResult.uploadState,
    published: true,
    publishType,
    publishState: publishResult.state || 'PENDING_REVIEW',
    warnings,
    warned: Boolean(preStatus.warned),
    dashboardUrl,
  };
}

export function parseCliArgs(argv) {
  const opts = {
    mode: 'draft',
    zipPath: '',
    skipReview: false,
    deployPercentage: undefined,
    blockOnWarnings: false,
    cancelPending: false,
    allowSameVersion: false,
    json: false,
  };
  const requireNextValue = (flag, index) => {
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error(`Missing value for ${flag}`);
    }
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--mode=')) {
      opts.mode = arg.slice('--mode='.length);
    } else if (arg === '--mode') {
      opts.mode = requireNextValue('--mode', i);
      i += 1;
    } else if (arg.startsWith('--zip=')) {
      opts.zipPath = arg.slice('--zip='.length);
    } else if (arg === '--zip') {
      opts.zipPath = requireNextValue('--zip', i);
      i += 1;
    } else if (arg === '--skip-review') {
      opts.skipReview = true;
    } else if (arg === '--block-on-warnings') {
      opts.blockOnWarnings = true;
    } else if (arg === '--cancel-pending') {
      opts.cancelPending = true;
    } else if (arg === '--allow-same-version') {
      opts.allowSameVersion = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg.startsWith('--deploy-percentage=')) {
      opts.deployPercentage = Number(arg.slice('--deploy-percentage='.length));
    } else if (arg === '--deploy-percentage') {
      opts.deployPercentage = Number(requireNextValue('--deploy-percentage', i));
      i += 1;
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }
  return opts;
}

function escapeMarkdownInline(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\`*_{}[\]()#<>|]/g, (ch) => `\\${ch}`)
    .trim();
}

export function formatStepSummary(result) {
  const esc = escapeMarkdownInline;
  const lines = [
    `## Chrome Web Store API V2 (${esc(result.mode)})`,
    '',
    `- **Item ID:** \`${esc(result.itemId)}\``,
  ];
  if (result.version) lines.push(`- **Version:** \`v${esc(result.version)}\``);
  if (result.zipBytes) lines.push(`- **Package Size:** ${Number(result.zipBytes)} bytes`);
  if (result.uploadState) lines.push(`- **Upload State:** \`${esc(result.uploadState)}\``);
  if (result.publishState) lines.push(`- **Submission State:** \`${esc(result.publishState)}\``);
  if (result.publishedVersion) {
    lines.push(
      `- **Published Revision:** \`v${esc(result.publishedVersion)}\` (\`${esc(result.publishedState || 'UNKNOWN')}\`)`
    );
  }
  if (result.submittedState) {
    lines.push(
      `- **Submitted Revision:** \`${result.submittedVersion ? `v${esc(result.submittedVersion)}` : 'n/a'}\` (\`${esc(result.submittedState)}\`)`
    );
  }
  if (result.lastAsyncUploadState) {
    lines.push(`- **Last Async Upload State:** \`${esc(result.lastAsyncUploadState)}\``);
  }
  if (result.takenDown) {
    lines.push('- **Policy Status:** `TAKEN_DOWN` (action required in Developer Dashboard)');
  }
  if (result.warned) {
    lines.push('- **Policy Warning:** `WARNED` (review policy notice in Developer Dashboard)');
  }
  if (result.cancelled) lines.push('- **Action:** Cancelled pending review submission');
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    lines.push('- **Warnings:**');
    for (const w of result.warnings) {
      lines.push(`  - \`${esc(w.reason || 'WARNING')}\`: ${esc(w.description || '')}`);
    }
  }
  if (result.mode === 'draft') {
    lines.push(
      '',
      '> Uploaded as a **draft** only. Review or update store screenshots/description in the [Developer Dashboard](' +
        result.dashboardUrl +
        '), then submit for review.'
    );
  } else {
    lines.push('', `Open in [Chrome Web Store Developer Dashboard](${result.dashboardUrl}).`);
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve()
    .then(() => parseCliArgs(process.argv.slice(2)))
    .then((opts) =>
      runCwsCommand({
        ...opts,
        logger: opts.json ? { log: () => {} } : console,
      }).then((result) => ({ opts, result }))
    )
    .then(({ opts, result }) => {
      if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatStepSummary(result), 'utf8');
      }
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatStepSummary(result));
      }
    })
    .catch((err) => {
      console.error(`Chrome Web Store publish failed: ${err.message}`);
      process.exitCode = 1;
    });
}
