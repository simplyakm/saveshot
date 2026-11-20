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
} from '../lib/capture.js';
import { ensureDriveFolder, uploadScreenshotToDrive } from '../lib/drive.js';
import { classifyCaptureError, SaveShotError } from '../lib/errors.js';
import {
  addRecentUpload,
  clearRecentUploads,
  getAccountFolderCache,
  getRecentUploads,
  getSettings,
  pruneStorage,
  saveAccountFolderCache,
  updateSettings,
} from '../lib/storage.js';

let badgeClearTimer = null;
let lastCaptureTimestamp = 0;
let lastErrorCode = '';
let lastFailedCapture = null;
let fallbackExpiryTimer = null;

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

async function uploadCapturedBlob({ pngBlob, tab, mode, interactiveAuth = false }) {
  clearFallbackCapture();
  const incognito = Boolean(tab?.incognito);
  const settings = await getSettings();
  const filename = buildScreenshotFilename(tab?.url || '', new Date(), { incognito });

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

async function captureVisibleTabFlow({ tab, tabId, showPageToast = false, interactiveAuth = false }) {
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

    if (showPageToast) {
      await sendTabToast(targetTab.id, {
        status: 'uploading',
        title: 'Uploading screenshot...',
        message: 'Saving to Google Drive',
      });
    }

    const pngBlob = await dataUrlToBlob(dataUrl);
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

    await sendTabToast(liveTab.id, {
      status: 'uploading',
      title: 'Uploading region screenshot...',
      message: 'Saving to Google Drive',
    });

    const croppedBlob = await cropPngDataUrl(dataUrl, selection);
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
          switch (message.type) {
            case 'GET_STATE': {
              const activeTab = await resolveTargetTab(message.tabId);
              const [session, settings, recentUploads, capturable] = await Promise.all([
                getSilentAuthSession(),
                getSettings(),
                getRecentUploads(),
                checkTabCapturable(activeTab),
              ]);
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
              const { profile } = await signIn();
              lastErrorCode = '';
              // Best-effort pre-warm destination folder link so "Open screenshots folder" works immediately
              resolveDriveFolderLink({ prewarmOnly: true }).catch(() => {});
              sendResponse({ ok: true, profile });
              return;
            }

            case 'OPEN_DRIVE_FOLDER': {
              const url = await resolveDriveFolderLink();
              sendResponse({ ok: true, url });
              return;
            }

            case 'SIGN_OUT': {
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
