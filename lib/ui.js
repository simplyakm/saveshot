export const VALID_THEMES = Object.freeze(['auto', 'light', 'dark']);

export function normalizeTheme(value) {
  return value === 'light' || value === 'dark' ? value : 'auto';
}

export function applyDocumentTheme(theme, doc = globalThis.document) {
  const root = doc?.documentElement;
  if (!root) return 'auto';
  const normalized = normalizeTheme(theme);
  if (normalized === 'auto') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = normalized;
  }
  return normalized;
}

export function initThemeSync(onThemeChange = null) {
  const apply = (raw) => {
    const next = applyDocumentTheme(raw);
    if (typeof onThemeChange === 'function') {
      onThemeChange(next);
    }
  };

  if (chrome?.storage?.local?.get) {
    chrome.storage.local
      .get('settings')
      .then((res) => apply(res?.settings?.theme))
      .catch(() => {});
  }

  if (chrome?.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.settings?.newValue) {
        apply(changes.settings.newValue.theme);
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
