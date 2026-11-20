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
  userName: document.getElementById('user-name'),
  userEmail: document.getElementById('user-email'),
  folderChip: document.getElementById('folder-chip'),
  folderChipName: document.getElementById('folder-chip-name'),
  settingsDrawer: document.getElementById('settings-drawer'),
  folderNameInput: document.getElementById('folder-name-input'),
  saveFolderBtn: document.getElementById('save-folder-btn'),
  autoCopyCheckbox: document.getElementById('auto-copy-checkbox'),
  incognitoNotice: document.getElementById('incognito-notice'),
  restrictedWarning: document.getElementById('restricted-warning'),
  captureVisibleBtn: document.getElementById('capture-visible-btn'),
  captureRegionBtn: document.getElementById('capture-region-btn'),
  statusBanner: document.getElementById('status-banner'),
  clearHistoryBtn: document.getElementById('clear-history-btn'),
  emptyHistory: document.getElementById('empty-history'),
  uploadList: document.getElementById('upload-list'),
  footerHelpBtn: document.getElementById('footer-help-btn'),
  footerBugBtn: document.getElementById('footer-bug-btn'),
  footerFeatureBtn: document.getElementById('footer-feature-btn'),
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

function formatRelativeTime(isoString) {
  if (!isoString) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(isoString)) / 1000));
  if (diffSec < 45) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function showStatus(type, content) {
  els.statusBanner.hidden = false;
  els.statusBanner.className = `status-banner ${type}`;
  els.statusBanner.innerHTML = '';

  if (type === 'loading') {
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
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
      saveLocalBtn.className = 'small-btn primary';
      saveLocalBtn.textContent = 'Save PNG locally';
      saveLocalBtn.addEventListener('click', async () => {
        saveLocalBtn.disabled = true;
        try {
          const fallback = await sendMessage({ type: 'GET_FALLBACK_PNG' });
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
      manageQuota.className = 'small-btn';
      manageQuota.href = 'https://drive.google.com/drive/quota';
      manageQuota.target = '_blank';
      manageQuota.rel = 'noopener noreferrer';
      manageQuota.textContent = 'Manage Drive storage';
      actions.append(manageQuota);
    }

    if (details.requiresReauth) {
      const reconnectBtn = document.createElement('button');
      reconnectBtn.className = 'small-btn';
      reconnectBtn.textContent = 'Sign in again';
      reconnectBtn.addEventListener('click', async () => {
        reconnectBtn.disabled = true;
        try {
          const res = await sendMessage({ type: 'SIGN_IN' });
          if (res.ok) await loadState();
        } finally {
          reconnectBtn.disabled = false;
        }
      });
      actions.append(reconnectBtn);
    }

    const reportBtn = document.createElement('button');
    reportBtn.className = 'small-btn';
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

    if (content.webViewLink) {
      const openLink = document.createElement('a');
      openLink.className = 'small-btn';
      openLink.href = content.webViewLink;
      openLink.target = '_blank';
      openLink.rel = 'noopener noreferrer';
      openLink.textContent = 'Open';
      els.statusBanner.append(openLink);
    }
  }
}

function hideStatus() {
  els.statusBanner.hidden = true;
}

function renderProfile(profile) {
  const name = profile?.name || 'Google Account';
  const email = profile?.email || '';
  els.userName.textContent = name;
  els.userEmail.textContent = email;

  els.userAvatar.innerHTML = '';
  const initial = (name || email || 'G').trim().charAt(0).toUpperCase();

  if (profile?.picture) {
    const img = document.createElement('img');
    img.src = profile.picture;
    img.alt = name;
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      els.userAvatar.textContent = initial;
    });
    els.userAvatar.append(img);
  } else {
    els.userAvatar.textContent = initial;
  }
}

function renderSettings(settings) {
  currentState.settings = settings;
  const folderName = settings?.folderName || 'Chrome_SaveShot_ScreenShots';
  els.folderChipName.textContent = folderName;
  els.folderChip.href =
    settings?.folderWebViewLink || 'https://drive.google.com/drive/my-drive';
  els.folderNameInput.value = folderName;
  els.autoCopyCheckbox.checked = Boolean(settings?.autoCopyLink);
}

function renderRecentUploads(uploads) {
  const list = Array.isArray(uploads) ? uploads : [];
  els.uploadList.innerHTML = '';

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

    if (item.thumbnailDataUrl) {
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
    title.className = 'upload-name';
    title.textContent = item.pageTitle || item.name || 'Screenshot';
    title.title = item.name || '';

    const sub = document.createElement('div');
    sub.className = 'upload-sub';

    const modeBadge = document.createElement('span');
    modeBadge.className = 'mode-pill';
    modeBadge.textContent = item.mode === 'region' ? 'Region' : 'Tab';

    const timeSpan = document.createElement('span');
    timeSpan.textContent = formatRelativeTime(item.createdTime);

    sub.append(modeBadge, timeSpan);
    meta.append(title, sub);

    const actions = document.createElement('div');
    actions.className = 'upload-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'small-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.title = 'Copy Google Drive link';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(item.webViewLink);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
        }, 1600);
      } catch {
        copyBtn.textContent = 'Error';
      }
    });

    const openLink = document.createElement('a');
    openLink.className = 'small-btn';
    openLink.href = item.webViewLink;
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';
    openLink.textContent = 'Open';
    openLink.title = 'Open screenshot in Google Drive';

    actions.append(copyBtn, openLink);
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
}

async function loadState() {
  showView('loading');
  try {
    currentState.activeTabId = await getPopupWindowTabId();
    const res = await sendMessage({
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

    if (!res.session?.signedIn) {
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
    els.authError.className = 'alert error';
    els.authError.hidden = false;
    showView('signed-out');
  }
}

els.helpBtn.addEventListener('click', () => openHelpPage());
els.footerHelpBtn.addEventListener('click', () => openHelpPage());
els.footerBugBtn.addEventListener('click', () =>
  openHelpPage({
    kind: 'bug',
    errorCode: currentState.lastErrorCode,
    jumpToFeedback: true,
  })
);
els.footerFeatureBtn.addEventListener('click', () =>
  openHelpPage({ kind: 'feature', jumpToFeedback: true })
);

els.signInBtn.addEventListener('click', async () => {
  els.signInBtn.disabled = true;
  els.authError.hidden = true;
  try {
    const res = await sendMessage({ type: 'SIGN_IN' });
    if (!res.ok) {
      const err = new Error(res.error || 'Google sign-in failed.');
      err.code = res.code;
      throw err;
    }
    await loadState();
  } catch (err) {
    els.authError.textContent = err.message || 'Google sign-in failed.';
    els.authError.className =
      err.code === 'AUTH_CANCELLED' ? 'alert warning' : 'alert error';
    els.authError.hidden = false;
  } finally {
    els.signInBtn.disabled = false;
  }
});

els.signOutBtn.addEventListener('click', async () => {
  els.signOutBtn.disabled = true;
  try {
    await sendMessage({ type: 'SIGN_OUT' });
    els.settingsDrawer.hidden = true;
    els.settingsToggleBtn.classList.remove('active');
    await loadState();
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
    const res = await sendMessage({
      type: 'UPDATE_SETTINGS',
      patch: { folderName },
    });
    if (res.ok) {
      renderSettings(res.settings);
      showStatus('success', {
        message: `New screenshots will save to "${res.settings.folderName}".`,
      });
    }
  } finally {
    els.saveFolderBtn.disabled = false;
  }
});

els.autoCopyCheckbox.addEventListener('change', async () => {
  const res = await sendMessage({
    type: 'UPDATE_SETTINGS',
    patch: { autoCopyLink: els.autoCopyCheckbox.checked },
  });
  if (res.ok) renderSettings(res.settings);
});

els.captureVisibleBtn.addEventListener('click', async () => {
  if (currentState.busy) return;
  currentState.busy = true;
  updateCaptureAvailability();
  const folderName = currentState.settings?.folderName || 'Chrome_SaveShot_ScreenShots';
  showStatus('loading', `Uploading to "${folderName}"...`);

  try {
    const res = await sendMessage({
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

    renderSettings(res.settings);
    renderRecentUploads(res.recentUploads);

    let copied = false;
    if (res.settings?.autoCopyLink && res.upload?.webViewLink) {
      try {
        await navigator.clipboard.writeText(res.upload.webViewLink);
        copied = true;
      } catch {
        // Ignore clipboard error when popup loses focus
      }
    }

    showStatus('success', {
      message: copied
        ? `Saved to "${res.upload.folderName}" and link copied!`
        : `Saved to "${res.upload.folderName}"!`,
      webViewLink: res.upload.webViewLink,
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
    const res = await sendMessage({
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

async function openDestinationDriveFolder() {
  const cached = currentState.settings?.folderWebViewLink || '';
  if (cached.includes('/drive/folders/')) {
    chrome.tabs.create({ url: cached });
    return;
  }
  try {
    const res = await sendMessage({ type: 'OPEN_DRIVE_FOLDER' });
    const url = (res.ok && res.url) || 'https://drive.google.com/drive/my-drive';
    if (currentState.settings && url.includes('/drive/folders/')) {
      currentState.settings.folderWebViewLink = url;
      els.folderChip.href = url;
    }
    chrome.tabs.create({ url });
  } catch {
    chrome.tabs.create({ url: 'https://drive.google.com/drive/my-drive' });
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
  const res = await sendMessage({ type: 'CLEAR_HISTORY' });
  if (res.ok) renderRecentUploads([]);
});

loadState();
