// version.js – Versionsanzeige „2.0.r<Release>“
// APP_VERSION_BASE pflegst du von Hand (z. B. '2.1' bei größeren Änderungen).
// APP_RELEASE setzt der GitHub-Workflow beim Veröffentlichen automatisch auf die
// Anzahl der Commits in main (git rev-list --count HEAD). Lokal bleibt es null → „dev“.
window.APP_VERSION_BASE = '2.1';
window.APP_RELEASE = null;
window.APP_VERSION = `${window.APP_VERSION_BASE}.r${window.APP_RELEASE ?? 'dev'}`;
