export const DEFAULT_SETTINGS = {
  folderName: 'Chrome_SaveShot_ScreenShots',
  folderId: null,
  folderWebViewLink: null,
  folderCacheByEmail: {},
  autoCopyLink: true,
  editBeforeUpload: false,
};

export const MAX_RECENT_UPLOADS = 8;
const MAX_CACHED_ACCOUNTS = 5;

function normalizeEmailKey(email) {
  return String(email || '').trim().toLowerCase();
}

export function sanitizeFolderName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trim()
    .slice(0, 80);
  return cleaned || DEFAULT_SETTINGS.folderName;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const raw =
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? settings
      : {};
  const rawCache =
    raw.folderCacheByEmail &&
    typeof raw.folderCacheByEmail === 'object' &&
    !Array.isArray(raw.folderCacheByEmail)
      ? raw.folderCacheByEmail
      : {};
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    folderName: sanitizeFolderName(raw.folderName ?? DEFAULT_SETTINGS.folderName),
    folderCacheByEmail: { ...rawCache },
    autoCopyLink: Boolean(raw.autoCopyLink ?? DEFAULT_SETTINGS.autoCopyLink),
    editBeforeUpload: Boolean(raw.editBeforeUpload ?? DEFAULT_SETTINGS.editBeforeUpload),
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

export async function saveAccountFolderCache(email, { folderName, folderId, folderWebViewLink }) {
  const current = await getSettings();
  const safeName = sanitizeFolderName(folderName);
  const key = normalizeEmailKey(email);
  const nextCache = { ...current.folderCacheByEmail };

  if (key) {
    delete nextCache[key];
    nextCache[key] = { folderName: safeName, folderId, folderWebViewLink };
    const keys = Object.keys(nextCache);
    while (keys.length > MAX_CACHED_ACCOUNTS) {
      delete nextCache[keys.shift()];
    }
  }

  const next = {
    ...current,
    folderName: safeName,
    folderId,
    folderWebViewLink,
    folderCacheByEmail: nextCache,
  };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function updateSettings(patch) {
  const safePatch =
    patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const [current, auth] = await Promise.all([getSettings(), getAuthState()]);
  const next = { ...current };

  if (safePatch.autoCopyLink !== undefined) {
    next.autoCopyLink = Boolean(safePatch.autoCopyLink);
  }
  if (safePatch.editBeforeUpload !== undefined) {
    next.editBeforeUpload = Boolean(safePatch.editBeforeUpload);
  }

  if (safePatch.folderName !== undefined) {
    const cleaned = sanitizeFolderName(safePatch.folderName);
    next.folderName = cleaned;
    if (cleaned !== current.folderName) {
      const restored = getAccountFolderCache(next, auth.userProfile?.email);
      next.folderId = restored.folderId;
      next.folderWebViewLink = restored.folderWebViewLink;
    }
  }

  await chrome.storage.local.set({ settings: next });
  return next;
}

/**
 * Store only minimal fields per upload to keep chrome.storage.local tiny (< 10 KB total).
 */
function compactUploadRecord(item) {
  return {
    id: item.id,
    name: item.name || '',
    webViewLink: item.webViewLink || '',
    createdTime: item.createdTime || '',
    pageTitle: (item.pageTitle || '').slice(0, 80),
    mode: item.mode === 'region' ? 'region' : 'visible',
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

export async function setAuthState({ signedOut, userProfile }) {
  const payload = {};
  if (signedOut !== undefined) payload.signedOut = Boolean(signedOut);
  if (userProfile !== undefined) payload.userProfile = userProfile;

  if (signedOut === true) {
    const current = await getSettings();
    payload.settings = { ...current, folderId: null, folderWebViewLink: null };
  } else if (userProfile?.email) {
    const current = await getSettings();
    const acctCache = getAccountFolderCache(current, userProfile.email);
    payload.settings = {
      ...current,
      folderId: acctCache.folderId,
      folderWebViewLink: acctCache.folderWebViewLink,
    };
  }

  await chrome.storage.local.set(payload);
}
