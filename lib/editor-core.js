export const EDITOR_TOOLS = Object.freeze([
  'arrow',
  'box',
  'circle',
  'line',
  'highlighter',
  'pencil',
  'text',
  'redact',
  'crop',
]);

export const REDACT_MODES = Object.freeze(['solid', 'pixelate']);
export const TEXT_STYLES = Object.freeze(['clean', 'meme']);
export const CAPTION_THEMES = Object.freeze(['light', 'dark']);

export const EDITOR_COLORS = Object.freeze([
  '#ef4444',
  '#f59e0b',
  '#22c55e',
  '#1a73e8',
  '#ffffff',
]);

export const STROKE_SIZES = Object.freeze({
  sm: 2.5,
  md: 4.5,
  lg: 8,
});

export const HIGHLIGHTER_SIZES = Object.freeze({
  sm: 14,
  md: 22,
  lg: 32,
});

export const HIGHLIGHTER_ALPHA = 0.36;

export const PIXELATE_BLOCK_SIZES = Object.freeze({
  sm: 10,
  md: 16,
  lg: 24,
});

export const FONT_SIZES = Object.freeze({
  sm: 16,
  md: 22,
  lg: 30,
  xl: 44,
});

export const TRANSFORM_KINDS = Object.freeze([
  'rotate-cw',
  'rotate-ccw',
  'flip-h',
  'flip-v',
]);

function safeNum(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

export function clampPoint(x, y, maxW, maxH) {
  const w = Math.max(1, safeNum(maxW, 1));
  const h = Math.max(1, safeNum(maxH, 1));
  return {
    x: Math.max(0, Math.min(w, safeNum(x, 0))),
    y: Math.max(0, Math.min(h, safeNum(y, 0))),
  };
}

/**
 * Normalize two drag points into a non-negative { x, y, width, height } rect clamped to canvas bounds.
 * When snapOutward is true (used for pixel redaction and crop), coordinates snap outward to full integer pixels
 * so anti-aliasing never leaves faint semi-transparent edges over sensitive pixels.
 */
export function normalizeRect(x1, y1, x2, y2, maxW, maxH, { snapOutward = false } = {}) {
  const w = Math.max(1, safeNum(maxW, 1));
  const h = Math.max(1, safeNum(maxH, 1));
  const p1 = clampPoint(x1, y1, w, h);
  const p2 = clampPoint(x2, y2, w, h);

  let minX = Math.min(p1.x, p2.x);
  let minY = Math.min(p1.y, p2.y);
  let maxX = Math.max(p1.x, p2.x);
  let maxY = Math.max(p1.y, p2.y);

  if (snapOutward) {
    minX = Math.max(0, Math.floor(minX));
    minY = Math.max(0, Math.floor(minY));
    maxX = Math.min(w, Math.ceil(maxX));
    maxY = Math.min(h, Math.ceil(maxY));
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

export function computeArrowGeometry(x1, y1, x2, y2, strokeWidth = 4) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) {
    return null;
  }

  const sw = Math.max(1.5, safeNum(strokeWidth, 4));
  const headLength = Math.min(Math.max(sw * 3.4, 11), Math.max(length * 0.65, 6));
  const headHalfAngle = Math.PI / 6.5;
  const angle = Math.atan2(dy, dx);

  const wingLeft = {
    x: x2 - headLength * Math.cos(angle - headHalfAngle),
    y: y2 - headLength * Math.sin(angle - headHalfAngle),
  };
  const wingRight = {
    x: x2 - headLength * Math.cos(angle + headHalfAngle),
    y: y2 - headLength * Math.sin(angle + headHalfAngle),
  };

  const shaftPullback = Math.min(length, headLength * 0.68);
  const shaftEnd = {
    x: x2 - (dx / length) * shaftPullback,
    y: y2 - (dy / length) * shaftPullback,
  };

  return {
    tip: { x: x2, y: y2 },
    wingLeft,
    wingRight,
    shaftEnd,
  };
}

export function parseHexColorInput(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
    return `#${trimmed.toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{3}$/.test(trimmed)) {
    const expanded = trimmed
      .toLowerCase()
      .split('')
      .map((ch) => ch + ch)
      .join('');
    return `#${expanded}`;
  }
  return null;
}

export function sanitizeHexColor(color, fallback = '#ef4444') {
  if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
    return color.toLowerCase();
  }
  return fallback;
}

/**
 * Irreversibly pixelate an integer pixel rectangle using block mean averaging.
 * Reads pixels from sourceCtx (defaults to ctx) and writes solid averaged blocks onto ctx.
 */
export function applyPixelateRect(ctx, rect, { blockSize = 16, sourceCtx = null } = {}) {
  const reader = sourceCtx || ctx;
  if (!ctx || !reader || typeof reader.getImageData !== 'function' || typeof ctx.putImageData !== 'function') {
    return false;
  }
  const rw = Math.floor(safeNum(rect?.width, 0));
  const rh = Math.floor(safeNum(rect?.height, 0));
  const rx = Math.floor(safeNum(rect?.x, 0));
  const ry = Math.floor(safeNum(rect?.y, 0));
  if (rw < 1 || rh < 1) return false;

  const bs = Math.max(6, Math.min(48, Math.round(safeNum(blockSize, 16))));
  const imgData = reader.getImageData(rx, ry, rw, rh);
  const data = imgData.data;

  // Distribute columns and rows evenly so trailing edges never shrink to a 1px unredacted sliver
  const cols = Math.max(1, Math.round(rw / bs));
  const rows = Math.max(1, Math.round(rh / bs));

  for (let row = 0; row < rows; row += 1) {
    const by = Math.floor((row * rh) / rows);
    const nextY = Math.floor(((row + 1) * rh) / rows);
    const bh = Math.max(1, nextY - by);
    for (let col = 0; col < cols; col += 1) {
      const bx = Math.floor((col * rw) / cols);
      const nextX = Math.floor(((col + 1) * rw) / cols);
      const bw = Math.max(1, nextX - bx);
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;
      const count = bw * bh;

      for (let py = 0; py < bh; py += 1) {
        let idx = ((by + py) * rw + bx) * 4;
        for (let px = 0; px < bw; px += 1) {
          rSum += data[idx];
          gSum += data[idx + 1];
          bSum += data[idx + 2];
          aSum += data[idx + 3];
          idx += 4;
        }
      }

      const rAvg = Math.round(rSum / count);
      const gAvg = Math.round(gSum / count);
      const bAvg = Math.round(bSum / count);
      const aAvg = aSum > 0 ? 255 : 0;

      for (let py = 0; py < bh; py += 1) {
        let idx = ((by + py) * rw + bx) * 4;
        for (let px = 0; px < bw; px += 1) {
          data[idx] = rAvg;
          data[idx + 1] = gAvg;
          data[idx + 2] = bAvg;
          data[idx + 3] = aAvg;
          idx += 4;
        }
      }
    }
  }

  ctx.putImageData(imgData, rx, ry);
  return true;
}

/**
 * Render a single annotation operation onto a 2D canvas context.
 */
export function renderAnnotation(ctx, op, canvasWidth, canvasHeight) {
  if (!ctx || !op || typeof op !== 'object') return false;
  const w = Math.max(1, safeNum(canvasWidth ?? ctx.canvas?.width, 1));
  const h = Math.max(1, safeNum(canvasHeight ?? ctx.canvas?.height, 1));
  const tool = op.tool;
  const color = sanitizeHexColor(op.color);
  const strokeWidth = Math.max(1, Math.min(48, safeNum(op.strokeWidth, STROKE_SIZES.md)));

  ctx.save();
  try {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    if (tool === 'redact') {
      const rect = normalizeRect(op.x1, op.y1, op.x2, op.y2, w, h, { snapOutward: true });
      if (rect.width < 1 || rect.height < 1) return false;
      if (op.redactMode === 'pixelate') {
        const applied = applyPixelateRect(ctx, rect, {
          blockSize: op.blockSize ?? PIXELATE_BLOCK_SIZES.md,
          sourceCtx: op.sourceCtx || null,
        });
        if (applied) return true;
      }
      ctx.fillStyle = '#000000';
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      return true;
    }

    if (tool === 'box') {
      const rect = normalizeRect(op.x1, op.y1, op.x2, op.y2, w, h);
      if (rect.width < 2 && rect.height < 2) return false;
      ctx.strokeStyle = color;
      ctx.lineWidth = strokeWidth;
      ctx.lineJoin = 'round';
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      return true;
    }

    if (tool === 'circle') {
      const rect = normalizeRect(op.x1, op.y1, op.x2, op.y2, w, h);
      if (rect.width < 2 && rect.height < 2) return false;
      ctx.strokeStyle = color;
      ctx.lineWidth = strokeWidth;
      ctx.beginPath();
      ctx.ellipse(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        Math.max(1, rect.width / 2),
        Math.max(1, rect.height / 2),
        0,
        0,
        Math.PI * 2
      );
      ctx.stroke();
      return true;
    }

    if (tool === 'line') {
      const p1 = clampPoint(op.x1, op.y1, w, h);
      const p2 = clampPoint(op.x2, op.y2, w, h);
      if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 2) return false;
      ctx.strokeStyle = color;
      ctx.lineWidth = strokeWidth;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      return true;
    }

    if (tool === 'arrow') {
      const p1 = clampPoint(op.x1, op.y1, w, h);
      const p2 = clampPoint(op.x2, op.y2, w, h);
      if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 3) return false;
      const geom = computeArrowGeometry(p1.x, p1.y, p2.x, p2.y, strokeWidth);
      if (!geom) return false;

      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = strokeWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(geom.shaftEnd.x, geom.shaftEnd.y);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(geom.tip.x, geom.tip.y);
      ctx.lineTo(geom.wingLeft.x, geom.wingLeft.y);
      ctx.lineTo(geom.wingRight.x, geom.wingRight.y);
      ctx.closePath();
      ctx.fill();
      return true;
    }

    if (tool === 'highlighter') {
      const rawPoints = Array.isArray(op.points) ? op.points : [];
      if (rawPoints.length < 2) return false;
      const pts = rawPoints.map((p) => clampPoint(p?.x, p?.y, w, h));
      let totalSpan = 0;
      for (let i = 1; i < pts.length; i += 1) {
        totalSpan += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      }
      if (totalSpan < 2) return false;

      const hlWidth = Math.max(
        4,
        Math.min(128, safeNum(op.strokeWidth, HIGHLIGHTER_SIZES.md))
      );

      ctx.globalAlpha = HIGHLIGHTER_ALPHA;
      ctx.strokeStyle = color;
      ctx.lineWidth = hlWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      if (pts.length === 2) {
        ctx.lineTo(pts[1].x, pts[1].y);
      } else {
        for (let i = 1; i < pts.length - 1; i += 1) {
          const midX = (pts[i].x + pts[i + 1].x) / 2;
          const midY = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last.x, last.y);
      }
      ctx.stroke();
      return true;
    }

    if (tool === 'pencil') {
      const rawPoints = Array.isArray(op.points) ? op.points : [];
      if (rawPoints.length === 0) return false;
      const pts = rawPoints.map((p) => clampPoint(p?.x, p?.y, w, h));

      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = strokeWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, strokeWidth / 2, 0, Math.PI * 2);
        ctx.fill();
        return true;
      }

      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      if (pts.length === 2) {
        ctx.lineTo(pts[1].x, pts[1].y);
      } else {
        for (let i = 1; i < pts.length - 1; i += 1) {
          const midX = (pts[i].x + pts[i + 1].x) / 2;
          const midY = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last.x, last.y);
      }
      ctx.stroke();
      return true;
    }

    if (tool === 'text') {
      const rawText = String(op.text ?? '').replace(/\r\n/g, '\n');
      if (!rawText.trim()) return false;
      const isMeme = op.textStyle === 'meme';
      const lines = (isMeme ? rawText.toUpperCase() : rawText).split('\n').slice(0, 25);
      const fontSize = Math.max(10, Math.min(180, safeNum(op.fontSize, FONT_SIZES.md)));
      const lineHeight = Math.round(fontSize * (isMeme ? 1.16 : 1.28));
      const pos = clampPoint(op.x, op.y, w, h);

      ctx.font = isMeme
        ? `900 ${fontSize}px Impact, "Arial Black", "Helvetica Neue", system-ui, sans-serif`
        : `600 ${fontSize}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.lineJoin = 'round';

      if (isMeme) {
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = Math.max(4, Math.round(fontSize * 0.2));
        ctx.fillStyle = color;
      } else {
        // Subtle contrasting outline so text stays legible over busy or similar-colored backgrounds
        ctx.strokeStyle = color === '#ffffff' ? 'rgba(20, 21, 24, 0.78)' : 'rgba(255, 255, 255, 0.78)';
        ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.14));
        ctx.fillStyle = color;
      }

      for (let i = 0; i < lines.length; i += 1) {
        const lineY = pos.y + i * lineHeight;
        if (lineY > h) break;
        const textLine = lines[i].slice(0, 300);
        ctx.strokeText(textLine, pos.x, lineY);
        ctx.fillText(textLine, pos.x, lineY);
      }
      return true;
    }

    return false;
  } finally {
    ctx.restore();
  }
}

/**
 * Losslessly rotate (90deg CW / CCW) or flip (horizontal / vertical) an ImageBitmap or Canvas
 * into targetCanvas, automatically updating targetCanvas width and height.
 */
export function transformSourceToCanvas(source, kind, targetCanvas) {
  if (!source || !targetCanvas || !TRANSFORM_KINDS.includes(kind)) {
    throw new Error(`Unsupported transform: ${kind}`);
  }
  const srcW = Math.max(1, Math.round(safeNum(source.width, 1)));
  const srcH = Math.max(1, Math.round(safeNum(source.height, 1)));
  const swapsAxes = kind === 'rotate-cw' || kind === 'rotate-ccw';
  const destW = swapsAxes ? srcH : srcW;
  const destH = swapsAxes ? srcW : srcH;

  targetCanvas.width = destW;
  targetCanvas.height = destH;

  const ctx = targetCanvas.getContext('2d');
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, destW, destH);

  if (kind === 'rotate-cw') {
    ctx.translate(destW, 0);
    ctx.rotate(Math.PI / 2);
  } else if (kind === 'rotate-ccw') {
    ctx.translate(0, destH);
    ctx.rotate(-Math.PI / 2);
  } else if (kind === 'flip-h') {
    ctx.translate(destW, 0);
    ctx.scale(-1, 1);
  } else if (kind === 'flip-v') {
    ctx.translate(0, destH);
    ctx.scale(1, -1);
  }

  ctx.drawImage(source, 0, 0);
  ctx.restore();

  return { width: destW, height: destH };
}

/**
 * Losslessly crop source into targetCanvas using an outward-snapped integer rectangle.
 */
export function cropSourceToCanvas(source, rect, targetCanvas) {
  if (!source || !targetCanvas || !rect || typeof rect !== 'object') {
    throw new Error('Invalid crop parameters');
  }
  const srcW = Math.max(1, Math.round(safeNum(source.width, 1)));
  const srcH = Math.max(1, Math.round(safeNum(source.height, 1)));
  const norm = normalizeRect(
    rect.x,
    rect.y,
    safeNum(rect.x, 0) + safeNum(rect.width, 0),
    safeNum(rect.y, 0) + safeNum(rect.height, 0),
    srcW,
    srcH,
    { snapOutward: true }
  );
  if (norm.width < 4 || norm.height < 4) {
    throw new Error('Crop selection is too small.');
  }

  targetCanvas.width = norm.width;
  targetCanvas.height = norm.height;
  const ctx = targetCanvas.getContext('2d');
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, norm.width, norm.height);
  ctx.drawImage(source, norm.x, norm.y, norm.width, norm.height, 0, 0, norm.width, norm.height);
  ctx.restore();

  return { width: norm.width, height: norm.height, rect: norm };
}

function wrapCaptionLines(ctx, text, maxWidth, maxLines = 6) {
  const paragraphs = text.split('\n');
  const lines = [];
  const measure = (s) =>
    typeof ctx.measureText === 'function' ? ctx.measureText(s).width : s.length * 12;

  const pushLongToken = (token) => {
    let chunk = '';
    for (const ch of token) {
      if (chunk && measure(chunk + ch) > maxWidth) {
        lines.push(chunk);
        if (lines.length >= maxLines) return '';
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    return chunk;
  };

  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      if (lines.length < maxLines) lines.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        current = candidate;
      } else if (current) {
        lines.push(current);
        if (lines.length >= maxLines) return lines;
        current = measure(word) > maxWidth ? pushLongToken(word) : word;
        if (lines.length >= maxLines) return lines;
      } else {
        current = pushLongToken(word);
        if (lines.length >= maxLines) return lines;
      }
    }
    if (current) {
      lines.push(current);
      if (lines.length >= maxLines) return lines;
    }
  }
  return lines.slice(0, maxLines);
}

const MAX_CAPTION_CANVAS_HEIGHT = 16200;

/**
 * Expand canvas upward with a clean light or dark meme/caption strip above source.
 */
export function addCaptionBarToCanvas(
  source,
  { text = '', theme = 'light', fontSize = null } = {},
  targetCanvas
) {
  if (!source || !targetCanvas) {
    throw new Error('Invalid caption bar parameters');
  }
  const cleanText = String(text ?? '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, 240);
  if (!cleanText) {
    throw new Error('Caption text cannot be empty.');
  }

  const srcW = Math.max(1, Math.round(safeNum(source.width, 1)));
  const srcH = Math.max(1, Math.round(safeNum(source.height, 1)));
  const isDark = theme === 'dark';
  const computedFont = fontSize
    ? Math.max(14, Math.min(96, Math.round(safeNum(fontSize, 28))))
    : Math.max(18, Math.min(54, Math.round(srcW * 0.042)));
  const padX = Math.max(16, Math.round(srcW * 0.04));
  const padY = Math.max(14, Math.round(computedFont * 0.6));
  const lineHeight = Math.round(computedFont * 1.28);

  const ctx = targetCanvas.getContext('2d');
  const fontSpec = `700 ${computedFont}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.font = fontSpec;
  const maxTextWidth = Math.max(80, srcW - padX * 2);
  const lines = wrapCaptionLines(ctx, cleanText, maxTextWidth, 6);
  const barHeight = Math.max(computedFont + padY * 2, lines.length * lineHeight + padY * 2);
  const destH = srcH + barHeight;
  if (destH > MAX_CAPTION_CANVAS_HEIGHT) {
    throw new Error('Image is too tall to add another caption bar. Crop the image first.');
  }

  targetCanvas.width = srcW;
  targetCanvas.height = destH;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = isDark ? '#141518' : '#ffffff';
  ctx.fillRect(0, 0, srcW, barHeight);
  ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(15, 18, 24, 0.10)';
  ctx.fillRect(0, barHeight - 1, srcW, 1);

  ctx.font = fontSpec;
  ctx.fillStyle = isDark ? '#f3f4f6' : '#141518';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const textBlockH = lines.length * lineHeight;
  const startY = Math.round((barHeight - textBlockH) / 2);
  for (let i = 0; i < lines.length; i += 1) {
    ctx.fillText(lines[i], Math.round(srcW / 2), startY + i * lineHeight, maxTextWidth);
  }

  ctx.drawImage(source, 0, barHeight);
  ctx.restore();

  return { width: srcW, height: destH, barHeight, lines };
}

/**
 * Compute an initial centered bounding box for a pasted reaction/sticker image,
 * capped to <= 50% of the canvas dimensions while preserving aspect ratio.
 */
export function computePastedImageBox(imgW, imgH, canvasW, canvasH) {
  const iw = Math.max(1, safeNum(imgW, 1));
  const ih = Math.max(1, safeNum(imgH, 1));
  const cw = Math.max(1, safeNum(canvasW, 1));
  const ch = Math.max(1, safeNum(canvasH, 1));

  const maxW = Math.max(24, cw * 0.5);
  const maxH = Math.max(24, ch * 0.5);
  const scale = Math.min(1, maxW / iw, maxH / ih);
  const width = Math.max(16, Math.round(iw * scale));
  const height = Math.max(16, Math.round(ih * scale));
  const x = Math.max(0, Math.round((cw - width) / 2));
  const y = Math.max(0, Math.round((ch - height) / 2));

  return { x, y, width, height };
}
