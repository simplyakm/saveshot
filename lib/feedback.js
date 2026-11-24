export const DEFAULT_CWS_SUPPORT_URL =
  'https://chromewebstore.google.com/detail/eilmbilnlihhddjdmdpppalfnbnieppf/support';

export function getEnvironmentSummary(userAgent = globalThis.navigator?.userAgent || '') {
  const manifest = chrome?.runtime?.getManifest?.() || { version: '1.2.1' };
  const chromeMatch = userAgent.match(/Chrome\/([\d.]+)/);
  const browser = chromeMatch ? `Chrome ${chromeMatch[1]}` : 'Chromium';

  let os = 'Unknown OS';
  if (/Mac OS X/i.test(userAgent)) os = 'macOS';
  else if (/Windows/i.test(userAgent)) os = 'Windows';
  else if (/CrOS/i.test(userAgent)) os = 'ChromeOS';
  else if (/Linux/i.test(userAgent)) os = 'Linux';

  return {
    extensionVersion: manifest.version || '1.2.1',
    browser,
    os,
  };
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
