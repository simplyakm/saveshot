try {
  const theme = localStorage.getItem('ss_theme');
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
  }
} catch {
  // Ignore unavailable localStorage in restricted contexts
}
