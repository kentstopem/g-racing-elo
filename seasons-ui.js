// seasons-ui.js – Admin-Bereich „Saisons“: Backup, Ersteinrichtung, neue Saison starten
(function () {
  const { showToast, escapeHtml: esc } = window.Helpers;
  const S = window.Seasons;
  const root = () => document.getElementById('seasonAdmin');

  const CROWN = /\s*👑️?/gu;
  const todayIso = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const isoFromRaceDate = r => {
    const [d, m, y] = (r.date || '').split('.');
    return y ? `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}` : '2025-01-01';
  };
  const fmt = iso => { const [y, m, d] = iso.split('-'); return `${+d}.${+m}.${y}`; };

  // ---------- Backup ----------
  async function downloadBackup () {
    showToast('Backup wird erstellt …');
    const data = await window.Storage.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `GRP-Backup_${todayIso()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    const n = ['drivers', 'cars', 'races', 'lapRecords', 'seasons', 'tracks'].map(k => `${data[k].length} ${k}`).join(', ');
    showToast(`Backup gespeichert (${n})`);
    return data;
  }

  // ---------- Ersteinrichtung ----------
  async function setupFirstSeason () {
    if (!window.isAdmin) return;
    const races = window.appData.allRaces || [];
    const first = window.Elo.sortChronologically(races)[0];
    const start = first ? isoFromRaceDate(first) : todayIso();
    const crowned = window.appData.drivers.filter(d => /👑/u.test(d.name));
    const msg = `Ersteinrichtung:\n\n• Strecke „Circuit du Garage“ (CDG) anlegen\n• Saison „2025/26“ ab ${fmt(start)} anlegen – alle ${races.length} Rennen gehören dazu\n• Kronen aus ${crowned.length} Fahrernamen entfernen\n\nVorher wird automatisch ein Backup heruntergeladen. Fortfahren?`;
    if (!confirm(msg)) return;
    try {
      await downloadBackup();
      const strip = name => String(name || '').replace(CROWN, '').trim();
      const driverUpdates = window.appData.drivers
        .filter(d => strip(d.name) !== d.name)
        .map(d => [d.id, { name: strip(d.name) }]);
      const raceUpdates = races
        .filter(r => r.results.some(res => strip(res.driverName) !== res.driverName))
        .map(r => [r.id, { results: r.results.map(res => ({ ...res, driverName: strip(res.driverName) })) }]);
      await window.Storage.setupSeasons({
        track:  { id: 'cdg', name: 'Circuit du Garage', short: 'CDG', createdAt: new Date().toISOString() },
        season: { id: '2025-26', name: '2025/26', start, trackId: 'cdg', createdAt: new Date().toISOString() },
        driverUpdates, raceUpdates
      });
      showToast('Saison 2025/26 eingerichtet');
    } catch (err) {
      console.error(err);
      showToast('⚠️ Einrichtung fehlgeschlagen – nichts wurde verändert, bitte erneut versuchen');
    }
  }

  // ---------- Neue Saison ----------
  async function startNewSeason (form) {
    if (!window.isAdmin) return;
    const name = form.seasonName.value.trim();
    const start = form.seasonStart.value;
    const trackChoice = form.seasonTrack.value;
    if (!name || !start) { showToast('Name und Startdatum angeben'); return; }
    if (S.list().some(s => s.name.toLowerCase() === name.toLowerCase())) { showToast('Diese Saison gibt es schon'); return; }
    if (S.hasSeasons() && start <= S.current().start) { showToast(`Start muss nach dem ${fmt(S.current().start)} liegen`); return; }

    let track = S.track(trackChoice);
    let newTrack = null;
    if (trackChoice === '__new') {
      const tName = form.trackName.value.trim();
      if (!tName) { showToast('Namen der neuen Strecke angeben'); return; }
      newTrack = { id: `t${Date.now()}`, name: tName, short: form.trackShort.value.trim() || null, createdAt: new Date().toISOString() };
      track = newTrack;
    }
    const later = (window.appData.allRaces || []).filter(r => window.Helpers.tsForRace(r) >= new Date(`${start}T00:00:00`).getTime()).length;
    const msg = `Saison „${name}“ ab ${fmt(start)} auf „${track.name}“ starten?\n\n• Alle Fahrer und Fahrzeuge beginnen bei 1000 G!RP\n• ${newTrack ? 'Neue Rekordliste für die neue Strecke' : 'Rekorde der Strecke laufen weiter'}\n• Bisherige Saisons bleiben vollständig erhalten` +
      (later ? `\n\n⚠️ ${later} bereits erfasste Rennen ab diesem Datum zählen dann zur neuen Saison.` : '');
    if (!confirm(msg)) return;
    try {
      if (newTrack) await window.Storage.addTrack(newTrack);
      await window.Storage.addSeason({ id: `s${Date.now()}`, name, start, trackId: track.id, createdAt: new Date().toISOString() });
      window.Seasons.select(null);
      showToast(`Saison ${name} gestartet – alle starten bei 1000 G!RP`);
      form.reset();
    } catch (err) {
      console.error(err);
      showToast('⚠️ Saison konnte nicht angelegt werden');
    }
  }

  // ---------- Darstellung ----------
  function render () {
    const el = root();
    if (!el) return;
    const all = window.appData.allRaces || [];
    const countFor = id => all.filter(r => S.seasonOfRace(r) === id).length;

    if (!S.hasSeasons()) {
      el.innerHTML = `
        <div class="card" style="margin-bottom:16px;">
          <h3>Ersteinrichtung</h3>
          <p class="muted" style="margin-bottom:12px;">Legt die Strecke „Circuit du Garage“ und die Saison „2025/26“ an, ordnet alle ${all.length} bisherigen Rennen dieser Saison zu und entfernt die Kronen aus den Fahrernamen. Vorher wird automatisch ein Backup heruntergeladen. Es wird nichts gelöscht.</p>
          <button class="btn btn-primary" id="setupSeasonsBtn">Saison 2025/26 einrichten</button>
        </div>
        <button class="btn" id="backupBtn">⬇️ Backup herunterladen</button>`;
      el.querySelector('#setupSeasonsBtn').onclick = setupFirstSeason;
      el.querySelector('#backupBtn').onclick = () => downloadBackup().catch(err => { console.error(err); showToast('⚠️ Backup fehlgeschlagen'); });
      return;
    }

    const rows = [...S.list()].reverse().map(s => {
      const t = S.track(s.trackId);
      const isCur = s.id === S.current().id;
      return `<tr><td><strong>${esc(s.name)}</strong>${isCur ? ' <span class="badge">aktuell</span>' : ''}</td><td>${fmt(s.start)}</td><td>${esc(t ? t.name : '–')}</td><td>${countFor(s.id)}</td></tr>`;
    }).join('');
    const trackOpts = S.tracks().map(t => `<option value="${t.id}" ${t.id === S.current().trackId ? 'selected' : ''}>${esc(t.name)}</option>`).join('');

    el.innerHTML = `
      <table class="record-table" style="margin-bottom:24px;">
        <thead><tr><th>Saison</th><th>Start</th><th>Strecke</th><th>Rennen</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>

      <form class="card" id="newSeasonForm" style="margin-bottom:16px;">
        <h3>Neue Saison starten</h3>
        <div class="race-meta-grid" style="grid-template-columns:1fr 1fr;">
          <div class="form-group"><label for="seasonName">Name</label><input id="seasonName" name="seasonName" placeholder="z. B. 2026/27" required></div>
          <div class="form-group"><label for="seasonStart">Start</label><input type="date" id="seasonStart" name="seasonStart" value="${todayIso()}" required></div>
        </div>
        <div class="form-group"><label for="seasonTrack">Strecke</label>
          <select id="seasonTrack" name="seasonTrack">${trackOpts}<option value="__new">+ Neue Strecke …</option></select>
        </div>
        <div id="newTrackFields" class="race-meta-grid hidden" style="grid-template-columns:2fr 1fr;">
          <div class="form-group"><label for="trackName">Name der neuen Strecke</label><input id="trackName" name="trackName"></div>
          <div class="form-group"><label for="trackShort">Kürzel</label><input id="trackShort" name="trackShort" maxlength="6"></div>
        </div>
        <button class="btn btn-primary" type="submit">Saison starten</button>
      </form>

      <button class="btn" id="backupBtn">⬇️ Backup herunterladen</button>`;

    const form = el.querySelector('#newSeasonForm');
    form.seasonTrack.onchange = () => el.querySelector('#newTrackFields').classList.toggle('hidden', form.seasonTrack.value !== '__new');
    form.onsubmit = e => { e.preventDefault(); startNewSeason(form); };
    el.querySelector('#backupBtn').onclick = () => downloadBackup().catch(err => { console.error(err); showToast('⚠️ Backup fehlgeschlagen'); });
  }

  window.SeasonsUI = { render, downloadBackup };
})();
