export const DEFAULT_CWS_SUPPORT_URL =
  'https://chromewebstore.google.com/detail/eilmbilnlihhddjdmdpppalfnbnieppf/support';

export function parseBuildNumberFromVersionName(versionName = '') {
  const match = String(versionName || '').match(/\(b([1-9]\d*)\)\s*$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function getEnvironmentSummary(userAgent = globalThis.navigator?.userAgent || '') {
  const manifest = globalThis.chrome?.runtime?.getManifest?.() || { version: '1.3.0' };
  const manifestVersion = String(manifest.version || '1.3.0').trim();
  const versionName = String(manifest.version_name || '').trim();
  const extensionVersion = versionName || manifestVersion;
  const buildNumber = parseBuildNumberFromVersionName(versionName);

  const chromeMatch = userAgent.match(/Chrome\/([\d.]+)/);
  const browser = chromeMatch ? `Chrome ${chromeMatch[1]}` : 'Chromium';

  let os = 'Unknown OS';
  if (/Mac OS X/i.test(userAgent)) os = 'macOS';
  else if (/Windows/i.test(userAgent)) os = 'Windows';
  else if (/CrOS/i.test(userAgent)) os = 'ChromeOS';
  else if (/Linux/i.test(userAgent)) os = 'Linux';

  return {
    extensionVersion,
    manifestVersion,
    buildNumber,
    browser,
    os,
  };
}

/**
 * Format an accessible hover tooltip (e.g. "SaveShot v1.3.0 · Build 1").
 */
export function formatVersionTooltip(env = getEnvironmentSummary()) {
  const safeEnv = env && typeof env === 'object' ? env : getEnvironmentSummary();
  const rawBase = String(safeEnv.manifestVersion || safeEnv.extensionVersion || '1.3.0').trim();
  const baseVer = rawBase.replace(/\s*\(b[1-9]\d*\)\s*$/, '') || rawBase;
  if (Number.isSafeInteger(safeEnv.buildNumber) && safeEnv.buildNumber >= 1) {
    return `SaveShot v${baseVer} \u00b7 Build ${safeEnv.buildNumber}`;
  }
  return `SaveShot v${safeEnv.extensionVersion || baseVer}`;
}

/**
 * Format a compact single-line version and error summary for bug reports.
 * Never includes private data (no emails, tokens, Drive links, or visited URLs).
 */
export function formatVersionInfoLine({
  env = getEnvironmentSummary(),
  lastErrorCode = '',
} = {}) {
  return `SaveShot v${env.extensionVersion} \u00b7 ${env.browser} (${env.os}) \u00b7 Last error: ${
    lastErrorCode || 'None'
  }`;
}
