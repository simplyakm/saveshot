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
let signOutEpoch = 0;
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
  signOutEpoch = 0;
  inflightSilentSession = null;
  inflightSignIn = null;
  knownTokens.clear();
}

/**
 * Callback-safe wrapper around chrome.identity.getAuthToken.
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
 * Revoke an OAuth token (and its underlying SaveShot grant) at Google's OAuth server.
 * Used on Sign out so reconnecting opens Google's account chooser and consent prompt,
 * and when a user leaves the granular drive.file checkbox unchecked.
 */
async function revokeGoogleToken(token, fetchImpl = fetch, timeoutMs = 4000) {
  if (!token || typeof fetchImpl !== 'function') return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        signal: controller.signal,
      }
    );
    return Boolean(response?.ok);
  } catch {
    // Best-effort cleanup when offline or unreachable
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function purgeSessionToken(token, fetchImpl, { revoke = false } = {}) {
  const tasks = [];
  if (token) {
    tasks.push(removeCachedToken(token));
  }
  tasks.push(clearAllCachedTokens());
  if (revoke && token) {
    tasks.push(revokeGoogleToken(token, fetchImpl));
  }
  await Promise.allSettled(tasks);
}

/**
 * Evict all cached OAuth access tokens locally in Chrome, clear Chrome's cached
 * extension auth state, and revoke the OAuth grant at Google's server so the next
 * sign-in opens Google's account chooser and permission screen.
 */
async function evictAndRevokeTokens(
  extraTokens = [],
  { fetchImpl = fetch, timeoutMs = 2000, revokeTimeoutMs = 4000 } = {}
) {
  const tokensToClean = new Set(extraTokens.filter(Boolean));
  for (const tok of knownTokens) {
    tokensToClean.add(tok);
  }
  knownTokens.clear();

  try {
    const cached = await requestAuthToken({
      interactive: false,
      timeoutMs: Math.min(1500, timeoutMs),
    });
    if (cached) {
      tokensToClean.add(cached);
    }
    knownTokens.clear();
  } catch {
    // No cached token returned or lookup failed/timed out; continue with known tokens + full cache clear
  }

  const allTokens = Array.from(tokensToClean);

  await Promise.all([
    (async () => {
      await Promise.allSettled(
        allTokens.map((tok) => removeCachedToken(tok, timeoutMs))
      );
      await clearAllCachedTokens(timeoutMs);
    })(),
    Promise.allSettled(
      allTokens.map((tok) => revokeGoogleToken(tok, fetchImpl, revokeTimeoutMs))
    ),
  ]);
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
  timer?.unref?.();

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

async function abortSupersededSignIn(token, fetchImpl, shouldRevoke) {
  await purgeSessionToken(token, fetchImpl, { revoke: shouldRevoke });
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
    await abortSupersededSignIn(token, fetchImpl, signOutEpoch > signInEpoch);
  }

  let profile = null;
  try {
    profile = await fetchGoogleUserInfo(token, fetchImpl);
  } catch (err) {
    if (signInEpoch !== authEpoch) {
      await abortSupersededSignIn(token, fetchImpl, signOutEpoch > signInEpoch);
    }
    if (err.code === 'DRIVE_SCOPE_MISSING') {
      await purgeSessionToken(token, fetchImpl, { revoke: true });
      await setAuthState({ signedOut: true, userProfile: null });
      throw err;
    }
    if (err.status === 401 || err.code === 'AUTH_REVOKED') {
      await removeCachedToken(token);
      token = await requestAuthToken({ interactive: true });
      if (signInEpoch !== authEpoch) {
        await abortSupersededSignIn(token, fetchImpl, signOutEpoch > signInEpoch);
      }
      try {
        profile = await fetchGoogleUserInfo(token, fetchImpl);
      } catch (retryErr) {
        if (signInEpoch !== authEpoch) {
          await abortSupersededSignIn(token, fetchImpl, signOutEpoch > signInEpoch);
        }
        if (retryErr.code === 'DRIVE_SCOPE_MISSING') {
          await purgeSessionToken(token, fetchImpl, { revoke: true });
          await setAuthState({ signedOut: true, userProfile: null });
        } else if (retryErr.status === 401) {
          await purgeSessionToken(token, fetchImpl, { revoke: false });
          await setAuthState({ signedOut: true, userProfile: null });
        }
        throw classifyAuthError(retryErr);
      }
    } else {
      throw classifyAuthError(err);
    }
  }

  if (signInEpoch !== authEpoch) {
    await abortSupersededSignIn(token, fetchImpl, signOutEpoch > signInEpoch);
  }

  await setAuthState({ signedOut: false, userProfile: profile });
  return { token, profile };
}

/**
 * Interactive sign-in via Chrome Identity and Google OAuth.
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

  if (signOutEpoch > startEpoch) {
    await purgeSessionToken(token, fetchImpl, { revoke: true });
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
    if (signOutEpoch > startEpoch || (await getAuthState()).signedOut) {
      await purgeSessionToken(token, fetchImpl, { revoke: true });
      return { signedIn: false, profile: null, needsSetup: false };
    }
    if (startEpoch !== authEpoch) {
      return { signedIn: false, profile: null, needsSetup: false };
    }
    await setAuthState({ signedOut: false, userProfile: liveProfile });
    return { signedIn: true, profile: liveProfile, needsSetup: false };
  } catch (err) {
    if (signOutEpoch > startEpoch) {
      await purgeSessionToken(token, fetchImpl, { revoke: true });
      return { signedIn: false, profile: null, needsSetup: false };
    }
    if (startEpoch !== authEpoch) {
      return { signedIn: false, profile: null, needsSetup: false };
    }
    if (err.code === 'DRIVE_SCOPE_MISSING') {
      await purgeSessionToken(token, fetchImpl, { revoke: true });
      await setAuthState({ signedOut: true, userProfile: null });
      return { signedIn: false, profile: null, needsSetup: false };
    }
    if (err.status === 401 || err.code === 'AUTH_REVOKED') {
      await removeCachedToken(token);
      // Retry once silently so expired 1-hour access tokens rotate seamlessly after laptop sleep
      let refreshedToken = null;
      try {
        refreshedToken = await requestAuthToken({ interactive: false });
        if (signOutEpoch > startEpoch || (await getAuthState()).signedOut) {
          await purgeSessionToken(refreshedToken, fetchImpl, { revoke: true });
          return { signedIn: false, profile: null, needsSetup: false };
        }
        if (startEpoch !== authEpoch) {
          return { signedIn: false, profile: null, needsSetup: false };
        }
        const refreshedProfile = await fetchGoogleUserInfo(
          refreshedToken,
          fetchImpl,
          5000
        );
        if (signOutEpoch > startEpoch || (await getAuthState()).signedOut) {
          await purgeSessionToken(refreshedToken, fetchImpl, { revoke: true });
          return { signedIn: false, profile: null, needsSetup: false };
        }
        if (startEpoch !== authEpoch) {
          return { signedIn: false, profile: null, needsSetup: false };
        }
        await setAuthState({ signedOut: false, userProfile: refreshedProfile });
        return { signedIn: true, profile: refreshedProfile, needsSetup: false };
      } catch (retryErr) {
        if (
          !refreshedToken ||
          retryErr?.status === 401 ||
          retryErr?.code === 'AUTH_REVOKED' ||
          retryErr?.code === 'DRIVE_SCOPE_MISSING'
        ) {
          await purgeSessionToken(refreshedToken, fetchImpl, {
            revoke: retryErr?.code === 'DRIVE_SCOPE_MISSING',
          });
          await setAuthState({ signedOut: true, userProfile: null });
          return { signedIn: false, profile: null, needsSetup: false };
        }
      }
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
 * Rotates expired 1-hour access tokens silently and detects revoked grants while tolerating offline mode.
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
 * Sign out locally, clear Chrome's cached OAuth tokens, and revoke the OAuth grant
 * at Google's server so the next sign-in opens Google's account chooser and consent prompt.
 */
export async function signOut(optionsOrFetch = {}) {
  const opts =
    typeof optionsOrFetch === 'function'
      ? { fetchImpl: optionsOrFetch }
      : optionsOrFetch || {};
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch;
  const timeoutMs =
    Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 2000;
  const revokeTimeoutMs =
    Number.isFinite(opts.revokeTimeoutMs) && opts.revokeTimeoutMs > 0
      ? opts.revokeTimeoutMs
      : opts.timeoutMs !== undefined
      ? timeoutMs
      : 4000;

  authEpoch += 1;
  signOutEpoch = authEpoch;
  inflightSilentSession = null;
  inflightSignIn = null;

  const priorTokens = Array.from(knownTokens);
  knownTokens.clear();

  // Persist signed-out state immediately AND evict/revoke tokens with failure and timeout resilience
  await Promise.all([
    setAuthState({ signedOut: true, userProfile: null, clearHistory: true }),
    evictAndRevokeTokens(priorTokens, { fetchImpl, timeoutMs, revokeTimeoutMs }),
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
  if ((signedOut || signOutEpoch > startEpoch) && !interactive) {
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

  if (signOutEpoch > startEpoch) {
    await purgeSessionToken(token, fetchImpl, { revoke: true });
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
      await purgeSessionToken(token, fetchImpl, { revoke: true });
      await setAuthState({ signedOut: true, userProfile: null });
      throw err;
    }

    if (err && (err.status === 401 || err.code === 'AUTH_REVOKED')) {
      const removedOk = await removeCachedToken(token);
      if (signOutEpoch > startEpoch || (await getAuthState()).signedOut) {
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
        if (signOutEpoch > startEpoch) {
          await purgeSessionToken(refreshedToken, fetchImpl, { revoke: true });
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
          await purgeSessionToken(refreshedToken, fetchImpl, { revoke: true });
        } else if (refreshedToken && classified.status === 401) {
          await purgeSessionToken(refreshedToken, fetchImpl, { revoke: false });
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
