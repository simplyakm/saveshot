import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  blobToDataUrl,
  buildScreenshotFilename,
  computeCropRect,
  dataUrlToBlob,
  FULLPAGE_LIMITS,
  isCapturableUrl,
  planFullPageSlice,
  sanitizeScreenshotFilename,
} from '../lib/capture.js';
import {
  buildMultipartUploadBody,
  downloadScreenshotFromDrive,
  ensureDriveFolder,
  escapeDriveQueryValue,
  fetchDriveWithRetry,
  updateScreenshotInDrive,
  uploadScreenshotToDrive,
  validateDriveFileId,
} from '../lib/drive.js';
import {
  clearAllCachedTokens,
  fetchGoogleUserInfo,
  getSilentAuthSession,
  isClientIdConfigured,
  PLACEHOLDER_CLIENT_ID,
  removeCachedToken,
  resetAuthMemoryForTests,
  signIn,
  signOut,
  withAuthToken,
} from '../lib/auth.js';
import {
  classifyAuthError,
  classifyCaptureError,
  classifyDriveHttpError,
} from '../lib/errors.js';
import {
  addRecentUpload,
  getAccountFolderCache,
  getRecentUploads,
  getSettings,
  normalizeAutoCopyMode,
  normalizeThemeSetting,
  pruneStorage,
  sanitizeFolderName,
  saveAccountFolderCache,
  setAuthState,
  updateRecentUpload,
  updateSettings,
} from '../lib/storage.js';
import {
  DEFAULT_CWS_SUPPORT_URL,
  formatVersionInfoLine,
  getEnvironmentSummary,
} from '../lib/feedback.js';
import {
  addCaptionBarToCanvas,
  applyPixelateRect,
  CAPTION_THEMES,
  clampPoint,
  computeArrowGeometry,
  computePastedImageBox,
  cropSourceToCanvas,
  EDITOR_TOOLS,
  FONT_SIZES,
  HIGHLIGHTER_ALPHA,
  HIGHLIGHTER_SIZES,
  normalizeRect,
  parseHexColorInput,
  PIXELATE_BLOCK_SIZES,
  REDACT_MODES,
  renderAnnotation,
  sanitizeHexColor,
  TEXT_STYLES,
  transformSourceToCanvas,
} from '../lib/editor-core.js';
import {
  applyDocumentTheme,
  formatShortcutDisplay,
  initThemeSync,
  normalizeTheme,
  safeHttpsUrl,
  sendRuntimeMessage,
  VALID_THEMES,
} from '../lib/ui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function installChromeMock({
  clientId = '1234567890-realclient.apps.googleusercontent.com',
  initialStore = {},
  onGetAuthToken = null,
  failStorageSetOnce = false,
  failStorageSetCount = 0,
  tabs = [{ id: 10, windowId: 1, active: true, url: 'https://example.com/app', title: 'Example App', incognito: false }],
  allowFileScheme = false,
  onCaptureVisibleTab = null,
  onTabSendMessage = null,
  onExecuteScript = null,
} = {}) {
  resetAuthMemoryForTests();
  const store = structuredClone(initialStore);
  const removedTokens = [];
  const createdTabs = [];
  const sentTabMessages = [];
  const badges = [];
  let executeScriptCalls = 0;
  let clearedAll = false;
  let tokenCounter = 0;
  let remainingSetFailures = failStorageSetCount || (failStorageSetOnce ? 1 : 0);

  const contextMenuItems = [];
  let duplicateMenuErrors = 0;

  const listeners = {
    onInstalled: [],
    onStartup: [],
    onMessage: [],
    onCommand: [],
    onContextMenuClicked: [],
    onStorageChanged: [],
  };

  globalThis.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({
        version: '1.3.0',
        oauth2: { client_id: clientId },
      }),
      getURL: (rel) => `chrome-extension://testext/${rel.replace(/^\/+/, '')}`,
      onInstalled: {
        addListener: (fn) => listeners.onInstalled.push(fn),
      },
      onStartup: {
        addListener: (fn) => listeners.onStartup.push(fn),
      },
      onMessage: {
        addListener: (fn) => listeners.onMessage.push(fn),
      },
      sendMessage: (payload, cb) => {
        if (listeners.onMessage.length === 0) {
          cb?.(undefined);
          return;
        }
        for (const fn of listeners.onMessage) {
          fn(payload, {}, (res) => cb?.(res));
        }
      },
    },
    commands: {
      onCommand: {
        addListener: (fn) => listeners.onCommand.push(fn),
      },
    },
    contextMenus: {
      create: (props, cb) => {
        if (props?.id && contextMenuItems.some((item) => item.id === props.id)) {
          duplicateMenuErrors += 1;
          globalThis.chrome.runtime.lastError = {
            message: `Cannot create item with duplicate id ${props.id}`,
          };
          cb?.();
          globalThis.chrome.runtime.lastError = null;
          return props.id;
        }
        contextMenuItems.push(structuredClone(props));
        cb?.();
        return props?.id;
      },
      removeAll: (cb) => {
        contextMenuItems.length = 0;
        cb?.();
      },
      onClicked: {
        addListener: (fn) => listeners.onContextMenuClicked.push(fn),
      },
    },
    action: {
      setBadgeText: ({ text }) => badges.push({ text }),
      setBadgeBackgroundColor: () => {},
    },
    extension: {
      isAllowedFileSchemeAccess: (cb) => cb(Boolean(allowFileScheme)),
    },
    tabs: {
      get: async (tabId) => {
        const found = tabs.find((t) => t.id === tabId);
        if (!found) throw new Error(`No tab with id: ${tabId}`);
        return structuredClone(found);
      },
      query: async () => tabs.filter((t) => t.active).map((t) => structuredClone(t)),
      create: async (opts) => {
        createdTabs.push(opts);
        return { id: 999, ...opts };
      },
      captureVisibleTab: async (windowId, opts) => {
        if (onCaptureVisibleTab) return onCaptureVisibleTab(windowId, opts);
        return TINY_PNG_DATA_URL;
      },
      sendMessage: async (tabId, message) => {
        sentTabMessages.push({ tabId, message });
        if (onTabSendMessage) return onTabSendMessage(tabId, message);
        return { ok: true, removed: false };
      },
    },
    scripting: {
      executeScript: async (opts) => {
        executeScriptCalls += 1;
        if (onExecuteScript) return onExecuteScript(opts);
        return [{ result: true }];
      },
    },
    storage: {
      onChanged: {
        addListener: (fn) => listeners.onStorageChanged.push(fn),
      },
      local: {
        get: async (keys) => {
          if (keys === null || keys === undefined) return structuredClone(store);
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) out[k] = structuredClone(store[k]);
          return out;
        },
        set: async (patch) => {
          if (remainingSetFailures > 0) {
            remainingSetFailures -= 1;
            throw new Error('QUOTA_BYTES quota exceeded');
          }
          const changes = {};
          for (const [k, v] of Object.entries(patch)) {
            changes[k] = {
              oldValue: structuredClone(store[k]),
              newValue: structuredClone(v),
            };
            store[k] = structuredClone(v);
          }
          for (const fn of listeners.onStorageChanged) {
            fn(changes, 'local');
          }
        },
        remove: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete store[k];
        },
      },
      session: (() => {
        const sessionStore = {};
        return {
          get: async (keys) => {
            if (keys === null || keys === undefined) return structuredClone(sessionStore);
            const list = Array.isArray(keys) ? keys : [keys];
            const out = {};
            for (const k of list) out[k] = structuredClone(sessionStore[k]);
            return out;
          },
          set: async (patch) => {
            for (const [k, v] of Object.entries(patch)) {
              sessionStore[k] = structuredClone(v);
            }
          },
          remove: async (keys) => {
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) delete sessionStore[k];
          },
          clear: async () => {
            for (const k of Object.keys(sessionStore)) delete sessionStore[k];
          },
        };
      })(),
    },
    identity: {
      getAuthToken: (opts, cb) => {
        if (onGetAuthToken) {
          const res = onGetAuthToken(opts, ++tokenCounter);
          if (res?.error) {
            globalThis.chrome.runtime.lastError = { message: res.error };
            cb(undefined);
            globalThis.chrome.runtime.lastError = null;
            return;
          }
          cb(res?.token ?? `token-${tokenCounter}`);
          return;
        }
        tokenCounter += 1;
        cb(`token-${tokenCounter}`);
      },
      removeCachedAuthToken: ({ token }, cb) => {
        removedTokens.push(token);
        cb();
      },
      clearAllCachedAuthTokens: (cb) => {
        clearedAll = true;
        cb();
      },
    },
  };

  const dispatchMessage = (message, sender = {}) =>
    new Promise((resolve) => {
      for (const fn of listeners.onMessage) {
        fn(message, sender, (res) => resolve(res));
      }
    });

  return {
    store,
    removedTokens,
    createdTabs,
    sentTabMessages,
    badges,
    contextMenuItems,
    getDuplicateMenuErrors: () => duplicateMenuErrors,
    listeners,
    dispatchMessage,
    getExecuteScriptCalls: () => executeScriptCalls,
    wasClearedAll: () => clearedAll,
  };
}

test('manifest.json is valid MV3 with incognito spanning mode, narrow scopes, icons, and commands', () => {
  const manifestPath = path.join(rootDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.incognito, 'spanning');
  assert.equal(
    manifest.homepage_url,
    undefined,
    'manifest.json must omit homepage_url so Chrome links to the Chrome Web Store listing'
  );
  assert.equal(manifest.background.type, 'module');
  assert.ok(fs.existsSync(path.join(rootDir, manifest.background.service_worker)));
  assert.ok(fs.existsSync(path.join(rootDir, manifest.action.default_popup)));

  assert.deepEqual(manifest.action.default_icon, manifest.icons);

  for (const [sizeKey, iconRelPath] of Object.entries(manifest.icons)) {
    const iconPath = path.join(rootDir, iconRelPath);
    assert.ok(fs.existsSync(iconPath), `Missing icon: ${iconRelPath}`);
    const buf = fs.readFileSync(iconPath);
    assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${iconRelPath} must be valid PNG`);
    const pngW = buf.readUInt32BE(16);
    const pngH = buf.readUInt32BE(20);
    const expected = Number(sizeKey);
    assert.equal(pngW, expected, `${iconRelPath} width must be ${expected}`);
    assert.equal(pngH, expected, `${iconRelPath} height must be ${expected}`);
  }

  const expectedStoreAssets = [
    ['store-assets/promo-small-440x280.png', 440, 280],
    ['store-assets/promo-marquee-1400x560.png', 1400, 560],
    ['store-assets/screenshot-1-capture-1280x800.png', 1280, 800],
    ['store-assets/screenshot-2-editor-1280x800.png', 1280, 800],
    ['store-assets/screenshot-3-privacy-1280x800.png', 1280, 800],
    ['store-assets/screenshot-4-themes-1280x800.png', 1280, 800],
    ['store-assets/screenshot-welcome-1280x800.png', 1280, 800],
  ];
  for (const [assetRel, expW, expH] of expectedStoreAssets) {
    const buf = fs.readFileSync(path.join(rootDir, assetRel));
    assert.equal(buf.readUInt32BE(16), expW, `${assetRel} width must be ${expW}`);
    assert.equal(buf.readUInt32BE(20), expH, `${assetRel} height must be ${expH}`);
    assert.equal(buf[25], 2, `${assetRel} must be 24-bit RGB PNG with no alpha channel`);
  }

  const readme = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');
  assert.ok(readme.slice(0, 160).includes('src="icons/icon128.png"'), 'README.md top must render icons/icon128.png');

  assert.ok(manifest.description.length > 0 && manifest.description.length <= 132, 'CWS description must be <= 132 chars');
  assert.match(manifest.description, /no external servers or tracking/i);

  assert.deepEqual(manifest.permissions.sort(), [
    'activeTab',
    'contextMenus',
    'identity',
    'scripting',
    'storage',
  ]);
  assert.ok(manifest.oauth2.scopes.includes('https://www.googleapis.com/auth/drive.file'));
  assert.equal(manifest.commands['capture-region'].suggested_key.default, 'Alt+Shift+S');
  assert.equal(manifest.commands['capture-visible'].suggested_key.default, 'Alt+Shift+V');
});

test('isCapturableUrl handles normal pages, internal pages, file:// permissions, and data:/blob: URLs', () => {
  assert.equal(isCapturableUrl('https://example.com/docs').canCaptureVisible, true);
  assert.equal(isCapturableUrl('https://example.com/docs').canCaptureRegion, true);

  // Restricted browser pages
  for (const url of [
    'chrome://extensions',
    'brave://settings',
    'chrome-error://chromewebdata/',
    'chrome-extension://abcdef/popup.html',
    'https://chromewebstore.google.com/detail/foo',
    '',
  ]) {
    const res = isCapturableUrl(url);
    assert.equal(res.canCaptureVisible, false, `Should reject ${url}`);
    assert.equal(res.canCaptureRegion, false, `Should reject ${url}`);
  }

  // file:// URL without "Allow access to file URLs"
  const blockedFile = isCapturableUrl('file:///Users/alice/report.pdf', {
    allowFileScheme: false,
  });
  assert.equal(blockedFile.canCaptureVisible, false);
  assert.equal(blockedFile.code, 'FILE_ACCESS_DISABLED');
  assert.match(blockedFile.reason, /Allow access to file URLs/);

  // file:// URL with permission enabled
  const allowedFile = isCapturableUrl('file:///Users/alice/report.pdf', {
    allowFileScheme: true,
  });
  assert.equal(allowedFile.canCaptureVisible, true);

  // data: URL supports visible capture, disables DOM region injection cleanly
  const dataPage = isCapturableUrl('data:text/html,<h1>Hello</h1>');
  assert.equal(dataPage.canCaptureVisible, true);
  assert.equal(dataPage.canCaptureRegion, false);
  assert.match(dataPage.regionDisabledReason, /Visible Tab/);
});

test('buildScreenshotFilename redacts Incognito hostnames and formats local files cleanly', () => {
  const fixedDate = new Date(2026, 10, 19, 7, 5, 9);
  assert.equal(
    buildScreenshotFilename('https://www.github.com/openai/repo', fixedDate),
    'Screenshot_2026-11-19_07-05-09_github.com.png'
  );
  assert.equal(
    buildScreenshotFilename('https://secret-bank.example/account', fixedDate, {
      incognito: true,
    }),
    'Screenshot_2026-11-19_07-05-09_incognito.png'
  );
  assert.equal(
    buildScreenshotFilename('file:///Users/alice/spec.pdf', fixedDate),
    'Screenshot_2026-11-19_07-05-09_local-file.png'
  );
});

test('computeCropRect is pixel-exact across browser zoom (50%-300%), Retina HiDPI, and trackpad pinch-zoom', () => {
  // 1. Fractional browser zoom 175% (viewportWidth rounded from 571.428 -> 571, dpr = 1.75)
  const zoom175 = computeCropRect(
    {
      x: 120,
      y: 90,
      width: 140,
      height: 100,
      viewportWidth: 571,
      viewportHeight: 375,
      devicePixelRatio: 1.75,
      visualViewportScale: 1,
      visualViewportOffsetLeft: 0,
      visualViewportOffsetTop: 0,
    },
    1000,
    657
  );
  assert.deepEqual(zoom175, { x: 210, y: 158, width: 245, height: 175 });

  // 2. Browser zoom 300% (viewportWidth = 333, dpr = 3.0)
  const zoom300 = computeCropRect(
    {
      x: 120,
      y: 90,
      width: 140,
      height: 100,
      viewportWidth: 333,
      viewportHeight: 219,
      devicePixelRatio: 3,
      visualViewportScale: 1,
      visualViewportOffsetLeft: 0,
      visualViewportOffsetTop: 0,
    },
    1000,
    657
  );
  assert.deepEqual(zoom300, { x: 360, y: 270, width: 420, height: 300 });

  // 3. Trackpad Pinch-Zoom 2.0x panned to offset (100, 75) on a 1x display
  const pinch2x = computeCropRect(
    {
      x: 120,
      y: 90,
      width: 140,
      height: 100,
      viewportWidth: 1000,
      viewportHeight: 657,
      devicePixelRatio: 1,
      visualViewportScale: 2.0,
      visualViewportOffsetLeft: 100,
      visualViewportOffsetTop: 75,
    },
    1000,
    657
  );
  assert.deepEqual(pinch2x, { x: 40, y: 30, width: 280, height: 200 });

  // 4. Out-of-bounds clamping safety
  const clamped = computeCropRect(
    { x: -20, y: 780, width: 500, height: 100, viewportWidth: 1000, viewportHeight: 800 },
    1000,
    800
  );
  assert.deepEqual(clamped, { x: 0, y: 780, width: 480, height: 20 });
});

test('error classifiers produce clear guidance for Chrome sign-in off, Drive full, missing scope, and OS/policy blocks', () => {
  // User not signed into Chrome / browser sign-in disabled
  const notSignedIn = classifyAuthError(new Error('The user turned off browser signin'));
  assert.equal(notSignedIn.code, 'CHROME_NOT_SIGNED_IN');
  assert.match(notSignedIn.userMessage, /Allow Chrome sign-in/);

  // User cancelled OAuth consent
  const cancelled = classifyAuthError(new Error('The user did not approve access.'));
  assert.equal(cancelled.code, 'AUTH_CANCELLED');

  // Google Drive storage quota full (403 storageQuotaExceeded)
  const quotaErr = classifyDriveHttpError(403, {
    error: {
      message: "The user's Drive storage quota has been exceeded.",
      errors: [{ reason: 'storageQuotaExceeded' }],
    },
  });
  assert.equal(quotaErr.code, 'DRIVE_QUOTA_EXCEEDED');
  assert.equal(quotaErr.retryable, false);
  assert.equal(quotaErr.recoverableWithLocalSave, true);
  assert.match(quotaErr.userMessage, /storage is full/);

  // Granular OAuth consent unchecked drive.file
  const scopeErr = classifyDriveHttpError(403, {
    error: {
      message: 'Insufficient Permission',
      errors: [{ reason: 'insufficientPermissions' }],
    },
  });
  assert.equal(scopeErr.code, 'DRIVE_SCOPE_MISSING');
  assert.equal(scopeErr.requiresReauth, true);

  // OS / window minimized /enterprise policy capture errors
  assert.equal(
    classifyCaptureError(new Error('Failed to capture tab: view is invisible')).code,
    'TAB_NOT_VISIBLE'
  );
  assert.equal(
    classifyCaptureError(
      new Error('This page cannot be scripted due to an ExtensionsSettings policy.')
    ).code,
    'ENTERPRISE_POLICY_BLOCKED'
  );
  assert.equal(
    classifyCaptureError(
      new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.')
    ).code,
    'CAPTURE_THROTTLED'
  );
});

test('Drive client retries transient 429/503 errors, never retries storageQuotaExceeded, and deduplicates concurrent folder creation', async () => {
  // 1. Concurrent ensureDriveFolder lock prevents duplicate folders
  let createCalls = 0;
  const concurrentFetch = async (url, opts = {}) => {
    if (url.includes('?q=')) {
      await new Promise((r) => setTimeout(r, 30));
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    if (opts.method === 'POST') {
      createCalls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return new Response(
        JSON.stringify({ id: 'shared-folder-id', name: 'Chrome_SaveShot_ScreenShots' }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const [f1, f2] = await Promise.all([
    ensureDriveFolder(
      'tok',
      { folderName: 'Chrome_SaveShot_ScreenShots', accountKey: 'alice@gmail.com' },
      concurrentFetch
    ),
    ensureDriveFolder(
      'tok',
      { folderName: 'Chrome_SaveShot_ScreenShots', accountKey: 'alice@gmail.com' },
      concurrentFetch
    ),
  ]);
  assert.equal(f1.id, 'shared-folder-id');
  assert.equal(f2.id, 'shared-folder-id');
  assert.equal(createCalls, 1, 'Should only create folder once under concurrent load');

  // 2. Upload retries transient 503 + 429 and succeeds, while omitting URL in Incognito
  const pngBlob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
  let uploadAttempts = 0;
  let uploadedBodyText = '';
  const flakyFetch = async (_url, opts) => {
    uploadAttempts += 1;
    uploadedBodyText = await opts.body.text();
    if (uploadAttempts === 1) {
      return new Response(JSON.stringify({ error: { message: 'Backend Error' } }), {
        status: 503,
      });
    }
    if (uploadAttempts === 2) {
      return new Response(
        JSON.stringify({
          error: { message: 'Rate Limit', errors: [{ reason: 'userRateLimitExceeded' }] },
        }),
        { status: 403 }
      );
    }
    return new Response(
      JSON.stringify({
        id: 'file-ok',
        name: 'Screenshot_incognito.png',
        webViewLink: 'https://drive.google.com/file/d/file-ok/view',
      }),
      { status: 200 }
    );
  };

  const uploaded = await uploadScreenshotToDrive(
    'tok-1',
    {
      filename: 'Screenshot_incognito.png',
      pngBlob,
      folderId: 'f-1',
      pageUrl: 'https://private.example/secret',
      incognito: true,
    },
    flakyFetch,
    { baseDelayMs: 10, maxRetries: 2 }
  );
  assert.equal(uploaded.id, 'file-ok');
  assert.equal(uploadAttempts, 3);
  assert.ok(
    !uploadedBodyText.includes('private.example'),
    'Incognito pageUrl must never be sent in Drive metadata description'
  );

  // 3. Drive storageQuotaExceeded fails immediately without retrying
  let quotaCalls = 0;
  const quotaFetch = async () => {
    quotaCalls += 1;
    return new Response(
      JSON.stringify({
        error: {
          message: 'Quota exceeded',
          errors: [{ reason: 'storageQuotaExceeded' }],
        },
      }),
      { status: 403 }
    );
  };

  await assert.rejects(
    () =>
      uploadScreenshotToDrive(
        'tok-1',
        { filename: 'shot.png', pngBlob, folderId: 'f-1' },
        quotaFetch,
        { baseDelayMs: 10, maxRetries: 2 }
      ),
    (err) => err.code === 'DRIVE_QUOTA_EXCEEDED'
  );
  assert.equal(quotaCalls, 1, 'Must not retry when Google Drive storage is full');
});

test('auth module handles not-signed-in Chrome, granular scope eviction, stale token detection, offline tolerance, and multi-account isolation', async () => {
  // 1. Unconfigured client_id check
  installChromeMock({ clientId: PLACEHOLDER_CLIENT_ID });
  assert.equal(isClientIdConfigured(), false);

  // 2. Chrome not signed in during interactive signIn
  installChromeMock({
    onGetAuthToken: () => ({ error: 'The user is not signed in.' }),
  });
  await assert.rejects(
    () => signIn(),
    (err) => err.code === 'CHROME_NOT_SIGNED_IN'
  );

  // 3. Stale cached token evicted on getSilentAuthSession when online 401 occurs,
  //    while offline network failure preserves cached userProfile
  const { store: offlineStore } = installChromeMock({
    initialStore: {
      signedOut: false,
      userProfile: { email: 'alice@gmail.com', name: 'Alice', verifiedAt: 1 },
    },
  });
  const offlineSession = await getSilentAuthSession(async () => {
    throw new TypeError('Failed to fetch');
  });
  assert.equal(offlineSession.signedIn, true);
  assert.equal(offlineSession.profile.email, 'alice@gmail.com');
  assert.equal(offlineStore.signedOut, false);

  // Expired 1-hour cached token on wake from sleep rotates silently on 401 without signing out
  const { store: rotatedStore, removedTokens: rotatedRemoved } = installChromeMock({
    initialStore: {
      signedOut: false,
      userProfile: { email: 'alice@gmail.com', name: 'Alice', verifiedAt: 1 },
    },
  });
  let silentAboutCalls = 0;
  const rotatedSession = await getSilentAuthSession(async () => {
    silentAboutCalls += 1;
    if (silentAboutCalls === 1) return new Response('', { status: 401 });
    return new Response(
      JSON.stringify({
        user: { displayName: 'Alice', emailAddress: 'alice@gmail.com' },
      }),
      { status: 200 }
    );
  });
  assert.equal(rotatedSession.signedIn, true);
  assert.equal(rotatedSession.profile.email, 'alice@gmail.com');
  assert.equal(rotatedStore.signedOut, false);
  assert.deepEqual(rotatedRemoved, ['token-1']);

  // Genuinely revoked grant (401 on both initial and refreshed token) evicts both and marks signedOut
  const { store: revokedStore, removedTokens: revokedRemoved } = installChromeMock({
    initialStore: {
      signedOut: false,
      userProfile: { email: 'alice@gmail.com', name: 'Alice', verifiedAt: 1 },
    },
  });
  const revokedSession = await getSilentAuthSession(
    async () => new Response('', { status: 401 })
  );
  assert.equal(revokedSession.signedIn, false);
  assert.equal(revokedStore.signedOut, true);
  assert.deepEqual(revokedRemoved, ['token-1', 'token-2']);

  // 4. Granular Drive scope unchecked (DRIVE_SCOPE_MISSING) evicts token and marks signedOut
  const { store: scopeStore, removedTokens: scopeRemoved } = installChromeMock({
    initialStore: {
      signedOut: false,
      userProfile: { email: 'alice@gmail.com', verifiedAt: Date.now() },
    },
  });
  await assert.rejects(
    () =>
      withAuthToken(async () => {
        throw classifyDriveHttpError(403, {
          error: {
            message: 'Insufficient Permission',
            errors: [{ reason: 'insufficientPermissions' }],
          },
        });
      }),
    (err) => err.code === 'DRIVE_SCOPE_MISSING'
  );
  assert.deepEqual(scopeRemoved, ['token-1']);
  assert.equal(scopeStore.signedOut, true);

  // 5. Multi-account folder cache isolation across Alice -> signOut -> Bob
  installChromeMock({});
  await saveAccountFolderCache('alice@gmail.com', {
    folderName: 'Chrome_SaveShot_ScreenShots',
    folderId: 'alice-folder-1',
    folderWebViewLink: 'https://drive.google.com/drive/folders/alice-folder-1',
  });
  await signOut(async () => new Response('', { status: 200 }));
  await setAuthState({
    signedOut: false,
    userProfile: { email: 'bob@gmail.com', name: 'Bob', verifiedAt: Date.now() },
  });
  const bobSettings = await getSettings();
  assert.equal(bobSettings.folderId, null, 'Bob must not inherit Alice folderId');
  assert.equal(
    getAccountFolderCache(bobSettings, 'bob@gmail.com').folderId,
    null
  );
  assert.equal(
    getAccountFolderCache(bobSettings, 'alice@gmail.com').folderId,
    'alice-folder-1',
    'Alice cache remains intact if she signs back in later'
  );
});

test('storage quota overflow falls back gracefully and dataUrl helpers validate corrupt inputs', async () => {
  installChromeMock({ failStorageSetOnce: true });
  const saved = await addRecentUpload({
    id: 'shot-1',
    name: 'shot.png',
    thumbnailDataUrl: 'data:image/jpeg;base64,abc',
  });
  assert.equal(saved.length, 1);

  await assert.rejects(
    () => dataUrlToBlob(''),
    (err) => err.code === 'EMPTY_CAPTURE'
  );

  const rawBlob = new Blob([new Uint8Array([1, 2, 3, 4, 5])], {
    type: 'image/png',
  });
  const encoded = await blobToDataUrl(rawBlob);
  assert.ok(encoded.startsWith('data:image/png;base64,'));
  const roundTrip = await dataUrlToBlob(encoded);
  assert.equal(roundTrip.size, 5);

  assert.equal(
    escapeDriveQueryValue("Team's Folder\\2026"),
    "Team\\'s Folder\\\\2026"
  );
  const mp = buildMultipartUploadBody({ name: 'a.png' }, rawBlob, 'b1');
  assert.equal(mp.contentType, 'multipart/related; boundary=b1');
});

test('storage compacts upload records, caps account cache to 5, and prunes legacy bloat', async () => {
  installChromeMock({
    initialStore: {
      recentUploads: Array.from({ length: 14 }, (_, i) => ({
        id: `id-${i}`,
        name: `shot-${i}.png`,
        webViewLink: `https://drive.google.com/file/d/${i}`,
        pageTitle: 'Example '.repeat(25),
        extraBloatField: 'x'.repeat(500),
        mode: 'region',
      })),
    },
  });

  await pruneStorage();
  const pruned = await getRecentUploads();
  assert.equal(pruned.length, 8, 'Should keep at most 8 recent uploads');
  assert.equal(pruned[0].extraBloatField, undefined, 'Should strip unused fields');
  assert.ok(pruned[0].pageTitle.length <= 80, 'Should cap pageTitle length');

  for (let i = 1; i <= 7; i += 1) {
    await saveAccountFolderCache(`user${i}@gmail.com`, {
      folderName: 'Chrome_SaveShot_ScreenShots',
      folderId: `f-${i}`,
      folderWebViewLink: `https://drive.google.com/drive/folders/f-${i}`,
    });
  }
  const settings = await getSettings();
  assert.equal(
    Object.keys(settings.folderCacheByEmail).length,
    5,
    'Should cap cached accounts to 5'
  );
});

test('feedback helper builds compact version info lines across OS/UA variants and exports zero GitHub links', async () => {
  const feedbackMod = await import('../lib/feedback.js');
  assert.equal('DEFAULT_REPO_URL' in feedbackMod, false, 'lib/feedback.js must not export DEFAULT_REPO_URL');
  assert.equal('getRepoUrl' in feedbackMod, false, 'lib/feedback.js must not export getRepoUrl');
  assert.equal('buildFeedbackPayload' in feedbackMod, false, 'lib/feedback.js must not export buildFeedbackPayload');

  const env = getEnvironmentSummary(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/156.0.0.0 Safari/537.36'
  );
  assert.equal(env.browser, 'Chrome 156.0.0.0');
  assert.equal(env.os, 'macOS');
  assert.equal(
    formatVersionInfoLine({ env }),
    `SaveShot v${env.extensionVersion} \u00b7 Chrome 156.0.0.0 (macOS) \u00b7 Last error: None`
  );
  assert.equal(
    formatVersionInfoLine({ env, lastErrorCode: 'DRIVE_QUOTA_EXCEEDED' }),
    `SaveShot v${env.extensionVersion} \u00b7 Chrome 156.0.0.0 (macOS) \u00b7 Last error: DRIVE_QUOTA_EXCEEDED`
  );
  assert.ok(DEFAULT_CWS_SUPPORT_URL.endsWith('/eilmbilnlihhddjdmdpppalfnbnieppf/support'));

  const prevChrome = globalThis.chrome;
  try {
    globalThis.chrome = undefined;
    assert.equal(
      getEnvironmentSummary('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/157.0.1.2').os,
      'Windows'
    );
    assert.equal(
      getEnvironmentSummary('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/157.0.0.0').os,
      'ChromeOS'
    );
    assert.equal(
      getEnvironmentSummary('Mozilla/5.0 (X11; Linux x86_64) Chrome/157.0.0.0').os,
      'Linux'
    );
    const fallbackEnv = getEnvironmentSummary('CustomBrowser/1.0');
    assert.equal(fallbackEnv.extensionVersion, '1.3.0');
    assert.equal(fallbackEnv.browser, 'Chromium');
    assert.equal(fallbackEnv.os, 'Unknown OS');
  } finally {
    globalThis.chrome = prevChrome;
  }
});

test('capture and filename helpers survive NaN/Infinity inputs, IPv6 URLs, invalid dates, and non-webstore chrome.google.com paths', async () => {
  // 1. Adversarial NaN / Infinity / null / negative inputs never produce NaN or <= 0 dimensions
  for (const badSelection of [
    null,
    undefined,
    {
      x: Number.NaN,
      y: Number.POSITIVE_INFINITY,
      width: -200,
      height: Number.NaN,
      viewportWidth: 0,
      viewportHeight: -10,
      devicePixelRatio: Number.NaN,
      visualViewportScale: -3,
      visualViewportOffsetLeft: Number.NEGATIVE_INFINITY,
      visualViewportOffsetTop: Number.NaN,
    },
  ]) {
    const rect = computeCropRect(badSelection, Number.NaN, 0);
    assert.equal(Number.isFinite(rect.x), true);
    assert.equal(Number.isFinite(rect.y), true);
    assert.ok(rect.width >= 1 && Number.isFinite(rect.width));
    assert.ok(rect.height >= 1 && Number.isFinite(rect.height));
  }

  // 2. IPv6 literal, invalid Date, and malformed URL produce clean filenames
  const fixedDate = new Date(2026, 10, 20, 9, 15, 0);
  assert.equal(
    buildScreenshotFilename('http://[::1]:8080/test', fixedDate),
    'Screenshot_2026-11-20_09-15-00_1.png'
  );
  const invalidDateName = buildScreenshotFilename('not-a-valid-url', new Date('invalid'));
  assert.doesNotMatch(invalidDateName, /NaN/);
  assert.match(invalidDateName, /^Screenshot_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_tab\.png$/);

  // 3. chrome.google.com non-webstore path allowed, /webstore blocked, filesystem: disables region only
  assert.equal(isCapturableUrl('https://chrome.google.com/webstore/detail/abc').canCaptureVisible, false);
  assert.equal(isCapturableUrl('https://chrome.google.com/sync').canCaptureVisible, true);
  const fsUrl = isCapturableUrl('filesystem:https://example.com/temporary/doc.html');
  assert.equal(fsUrl.canCaptureVisible, true);
  assert.equal(fsUrl.canCaptureRegion, false);

  // 4. Reject non-image data URLs
  await assert.rejects(
    () => dataUrlToBlob('data:text/plain;base64,aGVsbG8='),
    (err) => err.code === 'EMPTY_CAPTURE'
  );
});

test('Drive folder verification self-heals trashed, renamed, 404, and 403 insufficientFilePermissions folders and fails fast on timeouts/long Retry-After', async () => {
  // 1. Cached folder moved to Trash -> verifyFolder returns null -> searches -> creates fresh folder
  const calls = [];
  const trashedFetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    if (url.includes('/files/trashed-id')) {
      return new Response(
        JSON.stringify({ id: 'trashed-id', name: 'Chrome_SaveShot_ScreenShots', trashed: true }),
        { status: 200 }
      );
    }
    if (url.includes('?q=')) {
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ id: 'fresh-id', name: 'Chrome_SaveShot_ScreenShots' }),
      { status: 200 }
    );
  };
  const healedFromTrash = await ensureDriveFolder(
    'tok-1',
    { folderName: 'Chrome_SaveShot_ScreenShots', cachedFolderId: 'trashed-id', accountKey: 'a@b.com' },
    trashedFetch
  );
  assert.equal(healedFromTrash.id, 'fresh-id');
  assert.equal(calls.length, 3);

  // 2. Cached folder returns 403 insufficientFilePermissions -> must NOT throw DRIVE_SCOPE_MISSING, must self-heal
  const forbiddenFileFetch = async (url) => {
    if (url.includes('/files/foreign-id')) {
      return new Response(
        JSON.stringify({
          error: {
            message: 'The user does not have sufficient permissions for this file.',
            errors: [{ reason: 'insufficientFilePermissions' }],
          },
        }),
        { status: 403 }
      );
    }
    if (url.includes('?q=')) {
      return new Response(
        JSON.stringify({
          files: [{ id: 'found-id', name: 'Custom_Folder', webViewLink: 'https://drive.google.com/drive/folders/found-id' }],
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const healedFromForbidden = await ensureDriveFolder(
    'tok-2',
    { folderName: 'Custom_Folder', cachedFolderId: 'foreign-id', accountKey: 'a@b.com' },
    forbiddenFileFetch
  );
  assert.equal(healedFromForbidden.id, 'found-id');

  // 3. String shorthand options + null fetchImpl guard work safely
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ files: [{ id: 'str-id', name: 'Quick_Folder' }] }),
      { status: 200 }
    );
  try {
    const strFolder = await ensureDriveFolder('tok-3', 'Quick_Folder', null);
    assert.equal(strFolder.id, 'str-id');
  } finally {
    globalThis.fetch = origFetch;
  }

  // 4. AbortError timeout fails fast without burning retries
  let timeoutCalls = 0;
  const keepAlive = setTimeout(() => {}, 500);
  try {
    await assert.rejects(
      () =>
        fetchDriveWithRetry(
          'https://www.googleapis.com/drive/v3/files',
          {},
          {
            timeoutMs: 15,
            maxRetries: 2,
            baseDelayMs: 5,
            fetchImpl: (_url, { signal }) =>
              new Promise((_res, rej) => {
                timeoutCalls += 1;
                signal.addEventListener('abort', () => {
                  const err = new Error('The operation was aborted');
                  err.name = 'AbortError';
                  rej(err);
                });
              }),
          }
        ),
      (err) => err.code === 'NETWORK_ERROR' && err.reason === 'timeout' && err.retryable === false
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(timeoutCalls, 1, 'Timed-out request must not retry repeatedly');

  // 5. Long Retry-After (> 15s) fails immediately so user gets local fallback right away
  let longRetryCalls = 0;
  await assert.rejects(
    () =>
      fetchDriveWithRetry(
        'https://www.googleapis.com/drive/v3/files',
        {},
        {
          maxRetries: 2,
          baseDelayMs: 5,
          fetchImpl: async () => {
            longRetryCalls += 1;
            return new Response(JSON.stringify({ error: { message: 'Rate limited' } }), {
              status: 429,
              headers: { 'Retry-After': '60' },
            });
          },
        }
      ),
    (err) => err.code === 'DRIVE_RATE_LIMITED'
  );
  assert.equal(longRetryCalls, 1);
});

test('auth and storage edge cases: Drive /about profile parsing, 401 refresh retry, fresh-install prompt, folder rename-back cache restore, and double quota fallback', async () => {
  // 1. Drive /about profile parsing + signIn 401 token refresh retry
  const { removedTokens: signInRemoved } = installChromeMock({});
  let aboutAttempts = 0;
  const { profile } = await signIn(async () => {
    aboutAttempts += 1;
    if (aboutAttempts === 1) return new Response('', { status: 401 });
    return new Response(
      JSON.stringify({
        user: {
          displayName: 'Aashish',
          emailAddress: 'aashish@example.com',
          photoLink: 'https://example.com/pic.png',
        },
      }),
      { status: 200 }
    );
  });
  assert.equal(profile.email, 'aashish@example.com');
  assert.equal(profile.name, 'Aashish');
  assert.deepEqual(signInRemoved, ['token-1']);

  // 2. signIn with unchecked Google Drive permission (403 on /about) evicts token immediately
  const { store: uncheckedStore, removedTokens: uncheckedRemoved } = installChromeMock({});
  await assert.rejects(
    () => fetchGoogleUserInfo('tok-bad', async () => new Response('', { status: 403 })),
    (err) => err.code === 'DRIVE_SCOPE_MISSING'
  );
  await assert.rejects(
    () => signIn(async () => new Response('', { status: 403 })),
    (err) => err.code === 'DRIVE_SCOPE_MISSING'
  );
  assert.equal(uncheckedStore.signedOut, true);
  assert.deepEqual(uncheckedRemoved, ['token-1']);

  // 3. Fresh install (userProfile is null) non-interactive withAuthToken returns friendly AUTH_REQUIRED
  installChromeMock({
    onGetAuthToken: () => ({ error: 'OAuth2 not granted or revoked.' }),
  });
  await assert.rejects(
    () => withAuthToken(async () => 'ok', { interactive: false }),
    (err) =>
      err.code === 'AUTH_REQUIRED' &&
      err.recoverableWithLocalSave === true &&
      /Connect Google Drive/.test(err.userMessage)
  );

  // 4. withAuthToken 401 refresh succeeds on second token; and evicts refreshed token if retry gets 403 DRIVE_SCOPE_MISSING
  const { removedTokens: refreshRemoved } = installChromeMock({
    initialStore: {
      signedOut: false,
      userProfile: { email: 'aashish@example.com', verifiedAt: Date.now() },
    },
  });
  let opCalls = 0;
  const opResult = await withAuthToken(async (tok) => {
    opCalls += 1;
    if (opCalls === 1) {
      throw classifyDriveHttpError(401, {});
    }
    return `used-${tok}`;
  });
  assert.equal(opResult, 'used-token-2');
  assert.deepEqual(refreshRemoved, ['token-1']);

  // 5. sanitizeFolderName, corrupted storage recovery, and folder rename-back cache restoration
  assert.equal(sanitizeFolderName('  Team\x00\x1f_Shots\n '), 'Team_Shots');
  assert.equal(sanitizeFolderName('   '), 'Chrome_SaveShot_ScreenShots');

  installChromeMock({
    initialStore: { settings: 'corrupted-string', recentUploads: 'not-an-array' },
  });
  const recoveredSettings = await getSettings();
  assert.equal(recoveredSettings.folderName, 'Chrome_SaveShot_ScreenShots');
  assert.deepEqual(await getRecentUploads(), []);

  await setAuthState({
    signedOut: false,
    userProfile: { email: 'aashish@example.com', name: 'Aashish', verifiedAt: Date.now() },
  });
  await saveAccountFolderCache('aashish@example.com', {
    folderName: 'Chrome_SaveShot_ScreenShots',
    folderId: 'orig-folder-id',
    folderWebViewLink: 'https://drive.google.com/drive/folders/orig-folder-id',
  });
  const renamed = await updateSettings({ folderName: 'Temp_Folder' });
  assert.equal(renamed.folderId, null);
  const renamedBack = await updateSettings({ folderName: 'Chrome_SaveShot_ScreenShots' });
  assert.equal(renamedBack.folderId, 'orig-folder-id', 'Renaming back restores cached folderId');
  assert.equal(
    renamedBack.folderWebViewLink,
    'https://drive.google.com/drive/folders/orig-folder-id'
  );

  // 6. Double storage quota failure falls back to zero-thumbnail textOnly list without throwing
  installChromeMock({ failStorageSetCount: 2 });
  const textOnly = await addRecentUpload({
    id: 'q-1',
    name: 'shot.png',
    thumbnailDataUrl: 'data:image/webp;base64,AAAA',
  });
  assert.equal(textOnly.length, 1);
  assert.equal(textOnly[0].thumbnailDataUrl, '');

  // 7. Additional Drive HTTP error classifications (507, accessNotConfigured, domainPolicy, 502, AbortError)
  assert.equal(classifyDriveHttpError(507, {}).code, 'DRIVE_QUOTA_EXCEEDED');
  assert.equal(
    classifyDriveHttpError(403, { error: { errors: [{ reason: 'accessNotConfigured' }] } }).code,
    'DRIVE_API_DISABLED'
  );
  assert.equal(
    classifyDriveHttpError(403, { error: { errors: [{ reason: 'domainPolicy' }] } }).code,
    'DRIVE_POLICY_BLOCKED'
  );
  assert.equal(classifyDriveHttpError(502, {}).code, 'DRIVE_SERVER_ERROR');
  const abortErr = new Error('aborted');
  abortErr.name = 'AbortError';
  assert.equal(classifyAuthError(abortErr).code, 'NETWORK_ERROR');
});

test('service-worker end-to-end orchestration: onInstalled, OPEN_DRIVE_FOLDER, CAPTURE_VISIBLE, Incognito privacy, throttling retry, tab-switch guard, and local fallback', async () => {
  const origFetch = globalThis.fetch;
  try {
    let captureAttempts = 0;
    let contentScriptLoaded = false;
    const activeTabs = [
      {
        id: 42,
        windowId: 7,
        active: true,
        url: 'https://docs.example.com/guide',
        title: 'Guide Doc',
        incognito: false,
      },
    ];

    const mock = installChromeMock({
      initialStore: {
        signedOut: false,
        userProfile: {
          email: 'aashish@example.com',
          name: 'Aashish',
          verifiedAt: Date.now(),
        },
        settings: {
          folderName: 'My_Custom_Shots',
          folderId: null,
          folderWebViewLink: null,
          folderCacheByEmail: {},
          autoCopyLink: true,
        },
      },
      tabs: activeTabs,
      onCaptureVisibleTab: async () => {
        captureAttempts += 1;
        if (captureAttempts === 1) {
          throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');
        }
        return TINY_PNG_DATA_URL;
      },
      onExecuteScript: async () => {
        contentScriptLoaded = true;
        return [{ result: true }];
      },
      onTabSendMessage: async (_tabId, msg) => {
        if (!contentScriptLoaded && msg.type !== 'HIDE_UI_FOR_CAPTURE') {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        if (msg.type === 'HIDE_UI_FOR_CAPTURE' && !contentScriptLoaded) {
          throw new Error('Receiving end does not exist.');
        }
        return { ok: true, removed: false };
      },
    });

    const { registerServiceWorkerListeners, waitForInflightUploadForTests } = await import(
      '../background/service-worker.js'
    );
    // Re-bind listeners onto current mock instance if already imported
    if (mock.listeners.onMessage.length === 0) {
      registerServiceWorkerListeners();
    }

    // 1. onInstalled opens welcome.html on fresh install only
    await mock.listeners.onInstalled[0]({ reason: 'update' });
    assert.equal(mock.createdTabs.length, 0);
    await mock.listeners.onInstalled[0]({ reason: 'install' });
    assert.equal(mock.createdTabs.length, 1);
    assert.match(mock.createdTabs[0].url, /pages\/welcome\.html$/);

    // 2. OPEN_DRIVE_FOLDER resolves custom folder name via Drive API and caches folderWebViewLink
    let driveShouldFailQuota = false;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.startsWith('data:image/')) {
        return origFetch(url, opts);
      }
      if (u.includes('/drive/v3/about')) {
        return new Response(
          JSON.stringify({
            user: {
              displayName: 'Aashish',
              emailAddress: 'aashish@example.com',
            },
          }),
          { status: 200 }
        );
      }
      if (driveShouldFailQuota && u.includes('/upload/drive/v3/files')) {
        return new Response(
          JSON.stringify({
            error: {
              message: 'Quota exceeded',
              errors: [{ reason: 'storageQuotaExceeded' }],
            },
          }),
          { status: 403 }
        );
      }
      if (u.includes('/drive/v3/files/folder-custom-1')) {
        return new Response(
          JSON.stringify({
            id: 'folder-custom-1',
            name: 'My_Custom_Shots',
            trashed: false,
            webViewLink: 'https://drive.google.com/drive/folders/folder-custom-1',
          }),
          { status: 200 }
        );
      }
      if (u.includes('?q=')) {
        assert.ok(u.includes('My_Custom_Shots'), 'Must query custom folder name');
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      if (u.includes('/drive/v3/files?fields=')) {
        return new Response(
          JSON.stringify({
            id: 'folder-custom-1',
            name: 'My_Custom_Shots',
            webViewLink: 'https://drive.google.com/drive/folders/folder-custom-1',
          }),
          { status: 200 }
        );
      }
      if (u.includes('/upload/drive/v3/files')) {
        return new Response(
          JSON.stringify({
            id: 'uploaded-1',
            name: 'Screenshot_1.png',
            webViewLink: 'https://drive.google.com/file/d/uploaded-1/view',
            createdTime: '2026-11-20T10:00:00.000Z',
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unhandled fetch URL in SW test: ${u}`);
    };

    // Verify SIGN_IN immediately creates the Drive folder and caches folderWebViewLink before returning
    const signInRes = await mock.dispatchMessage({ type: 'SIGN_IN' });
    assert.equal(signInRes.ok, true);
    assert.equal(signInRes.settings.folderId, 'folder-custom-1');
    assert.equal(
      signInRes.settings.folderWebViewLink,
      'https://drive.google.com/drive/folders/folder-custom-1'
    );

    const folderRes = await mock.dispatchMessage({ type: 'OPEN_DRIVE_FOLDER' });
    assert.equal(folderRes.ok, true);
    assert.equal(folderRes.url, 'https://drive.google.com/drive/folders/folder-custom-1');

    // 3. CAPTURE_VISIBLE retries throttled captureVisibleTab, opens Editor immediately, uploads PNG in background, and records history
    const capRes = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 42 });
    assert.equal(capRes.ok, true);
    assert.equal(capRes.openedEditor, true);
    assert.equal(capRes.uploadingInBackground, true);
    assert.ok(capRes.sessionId);
    const bgUpload1 = await waitForInflightUploadForTests(capRes.sessionId);
    assert.equal(bgUpload1.ok, true);
    assert.equal(bgUpload1.result.upload.id, 'uploaded-1');
    assert.equal((await getRecentUploads()).length, 1);
    assert.equal(captureAttempts, 2, 'Should auto-retry once after CAPTURE_THROTTLED');

    // 4. Incognito CAPTURE_VISIBLE opens Editor and uploads to Drive in background while skipping local history
    activeTabs[0].incognito = true;
    const incogRes = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 42 });
    assert.equal(incogRes.ok, true);
    assert.equal(incogRes.openedEditor, true);
    assert.equal(incogRes.uploadingInBackground, true);
    const bgUploadIncog = await waitForInflightUploadForTests(incogRes.sessionId);
    assert.equal(bgUploadIncog.ok, true);
    assert.equal((await getRecentUploads()).length, 1, 'Incognito capture must not add to local history');
    activeTabs[0].incognito = false;

    // 5. Background upload failure keeps Editor open, records error status, and stores fallback PNG retrievable via GET_FALLBACK_PNG
    driveShouldFailQuota = true;
    const failRes = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 42 });
    assert.equal(failRes.ok, true);
    assert.equal(failRes.openedEditor, true);
    assert.equal(failRes.uploadingInBackground, true);
    const bgUploadFail = await waitForInflightUploadForTests(failRes.sessionId);
    assert.equal(bgUploadFail.ok, false);
    assert.equal(bgUploadFail.error.code, 'DRIVE_QUOTA_EXCEEDED');
    assert.equal(bgUploadFail.error.hasFallback, true);

    const statusAfterFail = await mock.dispatchMessage({
      type: 'GET_EDITOR_UPLOAD_STATUS',
      sessionId: failRes.sessionId,
    });
    assert.equal(statusAfterFail.ok, true);
    assert.equal(statusAfterFail.uploadState, 'failed');
    assert.equal(statusAfterFail.uploadErrorCode, 'DRIVE_QUOTA_EXCEEDED');

    const fbRes = await mock.dispatchMessage({ type: 'GET_FALLBACK_PNG' });
    assert.equal(fbRes.ok, true);
    assert.ok(fbRes.dataUrl.startsWith('data:image/png;base64,'));
    driveShouldFailQuota = false;

    // 6. START_REGION_CAPTURE injects content script once; subsequent toasts reuse existing script without re-injecting
    const regionStart = await mock.dispatchMessage({ type: 'START_REGION_CAPTURE', tabId: 42 });
    assert.equal(regionStart.ok, true);
    assert.equal(mock.getExecuteScriptCalls(), 1, 'Should inject selector.js once');

    // 7. REGION_SELECTED aborts safely with TAB_SWITCHED toast if tab became inactive before capture
    activeTabs[0].active = false;
    await mock.dispatchMessage(
      {
        type: 'REGION_SELECTED',
        selection: { x: 10, y: 10, width: 50, height: 50, viewportWidth: 800, viewportHeight: 600 },
      },
      { tab: { id: 42, windowId: 7 } }
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      mock.getExecuteScriptCalls(),
      1,
      'Subsequent toast must reuse loaded content script without redundant executeScript'
    );
    const tabSwitchedToast = mock.sentTabMessages.find(
      (m) => m.message?.type === 'SHOW_TOAST' && /tab changed/i.test(m.message.payload?.message || '')
    );
    assert.ok(tabSwitchedToast, 'Should surface TAB_SWITCHED error toast');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('sanitizeScreenshotFilename neutralizes path traversal, RLO bidi spoofing, XSS chars, reserved names, and length overflows', () => {
  assert.equal(sanitizeScreenshotFilename('Bug Report #42'), 'Bug Report #42.png');
  assert.equal(sanitizeScreenshotFilename('  My-Shot.PNG  '), 'My-Shot.png');
  assert.equal(sanitizeScreenshotFilename('double.png.PNG'), 'double.png');

  // Path traversal and directory separators
  const traversal = sanitizeScreenshotFilename('../../etc/passwd');
  assert.ok(!traversal.includes('/') && !traversal.includes('..'));
  assert.equal(traversal, 'etc_passwd.png');

  const winPath = sanitizeScreenshotFilename('..\\..\\Windows\\System32\\cmd.exe');
  assert.ok(!winPath.includes('\\') && !winPath.includes('..'));
  assert.equal(winPath, 'Windows_System32_cmd.exe.png');

  // Right-to-Left Override (U+202E) extension spoofing defense
  const rloSpoof = sanitizeScreenshotFilename('invoice\u202egnp.exe');
  assert.ok(!rloSpoof.includes('\u202e'));
  assert.equal(rloSpoof, 'invoicegnp.exe.png');

  // Control characters and HTML/XSS metacharacters
  const xssName = sanitizeScreenshotFilename('<img src=x onerror="alert(1)">\x00\r\n.png');
  assert.ok(!xssName.includes('<') && !xssName.includes('>') && !xssName.includes('"'));
  assert.ok(xssName.endsWith('.png'));

  // Windows reserved device basenames fall back cleanly
  for (const reserved of ['CON', 'con.png', 'PRN', 'AUX', 'NUL', 'COM1.png', 'LPT9']) {
    assert.equal(
      sanitizeScreenshotFilename(reserved, 'Fallback_Shot.png'),
      'Fallback_Shot.png'
    );
  }

  // Empty, dot-only, null/undefined, and reserved fallback
  for (const emptyVal of ['', '   ', '...', '.png', null, undefined]) {
    assert.equal(sanitizeScreenshotFilename(emptyVal), 'Screenshot.png');
  }
  assert.equal(sanitizeScreenshotFilename('', 'CON.png'), 'Screenshot.png');

  // Overlong names capped at <= 104 chars total (100 base + .png)
  const huge = sanitizeScreenshotFilename('a'.repeat(300));
  assert.equal(huge.length, 104);
  assert.ok(huge.endsWith('.png'));

  // Valid Unicode names preserved
  assert.equal(
    sanitizeScreenshotFilename('日本語_テスト 01.png'),
    '日本語_テスト 01.png'
  );
});

test('Drive fileId validation, in-place file replacement (multipart + rename-only PATCH), and media download', async () => {
  // 1. Reject path traversal, query injection, prototype pollution keys, and malformed IDs
  for (const badId of [
    '',
    'ab',
    '../about',
    'file/../../etc',
    'file123?fields=*',
    'file123&alt=media',
    'file123#frag',
    'file with space',
    '__proto__',
    'constructor',
    'prototype',
    'a'.repeat(129),
    null,
    undefined,
    42,
  ]) {
    assert.throws(
      () => validateDriveFileId(badId),
      (err) => err.code === 'INVALID_FILE_ID',
      `Should reject malicious or invalid fileId: ${String(badId)}`
    );
  }

  assert.equal(
    validateDriveFileId('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'),
    '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'
  );

  // Corrupted cached folderId in ensureDriveFolder self-heals without throwing INVALID_FILE_ID
  const healedFolder = await ensureDriveFolder(
    'tok-heal',
    { folderName: 'Safe_Folder', cachedFolderId: '../bad?inject=1', accountKey: 'u@e.com' },
    async (url) => {
      assert.ok(!url.includes('../bad'), 'Must never send unvalidated folderId to network');
      return new Response(
        JSON.stringify({ files: [{ id: 'clean-folder-id', name: 'Safe_Folder' }] }),
        { status: 200 }
      );
    }
  );
  assert.equal(healedFolder.id, 'clean-folder-id');

  // 2. Full multipart PATCH replaces PNG bytes + updates filename while preserving webViewLink
  const newPng = new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: 'image/png' });
  let patchCall = null;
  const replaced = await updateScreenshotInDrive(
    'tok-patch',
    {
      fileId: 'drive_file_1234',
      filename: 'Annotated_Shot.png',
      pngBlob: newPng,
    },
    async (url, opts) => {
      patchCall = { url, method: opts.method, headers: opts.headers, bodyText: await opts.body.text() };
      return new Response(
        JSON.stringify({
          id: 'drive_file_1234',
          name: 'Annotated_Shot.png',
          webViewLink: 'https://drive.google.com/file/d/drive_file_1234/view',
          modifiedTime: '2026-11-20T12:00:00.000Z',
          size: '7',
        }),
        { status: 200 }
      );
    }
  );
  assert.equal(patchCall.method, 'PATCH');
  assert.match(patchCall.url, /\/upload\/drive\/v3\/files\/drive_file_1234\?uploadType=multipart/);
  assert.match(patchCall.headers['Content-Type'], /^multipart\/related;/);
  assert.match(patchCall.bodyText, /"name":"Annotated_Shot\.png"/);
  assert.equal(replaced.id, 'drive_file_1234');
  assert.equal(replaced.name, 'Annotated_Shot.png');
  assert.equal(replaced.webViewLink, 'https://drive.google.com/file/d/drive_file_1234/view');

  // 3. Metadata-only PATCH (pngBlob: null) renames without uploading binary multipart body
  let renameCall = null;
  const renamedOnly = await updateScreenshotInDrive(
    'tok-patch',
    {
      fileId: 'drive_file_1234',
      filename: 'Renamed_Only.png',
      pngBlob: null,
    },
    async (url, opts) => {
      renameCall = { url, method: opts.method, headers: opts.headers, body: opts.body };
      return new Response(
        JSON.stringify({
          id: 'drive_file_1234',
          name: 'Renamed_Only.png',
          webViewLink: 'https://drive.google.com/file/d/drive_file_1234/view',
        }),
        { status: 200 }
      );
    }
  );
  assert.equal(renameCall.method, 'PATCH');
  assert.match(renameCall.url, /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/drive_file_1234\?fields=/);
  assert.equal(renameCall.body, JSON.stringify({ name: 'Renamed_Only.png' }));
  assert.equal(renamedOnly.name, 'Renamed_Only.png');

  // 4. Media download normalizes octet-stream to image/png and rejects empty files
  const downloaded = await downloadScreenshotFromDrive(
    'tok-dl',
    'drive_file_1234',
    async (url) => {
      assert.equal(url, 'https://www.googleapis.com/drive/v3/files/drive_file_1234?alt=media');
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    }
  );
  assert.equal(downloaded.type, 'image/png');
  assert.equal(downloaded.size, 4);

  await assert.rejects(
    () =>
      downloadScreenshotFromDrive(
        'tok-dl',
        'drive_file_1234',
        async () => new Response(new Uint8Array([]), { status: 200 })
      ),
    (err) => err.code === 'EMPTY_DRIVE_FILE'
  );
});

test('editor-core geometry, subpixel-proof redaction snapping, color validation, and mock canvas rendering', () => {
  // 1. Outward integer pixel snapping for redaction prevents anti-aliased edge bleed
  const snapped = normalizeRect(10.8, 20.9, 15.1, 30.2, 100, 100, { snapOutward: true });
  assert.deepEqual(snapped, { x: 10, y: 20, width: 6, height: 11 });

  // Reversed drag + out-of-bounds + NaN/Infinity clamping
  const reversed = normalizeRect(150, 90, -20, 10, 100, 80, { snapOutward: true });
  assert.deepEqual(reversed, { x: 0, y: 10, width: 100, height: 70 });
  assert.deepEqual(clampPoint(Number.NaN, Number.POSITIVE_INFINITY, 200, 100), { x: 0, y: 0 });
  assert.deepEqual(clampPoint(250, 150, 200, 100), { x: 200, y: 100 });

  // 2. Color validation blocks CSS injection strings
  assert.equal(sanitizeHexColor('#EF4444'), '#ef4444');
  assert.equal(sanitizeHexColor('red; background:url(x)'), '#ef4444');
  assert.equal(sanitizeHexColor('#fff'), '#ef4444');

  // 3. Arrow geometry handles zero-length drag without NaN
  assert.equal(computeArrowGeometry(10, 10, 10, 10, 4), null);
  const arrow = computeArrowGeometry(0, 0, 100, 0, 4);
  assert.ok(arrow.shaftEnd.x < 100 && arrow.shaftEnd.x > 80);

  // 4. Mock 2D context exercises all 7 annotation tools + transform error guard
  const opsLog = [];
  const mockCtx = {
    canvas: { width: 200, height: 120 },
    save: () => opsLog.push('save'),
    restore: () => opsLog.push('restore'),
    fillRect: (x, y, w, h) => opsLog.push(['fillRect', x, y, w, h, mockCtx.fillStyle]),
    strokeRect: (x, y, w, h) => opsLog.push(['strokeRect', x, y, w, h]),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => opsLog.push('curve'),
    arc: () => opsLog.push('arc'),
    ellipse: () => opsLog.push('ellipse'),
    closePath: () => {},
    stroke: () => opsLog.push('stroke'),
    fill: () => opsLog.push('fill'),
    strokeText: (t) => opsLog.push(['strokeText', t]),
    fillText: (t) => opsLog.push(['fillText', t]),
  };

  assert.equal(renderAnnotation(mockCtx, null, 200, 120), false);
  assert.equal(renderAnnotation(mockCtx, { tool: 'unknown' }, 200, 120), false);
  assert.equal(renderAnnotation(mockCtx, { tool: 'text', text: '   ' }, 200, 120), false);

  assert.equal(
    renderAnnotation(
      mockCtx,
      { tool: 'redact', color: '#22c55e', x1: 5.4, y1: 6.7, x2: 25.2, y2: 18.1 },
      200,
      120
    ),
    true
  );
  // Redact MUST ignore user color and force solid #000000 on integer-expanded bounds
  assert.deepEqual(
    opsLog.find((entry) => Array.isArray(entry) && entry[0] === 'fillRect'),
    ['fillRect', 5, 6, 21, 13, '#000000']
  );

  assert.equal(renderAnnotation(mockCtx, { tool: 'box', x1: 10, y1: 10, x2: 40, y2: 30 }, 200, 120), true);
  assert.equal(renderAnnotation(mockCtx, { tool: 'circle', x1: 10, y1: 10, x2: 40, y2: 30 }, 200, 120), true);
  assert.equal(renderAnnotation(mockCtx, { tool: 'line', x1: 10, y1: 10, x2: 40, y2: 30 }, 200, 120), true);
  assert.equal(renderAnnotation(mockCtx, { tool: 'arrow', x1: 10, y1: 10, x2: 60, y2: 40 }, 200, 120), true);
  assert.equal(renderAnnotation(mockCtx, { tool: 'pencil', points: [{ x: 12, y: 12 }] }, 200, 120), true);
  assert.equal(
    renderAnnotation(
      mockCtx,
      { tool: 'pencil', points: [{ x: 10, y: 10 }, { x: 20, y: 25 }, { x: 35, y: 30 }, { x: 50, y: 50 }] },
      200,
      120
    ),
    true
  );
  assert.ok(EDITOR_TOOLS.includes('highlighter'));
  assert.deepEqual(HIGHLIGHTER_SIZES, { sm: 14, md: 22, lg: 32 });
  assert.equal(HIGHLIGHTER_ALPHA, 0.36);

  // Highlighter ignores < 2px taps and renders valid strokes as a single translucent path
  assert.equal(
    renderAnnotation(mockCtx, { tool: 'highlighter', points: [{ x: 10, y: 10 }] }, 200, 120),
    false
  );
  assert.equal(
    renderAnnotation(
      mockCtx,
      { tool: 'highlighter', points: [{ x: 10, y: 10 }, { x: 10.8, y: 10.5 }] },
      200,
      120
    ),
    false
  );

  let recordedAlpha = null;
  let recordedLineWidth = null;
  mockCtx.stroke = () => {
    recordedAlpha = mockCtx.globalAlpha;
    recordedLineWidth = mockCtx.lineWidth;
    opsLog.push('stroke');
  };
  assert.equal(
    renderAnnotation(
      mockCtx,
      {
        tool: 'highlighter',
        color: '#f59e0b',
        strokeWidth: 66,
        points: [
          { x: 12, y: 24 },
          { x: 48, y: 24 },
          { x: 96, y: 26 },
        ],
      },
      200,
      120
    ),
    true
  );
  assert.equal(recordedAlpha, HIGHLIGHTER_ALPHA);
  assert.equal(recordedLineWidth, 66, 'Highlighter must support HiDPI stroke widths > 48px');

  assert.equal(
    renderAnnotation(mockCtx, { tool: 'text', text: 'Line 1\nLine 2', x: 15, y: 20, color: '#ffffff' }, 200, 120),
    true
  );

  assert.throws(() => transformSourceToCanvas({ width: 10, height: 10 }, 'skew-45', {}), /Unsupported transform/);
});

test('service-worker security boundary (FORBIDDEN_SENDER), editBeforeUpload flow, post-upload Replace vs New vs Rename-only, Drive media fallback, and signOut RAM wipe', async () => {
  const origFetch = globalThis.fetch;
  try {
    const activeTabs = [
      {
        id: 77,
        windowId: 3,
        active: true,
        url: 'https://app.example.com/billing',
        title: 'Billing Portal',
        incognito: false,
      },
    ];

    const mock = installChromeMock({
      initialStore: {
        signedOut: false,
        userProfile: {
          email: 'sec@example.com',
          name: 'Sec Tester',
          verifiedAt: Date.now(),
        },
        settings: {
          folderName: 'Chrome_SaveShot_ScreenShots',
          folderId: 'folder-sec-1',
          folderWebViewLink: 'https://drive.google.com/drive/folders/folder-sec-1',
          folderCacheByEmail: {
            'sec@example.com': {
              folderName: 'Chrome_SaveShot_ScreenShots',
              folderId: 'folder-sec-1',
              folderWebViewLink: 'https://drive.google.com/drive/folders/folder-sec-1',
            },
          },
          autoCopyLink: true,
          editBeforeUpload: false,
        },
        recentUploads: [
          {
            id: 'older_drive_id_99',
            name: 'Older_Shot.png',
            webViewLink: 'https://drive.google.com/file/d/older_drive_id_99/view',
            createdTime: '2026-11-19T10:00:00.000Z',
            pageTitle: 'Older Page',
            mode: 'visible',
            thumbnailDataUrl: '',
          },
        ],
      },
      tabs: activeTabs,
    });

    const { registerServiceWorkerListeners } = await import('../background/service-worker.js');
    registerServiceWorkerListeners();

    const driveRequests = [];
    let createdCounter = 0;

    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.startsWith('data:image/')) {
        return origFetch(url, opts);
      }
      driveRequests.push({ url: u, method: opts.method || 'GET' });

      if (u.includes('/drive/v3/about')) {
        return new Response(
          JSON.stringify({ user: { displayName: 'Sec Tester', emailAddress: 'sec@example.com' } }),
          { status: 200 }
        );
      }
      if (u.includes('/drive/v3/files/folder-sec-1')) {
        return new Response(
          JSON.stringify({
            id: 'folder-sec-1',
            name: 'Chrome_SaveShot_ScreenShots',
            trashed: false,
            webViewLink: 'https://drive.google.com/drive/folders/folder-sec-1',
          }),
          { status: 200 }
        );
      }
      if (u.includes('?alt=media')) {
        const rawBytes = await (await origFetch(TINY_PNG_DATA_URL)).arrayBuffer();
        return new Response(rawBytes, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      if (opts.method === 'PATCH' && u.includes('/upload/drive/v3/files/')) {
        const id = u.split('/upload/drive/v3/files/')[1].split('?')[0];
        const bodyText = await opts.body.text();
        const nameMatch = bodyText.match(/"name":"([^"]+)"/);
        const updatedName = nameMatch ? nameMatch[1] : 'Updated.png';
        return new Response(
          JSON.stringify({
            id,
            name: updatedName,
            webViewLink: `https://drive.google.com/file/d/${id}/view`,
            modifiedTime: '2026-11-20T12:10:00.000Z',
          }),
          { status: 200 }
        );
      }
      if (opts.method === 'PATCH' && u.includes('/drive/v3/files/')) {
        const id = u.split('/drive/v3/files/')[1].split('?')[0];
        const parsed = JSON.parse(opts.body);
        return new Response(
          JSON.stringify({
            id,
            name: parsed.name,
            webViewLink: `https://drive.google.com/file/d/${id}/view`,
            modifiedTime: '2026-11-20T12:11:00.000Z',
          }),
          { status: 200 }
        );
      }
      if (opts.method === 'POST' && u.includes('/upload/drive/v3/files')) {
        createdCounter += 1;
        const bodyText = await opts.body.text();
        const nameMatch = bodyText.match(/"name":"([^"]+)"/);
        const id = `created_file_${createdCounter}`;
        return new Response(
          JSON.stringify({
            id,
            name: nameMatch ? nameMatch[1] : `Shot_${createdCounter}.png`,
            webViewLink: `https://drive.google.com/file/d/${id}/view`,
            createdTime: '2026-11-20T12:05:00.000Z',
          }),
          { status: 200 }
        );
      }
      if (u.includes('oauth2.googleapis.com/revoke')) {
        return new Response('', { status: 200 });
      }
      throw new Error(`Unhandled fetch in security SW test: ${opts.method || 'GET'} ${u}`);
    };

    // 1. SECURITY: Webpage content-script sender and cross-extension sender MUST be blocked on all privileged actions
    const untrustedWebSender = {
      url: 'https://evil.example/phish',
      tab: { id: 77, url: 'https://evil.example/phish' },
    };
    for (const blockedType of [
      'GET_STATE',
      'SIGN_IN',
      'SIGN_OUT',
      'OPEN_DRIVE_FOLDER',
      'UPDATE_SETTINGS',
      'CLEAR_HISTORY',
      'CAPTURE_VISIBLE',
      'START_REGION_CAPTURE',
      'OPEN_EDITOR',
      'GET_EDITOR_SESSION',
      'SAVE_EDITED_SCREENSHOT',
    ]) {
      const res = await mock.dispatchMessage({ type: blockedType }, untrustedWebSender);
      assert.equal(res.ok, false, `${blockedType} must be blocked from webpage sender`);
      assert.equal(res.code, 'FORBIDDEN_SENDER');
    }

    // Trusted extension tab sender (e.g. pages/editor.html) IS allowed
    const trustedEditorSender = {
      url: 'chrome-extension://testext/pages/editor.html?session=abc',
      tab: { id: 500, url: 'chrome-extension://testext/pages/editor.html?session=abc' },
    };
    const stateFromTrusted = await mock.dispatchMessage({ type: 'GET_STATE' }, trustedEditorSender);
    assert.equal(stateFromTrusted.ok, true);

    // 2. Settings allowlist ignores arbitrary injected keys while enabling editBeforeUpload
    const settingsRes = await mock.dispatchMessage({
      type: 'UPDATE_SETTINGS',
      patch: { editBeforeUpload: true, injectedAdminFlag: true },
    });
    assert.equal(settingsRes.ok, true);
    assert.equal(settingsRes.settings.editBeforeUpload, true);
    assert.equal(settingsRes.settings.injectedAdminFlag, undefined);

    // 3. Pre-upload editor flow (editBeforeUpload = true): captures tab WITHOUT uploading to Drive first
    const preUploadCap = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 77 });
    assert.equal(preUploadCap.ok, true);
    assert.equal(preUploadCap.openedEditor, true);
    assert.ok(preUploadCap.sessionId);
    assert.equal(
      driveRequests.filter((r) => r.url.includes('/upload/drive/v3/files')).length,
      0,
      'Zero bytes should be uploaded to Google Drive before user finishes redacting in pre-upload mode'
    );
    assert.match(
      mock.createdTabs[mock.createdTabs.length - 1].url,
      new RegExp(`pages/editor\\.html\\?session=${preUploadCap.sessionId}$`)
    );

    const loadedNewSession = await mock.dispatchMessage(
      { type: 'GET_EDITOR_SESSION', sessionId: preUploadCap.sessionId },
      trustedEditorSender
    );
    assert.equal(loadedNewSession.ok, true);
    assert.equal(loadedNewSession.session.mode, 'new');
    assert.ok(loadedNewSession.dataUrl.startsWith('data:image/png;base64,'));

    // Reject non-PNG dataUrl injection on SAVE_EDITED_SCREENSHOT
    const badDataRes = await mock.dispatchMessage(
      {
        type: 'SAVE_EDITED_SCREENSHOT',
        sessionId: preUploadCap.sessionId,
        filename: 'clean.png',
        dataUrl: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
        imageModified: true,
        saveMode: 'new',
      },
      trustedEditorSender
    );
    assert.equal(badDataRes.ok, false);
    assert.equal(badDataRes.code, 'INVALID_IMAGE_DATA');

    // Save pre-upload session -> creates Drive file with sanitized filename and transitions session to 'existing'
    const firstSave = await mock.dispatchMessage(
      {
        type: 'SAVE_EDITED_SCREENSHOT',
        sessionId: preUploadCap.sessionId,
        filename: '../Billing_Redacted\u202e.PNG',
        dataUrl: TINY_PNG_DATA_URL,
        imageModified: true,
        saveMode: 'new',
      },
      trustedEditorSender
    );
    assert.equal(firstSave.ok, true);
    assert.equal(firstSave.action, 'created');
    assert.equal(firstSave.upload.id, 'created_file_1');
    assert.equal(firstSave.upload.name, 'Billing_Redacted.png');

    // 4. Subsequent rename-only save on that same session uses fast metadata-only PATCH (no multipart upload!)
    const beforePatchCount = driveRequests.length;
    const renameOnlySave = await mock.dispatchMessage(
      {
        type: 'SAVE_EDITED_SCREENSHOT',
        sessionId: preUploadCap.sessionId,
        filename: 'Billing_Q4_Final',
        dataUrl: '',
        imageModified: false,
        saveMode: 'replace',
      },
      trustedEditorSender
    );
    assert.equal(renameOnlySave.ok, true);
    assert.equal(renameOnlySave.action, 'replaced');
    assert.equal(renameOnlySave.upload.id, 'created_file_1');
    assert.equal(renameOnlySave.upload.name, 'Billing_Q4_Final.png');
    const lastDriveReq = driveRequests[driveRequests.length - 1];
    assert.equal(lastDriveReq.method, 'PATCH');
    assert.ok(
      lastDriveReq.url.includes('/drive/v3/files/created_file_1') &&
        !lastDriveReq.url.includes('/upload/'),
      'Rename-only update must use metadata-only PATCH endpoint'
    );
    assert.ok(driveRequests.length > beforePatchCount);

    // Verify recentUploads in storage updated in-place
    const recentAfterRename = await getRecentUploads();
    assert.equal(recentAfterRename[0].id, 'created_file_1');
    assert.equal(recentAfterRename[0].name, 'Billing_Q4_Final.png');

    // 5. Full pixel replace (imageModified: true, saveMode: 'replace') uses multipart PATCH and keeps same fileId & link
    const pixelReplace = await mock.dispatchMessage(
      {
        type: 'SAVE_EDITED_SCREENSHOT',
        sessionId: preUploadCap.sessionId,
        filename: 'Billing_Q4_Final.png',
        dataUrl: TINY_PNG_DATA_URL,
        imageModified: true,
        saveMode: 'replace',
      },
      trustedEditorSender
    );
    assert.equal(pixelReplace.ok, true);
    assert.equal(pixelReplace.action, 'replaced');
    assert.equal(pixelReplace.upload.id, 'created_file_1');
    assert.equal(
      pixelReplace.upload.webViewLink,
      'https://drive.google.com/file/d/created_file_1/view'
    );
    assert.match(
      driveRequests[driveRequests.length - 1].url,
      /\/upload\/drive\/v3\/files\/created_file_1\?uploadType=multipart/
    );

    // 6. Save as new copy (saveMode: 'new') on an existing session creates a separate Drive file
    const newCopyRes = await mock.dispatchMessage(
      {
        type: 'SAVE_EDITED_SCREENSHOT',
        sessionId: preUploadCap.sessionId,
        filename: 'Billing_Copy.png',
        dataUrl: TINY_PNG_DATA_URL,
        imageModified: true,
        saveMode: 'new',
      },
      trustedEditorSender
    );
    assert.equal(newCopyRes.ok, true);
    assert.equal(newCopyRes.action, 'created');
    assert.equal(newCopyRes.upload.id, 'created_file_2');

    // 7. Webpage toast OPEN_LAST_CAPTURE_EDITOR is allowed from content script and opens last capture
    const toastEditRes = await mock.dispatchMessage(
      { type: 'OPEN_LAST_CAPTURE_EDITOR' },
      untrustedWebSender
    );
    assert.equal(toastEditRes.ok, true);
    assert.ok(toastEditRes.sessionId);

    // 8. Older Recent Upload not in RAM downloads PNG from Drive via ?alt=media when editor opens
    const olderOpen = await mock.dispatchMessage(
      { type: 'OPEN_EDITOR', fileId: 'older_drive_id_99', filename: 'Older_Shot.png' },
      trustedEditorSender
    );
    assert.equal(olderOpen.ok, true);
    const olderLoaded = await mock.dispatchMessage(
      { type: 'GET_EDITOR_SESSION', sessionId: olderOpen.sessionId },
      trustedEditorSender
    );
    assert.equal(olderLoaded.ok, true);
    assert.equal(olderLoaded.session.fileId, 'older_drive_id_99');
    assert.ok(
      driveRequests.some((r) => r.url.includes('/files/older_drive_id_99?alt=media')),
      'Should download older screenshot media from Google Drive when not cached in memory'
    );

    // 9. Update recent upload helper ignores nonexistent IDs safely
    const unchangedRecent = await updateRecentUpload('nonexistent_id', { name: 'Nope.png' });
    assert.ok(unchangedRecent.every((x) => x.name !== 'Nope.png'));

    // 10. MV3 30-second service-worker idle termination simulation:
    //     Wipe all module-scope SW RAM Maps while editor tabs & fallback captures are active,
    //     and verify GET_EDITOR_SESSION, SAVE_EDITED_SCREENSHOT (L2 + L3), OPEN_LAST_CAPTURE_EDITOR,
    //     and GET_FALLBACK_PNG all survive seamlessly!
    const { resetInMemoryWorkerStateForTests } = await import('../background/service-worker.js');

    const preRestartCap = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 77 });
    assert.equal(preRestartCap.ok, true);
    assert.equal(preRestartCap.openedEditor, true);

    // Simulate Chrome terminating the idle MV3 service worker after 30 seconds
    resetInMemoryWorkerStateForTests();

    // Tab refresh on pre-upload session recovers from chrome.storage.session
    const recoveredPreUpload = await mock.dispatchMessage(
      { type: 'GET_EDITOR_SESSION', sessionId: preRestartCap.sessionId },
      trustedEditorSender
    );
    assert.equal(recoveredPreUpload.ok, true);
    assert.equal(recoveredPreUpload.session.mode, 'new');
    assert.ok(recoveredPreUpload.dataUrl.startsWith('data:image/png;base64,'));

    // Wipe SW RAM again right before user clicks Upload to Drive 2 minutes later
    resetInMemoryWorkerStateForTests();
    const saveAfterSwSleep = await mock.dispatchMessage(
      {
        type: 'SAVE_EDITED_SCREENSHOT',
        sessionId: preRestartCap.sessionId,
        filename: 'Survived_SW_Sleep.png',
        dataUrl: TINY_PNG_DATA_URL,
        imageModified: true,
        saveMode: 'new',
      },
      trustedEditorSender
    );
    assert.equal(saveAfterSwSleep.ok, true);
    assert.equal(saveAfterSwSleep.action, 'created');
    assert.equal(saveAfterSwSleep.upload.name, 'Survived_SW_Sleep.png');

    // Even if BOTH SW RAM and chrome.storage.session were cleared (e.g. manual extension reload),
    // open editor tab's sessionContext still completes Replace in Drive cleanly while signed in!
    resetInMemoryWorkerStateForTests();
    await globalThis.chrome.storage.session.clear();

    const saveViaContextFallback = await mock.dispatchMessage(
      {
        type: 'SAVE_EDITED_SCREENSHOT',
        sessionId: preRestartCap.sessionId,
        filename: 'Renamed_After_Reload',
        dataUrl: '',
        imageModified: false,
        saveMode: 'replace',
        sessionContext: {
          mode: 'existing',
          fileId: saveAfterSwSleep.upload.id,
          filename: 'Survived_SW_Sleep.png',
          folderName: 'Chrome_SaveShot_ScreenShots',
          webViewLink: saveAfterSwSleep.upload.webViewLink,
          captureMode: 'visible',
          incognito: false,
        },
      },
      trustedEditorSender
    );
    assert.equal(saveViaContextFallback.ok, true);
    assert.equal(saveViaContextFallback.action, 'replaced');
    assert.equal(saveViaContextFallback.upload.name, 'Renamed_After_Reload.png');

    // 10B. Instant Editor + parallel background upload flow (editBeforeUpload = false):
    //      Opens Editor immediately AND uploads in background with single-use justUploaded = true
    const { waitForInflightUploadForTests } = await import('../background/service-worker.js');
    await mock.dispatchMessage(
      { type: 'UPDATE_SETTINGS', patch: { editBeforeUpload: false } },
      trustedEditorSender
    );
    const tabsBeforePostUpload = mock.createdTabs.length;
    const postUploadCap = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 77 });
    assert.equal(postUploadCap.ok, true);
    assert.equal(postUploadCap.openedEditor, true);
    assert.equal(postUploadCap.uploadingInBackground, true);
    assert.ok(postUploadCap.sessionId);
    assert.equal(mock.createdTabs.length, tabsBeforePostUpload + 1);
    assert.match(
      mock.createdTabs[mock.createdTabs.length - 1].url,
      new RegExp(`pages/editor\\.html\\?session=${postUploadCap.sessionId}$`)
    );

    const postUploadResult = await waitForInflightUploadForTests(postUploadCap.sessionId);
    assert.equal(postUploadResult.ok, true);

    const firstPostUploadLoad = await mock.dispatchMessage(
      { type: 'GET_EDITOR_SESSION', sessionId: postUploadCap.sessionId },
      trustedEditorSender
    );
    assert.equal(firstPostUploadLoad.ok, true);
    assert.equal(firstPostUploadLoad.session.mode, 'existing');
    assert.equal(firstPostUploadLoad.session.uploadState, 'uploaded');
    assert.equal(firstPostUploadLoad.session.justUploaded, true, 'First editor load after upload must flag justUploaded');

    const secondPostUploadLoad = await mock.dispatchMessage(
      { type: 'GET_EDITOR_SESSION', sessionId: postUploadCap.sessionId },
      trustedEditorSender
    );
    assert.equal(secondPostUploadLoad.ok, true);
    assert.equal(secondPostUploadLoad.session.justUploaded, false, 'Reloading editor tab must not re-fire justUploaded');

    assert.ok((await getRecentUploads()).length > 0, 'Recent uploads should exist before sign-out');

    // 11. SIGN_OUT wipes recentUploads, RAM, and chrome.storage.session, and blocks context reconstruction
    await mock.dispatchMessage({ type: 'SIGN_OUT' }, trustedEditorSender);
    assert.equal((await getRecentUploads()).length, 0, 'SIGN_OUT must clear recentUploads in storage');
    const signedOutState = await mock.dispatchMessage({ type: 'GET_STATE' }, trustedEditorSender);
    assert.deepEqual(signedOutState.recentUploads, [], 'GET_STATE must return empty recentUploads when signed out');

    const afterSignOutSession = await mock.dispatchMessage(
      { type: 'GET_EDITOR_SESSION', sessionId: olderOpen.sessionId },
      trustedEditorSender
    );
    assert.equal(afterSignOutSession.ok, false);
    assert.equal(afterSignOutSession.code, 'EDITOR_SESSION_EXPIRED');

    const blockedSaveAfterSignOut = await mock.dispatchMessage(
      {
        type: 'SAVE_EDITED_SCREENSHOT',
        sessionId: preRestartCap.sessionId,
        filename: 'Should_Block.png',
        dataUrl: TINY_PNG_DATA_URL,
        imageModified: true,
        saveMode: 'replace',
        sessionContext: {
          mode: 'existing',
          fileId: 'created_file_1',
          filename: 'Billing.png',
        },
      },
      trustedEditorSender
    );
    assert.equal(blockedSaveAfterSignOut.ok, false);
    assert.equal(blockedSaveAfterSignOut.code, 'EDITOR_SESSION_EXPIRED');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('centralized design language, zero external dependencies, strict CSS/HTML hygiene, and icon consistency', () => {
  // 1. Zero runtime or dev external dependencies in package.json
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0, 'Must have zero external dependencies');
  assert.equal(Object.keys(pkg.devDependencies || {}).length, 0, 'Must have zero external devDependencies');

  // 2. Centralized tokens.css defines light, prefers-color-scheme dark, and [data-theme="dark"] parity
  const tokensPath = path.join(rootDir, 'styles/tokens.css');
  assert.ok(fs.existsSync(tokensPath), 'styles/tokens.css must exist');
  const tokensCss = fs.readFileSync(tokensPath, 'utf8');
  assert.match(tokensCss, /:root,\s*:root\[data-theme="light"\]/);
  assert.match(tokensCss, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.match(tokensCss, /:root\[data-theme="dark"\]/);

  const definedTokens = new Set(
    Array.from(tokensCss.matchAll(/(--ss-[a-z0-9-]+)\s*:/g), (m) => m[1])
  );
  assert.ok(definedTokens.size >= 30, 'tokens.css should define centralized --ss-* design tokens');

  // Verify auto-dark (@media) and manual-dark ([data-theme="dark"]) define the exact same --ss-* keys
  const autoDarkBlock = tokensCss.split('@media (prefers-color-scheme: dark)')[1]?.split(':root[data-theme="dark"]')[0] || '';
  const manualDarkBlock = tokensCss.split(':root[data-theme="dark"]')[1]?.split('/* Base Reset */')[0] || '';
  const autoDarkVars = Array.from(autoDarkBlock.matchAll(/(--ss-[a-z0-9-]+)\s*:/g), (m) => m[1]).sort();
  const manualDarkVars = Array.from(manualDarkBlock.matchAll(/(--ss-[a-z0-9-]+)\s*:/g), (m) => m[1]).sort();
  assert.deepEqual(
    autoDarkVars,
    manualDarkVars,
    'Auto dark media query and manual [data-theme="dark"] block must override identical token sets'
  );

  // 3. Every HTML page links tokens.css first, has zero inline styles/<style>/inline handlers/remote assets,
  //    and all local asset paths exist on disk
  const htmlFiles = ['popup/popup.html', 'pages/editor.html', 'pages/welcome.html'];
  for (const rel of htmlFiles) {
    const abs = path.join(rootDir, rel);
    const html = fs.readFileSync(abs, 'utf8');
    const htmlDir = path.dirname(abs);

    assert.ok(!/\bstyle\s*=/i.test(html), `${rel} must not contain inline style= attributes`);
    assert.ok(!/<style\b/i.test(html), `${rel} must not contain embedded <style> blocks`);
    assert.ok(
      !/\bon(?:click|change|input|keydown|keyup|load|error|submit|focus|blur)\s*=/i.test(html),
      `${rel} must not contain inline JS event attributes`
    );

    const stylesheetLinks = Array.from(
      html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/gi),
      (m) => m[1]
    );
    assert.ok(stylesheetLinks.length >= 2, `${rel} must link tokens.css and page stylesheet`);
    assert.equal(
      stylesheetLinks[0],
      '../styles/tokens.css',
      `${rel} must load ../styles/tokens.css before page styles`
    );

    const assetRefs = [
      ...stylesheetLinks,
      ...Array.from(html.matchAll(/<(?:script|img)\b[^>]*src="([^"]+)"/gi), (m) => m[1]),
    ];
    for (const ref of assetRefs) {
      assert.ok(!/^https?:\/\//i.test(ref), `${rel} must not load remote asset: ${ref}`);
      const resolved = path.resolve(htmlDir, ref);
      assert.ok(fs.existsSync(resolved), `${rel} references missing asset: ${ref}`);
      assert.ok(fs.statSync(resolved).size > 0, `${rel} references empty asset: ${ref}`);
    }
  }

  // 4. Page stylesheets contain zero :root redefinitions, zero @import, zero loose #hex or rgb()/hsl() colors,
  //    and every referenced var(--ss-*) exists in tokens.css
  const allowedDynamicVars = new Set(['--tx', '--ty', '--tcolor', '--tsize']);
  const pageCssFiles = ['popup/popup.css', 'pages/editor.css', 'pages/welcome.css'];
  for (const rel of pageCssFiles) {
    const rawCss = fs.readFileSync(path.join(rootDir, rel), 'utf8');
    const cleanCss = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

    assert.ok(!/:root\b/.test(cleanCss), `${rel} must not redefine :root tokens`);
    assert.ok(!/@import\b/i.test(cleanCss), `${rel} must not use @import`);
    assert.ok(!/url\(\s*['"]?https?:/i.test(cleanCss), `${rel} must not load remote CSS URLs`);

    for (const blockMatch of cleanCss.matchAll(/\{([^{}]*)\}/g)) {
      const declBody = blockMatch[1];
      assert.ok(
        !/#[0-9a-fA-F]{3,8}\b/.test(declBody),
        `${rel} contains hardcoded hex color instead of centralized token: ${declBody.trim()}`
      );
      assert.ok(
        !/\b(?:rgba?|hsla?)\s*\(/i.test(declBody),
        `${rel} contains loose rgb()/hsl() color instead of centralized token: ${declBody.trim()}`
      );
    }

    for (const varMatch of cleanCss.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      const varName = varMatch[1];
      assert.ok(
        definedTokens.has(varName) || allowedDynamicVars.has(varName),
        `${rel} references undefined CSS variable ${varName}`
      );
    }
  }

  // Also verify every var(--ss-*) inside tokens.css itself is defined
  for (const varMatch of tokensCss.matchAll(/var\(\s*(--ss-[a-z0-9-]+)/gi)) {
    assert.ok(definedTokens.has(varMatch[1]), `tokens.css references undefined ${varMatch[1]}`);
  }

  // 5. Extension UI JS modules contain zero innerHTML/eval/inline-style mutations
  for (const rel of ['popup/popup.js', 'pages/editor.js', 'pages/welcome.js', 'lib/ui.js']) {
    const js = fs.readFileSync(path.join(rootDir, rel), 'utf8');
    assert.ok(!/\.(?:innerHTML|outerHTML)\b/.test(js), `${rel} must not use innerHTML/outerHTML`);
    assert.ok(!/\binsertAdjacentHTML\b/.test(js), `${rel} must not use insertAdjacentHTML`);
    assert.ok(!/\beval\s*\(|\bnew\s+Function\s*\(/.test(js), `${rel} must not use eval/Function`);
    assert.ok(!/\.style\.cssText\b/.test(js), `${rel} must not assign .style.cssText`);
    assert.ok(!/\.style\.[a-zA-Z]+\s*=/.test(js), `${rel} must not mutate inline .style.<prop> directly`);
  }

  // 6. Content script shadow templates use [hidden] & classes instead of inline HTML style="..."
  const selectorJs = fs.readFileSync(path.join(rootDir, 'content/selector.js'), 'utf8');
  assert.ok(!/\bstyle="/.test(selectorJs), 'content/selector.js shadow HTML must not use inline style="..."');
  assert.ok(!/\.style\.flex\b/.test(selectorJs), 'content/selector.js toast buttons must use CSS classes instead of .style.flex');

  // 7. Consistent box-arrow external-link icon across Popup, Recent list, Editor, and Welcome,
  //    plus slim split footer order (version -> Report bug | @_simplyakm) with zero third-party logos
  const boxArrowPath = 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6';
  for (const rel of ['popup/popup.html', 'popup/popup.js', 'pages/editor.html', 'pages/welcome.html']) {
    const content = fs.readFileSync(path.join(rootDir, rel), 'utf8');
    assert.ok(content.includes(boxArrowPath), `${rel} must use the unified box-arrow external link icon`);
  }

  const popupHtml = fs.readFileSync(path.join(rootDir, 'popup/popup.html'), 'utf8');
  assert.ok(
    popupHtml.indexOf('id="capture-region-btn"') < popupHtml.indexOf('id="capture-visible-btn"'),
    'Select area must appear before Visible tab in popup.html'
  );
  assert.ok(
    popupHtml.indexOf('id="capture-visible-btn"') < popupHtml.indexOf('id="signed-out-view"'),
    'Capture tiles must sit above the signed-out Connect Google Drive card'
  );
  assert.ok(
    popupHtml.indexOf('id="capture-visible-btn"') < popupHtml.indexOf('id="account-folder-card"'),
    'Capture tiles must sit above the signed-in Account + Folder card'
  );
  assert.ok(
    popupHtml.includes('Autosave to your Google Drive'),
    'Signed-out popup card must display Autosave to your Google Drive heading'
  );
  assert.ok(
    popupHtml.includes(
      'Never lose a shot, with easy download and link sharing. Privacy-first, no external servers or tracking.'
    ),
    'Signed-out popup card must display refined privacy-first copy'
  );
  const footerChunk = popupHtml.split('<footer')[1] || '';
  assert.ok(
    footerChunk.indexOf('id="popup-version"') < footerChunk.indexOf('id="footer-bug-btn"'),
    'Version must appear before Report bug in popup footer'
  );
  assert.ok(footerChunk.includes('https://x.com/_simplyakm'), 'Popup footer must link to @_simplyakm');
  assert.ok(!/<svg\b/i.test(footerChunk), 'Popup footer must not include third-party SVG brand logos');

  const editorHtml = fs.readFileSync(path.join(rootDir, 'pages/editor.html'), 'utf8');
  const topbarLeftChunk = editorHtml.split('<div class="topbar-right">')[0] || '';
  const topbarRightChunk = editorHtml.split('<div class="topbar-right">')[1]?.split('</header>')[0] || '';
  assert.ok(
    topbarLeftChunk.indexOf('id="rename-pencil-btn"') < topbarLeftChunk.indexOf('id="open-drive-link"'),
    'Open in Google Drive icon must sit beside the pencil rename button on topbar-left'
  );
  assert.ok(
    topbarLeftChunk.includes('id="unsaved-pill"') && !topbarRightChunk.includes('id="unsaved-pill"'),
    'Unsaved changes pill must live in topbar-left status slot so right-side buttons never shift'
  );
  assert.ok(
    topbarRightChunk.indexOf('id="editor-help-btn"') < topbarRightChunk.indexOf('id="copy-image-btn"'),
    'Help button must appear before Copy image in editor topbar-right'
  );
  assert.ok(
    topbarRightChunk.indexOf('id="copy-image-btn"') < topbarRightChunk.indexOf('id="download-btn"'),
    'Copy image button must appear before Download in editor topbar-right'
  );
  assert.ok(
    editorHtml.includes('data-tool="highlighter"'),
    'Editor dock must include Highlighter tool button'
  );
});

test('UI helpers, theme sync, custom hex color parser, and strict storage allowlist battle-tests', async () => {
  // 1. Theme normalization & applyDocumentTheme
  assert.deepEqual(VALID_THEMES, ['auto', 'light', 'dark']);
  assert.equal(normalizeTheme('light'), 'light');
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.equal(normalizeTheme('auto'), 'auto');
  for (const bad of ['', 'DARK', 'solarized', null, undefined, {}, '__proto__', 'constructor']) {
    assert.equal(normalizeTheme(bad), 'auto');
    assert.equal(normalizeThemeSetting(bad), 'auto');
  }

  const fakeDoc = { documentElement: { dataset: {} } };
  assert.equal(applyDocumentTheme('dark', fakeDoc), 'dark');
  assert.equal(fakeDoc.documentElement.dataset.theme, 'dark');
  assert.equal(applyDocumentTheme('light', fakeDoc), 'light');
  assert.equal(fakeDoc.documentElement.dataset.theme, 'light');
  assert.equal(applyDocumentTheme('auto', fakeDoc), 'auto');
  assert.equal(fakeDoc.documentElement.dataset.theme, undefined);
  assert.equal(applyDocumentTheme('dark', null), 'auto');

  // 2. Live cross-tab theme sync via initThemeSync
  const prevDoc = globalThis.document;
  globalThis.document = { documentElement: { dataset: {} } };
  try {
    const mock = installChromeMock({
      initialStore: { settings: { theme: 'dark', folderName: 'Shots' } },
    });
    const seenThemes = [];
    initThemeSync((t) => seenThemes.push(t));
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(globalThis.document.documentElement.dataset.theme, 'dark');
    assert.deepEqual(seenThemes, ['dark']);

    // Ignore non-local storage area events
    for (const fn of mock.listeners.onStorageChanged) {
      fn({ settings: { newValue: { theme: 'light' } } }, 'session');
    }
    assert.equal(globalThis.document.documentElement.dataset.theme, 'dark');

    // Non-theme settings updates must not trigger redundant theme callbacks
    await updateSettings({ autoCopyLink: false });
    assert.deepEqual(seenThemes, ['dark']);

    // React immediately when settings.theme updates in chrome.storage.local
    await updateSettings({ theme: 'light' });
    assert.equal(globalThis.document.documentElement.dataset.theme, 'light');
    assert.deepEqual(seenThemes, ['dark', 'light']);
    await updateSettings({ theme: 'auto' });
    assert.equal(globalThis.document.documentElement.dataset.theme, undefined);
    assert.deepEqual(seenThemes, ['dark', 'light', 'auto']);
  } finally {
    globalThis.document = prevDoc;
  }

  // 3. safeHttpsUrl blocks XSS / non-HTTPS schemes
  assert.equal(safeHttpsUrl('https://drive.google.com/drive/folders/abc'), 'https://drive.google.com/drive/folders/abc');
  for (const unsafe of [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'http://insecure.example.com/file',
    'file:///etc/passwd',
    'chrome-extension://abcdef/popup.html',
    'not a url',
    '',
    null,
    undefined,
    123,
  ]) {
    assert.equal(
      safeHttpsUrl(unsafe, 'https://drive.google.com/drive/my-drive'),
      'https://drive.google.com/drive/my-drive',
      `Must reject non-https URL: ${String(unsafe)}`
    );
    assert.equal(safeHttpsUrl(unsafe), '');
  }

  // 4. sendRuntimeMessage handles empty response and runtime.lastError cleanly
  installChromeMock({});
  await assert.rejects(() => sendRuntimeMessage({ type: 'PING' }), /No response/);
  globalThis.chrome.runtime.sendMessage = (_payload, cb) => {
    globalThis.chrome.runtime.lastError = { message: 'Extension context invalidated.' };
    cb(undefined);
    globalThis.chrome.runtime.lastError = null;
  };
  await assert.rejects(() => sendRuntimeMessage({ type: 'PING' }), /Extension context invalidated/);

  // 5. parseHexColorInput supports 3-digit & 6-digit hex and blocks malformed/injection inputs
  assert.equal(parseHexColorInput('#ff0066'), '#ff0066');
  assert.equal(parseHexColorInput('  1A73E8 '), '#1a73e8');
  assert.equal(parseHexColorInput('#f06'), '#ff0066');
  assert.equal(parseHexColorInput('0aF'), '#00aaff');
  for (const invalidHex of [
    '',
    '#',
    '#12',
    '#1234',
    '#12345',
    '#1234567',
    '#12345678',
    '#gggggg',
    'red',
    '#ff0066; color:red',
    '<script>',
    null,
    undefined,
    999,
  ]) {
    assert.equal(parseHexColorInput(invalidHex), null, `Should reject invalid hex: ${String(invalidHex)}`);
  }

  // 6. Strict getSettings() allowlist strips injected keys & preserves folder cache when updating theme
  installChromeMock({
    initialStore: {
      settings: {
        folderName: 'Design_Shots',
        folderId: 'fid-123',
        folderWebViewLink: 'https://drive.google.com/drive/folders/fid-123',
        folderCacheByEmail: {},
        autoCopyLink: false,
        editBeforeUpload: true,
        theme: 'dark',
        rogueInjectedKey: 'evil',
      },
    },
  });
  const cleanSettings = await getSettings();
  assert.equal(cleanSettings.theme, 'dark');
  assert.equal(cleanSettings.rogueInjectedKey, undefined, 'getSettings must strip non-allowlisted properties');

  const afterThemePatch = await updateSettings({ theme: 'light', extraRogue: 1 });
  assert.equal(afterThemePatch.theme, 'light');
  assert.equal(afterThemePatch.folderId, 'fid-123', 'Changing theme must not reset cached folderId');
  assert.equal(afterThemePatch.extraRogue, undefined);
});

test('CAPTURE_VISIBLE_FROM_OVERLAY security gate: blocks uninitiated, cross-tab, and replayed requests while surviving SW idle restart', async () => {
  const origFetch = globalThis.fetch;
  try {
    const tabs = [
      {
        id: 77,
        windowId: 3,
        active: true,
        url: 'https://example.com/article',
        title: 'Article',
        incognito: false,
      },
      {
        id: 88,
        windowId: 4,
        active: true,
        url: 'https://other.example/page',
        title: 'Other Page',
        incognito: false,
      },
    ];

    const mock = installChromeMock({
      initialStore: {
        signedOut: false,
        userProfile: { email: 'u@example.com', name: 'User', verifiedAt: Date.now() },
        settings: {
          folderName: 'Chrome_SaveShot_ScreenShots',
          folderId: 'folder-ov-1',
          folderWebViewLink: 'https://drive.google.com/drive/folders/folder-ov-1',
          folderCacheByEmail: {
            'u@example.com': {
              folderName: 'Chrome_SaveShot_ScreenShots',
              folderId: 'folder-ov-1',
              folderWebViewLink: 'https://drive.google.com/drive/folders/folder-ov-1',
            },
          },
          autoCopyLink: true,
          editBeforeUpload: false,
          theme: 'dark',
        },
      },
      tabs,
    });

    const {
      registerServiceWorkerListeners,
      resetInMemoryWorkerStateForTests,
      waitForInflightUploadForTests,
    } = await import('../background/service-worker.js');
    resetInMemoryWorkerStateForTests();
    if (mock.listeners.onMessage.length === 0) {
      registerServiceWorkerListeners();
    }

    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.startsWith('data:image/')) return origFetch(url, opts);
      if (u.includes('/drive/v3/about')) {
        return new Response(
          JSON.stringify({ user: { displayName: 'User', emailAddress: 'u@example.com' } }),
          { status: 200 }
        );
      }
      if (u.includes('/drive/v3/files/folder-ov-1')) {
        return new Response(
          JSON.stringify({
            id: 'folder-ov-1',
            name: 'Chrome_SaveShot_ScreenShots',
            trashed: false,
            webViewLink: 'https://drive.google.com/drive/folders/folder-ov-1',
          }),
          { status: 200 }
        );
      }
      if (opts.method === 'POST' && u.includes('/upload/drive/v3/files')) {
        return new Response(
          JSON.stringify({
            id: 'overlay_full_1',
            name: 'Screenshot_full.png',
            webViewLink: 'https://drive.google.com/file/d/overlay_full_1/view',
            createdTime: '2026-11-21T00:00:00.000Z',
          }),
          { status: 200 }
        );
      }
      if (u.includes('oauth2.googleapis.com/revoke')) {
        return new Response('', { status: 200 });
      }
      throw new Error(`Unhandled fetch in overlay security test: ${u}`);
    };

    const tab77Sender = {
      url: 'https://example.com/article',
      tab: { id: 77, windowId: 3, url: 'https://example.com/article' },
    };
    const tab88Sender = {
      url: 'https://other.example/page',
      tab: { id: 88, windowId: 4, url: 'https://other.example/page' },
    };

    // 1. Uninitiated CAPTURE_VISIBLE_FROM_OVERLAY from webpage MUST fail
    const uninitiated = await mock.dispatchMessage(
      { type: 'CAPTURE_VISIBLE_FROM_OVERLAY' },
      tab77Sender
    );
    assert.equal(uninitiated.ok, false);
    assert.equal(uninitiated.code, 'NO_ACTIVE_REGION_SESSION');

    // 2. Initiate region capture on tab 77 from trusted popup
    const startRes = await mock.dispatchMessage({ type: 'START_REGION_CAPTURE', tabId: 77 });
    assert.equal(startRes.ok, true);

    // 3. Cross-tab attempt from tab 88 MUST be rejected without consuming tab 77's session
    const crossTab = await mock.dispatchMessage(
      { type: 'CAPTURE_VISIBLE_FROM_OVERLAY' },
      tab88Sender
    );
    assert.equal(crossTab.ok, false);
    assert.equal(crossTab.code, 'NO_ACTIVE_REGION_SESSION');

    // 4. Simulate MV3 service-worker idle RAM wipe while overlay is open, then press Enter on tab 77
    resetInMemoryWorkerStateForTests();
    const validCapture = await mock.dispatchMessage(
      { type: 'CAPTURE_VISIBLE_FROM_OVERLAY' },
      tab77Sender
    );
    assert.equal(validCapture.ok, true);
    assert.equal(validCapture.openedEditor, true);
    assert.equal(validCapture.uploadingInBackground, true);
    assert.ok(validCapture.sessionId);

    const bgOverlayRes = await waitForInflightUploadForTests(validCapture.sessionId);
    assert.equal(bgOverlayRes.ok, true);
    await new Promise((r) => setTimeout(r, 10));

    const successToast = mock.sentTabMessages.find(
      (m) =>
        m.tabId === 77 &&
        m.message?.type === 'SHOW_TOAST' &&
        m.message.payload?.status === 'success'
    );
    assert.ok(successToast, 'Full-tab capture from overlay must display success toast on tab');
    assert.equal(
      successToast.message.payload.theme,
      'dark',
      'Toast payload must inherit user theme setting'
    );

    // 5. Replay attempt on tab 77 MUST fail (single-use consumption)
    const replayed = await mock.dispatchMessage(
      { type: 'CAPTURE_VISIBLE_FROM_OVERLAY' },
      tab77Sender
    );
    assert.equal(replayed.ok, false);
    assert.equal(replayed.code, 'NO_ACTIVE_REGION_SESSION');

    // 6. SIGN_OUT invalidates any pending region session
    await mock.dispatchMessage({ type: 'START_REGION_CAPTURE', tabId: 77 });
    await mock.dispatchMessage({ type: 'SIGN_OUT' });
    const afterSignOut = await mock.dispatchMessage(
      { type: 'CAPTURE_VISIBLE_FROM_OVERLAY' },
      tab77Sender
    );
    assert.equal(afterSignOut.ok, false);
    assert.equal(afterSignOut.code, 'NO_ACTIVE_REGION_SESSION');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('all repository source, UI, and documentation files contain no em dashes or en dashes, and CWS zip is in sync', async () => {
  const textExts = new Set(['.js', '.mjs', '.json', '.html', '.css', '.md', '.txt', '.xml', '.yml']);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.git') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (textExts.has(path.extname(entry.name))) {
        const content = fs.readFileSync(full, 'utf8');
        assert.ok(!content.includes('\u2014'), `Found em dash in ${path.relative(rootDir, full)}`);
        assert.ok(!content.includes('\u2013'), `Found en dash in ${path.relative(rootDir, full)}`);
      }
    }
  };
  walk(rootDir);

  const { buildCwsZipBuffer, findLatestCwsZipName } = await import('../scripts/pack-cws.mjs');
  const { version, buffer } = buildCwsZipBuffer();
  assert.equal(version, '1.3.0');
  const latestZipName = findLatestCwsZipName(rootDir, version);
  assert.ok(latestZipName, 'Expected epoch-stamped CWS zip in store-assets/');
  const zipOnDisk = fs.readFileSync(
    path.join(rootDir, 'store-assets', latestZipName)
  );
  assert.equal(
    Buffer.compare(buffer, zipOnDisk),
    0,
    `store-assets/${latestZipName} must match current extension source files (run npm run pack)`
  );

  // Verify centralized content source of truth stays 100% synced across Markdown, HTML, and metadata
  const { SITE_COPY } = await import('../content-source/site-copy.mjs');
  const {
    buildGeneratedFiles,
    inlineMarkdownToHtml,
    stripInlineMarkdown,
    syncPopupHtmlLinks,
    syncWelcomeHtmlLinks,
    toIsoDate,
  } = await import('../scripts/sync-docs.mjs');

  assert.equal(
    inlineMarkdownToHtml('Use `<script>` & **Save** at [Site](https://example.com)'),
    'Use <code>&lt;script&gt;</code> &amp; <strong>Save</strong> at <a href="https://example.com" target="_blank" rel="noopener noreferrer">Site</a>'
  );
  assert.equal(
    stripInlineMarkdown('Click **Copy image** (`Ctrl+C`) at [Support](https://example.com)'),
    'Click Copy image (Ctrl+C) at Support'
  );
  assert.equal(toIsoDate('November 23, 2026'), '2026-11-23');

  const expectedDocs = buildGeneratedFiles(SITE_COPY);
  for (const [relPath, expectedContent] of Object.entries(expectedDocs)) {
    const actualContent = fs.readFileSync(path.join(rootDir, relPath), 'utf8');
    assert.equal(
      actualContent,
      expectedContent,
      `${relPath} drifted from content-source/site-copy.mjs (run npm run sync:docs)`
    );
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.equal(manifest.name, SITE_COPY.extensionTitle);
  assert.equal(manifest.short_name, SITE_COPY.brandName);
  assert.equal(manifest.version, SITE_COPY.version);
  assert.equal(manifest.description, SITE_COPY.shortDescription);
  assert.equal(pkg.version, SITE_COPY.version);
  assert.equal(pkg.description, SITE_COPY.shortDescription);

  const welcomeHtml = fs.readFileSync(path.join(rootDir, 'pages/welcome.html'), 'utf8');
  assert.equal(
    welcomeHtml,
    syncWelcomeHtmlLinks(welcomeHtml, SITE_COPY),
    'welcome.html links drifted from content-source/site-copy.mjs (run npm run sync:docs)'
  );
  assert.ok(welcomeHtml.includes(`href="${SITE_COPY.urls.homepage}"`), 'welcome.html must link to centralized Website URL');
  assert.ok(welcomeHtml.includes(`href="${SITE_COPY.urls.thanksHtml}"`), 'welcome.html must link to centralized Say thanks URL');
  assert.ok(welcomeHtml.includes(`href="${SITE_COPY.urls.privacyHtml}"`), 'welcome.html must link to centralized Privacy URL');
  assert.ok(welcomeHtml.includes(`href="${SITE_COPY.urls.termsHtml}"`), 'welcome.html must link to centralized Terms URL');

  const popupHtml = fs.readFileSync(path.join(rootDir, 'popup/popup.html'), 'utf8');
  assert.equal(
    popupHtml,
    syncPopupHtmlLinks(popupHtml, SITE_COPY),
    'popup.html links drifted from content-source/site-copy.mjs (run npm run sync:docs)'
  );
  assert.ok(popupHtml.includes(`href="${SITE_COPY.urls.thanksHtml}"`), 'popup.html footer must link to centralized Say thanks URL');

  // Lock canonical SaveShot icons and verified store assets by SHA-256 so they are never regenerated or altered by mistake
  const { createHash } = await import('node:crypto');
  const sha256Of = (relPath) =>
    createHash('sha256').update(fs.readFileSync(path.join(rootDir, relPath))).digest('hex');

  const lockedIconHashes = {
    'icons/icon16.png': '32293a125918477bc6f508b18ed445751848a77b772a0ecf65ac2141775a28af',
    'icons/icon32.png': 'db38433443e058ba2490dc45441213177b44b61a62d572c9543584264ceac2af',
    'icons/icon48.png': '0d32454dfea49e2f67072ab29f587ef8d0d046571d92bcf8c886f9c9141ce63c',
    'icons/icon128.png': '7245aa8f1dfe2f99d6b89e812d2434b18f7fb60c8015d7f01245047075e70c91',
  };
  for (const [iconRel, expectedSha] of Object.entries(lockedIconHashes)) {
    assert.equal(
      sha256Of(iconRel),
      expectedSha,
      `Official SaveShot icon ${iconRel} is locked; do not regenerate or replace`
    );
  }

  // Website icons in docs/ must match canonical icons/ byte-for-byte
  assert.equal(
    Buffer.compare(
      fs.readFileSync(path.join(rootDir, 'docs/icon32.png')),
      fs.readFileSync(path.join(rootDir, 'icons/icon32.png'))
    ),
    0,
    'docs/icon32.png must match icons/icon32.png byte-for-byte'
  );
  assert.equal(
    Buffer.compare(
      fs.readFileSync(path.join(rootDir, 'docs/icon128.png')),
      fs.readFileSync(path.join(rootDir, 'icons/icon128.png'))
    ),
    0,
    'docs/icon128.png must match icons/icon128.png byte-for-byte'
  );

  // Verify store-assets were generated from the current extension UI, CSS tokens, icons, and copy
  const { ASSET_INPUT_FILES, STORE_ASSET_SPECS, computeAssetSourceHashes } = await import(
    '../scripts/generate-store-assets.mjs'
  );
  const assetManifestPath = path.join(rootDir, 'store-assets/.asset-manifest.json');
  assert.ok(
    fs.existsSync(assetManifestPath),
    'Missing store-assets/.asset-manifest.json (run npm run build:assets)'
  );
  const assetManifest = JSON.parse(fs.readFileSync(assetManifestPath, 'utf8'));
  const liveSourceHashes = computeAssetSourceHashes(rootDir);

  for (const relInput of ASSET_INPUT_FILES) {
    assert.equal(
      assetManifest.sourceHashes?.[relInput],
      liveSourceHashes[relInput],
      `Extension source "${relInput}" changed since store-assets were generated. Run "npm run build:assets" to regenerate store visuals.`
    );
  }

  for (const [assetRel] of STORE_ASSET_SPECS) {
    assert.equal(
      sha256Of(assetRel),
      assetManifest.outputHashes?.[assetRel],
      `Generated store asset ${assetRel} does not match .asset-manifest.json (run npm run build:assets)`
    );
  }

  // Website pages must use real icon PNGs, include 7 FAQs + Support card + valid JSON-LD on index.html, keep footers decluttered, and keep editor.html footer-free
  const indexHtml = fs.readFileSync(path.join(rootDir, 'docs/index.html'), 'utf8');
  assert.ok(indexHtml.includes('src="icon128.png"'), 'docs/index.html must render canonical icon128.png');
  assert.ok(
    indexHtml.includes('<link rel="alternate" type="text/plain" href="llms.txt"'),
    'docs/index.html head must advertise llms.txt for AI/agent discovery'
  );
  const ldJsonMatch = indexHtml.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(ldJsonMatch, 'docs/index.html must contain application/ld+json structured data');
  assert.ok(!ldJsonMatch[1].includes('<'), 'JSON-LD script body must escape all < characters');
  const parsedJsonLd = JSON.parse(ldJsonMatch[1]);
  assert.equal(parsedJsonLd['@context'], 'https://schema.org');
  const appNode = parsedJsonLd['@graph']?.find((n) => n['@type'] === 'SoftwareApplication');
  const faqNode = parsedJsonLd['@graph']?.find((n) => n['@type'] === 'FAQPage');
  assert.ok(appNode, 'JSON-LD must include SoftwareApplication');
  assert.equal(appNode.softwareVersion, SITE_COPY.version);
  assert.equal(appNode.installUrl, SITE_COPY.urls.chromeWebStore);
  assert.equal(appNode.offers?.price, '0');
  assert.equal(appNode.aggregateRating, undefined, 'JSON-LD must never include fabricated aggregateRating');
  assert.ok(faqNode, 'JSON-LD must include FAQPage');
  assert.equal(faqNode.mainEntity?.length, 7, 'JSON-LD FAQPage must include all 7 visible FAQs');

  const llmsTxt = fs.readFileSync(path.join(rootDir, 'docs/llms.txt'), 'utf8');
  assert.ok(llmsTxt.startsWith('# SaveShot\n'), 'docs/llms.txt must start with H1 # SaveShot');
  assert.ok(llmsTxt.includes(SITE_COPY.urls.chromeWebStore), 'docs/llms.txt must include Chrome Web Store URL');
  assert.ok(llmsTxt.includes(SITE_COPY.urls.privacyHtml), 'docs/llms.txt must include Privacy Policy URL');
  assert.ok(llmsTxt.includes('Copy image'), 'docs/llms.txt must document Copy image capability');

  const robotsTxt = fs.readFileSync(path.join(rootDir, 'docs/robots.txt'), 'utf8');
  assert.ok(robotsTxt.includes('Allow: /'), 'docs/robots.txt must allow crawlers');
  assert.ok(robotsTxt.includes(`Sitemap: ${SITE_COPY.urls.homepage}sitemap.xml`), 'docs/robots.txt must point to sitemap.xml');

  const sitemapXml = fs.readFileSync(path.join(rootDir, 'docs/sitemap.xml'), 'utf8');
  for (const expectedLoc of [
    SITE_COPY.urls.homepage,
    SITE_COPY.urls.privacyHtml,
    SITE_COPY.urls.termsHtml,
    SITE_COPY.urls.thanksHtml,
  ]) {
    assert.ok(sitemapXml.includes(`<loc>${expectedLoc}</loc>`), `docs/sitemap.xml must include ${expectedLoc}`);
  }

  assert.ok(!indexHtml.includes('brand-badge'), 'docs/index.html must never use a hand-drawn SVG brand badge');
  assert.ok(indexHtml.includes('class="hero-thanks"'), 'docs/index.html hero must include subtle Already using it? Say thanks link');
  assert.equal((indexHtml.match(/<details\b/g) || []).length, 7, 'docs/index.html must render all 7 collapsible FAQs');
  assert.ok(
    indexHtml.includes(`href="${SITE_COPY.urls.chromeWebStoreSupport}"`),
    'docs/index.html Support card must link to Chrome Web Store Support page'
  );
  const indexSupportActions = indexHtml.match(/<div class="support-actions">[\s\S]*?<\/div>/)?.[0] || '';
  assert.equal(
    (indexSupportActions.match(/<a\b/g) || []).length,
    1,
    'docs/index.html Support card must render only the single Chrome Web Store Support button'
  );
  assert.equal((indexHtml.match(/href="thanks\.html"/g) || []).length, 2, 'thanks.html should appear in hero inline link and footer');
  assert.equal((indexHtml.match(/href="privacy\.html"/g) || []).length, 1, 'privacy.html should appear once in docs/index.html footer');
  assert.equal((indexHtml.match(/href="terms\.html"/g) || []).length, 1, 'terms.html should appear once in docs/index.html footer');

  const indexFooterLinks = indexHtml.match(/<nav class="site-footer-links"[\s\S]*?<\/nav>/)?.[0] || '';
  assert.equal(
    (indexFooterLinks.match(/<a\b/g) || []).length,
    4,
    'docs/index.html footer must stay decluttered at exactly 4 links (Say thanks, Privacy, Terms, @_simplyakm)'
  );

  const thanksHtml = fs.readFileSync(path.join(rootDir, 'docs/thanks.html'), 'utf8');
  assert.ok(
    thanksHtml.includes(`href="${SITE_COPY.urls.chromeWebStoreReviews}"`),
    'docs/thanks.html must link directly to Chrome Web Store reviews tab'
  );
  assert.ok(
    !thanksHtml.includes('topmate.io') && !thanksHtml.includes('Send a thank-you'),
    'docs/thanks.html must omit the removed Send a thank-you block'
  );
  assert.ok(!thanksHtml.includes('card-meta'), 'docs/thanks.html must not render card-meta badges');
  assert.equal(
    fs.readFileSync(path.join(rootDir, 'docs/CNAME'), 'utf8').trim(),
    'saveshot.simplyakm.com',
    'docs/CNAME must match the custom domain'
  );

  const editorHtml = fs.readFileSync(path.join(rootDir, 'pages/editor.html'), 'utf8');
  assert.ok(!editorHtml.includes('<footer'), 'pages/editor.html must remain footer-free for full-height canvas');

  assert.equal((welcomeHtml.match(/class="faq-item"/g) || []).length, 7, 'pages/welcome.html must render all 7 Good to know FAQs');
  assert.ok(welcomeHtml.includes('id="pin-nudge-card"'), 'pages/welcome.html must include smart live Pin-to-Chrome card');
  assert.ok(welcomeHtml.includes('id="version-strip"'), 'pages/welcome.html must include W1 version info strip');
  assert.ok(welcomeHtml.includes(`href="${SITE_COPY.urls.chromeWebStoreSupport}"`), 'pages/welcome.html must link to Chrome Web Store Support');
  assert.ok(!welcomeHtml.includes('repo-issues-link'), 'pages/welcome.html must not include Raise on GitHub button');

  for (const webPage of ['docs/index.html', 'docs/thanks.html', 'docs/privacy.html', 'docs/terms.html']) {
    const html = fs.readFileSync(path.join(rootDir, webPage), 'utf8');
    assert.ok(html.includes('href="icon32.png"'), `${webPage} must include official icon32.png favicon`);
    assert.ok(html.includes('class="site-footer"'), `${webPage} must include unified single-line site-footer`);
    assert.ok(html.includes('Privacy-first screenshot tool'), `${webPage} footer must show SaveShot · Privacy-first screenshot tool`);
  }

  // Capability-only shortcuts, zero github.com links, & footer-only @_simplyakm invariants across static HTML, Markdown, and agent discovery files
  for (const staticRel of [
    'docs/index.html',
    'docs/thanks.html',
    'docs/privacy.html',
    'docs/terms.html',
    'docs/llms.txt',
    'docs/robots.txt',
    'docs/sitemap.xml',
    'popup/popup.html',
    'pages/editor.html',
    'pages/welcome.html',
    'README.md',
    'PRIVACY.md',
    'TERMS.md',
    'store-assets/STORE_LISTING_SEO.md',
  ]) {
    const text = fs.readFileSync(path.join(rootDir, staticRel), 'utf8');
    assert.ok(
      !/Alt\s*\+\s*Shift\s*\+\s*[SV]/i.test(text),
      `${staticRel} must never hardcode exact Alt+Shift+S / Alt+Shift+V shortcut keys`
    );
    assert.ok(
      !text.toLowerCase().includes('github.com'),
      `${staticRel} must not contain any github.com URLs`
    );
    assert.ok(
      !text.includes('Open editor before uploading'),
      `${staticRel} must not retain legacy "Open editor before uploading" label`
    );
    if (staticRel.endsWith('.html')) {
      const withoutFooters = text.replace(/<footer\b[\s\S]*?<\/footer>/gi, '');
      assert.ok(
        !withoutFooters.includes('_simplyakm'),
        `${staticRel} must never mention @_simplyakm outside <footer>`
      );
    } else {
      assert.ok(
        !text.includes('_simplyakm'),
        `${staticRel} must not mention @_simplyakm in prose`
      );
    }
  }

  // Verify Option B Privacy Toggle label ("Only upload when I click Save") across popup UI & all synced docs
  for (const toggleDocRel of [
    'popup/popup.html',
    'README.md',
    'docs/index.html',
    'docs/llms.txt',
    'pages/welcome.html',
    'store-assets/STORE_LISTING_SEO.md',
  ]) {
    const toggleText = fs.readFileSync(path.join(rootDir, toggleDocRel), 'utf8');
    assert.ok(
      toggleText.includes('Only upload when I click Save'),
      `${toggleDocRel} must document "Only upload when I click Save"`
    );
  }
});

test('optimizations and edge cases: formatShortcutDisplay, zero-fetch base64 decode, session blob pruning, and Incognito post-upload editor isolation', async () => {
  // 1. formatShortcutDisplay handles spacing, empty strings, and non-string inputs
  assert.equal(formatShortcutDisplay('Alt+Shift+S'), 'Alt + Shift + S');
  assert.equal(formatShortcutDisplay('  Command + Shift + V  '), 'Command + Shift + V');
  assert.equal(formatShortcutDisplay(''), '');
  assert.equal(formatShortcutDisplay('   '), '');
  assert.equal(formatShortcutDisplay(null), '');
  assert.equal(formatShortcutDisplay(undefined), '');
  assert.equal(formatShortcutDisplay(42), '');

  // 2. dataUrlToBlob decodes base64 PNGs in-memory without invoking globalThis.fetch, and rejects corrupt/empty base64
  const savedFetch = globalThis.fetch;
  try {
    let fetchCalled = false;
    globalThis.fetch = async (url, opts) => {
      fetchCalled = true;
      return savedFetch(url, opts);
    };
    const decoded = await dataUrlToBlob(TINY_PNG_DATA_URL);
    assert.equal(fetchCalled, false, 'Base64 dataUrlToBlob must decode directly without fetch overhead');
    assert.equal(decoded.type, 'image/png');
    assert.ok(decoded.size > 0);

    // Also verify legacy atob / btoa fallback path for pre-Chrome-140 browsers
    const origFromB64 = Uint8Array.fromBase64;
    const origToB64 = Uint8Array.prototype.toBase64;
    try {
      Uint8Array.fromBase64 = undefined;
      Uint8Array.prototype.toBase64 = undefined;
      const legacyBlob = await dataUrlToBlob(TINY_PNG_DATA_URL);
      assert.equal(legacyBlob.size, decoded.size);
      const legacyEncoded = await blobToDataUrl(legacyBlob);
      assert.equal(legacyEncoded, TINY_PNG_DATA_URL);
      await assert.rejects(
        () => dataUrlToBlob('data:image/png;base64,%%%corrupt%%%'),
        (err) => err.code === 'EMPTY_CAPTURE'
      );
    } finally {
      Uint8Array.fromBase64 = origFromB64;
      Uint8Array.prototype.toBase64 = origToB64;
    }

    await assert.rejects(
      () => dataUrlToBlob('data:image/png;base64,%%%corrupt%%%'),
      (err) => err.code === 'EMPTY_CAPTURE'
    );
    await assert.rejects(
      () => dataUrlToBlob('data:image/png;base64,'),
      (err) => err.code === 'EMPTY_CAPTURE'
    );

    // Non-base64 SVG data URL gracefully falls back to fetch
    const svgBlob = await dataUrlToBlob('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>');
    assert.equal(fetchCalled, true);
    assert.ok(svgBlob.size > 0);
  } finally {
    globalThis.fetch = savedFetch;
  }

  // 3. Pre-upload session storage keeps at most 2 preUploadPng_* blobs and Incognito post-upload opens Editor without writing local history
  const origFetch = globalThis.fetch;
  try {
    const mock = installChromeMock({
      initialStore: {
        signedOut: false,
        userProfile: { email: 'incog@example.com', name: 'Incog', verifiedAt: Date.now() },
        settings: {
          folderName: 'Chrome_SaveShot_ScreenShots',
          folderId: 'f-incog-1',
          folderWebViewLink: 'https://drive.google.com/drive/folders/f-incog-1',
          folderCacheByEmail: {
            'incog@example.com': {
              folderName: 'Chrome_SaveShot_ScreenShots',
              folderId: 'f-incog-1',
              folderWebViewLink: 'https://drive.google.com/drive/folders/f-incog-1',
            },
          },
          autoCopyLink: true,
          editBeforeUpload: true,
          theme: 'auto',
        },
      },
      tabs: [
        {
          id: 91,
          windowId: 7,
          active: true,
          url: 'https://secret.example/private',
          title: 'Private Page',
          incognito: true,
        },
      ],
    });

    const {
      registerServiceWorkerListeners,
      resetInMemoryWorkerStateForTests,
      waitForInflightUploadForTests,
    } = await import('../background/service-worker.js');
    resetInMemoryWorkerStateForTests();
    if (mock.listeners.onMessage.length === 0) {
      registerServiceWorkerListeners();
    }

    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/drive/v3/files/f-incog-1')) {
        return new Response(
          JSON.stringify({
            id: 'f-incog-1',
            name: 'Chrome_SaveShot_ScreenShots',
            trashed: false,
            webViewLink: 'https://drive.google.com/drive/folders/f-incog-1',
          }),
          { status: 200 }
        );
      }
      if (opts.method === 'POST' && u.includes('/upload/drive/v3/files')) {
        return new Response(
          JSON.stringify({
            id: 'incog_file_1',
            name: 'Screenshot_incognito.png',
            webViewLink: 'https://drive.google.com/file/d/incog_file_1/view',
            createdTime: '2026-11-21T00:00:00.000Z',
          }),
          { status: 200 }
        );
      }
      if (u.includes('oauth2.googleapis.com/revoke')) {
        return new Response('', { status: 200 });
      }
      throw new Error(`Unexpected fetch in optimization test: ${u}`);
    };

    // Capture 3 pre-upload sessions back-to-back (spaced >520ms handled by captureVisibleTabSafe)
    const s1 = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 91 });
    const s2 = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 91 });
    const s3 = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 91 });
    assert.equal(s1.openedEditor, true);
    assert.equal(s2.openedEditor, true);
    assert.equal(s3.openedEditor, true);

    const sessionSnapshot = await globalThis.chrome.storage.session.get(null);
    const pngKeys = Object.keys(sessionSnapshot).filter((k) => k.startsWith('preUploadPng_'));
    assert.equal(pngKeys.length, 2, 'Should retain at most 2 pre-upload PNG blobs in chrome.storage.session');
    assert.ok(pngKeys.includes(`preUploadPng_${s2.sessionId}`));
    assert.ok(pngKeys.includes(`preUploadPng_${s3.sessionId}`));

    // Switch editBeforeUpload off and capture in Incognito -> opens Editor immediately + uploads in background while keeping recentUploads empty
    await mock.dispatchMessage({ type: 'UPDATE_SETTINGS', patch: { editBeforeUpload: false } });
    const incogCap = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 91 });
    assert.equal(incogCap.ok, true);
    assert.equal(incogCap.openedEditor, true);
    assert.equal(incogCap.uploadingInBackground, true);
    const incogBg = await waitForInflightUploadForTests(incogCap.sessionId);
    assert.equal(incogBg.ok, true);
    assert.equal((await getRecentUploads()).length, 0, 'Incognito upload must never store local recentUploads');

    const trustedSender = {
      url: 'chrome-extension://testext/pages/editor.html',
      tab: { id: 600, url: 'chrome-extension://testext/pages/editor.html' },
    };
    const incogEditor = await mock.dispatchMessage(
      { type: 'GET_EDITOR_SESSION', sessionId: incogCap.sessionId },
      trustedSender
    );
    assert.equal(incogEditor.ok, true);
    assert.equal(incogEditor.session.incognito, true);
    assert.equal(incogEditor.session.uploadState, 'uploaded');
    assert.equal(incogEditor.session.justUploaded, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('OAuth grant revocation on signOut, DRIVE_SCOPE_MISSING grant reset, silent-session race protection, concurrent signIn deduplication, and signed-out editBeforeUpload fallback', async () => {
  const origFetch = globalThis.fetch;
  try {
    // 1. Normal signOut evicts local Chrome tokens, clears state, AND calls oauth2.googleapis.com/revoke so Account Chooser opens on reconnect
    const revokedUrls = [];
    const { store: s1Store, removedTokens: s1Removed, wasClearedAll: s1WasClearedAll } = installChromeMock({
      initialStore: {
        signedOut: false,
        userProfile: { email: 'alice@example.com', name: 'Alice', verifiedAt: Date.now() },
        recentUploads: [{ id: 'f1', name: 'shot.png', webViewLink: 'https://drive.google.com/file/d/f1/view' }],
      },
    });
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/revoke')) {
        assert.equal(opts.method, 'POST');
        revokedUrls.push(u);
        return new Response('', { status: 200 });
      }
      throw new Error(`Unexpected fetch during signOut: ${url}`);
    };

    await signOut();
    assert.equal(revokedUrls.length, 1, 'signOut must revoke Google OAuth grant so Account Chooser opens on next sign-in');
    assert.match(revokedUrls[0], /token=token-1/);
    assert.equal(s1WasClearedAll(), true, 'signOut must call clearAllCachedAuthTokens');
    assert.equal(s1Store.signedOut, true);
    assert.equal(s1Store.userProfile, null);
    assert.deepEqual(s1Store.recentUploads, []);
    assert.deepEqual(s1Removed, ['token-1']);

    // While signed out, getSilentAuthSession never silently signs the user back in
    const silentAfterSignOut = await getSilentAuthSession();
    assert.equal(silentAfterSignOut.signedIn, false);

    // 2. Incomplete granular scope (DRIVE_SCOPE_MISSING / 403) also calls /revoke so next sign-in re-prompts checkbox
    const { removedTokens: scopeRemoved } = installChromeMock({});
    const revokedTokens = [];
    const scopeFetch = async (url) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/revoke')) {
        revokedTokens.push(u);
        return new Response('', { status: 200 });
      }
      return new Response('', { status: 403 });
    };
    await assert.rejects(
      () => signIn(scopeFetch),
      (err) => err.code === 'DRIVE_SCOPE_MISSING'
    );
    assert.deepEqual(scopeRemoved, ['token-1']);
    assert.equal(revokedTokens.length, 1, 'Incomplete scope grant must be revoked at Google');
    assert.match(revokedTokens[0], /token=token-1/);

    await assert.rejects(
      () =>
        withAuthToken(
          async () => {
            throw classifyDriveHttpError(403, {
              error: { errors: [{ reason: 'insufficientPermissions' }] },
            });
          },
          { interactive: true, fetchImpl: scopeFetch }
        ),
      (err) => err.code === 'DRIVE_SCOPE_MISSING'
    );
    assert.equal(revokedTokens.length, 2, 'withAuthToken DRIVE_SCOPE_MISSING must also revoke incomplete grant');

    // 3. In-flight getSilentAuthSession race vs signOut must NEVER resurrect signedOut=false and must revoke stale token
    const raceRevoked = [];
    const { store: raceStore } = installChromeMock({
      initialStore: {
        signedOut: false,
        userProfile: { email: 'alice@example.com', name: 'Alice', verifiedAt: 1 }, // stale verifiedAt forces /drive/v3/about check
      },
    });
    let resolveAboutFetch;
    const slowAboutFetch = (url) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/revoke')) {
        raceRevoked.push(u);
        return Promise.resolve(new Response('', { status: 200 }));
      }
      return new Promise((resolve) => {
        resolveAboutFetch = () =>
          resolve(
            new Response(
              JSON.stringify({
                user: { displayName: 'Alice', emailAddress: 'alice@example.com' },
              }),
              { status: 200 }
            )
          );
      });
    };

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/revoke')) {
        raceRevoked.push(u);
        return new Response('', { status: 200 });
      }
      throw new Error(`Unexpected global fetch in silent race test: ${u}`);
    };

    const pendingSilent = getSilentAuthSession(slowAboutFetch);
    await new Promise((r) => setTimeout(r, 15));
    await signOut();
    resolveAboutFetch();
    const racedResult = await pendingSilent;
    assert.equal(racedResult.signedIn, false, 'Stale silent check must resolve signedIn=false after signOut');
    assert.equal(raceStore.signedOut, true, 'Stale silent check must never overwrite signedOut back to false');
    assert.equal(raceStore.userProfile, null);
    assert.ok(raceRevoked.length >= 1, 'Token from superseded silent session must be revoked');

    // 4. Concurrent double-clicked signIn() shares a single interactive getAuthToken call,
    //    and superseding an in-flight silent session with signIn() does NOT revoke the active grant!
    let interactiveTokenCalls = 0;
    let falseRevokesDuringSignIn = 0;
    installChromeMock({
      initialStore: {
        signedOut: false,
        userProfile: { email: 'alice@example.com', name: 'Alice', verifiedAt: 1 },
      },
      onGetAuthToken: ({ interactive }) => {
        if (interactive) interactiveTokenCalls += 1;
        return { token: interactive ? `tok-dedup-${interactiveTokenCalls}` : 'tok-silent-pre' };
      },
    });
    globalThis.fetch = async (url) => {
      if (String(url).includes('oauth2.googleapis.com/revoke')) {
        falseRevokesDuringSignIn += 1;
        return new Response('', { status: 200 });
      }
      await new Promise((r) => setTimeout(r, 20));
      return new Response(
        JSON.stringify({
          user: { displayName: 'Alice', emailAddress: 'alice@example.com' },
        }),
        { status: 200 }
      );
    };
    const silentBeforeSignIn = getSilentAuthSession();
    const [resA, resB] = await Promise.all([signIn(), signIn()]);
    await silentBeforeSignIn;
    assert.equal(interactiveTokenCalls, 1, 'Concurrent signIn() calls must share one interactive token request');
    assert.equal(falseRevokesDuringSignIn, 0, 'signIn superseding silent check must NOT revoke grant');
    assert.equal(resA.profile.email, 'alice@example.com');
    assert.equal(resB.profile.email, 'alice@example.com');

    // 5. End-to-end service-worker SIGN_OUT revokes grant, signed-out captures open local Editor with zero Drive calls,
    //    and clicking Save to Google Drive inside Editor runs OAuth + reuses cached folder + uploads PNG seamlessly!
    let swRevokeCalls = 0;
    let folderCreates = 0;
    let cancelNextInteractiveAuth = false;
    const swMock = installChromeMock({
      initialStore: {
        signedOut: false,
        userProfile: { email: 'alice@example.com', name: 'Alice', verifiedAt: Date.now() },
        settings: {
          folderName: 'Chrome_SaveShot_ScreenShots',
          folderId: 'alice-folder-99',
          folderWebViewLink: 'https://drive.google.com/drive/folders/alice-folder-99',
          folderCacheByEmail: {
            'alice@example.com': {
              folderName: 'Chrome_SaveShot_ScreenShots',
              folderId: 'alice-folder-99',
              folderWebViewLink: 'https://drive.google.com/drive/folders/alice-folder-99',
            },
          },
          autoCopyLink: true,
          editBeforeUpload: false,
          theme: 'auto',
        },
      },
      onGetAuthToken: ({ interactive }) => {
        if (interactive && cancelNextInteractiveAuth) {
          cancelNextInteractiveAuth = false;
          return { error: 'The user did not approve access.' };
        }
        return { token: interactive ? 'tok-editor-signin' : 'tok-cached' };
      },
      tabs: [
        {
          id: 55,
          windowId: 2,
          active: true,
          url: 'https://example.com/dashboard',
          title: 'Dashboard',
          incognito: false,
        },
      ],
    });

    const { registerServiceWorkerListeners, resetInMemoryWorkerStateForTests } = await import(
      '../background/service-worker.js'
    );
    resetInMemoryWorkerStateForTests();
    registerServiceWorkerListeners();

    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.startsWith('data:image/')) {
        return origFetch(url, opts);
      }
      if (u.includes('oauth2.googleapis.com/revoke')) {
        swRevokeCalls += 1;
        return new Response('', { status: 200 });
      }
      if (u.includes('/drive/v3/about')) {
        return new Response(
          JSON.stringify({ user: { displayName: 'Alice', emailAddress: 'alice@example.com' } }),
          { status: 200 }
        );
      }
      if (u.includes('/drive/v3/files/alice-folder-99')) {
        return new Response(
          JSON.stringify({
            id: 'alice-folder-99',
            name: 'Chrome_SaveShot_ScreenShots',
            trashed: false,
            webViewLink: 'https://drive.google.com/drive/folders/alice-folder-99',
          }),
          { status: 200 }
        );
      }
      if (opts.method === 'POST' && u.includes('/upload/drive/v3/files')) {
        return new Response(
          JSON.stringify({
            id: 'editor_upgraded_file_1',
            name: 'Local_Shot_Upgraded.png',
            webViewLink: 'https://drive.google.com/file/d/editor_upgraded_file_1/view',
            createdTime: '2026-11-22T12:00:00.000Z',
          }),
          { status: 200 }
        );
      }
      if (opts.method === 'POST' && u.includes('/drive/v3/files')) {
        folderCreates += 1;
      }
      throw new Error(`Unexpected SW fetch: ${u}`);
    };

    // Sign out -> MUST call /revoke so Google re-opens Account Chooser on next Connect
    const outRes = await swMock.dispatchMessage({ type: 'SIGN_OUT' });
    assert.equal(outRes.ok, true);
    assert.equal(swRevokeCalls, 1, 'Service worker SIGN_OUT must revoke Google OAuth token');

    // Signed-out START_REGION_CAPTURE works immediately with zero Google API requests
    const signedOutRegionStart = await swMock.dispatchMessage({
      type: 'START_REGION_CAPTURE',
      tabId: 55,
    });
    assert.equal(signedOutRegionStart.ok, true, 'Region selection must work while signed out');

    // Signed-out CAPTURE_VISIBLE opens local Editor directly (even with editBeforeUpload=false)
    const signedOutLocalCap = await swMock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 55 });
    assert.equal(signedOutLocalCap.ok, true);
    assert.equal(signedOutLocalCap.openedEditor, true);
    assert.ok(signedOutLocalCap.sessionId);
    assert.equal(swMock.createdTabs.length, 1, 'Must open local Editor tab when capturing while signed out');

    const trustedEditorSender = {
      url: `chrome-extension://testext/pages/editor.html?session=${signedOutLocalCap.sessionId}`,
      tab: { id: 700, url: `chrome-extension://testext/pages/editor.html?session=${signedOutLocalCap.sessionId}` },
    };
    const localSessionLoaded = await swMock.dispatchMessage(
      { type: 'GET_EDITOR_SESSION', sessionId: signedOutLocalCap.sessionId },
      trustedEditorSender
    );
    assert.equal(localSessionLoaded.ok, true);
    assert.equal(localSessionLoaded.session.mode, 'new');
    assert.equal(localSessionLoaded.session.signedIn, false);
    assert.ok(localSessionLoaded.dataUrl.startsWith('data:image/png;base64,'));

    // User clicks "Save to Google Drive" in Editor and cancels OAuth -> returns AUTH_CANCELLED without losing session
    cancelNextInteractiveAuth = true;
    const cancelledEditorSave = await swMock.dispatchMessage(
      {
        type: 'SAVE_EDITED_SCREENSHOT',
        sessionId: signedOutLocalCap.sessionId,
        filename: 'Local_Shot_Upgraded.png',
        dataUrl: TINY_PNG_DATA_URL,
        imageModified: true,
        saveMode: 'new',
      },
      trustedEditorSender
    );
    assert.equal(cancelledEditorSave.ok, false);
    assert.equal(cancelledEditorSave.code, 'AUTH_CANCELLED');
    assert.equal(swMock.store.signedOut, true);

    // User clicks "Save to Google Drive" again and approves OAuth -> signs in, reuses cached alice-folder-99, and uploads PNG!
    const upgradedSave = await swMock.dispatchMessage(
      {
        type: 'SAVE_EDITED_SCREENSHOT',
        sessionId: signedOutLocalCap.sessionId,
        filename: 'Local_Shot_Upgraded.png',
        dataUrl: TINY_PNG_DATA_URL,
        imageModified: true,
        saveMode: 'new',
      },
      trustedEditorSender
    );
    assert.equal(upgradedSave.ok, true);
    assert.equal(upgradedSave.action, 'created');
    assert.equal(upgradedSave.signedIn, true);
    assert.equal(upgradedSave.upload.id, 'editor_upgraded_file_1');
    assert.equal(folderCreates, 0, 'Upgrading from Editor must reuse verified cached Drive folder');
    assert.equal(swMock.store.signedOut, false);
    assert.equal((await getRecentUploads()).length, 1, 'Uploaded shot must appear in Recent uploads after sign-in');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('token eviction and revocation resilience: API throws, offline revoke failure, wedged callbacks, failed silent lookup, mid-flight signIn/upload signOut races, and storage quota overflow', async () => {
  const origFetch = globalThis.fetch;
  try {
    let revokedTokens = [];
    let failRevokeNetwork = false;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/revoke')) {
        if (failRevokeNetwork) {
          throw new TypeError('Failed to fetch (offline)');
        }
        revokedTokens.push(u);
        return new Response('', { status: 200 });
      }
      throw new Error(`Unexpected fetch in eviction resilience test: ${u}`);
    };

    // 1. removeCachedAuthToken throws synchronously OR sets runtime.lastError -> clearAllCachedAuthTokens, /revoke, and signedOut=true still succeed
    const { store: throwStore } = installChromeMock({
      initialStore: {
        signedOut: false,
        userProfile: { email: 'alice@example.com', name: 'Alice', verifiedAt: Date.now() },
        recentUploads: [{ id: 'f1', name: 'a.png', webViewLink: 'https://drive.google.com/file/d/f1/view' }],
      },
    });
    let clearAllCalls = 0;
    globalThis.chrome.identity.removeCachedAuthToken = () => {
      throw new Error('Extension context or identity cache internal error');
    };
    globalThis.chrome.identity.clearAllCachedAuthTokens = (cb) => {
      clearAllCalls += 1;
      cb();
    };

    assert.equal(await removeCachedToken('bad-tok'), false);
    await signOut();
    assert.equal(clearAllCalls, 1, 'clearAllCachedAuthTokens must still run when removeCachedAuthToken throws');
    assert.equal(revokedTokens.length, 1, 'Google /revoke must still run when removeCachedAuthToken throws');
    assert.equal(throwStore.signedOut, true);
    assert.equal(throwStore.userProfile, null);
    assert.deepEqual(throwStore.recentUploads, []);

    // Also when removeCachedAuthToken sets chrome.runtime.lastError
    globalThis.chrome.identity.removeCachedAuthToken = (_opts, cb) => {
      globalThis.chrome.runtime.lastError = { message: 'Token not found in cache' };
      cb();
      globalThis.chrome.runtime.lastError = null;
    };
    assert.equal(await removeCachedToken('missing-tok'), false);

    // 2. Offline / failed /revoke AND clearAllCachedAuthTokens throws -> removeCachedAuthToken still evicts token & signOut resolves cleanly
    failRevokeNetwork = true;
    const { store: clearErrStore, removedTokens: clearErrRemoved } = installChromeMock({
      initialStore: {
        signedOut: false,
        userProfile: { email: 'alice@example.com', name: 'Alice', verifiedAt: Date.now() },
      },
    });
    globalThis.chrome.identity.clearAllCachedAuthTokens = () => {
      throw new Error('clearAllCachedAuthTokens unavailable');
    };
    assert.equal(await clearAllCachedTokens(), false);
    await signOut();
    assert.deepEqual(clearErrRemoved, ['token-1']);
    assert.equal(clearErrStore.signedOut, true);
    assert.equal(clearErrStore.userProfile, null);
    failRevokeNetwork = false;

    // 3. Browser without clearAllCachedAuthTokens AND silent getAuthToken fails during signOut -> knownTokens from earlier signIn is STILL evicted AND revoked at Google
    revokedTokens = [];
    let failSilentLookup = false;
    const { removedTokens: fallbackRemoved, store: fallbackStore } = installChromeMock({
      onGetAuthToken: ({ interactive }) => {
        if (!interactive && failSilentLookup) {
          return { error: 'Connection lost while checking cached token' };
        }
        return { token: 'active-session-token-77' };
      },
    });
    delete globalThis.chrome.identity.clearAllCachedAuthTokens;
    await signIn(async () =>
      new Response(
        JSON.stringify({ user: { displayName: 'Alice', emailAddress: 'alice@example.com' } }),
        { status: 200 }
      )
    );
    failSilentLookup = true;
    await signOut();
    assert.deepEqual(
      fallbackRemoved,
      ['active-session-token-77'],
      'Must still evict known token locally when silent getAuthToken fails and clearAllCachedAuthTokens is unsupported'
    );
    assert.equal(revokedTokens.length, 1, 'Must also revoke known token at Google even when silent getAuthToken fails');
    assert.match(revokedTokens[0], /token=active-session-token-77/);
    assert.equal(fallbackStore.signedOut, true);
    assert.equal(fallbackStore.userProfile, null);

    // 4. Wedged chrome.identity callbacks AND hung network fetch -> signOut resolves within timeoutMs and still persists signedOut=true
    const { store: hungStore } = installChromeMock({
      initialStore: {
        signedOut: false,
        userProfile: { email: 'alice@example.com', name: 'Alice', verifiedAt: Date.now() },
        recentUploads: [{ id: 'f2', name: 'b.png', webViewLink: 'https://drive.google.com/file/d/f2/view' }],
      },
    });
    globalThis.chrome.identity.getAuthToken = () => {};
    globalThis.chrome.identity.removeCachedAuthToken = () => {};
    globalThis.chrome.identity.clearAllCachedAuthTokens = () => {};

    const t0 = Date.now();
    await signOut({
      timeoutMs: 35,
      fetchImpl: (_url, { signal }) =>
        new Promise((_res, rej) => {
          signal.addEventListener('abort', () => rej(new Error('Aborted')));
        }),
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `signOut must not hang when chrome.identity or network wedges (took ${elapsed}ms)`);
    assert.equal(hungStore.signedOut, true);
    assert.equal(hungStore.userProfile, null);
    assert.deepEqual(hungStore.recentUploads, []);

    // 5. signOut called while interactive signIn is mid-flight -> newly minted token is immediately evicted AND revoked at Google
    revokedTokens = [];
    let finishInteractiveAbout;
    const { store: midSignInStore, removedTokens: midSignInRemoved } = installChromeMock({
      onGetAuthToken: () => ({ token: 'late-minted-token-99' }),
    });
    let midSignInClearedAll = 0;
    globalThis.chrome.identity.clearAllCachedAuthTokens = (cb) => {
      midSignInClearedAll += 1;
      cb();
    };
    const pendingSignIn = signIn((url) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/revoke')) {
        revokedTokens.push(u);
        return Promise.resolve(new Response('', { status: 200 }));
      }
      return new Promise((resolve) => {
        finishInteractiveAbout = () =>
          resolve(
            new Response(
              JSON.stringify({ user: { displayName: 'Alice', emailAddress: 'alice@example.com' } }),
              { status: 200 }
            )
          );
      });
    });
    await new Promise((r) => setTimeout(r, 15));
    await signOut();
    finishInteractiveAbout();
    await assert.rejects(
      () => pendingSignIn,
      (err) => err.code === 'AUTH_CANCELLED'
    );
    assert.ok(
      midSignInRemoved.includes('late-minted-token-99'),
      'Token minted by superseded signIn must be evicted immediately'
    );
    assert.ok(
      revokedTokens.some((u) => u.includes('token=late-minted-token-99')),
      'Token minted by superseded signIn must also be revoked at Google'
    );
    assert.ok(midSignInClearedAll >= 2, 'clearAllCachedAuthTokens must run during signOut and superseded signIn');
    assert.equal(midSignInStore.signedOut, true);
    assert.equal(midSignInStore.userProfile, null);

    // 6. signOut called mid-upload right before 401 token refresh -> refuses to mint/keep refreshed token and throws AUTH_REQUIRED
    revokedTokens = [];
    const { store: midUploadStore, removedTokens: midUploadRemoved } = installChromeMock({
      initialStore: {
        signedOut: false,
        userProfile: { email: 'alice@example.com', name: 'Alice', verifiedAt: Date.now() },
      },
      onGetAuthToken: (_opts, count) => ({ token: `upload-tok-${count}` }),
    });
    let refreshTokenRequests = 0;
    const origGetAuth = globalThis.chrome.identity.getAuthToken;
    globalThis.chrome.identity.getAuthToken = (opts, cb) => {
      refreshTokenRequests += 1;
      return origGetAuth(opts, cb);
    };

    await assert.rejects(
      () =>
        withAuthToken(async () => {
          await signOut();
          const unauthorized = new Error('Expired token');
          unauthorized.status = 401;
          throw unauthorized;
        }),
      (err) => err.code === 'AUTH_REQUIRED'
    );
    // 1st call: initial upload token; 2nd call: signOut's silent lookup; NO 3rd call to refresh after signOut!
    assert.equal(refreshTokenRequests, 2, 'Must not request a refreshed token on 401 after user already signed out');
    assert.ok(midUploadRemoved.includes('upload-tok-1'));
    assert.ok(revokedTokens.some((u) => u.includes('token=upload-tok-1')));
    assert.equal(midUploadStore.signedOut, true);

    // 7. Storage quota exceeded on first chrome.storage.local.set during signOut -> frees profile/history, clears folderId, and persists signedOut=true
    const { store: quotaStore, removedTokens: quotaRemoved } = installChromeMock({
      failStorageSetOnce: true,
      initialStore: {
        signedOut: false,
        userProfile: { email: 'alice@example.com', name: 'Alice', verifiedAt: Date.now() },
        settings: {
          folderName: 'Chrome_SaveShot_ScreenShots',
          folderId: 'alice-f1',
          folderWebViewLink: 'https://drive.google.com/drive/folders/alice-f1',
          folderCacheByEmail: {},
        },
        recentUploads: [{ id: 'f3', name: 'c.png', webViewLink: 'https://drive.google.com/file/d/f3/view' }],
      },
    });
    await signOut();
    assert.deepEqual(quotaRemoved, ['token-1']);
    assert.equal(quotaStore.signedOut, true, 'signedOut=true must persist even when first storage.local.set hits quota');
    assert.equal(quotaStore.userProfile, null);
    assert.equal(quotaStore.settings.folderId, null, 'Active folderId must also clear during quota fallback');
    assert.deepEqual(quotaStore.recentUploads, []);

    // 8. Normal logged-in 401 token expiry refreshes silently via removeCachedAuthToken WITHOUT calling clearAllCachedAuthTokens, /revoke, or signing out
    revokedTokens = [];
    const {
      store: refreshStore,
      removedTokens: refreshRemoved,
      wasClearedAll: refreshWasClearedAll,
    } = installChromeMock({
      initialStore: {
        signedOut: false,
        userProfile: { email: 'alice@example.com', name: 'Alice', verifiedAt: Date.now() },
      },
    });
    let attempt = 0;
    const uploadResult = await withAuthToken(async (tok) => {
      attempt += 1;
      if (attempt === 1) {
        const expired = new Error('Token expired');
        expired.status = 401;
        throw expired;
      }
      return `ok-${tok}`;
    });
    assert.equal(uploadResult, 'ok-token-2');
    assert.deepEqual(refreshRemoved, ['token-1']);
    assert.equal(revokedTokens.length, 0, 'Background 401 refresh must NOT call /revoke');
    assert.equal(refreshWasClearedAll(), false, 'Background 401 refresh must NOT call clearAllCachedAuthTokens');
    assert.equal(refreshStore.signedOut, false, 'Logged-in user must stay signed in across token rotation');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('REGION_SELECTED security gate blocks uninitiated/cross-tab/replayed drags, survives SW cold restart, and CAPTURE_VISIBLE reuses pngDataUrl without re-encoding', async () => {
  const origFetch = globalThis.fetch;
  const origCreateImageBitmap = globalThis.createImageBitmap;
  const origOffscreenCanvas = globalThis.OffscreenCanvas;
  try {
    globalThis.createImageBitmap = async () => ({
      width: 200,
      height: 120,
      close() {},
    });
    globalThis.OffscreenCanvas = class {
      constructor(w, h) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        return { drawImage() {}, imageSmoothingEnabled: true, imageSmoothingQuality: 'high' };
      }
      async convertToBlob() {
        return new Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' });
      }
    };

    const activeTabs = [
      { id: 101, windowId: 5, active: true, url: 'https://example.com/app', title: 'App', incognito: false },
      { id: 202, windowId: 5, active: true, url: 'https://evil.example/page', title: 'Evil', incognito: false },
    ];

    const mock = installChromeMock({
      initialStore: { signedOut: true, userProfile: null },
      tabs: activeTabs,
    });
    const { registerServiceWorkerListeners, resetInMemoryWorkerStateForTests } = await import(
      '../background/service-worker.js'
    );
    resetInMemoryWorkerStateForTests();
    registerServiceWorkerListeners();

    const tab101Sender = { url: activeTabs[0].url, tab: activeTabs[0] };
    const tab202Sender = { url: activeTabs[1].url, tab: activeTabs[1] };
    const sel = { x: 10, y: 10, width: 80, height: 60, viewportWidth: 200, viewportHeight: 120 };

    // 1. Uninitiated REGION_SELECTED from webpage content script is rejected with NO_ACTIVE_REGION_SESSION
    const forged = await mock.dispatchMessage(
      { type: 'REGION_SELECTED', selection: sel },
      tab202Sender
    );
    assert.equal(forged.ok, false);
    assert.equal(forged.code, 'NO_ACTIVE_REGION_SESSION');
    assert.equal(mock.createdTabs.length, 0, 'Forged REGION_SELECTED must not open an Editor tab');

    // 2. Start region capture on tab 101 -> cross-tab REGION_SELECTED from tab 202 is STILL blocked
    const start101 = await mock.dispatchMessage({ type: 'START_REGION_CAPTURE', tabId: 101 });
    assert.equal(start101.ok, true);

    const crossTab = await mock.dispatchMessage(
      { type: 'REGION_SELECTED', selection: sel },
      tab202Sender
    );
    assert.equal(crossTab.ok, false);
    assert.equal(crossTab.code, 'NO_ACTIVE_REGION_SESSION');

    // 3. Simulate MV3 SW 30s idle cold restart -> legitimate REGION_SELECTED from tab 101 still succeeds via chrome.storage.session
    resetInMemoryWorkerStateForTests();
    const legit = await mock.dispatchMessage(
      { type: 'REGION_SELECTED', selection: sel },
      tab101Sender
    );
    assert.equal(legit.ok, true);
    for (let i = 0; i < 30 && mock.createdTabs.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(mock.createdTabs.length, 1, 'Legitimate REGION_SELECTED must open local Editor tab');

    // 4. Replaying REGION_SELECTED a second time on tab 101 is blocked because token was consumed
    const replayed = await mock.dispatchMessage(
      { type: 'REGION_SELECTED', selection: sel },
      tab101Sender
    );
    assert.equal(replayed.ok, false);
    assert.equal(replayed.code, 'NO_ACTIVE_REGION_SESSION');

    // 5. CAPTURE_VISIBLE -> GET_EDITOR_SESSION returns exact captured dataUrl on first read and falls back cleanly on second read
    const capRes = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 101 });
    assert.equal(capRes.ok, true);
    assert.equal(capRes.openedEditor, true);

    const firstLoad = await mock.dispatchMessage({
      type: 'GET_EDITOR_SESSION',
      sessionId: capRes.sessionId,
    });
    assert.equal(firstLoad.ok, true);
    assert.equal(firstLoad.dataUrl, TINY_PNG_DATA_URL);

    const secondLoad = await mock.dispatchMessage({
      type: 'GET_EDITOR_SESSION',
      sessionId: capRes.sessionId,
    });
    assert.equal(secondLoad.ok, true);
    assert.equal(secondLoad.dataUrl, TINY_PNG_DATA_URL);
  } finally {
    globalThis.fetch = origFetch;
    globalThis.createImageBitmap = origCreateImageBitmap;
    globalThis.OffscreenCanvas = origOffscreenCanvas;
  }
});

test('contextMenus lifecycle: single top-level Take Screenshot item, concurrency safety, URL allowlist, click capture, TAB_ID_NONE fallback, and restricted page guard', async () => {
  const origFetch = globalThis.fetch;
  const origCreateImageBitmap = globalThis.createImageBitmap;
  const origOffscreenCanvas = globalThis.OffscreenCanvas;
  try {
    globalThis.createImageBitmap = async () => ({
      width: 200,
      height: 120,
      close() {},
    });
    globalThis.OffscreenCanvas = class {
      constructor(w, h) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        return { drawImage() {}, imageSmoothingEnabled: true, imageSmoothingQuality: 'high' };
      }
      async convertToBlob() {
        return new Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' });
      }
    };

    const webTab = {
      id: 301,
      windowId: 7,
      active: true,
      url: 'https://example.com/article',
      title: 'Article',
      incognito: false,
    };
    const restrictedTab = {
      id: 302,
      windowId: 7,
      active: false,
      url: 'chrome://settings',
      title: 'Settings',
      incognito: false,
    };

    const mock = installChromeMock({
      initialStore: { signedOut: true, userProfile: null },
      tabs: [webTab, restrictedTab],
    });
    const {
      CONTEXT_MENU_CAPTURE_ID,
      CONTEXT_MENU_CONTEXTS,
      CONTEXT_MENU_TITLE,
      CONTEXT_MENU_URL_PATTERNS,
      registerServiceWorkerListeners,
      resetInMemoryWorkerStateForTests,
      syncContextMenus,
    } = await import('../background/service-worker.js');
    resetInMemoryWorkerStateForTests();
    registerServiceWorkerListeners();

    // 1. onInstalled ('update' from 1.1.1 -> 1.2.1) registers exactly 1 top-level item (no submenu, no welcome tab)
    for (const fn of mock.listeners.onInstalled) {
      await fn({ reason: 'update', previousVersion: '1.1.1' });
    }
    assert.equal(mock.createdTabs.length, 0, 'Update must not open welcome.html');
    assert.equal(
      mock.contextMenuItems.length,
      1,
      'Must register exactly 1 context menu item so Chrome renders icon at top level with no submenu'
    );
    assert.equal(mock.contextMenuItems[0].id, CONTEXT_MENU_CAPTURE_ID);
    assert.equal(mock.contextMenuItems[0].title, CONTEXT_MENU_TITLE);
    assert.equal(mock.contextMenuItems[0].title, 'Take Screenshot');
    assert.equal(mock.contextMenuItems[0].parentId, undefined, 'Must have no parentId');
    assert.deepEqual(mock.contextMenuItems[0].documentUrlPatterns, [
      ...CONTEXT_MENU_URL_PATTERNS,
    ]);
    assert.ok(
      !mock.contextMenuItems[0].contexts.includes('action'),
      'Webpage context menu item should not clutter toolbar icon right-click menu'
    );
    assert.deepEqual(mock.contextMenuItems[0].contexts, [...CONTEXT_MENU_CONTEXTS]);

    // 2. Concurrent syncContextMenus + onStartup calls serialize cleanly with zero duplicate-id errors
    for (const fn of mock.listeners.onStartup) {
      fn();
    }
    const syncResults = await Promise.all([
      syncContextMenus(),
      syncContextMenus(),
      syncContextMenus(),
    ]);
    assert.deepEqual(syncResults, [true, true, true]);
    assert.equal(mock.contextMenuItems.length, 1);
    assert.equal(
      mock.getDuplicateMenuErrors(),
      0,
      'Serialized syncContextMenus must never trigger duplicate menu id errors'
    );

    // 3. Unknown menuItemId click is ignored completely
    for (const fn of mock.listeners.onContextMenuClicked) {
      await fn({ menuItemId: 'unrelated-item' }, webTab);
    }
    assert.equal(mock.sentTabMessages.length, 0);

    // 4. Right-click Take Screenshot on webTab (including TAB_ID_NONE fallback) mounts selector & authorizes REGION_SELECTED
    for (const fn of mock.listeners.onContextMenuClicked) {
      await fn({ menuItemId: CONTEXT_MENU_CAPTURE_ID }, { id: -1 });
    }
    assert.ok(
      mock.sentTabMessages.some(
        (m) => m.tabId === 301 && m.message?.type === 'START_REGION_SELECT'
      ),
      'Clicking Take Screenshot must mount START_REGION_SELECT on active tab'
    );

    const sel = { x: 12, y: 12, width: 90, height: 60, viewportWidth: 200, viewportHeight: 120 };
    const regionRes = await mock.dispatchMessage(
      { type: 'REGION_SELECTED', selection: sel },
      { url: webTab.url, tab: webTab }
    );
    assert.equal(regionRes.ok, true, 'Context-menu-initiated region drag must be authorized');
    for (let i = 0; i < 30 && mock.createdTabs.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(mock.createdTabs.length, 1, 'Signed-out context-menu capture must open local Editor');

    // 5. Clicking on an uncapturable internal page flashes '!' badge, sets lastErrorCode, and never authorizes REGION_SELECTED
    mock.badges.length = 0;
    for (const fn of mock.listeners.onContextMenuClicked) {
      await fn({ menuItemId: CONTEXT_MENU_CAPTURE_ID }, restrictedTab);
    }
    assert.ok(
      mock.badges.some((b) => b.text === '!'),
      'Restricted page context-menu attempt must flash ! badge'
    );
    const blockedDrag = await mock.dispatchMessage(
      { type: 'REGION_SELECTED', selection: sel },
      { url: restrictedTab.url, tab: restrictedTab }
    );
    assert.equal(blockedDrag.ok, false);
    assert.equal(blockedDrag.code, 'NO_ACTIVE_REGION_SESSION');

    // 6. Graceful false return if chrome.contextMenus is absent or throws
    globalThis.chrome.contextMenus = null;
    assert.equal(await syncContextMenus(), false);
  } finally {
    globalThis.fetch = origFetch;
    globalThis.createImageBitmap = origCreateImageBitmap;
    globalThis.OffscreenCanvas = origOffscreenCanvas;
  }
});

test('instant editor open + parallel background Drive upload: in-flight Save deduplication, MV3 SW restart recovery, failure Retry recovery, mid-upload signOut isolation, and Only upload when I click Save toggle', async () => {
  const origFetch = globalThis.fetch;
  try {
    const activeTab = {
      id: 505,
      windowId: 9,
      active: true,
      url: 'https://app.example.com/dashboard',
      title: 'Analytics Dashboard',
      incognito: false,
    };

    const mock = installChromeMock({
      initialStore: {
        signedOut: false,
        userProfile: {
          email: 'parallel@example.com',
          name: 'Parallel Tester',
          verifiedAt: Date.now(),
        },
        settings: {
          folderName: 'Chrome_SaveShot_ScreenShots',
          folderId: 'folder-par-1',
          folderWebViewLink: 'https://drive.google.com/drive/folders/folder-par-1',
          folderCacheByEmail: {
            'parallel@example.com': {
              folderName: 'Chrome_SaveShot_ScreenShots',
              folderId: 'folder-par-1',
              folderWebViewLink: 'https://drive.google.com/drive/folders/folder-par-1',
            },
          },
          autoCopyLink: true,
          editBeforeUpload: false,
          theme: 'auto',
        },
      },
      tabs: [activeTab],
    });

    const {
      registerServiceWorkerListeners,
      resetInMemoryWorkerStateForTests,
      waitForInflightUploadForTests,
    } = await import('../background/service-worker.js');
    resetInMemoryWorkerStateForTests();
    if (mock.listeners.onMessage.length === 0) {
      registerServiceWorkerListeners();
    }

    // Observe EDITOR_UPLOAD_STATUS broadcasts sent from the service worker
    const uploadBroadcasts = [];
    mock.listeners.onMessage.push((msg) => {
      if (msg?.type === 'EDITOR_UPLOAD_STATUS') {
        uploadBroadcasts.push(structuredClone(msg));
      }
    });

    const trustedSender = {
      url: 'chrome-extension://testext/pages/editor.html?session=live',
      tab: { id: 800, url: 'chrome-extension://testext/pages/editor.html?session=live' },
    };
    const untrustedSender = {
      url: 'https://evil.example/page',
      tab: { id: 505, url: 'https://evil.example/page' },
    };

    const driveRequests = [];
    let postCounter = 0;
    let deferredPostGate = null;
    let failNextPostMode = '';

    const createDeferred = () => {
      let resolve;
      const promise = new Promise((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };

    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.startsWith('data:image/')) return origFetch(url, opts);
      const method = opts.method || 'GET';
      driveRequests.push({ method, url: u });

      if (u.includes('/drive/v3/about')) {
        return new Response(
          JSON.stringify({
            user: { displayName: 'Parallel Tester', emailAddress: 'parallel@example.com' },
          }),
          { status: 200 }
        );
      }
      if (u.includes('/drive/v3/files/folder-par-1')) {
        return new Response(
          JSON.stringify({
            id: 'folder-par-1',
            name: 'Chrome_SaveShot_ScreenShots',
            trashed: false,
            webViewLink: 'https://drive.google.com/drive/folders/folder-par-1',
          }),
          { status: 200 }
        );
      }
      if (method === 'POST' && u.includes('/upload/drive/v3/files')) {
        if (deferredPostGate) {
          const gate = deferredPostGate;
          deferredPostGate = null;
          await gate.promise;
        }
        if (failNextPostMode === 'quota') {
          failNextPostMode = '';
          return new Response(
            JSON.stringify({
              error: {
                message: 'The user Drive storage quota has been exceeded.',
                errors: [{ reason: 'storageQuotaExceeded' }],
              },
            }),
            { status: 403 }
          );
        }
        postCounter += 1;
        const id = `bg_file_${postCounter}`;
        const bodyText = await opts.body.text();
        const m = bodyText.match(/"name":"([^"]+)"/);
        return new Response(
          JSON.stringify({
            id,
            name: m ? m[1] : `BgShot_${postCounter}.png`,
            webViewLink: `https://drive.google.com/file/d/${id}/view`,
            createdTime: '2026-11-25T10:00:00.000Z',
          }),
          { status: 200 }
        );
      }
      if (method === 'PATCH' && u.includes('/upload/drive/v3/files/')) {
        const id = u.split('/upload/drive/v3/files/')[1].split('?')[0];
        const bodyText = await opts.body.text();
        const m = bodyText.match(/"name":"([^"]+)"/);
        return new Response(
          JSON.stringify({
            id,
            name: m ? m[1] : 'Replaced.png',
            webViewLink: `https://drive.google.com/file/d/${id}/view`,
            modifiedTime: '2026-11-25T10:01:00.000Z',
          }),
          { status: 200 }
        );
      }
      if (method === 'PATCH' && u.includes('/drive/v3/files/')) {
        const id = u.split('/drive/v3/files/')[1].split('?')[0];
        const parsed = JSON.parse(opts.body);
        return new Response(
          JSON.stringify({
            id,
            name: parsed.name,
            webViewLink: `https://drive.google.com/file/d/${id}/view`,
            modifiedTime: '2026-11-25T10:02:00.000Z',
          }),
          { status: 200 }
        );
      }
      if (u.includes('oauth2.googleapis.com/revoke')) {
        return new Response('', { status: 200 });
      }
      throw new Error(`Unhandled fetch in parallel upload test: ${method} ${u}`);
    };

    // Security check: untrusted webpage sender cannot query GET_EDITOR_UPLOAD_STATUS
    const blockedStatus = await mock.dispatchMessage(
      { type: 'GET_EDITOR_UPLOAD_STATUS', sessionId: '12345678-1234-1234-1234-1234567890ab' },
      untrustedSender
    );
    assert.equal(blockedStatus.ok, false);
    assert.equal(blockedStatus.code, 'FORBIDDEN_SENDER');

    // 1. Instant Editor open while background upload is still in flight, then live EDITOR_UPLOAD_STATUS push on completion
    const gate1 = createDeferred();
    deferredPostGate = gate1;
    const cap1 = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 505 });
    assert.equal(cap1.ok, true);
    assert.equal(cap1.openedEditor, true, 'Editor must open immediately without waiting for Drive upload');
    assert.equal(cap1.uploadingInBackground, true);

    const session1Init = await mock.dispatchMessage(
      { type: 'GET_EDITOR_SESSION', sessionId: cap1.sessionId },
      trustedSender
    );
    assert.equal(session1Init.ok, true);
    assert.equal(session1Init.session.mode, 'new');
    assert.equal(session1Init.session.uploadState, 'uploading');
    assert.equal(session1Init.session.fileId, null);
    assert.equal(session1Init.dataUrl, TINY_PNG_DATA_URL);

    // Release Drive POST -> broadcasts uploaded status & transitions session to existing
    gate1.resolve();
    const bg1 = await waitForInflightUploadForTests(cap1.sessionId);
    assert.equal(bg1.ok, true);
    assert.equal(bg1.result.upload.id, 'bg_file_1');

    const broadcast1 = uploadBroadcasts.find((b) => b.sessionId === cap1.sessionId);
    assert.ok(broadcast1, 'Must broadcast EDITOR_UPLOAD_STATUS when background upload finishes');
    assert.equal(broadcast1.uploadState, 'uploaded');
    assert.equal(broadcast1.fileId, 'bg_file_1');
    assert.equal(broadcast1.webViewLink, 'https://drive.google.com/file/d/bg_file_1/view');

    const status1 = await mock.dispatchMessage(
      { type: 'GET_EDITOR_UPLOAD_STATUS', sessionId: cap1.sessionId },
      trustedSender
    );
    assert.equal(status1.ok, true);
    assert.equal(status1.mode, 'existing');
    assert.equal(status1.uploadState, 'uploaded');
    assert.equal(status1.fileId, 'bg_file_1');

    // 2. Race safety (pixel edit): clicking Save while initial background upload is in flight awaits upload then PATCHes exact fileId (0 duplicates)
    const gate2 = createDeferred();
    deferredPostGate = gate2;
    const postsBefore2 = driveRequests.filter((r) => r.method === 'POST' && r.url.includes('/upload/drive/v3/files')).length;
    const cap2 = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 505 });
    assert.equal(cap2.ok, true);
    assert.equal(cap2.uploadingInBackground, true);

    // Trigger Save while initial POST is still blocked on gate2
    const inflightSavePromise = mock.dispatchMessage(
      {
        type: 'SAVE_EDITED_SCREENSHOT',
        sessionId: cap2.sessionId,
        filename: 'Edited_InFlight.png',
        dataUrl: TINY_PNG_DATA_URL,
        imageModified: true,
        saveMode: 'replace',
      },
      trustedSender
    );
    await new Promise((r) => setTimeout(r, 25));
    const patchesBeforeRelease = driveRequests.filter((r) => r.method === 'PATCH').length;
    assert.equal(patchesBeforeRelease, 0, 'PATCH must wait until in-flight initial upload completes');

    gate2.resolve();
    const saveRes2 = await inflightSavePromise;
    assert.equal(saveRes2.ok, true);
    assert.equal(saveRes2.action, 'replaced', 'In-flight Save must PATCH the initial file instead of creating a duplicate');
    assert.equal(saveRes2.upload.id, 'bg_file_2');
    assert.equal(saveRes2.upload.name, 'Edited_InFlight.png');
    const postsAfter2 = driveRequests.filter((r) => r.method === 'POST' && r.url.includes('/upload/drive/v3/files')).length;
    assert.equal(postsAfter2 - postsBefore2, 1, 'Strictly 1 POST total (zero duplicate Drive files)');
    assert.match(
      driveRequests[driveRequests.length - 1].url,
      /\/upload\/drive\/v3\/files\/bg_file_2\?uploadType=multipart/
    );

    // 3. Race safety (rename-only): renaming while initial upload is in flight awaits upload then uses fast metadata-only PATCH
    const gate3 = createDeferred();
    deferredPostGate = gate3;
    const cap3 = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 505 });
    const inflightRenamePromise = mock.dispatchMessage(
      {
        type: 'SAVE_EDITED_SCREENSHOT',
        sessionId: cap3.sessionId,
        filename: 'Renamed_InFlight',
        dataUrl: TINY_PNG_DATA_URL,
        imageModified: false,
        saveMode: 'replace',
      },
      trustedSender
    );
    await new Promise((r) => setTimeout(r, 20));
    gate3.resolve();
    const renameRes3 = await inflightRenamePromise;
    assert.equal(renameRes3.ok, true);
    assert.equal(renameRes3.action, 'replaced');
    assert.equal(renameRes3.upload.id, 'bg_file_3');
    assert.equal(renameRes3.upload.name, 'Renamed_InFlight.png');
    const lastReq3 = driveRequests[driveRequests.length - 1];
    assert.equal(lastReq3.method, 'PATCH');
    assert.ok(
      lastReq3.url.includes('/drive/v3/files/bg_file_3') && !lastReq3.url.includes('/upload/'),
      'In-flight rename-only Save must use metadata-only PATCH'
    );

    // 4A. MV3 SW idle restart AFTER background upload finished: stale sessionContext still PATCHes persisted fileId (0 duplicates)
    resetInMemoryWorkerStateForTests();
    const postsBeforeSwRestart = driveRequests.filter((r) => r.method === 'POST' && r.url.includes('/upload/drive/v3/files')).length;
    const saveAfterSwRestart = await mock.dispatchMessage(
      {
        type: 'SAVE_EDITED_SCREENSHOT',
        sessionId: cap1.sessionId,
        filename: 'After_SW_Restart.png',
        dataUrl: TINY_PNG_DATA_URL,
        imageModified: true,
        saveMode: 'replace',
        sessionContext: { mode: 'new', fileId: null, filename: 'Stale.png' },
      },
      trustedSender
    );
    assert.equal(saveAfterSwRestart.ok, true);
    assert.equal(saveAfterSwRestart.action, 'replaced');
    assert.equal(saveAfterSwRestart.upload.id, 'bg_file_1');
    const postsAfterSwRestart = driveRequests.filter((r) => r.method === 'POST' && r.url.includes('/upload/drive/v3/files')).length;
    assert.equal(postsAfterSwRestart, postsBeforeSwRestart, 'Must not POST a duplicate after SW idle restart');

    // 4B. MV3 SW crash MID-UPLOAD (RAM wiped while uploadState === 'uploading'): reconciles to UPLOAD_INTERRUPTED and Retry succeeds cleanly
    const gate4 = createDeferred();
    deferredPostGate = gate4;
    const cap4 = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 505 });
    for (let i = 0; i < 20 && deferredPostGate === gate4; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(deferredPostGate, null, 'cap4 background upload must be in flight at POST before simulated SW crash');
    resetInMemoryWorkerStateForTests();
    const interruptedStatus = await mock.dispatchMessage(
      { type: 'GET_EDITOR_UPLOAD_STATUS', sessionId: cap4.sessionId },
      trustedSender
    );
    assert.equal(interruptedStatus.ok, true);
    assert.equal(interruptedStatus.uploadState, 'failed');
    assert.equal(interruptedStatus.uploadErrorCode, 'UPLOAD_INTERRUPTED');

    const retryInterrupted = await mock.dispatchMessage(
      {
        type: 'SAVE_EDITED_SCREENSHOT',
        sessionId: cap4.sessionId,
        filename: 'Recovered_After_Crash.png',
        dataUrl: TINY_PNG_DATA_URL,
        imageModified: true,
        saveMode: 'replace',
      },
      trustedSender
    );
    assert.equal(retryInterrupted.ok, true);
    assert.equal(retryInterrupted.action, 'created');
    assert.equal(retryInterrupted.upload.name, 'Recovered_After_Crash.png');
    gate4.resolve();
    await new Promise((r) => setTimeout(r, 20));

    // 5. Background upload failure (Drive quota full) keeps preUploadPng intact, broadcasts failed status, and Retry recovers cleanly
    failNextPostMode = 'quota';
    const cap5 = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 505 });
    assert.equal(cap5.ok, true);
    assert.equal(cap5.openedEditor, true);
    const bg5 = await waitForInflightUploadForTests(cap5.sessionId);
    assert.equal(bg5.ok, false);
    assert.equal(bg5.error.code, 'DRIVE_QUOTA_EXCEEDED');

    const failedBroadcast = uploadBroadcasts.find(
      (b) => b.sessionId === cap5.sessionId && b.uploadState === 'failed'
    );
    assert.ok(failedBroadcast, 'Must broadcast failed status pill info to Editor');
    assert.equal(failedBroadcast.uploadErrorCode, 'DRIVE_QUOTA_EXCEEDED');

    const sessionAfterQuotaFail = await globalThis.chrome.storage.session.get(`preUploadPng_${cap5.sessionId}`);
    assert.ok(
      sessionAfterQuotaFail[`preUploadPng_${cap5.sessionId}`]?.startsWith('data:image/png;base64,'),
      'Failed background upload must preserve preUploadPng in session storage for zero data loss'
    );

    const retryQuota = await mock.dispatchMessage(
      {
        type: 'SAVE_EDITED_SCREENSHOT',
        sessionId: cap5.sessionId,
        filename: 'Retried_After_Quota.png',
        dataUrl: TINY_PNG_DATA_URL,
        imageModified: true,
        saveMode: 'replace',
      },
      trustedSender
    );
    assert.equal(retryQuota.ok, true);
    assert.equal(retryQuota.action, 'created');
    assert.equal(retryQuota.upload.name, 'Retried_After_Quota.png');

    // 6. Option B Privacy Toggle ("Only upload when I click Save", storage key editBeforeUpload) prevents background upload
    const toggleRes = await mock.dispatchMessage(
      { type: 'UPDATE_SETTINGS', patch: { editBeforeUpload: true } },
      trustedSender
    );
    assert.equal(toggleRes.ok, true);
    assert.equal(toggleRes.settings.editBeforeUpload, true);

    const postsBeforeManual = driveRequests.filter((r) => r.method === 'POST' && r.url.includes('/upload/drive/v3/files')).length;
    const capManual = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 505 });
    assert.equal(capManual.ok, true);
    assert.equal(capManual.openedEditor, true);
    assert.equal(capManual.uploadingInBackground, false, 'Manual-save mode must not start background upload');

    const manualLoad = await mock.dispatchMessage(
      { type: 'GET_EDITOR_SESSION', sessionId: capManual.sessionId },
      trustedSender
    );
    assert.equal(manualLoad.ok, true);
    assert.equal(manualLoad.session.mode, 'new');
    assert.equal(manualLoad.session.uploadState, 'idle');
    assert.equal(
      driveRequests.filter((r) => r.method === 'POST' && r.url.includes('/upload/drive/v3/files')).length,
      postsBeforeManual,
      'Zero bytes may upload to Drive while Only upload when I click Save is enabled'
    );

    // 7. Prototype-key sessionId rejection (e.g. 'constructor')
    const protoSessionRes = await mock.dispatchMessage(
      { type: 'GET_EDITOR_SESSION', sessionId: 'constructor' },
      trustedSender
    );
    assert.equal(protoSessionRes.ok, false);
    assert.equal(protoSessionRes.code, 'EDITOR_SESSION_EXPIRED');

    const protoStatusRes = await mock.dispatchMessage(
      { type: 'GET_EDITOR_UPLOAD_STATUS', sessionId: 'constructor' },
      trustedSender
    );
    assert.equal(protoStatusRes.ok, false);
    assert.equal(protoStatusRes.code, 'EDITOR_SESSION_EXPIRED');

    // 8. Concurrent double SAVE_EDITED_SCREENSHOT on a 'new' session serializes via inflightSavesBySessionId (0 duplicates)
    const gateDoubleSave = createDeferred();
    deferredPostGate = gateDoubleSave;
    const postsBeforeDouble = driveRequests.filter(
      (r) => r.method === 'POST' && r.url.includes('/upload/drive/v3/files')
    ).length;
    const capDouble = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 505 });
    assert.equal(capDouble.uploadingInBackground, false);

    const firstDoubleSave = mock.dispatchMessage(
      {
        type: 'SAVE_EDITED_SCREENSHOT',
        sessionId: capDouble.sessionId,
        filename: 'Double_Click_One.png',
        dataUrl: TINY_PNG_DATA_URL,
        imageModified: true,
        saveMode: 'new',
      },
      trustedSender
    );
    const secondDoubleSave = mock.dispatchMessage(
      {
        type: 'SAVE_EDITED_SCREENSHOT',
        sessionId: capDouble.sessionId,
        filename: 'Double_Click_Two.png',
        dataUrl: TINY_PNG_DATA_URL,
        imageModified: true,
        saveMode: 'replace',
      },
      trustedSender
    );
    await new Promise((r) => setTimeout(r, 20));
    gateDoubleSave.resolve();
    const [doubleRes1, doubleRes2] = await Promise.all([firstDoubleSave, secondDoubleSave]);
    assert.equal(doubleRes1.ok, true);
    assert.equal(doubleRes1.action, 'created');
    assert.equal(doubleRes2.ok, true);
    assert.equal(doubleRes2.action, 'replaced', 'Second concurrent Save must PATCH the first created fileId');
    assert.equal(doubleRes2.upload.id, doubleRes1.upload.id);
    assert.equal(
      driveRequests.filter((r) => r.method === 'POST' && r.url.includes('/upload/drive/v3/files')).length -
        postsBeforeDouble,
      1,
      'Concurrent double Save must issue strictly 1 Drive POST'
    );

    // 9. Turn toggle back off to test mid-upload SIGN_OUT racing with both background upload AND an awaiting Save
    await mock.dispatchMessage(
      { type: 'UPDATE_SETTINGS', patch: { editBeforeUpload: false } },
      trustedSender
    );
    const gateSignOut = createDeferred();
    deferredPostGate = gateSignOut;
    const capSignOut = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 505 });
    assert.equal(capSignOut.uploadingInBackground, true);

    const saveDuringSignOutPromise = mock.dispatchMessage(
      {
        type: 'SAVE_EDITED_SCREENSHOT',
        sessionId: capSignOut.sessionId,
        filename: 'Should_Not_Resurrect.png',
        dataUrl: TINY_PNG_DATA_URL,
        imageModified: true,
        saveMode: 'replace',
        sessionContext: { mode: 'new', fileId: null, filename: 'Stale.png' },
      },
      trustedSender
    );
    await new Promise((r) => setTimeout(r, 20));
    await mock.dispatchMessage({ type: 'SIGN_OUT' }, trustedSender);
    gateSignOut.resolve();
    const saveDuringSignOutRes = await saveDuringSignOutPromise;
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(saveDuringSignOutRes.ok, false, 'Save interrupted by SIGN_OUT must fail cleanly');
    assert.equal(saveDuringSignOutRes.code, 'AUTH_REQUIRED');
    assert.equal(
      (await getRecentUploads()).length,
      0,
      'Abandoned mid-upload must not write to recentUploads after SIGN_OUT'
    );
    const sessionAfterSignOut = await globalThis.chrome.storage.session.get(null);
    assert.equal(
      Object.keys(sessionAfterSignOut).length,
      0,
      'Abandoned mid-upload must not resurrect chrome.storage.session keys after SIGN_OUT'
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('v1.3.0 storage autoCopyMode defaults/migration, planFullPageSlice math/caps, and editor-core pixelate/meme/crop/caption/paste', async () => {
  // 1. Storage autoCopyMode defaults to 'image' irrespective of Drive sign-in, with backward-compatible migration and prototype hardening
  installChromeMock();
  const freshSettings = await getSettings();
  assert.equal(freshSettings.autoCopyMode, 'image', 'Default autoCopyMode must be image');
  assert.equal(freshSettings.autoCopyLink, false, 'Default autoCopyLink must mirror autoCopyMode === link');

  assert.equal(normalizeAutoCopyMode('image'), 'image');
  assert.equal(normalizeAutoCopyMode('link'), 'link');
  assert.equal(normalizeAutoCopyMode('off'), 'off');
  assert.equal(normalizeAutoCopyMode('__proto__'), 'image');
  assert.equal(normalizeAutoCopyMode('constructor'), 'image');
  assert.equal(normalizeAutoCopyMode(null, 'off'), 'off');
  assert.equal(normalizeAutoCopyMode(undefined, 'link'), 'link');
  assert.equal(normalizeAutoCopyMode(undefined, undefined), 'image');

  // Legacy migration: persisted { autoCopyLink: false } without autoCopyMode migrates cleanly to 'off'
  await globalThis.chrome.storage.local.set({ settings: { autoCopyLink: false } });
  const migratedOff = await getSettings();
  assert.equal(migratedOff.autoCopyMode, 'off');
  assert.equal(migratedOff.autoCopyLink, false);

  // Updating autoCopyMode keeps autoCopyLink in sync and ignores prototype keys
  const linkUpdated = await updateSettings({ autoCopyMode: 'link' });
  assert.equal(linkUpdated.autoCopyMode, 'link');
  assert.equal(linkUpdated.autoCopyLink, true);
  const protoUpdated = await updateSettings({ autoCopyMode: 'toString' });
  assert.equal(protoUpdated.autoCopyMode, 'link', 'Invalid/prototype autoCopyMode must not overwrite existing valid mode');
  assert.equal(protoUpdated.autoCopyLink, true);

  // compactUploadRecord preserves 'fullpage' capture mode
  await addRecentUpload({
    id: 'fp_1',
    name: 'FullPage_Test.png',
    mode: 'fullpage',
    webViewLink: 'https://drive.google.com/file/d/fp_1/view',
    createdTime: new Date().toISOString(),
  });
  const recent = await getRecentUploads();
  assert.equal(recent[0].mode, 'fullpage');

  // 2. planFullPageSlice: multi-slice stitching, bottom overlap clamp, SPA inner container scaleY, lockedCanvasWidth pixel cap, MAX_PHYSICAL_HEIGHT cap, and NaN resilience
  const emptyPlan = planFullPageSlice();
  assert.equal(emptyPlan.sw, 1);
  assert.equal(emptyPlan.sh, 1);
  assert.equal(emptyPlan.skip, false);

  const slice0 = planFullPageSlice({
    bitmapWidth: 1000,
    bitmapHeight: 500,
    viewportWidth: 500,
    viewportHeight: 250,
    actualScrollY: 0,
    prevScrollY: 0,
    currentPhysicalHeight: 0,
    sliceIndex: 0,
  });
  assert.equal(slice0.sx, 0);
  assert.equal(slice0.sy, 0);
  assert.equal(slice0.sw, 1000);
  assert.equal(slice0.sh, 500);
  assert.equal(slice0.dy, 0);
  assert.equal(slice0.nextPhysicalHeight, 500);
  assert.equal(slice0.truncated, false);

  // Bottom-of-page overlap clamp: only 100 CSS px scrolled (delta = 100 -> 200 physical px at 2x scale)
  const sliceBottom = planFullPageSlice({
    bitmapWidth: 1000,
    bitmapHeight: 500,
    viewportWidth: 500,
    viewportHeight: 250,
    actualScrollY: 600,
    prevScrollY: 500,
    currentPhysicalHeight: 1500,
    sliceIndex: 3,
  });
  assert.equal(sliceBottom.sy, 300, 'Bottom overlap must crop from bottom of slice');
  assert.equal(sliceBottom.sh, 200);
  assert.equal(sliceBottom.dy, 1500);
  assert.equal(sliceBottom.nextPhysicalHeight, 1700);

  // Zero scroll advancement skips cleanly
  const noScroll = planFullPageSlice({
    bitmapWidth: 1000,
    bitmapHeight: 500,
    viewportWidth: 500,
    viewportHeight: 250,
    actualScrollY: 600,
    prevScrollY: 600,
    currentPhysicalHeight: 1700,
    sliceIndex: 4,
  });
  assert.equal(noScroll.skip, true);
  assert.equal(noScroll.sh, 0);

  // SPA inner scroll container: window viewport is 800x600 (1600x1200 @2x), inner scroller rect is { left: 200, top: 80, width: 600, height: 480 }
  const spaSlice0 = planFullPageSlice({
    bitmapWidth: 1600,
    bitmapHeight: 1200,
    viewportWidth: 800,
    viewportHeight: 600,
    actualScrollY: 0,
    prevScrollY: 0,
    currentPhysicalHeight: 0,
    sliceIndex: 0,
    containerRect: { left: 200, top: 80, width: 600, height: 480 },
  });
  assert.equal(spaSlice0.sx, 400);
  assert.equal(spaSlice0.sy, 160);
  assert.equal(spaSlice0.sw, 1200);
  assert.equal(spaSlice0.sh, 960);

  // Window narrowing mid-capture: lockedCanvasWidth enforces MAX_TOTAL_PIXELS against final stitched width
  const narrowCapped = planFullPageSlice({
    bitmapWidth: 2000,
    bitmapHeight: 4000,
    viewportWidth: 1000,
    viewportHeight: 2000,
    actualScrollY: 1000,
    prevScrollY: 0,
    currentPhysicalHeight: 9500,
    sliceIndex: 2,
    lockedCanvasWidth: 4000, // 40M / 4000 = 10000 max height -> remaining height = 500
  });
  assert.equal(narrowCapped.sh, 500, 'lockedCanvasWidth must enforce MAX_TOTAL_PIXELS even if window narrowed');
  assert.equal(narrowCapped.truncated, true);
  assert.equal(narrowCapped.nextPhysicalHeight, 10000);

  // MAX_PHYSICAL_HEIGHT cap
  const heightCapped = planFullPageSlice({
    bitmapWidth: 1000,
    bitmapHeight: 1000,
    viewportWidth: 1000,
    viewportHeight: 1000,
    actualScrollY: 15500,
    prevScrollY: 14500,
    currentPhysicalHeight: FULLPAGE_LIMITS.MAX_PHYSICAL_HEIGHT - 200,
    sliceIndex: 10,
  });
  assert.equal(heightCapped.sh, 200);
  assert.equal(heightCapped.truncated, true);
  assert.equal(heightCapped.nextPhysicalHeight, FULLPAGE_LIMITS.MAX_PHYSICAL_HEIGHT);

  // 3. editor-core: balanced-grid applyPixelateRect (zero 1x1 unredacted corner slivers!)
  assert.ok(EDITOR_TOOLS.includes('crop'));
  assert.equal(FONT_SIZES.xl, 44);
  assert.deepEqual(REDACT_MODES, ['solid', 'pixelate']);
  assert.deepEqual(TEXT_STYLES, ['clean', 'meme']);
  assert.deepEqual(CAPTION_THEMES, ['light', 'dark']);
  assert.ok(PIXELATE_BLOCK_SIZES.lg > PIXELATE_BLOCK_SIZES.sm);

  // Create a 33x33 pixel buffer where (32, 32) is a bright red secret pixel and all other pixels are white
  const W = 33;
  const H = 33;
  const buf = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    buf[i * 4] = 255;
    buf[i * 4 + 1] = 255;
    buf[i * 4 + 2] = 255;
    buf[i * 4 + 3] = 255;
  }
  const secretIdx = (32 * W + 32) * 4;
  buf[secretIdx] = 255;
  buf[secretIdx + 1] = 0;
  buf[secretIdx + 2] = 0;
  buf[secretIdx + 3] = 255;

  let writtenData = null;
  const mockPixelCtx = {
    getImageData: (x, y, w, h) => {
      const out = new Uint8ClampedArray(w * h * 4);
      for (let py = 0; py < h; py += 1) {
        for (let px = 0; px < w; px += 1) {
          const src = ((y + py) * W + (x + px)) * 4;
          const dst = (py * w + px) * 4;
          out[dst] = buf[src];
          out[dst + 1] = buf[src + 1];
          out[dst + 2] = buf[src + 2];
          out[dst + 3] = buf[src + 3];
        }
      }
      return { data: out, width: w, height: h };
    },
    putImageData: (imgData) => {
      writtenData = imgData.data;
    },
  };

  const didPixelate = applyPixelateRect(
    mockPixelCtx,
    { x: 0, y: 0, width: 33, height: 33 },
    { blockSize: 16 }
  );
  assert.equal(didPixelate, true);
  assert.ok(writtenData, 'applyPixelateRect must write averaged ImageData');
  // Because 33 / 16 rounds to 2 balanced blocks (widths 16 and 17), corner pixel (32,32) is averaged across a 17x17 block (289 pixels),
  // NOT isolated in a 1x1 sliver! Green/Blue channel at (32,32) must be ~254 (NOT 0!).
  assert.ok(
    writtenData[secretIdx + 1] >= 250 && writtenData[secretIdx + 2] >= 250,
    `Corner pixel (32,32) must be averaged with neighbors (got rgb=${writtenData[secretIdx]},${writtenData[secretIdx + 1]},${writtenData[secretIdx + 2]})`
  );

  // Separate sourceCtx (live preview path) reads from sourceCtx and writes to targetCtx
  let previewPutCalled = false;
  const previewTargetCtx = {
    putImageData: () => {
      previewPutCalled = true;
    },
  };
  assert.equal(
    applyPixelateRect(previewTargetCtx, { x: 0, y: 0, width: 33, height: 33 }, { blockSize: 12, sourceCtx: mockPixelCtx }),
    true
  );
  assert.equal(previewPutCalled, true);

  // 4. Meme text rendering uses Impact font, uppercase text, and both strokeText + fillText
  const textCalls = [];
  const mockTextCtx = {
    save() {},
    restore() {},
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    miterLimit: 0,
    textBaseline: '',
    strokeText(line, x, y) {
      textCalls.push({ op: 'strokeText', line, x, y, font: this.font, strokeStyle: this.strokeStyle });
    },
    fillText(line, x, y) {
      textCalls.push({ op: 'fillText', line, x, y, font: this.font, fillStyle: this.fillStyle });
    },
  };
  const drewMeme = renderAnnotation(
    mockTextCtx,
    { tool: 'text', textStyle: 'meme', text: 'ship it', x: 20, y: 30, color: '#ffffff', fontSize: 44 },
    800,
    600
  );
  assert.equal(drewMeme, true);
  assert.equal(textCalls.length, 2);
  assert.equal(textCalls[0].op, 'strokeText');
  assert.equal(textCalls[0].line, 'SHIP IT');
  assert.match(textCalls[0].font, /Impact/);
  assert.equal(textCalls[1].op, 'fillText');
  assert.equal(textCalls[1].line, 'SHIP IT');

  // 5. cropSourceToCanvas: valid crop + <4x4 rejection
  const cropDrawCalls = [];
  const targetCropCanvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      save() {},
      restore() {},
      setTransform() {},
      clearRect() {},
      drawImage(...args) {
        cropDrawCalls.push(args);
      },
    }),
  };
  const croppedDims = cropSourceToCanvas(
    { width: 400, height: 300 },
    { x: 50, y: 40, width: 200, height: 150 },
    targetCropCanvas
  );
  assert.deepEqual(croppedDims, {
    width: 200,
    height: 150,
    rect: { x: 50, y: 40, width: 200, height: 150 },
  });
  assert.equal(targetCropCanvas.width, 200);
  assert.equal(targetCropCanvas.height, 150);
  assert.equal(cropDrawCalls.length, 1);
  assert.throws(
    () => cropSourceToCanvas({ width: 400, height: 300 }, { x: 0, y: 0, width: 3, height: 3 }, targetCropCanvas),
    /too small/i
  );

  // 6. addCaptionBarToCanvas: long-token word-wrap, Dark/Light themes, empty rejection, MAX_CAPTION_CANVAS_HEIGHT guard
  const captionDrawnLines = [];
  const targetCaptionCanvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      save() {},
      restore() {},
      setTransform() {},
      clearRect() {},
      font: '',
      fillStyle: '',
      textAlign: '',
      textBaseline: '',
      measureText: (s) => ({ width: s.length * 14 }),
      fillRect() {},
      fillText(line) {
        captionDrawnLines.push(line);
      },
      drawImage() {},
    }),
  };
  const capRes = addCaptionBarToCanvas(
    { width: 320, height: 240 },
    { text: 'A'.repeat(40), theme: 'dark' },
    targetCaptionCanvas
  );
  assert.equal(capRes.width, 320);
  assert.ok(capRes.height > 240, 'Caption bar must expand canvas height');
  assert.ok(captionDrawnLines.length >= 2, 'Long unbroken token must wrap across multiple lines');
  assert.throws(
    () => addCaptionBarToCanvas({ width: 320, height: 240 }, { text: '   \n\t  ', theme: 'light' }, targetCaptionCanvas),
    /empty/i
  );
  assert.throws(
    () => addCaptionBarToCanvas({ width: 1000, height: 16180 }, { text: 'Too tall', theme: 'light' }, targetCaptionCanvas),
    /too tall/i
  );

  // 7. computePastedImageBox: scales large image <= 50% canvas while preserving aspect ratio; centers small sticker 1:1
  const bigBox = computePastedImageBox(1600, 800, 1000, 600);
  assert.ok(bigBox.width <= 500 && bigBox.height <= 300);
  assert.ok(Math.abs(bigBox.width / bigBox.height - 2) < 0.05);
  const smallBox = computePastedImageBox(120, 80, 1000, 600);
  assert.equal(smallBox.width, 120);
  assert.equal(smallBox.height, 80);
  assert.equal(smallBox.x, 440);
  assert.equal(smallBox.y, 260);
});

test('v1.3.0 Full-Page service-worker orchestration, background mode, Esc cancel, SIGN_OUT isolation, Incognito scrub, and security gates', async () => {
  const origFetch = globalThis.fetch;
  const origCreateImageBitmap = globalThis.createImageBitmap;
  const origOffscreenCanvas = globalThis.OffscreenCanvas;

  try {
    globalThis.createImageBitmap = async (src, sx, sy, sw, sh) => ({
      width: typeof sw === 'number' ? sw : 1000,
      height: typeof sh === 'number' ? sh : 500,
      close() {},
    });
    globalThis.OffscreenCanvas = class {
      constructor(w, h) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        return { drawImage() {} };
      }
      async convertToBlob() {
        return new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
      }
    };

    const trustedSender = { url: 'chrome-extension://testext/popup/popup.html' };
    const webpageSender = { tab: { id: 601, url: 'https://evil.example/page' }, url: 'https://evil.example/page' };

    let stepGate = null;
    let stepCalls = 0;
    let restoreCalls = 0;

    const mock = installChromeMock({
      tabs: [
        { id: 601, active: true, windowId: 1, url: 'https://docs.example.com/long-article', title: 'Long Article', incognito: false },
        { id: 602, active: true, windowId: 2, url: 'https://secret.example.com/private', title: 'Secret Private Title', incognito: true },
      ],
      initialStore: {
        settings: {
          folderName: 'Chrome_SaveShot_ScreenShots',
          autoCopyMode: 'image',
          autoCopyLink: false,
          editBeforeUpload: true,
        },
        userProfile: { name: 'Tester', email: 'tester@example.com' },
        signedOut: false,
      },
      onTabSendMessage: async (tabId, message) => {
        if (message.type === 'FULLPAGE_PREPARE') {
          return {
            ok: true,
            viewportWidth: 500,
            viewportHeight: 250,
            scrollStepHeight: 250,
            scrollTop: 0,
            maxScrollTop: 500,
            totalHeight: 750,
            containerRect: null,
          };
        }
        if (message.type === 'FULLPAGE_STEP') {
          stepCalls += 1;
          if (stepGate) {
            const gate = stepGate;
            stepGate = null;
            await gate.promise;
          }
          const y = Math.min(500, message.targetScrollTop || 0);
          return {
            ok: true,
            viewportWidth: 500,
            viewportHeight: 250,
            scrollStepHeight: 250,
            scrollTop: y,
            maxScrollTop: 500,
            totalHeight: 750,
            containerRect: null,
          };
        }
        if (message.type === 'FULLPAGE_RESTORE') {
          restoreCalls += 1;
          return { ok: true };
        }
        return { ok: true };
      },
    });

    const {
      registerServiceWorkerListeners,
      resetInMemoryWorkerStateForTests,
    } = await import('../background/service-worker.js');
    resetInMemoryWorkerStateForTests();
    if (mock.listeners.onMessage.length === 0) {
      registerServiceWorkerListeners();
    }

    const makeDeferred = () => {
      let resolve;
      const promise = new Promise((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };

    // 1. FORBIDDEN_SENDER: webpage tab cannot invoke CAPTURE_FULLPAGE
    const spoofedRes = await mock.dispatchMessage({ type: 'CAPTURE_FULLPAGE', tabId: 601 }, webpageSender);
    assert.equal(spoofedRes.ok, false);
    assert.equal(spoofedRes.code, 'FORBIDDEN_SENDER');

    // 2. background: true starts immediately after FULLPAGE_PREPARE, blocks concurrent duplicate on same tab,
    //    ignores cross-tab FULLPAGE_CANCEL, and stops cleanly on same-tab FULLPAGE_CANCEL with captureNotice
    const gateEsc = makeDeferred();
    stepGate = gateEsc;
    const bgStart = await mock.dispatchMessage(
      { type: 'CAPTURE_FULLPAGE', tabId: 601, background: true },
      trustedSender
    );
    assert.equal(bgStart.ok, true);
    assert.equal(bgStart.started, true, 'background: true must return started: true immediately so popup can close');

    // Wait deterministically until slice 0 is captured and the loop pauses on gateEsc inside FULLPAGE_STEP
    for (let i = 0; i < 60 && stepGate === gateEsc; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(stepGate, null, 'Background full-page loop must enter FULLPAGE_STEP after capturing slice 0');

    // Concurrent duplicate on same tab is blocked
    const dupRes = await mock.dispatchMessage(
      { type: 'CAPTURE_FULLPAGE', tabId: 601 },
      trustedSender
    );
    assert.equal(dupRes.ok, false);
    assert.equal(dupRes.code, 'FULLPAGE_IN_PROGRESS');

    // Cross-tab FULLPAGE_CANCEL from tab 602 must be rejected and NOT cancel tab 601's capture
    const wrongTabCancel = await mock.dispatchMessage(
      { type: 'FULLPAGE_CANCEL' },
      { tab: { id: 602 }, url: 'https://secret.example.com/private' }
    );
    assert.equal(wrongTabCancel.ok, false);

    // Same-tab FULLPAGE_CANCEL from tab 601 cancels cleanly
    const rightTabCancel = await mock.dispatchMessage(
      { type: 'FULLPAGE_CANCEL' },
      { tab: { id: 601 }, url: 'https://docs.example.com/long-article' }
    );
    assert.equal(rightTabCancel.ok, true);
    gateEsc.resolve();

    // Wait for background full-page capture to open editor tab
    let openedEditorTab = null;
    for (let i = 0; i < 60; i += 1) {
      openedEditorTab = mock.createdTabs.find((t) => t.url.includes('pages/editor.html?session='));
      if (openedEditorTab) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(openedEditorTab, 'Cancelled full-page capture with slices must still open editor');
    assert.ok(restoreCalls >= 1, 'FULLPAGE_RESTORE must be called in finally block');

    const sessionId1 = new URL(openedEditorTab.url).searchParams.get('session');
    const firstLoad = await mock.dispatchMessage(
      { type: 'GET_EDITOR_SESSION', sessionId: sessionId1 },
      trustedSender
    );
    assert.equal(firstLoad.ok, true);
    assert.equal(firstLoad.session.captureMode, 'fullpage');
    assert.equal(firstLoad.session.isFreshCapture, true, 'First editor load must see isFreshCapture: true');
    assert.match(firstLoad.session.captureNotice, /Stopped early/i);

    // Second GET_EDITOR_SESSION (simulating tab reload) consumes one-shot flags
    const reloadLoad = await mock.dispatchMessage(
      { type: 'GET_EDITOR_SESSION', sessionId: sessionId1 },
      trustedSender
    );
    assert.equal(reloadLoad.ok, true);
    assert.equal(reloadLoad.session.isFreshCapture, false, 'Tab reload must NOT re-trigger auto-copy');
    assert.equal(reloadLoad.session.captureNotice, '', 'Tab reload must NOT re-show one-shot captureNotice');

    // 3. Incognito full-page capture scrubs pageUrl and pageTitle from chrome.storage.session
    const tabsBeforeIncog = mock.createdTabs.length;
    const incogRes = await mock.dispatchMessage(
      { type: 'CAPTURE_FULLPAGE', tabId: 602 },
      trustedSender
    );
    assert.equal(incogRes.ok, true);
    assert.equal(incogRes.openedEditor, true);
    assert.equal(mock.createdTabs.length, tabsBeforeIncog + 1);

    const sessionDump = await globalThis.chrome.storage.session.get('editorSessionsById');
    const incogMeta = sessionDump.editorSessionsById?.[incogRes.sessionId];
    assert.ok(incogMeta, 'Incognito session metadata should exist');
    assert.equal(incogMeta.incognito, true);
    assert.equal(incogMeta.pageUrl, '', 'Incognito pageUrl must be scrubbed from chrome.storage.session');
    assert.equal(incogMeta.pageTitle, '', 'Incognito pageTitle must be scrubbed from chrome.storage.session');

    // 4. SIGN_OUT mid-full-page capture aborts cleanly with zero session resurrection, zero editor tab, and zero red '!' badge
    const gateSignOut = makeDeferred();
    stepGate = gateSignOut;
    const tabsBeforeSignOut = mock.createdTabs.length;
    const badgesBeforeSignOut = mock.badges.length;

    const signOutCapStart = await mock.dispatchMessage(
      { type: 'CAPTURE_FULLPAGE', tabId: 601, background: true },
      trustedSender
    );
    assert.equal(signOutCapStart.ok, true);
    assert.equal(signOutCapStart.started, true);

    for (let i = 0; i < 60 && stepGate === gateSignOut; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await mock.dispatchMessage({ type: 'SIGN_OUT' }, trustedSender);
    gateSignOut.resolve();
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(
      mock.createdTabs.length,
      tabsBeforeSignOut,
      'Full-page capture aborted by SIGN_OUT must not open an editor tab'
    );
    const errorBadgesAfterSignOut = mock.badges
      .slice(badgesBeforeSignOut)
      .filter((b) => b.text === '!');
    assert.equal(
      errorBadgesAfterSignOut.length,
      0,
      'SIGN_OUT mid-full-page must not show red ! error badge'
    );
    const sessionAfterSignOut = await globalThis.chrome.storage.session.get(null);
    assert.equal(
      Object.keys(sessionAfterSignOut).length,
      0,
      'SIGN_OUT mid-full-page must not resurrect chrome.storage.session keys'
    );
    assert.ok(stepCalls >= 2);
  } finally {
    globalThis.fetch = origFetch;
    globalThis.createImageBitmap = origCreateImageBitmap;
    globalThis.OffscreenCanvas = origOffscreenCanvas;
  }
});



