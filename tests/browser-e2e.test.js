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

    // Verify Popup UI Boot & Unconfigured OAuth Setup Banner
    const popupCheck = await evalIn(
      extPageSession,
      `(() => ({
        signedOutVisible: !document.getElementById('signed-out-view').hidden,
        setupBannerVisible: !document.getElementById('setup-banner').hidden,
        hasHelpBtn: Boolean(document.getElementById('help-btn')),
        hasBugFooterBtn: Boolean(document.getElementById('footer-bug-btn')),
      }))()`
    );
    assert.equal(popupCheck.signedOutVisible, true);
    assert.equal(popupCheck.setupBannerVisible, true);
    assert.equal(popupCheck.hasHelpBtn, true);
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
  } finally {
    cleanup();
    server.closeAllConnections();
    server.close();
  }
});
