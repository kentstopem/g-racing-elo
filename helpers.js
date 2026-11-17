(function(){
  // Linien-Icon aus dem SVG-Sprite in index.html (statt Emoji)
  function icon(name) {
    return `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  }

  // showToast(text, 4000) oder showToast(text, { icon: 'alert', duration })
  function showToast(message, opts = 4000) {
    const { duration = 4000, icon: ic } = typeof opts === 'number' ? { duration: opts } : opts;
    const t = document.createElement('div');
    t.className = 'toast';
    if (ic) t.innerHTML = icon(ic);
    t.append(message);
    document.body.appendChild(t);
    // kleine Verzögerung, damit das Element gerendert ist
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, duration);
  }

  // Timestamp-Helper für chronologische Sortierung von Rennen
  function tsForRace(r) {
    const dateStr = r.date || '01.01.1970';
    const dParts = dateStr.split('.');
    const iso = dParts.length === 3 ? `${dParts[2]}-${dParts[1].padStart(2, '0')}-${dParts[0].padStart(2, '0')}` : dateStr;
    const timeStr = (r.time || '00:00').replace(/[^0-9:]/g, '');
    return new Date(`${iso}T${timeStr}:00`).getTime();
  }

  // Text sicher in HTML einsetzen (Namen etc.)
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }

  // Feature Flags pro Gerät (localStorage), standardmäßig aus.
  // Einschalten: Seite mit ?feature=live öffnen, ausschalten mit ?feature=-live
  const FEATURE_KEY = 'grpFeatures';
  function readFeatures() {
    try { return JSON.parse(localStorage.getItem(FEATURE_KEY) || '[]'); } catch (e) { return []; }
  }
  function setFeature(name, on) {
    const set = new Set(readFeatures());
    on ? set.add(name) : set.delete(name);
    try { localStorage.setItem(FEATURE_KEY, JSON.stringify([...set])); } catch (e) {}
  }
  // Dauerhaft freigeschaltet (live seit 17.11.2026: Setup, Livecenter, CU-Anbindung)
  const ALWAYS_ON = ['live'];
  function feature(name) { return ALWAYS_ON.includes(name) || readFeatures().includes(name); }
  try {
    const params = new URLSearchParams(location.search);
    params.getAll('feature').forEach(f => f.startsWith('-') ? setFeature(f.slice(1), false) : setFeature(f, true));
  } catch (e) {}

  window.Helpers = { showToast, tsForRace, escapeHtml, icon, feature, setFeature };
})(); 