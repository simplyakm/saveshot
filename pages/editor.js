import {
  blobToDataUrl,
  dataUrlToBlob,
  sanitizeScreenshotFilename,
} from '../lib/capture.js';
import {
  FONT_SIZES,
  HIGHLIGHTER_SIZES,
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
  editorHelpBtn: document.getElementById('editor-help-btn'),
  copyImageBtn: document.getElementById('copy-image-btn'),
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
  signedIn: false,
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
  userPickedColor: false,
  highlighterAutoColored: false,
  sizeKey: 'md',
  ready: false,
  saving: false,
  uploadState: 'idle', // 'idle' | 'uploading' | 'uploaded' | 'failed'
  uploadError: '',
  uploadErrorCode: '',
  uploadRequiresReauth: false,
  autoCopyAttempted: false,
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

function clearStatusPillIfIdle() {
  if (state.saving || state.uploadState === 'uploading' || state.uploadState === 'failed') {
    return;
  }
  if (statusPillTimer) {
    clearTimeout(statusPillTimer);
    statusPillTimer = null;
  }
  els.statusPill.hidden = true;
  els.statusPill.title = '';
}

function restorePersistentUploadPill() {
  if (!state.ready || state.saving) return;
  if (state.signedIn && state.uploadState === 'uploading') {
    showStatusPill('warn', 'Uploading to Google Drive...');
  } else if (state.uploadState === 'failed') {
    showStatusPill(
      'err',
      state.uploadError || 'Could not upload to Google Drive. Click Retry or Download locally.'
    );
  }
}

function showStatusPill(kind, text, autoHideMs = 0) {
  if (statusPillTimer) {
    clearTimeout(statusPillTimer);
    statusPillTimer = null;
  }
  if (!text) {
    els.statusPill.hidden = true;
    els.statusPill.title = '';
    updateUiState();
    return;
  }
  els.unsavedPill.hidden = true;
  els.statusPill.hidden = false;
  els.statusPill.className = `status-pill ${kind}`;
  els.statusPill.textContent = text;
  els.statusPill.title = text;
  if (autoHideMs > 0) {
    statusPillTimer = setTimeout(() => {
      statusPillTimer = null;
      if (els.statusPill.textContent === text) {
        els.statusPill.hidden = true;
        els.statusPill.title = '';
        restorePersistentUploadPill();
        updateUiState();
      }
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
  const isUploadingInitial = state.signedIn && state.uploadState === 'uploading';
  const isFailedInitial =
    state.signedIn && state.mode === 'new' && state.uploadState === 'failed';
  const showUnsaved =
    state.ready &&
    !state.saving &&
    state.signedIn &&
    dirty &&
    !isUploadingInitial &&
    !isFailedInitial;

  if (showUnsaved && !els.statusPill.hidden && els.statusPill.classList.contains('ok')) {
    els.statusPill.hidden = true;
    els.statusPill.title = '';
  }
  els.unsavedPill.hidden = !showUnsaved || !els.statusPill.hidden;

  if (!state.signedIn) {
    els.saveDriveBtn.textContent = 'Save to Google Drive';
    els.saveDriveBtn.disabled = !state.ready || state.saving;
    els.saveDriveBtn.title = !state.ready
      ? 'Loading screenshot...'
      : 'Connect Google Drive and save screenshot';
  } else if (isFailedInitial) {
    els.saveDriveBtn.textContent = 'Retry';
    els.saveDriveBtn.disabled = !state.ready || state.saving;
    els.saveDriveBtn.title = !state.ready
      ? 'Loading screenshot...'
      : 'Retry uploading screenshot to Google Drive';
  } else if (isUploadingInitial) {
    els.saveDriveBtn.textContent = 'Save';
    els.saveDriveBtn.disabled = !state.ready || state.saving || !dirty;
    els.saveDriveBtn.title = !state.ready
      ? 'Loading screenshot...'
      : dirty
      ? 'Save changes to Google Drive'
      : 'Uploading screenshot to Google Drive...';
  } else {
    const canSave = state.ready && !state.saving && (state.mode === 'new' || dirty);
    els.saveDriveBtn.textContent = 'Save';
    els.saveDriveBtn.disabled = !canSave;
    els.saveDriveBtn.title = !state.ready
      ? 'Loading screenshot...'
      : state.mode === 'new'
      ? 'Upload screenshot to Google Drive'
      : dirty
      ? 'Save changes to Google Drive'
      : 'Make an edit or rename to enable Save';
  }

  const safeLink = state.signedIn ? safeHttpsUrl(state.webViewLink) : '';
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

function getEffectiveStrokeWidth(tool = state.tool) {
  const sizeTable = tool === 'highlighter' ? HIGHLIGHTER_SIZES : STROKE_SIZES;
  const base = sizeTable[state.sizeKey] || sizeTable.md;
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
  if (document.activeElement === els.textOverlayInput) {
    els.textOverlayInput.blur();
  }
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
      clearStatusPillIfIdle();
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
  if (document.activeElement === els.textOverlayInput) {
    els.textOverlayInput.blur();
  }
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

  if (
    nextTool === 'highlighter' &&
    !state.userPickedColor &&
    !state.highlighterAutoColored &&
    state.color === '#ef4444'
  ) {
    state.highlighterAutoColored = true;
    setColor('#f59e0b', { isCustom: false });
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
  }
  cancelPreviewRender();
  previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);

  return enqueueCanvasMutation(async () => {
    await pushUndoSnapshot();
    const sourceBitmap = state.undoStack[state.undoStack.length - 1].bitmap;
    transformSourceToCanvas(sourceBitmap, kind, els.baseCanvas);
    syncPreviewCanvasSize();
    state.isAtOriginalCapture = false;
    state.imageModifiedSinceSave = true;
    clearStatusPillIfIdle();
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
    clearStatusPillIfIdle();
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
    clearStatusPillIfIdle();
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

let previewRafId = 0;

function cancelPreviewRender() {
  if (previewRafId) {
    cancelAnimationFrame(previewRafId);
    previewRafId = 0;
  }
}

function renderActiveDragPreview() {
  previewRafId = 0;
  previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
  if (!state.activeDrag) return;
  renderAnnotation(
    previewCtx,
    buildDragOp(state.activeDrag),
    els.previewCanvas.width,
    els.previewCanvas.height
  );
}

function schedulePreviewRender() {
  if (previewRafId) return;
  previewRafId = requestAnimationFrame(renderActiveDragPreview);
}

function computeHighlighterPoints(drag, shiftKey) {
  if (shiftKey) {
    const dx = drag.currentX - drag.startX;
    const dy = drag.currentY - drag.startY;
    const snappedEnd =
      Math.abs(dx) >= Math.abs(dy)
        ? { x: drag.currentX, y: drag.startY }
        : { x: drag.startX, y: drag.currentY };
    return [{ x: drag.startX, y: drag.startY }, snappedEnd];
  }
  return drag.rawPoints;
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

  const isFreehand = state.tool === 'pencil' || state.tool === 'highlighter';
  const initialRawPoints = isFreehand ? [{ x: coords.x, y: coords.y }] : null;

  state.activeDrag = {
    pointerId: event.pointerId,
    tool: state.tool,
    color: state.color,
    strokeWidth: getEffectiveStrokeWidth(state.tool),
    startX: coords.x,
    startY: coords.y,
    currentX: coords.x,
    currentY: coords.y,
    rawPoints: initialRawPoints,
    points: initialRawPoints,
  };
  renderActiveDragPreview();
});

els.previewCanvas.addEventListener('pointermove', (event) => {
  if (!state.activeDrag || event.pointerId !== state.activeDrag.pointerId) return;
  event.preventDefault();
  const coords = getCanvasCoordinates(event);
  state.activeDrag.currentX = coords.x;
  state.activeDrag.currentY = coords.y;
  if (state.activeDrag.rawPoints) {
    const last = state.activeDrag.rawPoints[state.activeDrag.rawPoints.length - 1];
    if (!last || Math.hypot(coords.x - last.x, coords.y - last.y) >= 1.5) {
      state.activeDrag.rawPoints.push({ x: coords.x, y: coords.y });
    }
    state.activeDrag.points =
      state.activeDrag.tool === 'highlighter'
        ? computeHighlighterPoints(state.activeDrag, event.shiftKey)
        : state.activeDrag.rawPoints;
  }
  schedulePreviewRender();
});

function finishPointerDrag(event) {
  if (!state.activeDrag || event.pointerId !== state.activeDrag.pointerId) return;
  event.preventDefault();
  const coords = getCanvasCoordinates(event);
  state.activeDrag.currentX = coords.x;
  state.activeDrag.currentY = coords.y;
  if (state.activeDrag.rawPoints) {
    state.activeDrag.rawPoints.push({ x: coords.x, y: coords.y });
    state.activeDrag.points =
      state.activeDrag.tool === 'highlighter'
        ? computeHighlighterPoints(state.activeDrag, event.shiftKey)
        : state.activeDrag.rawPoints;
  }

  const finishedDrag = state.activeDrag;
  state.activeDrag = null;
  cancelPreviewRender();
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
      clearStatusPillIfIdle();
    } else {
      const unused = state.undoStack.pop();
      unused?.bitmap?.close?.();
    }
    updateUiState();
  });
}

els.previewCanvas.addEventListener('pointerup', finishPointerDrag);
els.previewCanvas.addEventListener('pointercancel', (event) => {
  if (state.activeDrag && event.pointerId !== state.activeDrag.pointerId) return;
  state.activeDrag = null;
  cancelPreviewRender();
  previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
});

els.textOverlayInput.addEventListener('input', () => {
  clearStatusPillIfIdle();
  updateUiState();
});

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
  if (els.filenameEditing.hidden) return;
  const clean = sanitizeScreenshotFilename(els.filenameInput.value, state.savedFilename);
  syncFilenameDisplay(clean);
  els.filenameEditing.hidden = true;
  els.filenameReadonly.hidden = false;
  if (document.activeElement === els.filenameInput) {
    els.filenameInput.blur();
  }
  updateUiState();
}

function cancelFilenameEdit() {
  els.filenameInput.value = state.committedStem;
  els.filenameEditing.hidden = true;
  els.filenameReadonly.hidden = false;
  if (document.activeElement === els.filenameInput) {
    els.filenameInput.blur();
  }
  updateUiState();
}

els.renamePencilBtn.addEventListener('click', openFilenameEditor);
els.filenameInput.addEventListener('input', () => {
  clearStatusPillIfIdle();
  updateUiState();
});
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
    state.userPickedColor = true;
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
  state.userPickedColor = true;
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
    state.userPickedColor = true;
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

els.editorHelpBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/welcome.html') });
});

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode PNG screenshot.'));
    }, 'image/png');
  });
}

let copyImageTimer = null;

async function copyCanvasImageToClipboard() {
  if (!state.ready) return false;
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    showStatusPill('err', 'Clipboard image copy is not available in this browser.', 3000);
    return false;
  }
  try {
    const pngBlobPromise = (async () => {
      await commitActiveTextIfNeeded();
      return canvasToPngBlob(els.baseCanvas);
    })();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlobPromise })]);
    if (copyImageTimer) clearTimeout(copyImageTimer);
    els.copyImageBtn.textContent = 'Copied!';
    copyImageTimer = setTimeout(() => {
      copyImageTimer = null;
      els.copyImageBtn.textContent = 'Copy image';
    }, 1600);
    showStatusPill('ok', 'Copied image to clipboard', 2600);
    return true;
  } catch {
    showStatusPill('err', 'Could not copy image to clipboard.', 3000);
    return false;
  }
}

els.copyImageBtn.addEventListener('click', () => {
  copyCanvasImageToClipboard();
});

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

let copyLinkTimer = null;

els.copyLinkBtn.addEventListener('click', async () => {
  const safeLink = safeHttpsUrl(state.webViewLink);
  if (!safeLink) return;
  try {
    await navigator.clipboard.writeText(safeLink);
    if (copyLinkTimer) clearTimeout(copyLinkTimer);
    els.copyLinkBtn.textContent = 'Copied!';
    copyLinkTimer = setTimeout(() => {
      copyLinkTimer = null;
      els.copyLinkBtn.textContent = 'Copy link';
    }, 1600);
  } catch {
    showStatusPill('err', 'Could not copy link to clipboard.', 3000);
  }
});

async function exportCanvasDataUrl() {
  const blob = await canvasToPngBlob(els.baseCanvas);
  return blobToDataUrl(blob);
}

let pendingUploadUpdate = null;
let pendingAuthRefresh = false;
let uploadPollTimer = null;
let saveClickPending = false;

function stopUploadStatusPoll() {
  if (uploadPollTimer) {
    clearInterval(uploadPollTimer);
    uploadPollTimer = null;
  }
}

async function syncAuthStateFromWorker() {
  if (state.saving || !state.ready) return;
  try {
    const res = await sendRuntimeMessage({ type: 'GET_STATE' });
    if (!res?.ok || state.saving) return;

    const nowSignedIn = Boolean(res.session?.signedIn);
    if (!nowSignedIn) {
      const keepAuthErrorPill =
        state.uploadState === 'failed' && state.uploadRequiresReauth;
      state.signedIn = false;
      state.mode = 'new';
      state.fileId = null;
      state.webViewLink = '';
      state.driveMatchesInitial = false;
      if (!keepAuthErrorPill) {
        stopUploadStatusPoll();
        state.uploadState = 'idle';
        state.uploadError = '';
        state.uploadErrorCode = '';
        state.uploadRequiresReauth = false;
        if (!els.statusPill.hidden && els.statusPill.classList.contains('warn')) {
          els.statusPill.hidden = true;
          els.statusPill.title = '';
        }
      }
    } else {
      state.signedIn = true;
      if (res.settings) {
        state.autoCopyLink = Boolean(res.settings.autoCopyLink);
        state.folderName = res.settings.folderName || state.folderName;
      }
    }
    updateUiState();
  } catch {
    // Ignore transient background state error
  }
}

function startUploadStatusPoll() {
  stopUploadStatusPoll();
  if (!state.sessionId || state.uploadState !== 'uploading') return;
  uploadPollTimer = setInterval(async () => {
    if (!state.ready || state.uploadState !== 'uploading' || state.saving) {
      if (state.uploadState !== 'uploading') stopUploadStatusPoll();
      return;
    }
    try {
      const res = await sendRuntimeMessage({
        type: 'GET_EDITOR_UPLOAD_STATUS',
        sessionId: state.sessionId,
      });
      if (res?.ok && res.uploadState && res.uploadState !== 'uploading') {
        await applyBackgroundUploadUpdate(res);
      } else if (res && !res.ok && res.code === 'EDITOR_SESSION_EXPIRED') {
        stopUploadStatusPoll();
        const stateRes = await sendRuntimeMessage({ type: 'GET_STATE' }).catch(() => null);
        if (stateRes?.ok && !stateRes.session?.signedIn) {
          await syncAuthStateFromWorker();
        } else {
          await applyBackgroundUploadUpdate({
            sessionId: state.sessionId,
            uploadState: 'failed',
            uploadError:
              'Background upload was interrupted. Click Retry to save to Google Drive.',
            uploadErrorCode: 'UPLOAD_INTERRUPTED',
          });
        }
      }
    } catch {
      // Ignore transient poll errors while waiting for background upload
    }
  }, 2500);
}

async function tryAutoCopyShareLink() {
  if (state.autoCopyAttempted) return false;
  const safeLink = safeHttpsUrl(state.webViewLink);
  if (!state.autoCopyLink || !safeLink || !navigator.clipboard?.writeText) {
    return false;
  }
  state.autoCopyAttempted = true;
  try {
    await navigator.clipboard.writeText(safeLink);
    return true;
  } catch {
    return false;
  }
}

async function applyBackgroundUploadUpdate(update, { fromInitialLoad = false } = {}) {
  if (!update || update.sessionId !== state.sessionId) return;
  if (!state.ready) {
    pendingUploadUpdate = update;
    return;
  }

  const nextState = update.uploadState || 'idle';

  if (nextState === 'uploading') {
    if (state.mode === 'existing' || state.uploadState === 'uploaded') return;
    state.uploadState = 'uploading';
    state.uploadError = '';
    state.uploadErrorCode = '';
    state.uploadRequiresReauth = false;
    if (!state.saving) {
      showStatusPill('warn', 'Uploading to Google Drive...');
      updateUiState();
    }
    startUploadStatusPoll();
    return;
  }

  if (nextState === 'uploaded') {
    stopUploadStatusPoll();
    const alreadyApplied =
      state.uploadState === 'uploaded' &&
      state.mode === 'existing' &&
      state.fileId === update.fileId &&
      !fromInitialLoad;
    if (alreadyApplied) return;

    const userRenamed =
      getDesiredFilename() !== state.savedFilename || !els.filenameEditing.hidden;

    state.mode = 'existing';
    state.fileId = update.fileId || state.fileId;
    state.folderName = update.folderName || state.folderName;
    state.webViewLink = update.webViewLink || state.webViewLink;
    state.savedFilename = sanitizeScreenshotFilename(
      update.filename || state.savedFilename
    );
    state.uploadState = 'uploaded';
    state.uploadError = '';
    state.uploadErrorCode = '';
    state.uploadRequiresReauth = false;
    state.driveMatchesInitial = true;

    if (!userRenamed) {
      syncFilenameDisplay(state.savedFilename);
    }

    // If the user already clicked Save while upload was in flight, let performSave own the status pill
    if (state.saving) {
      updateUiState();
      return;
    }

    const copied = await tryAutoCopyShareLink();

    if (state.saving) {
      updateUiState();
      return;
    }

    if (hasUnsavedChanges()) {
      if (!els.statusPill.classList.contains('err')) {
        if (statusPillTimer) {
          clearTimeout(statusPillTimer);
          statusPillTimer = null;
        }
        els.statusPill.hidden = true;
        els.statusPill.title = '';
      }
      updateUiState();
      return;
    }

    showStatusPill(
      'ok',
      copied ? 'Saved to Google Drive \u00b7 Link copied' : 'Saved to Google Drive',
      5000
    );
    updateUiState();
    return;
  }

  if (nextState === 'failed') {
    stopUploadStatusPoll();
    if (state.mode === 'existing' || state.uploadState === 'uploaded') return;
    const nextError =
      update.uploadError ||
      'Could not upload to Google Drive. Click Retry or Download locally.';
    const alreadyApplied =
      state.uploadState === 'failed' &&
      state.uploadError === nextError &&
      !fromInitialLoad;
    if (alreadyApplied) return;

    state.uploadState = 'failed';
    state.uploadError = nextError;
    state.uploadErrorCode = update.uploadErrorCode || 'UPLOAD_ERROR';
    state.uploadRequiresReauth = Boolean(update.uploadRequiresReauth);
    if (state.uploadRequiresReauth) {
      state.signedIn = false;
    }

    if (!state.saving) {
      showStatusPill('err', state.uploadError);
      updateUiState();
    }
  }
}

async function performSave(saveMode) {
  if (!state.ready || state.saving) return;
  // Set saving lock synchronously before any await so rapid double-clicks / Ctrl+S cannot duplicate uploads
  state.saving = true;
  updateUiState();

  try {
    await commitActiveTextIfNeeded();

    const desiredFilename = getDesiredFilename();
    syncFilenameDisplay(desiredFilename);

    const wasSignedOut = !state.signedIn;
    const wasUploadingInitial = state.signedIn && state.uploadState === 'uploading';
    const effectiveMode = wasSignedOut ? 'new' : state.mode;
    const effectiveSaveMode = wasSignedOut ? 'new' : saveMode;
    const pixelsModified = Boolean(state.imageModifiedSinceSave);
    const needImagePayload =
      wasSignedOut ||
      effectiveMode === 'new' ||
      effectiveSaveMode === 'new' ||
      pixelsModified;
    const sendImageModified =
      wasSignedOut || effectiveSaveMode === 'new' || pixelsModified;

    showStatusPill(
      'warn',
      wasSignedOut
        ? 'Connecting to Google Drive...'
        : wasUploadingInitial
        ? 'Saving to Google Drive...'
        : effectiveSaveMode === 'replace' && effectiveMode === 'existing'
        ? 'Replacing in Google Drive...'
        : 'Uploading to Google Drive...'
    );

    const dataUrl = needImagePayload ? await exportCanvasDataUrl() : '';
    const res = await sendRuntimeMessage({
      type: 'SAVE_EDITED_SCREENSHOT',
      sessionId: state.sessionId,
      filename: desiredFilename,
      dataUrl,
      imageModified: sendImageModified,
      saveMode: effectiveSaveMode,
      sessionContext: {
        mode: effectiveMode,
        fileId: wasSignedOut ? null : state.fileId,
        filename: state.savedFilename,
        folderName: state.folderName,
        webViewLink: wasSignedOut ? '' : state.webViewLink,
        captureMode: state.captureMode,
        pageUrl: state.pageUrl,
        pageTitle: state.pageTitle,
        incognito: state.incognito,
      },
    });

    if (!res.ok) {
      if (res.code === 'AUTH_CANCELLED') {
        showStatusPill('warn', 'Sign-in cancelled', 3500);
        return;
      }
      const err = new Error(res.error || 'Failed to save screenshot to Google Drive.');
      err.code = res.code || 'UPLOAD_ERROR';
      err.requiresReauth = Boolean(res.requiresReauth);
      throw err;
    }

    stopUploadStatusPoll();
    state.signedIn = true;
    state.mode = 'existing';
    state.uploadState = 'uploaded';
    state.uploadError = '';
    state.uploadErrorCode = '';
    state.uploadRequiresReauth = false;
    state.fileId = res.upload.id;
    state.savedFilename = res.upload.name;
    state.folderName = res.upload.folderName || state.folderName;
    state.webViewLink = res.upload.webViewLink || state.webViewLink;
    const uploadedCanvasPixels = res.action === 'created' || pixelsModified;
    if (uploadedCanvasPixels) {
      state.driveMatchesInitial = state.isAtOriginalCapture;
      for (const entry of state.undoStack) {
        entry.imageModifiedSinceSave = true;
      }
    } else if (wasUploadingInitial) {
      state.driveMatchesInitial = state.isAtOriginalCapture;
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
    if (err.requiresReauth) {
      stopUploadStatusPoll();
      state.signedIn = false;
      state.mode = 'new';
      state.fileId = null;
      state.webViewLink = '';
      state.driveMatchesInitial = false;
      state.uploadState = 'failed';
      state.uploadError =
        err.message || 'Your Google Drive session expired. Click "Save to Google Drive" again.';
      state.uploadErrorCode = err.code || 'AUTH_REVOKED';
      state.uploadRequiresReauth = true;
    } else if (state.mode === 'new') {
      stopUploadStatusPoll();
      state.uploadState = 'failed';
      state.uploadError =
        err.message || 'Could not save to Google Drive. Use "Download" to save locally.';
      state.uploadErrorCode = err.code || 'UPLOAD_ERROR';
      state.uploadRequiresReauth = false;
    }
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
  if (!state.ready || state.saving || saveClickPending) return;
  saveClickPending = true;
  try {
    await commitActiveTextIfNeeded();

    if (state.signedIn && state.mode === 'existing') {
      if (!hasUnsavedChanges()) {
        return;
      }
      els.confirmReplaceDialog.showModal();
      return;
    }

    if (state.signedIn && (state.uploadState === 'uploading' || state.uploadState === 'failed')) {
      if (state.uploadState === 'uploading' && !hasUnsavedChanges()) {
        return;
      }
      await performSave('replace');
      return;
    }

    await performSave('new');
  } finally {
    saveClickPending = false;
  }
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
  if (event.key === 'Shift' && state.activeDrag?.tool === 'highlighter' && state.activeDrag.rawPoints) {
    state.activeDrag.points = computeHighlighterPoints(state.activeDrag, true);
    schedulePreviewRender();
  }

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

  const activeEl = document.activeElement;
  const tag = activeEl?.tagName;
  if ((tag === 'INPUT' || tag === 'TEXTAREA') && activeEl.offsetParent !== null) return;

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

  if (
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'c'
  ) {
    const selection = window.getSelection?.();
    if (selection && !selection.isCollapsed && String(selection).length > 0) {
      return;
    }
    event.preventDefault();
    copyCanvasImageToClipboard();
    return;
  }

  if (event.ctrlKey || event.metaKey || event.altKey) return;

  const keyMap = {
    a: 'arrow',
    b: 'box',
    c: 'circle',
    l: 'line',
    h: 'highlighter',
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

window.addEventListener('keyup', (event) => {
  if (event.key === 'Shift' && state.activeDrag?.tool === 'highlighter' && state.activeDrag.rawPoints) {
    state.activeDrag.points = computeHighlighterPoints(state.activeDrag, false);
    schedulePreviewRender();
  }
});

window.addEventListener('beforeunload', (event) => {
  if (state.signedIn && hasUnsavedChanges()) {
    event.preventDefault();
    event.returnValue = '';
  }
});

window.addEventListener('pagehide', () => {
  stopUploadStatusPoll();
  clearUndoStack();
  state.initialBitmap?.close?.();
  state.initialBitmap = null;
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
    state.signedIn = Boolean(res.session.signedIn);
    state.mode = res.session.mode === 'new' ? 'new' : 'existing';
    state.driveMatchesInitial = state.signedIn && state.mode === 'existing';
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
    state.uploadState = res.session.uploadState || 'idle';
    state.uploadError = res.session.uploadError || '';
    state.uploadErrorCode = res.session.uploadErrorCode || '';
    state.uploadRequiresReauth = Boolean(res.session.uploadRequiresReauth);

    syncFilenameDisplay(state.savedFilename);

    els.baseCanvas.width = bitmap.width;
    els.baseCanvas.height = bitmap.height;
    baseCtx.drawImage(bitmap, 0, 0);
    syncPreviewCanvasSize();

    state.ready = true;
    els.stageMessage.hidden = true;
    els.canvasWrap.hidden = false;
    updateUiState();

    if (pendingUploadUpdate && pendingUploadUpdate.sessionId === state.sessionId) {
      const queued = pendingUploadUpdate;
      pendingUploadUpdate = null;
      await applyBackgroundUploadUpdate(queued, { fromInitialLoad: true });
    } else if (
      state.uploadState === 'uploading' ||
      state.uploadState === 'failed' ||
      res.session.justUploaded
    ) {
      await applyBackgroundUploadUpdate(
        {
          sessionId: state.sessionId,
          mode: state.mode,
          fileId: state.fileId,
          filename: state.savedFilename,
          folderName: state.folderName,
          webViewLink: state.webViewLink,
          uploadState: res.session.justUploaded ? 'uploaded' : state.uploadState,
          uploadError: state.uploadError,
          uploadErrorCode: state.uploadErrorCode,
          uploadRequiresReauth: state.uploadRequiresReauth,
        },
        { fromInitialLoad: true }
      );
    }

    if (pendingAuthRefresh) {
      pendingAuthRefresh = false;
      await syncAuthStateFromWorker();
    }
  } catch (err) {
    els.stageSpinner.hidden = true;
    els.stageMessageText.textContent =
      err.message || 'Could not load screenshot for editing.';
    showStatusPill('err', 'Session unavailable');
  }
}

if (chrome?.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender?.id && chrome?.runtime?.id && sender.id !== chrome.runtime.id) return;
    if (sender?.tab) return;
    if (
      message?.type === 'EDITOR_UPLOAD_STATUS' &&
      message.sessionId &&
      message.sessionId === state.sessionId
    ) {
      applyBackgroundUploadUpdate(message);
    }
  });
}

if (chrome?.storage?.onChanged?.addListener) {
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName === 'session' && changes.editorSessionsById?.newValue) {
      if (state.saving && state.mode === 'existing') return;
      const updatedSession = changes.editorSessionsById.newValue[state.sessionId];
      if (
        updatedSession &&
        (updatedSession.uploadState === 'uploaded' || updatedSession.uploadState === 'failed')
      ) {
        await applyBackgroundUploadUpdate(updatedSession);
      }
      return;
    }

    if (areaName !== 'local') return;
    if (!changes.signedOut && !changes.userProfile) return;

    if (!state.ready) {
      pendingAuthRefresh = true;
      return;
    }
    if (state.saving) return;

    await syncAuthStateFromWorker();
  });
}

initThemeSync();
initEditor();
