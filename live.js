// live.js – Live-Zeitnahme direkt von der Control Unit (Feature Flag "live", nur Admin)
//
// Ablauf: CU per Bluetooth verbinden (Bluefy auf iPad/iPhone, Chrome am Mac) →
// Regler den Fahrern und Fahrzeugen zuordnen → fahren → neue Rekorde übernehmen.
// Gespeichert wird nur, was der Admin beim Übernehmen bestätigt (über RecordsUI.persistRecord).

(function () {
  const { escapeHtml: esc, showToast, icon } = window.Helpers;
  const ASSIGN_KEY = 'liveAssign';
  const CONTROLLERS = [1, 2, 3, 4, 5, 6];

  let root = null;
  let conn = null;
  let state = 'idle';           // idle | connecting | connected | lost
  let tracker = new CU.LapTracker();
  let bests = {};               // Bestzeiten des Abends je Fahrer+Fahrzeug
  let lastStatus = null;
  let flash = null;
  let wakeLock = null;
  let assignment = loadAssignment();
  let rendered = false;

  function loadAssignment () {
    try { return JSON.parse(localStorage.getItem(ASSIGN_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveAssignment () {
    try { localStorage.setItem(ASSIGN_KEY, JSON.stringify(assignment)); } catch (e) {}
  }

  const fmt = ms => (ms == null ? '–' : (ms / 1000).toFixed(3));
  const drivers = () => [...window.appData.drivers].filter(d => !d.archived).sort((a, b) => a.name.localeCompare(b.name));
  const cars = () => [...window.appData.cars].filter(c => !c.archived).sort((a, b) => a.name.localeCompare(b.name));
  const driverName = id => window.appData.drivers.find(d => d.id === id)?.name ?? '?';
  const carName = id => window.appData.cars.find(c => c.id === id)?.name ?? '?';
  const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const todayTrack = () => window.Seasons.seasonAt(new Date(`${todayIso()}T12:00:00`).getTime()).trackId ?? null;

  // aktueller Rekord (Sekunden) für Fahrer+Fahrzeug auf der heutigen Strecke
  function recordFor (driverId, carId) {
    const track = todayTrack();
    const hits = (window.appData.lapRecords || [])
      .filter(r => r.driverId === driverId && r.carId === carId && window.Seasons.trackOfRecord(r) === track);
    return hits.length ? Math.min(...hits.map(r => r.time)) : null;
  }

  function candidates () {
    return CU.recordCandidates(bests, window.appData.lapRecords || [], todayTrack(), window.Seasons.trackOfRecord);
  }

  // ---------- Darstellung ----------

  function render () {
    root = root || document.getElementById('liveRoot');
    if (!root) return;
    if (!rendered) {
      root.innerHTML = `
        <div class="live-card">
          <div class="live-conn">
            <span id="liveState" class="live-state"></span>
            <div class="live-actions">
              <button class="btn btn-primary" id="liveConnect">Mit CU verbinden</button>
              <button class="btn" id="liveDisconnect">Trennen</button>
            </div>
          </div>
          <p id="liveHint" class="live-hint"></p>
        </div>

        <div class="live-card">
          <div class="live-head">
            <h3>Regler zuordnen</h3>
            <button class="btn" id="liveFromDraft" title="Fahrer und Fahrzeuge aus „Neues Rennen“ der Reihe nach auf Regler 1, 2, 3 … legen">${icon('shuffle')}Aus „Neues Rennen“</button>
          </div>
          <div id="liveAssign" class="live-assign"></div>
        </div>

        <div class="live-card">
          <div class="live-head">
            <h3>Zeiten</h3>
            <button class="btn" id="liveReset">${icon('refresh')}Zurücksetzen</button>
          </div>
          <div id="liveBoard"></div>
        </div>

        <div class="live-card">
          <h3>Neue Rekorde</h3>
          <div id="liveRecords"></div>
        </div>`;
      root.querySelector('#liveConnect').addEventListener('click', connect);
      root.querySelector('#liveDisconnect').addEventListener('click', disconnect);
      root.querySelector('#liveReset').addEventListener('click', resetTimes);
      root.querySelector('#liveFromDraft').addEventListener('click', fromDraft);
      root.querySelector('#liveAssign').addEventListener('change', onAssignChange);
      root.querySelector('#liveRecords').addEventListener('click', onRecordsClick);
      rendered = true;
    }
    renderConn();
    renderAssign();
    renderBoard();
    renderRecords();
  }

  function renderConn () {
    const el = root.querySelector('#liveState');
    const hint = root.querySelector('#liveHint');
    const texts = { idle: 'Nicht verbunden', connecting: 'Verbinde …', connected: 'Verbunden', lost: 'Verbindung verloren' };
    el.textContent = texts[state];
    el.dataset.state = state;
    root.querySelector('#liveConnect').disabled = state === 'connecting' || state === 'connected' || !CU.Connection.available();
    root.querySelector('#liveDisconnect').disabled = state !== 'connected';
    if (!CU.Connection.available()) {
      hint.innerHTML = 'Dieser Browser kann kein Bluetooth. Auf iPad/iPhone G!RP in <b>Bluefy</b> öffnen, am Mac in Chrome.';
    } else if (state === 'connected' && lastStatus) {
      hint.textContent = `Startampel ${lastStatus.start} · ${lastStatus.mode & 4 ? 'Boxengasse erkannt' : 'ohne Boxengasse'}`;
    } else {
      hint.textContent = state === 'connected' ? '' : 'SmartRace vorher schließen – die CU nimmt nur eine Verbindung an.';
    }
  }

  function renderAssign () {
    const dOpts = drivers(), cOpts = cars();
    root.querySelector('#liveAssign').innerHTML = CONTROLLERS.map(n => {
      const a = assignment[n] || {};
      return `<div class="live-assign-row">
        <span class="live-ctrl">${n}</span>
        <select data-ctrl="${n}" data-kind="driverId" aria-label="Fahrer Regler ${n}">
          <option value="">– Fahrer –</option>
          ${dOpts.map(d => `<option value="${d.id}" ${d.id === a.driverId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select>
        <select data-ctrl="${n}" data-kind="carId" aria-label="Fahrzeug Regler ${n}">
          <option value="">– Fahrzeug –</option>
          ${cOpts.map(c => `<option value="${c.id}" ${c.id === a.carId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>`;
    }).join('');
  }

  function renderBoard () {
    const seen = Object.keys(tracker.cars).map(Number);
    const ctrls = [...new Set([...CONTROLLERS.filter(n => assignment[n]?.driverId), ...seen])].sort((a, b) => a - b);
    if (!ctrls.length) {
      root.querySelector('#liveBoard').innerHTML = '<p class="live-empty">Noch keine Durchfahrt. Regler zuordnen, verbinden und losfahren.</p>';
      return;
    }
    const rows = ctrls.map(n => {
      const c = tracker.cars[n] || {};
      const a = assignment[n] || {};
      const rec = a.driverId && a.carId ? recordFor(a.driverId, a.carId) : null;
      const beat = c.best != null && (rec == null || c.best / 1000 < rec);
      const who = a.driverId ? `${esc(driverName(a.driverId))}<small>${a.carId ? esc(carName(a.carId)) : 'kein Fahrzeug'}</small>` : '<span class="live-empty">nicht zugeordnet</span>';
      return `<tr class="${flash === n ? 'flash' : ''}">
        <td class="live-ctrl">${n}</td>
        <td class="live-who">${who}</td>
        <td>${c.laps ?? 0}</td>
        <td class="live-big">${fmt(c.last)}</td>
        <td class="${beat ? 'live-beat' : ''}">${fmt(c.best)}</td>
        <td>${rec == null ? '–' : rec.toFixed(3)}</td>
      </tr>`;
    }).join('');
    root.querySelector('#liveBoard').innerHTML = `<div class="live-table-wrap"><table class="live-table">
      <thead><tr><th>#</th><th>Fahrer</th><th>Rd.</th><th>Letzte</th><th>Beste</th><th>Rekord</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  function renderRecords () {
    const list = candidates();
    root.querySelector('#liveRecords').innerHTML = list.length
      ? `<ul class="live-rec-list">${list.map((c, i) => `<li>
          <label><input type="checkbox" data-idx="${i}" checked>
          <b>${esc(driverName(c.driverId))}</b> · ${esc(carName(c.carId))}:
          <b>${c.time.toFixed(3)} s</b> <small>${c.previous == null ? 'erster Rekord' : `bisher ${c.previous.toFixed(3)} s`}</small></label>
        </li>`).join('')}</ul>
        <button class="btn btn-primary" id="liveSaveRecords">${icon('medal')}Ausgewählte übernehmen</button>`
      : '<p class="live-empty">Noch keine neue Bestzeit gegenüber den gespeicherten Rekorden.</p>';
  }

  // ---------- Aktionen ----------

  async function connect () {
    state = 'connecting'; renderConn();
    conn = conn || new CU.Connection({
      onMessage,
      log: msg => console.log('[CU]', msg),
      onReconnect: () => { state = 'connected'; renderConn(); showToast('CU wieder verbunden'); },
      onDisconnect: () => {
        const wasManual = conn?.manual;
        state = wasManual ? 'idle' : 'lost'; renderConn();
        if (!wasManual) showToast('Verbindung zur CU verloren', { icon: 'alert' });
        wakeLock?.release?.(); wakeLock = null;
      }
    });
    try {
      await conn.connect();
      state = 'connected';
      conn.startPolling();
      try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) {}
    } catch (err) {
      state = 'idle';
      if (err.name !== 'NotFoundError') showToast(`Verbinden fehlgeschlagen: ${err.message}`, { icon: 'alert' });
    }
    renderConn();
  }

  function disconnect () { conn?.disconnect(); }

  function onMessage (raw) {
    const ev = CU.parse(raw);
    if (ev.type === 'status') {
      const changed = !lastStatus || lastStatus.start !== ev.start || lastStatus.mode !== ev.mode;
      lastStatus = ev;
      if (changed) renderConn();
    } else if (ev.type === 'timer') {
      const lap = tracker.add(ev);
      if (!lap) return;
      CU.sessionBest(bests, assignment, lap);
      flash = lap.address;
      renderBoard(); renderRecords();
      clearTimeout(onMessage.t);
      onMessage.t = setTimeout(() => { flash = null; renderBoard(); }, 700);
    }
  }

  function resetTimes () {
    if (Object.keys(bests).length && !confirmReset()) return;
    tracker = new CU.LapTracker(); bests = {};
    renderBoard(); renderRecords();
  }
  // Inline-Bestätigung ohne Browser-Dialog: zweimal tippen
  function confirmReset () {
    const btn = root.querySelector('#liveReset');
    if (btn.dataset.armed) { delete btn.dataset.armed; btn.innerHTML = `${icon('refresh')}Zurücksetzen`; return true; }
    btn.dataset.armed = '1'; btn.textContent = 'Wirklich? Nochmal tippen';
    setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.innerHTML = `${icon('refresh')}Zurücksetzen`; } }, 3000);
    return false;
  }

  function onAssignChange (e) {
    const sel = e.target.closest('select[data-ctrl]');
    if (!sel) return;
    const n = sel.dataset.ctrl;
    assignment[n] = { ...(assignment[n] || {}), [sel.dataset.kind]: sel.value ? +sel.value : null };
    saveAssignment();
    renderBoard();
  }

  function fromDraft () {
    let entries = [];
    try { entries = JSON.parse(localStorage.getItem('raceDraft') || '{}').entries || []; } catch (e) {}
    if (!entries.length) { showToast('Kein Rennentwurf unter „Neues Rennen“ gefunden'); return; }
    assignment = {};
    entries.slice(0, CONTROLLERS.length).forEach((en, i) => { assignment[i + 1] = { driverId: en.driverId, carId: en.carId }; });
    saveAssignment();
    renderAssign(); renderBoard();
    showToast(`${Math.min(entries.length, CONTROLLERS.length)} Paarungen auf Regler 1–${Math.min(entries.length, CONTROLLERS.length)} gelegt`);
  }

  async function onRecordsClick (e) {
    if (!e.target.closest('#liveSaveRecords')) return;
    if (!window.isAdmin) { showToast('Nur Admin'); return; }
    const list = candidates();
    const picked = [...root.querySelectorAll('#liveRecords input[type=checkbox]')]
      .filter(cb => cb.checked).map(cb => list[+cb.dataset.idx]).filter(Boolean);
    if (!picked.length) return;
    const btn = e.target.closest('button'); btn.disabled = true;
    let saved = 0;
    for (const c of picked) {
      try {
        const res = await window.RecordsUI.persistRecord({ driverId: c.driverId, carId: c.carId, time: c.time, date: todayIso() });
        if (res !== 'slower') saved++;
      } catch (err) { showToast(`Fehler beim Speichern: ${err.message}`, { icon: 'alert' }); }
    }
    showToast(saved === 1 ? '1 Rekord übernommen' : `${saved} Rekorde übernommen`);
    btn.disabled = false;
    // Die Liste aktualisiert sich über den Live-Listener (appData.lapRecords); sicherheitshalber gleich neu zeichnen
    setTimeout(() => { renderRecords(); renderBoard(); }, 300);
  }

  // Rekorde/Fahrer ändern sich per Live-Sync → Ansicht aktuell halten, wenn sichtbar
  function refresh () {
    if (!rendered || !document.getElementById('live')?.classList.contains('active')) return;
    renderAssign(); renderBoard(); renderRecords();
  }

  window.LiveUI = { render, refresh };
})();
