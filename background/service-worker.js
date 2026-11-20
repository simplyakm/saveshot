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
  getRecentUploads,
  getSettings,
  pruneStorage,
  saveAccountFolderCache,
  updateRecentUpload,
  updateSettings,
} from '../lib/storage.js';

const CONTENT_SCRIPT_ALLOWED_TYPES = new Set([
  'REGION_SELECTED',
  'GET_FALLBACK_PNG',
  'OPEN_LAST_CAPTURE_EDITOR',
]);

const MAX_CACHED_CAPTURES = 3;
const RECENT_CAPTURE_TTL_MS = 5 * 60 * 1000;
const MAX_EDITOR_SESSIONS = 4;
const EDITOR_SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_EDITED_DATA_URL_LENGTH = 48 * 1024 * 1024;
const EDITOR_SESSION_ID_PATTERN = /^[a-zA-Z0-9-]{8,64}$/;

let badgeClearTimer = null;
let lastCaptureTimestamp = 0;
let lastErrorCode = '';
let lastFailedCapture = null;
let fallbackExpiryTimer = null;

let lastUploadedFileId = '';
const recentUploadedCaptures = new Map();
const editorSessions = new Map();

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearFallbackCapture() {
  if (fallbackExpiryTimer) {
    clearTimeout(fallbackExpiryTimer);
    fallbackExpiryTimer = null;
  }
  lastFailedCapture = null;
}

function storeFallbackCapture(blob, filename) {
  clearFallbackCapture();
  lastFailedCapture = { blob, filename };
  fallbackExpiryTimer = setTimeout(clearFallbackCapture, 2 * 60 * 1000);
  fallbackExpiryTimer?.unref?.();
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
}

function deleteEditorSession(sessionId) {
  const existing = editorSessions.get(sessionId);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }
  editorSessions.delete(sessionId);
}

function clearAllEditorSessions() {
  for (const [, entry] of editorSessions) {
    if (entry?.timer) clearTimeout(entry.timer);
  }
  editorSessions.clear();
}

function createEditorSession(data) {
  while (editorSessions.size >= MAX_EDITOR_SESSIONS) {
    const oldestId = editorSessions.keys().next().value;
    if (!oldestId) break;
    deleteEditorSession(oldestId);
  }

  const sessionId = crypto.randomUUID();
  const timer = setTimeout(() => {
    deleteEditorSession(sessionId);
  }, EDITOR_SESSION_TTL_MS);
  timer?.unref?.();

  const session = {
    sessionId,
    mode: data.mode === 'new' ? 'new' : 'existing',
    fileId: data.fileId || null,
    filename: sanitizeScreenshotFilename(data.filename || 'Screenshot.png'),
    folderName: data.folderName || 'Chrome_SaveShot_ScreenShots',
    webViewLink: data.webViewLink || '',
    pngBlob: data.pngBlob || null,
    pageUrl: data.pageUrl || '',
    pageTitle: data.pageTitle || '',
    captureMode: data.captureMode === 'region' ? 'region' : 'visible',
    incognito: Boolean(data.incognito),
    timer,
  };

  editorSessions.set(sessionId, session);
  return session;
}

function getValidEditorSession(sessionId) {
  if (typeof sessionId !== 'string' || !EDITOR_SESSION_ID_PATTERN.test(sessionId)) {
    throw new SaveShotError({
      code: 'EDITOR_SESSION_EXPIRED',
      userMessage:
        'This editor session is invalid or expired. Capture a new screenshot or click Edit from the SaveShot popup.',
    });
  }
  const session = editorSessions.get(sessionId);
  if (!session) {
    throw new SaveShotError({
      code: 'EDITOR_SESSION_EXPIRED',
      userMessage:
        'This editor session has expired. Capture a new screenshot or click Edit from the SaveShot popup.',
    });
  }
  return session;
}

async function openEditorTab(sessionId, windowId) {
  const url = chrome.runtime.getURL(
    `pages/editor.html?session=${encodeURIComponent(sessionId)}`
  );
  const opts = typeof windowId === 'number' ? { url, windowId } : { url };
  await chrome.tabs.create(opts);
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
    await sendMessageToContentScript(tabId, { type: 'SHOW_TOAST', payload });
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
}) {
  clearFallbackCapture();
  const incognito = Boolean(tab?.incognito);
  const settings = await getSettings();
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

          if (
            folder.id !== accountCache.folderId ||
            folder.webViewLink !== accountCache.folderWebViewLink ||
            folder.id !== settings.folderId ||
            folder.webViewLink !== settings.folderWebViewLink
          ) {
            latestSettings = await saveAccountFolderCache(email, {
              folderName: settings.folderName,
              folderId: folder.id,
              folderWebViewLink: folder.webViewLink,
            });
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
    const normalized =
      uploadErr instanceof SaveShotError ? uploadErr : classifyCaptureError(uploadErr);
    lastErrorCode = normalized.code || 'UPLOAD_ERROR';
    storeFallbackCapture(pngBlob, filename);
    normalized.hasFallback = true;
    normalized.fallbackFilename = filename;
    throw normalized;
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

  if (!incognito) {
    await addRecentUpload(record);
  }

  return {
    upload: { ...record, previewThumbnail: thumbnailDataUrl },
    settings: latestSettings,
  };
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
      await saveAccountFolderCache(accountEmail, {
        folderName: folder.name,
        folderId: folder.id,
        folderWebViewLink: folder.webViewLink,
      });
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
    const pngBlob = await dataUrlToBlob(dataUrl);
    const settings = await getSettings();

    if (settings.editBeforeUpload) {
      const incognito = Boolean(targetTab?.incognito);
      const filename = buildScreenshotFilename(targetTab?.url || '', new Date(), {
        incognito,
      });
      const session = createEditorSession({
        mode: 'new',
        fileId: null,
        filename,
        folderName: settings.folderName,
        webViewLink: '',
        pngBlob,
        pageUrl: targetTab?.url || '',
        pageTitle: targetTab?.title || '',
        captureMode: 'visible',
        incognito,
      });
      setBadge('', '');
      await openEditorTab(session.sessionId, targetTab?.windowId);
      return { openedEditor: true, sessionId: session.sessionId, settings };
    }

    if (showPageToast) {
      await sendTabToast(targetTab.id, {
        status: 'uploading',
        title: 'Uploading screenshot...',
        message: 'Saving to Google Drive',
      });
    }

    const result = await uploadCapturedBlob({
      pngBlob,
      tab: targetTab,
      mode: 'visible',
      interactiveAuth,
    });

    setBadge('✓', '#1e8e3e', 3000);

    if (showPageToast) {
      await sendTabToast(targetTab.id, {
        status: 'success',
        title: `Saved to "${result.upload.folderName}"`,
        message: result.upload.name,
        webViewLink: result.upload.webViewLink,
        thumbnailDataUrl: result.upload.previewThumbnail,
        autoCopyLink: Boolean(result.settings?.autoCopyLink),
        canEdit: true,
      });
    }

    return result;
  } catch (err) {
    const normalized = err instanceof SaveShotError ? err : classifyCaptureError(err);
    lastErrorCode = normalized.code || 'CAPTURE_ERROR';
    setBadge('!', '#d93025', 4000);
    if (showPageToast) {
      await sendTabToast(targetTab?.id, {
        status: 'error',
        title: 'Screenshot upload failed',
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

  const session = await getSilentAuthSession();
  if (!session.signedIn) {
    throw new SaveShotError({
      code: 'AUTH_REQUIRED',
      userMessage: 'Connect Google Drive first by clicking the SaveShot icon in Chrome.',
      requiresReauth: true,
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
    const croppedBlob = await cropPngDataUrl(dataUrl, selection);
    const settings = await getSettings();

    if (settings.editBeforeUpload) {
      const incognito = Boolean(liveTab?.incognito);
      const filename = buildScreenshotFilename(liveTab?.url || '', new Date(), {
        incognito,
      });
      const session = createEditorSession({
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
      });
      setBadge('', '');
      await openEditorTab(session.sessionId, liveTab?.windowId);
      return;
    }

    await sendTabToast(liveTab.id, {
      status: 'uploading',
      title: 'Uploading region screenshot...',
      message: 'Saving to Google Drive',
    });

    const result = await uploadCapturedBlob({
      pngBlob: croppedBlob,
      tab: liveTab,
      mode: 'region',
      interactiveAuth: false,
    });

    setBadge('✓', '#1e8e3e', 3000);
    await sendTabToast(liveTab.id, {
      status: 'success',
      title: `Saved to "${result.upload.folderName}"`,
      message: result.upload.name,
      webViewLink: result.upload.webViewLink,
      thumbnailDataUrl: result.upload.previewThumbnail,
      autoCopyLink: Boolean(result.settings?.autoCopyLink),
      canEdit: true,
    });
  } catch (err) {
    const normalized = err instanceof SaveShotError ? err : classifyCaptureError(err);
    lastErrorCode = normalized.code || 'CAPTURE_ERROR';
    setBadge('!', '#d93025', 4000);
    await sendTabToast(senderTab.id, {
      status: 'error',
      title: 'Screenshot upload failed',
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
  const session = getValidEditorSession(message.sessionId);
  const settings = await getSettings();
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
    session.filename = updatedFile.name;
    session.webViewLink = updatedFile.webViewLink;
    if (pngBlob) {
      session.pngBlob = pngBlob;
    }

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
  });

  // Transition session to existing file so any subsequent save updates this uploaded file
  session.mode = 'existing';
  session.fileId = result.upload.id;
  session.filename = result.upload.name;
  session.webViewLink = result.upload.webViewLink;
  session.folderName = result.upload.folderName;
  session.pngBlob = uploadBlob;

  return {
    ok: true,
    action: 'created',
    upload: {
      id: result.upload.id,
      name: result.upload.name,
      webViewLink: result.upload.webViewLink,
      folderName: result.upload.folderName,
    },
    autoCopyLink: Boolean(result.settings?.autoCopyLink),
  };
}

export function registerServiceWorkerListeners() {
  if (chrome?.runtime?.onInstalled) {
    chrome.runtime.onInstalled.addListener(async (details) => {
      await pruneStorage().catch(() => {});
      if (details.reason === 'install') {
        chrome.tabs.create({ url: chrome.runtime.getURL('pages/welcome.html') });
      }
    });
  }

  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || !message.type) return false;

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
              const activeTab = await resolveTargetTab(message.tabId);
              const [session, settings, recentUploads, capturable] = await Promise.all([
                getSilentAuthSession(),
                getSettings(),
                getRecentUploads(),
                checkTabCapturable(activeTab),
              ]);
              if (session?.signedIn && !settings?.folderWebViewLink) {
                resolveDriveFolderLink({ prewarmOnly: true }).catch(() => {});
              }
              sendResponse({
                ok: true,
                session,
                settings,
                recentUploads,
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
                settings = await saveAccountFolderCache(email, {
                  folderName: folder.name,
                  folderId: folder.id,
                  folderWebViewLink: folder.webViewLink,
                });
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
              clearFallbackCapture();
              clearRecentCaptureCache();
              clearAllEditorSessions();
              await signOut();
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
              if (result.openedEditor) {
                sendResponse({
                  ok: true,
                  openedEditor: true,
                  sessionId: result.sessionId,
                  settings: result.settings,
                });
                return;
              }
              const recentUploads = await getRecentUploads();
              sendResponse({
                ok: true,
                upload: result.upload,
                settings: result.settings,
                recentUploads,
              });
              return;
            }

            case 'START_REGION_CAPTURE': {
              await startRegionCaptureFlow({ tabId: message.tabId });
              sendResponse({ ok: true });
              return;
            }

            case 'REGION_SELECTED': {
              sendResponse({ ok: true });
              await handleRegionSelected(message.selection, sender.tab);
              return;
            }

            case 'OPEN_LAST_CAPTURE_EDITOR': {
              const settings = await getSettings();
              const cached = lastUploadedFileId
                ? recentUploadedCaptures.get(lastUploadedFileId)
                : null;

              let session;
              if (cached) {
                session = createEditorSession({
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
                const [latest] = await getRecentUploads();
                if (!latest?.id) {
                  throw new SaveShotError({
                    code: 'NO_RECENT_CAPTURE',
                    userMessage: 'No recent screenshot found to edit.',
                  });
                }
                const safeId = validateDriveFileId(latest.id);
                session = createEditorSession({
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

              const session = createEditorSession({
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
              const session = getValidEditorSession(message.sessionId);
              const settings = await getSettings();

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
              }

              const dataUrl = await blobToDataUrl(session.pngBlob);
              sendResponse({
                ok: true,
                session: {
                  sessionId: session.sessionId,
                  mode: session.mode,
                  fileId: session.fileId,
                  filename: session.filename,
                  folderName: session.folderName || settings.folderName,
                  webViewLink: session.webViewLink || '',
                  incognito: Boolean(session.incognito),
                  autoCopyLink: Boolean(settings.autoCopyLink),
                },
                dataUrl,
              });
              return;
            }

            case 'SAVE_EDITED_SCREENSHOT': {
              const res = await handleSaveEditedScreenshot(message);
              sendResponse(res);
              return;
            }

            case 'GET_FALLBACK_PNG': {
              if (!lastFailedCapture?.blob) {
                sendResponse({ ok: false, error: 'Saved screenshot is no longer in memory.' });
                return;
              }
              const dataUrl = await blobToDataUrl(lastFailedCapture.blob);
              sendResponse({
                ok: true,
                dataUrl,
                filename: lastFailedCapture.filename,
              });
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
      const activeTab = tab || (await resolveTargetTab());
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
        try {
          await startRegionCaptureFlow({ tab: activeTab });
        } catch (err) {
          const normalized = err instanceof SaveShotError ? err : classifyCaptureError(err);
          lastErrorCode = normalized.code || 'CAPTURE_ERROR';
          await sendTabToast(activeTab.id, {
            status: 'error',
            title: 'Cannot start region capture',
            message: normalized.userMessage,
          });
        }
      }
    });
  }
}

registerServiceWorkerListeners();
