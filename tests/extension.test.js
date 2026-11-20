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
} from '../lib/capture.js';
import {
  buildMultipartUploadBody,
  ensureDriveFolder,
  escapeDriveQueryValue,
  uploadScreenshotToDrive,
} from '../lib/drive.js';
import {
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
  saveAccountFolderCache,
  setAuthState,
} from '../lib/storage.js';
import {
  buildFeedbackPayload,
  getEnvironmentSummary,
} from '../lib/feedback.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function installChromeMock({
  clientId = '1234567890-realclient.apps.googleusercontent.com',
  initialStore = {},
  onGetAuthToken = null,
  failStorageSetOnce = false,
} = {}) {
  const store = structuredClone(initialStore);
  const removedTokens = [];
  let clearedAll = false;
  let tokenCounter = 0;
  let shouldFailSetOnce = failStorageSetOnce;

  globalThis.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ oauth2: { client_id: clientId } }),
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
          if (shouldFailSetOnce) {
            shouldFailSetOnce = false;
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

  return { store, removedTokens, wasClearedAll: () => clearedAll };
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
