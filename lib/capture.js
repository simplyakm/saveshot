import { SaveShotError } from './errors.js';

const RESTRICTED_PROTOCOLS = new Set([
  'chrome:',
  'chrome-extension:',
  'chrome-search:',
  'chrome-untrusted:',
  'chrome-error:',
  'devtools:',
  'edge:',
  'brave:',
  'vivaldi:',
  'opera:',
  'about:',
  'view-source:',
  'javascript:',
]);

const REGION_UNSUPPORTED_PROTOCOLS = new Set(['data:', 'blob:', 'filesystem:']);
const RESTRICTED_HOSTS = new Set(['chrome.google.com', 'chromewebstore.google.com']);

export function isCapturableUrl(url, { allowFileScheme = true } = {}) {
  if (!url || typeof url !== 'string') {
    return {
      ok: false,
      canCaptureVisible: false,
      canCaptureRegion: false,
      code: 'NO_ACTIVE_TAB',
      reason: 'No active webpage found to capture.',
    };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      canCaptureVisible: false,
      canCaptureRegion: false,
      code: 'INVALID_URL',
      reason: 'This page cannot be captured.',
    };
  }

  if (RESTRICTED_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      canCaptureVisible: false,
      canCaptureRegion: false,
      code: 'BROWSER_INTERNAL_PAGE',
      reason: 'Chrome blocks screenshots on browser internal pages. Open a normal webpage and try again.',
    };
  }

  if (parsed.protocol === 'file:' && !allowFileScheme) {
    return {
      ok: false,
      canCaptureVisible: false,
      canCaptureRegion: false,
      code: 'FILE_ACCESS_DISABLED',
      reason: 'To capture local file:// pages or PDFs, turn on "Allow access to file URLs" for SaveShot in chrome://extensions.',
    };
  }

  if (
    RESTRICTED_HOSTS.has(parsed.hostname) &&
    (parsed.hostname === 'chromewebstore.google.com' || parsed.pathname.startsWith('/webstore'))
  ) {
    return {
      ok: false,
      canCaptureVisible: false,
      canCaptureRegion: false,
      code: 'WEBSTORE_RESTRICTED',
      reason: 'Chrome blocks extensions on the Chrome Web Store. Switch to another webpage to take a screenshot.',
    };
  }

  if (REGION_UNSUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: true,
      canCaptureVisible: true,
      canCaptureRegion: false,
      code: 'DATA_URL_NO_REGION',
      reason: null,
      regionDisabledReason: 'Region selection does not work on data: or blob: URLs. Use "Visible Tab" instead.',
    };
  }

  return {
    ok: true,
    canCaptureVisible: true,
    canCaptureRegion: true,
    code: null,
    reason: null,
    regionDisabledReason: null,
  };
}

export function buildScreenshotFilename(pageUrl, now = new Date(), { incognito = false } = {}) {
  const safeNow =
    now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const datePart = `${safeNow.getFullYear()}-${pad(safeNow.getMonth() + 1)}-${pad(safeNow.getDate())}`;
  const timePart = `${pad(safeNow.getHours())}-${pad(safeNow.getMinutes())}-${pad(safeNow.getSeconds())}`;

  let hostSlug = incognito ? 'incognito' : 'tab';
  if (!incognito && pageUrl) {
    try {
      const parsed = new URL(pageUrl);
      if (parsed.protocol === 'file:') {
        hostSlug = 'local-file';
      } else if (parsed.hostname) {
        const cleaned = parsed.hostname
          .replace(/^www\./i, '')
          .replace(/[^a-zA-Z0-9.-]+/g, '_')
          .replace(/^[._-]+|[._-]+$/g, '')
          .slice(0, 40);
        if (cleaned) hostSlug = cleaned;
      }
    } catch {
      // Keep default slug
    }
  }

  return `Screenshot_${datePart}_${timePart}_${hostSlug}.png`;
}

function finiteOr(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function computeCropRect(selection, bitmapWidth, bitmapHeight) {
  const sel = selection && typeof selection === 'object' ? selection : {};
  const safeBmpW = Math.max(1, Math.round(finiteOr(bitmapWidth, 1)) || 1);
  const safeBmpH = Math.max(1, Math.round(finiteOr(bitmapHeight, 1)) || 1);

  const rawVpW = finiteOr(sel.viewportWidth, safeBmpW);
  const rawVpH = finiteOr(sel.viewportHeight, safeBmpH);
  const viewportWidth = rawVpW > 0 ? rawVpW : safeBmpW;
  const viewportHeight = rawVpH > 0 ? rawVpH : safeBmpH;

  const rawVvScale = finiteOr(sel.visualViewportScale, 1);
  const vvScale = rawVvScale > 0 ? rawVvScale : 1;
  const offsetLeft = finiteOr(sel.visualViewportOffsetLeft, 0);
  const offsetTop = finiteOr(sel.visualViewportOffsetTop, 0);
  const rawDpr = finiteOr(sel.devicePixelRatio, 0);
  const dpr = rawDpr > 0 ? rawDpr : 0;

  let baseScaleX = safeBmpW / viewportWidth;
  let baseScaleY = safeBmpH / viewportHeight;
  if (
    dpr > 0 &&
    Math.abs(safeBmpW - viewportWidth * dpr) <= Math.max(4, Math.ceil(dpr * 2)) &&
    Math.abs(safeBmpH - viewportHeight * dpr) <= Math.max(4, Math.ceil(dpr * 2))
  ) {
    baseScaleX = dpr;
    baseScaleY = dpr;
  }

  const scaleX = baseScaleX * vvScale;
  const scaleY = baseScaleY * vvScale;

  const selX = finiteOr(sel.x, 0);
  const selY = finiteOr(sel.y, 0);
  const selW = Math.max(0, finiteOr(sel.width, safeBmpW));
  const selH = Math.max(0, finiteOr(sel.height, safeBmpH));

  const rawX = Math.round((selX - offsetLeft) * scaleX);
  const rawY = Math.round((selY - offsetTop) * scaleY);
  const rawEndX = Math.round((selX + selW - offsetLeft) * scaleX);
  const rawEndY = Math.round((selY + selH - offsetTop) * scaleY);

  const x = Math.max(0, Math.min(safeBmpW - 1, rawX));
  const y = Math.max(0, Math.min(safeBmpH - 1, rawY));
  const clampedEndX = Math.max(x + 1, Math.min(safeBmpW, rawEndX));
  const clampedEndY = Math.max(y + 1, Math.min(safeBmpH, rawEndY));

  return { x, y, width: clampedEndX - x, height: clampedEndY - y };
}

export async function dataUrlToBlob(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new SaveShotError({
      code: 'EMPTY_CAPTURE',
      userMessage: 'Chrome returned an empty screenshot. Make sure the window is visible on screen and try again.',
    });
  }
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  if (!blob || blob.size === 0) {
    throw new SaveShotError({
      code: 'EMPTY_CAPTURE',
      userMessage: 'Captured image was empty. Bring the browser window into view and try again.',
    });
  }
  return blob;
}

export async function cropPngDataUrl(dataUrl, selection) {
  const sourceBlob = await dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(sourceBlob);
  try {
    const rect = computeCropRect(selection, bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(rect.width, rect.height);
    canvas.getContext('2d').drawImage(
      bitmap,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      rect.width,
      rect.height
    );
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    bitmap.close();
  }
}

export async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

/**
 * Create a tiny WebP thumbnail (~800 bytes) sized for the 46x34 popup preview box.
 */
export async function createThumbnailDataUrl(pngBlob, maxWidth = 96) {
  const bitmap = await createImageBitmap(pngBlob);
  try {
    const scale = Math.min(1, maxWidth / Math.max(1, bitmap.width));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    let thumbBlob;
    try {
      thumbBlob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.6 });
    } catch {
      thumbBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.65 });
    }
    return await blobToDataUrl(thumbBlob);
  } finally {
    bitmap.close();
  }
}
