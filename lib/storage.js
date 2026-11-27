import { normalizeTheme } from './ui.js';

export const VALID_AUTO_COPY_MODES = Object.freeze(['image', 'link', 'off']);

export function normalizeAutoCopyMode(value, fallback = 'image') {
  return typeof value === 'string' && VALID_AUTO_COPY_MODES.includes(value)
    ? value
    : fallback;
}

export const DEFAULT_SETTINGS = {
  folderName: 'Chrome_SaveShot_ScreenShots',
  folderId: null,
  folderWebViewLink: null,
  folderCacheByEmail: {},
  autoCopyMode: 'image',
  autoCopyLink: false,
  editBeforeUpload: false,
  theme: 'auto',
};

export const MAX_RECENT_UPLOADS = 8;
const MAX_CACHED_ACCOUNTS = 5;

function normalizeEmailKey(email) {
  return String(email || '').trim().toLowerCase();
}

export const normalizeThemeSetting = normalizeTheme;

export function sanitizeFolderName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trim()
    .slice(0, 80);
  return cleaned || DEFAULT_SETTINGS.folderName;
}

function capAccountCache(rawCache) {
  const entries = Object.entries(rawCache || {}).filter(
    ([k, v]) => k && v && typeof v === 'object' && !Array.isArray(v)
  );
  const sliced = entries.slice(-MAX_CACHED_ACCOUNTS);
  return Object.fromEntries(sliced);
}

export function normalizeSettingsObject(settings) {
  const raw =
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? settings
      : {};
  const rawCache =
    raw.folderCacheByEmail &&
    typeof raw.folderCacheByEmail === 'object' &&
    !Array.isArray(raw.folderCacheByEmail)
      ? capAccountCache(raw.folderCacheByEmail)
      : {};

  let autoCopyMode;
  if (raw.autoCopyMode !== undefined) {
    autoCopyMode = normalizeAutoCopyMode(raw.autoCopyMode, DEFAULT_SETTINGS.autoCopyMode);
  } else if (raw.autoCopyLink === false) {
    autoCopyMode = 'off';
  } else {
    autoCopyMode = DEFAULT_SETTINGS.autoCopyMode;
  }

  return {
    folderName: sanitizeFolderName(raw.folderName ?? DEFAULT_SETTINGS.folderName),
    folderId: typeof raw.folderId === 'string' && raw.folderId ? raw.folderId : null,
    folderWebViewLink:
      typeof raw.folderWebViewLink === 'string' && raw.folderWebViewLink
        ? raw.folderWebViewLink
        : null,
    folderCacheByEmail: rawCache,
    autoCopyMode,
    autoCopyLink: autoCopyMode === 'link',
    editBeforeUpload: Boolean(raw.editBeforeUpload ?? DEFAULT_SETTINGS.editBeforeUpload),
    theme: normalizeThemeSetting(raw.theme),
  };
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return normalizeSettingsObject(settings);
}

export async function getExtensionStateSnapshot() {
  const data = await chrome.storage.local.get([
    'settings',
    'recentUploads',
    'signedOut',
    'userProfile',
  ]);
  return {
    settings: normalizeSettingsObject(data?.settings),
    recentUploads: Array.isArray(data?.recentUploads) ? data.recentUploads : [],
    authState: {
      signedOut: Boolean(data?.signedOut),
      userProfile: data?.userProfile || null,
    },
  };
}

export function getAccountFolderCache(settings, email) {
  const key = normalizeEmailKey(email);
  if (!key) {
    return {
      folderId: settings?.folderId || null,
      folderWebViewLink: settings?.folderWebViewLink || null,
    };
  }
  const entry = settings?.folderCacheByEmail?.[key];
  if (!entry || entry.folderName !== settings?.folderName) {
    return { folderId: null, folderWebViewLink: null };
  }
  return {
    folderId: entry.folderId || null,
    folderWebViewLink: entry.folderWebViewLink || null,
  };
}

let settingsWriteQueue = Promise.resolve();

function enqueueSettingsWrite(fn) {
  const next = settingsWriteQueue.then(fn, fn);
  settingsWriteQueue = next.catch(() => {});
  return next;
}

export function saveAccountFolderCache(email, { folderName, folderId, folderWebViewLink }) {
  return enqueueSettingsWrite(async () => {
    const current = await getSettings();
    const safeName = sanitizeFolderName(folderName);
    const key = normalizeEmailKey(email);
    const nextCache = { ...current.folderCacheByEmail };

    if (key) {
      delete nextCache[key];
      nextCache[key] = { folderName: safeName, folderId, folderWebViewLink };
    }

    const next = {
      ...current,
      folderName: safeName,
      folderId,
      folderWebViewLink,
      folderCacheByEmail: capAccountCache(nextCache),
    };
    await chrome.storage.local.set({ settings: next });
    return next;
  });
}

export function updateSettings(patch) {
  return enqueueSettingsWrite(async () => {
    const safePatch =
      patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const current = await getSettings();
    const next = { ...current };

    if (safePatch.autoCopyMode !== undefined) {
      next.autoCopyMode = normalizeAutoCopyMode(safePatch.autoCopyMode, current.autoCopyMode);
      next.autoCopyLink = next.autoCopyMode === 'link';
    } else if (safePatch.autoCopyLink !== undefined) {
      next.autoCopyMode = Boolean(safePatch.autoCopyLink) ? 'link' : 'off';
      next.autoCopyLink = next.autoCopyMode === 'link';
    }
    if (safePatch.editBeforeUpload !== undefined) {
      next.editBeforeUpload = Boolean(safePatch.editBeforeUpload);
    }
    if (safePatch.theme !== undefined) {
      next.theme = normalizeThemeSetting(safePatch.theme);
    }

    if (safePatch.folderName !== undefined) {
      const cleaned = sanitizeFolderName(safePatch.folderName);
      next.folderName = cleaned;
      if (cleaned !== current.folderName) {
        const auth = await getAuthState();
        const restored = getAccountFolderCache(next, auth.userProfile?.email);
        next.folderId = restored.folderId;
        next.folderWebViewLink = restored.folderWebViewLink;
      }
    }

    await chrome.storage.local.set({ settings: next });
    return next;
  });
}

/**
 * Store only minimal fields per upload to keep chrome.storage.local tiny (< 10 KB total).
 */
function compactUploadRecord(item) {
  const mode =
    item.mode === 'region' || item.mode === 'fullpage' ? item.mode : 'visible';
  return {
    id: item.id,
    name: item.name || '',
    webViewLink: item.webViewLink || '',
    createdTime: item.createdTime || '',
    pageTitle: (item.pageTitle || '').slice(0, 80),
    mode,
    thumbnailDataUrl: item.thumbnailDataUrl || '',
  };
}

async function persistRecentUploads(list) {
  try {
    await chrome.storage.local.set({ recentUploads: list });
    return list;
  } catch {
    const slim = list.slice(0, 4).map((x, i) =>
      i === 0 ? x : { ...x, thumbnailDataUrl: '' }
    );
    try {
      await chrome.storage.local.set({ recentUploads: slim });
      return slim;
    } catch {
      const textOnly = slim.map((x) => ({ ...x, thumbnailDataUrl: '' }));
      await chrome.storage.local.set({ recentUploads: textOnly }).catch(() => {});
      return textOnly;
    }
  }
}

export async function getRecentUploads() {
  const { recentUploads } = await chrome.storage.local.get('recentUploads');
  return Array.isArray(recentUploads) ? recentUploads : [];
}

export async function addRecentUpload(item) {
  const existing = await getRecentUploads();
  const entry = compactUploadRecord(item);
  const updated = [entry, ...existing.filter((x) => x.id !== entry.id)].slice(
    0,
    MAX_RECENT_UPLOADS
  );
  return persistRecentUploads(updated);
}

export async function updateRecentUpload(fileId, patch = {}) {
  if (!fileId) return getRecentUploads();
  const existing = await getRecentUploads();
  let found = false;
  const updated = existing.map((item) => {
    if (item.id !== fileId) return item;
    found = true;
    return compactUploadRecord({ ...item, ...patch, id: item.id });
  });
  if (!found) return existing;
  return persistRecentUploads(updated);
}

export async function clearRecentUploads() {
  await chrome.storage.local.set({ recentUploads: [] });
}

export async function pruneStorage() {
  const [recent, settings] = await Promise.all([getRecentUploads(), getSettings()]);
  const trimmedRecent = recent.slice(0, MAX_RECENT_UPLOADS).map(compactUploadRecord);
  await chrome.storage.local.set({ recentUploads: trimmedRecent, settings });
}

export async function getAuthState() {
  const { signedOut, userProfile } = await chrome.storage.local.get([
    'signedOut',
    'userProfile',
  ]);
  return {
    signedOut: Boolean(signedOut),
    userProfile: userProfile || null,
  };
}

export async function setAuthState({ signedOut, userProfile, clearHistory = false }) {
  const payload = {};
  if (signedOut !== undefined) payload.signedOut = Boolean(signedOut);
  if (userProfile !== undefined) payload.userProfile = userProfile;
  if (clearHistory) payload.recentUploads = [];

  if (signedOut === true) {
    const current = await getSettings();
    if (current.folderId !== null || current.folderWebViewLink !== null) {
      payload.settings = { ...current, folderId: null, folderWebViewLink: null };
    }
  } else if (userProfile?.email) {
    const current = await getSettings();
    const acctCache = getAccountFolderCache(current, userProfile.email);
    if (
      current.folderId !== acctCache.folderId ||
      current.folderWebViewLink !== acctCache.folderWebViewLink
    ) {
      payload.settings = {
        ...current,
        folderId: acctCache.folderId,
        folderWebViewLink: acctCache.folderWebViewLink,
      };
    }
  }

  try {
    await chrome.storage.local.set(payload);
  } catch (err) {
    if (signedOut === true) {
      await chrome.storage.local.remove(['userProfile', 'recentUploads']).catch(() => {});
      try {
        await chrome.storage.local.set({
          signedOut: true,
          userProfile: null,
          recentUploads: [],
          ...(payload.settings ? { settings: payload.settings } : {}),
        });
      } catch {
        await chrome.storage.local.set({
          signedOut: true,
          userProfile: null,
          recentUploads: [],
        });
      }
      return;
    }
    throw err;
  }
}
