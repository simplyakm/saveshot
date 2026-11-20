import {
  buildFeedbackPayload,
  getEnvironmentSummary,
  getRepoUrl,
} from '../lib/feedback.js';

const els = {
  extVersion: document.getElementById('ext-version'),
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
  tabBug: document.getElementById('tab-bug'),
  tabFeature: document.getElementById('tab-feature'),
  fbTitle: document.getElementById('fb-title'),
  fbDetailsLabel: document.getElementById('fb-details-label'),
  fbDetails: document.getElementById('fb-details'),
  fbIncludeDiag: document.getElementById('fb-include-diag'),
  diagPreview: document.getElementById('diag-preview'),
  openGithubIssueBtn: document.getElementById('open-github-issue-btn'),
  copyReportBtn: document.getElementById('copy-report-btn'),
  repoIssuesLink: document.getElementById('repo-issues-link'),
};

let feedbackKind = 'bug';
let lastErrorCode = '';

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(res || { ok: false });
    });
  });
}

function setFeedbackKind(kind) {
  feedbackKind = kind === 'feature' ? 'feature' : 'bug';
  const isBug = feedbackKind === 'bug';
  els.tabBug.classList.toggle('active', isBug);
  els.tabFeature.classList.toggle('active', !isBug);

  els.fbDetailsLabel.textContent = isBug ? 'What happened?' : 'What would you like to add?';
  els.fbTitle.placeholder = isBug
    ? 'Example: Region capture shifts when page is scrolled'
    : 'Example: Option to save screenshots as JPEG';
  els.fbDetails.placeholder = isBug
    ? 'Tell us what steps you took and what you expected to happen.'
    : 'Describe how the feature should work and why it would be useful.';

  updateDiagnosticPreview();
}

function updateDiagnosticPreview() {
  const env = getEnvironmentSummary();
  els.diagPreview.hidden = !els.fbIncludeDiag.checked;
  els.diagPreview.textContent = [
    `SaveShot version: ${env.extensionVersion}`,
    `Browser: ${env.browser} (${env.os})`,
    `Last error code: ${lastErrorCode || 'None'}`,
  ].join('\n');
}

async function loadStatus() {
  const env = getEnvironmentSummary();
  els.extVersion.textContent = `v${env.extensionVersion}`;
  els.repoIssuesLink.href = `${getRepoUrl()}/issues`;

  // Check URL query/hash parameters (e.g. welcome.html?kind=bug&error=DRIVE_QUOTA_EXCEEDED#feedback)
  const params = new URLSearchParams(window.location.search);
  if (params.get('error')) {
    lastErrorCode = params.get('error');
  }
  if (params.get('kind')) {
    setFeedbackKind(params.get('kind'));
  }

  // Load live keyboard shortcuts from Chrome
  if (chrome?.commands?.getAll) {
    chrome.commands.getAll((commands) => {
      for (const cmd of commands || []) {
        if (cmd.name === 'capture-visible' && cmd.shortcut) {
          els.shortcutVisible.textContent = cmd.shortcut;
        } else if (cmd.name === 'capture-region' && cmd.shortcut) {
          els.shortcutRegion.textContent = cmd.shortcut;
        }
      }
    });
  }

  try {
    const res = await sendMessage({ type: 'GET_STATE' });
    if (res.lastErrorCode && !lastErrorCode) {
      lastErrorCode = res.lastErrorCode;
    }
    updateDiagnosticPreview();

    if (!res.session?.signedIn) {
      els.accountDot.classList.remove('connected');
      els.accountHeading.textContent = 'Google Drive not connected yet';
      els.accountDetail.textContent =
        'Approve one-time access to your Google Drive to start saving screenshots.';
      els.signInBtn.hidden = false;
      els.openDriveBtn.hidden = true;
      els.devSetupNotice.hidden = !res.session?.needsSetup;
      return;
    }

    const email = res.session.profile?.email || res.session.profile?.name || 'Google account';
    const folderName = res.settings?.folderName || 'Chrome_SaveShot_ScreenShots';
    els.accountDot.classList.add('connected');
    els.accountHeading.textContent = `Connected as ${email}`;
    els.accountDetail.textContent = `Screenshots save to "${folderName}" in your Google Drive.`;
    els.signInBtn.hidden = true;
    els.openDriveBtn.hidden = false;
    els.openDriveBtn.href =
      res.settings?.folderWebViewLink || 'https://drive.google.com/drive/my-drive';
    els.devSetupNotice.hidden = true;
  } catch {
    updateDiagnosticPreview();
  }
}

els.signInBtn.addEventListener('click', async () => {
  els.signInBtn.disabled = true;
  els.authError.hidden = true;
  try {
    const res = await sendMessage({ type: 'SIGN_IN' });
    if (!res.ok) throw new Error(res.error || 'Sign-in failed.');
    await loadStatus();
  } catch (err) {
    els.authError.textContent = err.message;
    els.authError.hidden = false;
  } finally {
    els.signInBtn.disabled = false;
  }
});

els.openDriveBtn.addEventListener('click', async (event) => {
  const currentHref = els.openDriveBtn.href || '';
  if (currentHref.includes('/drive/folders/')) return;
  event.preventDefault();
  const originalText = els.openDriveBtn.textContent;
  els.openDriveBtn.textContent = 'Opening folder...';
  try {
    const res = await sendMessage({ type: 'OPEN_DRIVE_FOLDER' });
    const url = (res.ok && res.url) || 'https://drive.google.com/drive/my-drive';
    els.openDriveBtn.href = url;
    chrome.tabs.create({ url });
  } catch {
    chrome.tabs.create({ url: 'https://drive.google.com/drive/my-drive' });
  } finally {
    els.openDriveBtn.textContent = originalText;
  }
});

els.editShortcutsBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

els.tabBug.addEventListener('click', () => setFeedbackKind('bug'));
els.tabFeature.addEventListener('click', () => setFeedbackKind('feature'));
els.fbIncludeDiag.addEventListener('change', updateDiagnosticPreview);

els.openGithubIssueBtn.addEventListener('click', () => {
  const { issueUrl } = buildFeedbackPayload({
    kind: feedbackKind,
    title: els.fbTitle.value,
    details: els.fbDetails.value,
    lastErrorCode,
    includeDiagnostics: els.fbIncludeDiag.checked,
  });
  chrome.tabs.create({ url: issueUrl });
});

els.copyReportBtn.addEventListener('click', async () => {
  const { title, body } = buildFeedbackPayload({
    kind: feedbackKind,
    title: els.fbTitle.value,
    details: els.fbDetails.value,
    lastErrorCode,
    includeDiagnostics: els.fbIncludeDiag.checked,
  });
  try {
    await navigator.clipboard.writeText(`${title}\n\n${body}`);
    els.copyReportBtn.textContent = 'Copied!';
    setTimeout(() => {
      els.copyReportBtn.textContent = 'Copy report text';
    }, 1800);
  } catch {
    els.copyReportBtn.textContent = 'Could not copy';
  }
});

loadStatus();
