import { sanitizeScreenshotFilename } from '../lib/capture.js';
import {
  FONT_SIZES,
  renderAnnotation,
  STROKE_SIZES,
  transformSourceToCanvas,
} from '../lib/editor-core.js';

const MAX_UNDO_STEPS = 20;

const els = {
  filenameInput: document.getElementById('filename-input'),
  folderBadge: document.getElementById('folder-badge'),
  downloadBtn: document.getElementById('download-btn'),
  copyLinkBtn: document.getElementById('copy-link-btn'),
  openDriveLink: document.getElementById('open-drive-link'),
  saveDriveBtn: document.getElementById('save-drive-btn'),
  styleGroup: document.getElementById('style-group'),
  colorSwatches: document.getElementById('color-swatches'),
  sizePills: document.getElementById('size-pills'),
  undoBtn: document.getElementById('undo-btn'),
  resetBtn: document.getElementById('reset-btn'),
  modeNote: document.getElementById('mode-note'),
  statusPill: document.getElementById('status-pill'),
  dimLabel: document.getElementById('dim-label'),
  stageMessage: document.getElementById('stage-message'),
  stageSpinner: document.getElementById('stage-spinner'),
  stageMessageText: document.getElementById('stage-message-text'),
  canvasWrap: document.getElementById('canvas-wrap'),
  baseCanvas: document.getElementById('base-canvas'),
  previewCanvas: document.getElementById('preview-canvas'),
  textOverlayInput: document.getElementById('text-overlay-input'),
  confirmReplaceDialog: document.getElementById('confirm-replace-dialog'),
  replaceTargetName: document.getElementById('replace-target-name'),
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

function safeHttpsUrl(url) {
  if (typeof url !== 'string' || !url) return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.href : '';
  } catch {
    return '';
  }
}

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error('No response from background service worker.'));
        return;
      }
      resolve(response);
    });
  });
}

function stripPngSuffix(filename) {
  return String(filename || 'Screenshot.png').replace(/\.png$/i, '');
}

function getDesiredFilename() {
  return sanitizeScreenshotFilename(els.filenameInput.value, state.savedFilename);
}

function hasUnsavedChanges() {
  if (!state.ready) return false;
  return state.imageModifiedSinceSave || getDesiredFilename() !== state.savedFilename;
}

function showStatusPill(kind, text, autoHideMs = 0) {
  if (!text) {
    els.statusPill.hidden = true;
    return;
  }
  els.statusPill.hidden = false;
  els.statusPill.className = `status-pill ${kind}`;
  els.statusPill.textContent = text;
  if (autoHideMs > 0) {
    setTimeout(() => {
      if (els.statusPill.textContent === text) {
        els.statusPill.hidden = true;
      }
    }, autoHideMs);
  }
}

function updateDimensionsLabel() {
  if (!state.ready) {
    els.dimLabel.textContent = '';
    return;
  }
  els.dimLabel.textContent = `${els.baseCanvas.width} x ${els.baseCanvas.height} px`;
}

function updateModeBannerAndButtons() {
  els.folderBadge.textContent = `Folder: ${state.folderName}`;
  els.saveDriveBtn.textContent =
    state.mode === 'existing' ? 'Replace in Drive' : 'Upload to Drive';
  els.saveDriveBtn.disabled = !state.ready || state.saving;

  const safeLink = safeHttpsUrl(state.webViewLink);
  if (safeLink) {
    els.copyLinkBtn.hidden = false;
    els.openDriveLink.hidden = false;
    els.openDriveLink.href = safeLink;
  } else {
    els.copyLinkBtn.hidden = true;
    els.openDriveLink.hidden = true;
  }

  if (state.mode === 'existing') {
    if (state.tool === 'redact') {
      els.modeNote.textContent =
        'Editing an uploaded Drive file. Tip: turn on "Open editor before uploading" in Settings to redact before initial upload.';
    } else {
      els.modeNote.textContent =
        'Editing an uploaded Drive file. Saving replaces the existing file and keeps the same Drive link.';
    }
  } else {
    els.modeNote.textContent =
      'Not uploaded yet. Edit or redact freely, then click "Upload to Drive".';
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
  updateModeBannerAndButtons();
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
    updateModeBannerAndButtons();
  });
}

function cancelActiveText() {
  els.textOverlayInput.hidden = true;
  els.textOverlayInput.value = '';
  state.activeTextAnchor = null;
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

  els.textOverlayInput.style.left = `${clampedCssX}px`;
  els.textOverlayInput.style.top = `${clampedCssY}px`;
  els.textOverlayInput.style.color = state.color;
  els.textOverlayInput.style.fontSize = `${cssFontSize}px`;
  els.textOverlayInput.value = '';
  els.textOverlayInput.hidden = false;
  requestAnimationFrame(() => els.textOverlayInput.focus());
}

async function setTool(nextTool) {
  await commitActiveTextIfNeeded();
  state.tool = nextTool;

  for (const btn of document.querySelectorAll('[data-tool]')) {
    btn.classList.toggle('active', btn.dataset.tool === nextTool);
  }

  els.styleGroup.classList.toggle('dimmed', nextTool === 'redact');
  els.previewCanvas.classList.toggle('text-cursor', nextTool === 'text');
  updateModeBannerAndButtons();
}

function setColor(nextColor) {
  state.color = nextColor;
  for (const btn of els.colorSwatches.querySelectorAll('[data-color]')) {
    btn.classList.toggle('active', btn.dataset.color === nextColor);
  }
  if (!els.textOverlayInput.hidden && state.activeTextAnchor) {
    state.activeTextAnchor.color = nextColor;
    els.textOverlayInput.style.color = nextColor;
  }
}

function setSizeKey(nextSize) {
  state.sizeKey = nextSize;
  for (const btn of els.sizePills.querySelectorAll('[data-size]')) {
    btn.classList.toggle('active', btn.dataset.size === nextSize);
  }
  if (!els.textOverlayInput.hidden && state.activeTextAnchor) {
    state.activeTextAnchor.fontSize = getEffectiveFontSize();
    els.textOverlayInput.style.fontSize = `${FONT_SIZES[nextSize] || FONT_SIZES.md}px`;
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
    const sourceBitmap = await createImageBitmap(els.baseCanvas);
    state.undoStack.push({
      bitmap: sourceBitmap,
      isAtOriginalCapture: state.isAtOriginalCapture,
      imageModifiedSinceSave: state.imageModifiedSinceSave,
    });
    while (state.undoStack.length > MAX_UNDO_STEPS) {
      const evicted = state.undoStack.shift();
      evicted?.bitmap?.close?.();
    }

    transformSourceToCanvas(sourceBitmap, kind, els.baseCanvas);
    syncPreviewCanvasSize();
    state.isAtOriginalCapture = false;
    state.imageModifiedSinceSave = true;
    updateModeBannerAndButtons();
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
    updateModeBannerAndButtons();
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
    state.imageModifiedSinceSave = !state.driveMatchesInitial;
    updateModeBannerAndButtons();
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
    updateModeBannerAndButtons();
  });
}

els.previewCanvas.addEventListener('pointerup', finishPointerDrag);
els.previewCanvas.addEventListener('pointercancel', () => {
  state.activeDrag = null;
  previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
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

els.filenameInput.addEventListener('blur', () => {
  const clean = getDesiredFilename();
  els.filenameInput.value = stripPngSuffix(clean);
});

els.filenameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    els.filenameInput.blur();
  }
});

for (const btn of document.querySelectorAll('[data-tool]')) {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
}

for (const swatch of els.colorSwatches.querySelectorAll('[data-color]')) {
  swatch.addEventListener('click', () => setColor(swatch.dataset.color));
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
    els.copyLinkBtn.textContent = 'Link copied!';
    setTimeout(() => {
      els.copyLinkBtn.textContent = 'Copy link';
    }, 1800);
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

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read encoded PNG.'));
    reader.readAsDataURL(blob);
  });
}

async function performSave(saveMode) {
  if (!state.ready || state.saving) return;
  await commitActiveTextIfNeeded();

  const desiredFilename = getDesiredFilename();
  els.filenameInput.value = stripPngSuffix(desiredFilename);

  const needImagePayload =
    state.mode === 'new' || saveMode === 'new' || state.imageModifiedSinceSave;

  state.saving = true;
  updateModeBannerAndButtons();
  showStatusPill(
    'warn',
    saveMode === 'replace' && state.mode === 'existing'
      ? 'Replacing file in Google Drive...'
      : 'Uploading to Google Drive...'
  );

  try {
    const dataUrl = needImagePayload ? await exportCanvasDataUrl() : '';
    const res = await sendMessage({
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
    els.filenameInput.value = stripPngSuffix(state.savedFilename);

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
      copied ? `${actionWord} - link copied!` : `${actionWord}!`,
      5000
    );
  } catch (err) {
    showStatusPill(
      'err',
      err.message || 'Could not save to Google Drive. Use "Download PNG" to save locally.'
    );
  } finally {
    state.saving = false;
    updateModeBannerAndButtons();
  }
}

els.saveDriveBtn.addEventListener('click', async () => {
  if (!state.ready || state.saving) return;
  await commitActiveTextIfNeeded();

  if (state.mode === 'existing') {
    if (!hasUnsavedChanges()) {
      showStatusPill('ok', 'No changes to save yet.', 2600);
      return;
    }
    els.replaceTargetName.textContent = state.savedFilename;
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
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

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
  if (state.imageModifiedSinceSave) {
    event.preventDefault();
    event.returnValue = '';
  }
});

window.addEventListener('unload', () => {
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
    els.modeNote.textContent = 'Session missing';
    return;
  }

  state.sessionId = sessionId;

  try {
    const res = await sendMessage({
      type: 'GET_EDITOR_SESSION',
      sessionId,
    });
    if (!res.ok || !res.dataUrl) {
      throw new Error(res.error || 'Could not load screenshot session.');
    }

    const blob = await (await fetch(res.dataUrl)).blob();
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
    state.captureMode = res.session.captureMode === 'region' ? 'region' : 'visible';
    state.pageUrl = res.session.pageUrl || '';
    state.pageTitle = res.session.pageTitle || '';
    state.incognito = Boolean(res.session.incognito);
    state.autoCopyLink = Boolean(res.session.autoCopyLink);

    els.filenameInput.value = stripPngSuffix(state.savedFilename);

    els.baseCanvas.width = bitmap.width;
    els.baseCanvas.height = bitmap.height;
    baseCtx.drawImage(bitmap, 0, 0);
    syncPreviewCanvasSize();

    els.stageMessage.hidden = true;
    els.canvasWrap.hidden = false;
    state.ready = true;
    updateModeBannerAndButtons();
  } catch (err) {
    els.stageSpinner.hidden = true;
    els.stageMessageText.textContent =
      err.message || 'Could not load screenshot for editing.';
    els.modeNote.textContent = 'Could not load screenshot';
  }
}

initEditor();
