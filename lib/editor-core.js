export const EDITOR_TOOLS = Object.freeze([
  'arrow',
  'box',
  'circle',
  'line',
  'highlighter',
  'pencil',
  'text',
  'redact',
]);

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

export const FONT_SIZES = Object.freeze({
  sm: 16,
  md: 22,
  lg: 30,
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
 * When snapOutward is true (used for pixel redaction), coordinates snap outward to full integer pixels
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
      const lines = rawText.split('\n').slice(0, 25);
      const fontSize = Math.max(10, Math.min(120, safeNum(op.fontSize, FONT_SIZES.md)));
      const lineHeight = Math.round(fontSize * 1.28);
      const pos = clampPoint(op.x, op.y, w, h);

      ctx.font = `600 ${fontSize}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.lineJoin = 'round';

      // Subtle contrasting outline so text stays legible over busy or similar-colored backgrounds
      ctx.strokeStyle = color === '#ffffff' ? 'rgba(20, 21, 24, 0.78)' : 'rgba(255, 255, 255, 0.78)';
      ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.14));
      ctx.fillStyle = color;

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
