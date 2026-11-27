export const VALID_THEMES = Object.freeze(['auto', 'light', 'dark']);

export function normalizeTheme(value) {
  return value === 'light' || value === 'dark' ? value : 'auto';
}

const THEME_STORAGE_KEY = 'ss_theme';

export function applyDocumentTheme(theme, doc = globalThis.document) {
  const root = doc?.documentElement;
  if (!root) return 'auto';
  const normalized = normalizeTheme(theme);
  if (normalized === 'auto') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = normalized;
  }
  try {
    if (typeof globalThis.localStorage?.setItem === 'function') {
      if (normalized === 'auto') {
        globalThis.localStorage.removeItem(THEME_STORAGE_KEY);
      } else {
        globalThis.localStorage.setItem(THEME_STORAGE_KEY, normalized);
      }
    }
  } catch {
    // Ignore restricted storage contexts
  }
  return normalized;
}

export function didAuthProfileVisiblyChange(changes) {
  if (!changes || typeof changes !== 'object') return false;
  if (
    Object.hasOwn(changes, 'signedOut') &&
    Boolean(changes.signedOut?.oldValue) !== Boolean(changes.signedOut?.newValue)
  ) {
    return true;
  }
  if (Object.hasOwn(changes, 'userProfile')) {
    const prev = changes.userProfile?.oldValue || null;
    const next = changes.userProfile?.newValue || null;
    if (Boolean(prev) !== Boolean(next)) return true;
    if (prev && next) {
      if (
        (prev.email || '') !== (next.email || '') ||
        (prev.name || '') !== (next.name || '') ||
        (prev.picture || '') !== (next.picture || '')
      ) {
        return true;
      }
    }
  }
  return false;
}

export function initThemeSync(onThemeChange = null, { skipInitialRead = false } = {}) {
  const apply = (raw) => {
    const next = applyDocumentTheme(raw);
    if (typeof onThemeChange === 'function') {
      onThemeChange(next);
    }
  };

  if (!skipInitialRead && chrome?.storage?.local?.get) {
    chrome.storage.local
      .get('settings')
      .then((res) => apply(res?.settings?.theme))
      .catch(() => {});
  }

  if (chrome?.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.settings?.newValue) {
        const nextTheme = normalizeTheme(changes.settings.newValue.theme);
        const prevTheme = changes.settings.oldValue
          ? normalizeTheme(changes.settings.oldValue.theme)
          : null;
        if (prevTheme === null || nextTheme !== prevTheme) {
          apply(nextTheme);
        }
      }
    });
  }
}

export function safeHttpsUrl(url, fallback = '') {
  if (typeof url !== 'string' || !url) return fallback;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.href : fallback;
  } catch {
    return fallback;
  }
}

export function formatShortcutDisplay(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\s*\+\s*/g, ' + ');
}

export function sendRuntimeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error('No response from background service worker.'));
        return;
      }
      resolve(response);
    });
  });
}
