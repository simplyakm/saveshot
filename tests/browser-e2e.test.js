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
              const detail = params?.expression ? ` (${String(params.expression).slice(0, 120)})` : '';
              rej(new Error(`CDP timeout on ${method}${detail}`));
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

function resolveChromiumBinary() {
  if (process.env.CHROMIUM_BIN && fs.existsSync(process.env.CHROMIUM_BIN)) {
    return process.env.CHROMIUM_BIN;
  }
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of ['chromium', 'chromium-browser']) {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const pwRoot = '/opt/ms-playwright';
  if (fs.existsSync(pwRoot)) {
    const dirs = fs
      .readdirSync(pwRoot)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .reverse();
    for (const dir of dirs) {
      const candidate = path.join(pwRoot, dir, 'chrome-linux64', 'chrome');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  for (const name of ['google-chrome', 'google-chrome-stable']) {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return 'chromium';
}

async function launchChromiumWithExtension(initialUrl) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saveshot-chr-'));
  const tmpExtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saveshot-ext-'));
  fs.cpSync(rootDir, tmpExtDir, {
    recursive: true,
    filter: (src) =>
      !src.includes(`${path.sep}tests`) &&
      !src.includes(`${path.sep}store-assets`) &&
      !src.includes(`${path.sep}scripts`) &&
      !src.includes(`${path.sep}docs`) &&
      !src.includes(`${path.sep}content-source`),
  });

  // Grant <all_urls> ONLY in this automated CDP harness so headless scripts can invoke
  // captureVisibleTab without OS-level physical toolbar clicks (production manifest keeps strict activeTab).
  const mfPath = path.join(tmpExtDir, 'manifest.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  mf.host_permissions.push('<all_urls>');
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));

  const proc = spawn(
    resolveChromiumBinary(),
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
      try {
        proc.kill('SIGKILL');
      } catch {}
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {}
      try {
        fs.rmSync(tmpExtDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {}
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

    if (req.url === '/fullpage') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html>
        <html>
        <head>
          <style>
            html, body { margin: 0; padding: 0; }
            #fixed-hdr {
              position: fixed;
              top: 0;
              left: 0;
              right: 0;
              height: 48px;
              background: rgb(220, 38, 38);
              z-index: 9999;
            }
            #fixed-left-rail {
              position: fixed;
              top: 48px;
              left: 0;
              width: 120px;
              height: calc(100vh - 48px);
              background: rgb(234, 179, 8);
              z-index: 900;
            }
            .x-layout {
              display: flex;
              margin-left: 120px;
            }
            .x-feed {
              flex: 1;
              min-width: 0;
            }
            #sticky-right-rail {
              width: 140px;
              flex-shrink: 0;
              position: sticky;
              top: 48px;
              align-self: flex-start;
              height: calc(100vh - 48px);
              background: rgb(236, 72, 153);
              z-index: 100;
            }
            .band-top { height: 1100px; background: rgb(14, 165, 233); }
            #sticky-hdr {
              position: sticky;
              top: 0;
              height: 64px;
              background: rgb(147, 51, 234);
              z-index: 50;
            }
            .band-mid { height: 1100px; background: rgb(34, 197, 94); }
            .band-bot { height: 1000px; background: rgb(249, 115, 22); }
          </style>
        </head>
        <body>
          <header id="fixed-hdr">Fixed Top Nav</header>
          <aside id="fixed-left-rail">Fixed Left Rail</aside>
          <div class="x-layout">
            <main class="x-feed">
              <div class="band-top"></div>
              <div id="sticky-hdr">Below-Fold Sticky Section</div>
              <div class="band-mid"></div>
              <div class="band-bot"></div>
            </main>
            <aside id="sticky-right-rail">Sticky Right Rail</aside>
          </div>
        </body>
        </html>`);
      return;
    }

    if (req.url === '/spa-scroll') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html>
        <html>
        <head>
          <style>
            html, body { margin: 0; padding: 0; height: 100vh; overflow: hidden; }
            #spa-scroller {
              height: 100vh;
              overflow-y: auto;
              background: rgb(255, 255, 255);
            }
            .spa-b1 { height: 1000px; background: rgb(59, 130, 246); }
            .spa-b2 { height: 1000px; background: rgb(16, 185, 129); }
            .spa-b3 { height: 1000px; background: rgb(245, 158, 11); }
          </style>
        </head>
        <body>
          <main id="spa-scroller">
            <div class="spa-b1"></div>
            <div class="spa-b2"></div>
            <div class="spa-b3"></div>
          </main>
        </body>
        </html>`);
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
      swTarget = targetInfos.find(
        (t) =>
          t.type === 'service_worker' &&
          t.url.endsWith('/background/service-worker.js')
      );
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

    // Verify Popup UI Boot & OAuth Setup Banner state (poll until async GET_STATE settles)
    const prodManifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
    const expectedNeedsSetup = prodManifest.oauth2.client_id.includes('YOUR_CHROME_OAUTH');
    for (let i = 0; i < 25; i += 1) {
      const settled = await evalIn(
        extPageSession,
        `Boolean(document.getElementById('loading-view')?.hidden)`
      );
      if (settled) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const popupCheck = await evalIn(
      extPageSession,
      `(() => {
        const gridRect = document.querySelector('.capture-grid').getBoundingClientRect();
        const cardRect = document.getElementById('signed-out-view').getBoundingClientRect();
        document.getElementById('settings-toggle-btn').click();
        const drawerVisible = !document.getElementById('settings-drawer').hidden;
        const themeVisible = !document.getElementById('theme-segmented').hidden;
        const autoCopyVisible = !document.getElementById('auto-copy-segmented').hidden;
        const autoCopyImageActive = document
          .querySelector('#auto-copy-segmented [data-copy-opt="image"]')
          .classList.contains('active');
        const autoCopyLinkBtn = document.querySelector('#auto-copy-segmented [data-copy-opt="link"]');
        const autoCopyLinkDisabled = Boolean(autoCopyLinkBtn?.disabled);
        const autoCopyLinkTitle = autoCopyLinkBtn?.title || '';
        const driveFolderHidden = document.getElementById('drive-folder-field').hidden;
        const driveOptsHidden = document.getElementById('drive-options-group').hidden;
        document.getElementById('settings-toggle-btn').click();
        return {
          mainVisible: !document.getElementById('main-view').hidden,
          signedOutVisible: !document.getElementById('signed-out-view').hidden,
          accountCardHidden: document.getElementById('account-folder-card').hidden,
          recentHidden: document.getElementById('recent-section').hidden,
          captureAboveCard: gridRect.bottom <= cardRect.top,
          hasFullpageTile: Boolean(document.getElementById('capture-fullpage-btn')),
          signedOutHeading: document.querySelector('#signed-out-view h2')?.textContent?.trim() || '',
          signedOutCopy: document.querySelector('#signed-out-view .connect-desc')?.textContent?.trim() || '',
          setupBannerVisible: !document.getElementById('setup-banner').hidden,
          settingsBtnVisible: !document.getElementById('settings-toggle-btn').hidden,
          openDriveHidden: document.getElementById('open-drive-btn').hidden,
          signOutHidden: document.getElementById('sign-out-btn').hidden,
          drawerVisible,
          themeVisible,
          autoCopyVisible,
          autoCopyImageActive,
          autoCopyLinkDisabled,
          autoCopyLinkTitle,
          driveFolderHidden,
          driveOptsHidden,
          hasHelpBtn: Boolean(document.getElementById('help-btn')),
          hasOpenDriveBtn: Boolean(document.getElementById('open-drive-btn')),
          hasBugFooterBtn: Boolean(document.getElementById('footer-bug-btn')),
          signedOutBg: getComputedStyle(document.getElementById('signed-out-view')).backgroundColor,
        };
      })()`
    );
    assert.equal(popupCheck.mainVisible, true);
    assert.equal(popupCheck.signedOutVisible, true);
    assert.equal(popupCheck.accountCardHidden, true);
    assert.equal(popupCheck.recentHidden, true);
    assert.equal(popupCheck.captureAboveCard, true, 'Capture tiles must sit above Connect Google Drive card');
    assert.equal(popupCheck.hasFullpageTile, true, 'Full page capture tile must be present in Popup');
    assert.equal(popupCheck.signedOutHeading, 'Autosave to your Google Drive');
    assert.equal(
      popupCheck.signedOutCopy,
      'Never lose a shot, with easy download and link sharing. Privacy-first, no external servers or tracking.'
    );
    assert.match(
      popupCheck.signedOutBg,
      /^rgba\(26,\s*115,\s*232,/,
      'Popup signed-out card must use soft blue tint background'
    );
    assert.equal(popupCheck.setupBannerVisible, expectedNeedsSetup);
    assert.equal(popupCheck.settingsBtnVisible, true, 'Settings gear must be accessible when signed out');
    assert.equal(popupCheck.openDriveHidden, true);
    assert.equal(popupCheck.signOutHidden, true);
    assert.equal(popupCheck.drawerVisible, true);
    assert.equal(popupCheck.themeVisible, true);
    assert.equal(popupCheck.autoCopyVisible, true, 'Auto-copy setting must be accessible while signed out');
    assert.equal(popupCheck.autoCopyImageActive, true, 'Auto-copy must default to Image while signed out');
    assert.equal(popupCheck.autoCopyLinkDisabled, true, 'Auto-copy Link option must be disabled while signed out');
    assert.match(popupCheck.autoCopyLinkTitle, /Connect Google Drive/i);
    assert.equal(popupCheck.driveFolderHidden, true, 'Drive folder setting must hide when signed out');
    assert.equal(popupCheck.driveOptsHidden, true, 'Drive upload checkboxes must hide when signed out');
    assert.equal(popupCheck.hasHelpBtn, true);
    assert.equal(popupCheck.hasOpenDriveBtn, true);
    assert.equal(popupCheck.hasBugFooterBtn, true);

    // Verify Welcome / Help page opened automatically on extension install, binds both shortcuts, and shows Pin nudge + 7 FAQs + W1 support
    const { targetInfos: postInstallTargets } = await cdp.send('Target.getTargets');
    const welcomeTarget = postInstallTargets.find(
      (t) => t.type === 'page' && t.url.endsWith('/pages/welcome.html')
    );
    assert.ok(welcomeTarget, 'pages/welcome.html must open automatically on install');
    const { sessionId: welcomeSession } = await cdp.send('Target.attachToTarget', {
      targetId: welcomeTarget.targetId,
      flatten: true,
    });
    for (let i = 0; i < 25; i += 1) {
      const welcomeSettled = await evalIn(
        welcomeSession,
        `document.getElementById('account-heading')?.textContent?.trim() !== 'Checking Google account...'`
      );
      if (welcomeSettled) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    const welcomeCheck = await evalIn(
      welcomeSession,
      `(() => ({
        title: document.querySelector('h1')?.textContent,
        subtitle: document.querySelector('.hero .subtitle')?.textContent?.trim() || '',
        pinNudgeVisible: !document.getElementById('pin-nudge-card')?.hidden,
        pinDoneHidden: Boolean(document.getElementById('pin-done-card')?.hidden),
        statusUnconnected: document.getElementById('status-card')?.classList.contains('unconnected'),
        statusBg: getComputedStyle(document.getElementById('status-card')).backgroundColor,
        accountHeading: document.getElementById('account-heading')?.textContent?.trim() || '',
        stepTitles: Array.from(document.querySelectorAll('.step-card h3'), (el) => el.textContent.trim()),
        shortcutRegionText: document.getElementById('shortcut-region')?.textContent?.trim() || '',
        shortcutVisibleText: document.getElementById('shortcut-visible')?.textContent?.trim() || '',
        unsetHintHidden: document.getElementById('shortcut-unset-hint')?.hidden,
        faqCount: document.querySelectorAll('#faq-list .faq-item').length,
        hasFeedbackSection: Boolean(document.getElementById('feedback')),
        versionStripText: document.getElementById('version-info-text')?.textContent?.trim() || '',
        cwsHref: document.getElementById('cws-support-link')?.href || '',
        hasRepoIssuesLink: Boolean(document.getElementById('repo-issues-link')),
        feedbackActionCount: document.querySelectorAll('#feedback .feedback-actions a').length,
        hasGithubAnywhere: document.documentElement.outerHTML.toLowerCase().includes('github.com'),
        footerLeft: document.getElementById('welcome-footer-left')?.textContent?.trim() || '',
        footerLinksCount: document.querySelectorAll('.welcome-footer-links a').length,
      }))()`
    );
    assert.equal(welcomeCheck.title, 'SaveShot');
    assert.match(welcomeCheck.subtitle, /download locally/i);
    assert.match(welcomeCheck.subtitle, /no external servers or tracking/i);
    assert.equal(welcomeCheck.pinNudgeVisible, true, 'Fresh unpinned install must show Pin SaveShot card');
    assert.equal(welcomeCheck.pinDoneHidden, true, 'Pin celebration card must be hidden while unpinned');
    assert.equal(welcomeCheck.statusUnconnected, true, 'Signed-out Welcome status card must have .unconnected');
    assert.match(
      welcomeCheck.statusBg,
      /^rgba\(26,\s*115,\s*232,/,
      'Welcome signed-out status card must use soft blue tint background'
    );
    assert.equal(welcomeCheck.accountHeading, 'Autosave to your Google Drive');
    assert.equal(welcomeCheck.stepTitles.length, 4, 'Welcome How it works must show all 4 steps including Editing');
    assert.ok(welcomeCheck.stepTitles.includes('Edit, redact, or copy'));
    assert.equal(welcomeCheck.shortcutRegionText, 'Alt + Shift + S');
    assert.equal(welcomeCheck.shortcutVisibleText, 'Alt + Shift + V');
    assert.equal(welcomeCheck.unsetHintHidden, true, 'Both default shortcuts must bind cleanly on fresh install');
    assert.equal(welcomeCheck.faqCount, 7, 'Welcome Good to know must show all 7 synced FAQs');
    assert.equal(welcomeCheck.hasFeedbackSection, true);
    assert.match(
      welcomeCheck.versionStripText,
      /^SaveShot v1\.3\.0 \u00b7 Chrome .* \u00b7 Last error: None$/
    );
    assert.equal(
      welcomeCheck.cwsHref,
      'https://chromewebstore.google.com/detail/eilmbilnlihhddjdmdpppalfnbnieppf/support'
    );
    assert.equal(welcomeCheck.hasRepoIssuesLink, false, 'Raise on GitHub must be removed from welcome.html');
    assert.equal(welcomeCheck.feedbackActionCount, 1, 'Feedback card must render only the single CWS Support CTA');
    assert.equal(welcomeCheck.hasGithubAnywhere, false, 'welcome.html must contain zero github.com URLs');
    assert.equal(welcomeCheck.footerLeft, 'SaveShot \u00b7 Privacy-first screenshot tool');
    assert.equal(welcomeCheck.footerLinksCount, 5, 'Welcome footer must stay decluttered with 5 right-side links');

    // Verify live Pin-to-Chrome celebration when user pins while welcome.html is open, plus Copy version info button
    const livePinAndCopyCheck = await evalIn(
      welcomeSession,
      `(async () => {
        let copiedText = '';
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (t) => {
              copiedText = t;
            },
          },
        });
        document.getElementById('copy-version-btn').click();
        await new Promise((r) => setTimeout(r, 30));
        const btnLabelAfterCopy = document.getElementById('copy-version-btn').textContent.trim();

        const origGetUserSettings = chrome.action.getUserSettings.bind(chrome.action);
        chrome.action.getUserSettings = async () => ({ isOnToolbar: true });
        window.dispatchEvent(new Event('focus'));
        await new Promise((r) => setTimeout(r, 40));
        const pinNudgeHiddenAfterPin = document.getElementById('pin-nudge-card').hidden;
        const pinDoneVisibleAfterPin = !document.getElementById('pin-done-card').hidden;
        const pinDoneText = document.getElementById('pin-done-card').textContent.replace(/\\s+/g, ' ').trim();
        chrome.action.getUserSettings = origGetUserSettings;

        return {
          copiedText,
          btnLabelAfterCopy,
          pinNudgeHiddenAfterPin,
          pinDoneVisibleAfterPin,
          pinDoneText,
        };
      })()`
    );
    assert.equal(livePinAndCopyCheck.btnLabelAfterCopy, 'Copied!');
    assert.match(livePinAndCopyCheck.copiedText, /^SaveShot v1\.3\.0 \u00b7 Chrome .* \u00b7 Last error: None$/);
    assert.equal(livePinAndCopyCheck.pinNudgeHiddenAfterPin, true, 'Pin nudge must hide once pinned');
    assert.equal(livePinAndCopyCheck.pinDoneVisibleAfterPin, true, 'Pin celebration must appear when pinned live');
    assert.match(livePinAndCopyCheck.pinDoneText, /Pinned to your Chrome toolbar!/);

    // Verify opening Help later when ALREADY pinned hides both pin cards, and ?error= populates version strip
    const { targetId: pinnedHelpTargetId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
      background: true,
    });
    const { sessionId: pinnedHelpSession } = await cdp.send('Target.attachToTarget', {
      targetId: pinnedHelpTargetId,
      flatten: true,
    });
    await cdp.send('Page.enable', {}, pinnedHelpSession);
    await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `
          if (chrome?.action) {
            chrome.action.getUserSettings = async () => ({ isOnToolbar: true });
          }
        `,
      },
      pinnedHelpSession
    );
    await cdp.send(
      'Page.navigate',
      { url: `chrome-extension://${extId}/pages/welcome.html?error=DRIVE_QUOTA_EXCEEDED#feedback` },
      pinnedHelpSession
    );
    await new Promise((r) => setTimeout(r, 250));
    const alreadyPinnedAudit = await evalIn(
      pinnedHelpSession,
      `(() => ({
        pinNudgeHidden: document.getElementById('pin-nudge-card').hidden,
        pinDoneHidden: document.getElementById('pin-done-card').hidden,
        versionText: document.getElementById('version-info-text').textContent.trim(),
      }))()`
    );
    assert.equal(alreadyPinnedAudit.pinNudgeHidden, true, 'Pin nudge must stay hidden when already pinned');
    assert.equal(alreadyPinnedAudit.pinDoneHidden, true, 'Pin celebration must not show when already pinned before opening');
    assert.match(alreadyPinnedAudit.versionText, /Last error: DRIVE_QUOTA_EXCEEDED$/);
    await cdp.send('Target.closeTarget', { targetId: pinnedHelpTargetId });

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
    // 0. Real Chromium C++ MenuManager Registration + Context Menu 1-Click Capture Flow
    // -------------------------------------------------------------------------
    const nativeContextMenuAudit = await evalIn(
      swSession,
      `(async () => {
        const hasClickListener = Boolean(chrome.contextMenus?.onClicked?.hasListeners?.());
        const existingCheck = await new Promise((resolve) => {
          chrome.contextMenus.update('saveshot-take-screenshot', {}, () => {
            resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'OK');
          });
        });
        const bogusCheck = await new Promise((resolve) => {
          chrome.contextMenus.update('saveshot-nonexistent-submenu', {}, () => {
            resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'OK');
          });
        });
        const targetTab = await chrome.tabs.get(${testTabInfo.tabId});
        await globalThis.__saveshotTriggerContextMenuForTest(
          { menuItemId: 'saveshot-take-screenshot' },
          targetTab
        );
        return { hasClickListener, existingCheck, bogusCheck };
      })()`
    );
    assert.equal(nativeContextMenuAudit.hasClickListener, true, 'Service worker must bind contextMenus.onClicked');
    assert.equal(
      nativeContextMenuAudit.existingCheck,
      'OK',
      'Chromium native MenuManager must have registered saveshot-take-screenshot on install'
    );
    assert.match(
      nativeContextMenuAudit.bogusCheck,
      /Cannot find menu item/i,
      'No extra submenu item may exist in Chromium MenuManager'
    );

    // Verify context menu click mounted the region selector on the active page and dragging opens cropped local Editor
    const cmOverlayMounted = await evalIn(
      pageSession,
      `Boolean(document.getElementById('__saveshot-overlay-host'))`
    );
    assert.equal(cmOverlayMounted, true, 'Clicking Take Screenshot must mount region overlay on webpage');

    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: 124, y: 94, button: 'left', clickCount: 1 },
      pageSession
    );
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: 256, y: 186, button: 'left' },
      pageSession
    );
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: 256, y: 186, button: 'left', clickCount: 1 },
      pageSession
    );

    let cmEditorTarget = null;
    for (let i = 0; i < 20; i += 1) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      cmEditorTarget = targetInfos.find(
        (t) => t.type === 'page' && t.url.includes('/pages/editor.html?session=')
      );
      if (cmEditorTarget) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.ok(cmEditorTarget, 'Context-menu region drag must open cropped Editor tab');
    await cdp.send('Target.closeTarget', { targetId: cmEditorTarget.targetId });
    await evalIn(swSession, `chrome.tabs.update(${testTabInfo.tabId}, { active: true })`);

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

    // Re-open overlay via START_REGION_CAPTURE and drag directly across #underlying-btn -> verify button is NOT clicked!
    const startHostileDrag = await evalIn(
      extPageSession,
      `new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'START_REGION_CAPTURE', tabId: ${testTabInfo.tabId} }, resolve);
      })`
    );
    assert.equal(startHostileDrag.ok, true);
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

    // Dragging a region while signed out opens the local Editor tab directly; verify and close it before Section 3
    let hostileLocalEditor = null;
    for (let i = 0; i < 20; i += 1) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      hostileLocalEditor = targetInfos.find(
        (t) => t.type === 'page' && t.url.includes('/pages/editor.html?session=')
      );
      if (hostileLocalEditor) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.ok(hostileLocalEditor, 'Signed-out region drag must open local Editor tab');
    await cdp.send('Target.closeTarget', { targetId: hostileLocalEditor.targetId });
    await evalIn(swSession, `chrome.tabs.update(${testTabInfo.tabId}, { active: true })`);

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
          if (method === 'POST' && u.includes('/upload/drive/v3/files')) {
            return new Response(
              JSON.stringify({
                id: 'e2e_overlay_full_01',
                name: 'Screenshot_full_tab.png',
                webViewLink: 'https://drive.google.com/file/d/e2e_overlay_full_01/view',
                createdTime: new Date().toISOString(),
              }),
              { status: 200 }
            );
          }
          if (u.includes('/drive/v3/about')) {
            return new Response(
              JSON.stringify({
                user: { displayName: 'E2E User', emailAddress: 'e2e@example.com' },
              }),
              { status: 200 }
            );
          }
          return new Response(
            JSON.stringify({
              id: 'folder_e2e_1',
              name: 'Chrome_SaveShot_ScreenShots',
              trashed: false,
              webViewLink: 'https://drive.google.com/drive/folders/folder_e2e_1',
            }),
            { status: 200 }
          );
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
        (t) =>
          t.type === 'page' &&
          t.url.includes(`/pages/editor.html?session=${openEditorRes.sessionId}`)
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
          const wrap = document.getElementById('canvas-wrap');
          return Boolean(c && wrap && !wrap.hidden && c.width === 160 && c.height === 100);
        })()`
      );
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // 5A. Verify SaveShot / Editor title, clean Save/unsaved-pill state, Redact enabling Save + unsaved notification, and Undo hiding it
    const redactCheck = await evalIn(
      editorSession,
      `(async () => {
        const saveBtn = document.getElementById('save-drive-btn');
        const unsavedPill = document.getElementById('unsaved-pill');
        const brandText = document.getElementById('editor-brand')?.textContent?.replace(/\\s+/g, ' ')?.trim() || '';
        const initialSaveDisabled = saveBtn.disabled;
        const initialUnsavedHidden = unsavedPill.hidden;
        const initialSaveLabel = saveBtn.textContent.trim();
        const initialReadonlyVisible =
          !document.getElementById('filename-readonly').hidden &&
          document.getElementById('filename-editing').hidden;

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

        const saveEnabledAfterDraw = !saveBtn.disabled;
        const unsavedShownAfterDraw = !unsavedPill.hidden;
        const unsavedText = unsavedPill.textContent.replace(/\\s+/g, ' ').trim();

        // Undo back to clean initial state -> Save button disables AND unsaved notification hides immediately
        document.getElementById('undo-btn').click();
        await new Promise((r) => setTimeout(r, 35));
        const saveDisabledAfterUndo = saveBtn.disabled;
        const unsavedHiddenAfterUndo = unsavedPill.hidden;

        // Re-apply Redact permanently over the green secret region
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
          brandText,
          initialSaveDisabled,
          initialUnsavedHidden,
          initialSaveLabel,
          initialReadonlyVisible,
          saveEnabledAfterDraw,
          unsavedShownAfterDraw,
          unsavedText,
          saveDisabledAfterUndo,
          unsavedHiddenAfterUndo,
          styleDimmed: document.getElementById('style-group').classList.contains('dimmed'),
          nonBlackInSecret,
        };
      })()`
    );
    assert.equal(redactCheck.brandText, 'SaveShot / Editor');
    assert.equal(redactCheck.initialSaveDisabled, true, 'Save must be disabled before any edits on existing file');
    assert.equal(redactCheck.initialUnsavedHidden, true, 'Unsaved notification must be hidden initially');
    assert.equal(redactCheck.initialSaveLabel, 'Save');
    assert.equal(redactCheck.initialReadonlyVisible, true, 'Filename must start in read-only mode');
    assert.equal(redactCheck.saveEnabledAfterDraw, true, 'Save must activate once an edit is made');
    assert.equal(redactCheck.unsavedShownAfterDraw, true, 'Unsaved notification must show once an edit is made');
    assert.match(redactCheck.unsavedText, /Unsaved changes.*Click Save/);
    assert.equal(redactCheck.saveDisabledAfterUndo, true, 'Save must re-disable when Undo returns to clean state');
    assert.equal(redactCheck.unsavedHiddenAfterUndo, true, 'Unsaved notification must hide when Undo returns to clean state');
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
    assert.equal(transformCheck.afterRotate.dimText, '100 \u00d7 160');
    assert.deepEqual(transformCheck.afterRotate.rotatedBlackPixel, [0, 0, 0, 255]);
    assert.deepEqual(transformCheck.flippedBlackPixel, [0, 0, 0, 255]);
    assert.equal(transformCheck.restoredW, 160);
    assert.equal(transformCheck.restoredH, 100);
    assert.deepEqual(transformCheck.restoredBlackPixel, [0, 0, 0, 255]);

    // 5B.2. Test Highlighter (H) auto-Amber default, translucent marker stroke, Shift straight-line snap, and Undo
    const highlighterCheck = await evalIn(
      editorSession,
      `(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
        await new Promise((r) => setTimeout(r, 20));

        const highlighterActive = document
          .querySelector('[data-tool="highlighter"]')
          .classList.contains('active');
        const autoSwitchedToAmber = document
          .querySelector('.swatch-amber')
          .classList.contains('active');

        const preview = document.getElementById('preview-canvas');
        const rect = preview.getBoundingClientRect();
        const sx = rect.width / 160;
        const sy = rect.height / 100;

        // Drag from (90, 65) to (145, 88) while holding Shift -> must snap horizontally along y=65
        preview.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            pointerId: 9,
            shiftKey: true,
            clientX: rect.left + 90 * sx,
            clientY: rect.top + 65 * sy,
          })
        );
        preview.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            button: 0,
            pointerId: 9,
            shiftKey: true,
            clientX: rect.left + 145 * sx,
            clientY: rect.top + 88 * sy,
          })
        );
        preview.dispatchEvent(
          new PointerEvent('pointerup', {
            bubbles: true,
            button: 0,
            pointerId: 9,
            shiftKey: true,
            clientX: rect.left + 145 * sx,
            clientY: rect.top + 88 * sy,
          })
        );
        await new Promise((r) => setTimeout(r, 40));

        const ctx = document.getElementById('base-canvas').getContext('2d');
        const highlightedHorizontalPixel = Array.from(ctx.getImageData(130, 65, 1, 1).data);
        const unsnappedDiagonalPixel = Array.from(ctx.getImageData(145, 88, 1, 1).data);

        // Undo restores white background at (130, 65) cleanly
        document.getElementById('undo-btn').click();
        await new Promise((r) => setTimeout(r, 30));
        const restoredAfterUndoPixel = Array.from(ctx.getImageData(130, 65, 1, 1).data);

        return {
          highlighterActive,
          autoSwitchedToAmber,
          highlightedHorizontalPixel,
          unsnappedDiagonalPixel,
          restoredAfterUndoPixel,
        };
      })()`
    );
    assert.equal(highlighterCheck.highlighterActive, true, 'Pressing H must activate Highlighter tool');
    assert.equal(
      highlighterCheck.autoSwitchedToAmber,
      true,
      'Selecting Highlighter for the first time must auto-switch default Red to Amber'
    );
    assert.ok(
      highlighterCheck.highlightedHorizontalPixel[2] > 120 &&
        highlighterCheck.highlightedHorizontalPixel[2] < 210,
      `Expected translucent Amber blend over white at (130, 65), got ${JSON.stringify(
        highlighterCheck.highlightedHorizontalPixel
      )}`
    );
    assert.deepEqual(
      highlighterCheck.unsnappedDiagonalPixel,
      [255, 255, 255, 255],
      'Shift-snapped horizontal highlighter must not paint down at diagonal (145, 88)'
    );
    assert.deepEqual(
      highlighterCheck.restoredAfterUndoPixel,
      [255, 255, 255, 255],
      'Undo must cleanly remove Highlighter stroke'
    );

    // 5C. Custom #HEX color, Intentional Pencil Rename + Escape, XSS payloads, and Pixel-Exact Replace Dialog
    const dialogAndXssCheck = await evalIn(
      editorSession,
      `(async () => {
        window.__xssTriggered = false;
        document.querySelector('[data-tool="box"]').click();
        await new Promise((r) => setTimeout(r, 20));

        // Test Custom #HEX Color Popover: invalid input rejected, shorthand '0af' -> #00aaff applied
        document.getElementById('custom-color-btn').click();
        const hexPopover = document.getElementById('hex-popover');
        const hexInput = document.getElementById('hex-text-input');
        const hexWrap = document.getElementById('hex-input-wrap');

        hexInput.value = 'zzzzzz';
        document.getElementById('apply-hex-btn').click();
        const markedInvalid = hexWrap.classList.contains('invalid') && !hexPopover.hidden;

        hexInput.value = '0af';
        document.getElementById('apply-hex-btn').click();
        const appliedCustomHex =
          hexPopover.hidden &&
          document.getElementById('custom-color-btn').classList.contains('active');

        const preview = document.getElementById('preview-canvas');
        const rect = preview.getBoundingClientRect();
        const sx = rect.width / 160;
        const sy = rect.height / 100;
        preview.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: rect.left + 100 * sx, clientY: rect.top + 15 * sy }));
        preview.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: rect.left + 145 * sx, clientY: rect.top + 45 * sy }));
        preview.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: rect.left + 145 * sx, clientY: rect.top + 45 * sy }));
        await new Promise((r) => setTimeout(r, 35));

        const boxBorderPixel = Array.from(
          document.getElementById('base-canvas').getContext('2d').getImageData(120, 15, 1, 1).data
        );

        // Text tool with HTML payload
        document.querySelector('[data-tool="text"]').click();
        await new Promise((r) => setTimeout(r, 20));
        preview.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: rect.left + 80 * sx, clientY: rect.top + 75 * sy }));
        await new Promise((r) => setTimeout(r, 20));
        const txt = document.getElementById('text-overlay-input');
        txt.value = '<img src=x onerror="window.__xssTriggered=true">Verified';
        txt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 40));

        // Intentional pencil rename: Escape cancels back to Original_Secret, then pencil + blur commits sanitized name
        const pencilBtn = document.getElementById('rename-pencil-btn');
        const fnInput = document.getElementById('filename-input');
        pencilBtn.click();
        const openedOnPencil =
          document.getElementById('filename-readonly').hidden &&
          !document.getElementById('filename-editing').hidden;

        fnInput.value = 'Accidental_Typing';
        fnInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const cancelledName = document.getElementById('filename-display').textContent;

        pencilBtn.click();
        fnInput.value = '../<script>window.__xssTriggered=true</script>Clean_Report';
        fnInput.dispatchEvent(new Event('blur'));
        const sanitizedDisplay = document.getElementById('filename-display').textContent;

        document.getElementById('save-drive-btn').click();
        await new Promise((r) => setTimeout(r, 30));

        const dlg = document.getElementById('confirm-replace-dialog');
        const dialogOpenOnSave = dlg.open;
        const dialogHeading = dlg.querySelector('h2')?.textContent?.trim() || '';

        // Measure all 5 right-hand topbar controls and all 3 dialog buttons for pixel-exact 32px parity
        const measureBtns = (ids) =>
          ids.map((id) => {
            const el = document.getElementById(id);
            const b = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return {
              id,
              text: el.textContent.trim(),
              top: b.top,
              bottom: b.bottom,
              height: Math.round(b.height),
              fontSize: cs.fontSize,
              lineHeight: cs.lineHeight,
              borderRadius: cs.borderRadius,
            };
          });

        const topbarBtns = measureBtns([
          'editor-help-btn',
          'copy-image-btn',
          'download-btn',
          'copy-link-btn',
          'save-drive-btn',
        ]);
        const pencilRect = document.getElementById('rename-pencil-btn').getBoundingClientRect();
        const openDriveRect = document.getElementById('open-drive-link').getBoundingClientRect();
        const unsavedEl = document.getElementById('unsaved-pill');
        const unsavedRect = unsavedEl.getBoundingClientRect();
        const unsavedInLeft = Boolean(document.querySelector('.topbar-left #unsaved-pill'));

        const dlgBtns = measureBtns([
          'cancel-replace-btn',
          'save-new-copy-btn',
          'confirm-replace-btn',
        ]);

        // Cancel first -> must close modal without sending PATCH
        document.getElementById('cancel-replace-btn').click();
        await new Promise((r) => setTimeout(r, 20));
        const closedAfterCancel = !dlg.open;

        return {
          markedInvalid,
          appliedCustomHex,
          boxBorderPixel,
          xssTriggered: window.__xssTriggered,
          openedOnPencil,
          cancelledName,
          sanitizedDisplay,
          dialogOpenOnSave,
          dialogHeading,
          topbarBtns,
          openIconBesidePencil: {
            pencilW: Math.round(pencilRect.width),
            pencilH: Math.round(pencilRect.height),
            openW: Math.round(openDriveRect.width),
            openH: Math.round(openDriveRect.height),
            topDiff: Math.abs(pencilRect.top - openDriveRect.top),
            rightOfPencil: openDriveRect.left >= pencilRect.right - 0.5,
          },
          leftUnsavedMetrics: {
            inLeft: unsavedInLeft,
            height: Math.round(unsavedRect.height),
          },
          dlgBtns,
          closedAfterCancel,
        };
      })()`
    );
    assert.equal(dialogAndXssCheck.markedInvalid, true, 'Invalid hex input must mark wrapper invalid');
    assert.equal(dialogAndXssCheck.appliedCustomHex, true, '3-digit hex shorthand must apply custom color');
    assert.equal(dialogAndXssCheck.boxBorderPixel[0], 0, 'Custom #00aaff box red channel must be 0');
    assert.equal(dialogAndXssCheck.boxBorderPixel[1], 170, 'Custom #00aaff box green channel must be 170');
    assert.equal(dialogAndXssCheck.boxBorderPixel[2], 255, 'Custom #00aaff box blue channel must be 255');
    assert.equal(dialogAndXssCheck.xssTriggered, false, 'Zero DOM XSS allowed in text or filename');
    assert.equal(dialogAndXssCheck.openedOnPencil, true, 'Clicking pencil must reveal filename input');
    assert.equal(dialogAndXssCheck.cancelledName, 'Original_Secret', 'Escape must revert filename edit');
    assert.match(dialogAndXssCheck.sanitizedDisplay, /Clean_Report$/);
    assert.equal(dialogAndXssCheck.dialogOpenOnSave, true, 'Must warn before replacing existing Drive file');
    assert.equal(dialogAndXssCheck.dialogHeading, 'Replace existing file?');

    // Verify Open in Google Drive sits right next to Pencil as a matching 28x28 icon button, and unsaved pill is 24px in topbar-left
    assert.equal(dialogAndXssCheck.openIconBesidePencil.pencilW, 28);
    assert.equal(dialogAndXssCheck.openIconBesidePencil.pencilH, 28);
    assert.equal(dialogAndXssCheck.openIconBesidePencil.openW, 28);
    assert.equal(dialogAndXssCheck.openIconBesidePencil.openH, 28);
    assert.ok(dialogAndXssCheck.openIconBesidePencil.topDiff <= 0.5, 'Open icon must align vertically with Pencil icon');
    assert.equal(dialogAndXssCheck.openIconBesidePencil.rightOfPencil, true, 'Open icon must sit directly to the right of Pencil icon');
    assert.equal(dialogAndXssCheck.leftUnsavedMetrics.inLeft, true, 'Unsaved changes pill must render inside .topbar-left');
    assert.equal(dialogAndXssCheck.leftUnsavedMetrics.height, 24, 'Left unsaved pill must match 24px status pill height');

    // Verify all 5 Editor topbar-right buttons (Help, Copy image, Download, Copy link, Save) share exact 32px height and 0px vertical drift
    const [helpBtnMetrics, copyImgMetrics, dlBtnMetrics, copyBtnMetrics, saveBtnMetrics] =
      dialogAndXssCheck.topbarBtns;
    assert.equal(helpBtnMetrics.text, 'Help');
    assert.equal(copyImgMetrics.text, 'Copy image');
    for (const m of [helpBtnMetrics, copyImgMetrics, dlBtnMetrics, copyBtnMetrics, saveBtnMetrics]) {
      assert.equal(m.height, 32, `${m.id} must be 32px tall`);
      assert.equal(m.fontSize, '12.5px', `${m.id} must use 12.5px font-size`);
      assert.equal(m.lineHeight, '18px', `${m.id} must use 18px line-height`);
      assert.equal(m.borderRadius, '8px', `${m.id} must use 8px border-radius`);
      assert.ok(Math.abs(m.top - dlBtnMetrics.top) <= 0.5, `${m.id} top misaligned`);
      assert.ok(Math.abs(m.bottom - dlBtnMetrics.bottom) <= 0.5, `${m.id} bottom misaligned`);
    }

    // 5C.2. Verify real ClipboardItem PNG copy (zero clipboardWrite permission) via Copy image button & Ctrl+C, plus input focus & Circle (C) safety
    await cdp.send('Page.bringToFront', {}, editorSession);
    const nativeCopyRes = await cdp.send(
      'Runtime.evaluate',
      {
        expression: `(async () => {
          document.getElementById('copy-image-btn').click();
          for (let i = 0; i < 20; i += 1) {
            if (document.getElementById('copy-image-btn').textContent.trim() === 'Copied!') {
              return {
                ok: true,
                pillText: document.getElementById('status-pill').textContent.trim(),
              };
            }
            await new Promise((r) => setTimeout(r, 30));
          }
          return {
            ok: false,
            btnText: document.getElementById('copy-image-btn').textContent.trim(),
            pillText: document.getElementById('status-pill').textContent.trim(),
          };
        })()`,
        userGesture: true,
        awaitPromise: true,
        returnByValue: true,
      },
      editorSession
    );
    assert.equal(
      nativeCopyRes.result.value.ok,
      true,
      `Real Chromium ClipboardItem write must succeed without clipboardWrite permission (got: ${JSON.stringify(
        nativeCopyRes.result.value
      )})`
    );
    assert.equal(nativeCopyRes.result.value.pillText, 'Copied image to clipboard');

    const ctrlCCopyCheck = await evalIn(
      editorSession,
      `(async () => {
        const capturedItems = [];
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            write: async (items) => {
              capturedItems.push(...items);
            },
            writeText: async () => {},
          },
        });

        // 1. Ctrl+C while focused inside filename input must NOT hijack native text copy
        document.getElementById('rename-pencil-btn').click();
        const fnInput = document.getElementById('filename-input');
        fnInput.focus();
        fnInput.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true })
        );
        await new Promise((r) => setTimeout(r, 25));
        const writesDuringInputFocus = capturedItems.length;
        fnInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        // 2. Plain 'c' (no Ctrl/Cmd) must still select the Circle tool
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
        await new Promise((r) => setTimeout(r, 20));
        const circleActiveOnPlainC = document
          .querySelector('[data-tool="circle"]')
          .classList.contains('active');

        // 3. Ctrl+C on canvas copies encoded 160x100 PNG ClipboardItem
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true })
        );
        for (let i = 0; i < 20 && capturedItems.length === 0; i += 1) {
          await new Promise((r) => setTimeout(r, 25));
        }
        const pngBlob = await capturedItems[0].getType('image/png');
        const bytes = new Uint8Array(await pngBlob.arrayBuffer());
        const magicHex = Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
        const view = new DataView(bytes.buffer);
        const pngWidth = view.getUint32(16, false);
        const pngHeight = view.getUint32(20, false);

        document.getElementById('status-pill').hidden = true;
        return {
          writesDuringInputFocus,
          circleActiveOnPlainC,
          totalWritesAfterCtrlC: capturedItems.length,
          mimeType: pngBlob.type,
          magicHex,
          pngWidth,
          pngHeight,
        };
      })()`
    );
    assert.equal(ctrlCCopyCheck.writesDuringInputFocus, 0, 'Ctrl+C inside <input> must not copy canvas image');
    assert.equal(ctrlCCopyCheck.circleActiveOnPlainC, true, 'Plain C key must still activate Circle tool');
    assert.equal(ctrlCCopyCheck.totalWritesAfterCtrlC, 1, 'Ctrl+C on editor stage must copy canvas PNG');
    assert.equal(ctrlCCopyCheck.mimeType, 'image/png');
    assert.equal(ctrlCCopyCheck.magicHex, '89504e470d0a1a0a');
    assert.equal(ctrlCCopyCheck.pngWidth, 160);
    assert.equal(ctrlCCopyCheck.pngHeight, 100);

    // Verify all 3 modal buttons (Cancel, Save as new, Replace) share exact 32px height, 0px vertical drift, and identical typography
    const [cancelMetrics, saveNewMetrics, replaceMetrics] = dialogAndXssCheck.dlgBtns;
    for (const m of [cancelMetrics, saveNewMetrics, replaceMetrics]) {
      assert.equal(m.height, 32, `${m.id} must be 32px tall`);
      assert.equal(m.fontSize, '12.5px', `${m.id} must use 12.5px font-size`);
      assert.equal(m.lineHeight, '18px', `${m.id} must use 18px line-height`);
      assert.equal(m.borderRadius, '8px', `${m.id} must use 8px border-radius`);
      assert.ok(Math.abs(m.top - cancelMetrics.top) <= 0.5, `${m.id} top misaligned`);
      assert.ok(Math.abs(m.bottom - cancelMetrics.bottom) <= 0.5, `${m.id} bottom misaligned`);
    }
    assert.equal(dialogAndXssCheck.closedAfterCancel, true);

    const patchCountAfterCancel = await evalIn(
      swSession,
      `globalThis.__e2eDriveCalls.filter((c) => c.method === 'PATCH').length`
    );
    assert.equal(patchCountAfterCancel, 0, 'Cancel must not replace the Drive file');

    // Confirm Replace in modal -> executes PATCH, updates storage, and re-disables Save until next change
    const confirmSaveCheck = await evalIn(
      editorSession,
      `(async () => {
        document.getElementById('save-drive-btn').click();
        await new Promise((r) => setTimeout(r, 20));
        document.getElementById('confirm-replace-btn').click();
        for (let i = 0; i < 30; i += 1) {
          const pill = document.getElementById('status-pill');
          if (!pill.hidden && pill.textContent.includes('Replaced in Google Drive')) {
            return {
              ok: true,
              pillText: pill.textContent,
              saveDisabledAfterSave: document.getElementById('save-drive-btn').disabled,
              unsavedHiddenAfterSave: document.getElementById('unsaved-pill').hidden,
            };
          }
          await new Promise((r) => setTimeout(r, 80));
        }
        return { ok: false, pillText: document.getElementById('status-pill').textContent };
      })()`
    );
    assert.equal(confirmSaveCheck.ok, true, `Expected Replaced pill, got: ${confirmSaveCheck.pillText}`);
    assert.equal(
      confirmSaveCheck.saveDisabledAfterSave,
      true,
      'Save button must return to disabled once all changes are saved'
    );
    assert.equal(
      confirmSaveCheck.unsavedHiddenAfterSave,
      true,
      'Unsaved changes notification must clear once changes are saved'
    );

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
    // while pages/editor.html remains open, then rename via pencil & save again!
    await evalIn(swSession, `globalThis.__saveshotResetRamForTest()`);

    const saveAfterSwIdleCheck = await evalIn(
      editorSession,
      `(async () => {
        document.getElementById('rename-pencil-btn').click();
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

    // 5D. Signed-In Popup Pixel-Perfect Alignment, Slim Split Footer, & Live Cross-Tab Theme Sync
    await cdp.send('Page.reload', {}, extPageSession);
    for (let i = 0; i < 25; i += 1) {
      const ready = await evalIn(
        extPageSession,
        `Boolean(document.getElementById('main-view') && !document.getElementById('main-view').hidden)`
      );
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const popupPixelAudit = await evalIn(
      extPageSession,
      `(() => {
        const avatarSlot = document.querySelector('.account-row .icon-slot').getBoundingClientRect();
        const folderSlot = document.querySelector('.folder-row .icon-slot').getBoundingClientRect();
        const emailEl = document.getElementById('user-email');
        const folderNameEl = document.getElementById('folder-chip-name');
        const folderSvg = document.getElementById('folder-icon-svg').getBoundingClientRect();
        const emailRect = emailEl.getBoundingClientRect();
        const folderNameRect = folderNameEl.getBoundingClientRect();

        const regionTile = document.getElementById('capture-region-btn').getBoundingClientRect();
        const visibleTile = document.getElementById('capture-visible-btn').getBoundingClientRect();

        const footer = document.querySelector('.popup-footer');
        const footerRect = footer.getBoundingClientRect();
        const verRect = document.getElementById('popup-version').getBoundingClientRect();
        const bugRect = document.getElementById('footer-bug-btn').getBoundingClientRect();
        const authorEl = document.getElementById('footer-author-link');
        const authorRect = authorEl.getBoundingClientRect();

        const folderExtPath = document.querySelector('#folder-chip .open-ext-icon path')?.getAttribute('d') || '';
        const recentExtPath = document.querySelector('#upload-list a.ss-icon-btn svg path')?.getAttribute('d') || '';

        return {
          slotLeftDiff: Math.abs(avatarSlot.left - folderSlot.left),
          avatarSlotWidth: Math.round(avatarSlot.width),
          folderSlotWidth: Math.round(folderSlot.width),
          labelLeftDiff: Math.abs(emailRect.left - folderNameRect.left),
          folderCenterDiff: Math.abs(
            (folderSvg.top + folderSvg.height / 2) - (folderNameRect.top + folderNameRect.height / 2)
          ),
          folderText: folderNameEl.textContent,
          folderClientH: folderNameEl.clientHeight,
          folderScrollH: folderNameEl.scrollHeight,
          selectAreaFirst: regionTile.left < visibleTile.left,
          tileTopDiff: Math.abs(regionTile.top - visibleTile.top),
          tileHeightDiff: Math.abs(regionTile.height - visibleTile.height),
          footerHeight: Math.round(footerRect.height),
          versionText: document.getElementById('popup-version').textContent.trim(),
          versionBeforeBug: verRect.right < bugRect.left,
          authorLeftOfRightEdge: Math.round(footerRect.right - authorRect.right),
          authorText: authorEl.textContent.trim(),
          authorHref: authorEl.href,
          footerSvgCount: footer.querySelectorAll('svg').length,
          folderExtPath,
          recentExtPath,
        };
      })()`
    );

    assert.ok(popupPixelAudit.slotLeftDiff <= 0.5, 'Avatar and Folder icon slots must share exact X alignment');
    assert.equal(popupPixelAudit.avatarSlotWidth, 18);
    assert.equal(popupPixelAudit.folderSlotWidth, 18);
    assert.ok(popupPixelAudit.labelLeftDiff <= 0.5, 'Email and Folder labels must start at exact same X coordinate');
    assert.ok(
      popupPixelAudit.folderCenterDiff <= 1.25,
      `Folder icon and folder name must align optically (center diff: ${popupPixelAudit.folderCenterDiff}px)`
    );
    assert.equal(popupPixelAudit.folderText, 'Chrome_SaveShot_ScreenShots');
    assert.ok(popupPixelAudit.folderClientH >= 17, 'Folder label must preserve full descender height for underscores');
    assert.ok(
      popupPixelAudit.folderScrollH <= popupPixelAudit.folderClientH + 1,
      'Underscores in folder name must not clip vertically'
    );
    assert.equal(popupPixelAudit.selectAreaFirst, true, 'Select area must sit left of Visible tab');
    assert.ok(popupPixelAudit.tileTopDiff <= 0.5, 'Capture tiles must align horizontally');
    assert.ok(popupPixelAudit.tileHeightDiff <= 0.5, 'Capture tiles must have identical height');
    assert.equal(popupPixelAudit.footerHeight, 25, 'Slim split footer must be 25px tall');
    assert.match(popupPixelAudit.versionText, /^v\d+\.\d+\.\d+$/);
    assert.equal(popupPixelAudit.versionBeforeBug, true, 'Version must appear before Report bug');
    assert.equal(popupPixelAudit.authorText, '@_simplyakm');
    assert.equal(popupPixelAudit.authorHref, 'https://x.com/_simplyakm');
    assert.equal(popupPixelAudit.footerSvgCount, 0, 'Footer must contain zero brand SVG logos');
    assert.ok(popupPixelAudit.folderExtPath.length > 10);
    assert.equal(
      popupPixelAudit.folderExtPath,
      popupPixelAudit.recentExtPath,
      'Folder row and Recent row must use identical external-link box-arrow icon'
    );

    // Toggle Appearance -> Dark in Popup Settings and verify live sync across Popup, Editor, and Welcome tabs
    const themeSyncAudit = await evalIn(
      extPageSession,
      `(async () => {
        document.getElementById('settings-toggle-btn').click();
        document.querySelector('[data-theme-opt="dark"]').click();
        await new Promise((r) => setTimeout(r, 80));
        return {
          popupThemeAttr: document.documentElement.dataset.theme,
          popupBg: getComputedStyle(document.body).backgroundColor,
        };
      })()`
    );
    assert.equal(themeSyncAudit.popupThemeAttr, 'dark');
    assert.equal(themeSyncAudit.popupBg, 'rgb(28, 29, 32)', 'Dark mode must apply neutral graphite #1c1d20');

    const [editorThemeAfter, welcomeSignedInState] = await Promise.all([
      evalIn(editorSession, `document.documentElement.dataset.theme`),
      evalIn(
        welcomeSession,
        `(() => ({
          theme: document.documentElement.dataset.theme,
          unconnected: document.getElementById('status-card').classList.contains('unconnected'),
          dotConnected: document.getElementById('account-dot').classList.contains('connected'),
          heading: document.getElementById('account-heading').textContent.trim(),
        }))()`
      ),
    ]);
    assert.equal(editorThemeAfter, 'dark', 'Open Editor tab must live-sync to dark theme');
    assert.equal(welcomeSignedInState.theme, 'dark', 'Open Welcome tab must live-sync to dark theme');
    assert.equal(
      welcomeSignedInState.unconnected,
      false,
      'Signed-in Welcome status card must drop .unconnected soft blue tint'
    );
    assert.equal(welcomeSignedInState.dotConnected, true, 'Signed-in Welcome status dot must be green');
    assert.equal(welcomeSignedInState.heading, 'Connected as e2e@example.com');

    // Reset Appearance back to Auto
    await evalIn(
      extPageSession,
      `(async () => {
        document.querySelector('[data-theme-opt="auto"]').click();
        await new Promise((r) => setTimeout(r, 60));
      })()`
    );

    // 5E. Region Overlay Full Tab (Enter) Seamless Capture + Real Content-Script Privilege Guard
    await cdp.send('Page.navigate', { url: `${baseUrl}/` }, pageSession);
    await new Promise((r) => setTimeout(r, 350));
    await evalIn(swSession, `chrome.tabs.update(${testTabInfo.tabId}, { active: true })`);

    const startOverlayForEnter = await evalIn(
      extPageSession,
      `new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'START_REGION_CAPTURE', tabId: ${testTabInfo.tabId} }, resolve);
      })`
    );
    assert.equal(startOverlayForEnter.ok, true);

    const hudCheck = await evalIn(
      pageSession,
      `(() => {
        const host = document.getElementById('__saveshot-overlay-host');
        const btn = host?.shadowRoot?.getElementById('full-tab-btn');
        return {
          mounted: Boolean(host),
          fullTabBtnText: btn?.textContent?.replace(/\\s+/g, ' ')?.trim() || '',
        };
      })()`
    );
    assert.equal(hudCheck.mounted, true);
    assert.equal(hudCheck.fullTabBtnText, 'Full tab Enter');

    // Press Enter to capture full visible tab straight from the region overlay
    await cdp.send(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
      pageSession
    );
    await cdp.send(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
      pageSession
    );

    let fullTabToastCheck = null;
    for (let i = 0; i < 30; i += 1) {
      fullTabToastCheck = await evalIn(
        pageSession,
        `(() => {
          const host = document.getElementById('__saveshot-toast-host');
          const title = host?.shadowRoot?.getElementById('title')?.textContent || '';
          const btns = Array.from(host?.shadowRoot?.querySelectorAll('.btn') || []);
          return {
            overlayGone: !document.getElementById('__saveshot-overlay-host'),
            title,
            btnCount: btns.length,
            allBtns32px: btns.length > 0 && btns.every((b) => Math.round(b.getBoundingClientRect().height) === 32),
          };
        })()`
      );
      if (fullTabToastCheck.title.includes('Saved to')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(fullTabToastCheck.overlayGone, true, 'Enter must dismiss region overlay before capture');
    assert.match(fullTabToastCheck.title, /Saved to "Chrome_SaveShot_ScreenShots"/);
    assert.equal(fullTabToastCheck.allBtns32px, true, 'Webpage toast buttons must share 32px unified height');

    const realSenderSecurityCheck = await evalIn(
      swSession,
      `(async () => {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: ${testTabInfo.tabId} },
          func: () =>
            new Promise((resolve) => {
              const host = document.getElementById('__saveshot-toast-host');
              const buttons = Array.from(host?.shadowRoot?.querySelectorAll('button, a') || []).map(
                (el) => el.textContent.trim()
              );
              chrome.runtime.sendMessage({ type: 'SIGN_OUT' }, (res) => {
                chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_FROM_OVERLAY' }, (unauthCap) => {
                  chrome.runtime.sendMessage(
                    {
                      type: 'REGION_SELECTED',
                      selection: {
                        x: 10,
                        y: 10,
                        width: 50,
                        height: 50,
                        viewportWidth: 800,
                        viewportHeight: 600,
                        devicePixelRatio: 1,
                      },
                    },
                    (unauthRegion) => {
                      resolve({ buttons, signOutAttempt: res, unauthCap, unauthRegion });
                    }
                  );
                });
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
    assert.equal(realSenderSecurityCheck.unauthCap.ok, false);
    assert.equal(
      realSenderSecurityCheck.unauthCap.code,
      'NO_ACTIVE_REGION_SESSION',
      'Real Chromium content-script world must not trigger CAPTURE_VISIBLE_FROM_OVERLAY without an active region session'
    );
    assert.equal(realSenderSecurityCheck.unauthRegion.ok, false);
    assert.equal(
      realSenderSecurityCheck.unauthRegion.code,
      'NO_ACTIVE_REGION_SESSION',
      'Real Chromium content-script world must not trigger REGION_SELECTED without an active region session'
    );

    // Verify a brand-new Editor tab also opened automatically right after upload with "Saved to Google Drive"
    let autoOpenedEditorTarget = null;
    for (let i = 0; i < 25; i += 1) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      autoOpenedEditorTarget = targetInfos.find(
        (t) =>
          t.type === 'page' &&
          t.url.includes('/pages/editor.html?session=') &&
          t.targetId !== editorTarget.targetId
      );
      if (autoOpenedEditorTarget) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(autoOpenedEditorTarget, 'Editor tab must open automatically in a new tab right after upload');

    const { sessionId: autoEditorSession } = await cdp.send('Target.attachToTarget', {
      targetId: autoOpenedEditorTarget.targetId,
      flatten: true,
    });
    let autoEditorState = null;
    for (let i = 0; i < 25; i += 1) {
      autoEditorState = await evalIn(
        autoEditorSession,
        `(() => {
          const wrap = document.getElementById('canvas-wrap');
          const status = document.getElementById('status-pill');
          const unsaved = document.getElementById('unsaved-pill');
          return {
            ready: Boolean(wrap && !wrap.hidden),
            statusText: status && !status.hidden ? status.textContent.trim() : '',
            unsavedHidden: Boolean(unsaved && unsaved.hidden),
          };
        })()`
      );
      if (autoEditorState.ready && autoEditorState.statusText.includes('Saved to Google Drive')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(autoEditorState.ready, true);
    assert.match(autoEditorState.statusText, /Saved to Google Drive/);
    assert.equal(autoEditorState.unsavedHidden, true);

    // Battle-test live Text draft unsaved state + Escape, Reset + Undo, beforeunload guard, and Ctrl+S shortcut
    const editorEdgeAudit = await evalIn(
      autoEditorSession,
      `(async () => {
        const unsavedPill = document.getElementById('unsaved-pill');
        const saveBtn = document.getElementById('save-drive-btn');
        const preview = document.getElementById('preview-canvas');
        const rect = preview.getBoundingClientRect();

        const cleanBeforeUnload = !window.dispatchEvent(new Event('beforeunload', { cancelable: true }));

        // 1. Live Text overlay input shows unsaved pill while typing, and hides on Escape
        document.querySelector('[data-tool="text"]').click();
        await new Promise((r) => setTimeout(r, 15));
        preview.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: rect.left + 24, clientY: rect.top + 24 }));
        await new Promise((r) => setTimeout(r, 15));
        const txt = document.getElementById('text-overlay-input');
        const emptyTextUnsavedHidden = unsavedPill.hidden;
        txt.value = 'Draft note';
        txt.dispatchEvent(new Event('input', { bubbles: true }));
        const typingShowsUnsaved = !unsavedPill.hidden && !saveBtn.disabled;
        txt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const escHidesUnsaved = unsavedPill.hidden && saveBtn.disabled;

        // 2. Draw box -> Reset hides unsaved pill -> Undo of Reset re-shows unsaved pill -> Reset again
        document.querySelector('[data-tool="box"]').click();
        await new Promise((r) => setTimeout(r, 15));
        preview.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: rect.left + 10, clientY: rect.top + 10 }));
        preview.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: rect.left + 60, clientY: rect.top + 50 }));
        preview.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: rect.left + 60, clientY: rect.top + 50 }));
        await new Promise((r) => setTimeout(r, 35));
        const dirtyAfterBox = !unsavedPill.hidden;

        document.getElementById('reset-btn').click();
        await new Promise((r) => setTimeout(r, 35));
        const cleanAfterReset = unsavedPill.hidden && saveBtn.disabled;

        document.getElementById('undo-btn').click();
        await new Promise((r) => setTimeout(r, 35));
        const dirtyAfterUndoReset = !unsavedPill.hidden && !saveBtn.disabled;

        document.getElementById('undo-btn').click();
        await new Promise((r) => setTimeout(r, 35));
        const cleanAtStart = unsavedPill.hidden && saveBtn.disabled;

        // 3. Rename-only change triggers beforeunload guard AND Ctrl+S opens Replace confirmation modal
        document.getElementById('rename-pencil-btn').click();
        const fnInput = document.getElementById('filename-input');
        fnInput.value = 'Renamed_Guard_Check';
        const dirtyBeforeUnload = !window.dispatchEvent(new Event('beforeunload', { cancelable: true }));

        const ctrlSEvent = new KeyboardEvent('keydown', {
          key: 's',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        });
        window.dispatchEvent(ctrlSEvent);
        await new Promise((r) => setTimeout(r, 25));
        const dlg = document.getElementById('confirm-replace-dialog');
        const ctrlSPrevented = ctrlSEvent.defaultPrevented;
        const ctrlSOpenedModal = dlg.open;
        document.getElementById('cancel-replace-btn').click();

        return {
          cleanBeforeUnload,
          emptyTextUnsavedHidden,
          typingShowsUnsaved,
          escHidesUnsaved,
          dirtyAfterBox,
          cleanAfterReset,
          dirtyAfterUndoReset,
          cleanAtStart,
          dirtyBeforeUnload,
          ctrlSPrevented,
          ctrlSOpenedModal,
        };
      })()`
    );
    assert.equal(editorEdgeAudit.cleanBeforeUnload, false, 'Clean editor must not trigger beforeunload prompt');
    assert.equal(editorEdgeAudit.emptyTextUnsavedHidden, true);
    assert.equal(editorEdgeAudit.typingShowsUnsaved, true, 'Typing text annotation must immediately show unsaved notification');
    assert.equal(editorEdgeAudit.escHidesUnsaved, true, 'Pressing Escape on text annotation must hide unsaved notification');
    assert.equal(editorEdgeAudit.dirtyAfterBox, true);
    assert.equal(editorEdgeAudit.cleanAfterReset, true, 'Reset to original must clear unsaved notification');
    assert.equal(editorEdgeAudit.dirtyAfterUndoReset, true, 'Undoing Reset must restore unsaved notification');
    assert.equal(editorEdgeAudit.cleanAtStart, true);
    assert.equal(editorEdgeAudit.dirtyBeforeUnload, true, 'Rename-only change must protect tab with beforeunload');
    assert.equal(editorEdgeAudit.ctrlSPrevented, true, 'Ctrl+S must prevent native Save Webpage As dialog');
    assert.equal(editorEdgeAudit.ctrlSOpenedModal, true, 'Ctrl+S must trigger Save action when dirty');

    // Battle-test unassigned Chrome shortcuts fallback on Welcome page ("Not set" + hint visible)
    await cdp.send('Page.enable', {}, welcomeSession);
    await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `
          if (chrome?.commands) {
            chrome.commands.getAll = (cb) => cb([
              { name: 'capture-region', shortcut: '' },
              { name: 'capture-visible', shortcut: '' },
            ]);
          }
        `,
      },
      welcomeSession
    );
    await cdp.send('Page.reload', {}, welcomeSession);
    await new Promise((r) => setTimeout(r, 250));
    const unsetWelcomeAudit = await evalIn(
      welcomeSession,
      `(() => ({
        regionText: document.getElementById('shortcut-region')?.textContent?.trim(),
        visibleText: document.getElementById('shortcut-visible')?.textContent?.trim(),
        hintVisible: !document.getElementById('shortcut-unset-hint')?.hidden,
      }))()`
    );
    assert.equal(unsetWelcomeAudit.regionText, 'Not set');
    assert.equal(unsetWelcomeAudit.visibleText, 'Not set');
    assert.equal(unsetWelcomeAudit.hintVisible, true, 'Welcome page must reveal hint when shortcuts are unassigned');

    // Verify signing out from Popup revokes Google OAuth grant, clears Recent history, and live-syncs open Welcome tab
    const signOutAudit = await evalIn(
      extPageSession,
      `(async () => {
        document.getElementById('sign-out-btn').click();
        for (let i = 0; i < 25; i += 1) {
          const signedOutVisible = !document.getElementById('signed-out-view').hidden;
          if (signedOutVisible) {
            const { recentUploads } = await chrome.storage.local.get('recentUploads');
            return {
              signedOutVisible: true,
              storedCount: (recentUploads || []).length,
              domItems: document.getElementById('upload-list').children.length,
            };
          }
          await new Promise((r) => setTimeout(r, 80));
        }
        return { signedOutVisible: false };
      })()`
    );
    assert.equal(signOutAudit.signedOutVisible, true);
    assert.equal(signOutAudit.storedCount, 0, 'Signing out must clear recentUploads in storage');
    assert.equal(signOutAudit.domItems, 0, 'Signing out must clear rendered Recent items in popup');

    const e2eRevoked = await evalIn(
      swSession,
      `globalThis.__e2eDriveCalls.some((c) => c.method === 'POST' && c.url.includes('oauth2.googleapis.com/revoke?token=e2e-mock-token'))`
    );
    assert.equal(e2eRevoked, true, 'Signing out in Chromium must revoke OAuth token at oauth2.googleapis.com/revoke');

    let welcomeSignedOutState = { heading: '', unconnected: false };
    for (let i = 0; i < 20; i += 1) {
      welcomeSignedOutState = await evalIn(
        welcomeSession,
        `(() => ({
          heading: document.getElementById('account-heading')?.textContent?.trim() || '',
          unconnected: Boolean(document.getElementById('status-card')?.classList.contains('unconnected')),
        }))()`
      );
      if (welcomeSignedOutState.heading === 'Autosave to your Google Drive') break;
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.equal(
      welcomeSignedOutState.heading,
      'Autosave to your Google Drive',
      'Open Welcome tab must live-sync to disconnected state after popup Sign out'
    );
    assert.equal(
      welcomeSignedOutState.unconnected,
      true,
      'Open Welcome tab must restore .unconnected soft blue tint after Sign out'
    );

    // 5F. Signed-Out Editor Live Sync, Logged-Out Unsaved Warning Suppression, Help Button, & Local Capture -> Save to Google Drive Upgrade
    let signedOutEditorSync = null;
    for (let i = 0; i < 20; i += 1) {
      signedOutEditorSync = await evalIn(
        autoEditorSession,
        `(() => {
          const saveBtn = document.getElementById('save-drive-btn');
          return {
            saveLabel: saveBtn.textContent.trim(),
            saveDisabled: saveBtn.disabled,
            unsavedHidden: document.getElementById('unsaved-pill').hidden,
            openHidden: document.getElementById('open-drive-link').hidden,
            copyHidden: document.getElementById('copy-link-btn').hidden,
            beforeUnloadBlocked: !window.dispatchEvent(new Event('beforeunload', { cancelable: true })),
          };
        })()`
      );
      if (signedOutEditorSync.saveLabel === 'Save to Google Drive') break;
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.equal(
      signedOutEditorSync.saveLabel,
      'Save to Google Drive',
      'Open Editor tab must live-sync button to Save to Google Drive on Sign out'
    );
    assert.equal(signedOutEditorSync.saveDisabled, false, 'Save to Google Drive must stay enabled while signed out');
    assert.equal(signedOutEditorSync.unsavedHidden, true, 'Unsaved changes pill must stay hidden when signed out');
    assert.equal(signedOutEditorSync.openHidden, true, 'Open in Drive icon must hide when signed out');
    assert.equal(signedOutEditorSync.copyHidden, true, 'Copy link button must hide when signed out');
    assert.equal(
      signedOutEditorSync.beforeUnloadBlocked,
      false,
      'Tab close beforeunload prompt must NEVER fire when signed out'
    );

    // Clicking Help in Editor opens pages/welcome.html in a new tab
    const welcomeCountBefore = (await cdp.send('Target.getTargets')).targetInfos.filter(
      (t) => t.type === 'page' && t.url.endsWith('/pages/welcome.html')
    ).length;
    await evalIn(autoEditorSession, `document.getElementById('editor-help-btn').click()`);
    let welcomeCountAfter = welcomeCountBefore;
    for (let i = 0; i < 20; i += 1) {
      welcomeCountAfter = (await cdp.send('Target.getTargets')).targetInfos.filter(
        (t) => t.type === 'page' && t.url.endsWith('/pages/welcome.html')
      ).length;
      if (welcomeCountAfter > welcomeCountBefore) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.equal(welcomeCountAfter, welcomeCountBefore + 1, 'Editor Help button must open pages/welcome.html');

    // Capture Visible Tab while signed out -> opens brand-new local Editor tab -> click Save to Google Drive -> signs in, uploads, and live-syncs Popup!
    await evalIn(swSession, `chrome.tabs.update(${testTabInfo.tabId}, { active: true })`);
    const knownEditorIds = new Set(
      (await cdp.send('Target.getTargets')).targetInfos
        .filter((t) => t.type === 'page' && t.url.includes('/pages/editor.html?session='))
        .map((t) => t.targetId)
    );
    const localCapRes = await evalIn(
      extPageSession,
      `new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE', tabId: ${testTabInfo.tabId} }, resolve);
      })`
    );
    assert.equal(localCapRes.ok, true);
    assert.equal(localCapRes.openedEditor, true, 'Capturing while signed out must open local Editor directly');

    let localEditorTarget = null;
    for (let i = 0; i < 25; i += 1) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      localEditorTarget = targetInfos.find(
        (t) =>
          t.type === 'page' &&
          t.url.includes(`/pages/editor.html?session=${localCapRes.sessionId}`) &&
          !knownEditorIds.has(t.targetId)
      );
      if (localEditorTarget) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.ok(localEditorTarget, 'Signed-out local capture must open Editor tab');

    const { sessionId: localEditorSession } = await cdp.send('Target.attachToTarget', {
      targetId: localEditorTarget.targetId,
      flatten: true,
    });
    for (let i = 0; i < 25; i += 1) {
      const ready = await evalIn(
        localEditorSession,
        `Boolean(document.getElementById('canvas-wrap') && !document.getElementById('canvas-wrap').hidden)`
      );
      if (ready) break;
      await new Promise((r) => setTimeout(r, 80));
    }

    const upgradedFromEditor = await evalIn(
      localEditorSession,
      `(async () => {
        const saveBtn = document.getElementById('save-drive-btn');
        const initialLabel = saveBtn.textContent.trim();
        const initialEnabled = !saveBtn.disabled;

        // Draw an arrow while signed out -> verify unsaved-pill STILL stays hidden
        document.querySelector('[data-tool="arrow"]').click();
        const preview = document.getElementById('preview-canvas');
        const rect = preview.getBoundingClientRect();
        preview.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: rect.left + 15, clientY: rect.top + 15 }));
        preview.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, pointerId: 1, clientX: rect.left + 70, clientY: rect.top + 55 }));
        preview.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, clientX: rect.left + 70, clientY: rect.top + 55 }));
        await new Promise((r) => setTimeout(r, 35));
        const unsavedWhileSignedOut = !document.getElementById('unsaved-pill').hidden;

        // Click Save to Google Drive -> triggers signIn + upload
        saveBtn.click();
        for (let i = 0; i < 30; i += 1) {
          const pill = document.getElementById('status-pill');
          if (!pill.hidden && pill.textContent.includes('Saved to Google Drive')) {
            return {
              ok: true,
              initialLabel,
              initialEnabled,
              unsavedWhileSignedOut,
              afterLabel: saveBtn.textContent.trim(),
              afterDisabled: saveBtn.disabled,
              openVisible: !document.getElementById('open-drive-link').hidden,
              copyVisible: !document.getElementById('copy-link-btn').hidden,
            };
          }
          await new Promise((r) => setTimeout(r, 80));
        }
        return { ok: false, pillText: document.getElementById('status-pill').textContent };
      })()`
    );
    assert.equal(upgradedFromEditor.ok, true, `Expected Saved to Google Drive after Editor upgrade, got: ${upgradedFromEditor.pillText}`);
    assert.equal(upgradedFromEditor.initialLabel, 'Save to Google Drive');
    assert.equal(upgradedFromEditor.initialEnabled, true);
    assert.equal(upgradedFromEditor.unsavedWhileSignedOut, false, 'Drawing while signed out must never show unsaved warning');
    assert.equal(upgradedFromEditor.afterLabel, 'Save', 'Primary button must become Save once connected and uploaded');
    assert.equal(upgradedFromEditor.afterDisabled, true, 'Save must disable until next edit once uploaded');
    assert.equal(upgradedFromEditor.openVisible, true, 'Open in Google Drive icon must appear beside pencil after upload');
    assert.equal(upgradedFromEditor.copyVisible, true, 'Copy link button must appear after upload');

    // Open Popup tab also live-synced to Signed-In view with Account card + Recent upload!
    let popupLiveSignedIn = null;
    for (let i = 0; i < 20; i += 1) {
      popupLiveSignedIn = await evalIn(
        extPageSession,
        `(() => ({
          signedOutHidden: document.getElementById('signed-out-view').hidden,
          accountVisible: !document.getElementById('account-folder-card').hidden,
          recentVisible: !document.getElementById('recent-section').hidden,
          recentItems: document.getElementById('upload-list').children.length,
        }))()`
      );
      if (popupLiveSignedIn.accountVisible && popupLiveSignedIn.recentItems > 0) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.equal(popupLiveSignedIn.signedOutHidden, true);
    assert.equal(popupLiveSignedIn.accountVisible, true, 'Popup must live-sync to signed-in Account card after Editor sign-in');
    assert.equal(popupLiveSignedIn.recentVisible, true, 'Popup must reveal Recent section after Editor sign-in');
    assert.equal(popupLiveSignedIn.recentItems, 1, 'Upgraded screenshot must appear in Popup Recent list');

    // -------------------------------------------------------------------------
    // 6. Real Chromium v1.2.1 E2E: Instant Editor Open + Parallel Background Drive Upload,
    //    In-Flight Edit Race, In-Flight Save Deduplication, Failure Recovery, & "Only upload when I click Save"
    // -------------------------------------------------------------------------
    await evalIn(
      swSession,
      `(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({
          settings: { ...settings, autoCopyMode: 'link', autoCopyLink: true, editBeforeUpload: false },
        });
        globalThis.__v121PostCount = 0;
        globalThis.__v121PatchCalls = [];
        globalThis.__v121PostGate = null;
        globalThis.__v121FailNextPost = false;

        globalThis.__v121ArmGate = () => {
          let resolve;
          const promise = new Promise((r) => { resolve = r; });
          globalThis.__v121PostGate = { promise, resolve };
        };
        globalThis.__v121ReleaseGate = () => {
          const g = globalThis.__v121PostGate;
          globalThis.__v121PostGate = null;
          if (g) g.resolve();
        };

        const baseFetch = globalThis.fetch.bind(globalThis);
        globalThis.fetch = async (url, opts = {}) => {
          const u = String(url);
          const method = opts.method || 'GET';

          if (method === 'POST' && u.includes('/upload/drive/v3/files')) {
            if (globalThis.__v121PostGate) {
              const gate = globalThis.__v121PostGate;
              await gate.promise;
            }
            if (globalThis.__v121FailNextPost) {
              globalThis.__v121FailNextPost = false;
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
            globalThis.__v121PostCount += 1;
            const id = 'v121_bg_file_' + globalThis.__v121PostCount;
            const bodyText = await opts.body.text();
            const m = bodyText.match(/"name":"([^"]+)"/);
            return new Response(
              JSON.stringify({
                id,
                name: m ? m[1] : 'BgShot_' + globalThis.__v121PostCount + '.png',
                webViewLink: 'https://drive.google.com/file/d/' + id + '/view',
                createdTime: new Date().toISOString(),
              }),
              { status: 200 }
            );
          }

          if (method === 'PATCH' && (u.includes('/upload/drive/v3/files/') || u.includes('/drive/v3/files/'))) {
            const parts = u.split('/files/');
            const id = parts[1].split('?')[0];
            let name = 'Patched.png';
            if (u.includes('/upload/')) {
              const bodyText = await opts.body.text();
              const m = bodyText.match(/"name":"([^"]+)"/);
              if (m) name = m[1];
            } else {
              name = JSON.parse(opts.body).name;
            }
            globalThis.__v121PatchCalls.push({ id, url: u, name });
            return new Response(
              JSON.stringify({
                id,
                name,
                webViewLink: 'https://drive.google.com/file/d/' + id + '/view',
                modifiedTime: new Date().toISOString(),
              }),
              { status: 200 }
            );
          }

          return baseFetch(url, opts);
        };
      })()`
    );

    const openAndAttachNewEditor = async (captureExpr) => {
      await evalIn(swSession, `chrome.tabs.update(${testTabInfo.tabId}, { active: true })`);
      const beforeIds = new Set(
        (await cdp.send('Target.getTargets')).targetInfos
          .filter((t) => t.type === 'page' && t.url.includes('/pages/editor.html?session='))
          .map((t) => t.targetId)
      );
      const capRes = await evalIn(extPageSession, captureExpr);
      let newTarget = null;
      for (let i = 0; i < 30; i += 1) {
        const { targetInfos } = await cdp.send('Target.getTargets');
        newTarget = targetInfos.find(
          (t) =>
            t.type === 'page' &&
            t.url.includes(`/pages/editor.html?session=${capRes.sessionId}`) &&
            !beforeIds.has(t.targetId)
        );
        if (newTarget) break;
        await new Promise((r) => setTimeout(r, 60));
      }
      assert.ok(newTarget, 'New Editor tab must open immediately');
      const { sessionId: edSess } = await cdp.send('Target.attachToTarget', {
        targetId: newTarget.targetId,
        flatten: true,
      });
      for (let i = 0; i < 30; i += 1) {
        const ready = await evalIn(
          edSess,
          `Boolean(document.getElementById('canvas-wrap') && !document.getElementById('canvas-wrap').hidden)`
        );
        if (ready) break;
        await new Promise((r) => setTimeout(r, 60));
      }
      return { capRes, targetId: newTarget.targetId, edSess };
    };

    // 6A. Instant Editor Open + Live Status Sync ("Uploading to Google Drive..." -> "Saved to Google Drive · Link copied")
    await evalIn(swSession, `globalThis.__v121ArmGate()`);
    const instantCase = await openAndAttachNewEditor(
      `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE', tabId: ${testTabInfo.tabId} }, resolve))`
    );
    assert.equal(instantCase.capRes.ok, true);
    assert.equal(instantCase.capRes.openedEditor, true);
    assert.equal(instantCase.capRes.uploadingInBackground, true);

    const inFlightState6A = await evalIn(
      instantCase.edSess,
      `(() => {
        window.__e2eCopiedLink = '';
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (text) => { window.__e2eCopiedLink = text; },
            write: async () => {},
          },
        });
        const pill = document.getElementById('status-pill');
        return {
          pillVisible: !pill.hidden,
          pillText: pill.textContent.trim(),
          saveDisabled: document.getElementById('save-drive-btn').disabled,
          copyLinkHidden: document.getElementById('copy-link-btn').hidden,
          openDriveHidden: document.getElementById('open-drive-link').hidden,
          copyImageEnabled: !document.getElementById('copy-image-btn').disabled,
          downloadEnabled: !document.getElementById('download-btn').disabled,
        };
      })()`
    );
    assert.equal(inFlightState6A.pillVisible, true);
    assert.equal(inFlightState6A.pillText, 'Uploading to Google Drive...');
    assert.equal(inFlightState6A.saveDisabled, true);
    assert.equal(inFlightState6A.copyLinkHidden, true);
    assert.equal(inFlightState6A.openDriveHidden, true);
    assert.equal(inFlightState6A.copyImageEnabled, true);
    assert.equal(inFlightState6A.downloadEnabled, true);

    await evalIn(swSession, `globalThis.__v121ReleaseGate()`);
    let settled6A = null;
    for (let i = 0; i < 30; i += 1) {
      settled6A = await evalIn(
        instantCase.edSess,
        `(() => ({
          pillText: document.getElementById('status-pill').textContent.trim(),
          copiedLink: window.__e2eCopiedLink || '',
          copyLinkVisible: !document.getElementById('copy-link-btn').hidden,
          openDriveVisible: !document.getElementById('open-drive-link').hidden,
          openDriveHref: document.getElementById('open-drive-link').href,
          saveDisabled: document.getElementById('save-drive-btn').disabled,
          unsavedHidden: document.getElementById('unsaved-pill').hidden,
        }))()`
      );
      if (settled6A.pillText.includes('Saved to Google Drive') && settled6A.copyLinkVisible) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.equal(settled6A.pillText, 'Saved to Google Drive \u00b7 Link copied');
    assert.equal(settled6A.copiedLink, 'https://drive.google.com/file/d/v121_bg_file_1/view');
    assert.equal(settled6A.copyLinkVisible, true);
    assert.equal(settled6A.openDriveVisible, true);
    assert.equal(settled6A.openDriveHref, 'https://drive.google.com/file/d/v121_bg_file_1/view');
    assert.equal(settled6A.saveDisabled, true);
    assert.equal(settled6A.unsavedHidden, true);
    await cdp.send('Target.closeTarget', { targetId: instantCase.targetId });

    // 6B. In-Flight Edit Race: draw + rename while uploading -> upload succeeds -> preserves dirty state & shows "Unsaved changes · Click Save"
    await evalIn(swSession, `globalThis.__v121ArmGate()`);
    const editRaceCase = await openAndAttachNewEditor(
      `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE', tabId: ${testTabInfo.tabId} }, resolve))`
    );

    const duringEdit6B = await evalIn(
      editRaceCase.edSess,
      `(async () => {
        document.querySelector('[data-tool="arrow"]').click();
        const preview = document.getElementById('preview-canvas');
        const rect = preview.getBoundingClientRect();
        preview.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 3, clientX: rect.left + 14, clientY: rect.top + 14 }));
        preview.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, pointerId: 3, clientX: rect.left + 80, clientY: rect.top + 60 }));
        preview.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 3, clientX: rect.left + 80, clientY: rect.top + 60 }));
        await new Promise((r) => setTimeout(r, 35));

        document.getElementById('rename-pencil-btn').click();
        const fnInput = document.getElementById('filename-input');
        fnInput.value = 'InFlight_Edited_Title';
        fnInput.dispatchEvent(new Event('blur'));

        return {
          pillWhileUploading: document.getElementById('status-pill').textContent.trim(),
          saveEnabledWhileUploading: !document.getElementById('save-drive-btn').disabled,
          displayStem: document.getElementById('filename-display').textContent.trim(),
        };
      })()`
    );
    assert.equal(duringEdit6B.pillWhileUploading, 'Uploading to Google Drive...');
    assert.equal(duringEdit6B.saveEnabledWhileUploading, true);
    assert.equal(duringEdit6B.displayStem, 'InFlight_Edited_Title');

    await evalIn(swSession, `globalThis.__v121ReleaseGate()`);
    let settled6B = null;
    for (let i = 0; i < 30; i += 1) {
      settled6B = await evalIn(
        editRaceCase.edSess,
        `(() => ({
          copyLinkVisible: !document.getElementById('copy-link-btn').hidden,
          openDriveVisible: !document.getElementById('open-drive-link').hidden,
          statusPillHidden: document.getElementById('status-pill').hidden,
          unsavedVisible: !document.getElementById('unsaved-pill').hidden,
          unsavedText: document.getElementById('unsaved-pill').textContent.replace(/\\s+/g, ' ').trim(),
          displayStem: document.getElementById('filename-display').textContent.trim(),
          saveEnabled: !document.getElementById('save-drive-btn').disabled,
        }))()`
      );
      if (settled6B.copyLinkVisible && settled6B.unsavedVisible) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.equal(settled6B.copyLinkVisible, true, 'Copy link must reveal once initial upload finishes');
    assert.equal(settled6B.openDriveVisible, true, 'Open in Google Drive must reveal once initial upload finishes');
    assert.equal(settled6B.statusPillHidden, true, 'Saved pill must not hide user dirty state');
    assert.equal(settled6B.unsavedVisible, true, 'Unsaved changes pill must appear when user edited while uploading');
    assert.match(settled6B.unsavedText, /Unsaved changes.*Click Save/);
    assert.equal(settled6B.displayStem, 'InFlight_Edited_Title', 'User rename must not be overwritten by background upload completion');
    assert.equal(settled6B.saveEnabled, true);
    await cdp.send('Target.closeTarget', { targetId: editRaceCase.targetId });

    // 6C. In-Flight Save Deduplication: user draws while upload is in flight and clicks Save -> awaits upload then PATCHes exact fileId (0 duplicate Drive files)
    const postsBefore6C = await evalIn(swSession, `globalThis.__v121PostCount`);
    const patchesBefore6C = await evalIn(swSession, `globalThis.__v121PatchCalls.length`);
    await evalIn(swSession, `globalThis.__v121ArmGate()`);
    const dedupCase = await openAndAttachNewEditor(
      `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE', tabId: ${testTabInfo.tabId} }, resolve))`
    );

    const clickedSaveInFlight = await evalIn(
      dedupCase.edSess,
      `(async () => {
        document.querySelector('[data-tool="arrow"]').click();
        const preview = document.getElementById('preview-canvas');
        const rect = preview.getBoundingClientRect();
        preview.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 4, clientX: rect.left + 18, clientY: rect.top + 18 }));
        preview.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, pointerId: 4, clientX: rect.left + 90, clientY: rect.top + 65 }));
        preview.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 4, clientX: rect.left + 90, clientY: rect.top + 65 }));
        await new Promise((r) => setTimeout(r, 35));

        document.getElementById('save-drive-btn').click();
        await new Promise((r) => setTimeout(r, 35));
        return {
          dialogOpen: document.getElementById('confirm-replace-dialog').open,
          pillText: document.getElementById('status-pill').textContent.trim(),
        };
      })()`
    );
    assert.equal(clickedSaveInFlight.dialogOpen, false, 'Saving while initial upload is in flight should not block on Replace modal');
    assert.equal(clickedSaveInFlight.pillText, 'Saving to Google Drive...');

    // Verify zero PATCH calls have fired while initial POST is still held by gate
    const patchesWhileHeld = await evalIn(swSession, `globalThis.__v121PatchCalls.length`);
    assert.equal(patchesWhileHeld, patchesBefore6C);

    await evalIn(swSession, `globalThis.__v121ReleaseGate()`);
    let settled6C = null;
    for (let i = 0; i < 35; i += 1) {
      settled6C = await evalIn(
        dedupCase.edSess,
        `(() => ({
          pillText: document.getElementById('status-pill').textContent.trim(),
          saveDisabled: document.getElementById('save-drive-btn').disabled,
          copyLinkVisible: !document.getElementById('copy-link-btn').hidden,
          openHref: document.getElementById('open-drive-link').href,
        }))()`
      );
      if (settled6C.pillText.includes('Replaced in Google Drive')) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.match(settled6C.pillText, /Replaced in Google Drive/);
    assert.equal(settled6C.saveDisabled, true);
    assert.equal(settled6C.copyLinkVisible, true);

    const driveCounts6C = await evalIn(
      swSession,
      `({ posts: globalThis.__v121PostCount, patches: globalThis.__v121PatchCalls })`
    );
    assert.equal(driveCounts6C.posts, postsBefore6C + 1, 'Must create strictly 1 Drive file (zero duplicates)');
    assert.equal(driveCounts6C.patches.length, patchesBefore6C + 1, 'Must PATCH that exact fileId once');
    assert.equal(driveCounts6C.patches[driveCounts6C.patches.length - 1].id, `v121_bg_file_${driveCounts6C.posts}`);
    await cdp.send('Target.closeTarget', { targetId: dedupCase.targetId });

    // 6D. Background Upload Failure Recovery: Drive quota full -> Editor keeps PNG open, shows error pill, Retry + Copy image + Download ready -> Retry succeeds
    await evalIn(swSession, `globalThis.__v121FailNextPost = true`);
    const failCase = await openAndAttachNewEditor(
      `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE', tabId: ${testTabInfo.tabId} }, resolve))`
    );

    let failedUi6D = null;
    for (let i = 0; i < 30; i += 1) {
      failedUi6D = await evalIn(
        failCase.edSess,
        `(() => {
          const pill = document.getElementById('status-pill');
          const saveBtn = document.getElementById('save-drive-btn');
          return {
            canvasVisible: !document.getElementById('canvas-wrap').hidden,
            pillVisible: !pill.hidden,
            pillIsErr: pill.classList.contains('err'),
            pillText: pill.textContent.trim(),
            saveLabel: saveBtn.textContent.trim(),
            saveEnabled: !saveBtn.disabled,
            copyImageEnabled: !document.getElementById('copy-image-btn').disabled,
            downloadEnabled: !document.getElementById('download-btn').disabled,
            copyLinkHidden: document.getElementById('copy-link-btn').hidden,
          };
        })()`
      );
      if (failedUi6D.pillIsErr && failedUi6D.saveLabel === 'Retry') break;
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.equal(failedUi6D.canvasVisible, true, 'PNG must stay open in Editor when background upload fails');
    assert.equal(failedUi6D.pillVisible, true);
    assert.equal(failedUi6D.pillIsErr, true);
    assert.match(failedUi6D.pillText, /storage is full/i);
    assert.equal(failedUi6D.saveLabel, 'Retry');
    assert.equal(failedUi6D.saveEnabled, true);
    assert.equal(failedUi6D.copyImageEnabled, true);
    assert.equal(failedUi6D.downloadEnabled, true);
    assert.equal(failedUi6D.copyLinkHidden, true);

    // Click Retry -> uploads cleanly now that Drive recovered
    const retried6D = await evalIn(
      failCase.edSess,
      `(async () => {
        document.getElementById('save-drive-btn').click();
        for (let i = 0; i < 30; i += 1) {
          const pill = document.getElementById('status-pill');
          if (!pill.hidden && pill.textContent.includes('Saved to Google Drive')) {
            return {
              ok: true,
              pillText: pill.textContent.trim(),
              saveLabel: document.getElementById('save-drive-btn').textContent.trim(),
              saveDisabled: document.getElementById('save-drive-btn').disabled,
              copyLinkVisible: !document.getElementById('copy-link-btn').hidden,
              openDriveVisible: !document.getElementById('open-drive-link').hidden,
            };
          }
          await new Promise((r) => setTimeout(r, 60));
        }
        return { ok: false, pillText: document.getElementById('status-pill').textContent.trim() };
      })()`
    );
    assert.equal(retried6D.ok, true, `Retry must succeed after Drive recovers (got: ${retried6D.pillText})`);
    assert.equal(retried6D.saveLabel, 'Save');
    assert.equal(retried6D.saveDisabled, true);
    assert.equal(retried6D.copyLinkVisible, true);
    assert.equal(retried6D.openDriveVisible, true);
    await cdp.send('Target.closeTarget', { targetId: failCase.targetId });

    // 6E. Option B Privacy Toggle ("Only upload when I click Save"): verify UI label in Popup Settings, editBeforeUpload key, and zero background upload until Save
    const toggleAudit = await evalIn(
      extPageSession,
      `(async () => {
        if (document.getElementById('settings-drawer').hidden) {
          document.getElementById('settings-toggle-btn').click();
        }
        const checkbox = document.getElementById('edit-before-upload-checkbox');
        const labelText = checkbox.closest('label').querySelector('.ss-body').textContent.trim();
        checkbox.click();
        await new Promise((r) => setTimeout(r, 80));
        const { settings } = await chrome.storage.local.get('settings');
        return {
          labelText,
          checked: checkbox.checked,
          storedEditBeforeUpload: Boolean(settings?.editBeforeUpload),
        };
      })()`
    );
    assert.equal(toggleAudit.labelText, 'Only upload when I click Save');
    assert.equal(toggleAudit.checked, true);
    assert.equal(toggleAudit.storedEditBeforeUpload, true);

    const postsBeforeManual6E = await evalIn(swSession, `globalThis.__v121PostCount`);
    const manualCase = await openAndAttachNewEditor(
      `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE', tabId: ${testTabInfo.tabId} }, resolve))`
    );
    assert.equal(manualCase.capRes.ok, true);
    assert.equal(manualCase.capRes.openedEditor, true);
    assert.equal(manualCase.capRes.uploadingInBackground, false);

    const manualEditorUi = await evalIn(
      manualCase.edSess,
      `(() => ({
        pillHidden: document.getElementById('status-pill').hidden,
        saveLabel: document.getElementById('save-drive-btn').textContent.trim(),
        saveEnabled: !document.getElementById('save-drive-btn').disabled,
        copyLinkHidden: document.getElementById('copy-link-btn').hidden,
      }))()`
    );
    assert.equal(manualEditorUi.pillHidden, true, 'Manual-save mode must not show Uploading pill');
    assert.equal(manualEditorUi.saveLabel, 'Save');
    assert.equal(manualEditorUi.saveEnabled, true);
    assert.equal(manualEditorUi.copyLinkHidden, true);

    const postsWhileManualOpen = await evalIn(swSession, `globalThis.__v121PostCount`);
    assert.equal(postsWhileManualOpen, postsBeforeManual6E, 'Zero Drive POSTs allowed while Only upload when I click Save is enabled');

    const manualSaveDone = await evalIn(
      manualCase.edSess,
      `(async () => {
        document.getElementById('save-drive-btn').click();
        for (let i = 0; i < 30; i += 1) {
          const pill = document.getElementById('status-pill');
          if (!pill.hidden && pill.textContent.includes('Saved to Google Drive')) {
            return { ok: true, copyLinkVisible: !document.getElementById('copy-link-btn').hidden };
          }
          await new Promise((r) => setTimeout(r, 60));
        }
        return { ok: false };
      })()`
    );
    assert.equal(manualSaveDone.ok, true);
    assert.equal(manualSaveDone.copyLinkVisible, true);
    const postsAfterManualSave = await evalIn(swSession, `globalThis.__v121PostCount`);
    assert.equal(postsAfterManualSave, postsBeforeManual6E + 1);
    await cdp.send('Target.closeTarget', { targetId: manualCase.targetId });

    // -------------------------------------------------------------------------
    // 7. Real Chromium v1.3.0 E2E: Auto-Copy Image Default, Full-Page Capture
    //    (Fixed/Sticky + SPA Inner Scroller + Esc Early Stop), Crop (K),
    //    Pixelate Redaction, Meme Text + Caption Bar, & Ctrl+V Paste Security
    // -------------------------------------------------------------------------
    try {
      await cdp.send('Browser.grantPermissions', {
        origin: `chrome-extension://${extId}`,
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      });
    } catch {
      // Older Chromium builds may not expose all permission enum values
    }

    // 7A. Signed-in Popup Auto-Copy Segmented Control: Link is enabled while signed in, switch to Image (default),
    //     fresh capture auto-copies real PNG to clipboard & settled pill shows "Saved to Google Drive · Image copied",
    //     tab reload does NOT re-copy, and Off skips auto-copy
    const popupSignedInAutoCopy = await evalIn(
      extPageSession,
      `(async () => {
        if (document.getElementById('settings-drawer').hidden) {
          document.getElementById('settings-toggle-btn').click();
        }
        const linkBtn = document.querySelector('#auto-copy-segmented [data-copy-opt="link"]');
        const imgBtn = document.querySelector('#auto-copy-segmented [data-copy-opt="image"]');
        const checkbox = document.getElementById('edit-before-upload-checkbox');
        const linkEnabledWhenSignedIn = !linkBtn.disabled;
        imgBtn.click();
        if (checkbox.checked) checkbox.click();
        await new Promise((r) => setTimeout(r, 100));
        const { settings } = await chrome.storage.local.get('settings');
        return {
          linkEnabledWhenSignedIn,
          imgActive: imgBtn.classList.contains('active'),
          storedAutoCopyMode: settings?.autoCopyMode,
          storedEditBeforeUpload: Boolean(settings?.editBeforeUpload),
        };
      })()`
    );
    assert.equal(popupSignedInAutoCopy.linkEnabledWhenSignedIn, true, 'Auto-copy Link must enable when signed in');
    assert.equal(popupSignedInAutoCopy.imgActive, true);
    assert.equal(popupSignedInAutoCopy.storedAutoCopyMode, 'image');
    assert.equal(popupSignedInAutoCopy.storedEditBeforeUpload, false);

    const autoCopyImgCase = await openAndAttachNewEditor(
      `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE', tabId: ${testTabInfo.tabId} }, resolve))`
    );
    let settled7A = null;
    for (let i = 0; i < 35; i += 1) {
      settled7A = await evalIn(
        autoCopyImgCase.edSess,
        `(async () => {
          let clipboardTypes = [];
          try {
            const items = await navigator.clipboard.read();
            clipboardTypes = items.flatMap((it) => it.types);
          } catch {}
          return {
            pillText: document.getElementById('status-pill').textContent.trim(),
            copyBtnText: document.getElementById('copy-image-btn').textContent.trim(),
            clipboardTypes,
          };
        })()`
      );
      if (settled7A.pillText.includes('Saved to Google Drive')) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.equal(
      settled7A.pillText,
      'Saved to Google Drive \u00b7 Image copied',
      `Default Image auto-copy must not be overwritten by Drive link (got: ${settled7A.pillText})`
    );
    assert.ok(
      settled7A.clipboardTypes.includes('image/png'),
      `Real Chromium clipboard must hold image/png after fresh capture (got: ${JSON.stringify(settled7A.clipboardTypes)})`
    );

    // Reloading Editor tab must NOT re-copy image (single-use isFreshCapture)
    await cdp.send('Page.reload', {}, autoCopyImgCase.edSess);
    let reloadState7A = null;
    for (let i = 0; i < 30; i += 1) {
      try {
        reloadState7A = await evalIn(
          autoCopyImgCase.edSess,
          `(() => ({
            ready: Boolean(document.getElementById('canvas-wrap') && !document.getElementById('canvas-wrap').hidden),
            pillHidden: document.getElementById('status-pill').hidden,
            pillText: document.getElementById('status-pill').textContent.trim(),
            copyBtnText: document.getElementById('copy-image-btn').textContent.trim(),
          }))()`
        );
        if (reloadState7A.ready) break;
      } catch {
        // Reload navigation in progress
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.equal(reloadState7A?.ready, true);
    assert.equal(reloadState7A.copyBtnText, 'Copy image', 'Tab reload must not re-flash Copied!');
    assert.ok(!reloadState7A.pillText.includes('Image copied'), 'Tab reload must not re-copy image');
    await cdp.send('Target.closeTarget', { targetId: autoCopyImgCase.targetId });

    // Switch Auto-copy to Off -> fresh capture settles with plain "Saved to Google Drive"
    await evalIn(
      extPageSession,
      `(async () => {
        document.querySelector('#auto-copy-segmented [data-copy-opt="off"]').click();
        await new Promise((r) => setTimeout(r, 80));
      })()`
    );
    const offCase = await openAndAttachNewEditor(
      `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE', tabId: ${testTabInfo.tabId} }, resolve))`
    );
    let settledOff = null;
    for (let i = 0; i < 30; i += 1) {
      settledOff = await evalIn(
        offCase.edSess,
        `(() => ({ pillText: document.getElementById('status-pill').textContent.trim() }))()`
      );
      if (settledOff.pillText.includes('Saved to Google Drive')) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.equal(settledOff.pillText, 'Saved to Google Drive');
    await cdp.send('Target.closeTarget', { targetId: offCase.targetId });

    // Restore Auto-copy = Image and turn on editBeforeUpload for pure local Editor + Full-Page tests
    await evalIn(
      swSession,
      `(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({
          settings: { ...settings, autoCopyMode: 'image', autoCopyLink: false, editBeforeUpload: true },
        });
      })()`
    );

    // 7B. Real Chromium Full-Page Scrolling Capture:
    //     1) Tall page with position: fixed top header + below-fold position: sticky header + colored bands
    const fpTabInfo = await evalIn(
      swSession,
      `(async () => {
        const tab = await chrome.tabs.create({ url: '${baseUrl}/fullpage', active: true });
        await new Promise((resolve) => {
          const onUpdated = (id, info) => {
            if (id === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(onUpdated);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(onUpdated);
        });
        return { tabId: tab.id, windowId: tab.windowId };
      })()`
    );
    await new Promise((r) => setTimeout(r, 250));

    const openEditorForTab = async (tabId, messageObj) => {
      await evalIn(swSession, `chrome.tabs.update(${tabId}, { active: true })`);
      const beforeIds = new Set(
        (await cdp.send('Target.getTargets')).targetInfos
          .filter((t) => t.type === 'page' && t.url.includes('/pages/editor.html?session='))
          .map((t) => t.targetId)
      );
      const res = await evalIn(
        extPageSession,
        `new Promise((resolve) => chrome.runtime.sendMessage(${JSON.stringify({ ...messageObj, tabId })}, resolve))`
      );
      let newTarget = null;
      for (let i = 0; i < 60; i += 1) {
        const { targetInfos } = await cdp.send('Target.getTargets');
        newTarget = targetInfos.find(
          (t) =>
            t.type === 'page' &&
            t.url.includes('/pages/editor.html?session=') &&
            !beforeIds.has(t.targetId)
        );
        if (newTarget) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(newTarget, 'Expected new Editor tab to open');
      const { sessionId: edSess } = await cdp.send('Target.attachToTarget', {
        targetId: newTarget.targetId,
        flatten: true,
      });
      for (let i = 0; i < 40; i += 1) {
        const ready = await evalIn(
          edSess,
          `Boolean(document.getElementById('canvas-wrap') && !document.getElementById('canvas-wrap').hidden)`
        );
        if (ready) break;
        await new Promise((r) => setTimeout(r, 60));
      }
      return { res, targetId: newTarget.targetId, edSess };
    };

    const fullPageCase = await openEditorForTab(fpTabInfo.tabId, { type: 'CAPTURE_FULLPAGE' });
    assert.equal(fullPageCase.res.ok, true, `Full-page capture failed: ${JSON.stringify(fullPageCase.res)}`);

    const fpAudit = await evalIn(
      fullPageCase.edSess,
      `(() => {
        const canvas = document.getElementById('base-canvas');
        const ctx = canvas.getContext('2d');
        const wrap = document.getElementById('canvas-wrap');
        const rect = canvas.getBoundingClientRect();
        const midX = Math.floor(canvas.width / 2);
        const leftRailX = Math.min(canvas.width - 1, Math.max(10, Math.floor(canvas.width * 0.04)));
        const rightRailX = Math.max(0, Math.floor(canvas.width * 0.96));
        const sampleAt = (x, fracY) => {
          const y = Math.min(canvas.height - 1, Math.max(0, Math.floor(canvas.height * fracY)));
          const d = ctx.getImageData(x, y, 1, 1).data;
          return [d[0], d[1], d[2]];
        };
        const sample = (fracY) => sampleAt(midX, fracY);
        // Find purple sticky band (r>110, g<90, b>180) and verify red fixed header is NOT repeated below y=200
        let foundStickyPurple = false;
        let repeatedFixedRedBelowFold = false;
        for (let y = 0; y < canvas.height; y += 8) {
          const d = ctx.getImageData(midX, y, 1, 1).data;
          if (d[0] > 110 && d[1] < 90 && d[2] > 180) foundStickyPurple = true;
          if (y > 200 && d[0] > 190 && d[1] < 65 && d[2] < 65) repeatedFixedRedBelowFold = true;
        }
        return {
          width: canvas.width,
          height: canvas.height,
          hasTallClass: wrap.classList.contains('tall-canvas'),
          renderedWidth: Math.round(rect.width),
          topHeaderRgb: sample(0.005),
          bandTopRgb: sample(0.18),
          bandMidRgb: sample(0.55),
          bandBotRgb: sample(0.92),
          leftRailTopRgb: sampleAt(leftRailX, 0.05),
          leftRailMidRgb: sampleAt(leftRailX, 0.55),
          leftRailBotRgb: sampleAt(leftRailX, 0.92),
          rightRailTopRgb: sampleAt(rightRailX, 0.05),
          rightRailMidRgb: sampleAt(rightRailX, 0.55),
          rightRailBotRgb: sampleAt(rightRailX, 0.92),
          foundStickyPurple,
          repeatedFixedRedBelowFold,
        };
      })()`
    );
    assert.ok(fpAudit.height > 2000, `Full-page stitched height must exceed 2000px (got ${fpAudit.height})`);
    assert.equal(fpAudit.hasTallClass, true, 'Tall full-page canvas must activate .tall-canvas scrolling mode');
    assert.ok(fpAudit.renderedWidth >= 300, `Tall canvas must remain legible width (got ${fpAudit.renderedWidth}px)`);
    assert.ok(
      fpAudit.topHeaderRgb[0] > 180 && fpAudit.topHeaderRgb[1] < 80,
      `Top fixed header should appear once at top (got rgb=${fpAudit.topHeaderRgb})`
    );
    assert.equal(
      fpAudit.repeatedFixedRedBelowFold,
      false,
      'Fixed header must NOT repeat on scrolled slices'
    );
    assert.equal(
      fpAudit.foundStickyPurple,
      true,
      'Below-the-fold position: sticky header must stay visible in-flow'
    );
    assert.ok(
      fpAudit.leftRailTopRgb[0] > 200 && fpAudit.leftRailTopRgb[1] > 150 && fpAudit.leftRailTopRgb[2] < 50,
      `Left fixed sidebar should appear once in slice 0 (got rgb=${fpAudit.leftRailTopRgb})`
    );
    assert.ok(
      !(fpAudit.leftRailMidRgb[0] > 200 && fpAudit.leftRailMidRgb[1] > 150 && fpAudit.leftRailMidRgb[2] < 50),
      `Left fixed sidebar must NOT repeat on mid slice (got rgb=${fpAudit.leftRailMidRgb})`
    );
    assert.ok(
      !(fpAudit.leftRailBotRgb[0] > 200 && fpAudit.leftRailBotRgb[1] > 150 && fpAudit.leftRailBotRgb[2] < 50),
      `Left fixed sidebar must NOT repeat on bottom slice (got rgb=${fpAudit.leftRailBotRgb})`
    );
    assert.ok(
      fpAudit.rightRailTopRgb[0] > 200 && fpAudit.rightRailTopRgb[1] < 110 && fpAudit.rightRailTopRgb[2] > 120,
      `Right tall sticky sidebar should appear once in slice 0 (got rgb=${fpAudit.rightRailTopRgb})`
    );
    assert.ok(
      !(fpAudit.rightRailMidRgb[0] > 200 && fpAudit.rightRailMidRgb[1] < 110 && fpAudit.rightRailMidRgb[2] > 120),
      `Right tall sticky sidebar must NOT repeat on mid slice (got rgb=${fpAudit.rightRailMidRgb})`
    );
    assert.ok(
      !(fpAudit.rightRailBotRgb[0] > 200 && fpAudit.rightRailBotRgb[1] < 110 && fpAudit.rightRailBotRgb[2] > 120),
      `Right tall sticky sidebar must NOT repeat on bottom slice (got rgb=${fpAudit.rightRailBotRgb})`
    );
    assert.ok(fpAudit.bandTopRgb[2] > 180, `Top cyan band expected (got ${fpAudit.bandTopRgb})`);
    assert.ok(fpAudit.bandMidRgb[1] > 150, `Mid green band expected (got ${fpAudit.bandMidRgb})`);
    assert.ok(fpAudit.bandBotRgb[0] > 200 && fpAudit.bandBotRgb[1] > 80, `Bottom orange band expected (got ${fpAudit.bandBotRgb})`);

    // Verify original /fullpage tab scroll & DOM styles were cleanly restored
    const fpTargets = (await cdp.send('Target.getTargets')).targetInfos;
    const fpPageTarget = fpTargets.find((t) => t.type === 'page' && t.url.endsWith('/fullpage'));
    assert.ok(fpPageTarget);
    const { sessionId: fpPageSess } = await cdp.send('Target.attachToTarget', {
      targetId: fpPageTarget.targetId,
      flatten: true,
    });
    const fpRestored = await evalIn(
      fpPageSess,
      `(() => ({
        scrollY: window.scrollY,
        fixedOpacity: getComputedStyle(document.getElementById('fixed-hdr')).opacity,
        leftRailOpacity: getComputedStyle(document.getElementById('fixed-left-rail')).opacity,
        rightRailOpacity: getComputedStyle(document.getElementById('sticky-right-rail')).opacity,
        rightRailPosition: getComputedStyle(document.getElementById('sticky-right-rail')).position,
        stickyPosition: getComputedStyle(document.getElementById('sticky-hdr')).position,
        pillRemoved: !document.getElementById('__saveshot-fullpage-pill-host'),
        styleRemoved: !document.getElementById('__saveshot-fullpage-style'),
      }))()`
    );
    assert.equal(fpRestored.scrollY, 0, 'Original window scrollY must be restored');
    assert.equal(fpRestored.fixedOpacity, '1', 'Fixed header opacity must be restored');
    assert.equal(fpRestored.leftRailOpacity, '1', 'Fixed left rail opacity must be restored');
    assert.equal(fpRestored.rightRailOpacity, '1', 'Sticky right rail opacity must be restored');
    assert.equal(fpRestored.rightRailPosition, 'sticky', 'Sticky right rail position must be restored');
    assert.equal(fpRestored.stickyPosition, 'sticky', 'Sticky header position must be restored');
    assert.equal(fpRestored.pillRemoved, true, 'Progress pill shadow host must be removed after restore');
    assert.equal(fpRestored.styleRemoved, true, 'Full-page helper style must be removed after restore');
    await cdp.send('Target.closeTarget', { targetId: fullPageCase.targetId });

    //     2) SPA inner scroll container (/spa-scroll)
    const spaTabInfo = await evalIn(
      swSession,
      `(async () => {
        const tab = await chrome.tabs.create({ url: '${baseUrl}/spa-scroll', active: true });
        await new Promise((resolve) => {
          const onUpdated = (id, info) => {
            if (id === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(onUpdated);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(onUpdated);
        });
        return { tabId: tab.id };
      })()`
    );
    await new Promise((r) => setTimeout(r, 200));
    const spaCase = await openEditorForTab(spaTabInfo.tabId, { type: 'CAPTURE_FULLPAGE' });
    assert.equal(spaCase.res.ok, true);
    const spaAudit = await evalIn(
      spaCase.edSess,
      `(() => {
        const canvas = document.getElementById('base-canvas');
        const ctx = canvas.getContext('2d');
        const midX = Math.floor(canvas.width / 2);
        const topPx = ctx.getImageData(midX, Math.floor(canvas.height * 0.1), 1, 1).data;
        const botPx = ctx.getImageData(midX, Math.floor(canvas.height * 0.9), 1, 1).data;
        return { height: canvas.height, topRgb: [topPx[0], topPx[1], topPx[2]], botRgb: [botPx[0], botPx[1], botPx[2]] };
      })()`
    );
    assert.ok(spaAudit.height > 2000, `SPA inner scroll container stitched height must exceed 2000px (got ${spaAudit.height})`);
    assert.ok(spaAudit.topRgb[2] > 180, `SPA top blue band expected (got ${spaAudit.topRgb})`);
    assert.ok(spaAudit.botRgb[0] > 200 && spaAudit.botRgb[1] > 120, `SPA bottom amber band expected (got ${spaAudit.botRgb})`);
    await cdp.send('Target.closeTarget', { targetId: spaCase.targetId });
    await evalIn(swSession, `chrome.tabs.remove(${spaTabInfo.tabId})`);

    //     3) Esc early stop during background: true full-page capture on /fullpage
    await evalIn(swSession, `chrome.tabs.update(${fpTabInfo.tabId}, { active: true })`);
    const beforeEscIds = new Set(
      (await cdp.send('Target.getTargets')).targetInfos
        .filter((t) => t.type === 'page' && t.url.includes('/pages/editor.html?session='))
        .map((t) => t.targetId)
    );
    const escStartRes = await evalIn(
      extPageSession,
      `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'CAPTURE_FULLPAGE', tabId: ${fpTabInfo.tabId}, background: true }, resolve))`
    );
    assert.equal(escStartRes.ok, true);
    assert.equal(escStartRes.started, true);
    await new Promise((r) => setTimeout(r, 220));
    await cdp.send(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      fpPageSess
    );
    await cdp.send(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      fpPageSess
    );

    let escEditorTarget = null;
    for (let i = 0; i < 60; i += 1) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      escEditorTarget = targetInfos.find(
        (t) =>
          t.type === 'page' &&
          t.url.includes('/pages/editor.html?session=') &&
          !beforeEscIds.has(t.targetId)
      );
      if (escEditorTarget) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(escEditorTarget, 'Esc early stop must still open Editor with captured slices');
    const { sessionId: escEdSess } = await cdp.send('Target.attachToTarget', {
      targetId: escEditorTarget.targetId,
      flatten: true,
    });
    for (let i = 0; i < 30; i += 1) {
      const ready = await evalIn(
        escEdSess,
        `Boolean(document.getElementById('canvas-wrap') && !document.getElementById('canvas-wrap').hidden)`
      );
      if (ready) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    const escAudit = await evalIn(
      escEdSess,
      `(() => ({
        height: document.getElementById('base-canvas').height,
        pillText: document.getElementById('status-pill').textContent.trim(),
      }))()`
    );
    assert.ok(escAudit.height > 0 && escAudit.height < fpAudit.height, `Esc early stop should capture partial height (${escAudit.height} < ${fpAudit.height})`);
    assert.match(escAudit.pillText, /Stopped early/i, `Expected Stopped early pill (got: ${escAudit.pillText})`);
    await cdp.send('Target.closeTarget', { targetId: escEditorTarget.targetId });
    await evalIn(swSession, `chrome.tabs.remove(${fpTabInfo.tabId})`);

    // 7C, 7D, 7E: Real Chromium Editor Battle-Test (No-Tool Default + Unselect + Zoom/Pan, Crop K, Pixelate Redaction, Meme Text + Caption Bar, Ctrl+V Paste + SVG XSS)
    const toolsCase = await openAndAttachNewEditor(
      `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE', tabId: ${testTabInfo.tabId} }, resolve))`
    );

    // 7C0. UX Polish: Editor starts with NO tool selected, click-outside/toggle/Esc unselects,
    //      topbar Zoom control, drag-pan when zoomed, scrollbar gutter guard, Ctrl+wheel accumulation,
    //      and live text overlay scaling + Esc cancel under zoom
    const uxPolishAudit = await evalIn(
      toolsCase.edSess,
      `(async () => {
        const preview = document.getElementById('preview-canvas');
        const stage = document.getElementById('stage');
        const wrap = document.getElementById('canvas-wrap');
        const zoomResetBtn = document.getElementById('zoom-reset-btn');
        const zoomInBtn = document.getElementById('zoom-in-btn');
        const zoomOutBtn = document.getElementById('zoom-out-btn');

        // 1. Starts with NO tool selected
        const initialActiveTools = document.querySelectorAll('[data-tool].active').length;
        const initialStyleDimmed = document.getElementById('style-group').classList.contains('dimmed');
        const initialStyleInert = Boolean(document.getElementById('style-group').inert);
        const initialZoomLabel = zoomResetBtn.textContent.trim();
        const initialZoomAria = zoomResetBtn.getAttribute('aria-label') || '';

        // Dragging on canvas with no tool selected draws nothing
        const r0 = preview.getBoundingClientRect();
        preview.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 20, clientX: r0.left + 20, clientY: r0.top + 20 }));
        preview.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, pointerId: 20, clientX: r0.left + 90, clientY: r0.top + 70 }));
        preview.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 20, clientX: r0.left + 90, clientY: r0.top + 70 }));
        await new Promise((r) => setTimeout(r, 40));
        const undoStillDisabledAfterIdleDrag = document.getElementById('undo-btn').disabled;

        // 2. Click tool -> active; click same tool again -> toggles off
        const arrowBtn = document.querySelector('[data-tool="arrow"]');
        arrowBtn.click();
        await new Promise((r) => setTimeout(r, 25));
        const arrowActiveAfterFirstClick = arrowBtn.classList.contains('active');
        arrowBtn.click();
        await new Promise((r) => setTimeout(r, 25));
        const activeAfterToggleOff = document.querySelectorAll('[data-tool].active').length;

        // 3. Click empty stage backdrop -> unselects active tool
        document.querySelector('[data-tool="box"]').click();
        await new Promise((r) => setTimeout(r, 25));
        const sr0 = stage.getBoundingClientRect();
        stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 21, clientX: sr0.left + 6, clientY: sr0.top + 6 }));
        await new Promise((r) => setTimeout(r, 25));
        const activeAfterStageClick = document.querySelectorAll('[data-tool].active').length;

        // 4. Press Escape -> unselects active tool
        arrowBtn.click();
        await new Promise((r) => setTimeout(r, 25));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((r) => setTimeout(r, 25));
        const activeAfterEsc = document.querySelectorAll('[data-tool].active').length;

        // 5. Topbar zoom: Fit -> 100% -> 125% -> 150% -> 200%, pan when zoomed in with no tool selected
        zoomResetBtn.click();
        await new Promise((r) => setTimeout(r, 25));
        const labelAfterActual = zoomResetBtn.textContent.trim();
        const hasZoomedClass = wrap.classList.contains('zoomed-canvas');
        zoomInBtn.click();
        zoomInBtn.click();
        zoomInBtn.click();
        await new Promise((r) => setTimeout(r, 35));
        const labelAt200 = zoomResetBtn.textContent.trim();
        const panCursorAt200 = preview.classList.contains('pan-cursor');

        // Drag-pan canvas at 200% with no tool selected
        stage.scrollLeft = 0;
        stage.scrollTop = 0;
        const rZoom = preview.getBoundingClientRect();
        preview.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 22, clientX: rZoom.left + 200, clientY: rZoom.top + 200 }));
        preview.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, pointerId: 22, clientX: rZoom.left + 120, clientY: rZoom.top + 130 }));
        preview.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 22, clientX: rZoom.left + 120, clientY: rZoom.top + 130 }));
        await new Promise((r) => setTimeout(r, 35));
        const pannedScroll = { left: stage.scrollLeft, top: stage.scrollTop };
        const undoStillDisabledAfterPan = document.getElementById('undo-btn').disabled;

        // 6. Scrollbar gutter click on #stage must NOT unselect active tool
        document.querySelector('[data-tool="box"]').click();
        await new Promise((r) => setTimeout(r, 25));
        const srZoom = stage.getBoundingClientRect();
        stage.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerId: 23,
          clientX: srZoom.left + stage.clientWidth + 2,
          clientY: srZoom.top + 40,
        }));
        await new Promise((r) => setTimeout(r, 25));
        const boxStillActiveAfterScrollbarClick = document.querySelector('[data-tool="box"]').classList.contains('active');

        // 7. Ctrl+wheel: deltaY=0 is no-op; tiny trackpad deltas accumulate until >= 40 -> zooms to 300%
        stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 0, clientX: srZoom.left + 100, clientY: srZoom.top + 100 }));
        const labelAfterZeroWheel = zoomResetBtn.textContent.trim();
        stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -15, clientX: srZoom.left + 100, clientY: srZoom.top + 100 }));
        const labelAfterSmallWheel = zoomResetBtn.textContent.trim();
        stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -30, clientX: srZoom.left + 100, clientY: srZoom.top + 100 }));
        await new Promise((r) => setTimeout(r, 30));
        const labelAfterAccumWheel = zoomResetBtn.textContent.trim();
        const zoomInDisabledAtMax = zoomInBtn.disabled;

        // 8. Text overlay --tsize scales under zoom, keeps focus on zoom click, and Esc cancels without stamping
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
        await new Promise((r) => setTimeout(r, 25));
        const rText = preview.getBoundingClientRect();
        preview.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 24, clientX: rText.left + 120, clientY: rText.top + 120 }));
        await new Promise((r) => setTimeout(r, 35));
        const textInput = document.getElementById('text-overlay-input');
        textInput.value = 'ShouldCancel';
        const tsizeAt300 = parseInt(textInput.style.getPropertyValue('--tsize'), 10);
        zoomOutBtn.click();
        await new Promise((r) => setTimeout(r, 30));
        const tsizeAt200 = parseInt(textInput.style.getPropertyValue('--tsize'), 10);
        const textFocusedAfterZoom = document.activeElement === textInput;
        // Blur input (simulating focus elsewhere) then press Esc on window -> must cancel text, not stamp it
        textInput.blur();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((r) => setTimeout(r, 35));
        const textHiddenAfterEsc = textInput.hidden;
        const undoStillDisabledAfterEscCancel = document.getElementById('undo-btn').disabled;

        // 9. Keyboard zoom 0 -> Fit, 1 -> 100%, + -> 125%, - -> 100%, 0 -> Fit; Esc unselects text tool
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
        const labelAfterKey0 = zoomResetBtn.textContent.trim();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
        const labelAfterKey1 = zoomResetBtn.textContent.trim();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
        const labelAfterKeyPlus = zoomResetBtn.textContent.trim();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true }));
        const labelAfterKeyMinus = zoomResetBtn.textContent.trim();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((r) => setTimeout(r, 25));

        return {
          initialActiveTools,
          initialStyleDimmed,
          initialStyleInert,
          initialZoomLabel,
          initialZoomAria,
          undoStillDisabledAfterIdleDrag,
          arrowActiveAfterFirstClick,
          activeAfterToggleOff,
          activeAfterStageClick,
          activeAfterEsc,
          labelAfterActual,
          hasZoomedClass,
          labelAt200,
          panCursorAt200,
          pannedScroll,
          undoStillDisabledAfterPan,
          boxStillActiveAfterScrollbarClick,
          labelAfterZeroWheel,
          labelAfterSmallWheel,
          labelAfterAccumWheel,
          zoomInDisabledAtMax,
          tsizeAt300,
          tsizeAt200,
          textFocusedAfterZoom,
          textHiddenAfterEsc,
          undoStillDisabledAfterEscCancel,
          labelAfterKey0,
          labelAfterKey1,
          labelAfterKeyPlus,
          labelAfterKeyMinus,
        };
      })()`
    );
    assert.equal(uxPolishAudit.initialActiveTools, 0, 'Fresh editor must start with NO tool selected');
    assert.equal(uxPolishAudit.initialStyleDimmed, true, 'Style controls must be dimmed when no tool is selected');
    assert.equal(uxPolishAudit.initialStyleInert, true, 'Style controls must be inert when no tool is selected');
    assert.equal(uxPolishAudit.initialZoomLabel, 'Fit');
    assert.match(uxPolishAudit.initialZoomAria, /^Zoom: Fit/i);
    assert.equal(uxPolishAudit.undoStillDisabledAfterIdleDrag, true, 'Dragging with no tool selected must not draw');
    assert.equal(uxPolishAudit.arrowActiveAfterFirstClick, true);
    assert.equal(uxPolishAudit.activeAfterToggleOff, 0, 'Clicking active tool again must toggle it off');
    assert.equal(uxPolishAudit.activeAfterStageClick, 0, 'Clicking empty stage backdrop must unselect tool');
    assert.equal(uxPolishAudit.activeAfterEsc, 0, 'Pressing Escape must unselect active tool');
    assert.equal(uxPolishAudit.labelAfterActual, '100%');
    assert.equal(uxPolishAudit.hasZoomedClass, true);
    assert.equal(uxPolishAudit.labelAt200, '200%');
    assert.equal(uxPolishAudit.panCursorAt200, true, 'Zoomed canvas with no tool selected must show grab pan cursor');
    assert.ok(
      uxPolishAudit.pannedScroll.left > 0 || uxPolishAudit.pannedScroll.top > 0,
      `Dragging zoomed canvas with no tool selected must pan stage (got ${JSON.stringify(uxPolishAudit.pannedScroll)})`
    );
    assert.equal(uxPolishAudit.undoStillDisabledAfterPan, true, 'Panning must not mutate canvas or undo stack');
    assert.equal(uxPolishAudit.boxStillActiveAfterScrollbarClick, true, 'Clicking stage scrollbar gutter must NOT unselect active tool');
    assert.equal(uxPolishAudit.labelAfterZeroWheel, '200%', 'Ctrl+wheel with deltaY=0 must be a no-op');
    assert.equal(uxPolishAudit.labelAfterSmallWheel, '200%', 'Small trackpad wheel delta must accumulate before stepping');
    assert.equal(uxPolishAudit.labelAfterAccumWheel, '300%', 'Accumulated Ctrl+wheel must step zoom to 300%');
    assert.equal(uxPolishAudit.zoomInDisabledAtMax, true, 'Zoom in button must disable at max zoom');
    assert.ok(
      uxPolishAudit.tsizeAt300 > uxPolishAudit.tsizeAt200,
      `Text overlay --tsize must scale down when zooming out (${uxPolishAudit.tsizeAt300} > ${uxPolishAudit.tsizeAt200})`
    );
    assert.equal(uxPolishAudit.textFocusedAfterZoom, true, 'Clicking zoom button must refocus active text input');
    assert.equal(uxPolishAudit.textHiddenAfterEsc, true, 'Pressing Esc must cancel open text overlay');
    assert.equal(uxPolishAudit.undoStillDisabledAfterEscCancel, true, 'Cancelled text overlay must NOT be stamped onto canvas');
    assert.equal(uxPolishAudit.labelAfterKey0, 'Fit');
    assert.equal(uxPolishAudit.labelAfterKey1, '100%');
    assert.equal(uxPolishAudit.labelAfterKeyPlus, '125%');
    assert.equal(uxPolishAudit.labelAfterKeyMinus, '100%');

    // 7C. Crop Tool (K): drag -> live W x H -> Enter crops losslessly -> Ctrl+Z restores -> K + Esc exits cleanly
    const cropAudit = await evalIn(
      toolsCase.edSess,
      `(async () => {
        const base = document.getElementById('base-canvas');
        const preview = document.getElementById('preview-canvas');
        const origW = base.width;
        const origH = base.height;

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
        await new Promise((r) => setTimeout(r, 40));
        const cropContextVisible = !document.getElementById('crop-context').hidden;
        const styleDimmed = document.getElementById('style-group').classList.contains('dimmed');
        const styleInert = Boolean(document.getElementById('style-group').inert);
        const applyDisabledBeforeDrag = document.getElementById('apply-crop-btn').disabled;

        const rect = preview.getBoundingClientRect();
        preview.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 10, clientX: rect.left + 40, clientY: rect.top + 30 }));
        preview.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, pointerId: 10, clientX: rect.left + 220, clientY: rect.top + 170 }));
        preview.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 10, clientX: rect.left + 220, clientY: rect.top + 170 }));
        await new Promise((r) => setTimeout(r, 40));

        const dimText = document.getElementById('crop-dim-label').textContent.trim();
        const applyEnabledAfterDrag = !document.getElementById('apply-crop-btn').disabled;

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 80));
        const croppedW = base.width;
        const croppedH = base.height;

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        await new Promise((r) => setTimeout(r, 80));
        const undoneW = base.width;
        const undoneH = base.height;

        // Pressing Esc in Crop with no pending crop exits back to previous tool
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((r) => setTimeout(r, 40));
        const exitedCrop = document.getElementById('crop-context').hidden;

        return {
          origW, origH,
          cropContextVisible, styleDimmed, styleInert, applyDisabledBeforeDrag,
          dimText, applyEnabledAfterDrag,
          croppedW, croppedH,
          undoneW, undoneH,
          exitedCrop,
        };
      })()`
    );
    assert.equal(cropAudit.cropContextVisible, true);
    assert.equal(cropAudit.styleDimmed, true);
    assert.equal(cropAudit.styleInert, true);
    assert.equal(cropAudit.applyDisabledBeforeDrag, true);
    assert.match(cropAudit.dimText, /^Crop \d+ \u00d7 \d+$/);
    assert.equal(cropAudit.applyEnabledAfterDrag, true);
    assert.ok(cropAudit.croppedW < cropAudit.origW && cropAudit.croppedH < cropAudit.origH);
    assert.equal(cropAudit.undoneW, cropAudit.origW);
    assert.equal(cropAudit.undoneH, cropAudit.origH);
    assert.equal(cropAudit.exitedCrop, true, 'Esc in Crop with no selection must exit back to previous tool');

    // 7D. Pixelate Redaction: Solid dims style-group; Pixelate unlocks size-pills while dimming color-swatches;
    //     zero raw corner sliver left after pixelating non-divisible area; Undo restores raw pixel
    const pixelateAudit = await evalIn(
      toolsCase.edSess,
      `(async () => {
        const base = document.getElementById('base-canvas');
        const ctx = base.getContext('2d');
        const preview = document.getElementById('preview-canvas');

        // Paint a clean 60x60 white test patch at (20,20) with a bright red corner secret at (52,52)
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(20, 20, 60, 60);
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(52, 52, 1, 1);

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
        await new Promise((r) => setTimeout(r, 30));
        const solidDimsAll = document.getElementById('style-group').classList.contains('dimmed');

        document.querySelector('[data-redact-mode="pixelate"]').click();
        await new Promise((r) => setTimeout(r, 30));
        const pixStyleNotDimmed = !document.getElementById('style-group').classList.contains('dimmed');
        const pixColorsDimmed = document.getElementById('color-swatches').classList.contains('dimmed');
        const pixColorsInert = Boolean(document.getElementById('color-swatches').inert);
        document.querySelector('#size-pills [data-size="lg"]').click();

        const rect = preview.getBoundingClientRect();
        const sx = rect.width / base.width;
        const sy = rect.height / base.height;
        preview.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 11, clientX: rect.left + 20 * sx, clientY: rect.top + 20 * sy }));
        preview.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, pointerId: 11, clientX: rect.left + 53 * sx, clientY: rect.top + 53 * sy }));
        preview.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 11, clientX: rect.left + 53 * sx, clientY: rect.top + 53 * sy }));
        await new Promise((r) => setTimeout(r, 80));

        const afterPx = Array.from(ctx.getImageData(52, 52, 1, 1).data);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        await new Promise((r) => setTimeout(r, 80));
        const undonePx = Array.from(ctx.getImageData(52, 52, 1, 1).data);

        return {
          solidDimsAll,
          pixStyleNotDimmed,
          pixColorsDimmed,
          pixColorsInert,
          afterPx,
          undonePx,
        };
      })()`
    );
    assert.equal(pixelateAudit.solidDimsAll, true);
    assert.equal(pixelateAudit.pixStyleNotDimmed, true, 'Pixelate must unlock #size-pills');
    assert.equal(pixelateAudit.pixColorsDimmed, true, 'Pixelate must dim #color-swatches');
    assert.equal(pixelateAudit.pixColorsInert, true);
    assert.ok(
      pixelateAudit.afterPx[1] >= 180 && pixelateAudit.afterPx[2] >= 180,
      `Corner secret pixel must be averaged by balanced grid (got rgba=${pixelateAudit.afterPx})`
    );
    assert.ok(
      pixelateAudit.undonePx[0] === 255 && pixelateAudit.undonePx[1] === 0,
      `Undo must restore exact original red pixel (got rgba=${pixelateAudit.undonePx})`
    );

    // 7E. Meme Toolkit (Meme Text + XL + Focus Retention, Dark Caption Bar + Undo, Ctrl+V Paste + Second Paste Stamp + SVG XSS Block + Filename Input Paste Safety)
    const memeAndPasteAudit = await evalIn(
      toolsCase.edSess,
      `(async () => {
        const base = document.getElementById('base-canvas');
        const ctx = base.getContext('2d');
        const preview = document.getElementById('preview-canvas');

        // 1. Meme text + XL + focus retention
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
        await new Promise((r) => setTimeout(r, 30));
        const xlVisibleInText = !document.getElementById('size-xl-btn').hidden;
        const rect = preview.getBoundingClientRect();
        preview.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 12, clientX: rect.left + 80, clientY: rect.top + 80 }));
        await new Promise((r) => setTimeout(r, 40));

        document.querySelector('[data-text-mode="meme"]').click();
        const textInput = document.getElementById('text-overlay-input');
        const memeClassApplied = textInput.classList.contains('meme-style');
        const focusKeptAfterMeme = document.activeElement === textInput;

        document.getElementById('size-xl-btn').click();
        const focusKeptAfterXl = document.activeElement === textInput;
        textInput.value = 'ship it';
        textInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 70));

        // 2. Dark Caption Bar + focus retention + Undo height restore
        const hBeforeCaption = base.height;
        document.getElementById('caption-toggle-btn').click();
        const capInput = document.getElementById('caption-text-input');
        capInput.value = 'WHEN ALL TESTS PASS';
        document.querySelector('[data-caption-theme="dark"]').click();
        const focusKeptAfterCaptionTheme = document.activeElement === capInput;
        document.getElementById('apply-caption-btn').click();
        await new Promise((r) => setTimeout(r, 80));

        const hAfterCaption = base.height;
        const topStripPx = Array.from(ctx.getImageData(4, 4, 1, 1).data);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        await new Promise((r) => setTimeout(r, 80));
        const hAfterCaptionUndo = base.height;

        // Helper to craft synthetic paste events with files
        const dispatchFilePaste = (file) => {
          const dt = new DataTransfer();
          dt.items.add(file);
          const ev = new Event('paste', { bubbles: true, cancelable: true });
          Object.defineProperty(ev, 'clipboardData', { value: dt });
          window.dispatchEvent(ev);
          return ev;
        };

        // 3. SVG XSS paste MUST be blocked
        const svgFile = new File(
          ['<svg xmlns="http://www.w3.org/2000/svg"><script>window.__xss=1</script></svg>'],
          'evil.svg',
          { type: 'image/svg+xml' }
        );
        dispatchFilePaste(svgFile);
        await new Promise((r) => setTimeout(r, 40));
        const svgBlockedPill = document.getElementById('status-pill').textContent.trim();
        const svgOverlayHidden = document.getElementById('paste-context').hidden;

        // Helper to generate a solid color PNG File via offscreen canvas
        const makePngFile = async (color, w, h, name) => {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const cx = c.getContext('2d');
          cx.fillStyle = color;
          cx.fillRect(0, 0, w, h);
          const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
          return new File([blob], name, { type: 'image/png' });
        };

        // 4. Pasting while #filename-input is focused must NOT trigger canvas paste overlay
        const redPng = await makePngFile('#ff0000', 80, 60, 'red.png');
        document.getElementById('rename-pencil-btn').click();
        dispatchFilePaste(redPng);
        await new Promise((r) => setTimeout(r, 50));
        const pasteIgnoredInInput = document.getElementById('paste-context').hidden;
        document.getElementById('filename-input').blur();
        await new Promise((r) => setTimeout(r, 30));

        // 5. Valid PNG paste -> shows paste-context, hides XL, dims style-group;
        //    second PNG paste stamps first onto base-canvas (does NOT delete it!); Enter stamps second
        dispatchFilePaste(redPng);
        await new Promise((r) => setTimeout(r, 80));
        const pasteContextVisible = !document.getElementById('paste-context').hidden;
        const xlHiddenDuringPaste = document.getElementById('size-xl-btn').hidden;
        const styleDimmedDuringPaste = document.getElementById('style-group').classList.contains('dimmed');

        const bluePng = await makePngFile('#0000ff', 40, 40, 'blue.png');
        dispatchFilePaste(bluePng);
        await new Promise((r) => setTimeout(r, 100));
        // Red image was 80x60 centered on canvas; blue overlay (40x40) is preview-only so base-canvas has red pixels!
        const cx = Math.floor(base.width / 2);
        const cy = Math.floor(base.height / 2);
        const stampedFirstPx = Array.from(ctx.getImageData(cx - 30, cy, 1, 1).data);

        // Press Enter to stamp second (blue) image at center
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 80));
        const stampedSecondPx = Array.from(ctx.getImageData(cx, cy, 1, 1).data);
        const pasteContextHiddenAfterStamp = document.getElementById('paste-context').hidden;

        return {
          xlVisibleInText,
          memeClassApplied,
          focusKeptAfterMeme,
          focusKeptAfterXl,
          focusKeptAfterCaptionTheme,
          hBeforeCaption,
          hAfterCaption,
          topStripPx,
          hAfterCaptionUndo,
          svgBlockedPill,
          svgOverlayHidden,
          xssExecuted: Boolean(window.__xss),
          pasteIgnoredInInput,
          pasteContextVisible,
          xlHiddenDuringPaste,
          styleDimmedDuringPaste,
          stampedFirstPx,
          stampedSecondPx,
          pasteContextHiddenAfterStamp,
        };
      })()`
    );
    assert.equal(memeAndPasteAudit.xlVisibleInText, true);
    assert.equal(memeAndPasteAudit.memeClassApplied, true);
    assert.equal(memeAndPasteAudit.focusKeptAfterMeme, true, 'Switching Clean -> Meme must keep text input focused');
    assert.equal(memeAndPasteAudit.focusKeptAfterXl, true, 'Clicking XL size must keep text input focused');
    assert.equal(memeAndPasteAudit.focusKeptAfterCaptionTheme, true, 'Switching Caption theme must keep input focused');
    assert.ok(memeAndPasteAudit.hAfterCaption > memeAndPasteAudit.hBeforeCaption, 'Caption bar must expand canvas height');
    assert.ok(
      memeAndPasteAudit.topStripPx[0] < 40 && memeAndPasteAudit.topStripPx[1] < 40 && memeAndPasteAudit.topStripPx[2] < 40,
      `Dark caption bar top strip must be dark (got rgba=${memeAndPasteAudit.topStripPx})`
    );
    assert.equal(memeAndPasteAudit.hAfterCaptionUndo, memeAndPasteAudit.hBeforeCaption, 'Undo must restore pre-caption height');
    assert.match(memeAndPasteAudit.svgBlockedPill, /SVG images cannot be pasted/i);
    assert.equal(memeAndPasteAudit.svgOverlayHidden, true);
    assert.equal(memeAndPasteAudit.xssExecuted, false);
    assert.equal(memeAndPasteAudit.pasteIgnoredInInput, true, 'Pasting inside filename input must not hijack into canvas overlay');
    assert.equal(memeAndPasteAudit.pasteContextVisible, true);
    assert.equal(memeAndPasteAudit.xlHiddenDuringPaste, true);
    assert.equal(memeAndPasteAudit.styleDimmedDuringPaste, true);
    assert.ok(
      memeAndPasteAudit.stampedFirstPx[0] > 200 && memeAndPasteAudit.stampedFirstPx[2] < 40,
      `Second paste must stamp first red image instead of deleting it (got rgba=${memeAndPasteAudit.stampedFirstPx})`
    );
    assert.ok(
      memeAndPasteAudit.stampedSecondPx[2] > 200 && memeAndPasteAudit.stampedSecondPx[0] < 40,
      `Enter must stamp second blue image (got rgba=${memeAndPasteAudit.stampedSecondPx})`
    );
    assert.equal(memeAndPasteAudit.pasteContextHiddenAfterStamp, true);

    await cdp.send('Target.closeTarget', { targetId: toolsCase.targetId });
  } finally {
    cleanup();
    server.closeAllConnections();
    server.close();
  }
});
