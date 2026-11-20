import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    };

    ws.onopen = () =>
      resolve({
        send(method, params = {}, sessionId) {
          return new Promise((res, rej) => {
            const msgId = ++id;
            const timer = setTimeout(() => {
              pending.delete(msgId);
              rej(new Error(`CDP timeout on ${method}`));
            }, 10000);
            pending.set(msgId, {
              res: (v) => {
                clearTimeout(timer);
                res(v);
              },
              rej: (e) => {
                clearTimeout(timer);
                rej(e);
              },
            });
            ws.send(
              JSON.stringify({
                id: msgId,
                method,
                params,
                ...(sessionId ? { sessionId } : {}),
              })
            );
          });
        },
        close: () => {
          for (const [, p] of pending) p.rej(new Error('CDP closed'));
          pending.clear();
          ws.close();
        },
      });

    ws.onerror = reject;
  });
}

async function launchChromiumWithExtension(initialUrl) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saveshot-chr-'));
  const tmpExtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saveshot-ext-'));
  fs.cpSync(rootDir, tmpExtDir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}tests`),
  });

  // Grant <all_urls> ONLY in this automated CDP harness so headless scripts can invoke
  // captureVisibleTab without OS-level physical toolbar clicks (production manifest keeps strict activeTab).
  const mfPath = path.join(tmpExtDir, 'manifest.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  mf.host_permissions.push('<all_urls>');
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));

  const proc = spawn(
    'chromium',
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--window-size=1000,800',
      `--user-data-dir=${userDataDir}`,
      `--disable-extensions-except=${tmpExtDir}`,
      `--load-extension=${tmpExtDir}`,
      '--remote-debugging-port=0',
      initialUrl,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for Chromium CDP')),
      10000
    );
    proc.stderr.on('data', (chunk) => {
      const m = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });

  const cdp = await connectCdp(wsUrl);
  return {
    cdp,
    cleanup: () => {
      try {
        cdp.close();
      } catch {}
      proc.kill('SIGKILL');
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(tmpExtDir, { recursive: true, force: true });
    },
  };
}

test('E2E Chromium battle-test: zoom (50%-300%), pinch-zoom, hostile DOM/CSS/modal <dialog>, strict CSP, SVG fallback, and popup boot', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/hostile') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html>
        <html style="transform: translateY(50px); filter: contrast(1.01); zoom: 1.4;">
        <body style="margin:0; height:2400px; background:#f8fafc;">
          <button id="underlying-btn" style="position:fixed; left:80px; top:80px; width:300px; height:300px;" onclick="window.__btnClicked = true">Danger Button</button>
          <dialog id="page-modal" style="width:260px; height:160px;">Open Page Modal</dialog>
          <script>
            window.__btnClicked = false;
            window.__pageSawEscape = false;
            document.getElementById('page-modal').showModal();
            window.addEventListener('keydown', (e) => {
              if (e.key === 'Escape') window.__pageSawEscape = true;
            });
          </script>
        </body>
        </html>`);
      return;
    }

    if (req.url === '/strict-csp') {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Security-Policy':
          "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'none'",
      });
      res.end('<!doctype html><html><body><h1>Bank Grade CSP</h1></body></html>');
      return;
    }

    if (req.url === '/diagram.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#10b981"/></svg>'
      );
      return;
    }

    // Calibration target: pure red 140x100 box surrounded by pure white background + vertical scrollbar
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html>
      <html>
      <head>
        <style>
          html, body { margin: 0; padding: 0; background: rgb(255, 255, 255); height: 3000px; }
          #red-box {
            position: fixed;
            left: 120px;
            top: 90px;
            width: 140px;
            height: 100px;
            background: rgb(255, 0, 0);
          }
        </style>
      </head>
      <body><div id="red-box"></div></body>
      </html>`);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  let cleanup = () => {};
  try {
    const launched = await launchChromiumWithExtension(`${baseUrl}/`);
    const { cdp } = launched;
    cleanup = launched.cleanup;

    // Wait for MV3 service worker target and test page target
    let swTarget = null;
    let pageTarget = null;
    for (let i = 0; i < 25; i += 1) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      swTarget = targetInfos.find((t) => t.type === 'service_worker');
      pageTarget = targetInfos.find(
        (t) => t.type === 'page' && t.url.startsWith(baseUrl)
      );
      if (swTarget && pageTarget) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(swTarget, 'MV3 Service Worker must boot cleanly');
    assert.ok(pageTarget, 'Test webpage target must exist');

    const extId = new URL(swTarget.url).hostname;
    const { sessionId: swSession } = await cdp.send('Target.attachToTarget', {
      targetId: swTarget.targetId,
      flatten: true,
    });
    const { sessionId: pageSession } = await cdp.send('Target.attachToTarget', {
      targetId: pageTarget.targetId,
      flatten: true,
    });

    // Open extension popup page in a background tab so pageTarget remains the active visible tab
    const { targetId: popupTargetId } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extId}/popup/popup.html`,
      background: true,
    });
    const { sessionId: extPageSession } = await cdp.send(
      'Target.attachToTarget',
      {
        targetId: popupTargetId,
        flatten: true,
      }
    );
    await new Promise((r) => setTimeout(r, 350));

    const evalIn = async (sessionId, expression) => {
      const r = await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId
      );
      if (r.exceptionDetails) {
        throw new Error(`Eval failed: ${JSON.stringify(r.exceptionDetails)}`);
      }
      return r.result.value;
    };

    // Verify Popup UI Boot & OAuth Setup Banner state
    const prodManifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
    const expectedNeedsSetup = prodManifest.oauth2.client_id.includes('YOUR_CHROME_OAUTH');
    const popupCheck = await evalIn(
      extPageSession,
      `(() => ({
        signedOutVisible: !document.getElementById('signed-out-view').hidden,
        setupBannerVisible: !document.getElementById('setup-banner').hidden,
        hasHelpBtn: Boolean(document.getElementById('help-btn')),
        hasOpenDriveBtn: Boolean(document.getElementById('open-drive-btn')),
        hasBugFooterBtn: Boolean(document.getElementById('footer-bug-btn')),
      }))()`
    );
    assert.equal(popupCheck.signedOutVisible, true);
    assert.equal(popupCheck.setupBannerVisible, expectedNeedsSetup);
    assert.equal(popupCheck.hasHelpBtn, true);
    assert.equal(popupCheck.hasOpenDriveBtn, true);
    assert.equal(popupCheck.hasBugFooterBtn, true);

    // Verify Welcome / Help page opened automatically on extension install and renders feedback form
    const { targetInfos: postInstallTargets } = await cdp.send('Target.getTargets');
    const welcomeTarget = postInstallTargets.find(
      (t) => t.type === 'page' && t.url.endsWith('/pages/welcome.html')
    );
    assert.ok(welcomeTarget, 'pages/welcome.html must open automatically on install');
    const { sessionId: welcomeSession } = await cdp.send('Target.attachToTarget', {
      targetId: welcomeTarget.targetId,
      flatten: true,
    });
    await new Promise((r) => setTimeout(r, 250));
    const welcomeCheck = await evalIn(
      welcomeSession,
      `(() => ({
        title: document.querySelector('h1')?.textContent,
        hasFeedbackSection: Boolean(document.getElementById('feedback')),
        diagText: document.getElementById('diag-preview')?.textContent || '',
      }))()`
    );
    assert.equal(welcomeCheck.title, 'SaveShot');
    assert.equal(welcomeCheck.hasFeedbackSection, true);
    assert.match(welcomeCheck.diagText, /SaveShot version:/);

    // Get test tabId & windowId so we always capture the active calibration tab
    const testTabInfo = await evalIn(
      swSession,
      `(async () => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find((tab) => tab.url && tab.url.startsWith(${JSON.stringify(baseUrl)}));
        await chrome.tabs.update(t.id, { active: true });
        return { tabId: t.id, windowId: t.windowId };
      })()`
    );

    // -------------------------------------------------------------------------
    // 1. Real OffscreenCanvas Crop Accuracy across Browser Zooms & Pinch-Zoom
    // -------------------------------------------------------------------------
    for (const zoom of [0.5, 0.67, 1.0, 1.5, 2.0, 3.0]) {
      await evalIn(
        swSession,
        `chrome.tabs.setZoom(${testTabInfo.tabId}, ${zoom})`
      );
      await new Promise((r) => setTimeout(r, 560));

      const selection = await evalIn(
        pageSession,
        `(() => {
          const r = document.getElementById('red-box').getBoundingClientRect();
          const vv = window.visualViewport;
          return {
            x: r.x + 4,
            y: r.y + 4,
            width: r.width - 8,
            height: r.height - 8,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio,
            visualViewportOffsetLeft: vv.offsetLeft,
            visualViewportOffsetTop: vv.offsetTop,
            visualViewportScale: vv.scale,
          };
        })()`
      );

      const cropCheck = await evalIn(
        extPageSession,
        `(async () => {
          const { cropPngDataUrl } = await import('../lib/capture.js');
          const dataUrl = await chrome.tabs.captureVisibleTab(${testTabInfo.windowId}, { format: 'png' });
          const cropped = await cropPngDataUrl(dataUrl, ${JSON.stringify(selection)});
          const bmp = await createImageBitmap(cropped);
          const canvas = new OffscreenCanvas(bmp.width, bmp.height);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(bmp, 0, 0);
          const { data, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height);
          bmp.close();
          let nonRedPixels = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] < 240 || data[i + 1] > 15 || data[i + 2] > 15) nonRedPixels++;
          }
          return { width, height, nonRedPixels };
        })()`
      );

      assert.equal(
        cropCheck.nonRedPixels,
        0,
        `Zoom ${zoom}x crop must contain 0 non-red background pixels (got ${cropCheck.nonRedPixels})`
      );
      assert.ok(
        Math.abs(cropCheck.width - Math.round(132 * zoom)) <= 1,
        `Expected width ~${Math.round(132 * zoom)}, got ${cropCheck.width}`
      );
      assert.ok(
        Math.abs(cropCheck.height - Math.round(92 * zoom)) <= 1,
        `Expected height ~${Math.round(92 * zoom)}, got ${cropCheck.height}`
      );
    }

    // Pinch-zoom 2.0x with pan offset via synthesizePinchGesture
    await evalIn(swSession, `chrome.tabs.setZoom(${testTabInfo.tabId}, 1.0)`);
    await cdp
      .send(
        'Input.synthesizePinchGesture',
        { x: 200, y: 150, scaleFactor: 2.0 },
        pageSession
      )
      .catch(() =>
        cdp.send(
          'Emulation.setPageScaleFactor',
          { pageScaleFactor: 2.0 },
          pageSession
        )
      );
    await new Promise((r) => setTimeout(r, 560));

    const pinchSelection = await evalIn(
      pageSession,
      `(() => {
        const r = document.getElementById('red-box').getBoundingClientRect();
        const vv = window.visualViewport;
        return {
          x: r.x + 4,
          y: r.y + 4,
          width: r.width - 8,
          height: r.height - 8,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
          visualViewportOffsetLeft: vv.offsetLeft,
          visualViewportOffsetTop: vv.offsetTop,
          visualViewportScale: vv.scale,
        };
      })()`
    );

    const pinchCrop = await evalIn(
      extPageSession,
      `(async () => {
        const { cropPngDataUrl } = await import('../lib/capture.js');
        const dataUrl = await chrome.tabs.captureVisibleTab(${testTabInfo.windowId}, { format: 'png' });
        const cropped = await cropPngDataUrl(dataUrl, ${JSON.stringify(pinchSelection)});
        const bmp = await createImageBitmap(cropped);
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        const { data, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height);
        bmp.close();
        let nonRedPixels = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] < 240 || data[i + 1] > 15 || data[i + 2] > 15) nonRedPixels++;
        }
        return { width, height, nonRedPixels };
      })()`
    );
    assert.equal(
      pinchCrop.nonRedPixels,
      0,
      'Pinch-zoom 2.0x crop must be 100% on target'
    );
    assert.equal(pinchCrop.width, 264);
    assert.equal(pinchCrop.height, 184);

    // -------------------------------------------------------------------------
    // 2. Hostile Webpage Battle-Test (CSS transform + filter + zoom + open modal <dialog> + Escape hijack + click-through)
    // -------------------------------------------------------------------------
    await cdp.send('Page.navigate', { url: `${baseUrl}/hostile` }, pageSession);
    await new Promise((r) => setTimeout(r, 400));

    const startHostile = await evalIn(
      swSession,
      `(async () => {
        await chrome.scripting.executeScript({ target: { tabId: ${testTabInfo.tabId} }, files: ['content/selector.js'] });
        return await chrome.tabs.sendMessage(${testTabInfo.tabId}, { type: 'START_REGION_SELECT' });
      })()`
    );
    assert.equal(startHostile.ok, true);

    const hostileGeometry = await evalIn(
      pageSession,
      `(() => {
        const host = document.getElementById('__saveshot-overlay-host');
        const r = host.getBoundingClientRect();
        return {
          tag: host.tagName,
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          innerW: window.innerWidth,
          innerH: window.innerHeight,
        };
      })()`
    );
    assert.equal(
      hostileGeometry.tag,
      'DIALOG',
      'Should promote to modal <dialog> over page modal'
    );
    assert.equal(hostileGeometry.x, 0, 'Must neutralize ancestor transform');
    assert.equal(
      hostileGeometry.y,
      0,
      'Must neutralize ancestor translateY(50px)'
    );
    assert.equal(
      hostileGeometry.w,
      hostileGeometry.innerW,
      'Must neutralize ancestor CSS zoom: 1.4'
    );

    // Press Escape -> cancels SaveShot overlay WITHOUT closing page's modal or firing page's Escape handler
    await cdp.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      },
      pageSession
    );
    await cdp.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyUp',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      },
      pageSession
    );

    const afterEsc = await evalIn(
      pageSession,
      `(() => ({
        overlayPresent: Boolean(document.getElementById('__saveshot-overlay-host')),
        pageModalStillOpen: document.getElementById('page-modal').open,
        pageSawEscape: window.__pageSawEscape,
      }))()`
    );
    assert.equal(
      afterEsc.overlayPresent,
      false,
      'Escape must dismiss SaveShot overlay'
    );
    assert.equal(
      afterEsc.pageModalStillOpen,
      true,
      'Page modal <dialog> must remain open'
    );
    assert.equal(
      afterEsc.pageSawEscape,
      false,
      'Page Escape listener must not fire'
    );

    // Re-open overlay and drag directly across #underlying-btn -> verify button is NOT clicked!
    await evalIn(
      swSession,
      `chrome.tabs.sendMessage(${testTabInfo.tabId}, { type: 'START_REGION_SELECT' })`
    );
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: 110, y: 110, button: 'left', clickCount: 1 },
      pageSession
    );
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: 220, y: 220, button: 'left' },
      pageSession
    );
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: 220, y: 220, button: 'left', clickCount: 1 },
      pageSession
    );
    await new Promise((r) => setTimeout(r, 120));

    const btnClicked = await evalIn(pageSession, `window.__btnClicked`);
    assert.equal(
      btnClicked,
      false,
      'Releasing drag must never click underlying page buttons'
    );

    // -------------------------------------------------------------------------
    // 3. Strict Bank-Grade CSP + Zero-Data-Loss Local Save Fallback Toast
    // -------------------------------------------------------------------------
    await cdp.send(
      'Page.navigate',
      { url: `${baseUrl}/strict-csp` },
      pageSession
    );
    await new Promise((r) => setTimeout(r, 350));

    await evalIn(
      swSession,
      `(async () => {
        await chrome.scripting.executeScript({ target: { tabId: ${testTabInfo.tabId} }, files: ['content/selector.js'] });
        await chrome.tabs.sendMessage(${testTabInfo.tabId}, {
          type: 'SHOW_TOAST',
          payload: {
            status: 'error',
            title: 'Screenshot upload failed',
            message: 'Your Google Drive storage is full.',
            fallbackDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            fallbackFilename: 'Screenshot_fallback.png',
          },
        });
      })()`
    );

    const cspToast = await evalIn(
      pageSession,
      `(() => {
        const host = document.getElementById('__saveshot-toast-host');
        const link = host?.shadowRoot?.querySelector('a.btn-primary');
        return {
          mounted: Boolean(host),
          downloadAttr: link?.getAttribute('download'),
          buttonText: link?.textContent,
        };
      })()`
    );
    assert.equal(cspToast.mounted, true);
    assert.equal(cspToast.downloadAttr, 'Screenshot_fallback.png');
    assert.equal(cspToast.buttonText, 'Save PNG locally');

    // Verify HIDE_UI_FOR_CAPTURE strips lingering toast before back-to-back captures
    const hideFirst = await evalIn(
      swSession,
      `chrome.tabs.sendMessage(${testTabInfo.tabId}, { type: 'HIDE_UI_FOR_CAPTURE' })`
    );
    assert.equal(hideFirst.ok, true);
    assert.equal(hideFirst.removed, true);
    const toastStillMounted = await evalIn(
      pageSession,
      `Boolean(document.getElementById('__saveshot-toast-host'))`
    );
    assert.equal(toastStillMounted, false);

    const hideSecond = await evalIn(
      swSession,
      `chrome.tabs.sendMessage(${testTabInfo.tabId}, { type: 'HIDE_UI_FOR_CAPTURE' })`
    );
    assert.equal(hideSecond.removed, false);

    // -------------------------------------------------------------------------
    // 4. Standalone SVG Document Graceful Fallback
    // -------------------------------------------------------------------------
    await cdp.send(
      'Page.navigate',
      { url: `${baseUrl}/diagram.svg` },
      pageSession
    );
    await new Promise((r) => setTimeout(r, 350));

    const svgRegion = await evalIn(
      swSession,
      `(async () => {
        await chrome.scripting.executeScript({ target: { tabId: ${testTabInfo.tabId} }, files: ['content/selector.js'] });
        return await chrome.tabs.sendMessage(${testTabInfo.tabId}, { type: 'START_REGION_SELECT' });
      })()`
    );
    assert.equal(svgRegion.ok, false);
    assert.equal(svgRegion.code, 'UNSUPPORTED_DOM');
    assert.match(svgRegion.reason, /Visible Tab/);

    // -------------------------------------------------------------------------
    // 5. Real Chromium Editor E2E: Destructive Redaction, Rotate/Flip/Undo,
    //    XSS Immunity, Replace Warning Modal, and Real Content-Script Privilege Guard
    // -------------------------------------------------------------------------
    await evalIn(
      swSession,
      `(async () => {
        globalThis.__e2eDriveCalls = [];

        // Build a 160x100 PNG with a bright green (0,255,0) secret block at (20..70, 20..55) on white background
        const c = new OffscreenCanvas(160, 100);
        const ctx = c.getContext('2d');
        ctx.fillStyle = 'rgb(255, 255, 255)';
        ctx.fillRect(0, 0, 160, 100);
        ctx.fillStyle = 'rgb(0, 255, 0)';
        ctx.fillRect(20, 20, 50, 35);
        const secretBlob = await c.convertToBlob({ type: 'image/png' });
        const secretBytes = await secretBlob.arrayBuffer();

        await chrome.storage.local.set({
          signedOut: false,
          userProfile: { email: 'e2e@example.com', name: 'E2E User', verifiedAt: Date.now() },
          settings: {
            folderName: 'Chrome_SaveShot_ScreenShots',
            folderId: 'folder_e2e_1',
            folderWebViewLink: 'https://drive.google.com/drive/folders/folder_e2e_1',
            folderCacheByEmail: {
              'e2e@example.com': {
                folderName: 'Chrome_SaveShot_ScreenShots',
                folderId: 'folder_e2e_1',
                folderWebViewLink: 'https://drive.google.com/drive/folders/folder_e2e_1',
              },
            },
            autoCopyLink: false,
            editBeforeUpload: false,
          },
          recentUploads: [
            {
              id: 'e2e_shot_01',
              name: 'Original_Secret.png',
              webViewLink: 'https://drive.google.com/file/d/e2e_shot_01/view',
              createdTime: new Date().toISOString(),
              pageTitle: 'Secret Dashboard',
              mode: 'visible',
              thumbnailDataUrl: '',
            },
          ],
        });

        chrome.identity.getAuthToken = (_opts, cb) => cb('e2e-mock-token');

        const realFetch = globalThis.fetch.bind(globalThis);
        globalThis.fetch = async (url, opts = {}) => {
          const u = String(url);
          if (u.startsWith('data:image/')) return realFetch(url, opts);

          const method = opts.method || 'GET';
          globalThis.__e2eDriveCalls.push({ url: u, method });

          if (u.includes('?alt=media')) {
            return new Response(secretBytes.slice(0), {
              status: 200,
              headers: { 'Content-Type': 'image/png' },
            });
          }
          if (method === 'PATCH' && u.includes('/upload/drive/v3/files/e2e_shot_01')) {
            const bodyText = await opts.body.text();
            const m = bodyText.match(/"name":"([^"]+)"/);
            return new Response(
              JSON.stringify({
                id: 'e2e_shot_01',
                name: m ? m[1] : 'Updated.png',
                webViewLink: 'https://drive.google.com/file/d/e2e_shot_01/view',
                modifiedTime: new Date().toISOString(),
              }),
              { status: 200 }
            );
          }
          if (method === 'PATCH' && u.includes('/drive/v3/files/e2e_shot_01')) {
            const parsed = JSON.parse(opts.body);
            return new Response(
              JSON.stringify({
                id: 'e2e_shot_01',
                name: parsed.name,
                webViewLink: 'https://drive.google.com/file/d/e2e_shot_01/view',
                modifiedTime: new Date().toISOString(),
              }),
              { status: 200 }
            );
          }
          return new Response(JSON.stringify({ id: 'folder_e2e_1', name: 'Chrome_SaveShot_ScreenShots' }), {
            status: 200,
          });
        };
      })()`
    );

    // Open editor from trusted extension context
    const openEditorRes = await evalIn(
      extPageSession,
      `new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            type: 'OPEN_EDITOR',
            fileId: 'e2e_shot_01',
            filename: 'Original_Secret.png',
            webViewLink: 'https://drive.google.com/file/d/e2e_shot_01/view',
          },
          resolve
        );
      })`
    );
    assert.equal(openEditorRes.ok, true);

    let editorTarget = null;
    for (let i = 0; i < 20; i += 1) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      editorTarget = targetInfos.find(
        (t) => t.type === 'page' && t.url.includes('/pages/editor.html?session=')
      );
      if (editorTarget) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    assert.ok(editorTarget, 'pages/editor.html tab must open');

    const { sessionId: editorSession } = await cdp.send('Target.attachToTarget', {
      targetId: editorTarget.targetId,
      flatten: true,
    });

    // Wait for editor canvas to finish loading the 160x100 PNG from Drive media endpoint
    for (let i = 0; i < 25; i += 1) {
      const ready = await evalIn(
        editorSession,
        `(() => {
          const c = document.getElementById('base-canvas');
          return !document.getElementById('canvas-wrap').hidden && c.width === 160 && c.height === 100;
        })()`
      );
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // 5A. Select Redact tool and drag across the green secret region (18,18 -> 74,58)
    const redactCheck = await evalIn(
      editorSession,
      `(async () => {
        document.querySelector('[data-tool="redact"]').click();
        await new Promise((r) => setTimeout(r, 20));
        const preview = document.getElementById('preview-canvas');
        const rect = preview.getBoundingClientRect();
        const scaleX = rect.width / 160;
        const scaleY = rect.height / 100;

        const fire = (type, cx, cy) => {
          preview.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              button: 0,
              pointerId: 1,
              clientX: rect.left + cx * scaleX,
              clientY: rect.top + cy * scaleY,
            })
          );
        };
        fire('pointerdown', 18, 18);
        fire('pointermove', 74, 58);
        fire('pointerup', 74, 58);
        await new Promise((r) => setTimeout(r, 40));

        const base = document.getElementById('base-canvas');
        const ctx = base.getContext('2d');
        const secretPixels = ctx.getImageData(20, 20, 50, 35).data;
        let nonBlackInSecret = 0;
        for (let i = 0; i < secretPixels.length; i += 4) {
          if (
            secretPixels[i] !== 0 ||
            secretPixels[i + 1] !== 0 ||
            secretPixels[i + 2] !== 0 ||
            secretPixels[i + 3] !== 255
          ) {
            nonBlackInSecret += 1;
          }
        }
        return {
          styleDimmed: document.getElementById('style-group').classList.contains('dimmed'),
          nonBlackInSecret,
        };
      })()`
    );
    assert.equal(redactCheck.styleDimmed, true, 'Style swatches should dim while Redact is active');
    assert.equal(
      redactCheck.nonBlackInSecret,
      0,
      'Every pixel under Redact must be 100% opaque #000000 with zero green bleed'
    );

    // 5B. Test Rotate 90deg CW, Flip Horizontal, and Undo restoring dimensions & pixel locations
    const transformCheck = await evalIn(
      editorSession,
      `(async () => {
        const base = document.getElementById('base-canvas');
        const ctx = base.getContext('2d');

        document.querySelector('[data-transform="rotate-cw"]').click();
        await new Promise((r) => setTimeout(r, 40));
        const afterRotate = {
          w: base.width,
          h: base.height,
          dimText: document.getElementById('dim-label').textContent,
          rotatedBlackPixel: Array.from(ctx.getImageData(74, 25, 1, 1).data),
        };

        document.querySelector('[data-transform="flip-h"]').click();
        await new Promise((r) => setTimeout(r, 40));
        const flippedBlackPixel = Array.from(ctx.getImageData(25, 25, 1, 1).data);

        // Undo twice -> restores 160x100 upright redacted image
        document.getElementById('undo-btn').click();
        await new Promise((r) => setTimeout(r, 30));
        document.getElementById('undo-btn').click();
        await new Promise((r) => setTimeout(r, 30));

        return {
          afterRotate,
          flippedBlackPixel,
          restoredW: base.width,
          restoredH: base.height,
          restoredBlackPixel: Array.from(ctx.getImageData(25, 25, 1, 1).data),
        };
      })()`
    );
    assert.equal(transformCheck.afterRotate.w, 100);
    assert.equal(transformCheck.afterRotate.h, 160);
    assert.equal(transformCheck.afterRotate.dimText, '100 x 160 px');
    assert.deepEqual(transformCheck.afterRotate.rotatedBlackPixel, [0, 0, 0, 255]);
    assert.deepEqual(transformCheck.flippedBlackPixel, [0, 0, 0, 255]);
    assert.equal(transformCheck.restoredW, 160);
    assert.equal(transformCheck.restoredH, 100);
    assert.deepEqual(transformCheck.restoredBlackPixel, [0, 0, 0, 255]);

    // 5C. Draw Arrow + Text with XSS payload, then verify Replace Existing File Warning <dialog>
    const dialogAndXssCheck = await evalIn(
      editorSession,
      `(async () => {
        window.__xssTriggered = false;
        document.querySelector('[data-tool="arrow"]').click();
        await new Promise((r) => setTimeout(r, 20));
        const preview = document.getElementById('preview-canvas');
        const rect = preview.getBoundingClientRect();
        const sx = rect.width / 160;
        const sy = rect.height / 100;
        preview.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: rect.left + 90 * sx, clientY: rect.top + 70 * sy }));
        preview.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: rect.left + 140 * sx, clientY: rect.top + 30 * sy }));
        preview.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: rect.left + 140 * sx, clientY: rect.top + 30 * sy }));
        await new Promise((r) => setTimeout(r, 30));

        // Text tool with HTML payload
        document.querySelector('[data-tool="text"]').click();
        await new Promise((r) => setTimeout(r, 20));
        preview.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: rect.left + 80 * sx, clientY: rect.top + 75 * sy }));
        await new Promise((r) => setTimeout(r, 20));
        const txt = document.getElementById('text-overlay-input');
        txt.value = '<img src=x onerror="window.__xssTriggered=true">Verified';
        txt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 40));

        // Rename input with XSS/traversal chars and click Replace in Drive
        const fnInput = document.getElementById('filename-input');
        fnInput.value = '../<script>window.__xssTriggered=true</script>Clean_Report';
        fnInput.dispatchEvent(new Event('blur'));

        document.getElementById('save-drive-btn').click();
        await new Promise((r) => setTimeout(r, 30));

        const dlg = document.getElementById('confirm-replace-dialog');
        const dialogOpenOnSave = dlg.open;
        const targetText = document.getElementById('replace-target-name').textContent;

        // Cancel first -> must close modal without sending PATCH
        document.getElementById('cancel-replace-btn').click();
        await new Promise((r) => setTimeout(r, 20));
        const closedAfterCancel = !dlg.open;

        return {
          xssTriggered: window.__xssTriggered,
          sanitizedInputVal: fnInput.value,
          dialogOpenOnSave,
          targetText,
          closedAfterCancel,
        };
      })()`
    );
    assert.equal(dialogAndXssCheck.xssTriggered, false, 'Zero DOM XSS allowed in text or filename');
    assert.equal(dialogAndXssCheck.dialogOpenOnSave, true, 'Must warn before replacing existing Drive file');
    assert.equal(dialogAndXssCheck.targetText, 'Original_Secret.png');
    assert.equal(dialogAndXssCheck.closedAfterCancel, true);

    const patchCountAfterCancel = await evalIn(
      swSession,
      `globalThis.__e2eDriveCalls.filter((c) => c.method === 'PATCH').length`
    );
    assert.equal(patchCountAfterCancel, 0, 'Cancel must not replace the Drive file');

    // Confirm Replace in modal -> executes PATCH and updates storage
    const confirmSaveCheck = await evalIn(
      editorSession,
      `(async () => {
        document.getElementById('save-drive-btn').click();
        await new Promise((r) => setTimeout(r, 20));
        document.getElementById('confirm-replace-btn').click();
        for (let i = 0; i < 30; i += 1) {
          const pill = document.getElementById('status-pill');
          if (!pill.hidden && pill.textContent.includes('Replaced in Google Drive')) {
            return { ok: true, pillText: pill.textContent };
          }
          await new Promise((r) => setTimeout(r, 80));
        }
        return { ok: false, pillText: document.getElementById('status-pill').textContent };
      })()`
    );
    assert.equal(confirmSaveCheck.ok, true, `Expected Replaced pill, got: ${confirmSaveCheck.pillText}`);

    const swVerifyAfterReplace = await evalIn(
      swSession,
      `(async () => {
        const { recentUploads } = await chrome.storage.local.get('recentUploads');
        return {
          patchCalls: globalThis.__e2eDriveCalls.filter((c) => c.method === 'PATCH').length,
          latestRecent: recentUploads[0],
        };
      })()`
    );
    assert.equal(swVerifyAfterReplace.patchCalls, 1);
    assert.equal(
      swVerifyAfterReplace.latestRecent.webViewLink,
      'https://drive.google.com/file/d/e2e_shot_01/view'
    );
    assert.match(swVerifyAfterReplace.latestRecent.name, /Clean_Report\.png$/);

    // Simulate Chrome's 30-second MV3 service worker idle sleep (wiping all module-scope SW RAM)
    // while pages/editor.html remains open, then rename & save again!
    await evalIn(swSession, `globalThis.__saveshotResetRamForTest()`);

    const saveAfterSwIdleCheck = await evalIn(
      editorSession,
      `(async () => {
        const fnInput = document.getElementById('filename-input');
        fnInput.value = 'Saved_After_Idle_Sleep';
        fnInput.dispatchEvent(new Event('blur'));
        document.getElementById('status-pill').hidden = true;

        document.getElementById('save-drive-btn').click();
        await new Promise((r) => setTimeout(r, 25));
        document.getElementById('confirm-replace-btn').click();

        for (let i = 0; i < 30; i += 1) {
          const pill = document.getElementById('status-pill');
          if (!pill.hidden && !pill.textContent.includes('Replacing')) {
            return { ok: pill.textContent.includes('Replaced in Google Drive'), pillText: pill.textContent };
          }
          await new Promise((r) => setTimeout(r, 80));
        }
        return { ok: false, pillText: document.getElementById('status-pill').textContent };
      })()`
    );
    assert.equal(
      saveAfterSwIdleCheck.ok,
      true,
      `Editor save must survive MV3 service worker idle sleep (got: ${saveAfterSwIdleCheck.pillText})`
    );

    // 5D. Verify real Chromium content-script MessageSender cannot invoke privileged SIGN_OUT,
    //     while webpage success toast renders opt-in Edit button cleanly
    await cdp.send('Page.navigate', { url: `${baseUrl}/` }, pageSession);
    await new Promise((r) => setTimeout(r, 300));

    const realSenderSecurityCheck = await evalIn(
      swSession,
      `(async () => {
        await chrome.scripting.executeScript({ target: { tabId: ${testTabInfo.tabId} }, files: ['content/selector.js'] });
        await chrome.tabs.sendMessage(${testTabInfo.tabId}, {
          type: 'SHOW_TOAST',
          payload: {
            status: 'success',
            title: 'Saved to Drive',
            message: 'Shot.png',
            webViewLink: 'https://drive.google.com/file/d/e2e_shot_01/view',
            canEdit: true,
          },
        });

        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: ${testTabInfo.tabId} },
          func: () =>
            new Promise((resolve) => {
              const host = document.getElementById('__saveshot-toast-host');
              const buttons = Array.from(host?.shadowRoot?.querySelectorAll('button, a') || []).map(
                (el) => el.textContent.trim()
              );
              chrome.runtime.sendMessage({ type: 'SIGN_OUT' }, (res) => {
                resolve({ buttons, signOutAttempt: res });
              });
            }),
        });
        return result;
      })()`
    );
    assert.ok(realSenderSecurityCheck.buttons.includes('Edit'), 'Success toast should render Edit button');
    assert.equal(realSenderSecurityCheck.signOutAttempt.ok, false);
    assert.equal(
      realSenderSecurityCheck.signOutAttempt.code,
      'FORBIDDEN_SENDER',
      'Real Chromium content-script world must be blocked from privileged background actions'
    );
  } finally {
    cleanup();
    server.closeAllConnections();
    server.close();
  }
});
