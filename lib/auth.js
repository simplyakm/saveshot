import { classifyAuthError, SaveShotError } from './errors.js';
import { getAuthState, setAuthState } from './storage.js';

const DRIVE_ABOUT_ENDPOINT =
  'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,photoLink)';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

export const PLACEHOLDER_CLIENT_ID =
  'YOUR_CHROME_OAUTH_CLIENT_ID.apps.googleusercontent.com';

/**
 * Check whether the developer has replaced the placeholder OAuth Client ID in manifest.json.
 */
export function isClientIdConfigured() {
  const manifest = chrome.runtime.getManifest();
  const clientId = manifest?.oauth2?.client_id || '';
  return (
    Boolean(clientId) &&
    clientId !== PLACEHOLDER_CLIENT_ID &&
    !clientId.includes('YOUR_CHROME_OAUTH')
  );
}

/**
 * Callback-safe wrapper around chrome.identity.getAuthToken.
 * Uses the Google account signed into the Chrome profile (Chrome Sync).
 */
export function requestAuthToken({ interactive = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!chrome?.identity?.getAuthToken) {
      reject(
        new SaveShotError({
          code: 'IDENTITY_UNSUPPORTED',
          userMessage:
            'Chrome Identity API is unavailable in this browser build.',
        })
      );
      return;
    }

    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(classifyAuthError(chrome.runtime.lastError));
        return;
      }
      if (!token) {
        reject(
          new SaveShotError({
            code: 'AUTH_ERROR',
            userMessage: 'Google sign-in did not return an access token.',
          })
        );
        return;
      }
      resolve(token);
    });
  });
}

export function removeCachedToken(token) {
  return new Promise((resolve) => {
    if (!token || !chrome?.identity?.removeCachedAuthToken) {
      resolve();
      return;
    }
    chrome.identity.removeCachedAuthToken({ token }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function clearAllCachedTokens() {
  return new Promise((resolve) => {
    if (typeof chrome?.identity?.clearAllCachedAuthTokens !== 'function') {
      resolve();
      return;
    }
    chrome.identity.clearAllCachedAuthTokens(() => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

/**
 * Fetch the connected Google Drive user's display name, email, and avatar using only drive.file.
 */
export async function fetchGoogleUserInfo(
  token,
  fetchImpl = fetch,
  timeoutMs = 8000
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(DRIVE_ABOUT_ENDPOINT, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
  } catch (err) {
    throw classifyAuthError(err);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401) {
    throw new SaveShotError({
      code: 'AUTH_REVOKED',
      userMessage: 'Your Google Drive session expired. Please connect Google Drive again.',
      status: 401,
      requiresReauth: true,
    });
  }

  if (response.status === 403) {
    throw new SaveShotError({
      code: 'DRIVE_SCOPE_MISSING',
      userMessage:
        'Google Drive permission was not checked. Click "Connect Google Drive" again and check the Google Drive box.',
      status: 403,
      requiresReauth: true,
    });
  }

  if (!response.ok) {
    throw new SaveShotError({
      code: 'AUTH_ERROR',
      userMessage: `Could not verify Google Drive connection (${response.status}).`,
      status: response.status,
    });
  }

  const data = await response.json();
  const user = data.user || data;
  const email = user.emailAddress || user.email || '';
  return {
    email,
    name: user.displayName || user.name || email || 'Google Drive',
    picture: user.photoLink || user.picture || '',
    verifiedAt: Date.now(),
  };
}

let authEpoch = 0;
let inflightSilentSession = null;
let inflightSignIn = null;

/**
 * Revoke an incomplete OAuth grant at Google ONLY when the user left the granular
 * drive.file checkbox unchecked, so the next sign-in re-shows the permission checkbox.
 * Normal sign-out intentionally preserves the Google grant for seamless 1-click reconnect.
 */
async function revokeIncompleteScopeGrant(token, fetchImpl = fetch) {
  if (!token || typeof fetchImpl !== 'function') return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    await fetchImpl(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      signal: controller.signal,
    });
  } catch {
    // Best-effort cleanup
  } finally {
    clearTimeout(timer);
  }
}

async function runSignIn(fetchImpl) {
  if (!isClientIdConfigured()) {
    throw new SaveShotError({
      code: 'OAUTH_CONFIG_ERROR',
      userMessage:
        'OAuth Client ID is not configured in manifest.json. See README.md for 2-minute setup instructions.',
    });
  }

  authEpoch += 1;
  inflightSilentSession = null;

  let token = await requestAuthToken({ interactive: true });
  let profile = null;
  try {
    profile = await fetchGoogleUserInfo(token, fetchImpl);
  } catch (err) {
    if (err.code === 'DRIVE_SCOPE_MISSING') {
      await removeCachedToken(token);
      await revokeIncompleteScopeGrant(token, fetchImpl);
      await setAuthState({ signedOut: true, userProfile: null });
      throw err;
    }
    if (err.status === 401 || err.code === 'AUTH_REVOKED') {
      await removeCachedToken(token);
      token = await requestAuthToken({ interactive: true });
      try {
        profile = await fetchGoogleUserInfo(token, fetchImpl);
      } catch (retryErr) {
        if (retryErr.code === 'DRIVE_SCOPE_MISSING') {
          await removeCachedToken(token);
          await revokeIncompleteScopeGrant(token, fetchImpl);
          await setAuthState({ signedOut: true, userProfile: null });
        } else if (retryErr.status === 401) {
          await removeCachedToken(token);
          await setAuthState({ signedOut: true, userProfile: null });
        }
        throw classifyAuthError(retryErr);
      }
    } else {
      throw classifyAuthError(err);
    }
  }

  await setAuthState({ signedOut: false, userProfile: profile });
  return { token, profile };
}

/**
 * Interactive sign-in using Chrome's signed-in Google account.
 * Deduplicates concurrent calls so rapid double-clicks share one auth flow.
 */
export async function signIn(fetchImpl = fetch) {
  if (fetchImpl !== fetch) {
    return runSignIn(fetchImpl);
  }
  if (!inflightSignIn) {
    inflightSignIn = runSignIn(fetch).finally(() => {
      inflightSignIn = null;
    });
  }
  return inflightSignIn;
}

async function runSilentAuthSession(fetchImpl) {
  if (!isClientIdConfigured()) {
    return { signedIn: false, profile: null, needsSetup: true };
  }

  const startEpoch = authEpoch;
  const { signedOut, userProfile } = await getAuthState();
  if (signedOut || startEpoch !== authEpoch) {
    return { signedIn: false, profile: null, needsSetup: false };
  }

  let token;
  try {
    token = await requestAuthToken({ interactive: false });
  } catch {
    return { signedIn: false, profile: null, needsSetup: false };
  }

  if (startEpoch !== authEpoch) {
    return { signedIn: false, profile: null, needsSetup: false };
  }

  // Re-verify profile if missing or older than 5 minutes so revoked tokens / switched accounts are caught early
  const isFresh =
    userProfile?.email &&
    userProfile?.verifiedAt &&
    Date.now() - userProfile.verifiedAt < 5 * 60 * 1000;

  if (isFresh) {
    return { signedIn: true, profile: userProfile, needsSetup: false };
  }

  try {
    const liveProfile = await fetchGoogleUserInfo(token, fetchImpl, 5000);
    if (startEpoch !== authEpoch || (await getAuthState()).signedOut) {
      return { signedIn: false, profile: null, needsSetup: false };
    }
    await setAuthState({ signedOut: false, userProfile: liveProfile });
    return { signedIn: true, profile: liveProfile, needsSetup: false };
  } catch (err) {
    if (startEpoch !== authEpoch) {
      return { signedIn: false, profile: null, needsSetup: false };
    }
    if (err.code === 'DRIVE_SCOPE_MISSING') {
      await removeCachedToken(token);
      await revokeIncompleteScopeGrant(token, fetchImpl);
      await setAuthState({ signedOut: true, userProfile: null });
      return { signedIn: false, profile: null, needsSetup: false };
    }
    if (err.status === 401 || err.code === 'AUTH_REVOKED') {
      await removeCachedToken(token);
      await setAuthState({ signedOut: true, userProfile: null });
      return { signedIn: false, profile: null, needsSetup: false };
    }
    // If temporarily offline, preserve cached profile rather than locking the user out
    if (userProfile?.email) {
      return { signedIn: true, profile: userProfile, needsSetup: false };
    }
    return {
      signedIn: true,
      profile: { email: '', name: 'Google Account', picture: '' },
      needsSetup: false,
    };
  }
}

/**
 * Check if the user is signed in without popping up a consent dialog.
 * Detects revoked tokens and Chrome profile account switches while tolerating offline mode.
 */
export async function getSilentAuthSession(fetchImpl = fetch) {
  if (fetchImpl !== fetch) {
    return runSilentAuthSession(fetchImpl);
  }
  if (!inflightSilentSession) {
    inflightSilentSession = runSilentAuthSession(fetch).finally(() => {
      inflightSilentSession = null;
    });
  }
  return inflightSilentSession;
}

/**
 * Sign out locally and clear Chrome's cached OAuth tokens without revoking the
 * user's Google Account permission grant, so reconnecting with the same account
 * is seamless and does not re-prompt for consent.
 */
export async function signOut() {
  authEpoch += 1;
  inflightSilentSession = null;

  let token = null;
  try {
    token = await requestAuthToken({ interactive: false });
  } catch {
    // No cached token present
  }

  if (token) {
    await removeCachedToken(token);
  }

  await clearAllCachedTokens();
  await setAuthState({ signedOut: true, userProfile: null, clearHistory: true });
}

/**
 * Execute an authenticated Google API operation with automatic 401 token refresh retry
 * and clean cache eviction when scopes or credentials are revoked.
 */
export async function withAuthToken(
  operation,
  { interactive = false, fetchImpl = fetch } = {}
) {
  if (!isClientIdConfigured()) {
    throw new SaveShotError({
      code: 'OAUTH_CONFIG_ERROR',
      userMessage:
        'OAuth Client ID is not configured in manifest.json. See README.md for setup instructions.',
    });
  }

  const { signedOut, userProfile } = await getAuthState();
  if (signedOut && !interactive) {
    throw new SaveShotError({
      code: 'AUTH_REQUIRED',
      userMessage: 'Connect Google Drive first by clicking the SaveShot icon in Chrome.',
      requiresReauth: true,
      recoverableWithLocalSave: true,
    });
  }

  let token;
  try {
    token = await requestAuthToken({ interactive });
  } catch (tokenErr) {
    const classified =
      tokenErr instanceof SaveShotError ? tokenErr : classifyAuthError(tokenErr);
    if (!interactive && !userProfile && classified.code === 'AUTH_REVOKED') {
      throw new SaveShotError({
        code: 'AUTH_REQUIRED',
        userMessage: 'Connect Google Drive first by clicking the SaveShot icon in Chrome.',
        requiresReauth: true,
        recoverableWithLocalSave: true,
      });
    }
    classified.recoverableWithLocalSave = true;
    throw classified;
  }

  try {
    return await operation(token, userProfile?.email || '');
  } catch (err) {
    // If user unchecked granular Drive scope on consent screen, evict token and reset incomplete grant so re-sign-in re-prompts
    if (err?.code === 'DRIVE_SCOPE_MISSING') {
      await removeCachedToken(token);
      await revokeIncompleteScopeGrant(token, fetchImpl);
      await setAuthState({ signedOut: true, userProfile: null });
      throw err;
    }

    if (err && (err.status === 401 || err.code === 'AUTH_REVOKED')) {
      await removeCachedToken(token);
      let refreshedToken = null;
      try {
        refreshedToken = await requestAuthToken({ interactive });
        return await operation(refreshedToken, userProfile?.email || '');
      } catch (retryErr) {
        const classified =
          retryErr instanceof SaveShotError
            ? retryErr
            : classifyAuthError(retryErr);
        if (refreshedToken && classified.code === 'DRIVE_SCOPE_MISSING') {
          await removeCachedToken(refreshedToken);
          await revokeIncompleteScopeGrant(refreshedToken, fetchImpl);
        } else if (refreshedToken && classified.status === 401) {
          await removeCachedToken(refreshedToken);
        }
        if (classified.requiresReauth || classified.status === 401) {
          await setAuthState({ signedOut: true, userProfile: null });
        }
        classified.recoverableWithLocalSave = true;
        throw classified;
      }
    }

    throw err;
  }
}
