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

let authEpoch = 0;
let inflightSilentSession = null;
let inflightSignIn = null;
const knownTokens = new Set();

function rememberIssuedToken(token) {
  if (!token) return;
  knownTokens.delete(token);
  knownTokens.add(token);
  while (knownTokens.size > 8) {
    const oldest = knownTokens.values().next().value;
    if (!oldest) break;
    knownTokens.delete(oldest);
  }
}

export function resetAuthMemoryForTests() {
  authEpoch = 0;
  inflightSilentSession = null;
  inflightSignIn = null;
  knownTokens.clear();
}

/**
 * Callback-safe wrapper around chrome.identity.getAuthToken.
 * Uses the Google account signed into the Chrome profile (Chrome Sync).
 */
export function requestAuthToken({ interactive = false, timeoutMs = 0 } = {}) {
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

    let settled = false;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new SaveShotError({
            code: 'AUTH_TIMEOUT',
            userMessage: 'Timed out waiting for Chrome Identity token cache.',
          })
        );
      }, timeoutMs);
      timer?.unref?.();
    }

    try {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);

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
        rememberIssuedToken(token);
        resolve(token);
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(classifyAuthError(err));
    }
  });
}

export function removeCachedToken(token, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (token) {
      knownTokens.delete(token);
    }
    if (!token || typeof chrome?.identity?.removeCachedAuthToken !== 'function') {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer?.unref?.();

    try {
      chrome.identity.removeCachedAuthToken({ token }, () => {
        const hadError = Boolean(chrome.runtime?.lastError);
        finish(!hadError);
      });
    } catch {
      finish(false);
    }
  });
}

export function clearAllCachedTokens(timeoutMs = 2000) {
  return new Promise((resolve) => {
    knownTokens.clear();
    if (typeof chrome?.identity?.clearAllCachedAuthTokens !== 'function') {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer?.unref?.();

    try {
      chrome.identity.clearAllCachedAuthTokens(() => {
        const hadError = Boolean(chrome.runtime?.lastError);
        finish(!hadError);
      });
    } catch {
      finish(false);
    }
  });
}

/**
 * Evict all cached OAuth access tokens and clear Chrome's remembered account preference
 * via clearAllCachedAuthTokens so the user gets the Account Picker on next sign-in,
 * without revoking their Google Account OAuth permission grant.
 */
async function evictAllLocalTokens(extraTokens = [], timeoutMs = 2000) {
  const tokensToRemove = new Set(extraTokens.filter(Boolean));
  for (const tok of knownTokens) {
    tokensToRemove.add(tok);
  }
  knownTokens.clear();

  try {
    const cached = await requestAuthToken({
      interactive: false,
      timeoutMs: Math.min(1500, timeoutMs),
    });
    if (cached) {
      tokensToRemove.add(cached);
    }
    knownTokens.clear();
  } catch {
    // No cached token returned or lookup failed/timed out; continue evicting known tokens + full cache
  }

  await Promise.allSettled(
    Array.from(tokensToRemove, (tok) => removeCachedToken(tok, timeoutMs))
  );
  await clearAllCachedTokens(timeoutMs);
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

async function abortSupersededSignIn(token) {
  await Promise.allSettled([
    removeCachedToken(token),
    clearAllCachedTokens(),
  ]);
  throw new SaveShotError({
    code: 'AUTH_CANCELLED',
    userMessage: 'Sign-in was cancelled.',
  });
}

async function runSignIn(fetchImpl) {
  if (!isClientIdConfigured()) {
    throw new SaveShotError({
      code: 'OAUTH_CONFIG_ERROR',
      userMessage:
        'OAuth Client ID is not configured in manifest.json. See README.md for 2-minute setup instructions.',
    });
  }

  const signInEpoch = (authEpoch += 1);
  inflightSilentSession = null;

  let token = await requestAuthToken({ interactive: true });
  if (signInEpoch !== authEpoch) {
    await abortSupersededSignIn(token);
  }

  let profile = null;
  try {
    profile = await fetchGoogleUserInfo(token, fetchImpl);
  } catch (err) {
    if (signInEpoch !== authEpoch) {
      await abortSupersededSignIn(token);
    }
    if (err.code === 'DRIVE_SCOPE_MISSING') {
      await removeCachedToken(token);
      await clearAllCachedTokens();
      await revokeIncompleteScopeGrant(token, fetchImpl);
      await setAuthState({ signedOut: true, userProfile: null });
      throw err;
    }
    if (err.status === 401 || err.code === 'AUTH_REVOKED') {
      await removeCachedToken(token);
      token = await requestAuthToken({ interactive: true });
      if (signInEpoch !== authEpoch) {
        await abortSupersededSignIn(token);
      }
      try {
        profile = await fetchGoogleUserInfo(token, fetchImpl);
      } catch (retryErr) {
        if (signInEpoch !== authEpoch) {
          await abortSupersededSignIn(token);
        }
        if (retryErr.code === 'DRIVE_SCOPE_MISSING') {
          await removeCachedToken(token);
          await clearAllCachedTokens();
          await revokeIncompleteScopeGrant(token, fetchImpl);
          await setAuthState({ signedOut: true, userProfile: null });
        } else if (retryErr.status === 401) {
          await removeCachedToken(token);
          await clearAllCachedTokens();
          await setAuthState({ signedOut: true, userProfile: null });
        }
        throw classifyAuthError(retryErr);
      }
    } else {
      throw classifyAuthError(err);
    }
  }

  if (signInEpoch !== authEpoch) {
    await abortSupersededSignIn(token);
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
    const activePromise = runSignIn(fetch).finally(() => {
      if (inflightSignIn === activePromise) {
        inflightSignIn = null;
      }
    });
    inflightSignIn = activePromise;
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
    await removeCachedToken(token);
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
      await clearAllCachedTokens();
      await revokeIncompleteScopeGrant(token, fetchImpl);
      await setAuthState({ signedOut: true, userProfile: null });
      return { signedIn: false, profile: null, needsSetup: false };
    }
    if (err.status === 401 || err.code === 'AUTH_REVOKED') {
      await removeCachedToken(token);
      await clearAllCachedTokens();
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
    const activePromise = runSilentAuthSession(fetch).finally(() => {
      if (inflightSilentSession === activePromise) {
        inflightSilentSession = null;
      }
    });
    inflightSilentSession = activePromise;
  }
  return inflightSilentSession;
}

/**
 * Sign out locally and clear Chrome's cached OAuth tokens without revoking the
 * user's Google Account permission grant, so reconnecting with the same account
 * is seamless and does not re-prompt for consent.
 */
export async function signOut({ timeoutMs = 2000 } = {}) {
  authEpoch += 1;
  inflightSilentSession = null;
  inflightSignIn = null;

  const priorTokens = Array.from(knownTokens);
  knownTokens.clear();

  // Persist signed-out state immediately AND evict all cached tokens with failure/timeout resilience
  await Promise.all([
    setAuthState({ signedOut: true, userProfile: null, clearHistory: true }),
    evictAllLocalTokens(priorTokens, timeoutMs),
  ]);
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

  const startEpoch = authEpoch;
  const { signedOut, userProfile } = await getAuthState();
  if ((signedOut || startEpoch !== authEpoch) && !interactive) {
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

  if (startEpoch !== authEpoch) {
    const ok = await removeCachedToken(token);
    if (!ok) await clearAllCachedTokens();
    throw new SaveShotError({
      code: 'AUTH_REQUIRED',
      userMessage: 'Connect Google Drive first by clicking the SaveShot icon in Chrome.',
      requiresReauth: true,
      recoverableWithLocalSave: true,
    });
  }

  try {
    return await operation(token, userProfile?.email || '');
  } catch (err) {
    // If user unchecked granular Drive scope on consent screen, evict token and reset incomplete grant so re-sign-in re-prompts
    if (err?.code === 'DRIVE_SCOPE_MISSING') {
      await removeCachedToken(token);
      await clearAllCachedTokens();
      await revokeIncompleteScopeGrant(token, fetchImpl);
      await setAuthState({ signedOut: true, userProfile: null });
      throw err;
    }

    if (err && (err.status === 401 || err.code === 'AUTH_REVOKED')) {
      const removedOk = await removeCachedToken(token);
      if (startEpoch !== authEpoch || (await getAuthState()).signedOut) {
        if (!removedOk) await clearAllCachedTokens();
        throw new SaveShotError({
          code: 'AUTH_REQUIRED',
          userMessage: 'Connect Google Drive first by clicking the SaveShot icon in Chrome.',
          requiresReauth: true,
          recoverableWithLocalSave: true,
        });
      }
      let refreshedToken = null;
      try {
        refreshedToken = await requestAuthToken({ interactive });
        if (startEpoch !== authEpoch) {
          const refreshedRemovedOk = await removeCachedToken(refreshedToken);
          if (!refreshedRemovedOk) await clearAllCachedTokens();
          throw new SaveShotError({
            code: 'AUTH_REQUIRED',
            userMessage: 'Connect Google Drive first by clicking the SaveShot icon in Chrome.',
            requiresReauth: true,
            recoverableWithLocalSave: true,
          });
        }
        return await operation(refreshedToken, userProfile?.email || '');
      } catch (retryErr) {
        const classified =
          retryErr instanceof SaveShotError
            ? retryErr
            : classifyAuthError(retryErr);
        if (refreshedToken && classified.code === 'DRIVE_SCOPE_MISSING') {
          await removeCachedToken(refreshedToken);
          await clearAllCachedTokens();
          await revokeIncompleteScopeGrant(refreshedToken, fetchImpl);
        } else if (refreshedToken && classified.status === 401) {
          await removeCachedToken(refreshedToken);
          await clearAllCachedTokens();
        }
        if (classified.requiresReauth || classified.status === 401) {
          await clearAllCachedTokens();
          await setAuthState({ signedOut: true, userProfile: null });
        }
        classified.recoverableWithLocalSave = true;
        throw classified;
      }
    }

    throw err;
  }
}
