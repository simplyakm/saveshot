import {
  blobToDataUrl,
  dataUrlToBlob,
  sanitizeScreenshotFilename,
} from '../lib/capture.js';
import {
  FONT_SIZES,
  parseHexColorInput,
  renderAnnotation,
  sanitizeHexColor,
  STROKE_SIZES,
  transformSourceToCanvas,
} from '../lib/editor-core.js';
import { initThemeSync, safeHttpsUrl, sendRuntimeMessage } from '../lib/ui.js';

const MAX_UNDO_STEPS = 20;

const els = {
  filenameReadonly: document.getElementById('filename-readonly'),
  filenameDisplay: document.getElementById('filename-display'),
  renamePencilBtn: document.getElementById('rename-pencil-btn'),
  filenameEditing: document.getElementById('filename-editing'),
  filenameInput: document.getElementById('filename-input'),
  dimLabel: document.getElementById('dim-label'),
  statusPill: document.getElementById('status-pill'),
  unsavedPill: document.getElementById('unsaved-pill'),
  downloadBtn: document.getElementById('download-btn'),
  copyLinkBtn: document.getElementById('copy-link-btn'),
  openDriveLink: document.getElementById('open-drive-link'),
  saveDriveBtn: document.getElementById('save-drive-btn'),
  styleGroup: document.getElementById('style-group'),
  colorSwatches: document.getElementById('color-swatches'),
  customColorBtn: document.getElementById('custom-color-btn'),
  hexPopover: document.getElementById('hex-popover'),
  hexColorNative: document.getElementById('hex-color-native'),
  hexInputWrap: document.getElementById('hex-input-wrap'),
  hexTextInput: document.getElementById('hex-text-input'),
  applyHexBtn: document.getElementById('apply-hex-btn'),
  sizePills: document.getElementById('size-pills'),
  undoBtn: document.getElementById('undo-btn'),
  resetBtn: document.getElementById('reset-btn'),
  stageMessage: document.getElementById('stage-message'),
  stageSpinner: document.getElementById('stage-spinner'),
  stageMessageText: document.getElementById('stage-message-text'),
  canvasWrap: document.getElementById('canvas-wrap'),
  baseCanvas: document.getElementById('base-canvas'),
  previewCanvas: document.getElementById('preview-canvas'),
  textOverlayInput: document.getElementById('text-overlay-input'),
  confirmReplaceDialog: document.getElementById('confirm-replace-dialog'),
  cancelReplaceBtn: document.getElementById('cancel-replace-btn'),
  saveNewCopyBtn: document.getElementById('save-new-copy-btn'),
  confirmReplaceBtn: document.getElementById('confirm-replace-btn'),
};

const baseCtx = els.baseCanvas.getContext('2d');
const previewCtx = els.previewCanvas.getContext('2d');

const state = {
  sessionId: '',
  mode: 'new', // 'new' | 'existing'
  fileId: null,
  savedFilename: 'Screenshot.png',
  committedStem: 'Screenshot',
  folderName: 'Chrome_SaveShot_ScreenShots',
  webViewLink: '',
  captureMode: 'visible',
  pageUrl: '',
  pageTitle: '',
  incognito: false,
  autoCopyLink: true,
  tool: 'arrow',
  color: '#ef4444',
  sizeKey: 'md',
  ready: false,
  saving: false,
  isAtOriginalCapture: true,
  driveMatchesInitial: false,
  imageModifiedSinceSave: false,
  initialBitmap: null,
  undoStack: [],
  activeDrag: null,
  activeTextAnchor: null,
};

function stripPngSuffix(filename) {
  return String(filename || 'Screenshot.png').replace(/\.png$/i, '');
}

function getDesiredFilename() {
  const rawCandidate = !els.filenameEditing.hidden
    ? els.filenameInput.value
    : els.filenameInput.value || state.committedStem;
  return sanitizeScreenshotFilename(rawCandidate, state.savedFilename);
}

function syncFilenameDisplay(cleanFilename) {
  const stem = stripPngSuffix(cleanFilename);
  state.committedStem = stem;
  els.filenameInput.value = stem;
  els.filenameDisplay.textContent = stem;
  els.filenameDisplay.title = `${stem}.png`;
}

function hasUnsavedChanges() {
  if (!state.ready) return false;
  const hasPendingText =
    !els.textOverlayInput.hidden && Boolean(els.textOverlayInput.value.trim());
  return (
    state.imageModifiedSinceSave ||
    hasPendingText ||
    getDesiredFilename() !== state.savedFilename
  );
}

let statusPillTimer = null;

function showStatusPill(kind, text, autoHideMs = 0) {
  if (statusPillTimer) {
    clearTimeout(statusPillTimer);
    statusPillTimer = null;
  }
  if (!text) {
    els.statusPill.hidden = true;
    return;
  }
  els.statusPill.hidden = false;
  els.statusPill.className = `status-pill ${kind}`;
  els.statusPill.textContent = text;
  if (autoHideMs > 0) {
    statusPillTimer = setTimeout(() => {
      if (els.statusPill.textContent === text) {
        els.statusPill.hidden = true;
      }
      statusPillTimer = null;
    }, autoHideMs);
  }
}

function updateDimensionsLabel() {
  if (!state.ready) {
    els.dimLabel.textContent = '';
    els.dimLabel.hidden = true;
    return;
  }
  els.dimLabel.hidden = false;
  els.dimLabel.textContent = `${els.baseCanvas.width} \u00d7 ${els.baseCanvas.height}`;
}

function updateUiState() {
  const dirty = hasUnsavedChanges();
  const canSave = state.ready && !state.saving && (state.mode === 'new' || dirty);

  els.unsavedPill.hidden = !state.ready || state.saving || !dirty;
  if (dirty && !state.saving && els.statusPill.classList.contains('ok')) {
    els.statusPill.hidden = true;
  }

  els.saveDriveBtn.textContent = 'Save';
  els.saveDriveBtn.disabled = !canSave;
  els.saveDriveBtn.title = !state.ready
    ? 'Loading screenshot...'
    : state.mode === 'new'
    ? 'Upload screenshot to Google Drive'
    : dirty
    ? 'Save changes to Google Drive'
    : 'Make an edit or rename to enable Save';

  const safeLink = safeHttpsUrl(state.webViewLink);
  if (safeLink) {
    els.copyLinkBtn.hidden = false;
    els.openDriveLink.hidden = false;
    els.openDriveLink.href = safeLink;
  } else {
    els.copyLinkBtn.hidden = true;
    els.openDriveLink.hidden = true;
  }

  els.undoBtn.disabled = !state.ready || state.saving || state.undoStack.length === 0;
  els.resetBtn.disabled = !state.ready || state.saving || state.isAtOriginalCapture;
}

function syncPreviewCanvasSize() {
  els.previewCanvas.width = els.baseCanvas.width;
  els.previewCanvas.height = els.baseCanvas.height;
  previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
  updateDimensionsLabel();
}

function getDisplayScale() {
  const rect = els.baseCanvas.getBoundingClientRect();
  if (!rect.width) return 1;
  return Math.max(1, Math.min(3.5, els.baseCanvas.width / rect.width));
}

function getEffectiveStrokeWidth() {
  const base = STROKE_SIZES[state.sizeKey] || STROKE_SIZES.md;
  return Math.round(base * getDisplayScale() * 10) / 10;
}

function getEffectiveFontSize() {
  const base = FONT_SIZES[state.sizeKey] || FONT_SIZES.md;
  return Math.round(base * getDisplayScale());
}

function getCanvasCoordinates(event) {
  const rect = els.baseCanvas.getBoundingClientRect();
  const scaleX = els.baseCanvas.width / Math.max(1, rect.width);
  const scaleY = els.baseCanvas.height / Math.max(1, rect.height);
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
    cssX: event.clientX - rect.left,
    cssY: event.clientY - rect.top,
  };
}

async function pushUndoSnapshot() {
  const snapshot = await createImageBitmap(els.baseCanvas);
  state.undoStack.push({
    bitmap: snapshot,
    isAtOriginalCapture: state.isAtOriginalCapture,
    imageModifiedSinceSave: state.imageModifiedSinceSave,
  });
  while (state.undoStack.length > MAX_UNDO_STEPS) {
    const evicted = state.undoStack.shift();
    evicted?.bitmap?.close?.();
  }
  updateUiState();
}

function clearUndoStack() {
  while (state.undoStack.length > 0) {
    const entry = state.undoStack.pop();
    entry?.bitmap?.close?.();
  }
}

let mutationQueue = Promise.resolve();

function enqueueCanvasMutation(fn) {
  mutationQueue = mutationQueue.then(fn, fn);
  return mutationQueue;
}

function commitActiveTextIfNeeded() {
  if (els.textOverlayInput.hidden || !state.activeTextAnchor) {
    return mutationQueue;
  }
  const text = els.textOverlayInput.value;
  const anchor = state.activeTextAnchor;

  els.textOverlayInput.hidden = true;
  els.textOverlayInput.value = '';
  state.activeTextAnchor = null;

  if (!text.trim()) {
    return mutationQueue;
  }

  return enqueueCanvasMutation(async () => {
    await pushUndoSnapshot();
    const drew = renderAnnotation(
      baseCtx,
      {
        tool: 'text',
        text,
        x: anchor.x,
        y: anchor.y,
        color: anchor.color,
        fontSize: anchor.fontSize,
      },
      els.baseCanvas.width,
      els.baseCanvas.height
    );

    if (drew) {
      state.isAtOriginalCapture = false;
      state.imageModifiedSinceSave = true;
    } else {
      const popped = state.undoStack.pop();
      popped?.bitmap?.close?.();
    }
    updateUiState();
  });
}

function cancelActiveText() {
  els.textOverlayInput.hidden = true;
  els.textOverlayInput.value = '';
  state.activeTextAnchor = null;
  updateUiState();
}

function openTextOverlayAt(coords) {
  const rect = els.baseCanvas.getBoundingClientRect();
  const cssFontSize = FONT_SIZES[state.sizeKey] || FONT_SIZES.md;
  const clampedCssX = Math.max(4, Math.min(Math.max(4, rect.width - 120), coords.cssX));
  const clampedCssY = Math.max(4, Math.min(Math.max(4, rect.height - 34), coords.cssY));

  state.activeTextAnchor = {
    x: (clampedCssX / Math.max(1, rect.width)) * els.baseCanvas.width,
    y: (clampedCssY / Math.max(1, rect.height)) * els.baseCanvas.height,
    color: state.color,
    fontSize: getEffectiveFontSize(),
  };

  els.textOverlayInput.style.setProperty('--tx', `${clampedCssX}px`);
  els.textOverlayInput.style.setProperty('--ty', `${clampedCssY}px`);
  els.textOverlayInput.style.setProperty('--tcolor', state.color);
  els.textOverlayInput.style.setProperty('--tsize', `${cssFontSize}px`);
  els.textOverlayInput.value = '';
  els.textOverlayInput.hidden = false;
  requestAnimationFrame(() => els.textOverlayInput.focus());
}

function closeHexPopover() {
  els.hexPopover.hidden = true;
  els.hexInputWrap.classList.remove('invalid');
}

async function setTool(nextTool) {
  await commitActiveTextIfNeeded();
  state.tool = nextTool;

  for (const btn of document.querySelectorAll('[data-tool]')) {
    btn.classList.toggle('active', btn.dataset.tool === nextTool);
  }

  if (nextTool === 'redact') {
    closeHexPopover();
  }
  els.styleGroup.classList.toggle('dimmed', nextTool === 'redact');
  els.previewCanvas.classList.toggle('text-cursor', nextTool === 'text');
  updateUiState();
}

function setColor(nextColor, { isCustom = false } = {}) {
  const safeColor = sanitizeHexColor(nextColor, state.color);
  state.color = safeColor;

  let matchedPreset = false;
  for (const btn of els.colorSwatches.querySelectorAll('[data-color]')) {
    const isMatch = !isCustom && btn.dataset.color.toLowerCase() === safeColor;
    btn.classList.toggle('active', isMatch);
    if (isMatch) matchedPreset = true;
  }

  if (isCustom || !matchedPreset) {
    els.customColorBtn.classList.add('active');
    document.documentElement.style.setProperty('--ss-custom-swatch', safeColor);
    els.hexColorNative.value = safeColor;
    els.hexTextInput.value = safeColor.slice(1).toUpperCase();
  } else {
    els.customColorBtn.classList.remove('active');
    document.documentElement.style.removeProperty('--ss-custom-swatch');
  }

  if (!els.textOverlayInput.hidden && state.activeTextAnchor) {
    state.activeTextAnchor.color = safeColor;
    els.textOverlayInput.style.setProperty('--tcolor', safeColor);
  }
}

function setSizeKey(nextSize) {
  state.sizeKey = nextSize;
  for (const btn of els.sizePills.querySelectorAll('[data-size]')) {
    btn.classList.toggle('active', btn.dataset.size === nextSize);
  }
  if (!els.textOverlayInput.hidden && state.activeTextAnchor) {
    state.activeTextAnchor.fontSize = getEffectiveFontSize();
    els.textOverlayInput.style.setProperty(
      '--tsize',
      `${FONT_SIZES[nextSize] || FONT_SIZES.md}px`
    );
  }
}

function applyTransform(kind) {
  if (!state.ready || state.saving) return mutationQueue;
  commitActiveTextIfNeeded();
  if (state.activeDrag) {
    state.activeDrag = null;
    previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
  }

  return enqueueCanvasMutation(async () => {
    await pushUndoSnapshot();
    const sourceBitmap = state.undoStack[state.undoStack.length - 1].bitmap;
    transformSourceToCanvas(sourceBitmap, kind, els.baseCanvas);
    syncPreviewCanvasSize();
    state.isAtOriginalCapture = false;
    state.imageModifiedSinceSave = true;
    updateUiState();
  });
}

function undoLastChange() {
  if (!state.ready || state.saving) return mutationQueue;
  if (!els.textOverlayInput.hidden) {
    cancelActiveText();
    return mutationQueue;
  }
  return enqueueCanvasMutation(async () => {
    const prev = state.undoStack.pop();
    if (!prev) return;

    try {
      els.baseCanvas.width = prev.bitmap.width;
      els.baseCanvas.height = prev.bitmap.height;
      baseCtx.clearRect(0, 0, els.baseCanvas.width, els.baseCanvas.height);
      baseCtx.drawImage(prev.bitmap, 0, 0);
      syncPreviewCanvasSize();
      state.isAtOriginalCapture = prev.isAtOriginalCapture;
      state.imageModifiedSinceSave = prev.imageModifiedSinceSave;
    } finally {
      prev.bitmap.close();
    }
    updateUiState();
  });
}

function resetToOriginal() {
  if (!state.ready || state.saving || state.isAtOriginalCapture || !state.initialBitmap) {
    return mutationQueue;
  }
  commitActiveTextIfNeeded();
  return enqueueCanvasMutation(async () => {
    await pushUndoSnapshot();

    els.baseCanvas.width = state.initialBitmap.width;
    els.baseCanvas.height = state.initialBitmap.height;
    baseCtx.clearRect(0, 0, els.baseCanvas.width, els.baseCanvas.height);
    baseCtx.drawImage(state.initialBitmap, 0, 0);
    syncPreviewCanvasSize();

    state.isAtOriginalCapture = true;
    state.imageModifiedSinceSave = state.mode === 'existing' ? !state.driveMatchesInitial : false;
    updateUiState();
  });
}

function buildDragOp(drag) {
  return {
    tool: drag.tool,
    color: drag.color,
    strokeWidth: drag.strokeWidth,
    x1: drag.startX,
    y1: drag.startY,
    x2: drag.currentX,
    y2: drag.currentY,
    points: drag.points,
  };
}

function renderActiveDragPreview() {
  previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
  if (!state.activeDrag) return;
  renderAnnotation(
    previewCtx,
    buildDragOp(state.activeDrag),
    els.previewCanvas.width,
    els.previewCanvas.height
  );
}

els.previewCanvas.addEventListener('pointerdown', (event) => {
  if (!state.ready || state.saving || event.button !== 0) return;
  event.preventDefault();
  closeHexPopover();

  const coords = getCanvasCoordinates(event);
  commitActiveTextIfNeeded();

  if (state.tool === 'text') {
    openTextOverlayAt(coords);
    return;
  }

  try {
    els.previewCanvas.setPointerCapture(event.pointerId);
  } catch {
    // Synthetic pointer events in tests may not register an active pointerId
  }

  state.activeDrag = {
    pointerId: event.pointerId,
    tool: state.tool,
    color: state.color,
    strokeWidth: getEffectiveStrokeWidth(),
    startX: coords.x,
    startY: coords.y,
    currentX: coords.x,
    currentY: coords.y,
    points: state.tool === 'pencil' ? [{ x: coords.x, y: coords.y }] : null,
  };
  renderActiveDragPreview();
});

els.previewCanvas.addEventListener('pointermove', (event) => {
  if (!state.activeDrag) return;
  event.preventDefault();
  const coords = getCanvasCoordinates(event);
  state.activeDrag.currentX = coords.x;
  state.activeDrag.currentY = coords.y;
  if (state.activeDrag.points) {
    const last = state.activeDrag.points[state.activeDrag.points.length - 1];
    if (!last || Math.hypot(coords.x - last.x, coords.y - last.y) >= 1.5) {
      state.activeDrag.points.push({ x: coords.x, y: coords.y });
    }
  }
  renderActiveDragPreview();
});

function finishPointerDrag(event) {
  if (!state.activeDrag) return;
  event.preventDefault();
  const coords = getCanvasCoordinates(event);
  state.activeDrag.currentX = coords.x;
  state.activeDrag.currentY = coords.y;
  if (state.activeDrag.points) {
    state.activeDrag.points.push({ x: coords.x, y: coords.y });
  }

  const finishedDrag = state.activeDrag;
  state.activeDrag = null;
  previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);

  enqueueCanvasMutation(async () => {
    await pushUndoSnapshot();
    const drew = renderAnnotation(
      baseCtx,
      buildDragOp(finishedDrag),
      els.baseCanvas.width,
      els.baseCanvas.height
    );

    if (drew) {
      state.isAtOriginalCapture = false;
      state.imageModifiedSinceSave = true;
    } else {
      const unused = state.undoStack.pop();
      unused?.bitmap?.close?.();
    }
    updateUiState();
  });
}

els.previewCanvas.addEventListener('pointerup', finishPointerDrag);
els.previewCanvas.addEventListener('pointercancel', () => {
  state.activeDrag = null;
  previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
});

els.textOverlayInput.addEventListener('input', () => updateUiState());

els.textOverlayInput.addEventListener('keydown', async (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelActiveText();
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    await commitActiveTextIfNeeded();
  }
});

/* Intentional Pencil Rename Handlers */
function openFilenameEditor() {
  if (!state.ready || state.saving) return;
  els.filenameReadonly.hidden = true;
  els.filenameEditing.hidden = false;
  els.filenameInput.value = state.committedStem;
  els.filenameInput.focus();
  els.filenameInput.select();
}

function commitFilenameEdit() {
  const clean = sanitizeScreenshotFilename(els.filenameInput.value, state.savedFilename);
  syncFilenameDisplay(clean);
  els.filenameEditing.hidden = true;
  els.filenameReadonly.hidden = false;
  updateUiState();
}

function cancelFilenameEdit() {
  els.filenameInput.value = state.committedStem;
  els.filenameEditing.hidden = true;
  els.filenameReadonly.hidden = false;
  updateUiState();
}

els.renamePencilBtn.addEventListener('click', openFilenameEditor);
els.filenameInput.addEventListener('input', () => updateUiState());
els.filenameInput.addEventListener('blur', commitFilenameEdit);
els.filenameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    els.filenameInput.blur();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    cancelFilenameEdit();
  }
});

/* Custom Hex Color Popover Handlers */
els.customColorBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  const willShow = els.hexPopover.hidden;
  els.hexPopover.hidden = !willShow;
  els.hexInputWrap.classList.remove('invalid');
  if (willShow) {
    els.hexColorNative.value = state.color;
    els.hexTextInput.value = state.color.slice(1).toUpperCase();
    els.hexTextInput.focus();
    els.hexTextInput.select();
  }
});

els.hexPopover.addEventListener('click', (event) => {
  event.stopPropagation();
});

els.hexColorNative.addEventListener('input', () => {
  const parsed = parseHexColorInput(els.hexColorNative.value);
  if (parsed) {
    els.hexInputWrap.classList.remove('invalid');
    setColor(parsed, { isCustom: true });
  }
});

function applyHexFromTextInput() {
  const parsed = parseHexColorInput(els.hexTextInput.value);
  if (!parsed) {
    els.hexInputWrap.classList.add('invalid');
    return false;
  }
  els.hexInputWrap.classList.remove('invalid');
  setColor(parsed, { isCustom: true });
  closeHexPopover();
  return true;
}

els.applyHexBtn.addEventListener('click', () => {
  applyHexFromTextInput();
});

els.hexTextInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    applyHexFromTextInput();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeHexPopover();
  }
});

document.addEventListener('click', (event) => {
  if (
    !els.hexPopover.hidden &&
    !els.hexPopover.contains(event.target) &&
    event.target !== els.customColorBtn
  ) {
    closeHexPopover();
  }
});

for (const btn of document.querySelectorAll('[data-tool]')) {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
}

for (const swatch of els.colorSwatches.querySelectorAll('[data-color]')) {
  swatch.addEventListener('click', () => {
    closeHexPopover();
    setColor(swatch.dataset.color, { isCustom: false });
  });
}

for (const pill of els.sizePills.querySelectorAll('[data-size]')) {
  pill.addEventListener('click', () => setSizeKey(pill.dataset.size));
}

for (const btn of document.querySelectorAll('[data-transform]')) {
  btn.addEventListener('click', () => applyTransform(btn.dataset.transform));
}

els.undoBtn.addEventListener('click', () => undoLastChange());
els.resetBtn.addEventListener('click', () => resetToOriginal());

els.downloadBtn.addEventListener('click', async () => {
  if (!state.ready) return;
  await commitActiveTextIfNeeded();
  const filename = getDesiredFilename();
  els.baseCanvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showStatusPill('ok', `Downloaded ${filename}`, 3000);
  }, 'image/png');
});

els.copyLinkBtn.addEventListener('click', async () => {
  const safeLink = safeHttpsUrl(state.webViewLink);
  if (!safeLink) return;
  try {
    await navigator.clipboard.writeText(safeLink);
    els.copyLinkBtn.textContent = 'Copied!';
    setTimeout(() => {
      els.copyLinkBtn.textContent = 'Copy link';
    }, 1600);
  } catch {
    showStatusPill('err', 'Could not copy link to clipboard.', 3000);
  }
});

async function exportCanvasDataUrl() {
  const blob = await new Promise((resolve, reject) => {
    els.baseCanvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error('Could not encode PNG screenshot.'));
    }, 'image/png');
  });
  return blobToDataUrl(blob);
}

async function performSave(saveMode) {
  if (!state.ready || state.saving) return;
  await commitActiveTextIfNeeded();

  const desiredFilename = getDesiredFilename();
  syncFilenameDisplay(desiredFilename);

  const needImagePayload =
    state.mode === 'new' || saveMode === 'new' || state.imageModifiedSinceSave;

  state.saving = true;
  updateUiState();
  showStatusPill(
    'warn',
    saveMode === 'replace' && state.mode === 'existing'
      ? 'Replacing in Google Drive...'
      : 'Uploading to Google Drive...'
  );

  try {
    const dataUrl = needImagePayload ? await exportCanvasDataUrl() : '';
    const res = await sendRuntimeMessage({
      type: 'SAVE_EDITED_SCREENSHOT',
      sessionId: state.sessionId,
      filename: desiredFilename,
      dataUrl,
      imageModified: needImagePayload,
      saveMode,
      sessionContext: {
        mode: state.mode,
        fileId: state.fileId,
        filename: state.savedFilename,
        folderName: state.folderName,
        webViewLink: state.webViewLink,
        captureMode: state.captureMode,
        pageUrl: state.pageUrl,
        pageTitle: state.pageTitle,
        incognito: state.incognito,
      },
    });

    if (!res.ok) {
      throw new Error(res.error || 'Failed to save screenshot to Google Drive.');
    }

    state.mode = 'existing';
    state.fileId = res.upload.id;
    state.savedFilename = res.upload.name;
    state.folderName = res.upload.folderName || state.folderName;
    state.webViewLink = res.upload.webViewLink || state.webViewLink;
    if (needImagePayload) {
      state.driveMatchesInitial = state.isAtOriginalCapture;
      for (const entry of state.undoStack) {
        entry.imageModifiedSinceSave = true;
      }
    }
    state.imageModifiedSinceSave = false;
    syncFilenameDisplay(state.savedFilename);

    let copied = false;
    const safeLink = safeHttpsUrl(state.webViewLink);
    if (res.autoCopyLink && safeLink && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(safeLink);
        copied = true;
      } catch {
        // Ignore clipboard failure when tab is unfocused
      }
    }

    const actionWord =
      res.action === 'replaced' ? 'Replaced in Google Drive' : 'Saved to Google Drive';
    showStatusPill(
      'ok',
      copied ? `${actionWord} \u00b7 Link copied` : actionWord,
      5000
    );
  } catch (err) {
    showStatusPill(
      'err',
      err.message || 'Could not save to Google Drive. Use "Download" to save locally.'
    );
  } finally {
    state.saving = false;
    updateUiState();
  }
}

els.saveDriveBtn.addEventListener('click', async () => {
  if (!state.ready || state.saving) return;
  await commitActiveTextIfNeeded();

  if (state.mode === 'existing') {
    if (!hasUnsavedChanges()) {
      return;
    }
    els.confirmReplaceDialog.showModal();
    return;
  }

  await performSave('new');
});

els.cancelReplaceBtn.addEventListener('click', () => {
  els.confirmReplaceDialog.close();
});

els.saveNewCopyBtn.addEventListener('click', async () => {
  els.confirmReplaceDialog.close();
  await performSave('new');
});

els.confirmReplaceBtn.addEventListener('click', async () => {
  els.confirmReplaceDialog.close();
  await performSave('replace');
});

window.addEventListener('keydown', (event) => {
  if (!state.ready || state.saving || els.confirmReplaceDialog.open) return;

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (!els.filenameEditing.hidden) {
      els.filenameInput.blur();
    }
    if (!els.saveDriveBtn.disabled) {
      els.saveDriveBtn.click();
    }
    return;
  }

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (event.key === 'Escape' && !els.hexPopover.hidden) {
    event.preventDefault();
    closeHexPopover();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undoLastChange();
    return;
  }

  if (event.ctrlKey || event.metaKey || event.altKey) return;

  const keyMap = {
    a: 'arrow',
    b: 'box',
    c: 'circle',
    l: 'line',
    p: 'pencil',
    t: 'text',
    r: 'redact',
  };
  const nextTool = keyMap[event.key.toLowerCase()];
  if (nextTool) {
    event.preventDefault();
    setTool(nextTool);
  }
});

window.addEventListener('beforeunload', (event) => {
  if (hasUnsavedChanges()) {
    event.preventDefault();
    event.returnValue = '';
  }
});

window.addEventListener('pagehide', () => {
  clearUndoStack();
  state.initialBitmap?.close?.();
});

async function initEditor() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session') || '';
  if (!sessionId) {
    els.stageSpinner.hidden = true;
    els.stageMessageText.textContent =
      'No screenshot session specified. Capture a screenshot or click Edit in the SaveShot popup.';
    return;
  }

  state.sessionId = sessionId;

  try {
    const res = await sendRuntimeMessage({
      type: 'GET_EDITOR_SESSION',
      sessionId,
    });
    if (!res.ok || !res.dataUrl) {
      throw new Error(res.error || 'Could not load screenshot session.');
    }

    const blob = await dataUrlToBlob(res.dataUrl);
    const bitmap = await createImageBitmap(blob);

    state.initialBitmap = bitmap;
    state.mode = res.session.mode === 'new' ? 'new' : 'existing';
    state.driveMatchesInitial = state.mode === 'existing';
    state.fileId = res.session.fileId || null;
    state.savedFilename = sanitizeScreenshotFilename(
      res.session.filename || 'Screenshot.png'
    );
    state.folderName = res.session.folderName || 'Chrome_SaveShot_ScreenShots';
    state.webViewLink = res.session.webViewLink || '';
    state.captureMode = res.session.captureMode || 'visible';
    state.pageUrl = res.session.pageUrl || '';
    state.pageTitle = res.session.pageTitle || '';
    state.incognito = Boolean(res.session.incognito);
    state.autoCopyLink = Boolean(res.session.autoCopyLink);

    syncFilenameDisplay(state.savedFilename);

    els.baseCanvas.width = bitmap.width;
    els.baseCanvas.height = bitmap.height;
    baseCtx.drawImage(bitmap, 0, 0);
    syncPreviewCanvasSize();

    state.ready = true;
    els.stageMessage.hidden = true;
    els.canvasWrap.hidden = false;
    updateUiState();

    if (res.session.justUploaded) {
      let copied = false;
      const safeLink = safeHttpsUrl(state.webViewLink);
      if (state.autoCopyLink && safeLink && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(safeLink);
          copied = true;
        } catch {
          // Ignore clipboard error when tab is unfocused
        }
      }
      showStatusPill(
        'ok',
        copied ? 'Saved to Google Drive \u00b7 Link copied' : 'Saved to Google Drive',
        5000
      );
    }
  } catch (err) {
    els.stageSpinner.hidden = true;
    els.stageMessageText.textContent =
      err.message || 'Could not load screenshot for editing.';
    showStatusPill('err', 'Session unavailable');
  }
}

initThemeSync();
initEditor();
