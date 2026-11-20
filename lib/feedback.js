export const DEFAULT_REPO_URL = 'https://github.com/simplyakm/saveshot';

export function getRepoUrl() {
  try {
    const url = chrome?.runtime?.getManifest?.()?.homepage_url || DEFAULT_REPO_URL;
    return url.replace(/\/+$/, '');
  } catch {
    return DEFAULT_REPO_URL;
  }
}

export function getEnvironmentSummary(userAgent = globalThis.navigator?.userAgent || '') {
  const manifest = chrome?.runtime?.getManifest?.() || { version: '1.1.1' };
  const chromeMatch = userAgent.match(/Chrome\/([\d.]+)/);
  const browser = chromeMatch ? `Chrome ${chromeMatch[1]}` : 'Chromium';

  let os = 'Unknown OS';
  if (/Mac OS X/i.test(userAgent)) os = 'macOS';
  else if (/Windows/i.test(userAgent)) os = 'Windows';
  else if (/CrOS/i.test(userAgent)) os = 'ChromeOS';
  else if (/Linux/i.test(userAgent)) os = 'Linux';

  return {
    extensionVersion: manifest.version || '1.1.1',
    browser,
    os,
  };
}

/**
 * Build a plain-text report and a pre-filled GitHub new-issue URL.
 * Never includes private data (no emails, tokens, Drive links, or visited URLs).
 */
export function buildFeedbackPayload({
  kind = 'bug',
  title = '',
  details = '',
  lastErrorCode = '',
  includeDiagnostics = true,
  repoUrl = getRepoUrl(),
  env = getEnvironmentSummary(),
} = {}) {
  const isBug = kind !== 'feature';
  const cleanTitle = title.trim() || (isBug ? 'Bug: ' : 'Feature request: ');
  const cleanDetails = details.trim() || (isBug ? 'Steps to reproduce:\n1. \n2. \n\nWhat happened:' : 'What would you like to see added and why?');

  const lines = [cleanDetails];

  if (includeDiagnostics) {
    lines.push(
      '',
      '---',
      'Diagnostic info:',
      `- SaveShot version: ${env.extensionVersion}`,
      `- Browser: ${env.browser} (${env.os})`,
      `- Last error code: ${lastErrorCode || 'None'}`
    );
  }

  const bodyText = lines.join('\n');
  const params = new URLSearchParams({
    labels: isBug ? 'bug' : 'enhancement',
    title: cleanTitle,
    body: bodyText,
  });

  return {
    title: cleanTitle,
    body: bodyText,
    issueUrl: `${repoUrl.replace(/\/+$/, '')}/issues/new?${params.toString()}`,
  };
}
