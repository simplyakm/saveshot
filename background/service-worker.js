import {
  getSilentAuthSession,
  signIn,
  signOut,
  withAuthToken,
} from '../lib/auth.js';
import {
  blobToDataUrl,
  buildScreenshotFilename,
  createThumbnailDataUrl,
  cropPngDataUrl,
  dataUrlToBlob,
  isCapturableUrl,
  sanitizeScreenshotFilename,
} from '../lib/capture.js';
import {
  downloadScreenshotFromDrive,
  ensureDriveFolder,
  updateScreenshotInDrive,
  uploadScreenshotToDrive,
  validateDriveFileId,
} from '../lib/drive.js';
import { classifyCaptureError, SaveShotError } from '../lib/errors.js';
import {
  addRecentUpload,
  clearRecentUploads,
  getAccountFolderCache,
  getAuthState,
  getRecentUploads,
  getSettings,
  pruneStorage,
  saveAccountFolderCache,
  updateRecentUpload,
  updateSettings,
} from '../lib/storage.js';

const CONTENT_SCRIPT_ALLOWED_TYPES = new Set([
  'REGION_SELECTED',
  'CAPTURE_VISIBLE_FROM_OVERLAY',
  'GET_FALLBACK_PNG',
  'OPEN_LAST_CAPTURE_EDITOR',
]);

const MAX_CACHED_CAPTURES = 3;
const RECENT_CAPTURE_TTL_MS = 5 * 60 * 1000;
const MAX_RAM_EDITOR_SESSIONS = 6;
const MAX_PERSISTED_EDITOR_SESSIONS = 12;
const FALLBACK_SESSION_TTL_MS = 10 * 60 * 1000;
const REGION_SESSION_TTL_MS = 2 * 60 * 1000;
const MAX_EDITED_DATA_URL_LENGTH = 48 * 1024 * 1024;
const EDITOR_SESSION_ID_PATTERN = /^[a-zA-Z0-9-]{8,64}$/;
const DISALLOWED_SESSION_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
]);

const SESSION_META_MAP_KEY = 'editorSessionsById';
const PREUPLOAD_PNG_PREFIX = 'preUploadPng_';
const LAST_UPLOADED_META_KEY = 'lastUploadedMeta';
const FALLBACK_CAPTURE_KEY = 'lastFailedCaptureSession';
const PENDING_REGION_TABS_KEY = 'pendingRegionTabs';

export const CONTEXT_MENU_CAPTURE_ID = 'saveshot-take-screenshot';
export const CONTEXT_MENU_TITLE = 'Take Screenshot';
export const CONTEXT_MENU_URL_PATTERNS = Object.freeze([
  'http://*/*',
  'https://*/*',
  'file://*/*',
]);
export const CONTEXT_MENU_CONTEXTS = Object.freeze([
  'page',
  'frame',
  'selection',
  'link',
  'editable',
  'image',
  'video',
  'audio',
]);

let badgeClearTimer = null;
let lastCaptureTimestamp = 0;
let lastErrorCode = '';
let lastFailedCapture = null;
let fallbackExpiryTimer = null;
let contextMenuSyncChain = Promise.resolve(false);
let workerSessionEpoch = 0;
let sessionMetaWriteChain = Promise.resolve();

let lastUploadedFileId = '';
const recentUploadedCaptures = new Map();
const editorSessions = new Map();
const pendingRegionTabIds = new Map();
const inflightUploadsBySessionId = new Map();
const inflightSavesBySessionId = new Map();

export function isTrustedExtensionSender(sender) {
  const extOriginPrefix = chrome?.runtime?.getURL
    ? chrome.runtime.getURL('')
    : 'chrome-extension://';

  if (sender?.id && chrome?.runtime?.id && sender.id !== chrome.runtime.id) {
    return false;
  }
  if (typeof sender?.url === 'string' && sender.url.length > 0) {
    return sender.url.startsWith(extOriginPrefix);
  }
  if (sender?.tab) {
    const tabUrl = String(sender.tab.url || '');
    return tabUrl.startsWith(extOriginPrefix);
  }
  return true;
}

function getSessionStorageArea() {
  return chrome?.storage?.session || null;
}

async function sessionStoreGet(keys) {
  const area = getSessionStorageArea();
  if (!area) return {};
  try {
    return (await area.get(keys)) || {};
  } catch {
    return {};
  }
}

async function sessionStoreSet(items) {
  const area = getSessionStorageArea();
  if (!area) return false;
  try {
    await area.set(items);
    return true;
  } catch {
    return false;
  }
}

async function sessionStoreRemove(keys) {
  const area = getSessionStorageArea();
  if (!area) return;
  try {
    await area.remove(keys);
  } catch {
    // Ignore cleanup errors
  }
}

async function clearSessionStorageArea() {
  const area = getSessionStorageArea();
  if (!area) return;
  try {
    await area.clear();
  } catch {
    // Ignore cleanup errors
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearFallbackCapture() {
  if (fallbackExpiryTimer) {
    clearTimeout(fallbackExpiryTimer);
    fallbackExpiryTimer = null;
  }
  lastFailedCapture = null;
  sessionStoreRemove(FALLBACK_CAPTURE_KEY);
}

function storeFallbackCapture(blob, filename) {
  if (fallbackExpiryTimer) {
    clearTimeout(fallbackExpiryTimer);
    fallbackExpiryTimer = null;
  }
  const writeEpoch = workerSessionEpoch;
  lastFailedCapture = { blob, filename };
  fallbackExpiryTimer = setTimeout(clearFallbackCapture, 2 * 60 * 1000);
  fallbackExpiryTimer?.unref?.();

  // Also persist in chrome.storage.session so Save PNG locally survives MV3 30s SW idle sleep
  blobToDataUrl(blob)
    .then((dataUrl) => {
      if (writeEpoch !== workerSessionEpoch || !lastFailedCapture) return;
      return sessionStoreSet({
        [FALLBACK_CAPTURE_KEY]: {
          dataUrl,
          filename,
          expiresAt: Date.now() + FALLBACK_SESSION_TTL_MS,
        },
      });
    })
    .catch(() => {});
}

function deleteRecentCaptureEntry(fileId) {
  const existing = recentUploadedCaptures.get(fileId);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }
  recentUploadedCaptures.delete(fileId);
  if (lastUploadedFileId === fileId) {
    const keys = Array.from(recentUploadedCaptures.keys());
    lastUploadedFileId = keys.length > 0 ? keys[keys.length - 1] : '';
  }
}

function clearRecentCaptureCache() {
  for (const [, entry] of recentUploadedCaptures) {
    if (entry?.timer) clearTimeout(entry.timer);
  }
  recentUploadedCaptures.clear();
  lastUploadedFileId = '';
}

function cacheUploadedCapture(entry) {
  if (!entry?.fileId || !entry?.pngBlob) return;
  deleteRecentCaptureEntry(entry.fileId);

  while (recentUploadedCaptures.size >= MAX_CACHED_CAPTURES) {
    const oldestKey = recentUploadedCaptures.keys().next().value;
    if (!oldestKey) break;
    deleteRecentCaptureEntry(oldestKey);
  }

  const timer = setTimeout(() => {
    deleteRecentCaptureEntry(entry.fileId);
  }, RECENT_CAPTURE_TTL_MS);
  timer?.unref?.();

  recentUploadedCaptures.set(entry.fileId, { ...entry, timer });
  lastUploadedFileId = entry.fileId;

  sessionStoreSet({
    [LAST_UPLOADED_META_KEY]: {
      fileId: entry.fileId,
      filename: entry.filename,
      webViewLink: entry.webViewLink || '',
      folderName: entry.folderName || '',
      pageUrl: entry.pageUrl || '',
      pageTitle: entry.pageTitle || '',
      mode: entry.mode === 'region' ? 'region' : 'visible',
      incognito: Boolean(entry.incognito),
    },
  });
}

function normalizeUploadState(value) {
  if (value === 'uploading' || value === 'uploaded' || value === 'failed') {
    return value;
  }
  return 'idle';
}

function serializeSessionMeta(session) {
  return {
    sessionId: session.sessionId,
    mode: session.mode === 'new' ? 'new' : 'existing',
    fileId: session.fileId || null,
    filename: sanitizeScreenshotFilename(session.filename || 'Screenshot.png'),
    folderName: session.folderName || 'Chrome_SaveShot_ScreenShots',
    webViewLink: session.webViewLink || '',
    pageUrl: session.pageUrl || '',
    pageTitle: session.pageTitle || '',
    captureMode: session.captureMode === 'region' ? 'region' : 'visible',
    incognito: Boolean(session.incognito),
    justUploaded: Boolean(session.justUploaded),
    editorLoaded: Boolean(session.editorLoaded),
    uploadState: normalizeUploadState(session.uploadState),
    uploadError: typeof session.uploadError === 'string' ? session.uploadError : '',
    uploadErrorCode: typeof session.uploadErrorCode === 'string' ? session.uploadErrorCode : '',
    uploadRequiresReauth: Boolean(session.uploadRequiresReauth),
    updatedAt: Date.now(),
  };
}

function putRamEditorSession(session) {
  editorSessions.delete(session.sessionId);
  while (editorSessions.size >= MAX_RAM_EDITOR_SESSIONS) {
    const oldestId = editorSessions.keys().next().value;
    if (!oldestId) break;
    editorSessions.delete(oldestId);
  }
  editorSessions.set(session.sessionId, session);
}

function clearAllEditorSessions() {
  editorSessions.clear();
}

function broadcastEditorUploadStatus(session) {
  if (!session?.sessionId) return;
  const payload = {
    type: 'EDITOR_UPLOAD_STATUS',
    sessionId: session.sessionId,
    mode: session.mode === 'new' ? 'new' : 'existing',
    fileId: session.fileId || null,
    filename: sanitizeScreenshotFilename(session.filename || 'Screenshot.png'),
    folderName: session.folderName || 'Chrome_SaveShot_ScreenShots',
    webViewLink: session.webViewLink || '',
    uploadState: normalizeUploadState(session.uploadState),
    uploadError: typeof session.uploadError === 'string' ? session.uploadError : '',
    uploadErrorCode: typeof session.uploadErrorCode === 'string' ? session.uploadErrorCode : '',
    uploadRequiresReauth: Boolean(session.uploadRequiresReauth),
  };
  try {
    const maybePromise = chrome?.runtime?.sendMessage?.(payload);
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch(() => {});
    }
  } catch {
    // Ignore when no editor page is open to receive live updates
  }
}

async function reconcileInterruptedUpload(session) {
  if (
    session &&
    session.uploadState === 'uploading' &&
    !session.fileId &&
    !inflightUploadsBySessionId.has(session.sessionId)
  ) {
    session.uploadState = 'failed';
    session.uploadError =
      'Background upload was interrupted. Click Retry to save to Google Drive.';
    session.uploadErrorCode = 'UPLOAD_INTERRUPTED';
    session.uploadRequiresReauth = false;
    await persistEditorSessionMeta(session);
  }
  return session;
}

function persistEditorSessionMeta(
  session,
  { storePreUploadBlob = false, expectedEpoch = workerSessionEpoch } = {}
) {
  const writeEpoch = expectedEpoch;
  const runWrite = async () => {
    if (writeEpoch !== workerSessionEpoch) return;
    const data = await sessionStoreGet(SESSION_META_MAP_KEY);
    if (writeEpoch !== workerSessionEpoch) return;
    const existingMap =
      data?.[SESSION_META_MAP_KEY] && typeof data[SESSION_META_MAP_KEY] === 'object'
        ? { ...data[SESSION_META_MAP_KEY] }
        : {};

    delete existingMap[session.sessionId];
    existingMap[session.sessionId] = serializeSessionMeta(session);

    const ids = Object.keys(existingMap);
    const evictedPngKeys = [];
    while (ids.length > MAX_PERSISTED_EDITOR_SESSIONS) {
      const evictedId = ids.shift();
      delete existingMap[evictedId];
      evictedPngKeys.push(`${PREUPLOAD_PNG_PREFIX}${evictedId}`);
    }

    if (evictedPngKeys.length > 0) {
      await sessionStoreRemove(evictedPngKeys);
    }

    if (writeEpoch !== workerSessionEpoch) return;
    await sessionStoreSet({ [SESSION_META_MAP_KEY]: existingMap });

    if (storePreUploadBlob && session.mode === 'new' && session.pngBlob) {
      try {
        // Keep at most 2 pre-upload PNGs in chrome.storage.session, preferring to evict
        // already-loaded non-uploading sessions before unloaded or actively uploading ones
        const otherNewIds = Object.keys(existingMap).filter(
          (id) => id !== session.sessionId && existingMap[id]?.mode === 'new'
        );
        if (otherNewIds.length >= 2) {
          const evictionPriority = (id) => {
            const meta = existingMap[id];
            if (meta?.uploadState === 'uploading') return 2;
            if (!meta?.editorLoaded) return 1;
            return 0;
          };
          const orderedForEviction = [...otherNewIds].sort(
            (a, b) => evictionPriority(a) - evictionPriority(b)
          );
          const dropIds = orderedForEviction.slice(0, otherNewIds.length - 1);
          await sessionStoreRemove(dropIds.map((id) => `${PREUPLOAD_PNG_PREFIX}${id}`));
        }
        const dataUrl =
          typeof session.pngDataUrl === 'string' &&
          session.pngDataUrl.startsWith('data:image/png;base64,')
            ? session.pngDataUrl
            : await blobToDataUrl(session.pngBlob);
        if (writeEpoch !== workerSessionEpoch) return;
        session.pngDataUrl = dataUrl;
        await sessionStoreSet({
          [`${PREUPLOAD_PNG_PREFIX}${session.sessionId}`]: dataUrl,
        });
      } catch {
        // Best-effort if image exceeds session quota; RAM and editor canvas still hold pixels
      }
    }
  };

  sessionMetaWriteChain = sessionMetaWriteChain.catch(() => {}).then(runWrite);
  return sessionMetaWriteChain;
}

async function createEditorSession(data) {
  const sessionId = crypto.randomUUID();
  const session = {
    sessionId,
    mode: data.mode === 'new' ? 'new' : 'existing',
    fileId: data.fileId || null,
    filename: sanitizeScreenshotFilename(data.filename || 'Screenshot.png'),
    folderName: data.folderName || 'Chrome_SaveShot_ScreenShots',
    webViewLink: data.webViewLink || '',
    pngBlob: data.pngBlob || null,
    pngDataUrl: typeof data.pngDataUrl === 'string' ? data.pngDataUrl : '',
    pageUrl: data.pageUrl || '',
    pageTitle: data.pageTitle || '',
    captureMode: data.captureMode === 'region' ? 'region' : 'visible',
    incognito: Boolean(data.incognito),
    justUploaded: Boolean(data.justUploaded),
    editorLoaded: Boolean(data.editorLoaded),
    uploadState: normalizeUploadState(data.uploadState),
    uploadError: typeof data.uploadError === 'string' ? data.uploadError : '',
    uploadErrorCode: typeof data.uploadErrorCode === 'string' ? data.uploadErrorCode : '',
    uploadRequiresReauth: Boolean(data.uploadRequiresReauth),
  };

  putRamEditorSession(session);
  await persistEditorSessionMeta(session, {
    storePreUploadBlob: session.mode === 'new',
  });
  return session;
}

/**
 * Resolve an editor session across MV3 service-worker idle restarts:
 * 1. Fast L1 in-memory Map (0ms when SW stayed awake)
 * 2. L2 chrome.storage.session (survives 30-second MV3 SW idle termination)
 * 3. L3 trusted editor page fallback context (survives even manual extension reloads while signed in)
 */
async function resolveEditorSession(sessionId, fallbackContext = null) {
  if (
    typeof sessionId !== 'string' ||
    DISALLOWED_SESSION_KEYS.has(sessionId) ||
    !EDITOR_SESSION_ID_PATTERN.test(sessionId)
  ) {
    throw new SaveShotError({
      code: 'EDITOR_SESSION_EXPIRED',
      userMessage:
        'This editor session is invalid or expired. Capture a new screenshot or click Edit from the SaveShot popup.',
    });
  }

  const ramHit = editorSessions.get(sessionId);
  if (ramHit) {
    return ramHit;
  }

  const preUploadKey = `${PREUPLOAD_PNG_PREFIX}${sessionId}`;
  const stored = await sessionStoreGet([SESSION_META_MAP_KEY, preUploadKey]);
  const storedMap = stored?.[SESSION_META_MAP_KEY];
  const storedMeta =
    storedMap && typeof storedMap === 'object' && Object.hasOwn(storedMap, sessionId)
      ? storedMap[sessionId]
      : null;

  if (storedMeta && typeof storedMeta === 'object') {
    let pngBlob = null;
    if (typeof stored[preUploadKey] === 'string' && stored[preUploadKey].startsWith('data:image/')) {
      try {
        pngBlob = await dataUrlToBlob(stored[preUploadKey]);
      } catch {
        pngBlob = null;
      }
    }

    const rehydrated = {
      sessionId,
      mode: storedMeta.mode === 'new' ? 'new' : 'existing',
      fileId: storedMeta.fileId ? validateDriveFileId(storedMeta.fileId) : null,
      filename: sanitizeScreenshotFilename(storedMeta.filename || 'Screenshot.png'),
      folderName: storedMeta.folderName || 'Chrome_SaveShot_ScreenShots',
      webViewLink: storedMeta.webViewLink || '',
      pngBlob,
      pageUrl: storedMeta.pageUrl || '',
      pageTitle: storedMeta.pageTitle || '',
      captureMode: storedMeta.captureMode === 'region' ? 'region' : 'visible',
      incognito: Boolean(storedMeta.incognito),
      justUploaded: Boolean(storedMeta.justUploaded),
      editorLoaded: Boolean(storedMeta.editorLoaded),
      uploadState: normalizeUploadState(storedMeta.uploadState),
      uploadError: typeof storedMeta.uploadError === 'string' ? storedMeta.uploadError : '',
      uploadErrorCode:
        typeof storedMeta.uploadErrorCode === 'string' ? storedMeta.uploadErrorCode : '',
      uploadRequiresReauth: Boolean(storedMeta.uploadRequiresReauth),
    };
    putRamEditorSession(rehydrated);
    return rehydrated;
  }

  if (fallbackContext && typeof fallbackContext === 'object') {
    const mode = fallbackContext.mode === 'new' ? 'new' : 'existing';
    const auth = mode === 'existing' ? await getAuthState() : null;
    const fileId =
      mode === 'existing' && !auth?.signedOut && fallbackContext.fileId
        ? validateDriveFileId(fallbackContext.fileId)
        : null;

    if (mode === 'new' || fileId) {
      const reconstructed = {
        sessionId,
        mode,
        fileId,
        filename: sanitizeScreenshotFilename(fallbackContext.filename || 'Screenshot.png'),
        folderName: fallbackContext.folderName || 'Chrome_SaveShot_ScreenShots',
        webViewLink: typeof fallbackContext.webViewLink === 'string' ? fallbackContext.webViewLink : '',
        pngBlob: null,
        pageUrl: typeof fallbackContext.pageUrl === 'string' ? fallbackContext.pageUrl : '',
        pageTitle: typeof fallbackContext.pageTitle === 'string' ? fallbackContext.pageTitle : '',
        captureMode: fallbackContext.captureMode === 'region' ? 'region' : 'visible',
        incognito: Boolean(fallbackContext.incognito),
        justUploaded: false,
        editorLoaded: true,
        uploadState: fileId ? 'uploaded' : 'idle',
        uploadError: '',
        uploadErrorCode: '',
        uploadRequiresReauth: false,
      };
      putRamEditorSession(reconstructed);
      await persistEditorSessionMeta(reconstructed);
      return reconstructed;
    }
  }

  throw new SaveShotError({
    code: 'EDITOR_SESSION_EXPIRED',
    userMessage:
      'This editor session has expired. Capture a new screenshot or click Edit from the SaveShot popup.',
  });
}

async function registerPendingRegionTab(tabId) {
  if (typeof tabId !== 'number') return;
  const now = Date.now();
  for (const [id, exp] of pendingRegionTabIds) {
    if (exp <= now) pendingRegionTabIds.delete(id);
  }
  const expiresAt = now + REGION_SESSION_TTL_MS;
  pendingRegionTabIds.set(tabId, expiresAt);

  const stored = (await sessionStoreGet(PENDING_REGION_TABS_KEY))?.[PENDING_REGION_TABS_KEY];
  const nextMap = stored && typeof stored === 'object' ? { ...stored } : {};
  for (const [k, exp] of Object.entries(nextMap)) {
    if (Number(exp) <= now) delete nextMap[k];
  }
  nextMap[String(tabId)] = expiresAt;
  await sessionStoreSet({ [PENDING_REGION_TABS_KEY]: nextMap });
}

async function consumePendingRegionTab(tabId) {
  if (typeof tabId !== 'number') return false;
  const now = Date.now();
  const ramExp = pendingRegionTabIds.get(tabId);
  pendingRegionTabIds.delete(tabId);

  const stored = (await sessionStoreGet(PENDING_REGION_TABS_KEY))?.[PENDING_REGION_TABS_KEY];
  const nextMap = stored && typeof stored === 'object' ? { ...stored } : {};
  const storedExp = Number(nextMap[String(tabId)] || 0);
  delete nextMap[String(tabId)];
  for (const [k, exp] of Object.entries(nextMap)) {
    if (Number(exp) <= now) delete nextMap[k];
  }
  await sessionStoreSet({ [PENDING_REGION_TABS_KEY]: nextMap });

  return (typeof ramExp === 'number' && ramExp > now) || storedExp > now;
}

/**
 * Test helper to simulate Chrome terminating and cold-restarting the MV3 service worker
 * (wiping all module-level RAM Maps while preserving chrome.storage.session and chrome.storage.local).
 */
export function resetInMemoryWorkerStateForTests() {
  workerSessionEpoch += 1;
  clearRecentCaptureCache();
  clearAllEditorSessions();
  pendingRegionTabIds.clear();
  inflightUploadsBySessionId.clear();
  inflightSavesBySessionId.clear();
  if (fallbackExpiryTimer) {
    clearTimeout(fallbackExpiryTimer);
    fallbackExpiryTimer = null;
  }
  lastFailedCapture = null;
}

export async function waitForInflightUploadForTests(sessionId) {
  if (typeof sessionId === 'string' && inflightUploadsBySessionId.has(sessionId)) {
    return inflightUploadsBySessionId.get(sessionId);
  }
  if (!sessionId && inflightUploadsBySessionId.size > 0) {
    return Promise.all(Array.from(inflightUploadsBySessionId.values()));
  }
  return null;
}

globalThis.__saveshotResetRamForTest = resetInMemoryWorkerStateForTests;
globalThis.__saveshotWaitForUploadForTest = waitForInflightUploadForTests;

async function openEditorTab(sessionId, windowId) {
  const url = chrome.runtime.getURL(
    `pages/editor.html?session=${encodeURIComponent(sessionId)}`
  );
  if (typeof windowId === 'number') {
    try {
      await chrome.tabs.create({ url, windowId });
      return;
    } catch {
      // Source window closed between capture and tab creation; fall back to default window
    }
  }
  await chrome.tabs.create({ url });
}

function setBadge(text, color, autoClearMs = 0) {
  if (badgeClearTimer) {
    clearTimeout(badgeClearTimer);
    badgeClearTimer = null;
  }
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
  if (autoClearMs > 0) {
    badgeClearTimer = setTimeout(() => {
      chrome.action.setBadgeText({ text: '' });
      badgeClearTimer = null;
    }, autoClearMs);
    badgeClearTimer?.unref?.();
  }
}

async function isFileSchemeAllowed() {
  if (typeof chrome?.extension?.isAllowedFileSchemeAccess !== 'function') {
    return false;
  }
  return new Promise((resolve) => {
    chrome.extension.isAllowedFileSchemeAccess((allowed) => {
      void chrome.runtime.lastError;
      resolve(Boolean(allowed));
    });
  });
}

async function checkTabCapturable(tab) {
  const url = tab?.url || '';
  const allowFileScheme = url.startsWith('file:') ? await isFileSchemeAllowed() : true;
  return isCapturableUrl(url, { allowFileScheme });
}

async function resolveTargetTab(tabId) {
  if (typeof tabId === 'number') {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab) return tab;
    } catch {
      // Fall back to active tab in last focused window
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function captureVisibleTabSafe(windowId) {
  const elapsed = Date.now() - lastCaptureTimestamp;
  if (elapsed < 520) await sleep(520 - elapsed);

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    lastCaptureTimestamp = Date.now();
    return dataUrl;
  } catch (err) {
    const classified = classifyCaptureError(err);
    if (classified.code === 'CAPTURE_THROTTLED') {
      await sleep(560);
      try {
        const retryUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
        lastCaptureTimestamp = Date.now();
        return retryUrl;
      } catch (retryErr) {
        throw classifyCaptureError(retryErr);
      }
    }
    throw classified;
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/selector.js'],
    });
  } catch (err) {
    throw classifyCaptureError(err);
  }
}

async function sendMessageToContentScript(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await ensureContentScript(tabId);
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

async function hidePageUiBeforeCapture(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'HIDE_UI_FOR_CAPTURE' });
  } catch {
    // Content script not injected on this tab yet; nothing to hide
  }
}

async function sendTabToast(tabId, payload) {
  if (!tabId) return;
  try {
    let theme = payload?.theme;
    if (!theme) {
      const settings = await getSettings().catch(() => null);
      theme = settings?.theme || 'auto';
    }
    await sendMessageToContentScript(tabId, {
      type: 'SHOW_TOAST',
      payload: { ...payload, theme },
    });
  } catch {
    // Ignore if tab navigated or closed
  }
}

async function uploadCapturedBlob({
  pngBlob,
  tab,
  mode,
  interactiveAuth = false,
  customFilename = '',
  initialSettings = null,
  shouldAbort = null,
}) {
  clearFallbackCapture();
  const incognito = Boolean(tab?.incognito);
  const settings = initialSettings || (await getSettings());
  const defaultName = buildScreenshotFilename(tab?.url || '', new Date(), { incognito });
  const filename = customFilename
    ? sanitizeScreenshotFilename(customFilename, defaultName)
    : defaultName;

  let uploadResult;
  let thumbnailDataUrl = '';
  let latestSettings = settings;

  try {
    [thumbnailDataUrl, uploadResult] = await Promise.all([
      createThumbnailDataUrl(pngBlob).catch(() => ''),
      withAuthToken(
        async (token, email) => {
          const accountCache = getAccountFolderCache(settings, email);
          const folder = await ensureDriveFolder(token, {
            folderName: settings.folderName,
            cachedFolderId: accountCache.folderId,
            accountKey: email,
          });

          if (shouldAbort?.()) {
            return null;
          }

          if (
            folder.id !== accountCache.folderId ||
            folder.webViewLink !== accountCache.folderWebViewLink ||
            folder.id !== settings.folderId ||
            folder.webViewLink !== settings.folderWebViewLink
          ) {
            if (shouldAbort?.()) {
              return null;
            }
            latestSettings = await saveAccountFolderCache(email, {
              folderName: settings.folderName,
              folderId: folder.id,
              folderWebViewLink: folder.webViewLink,
            });
          }

          if (shouldAbort?.()) {
            return null;
          }

          const file = await uploadScreenshotToDrive(token, {
            filename,
            pngBlob,
            folderId: folder.id,
            pageUrl: tab?.url || '',
            incognito,
          });

          return { file, folder };
        },
        { interactive: interactiveAuth }
      ),
    ]);
  } catch (uploadErr) {
    if (shouldAbort?.()) {
      return { aborted: true };
    }
    const normalized =
      uploadErr instanceof SaveShotError ? uploadErr : classifyCaptureError(uploadErr);
    lastErrorCode = normalized.code || 'UPLOAD_ERROR';
    storeFallbackCapture(pngBlob, filename);
    normalized.hasFallback = true;
    normalized.fallbackFilename = filename;
    throw normalized;
  }

  if (shouldAbort?.() || !uploadResult?.file) {
    return { aborted: true };
  }

  lastErrorCode = '';
  const record = {
    id: uploadResult.file.id,
    name: uploadResult.file.name,
    webViewLink: uploadResult.file.webViewLink,
    createdTime: uploadResult.file.createdTime,
    pageTitle: incognito ? 'Incognito Screenshot' : tab?.title || '',
    folderName: uploadResult.folder.name,
    mode,
    thumbnailDataUrl: incognito ? '' : thumbnailDataUrl,
  };

  if (shouldAbort?.()) {
    return { aborted: true };
  }

  cacheUploadedCapture({
    fileId: record.id,
    pngBlob,
    filename: record.name,
    webViewLink: record.webViewLink,
    folderName: record.folderName,
    pageUrl: tab?.url || '',
    pageTitle: tab?.title || '',
    mode,
    incognito,
  });

  const recentUploads = incognito ? null : await addRecentUpload(record);
  if (shouldAbort?.()) {
    deleteRecentCaptureEntry(record.id);
    if (!incognito) {
      await clearRecentUploads().catch(() => {});
    }
    return { aborted: true };
  }

  return {
    upload: { ...record, previewThumbnail: thumbnailDataUrl },
    settings: latestSettings,
    recentUploads,
  };
}

function startBackgroundUploadForSession({
  session,
  pngBlob,
  tab,
  mode,
  interactiveAuth = false,
  settings,
  showPageToast = false,
  customFilename = '',
}) {
  const startEpoch = workerSessionEpoch;
  const sessionId = session.sessionId;
  const shouldAbort = () => workerSessionEpoch !== startEpoch;

  const uploadTask = (async () => {
    try {
      const result = await uploadCapturedBlob({
        pngBlob,
        tab,
        mode,
        interactiveAuth,
        customFilename: customFilename || session.filename,
        initialSettings: settings,
        shouldAbort,
      });

      if (shouldAbort() || result?.aborted) {
        return { ok: false, aborted: true };
      }

      setBadge('✓', '#15803d', 3000);

      session.mode = 'existing';
      session.fileId = result.upload.id;
      session.filename = result.upload.name;
      session.folderName = result.upload.folderName;
      session.webViewLink = result.upload.webViewLink;
      session.uploadState = 'uploaded';
      session.uploadError = '';
      session.uploadErrorCode = '';
      session.uploadRequiresReauth = false;
      session.justUploaded = !session.editorLoaded;

      await persistEditorSessionMeta(session, { expectedEpoch: startEpoch });
      if (shouldAbort()) {
        return { ok: false, aborted: true };
      }
      await sessionStoreRemove(`${PREUPLOAD_PNG_PREFIX}${sessionId}`);
      if (shouldAbort()) {
        return { ok: false, aborted: true };
      }
      broadcastEditorUploadStatus(session);

      if (showPageToast && tab?.id && !shouldAbort()) {
        sendTabToast(tab.id, {
          status: 'success',
          title: `Saved to "${result.upload.folderName}"`,
          message: result.upload.name,
          webViewLink: result.upload.webViewLink,
          thumbnailDataUrl: result.upload.previewThumbnail,
          autoCopyLink: Boolean(result.settings?.autoCopyLink),
          canEdit: true,
          theme: result.settings?.theme,
        }).catch(() => {});
      }

      return { ok: true, result };
    } catch (err) {
      if (shouldAbort()) {
        return { ok: false, aborted: true };
      }

      const normalized = err instanceof SaveShotError ? err : classifyCaptureError(err);
      lastErrorCode = normalized.code || 'UPLOAD_ERROR';
      setBadge('!', '#dc2626', 4000);

      session.mode = 'new';
      session.fileId = null;
      session.webViewLink = '';
      session.uploadState = 'failed';
      session.uploadError =
        normalized.userMessage || 'Could not upload screenshot to Google Drive.';
      session.uploadErrorCode = normalized.code || 'UPLOAD_ERROR';
      session.uploadRequiresReauth = Boolean(normalized.requiresReauth);
      session.justUploaded = false;

      await persistEditorSessionMeta(session, { expectedEpoch: startEpoch });
      if (shouldAbort()) {
        return { ok: false, aborted: true };
      }
      broadcastEditorUploadStatus(session);

      if (showPageToast && tab?.id && !shouldAbort()) {
        sendTabToast(tab.id, {
          status: 'error',
          title: 'Screenshot upload failed',
          message: normalized.userMessage,
          hasFallback: Boolean(normalized.hasFallback),
          fallbackFilename: normalized.fallbackFilename || session.filename || 'Screenshot.png',
          theme: settings?.theme,
        }).catch(() => {});
      }

      return { ok: false, error: normalized };
    } finally {
      if (inflightUploadsBySessionId.get(sessionId) === uploadTask) {
        inflightUploadsBySessionId.delete(sessionId);
      }
    }
  })();

  inflightUploadsBySessionId.set(sessionId, uploadTask);
  return uploadTask;
}

async function resolveDriveFolderLink({ prewarmOnly = false } = {}) {
  const settings = await getSettings();
  const folderName = settings.folderName || 'Chrome_SaveShot_ScreenShots';

  return withAuthToken(
    async (token, accountEmail) => {
      const accountCache = getAccountFolderCache(settings, accountEmail);
      if (prewarmOnly && accountCache.folderId && accountCache.folderWebViewLink) {
        return accountCache.folderWebViewLink;
      }

      const folder = await ensureDriveFolder(token, {
        folderName,
        cachedFolderId: accountCache.folderId,
        accountKey: accountEmail,
      });
      if (
        folder.id !== accountCache.folderId ||
        folder.webViewLink !== accountCache.folderWebViewLink ||
        folder.id !== settings.folderId ||
        folder.webViewLink !== settings.folderWebViewLink
      ) {
        await saveAccountFolderCache(accountEmail, {
          folderName: folder.name,
          folderId: folder.id,
          folderWebViewLink: folder.webViewLink,
        });
      }
      return folder.webViewLink;
    },
    { interactive: false }
  );
}

async function captureVisibleTabFlow({
  tab,
  tabId,
  showPageToast = false,
  interactiveAuth = false,
}) {
  const targetTab = tab || (await resolveTargetTab(tabId));
  const check = await checkTabCapturable(targetTab);
  if (!check.canCaptureVisible) {
    throw new SaveShotError({
      code: check.code || 'UNCAPTURABLE_TAB',
      userMessage: check.reason,
    });
  }

  setBadge('...', '#1a73e8');
  try {
    await hidePageUiBeforeCapture(targetTab.id);
    const dataUrl = await captureVisibleTabSafe(targetTab.windowId);
    const [pngBlob, settings, authSession] = await Promise.all([
      dataUrlToBlob(dataUrl),
      getSettings(),
      getSilentAuthSession(),
    ]);

    const incognito = Boolean(targetTab?.incognito);
    const filename = buildScreenshotFilename(targetTab?.url || '', new Date(), {
      incognito,
    });
    const shouldAutoUpload = Boolean(authSession.signedIn) && !settings.editBeforeUpload;

    const session = await createEditorSession({
      mode: 'new',
      fileId: null,
      filename,
      folderName: settings.folderName,
      webViewLink: '',
      pngBlob,
      pngDataUrl: dataUrl,
      pageUrl: targetTab?.url || '',
      pageTitle: targetTab?.title || '',
      captureMode: 'visible',
      incognito,
      uploadState: shouldAutoUpload ? 'uploading' : 'idle',
    });

    if (shouldAutoUpload) {
      startBackgroundUploadForSession({
        session,
        pngBlob,
        tab: targetTab,
        mode: 'visible',
        interactiveAuth,
        settings,
        showPageToast,
        customFilename: filename,
      });
    } else if (inflightUploadsBySessionId.size === 0) {
      setBadge('', '');
    }

    await openEditorTab(session.sessionId, targetTab?.windowId);
    return {
      openedEditor: true,
      uploadingInBackground: shouldAutoUpload,
      sessionId: session.sessionId,
      settings,
    };
  } catch (err) {
    const normalized = err instanceof SaveShotError ? err : classifyCaptureError(err);
    lastErrorCode = normalized.code || 'CAPTURE_ERROR';
    setBadge('!', '#dc2626', 4000);
    if (showPageToast) {
      await sendTabToast(targetTab?.id, {
        status: 'error',
        title: 'Screenshot capture failed',
        message: normalized.userMessage,
        hasFallback: Boolean(normalized.hasFallback),
        fallbackFilename: normalized.fallbackFilename || 'Screenshot.png',
      });
    }
    throw normalized;
  }
}

async function startRegionCaptureFlow({ tab, tabId } = {}) {
  const targetTab = tab || (await resolveTargetTab(tabId));
  const check = await checkTabCapturable(targetTab);
  if (!check.canCaptureVisible) {
    throw new SaveShotError({
      code: check.code || 'UNCAPTURABLE_TAB',
      userMessage: check.reason,
    });
  }
  if (!check.canCaptureRegion) {
    throw new SaveShotError({
      code: check.code || 'REGION_UNSUPPORTED',
      userMessage:
        check.regionDisabledReason ||
        'Region selection does not work on this page. Use "Visible Tab" instead.',
    });
  }

  const response = await sendMessageToContentScript(targetTab.id, {
    type: 'START_REGION_SELECT',
  });

  if (response && response.ok === false) {
    throw new SaveShotError({
      code: response.code || 'REGION_UNSUPPORTED',
      userMessage:
        response.reason ||
        'Region selection does not work on this page. Use "Visible Tab" instead.',
    });
  }

  await registerPendingRegionTab(targetTab.id);
}

async function handleRegionSelected(selection, senderTab) {
  if (!senderTab?.id) return;

  setBadge('...', '#1a73e8');
  try {
    const liveTab = await chrome.tabs.get(senderTab.id);
    if (!liveTab || !liveTab.active) {
      throw new SaveShotError({
        code: 'TAB_SWITCHED',
        userMessage: 'The tab changed before capture finished. Stay on the tab and try again.',
      });
    }

    const dataUrl = await captureVisibleTabSafe(liveTab.windowId);
    const [croppedBlob, settings, authSession] = await Promise.all([
      cropPngDataUrl(dataUrl, selection),
      getSettings(),
      getSilentAuthSession(),
    ]);

    const incognito = Boolean(liveTab?.incognito);
    const filename = buildScreenshotFilename(liveTab?.url || '', new Date(), {
      incognito,
    });
    const shouldAutoUpload = Boolean(authSession.signedIn) && !settings.editBeforeUpload;

    const session = await createEditorSession({
      mode: 'new',
      fileId: null,
      filename,
      folderName: settings.folderName,
      webViewLink: '',
      pngBlob: croppedBlob,
      pageUrl: liveTab?.url || '',
      pageTitle: liveTab?.title || '',
      captureMode: 'region',
      incognito,
      uploadState: shouldAutoUpload ? 'uploading' : 'idle',
    });

    if (shouldAutoUpload) {
      startBackgroundUploadForSession({
        session,
        pngBlob: croppedBlob,
        tab: liveTab,
        mode: 'region',
        interactiveAuth: false,
        settings,
        showPageToast: true,
        customFilename: filename,
      });
    } else if (inflightUploadsBySessionId.size === 0) {
      setBadge('', '');
    }

    await openEditorTab(session.sessionId, liveTab?.windowId);
  } catch (err) {
    const normalized = err instanceof SaveShotError ? err : classifyCaptureError(err);
    lastErrorCode = normalized.code || 'CAPTURE_ERROR';
    setBadge('!', '#dc2626', 4000);
    await sendTabToast(senderTab.id, {
      status: 'error',
      title: 'Screenshot capture failed',
      message: normalized.userMessage,
      hasFallback: Boolean(normalized.hasFallback),
      fallbackFilename: normalized.fallbackFilename || 'Screenshot.png',
    });
  }
}

async function parseEditedPngDataUrl(dataUrl) {
  if (
    typeof dataUrl !== 'string' ||
    !dataUrl.startsWith('data:image/png;base64,') ||
    dataUrl.length > MAX_EDITED_DATA_URL_LENGTH
  ) {
    throw new SaveShotError({
      code: 'INVALID_IMAGE_DATA',
      userMessage: 'Edited image data is invalid or exceeds the maximum supported size.',
    });
  }
  return dataUrlToBlob(dataUrl);
}

async function handleSaveEditedScreenshot(message) {
  const sessionKey = typeof message.sessionId === 'string' ? message.sessionId : '';
  const prevSave = sessionKey ? inflightSavesBySessionId.get(sessionKey) : null;

  const currentSave = (async () => {
    if (prevSave) {
      await prevSave;
    }
    return executeSaveEditedScreenshot(message);
  })();

  const settledSave = currentSave.then(
    () => {},
    () => {}
  );
  if (sessionKey) {
    inflightSavesBySessionId.set(sessionKey, settledSave);
  }

  try {
    return await currentSave;
  } finally {
    if (sessionKey && inflightSavesBySessionId.get(sessionKey) === settledSave) {
      inflightSavesBySessionId.delete(sessionKey);
    }
  }
}

async function executeSaveEditedScreenshot(message) {
  const startEpoch = workerSessionEpoch;

  // Race safety: if the initial background upload for this session is still in flight,
  // await it first so we PATCH that exact fileId instead of creating a duplicate Drive file.
  const inflightUpload =
    typeof message.sessionId === 'string'
      ? inflightUploadsBySessionId.get(message.sessionId)
      : null;
  if (inflightUpload) {
    const bgOutcome = await inflightUpload;
    if (bgOutcome?.aborted || workerSessionEpoch !== startEpoch) {
      throw new SaveShotError({
        code: 'AUTH_REQUIRED',
        userMessage: 'You signed out of Google Drive. Click "Save to Google Drive" to reconnect.',
        requiresReauth: true,
      });
    }
  }

  const [session, settings] = await Promise.all([
    resolveEditorSession(message.sessionId, message.sessionContext),
    getSettings(),
  ]);
  const saveMode = message.saveMode === 'new' ? 'new' : 'replace';
  const imageModified = Boolean(message.imageModified);
  const safeFilename = sanitizeScreenshotFilename(
    message.filename,
    session.filename || 'Screenshot.png'
  );

  // Branch 1: Replace existing Google Drive file in-place (preserving share link)
  if (session.mode === 'existing' && saveMode === 'replace' && session.fileId) {
    const pngBlob = imageModified
      ? await parseEditedPngDataUrl(message.dataUrl)
      : null;

    let updatedFile;
    let thumbnailDataUrl = '';
    try {
      [thumbnailDataUrl, updatedFile] = await Promise.all([
        pngBlob ? createThumbnailDataUrl(pngBlob).catch(() => '') : Promise.resolve(''),
        withAuthToken(
          (token) =>
            updateScreenshotInDrive(token, {
              fileId: session.fileId,
              filename: safeFilename,
              pngBlob,
            }),
          { interactive: false }
        ),
      ]);
    } catch (err) {
      const normalized = err instanceof SaveShotError ? err : classifyCaptureError(err);
      lastErrorCode = normalized.code || 'UPLOAD_ERROR';
      const fallbackBlob = pngBlob || session.pngBlob;
      if (fallbackBlob) {
        storeFallbackCapture(fallbackBlob, safeFilename);
        normalized.hasFallback = true;
        normalized.fallbackFilename = safeFilename;
      }
      throw normalized;
    }

    lastErrorCode = '';
    setBadge('✓', '#15803d', 3000);
    session.filename = updatedFile.name;
    session.webViewLink = updatedFile.webViewLink;
    session.uploadState = 'uploaded';
    session.uploadError = '';
    session.uploadErrorCode = '';
    session.uploadRequiresReauth = false;
    if (pngBlob) {
      session.pngBlob = pngBlob;
      session.pngDataUrl = '';
    }
    await persistEditorSessionMeta(session);

    if (session.pngBlob) {
      cacheUploadedCapture({
        fileId: updatedFile.id,
        pngBlob: session.pngBlob,
        filename: updatedFile.name,
        webViewLink: updatedFile.webViewLink,
        folderName: session.folderName || settings.folderName,
        pageUrl: session.pageUrl,
        pageTitle: session.pageTitle,
        mode: session.captureMode,
        incognito: session.incognito,
      });
    }

    if (!session.incognito) {
      await updateRecentUpload(updatedFile.id, {
        name: updatedFile.name,
        webViewLink: updatedFile.webViewLink,
        ...(pngBlob && thumbnailDataUrl ? { thumbnailDataUrl } : {}),
      });
    }

    return {
      ok: true,
      action: 'replaced',
      signedIn: true,
      upload: {
        id: updatedFile.id,
        name: updatedFile.name,
        webViewLink: updatedFile.webViewLink,
        folderName: session.folderName || settings.folderName,
      },
      autoCopyLink: Boolean(settings.autoCopyLink),
    };
  }

  // Branch 2: Upload as a brand-new screenshot file in Google Drive
  const uploadBlob =
    imageModified || !session.pngBlob
      ? await parseEditedPngDataUrl(message.dataUrl)
      : session.pngBlob;

  const authSession = await getSilentAuthSession();
  let activeSettings = settings;
  if (!authSession.signedIn) {
    await signIn();
    lastErrorCode = '';
    activeSettings = await getSettings();
  }

  const result = await uploadCapturedBlob({
    pngBlob: uploadBlob,
    tab: {
      url: session.pageUrl,
      title: session.pageTitle,
      incognito: session.incognito,
    },
    mode: session.captureMode,
    interactiveAuth: false,
    customFilename: safeFilename,
    initialSettings: activeSettings,
  });

  setBadge('✓', '#15803d', 3000);

  // Transition session to existing file so any subsequent save updates this uploaded file
  session.mode = 'existing';
  session.fileId = result.upload.id;
  session.filename = result.upload.name;
  session.webViewLink = result.upload.webViewLink;
  session.folderName = result.upload.folderName;
  session.pngBlob = uploadBlob;
  session.pngDataUrl = '';
  session.uploadState = 'uploaded';
  session.uploadError = '';
  session.uploadErrorCode = '';
  session.uploadRequiresReauth = false;
  await persistEditorSessionMeta(session);
  await sessionStoreRemove(`${PREUPLOAD_PNG_PREFIX}${session.sessionId}`);

  return {
    ok: true,
    action: 'created',
    signedIn: true,
    upload: {
      id: result.upload.id,
      name: result.upload.name,
      webViewLink: result.upload.webViewLink,
      folderName: result.upload.folderName,
    },
    autoCopyLink: Boolean(result.settings?.autoCopyLink),
  };
}

export function syncContextMenus() {
  contextMenuSyncChain = contextMenuSyncChain.catch(() => false).then(() => {
    if (!chrome?.contextMenus?.removeAll || !chrome?.contextMenus?.create) {
      return false;
    }
    return new Promise((resolve) => {
      try {
        chrome.contextMenus.removeAll(() => {
          void chrome.runtime?.lastError;
          try {
            chrome.contextMenus.create(
              {
                id: CONTEXT_MENU_CAPTURE_ID,
                title: CONTEXT_MENU_TITLE,
                contexts: [...CONTEXT_MENU_CONTEXTS],
                documentUrlPatterns: [...CONTEXT_MENU_URL_PATTERNS],
              },
              () => {
                void chrome.runtime?.lastError;
                resolve(true);
              }
            );
          } catch {
            resolve(false);
          }
        });
      } catch {
        resolve(false);
      }
    });
  });
  return contextMenuSyncChain;
}

async function triggerBackgroundRegionCapture(targetTab) {
  if (!targetTab?.id) return;
  try {
    await startRegionCaptureFlow({ tab: targetTab });
  } catch (err) {
    const normalized = err instanceof SaveShotError ? err : classifyCaptureError(err);
    lastErrorCode = normalized.code || 'CAPTURE_ERROR';
    setBadge('!', '#dc2626', 4000);
    await sendTabToast(targetTab.id, {
      status: 'error',
      title: 'Cannot start region capture',
      message: normalized.userMessage,
    });
  }
}

export function registerServiceWorkerListeners() {
  if (chrome?.runtime?.onInstalled) {
    chrome.runtime.onInstalled.addListener(async (details) => {
      await Promise.all([syncContextMenus(), pruneStorage().catch(() => {})]);
      if (details?.reason === 'install') {
        chrome.tabs.create({ url: chrome.runtime.getURL('pages/welcome.html') });
      }
    });
  }

  if (chrome?.runtime?.onStartup) {
    chrome.runtime.onStartup.addListener(() => {
      syncContextMenus();
    });
  }

  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || !message.type || message.type === 'EDITOR_UPLOAD_STATUS') {
        return false;
      }

      (async () => {
        try {
          if (
            !CONTENT_SCRIPT_ALLOWED_TYPES.has(message.type) &&
            !isTrustedExtensionSender(sender)
          ) {
            throw new SaveShotError({
              code: 'FORBIDDEN_SENDER',
              userMessage: 'Action is not permitted from webpage context.',
            });
          }

          switch (message.type) {
            case 'GET_STATE': {
              const tabCheckPromise = resolveTargetTab(message.tabId).then(
                async (tab) => ({
                  activeTab: tab,
                  capturable: await checkTabCapturable(tab),
                })
              );
              const [session, settings, recentUploads, { activeTab, capturable }] =
                await Promise.all([
                  getSilentAuthSession(),
                  getSettings(),
                  getRecentUploads(),
                  tabCheckPromise,
                ]);
              if (session?.signedIn && !settings?.folderWebViewLink) {
                resolveDriveFolderLink({ prewarmOnly: true }).catch(() => {});
              }
              sendResponse({
                ok: true,
                session,
                settings,
                recentUploads: session?.signedIn ? recentUploads : [],
                capturable,
                incognito: Boolean(activeTab?.incognito),
                lastErrorCode,
              });
              return;
            }

            case 'SIGN_IN': {
              const { token, profile } = await signIn();
              lastErrorCode = '';
              let settings = await getSettings();
              try {
                const email = profile?.email || '';
                const accountCache = getAccountFolderCache(settings, email);
                const folder = await ensureDriveFolder(token, {
                  folderName: settings.folderName || 'Chrome_SaveShot_ScreenShots',
                  cachedFolderId: accountCache.folderId,
                  accountKey: email,
                });
                if (
                  folder.id !== accountCache.folderId ||
                  folder.webViewLink !== accountCache.folderWebViewLink ||
                  folder.id !== settings.folderId ||
                  folder.webViewLink !== settings.folderWebViewLink
                ) {
                  settings = await saveAccountFolderCache(email, {
                    folderName: folder.name,
                    folderId: folder.id,
                    folderWebViewLink: folder.webViewLink,
                  });
                }
              } catch {
                // Non-fatal if network drops right after consent; upload or OPEN_DRIVE_FOLDER will retry
              }
              sendResponse({ ok: true, profile, settings });
              return;
            }

            case 'OPEN_DRIVE_FOLDER': {
              const url = await resolveDriveFolderLink();
              sendResponse({ ok: true, url });
              return;
            }

            case 'SIGN_OUT': {
              workerSessionEpoch += 1;
              inflightUploadsBySessionId.clear();
              inflightSavesBySessionId.clear();
              clearFallbackCapture();
              clearRecentCaptureCache();
              clearAllEditorSessions();
              pendingRegionTabIds.clear();
              lastErrorCode = '';
              setBadge('', '');
              sessionMetaWriteChain = sessionMetaWriteChain
                .catch(() => {})
                .then(() => clearSessionStorageArea());
              await Promise.all([sessionMetaWriteChain, signOut()]);
              sendResponse({ ok: true });
              return;
            }

            case 'UPDATE_SETTINGS': {
              const settings = await updateSettings(message.patch || {});
              sendResponse({ ok: true, settings });
              return;
            }

            case 'CLEAR_HISTORY': {
              await clearRecentUploads();
              sendResponse({ ok: true });
              return;
            }

            case 'CAPTURE_VISIBLE': {
              const result = await captureVisibleTabFlow({
                tabId: message.tabId,
                showPageToast: false,
                interactiveAuth: false,
              });
              sendResponse({
                ok: true,
                openedEditor: Boolean(result.openedEditor),
                uploadingInBackground: Boolean(result.uploadingInBackground),
                sessionId: result.sessionId || '',
                settings: result.settings,
              });
              return;
            }

            case 'START_REGION_CAPTURE': {
              await startRegionCaptureFlow({ tabId: message.tabId });
              sendResponse({ ok: true });
              return;
            }

            case 'REGION_SELECTED': {
              const senderTabId = sender?.tab?.id;
              const allowed = await consumePendingRegionTab(senderTabId);
              if (!allowed) {
                throw new SaveShotError({
                  code: 'NO_ACTIVE_REGION_SESSION',
                  userMessage: 'No active area selection on this tab.',
                });
              }
              sendResponse({ ok: true });
              await handleRegionSelected(message.selection, sender.tab);
              return;
            }

            case 'CAPTURE_VISIBLE_FROM_OVERLAY': {
              const senderTabId = sender?.tab?.id;
              const allowed = await consumePendingRegionTab(senderTabId);
              if (!allowed) {
                throw new SaveShotError({
                  code: 'NO_ACTIVE_REGION_SESSION',
                  userMessage: 'No active area selection on this tab.',
                });
              }
              const liveTab = await chrome.tabs.get(senderTabId);
              if (!liveTab || !liveTab.active) {
                const switchedErr = new SaveShotError({
                  code: 'TAB_SWITCHED',
                  userMessage:
                    'The tab changed before capture finished. Stay on the tab and try again.',
                });
                await sendTabToast(senderTabId, {
                  status: 'error',
                  title: 'Screenshot capture failed',
                  message: switchedErr.userMessage,
                });
                throw switchedErr;
              }
              const result = await captureVisibleTabFlow({
                tab: liveTab,
                showPageToast: true,
                interactiveAuth: false,
              });
              sendResponse({
                ok: true,
                openedEditor: Boolean(result.openedEditor),
                uploadingInBackground: Boolean(result.uploadingInBackground),
                sessionId: result.sessionId || '',
              });
              return;
            }

            case 'OPEN_LAST_CAPTURE_EDITOR': {
              const settings = await getSettings();
              const cached = lastUploadedFileId
                ? recentUploadedCaptures.get(lastUploadedFileId)
                : null;

              let session;
              if (cached) {
                session = await createEditorSession({
                  mode: 'existing',
                  fileId: cached.fileId,
                  filename: cached.filename,
                  folderName: cached.folderName || settings.folderName,
                  webViewLink: cached.webViewLink,
                  pngBlob: cached.pngBlob,
                  pageUrl: cached.pageUrl,
                  pageTitle: cached.pageTitle,
                  captureMode: cached.mode,
                  incognito: cached.incognito,
                });
              } else {
                const storedLast = (await sessionStoreGet(LAST_UPLOADED_META_KEY))?.[
                  LAST_UPLOADED_META_KEY
                ];
                if (storedLast?.fileId) {
                  const safeId = validateDriveFileId(storedLast.fileId);
                  session = await createEditorSession({
                    mode: 'existing',
                    fileId: safeId,
                    filename: storedLast.filename || 'Screenshot.png',
                    folderName: storedLast.folderName || settings.folderName,
                    webViewLink: storedLast.webViewLink || '',
                    pngBlob: null,
                    pageUrl: storedLast.pageUrl || '',
                    pageTitle: storedLast.pageTitle || '',
                    captureMode: storedLast.mode,
                    incognito: Boolean(storedLast.incognito),
                  });
                } else {
                  const [latest] = await getRecentUploads();
                  if (!latest?.id) {
                    throw new SaveShotError({
                      code: 'NO_RECENT_CAPTURE',
                      userMessage: 'No recent screenshot found to edit.',
                    });
                  }
                  const safeId = validateDriveFileId(latest.id);
                  session = await createEditorSession({
                    mode: 'existing',
                    fileId: safeId,
                    filename: latest.name || 'Screenshot.png',
                    folderName: settings.folderName,
                    webViewLink: latest.webViewLink || '',
                    pngBlob: null,
                    pageTitle: latest.pageTitle || '',
                    captureMode: latest.mode,
                    incognito: false,
                  });
                }
              }

              await openEditorTab(session.sessionId, sender?.tab?.windowId);
              sendResponse({ ok: true, sessionId: session.sessionId });
              return;
            }

            case 'OPEN_EDITOR': {
              const safeId = validateDriveFileId(message.fileId);
              const [settings, recentUploads] = await Promise.all([
                getSettings(),
                getRecentUploads(),
              ]);
              const cached = recentUploadedCaptures.get(safeId);
              const recentItem = recentUploads.find((item) => item.id === safeId);

              const session = await createEditorSession({
                mode: 'existing',
                fileId: safeId,
                filename:
                  message.filename ||
                  cached?.filename ||
                  recentItem?.name ||
                  'Screenshot.png',
                folderName:
                  message.folderName ||
                  cached?.folderName ||
                  settings.folderName,
                webViewLink:
                  message.webViewLink ||
                  cached?.webViewLink ||
                  recentItem?.webViewLink ||
                  '',
                pngBlob: cached?.pngBlob || null,
                pageUrl: cached?.pageUrl || '',
                pageTitle: cached?.pageTitle || recentItem?.pageTitle || '',
                captureMode: cached?.mode || recentItem?.mode || 'visible',
                incognito: Boolean(cached?.incognito),
              });

              await openEditorTab(session.sessionId);
              sendResponse({ ok: true, sessionId: session.sessionId });
              return;
            }

            case 'GET_EDITOR_SESSION': {
              const [session, settings, authSession] = await Promise.all([
                resolveEditorSession(message.sessionId),
                getSettings(),
                getSilentAuthSession(),
              ]);

              const wasLoaded = Boolean(session.editorLoaded);
              const stateBeforeLoad = normalizeUploadState(session.uploadState);

              await reconcileInterruptedUpload(session);

              if (!session.pngBlob) {
                if (!session.fileId) {
                  throw new SaveShotError({
                    code: 'EMPTY_CAPTURE',
                    userMessage: 'Screenshot data is no longer available.',
                  });
                }
                session.pngBlob = await withAuthToken(
                  (token) => downloadScreenshotFromDrive(token, session.fileId),
                  { interactive: false }
                );
                session.pngDataUrl = '';
              }

              let dataUrl = '';
              if (
                typeof session.pngDataUrl === 'string' &&
                session.pngDataUrl.startsWith('data:image/')
              ) {
                dataUrl = session.pngDataUrl;
                session.pngDataUrl = '';
              } else {
                dataUrl = await blobToDataUrl(session.pngBlob);
              }

              const currentUploadState = normalizeUploadState(session.uploadState);
              const transitionedDuringLoad =
                !wasLoaded &&
                stateBeforeLoad === 'uploading' &&
                currentUploadState === 'uploaded';
              const justUploaded = Boolean(session.justUploaded) || transitionedDuringLoad;
              session.editorLoaded = true;
              if (session.justUploaded) {
                session.justUploaded = false;
              }

              const sessionSnapshot = {
                sessionId: session.sessionId,
                mode: session.mode,
                signedIn: Boolean(authSession?.signedIn),
                fileId: session.fileId,
                filename: session.filename,
                folderName: session.folderName || settings.folderName,
                webViewLink: session.webViewLink || '',
                captureMode: session.captureMode || 'visible',
                pageUrl: session.pageUrl || '',
                pageTitle: session.pageTitle || '',
                incognito: Boolean(session.incognito),
                autoCopyLink: Boolean(settings.autoCopyLink),
                justUploaded,
                uploadState: currentUploadState,
                uploadError: session.uploadError || '',
                uploadErrorCode: session.uploadErrorCode || '',
                uploadRequiresReauth: Boolean(session.uploadRequiresReauth),
              };

              if (justUploaded || !wasLoaded) {
                await persistEditorSessionMeta(session);
              }

              sendResponse({
                ok: true,
                session: sessionSnapshot,
                dataUrl,
              });
              return;
            }

            case 'GET_EDITOR_UPLOAD_STATUS': {
              const [session, settings, authSession] = await Promise.all([
                resolveEditorSession(message.sessionId),
                getSettings(),
                getSilentAuthSession(),
              ]);

              await reconcileInterruptedUpload(session);

              sendResponse({
                ok: true,
                sessionId: session.sessionId,
                mode: session.mode,
                signedIn: Boolean(authSession?.signedIn),
                fileId: session.fileId,
                filename: session.filename,
                folderName: session.folderName || settings.folderName,
                webViewLink: session.webViewLink || '',
                uploadState: normalizeUploadState(session.uploadState),
                uploadError: session.uploadError || '',
                uploadErrorCode: session.uploadErrorCode || '',
                uploadRequiresReauth: Boolean(session.uploadRequiresReauth),
              });
              return;
            }

            case 'SAVE_EDITED_SCREENSHOT': {
              const res = await handleSaveEditedScreenshot(message);
              sendResponse(res);
              return;
            }

            case 'GET_FALLBACK_PNG': {
              if (lastFailedCapture?.blob) {
                const dataUrl = await blobToDataUrl(lastFailedCapture.blob);
                sendResponse({
                  ok: true,
                  dataUrl,
                  filename: lastFailedCapture.filename,
                });
                return;
              }

              const storedFallback = (await sessionStoreGet(FALLBACK_CAPTURE_KEY))?.[
                FALLBACK_CAPTURE_KEY
              ];
              if (
                storedFallback?.dataUrl &&
                storedFallback.expiresAt > Date.now()
              ) {
                sendResponse({
                  ok: true,
                  dataUrl: storedFallback.dataUrl,
                  filename: storedFallback.filename || 'Screenshot.png',
                });
                return;
              }

              sendResponse({ ok: false, error: 'Saved screenshot is no longer in memory.' });
              return;
            }

            default:
              sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
          }
        } catch (err) {
          const normalized = err instanceof SaveShotError ? err : classifyCaptureError(err);
          lastErrorCode = normalized.code || 'ERROR';
          sendResponse({
            ok: false,
            code: normalized.code || 'ERROR',
            error: normalized.userMessage || err?.message || 'Something went wrong.',
            requiresReauth: Boolean(normalized.requiresReauth),
            hasFallback: Boolean(normalized.hasFallback),
            fallbackFilename: normalized.fallbackFilename || '',
          });
        }
      })();

      return true;
    });
  }

  if (chrome?.commands?.onCommand) {
    chrome.commands.onCommand.addListener(async (command, tab) => {
      const activeTab =
        (tab && typeof tab.id === 'number' && tab.id >= 0 ? tab : null) ||
        (await resolveTargetTab());
      if (!activeTab) return;

      if (command === 'capture-visible') {
        try {
          await captureVisibleTabFlow({
            tab: activeTab,
            showPageToast: true,
            interactiveAuth: false,
          });
        } catch {
          // Surfaced via toast and badge
        }
      } else if (command === 'capture-region') {
        await triggerBackgroundRegionCapture(activeTab);
      }
    });
  }

  if (chrome?.contextMenus?.onClicked) {
    chrome.contextMenus.onClicked.addListener(handleContextMenuClicked);
  }
}

export async function handleContextMenuClicked(info, tab) {
  if (info?.menuItemId !== CONTEXT_MENU_CAPTURE_ID) return;
  const targetTab =
    (tab && typeof tab.id === 'number' && tab.id >= 0 ? tab : null) ||
    (await resolveTargetTab());
  await triggerBackgroundRegionCapture(targetTab);
}

globalThis.__saveshotTriggerContextMenuForTest = handleContextMenuClicked;

registerServiceWorkerListeners();
