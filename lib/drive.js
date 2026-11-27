import { classifyDriveHttpError, SaveShotError } from './errors.js';

const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

// Deduplicate concurrent folder creation calls per account + folder name
const inflightFolderPromises = new Map();
const verifiedFolderCache = new Map();

export function clearDriveFolderVerifyCache() {
  verifiedFolderCache.clear();
}

/**
 * Escape single quotes and backslashes for Google Drive v3 search query literals.
 */
export function escapeDriveQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Build a multipart/related Blob payload for Google Drive v3 file upload.
 * Streams raw PNG binary bytes without base64 bloat.
 */
export function buildMultipartUploadBody(metadata, fileBlob, boundary) {
  const safeBoundary =
    boundary ||
    `saveshot_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;

  const metadataPart =
    `--${safeBoundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n`;

  const mediaHeader =
    `--${safeBoundary}\r\n` +
    `Content-Type: ${fileBlob.type || 'image/png'}\r\n\r\n`;

  const closing = `\r\n--${safeBoundary}--`;

  const body = new Blob([metadataPart, mediaHeader, fileBlob, closing], {
    type: `multipart/related; boundary=${safeBoundary}`,
  });

  return {
    boundary: safeBoundary,
    contentType: `multipart/related; boundary=${safeBoundary}`,
    body,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseDriveError(response) {
  let json = null;
  try {
    json = await response.json();
  } catch {
    // Non-JSON error body
  }
  return classifyDriveHttpError(response.status, json);
}

/**
 * Execute a Drive HTTP call with AbortController timeout and bounded exponential-backoff retry
 * for transient 429 / 5xx / rate-limit / network-drop errors (never retrying storageQuotaExceeded or 401).
 */
export async function fetchDriveWithRetry(
  url,
  init,
  {
    fetchImpl = fetch,
    timeoutMs = 15000,
    maxRetries = 2,
    baseDelayMs = 350,
  } = {}
) {
  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer?.unref?.();

    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (networkErr) {
      const isTimeout = networkErr?.name === 'AbortError';
      const isOffline =
        typeof navigator !== 'undefined' && navigator.onLine === false;
      const err = new SaveShotError({
        code: 'NETWORK_ERROR',
        userMessage: isOffline
          ? 'You appear to be offline. Connect to the internet or save the screenshot locally below.'
          : isTimeout
          ? 'Google Drive took too long to respond. Check your internet or save the screenshot locally below.'
          : 'Network connection failed while reaching Google Drive. Save the screenshot locally or retry.',
        reason: isTimeout ? 'timeout' : networkErr?.message || 'networkError',
        recoverableWithLocalSave: true,
        retryable: !isOffline && !isTimeout,
      });

      if (err.retryable && attempt < maxRetries) {
        attempt += 1;
        await sleep(baseDelayMs * 2 ** (attempt - 1));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      return response;
    }

    const driveErr = await parseDriveError(response);
    const retryAfterSec = Number(response.headers?.get?.('Retry-After'));
    if (
      driveErr.retryable &&
      attempt < maxRetries &&
      !(Number.isFinite(retryAfterSec) && retryAfterSec > 15)
    ) {
      attempt += 1;
      const waitMs =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.min(4000, retryAfterSec * 1000)
          : baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 120);
      await sleep(waitMs);
      continue;
    }

    throw driveErr;
  }
}

const DRIVE_FILE_ID_PATTERN = /^[a-zA-Z0-9_-]{4,128}$/;
const DISALLOWED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function validateDriveFileId(fileId) {
  if (
    typeof fileId !== 'string' ||
    DISALLOWED_OBJECT_KEYS.has(fileId) ||
    !DRIVE_FILE_ID_PATTERN.test(fileId)
  ) {
    throw new SaveShotError({
      code: 'INVALID_FILE_ID',
      userMessage: 'Invalid Google Drive file identifier.',
    });
  }
  return fileId;
}

/**
 * Verify whether a cached Drive folder still exists and is not in the trash.
 */
async function verifyFolder(
  token,
  folderId,
  expectedName,
  fetchImpl,
  retryOptions
) {
  if (
    !folderId ||
    typeof folderId !== 'string' ||
    DISALLOWED_OBJECT_KEYS.has(folderId) ||
    !DRIVE_FILE_ID_PATTERN.test(folderId)
  ) {
    return null;
  }

  const url = `${DRIVE_FILES_API}/${encodeURIComponent(
    folderId
  )}?fields=id,name,trashed,webViewLink`;

  let response;
  try {
    response = await fetchDriveWithRetry(
      url,
      { headers: { Authorization: `Bearer ${token}` } },
      { fetchImpl, timeoutMs: 10000, ...retryOptions }
    );
  } catch (err) {
    // 404 or file-specific 403 means cached folder was deleted or belonged to another account
    if (
      err.status === 404 ||
      err.code === 'DRIVE_FILE_FORBIDDEN' ||
      (err.status === 403 && err.code === 'DRIVE_ERROR')
    ) {
      return null;
    }
    throw err;
  }

  const folder = await response.json();
  if (folder.trashed || folder.name !== expectedName) {
    return null;
  }
  return {
    id: folder.id,
    name: folder.name,
    webViewLink:
      folder.webViewLink ||
      `https://drive.google.com/drive/folders/${folder.id}`,
  };
}

/**
 * Search for an existing folder created by this extension (works with narrow drive.file scope).
 */
async function findFolderByName(token, folderName, fetchImpl, retryOptions) {
  const escapedName = escapeDriveQueryValue(folderName);
  const query = `name='${escapedName}' and mimeType='${FOLDER_MIME_TYPE}' and trashed=false`;
  const params = new URLSearchParams({
    q: query,
    spaces: 'drive',
    fields: 'files(id,name,webViewLink)',
    pageSize: '1',
  });

  const response = await fetchDriveWithRetry(
    `${DRIVE_FILES_API}?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } },
    { fetchImpl, timeoutMs: 12000, ...retryOptions }
  );

  const data = await response.json();
  const match = data?.files?.[0];
  if (!match) return null;

  return {
    id: match.id,
    name: match.name,
    webViewLink:
      match.webViewLink ||
      `https://drive.google.com/drive/folders/${match.id}`,
  };
}

/**
 * Create a new folder in the user's Google Drive root.
 */
async function createFolder(token, folderName, fetchImpl, retryOptions) {
  const response = await fetchDriveWithRetry(
    `${DRIVE_FILES_API}?fields=id,name,webViewLink`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: FOLDER_MIME_TYPE,
      }),
    },
    { fetchImpl, timeoutMs: 12000, ...retryOptions }
  );

  const folder = await response.json();
  return {
    id: folder.id,
    name: folder.name,
    webViewLink:
      folder.webViewLink ||
      `https://drive.google.com/drive/folders/${folder.id}`,
  };
}

/**
 * Ensure the target Drive folder exists (checking cache -> searching -> creating).
 * Uses an in-flight lock so concurrent captures never create duplicate folders.
 */
export async function ensureDriveFolder(
  token,
  options = {},
  fetchImpl = fetch,
  retryOptions = {}
) {
  const opts =
    typeof options === 'string' ? { folderName: options } : options || {};
  const {
    folderName,
    cachedFolderId = null,
    accountKey = '',
    verifyTtlMs = 0,
  } = opts;
  const safeFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const normalizedName =
    (folderName || 'Chrome_SaveShot_ScreenShots').trim() || 'Chrome_SaveShot_ScreenShots';
  const lockKey = `${accountKey || token.slice(-12)}::${normalizedName}`;

  if (verifyTtlMs > 0 && cachedFolderId) {
    const cached = verifiedFolderCache.get(lockKey);
    if (
      cached &&
      cached.folder?.id === cachedFolderId &&
      cached.folder?.name === normalizedName &&
      Date.now() - cached.verifiedAt < verifyTtlMs
    ) {
      return cached.folder;
    }
  }

  if (inflightFolderPromises.has(lockKey)) {
    return inflightFolderPromises.get(lockKey);
  }

  const recordVerified = (folder) => {
    if (folder?.id) {
      verifiedFolderCache.set(lockKey, { folder, verifiedAt: Date.now() });
      while (verifiedFolderCache.size > 16) {
        const oldestKey = verifiedFolderCache.keys().next().value;
        if (!oldestKey) break;
        verifiedFolderCache.delete(oldestKey);
      }
    }
    return folder;
  };

  const task = (async () => {
    if (cachedFolderId) {
      const verified = await verifyFolder(
        token,
        cachedFolderId,
        normalizedName,
        safeFetch,
        retryOptions
      );
      if (verified) return recordVerified(verified);
      verifiedFolderCache.delete(lockKey);
    }

    const existing = await findFolderByName(
      token,
      normalizedName,
      safeFetch,
      retryOptions
    );
    if (existing) return recordVerified(existing);

    return recordVerified(
      await createFolder(token, normalizedName, safeFetch, retryOptions)
    );
  })();

  inflightFolderPromises.set(lockKey, task);
  try {
    return await task;
  } finally {
    inflightFolderPromises.delete(lockKey);
  }
}

/**
 * Upload a PNG screenshot Blob into the target Google Drive folder.
 */
export async function uploadScreenshotToDrive(
  token,
  { filename, pngBlob, folderId, pageUrl = '', incognito = false },
  fetchImpl = fetch,
  retryOptions = {}
) {
  const description =
    !incognito && pageUrl
      ? `Captured from ${pageUrl} using SaveShot`
      : 'Captured using SaveShot';

  const metadata = {
    name: filename,
    parents: folderId ? [folderId] : undefined,
    description,
  };

  const { contentType, body } = buildMultipartUploadBody(metadata, pngBlob);
  const uploadUrl = `${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id,name,webViewLink,createdTime,size`;

  const response = await fetchDriveWithRetry(
    uploadUrl,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': contentType,
      },
      body,
    },
    { fetchImpl, timeoutMs: 30000, ...retryOptions }
  );

  const file = await response.json();
  return {
    id: file.id,
    name: file.name,
    webViewLink:
      file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
    createdTime: file.createdTime || new Date().toISOString(),
    size: Number(file.size) || pngBlob.size,
  };
}

/**
 * Replace an existing screenshot's PNG content and/or filename in Google Drive using drive.file scope.
 * Preserves the exact same file ID and webViewLink. When pngBlob is null, performs a fast metadata-only rename.
 */
export async function updateScreenshotInDrive(
  token,
  { fileId, filename, pngBlob = null },
  fetchImpl = fetch,
  retryOptions = {}
) {
  const safeId = validateDriveFileId(fileId);
  const safeFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const metadata = { name: filename };

  let response;
  if (pngBlob) {
    const { contentType, body } = buildMultipartUploadBody(metadata, pngBlob);
    const updateUrl = `${DRIVE_UPLOAD_API}/${encodeURIComponent(
      safeId
    )}?uploadType=multipart&fields=id,name,webViewLink,modifiedTime,size`;

    response = await fetchDriveWithRetry(
      updateUrl,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': contentType,
        },
        body,
      },
      { fetchImpl: safeFetch, timeoutMs: 30000, ...retryOptions }
    );
  } else {
    const renameUrl = `${DRIVE_FILES_API}/${encodeURIComponent(
      safeId
    )}?fields=id,name,webViewLink,modifiedTime,size`;

    response = await fetchDriveWithRetry(
      renameUrl,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(metadata),
      },
      { fetchImpl: safeFetch, timeoutMs: 12000, ...retryOptions }
    );
  }

  const file = await response.json();
  const resolvedId = file.id || safeId;
  return {
    id: resolvedId,
    name: file.name || filename,
    webViewLink:
      file.webViewLink || `https://drive.google.com/file/d/${resolvedId}/view`,
    modifiedTime: file.modifiedTime || new Date().toISOString(),
    size: Number(file.size) || (pngBlob ? pngBlob.size : 0),
  };
}

/**
 * Download an existing screenshot created by SaveShot from Google Drive for editing.
 */
export async function downloadScreenshotFromDrive(
  token,
  fileId,
  fetchImpl = fetch,
  retryOptions = {}
) {
  const safeId = validateDriveFileId(fileId);
  const safeFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
  const mediaUrl = `${DRIVE_FILES_API}/${encodeURIComponent(safeId)}?alt=media`;

  const response = await fetchDriveWithRetry(
    mediaUrl,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
    { fetchImpl: safeFetch, timeoutMs: 25000, ...retryOptions }
  );

  const blob = await response.blob();
  if (!blob || blob.size === 0) {
    throw new SaveShotError({
      code: 'EMPTY_DRIVE_FILE',
      userMessage: 'The screenshot file in Google Drive could not be loaded.',
    });
  }

  if (blob.type === 'image/png') {
    return blob;
  }
  return new Blob([blob], { type: 'image/png' });
}

