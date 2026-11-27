// Zero-dependency PDF 1.4 exporter with smart non-clipping page-break detection.
// Uses Chromium's native PNG encoder (IDAT passthrough for lossless RGB text/UI)
// with automatic per-page JPEG fallback for photo-heavy slices.

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEXT_ENCODER = new TextEncoder();

export const PDF_LIMITS = Object.freeze({
  A4_WIDTH_PT: 595.28,
  A4_HEIGHT_PT: 841.89,
  MARGIN_PT: 24,
  MAX_PAGE_PT: 14400,
  MIN_PAGE_PT: 36,
  MAX_PT_PER_PX: 0.75,
  TALL_ASPECT_THRESHOLD: 1.55,
  MAX_PAGES: 50,
  MAX_SOURCE_PIXELS: 50_000_000,
  MAX_CANVAS_DIM: 32767,
  MAX_SCAN_WIDTH: 1920,
  MAX_SEARCH_UP_PX: 480,
  PNG_MAX_BYTES_PER_PX: 0.35,
  PNG_MIN_FLOOR_BYTES: 48 * 1024,
  PNG_MAX_SLICE_BYTES: 1_500_000,
  JPEG_QUALITY: 0.92,
});

function readUint32BE(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

/**
 * Validate an 8-bit non-interlaced RGB PNG (colorType 2) with no tRNS chunk and concatenate
 * its contiguous IDAT payload. Returns { width, height, idatBytes } or null if ineligible.
 */
export function extractRgbPngIdat(pngBytes) {
  if (!(pngBytes instanceof Uint8Array) || pngBytes.byteLength < 45) {
    return null;
  }
  for (let i = 0; i < 8; i += 1) {
    if (pngBytes[i] !== PNG_SIGNATURE[i]) return null;
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  let sawIdat = false;
  let endedIdat = false;
  let sawIend = false;
  const idatSlices = [];
  let totalIdatBytes = 0;

  while (offset + 12 <= pngBytes.byteLength) {
    const chunkLen = readUint32BE(pngBytes, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLen;
    const nextOffset = dataEnd + 4; // +4 for CRC
    if (nextOffset > pngBytes.byteLength) {
      return null;
    }

    const t0 = pngBytes[offset + 4];
    const t1 = pngBytes[offset + 5];
    const t2 = pngBytes[offset + 6];
    const t3 = pngBytes[offset + 7];

    // IHDR must be the very first chunk at offset 8
    if (t0 === 0x49 && t1 === 0x48 && t2 === 0x44 && t3 === 0x52) {
      if (offset !== 8 || sawIhdr || chunkLen !== 13) return null;
      width = readUint32BE(pngBytes, dataStart);
      height = readUint32BE(pngBytes, dataStart + 4);
      const bitDepth = pngBytes[dataStart + 8];
      const colorType = pngBytes[dataStart + 9];
      const compression = pngBytes[dataStart + 10];
      const filterMethod = pngBytes[dataStart + 11];
      const interlace = pngBytes[dataStart + 12];
      if (
        width < 1 ||
        height < 1 ||
        bitDepth !== 8 ||
        colorType !== 2 ||
        compression !== 0 ||
        filterMethod !== 0 ||
        interlace !== 0
      ) {
        return null;
      }
      sawIhdr = true;
    } else if (t0 === 0x74 && t1 === 0x52 && t2 === 0x4e && t3 === 0x53) {
      // tRNS defines a transparent RGB key; never pass through to /DeviceRGB
      return null;
    } else if (t0 === 0x49 && t1 === 0x44 && t2 === 0x41 && t3 === 0x54) {
      // IDAT chunks must follow IHDR and remain contiguous
      if (!sawIhdr || endedIdat) return null;
      sawIdat = true;
      if (chunkLen > 0) {
        idatSlices.push(pngBytes.subarray(dataStart, dataEnd));
        totalIdatBytes += chunkLen;
      }
    } else if (t0 === 0x49 && t1 === 0x45 && t2 === 0x4e && t3 === 0x44) {
      // IEND must have length 0
      if (chunkLen !== 0) return null;
      sawIend = true;
      break;
    } else {
      if (!sawIhdr) return null;
      if (sawIdat) endedIdat = true;
    }

    offset = nextOffset;
  }

  if (!sawIhdr || !sawIend || totalIdatBytes === 0) {
    return null;
  }

  if (idatSlices.length === 1) {
    return { width, height, idatBytes: new Uint8Array(idatSlices[0]) };
  }

  const idatBytes = new Uint8Array(totalIdatBytes);
  let pos = 0;
  for (const slice of idatSlices) {
    idatBytes.set(slice, pos);
    pos += slice.byteLength;
  }
  return { width, height, idatBytes };
}

/**
 * Find the safest horizontal cut row inside an RGBA pixel band so text lines are not clipped.
 * Searches upward in [minOffsetY, targetOffsetY] using channel-aware RGB horizontal + vertical
 * contrast, center-column weighting (for multi-column/sidebar layouts), a 5-row anti-sliver
 * cushion, clean-gutter centering bonus, and full-bleed photo snap-back.
 */
export function findSmartPageBreak(rgba, width, height, targetOffsetY, opts = {}) {
  const safeW = Math.max(1, Math.floor(Number(width) || 0));
  const safeH = Math.max(1, Math.floor(Number(height) || 0));
  const clampedTarget = Math.max(0, Math.min(safeH - 1, Math.floor(Number(targetOffsetY) || 0)));
  const minOffsetY = Math.max(0, Math.min(clampedTarget, Math.floor(Number(opts.minOffsetY) || 0)));

  if (
    !(rgba instanceof Uint8ClampedArray || rgba instanceof Uint8Array) ||
    rgba.length < safeW * safeH * 4 ||
    clampedTarget <= minOffsetY ||
    safeW < 8
  ) {
    return clampedTarget;
  }

  const xStart = Math.min(4, Math.max(0, Math.floor(safeW * 0.02)));
  const xEnd = Math.max(xStart + 2, safeW - Math.min(16, Math.floor(safeW * 0.04)));
  const leftRailEnd = xStart + Math.floor((xEnd - xStart) * 0.15);
  const rightRailStart = xEnd - Math.floor((xEnd - xStart) * 0.15);

  const T_EDGE = 24;
  const EDGE_CAP = 120;
  const rowEnergy = new Float32Array(safeH);

  let weightSum = 0;
  for (let x = xStart + 1; x < xEnd; x += 1) {
    weightSum += x < leftRailEnd || x >= rightRailStart ? 0.6 : 1.0;
  }
  const invWeight = weightSum > 0 ? 1 / weightSum : 1;

  for (let y = 0; y < safeH; y += 1) {
    const rowBase = y * safeW * 4;
    const prevRowBase = y > 0 ? (y - 1) * safeW * 4 : rowBase;
    let hSum = 0;
    let vSum = 0;

    for (let x = xStart + 1; x < xEnd; x += 1) {
      const idx = rowBase + x * 4;
      const leftIdx = idx - 4;
      const r = rgba[idx];
      const g = rgba[idx + 1];
      const b = rgba[idx + 2];

      const hDiff =
        Math.abs(r - rgba[leftIdx]) +
        Math.abs(g - rgba[leftIdx + 1]) +
        Math.abs(b - rgba[leftIdx + 2]);
      const colW = x < leftRailEnd || x >= rightRailStart ? 0.6 : 1.0;

      if (hDiff > T_EDGE) {
        const excess = hDiff - T_EDGE;
        hSum += (excess < EDGE_CAP ? excess : EDGE_CAP) * colW;
      }

      if (y > 0) {
        const upIdx = prevRowBase + x * 4;
        const vDiff =
          Math.abs(r - rgba[upIdx]) +
          Math.abs(g - rgba[upIdx + 1]) +
          Math.abs(b - rgba[upIdx + 2]);
        if (vDiff > T_EDGE) {
          const vExcess = vDiff - T_EDGE;
          vSum += (vExcess < EDGE_CAP ? vExcess : EDGE_CAP) * colW;
        }
      }
    }

    rowEnergy[y] = (hSum + 0.35 * vSum) * invWeight;
  }

  // 5-row anti-sliver cushion suppresses 1-2px false gaps inside i/j dots, '=', or descenders
  const cushioned = new Float32Array(safeH);
  for (let y = 0; y < safeH; y += 1) {
    const e0 = rowEnergy[y];
    const em1 = rowEnergy[y > 0 ? y - 1 : 0];
    const ep1 = rowEnergy[y + 1 < safeH ? y + 1 : safeH - 1];
    const em2 = rowEnergy[y > 1 ? y - 2 : 0];
    const ep2 = rowEnergy[y + 2 < safeH ? y + 2 : safeH - 1];
    const localMax = em1 > e0 ? (em1 > ep1 ? em1 : ep1) : e0 > ep1 ? e0 : ep1;
    cushioned[y] = 0.4 * e0 + 0.2 * (em1 + ep1) + 0.1 * (em2 + ep2) + 0.25 * localMax;
  }

  // Identify clean whitespace/uniform bands for gutter-centering bonus (scaled by cleanliness)
  const CLEAN_EPS = 0.35;
  const runBonus = new Float32Array(safeH);
  let yCursor = minOffsetY;
  while (yCursor <= clampedTarget) {
    if (cushioned[yCursor] < CLEAN_EPS) {
      const start = yCursor;
      while (yCursor <= clampedTarget && cushioned[yCursor] < CLEAN_EPS) {
        yCursor += 1;
      }
      const end = yCursor - 1;
      const runLen = end - start + 1;
      if (runLen >= 3) {
        const mid = (start + end) * 0.5;
        const half = Math.max(1, runLen * 0.5);
        const thicknessFactor = Math.min(1, runLen / 16);
        for (let r = start; r <= end; r += 1) {
          const centerProximity = 1 - Math.abs(r - mid) / half;
          const cleanliness = Math.max(0, 1 - cushioned[r] / CLEAN_EPS);
          runBonus[r] = 0.35 * thicknessFactor * cleanliness * (0.4 + 0.6 * centerProximity);
        }
      }
    } else {
      yCursor += 1;
    }
  }

  const searchSpan = Math.max(1, clampedTarget - minOffsetY);
  const DIST_LAMBDA = 0.9;
  let bestY = clampedTarget;
  let bestCost = Infinity;
  let bestS = cushioned[clampedTarget];

  for (let y = minOffsetY; y <= clampedTarget; y += 1) {
    const relDist = (clampedTarget - y) / searchSpan;
    const cost = cushioned[y] - runBonus[y] + DIST_LAMBDA * relDist * relDist;
    if (cost < bestCost) {
      bestCost = cost;
      bestY = y;
      bestS = cushioned[y];
    }
  }

  // Full-bleed photo / chart fallback: if no row in the window is meaningfully cleaner
  // than the target break itself, snap cleanly to targetOffsetY instead of cutting early.
  const targetS = cushioned[clampedTarget];
  const PHOTO_CLEAN_THRESHOLD = 2.5;
  if (bestS > PHOTO_CLEAN_THRESHOLD && bestS > 0.65 * targetS) {
    return clampedTarget;
  }

  return bestY;
}

function clampPagePt(val) {
  return Math.max(PDF_LIMITS.MIN_PAGE_PT, Math.min(PDF_LIMITS.MAX_PAGE_PT, val));
}

/**
 * Plan PDF page geometry and source pixel slice ranges [y, y + height) for a canvas.
 * Short/normal captures fit onto a single aspect-matched page; tall captures paginate onto A4
 * with smart non-clipping breaks, orphan-sliver balancing, and narrow-crop upscale protection.
 */
export function planPdfPageSlices(
  srcWidth,
  srcHeight,
  { getBandRgba = null, maxPages = PDF_LIMITS.MAX_PAGES } = {}
) {
  const w = Math.max(1, Math.floor(Number(srcWidth) || 0));
  const h = Math.max(1, Math.floor(Number(srcHeight) || 0));
  const safeMaxPages = Math.max(1, Math.min(PDF_LIMITS.MAX_PAGES, Math.floor(Number(maxPages) || PDF_LIMITS.MAX_PAGES)));

  // 1. Short / normal captures: single crisp content-fitted page matching aspect ratio
  if (h / w <= PDF_LIMITS.TALL_ASPECT_THRESHOLD) {
    const baseW = w >= h ? PDF_LIMITS.A4_HEIGHT_PT : PDF_LIMITS.A4_WIDTH_PT;
    let ptPerPx = Math.min(baseW / w, PDF_LIMITS.MAX_PT_PER_PX);
    if (w * ptPerPx > PDF_LIMITS.MAX_PAGE_PT) {
      ptPerPx = PDF_LIMITS.MAX_PAGE_PT / w;
    }
    if (h * ptPerPx > PDF_LIMITS.MAX_PAGE_PT) {
      ptPerPx = PDF_LIMITS.MAX_PAGE_PT / h;
    }
    const drawW = Math.max(1, w * ptPerPx);
    const drawH = Math.max(1, h * ptPerPx);
    const pageW = clampPagePt(drawW);
    const pageH = clampPagePt(drawH);
    const fitScale = Math.min(1, pageW / drawW, pageH / drawH);
    const finalDrawW = drawW * fitScale;
    const finalDrawH = drawH * fitScale;
    return [
      {
        y: 0,
        height: h,
        pageW,
        pageH,
        drawX: (pageW - finalDrawW) / 2,
        drawY: (pageH - finalDrawH) / 2,
        drawW: finalDrawW,
        drawH: finalDrawH,
      },
    ];
  }

  // 2. Tall captures: paginate onto standard A4 Portrait with 24pt margins
  const pageW = PDF_LIMITS.A4_WIDTH_PT;
  const pageH = PDF_LIMITS.A4_HEIGHT_PT;
  const margin = PDF_LIMITS.MARGIN_PT;
  const printableW = pageW - margin * 2;
  const printableH = pageH - margin * 2;

  const ptPerPx = Math.min(printableW / w, PDF_LIMITS.MAX_PT_PER_PX);
  const idealPagePx = Math.max(1, Math.floor(printableH / ptPerPx));

  const makeA4Slice = (y, sliceH) => {
    const scale = Math.min(ptPerPx, printableH / sliceH);
    const drawW = w * scale;
    const drawH = sliceH * scale;
    return {
      y,
      height: sliceH,
      pageW,
      pageH,
      drawX: (pageW - drawW) / 2,
      // PDF origin is bottom-left; top-align slice inside printable area
      drawY: pageH - margin - drawH,
      drawW,
      drawH,
    };
  };

  // Mild <= 12% single-page overflow fits cleanly on 1 A4 page without splitting
  if (h <= Math.round(idealPagePx * 1.12)) {
    return [makeA4Slice(0, h)];
  }

  const slices = [];
  let currentY = 0;

  while (currentY < h && slices.length < safeMaxPages) {
    const remaining = h - currentY;
    const isLastAllowed = slices.length === safeMaxPages - 1;

    // Absorb <= 4% final sliver cleanly onto the current page
    if (isLastAllowed || remaining <= Math.round(idealPagePx * 1.04)) {
      slices.push(makeA4Slice(currentY, remaining));
      currentY = h;
      break;
    }

    // Rebalance penultimate page when remaining would otherwise leave a tiny < 25% trailing stub
    const isRebalanced = remaining <= Math.round(idealPagePx * 1.25);
    let targetY = isRebalanced
      ? currentY + Math.round(remaining * 0.55)
      : currentY + idealPagePx;
    targetY = Math.min(h - 1, Math.max(currentY + 1, targetY));

    let chosenY = targetY;
    if (typeof getBandRgba === 'function') {
      const searchUp = Math.min(Math.round(idealPagePx * 0.22), PDF_LIMITS.MAX_SEARCH_UP_PX);
      const minAdvance = isRebalanced
        ? Math.max(1, remaining - idealPagePx, Math.round(remaining * 0.35))
        : Math.max(1, Math.round(idealPagePx * 0.55));
      const minAllowedY = Math.min(targetY, currentY + minAdvance);
      const bandTop = Math.max(minAllowedY, targetY - searchUp);
      const fetchTop = Math.max(currentY, bandTop - 2);
      const bandBottom = Math.min(h, targetY + 3);
      const bandH = bandBottom - fetchTop;

      if (bandH >= 4 && targetY > bandTop) {
        const band = getBandRgba(fetchTop, bandH);
        if (band && band.rgba && band.width > 0 && band.height > 0) {
          const offset = findSmartPageBreak(
            band.rgba,
            band.width,
            band.height,
            targetY - fetchTop,
            { minOffsetY: bandTop - fetchTop }
          );
          chosenY = Math.max(currentY + 1, Math.min(h, fetchTop + offset));
        }
      }
    }

    const sliceH = chosenY - currentY;
    slices.push(makeA4Slice(currentY, sliceH));
    currentY = chosenY;
  }

  return slices;
}

function fmtPdfNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * 100) / 100;
  if (Object.is(rounded, -0) || rounded === 0) return '0';
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * Assemble a standards-compliant PDF 1.4 document as an array of Uint8Array chunks
 * (ready to pass directly to new Blob(parts, { type: 'application/pdf' }) without copying).
 * Each page entry: { imgBytes, imgWidth, imgHeight, encoding: 'flate-rgb' | 'jpeg',
 *   pageW, pageH, drawX, drawY, drawW, drawH }.
 */
export function buildPdfParts(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('Cannot build PDF with zero pages.');
  }

  const parts = [];
  let byteOffset = 0;

  const pushBytes = (u8) => {
    parts.push(u8);
    byteOffset += u8.byteLength;
  };
  const pushAscii = (str) => {
    pushBytes(TEXT_ENCODER.encode(str));
  };

  // PDF 1.4 header + binary marker comment (4 bytes >= 0x80)
  pushAscii('%PDF-1.4\n');
  pushBytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  // Object numbering:
  // 1: Catalog
  // 2: Pages
  // 3: Info (static ASCII only - never leaks page URL, title, or timestamps)
  // Per page i (0-based):
  //   imgObj = 4 + i * 3
  //   contentObj = 5 + i * 3
  //   pageObj = 6 + i * 3
  const totalObjects = 3 + pages.length * 3;
  const offsets = new Array(totalObjects + 1).fill(0);
  const pageObjIds = [];

  for (let i = 0; i < pages.length; i += 1) {
    pageObjIds.push(6 + i * 3);
  }

  const beginObj = (id) => {
    offsets[id] = byteOffset;
    pushAscii(`${id} 0 obj\n`);
  };
  const endObj = () => {
    pushAscii('endobj\n');
  };

  // 1: Catalog
  beginObj(1);
  pushAscii('<< /Type /Catalog /Pages 2 0 R >>\n');
  endObj();

  // 2: Pages
  beginObj(2);
  const kidsList = pageObjIds.map((id) => `${id} 0 R`).join(' ');
  pushAscii(`<< /Type /Pages /Kids [${kidsList}] /Count ${pages.length} >>\n`);
  endObj();

  // 3: Info (privacy-safe static ASCII metadata)
  beginObj(3);
  pushAscii('<< /Producer (SaveShot) /Creator (SaveShot) >>\n');
  endObj();

  // Page triples
  for (let i = 0; i < pages.length; i += 1) {
    const p = pages[i];
    if (!(p.imgBytes instanceof Uint8Array) || p.imgBytes.byteLength === 0) {
      throw new Error(`Invalid image stream for PDF page ${i + 1}.`);
    }
    const imgW = Math.max(1, Math.floor(Number(p.imgWidth) || 1));
    const imgH = Math.max(1, Math.floor(Number(p.imgHeight) || 1));
    const pageW = clampPagePt(Number(p.pageW) || PDF_LIMITS.A4_WIDTH_PT);
    const pageH = clampPagePt(Number(p.pageH) || PDF_LIMITS.A4_HEIGHT_PT);
    const drawW = Math.max(1, Number(p.drawW) || pageW);
    const drawH = Math.max(1, Number(p.drawH) || pageH);
    const drawX = Number.isFinite(p.drawX) ? p.drawX : 0;
    const drawY = Number.isFinite(p.drawY) ? p.drawY : 0;

    const imgId = 4 + i * 3;
    const contentId = 5 + i * 3;
    const pageId = 6 + i * 3;

    // Image XObject
    beginObj(imgId);
    if (p.encoding === 'flate-rgb') {
      pushAscii(
        `<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode ` +
          `/DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${imgW} >> ` +
          `/Length ${p.imgBytes.byteLength} >>\nstream\n`
      );
    } else if (p.encoding === 'jpeg') {
      pushAscii(
        `<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
          `/Length ${p.imgBytes.byteLength} >>\nstream\n`
      );
    } else {
      throw new Error(`Unsupported PDF image encoding: ${p.encoding}`);
    }
    pushBytes(p.imgBytes);
    pushAscii('\nendstream\n');
    endObj();

    // Content stream
    const contentStr =
      `q\n${fmtPdfNum(drawW)} 0 0 ${fmtPdfNum(drawH)} ` +
      `${fmtPdfNum(drawX)} ${fmtPdfNum(drawY)} cm\n/Im0 Do\nQ\n`;
    const contentBytes = TEXT_ENCODER.encode(contentStr);
    beginObj(contentId);
    pushAscii(`<< /Length ${contentBytes.byteLength} >>\nstream\n`);
    pushBytes(contentBytes);
    pushAscii('\nendstream\n');
    endObj();

    // Page object
    beginObj(pageId);
    pushAscii(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmtPdfNum(pageW)} ${fmtPdfNum(pageH)}] ` +
        `/Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>\n`
    );
    endObj();
  }

  // Byte-exact 20-byte xref table entries (PDF 1.4 section 3.4.3)
  const xrefOffset = byteOffset;
  let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= totalObjects; id += 1) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pushAscii(xref);

  pushAscii(
    `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R /Info 3 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`
  );

  return parts;
}

function createWorkingCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(width, height);
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

async function encodeCanvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob(quality !== undefined ? { type, quality } : { type });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(`Failed to encode ${type}`))),
      type,
      quality
    );
  });
}

function yieldFrame() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Export an HTMLCanvasElement / OffscreenCanvas to a PDF Blob with zero third-party libraries.
 * Preserves #base-canvas GPU acceleration by reading only small break-search bands via a
 * disposable scratch canvas in Phase 1, then encoding slices sequentially in Phase 2.
 */
export async function exportCanvasToPdfBlob(canvas, { onProgress = null, signal = null } = {}) {
  const srcW = Math.floor(Number(canvas?.width) || 0);
  const srcH = Math.floor(Number(canvas?.height) || 0);
  if (
    srcW < 1 ||
    srcH < 1 ||
    srcW > PDF_LIMITS.MAX_CANVAS_DIM ||
    srcH > PDF_LIMITS.MAX_CANVAS_DIM ||
    srcW * srcH > PDF_LIMITS.MAX_SOURCE_PIXELS
  ) {
    throw new Error('Canvas dimensions are invalid or exceed the maximum supported PDF export size.');
  }

  const checkAborted = () => {
    if (signal?.aborted) {
      throw new DOMException('PDF export cancelled.', 'AbortError');
    }
  };

  // Phase 1: Plan smart page breaks using one tiny reusable opaque white-filled scan canvas (<= 3.2 MB)
  let slices;
  let scanCanvas = null;
  let scanCtx = null;
  try {
    const scanW = Math.min(srcW, PDF_LIMITS.MAX_SCAN_WIDTH);
    slices = planPdfPageSlices(srcW, srcH, {
      getBandRgba: (bandTop, bandH) => {
        if (!scanCanvas) {
          scanCanvas = createWorkingCanvas(scanW, bandH);
          scanCtx = scanCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
        } else if (scanCanvas.width !== scanW || scanCanvas.height !== bandH) {
          scanCanvas.width = scanW;
          scanCanvas.height = bandH;
        }
        if (!scanCtx) return null;
        scanCtx.fillStyle = '#ffffff';
        scanCtx.fillRect(0, 0, scanW, bandH);
        scanCtx.drawImage(canvas, 0, bandTop, srcW, bandH, 0, 0, scanW, bandH);
        const imgData = scanCtx.getImageData(0, 0, scanW, bandH);
        return { rgba: imgData.data, width: scanW, height: bandH };
      },
    });
  } finally {
    if (scanCanvas) {
      scanCanvas.width = 0;
      scanCanvas.height = 0;
      scanCanvas = null;
      scanCtx = null;
    }
  }

  checkAborted();

  // Phase 2: Sequentially encode slices using one reusable opaque white-filled canvas
  const encodedPages = [];
  let sliceCanvas = null;
  let sliceCtx = null;

  try {
    for (let i = 0; i < slices.length; i += 1) {
      checkAborted();
      const slice = slices[i];
      if (slice.height < 1 || slice.height > PDF_LIMITS.MAX_CANVAS_DIM) {
        throw new Error('PDF page slice exceeds maximum supported canvas height.');
      }
      if (typeof onProgress === 'function') {
        onProgress(i + 1, slices.length);
      }

      if (!sliceCanvas) {
        sliceCanvas = createWorkingCanvas(srcW, slice.height);
        sliceCtx = sliceCanvas.getContext('2d', { alpha: false });
      } else if (sliceCanvas.width !== srcW || sliceCanvas.height !== slice.height) {
        sliceCanvas.width = srcW;
        sliceCanvas.height = slice.height;
      }
      if (!sliceCtx) {
        throw new Error('Could not allocate canvas context for PDF export.');
      }

      // Opaque canvas initializes to black; explicitly fill white before drawing source pixels
      sliceCtx.fillStyle = '#ffffff';
      sliceCtx.fillRect(0, 0, srcW, slice.height);
      sliceCtx.drawImage(canvas, 0, slice.y, srcW, slice.height, 0, 0, srcW, slice.height);

      let imgBytes = null;
      let encoding = 'jpeg';
      const maxPngBytes = Math.min(
        PDF_LIMITS.PNG_MAX_SLICE_BYTES,
        Math.max(
          PDF_LIMITS.PNG_MIN_FLOOR_BYTES,
          Math.round(srcW * slice.height * PDF_LIMITS.PNG_MAX_BYTES_PER_PX)
        )
      );

      try {
        const pngBlob = await encodeCanvasToBlob(sliceCanvas, 'image/png');
        checkAborted();
        if (pngBlob && pngBlob.size > 0 && pngBlob.size <= maxPngBytes) {
          const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
          const extracted = extractRgbPngIdat(pngBytes);
          if (extracted && extracted.width === srcW && extracted.height === slice.height) {
            imgBytes = extracted.idatBytes;
            encoding = 'flate-rgb';
          }
        }
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        // Fall through to JPEG encoding
      }

      if (!imgBytes) {
        const jpegBlob = await encodeCanvasToBlob(sliceCanvas, 'image/jpeg', PDF_LIMITS.JPEG_QUALITY);
        checkAborted();
        const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
        if (jpegBytes.byteLength < 4 || jpegBytes[0] !== 0xff || jpegBytes[1] !== 0xd8) {
          throw new Error('Could not encode JPEG fallback stream for PDF page.');
        }
        imgBytes = jpegBytes;
        encoding = 'jpeg';
      }

      encodedPages.push({
        imgBytes,
        imgWidth: srcW,
        imgHeight: slice.height,
        encoding,
        pageW: slice.pageW,
        pageH: slice.pageH,
        drawX: slice.drawX,
        drawY: slice.drawY,
        drawW: slice.drawW,
        drawH: slice.drawH,
      });

      if (slices.length > 1 && i + 1 < slices.length) {
        await yieldFrame();
      }
    }
  } finally {
    if (sliceCanvas) {
      sliceCanvas.width = 0;
      sliceCanvas.height = 0;
      sliceCanvas = null;
      sliceCtx = null;
    }
  }

  checkAborted();
  const pdfParts = buildPdfParts(encodedPages);
  return {
    blob: new Blob(pdfParts, { type: 'application/pdf' }),
    pageCount: encodedPages.length,
  };
}
