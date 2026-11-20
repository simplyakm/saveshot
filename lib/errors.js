export class SaveShotError extends Error {
  constructor({
    code,
    userMessage,
    status = 0,
    reason = '',
    recoverableWithLocalSave = false,
    requiresReauth = false,
    retryable = false,
  }) {
    super(userMessage);
    this.name = 'SaveShotError';
    this.code = code;
    this.userMessage = userMessage;
    this.status = status;
    this.reason = reason;
    this.recoverableWithLocalSave = recoverableWithLocalSave;
    this.requiresReauth = requiresReauth;
    this.retryable = retryable;
  }
}

const AUTH_RULES = [
  {
    match: ['turned off browser signin', 'browser sign-in is disabled', 'not signed in', 'no user is signed in'],
    code: 'CHROME_NOT_SIGNED_IN',
    userMessage: 'Sign into Chrome first (or turn on "Allow Chrome sign-in" in chrome://settings/syncSetup) to connect Google Drive.',
    requiresReauth: true,
  },
  {
    match: ['did not approve', 'user cancelled', 'user canceled', 'closed the window', 'access_denied', 'interaction was cancelled'],
    code: 'AUTH_CANCELLED',
    userMessage: 'Google Drive connection was cancelled. Click "Connect Google Drive" whenever you want to try again.',
  },
  {
    match: ['bad client id', 'invalid oauth2 client id', 'client_id', 'unauthorized_client', 'custom uri scheme', 'app_id'],
    code: 'OAUTH_CONFIG_ERROR',
    userMessage: 'The OAuth Client ID in manifest.json does not match this extension ID in Google Cloud Console. See README.md.',
  },
  {
    match: ['function unsupported', 'api keys', 'not supported in this browser'],
    code: 'IDENTITY_UNSUPPORTED',
    userMessage: 'This browser build does not support Chrome Identity sign-in. Please use Google Chrome.',
  },
  {
    match: ['connection failed', 'failed to fetch', 'networkerror', 'net::err_', 'offline', 'aborted', 'timed out'],
    code: 'NETWORK_ERROR',
    userMessage: 'Could not reach Google. Check your internet connection and try again.',
    recoverableWithLocalSave: true,
    retryable: true,
  },
  {
    match: ['oauth2 not granted or revoked', 'expired or revoked', 'invalid_grant', 'invalid credentials', 'session expired'],
    code: 'AUTH_REVOKED',
    userMessage: 'Your Google Drive connection expired or was revoked. Click "Connect Google Drive" again.',
    status: 401,
    recoverableWithLocalSave: true,
    requiresReauth: true,
  },
];

const CAPTURE_RULES = [
  {
    match: ['max_capture_visible_tab_calls_per_second'],
    code: 'CAPTURE_THROTTLED',
    userMessage: 'Capturing too fast. Wait a second and try again.',
    retryable: true,
  },
  {
    match: ['extensionssettings policy', 'disabled by policy', 'taking screenshots has been disabled', 'blocked by administrator'],
    code: 'ENTERPRISE_POLICY_BLOCKED',
    userMessage: 'Screenshots on this site or browser are blocked by an administrator policy.',
  },
  {
    match: ['file://'],
    code: 'FILE_ACCESS_DISABLED',
    userMessage: 'To capture local file:// pages or PDFs, turn on "Allow access to file URLs" for SaveShot in chrome://extensions.',
  },
  {
    match: ['showing error page', 'frame with id 0 was removed'],
    code: 'ERROR_PAGE_TAB',
    userMessage: 'Region selection cannot run on a browser error page. Reload the page or use "Visible Tab" instead.',
  },
  {
    match: ['view is invisible', 'window is minimized', 'no active web contents', 'tabs cannot be edited right now', 'user may be dragging a tab'],
    code: 'TAB_NOT_VISIBLE',
    userMessage: 'Could not capture the tab because the window is minimized, hidden, or being dragged. Bring it into view and try again.',
  },
  {
    match: ["either the '<all_urls>' or 'activetab' permission is required", 'cannot access contents of', 'missing host permission'],
    code: 'ACTIVE_TAB_EXPIRED',
    userMessage: 'Page permission expired because the tab navigated or reloaded. Click SaveShot and try again.',
  },
  {
    match: ['abort', 'timed out', 'failed to fetch', 'networkerror'],
    code: 'NETWORK_ERROR',
    userMessage: 'Connection timed out while uploading to Google Drive. Check your internet or save the PNG locally.',
    recoverableWithLocalSave: true,
    retryable: true,
  },
];

function matchRule(rules, lower) {
  return rules.find((rule) => rule.match.some((m) => lower.includes(m)));
}

export function classifyAuthError(rawError) {
  if (rawError instanceof SaveShotError) return rawError;
  const msg = String(rawError?.message || rawError || '').trim();
  if (rawError?.status === 401) {
    return new SaveShotError({
      code: 'AUTH_REVOKED',
      userMessage: 'Your Google Drive session expired. Click "Connect Google Drive" again.',
      status: 401,
      recoverableWithLocalSave: true,
      requiresReauth: true,
    });
  }
  if (rawError?.name === 'AbortError') {
    return new SaveShotError({
      code: 'NETWORK_ERROR',
      userMessage: 'Timed out while connecting to Google Drive. Check your internet connection and try again.',
      recoverableWithLocalSave: true,
      retryable: true,
    });
  }
  const hit = matchRule(AUTH_RULES, msg.toLowerCase());
  if (hit) return new SaveShotError(hit);
  return new SaveShotError({
    code: 'AUTH_ERROR',
    userMessage: msg || 'Google Drive connection failed. Please try again.',
  });
}

export function classifyDriveHttpError(status, errorBody) {
  const apiMessage = errorBody?.error?.message || `Google Drive request failed (${status}).`;
  const reason = errorBody?.error?.errors?.[0]?.reason || errorBody?.error?.details?.[0]?.reason || '';
  const lowerMsg = apiMessage.toLowerCase();
  const lowerReason = String(reason).toLowerCase();

  if (status === 401) {
    return new SaveShotError({
      code: 'AUTH_REVOKED',
      userMessage: 'Your Google Drive session expired. Click "Connect Google Drive" again.',
      status,
      reason,
      recoverableWithLocalSave: true,
      requiresReauth: true,
    });
  }

  if (
    status === 507 ||
    lowerReason === 'storagequotaexceeded' ||
    lowerReason === 'teamdrivestoragequotaexceeded' ||
    lowerMsg.includes('storage quota has been exceeded')
  ) {
    return new SaveShotError({
      code: 'DRIVE_QUOTA_EXCEEDED',
      userMessage: 'Your Google Drive storage is full. Free up space in Drive (and empty Trash), or save this screenshot locally below.',
      status,
      reason: reason || 'storageQuotaExceeded',
      recoverableWithLocalSave: true,
    });
  }

  if (
    status === 429 ||
    ['ratelimitexceeded', 'userratelimitexceeded', 'sharingratelimitexceeded', 'quotaexceeded'].includes(lowerReason)
  ) {
    return new SaveShotError({
      code: 'DRIVE_RATE_LIMITED',
      userMessage: 'Google Drive is busy right now. Wait a moment or save the screenshot locally below.',
      status,
      reason: reason || 'rateLimitExceeded',
      recoverableWithLocalSave: true,
      retryable: true,
    });
  }

  if (status === 403) {
    if (lowerReason === 'insufficientfilepermissions') {
      return new SaveShotError({
        code: 'DRIVE_FILE_FORBIDDEN',
        userMessage: 'SaveShot no longer has access to the previous Google Drive folder. Try again to create a fresh folder.',
        status,
        reason: reason || 'insufficientFilePermissions',
        recoverableWithLocalSave: true,
      });
    }

    if (
      lowerReason === 'insufficientpermissions' ||
      lowerMsg.includes('insufficient permission') ||
      lowerMsg.includes('insufficient authentication scopes')
    ) {
      return new SaveShotError({
        code: 'DRIVE_SCOPE_MISSING',
        userMessage: 'Google Drive permission was not checked. Click "Connect Google Drive" again and check the Google Drive box.',
        status,
        reason: reason || 'insufficientPermissions',
        recoverableWithLocalSave: true,
        requiresReauth: true,
      });
    }

    if (lowerReason === 'accessnotconfigured' || lowerMsg.includes('has not been used in project')) {
      return new SaveShotError({
        code: 'DRIVE_API_DISABLED',
        userMessage: 'Google Drive API is not enabled in the Google Cloud project yet. Enable it in APIs & Services > Library.',
        status,
        reason: reason || 'accessNotConfigured',
        recoverableWithLocalSave: true,
      });
    }

    if (
      lowerReason === 'domainpolicy' ||
      lowerReason === 'appnotauthorizedtofile' ||
      lowerMsg.includes('domain policy') ||
      lowerMsg.includes('administrator')
    ) {
      return new SaveShotError({
        code: 'DRIVE_POLICY_BLOCKED',
        userMessage: 'Your Google Workspace admin blocks third-party uploads to Google Drive on this account.',
        status,
        reason,
        recoverableWithLocalSave: true,
      });
    }
  }

  if (status >= 500 && status <= 599) {
    return new SaveShotError({
      code: 'DRIVE_SERVER_ERROR',
      userMessage: 'Google Drive is having server trouble right now. Try again shortly or save the screenshot locally.',
      status,
      reason,
      recoverableWithLocalSave: true,
      retryable: true,
    });
  }

  return new SaveShotError({
    code: 'DRIVE_ERROR',
    userMessage: apiMessage,
    status,
    reason,
    recoverableWithLocalSave: true,
  });
}

export function classifyCaptureError(rawError) {
  if (rawError instanceof SaveShotError) return rawError;
  const msg = String(rawError?.message || rawError || '').trim();
  const hit = matchRule(CAPTURE_RULES, msg.toLowerCase());
  if (hit) return new SaveShotError(hit);
  return new SaveShotError({
    code: 'CAPTURE_ERROR',
    userMessage: msg || 'Could not take screenshot.',
  });
}
