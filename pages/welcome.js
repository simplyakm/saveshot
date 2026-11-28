import {
  DEFAULT_CWS_SUPPORT_URL,
  formatVersionInfoLine,
  formatVersionTooltip,
  getEnvironmentSummary,
} from '../lib/feedback.js';
import {
  didAuthProfileVisiblyChange,
  formatShortcutDisplay,
  initThemeSync,
  safeHttpsUrl,
  sendRuntimeMessage,
} from '../lib/ui.js';

const els = {
  extVersion: document.getElementById('ext-version'),
  pinNudgeCard: document.getElementById('pin-nudge-card'),
  pinDoneCard: document.getElementById('pin-done-card'),
  statusCard: document.getElementById('status-card'),
  accountDot: document.getElementById('account-dot'),
  accountHeading: document.getElementById('account-heading'),
  accountDetail: document.getElementById('account-detail'),
  signInBtn: document.getElementById('sign-in-btn'),
  openDriveBtn: document.getElementById('open-drive-btn'),
  devSetupNotice: document.getElementById('dev-setup-notice'),
  authError: document.getElementById('auth-error'),
  shortcutVisible: document.getElementById('shortcut-visible'),
  shortcutRegion: document.getElementById('shortcut-region'),
  editShortcutsBtn: document.getElementById('edit-shortcuts-btn'),
  versionInfoText: document.getElementById('version-info-text'),
  copyVersionBtn: document.getElementById('copy-version-btn'),
  cwsSupportLink: document.getElementById('cws-support-link'),
};

let lastErrorCode = '';
let wasUnpinnedDuringSession = false;
let copyVersionTimer = null;

function applyToolbarPinState(isOnToolbar) {
  if (typeof isOnToolbar !== 'boolean') return;
  if (!isOnToolbar) {
    wasUnpinnedDuringSession = true;
    els.pinNudgeCard.hidden = false;
    els.pinDoneCard.hidden = true;
    return;
  }

  els.pinNudgeCard.hidden = true;
  els.pinDoneCard.hidden = !wasUnpinnedDuringSession;
}

async function refreshPinStatus() {
  if (typeof chrome?.action?.getUserSettings !== 'function') return;
  try {
    const settings = await chrome.action.getUserSettings();
    applyToolbarPinState(settings?.isOnToolbar);
  } catch {
    // Ignore if browser build omits getUserSettings
  }
}

function updateVersionStrip() {
  const env = getEnvironmentSummary();
  els.versionInfoText.textContent = formatVersionInfoLine({
    env,
    lastErrorCode,
  });
}

async function loadStatus() {
  const env = getEnvironmentSummary();
  els.extVersion.textContent = `v${env.extensionVersion}`;
  els.extVersion.title = formatVersionTooltip(env);
  els.cwsSupportLink.href = safeHttpsUrl(
    els.cwsSupportLink.getAttribute('href'),
    DEFAULT_CWS_SUPPORT_URL
  );

  const params = new URLSearchParams(window.location.search);
  if (params.get('error')) {
    lastErrorCode = params.get('error');
  }
  updateVersionStrip();

  if (chrome?.commands?.getAll) {
    chrome.commands.getAll((commands) => {
      let hasUnset = false;
      let sawRegion = false;
      let sawVisible = false;
      for (const cmd of commands || []) {
        if (cmd.name === 'capture-visible') {
          sawVisible = true;
          if (cmd.shortcut) {
            els.shortcutVisible.textContent = formatShortcutDisplay(cmd.shortcut);
          } else {
            els.shortcutVisible.textContent = 'Not set';
            hasUnset = true;
          }
        } else if (cmd.name === 'capture-region') {
          sawRegion = true;
          if (cmd.shortcut) {
            els.shortcutRegion.textContent = formatShortcutDisplay(cmd.shortcut);
          } else {
            els.shortcutRegion.textContent = 'Not set';
            hasUnset = true;
          }
        }
      }
      if (!sawRegion) {
        els.shortcutRegion.textContent = 'Not set';
        hasUnset = true;
      }
      if (!sawVisible) {
        els.shortcutVisible.textContent = 'Not set';
        hasUnset = true;
      }
      const unsetHint = document.getElementById('shortcut-unset-hint');
      if (unsetHint) {
        unsetHint.hidden = !hasUnset;
      }
    });
  }

  try {
    const res = await sendRuntimeMessage({
      type: 'GET_STATE',
      includeTab: false,
      includeRecent: false,
    });
    if (res.lastErrorCode && !lastErrorCode) {
      lastErrorCode = res.lastErrorCode;
    }
    updateVersionStrip();

    if (!res.session?.signedIn) {
      els.statusCard.classList.add('unconnected');
      els.accountDot.classList.remove('connected');
      els.accountHeading.textContent = 'Autosave to your Google Drive';
      els.accountDetail.textContent =
        'Connect once to autosave shots to "Chrome_SaveShot_ScreenShots", or capture locally anytime.';
      els.signInBtn.hidden = false;
      els.openDriveBtn.hidden = true;
      els.devSetupNotice.hidden = !res.session?.needsSetup;
      return;
    }

    const email = res.session.profile?.email || res.session.profile?.name || 'Google account';
    const folderName = res.settings?.folderName || 'Chrome_SaveShot_ScreenShots';
    els.statusCard.classList.remove('unconnected');
    els.accountDot.classList.add('connected');
    els.accountHeading.textContent = `Connected as ${email}`;
    els.accountDetail.textContent = `Screenshots save to "${folderName}" in your Google Drive.`;
    els.signInBtn.hidden = true;
    els.openDriveBtn.hidden = false;
    els.openDriveBtn.href = safeHttpsUrl(
      res.settings?.folderWebViewLink,
      'https://drive.google.com/drive/my-drive'
    );
    els.devSetupNotice.hidden = true;
  } catch {
    updateVersionStrip();
  }
}

els.signInBtn.addEventListener('click', async () => {
  els.signInBtn.disabled = true;
  els.authError.hidden = true;
  try {
    const res = await sendRuntimeMessage({ type: 'SIGN_IN' });
    if (!res.ok) throw new Error(res.error || 'Sign-in failed.');
    await loadStatus();
  } catch (err) {
    els.authError.textContent = err.message;
    els.authError.hidden = false;
  } finally {
    els.signInBtn.disabled = false;
  }
});

let openingWelcomeFolder = false;

els.openDriveBtn.addEventListener('click', async (event) => {
  const currentHref = els.openDriveBtn.href || '';
  if (currentHref.includes('/drive/folders/')) return;
  event.preventDefault();
  if (openingWelcomeFolder) return;
  openingWelcomeFolder = true;
  const labelSpan = els.openDriveBtn.querySelector('span');
  const originalText = labelSpan ? labelSpan.textContent : '';
  if (labelSpan) labelSpan.textContent = 'Opening...';
  try {
    const res = await sendRuntimeMessage({ type: 'OPEN_DRIVE_FOLDER' });
    const url = safeHttpsUrl(res.ok ? res.url : '', 'https://drive.google.com/drive/my-drive');
    els.openDriveBtn.href = url;
    chrome.tabs.create({ url });
  } catch {
    chrome.tabs.create({ url: 'https://drive.google.com/drive/my-drive' });
  } finally {
    if (labelSpan) labelSpan.textContent = originalText;
    openingWelcomeFolder = false;
  }
});

els.editShortcutsBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

els.copyVersionBtn.addEventListener('click', async () => {
  const line = formatVersionInfoLine({
    env: getEnvironmentSummary(),
    lastErrorCode,
  });
  try {
    await navigator.clipboard.writeText(line);
    if (copyVersionTimer) clearTimeout(copyVersionTimer);
    els.copyVersionBtn.textContent = 'Copied!';
    copyVersionTimer = setTimeout(() => {
      copyVersionTimer = null;
      els.copyVersionBtn.textContent = 'Copy version info';
    }, 1800);
  } catch {
    els.copyVersionBtn.textContent = 'Could not copy';
  }
});

if (chrome?.action?.onUserSettingsChanged?.addListener) {
  chrome.action.onUserSettingsChanged.addListener((change) => {
    applyToolbarPinState(change?.isOnToolbar);
  });
}

window.addEventListener('focus', refreshPinStatus);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshPinStatus();
});

if (chrome?.storage?.onChanged?.addListener) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const folderChanged =
      Boolean(changes.settings) &&
      (changes.settings.oldValue?.folderName !== changes.settings.newValue?.folderName ||
        changes.settings.oldValue?.folderWebViewLink !==
          changes.settings.newValue?.folderWebViewLink);
    if (didAuthProfileVisiblyChange(changes) || folderChanged) {
      loadStatus();
    }
  });
}

initThemeSync();
refreshPinStatus();
loadStatus();
