(function(){
  function showToast(message, duration = 2500) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = message;
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

  window.Helpers = { showToast, tsForRace };
})(); 