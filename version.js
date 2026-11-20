// version.js – Versionsanzeige „3.2.r<Release>“
// APP_VERSION_BASE pflegst du von Hand (z. B. '2.1' bei größeren Änderungen).
// APP_RELEASE setzt der GitHub-Workflow beim Veröffentlichen automatisch auf die
// Anzahl der Commits in main (git rev-list --count HEAD). Lokal bleibt es null → „dev“.
window.APP_VERSION_BASE = '3.2';
window.APP_RELEASE = null;
window.APP_VERSION = `${window.APP_VERSION_BASE}.r${window.APP_RELEASE ?? 'dev'}`;
// Sofort in die Fußzeile schreiben (das Skript steht nach der Fußzeile), damit beim Laden keine alte Nummer aufblitzt
{ const el = document.getElementById('appVersion'); if (el) el.textContent = window.APP_VERSION; }
