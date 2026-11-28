import {
  blobToDataUrl,
  dataUrlToBlob,
  putBlobInTransferCache,
  sanitizePdfFilename,
  sanitizeScreenshotFilename,
  takeBlobFromTransferCache,
} from '../lib/capture.js';
import {
  addCaptionBarToCanvas,
  applyPixelateRect,
  computeAnnotationBounds,
  computePastedImageBox,
  cropSourceToCanvas,
  FONT_SIZES,
  HIGHLIGHTER_SIZES,
  normalizeRect,
  parseHexColorInput,
  PIXELATE_BLOCK_SIZES,
  renderAnnotation,
  sanitizeHexColor,
  STROKE_SIZES,
  transformSourceToCanvas,
} from '../lib/editor-core.js';
import { formatVersionTooltip, getEnvironmentSummary } from '../lib/feedback.js';
import { exportCanvasToPdfBlob, PDF_LIMITS } from '../lib/pdf.js';
import {
  didAuthProfileVisiblyChange,
  initThemeSync,
  safeHttpsUrl,
  sendRuntimeMessage,
} from '../lib/ui.js';

const MAX_UNDO_STEPS = 20;
const MIN_UNDO_STEPS = 3;
const MAX_UNDO_BYTES = 256 * 1024 * 1024;
const ZOOM_STEPS = Object.freeze([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3]);
const MAX_PASTE_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_PASTE_IMAGE_DIM = 8192;
const MAX_PASTE_IMAGE_PIXELS = 16_000_000;
const ALLOWED_PASTE_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const els = {
  filenameReadonly: document.getElementById('filename-readonly'),
  filenameDisplay: document.getElementById('filename-display'),
  renamePencilBtn: document.getElementById('rename-pencil-btn'),
  filenameEditing: document.getElementById('filename-editing'),
  filenameInput: document.getElementById('filename-input'),
  dimLabel: document.getElementById('dim-label'),
  zoomControl: document.getElementById('zoom-control'),
  zoomOutBtn: document.getElementById('zoom-out-btn'),
  zoomResetBtn: document.getElementById('zoom-reset-btn'),
  zoomInBtn: document.getElementById('zoom-in-btn'),
  statusToastWrap: document.getElementById('status-toast-wrap'),
  statusPill: document.getElementById('status-pill'),
  statusToastClose: document.getElementById('status-toast-close'),
  unsavedPill: document.getElementById('unsaved-pill'),
  editorHelpBtn: document.getElementById('editor-help-btn'),
  copyImageBtn: document.getElementById('copy-image-btn'),
  copyLinkBtn: document.getElementById('copy-link-btn'),
  downloadDropdown: document.getElementById('download-dropdown'),
  downloadBtn: document.getElementById('download-btn'),
  downloadMenu: document.getElementById('download-menu'),
  downloadPngBtn: document.getElementById('download-png-btn'),
  downloadPdfBtn: document.getElementById('download-pdf-btn'),
  downloadPdfMeta: document.getElementById('download-pdf-meta'),
  openDriveLink: document.getElementById('open-drive-link'),
  saveDriveBtn: document.getElementById('save-drive-btn'),
  editorDock: document.getElementById('editor-dock'),
  styleGroup: document.getElementById('style-group'),
  colorSwatches: document.getElementById('color-swatches'),
  customColorBtn: document.getElementById('custom-color-btn'),
  hexPopover: document.getElementById('hex-popover'),
  hexColorNative: document.getElementById('hex-color-native'),
  hexInputWrap: document.getElementById('hex-input-wrap'),
  hexTextInput: document.getElementById('hex-text-input'),
  applyHexBtn: document.getElementById('apply-hex-btn'),
  sizePills: document.getElementById('size-pills'),
  sizeXlBtn: document.getElementById('size-xl-btn'),
  contextBar: document.getElementById('context-bar'),
  redactContext: document.getElementById('redact-context'),
  redactModeSegmented: document.getElementById('redact-mode-segmented'),
  textContext: document.getElementById('text-context'),
  textStyleSegmented: document.getElementById('text-style-segmented'),
  captionToggleBtn: document.getElementById('caption-toggle-btn'),
  captionForm: document.getElementById('caption-form'),
  captionTextInput: document.getElementById('caption-text-input'),
  captionThemeSegmented: document.getElementById('caption-theme-segmented'),
  applyCaptionBtn: document.getElementById('apply-caption-btn'),
  cancelCaptionBtn: document.getElementById('cancel-caption-btn'),
  cropContext: document.getElementById('crop-context'),
  cropDimLabel: document.getElementById('crop-dim-label'),
  applyCropBtn: document.getElementById('apply-crop-btn'),
  cancelCropBtn: document.getElementById('cancel-crop-btn'),
  pasteContext: document.getElementById('paste-context'),
  applyPasteBtn: document.getElementById('apply-paste-btn'),
  cancelPasteBtn: document.getElementById('cancel-paste-btn'),
  undoBtn: document.getElementById('undo-btn'),
  resetBtn: document.getElementById('reset-btn'),
  stage: document.getElementById('stage'),
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

let pixelateScratchCanvas = null;
let pixelateScratchCtx = null;
let lastPreviewDirtyRect = null; // null | 'full' | { x, y, width, height }

function releasePixelateScratch() {
  if (pixelateScratchCanvas) {
    pixelateScratchCanvas.width = 0;
    pixelateScratchCanvas.height = 0;
    pixelateScratchCanvas = null;
    pixelateScratchCtx = null;
  }
}

function renderPixelateViaScratch(targetCtx, rect, blockSize) {
  if (!rect || rect.width < 2 || rect.height < 2) return false;
  if (!pixelateScratchCanvas) {
    pixelateScratchCanvas = document.createElement('canvas');
    pixelateScratchCtx = pixelateScratchCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!pixelateScratchCtx) return false;
  if (
    pixelateScratchCanvas.width !== rect.width ||
    pixelateScratchCanvas.height !== rect.height
  ) {
    pixelateScratchCanvas.width = rect.width;
    pixelateScratchCanvas.height = rect.height;
  }
  pixelateScratchCtx.clearRect(0, 0, rect.width, rect.height);
  pixelateScratchCtx.drawImage(
    els.baseCanvas,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    rect.width,
    rect.height
  );
  const ok = applyPixelateRect(
    pixelateScratchCtx,
    { x: 0, y: 0, width: rect.width, height: rect.height },
    { blockSize }
  );
  if (!ok) return false;
  targetCtx.save();
  targetCtx.globalAlpha = 1;
  targetCtx.globalCompositeOperation = 'source-over';
  targetCtx.drawImage(pixelateScratchCanvas, rect.x, rect.y);
  targetCtx.restore();
  return true;
}

function clearPreviewCanvas() {
  if (!lastPreviewDirtyRect) return;
  if (lastPreviewDirtyRect === 'full') {
    previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
  } else {
    previewCtx.clearRect(
      lastPreviewDirtyRect.x,
      lastPreviewDirtyRect.y,
      lastPreviewDirtyRect.width,
      lastPreviewDirtyRect.height
    );
  }
  lastPreviewDirtyRect = null;
}

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
  autoCopyMode: 'image', // 'image' | 'link' | 'off'
  autoImageCopied: false,
  captureNotice: '',
  tool: null, // null = safe browse/scroll/pan mode until a tool is picked
  previousTool: null,
  zoom: 'fit', // 'fit' | number (0.25 .. 3)
  redactMode: 'solid', // 'solid' | 'pixelate'
  textStyle: 'clean', // 'clean' | 'meme'
  captionTheme: 'light', // 'light' | 'dark'
  color: '#ef4444',
  userPickedColor: false,
  highlighterAutoColored: false,
  memeAutoColored: false,
  preMemeColor: null,
  sizeKey: 'md',
  ready: false,
  saving: false,
  exporting: false,
  uploadState: 'idle', // 'idle' | 'uploading' | 'uploaded' | 'failed'
  uploadError: '',
  uploadErrorCode: '',
  uploadRequiresReauth: false,
  autoCopyAttempted: false,
  isAtOriginalCapture: true,
  driveMatchesInitial: false,
  imageModifiedSinceSave: false,
  initialBlob: null,
  undoStack: [],
  undoBytes: 0,
  activeDrag: null,
  activePan: null,
  activeTextAnchor: null,
  pendingCrop: null,
  pastedOverlay: null,
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
    Boolean(state.pastedOverlay) ||
    getDesiredFilename() !== state.savedFilename
  );
}

let statusPillTimer = null;
let initialAutoCopyPromise = null;
let activePdfExportAbort = null;

function hideStatusPill() {
  if (statusPillTimer) {
    clearTimeout(statusPillTimer);
    statusPillTimer = null;
  }
  els.statusPill.hidden = true;
  els.statusPill.title = '';
  els.statusToastClose.hidden = true;
}

function clearStatusPillIfIdle() {
  if (
    state.saving ||
    state.exporting ||
    state.uploadState === 'uploading' ||
    state.uploadState === 'failed'
  ) {
    return;
  }
  hideStatusPill();
}

function restorePersistentUploadPill() {
  if (!state.ready || state.saving || state.exporting) return;
  if (state.signedIn && state.uploadState === 'uploading') {
    const uploadingText = state.autoImageCopied
      ? 'Uploading to Google Drive... \u00b7 Image copied'
      : 'Uploading to Google Drive...';
    showStatusPill('warn', uploadingText);
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
    hideStatusPill();
    updateUiState();
    return;
  }
  els.unsavedPill.hidden = true;
  els.statusPill.hidden = false;
  els.statusPill.className = `status-pill ${kind}`;
  els.statusPill.textContent = text;
  els.statusPill.title = text;
  const showDismiss =
    kind === 'err' ||
    (kind === 'warn' &&
      (autoHideMs >= 4500 ||
        (autoHideMs === 0 &&
          !state.saving &&
          !state.exporting &&
          state.uploadState !== 'uploading')));
  els.statusToastClose.hidden = !showDismiss;
  if (autoHideMs > 0) {
    statusPillTimer = setTimeout(() => {
      statusPillTimer = null;
      if (els.statusPill.textContent === text) {
        hideStatusPill();
        restorePersistentUploadPill();
        updateUiState();
      }
    }, autoHideMs);
  }
}

els.statusToastClose.addEventListener('click', () => {
  hideStatusPill();
  updateUiState();
});

function updateDimensionsLabel() {
  if (!state.ready) {
    els.dimLabel.textContent = '';
    els.dimLabel.hidden = true;
    els.zoomControl.hidden = true;
    return;
  }
  els.dimLabel.hidden = false;
  els.dimLabel.textContent = `${els.baseCanvas.width} \u00d7 ${els.baseCanvas.height}`;
  els.zoomControl.hidden = false;
  updateZoomUi();
}

const MAX_ZOOM_CSS_DIM = 16384;

function getMaxZoomScale() {
  const maxDim = Math.max(els.baseCanvas.width || 0, els.baseCanvas.height || 0);
  const upperStep = ZOOM_STEPS[ZOOM_STEPS.length - 1];
  if (!maxDim) return upperStep;
  const rawCap = MAX_ZOOM_CSS_DIM / maxDim;
  let best = ZOOM_STEPS[0];
  for (const s of ZOOM_STEPS) {
    if (s <= rawCap + 0.001) best = s;
  }
  return best;
}

function getEffectiveZoomScale() {
  if (typeof state.zoom === 'number' && Number.isFinite(state.zoom) && state.zoom > 0) {
    return state.zoom;
  }
  const rect = els.baseCanvas.getBoundingClientRect();
  if (rect.width > 0 && els.baseCanvas.width > 0) {
    return rect.width / els.baseCanvas.width;
  }
  return 1;
}

function computeTextOverlayCssFontSize(canvasFontSize) {
  const rect = els.baseCanvas.getBoundingClientRect();
  if (!rect.width || !els.baseCanvas.width) {
    return FONT_SIZES[state.sizeKey] || FONT_SIZES.md;
  }
  return Math.max(10, Math.round(canvasFontSize * (rect.width / els.baseCanvas.width)));
}

function isStagePannable() {
  if (!els.stage) return false;
  return (
    els.stage.scrollWidth > els.stage.clientWidth + 2 ||
    els.stage.scrollHeight > els.stage.clientHeight + 2
  );
}

function updateZoomUi() {
  if (!els.zoomControl) return;
  const eff = getEffectiveZoomScale();
  const minZoom = ZOOM_STEPS[0];
  const maxZoom = getMaxZoomScale();
  const isFit = state.zoom === 'fit';
  const actualPct = Math.round(Math.min(1, maxZoom) * 100);
  const label = isFit ? 'Fit' : `${Math.round(state.zoom * 100)}%`;
  els.zoomResetBtn.textContent = label;
  els.zoomResetBtn.title = isFit
    ? `Click for ${actualPct}% actual size (1)`
    : 'Click to fit screen (0)';
  els.zoomResetBtn.setAttribute(
    'aria-label',
    isFit
      ? `Zoom: Fit. Click for ${actualPct}%`
      : `Zoom: ${label}. Click to fit`
  );
  els.zoomOutBtn.disabled = !state.ready || eff <= minZoom + 0.01;
  els.zoomInBtn.disabled = !state.ready || eff >= maxZoom - 0.01;
}

function repositionActiveTextOverlay() {
  if (els.textOverlayInput.hidden || !state.activeTextAnchor) return;
  const rect = els.baseCanvas.getBoundingClientRect();
  if (!rect.width || !els.baseCanvas.width) return;
  const cssFontSize = computeTextOverlayCssFontSize(state.activeTextAnchor.fontSize);
  const minTextHeight = Math.max(34, Math.ceil(cssFontSize * 1.4));
  const rawX = (state.activeTextAnchor.x / els.baseCanvas.width) * rect.width;
  const rawY = (state.activeTextAnchor.y / els.baseCanvas.height) * rect.height;
  const clampedX = Math.max(4, Math.min(Math.max(4, rect.width - 120), rawX));
  const clampedY = Math.max(4, Math.min(Math.max(4, rect.height - minTextHeight), rawY));
  els.textOverlayInput.style.setProperty('--tx', `${clampedX}px`);
  els.textOverlayInput.style.setProperty('--ty', `${clampedY}px`);
  els.textOverlayInput.style.setProperty('--tsize', `${cssFontSize}px`);
}

function updatePreviewCursor() {
  const showPaste = Boolean(state.pastedOverlay);
  if (showPaste) {
    els.previewCanvas.classList.remove('text-cursor', 'idle-cursor', 'pan-cursor', 'panning-cursor');
    return;
  }
  els.previewCanvas.classList.remove('move-cursor', 'nwse-cursor');
  const isIdle = !state.tool;
  const isPanning = isIdle && Boolean(state.activePan);
  const canPan = isIdle && !isPanning && isStagePannable();
  els.previewCanvas.classList.toggle('text-cursor', state.tool === 'text');
  els.previewCanvas.classList.toggle('panning-cursor', isPanning);
  els.previewCanvas.classList.toggle('pan-cursor', canPan);
  els.previewCanvas.classList.toggle('idle-cursor', isIdle && !isPanning && !canPan);
}

function applyZoom(
  nextZoom,
  { preserveCenter = true, anchorClientX = null, anchorClientY = null } = {}
) {
  const minZoom = ZOOM_STEPS[0];
  const maxZoom = getMaxZoomScale();
  const normalized =
    nextZoom === 'fit'
      ? 'fit'
      : Math.max(minZoom, Math.min(maxZoom, Number(nextZoom) || 1));

  state.activePan = null;

  let anchorRelX = 0.5;
  let anchorRelY = 0.5;
  let viewportOffsetX = 0;
  let viewportOffsetY = 0;
  const canPreserve = preserveCenter && state.ready && els.stage && !els.canvasWrap.hidden;

  if (canPreserve) {
    const stageRect = els.stage.getBoundingClientRect();
    const canvasRect = els.baseCanvas.getBoundingClientRect();
    const cx = anchorClientX ?? stageRect.left + stageRect.width / 2;
    const cy = anchorClientY ?? stageRect.top + stageRect.height / 2;
    viewportOffsetX = cx - stageRect.left;
    viewportOffsetY = cy - stageRect.top;
    if (canvasRect.width > 0 && canvasRect.height > 0) {
      anchorRelX = Math.max(0, Math.min(1, (cx - canvasRect.left) / canvasRect.width));
      anchorRelY = Math.max(0, Math.min(1, (cy - canvasRect.top) / canvasRect.height));
    }
  }

  state.zoom = normalized;

  if (normalized === 'fit') {
    els.canvasWrap.classList.remove('zoomed-canvas');
    els.baseCanvas.style.removeProperty('--zoom-w');
    els.baseCanvas.style.removeProperty('--zoom-h');
  } else {
    const w = Math.max(1, Math.round(els.baseCanvas.width * normalized));
    const h = Math.max(1, Math.round(els.baseCanvas.height * normalized));
    els.baseCanvas.style.setProperty('--zoom-w', `${w}px`);
    els.baseCanvas.style.setProperty('--zoom-h', `${h}px`);
    els.canvasWrap.classList.add('zoomed-canvas');
  }

  if (canPreserve) {
    const stageRect = els.stage.getBoundingClientRect();
    const nextCanvasRect = els.baseCanvas.getBoundingClientRect();
    const canvasLeftInContent = nextCanvasRect.left - stageRect.left + els.stage.scrollLeft;
    const canvasTopInContent = nextCanvasRect.top - stageRect.top + els.stage.scrollTop;
    const targetScrollLeft = canvasLeftInContent + anchorRelX * nextCanvasRect.width - viewportOffsetX;
    const targetScrollTop = canvasTopInContent + anchorRelY * nextCanvasRect.height - viewportOffsetY;
    els.stage.scrollLeft = Math.max(0, Math.round(targetScrollLeft));
    els.stage.scrollTop = Math.max(0, Math.round(targetScrollTop));
  }

  repositionActiveTextOverlay();
  if (state.pendingCrop || state.pastedOverlay) {
    renderActiveDragPreview();
  }
  updateZoomUi();
  updatePreviewCursor();
}

function stepZoom(direction, anchorOpts = {}) {
  if (!state.ready) return;
  const current = getEffectiveZoomScale();
  const maxZoom = getMaxZoomScale();
  const eps = 0.02;
  if (direction > 0) {
    const next = ZOOM_STEPS.find((s) => s > current + eps && s <= maxZoom + 0.001) ?? maxZoom;
    applyZoom(next, anchorOpts);
  } else {
    let next = ZOOM_STEPS[0];
    for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
      if (ZOOM_STEPS[i] < current - eps && ZOOM_STEPS[i] <= maxZoom + 0.001) {
        next = ZOOM_STEPS[i];
        break;
      }
    }
    applyZoom(next, anchorOpts);
  }
}

function toggleFitAndActualZoom() {
  if (!state.ready) return;
  applyZoom(state.zoom === 'fit' ? Math.min(1, getMaxZoomScale()) : 'fit');
}

function updateStyleControlsState() {
  const showPaste = Boolean(state.pastedOverlay);
  const dimAll =
    !state.tool ||
    showPaste ||
    state.tool === 'crop' ||
    (state.tool === 'redact' && state.redactMode === 'solid');
  const dimColorsOnly =
    !dimAll && state.tool === 'redact' && state.redactMode === 'pixelate';

  els.styleGroup.classList.toggle('dimmed', dimAll);
  els.styleGroup.inert = dimAll;
  els.colorSwatches.classList.toggle('dimmed', dimColorsOnly);
  els.colorSwatches.inert = dimColorsOnly;
}

function updateUiState() {
  const dirty = hasUnsavedChanges();
  const busy = state.saving || state.exporting;
  const isUploadingInitial = state.signedIn && state.uploadState === 'uploading';
  const isFailedInitial =
    state.signedIn && state.mode === 'new' && state.uploadState === 'failed';
  const showUnsaved =
    state.ready &&
    !busy &&
    state.signedIn &&
    dirty &&
    !isUploadingInitial &&
    !isFailedInitial;

  if (showUnsaved && !els.statusPill.hidden && els.statusPill.classList.contains('ok')) {
    hideStatusPill();
  }
  els.unsavedPill.hidden = !showUnsaved || !els.statusPill.hidden;

  if (!state.signedIn) {
    els.saveDriveBtn.textContent = 'Save to Google Drive';
    els.saveDriveBtn.disabled = !state.ready || busy;
    els.saveDriveBtn.title = !state.ready
      ? 'Loading screenshot...'
      : 'Connect Google Drive and save screenshot';
  } else if (isFailedInitial) {
    els.saveDriveBtn.textContent = 'Retry';
    els.saveDriveBtn.disabled = !state.ready || busy;
    els.saveDriveBtn.title = !state.ready
      ? 'Loading screenshot...'
      : 'Retry uploading screenshot to Google Drive';
  } else if (isUploadingInitial) {
    els.saveDriveBtn.textContent = 'Save';
    els.saveDriveBtn.disabled = !state.ready || busy || !dirty;
    els.saveDriveBtn.title = !state.ready
      ? 'Loading screenshot...'
      : dirty
      ? 'Save changes to Google Drive'
      : 'Uploading screenshot to Google Drive...';
  } else {
    const canSave = state.ready && !busy && (state.mode === 'new' || dirty);
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

  els.downloadBtn.disabled = !state.ready || busy;
  els.downloadPngBtn.disabled = !state.ready || busy;
  els.downloadPdfBtn.disabled = !state.ready || busy;
  els.copyImageBtn.disabled = !state.ready || busy;
  els.renamePencilBtn.disabled = !state.ready || busy;
  els.editorDock.inert = busy;
  els.contextBar.inert = busy;

  const safeLink = state.signedIn ? safeHttpsUrl(state.webViewLink) : '';
  if (safeLink) {
    els.copyLinkBtn.hidden = false;
    els.openDriveLink.hidden = false;
    els.openDriveLink.href = safeLink;
  } else {
    els.copyLinkBtn.hidden = true;
    els.openDriveLink.hidden = true;
  }

  const hasUndoableAction =
    state.undoStack.length > 0 ||
    !els.textOverlayInput.hidden ||
    Boolean(state.pastedOverlay) ||
    Boolean(state.pendingCrop);
  els.undoBtn.disabled = !state.ready || busy || !hasUndoableAction;
  els.resetBtn.disabled = !state.ready || busy || state.isAtOriginalCapture;
  updateContextBar();
  updateZoomUi();
}

function updateContextBar() {
  const showPaste = Boolean(state.pastedOverlay);
  const showCrop = !showPaste && state.tool === 'crop';
  const showRedact = !showPaste && state.tool === 'redact';
  const showText = !showPaste && state.tool === 'text';

  els.pasteContext.hidden = !showPaste;
  els.cropContext.hidden = !showCrop;
  els.redactContext.hidden = !showRedact;
  els.textContext.hidden = !showText;
  els.contextBar.hidden = !(showPaste || showCrop || showRedact || showText);
  els.sizeXlBtn.hidden = showPaste || state.tool !== 'text';
  updateStyleControlsState();

  if (showCrop) {
    if (state.pendingCrop && state.pendingCrop.width >= 4 && state.pendingCrop.height >= 4) {
      els.cropDimLabel.textContent = `Crop ${state.pendingCrop.width} \u00d7 ${state.pendingCrop.height}`;
      els.applyCropBtn.disabled = !state.ready || state.saving || state.exporting;
    } else {
      els.cropDimLabel.textContent = 'Drag on image to select crop area';
      els.applyCropBtn.disabled = true;
    }
  }

  updatePreviewCursor();
}

function syncPreviewCanvasSize() {
  els.previewCanvas.width = els.baseCanvas.width;
  els.previewCanvas.height = els.baseCanvas.height;
  lastPreviewDirtyRect = null;
  const isTall =
    els.baseCanvas.width > 0 && els.baseCanvas.height > els.baseCanvas.width * 1.5;
  els.canvasWrap.classList.toggle('tall-canvas', isTall);
  if (typeof state.zoom === 'number') {
    applyZoom(state.zoom, { preserveCenter: false });
    updateDimensionsLabel();
  } else {
    updateDimensionsLabel();
    updatePreviewCursor();
  }
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

function getEffectivePixelateBlockSize() {
  const base = PIXELATE_BLOCK_SIZES[state.sizeKey] || PIXELATE_BLOCK_SIZES.md;
  return Math.max(6, Math.min(48, Math.round(base * getDisplayScale())));
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

function popUnusedUndoSnapshot() {
  const popped = state.undoStack.pop();
  if (!popped) return;
  state.undoBytes = Math.max(0, state.undoBytes - (popped.bytes || 0));
  popped.bitmap?.close?.();
}

async function pushUndoSnapshot(dirtyRect = null) {
  const cw = els.baseCanvas.width;
  const ch = els.baseCanvas.height;
  let usePatch = false;
  let rx = 0;
  let ry = 0;
  let rw = cw;
  let rh = ch;

  if (dirtyRect && cw > 0 && ch > 0) {
    rx = Math.max(0, Math.floor(dirtyRect.x));
    ry = Math.max(0, Math.floor(dirtyRect.y));
    const rx2 = Math.min(cw, Math.ceil(dirtyRect.x + dirtyRect.width));
    const ry2 = Math.min(ch, Math.ceil(dirtyRect.y + dirtyRect.height));
    rw = Math.max(0, rx2 - rx);
    rh = Math.max(0, ry2 - ry);
    if (rw > 0 && rh > 0 && rw * rh < cw * ch * 0.65) {
      usePatch = true;
    }
  }

  const snapshot = usePatch
    ? await createImageBitmap(els.baseCanvas, rx, ry, rw, rh)
    : await createImageBitmap(els.baseCanvas);
  const bytes = Math.max(0, snapshot.width * snapshot.height * 4);
  state.undoStack.push({
    kind: usePatch ? 'patch' : 'full',
    x: usePatch ? rx : 0,
    y: usePatch ? ry : 0,
    width: snapshot.width,
    height: snapshot.height,
    bitmap: snapshot,
    bytes,
    isAtOriginalCapture: state.isAtOriginalCapture,
    imageModifiedSinceSave: state.imageModifiedSinceSave,
  });
  state.undoBytes += bytes;
  while (
    state.undoStack.length > MAX_UNDO_STEPS ||
    (state.undoStack.length > MIN_UNDO_STEPS && state.undoBytes > MAX_UNDO_BYTES)
  ) {
    const evicted = state.undoStack.shift();
    state.undoBytes = Math.max(0, state.undoBytes - (evicted?.bytes || 0));
    evicted?.bitmap?.close?.();
  }
  updateUiState();
}

function clearUndoStack() {
  while (state.undoStack.length > 0) {
    const entry = state.undoStack.pop();
    entry?.bitmap?.close?.();
  }
  state.undoBytes = 0;
}

let mutationQueue = Promise.resolve();

function enqueueCanvasMutation(fn) {
  mutationQueue = mutationQueue.then(fn, fn);
  return mutationQueue;
}

function clearPendingCrop() {
  if (!state.pendingCrop) return;
  state.pendingCrop = null;
  cancelPreviewRender();
  clearPreviewCanvas();
  updateUiState();
}

function closeCaptionForm({ restoreFocus = false } = {}) {
  const wasOpen = !els.captionForm.hidden;
  els.captionForm.hidden = true;
  els.captionToggleBtn.hidden = false;
  els.captionToggleBtn.setAttribute('aria-expanded', 'false');
  els.captionTextInput.value = '';
  if (restoreFocus && wasOpen) {
    els.captionToggleBtn.focus();
  }
}

function cancelPastedOverlay() {
  if (!state.pastedOverlay) return;
  const ov = state.pastedOverlay;
  state.pastedOverlay = null;
  ov.bitmap?.close?.();
  cancelPreviewRender();
  clearPreviewCanvas();
  updateUiState();
}

function commitPastedOverlayIfNeeded() {
  if (!state.pastedOverlay) return mutationQueue;
  const ov = state.pastedOverlay;
  state.pastedOverlay = null;
  cancelPreviewRender();
  clearPreviewCanvas();
  updateUiState();

  return enqueueCanvasMutation(async () => {
    try {
      const dx = Math.round(ov.x);
      const dy = Math.round(ov.y);
      const dw = Math.max(1, Math.round(ov.width));
      const dh = Math.max(1, Math.round(ov.height));
      await pushUndoSnapshot({ x: dx - 2, y: dy - 2, width: dw + 4, height: dh + 4 });
      baseCtx.save();
      baseCtx.globalAlpha = 1;
      baseCtx.globalCompositeOperation = 'source-over';
      baseCtx.drawImage(ov.bitmap, dx, dy, dw, dh);
      baseCtx.restore();
      state.isAtOriginalCapture = false;
      state.imageModifiedSinceSave = true;
      clearStatusPillIfIdle();
      updateUiState();
    } finally {
      ov.bitmap?.close?.();
    }
  });
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
    const op = {
      tool: 'text',
      text,
      textStyle: anchor.textStyle || 'clean',
      x: anchor.x,
      y: anchor.y,
      color: anchor.color,
      fontSize: anchor.fontSize,
    };
    const bounds = computeAnnotationBounds(
      op,
      els.baseCanvas.width,
      els.baseCanvas.height,
      baseCtx
    );
    await pushUndoSnapshot(bounds);
    const drew = renderAnnotation(
      baseCtx,
      op,
      els.baseCanvas.width,
      els.baseCanvas.height
    );

    if (drew) {
      state.isAtOriginalCapture = false;
      state.imageModifiedSinceSave = true;
      clearStatusPillIfIdle();
    } else {
      popUnusedUndoSnapshot();
    }
    updateUiState();
  });
}

async function commitPendingEditsIfNeeded() {
  await commitActiveTextIfNeeded();
  await commitPastedOverlayIfNeeded();
  clearPendingCrop();
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
  const canvasFontSize = getEffectiveFontSize();
  const cssFontSize = computeTextOverlayCssFontSize(canvasFontSize);
  const minTextHeight = Math.max(34, Math.ceil(cssFontSize * 1.4));
  const clampedCssX = Math.max(4, Math.min(Math.max(4, rect.width - 120), coords.cssX));
  const clampedCssY = Math.max(
    4,
    Math.min(Math.max(4, rect.height - minTextHeight), coords.cssY)
  );

  state.activeTextAnchor = {
    x: (clampedCssX / Math.max(1, rect.width)) * els.baseCanvas.width,
    y: (clampedCssY / Math.max(1, rect.height)) * els.baseCanvas.height,
    color: state.color,
    fontSize: canvasFontSize,
    textStyle: state.textStyle,
  };

  els.textOverlayInput.classList.toggle('meme-style', state.textStyle === 'meme');
  els.textOverlayInput.style.setProperty('--tx', `${clampedCssX}px`);
  els.textOverlayInput.style.setProperty('--ty', `${clampedCssY}px`);
  els.textOverlayInput.style.setProperty('--tcolor', state.color);
  els.textOverlayInput.style.setProperty('--tsize', `${cssFontSize}px`);
  els.textOverlayInput.value = '';
  els.textOverlayInput.hidden = false;
  updateUiState();
  requestAnimationFrame(() => els.textOverlayInput.focus());
}

function closeHexPopover({ restoreFocus = false } = {}) {
  const wasOpen = !els.hexPopover.hidden;
  els.hexPopover.hidden = true;
  els.hexInputWrap.classList.remove('invalid');
  els.customColorBtn.setAttribute('aria-expanded', 'false');
  if (restoreFocus && wasOpen) {
    els.customColorBtn.focus();
  }
}

function setRedactMode(mode) {
  state.redactMode = mode === 'pixelate' ? 'pixelate' : 'solid';
  for (const btn of els.redactModeSegmented.querySelectorAll('[data-redact-mode]')) {
    const isActive = btn.dataset.redactMode === state.redactMode;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  }
  updateStyleControlsState();
}

function setTextStyle(styleMode) {
  const nextStyle = styleMode === 'meme' ? 'meme' : 'clean';
  state.textStyle = nextStyle;
  for (const btn of els.textStyleSegmented.querySelectorAll('[data-text-mode]')) {
    const isActive = btn.dataset.textMode === state.textStyle;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  }
  if (
    state.textStyle === 'meme' &&
    !state.userPickedColor &&
    !state.memeAutoColored &&
    state.color !== '#ffffff'
  ) {
    state.preMemeColor = state.color;
    state.memeAutoColored = true;
    setColor('#ffffff', { isCustom: false });
  } else if (
    state.textStyle === 'clean' &&
    state.memeAutoColored &&
    !state.userPickedColor &&
    state.preMemeColor
  ) {
    const restore = state.preMemeColor;
    state.memeAutoColored = false;
    state.preMemeColor = null;
    setColor(restore, { isCustom: false });
  }
  if (!els.textOverlayInput.hidden && state.activeTextAnchor) {
    state.activeTextAnchor.textStyle = state.textStyle;
    els.textOverlayInput.classList.toggle('meme-style', state.textStyle === 'meme');
    els.textOverlayInput.focus();
  }
}

function setCaptionTheme(theme) {
  state.captionTheme = theme === 'dark' ? 'dark' : 'light';
  for (const btn of els.captionThemeSegmented.querySelectorAll('[data-caption-theme]')) {
    const isActive = btn.dataset.captionTheme === state.captionTheme;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  }
  if (!els.captionForm.hidden) {
    els.captionTextInput.focus();
  }
}

function applyCaptionBar() {
  if (!state.ready || state.saving || state.exporting) return mutationQueue;
  const raw = els.captionTextInput.value.trim();
  if (!raw) {
    els.captionTextInput.focus();
    return mutationQueue;
  }
  const theme = state.captionTheme;
  closeCaptionForm();
  commitActiveTextIfNeeded();
  commitPastedOverlayIfNeeded();
  clearPendingCrop();

  return enqueueCanvasMutation(async () => {
    await pushUndoSnapshot();
    const sourceBitmap = state.undoStack[state.undoStack.length - 1].bitmap;
    try {
      addCaptionBarToCanvas(sourceBitmap, { text: raw, theme }, els.baseCanvas);
      syncPreviewCanvasSize();
      state.isAtOriginalCapture = false;
      state.imageModifiedSinceSave = true;
      clearStatusPillIfIdle();
      updateUiState();
    } catch (err) {
      popUnusedUndoSnapshot();
      showStatusPill('err', err?.message || 'Could not add caption bar.', 3500);
      updateUiState();
    }
  });
}

function applyPendingCrop() {
  if (!state.ready || state.saving || state.exporting || !state.pendingCrop) return mutationQueue;
  const cropRect = { ...state.pendingCrop };
  if (cropRect.width < 4 || cropRect.height < 4) return mutationQueue;
  clearPendingCrop();

  return enqueueCanvasMutation(async () => {
    await pushUndoSnapshot();
    const sourceBitmap = state.undoStack[state.undoStack.length - 1].bitmap;
    try {
      cropSourceToCanvas(sourceBitmap, cropRect, els.baseCanvas);
      syncPreviewCanvasSize();
      state.isAtOriginalCapture = false;
      state.imageModifiedSinceSave = true;
      clearStatusPillIfIdle();
      updateUiState();
    } catch (err) {
      popUnusedUndoSnapshot();
      showStatusPill('err', err?.message || 'Could not crop screenshot.', 3500);
      updateUiState();
    }
  });
}

function setTool(nextTool) {
  if (state.saving || state.exporting) return;
  const normalized = nextTool || null;
  if (state.activeDrag) {
    state.activeDrag = null;
    cancelPreviewRender();
    clearPreviewCanvas();
  }
  releasePixelateScratch();
  state.activePan = null;
  commitPendingEditsIfNeeded();
  closeCaptionForm();
  if (normalized === 'crop' && state.tool !== 'crop') {
    state.previousTool = state.tool;
  }
  state.tool = normalized;

  if (normalized !== 'text' && state.sizeKey === 'xl') {
    setSizeKey('lg');
  }

  for (const btn of document.querySelectorAll('[data-tool]')) {
    const isActive = Boolean(normalized) && btn.dataset.tool === normalized;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  }

  if (
    normalized === 'highlighter' &&
    !state.userPickedColor &&
    !state.highlighterAutoColored &&
    state.color === '#ef4444'
  ) {
    state.highlighterAutoColored = true;
    setColor('#f59e0b', { isCustom: false });
  }

  if (!normalized || normalized === 'redact' || normalized === 'crop') {
    closeHexPopover();
  }
  updateUiState();
}

function setColor(nextColor, { isCustom = false, refocusText = false } = {}) {
  const safeColor = sanitizeHexColor(nextColor, state.color);
  state.color = safeColor;

  let matchedPreset = false;
  for (const btn of els.colorSwatches.querySelectorAll('[data-color]')) {
    const isMatch = !isCustom && btn.dataset.color.toLowerCase() === safeColor;
    btn.classList.toggle('active', isMatch);
    btn.setAttribute('aria-pressed', String(isMatch));
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
    if (refocusText) {
      els.textOverlayInput.focus();
    }
  }
}

function setSizeKey(nextSize, { refocusText = false } = {}) {
  state.sizeKey = nextSize;
  for (const btn of els.sizePills.querySelectorAll('[data-size]')) {
    const isActive = btn.dataset.size === nextSize;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  }
  if (!els.textOverlayInput.hidden && state.activeTextAnchor) {
    state.activeTextAnchor.fontSize = getEffectiveFontSize();
    els.textOverlayInput.style.setProperty(
      '--tsize',
      `${computeTextOverlayCssFontSize(state.activeTextAnchor.fontSize)}px`
    );
    if (refocusText) {
      els.textOverlayInput.focus();
    }
  }
}

function applyTransform(kind) {
  if (!state.ready || state.saving || state.exporting) return mutationQueue;
  commitActiveTextIfNeeded();
  commitPastedOverlayIfNeeded();
  clearPendingCrop();
  if (state.activeDrag) {
    state.activeDrag = null;
  }
  cancelPreviewRender();
  clearPreviewCanvas();

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
  if (!state.ready || state.saving || state.exporting) return mutationQueue;
  if (!els.textOverlayInput.hidden) {
    cancelActiveText();
    return mutationQueue;
  }
  if (state.pastedOverlay) {
    cancelPastedOverlay();
    return mutationQueue;
  }
  if (state.pendingCrop) {
    clearPendingCrop();
    return mutationQueue;
  }
  return enqueueCanvasMutation(async () => {
    const prev = state.undoStack.pop();
    if (!prev) return;
    state.undoBytes = Math.max(0, state.undoBytes - (prev.bytes || 0));

    try {
      if (prev.kind === 'patch') {
        baseCtx.clearRect(prev.x, prev.y, prev.width, prev.height);
        baseCtx.drawImage(prev.bitmap, prev.x, prev.y);
      } else {
        els.baseCanvas.width = prev.bitmap.width;
        els.baseCanvas.height = prev.bitmap.height;
        baseCtx.clearRect(0, 0, els.baseCanvas.width, els.baseCanvas.height);
        baseCtx.drawImage(prev.bitmap, 0, 0);
        syncPreviewCanvasSize();
      }
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
  if (
    !state.ready ||
    state.saving ||
    state.exporting ||
    state.isAtOriginalCapture ||
    !state.initialBlob
  ) {
    return mutationQueue;
  }
  cancelActiveText();
  cancelPastedOverlay();
  clearPendingCrop();
  return enqueueCanvasMutation(async () => {
    const initialBitmap = await createImageBitmap(state.initialBlob);
    try {
      await pushUndoSnapshot();

      els.baseCanvas.width = initialBitmap.width;
      els.baseCanvas.height = initialBitmap.height;
      baseCtx.clearRect(0, 0, els.baseCanvas.width, els.baseCanvas.height);
      baseCtx.drawImage(initialBitmap, 0, 0);
      syncPreviewCanvasSize();

      state.isAtOriginalCapture = true;
      state.imageModifiedSinceSave = state.mode === 'existing' ? !state.driveMatchesInitial : false;
      clearStatusPillIfIdle();
      updateUiState();
    } finally {
      initialBitmap.close();
    }
  });
}

function buildDragOp(drag) {
  const op = {
    tool: drag.tool,
    color: drag.color,
    strokeWidth: drag.strokeWidth,
    x1: drag.startX,
    y1: drag.startY,
    x2: drag.currentX,
    y2: drag.currentY,
    points: drag.points,
  };
  if (drag.tool === 'redact') {
    op.redactMode = drag.redactMode || 'solid';
    op.blockSize = drag.blockSize || PIXELATE_BLOCK_SIZES.md;
  }
  return op;
}

let previewRafId = 0;

function cancelPreviewRender() {
  if (previewRafId) {
    cancelAnimationFrame(previewRafId);
    previewRafId = 0;
  }
}

function getPasteResizeHandleRadius() {
  return Math.max(8, Math.round(9 * getDisplayScale()));
}

function isOnPasteResizeHandle(ov, x, y) {
  const r = getPasteResizeHandleRadius() * 1.4;
  const hx = ov.x + ov.width;
  const hy = ov.y + ov.height;
  return Math.abs(x - hx) <= r && Math.abs(y - hy) <= r;
}

function isInsidePasteBox(ov, x, y) {
  return x >= ov.x && x <= ov.x + ov.width && y >= ov.y && y <= ov.y + ov.height;
}

function renderCropOverlay(rect) {
  const cw = els.previewCanvas.width;
  const ch = els.previewCanvas.height;
  const ds = getDisplayScale();
  previewCtx.save();
  previewCtx.fillStyle = 'rgba(15, 18, 24, 0.52)';
  previewCtx.fillRect(0, 0, cw, ch);
  if (rect.width >= 2 && rect.height >= 2) {
    previewCtx.clearRect(rect.x, rect.y, rect.width, rect.height);
    previewCtx.strokeStyle = '#ffffff';
    previewCtx.lineWidth = Math.max(1.5, Math.round(1.5 * ds));
    previewCtx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);

    // Subtle rule-of-thirds guides
    previewCtx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    previewCtx.lineWidth = Math.max(1, Math.round(ds));
    previewCtx.beginPath();
    previewCtx.moveTo(rect.x + rect.width / 3, rect.y);
    previewCtx.lineTo(rect.x + rect.width / 3, rect.y + rect.height);
    previewCtx.moveTo(rect.x + (rect.width * 2) / 3, rect.y);
    previewCtx.lineTo(rect.x + (rect.width * 2) / 3, rect.y + rect.height);
    previewCtx.moveTo(rect.x, rect.y + rect.height / 3);
    previewCtx.lineTo(rect.x + rect.width, rect.y + rect.height / 3);
    previewCtx.moveTo(rect.x, rect.y + (rect.height * 2) / 3);
    previewCtx.lineTo(rect.x + rect.width, rect.y + (rect.height * 2) / 3);
    previewCtx.stroke();
  }
  previewCtx.restore();
}

function renderPastedOverlayPreview(ov) {
  const ds = getDisplayScale();
  const handleR = getPasteResizeHandleRadius();
  previewCtx.save();
  previewCtx.drawImage(ov.bitmap, ov.x, ov.y, ov.width, ov.height);
  previewCtx.strokeStyle = '#1a73e8';
  previewCtx.lineWidth = Math.max(2, Math.round(2 * ds));
  previewCtx.setLineDash([Math.round(6 * ds), Math.round(4 * ds)]);
  previewCtx.strokeRect(ov.x, ov.y, ov.width, ov.height);
  previewCtx.setLineDash([]);

  // Bottom-right resize handle
  previewCtx.fillStyle = '#ffffff';
  previewCtx.strokeStyle = '#1a73e8';
  previewCtx.lineWidth = Math.max(2, Math.round(2 * ds));
  previewCtx.beginPath();
  previewCtx.arc(ov.x + ov.width, ov.y + ov.height, handleR, 0, Math.PI * 2);
  previewCtx.fill();
  previewCtx.stroke();
  previewCtx.restore();
}

function renderActiveDragPreview() {
  previewRafId = 0;
  clearPreviewCanvas();

  if (state.pastedOverlay) {
    const ov = state.pastedOverlay;
    renderPastedOverlayPreview(ov);
    const pad = Math.ceil(getPasteResizeHandleRadius() + 8 * getDisplayScale());
    lastPreviewDirtyRect = {
      x: Math.max(0, Math.floor(ov.x - pad)),
      y: Math.max(0, Math.floor(ov.y - pad)),
      width: Math.min(els.previewCanvas.width, Math.ceil(ov.width + pad * 2)),
      height: Math.min(els.previewCanvas.height, Math.ceil(ov.height + pad * 2)),
    };
    return;
  }

  if (state.activeDrag?.tool === 'crop') {
    const rect = normalizeRect(
      state.activeDrag.startX,
      state.activeDrag.startY,
      state.activeDrag.currentX,
      state.activeDrag.currentY,
      els.previewCanvas.width,
      els.previewCanvas.height,
      { snapOutward: true }
    );
    renderCropOverlay(rect);
    lastPreviewDirtyRect = 'full';
    if (rect.width >= 4 && rect.height >= 4) {
      els.cropDimLabel.textContent = `Crop ${rect.width} \u00d7 ${rect.height}`;
    }
    return;
  }

  if (state.pendingCrop) {
    renderCropOverlay(state.pendingCrop);
    lastPreviewDirtyRect = 'full';
    return;
  }

  if (!state.activeDrag) return;
  const op = buildDragOp(state.activeDrag, { forPreview: true });
  if (op.tool === 'redact' && op.redactMode === 'pixelate') {
    const rect = normalizeRect(
      op.x1,
      op.y1,
      op.x2,
      op.y2,
      els.previewCanvas.width,
      els.previewCanvas.height,
      { snapOutward: true }
    );
    if (rect.width >= 2 && rect.height >= 2) {
      renderPixelateViaScratch(previewCtx, rect, op.blockSize);
      const ds = getDisplayScale();
      const borderPad = Math.max(4, Math.ceil(3 * ds));
      previewCtx.save();
      previewCtx.strokeStyle = '#1a73e8';
      previewCtx.lineWidth = Math.max(1.5, Math.round(1.5 * ds));
      previewCtx.setLineDash([Math.max(4, Math.round(4 * ds)), Math.max(3, Math.round(3 * ds))]);
      previewCtx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
      previewCtx.restore();
      lastPreviewDirtyRect = {
        x: Math.max(0, rect.x - borderPad),
        y: Math.max(0, rect.y - borderPad),
        width: Math.min(els.previewCanvas.width, rect.width + borderPad * 2),
        height: Math.min(els.previewCanvas.height, rect.height + borderPad * 2),
      };
    }
    return;
  }

  const drew = renderAnnotation(
    previewCtx,
    op,
    els.previewCanvas.width,
    els.previewCanvas.height
  );
  if (drew) {
    lastPreviewDirtyRect =
      computeAnnotationBounds(op, els.previewCanvas.width, els.previewCanvas.height) || 'full';
  }
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
  if (!state.ready || state.saving || state.exporting || event.button !== 0) return;
  closeHexPopover();
  closeDownloadMenu();

  const coords = getCanvasCoordinates(event);

  // Interactive drag/resize for pasted reaction image overlay
  if (state.pastedOverlay) {
    event.preventDefault();
    const ov = state.pastedOverlay;
    if (isOnPasteResizeHandle(ov, coords.x, coords.y)) {
      ov.dragMode = 'resize';
      ov.pointerId = event.pointerId;
      try {
        els.previewCanvas.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointer events in tests
      }
      return;
    }
    if (isInsidePasteBox(ov, coords.x, coords.y)) {
      ov.dragMode = 'move';
      ov.pointerId = event.pointerId;
      ov.dragOffsetX = coords.x - ov.x;
      ov.dragOffsetY = coords.y - ov.y;
      try {
        els.previewCanvas.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointer events in tests
      }
      return;
    }
    // Clicking outside pasted image stamps it cleanly
    commitPastedOverlayIfNeeded();
    return;
  }

  commitActiveTextIfNeeded();

  // Safe browse/pan mode when no drawing tool is selected
  if (!state.tool) {
    if (isStagePannable()) {
      event.preventDefault();
      state.activePan = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startScrollLeft: els.stage.scrollLeft,
        startScrollTop: els.stage.scrollTop,
      };
      try {
        els.previewCanvas.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointer events in tests
      }
      updatePreviewCursor();
    }
    return;
  }

  event.preventDefault();

  if (state.tool === 'text') {
    openTextOverlayAt(coords);
    return;
  }

  if (state.tool === 'crop') {
    state.pendingCrop = null;
    updateUiState();
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
    redactMode: state.redactMode,
    blockSize: getEffectivePixelateBlockSize(),
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
  if (state.activePan && event.pointerId === state.activePan.pointerId) {
    event.preventDefault();
    els.stage.scrollLeft = Math.max(
      0,
      Math.round(state.activePan.startScrollLeft - (event.clientX - state.activePan.startX))
    );
    els.stage.scrollTop = Math.max(
      0,
      Math.round(state.activePan.startScrollTop - (event.clientY - state.activePan.startY))
    );
    return;
  }

  if (state.pastedOverlay) {
    const ov = state.pastedOverlay;
    const coords = getCanvasCoordinates(event);
    if (!ov.dragMode) {
      const onHandle = isOnPasteResizeHandle(ov, coords.x, coords.y);
      const inside = !onHandle && isInsidePasteBox(ov, coords.x, coords.y);
      els.previewCanvas.classList.toggle('nwse-cursor', onHandle);
      els.previewCanvas.classList.toggle('move-cursor', inside);
      return;
    }
    if (event.pointerId !== ov.pointerId) return;
    event.preventDefault();
    const cw = els.baseCanvas.width;
    const ch = els.baseCanvas.height;
    if (ov.dragMode === 'move') {
      ov.x = Math.max(-ov.width + 24, Math.min(cw - 24, Math.round(coords.x - ov.dragOffsetX)));
      ov.y = Math.max(-ov.height + 24, Math.min(ch - 24, Math.round(coords.y - ov.dragOffsetY)));
    } else if (ov.dragMode === 'resize') {
      const maxW = Math.max(24, cw - ov.x);
      const maxH = Math.max(24, ch - ov.y);
      const maxWByH = Math.max(24, maxH * ov.aspectRatio);
      const upperW = Math.min(maxW, maxWByH);
      const rawW = Math.max(24, coords.x - ov.x, (coords.y - ov.y) * ov.aspectRatio);
      const nextW = Math.max(24, Math.min(upperW, rawW));
      ov.width = Math.max(24, Math.round(nextW));
      ov.height = Math.max(24, Math.min(maxH, Math.round(ov.width / ov.aspectRatio)));
    }
    schedulePreviewRender();
    return;
  }

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
  if (state.activePan && event.pointerId === state.activePan.pointerId) {
    event.preventDefault();
    state.activePan = null;
    updatePreviewCursor();
    return;
  }

  if (state.pastedOverlay?.dragMode && event.pointerId === state.pastedOverlay.pointerId) {
    event.preventDefault();
    state.pastedOverlay.dragMode = null;
    state.pastedOverlay.pointerId = null;
    renderActiveDragPreview();
    return;
  }

  if (!state.activeDrag || event.pointerId !== state.activeDrag.pointerId) return;
  event.preventDefault();
  const coords = getCanvasCoordinates(event);
  state.activeDrag.currentX = coords.x;
  state.activeDrag.currentY = coords.y;

  if (state.activeDrag.tool === 'crop') {
    const rect = normalizeRect(
      state.activeDrag.startX,
      state.activeDrag.startY,
      state.activeDrag.currentX,
      state.activeDrag.currentY,
      els.baseCanvas.width,
      els.baseCanvas.height,
      { snapOutward: true }
    );
    state.activeDrag = null;
    cancelPreviewRender();
    if (rect.width >= 4 && rect.height >= 4) {
      state.pendingCrop = rect;
      renderActiveDragPreview();
    } else {
      state.pendingCrop = null;
      clearPreviewCanvas();
    }
    updateUiState();
    return;
  }

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
  clearPreviewCanvas();

  enqueueCanvasMutation(async () => {
    const op = buildDragOp(finishedDrag);
    const bounds = computeAnnotationBounds(
      op,
      els.baseCanvas.width,
      els.baseCanvas.height
    );
    await pushUndoSnapshot(bounds);
    let drew = false;
    if (op.tool === 'redact' && op.redactMode === 'pixelate') {
      const rect = normalizeRect(
        op.x1,
        op.y1,
        op.x2,
        op.y2,
        els.baseCanvas.width,
        els.baseCanvas.height,
        { snapOutward: true }
      );
      try {
        drew = renderPixelateViaScratch(baseCtx, rect, op.blockSize);
      } finally {
        releasePixelateScratch();
      }
    } else {
      drew = renderAnnotation(
        baseCtx,
        op,
        els.baseCanvas.width,
        els.baseCanvas.height
      );
    }

    if (drew) {
      state.isAtOriginalCapture = false;
      state.imageModifiedSinceSave = true;
      clearStatusPillIfIdle();
    } else {
      popUnusedUndoSnapshot();
    }
    updateUiState();
  });
}

els.previewCanvas.addEventListener('pointerup', finishPointerDrag);
els.previewCanvas.addEventListener('pointercancel', (event) => {
  if (state.activePan && event.pointerId === state.activePan.pointerId) {
    state.activePan = null;
    updatePreviewCursor();
    return;
  }
  if (state.pastedOverlay?.dragMode && event.pointerId === state.pastedOverlay.pointerId) {
    state.pastedOverlay.dragMode = null;
    state.pastedOverlay.pointerId = null;
    return;
  }
  if (state.activeDrag && event.pointerId !== state.activeDrag.pointerId) return;
  state.activeDrag = null;
  cancelPreviewRender();
  clearPreviewCanvas();
  releasePixelateScratch();
  if (state.pendingCrop) {
    renderActiveDragPreview();
  }
  updateUiState();
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
  if (!state.ready || state.saving || state.exporting) return;
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
  if (willShow) {
    closeDownloadMenu();
  }
  els.hexPopover.hidden = !willShow;
  els.customColorBtn.setAttribute('aria-expanded', String(willShow));
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
  setColor(parsed, { isCustom: true, refocusText: true });
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
    closeHexPopover({ restoreFocus: true });
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
  if (!els.downloadMenu.hidden && !els.downloadDropdown.contains(event.target)) {
    closeDownloadMenu();
  }
});

// Clicking outside the canvas and editing controls unselects the active tool
document.addEventListener('pointerdown', (event) => {
  if (!state.ready || state.saving || state.exporting || event.button !== 0 || els.confirmReplaceDialog.open) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  // Ignore clicks inside the stage's native scrollbar gutters so dragging scrollbars keeps tool/crop intact
  if (target === els.stage) {
    const stageRect = els.stage.getBoundingClientRect();
    const onVerticalScrollbar = event.clientX >= stageRect.left + els.stage.clientWidth;
    const onHorizontalScrollbar = event.clientY >= stageRect.top + els.stage.clientHeight;
    if (onVerticalScrollbar || onHorizontalScrollbar) {
      return;
    }
  }
  if (
    els.canvasWrap.contains(target) ||
    els.editorDock.contains(target) ||
    els.contextBar.contains(target) ||
    els.hexPopover.contains(target) ||
    els.downloadDropdown.contains(target) ||
    els.statusToastWrap.contains(target) ||
    els.zoomControl.contains(target) ||
    els.filenameReadonly.contains(target) ||
    els.filenameEditing.contains(target) ||
    target.closest('button, a, input, textarea, select, label, dialog')
  ) {
    return;
  }
  if (state.tool !== null || state.pastedOverlay || !els.textOverlayInput.hidden) {
    setTool(null);
  }
});

function refocusTextOverlayIfOpen() {
  if (!els.textOverlayInput.hidden) {
    els.textOverlayInput.focus();
  }
}

els.zoomOutBtn.addEventListener('click', () => {
  stepZoom(-1);
  refocusTextOverlayIfOpen();
});
els.zoomResetBtn.addEventListener('click', () => {
  toggleFitAndActualZoom();
  refocusTextOverlayIfOpen();
});
els.zoomInBtn.addEventListener('click', () => {
  stepZoom(1);
  refocusTextOverlayIfOpen();
});

let wheelDeltaAccum = 0;
let wheelAccumTimer = null;

els.stage.addEventListener(
  'wheel',
  (event) => {
    if (!state.ready || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    if (event.deltaY === 0) return;
    if (wheelAccumTimer) clearTimeout(wheelAccumTimer);
    wheelAccumTimer = setTimeout(() => {
      wheelDeltaAccum = 0;
      wheelAccumTimer = null;
    }, 180);
    wheelDeltaAccum += event.deltaY;
    if (Math.abs(wheelDeltaAccum) < 40) return;
    const dir = wheelDeltaAccum < 0 ? 1 : -1;
    wheelDeltaAccum = 0;
    stepZoom(dir, {
      anchorClientX: event.clientX,
      anchorClientY: event.clientY,
    });
  },
  { passive: false }
);

let resizeRafId = 0;

window.addEventListener('resize', () => {
  if (!state.ready || resizeRafId) return;
  resizeRafId = requestAnimationFrame(() => {
    resizeRafId = 0;
    if (!state.ready) return;
    repositionActiveTextOverlay();
    if (state.pendingCrop || state.pastedOverlay) {
      renderActiveDragPreview();
    }
    updateZoomUi();
    updatePreviewCursor();
  });
});

for (const btn of document.querySelectorAll('[data-tool]')) {
  btn.addEventListener('click', () => {
    const targetTool = btn.dataset.tool;
    setTool(state.tool === targetTool ? null : targetTool);
  });
}

for (const swatch of els.colorSwatches.querySelectorAll('[data-color]')) {
  swatch.addEventListener('click', () => {
    state.userPickedColor = true;
    closeHexPopover();
    setColor(swatch.dataset.color, { isCustom: false, refocusText: true });
  });
}

for (const pill of els.sizePills.querySelectorAll('[data-size]')) {
  pill.addEventListener('click', () => setSizeKey(pill.dataset.size, { refocusText: true }));
}

for (const btn of document.querySelectorAll('[data-transform]')) {
  btn.addEventListener('click', () => applyTransform(btn.dataset.transform));
}

for (const btn of els.redactModeSegmented.querySelectorAll('[data-redact-mode]')) {
  btn.addEventListener('click', () => setRedactMode(btn.dataset.redactMode));
}

for (const btn of els.textStyleSegmented.querySelectorAll('[data-text-mode]')) {
  btn.addEventListener('click', () => setTextStyle(btn.dataset.textMode));
}

for (const btn of els.captionThemeSegmented.querySelectorAll('[data-caption-theme]')) {
  btn.addEventListener('click', () => setCaptionTheme(btn.dataset.captionTheme));
}

els.captionToggleBtn.addEventListener('click', () => {
  els.captionToggleBtn.hidden = true;
  els.captionToggleBtn.setAttribute('aria-expanded', 'true');
  els.captionForm.hidden = false;
  els.captionTextInput.focus();
});

els.applyCaptionBtn.addEventListener('click', () => {
  applyCaptionBar();
});

els.cancelCaptionBtn.addEventListener('click', () => {
  closeCaptionForm({ restoreFocus: true });
});

els.captionTextInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    applyCaptionBar();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeCaptionForm({ restoreFocus: true });
  }
});

els.applyCropBtn.addEventListener('click', () => {
  applyPendingCrop();
});

els.cancelCropBtn.addEventListener('click', () => {
  if (state.pendingCrop) {
    clearPendingCrop();
  } else if (state.tool === 'crop') {
    setTool(state.previousTool || null);
  }
});

els.applyPasteBtn.addEventListener('click', () => {
  if (state.saving || state.exporting) return;
  commitPastedOverlayIfNeeded();
});

els.cancelPasteBtn.addEventListener('click', () => {
  if (state.saving || state.exporting) return;
  cancelPastedOverlay();
});

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

function flashCopyImageButton() {
  if (copyImageTimer) clearTimeout(copyImageTimer);
  els.copyImageBtn.textContent = 'Copied!';
  copyImageTimer = setTimeout(() => {
    copyImageTimer = null;
    els.copyImageBtn.textContent = 'Copy image';
  }, 1600);
}

async function exportCurrentPngBlob() {
  if (state.isAtOriginalCapture && state.initialBlob) {
    return state.initialBlob;
  }
  return canvasToPngBlob(els.baseCanvas);
}

async function copyCanvasImageToClipboard() {
  if (!state.ready || state.saving || state.exporting) return false;
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    showStatusPill('err', 'Clipboard image copy is not available in this browser.', 3000);
    return false;
  }
  try {
    const pngBlobPromise = (async () => {
      await commitPendingEditsIfNeeded();
      return exportCurrentPngBlob();
    })();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlobPromise })]);
    flashCopyImageButton();
    showStatusPill('ok', 'Copied image to clipboard', 2600);
    return true;
  } catch {
    showStatusPill('err', 'Could not copy image to clipboard.', 3000);
    return false;
  }
}

async function tryAutoCopyInitialImage(pngBlob) {
  if (
    state.autoCopyAttempted ||
    state.autoCopyMode !== 'image' ||
    !pngBlob ||
    typeof ClipboardItem === 'undefined' ||
    !navigator.clipboard?.write
  ) {
    return false;
  }
  state.autoCopyAttempted = true;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    state.autoImageCopied = true;
    flashCopyImageButton();
    return true;
  } catch {
    // Degrade silently if browser withheld focus/clipboard permission on background tab load
    return false;
  }
}

els.copyImageBtn.addEventListener('click', () => {
  copyCanvasImageToClipboard();
});

function getDownloadMenuItems() {
  return [els.downloadPngBtn, els.downloadPdfBtn];
}

function updateDownloadMenuMeta() {
  const w = Math.max(1, els.baseCanvas.width || 1);
  const h = Math.max(1, els.baseCanvas.height || 1);
  els.downloadPdfMeta.textContent =
    h / w > PDF_LIMITS.TALL_ASPECT_THRESHOLD ? 'Multi-page \u00b7 smart breaks' : 'Single page';
}

function openDownloadMenu({ focusIndex = -1 } = {}) {
  if (!state.ready || state.saving || state.exporting) return;
  closeHexPopover();
  updateDownloadMenuMeta();
  els.downloadMenu.hidden = false;
  els.downloadBtn.setAttribute('aria-expanded', 'true');
  const items = getDownloadMenuItems();
  if (focusIndex >= 0 && items[focusIndex]) {
    items[focusIndex].focus();
  }
}

function closeDownloadMenu({ restoreFocus = false } = {}) {
  const wasOpen = !els.downloadMenu.hidden;
  els.downloadMenu.hidden = true;
  els.downloadBtn.setAttribute('aria-expanded', 'false');
  if (restoreFocus && wasOpen) {
    els.downloadBtn.focus();
  }
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function downloadAsPng() {
  if (!state.ready || state.saving || state.exporting) return;
  closeDownloadMenu();
  state.exporting = true;
  updateUiState();
  try {
    await commitPendingEditsIfNeeded();
    const filename = getDesiredFilename();
    const blob = await exportCurrentPngBlob().catch(() => null);
    if (!blob) {
      showStatusPill('err', 'Could not export PNG screenshot.', 3500);
      return;
    }
    triggerBlobDownload(blob, filename);
    showStatusPill('ok', `Downloaded ${filename}`, 3000);
  } finally {
    state.exporting = false;
    updateUiState();
  }
}

async function downloadAsPdf() {
  if (!state.ready || state.saving || state.exporting) return;
  closeDownloadMenu();
  state.exporting = true;
  updateUiState();
  const abortController = new AbortController();
  activePdfExportAbort = abortController;
  try {
    await commitPendingEditsIfNeeded();
    const pdfFilename = sanitizePdfFilename(getDesiredFilename(), 'Screenshot.pdf');
    const { blob, pageCount } = await exportCanvasToPdfBlob(els.baseCanvas, {
      signal: abortController.signal,
      onProgress: (current, total) => {
        if (total > 1) {
          showStatusPill('warn', `Exporting PDF (${current}/${total})...`);
        }
      },
    });
    if (abortController.signal.aborted) return;
    triggerBlobDownload(blob, pdfFilename);
    const pageNote = pageCount > 1 ? ` (${pageCount} pages)` : '';
    showStatusPill('ok', `Downloaded ${pdfFilename}${pageNote}`, 3500);
  } catch (err) {
    if (err?.name !== 'AbortError') {
      showStatusPill('err', err?.message || 'Could not export PDF document.', 4500);
    }
  } finally {
    if (activePdfExportAbort === abortController) {
      activePdfExportAbort = null;
    }
    state.exporting = false;
    updateUiState();
  }
}

els.downloadBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  if (!state.ready || state.saving || state.exporting) return;
  if (els.downloadMenu.hidden) {
    openDownloadMenu();
  } else {
    closeDownloadMenu();
  }
});

els.downloadBtn.addEventListener('keydown', (event) => {
  if (!state.ready || state.saving || state.exporting) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    openDownloadMenu({ focusIndex: 0 });
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    openDownloadMenu({ focusIndex: getDownloadMenuItems().length - 1 });
  }
});

els.downloadMenu.addEventListener('click', (event) => {
  event.stopPropagation();
});

els.downloadMenu.addEventListener('keydown', (event) => {
  const items = getDownloadMenuItems();
  const idx = items.indexOf(document.activeElement);
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    items[(idx + 1 + items.length) % items.length]?.focus();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    items[(idx - 1 + items.length) % items.length]?.focus();
  } else if (event.key === 'Home') {
    event.preventDefault();
    items[0]?.focus();
  } else if (event.key === 'End') {
    event.preventDefault();
    items[items.length - 1]?.focus();
  } else if (event.key === 'Tab') {
    closeDownloadMenu({ restoreFocus: true });
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeDownloadMenu({ restoreFocus: true });
  }
});

els.downloadPngBtn.addEventListener('click', () => {
  downloadAsPng();
});

els.downloadPdfBtn.addEventListener('click', () => {
  downloadAsPdf();
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

async function exportEditedPayloadForWorker() {
  const blob = await exportCurrentPngBlob();
  if (!state.incognito) {
    const blobCacheUrl = await putBlobInTransferCache(blob);
    if (blobCacheUrl) {
      return { blobCacheUrl, dataUrl: '' };
    }
  }
  return { blobCacheUrl: '', dataUrl: await blobToDataUrl(blob) };
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
    const res = await sendRuntimeMessage({
      type: 'GET_STATE',
      includeTab: false,
      includeRecent: false,
    });
    if (!res?.ok || state.saving) return;

    if (res.settings) {
      const nextMode = res.settings.autoCopyMode;
      state.autoCopyMode =
        nextMode === 'link' || nextMode === 'off' || nextMode === 'image'
          ? nextMode
          : res.settings.autoCopyLink
          ? 'link'
          : 'image';
      state.folderName = res.settings.folderName || state.folderName;
    }

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
        if (!state.exporting && !els.statusPill.hidden && els.statusPill.classList.contains('warn')) {
          hideStatusPill();
        }
      }
    } else {
      state.signedIn = true;
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
        const stateRes = await sendRuntimeMessage({
          type: 'GET_STATE',
          includeTab: false,
          includeRecent: false,
        }).catch(() => null);
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
  }, 6000);
}

async function tryAutoCopyShareLink() {
  if (state.autoCopyAttempted) return false;
  const safeLink = safeHttpsUrl(state.webViewLink);
  if (state.autoCopyMode !== 'link' || !safeLink || !navigator.clipboard?.writeText) {
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
    if (!state.saving && !state.exporting) {
      const uploadingText = state.autoImageCopied
        ? 'Uploading to Google Drive... \u00b7 Image copied'
        : 'Uploading to Google Drive...';
      showStatusPill('warn', uploadingText);
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

    // If the user is already saving or exporting, let that active flow own the status toast
    if (state.saving || state.exporting) {
      updateUiState();
      return;
    }

    const copiedLink = await tryAutoCopyShareLink();
    if (initialAutoCopyPromise) {
      await initialAutoCopyPromise.catch(() => false);
    }

    if (state.saving || state.exporting) {
      updateUiState();
      return;
    }

    if (hasUnsavedChanges()) {
      if (!els.statusPill.classList.contains('err')) {
        hideStatusPill();
      }
      updateUiState();
      return;
    }

    const savedText = copiedLink
      ? 'Saved to Google Drive \u00b7 Link copied'
      : state.autoImageCopied
      ? 'Saved to Google Drive \u00b7 Image copied'
      : 'Saved to Google Drive';
    showStatusPill('ok', savedText, 5000);
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

    if (!state.saving && !state.exporting) {
      showStatusPill('err', state.uploadError);
      updateUiState();
    }
  }
}

async function performSave(saveMode) {
  if (!state.ready || state.saving || state.exporting) return;
  closeDownloadMenu();
  // Set saving lock synchronously before any await so rapid double-clicks / Ctrl+S cannot duplicate uploads
  state.saving = true;
  updateUiState();

  try {
    await commitPendingEditsIfNeeded();

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

    const payload = needImagePayload
      ? await exportEditedPayloadForWorker()
      : { blobCacheUrl: '', dataUrl: '' };
    const res = await sendRuntimeMessage({
      type: 'SAVE_EDITED_SCREENSHOT',
      sessionId: state.sessionId,
      filename: desiredFilename,
      dataUrl: payload.dataUrl,
      blobCacheUrl: payload.blobCacheUrl,
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
    const shouldCopyLink =
      (res.autoCopyMode ? res.autoCopyMode === 'link' : Boolean(res.autoCopyLink)) &&
      safeLink &&
      navigator.clipboard?.writeText;
    if (shouldCopyLink) {
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
  if (!state.ready || state.saving || state.exporting || saveClickPending) return;
  closeDownloadMenu();
  saveClickPending = true;
  try {
    await commitPendingEditsIfNeeded();

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

window.addEventListener('paste', async (event) => {
  if (!state.ready || state.saving || state.exporting || els.confirmReplaceDialog.open) return;
  const activeEl = document.activeElement;
  const tag = activeEl?.tagName;
  if ((tag === 'INPUT' || tag === 'TEXTAREA') && activeEl.offsetParent !== null) return;

  const items = event.clipboardData?.items;
  if (!items) return;

  let imageFile = null;
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const mime = String(item.type || '').toLowerCase();
    if (mime === 'image/svg+xml') {
      event.preventDefault();
      showStatusPill('err', 'SVG images cannot be pasted for security reasons.', 3200);
      return;
    }
    if (ALLOWED_PASTE_IMAGE_MIMES.has(mime)) {
      imageFile = item.getAsFile();
      break;
    }
  }
  if (!imageFile) return;

  event.preventDefault();
  if (imageFile.size > MAX_PASTE_IMAGE_BYTES) {
    showStatusPill('err', 'Pasted image exceeds the 15 MB limit.', 3200);
    return;
  }

  let bitmap = null;
  try {
    bitmap = await createImageBitmap(imageFile);
    if (
      bitmap.width > MAX_PASTE_IMAGE_DIM ||
      bitmap.height > MAX_PASTE_IMAGE_DIM ||
      bitmap.width * bitmap.height > MAX_PASTE_IMAGE_PIXELS
    ) {
      bitmap.close?.();
      bitmap = null;
      showStatusPill('err', 'Pasted image dimensions exceed the supported limit.', 3200);
      return;
    }

    await commitActiveTextIfNeeded();
    if (state.pastedOverlay) {
      await commitPastedOverlayIfNeeded();
    }
    clearPendingCrop();

    if (!state.ready || state.saving || state.exporting || els.confirmReplaceDialog.open) {
      bitmap.close?.();
      bitmap = null;
      return;
    }

    const box = computePastedImageBox(
      bitmap.width,
      bitmap.height,
      els.baseCanvas.width,
      els.baseCanvas.height
    );
    state.pastedOverlay = {
      bitmap,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      aspectRatio: Math.max(0.05, bitmap.width / Math.max(1, bitmap.height)),
      dragMode: null,
      dragOffsetX: 0,
      dragOffsetY: 0,
      pointerId: null,
    };
    bitmap = null;
    renderActiveDragPreview();
    updateUiState();
  } catch {
    bitmap?.close?.();
    showStatusPill('err', 'Could not decode pasted image.', 3000);
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Shift' && state.activeDrag?.tool === 'highlighter' && state.activeDrag.rawPoints) {
    state.activeDrag.points = computeHighlighterPoints(state.activeDrag, true);
    schedulePreviewRender();
  }

  if (!state.ready || state.saving || state.exporting || els.confirmReplaceDialog.open) return;

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

  if (event.key === 'Escape') {
    if (!els.downloadMenu.hidden) {
      event.preventDefault();
      closeDownloadMenu({ restoreFocus: true });
      return;
    }
    if (!els.hexPopover.hidden) {
      event.preventDefault();
      closeHexPopover({ restoreFocus: true });
      return;
    }
    if (!els.captionForm.hidden) {
      event.preventDefault();
      closeCaptionForm({ restoreFocus: true });
      return;
    }
    if (!els.textOverlayInput.hidden) {
      event.preventDefault();
      cancelActiveText();
      return;
    }
    if (state.pastedOverlay) {
      event.preventDefault();
      cancelPastedOverlay();
      return;
    }
    if (state.pendingCrop) {
      event.preventDefault();
      clearPendingCrop();
      return;
    }
    if (state.tool !== null) {
      event.preventDefault();
      setTool(null);
      return;
    }
  }

  if (!els.downloadMenu.hidden) {
    return;
  }

  if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (state.pastedOverlay) {
      event.preventDefault();
      commitPastedOverlayIfNeeded();
      return;
    }
    if (state.pendingCrop && state.pendingCrop.width >= 4 && state.pendingCrop.height >= 4) {
      event.preventDefault();
      applyPendingCrop();
      return;
    }
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

  // Zoom shortcuts (+, =, -, 0 work plain or with Ctrl/Cmd; 1 works plain so Ctrl+1 stays browser tab switch)
  if (!event.altKey && (event.key === '+' || event.key === '=')) {
    event.preventDefault();
    stepZoom(1);
    return;
  }
  if (!event.altKey && (event.key === '-' || event.key === '_')) {
    event.preventDefault();
    stepZoom(-1);
    return;
  }
  if (!event.altKey && event.key === '0') {
    event.preventDefault();
    applyZoom('fit');
    return;
  }

  if (event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.key === '1') {
    event.preventDefault();
    applyZoom(Math.min(1, getMaxZoomScale()));
    return;
  }

  const keyMap = {
    a: 'arrow',
    b: 'box',
    c: 'circle',
    l: 'line',
    h: 'highlighter',
    p: 'pencil',
    t: 'text',
    r: 'redact',
    k: 'crop',
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
  activePdfExportAbort?.abort();
  activePdfExportAbort = null;
  stopUploadStatusPoll();
  clearUndoStack();
  if (state.pastedOverlay) {
    state.pastedOverlay.bitmap?.close?.();
    state.pastedOverlay = null;
  }
  state.initialBlob = null;
  releasePixelateScratch();
  els.baseCanvas.width = 0;
  els.baseCanvas.height = 0;
  els.previewCanvas.width = 0;
  els.previewCanvas.height = 0;
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
      acceptBlobCache: typeof globalThis.caches?.open === 'function',
    });
    if (!res.ok || (!res.blobCacheUrl && !res.dataUrl)) {
      throw new Error(res.error || 'Could not load screenshot session.');
    }

    let blob = null;
    if (res.blobCacheUrl) {
      blob = await takeBlobFromTransferCache(res.blobCacheUrl);
    }
    if (!blob && res.dataUrl) {
      blob = await dataUrlToBlob(res.dataUrl);
    }
    if (!blob) {
      throw new Error('Screenshot data is no longer available.');
    }

    const bitmap = await createImageBitmap(blob);
    try {
      state.initialBlob = blob;
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
      state.autoCopyMode =
        res.session.autoCopyMode === 'link' ||
        res.session.autoCopyMode === 'off' ||
        res.session.autoCopyMode === 'image'
          ? res.session.autoCopyMode
          : res.session.autoCopyLink
          ? 'link'
          : 'image';
      state.captureNotice = res.session.captureNotice || '';
      state.uploadState = res.session.uploadState || 'idle';
      state.uploadError = res.session.uploadError || '';
      state.uploadErrorCode = res.session.uploadErrorCode || '';
      state.uploadRequiresReauth = Boolean(res.session.uploadRequiresReauth);

      syncFilenameDisplay(state.savedFilename);

      els.baseCanvas.width = bitmap.width;
      els.baseCanvas.height = bitmap.height;
      baseCtx.drawImage(bitmap, 0, 0);
      syncPreviewCanvasSize();
    } finally {
      bitmap.close();
    }

    // Paint and activate the editor immediately so Chromium's clipboard PNG encoder
    // never blocks first paint, dimensions/zoom layout, or drawing controls
    state.ready = true;
    els.stageMessage.hidden = true;
    els.canvasWrap.hidden = false;
    updateDimensionsLabel();
    updateUiState();

    const shouldAutoCopyImage =
      Boolean(res.session.isFreshCapture) && state.autoCopyMode === 'image';
    const autoCopyPromise = shouldAutoCopyImage
      ? tryAutoCopyInitialImage(blob).finally(() => {
          if (initialAutoCopyPromise === autoCopyPromise) {
            initialAutoCopyPromise = null;
          }
        })
      : Promise.resolve(false);
    initialAutoCopyPromise = shouldAutoCopyImage ? autoCopyPromise : null;

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
    } else if (state.captureNotice) {
      const notice = state.captureNotice;
      state.captureNotice = '';
      showStatusPill('warn', notice, 6500);
    }

    if (state.captureNotice && !els.statusPill.classList.contains('err')) {
      const notice = state.captureNotice;
      state.captureNotice = '';
      if (state.uploadState === 'uploading') {
        showStatusPill('warn', notice, 5500);
      } else if (state.uploadState === 'uploaded') {
        const suffix = state.autoImageCopied
          ? ' \u00b7 Saved to Drive \u00b7 Image copied'
          : ' \u00b7 Saved to Drive';
        showStatusPill('warn', `${notice}${suffix}`, 7000);
      }
    }

    if (shouldAutoCopyImage) {
      autoCopyPromise
        .then((copiedInitialImage) => {
          if (!copiedInitialImage || state.saving) return;
          if (state.signedIn && state.uploadState === 'uploading') {
            if (els.statusPill.textContent === 'Uploading to Google Drive...') {
              restorePersistentUploadPill();
            } else if (
              !els.statusPill.hidden &&
              !els.statusPill.textContent.includes('Image copied')
            ) {
              showStatusPill(
                'warn',
                `${els.statusPill.textContent} \u00b7 Image copied`,
                4500
              );
            }
          } else if (
            state.uploadState === 'uploaded' &&
            !hasUnsavedChanges() &&
            !els.statusPill.hidden &&
            !els.statusPill.textContent.includes('Image copied') &&
            !els.statusPill.classList.contains('err')
          ) {
            const pillKind = els.statusPill.classList.contains('warn') ? 'warn' : 'ok';
            showStatusPill(
              pillKind,
              `${els.statusPill.textContent} \u00b7 Image copied`,
              4500
            );
          } else if (!els.statusPill.hidden && !els.statusPill.textContent.includes('Image copied') && els.statusPill.classList.contains('warn')) {
            showStatusPill(
              'warn',
              `${els.statusPill.textContent} \u00b7 Image copied`,
              5500
            );
          } else if (els.statusPill.hidden && !hasUnsavedChanges()) {
            showStatusPill('ok', 'Copied image to clipboard', 3000);
          }
        })
        .catch(() => {});
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
      const sessionsMap = changes.editorSessionsById.newValue;
      const updatedSession =
        sessionsMap && Object.hasOwn(sessionsMap, state.sessionId)
          ? sessionsMap[state.sessionId]
          : null;
      if (
        updatedSession &&
        (updatedSession.uploadState === 'uploaded' || updatedSession.uploadState === 'failed')
      ) {
        await applyBackgroundUploadUpdate(updatedSession);
      }
      return;
    }

    if (areaName !== 'local') return;
    if (!didAuthProfileVisiblyChange(changes)) return;

    if (!state.ready) {
      pendingAuthRefresh = true;
      return;
    }
    if (state.saving) return;

    await syncAuthStateFromWorker();
  });
}

const editorVersionTooltip = formatVersionTooltip(getEnvironmentSummary());
const editorBrandEl = document.getElementById('editor-brand');
if (editorBrandEl) {
  editorBrandEl.title = editorVersionTooltip;
}
if (els.editorHelpBtn) {
  els.editorHelpBtn.title = `Help and shortcuts (${editorVersionTooltip})`;
}

initThemeSync();
initEditor();
