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

const RESERVED_WINDOWS_BASENAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeScreenshotFilename(rawName, fallback = 'Screenshot.png') {
  const cleanBase = (input) => {
    const withoutControls = String(input ?? '').replace(
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g,
      ''
    );

    const pathSafe = withoutControls
      .split(/[\\/]+/)
      .map((seg) => seg.trim())
      .filter((seg) => seg && seg !== '.' && seg !== '..')
      .join('_');

    const stripped = pathSafe
      .replace(/[<>:"|?*]+/g, '_')
      .replace(/\.{2,}/g, '.')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/(?:\.png)+$/i, '')
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .slice(0, 100)
      .replace(/^[\s.]+|[\s.]+$/g, '');

    if (!stripped || RESERVED_WINDOWS_BASENAMES.test(stripped)) {
      return '';
    }
    return stripped;
  };

  const base = cleanBase(rawName) || cleanBase(fallback) || 'Screenshot';
  return `${base}.png`;
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

export const FULLPAGE_LIMITS = Object.freeze({
  MAX_SLICES: 24,
  MAX_PHYSICAL_HEIGHT: 16000,
  MAX_TOTAL_PIXELS: 40_000_000,
});

/**
 * Returns true if liveUrl is still the same document origin as initialUrl,
 * allowing same-document history.replaceState(), ?query, and #hash updates
 * during infinite scroll while blocking cross-origin redirects and opaque origins.
 */
export function isSameDocumentCaptureUrl(initialUrl, liveUrl) {
  if (!initialUrl || !liveUrl) return false;
  if (initialUrl === liveUrl) return true;
  try {
    const a = new URL(initialUrl);
    const b = new URL(liveUrl);
    if (a.protocol !== b.protocol) return false;
    if (a.protocol === 'http:' || a.protocol === 'https:') {
      return a.origin !== 'null' && a.origin === b.origin;
    }
    if (a.protocol === 'file:') {
      return a.pathname === b.pathname;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Compute exact source crop and destination Y for a single full-page scroll slice.
 * Handles top-overlap crop-out, bottom-of-page overlap clamping, fractional HiDPI/zoom
 * scaling with zero cumulative drift, inner scroll containers, and GPU canvas caps.
 */
export function planFullPageSlice({
  sliceIndex = 0,
  prevScrollY = 0,
  actualScrollY = 0,
  viewportHeight = 1,
  viewportWidth = 1,
  bitmapWidth = 1,
  bitmapHeight = 1,
  devicePixelRatio = 0,
  containerRect = null,
  lockedCanvasWidth = 0,
  currentPhysicalHeight = 0,
  maxPhysicalHeight = FULLPAGE_LIMITS.MAX_PHYSICAL_HEIGHT,
  maxTotalPixels = FULLPAGE_LIMITS.MAX_TOTAL_PIXELS,
} = {}) {
  const safeBmpW = Math.max(1, Math.round(finiteOr(bitmapWidth, 1)) || 1);
  const safeBmpH = Math.max(1, Math.round(finiteOr(bitmapHeight, 1)) || 1);
  const safeVpW = Math.max(1, finiteOr(viewportWidth, safeBmpW));
  const safeVpH = Math.max(1, finiteOr(viewportHeight, safeBmpH));
  const rawDpr = finiteOr(devicePixelRatio, 0);
  const dpr = rawDpr > 0 ? rawDpr : 0;

  let scaleX = safeBmpW / safeVpW;
  let scaleY = safeBmpH / safeVpH;
  if (
    dpr > 0 &&
    Math.abs(safeBmpW - safeVpW * dpr) <= Math.max(4, Math.ceil(dpr * 2)) &&
    Math.abs(safeBmpH - safeVpH * dpr) <= Math.max(4, Math.ceil(dpr * 2))
  ) {
    scaleX = dpr;
    scaleY = dpr;
  }

  let sx = 0;
  let sw = safeBmpW;
  let containerTopPx = 0;
  let containerHeightPx = safeBmpH;

  if (containerRect && typeof containerRect === 'object') {
    const rx = Math.max(0, Math.round(finiteOr(containerRect.left, 0) * scaleX));
    const ry = Math.max(0, Math.round(finiteOr(containerRect.top, 0) * scaleY));
    const rw = Math.max(1, Math.round(finiteOr(containerRect.width, safeVpW) * scaleX));
    const rh = Math.max(1, Math.round(finiteOr(containerRect.height, safeVpH) * scaleY));
    sx = Math.min(safeBmpW - 1, rx);
    sw = Math.max(1, Math.min(safeBmpW - sx, rw));
    containerTopPx = Math.min(safeBmpH - 1, ry);
    containerHeightPx = Math.max(1, Math.min(safeBmpH - containerTopPx, rh));
  }

  const budgetWidth = Math.max(sw, Math.round(finiteOr(lockedCanvasWidth, 0)));
  const effectiveMaxHeight = Math.max(
    1,
    Math.min(
      Math.floor(finiteOr(maxPhysicalHeight, FULLPAGE_LIMITS.MAX_PHYSICAL_HEIGHT)),
      Math.floor(finiteOr(maxTotalPixels, FULLPAGE_LIMITS.MAX_TOTAL_PIXELS) / budgetWidth)
    )
  );

  const curH = Math.max(0, Math.round(finiteOr(currentPhysicalHeight, 0)));
  const remainingHeight = Math.max(0, effectiveMaxHeight - curH);
  if (remainingHeight <= 0) {
    return {
      skip: true,
      truncated: true,
      sx,
      sy: containerTopPx,
      sw,
      sh: 0,
      dy: curH,
      nextPhysicalHeight: curH,
      canvasWidth: sw,
    };
  }

  if (sliceIndex === 0) {
    const sh = Math.min(containerHeightPx, remainingHeight);
    return {
      skip: sh <= 0,
      truncated: sh < containerHeightPx,
      sx,
      sy: containerTopPx,
      sw,
      sh,
      dy: 0,
      nextPhysicalHeight: sh,
      canvasWidth: sw,
    };
  }

  const curScrollY = finiteOr(actualScrollY, 0);
  const oldScrollY = finiteOr(prevScrollY, 0);
  const deltaCss = curScrollY - oldScrollY;
  if (deltaCss <= 0.5) {
    return {
      skip: true,
      truncated: false,
      sx,
      sy: containerTopPx,
      sw,
      sh: 0,
      dy: curH,
      nextPhysicalHeight: curH,
      canvasWidth: sw,
    };
  }

  // Quantize cumulative scroll offsets rather than per-slice deltas for zero drift across fractional DPR/zoom
  const quantizedDeltaPx = Math.round(curScrollY * scaleY) - Math.round(oldScrollY * scaleY);
  const deltaPx = Math.max(1, Math.min(containerHeightPx, quantizedDeltaPx));
  // Copy only the newly exposed bottom strip of the captured frame, automatically cropping top overlap
  const rawSy = containerTopPx + (containerHeightPx - deltaPx);
  const sh = Math.min(deltaPx, remainingHeight);

  return {
    skip: sh <= 0,
    truncated: sh < deltaPx,
    sx,
    sy: rawSy,
    sw,
    sh,
    dy: curH,
    nextPhysicalHeight: curH + sh,
    canvasWidth: sw,
  };
}

export async function dataUrlToBlob(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new SaveShotError({
      code: 'EMPTY_CAPTURE',
      userMessage: 'Chrome returned an empty screenshot. Make sure the window is visible on screen and try again.',
    });
  }

  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx > 0) {
    const header = dataUrl.slice(5, commaIdx);
    if (header.endsWith(';base64')) {
      const mime = header.slice(0, -7) || 'image/png';
      const b64 = dataUrl.slice(commaIdx + 1);
      if (typeof Uint8Array.fromBase64 === 'function') {
        let bytes;
        try {
          bytes = Uint8Array.fromBase64(b64);
        } catch {
          throw new SaveShotError({
            code: 'EMPTY_CAPTURE',
            userMessage: 'Captured image data was invalid. Try taking the screenshot again.',
          });
        }
        if (!bytes || bytes.length === 0) {
          throw new SaveShotError({
            code: 'EMPTY_CAPTURE',
            userMessage: 'Captured image was empty. Bring the browser window into view and try again.',
          });
        }
        return new Blob([bytes], { type: mime });
      }

      let binary = '';
      try {
        binary = atob(b64);
      } catch {
        throw new SaveShotError({
          code: 'EMPTY_CAPTURE',
          userMessage: 'Captured image data was invalid. Try taking the screenshot again.',
        });
      }
      if (binary.length === 0) {
        throw new SaveShotError({
          code: 'EMPTY_CAPTURE',
          userMessage: 'Captured image was empty. Bring the browser window into view and try again.',
        });
      }
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new Blob([bytes], { type: mime });
    }
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
  if (typeof bytes.toBase64 === 'function') {
    return `data:${blob.type || 'image/png'};base64,${bytes.toBase64()}`;
  }
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

async function readPngHeaderWidth(blob) {
  if (!blob || typeof blob.slice !== 'function') return null;
  try {
    const header = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
    if (
      header.length >= 24 &&
      header[0] === 0x89 &&
      header[1] === 0x50 &&
      header[2] === 0x4e &&
      header[3] === 0x47 &&
      header[4] === 0x0d &&
      header[5] === 0x0a &&
      header[6] === 0x1a &&
      header[7] === 0x0a
    ) {
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
      return view.getUint32(16, false);
    }
  } catch {
    // Fall back when header inspection is unavailable
  }
  return null;
}

/**
 * Create a tiny WebP thumbnail (~800 bytes) sized for the 42x30 popup preview box.
 * Uses top-cropping and capped height (96x72 max) so tall full-page captures stay tiny,
 * and avoids upscaling narrow captures smaller than maxWidth.
 */
export async function createThumbnailDataUrl(pngBlob, maxWidth = 96, maxHeight = 72) {
  const pngWidth = await readPngHeaderWidth(pngBlob);
  const shouldResizeOnDecode = pngWidth === null || pngWidth > maxWidth;
  let bitmap;
  if (shouldResizeOnDecode) {
    try {
      bitmap = await createImageBitmap(pngBlob, {
        resizeWidth: maxWidth,
        resizeQuality: 'medium',
      });
    } catch {
      bitmap = await createImageBitmap(pngBlob);
    }
  } else {
    bitmap = await createImageBitmap(pngBlob);
  }
  try {
    const srcW = Math.max(1, bitmap.width);
    const srcH = Math.max(1, bitmap.height);
    const scale = Math.min(1, maxWidth / srcW);
    const width = Math.max(1, Math.round(srcW * scale));
    const fullScaledHeight = Math.max(1, Math.round(srcH * scale));
    const height = Math.min(maxHeight, fullScaledHeight);
    const srcCropH = Math.max(1, Math.min(srcH, Math.round(height / scale)));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, srcW, srcCropH, 0, 0, width, height);
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

export const SAVESHOT_BLOB_CACHE = 'saveshot-blobs-v1';
const BLOB_CACHE_PATH_PREFIX = '/__saveshot_blob__/';
const BLOB_CACHE_ID_PATTERN = /^[a-zA-Z0-9-]{8,64}$/;
const BLOB_CACHE_TTL_MS = 2 * 60 * 1000;
const BLOB_CACHE_MAX_ENTRIES = 8;

export function isValidBlobTransferUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const extOrigin =
      typeof chrome?.runtime?.getURL === 'function'
        ? new URL(chrome.runtime.getURL('')).origin
        : '';
    const parsed = new URL(url);
    if (extOrigin && parsed.origin !== extOrigin) return false;
    if (!parsed.pathname.startsWith(BLOB_CACHE_PATH_PREFIX)) return false;
    const key = parsed.pathname.slice(BLOB_CACHE_PATH_PREFIX.length);
    return BLOB_CACHE_ID_PATTERN.test(key);
  } catch {
    return false;
  }
}

async function pruneStaleTransferCacheEntries(cache) {
  if (!cache || typeof cache.keys !== 'function') return;
  try {
    const keys = await cache.keys();
    if (!Array.isArray(keys) || keys.length === 0) return;
    const now = Date.now();
    const surviving = [];
    for (const req of keys) {
      const resp = await cache.match(req).catch(() => null);
      const createdAt = Number(resp?.headers?.get?.('X-SaveShot-Created-At') || 0);
      if (!createdAt || now - createdAt > BLOB_CACHE_TTL_MS) {
        await cache.delete(req).catch(() => {});
      } else {
        surviving.push({ req, createdAt });
      }
    }
    if (surviving.length >= BLOB_CACHE_MAX_ENTRIES) {
      surviving.sort((a, b) => a.createdAt - b.createdAt);
      const dropCount = surviving.length - BLOB_CACHE_MAX_ENTRIES + 1;
      for (let i = 0; i < dropCount; i += 1) {
        await cache.delete(surviving[i].req).catch(() => {});
      }
    }
  } catch {
    // Best-effort pruning
  }
}

export async function putBlobInTransferCache(blob) {
  if (
    !blob ||
    typeof globalThis.caches?.open !== 'function' ||
    typeof chrome?.runtime?.getURL !== 'function'
  ) {
    return '';
  }
  const id =
    typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  const url = chrome.runtime.getURL(`__saveshot_blob__/${id}`);
  try {
    const cache = await globalThis.caches.open(SAVESHOT_BLOB_CACHE);
    await pruneStaleTransferCacheEntries(cache);
    await cache.put(
      url,
      new Response(blob, {
        headers: {
          'Content-Type': blob.type || 'image/png',
          'X-SaveShot-Created-At': String(Date.now()),
        },
      })
    );
    return url;
  } catch {
    return '';
  }
}

export async function deleteBlobFromTransferCache(url) {
  if (!isValidBlobTransferUrl(url) || typeof globalThis.caches?.open !== 'function') {
    return;
  }
  try {
    const cache = await globalThis.caches.open(SAVESHOT_BLOB_CACHE);
    await cache.delete(url);
  } catch {
    // Ignore cleanup errors
  }
}

export async function takeBlobFromTransferCache(url) {
  if (!isValidBlobTransferUrl(url) || typeof globalThis.caches?.open !== 'function') {
    return null;
  }
  try {
    const cache = await globalThis.caches.open(SAVESHOT_BLOB_CACHE);
    const resp = await cache.match(url);
    await cache.delete(url).catch(() => {});
    if (!resp) return null;
    return await resp.blob();
  } catch {
    return null;
  }
}

export async function clearBlobTransferCache() {
  if (typeof globalThis.caches?.delete !== 'function') return;
  try {
    await globalThis.caches.delete(SAVESHOT_BLOB_CACHE);
  } catch {
    // Ignore cache cleanup errors
  }
}
