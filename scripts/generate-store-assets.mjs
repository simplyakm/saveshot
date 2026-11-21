import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_COPY } from '../content-source/site-copy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'store-assets');

/**
 * Every extension source file whose visual, structural, icon, or copy changes
 * affect the generated Chrome Web Store promotional tiles and screenshots.
 */
export const ASSET_INPUT_FILES = [
  'manifest.json',
  'content-source/site-copy.mjs',
  'styles/tokens.css',
  'popup/popup.html',
  'popup/popup.css',
  'pages/editor.html',
  'pages/editor.css',
  'lib/editor-core.js',
  'pages/welcome.html',
  'pages/welcome.css',
  'content/selector.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'scripts/generate-store-assets.mjs',
];

export const STORE_ASSET_SPECS = [
  ['store-assets/promo-small-440x280.png', 440, 280],
  ['store-assets/promo-marquee-1400x560.png', 1400, 560],
  ['store-assets/screenshot-1-capture-1280x800.png', 1280, 800],
  ['store-assets/screenshot-2-editor-1280x800.png', 1280, 800],
  ['store-assets/screenshot-3-privacy-1280x800.png', 1280, 800],
  ['store-assets/screenshot-4-themes-1280x800.png', 1280, 800],
  ['store-assets/screenshot-welcome-1280x800.png', 1280, 800],
];

export function sha256File(absPath) {
  return createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

export function computeAssetSourceHashes(baseDir = rootDir) {
  const result = {};
  for (const rel of ASSET_INPUT_FILES) {
    result[rel] = sha256File(path.join(baseDir, rel));
  }
  return result;
}

/**
 * Map system-ui on headless Linux to Google Chrome's native UI font (Roboto)
 * instead of X11 DejaVu Sans, so weights 400 / 500 / 600 / 700 render crisply
 * and match SaveShot's tokens.css typography hierarchy.
 */
const FONT_BRIDGE_CSS = `
  @font-face {
    font-family: 'system-ui';
    src: local('Roboto'), local('Liberation Sans');
    font-weight: 400;
    font-style: normal;
  }
  @font-face {
    font-family: 'system-ui';
    src: local('Roboto Medium'), local('Roboto');
    font-weight: 500;
    font-style: normal;
  }
  @font-face {
    font-family: 'system-ui';
    src: local('Roboto Medium'), local('Roboto Bold'), local('Roboto');
    font-weight: 600;
    font-style: normal;
  }
  @font-face {
    font-family: 'system-ui';
    src: local('Roboto Bold'), local('Liberation Sans Bold'), local('Roboto');
    font-weight: 700;
    font-style: normal;
  }
  @font-face {
    font-family: 'ui-monospace';
    src: local('Liberation Mono'), local('DejaVu Sans Mono');
    font-weight: 400 700;
    font-style: normal;
  }
`;

function createMiniThumbDataUri(accent = '#1a73e8', dark = false) {
  const bg = dark ? '#1e2430' : '#eff4fc';
  const card = dark ? '#2a3140' : '#ffffff';
  const bar = dark ? '#5b9df9' : accent;
  const muted = dark ? '#4b5568' : '#cbd5e1';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="84" height="60" viewBox="0 0 84 60">
    <rect width="84" height="60" fill="${bg}"/>
    <rect x="7" y="7" width="70" height="46" rx="4" fill="${card}"/>
    <rect x="13" y="14" width="34" height="5" rx="2.5" fill="${muted}"/>
    <rect x="13" y="25" width="12" height="20" rx="2" fill="${bar}" opacity="0.35"/>
    <rect x="29" y="20" width="12" height="25" rx="2" fill="${bar}" opacity="0.55"/>
    <rect x="45" y="16" width="12" height="29" rx="2" fill="${bar}" opacity="0.8"/>
    <rect x="61" y="12" width="10" height="33" rx="2" fill="${bar}"/>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

async function launchChromiumCdp(userDataDir) {
  const proc = spawn(
    'chromium',
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--font-render-hinting=none',
      '--window-size=1600,1000',
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium DevTools launch timeout')), 12000);
    proc.stderr.on('data', (chunk) => {
      const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });

  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(JSON.stringify(msg.error)));
      } else {
        entry.resolve(msg.result);
      }
    }
  };
  await new Promise((resolve) => {
    ws.onopen = resolve;
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const { targetInfos } = await send('Target.getTargets');
  const pageTarget = targetInfos.find((t) => t.type === 'page');
  const { sessionId } = await send('Target.attachToTarget', {
    targetId: pageTarget.targetId,
    flatten: true,
  });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);

  return { proc, ws, send, sessionId };
}

async function captureElementPngDataUri(cdp, url, selector, viewportW, viewportH) {
  const { send, sessionId } = cdp;
  await send(
    'Emulation.setDeviceMetricsOverride',
    { width: viewportW, height: viewportH, deviceScaleFactor: 2, mobile: false },
    sessionId
  );
  await send('Page.navigate', { url }, sessionId);
  await new Promise((r) => setTimeout(r, 320));

  const evalRes = await send(
    'Runtime.evaluate',
    {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      })()`,
      returnByValue: true,
    },
    sessionId
  );
  const box = evalRes.result.value;
  const { data } = await send(
    'Page.captureScreenshot',
    {
      format: 'png',
      omitBackground: true,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
    },
    sessionId
  );
  return { dataUri: `data:image/png;base64,${data}`, width: box.width, height: box.height };
}

async function captureFullViewport2x(cdp, htmlPath, width, height, outRawPngPath) {
  const { send, sessionId } = cdp;
  await send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 2, mobile: false },
    sessionId
  );
  await send('Page.navigate', { url: `file://${htmlPath}` }, sessionId);
  await new Promise((r) => setTimeout(r, 320));
  const { data } = await send(
    'Page.captureScreenshot',
    {
      format: 'png',
      clip: { x: 0, y: 0, width, height, scale: 1 },
    },
    sessionId
  );
  fs.writeFileSync(outRawPngPath, Buffer.from(data, 'base64'));
}

function stageRealExtensionFiles(stageDir) {
  for (const dir of ['styles', 'popup', 'pages', 'lib', 'icons']) {
    fs.cpSync(path.join(rootDir, dir), path.join(stageDir, dir), { recursive: true });
  }

  // Prepend FONT_BRIDGE_CSS to staged styles/tokens.css so every real extension page uses crisp Roboto
  const stagedTokensPath = path.join(stageDir, 'styles/tokens.css');
  const tokensCss = fs.readFileSync(stagedTokensPath, 'utf8');
  fs.writeFileSync(stagedTokensPath, `${FONT_BRIDGE_CSS}\n${tokensCss}`, 'utf8');

  const rawPopupHtml = fs
    .readFileSync(path.join(stageDir, 'popup/popup.html'), 'utf8')
    .replace(/<script\b[^>]*><\/script>/g, '');

  const buildStagedPopup = (variant) => {
    const isDark = variant === 'dark';
    const isSignedOut = variant === 'signed-out';
    const thumb1 = createMiniThumbDataUri('#1a73e8', isDark);
    const thumb2 = createMiniThumbDataUri('#15803d', isDark);

    const frameCss = `
      html { background: transparent !important; }
      body {
        background: transparent !important;
        padding: 36px !important;
        width: auto !important;
        display: inline-block !important;
      }
      #popup-shell {
        width: 352px;
        background: var(--ss-bg);
        color: var(--ss-text);
        border-radius: var(--ss-radius-shell);
        border: 1px solid ${isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(15, 18, 24, 0.10)'};
        overflow: hidden;
      }
      /* Upgrade header & hero icons to icon128.png for razor-sharp 2x Retina downsampling */
    `;

    const initScript = `
      <script>
        document.documentElement.dataset.theme = ${JSON.stringify(isDark ? 'dark' : 'light')};
        const app = document.querySelector('.app');
        const shell = document.createElement('div');
        shell.id = 'popup-shell';
        app.parentNode.insertBefore(shell, app);
        shell.appendChild(app);

        for (const img of document.querySelectorAll('img[src*="icons/icon"]')) {
          img.src = '../icons/icon128.png';
        }

        document.getElementById('loading-view').hidden = true;
        document.getElementById('popup-version').textContent = ${JSON.stringify(`v${SITE_COPY.version}`)};
        document.getElementById('footer-author-link').textContent = ${JSON.stringify(SITE_COPY.urls.authorHandle)};
        document.getElementById('popup-shortcut-region').textContent = ${JSON.stringify(SITE_COPY.shortcuts.region.display)};
        document.getElementById('popup-shortcut-visible').textContent = ${JSON.stringify(SITE_COPY.shortcuts.visible.display)};

        if (${JSON.stringify(isSignedOut)}) {
          document.getElementById('signed-out-view').hidden = false;
        } else {
          document.getElementById('main-view').hidden = false;
          document.getElementById('header-actions').hidden = false;
          document.getElementById('sign-out-btn').hidden = false;
          document.getElementById('user-avatar').textContent = 'A';
          document.getElementById('user-email').textContent = 'alex@workspace.io';
          document.getElementById('folder-chip-name').textContent = ${JSON.stringify(SITE_COPY.defaultFolderName)};
          document.getElementById('empty-history').hidden = true;
          document.getElementById('clear-history-btn').hidden = false;

          const ul = document.getElementById('upload-list');
          ul.hidden = false;
          const items = [
            { name: 'Q4_Revenue_Overview.png', meta: 'Area · Just now', thumb: ${JSON.stringify(thumb1)} },
            { name: 'Webhook_Receipt.png', meta: 'Tab · 4m ago', thumb: ${JSON.stringify(thumb2)} },
          ];
          for (const item of items) {
            const li = document.createElement('li');
            li.className = 'upload-item';
            li.innerHTML = \`
              <img class="upload-thumb" src="\${item.thumb}" alt="" />
              <div class="upload-meta">
                <span class="ss-body upload-name">\${item.name}</span>
                <span class="ss-meta">\${item.meta}</span>
              </div>
              <div class="upload-actions">
                <button type="button" class="ss-icon-btn" aria-label="Edit">
                  <svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.95" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                </button>
                <button type="button" class="ss-icon-btn" aria-label="Copy link">
                  <svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.95" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
                <button type="button" class="ss-icon-btn" aria-label="Open">
                  <svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.95" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                </button>
              </div>
            \`;
            ul.appendChild(li);
          }
        }
      </script>
    `;

    return rawPopupHtml
      .replace('</head>', `<style>${frameCss}</style></head>`)
      .replace('</body>', `${initScript}</body>`);
  };

  fs.writeFileSync(path.join(stageDir, 'popup/staged-light.html'), buildStagedPopup('light'));
  fs.writeFileSync(path.join(stageDir, 'popup/staged-dark.html'), buildStagedPopup('dark'));
  fs.writeFileSync(
    path.join(stageDir, 'popup/staged-signed-out.html'),
    buildStagedPopup('signed-out')
  );

  // Stage real pages/editor.html powered by real lib/editor-core.js annotations!
  const rawEditorHtml = fs
    .readFileSync(path.join(stageDir, 'pages/editor.html'), 'utf8')
    .replace(/<script\b[^>]*><\/script>/g, '');
  const inlinedEditorCoreJs = fs
    .readFileSync(path.join(rootDir, 'lib/editor-core.js'), 'utf8')
    .replace(/^export\s+/gm, '');

  const editorStageCss = `
    .editor-app { height: 636px !important; }
    .stage { padding: 14px 28px 0 !important; align-items: flex-start !important; }
    #canvas-wrap { border-radius: 8px 8px 0 0 !important; overflow: hidden; }
  `;

  const editorStageScript = `
    <script>
      ${inlinedEditorCoreJs}

      document.documentElement.dataset.theme = 'light';
      for (const img of document.querySelectorAll('img[src*="icons/icon"]')) {
        img.src = '../icons/icon128.png';
      }

      document.getElementById('filename-display').textContent = 'Webhook_Receipt';
      document.getElementById('dim-label').textContent = '1240 × 720';
      document.getElementById('unsaved-pill').hidden = false;
      document.getElementById('copy-link-btn').hidden = false;
      document.getElementById('open-drive-link').hidden = false;
      document.getElementById('save-drive-btn').disabled = false;
      document.getElementById('undo-btn').disabled = false;
      document.getElementById('reset-btn').disabled = false;
      document.getElementById('stage-message').hidden = true;

      const wrap = document.getElementById('canvas-wrap');
      wrap.hidden = false;
      const base = document.getElementById('base-canvas');
      const prev = document.getElementById('preview-canvas');
      const W = 880;
      const H = 500;
      const dpr = 2;
      base.width = W * dpr;
      base.height = H * dpr;
      base.style.width = W + 'px';
      base.style.height = H + 'px';
      prev.width = W * dpr;
      prev.height = H * dpr;
      prev.style.width = W + 'px';
      prev.style.height = H + 'px';

      const ctx = base.getContext('2d');
      ctx.scale(dpr, dpr);

      // Draw crisp captured SaaS payment receipt UI on the screenshot canvas
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);

      // Header row
      ctx.fillStyle = '#141518';
      ctx.font = '700 18px system-ui, Roboto, sans-serif';
      ctx.fillText('Order #INV-88412 · Webhook Delivery Log', 34, 42);
      ctx.fillStyle = '#767c89';
      ctx.font = '400 12.5px system-ui, Roboto, sans-serif';
      ctx.fillText('Production Environment · Processed 2 minutes ago', 34, 63);

      // Error badge top-right
      ctx.fillStyle = '#fef2f2';
      ctx.beginPath();
      ctx.roundRect(674, 26, 172, 28, 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(220, 38, 38, 0.28)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#991b1b';
      ctx.font = '600 12px system-ui, Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('HTTP 502 Bad Gateway', 674 + 86, 44);
      ctx.textAlign = 'left';

      ctx.strokeStyle = '#eceef2';
      ctx.beginPath();
      ctx.moveTo(34, 82);
      ctx.lineTo(846, 82);
      ctx.stroke();

      // Left info card (Customer PII to be redacted)
      ctx.fillStyle = '#f5f6f8';
      ctx.beginPath();
      ctx.roundRect(34, 102, 392, 122, 10);
      ctx.fill();
      ctx.fillStyle = '#767c89';
      ctx.font = '500 11.5px system-ui, Roboto, sans-serif';
      ctx.fillText('Customer Billing Details', 52, 126);
      ctx.fillStyle = '#525866';
      ctx.font = '400 13px system-ui, Roboto, sans-serif';
      ctx.fillText('Email:', 52, 156);
      ctx.fillText('Card:', 52, 188);

      // Right info card (Buggy retry payload highlighted by SaveShot annotations)
      ctx.fillStyle = '#f5f6f8';
      ctx.beginPath();
      ctx.roundRect(446, 102, 400, 122, 10);
      ctx.fill();
      ctx.fillStyle = '#767c89';
      ctx.font = '500 11.5px system-ui, Roboto, sans-serif';
      ctx.fillText('Retry Configuration Payload', 464, 126);
      ctx.fillStyle = '#141518';
      ctx.font = '600 13px ui-monospace, Liberation Mono, monospace';
      ctx.fillText('retry_backoff_ms: null', 464, 156);
      ctx.fillStyle = '#525866';
      ctx.font = '400 12.5px ui-monospace, Liberation Mono, monospace';
      ctx.fillText('max_attempts: 3  |  timeout_ms: 15000', 464, 184);

      // Event table below
      ctx.strokeStyle = '#eceef2';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(34, 256, 812, 146, 10);
      ctx.stroke();
      ctx.fillStyle = '#f5f6f8';
      ctx.beginPath();
      ctx.roundRect(35, 257, 810, 36, [9, 9, 0, 0]);
      ctx.fill();

      ctx.fillStyle = '#767c89';
      ctx.font = '600 11.5px system-ui, Roboto, sans-serif';
      ctx.fillText('Timestamp', 52, 279);
      ctx.fillText('Event Type', 210, 279);
      ctx.fillText('Result', 720, 279);

      const rows = [
        ['10:42:11.04', 'payment_intent.succeeded', '200 OK', '#15803d'],
        ['10:42:14.89', 'webhook.delivery.retry_failed (NaN delay)', '502 Error', '#dc2626'],
      ];
      rows.forEach(([ts, ev, status, col], idx) => {
        const y = 318 + idx * 44;
        if (idx === 1) {
          ctx.fillStyle = 'rgba(239, 68, 68, 0.04)';
          ctx.fillRect(35, y - 24, 810, 44);
        }
        ctx.fillStyle = '#525866';
        ctx.font = '400 12.5px ui-monospace, Liberation Mono, monospace';
        ctx.fillText(ts, 52, y);
        ctx.fillStyle = '#141518';
        ctx.fillText(ev, 210, y);
        ctx.fillStyle = col;
        ctx.font = '600 12.5px system-ui, Roboto, sans-serif';
        ctx.fillText(status, 720, y);
      });

      // Render real SaveShot annotations + solid black pixel redactions using lib/editor-core.js!
      const ops = [
        { tool: 'redact', x1: 102, y1: 141, x2: 344, y2: 162 },
        { tool: 'redact', x1: 102, y1: 173, x2: 274, y2: 194 },
        { tool: 'box', color: '#ef4444', strokeWidth: 3.5, x1: 444, y1: 100, x2: 848, y2: 226 },
        { tool: 'arrow', color: '#ef4444', strokeWidth: 4, x1: 360, y1: 238, x2: 436, y2: 184 },
        { tool: 'text', color: '#ef4444', fontSize: 16, x: 224, y: 230, text: 'Null backoff bug' },
      ];
      for (const op of ops) {
        renderAnnotation(ctx, op, W, H);
      }
    </script>
  `;

  fs.writeFileSync(
    path.join(stageDir, 'pages/staged-editor.html'),
    rawEditorHtml
      .replace('</head>', `<style>${editorStageCss}</style></head>`)
      .replace('</body>', `${editorStageScript}</body>`)
  );

  // Stage real pages/welcome.html in connected state so header + status + 4 steps + shortcuts fit cleanly
  const rawWelcomeHtml = fs
    .readFileSync(path.join(stageDir, 'pages/welcome.html'), 'utf8')
    .replace(/<script\b[^>]*><\/script>/g, '');

  const welcomeStageCss = `
    body { padding: 24px 24px 32px !important; background: var(--ss-page-bg) !important; }
    .container { max-width: 760px !important; gap: 15px !important; }
    .welcome-card { padding: 14px 18px !important; }
    .steps-grid { gap: 10px !important; }
  `;

  const welcomeStageScript = `
    <script>
      document.documentElement.dataset.theme = 'light';
      for (const img of document.querySelectorAll('img[src*="icons/icon"]')) {
        img.src = '../icons/icon128.png';
      }
      document.getElementById('ext-version').textContent = ${JSON.stringify(`v${SITE_COPY.version}`)};
      document.getElementById('account-dot').classList.add('connected');
      document.getElementById('account-heading').textContent = 'Connected as alex@workspace.io';
      document.getElementById('account-detail').textContent = ${JSON.stringify(
        `Screenshots save to "${SITE_COPY.defaultFolderName}" in your Google Drive.`
      )};
      document.getElementById('sign-in-btn').hidden = true;
      document.getElementById('open-drive-btn').hidden = false;
      document.getElementById('shortcut-region').textContent = ${JSON.stringify(SITE_COPY.shortcuts.region.display)};
      document.getElementById('shortcut-visible').textContent = ${JSON.stringify(SITE_COPY.shortcuts.visible.display)};
    </script>
  `;

  fs.writeFileSync(
    path.join(stageDir, 'pages/staged-welcome.html'),
    rawWelcomeHtml
      .replace('</head>', `<style>${welcomeStageCss}</style></head>`)
      .replace('</body>', `${welcomeStageScript}</body>`)
  );
}

/**
 * Shared design-system CSS for all 7 Chrome Web Store assets.
 * Directly consumes SaveShot's tokens.css variables for 100% palette, border,
 * radius, and typography consistency across every promotional tile and slide.
 */
function buildSlideCommonCss(tokensCss) {
  return `
    ${FONT_BRIDGE_CSS}
    ${tokensCss}

    html, body {
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: var(--ss-page-bg);
      color: var(--ss-text);
      font-family: var(--ss-font-sans);
      -webkit-font-smoothing: antialiased;
    }

    /* Locked 1280x800 Slide Grid - identical header geometry across all 5 screenshots */
    .cws-slide {
      width: 1280px;
      height: 800px;
      background: var(--ss-page-bg);
      padding: 38px 72px 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      position: relative;
    }

    .cws-header {
      width: 1136px;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      margin-bottom: 24px;
      flex-shrink: 0;
    }

    .cws-kicker {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      height: 22px;
      margin-bottom: 8px;
      font-size: 12.5px;
      line-height: 18px;
      letter-spacing: -0.01em;
    }

    .cws-kicker-brand {
      font-weight: 600;
      color: var(--ss-text);
    }

    .cws-kicker-dot {
      color: var(--ss-text-muted);
    }

    .cws-kicker-topic {
      font-weight: 500;
      color: var(--ss-text-muted);
    }

    .cws-h1 {
      font-size: 30px;
      font-weight: 700;
      line-height: 38px;
      letter-spacing: -0.024em;
      color: var(--ss-text);
      white-space: nowrap;
    }

    .cws-sub {
      margin-top: 6px;
      font-size: 15px;
      font-weight: 400;
      line-height: 22px;
      letter-spacing: -0.005em;
      color: var(--ss-text-secondary);
      white-space: nowrap;
    }

    /* Elevated Browser / App Showcase Shell (starts at exact y = 160px on slides) */
    .cws-frame {
      width: 1136px;
      flex: 1;
      background: var(--ss-bg);
      border-radius: var(--ss-radius-shell) var(--ss-radius-shell) 0 0;
      border: 1px solid var(--ss-border-strong);
      border-bottom: none;
      box-shadow: 0 20px 52px rgba(15, 18, 24, 0.10), 0 2px 6px rgba(15, 18, 24, 0.04);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      position: relative;
    }

    .cws-popup-img {
      display: block;
      width: 352px;
      height: auto;
      border-radius: var(--ss-radius-shell);
      box-shadow: 0 22px 50px rgba(15, 18, 24, 0.18), 0 2px 8px rgba(15, 18, 24, 0.06);
    }

    .cws-popup-img.dark-shadow {
      box-shadow: 0 24px 56px rgba(0, 0, 0, 0.42), 0 2px 8px rgba(0, 0, 0, 0.20);
    }

    /* Authentic Webpage Upload Toast matching content/selector.js */
    .cws-toast {
      width: 352px;
      background: #ffffff;
      color: #141518;
      border-radius: 14px;
      border: 1px solid rgba(15, 18, 24, 0.10);
      padding: 12px 14px;
      box-shadow: 0 16px 38px rgba(15, 18, 24, 0.14), 0 2px 6px rgba(15, 18, 24, 0.05);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .cws-toast.dark {
      background: #1c1d20;
      color: #f3f4f6;
      border-color: rgba(255, 255, 255, 0.12);
      box-shadow: 0 20px 46px rgba(0, 0, 0, 0.44);
    }
    .cws-toast-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .cws-toast-thumb {
      width: 46px;
      height: 34px;
      border-radius: 6px;
      border: 1px solid rgba(15, 18, 24, 0.08);
      flex-shrink: 0;
    }
    .cws-toast.dark .cws-toast-thumb {
      border-color: rgba(255, 255, 255, 0.10);
    }
    .cws-toast-title {
      font-size: 13px;
      font-weight: 600;
      line-height: 18px;
      letter-spacing: -0.015em;
    }
    .cws-toast-sub {
      font-size: 12px;
      line-height: 17px;
      color: #525866;
      margin-top: 1px;
    }
    .cws-toast.dark .cws-toast-sub {
      color: #a6abb6;
    }
    .cws-toast-actions {
      display: flex;
      gap: 6px;
    }
    .cws-toast-btn {
      flex: 1;
      height: 32px;
      border-radius: 8px;
      font-size: 12.5px;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(15, 18, 24, 0.15);
    }
    .cws-toast-btn.compact {
      flex: 0.76;
    }
    .cws-toast-btn.primary {
      background: #1a73e8;
      color: #ffffff;
      border-color: transparent;
    }
    .cws-toast.dark .cws-toast-btn {
      border-color: rgba(255, 255, 255, 0.16);
      color: #f3f4f6;
    }
    .cws-toast.dark .cws-toast-btn.primary {
      background: #5b9df9;
      color: #0d131f;
      border-color: transparent;
    }
  `;
}

function renderSlideHeader(iconDataUri, topic, headline, subtitle) {
  return `
    <header class="cws-header">
      <div class="cws-kicker">
        <img src="${iconDataUri}" width="18" height="18" alt="" />
        <span class="cws-kicker-brand">${SITE_COPY.brandName}</span>
        <span class="cws-kicker-dot">&middot;</span>
        <span class="cws-kicker-topic">${topic}</span>
      </div>
      <h1 class="cws-h1">${headline}</h1>
      <p class="cws-sub">${subtitle}</p>
    </header>
  `;
}

export async function generateAllStoreAssets() {
  fs.mkdirSync(outDir, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saveshot-assets-'));
  const stageDir = path.join(tempRoot, 'ext');
  const raw2xDir = path.join(tempRoot, 'raw2x');
  const userDataDir = path.join(tempRoot, 'profile');
  fs.mkdirSync(stageDir, { recursive: true });
  fs.mkdirSync(raw2xDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  stageRealExtensionFiles(stageDir);

  const tokensCss = fs.readFileSync(path.join(rootDir, 'styles/tokens.css'), 'utf8');
  const iconDataUri = `data:image/png;base64,${fs
    .readFileSync(path.join(rootDir, 'icons/icon128.png'))
    .toString('base64')}`;
  const thumbLight = createMiniThumbDataUri('#1a73e8', false);
  const thumbDark = createMiniThumbDataUri('#1a73e8', true);

  const cdp = await launchChromiumCdp(userDataDir);
  try {
    // Stage 1: Capture real extension UI surfaces at 2x Retina
    const popupLight = await captureElementPngDataUri(
      cdp,
      `file://${path.join(stageDir, 'popup/staged-light.html')}`,
      '#popup-shell',
      500,
      600
    );
    const popupDark = await captureElementPngDataUri(
      cdp,
      `file://${path.join(stageDir, 'popup/staged-dark.html')}`,
      '#popup-shell',
      500,
      600
    );
    const popupSignedOut = await captureElementPngDataUri(
      cdp,
      `file://${path.join(stageDir, 'popup/staged-signed-out.html')}`,
      '#popup-shell',
      500,
      600
    );
    const editorShot = await captureElementPngDataUri(
      cdp,
      `file://${path.join(stageDir, 'pages/staged-editor.html')}`,
      '.editor-app',
      1136,
      636
    );
    const welcomeShot = await captureElementPngDataUri(
      cdp,
      `file://${path.join(stageDir, 'pages/staged-welcome.html')}`,
      'body',
      1136,
      636
    );

    const commonCss = buildSlideCommonCss(tokensCss);

    // Stage 2: Build all 7 Chrome Web Store assets with unified design & typography
    const assetPages = [
      {
        relPath: 'store-assets/promo-small-440x280.png',
        width: 440,
        height: 280,
        html: `<!DOCTYPE html><html><head><meta charset="UTF-8" /><style>${commonCss}
          .promo-sm {
            width: 440px;
            height: 280px;
            background: var(--ss-page-bg);
            padding: 26px 28px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
          }
          .promo-sm-brand {
            display: flex;
            align-items: center;
            gap: 12px;
          }
          .promo-sm-title {
            font-size: 24px;
            font-weight: 700;
            line-height: 28px;
            letter-spacing: -0.025em;
            color: var(--ss-text);
          }
          .promo-sm-tag {
            font-size: 12.5px;
            font-weight: 500;
            line-height: 17px;
            color: var(--ss-accent-text);
            margin-top: 2px;
          }
          .promo-sm-desc {
            margin-top: 14px;
            font-size: 13.5px;
            font-weight: 400;
            line-height: 20px;
            color: var(--ss-text-secondary);
          }
          .promo-sm-card {
            background: var(--ss-bg);
            border: 1px solid var(--ss-border-strong);
            border-radius: var(--ss-radius-card);
            padding: 11px 14px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            box-shadow: 0 8px 22px rgba(15, 18, 24, 0.06);
          }
          .promo-sm-ok {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-size: 12.5px;
            font-weight: 600;
            color: var(--ss-green);
          }
          .promo-sm-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--ss-green);
          }
        </style></head><body>
          <div class="promo-sm">
            <div>
              <div class="promo-sm-brand">
                <img src="${iconDataUri}" width="44" height="44" alt="" />
                <div>
                  <div class="promo-sm-title">${SITE_COPY.brandName}</div>
                  <div class="promo-sm-tag">Screenshots straight to Google Drive</div>
                </div>
              </div>
              <p class="promo-sm-desc">
                Capture any area or tab, annotate or redact in Chrome, and copy your Drive share link automatically.
              </p>
              <div style="display:flex;gap:6px;margin-top:14px;">
                <span class="ss-kbd">${SITE_COPY.shortcuts.region.key} &middot; Area</span>
                <span class="ss-kbd">Annotate &amp; Redact</span>
                <span class="ss-kbd">drive.file</span>
              </div>
            </div>
            <div class="promo-sm-card">
              <span class="promo-sm-ok">
                <span class="promo-sm-dot"></span>
                <span>Saved to Drive &middot; Link copied</span>
              </span>
              <span class="ss-kbd">100% Local</span>
            </div>
          </div>
        </body></html>`,
      },
      {
        relPath: 'store-assets/promo-marquee-1400x560.png',
        width: 1400,
        height: 560,
        html: `<!DOCTYPE html><html><head><meta charset="UTF-8" /><style>${commonCss}
          .marquee {
            width: 1400px;
            height: 560px;
            background: var(--ss-page-bg);
            padding: 0 76px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 48px;
          }
          .mq-left {
            width: 520px;
            display: flex;
            flex-direction: column;
            gap: 16px;
            flex-shrink: 0;
          }
          .mq-brand {
            display: inline-flex;
            align-items: center;
            gap: 12px;
          }
          .mq-brand-name {
            font-size: 24px;
            font-weight: 700;
            letter-spacing: -0.024em;
            color: var(--ss-text);
          }
          .mq-h1 {
            font-size: 38px;
            font-weight: 700;
            line-height: 46px;
            letter-spacing: -0.028em;
            color: var(--ss-text);
          }
          .mq-sub {
            font-size: 16px;
            font-weight: 400;
            line-height: 24px;
            color: var(--ss-text-secondary);
          }
          .mq-meta-row {
            display: flex;
            align-items: center;
            gap: 8px;
            padding-top: 4px;
            flex-wrap: wrap;
          }
          .mq-chip {
            height: 28px;
            padding: 0 11px;
            border-radius: var(--ss-radius-ctrl);
            background: var(--ss-bg);
            border: 1px solid var(--ss-border-strong);
            font-size: 12px;
            font-weight: 500;
            color: var(--ss-text);
            display: inline-flex;
            align-items: center;
            gap: 6px;
          }
          .mq-chip-dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: var(--ss-green);
          }
          .mq-right {
            flex: 1;
            height: 472px;
            position: relative;
          }
          .mq-editor-card {
            position: absolute;
            left: 0;
            top: 14px;
            width: 590px;
            height: 330px;
            border-radius: var(--ss-radius-shell);
            border: 1px solid var(--ss-border-strong);
            box-shadow: 0 18px 44px rgba(15, 18, 24, 0.11);
            overflow: hidden;
            background: var(--ss-bg);
          }
          .mq-editor-card img {
            width: 100%;
            height: auto;
            display: block;
          }
          .mq-popup-wrap {
            position: absolute;
            right: 0;
            bottom: 8px;
          }
        </style></head><body>
          <div class="marquee">
            <div class="mq-left">
              <div class="mq-brand">
                <img src="${iconDataUri}" width="44" height="44" alt="" />
                <span class="mq-brand-name">${SITE_COPY.brandName}</span>
              </div>
              <h1 class="mq-h1">Capture &amp; edit screenshots straight to Google Drive.</h1>
              <p class="mq-sub">
                Select any area or tab, annotate or redact sensitive details in Chrome, and copy your shareable Drive link automatically.
              </p>
              <div class="mq-meta-row">
                <span class="mq-chip"><span class="mq-chip-dot"></span>100% Local in Chrome</span>
                <span class="mq-chip">Narrow drive.file Scope</span>
                <span class="mq-chip">No External Servers</span>
              </div>
            </div>
            <div class="mq-right">
              <div class="mq-editor-card">
                <img src="${editorShot.dataUri}" alt="" />
              </div>
              <div class="mq-popup-wrap">
                <img class="cws-popup-img" src="${popupLight.dataUri}" alt="" />
              </div>
            </div>
          </div>
        </body></html>`,
      },
      {
        relPath: 'store-assets/screenshot-1-capture-1280x800.png',
        width: 1280,
        height: 800,
        html: `<!DOCTYPE html><html><head><meta charset="UTF-8" /><style>${commonCss}
          .browser-bar {
            height: 40px;
            background: var(--ss-surface);
            border-bottom: 1px solid var(--ss-border);
            padding: 0 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-shrink: 0;
          }
          .browser-dots {
            display: flex;
            gap: 7px;
          }
          .browser-dots span {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: rgba(15, 18, 24, 0.16);
          }
          .browser-url {
            height: 26px;
            padding: 0 132px;
            border-radius: var(--ss-radius-sm);
            background: var(--ss-bg);
            border: 1px solid var(--ss-border);
            font-size: 12px;
            color: var(--ss-text-secondary);
            display: inline-flex;
            align-items: center;
          }
          .browser-ext-pill {
            height: 26px;
            padding: 0 9px;
            border-radius: var(--ss-radius-sm);
            background: var(--ss-accent-soft);
            border: 1px solid var(--ss-accent-border);
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 11.5px;
            font-weight: 600;
            color: var(--ss-accent-text);
          }
          .capture-viewport {
            flex: 1;
            position: relative;
            background: #eef1f6;
          }
          .capture-dim {
            position: absolute;
            inset: 0;
            background: rgba(15, 18, 24, 0.30);
          }
          /* Authentic selector.js HUD pill */
          .selector-hud {
            position: absolute;
            top: 18px;
            left: 364px;
            transform: translateX(-50%);
            height: 36px;
            padding: 0 10px 0 14px;
            border-radius: var(--ss-radius-dock);
            background: rgba(20, 21, 24, 0.94);
            color: #f3f4f6;
            font-size: 12.5px;
            font-weight: 500;
            display: inline-flex;
            align-items: center;
            gap: 9px;
            box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
            z-index: 4;
          }
          .selector-hud-sep {
            width: 1px;
            height: 14px;
            background: rgba(255, 255, 255, 0.16);
          }
          .selector-hud-btn {
            height: 24px;
            padding: 0 8px;
            border-radius: var(--ss-radius-sm);
            background: rgba(255, 255, 255, 0.10);
            border: 1px solid rgba(255, 255, 255, 0.16);
            font-size: 11.5px;
            display: inline-flex;
            align-items: center;
            gap: 5px;
          }
          .selector-hud-key {
            color: #a6abb6;
            font-family: var(--ss-font-mono);
            font-size: 10.5px;
          }
          .crop-box {
            position: absolute;
            left: 48px;
            top: 72px;
            width: 632px;
            height: 392px;
            background: var(--ss-bg);
            border: 2px solid var(--ss-accent);
            border-radius: 2px;
            box-shadow: 0 16px 40px rgba(15, 18, 24, 0.18);
            padding: 26px 28px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            z-index: 3;
          }
          .crop-dim-pill {
            position: absolute;
            left: 48px;
            top: 472px;
            height: 24px;
            padding: 0 9px;
            border-radius: var(--ss-radius-sm);
            background: rgba(20, 21, 24, 0.94);
            color: #f3f4f6;
            font-family: var(--ss-font-mono);
            font-size: 11.5px;
            font-weight: 500;
            display: inline-flex;
            align-items: center;
            z-index: 4;
          }
          .metric-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 12px;
          }
          .metric-card {
            background: var(--ss-surface);
            border-radius: var(--ss-radius-row);
            padding: 13px 14px;
          }
          .bars {
            height: 138px;
            display: flex;
            align-items: flex-end;
            gap: 14px;
            padding: 0 6px;
          }
          .bar {
            flex: 1;
            border-radius: 6px 6px 0 0;
          }
        </style></head><body>
          <div class="cws-slide">
            ${renderSlideHeader(
              iconDataUri,
              'Area & Tab Capture',
              'Select any screen area or capture the visible tab',
              `Drag to crop with pixel-exact zoom accuracy (${SITE_COPY.shortcuts.region.key}) or press ${SITE_COPY.shortcuts.visible.key} to save straight to Google Drive.`
            )}
            <div class="cws-frame">
              <div class="browser-bar">
                <div class="browser-dots"><span></span><span></span><span></span></div>
                <div class="browser-url">analytics.workspace.io/quarterly-overview</div>
                <div class="browser-ext-pill">
                  <img src="${iconDataUri}" width="15" height="15" alt="" />
                  <span>${SITE_COPY.brandName}</span>
                </div>
              </div>
              <div class="capture-viewport">
                <div class="capture-dim"></div>
                <div class="selector-hud">
                  <span>Drag to select area</span>
                  <span class="selector-hud-sep"></span>
                  <span class="selector-hud-btn">Full tab <span class="selector-hud-key">Enter</span></span>
                  <span class="selector-hud-key">Esc</span>
                </div>
                <div class="crop-box">
                  <div style="display:flex;align-items:center;justify-content:space-between;">
                    <div>
                      <div class="ss-title-lg">Quarterly Revenue Overview</div>
                      <div class="ss-body-regular">Updated 2 minutes ago &middot; Consolidated Forecast</div>
                    </div>
                    <span style="height:26px;padding:0 10px;border-radius:6px;background:var(--ss-green-soft);border:1px solid var(--ss-green-border);color:var(--ss-green);font-size:12px;font-weight:600;display:inline-flex;align-items:center;">+24.8% YoY</span>
                  </div>
                  <div class="metric-grid">
                    <div class="metric-card">
                      <div class="ss-meta">Net Revenue</div>
                      <div style="font-size:21px;font-weight:700;letter-spacing:-0.02em;margin-top:4px;">$148,920</div>
                    </div>
                    <div class="metric-card">
                      <div class="ss-meta">Active Teams</div>
                      <div style="font-size:21px;font-weight:700;letter-spacing:-0.02em;margin-top:4px;">1,842</div>
                    </div>
                    <div class="metric-card">
                      <div class="ss-meta">Retention</div>
                      <div style="font-size:21px;font-weight:700;letter-spacing:-0.02em;color:var(--ss-green);margin-top:4px;">98.4%</div>
                    </div>
                  </div>
                  <div class="bars">
                    <div class="bar" style="height:44%;background:rgba(26,115,232,0.18);"></div>
                    <div class="bar" style="height:58%;background:rgba(26,115,232,0.32);"></div>
                    <div class="bar" style="height:54%;background:rgba(26,115,232,0.48);"></div>
                    <div class="bar" style="height:76%;background:rgba(26,115,232,0.72);"></div>
                    <div class="bar" style="height:94%;background:var(--ss-accent);"></div>
                  </div>
                </div>
                <div class="crop-dim-pill">1180 × 680</div>
                <div style="position:absolute;right:34px;top:16px;z-index:5;">
                  <img class="cws-popup-img" src="${popupLight.dataUri}" alt="" />
                </div>
              </div>
            </div>
          </div>
        </body></html>`,
      },
      {
        relPath: 'store-assets/screenshot-2-editor-1280x800.png',
        width: 1280,
        height: 800,
        html: `<!DOCTYPE html><html><head><meta charset="UTF-8" /><style>${commonCss}</style></head><body>
          <div class="cws-slide">
            ${renderSlideHeader(
              iconDataUri,
              'Built-In Editor',
              'Annotate, redact sensitive details, rotate, or rename',
              'Opens automatically after upload so you can add arrows, shapes, text, or solid black pixel redactions.'
            )}
            <div class="cws-frame">
              <img src="${editorShot.dataUri}" style="width:1136px;height:auto;display:block;" alt="" />
            </div>
          </div>
        </body></html>`,
      },
      {
        relPath: 'store-assets/screenshot-3-privacy-1280x800.png',
        width: 1280,
        height: 800,
        html: `<!DOCTYPE html><html><head><meta charset="UTF-8" /><style>${commonCss}
          .priv-layout {
            width: 1136px;
            display: grid;
            grid-template-columns: 352px 1fr;
            gap: 32px;
            align-items: center;
            margin-top: 26px;
          }
          .priv-right {
            display: flex;
            flex-direction: column;
            gap: 16px;
          }
          .flow-card {
            background: var(--ss-bg);
            border: 1px solid var(--ss-border-strong);
            border-radius: var(--ss-radius-shell);
            padding: 22px 26px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            box-shadow: 0 8px 24px rgba(15, 18, 24, 0.04);
          }
          .flow-node {
            flex: 1;
            text-align: center;
          }
          .flow-arrow {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 5px;
            min-width: 170px;
          }
          .flow-line {
            width: 140px;
            height: 2px;
            background: var(--ss-accent);
            border-radius: 2px;
          }
          .priv-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 14px;
          }
          .priv-card {
            background: var(--ss-bg);
            border: 1px solid var(--ss-border);
            border-radius: var(--ss-radius-shell);
            padding: 18px 20px;
            display: flex;
            flex-direction: column;
            gap: 5px;
          }
          .priv-card-head {
            display: flex;
            align-items: center;
            gap: 7px;
          }
          .priv-check {
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: var(--ss-green-soft);
            color: var(--ss-green);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: 700;
            flex-shrink: 0;
          }
        </style></head><body>
          <div class="cws-slide">
            ${renderSlideHeader(
              iconDataUri,
              'Privacy First',
              '100% local in Chrome with no external servers or tracking',
              "Uploads go straight from Chrome to Google's official Drive API under the narrow drive.file permission."
            )}
            <div class="priv-layout">
              <div>
                <img class="cws-popup-img" src="${popupSignedOut.dataUri}" alt="" />
              </div>
              <div class="priv-right">
                <div class="flow-card">
                  <div class="flow-node">
                    <div class="ss-title-md">Your Chrome Browser</div>
                    <div class="ss-body-regular" style="margin-top:2px;">Capture, crop &amp; redact in memory</div>
                  </div>
                  <div class="flow-arrow">
                    <span class="ss-meta" style="color:var(--ss-accent-text);font-weight:600;">Direct HTTPS TLS</span>
                    <span class="flow-line"></span>
                    <span class="ss-meta" style="color:var(--ss-green);font-weight:600;">Zero middleman servers</span>
                  </div>
                  <div class="flow-node">
                    <div class="ss-title-md">Your Google Drive</div>
                    <div class="ss-body-regular" style="margin-top:2px;">googleapis.com (drive.file)</div>
                  </div>
                </div>
                <div class="priv-grid">
                  <div class="priv-card">
                    <div class="priv-card-head">
                      <span class="priv-check">&#10003;</span>
                      <span class="ss-title-sm">Narrow drive.file Scope</span>
                    </div>
                    <p class="ss-body-regular">SaveShot can only access screenshots it creates itself, never any other files in your Drive.</p>
                  </div>
                  <div class="priv-card">
                    <div class="priv-card-head">
                      <span class="priv-check">&#10003;</span>
                      <span class="ss-title-sm">Active-Tab Only</span>
                    </div>
                    <p class="ss-body-regular">Uses activeTab instead of broad host permissions, with zero background screen access.</p>
                  </div>
                  <div class="priv-card">
                    <div class="priv-card-head">
                      <span class="priv-check">&#10003;</span>
                      <span class="ss-title-sm">Incognito &amp; Sign-Out Clean</span>
                    </div>
                    <p class="ss-body-regular">Leaves out page URLs in Incognito and clears recent history automatically when you sign out.</p>
                  </div>
                  <div class="priv-card">
                    <div class="priv-card-head">
                      <span class="priv-check">&#10003;</span>
                      <span class="ss-title-sm">Zero External Dependencies</span>
                    </div>
                    <p class="ss-body-regular">Lightweight vanilla code with zero third-party libraries, SDKs, analytics, or trackers.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </body></html>`,
      },
      {
        relPath: 'store-assets/screenshot-4-themes-1280x800.png',
        width: 1280,
        height: 800,
        html: `<!DOCTYPE html><html><head><meta charset="UTF-8" /><style>${commonCss}
          .themes-grid {
            display: flex;
            align-items: flex-start;
            justify-content: center;
            gap: 56px;
            margin-top: 8px;
          }
          .theme-col {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 14px;
          }
          .theme-caption {
            font-size: 12px;
            font-weight: 500;
            color: var(--ss-text-muted);
          }
        </style></head><body>
          <div class="cws-slide">
            ${renderSlideHeader(
              iconDataUri,
              'Light & Dark Themes',
              'Neutral Light and Graphite Dark themes, built right in',
              'Follows your system appearance automatically or switches live across the popup, editor, and upload toast.'
            )}
            <div class="themes-grid">
              <div class="theme-col">
                <img class="cws-popup-img" src="${popupLight.dataUri}" alt="" />
                <div class="cws-toast">
                  <div class="cws-toast-row">
                    <img class="cws-toast-thumb" src="${thumbLight}" alt="" />
                    <div style="flex:1;min-width:0;">
                      <div class="cws-toast-title">Saved to "${SITE_COPY.defaultFolderName}"</div>
                      <div class="cws-toast-sub">Q4_Revenue_Overview.png</div>
                    </div>
                  </div>
                  <div class="cws-toast-actions">
                    <span class="cws-toast-btn primary">Link copied!</span>
                    <span class="cws-toast-btn compact">Edit</span>
                    <span class="cws-toast-btn compact">Open</span>
                  </div>
                </div>
                <span class="theme-caption">Neutral Light Theme</span>
              </div>

              <div class="theme-col">
                <img class="cws-popup-img dark-shadow" src="${popupDark.dataUri}" alt="" />
                <div class="cws-toast dark">
                  <div class="cws-toast-row">
                    <img class="cws-toast-thumb" src="${thumbDark}" alt="" />
                    <div style="flex:1;min-width:0;">
                      <div class="cws-toast-title">Saved to "${SITE_COPY.defaultFolderName}"</div>
                      <div class="cws-toast-sub">Q4_Revenue_Overview.png</div>
                    </div>
                  </div>
                  <div class="cws-toast-actions">
                    <span class="cws-toast-btn primary">Link copied!</span>
                    <span class="cws-toast-btn compact">Edit</span>
                    <span class="cws-toast-btn compact">Open</span>
                  </div>
                </div>
                <span class="theme-caption">Graphite Dark Theme</span>
              </div>
            </div>
          </div>
        </body></html>`,
      },
      {
        relPath: 'store-assets/screenshot-welcome-1280x800.png',
        width: 1280,
        height: 800,
        html: `<!DOCTYPE html><html><head><meta charset="UTF-8" /><style>${commonCss}</style></head><body>
          <div class="cws-slide">
            ${renderSlideHeader(
              iconDataUri,
              'Quick Setup & Shortcuts',
              'Ready in seconds with customizable keyboard shortcuts',
              'Connect Google Drive once, review the 4-step workflow, or customize shortcuts anytime.'
            )}
            <div class="cws-frame" style="background:var(--ss-page-bg);">
              <img src="${welcomeShot.dataUri}" style="width:1136px;height:auto;display:block;" alt="" />
            </div>
          </div>
        </body></html>`,
      },
    ];

    for (const page of assetPages) {
      const baseName = path.basename(page.relPath);
      const htmlPath = path.join(tempRoot, `${baseName}.html`);
      const rawPngPath = path.join(raw2xDir, baseName);
      fs.writeFileSync(htmlPath, page.html, 'utf8');
      await captureFullViewport2x(cdp, htmlPath, page.width, page.height, rawPngPath);
    }
  } finally {
    cdp.ws.close();
    cdp.proc.kill('SIGKILL');
  }

  // Stage 3: Downsample 2x Retina captures via Lanczos to exact 1x dimensions in strict 24-bit RGB (no alpha)
  execFileSync(
    'python3',
    [
      '-c',
      `
import json, os, sys
from PIL import Image

raw_dir, out_dir, specs_json = sys.argv[1], sys.argv[2], sys.argv[3]
specs = json.loads(specs_json)

for rel_path, target_w, target_h in specs:
    fname = os.path.basename(rel_path)
    src = os.path.join(raw_dir, fname)
    dst = os.path.join(out_dir, fname)
    im = Image.open(src)
    if im.mode != 'RGB':
        bg = Image.new('RGB', im.size, (245, 246, 248))
        if 'A' in im.getbands():
            bg.paste(im, mask=im.split()[-1])
        else:
            bg.paste(im)
        im = bg
    if im.size != (target_w, target_h):
        im = im.resize((target_w, target_h), Image.Resampling.LANCZOS)
    im.save(dst, format='PNG', optimize=True)
    with open(dst, 'rb') as f:
        hdr = f.read(26)
    w = int.from_bytes(hdr[16:20], 'big')
    h = int.from_bytes(hdr[20:24], 'big')
    ct = hdr[25]
    assert (w, h, ct) == (target_w, target_h, 2), f"Invalid PNG {fname}: {(w, h, ct)}"
    print(f"Built {rel_path} ({w}x{h} 24-bit RGB, {os.path.getsize(dst)} bytes)")
`,
      raw2xDir,
      outDir,
      JSON.stringify(STORE_ASSET_SPECS),
    ],
    { stdio: 'inherit' }
  );

  fs.rmSync(tempRoot, { recursive: true, force: true });

  // Write deterministic asset manifest tracking both input source hashes and output PNG hashes
  const outputHashes = {};
  for (const [relPath] of STORE_ASSET_SPECS) {
    outputHashes[relPath] = sha256File(path.join(rootDir, relPath));
  }
  const manifestData = {
    comment: 'Generated by npm run build:assets (scripts/generate-store-assets.mjs). Do not edit manually.',
    sourceHashes: computeAssetSourceHashes(rootDir),
    outputHashes,
  };
  fs.writeFileSync(
    path.join(outDir, '.asset-manifest.json'),
    `${JSON.stringify(manifestData, null, 2)}\n`,
    'utf8'
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateAllStoreAssets();
}
