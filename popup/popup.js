import {
  applyDocumentTheme,
  formatShortcutDisplay,
  initThemeSync,
  normalizeTheme,
  safeHttpsUrl,
  sendRuntimeMessage,
} from '../lib/ui.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const els = {
  helpBtn: document.getElementById('help-btn'),
  headerActions: document.getElementById('header-actions'),
  openDriveBtn: document.getElementById('open-drive-btn'),
  settingsToggleBtn: document.getElementById('settings-toggle-btn'),
  signOutBtn: document.getElementById('sign-out-btn'),
  loadingView: document.getElementById('loading-view'),
  signedOutView: document.getElementById('signed-out-view'),
  setupBanner: document.getElementById('setup-banner'),
  signInBtn: document.getElementById('sign-in-btn'),
  authError: document.getElementById('auth-error'),
  mainView: document.getElementById('main-view'),
  userAvatar: document.getElementById('user-avatar'),
  userEmail: document.getElementById('user-email'),
  folderChip: document.getElementById('folder-chip'),
  folderChipName: document.getElementById('folder-chip-name'),
  settingsDrawer: document.getElementById('settings-drawer'),
  folderNameInput: document.getElementById('folder-name-input'),
  saveFolderBtn: document.getElementById('save-folder-btn'),
  themeSegmented: document.getElementById('theme-segmented'),
  autoCopyCheckbox: document.getElementById('auto-copy-checkbox'),
  editBeforeUploadCheckbox: document.getElementById('edit-before-upload-checkbox'),
  incognitoNotice: document.getElementById('incognito-notice'),
  restrictedWarning: document.getElementById('restricted-warning'),
  captureRegionBtn: document.getElementById('capture-region-btn'),
  captureVisibleBtn: document.getElementById('capture-visible-btn'),
  shortcutRegion: document.getElementById('popup-shortcut-region'),
  shortcutVisible: document.getElementById('popup-shortcut-visible'),
  statusBanner: document.getElementById('status-banner'),
  clearHistoryBtn: document.getElementById('clear-history-btn'),
  emptyHistory: document.getElementById('empty-history'),
  uploadList: document.getElementById('upload-list'),
  popupVersion: document.getElementById('popup-version'),
  footerBugBtn: document.getElementById('footer-bug-btn'),
};

let currentState = {
  activeTabId: undefined,
  incognito: false,
  lastErrorCode: '',
  settings: null,
  capturable: {
    ok: true,
    canCaptureVisible: true,
    canCaptureRegion: true,
    reason: null,
    regionDisabledReason: null,
  },
  busy: false,
};

function createActionSvg(kind) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', kind === 'check' ? '2.3' : '1.95');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const add = (tag, attrs) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v);
    }
    svg.appendChild(el);
  };

  if (kind === 'edit') {
    add('path', { d: 'M12 20h9' });
    add('path', { d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z' });
  } else if (kind === 'copy') {
    add('rect', { x: '9', y: '9', width: '13', height: '13', rx: '2' });
    add('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' });
  } else if (kind === 'open') {
    add('path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' });
    add('polyline', { points: '15 3 21 3 21 9' });
    add('line', { x1: '10', y1: '14', x2: '21', y2: '3' });
  } else if (kind === 'check') {
    add('polyline', { points: '20 6 9 17 4 12' });
  }
  return svg;
}

function openHelpPage({ kind = '', errorCode = '', jumpToFeedback = false } = {}) {
  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  if (errorCode) params.set('error', errorCode);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const hash = jumpToFeedback ? '#feedback' : '';
  chrome.tabs.create({ url: chrome.runtime.getURL(`pages/welcome.html${qs}${hash}`) });
}

async function getPopupWindowTabId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return typeof tab?.id === 'number' ? tab.id : undefined;
  } catch {
    return undefined;
  }
}

function formatRelativeTime(isoString) {
  if (!isoString) return '';
  const ts = Date.parse(isoString);
  if (Number.isNaN(ts)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 45) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function renderThemeButtons(theme) {
  const active = normalizeTheme(theme);
  applyDocumentTheme(active);
  for (const btn of els.themeSegmented.querySelectorAll('[data-theme-opt]')) {
    btn.classList.toggle('active', btn.dataset.themeOpt === active);
  }
}

function showStatus(type, content) {
  els.statusBanner.hidden = false;
  els.statusBanner.className = `status-banner ${type}`;
  els.statusBanner.replaceChildren();

  if (type === 'loading') {
    const spinner = document.createElement('div');
    spinner.className = 'ss-spinner';
    const text = document.createElement('span');
    text.textContent = content;
    els.statusBanner.append(spinner, text);
    return;
  }

  if (type === 'error') {
    const details = typeof content === 'string' ? { message: content } : content || {};
    if (details.code) currentState.lastErrorCode = details.code;

    const msg = document.createElement('div');
    msg.textContent = details.message || 'Could not upload screenshot.';
    els.statusBanner.append(msg);

    const actions = document.createElement('div');
    actions.className = 'status-actions';

    if (details.hasFallback) {
      const saveLocalBtn = document.createElement('button');
      saveLocalBtn.type = 'button';
      saveLocalBtn.className = 'ss-btn ss-btn-sm ss-btn-primary';
      saveLocalBtn.textContent = 'Save PNG locally';
      saveLocalBtn.addEventListener('click', async () => {
        saveLocalBtn.disabled = true;
        try {
          const fallback = await sendRuntimeMessage({ type: 'GET_FALLBACK_PNG' });
          if (fallback.ok && fallback.dataUrl) {
            const a = document.createElement('a');
            a.href = fallback.dataUrl;
            a.download = fallback.filename || details.fallbackFilename || 'Screenshot.png';
            a.click();
            saveLocalBtn.textContent = 'Saved!';
          } else {
            saveLocalBtn.textContent = 'Expired';
          }
        } catch {
          saveLocalBtn.textContent = 'Failed';
        }
      });
      actions.append(saveLocalBtn);
    }

    if (details.code === 'DRIVE_QUOTA_EXCEEDED') {
      const manageQuota = document.createElement('a');
      manageQuota.className = 'ss-btn ss-btn-sm ss-btn-secondary';
      manageQuota.href = 'https://drive.google.com/drive/quota';
      manageQuota.target = '_blank';
      manageQuota.rel = 'noopener noreferrer';
      manageQuota.textContent = 'Manage storage';
      actions.append(manageQuota);
    }

    if (details.requiresReauth) {
      const reconnectBtn = document.createElement('button');
      reconnectBtn.type = 'button';
      reconnectBtn.className = 'ss-btn ss-btn-sm ss-btn-secondary';
      reconnectBtn.textContent = 'Reconnect';
      reconnectBtn.addEventListener('click', async () => {
        reconnectBtn.disabled = true;
        try {
          const res = await sendRuntimeMessage({ type: 'SIGN_IN' });
          if (res.ok) {
            await loadState();
          } else if (res.error) {
            msg.textContent = res.error;
          }
        } finally {
          reconnectBtn.disabled = false;
        }
      });
      actions.append(reconnectBtn);
    }

    const reportBtn = document.createElement('button');
    reportBtn.type = 'button';
    reportBtn.className = 'ss-btn ss-btn-sm ss-btn-secondary';
    reportBtn.textContent = 'Report bug';
    reportBtn.addEventListener('click', () => {
      openHelpPage({
        kind: 'bug',
        errorCode: details.code || currentState.lastErrorCode,
        jumpToFeedback: true,
      });
    });
    actions.append(reportBtn);

    els.statusBanner.append(actions);
    return;
  }

  if (type === 'success' && typeof content === 'object') {
    const label = document.createElement('span');
    label.textContent = content.message;
    els.statusBanner.append(label);

    const safeLink = safeHttpsUrl(content.webViewLink);
    if (content.fileId || safeLink) {
      const inlineActions = document.createElement('div');
      inlineActions.className = 'status-inline-actions';

      if (content.fileId) {
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'status-link-action';
        editBtn.textContent = 'Edit';
        editBtn.title = 'Annotate, redact, rotate, or rename screenshot';
        editBtn.addEventListener('click', () => {
          openEditorForUpload({
            fileId: content.fileId,
            filename: content.filename || 'Screenshot.png',
            webViewLink: safeLink,
            folderName: content.folderName || currentState.settings?.folderName,
          });
        });
        inlineActions.append(editBtn);
      }

      if (safeLink) {
        const openLink = document.createElement('a');
        openLink.className = 'status-link-action';
        openLink.href = safeLink;
        openLink.target = '_blank';
        openLink.rel = 'noopener noreferrer';
        openLink.textContent = 'Open';
        inlineActions.append(openLink);
      }

      els.statusBanner.append(inlineActions);
    }
  }
}

async function openEditorForUpload({ fileId, filename, webViewLink, folderName }) {
  if (!fileId) return;
  try {
    const res = await sendRuntimeMessage({
      type: 'OPEN_EDITOR',
      fileId,
      filename,
      webViewLink,
      folderName,
    });
    if (res.ok) {
      window.close();
      return;
    }
    showStatus('error', {
      message: res.error || 'Could not open screenshot editor.',
      code: res.code,
      requiresReauth: res.requiresReauth,
    });
  } catch (err) {
    showStatus('error', err.message || 'Could not open screenshot editor.');
  }
}

function hideStatus() {
  els.statusBanner.hidden = true;
}

function setAvatarInitial(initial) {
  const span = document.createElement('span');
  span.className = 'avatar-initial';
  span.textContent = initial;
  els.userAvatar.replaceChildren(span);
}

function renderProfile(profile) {
  const name = profile?.name || 'Google Account';
  const email = profile?.email || '';
  els.userEmail.textContent = email || name;
  els.userEmail.title = email && name && name !== email ? `${name} (${email})` : email || name;

  const initial = (email || name || 'G').trim().charAt(0).toUpperCase();
  const safePic = safeHttpsUrl(profile?.picture);

  if (safePic) {
    const img = document.createElement('img');
    img.src = safePic;
    img.alt = name;
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => setAvatarInitial(initial));
    els.userAvatar.replaceChildren(img);
  } else {
    setAvatarInitial(initial);
  }
}

function renderSettings(settings) {
  currentState.settings = settings;
  const folderName = settings?.folderName || 'Chrome_SaveShot_ScreenShots';
  els.folderChipName.textContent = folderName;
  els.folderChip.href = safeHttpsUrl(
    settings?.folderWebViewLink,
    'https://drive.google.com/drive/my-drive'
  );
  els.folderNameInput.value = folderName;
  els.autoCopyCheckbox.checked = Boolean(settings?.autoCopyLink);
  els.editBeforeUploadCheckbox.checked = Boolean(settings?.editBeforeUpload);
  renderThemeButtons(settings?.theme);
}

function renderRecentUploads(uploads) {
  const list = Array.isArray(uploads) ? uploads : [];
  els.uploadList.replaceChildren();

  if (list.length === 0) {
    els.emptyHistory.hidden = false;
    els.uploadList.hidden = true;
    els.clearHistoryBtn.hidden = true;
    return;
  }

  els.emptyHistory.hidden = true;
  els.uploadList.hidden = false;
  els.clearHistoryBtn.hidden = false;

  for (const item of list) {
    const li = document.createElement('li');
    li.className = 'upload-item';

    if (
      typeof item.thumbnailDataUrl === 'string' &&
      item.thumbnailDataUrl.startsWith('data:image/')
    ) {
      const thumb = document.createElement('img');
      thumb.className = 'upload-thumb';
      thumb.src = item.thumbnailDataUrl;
      thumb.alt = item.name || 'Screenshot';
      li.append(thumb);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'upload-thumb-placeholder';
      placeholder.textContent = 'PNG';
      li.append(placeholder);
    }

    const meta = document.createElement('div');
    meta.className = 'upload-meta';

    const title = document.createElement('div');
    title.className = 'ss-body upload-name';
    title.textContent = item.pageTitle || item.name || 'Screenshot';
    title.title = item.name || '';

    const sub = document.createElement('div');
    sub.className = 'ss-meta tabular';
    const modeWord = item.mode === 'region' ? 'Area' : 'Tab';
    const relTime = formatRelativeTime(item.createdTime);
    sub.textContent = relTime ? `${modeWord} \u00b7 ${relTime}` : modeWord;

    meta.append(title, sub);

    const actions = document.createElement('div');
    actions.className = 'upload-actions';

    const safeLink = safeHttpsUrl(item.webViewLink);

    if (item.id) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'ss-icon-btn';
      editBtn.title = 'Edit screenshot';
      editBtn.setAttribute('aria-label', 'Edit screenshot');
      editBtn.append(createActionSvg('edit'));
      editBtn.addEventListener('click', () => {
        openEditorForUpload({
          fileId: item.id,
          filename: item.name || 'Screenshot.png',
          webViewLink: safeLink,
          folderName: currentState.settings?.folderName,
        });
      });
      actions.append(editBtn);
    }

    if (safeLink) {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'ss-icon-btn';
      copyBtn.title = 'Copy Drive link';
      copyBtn.setAttribute('aria-label', 'Copy Drive link');
      copyBtn.append(createActionSvg('copy'));
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(safeLink);
          copyBtn.classList.add('copied');
          copyBtn.replaceChildren(createActionSvg('check'));
          setTimeout(() => {
            copyBtn.classList.remove('copied');
            copyBtn.replaceChildren(createActionSvg('copy'));
          }, 1400);
        } catch {
          copyBtn.title = 'Could not copy link';
        }
      });

      const openLink = document.createElement('a');
      openLink.className = 'ss-icon-btn';
      openLink.href = safeLink;
      openLink.target = '_blank';
      openLink.rel = 'noopener noreferrer';
      openLink.title = 'Open in Google Drive';
      openLink.setAttribute('aria-label', 'Open in Google Drive');
      openLink.append(createActionSvg('open'));

      actions.append(copyBtn, openLink);
    }

    li.append(meta, actions);
    els.uploadList.append(li);
  }
}

function updateCaptureAvailability() {
  const cap = currentState.capturable || {};
  const canVisible = Boolean(cap.canCaptureVisible ?? cap.ok);
  const canRegion = Boolean(cap.canCaptureRegion ?? cap.ok);

  els.captureVisibleBtn.disabled = currentState.busy || !canVisible;
  els.captureRegionBtn.disabled = currentState.busy || !canRegion;

  els.incognitoNotice.hidden = !currentState.incognito;

  const warningMsg = !canVisible
    ? cap.reason
    : !canRegion
    ? cap.regionDisabledReason
    : null;

  if (warningMsg) {
    els.restrictedWarning.textContent = warningMsg;
    els.restrictedWarning.hidden = false;
  } else {
    els.restrictedWarning.hidden = true;
  }
}

function showView(viewName) {
  els.loadingView.hidden = viewName !== 'loading';
  els.signedOutView.hidden = viewName !== 'signed-out';
  els.mainView.hidden = viewName !== 'main';
  els.headerActions.hidden = viewName !== 'main';
  els.signOutBtn.hidden = viewName !== 'main';
}

function initStaticMetadata() {
  const version = chrome?.runtime?.getManifest?.()?.version || '1.1.1';
  els.popupVersion.textContent = `v${version}`;

  if (chrome?.commands?.getAll) {
    chrome.commands.getAll((commands) => {
      for (const cmd of commands || []) {
        if (cmd.name === 'capture-region') {
          els.shortcutRegion.textContent = cmd.shortcut
            ? formatShortcutDisplay(cmd.shortcut)
            : 'Shortcut not set';
        } else if (cmd.name === 'capture-visible') {
          els.shortcutVisible.textContent = cmd.shortcut
            ? formatShortcutDisplay(cmd.shortcut)
            : 'Shortcut not set';
        }
      }
    });
  }
}

async function loadState() {
  showView('loading');
  try {
    currentState.activeTabId = await getPopupWindowTabId();
    const res = await sendRuntimeMessage({
      type: 'GET_STATE',
      tabId: currentState.activeTabId,
    });
    if (!res.ok) throw new Error(res.error);

    currentState.capturable = res.capturable || {
      ok: true,
      canCaptureVisible: true,
      canCaptureRegion: true,
    };
    currentState.incognito = Boolean(res.incognito);
    currentState.lastErrorCode = res.lastErrorCode || '';

    if (res.settings) {
      renderThemeButtons(res.settings.theme);
    }

    if (!res.session?.signedIn) {
      renderRecentUploads([]);
      els.setupBanner.hidden = !res.session?.needsSetup;
      els.authError.hidden = true;
      showView('signed-out');
      return;
    }

    renderProfile(res.session.profile);
    renderSettings(res.settings);
    renderRecentUploads(res.recentUploads);
    updateCaptureAvailability();
    hideStatus();
    showView('main');
  } catch (err) {
    els.authError.textContent = err.message || 'Could not load SaveShot.';
    els.authError.className = 'ss-alert error';
    els.authError.hidden = false;
    showView('signed-out');
  }
}

els.helpBtn.addEventListener('click', () => openHelpPage());
els.footerBugBtn.addEventListener('click', () =>
  openHelpPage({
    kind: 'bug',
    errorCode: currentState.lastErrorCode,
    jumpToFeedback: true,
  })
);

els.signInBtn.addEventListener('click', async () => {
  els.signInBtn.disabled = true;
  els.authError.hidden = true;
  try {
    const res = await sendRuntimeMessage({ type: 'SIGN_IN' });
    if (!res.ok) {
      const err = new Error(res.error || 'Google sign-in failed.');
      err.code = res.code;
      throw err;
    }
    await loadState();
  } catch (err) {
    els.authError.textContent = err.message || 'Google sign-in failed.';
    els.authError.className =
      err.code === 'AUTH_CANCELLED' ? 'ss-alert warning' : 'ss-alert error';
    els.authError.hidden = false;
  } finally {
    els.signInBtn.disabled = false;
  }
});

els.signOutBtn.addEventListener('click', async () => {
  els.signOutBtn.disabled = true;
  try {
    await sendRuntimeMessage({ type: 'SIGN_OUT' });
    els.settingsDrawer.hidden = true;
    els.settingsToggleBtn.classList.remove('active');
    renderRecentUploads([]);
    els.setupBanner.hidden = true;
    els.authError.hidden = true;
    hideStatus();
    showView('signed-out');
  } finally {
    els.signOutBtn.disabled = false;
  }
});

els.settingsToggleBtn.addEventListener('click', () => {
  const willShow = els.settingsDrawer.hidden;
  els.settingsDrawer.hidden = !willShow;
  els.settingsToggleBtn.classList.toggle('active', willShow);
});

els.saveFolderBtn.addEventListener('click', async () => {
  const folderName = els.folderNameInput.value.trim() || 'Chrome_SaveShot_ScreenShots';
  els.saveFolderBtn.disabled = true;
  try {
    const res = await sendRuntimeMessage({
      type: 'UPDATE_SETTINGS',
      patch: { folderName },
    });
    if (res.ok) {
      renderSettings(res.settings);
      showStatus('success', {
        message: `Saving new screenshots to "${res.settings.folderName}"`,
      });
    }
  } finally {
    els.saveFolderBtn.disabled = false;
  }
});

for (const btn of els.themeSegmented.querySelectorAll('[data-theme-opt]')) {
  btn.addEventListener('click', async () => {
    const theme = normalizeTheme(btn.dataset.themeOpt);
    renderThemeButtons(theme);
    const res = await sendRuntimeMessage({
      type: 'UPDATE_SETTINGS',
      patch: { theme },
    });
    if (res.ok) renderSettings(res.settings);
  });
}

els.autoCopyCheckbox.addEventListener('change', async () => {
  const res = await sendRuntimeMessage({
    type: 'UPDATE_SETTINGS',
    patch: { autoCopyLink: els.autoCopyCheckbox.checked },
  });
  if (res.ok) renderSettings(res.settings);
});

els.editBeforeUploadCheckbox.addEventListener('change', async () => {
  const res = await sendRuntimeMessage({
    type: 'UPDATE_SETTINGS',
    patch: { editBeforeUpload: els.editBeforeUploadCheckbox.checked },
  });
  if (res.ok) renderSettings(res.settings);
});

els.captureVisibleBtn.addEventListener('click', async () => {
  if (currentState.busy) return;
  currentState.busy = true;
  updateCaptureAvailability();
  const folderName = currentState.settings?.folderName || 'Chrome_SaveShot_ScreenShots';
  const willOpenEditor = Boolean(currentState.settings?.editBeforeUpload);
  showStatus(
    'loading',
    willOpenEditor ? 'Opening screenshot editor...' : `Uploading to "${folderName}"...`
  );

  try {
    const res = await sendRuntimeMessage({
      type: 'CAPTURE_VISIBLE',
      tabId: currentState.activeTabId,
    });
    if (!res.ok) {
      showStatus('error', {
        message: res.error,
        code: res.code,
        requiresReauth: res.requiresReauth,
        hasFallback: res.hasFallback,
        fallbackFilename: res.fallbackFilename,
      });
      return;
    }

    if (res.openedEditor) {
      window.close();
      return;
    }

    renderSettings(res.settings);
    renderRecentUploads(res.recentUploads);

    let copied = false;
    const safeLink = safeHttpsUrl(res.upload?.webViewLink);
    if (res.settings?.autoCopyLink && safeLink) {
      try {
        await navigator.clipboard.writeText(safeLink);
        copied = true;
      } catch {
        // Ignore clipboard error when popup loses focus
      }
    }

    if (res.openedEditorAfterUpload) {
      window.close();
      return;
    }

    showStatus('success', {
      message: copied ? 'Saved \u00b7 Link copied' : 'Saved to Google Drive',
      fileId: res.upload.id,
      filename: res.upload.name,
      folderName: res.upload.folderName,
      webViewLink: safeLink,
    });
  } catch (err) {
    showStatus('error', err.message || 'Could not upload screenshot.');
  } finally {
    currentState.busy = false;
    updateCaptureAvailability();
  }
});

els.captureRegionBtn.addEventListener('click', async () => {
  if (currentState.busy) return;
  currentState.busy = true;
  updateCaptureAvailability();

  try {
    const res = await sendRuntimeMessage({
      type: 'START_REGION_CAPTURE',
      tabId: currentState.activeTabId,
    });
    if (!res.ok) {
      currentState.busy = false;
      updateCaptureAvailability();
      showStatus('error', {
        message: res.error || 'Could not start region selection.',
        code: res.code,
        requiresReauth: res.requiresReauth,
      });
      return;
    }
    window.close();
  } catch (err) {
    currentState.busy = false;
    updateCaptureAvailability();
    showStatus('error', err.message || 'Could not start region selection.');
  }
});

els.folderNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    els.saveFolderBtn.click();
  }
});

let openingFolder = false;

async function openDestinationDriveFolder() {
  if (openingFolder) return;
  const cached = safeHttpsUrl(currentState.settings?.folderWebViewLink);
  if (cached.includes('/drive/folders/')) {
    chrome.tabs.create({ url: cached });
    return;
  }
  openingFolder = true;
  try {
    const res = await sendRuntimeMessage({ type: 'OPEN_DRIVE_FOLDER' });
    const url = safeHttpsUrl(res.ok ? res.url : '', 'https://drive.google.com/drive/my-drive');
    if (currentState.settings && url.includes('/drive/folders/')) {
      currentState.settings.folderWebViewLink = url;
      els.folderChip.href = url;
    }
    chrome.tabs.create({ url });
  } catch {
    chrome.tabs.create({ url: 'https://drive.google.com/drive/my-drive' });
  } finally {
    openingFolder = false;
  }
}

els.openDriveBtn.addEventListener('click', () => {
  openDestinationDriveFolder();
});

els.folderChip.addEventListener('click', (event) => {
  const currentHref = els.folderChip.href || '';
  if (currentHref.includes('/drive/folders/')) return;
  event.preventDefault();
  openDestinationDriveFolder();
});

els.clearHistoryBtn.addEventListener('click', async () => {
  const res = await sendRuntimeMessage({ type: 'CLEAR_HISTORY' });
  if (res.ok) renderRecentUploads([]);
});

initThemeSync();
initStaticMetadata();
loadState();
