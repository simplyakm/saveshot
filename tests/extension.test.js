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
  isCapturableUrl,
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
  fetchGoogleUserInfo,
  getSilentAuthSession,
  isClientIdConfigured,
  PLACEHOLDER_CLIENT_ID,
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
  pruneStorage,
  sanitizeFolderName,
  saveAccountFolderCache,
  setAuthState,
  updateRecentUpload,
  updateSettings,
} from '../lib/storage.js';
import {
  buildFeedbackPayload,
  getEnvironmentSummary,
} from '../lib/feedback.js';
import {
  clampPoint,
  computeArrowGeometry,
  normalizeRect,
  renderAnnotation,
  sanitizeHexColor,
  transformSourceToCanvas,
} from '../lib/editor-core.js';

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
  const store = structuredClone(initialStore);
  const removedTokens = [];
  const createdTabs = [];
  const sentTabMessages = [];
  const badges = [];
  let executeScriptCalls = 0;
  let clearedAll = false;
  let tokenCounter = 0;
  let remainingSetFailures = failStorageSetCount || (failStorageSetOnce ? 1 : 0);

  const listeners = {
    onInstalled: [],
    onMessage: [],
    onCommand: [],
  };

  globalThis.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({
        version: '1.1.0',
        homepage_url: 'https://github.com/simplyakm/saveshot',
        oauth2: { client_id: clientId },
      }),
      getURL: (rel) => `chrome-extension://testext/${rel.replace(/^\/+/, '')}`,
      onInstalled: {
        addListener: (fn) => listeners.onInstalled.push(fn),
      },
      onMessage: {
        addListener: (fn) => listeners.onMessage.push(fn),
      },
    },
    commands: {
      onCommand: {
        addListener: (fn) => listeners.onCommand.push(fn),
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
      local: {
        get: async (keys) => {
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
          for (const [k, v] of Object.entries(patch)) {
            store[k] = structuredClone(v);
          }
        },
      },
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
  assert.equal(manifest.background.type, 'module');
  assert.ok(fs.existsSync(path.join(rootDir, manifest.background.service_worker)));
  assert.ok(fs.existsSync(path.join(rootDir, manifest.action.default_popup)));

  for (const iconRelPath of Object.values(manifest.icons)) {
    const iconPath = path.join(rootDir, iconRelPath);
    assert.ok(fs.existsSync(iconPath), `Missing icon: ${iconRelPath}`);
    assert.ok(fs.statSync(iconPath).size > 0, `Empty icon: ${iconRelPath}`);
  }

  assert.deepEqual(manifest.permissions.sort(), [
    'activeTab',
    'identity',
    'scripting',
    'storage',
  ]);
  assert.ok(manifest.oauth2.scopes.includes('https://www.googleapis.com/auth/drive.file'));
  assert.ok(manifest.commands['capture-visible']);
  assert.ok(manifest.commands['capture-region']);
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
  assert.deepEqual(revokedRemoved, ['token-1']);

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

test('feedback helper builds pre-filled GitHub bug and feature URLs without leaking private info', () => {
  const env = getEnvironmentSummary(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/156.0.0.0 Safari/537.36'
  );
  assert.equal(env.browser, 'Chrome 156.0.0.0');
  assert.equal(env.os, 'macOS');

  const bug = buildFeedbackPayload({
    kind: 'bug',
    title: 'Upload stuck on slow Wi-Fi',
    details: 'Happened once after waking laptop.',
    lastErrorCode: 'NETWORK_ERROR',
    includeDiagnostics: true,
    repoUrl: 'https://github.com/acme/saveshot',
    env,
  });

  assert.ok(bug.issueUrl.startsWith('https://github.com/acme/saveshot/issues/new?'));
  assert.ok(bug.issueUrl.includes('labels=bug'));
  assert.ok(bug.body.includes('Last error code: NETWORK_ERROR'));

  const featureNoDiag = buildFeedbackPayload({
    kind: 'feature',
    title: 'WebP upload option',
    details: 'Save Drive space.',
    includeDiagnostics: false,
    repoUrl: 'https://github.com/acme/saveshot',
    env,
  });
  assert.ok(featureNoDiag.issueUrl.includes('labels=enhancement'));
  assert.ok(!featureNoDiag.body.includes('Diagnostic info:'));
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

    const { registerServiceWorkerListeners } = await import('../background/service-worker.js');
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

    // 3. CAPTURE_VISIBLE retries throttled captureVisibleTab, uploads PNG, and records history
    const capRes = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 42 });
    assert.equal(capRes.ok, true);
    assert.equal(capRes.upload.id, 'uploaded-1');
    assert.equal(capRes.recentUploads.length, 1);
    assert.equal(captureAttempts, 2, 'Should auto-retry once after CAPTURE_THROTTLED');

    // 4. Incognito CAPTURE_VISIBLE uploads to Drive while skipping local history
    activeTabs[0].incognito = true;
    const incogRes = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 42 });
    assert.equal(incogRes.ok, true);
    assert.equal(incogRes.recentUploads.length, 1, 'Incognito capture must not add to local history');
    activeTabs[0].incognito = false;

    // 5. Upload failure stores fallback PNG in memory and GET_FALLBACK_PNG retrieves it
    driveShouldFailQuota = true;
    const failRes = await mock.dispatchMessage({ type: 'CAPTURE_VISIBLE', tabId: 42 });
    assert.equal(failRes.ok, false);
    assert.equal(failRes.code, 'DRIVE_QUOTA_EXCEEDED');
    assert.equal(failRes.hasFallback, true);

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

    // 10. SIGN_OUT wipes all editor sessions and cached captures from memory immediately
    await mock.dispatchMessage({ type: 'SIGN_OUT' }, trustedEditorSender);
    const afterSignOutSession = await mock.dispatchMessage(
      { type: 'GET_EDITOR_SESSION', sessionId: olderOpen.sessionId },
      trustedEditorSender
    );
    assert.equal(afterSignOutSession.ok, false);
    assert.equal(afterSignOutSession.code, 'EDITOR_SESSION_EXPIRED');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('all repository source, UI, and documentation files contain no em dashes or en dashes', () => {
  const textExts = new Set(['.js', '.json', '.html', '.css', '.md', '.yml']);
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
});
