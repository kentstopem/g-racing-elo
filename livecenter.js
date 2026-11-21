// livecenter.js – Livecenter: Training, Qualifying und Rennen live (window.Livecenter)
//
// Vollbild über der App, für iPad quer und per AirPlay auf dem Fernseher (große Schrift, dunkel).
// Rennlogik: race-engine.js. Datenquelle: Control Unit (cu-source.js) oder Simulator (live-sim.js),
// beide liefern dieselben Ereignisse.
(function () {
  const esc = s => window.Helpers.escapeHtml(s);
  const MD = window.MasterData;
  const STORE = 'lcLast';
  const VOICE_KEY = 'lcVoice';
  const MODE_LABEL = { practice: 'Freies Training', quali: 'Qualifying', race: 'Rennen' };

  let root = null;
  let session = null;
  let source = null;
  let loop = null;
  let wakeLock = null;
  let view = 'setup';
  // Simulator nur noch zum Testen (Adresse mit ?sim), sonst immer die Control Unit
  const SIM_OK = /[?&]sim\b/.test(location.search);
  let cfg = loadCfg();
  let ticker = [];
  let lapFlash = {};
  let overlay = null;          // { kind: 'go' | 'resume', until }
  let simOpen = false;
  let carPick = null;
  let drvPick = null;          // Vorbereitung: Regler, für den die Fahrerauswahl offen ist
  let lastSwipe = 0;           // nach einem Wisch kein „Klick“ aufs Autobild auswerten         // Vorbereitung: Regler, für den die Fahrzeugauswahl (Galerie) offen ist
  let addPanel = null;         // Training: { ctrl, driverId, carId } – Fahrer dazunehmen
  let menuCtrl = null;         // Regler, dessen Strafen-Menü offen ist
  let voiceOn = readVoice();
  let lastSay = { prio: 0, type: '', at: 0, until: 0 };
  let shellKey = '';
  let endArmed = 0;            // „Hauptmenü“: Rückfrage offen
  let restartArmed = false;
  let noScoreArmed = false;    // „Nicht werten“ (zum Testen) zweimal tippen    // „Neu starten“ in der Roten Flagge zweimal tippen
  let redPen = {};             // Strafendialog bei Roter Flagge: { ctrl: Sekunden }
  let redReason = '';
  let resultOrder = null;      // Ergebnis-Reihenfolge (Regler), von Hand korrigierbar
  let recPick = new Set();     // ausgewählte neue Rekorde
  let recState = '';           // '' | 'saving' | 'done'
  let girpDone = false;
  let startWall = null;        // Uhrzeit (Date.now) beim ersten „Los“ – wird als Rennbeginn gespeichert
  let baseRecords = [];        // Rekorde dieser Strecke beim Start der Sitzung
  let resTab = 'result';       // Ergebnis-Seite: result | details | laps | stats
  let discardArmed = false;   // „Verwerfen“ der gesicherten Sitzung zweimal tippen
  let tuneTimers = {};         // Regler → Timer: Tuning erst kurz nach dem letzten Tipp senden
  let tuneOk = {};             // Regler → true, sobald das Auto nach dem Senden über einen Sensor gefahren ist
  let dmgPanel = null;          // Schaden melden: { ctrl, type, note, step: 'pick' | 'swap' }
  let qualiBests = {};         // beste Quali-Runde je Paarung ("driverId|carId" → ms), fürs Rennen danach

  // ---------- Daten aus der App ----------
  const appData = () => window.appData || {};
  // Auswahl nur aktive Fahrer/Fahrzeuge (wie „Nur aktive“ in den Listen); bereits eingeteilte bleiben sichtbar
  const isActive = x => (window.Elo?.isActive ? window.Elo.isActive(x) : !!x && !x.archived && !x.hideFromRanking);
  const drivers = (keep = []) => [...(appData().drivers || [])].filter(d => isActive(d) || keep.includes(d.id)).sort((a, b) => a.name.localeCompare(b.name));
  // Gesperrt (offener Motor-/Sensorschaden, siehe damage.js) – unabhängig von „aktiv“, wird nie angeboten
  const isLocked = c => !!window.Damage?.isLocked(c);
  // „Nur Training“ (z. B. anderer Decoder, stört im Rennen): nur im Freien Training wählbar
  const allowedIn = (c, mode) => MD.carAllowedIn(c, mode);
  const cars = (keep = [], mode = cfg.mode) => [...(appData().cars || [])].filter(c => (isActive(c) && !isLocked(c) && allowedIn(c, mode)) || keep.includes(c.id)).sort((a, b) => a.name.localeCompare(b.name));
  const driverName = id => (appData().drivers || []).find(d => d.id === id)?.name ?? '?';
  const carName = id => (appData().cars || []).find(c => c.id === id)?.name ?? '';
  const trackId = () => window.Seasons?.current?.()?.trackId ?? null;
  const track = () => (appData().tracks || []).find(t => t.id === trackId()) || {};
  const settings = () => appData().raceSettings || MD.raceSettings();
  function trackRecords () {
    const tid = trackId();
    return (appData().lapRecords || [])
      .filter(r => !tid || window.Seasons?.trackOfRecord?.(r) === tid)
      .map(r => ({ driverId: r.driverId, carId: r.carId, ms: Math.round(r.time * 1000) }));
  }

  function loadCfg () {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (e) {}
    return { source: SIM_OK && c.source === 'sim' ? 'sim' : 'cu', mode: c.mode || 'practice', raceLaps: c.raceLaps || 60, qualiLaps: c.qualiLaps || 3, assign: c.assign || {}, lastCar: c.lastCar || {}, finishCount: c.finishCount || 0, dqOpen: !!c.dqOpen, fullDistance: !!c.fullDistance, fuelPractice: !!c.fuelPractice, fuelQuali: !!c.fuelQuali, broadcast: !!c.broadcast };
  }
  const fuelOnFor = mode => mode === 'race' || (mode === 'practice' ? !!cfg.fuelPractice : mode === 'quali' ? !!cfg.fuelQuali : false);
  function saveCfg () { try { localStorage.setItem(STORE, JSON.stringify(cfg)); } catch (e) {} }
  function readVoice () { try { return localStorage.getItem(VOICE_KEY) !== 'off'; } catch (e) { return true; } }

  const fmt = ms => (ms == null ? '–' : (ms / 1000).toFixed(3).replace('.', ','));
  const fmtGap = s => {
    if (s.pos === 1) return '';
    if (s.gapLaps > 0) return `+${s.gapLaps} Rd.`;
    if (s.gap == null) return '–';
    return `+${(s.gap / 1000).toFixed(s.gap >= 10000 ? 1 : 3).replace('.', ',')}`;
  };
  const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const fmtTotal = ms => (ms == null ? '–' : `${clock(ms)},${Math.floor((ms % 1000) / 100)}`);
  const ctrlStyle = n => { const c = MD.controller(n); return `--cc:${c.color};--ct:${c.text}`; };
  const who = id => esc(driverName(id));
  // Alle Eingaben während eines Events nur für den eingeloggten Admin (Tristan 2026-11-17)
  const canEdit = () => !!window.isAdmin && source?.kind !== 'view';   // Zuschauen: auch der Admin nur lesend

  // ---------- Öffnen / Schließen ----------
  function open () {
    if (!root) {
      root = document.createElement('div');
      root.id = 'livecenter';
      root.className = 'lc';
      document.body.appendChild(root);
      root.addEventListener('click', onClick);
      // Zeilen werden laufend neu gezeichnet → Antippen schon beim Berühren auswerten
      root.addEventListener('pointerdown', e => {
        const row = e.target.closest('.lc-row[data-ctrl]');
        if (!row || !session || !canEdit()) return;
        const ctrl = +row.dataset.ctrl;
        menuCtrl = menuCtrl === ctrl ? null : ctrl; addPanel = null; dmgPanel = null;
        renderLive();
      });
      // Vorbereitung: über das Autobild wischen = voriges/nächstes freies Auto (Tristan 21.11.)
      let swipe = null;
      root.addEventListener('touchstart', e => { const im = e.target.closest('.lc-tile-car[data-ctrl]'); swipe = im ? { ctrl: +im.dataset.ctrl, x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
      root.addEventListener('touchend', e => {
        if (!swipe || session || !canEdit()) { swipe = null; return; }
        const dx = e.changedTouches[0].clientX - swipe.x, dy = e.changedTouches[0].clientY - swipe.y;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) { stepCar(swipe.ctrl, dx < 0 ? 1 : -1); swipe.done = performance.now(); }
        lastSwipe = swipe.done || 0; swipe = null;
      }, { passive: true });
      root.addEventListener('change', onChange);
      root.addEventListener('input', e => { if (dmgPanel && e.target.matches('[data-dmgnote]')) dmgPanel.note = e.target.value; });
    }
    document.documentElement.classList.add('lc-open');
    root.hidden = false;
    shellKey = '';
    watchCu();
    if (!session) { if (canEdit()) enterSetup(); else startWatch(); } else renderLive();
  }

  // ---------- Live-Übertragung: Rennstand für Zuschauer (ein kleines Dokument live/current) ----------
  // Nur wenn „Live übertragen“ an ist. Höchstens alle 2,5 s (wichtige Ereignisse nach 0,8 s), nur bei Änderungen.
  const liveDoc = () => (window.db ? window.db.collection('live').doc('current') : null);
  let castAt = 0, castBusy = false, castPending = false, castLast = '', castFull = false;
  function broadcast (force = false) {
    if (!cfg.broadcast || !canEdit() || !session || !source || source.kind === 'view' || !liveDoc()) return;
    castPending = castPending || force;
    const since = Date.now() - castAt;
    if (castBusy || since < (castPending ? 800 : 2500)) return;
    const full = session.phase === 'finished';
    if (full && castFull) return;
    const snap = session.snapshot(source.now());
    const ids = new Set(snap.cars.map(c => c.driverId));
    snap.opts.records = (snap.opts.records || []).filter(r => ids.has(r.driverId));
    snap.opts.track = { id: snap.opts.track?.id, name: snap.opts.track?.name, minLapMs: snap.opts.track?.minLapMs, refLapMs: snap.opts.track?.refLapMs };
    const r = x => (x == null ? x : Math.round(x));                       // ganze ms reichen fürs Anzeigen
    snap.cars.forEach(c => {
      c.pitLog = []; if (!full) c.lapTimes = c.lapTimes.slice(-1);
      c.crossings = c.crossings.map(r); c.lastCross = r(c.lastCross); c.finishT = r(c.finishT); c.pitStandMs = r(c.pitStandMs); c.penaltyMs = r(c.penaltyMs);
      c.fuel = Math.round(c.fuel * 10) / 10;
    });
    ['goT', 'redAt', 'endT'].forEach(k => { snap.state[k] = r(snap.state[k]); });
    const body = { snap, redReason, lightsRunning: !!session.lightsRunning, ticker: ticker.slice(0, 4), girp: girpDone ? girpShown : null };
    // Vergleich ohne laufende Uhr-Werte: in Pausen (Rote Flagge, Ampel) wird dann nichts geschrieben
    const cmp = JSON.stringify({ ...body, snap: { ...snap, savedT: 0, state: { ...snap.state, lastT: 0 }, cars: snap.cars.map(c => ({ ...c, pitLastT: 0 })) } });
    castPending = false;
    if (cmp === castLast) return;
    castLast = cmp; castAt = Date.now(); castBusy = true;
    liveDoc().set({ active: true, at: castAt, data: JSON.stringify(body) })
      .then(() => { if (full) castFull = true; })
      .catch(e => console.warn('Live-Übertragung', e))
      .finally(() => { castBusy = false; });
  }
  function endBroadcast () {
    castLast = ''; castFull = false;
    if (canEdit() && liveDoc()) liveDoc().set({ active: false, at: Date.now() }).catch(() => {});
  }
  function toggleBroadcast () {
    cfg.broadcast = !cfg.broadcast; saveCfg();
    if (cfg.broadcast) { castLast = ''; castFull = false; broadcast(true); } else endBroadcast();
  }

  // Zuschauer: Stand aus live/current anzeigen, nur lesen, ohne Ansagen
  let watchUnsub = null, watchAt = 0;
  function startWatch () {
    stopSession();
    view = 'live'; shellKey = '';
    source = { kind: 'view', now: () => performance.now(), close () { watchUnsub?.(); watchUnsub = null; } };
    renderWatchIdle('Verbinde …');
    if (!liveDoc()) { renderWatchIdle('Keine Verbindung zur Datenbank.'); return; }
    watchUnsub = liveDoc().onSnapshot(doc => applyWatch(doc.data()), err => renderWatchIdle(`Keine Verbindung: ${err.message}`));
    loop = setInterval(() => { if (session && source?.kind === 'view') { session.tick(source.now()); renderLive(); } }, 250);
  }
  function applyWatch (d) {
    if (!source || source.kind !== 'view') return;
    if (!d?.active || !d.data) { session = null; shellKey = ''; renderWatchIdle('Gerade wird nichts live übertragen.'); return; }
    let x; try { x = JSON.parse(d.data); } catch (e) { return; }
    const age = Math.max(0, Date.now() - (d.at || Date.now()));
    watchAt = d.at || Date.now();
    session = window.RaceEngine.Session.restore(x.snap, source.now() - age, { live: true });
    session.lightsRunning = !!x.lightsRunning;
    redReason = x.redReason || ''; ticker = x.ticker || []; girpShown = x.girp || null;
    if (session.phase !== 'finished') resultOrder = null;
    renderLive();
  }
  function renderWatchIdle (msg) {
    if (!root || source?.kind !== 'view' || session) return;
    root.innerHTML = `<div class="lc-setup">
        <header class="lc-top"><div class="lc-brand">Livecenter</div><div class="lc-track">Zuschauen</div>
          <button class="lc-btn lc-ghost" data-act="close">Schließen</button></header>
        <div class="lc-watch-idle"><h2>${esc(msg)}</h2><p class="lc-note">Sobald live von der Strecke übertragen wird, siehst du hier mehr.</p></div>
      </div>`;
  }

  /** Ins Hauptmenü, Sitzung (Zeitnahme, CU, Sicherung) läuft weiter; open() zeigt sie wieder an */
  function hide () {
    shellKey = '';
    root.hidden = true;
    document.documentElement.classList.remove('lc-open');
  }

  function close () {
    // Rennen beendet, aber noch nicht an G!RP übergeben: Sicherung behalten (Livecenter bietet „Fortsetzen“ an)
    stopSession({ keepSnap: !!session && session.mode === 'race' && session.phase === 'finished' && !girpDone });
    root.hidden = true;
    document.documentElement.classList.remove('lc-open');
    window.Livecenter.onClose?.();
  }

  /**
   * Gefahrene Runden am Ende einer Sitzung zu Fahrer und Fahrzeug addieren (practiceLaps, je ein Schreibvorgang).
   * Training und Quali zählen hier; Rennrunden kommen wie bisher über die G!RP-Wertung (totalRounds) dazu.
   */
  function countLaps ({ unscored = false } = {}) {
    if (!session || session.lapsCounted || (session.mode === 'race' && !unscored) || !window.isAdmin || !window.Storage?.updateDriverFields) return;
    session.lapsCounted = true;
    const inc = n => firebase.firestore.FieldValue.increment(n);
    const byDriver = {}, byCar = {};
    // Je Fahrzeug aus den Runden-Segmenten (Autotausch!); die zählen auch Runden vor „Zurücksetzen“ im Training
    for (const c of session.allCars()) {
      for (const sg of window.RaceEngine.Session.carLapsOf(c)) {
        byDriver[c.driverId] = (byDriver[c.driverId] || 0) + sg.laps;
        byCar[sg.carId] = (byCar[sg.carId] || 0) + sg.laps;
      }
    }
    const fail = err => window.Helpers.showToast?.(`Runden nicht gespeichert: ${err.message}`, { icon: 'alert' });
    for (const [id, n] of Object.entries(byDriver)) {
      const d = (appData().drivers || []).find(x => String(x.id) === id); if (d) d.practiceLaps = (d.practiceLaps || 0) + n;
      window.Storage.updateDriverFields(d?.id ?? id, { practiceLaps: inc(n) }).catch(fail);
    }
    for (const [id, n] of Object.entries(byCar)) {
      const c = (appData().cars || []).find(x => String(x.id) === id); if (c) c.practiceLaps = (c.practiceLaps || 0) + n;
      window.Storage.updateCarFields(c?.id ?? id, { practiceLaps: inc(n) }).catch(fail);
    }
  }

  function stopSession ({ keepSnap = false } = {}) {
    const watching = source?.kind === 'view';
    if (!watching) { try { countLaps(); } catch (e) { console.error(e); } }
    clearInterval(loop); loop = null;
    if (session && !keepSnap && !watching) clearSnap();
    if (session && !watching && cfg.broadcast) endBroadcast();
    source?.close(); source = null;
    session = null;
    wakeLock?.release?.(); wakeLock = null;
    window.Voice?.stop?.();
  }

  // ---------- Vorbereitung ----------
  function entriesFromCfg () {
    return MD.CONTROLLERS.map(c => ({ ctrl: c.n, ...(cfg.assign[c.n] || {}) })).filter(e => e.driverId && e.carId);
  }

  /** In der Vorbereitung ist die Strecke immer frei – egal, wie das Event davor beendet wurde (Tristan 20.11.) */
  function releaseTrack () { if (cfg.source === 'cu' && canEdit()) cuHub()?.releaseTrack?.(); }
  function enterSetup () { view = 'setup'; releaseTrack(); renderSetup(); }

  /** Galerie: alle wählbaren Autos; vergebene mit Reglerfarbe, Auswahl tauscht die Plätze */
  function carPickHtml (n, cAll) {
    const c = MD.controller(n), cur = cfg.assign[n]?.carId ?? null;
    const owner = id => MD.CONTROLLERS.find(o => o.n !== n && cfg.assign[o.n]?.carId === id);
    const tile = x => {
      const o = owner(x.id), img = carImg(x.id);
      return `<button class="lc-pick-car ${x.id === cur ? 'on' : ''} ${o ? 'taken' : ''}" data-act="carSet" data-ctrl="${n}" data-car="${x.id}" ${o ? `style="${ctrlStyle(o.n)}"` : ''}>
        <span class="lc-pick-img">${img ? `<img src="${img}" alt="">` : ''}</span>
        <span class="lc-pick-name">${esc(x.name)}</span>
        ${o ? `<span class="lc-pick-owner" title="Vergeben – tauscht die Plätze">${esc(cfg.assign[o.n]?.driverId != null ? driverName(cfg.assign[o.n].driverId) : o.name)} ⇄</span>` : ''}
      </button>`;
    };
    return `<div class="lc-pick-back" data-act="carPickClose"></div>
      <div class="lc-pick" style="${ctrlStyle(n)}" role="dialog" aria-label="Fahrzeug für Regler ${c.name}">
        <div class="lc-pick-head"><span class="lc-swatch"></span><b>Fahrzeug wählen${cfg.assign[n]?.driverId ? ` für ${esc(driverName(cfg.assign[n].driverId))}` : ''}</b>
          ${cur != null ? `<button class="lc-btn lc-ghost" data-act="carSet" data-ctrl="${n}" data-car="">Kein Fahrzeug</button>` : ''}
          <button class="lc-btn lc-ghost" data-act="carPickClose">Schließen</button></div>
        <div class="lc-pick-grid">${cAll.map(tile).join('')}</div>
      </div>`;
  }

  /** Fahrerauswahl wie die Fahrzeug-Galerie: Kacheln mit PB (aktuelle Strecke), Runden und Rennen gesamt */
  function drvPickHtml (n, dAll) {
    const c = MD.controller(n), cur = cfg.assign[n]?.driverId ?? null;
    const owner = id => MD.CONTROLLERS.find(o => o.n !== n && cfg.assign[o.n]?.driverId === id);
    const recs = trackRecords(), races = appData().allRaces || appData().races || [];
    const nf = v => Number(v || 0).toLocaleString('de-DE');
    const tile = d => {
      const o = owner(d.id);
      const pb = recs.filter(r => String(r.driverId) === String(d.id)).reduce((m, r) => (m == null || r.ms < m ? r.ms : m), null);
      const tot = MD.driverTotals ? MD.driverTotals(d.id, races, d) : { laps: d.totalRounds || 0, races: d.races || 0 };
      return `<button class="lc-pick-car lc-pick-drv ${d.id === cur ? 'on' : ''} ${o ? 'taken' : ''}" data-act="drvSet" data-ctrl="${n}" data-driver="${d.id}" ${o ? `style="${ctrlStyle(o.n)}"` : ''}>
        ${o ? `<span class="lc-pick-owner" title="Vergeben – tauscht die Plätze">${esc(cfg.assign[o.n]?.carId != null ? carName(cfg.assign[o.n].carId).replace(/^\(\d+\)\s*/, '') : o.name)} ⇄</span>` : ''}
        <span class="lc-pick-name">${esc(d.name)}</span>
        <span class="lc-pick-stats">PB ${pb != null ? fmt(pb) : '–'}<br>${nf(tot.laps)} Runden · ${nf(tot.races)} Rennen</span>
      </button>`;
    };
    return `<div class="lc-pick-back" data-act="pickClose"></div>
      <div class="lc-pick" style="${ctrlStyle(n)}" role="dialog" aria-label="Fahrer für Regler ${c.name}">
        <div class="lc-pick-head"><span class="lc-swatch"></span><b>Fahrer wählen${cfg.assign[n]?.carId != null ? ` für ${esc(carName(cfg.assign[n].carId))}` : ''}</b>
          ${cur != null ? `<button class="lc-btn lc-ghost" data-act="drvSet" data-ctrl="${n}" data-driver="">Kein Fahrer</button>` : ''}
          <button class="lc-btn lc-ghost" data-act="pickClose">Schließen</button></div>
        <div class="lc-pick-grid lc-pick-grid-drv">${dAll.map(tile).join('')}</div>
      </div>`;
  }

  /** Fahrer/Fahrzeug auf Regler n setzen; steht es schon auf einem anderen Regler, tauschen die beiden die Plätze */
  function assignSlot (n, kind, val) {
    const prev = cfg.assign[n]?.[kind] ?? null;
    cfg.assign[n] = { ...(cfg.assign[n] || {}), [kind]: val };
    if (val != null) {
      for (const [k, a] of Object.entries(cfg.assign)) {
        if (+k === n || a?.[kind] !== val) continue;
        a[kind] = prev;
        if (!a.driverId && !a.carId) delete cfg.assign[k];
      }
    }
    if (kind === 'driverId' && val != null && !cfg.assign[n].carId) {
      // Fahrzeug vorschlagen: das, mit dem der Fahrer zuletzt gefahren ist
      const last = cfg.lastCar?.[val];
      if (last && !Object.values(cfg.assign).some(a => a?.carId === last) && cars().some(x => x.id === last)) cfg.assign[n].carId = last;
    }
    if (cfg.assign[n].driverId && cfg.assign[n].carId) { cfg.lastCar = { ...(cfg.lastCar || {}), [cfg.assign[n].driverId]: cfg.assign[n].carId }; }
    if (!cfg.assign[n].driverId && !cfg.assign[n].carId) delete cfg.assign[n];
    delete cfg.hint;
    saveCfg(); renderSetup();
  }

  /** ‹ › bzw. Wischen: voriges/nächstes freie Auto (vergebene werden übersprungen) */
  function stepCar (n, dir) {
    const cur = cfg.assign[n]?.carId ?? null;
    const list = cars(Object.values(cfg.assign).map(a => a?.carId)).filter(x => x.id === cur || !MD.CONTROLLERS.some(o => o.n !== n && cfg.assign[o.n]?.carId === x.id));
    if (!list.length) return;
    const i = list.findIndex(x => x.id === cur);
    const next = i < 0 ? (dir > 0 ? list[0] : list[list.length - 1]) : list[(i + dir + list.length) % list.length];
    if (next.id !== cur) assignSlot(n, 'carId', next.id);
  }

  function renderSetup () {
    restoreThrottled();
    // Gesperrte Fahrzeuge (offener kritischer Schaden) aus der Zuweisung nehmen – auch nach „Autos rotieren“
    const lockedOut = [];
    for (const a of Object.values(cfg.assign)) {
      const car = a?.carId != null && (appData().cars || []).find(x => x.id === a.carId);
      if (car && isLocked(car)) { lockedOut.push(car.name); a.carId = null; }
    }
    if (lockedOut.length) { cfg.hint = `Gesperrt wegen Schaden: ${lockedOut.join(', ')} – bitte anderes Fahrzeug wählen.`; saveCfg(); }
    // „Nur Training“-Fahrzeuge raus, sobald Qualifying oder Rennen gewählt ist
    const practiceOut = [];
    for (const a of Object.values(cfg.assign)) {
      const car = a?.carId != null && (appData().cars || []).find(x => x.id === a.carId);
      if (car && !allowedIn(car, cfg.mode)) { practiceOut.push(car.name); a.carId = null; }
    }
    if (practiceOut.length) { cfg.hint = `Nur im Training: ${practiceOut.join(', ')} – bitte anderes Fahrzeug wählen.`; saveCfg(); }
    const dAll = drivers(Object.values(cfg.assign).map(a => a?.driverId)), cAll = cars(Object.values(cfg.assign).map(a => a?.carId));
    const t = track();
    const entries = entriesFromCfg();
    const usedD = Object.values(cfg.assign).map(a => a?.driverId).filter(Boolean);
    const rows = MD.CONTROLLERS.map(c => {
      const a = cfg.assign[c.n] || {};
      // Kachel je Regler (Rahmen in Reglerfarbe, ohne Farbnamen): Autobild mit ‹ › bzw. Wischen, Tippen = alle Autos (Tristan 21.11.)
      const img = a.carId != null ? carImg(a.carId) : null;
      const can = canEdit();
      return `<div class="lc-tile ${a.driverId || a.carId ? 'used' : ''}" style="${ctrlStyle(c.n)}" aria-label="Regler ${c.name}">
        <button class="lc-tile-clear" data-act="clear" data-ctrl="${c.n}" aria-label="Regler ${c.name} leeren" title="Leeren" ${(a.driverId || a.carId) && can ? '' : 'hidden'}>×</button>
        <div class="lc-tile-gal">
          <button class="lc-tile-arrow" data-act="carStep" data-ctrl="${c.n}" data-dir="-1" aria-label="Voriges Auto" ${can ? '' : 'disabled'}>‹</button>
          <button class="lc-tile-car" data-act="carPick" data-ctrl="${c.n}" aria-label="Fahrzeug wählen" ${can ? '' : 'disabled'}>${a.carId != null ? (img ? `<img src="${img}" alt="">` : `<span>${esc(carName(a.carId))}</span>`) : '<span>Fahrzeug wählen</span>'}</button>
          <button class="lc-tile-arrow" data-act="carStep" data-ctrl="${c.n}" data-dir="1" aria-label="Nächstes Auto" ${can ? '' : 'disabled'}>›</button>
        </div>
        <div class="lc-tile-name">${a.carId != null ? esc(carName(a.carId)) : '&nbsp;'}</div>
        <button class="lc-tile-driver ${a.driverId != null ? 'on' : ''}" data-act="drvPick" data-ctrl="${c.n}" aria-label="Fahrer wählen" ${can ? '' : 'disabled'}>${a.driverId != null ? esc(driverName(a.driverId)) : '– Fahrer –'}</button>
      </div>`;
    }).join('');
    const incomplete = MD.CONTROLLERS.filter(c => { const a = cfg.assign[c.n] || {}; return !!a.driverId !== !!a.carId; });
    const dupD = usedD.filter((d, i) => usedD.indexOf(d) !== i);
    const problems = [
      ...incomplete.map(c => `${MD.controller(c.n).name}: Fahrer und Fahrzeug wählen`),
      ...[...new Set(dupD)].map(d => `${driverName(d)} ist zweimal eingeteilt`)
    ];
    const lapsField = cfg.mode === 'race'
      ? `<label class="lc-field lc-field-laps">Runden<input type="number" inputmode="numeric" min="1" max="999" data-cfg="raceLaps" value="${cfg.raceLaps}"></label>`
      : cfg.mode === 'quali'
        ? `<label class="lc-field lc-field-laps">Quali-Runden je Fahrer<input type="number" inputmode="numeric" min="1" max="50" data-cfg="qualiLaps" value="${cfg.qualiLaps}"></label>`
        : '<p class="lc-note">Keine Startampel – die Strecke ist sofort frei</p>';
    // Qualifying startet ebenfalls ohne Ampel (Tristan 2026-11-17)
    const raceOpts = cfg.mode === 'race' ? `
      <label class="lc-field lc-field-end">Rennende<select data-cfg="finishCount">
        <option value="0" ${!cfg.finishCount ? 'selected' : ''}>alle im Ziel</option>
        ${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${cfg.finishCount === n ? 'selected' : ''}>${n} im Ziel</option>`).join('')}
      </select></label></div>
      <label class="lc-check"><input type="checkbox" data-cfg="dqOpen" ${cfg.dqOpen ? 'checked' : ''}> Offene Strafen bei Rennende: disqualifizieren<small>Sonst wird die offene Zeit auf die Gesamtzeit addiert.</small></label>
      <label class="lc-check"><input type="checkbox" data-cfg="fullDistance" ${cfg.fullDistance ? 'checked' : ''}> Alle fahren volle Distanz<small>Überrundete fahren nach dem Sieg weiter, bis sie alle Runden haben.</small></label>` : '';
    // Tanken im Training/Quali per Checkbox (Tristan 2026-11-19), im Rennen immer an
    const fuelKey = cfg.mode === 'practice' ? 'fuelPractice' : cfg.mode === 'quali' ? 'fuelQuali' : null;
    const fuelCheck = fuelKey ? `<label class="lc-check"><input type="checkbox" data-cfg="${fuelKey}" ${cfg[fuelKey] ? 'checked' : ''}> Mit Tanken<small>Spritverbrauch und Tanken in der Box wie im Rennen.</small></label>` : '';
    const fuelNote = fuelOnFor(cfg.mode) ? (() => {
      const ref = MD.trackSetup(t).refLapMs;
      const plan = MD.raceFuelPlan(cfg.mode === 'race' ? cfg.raceLaps : cfg.mode === 'quali' ? cfg.qualiLaps : 0, ref, t, settings());
      return `<p class="lc-note">Voller Tank reicht ca. ${Math.round(plan.lapsPerTank)} Runden bei ${ref} ms Rundenzeit${cfg.mode !== 'practice' && plan.stops ? ` · ${plan.stops} Boxenstopp${plan.stops > 1 ? 's' : ''} nötig` : ''}</p>`;
    })() : '';

    const saved = readSnap();
    const resumeBar = !saved ? '' : (() => {
      const o = saved.snap.opts, n = saved.snap.cars.length;
      const lapsDone = Math.max(0, ...saved.snap.cars.map(c => c.laps || 0));
      const mins = Math.max(0, Math.round((Date.now() - saved.at) / 60000));
      const what = `${MODE_LABEL[o.mode] || 'Sitzung'}${o.mode === 'race' ? ` · Rd. ${lapsDone} von ${o.laps}` : ` · ${lapsDone} Rd.`}${saved.snap.state.phase === 'finished' ? ' · beendet, noch nicht gespeichert' : ''}`;
      const ok = canEdit() && (cfg.source === 'sim' || cuHub()?.state === 'connected');
      return `<div class="lc-resume-bar">
        <div><b>Unterbrochen: ${esc(what)}</b><span>${n} Fahrer · gesichert ${mins < 1 ? 'gerade eben' : `vor ${mins} Min.`}${ok || !canEdit() ? '' : ' · erst mit der CU verbinden'}</span></div>
        ${canEdit() ? `<button class="lc-btn lc-ghost" data-act="discardSaved">${discardArmed ? 'Wirklich verwerfen?' : 'Verwerfen'}</button>
        <button class="lc-btn lc-primary" data-act="resumeSaved" ${ok ? '' : 'disabled'}>Fortsetzen</button>` : ''}
      </div>`;
    })();

    root.innerHTML = `
      <div class="lc-setup">
        <header class="lc-top">
          <div class="lc-brand">Livecenter</div>
          <div class="lc-track">${esc(t.name || 'Keine Strecke')}</div>
          <button class="lc-btn lc-ghost" data-act="close">Schließen</button>
        </header>
        ${resumeBar}
        <div class="lc-setup-grid">
          <section class="lc-card">
            <h3>Was wird gefahren?</h3>
            <div class="lc-seg" role="tablist">
              ${Object.entries(MODE_LABEL).map(([k, l]) => `<button role="tab" data-act="mode" data-mode="${k}" class="${cfg.mode === k ? 'on' : ''}">${l}</button>`).join('')}
            </div>
            ${cfg.mode === 'race' ? `<div class="lc-field-row">${lapsField}${raceOpts}` : lapsField}
            ${fuelCheck}
            ${fuelNote}
            <h3>Verbindung</h3>
            ${SIM_OK ? `<div class="lc-seg">
              <button data-act="src" data-src="cu" class="${cfg.source === 'cu' ? 'on' : ''}">Control Unit</button>
              <button data-act="src" data-src="sim" class="${cfg.source === 'sim' ? 'on' : ''}">Simulator</button>
            </div>` : ''}
            ${cfg.source === 'cu' ? cuBox() : '<p class="lc-note">Der Simulator fährt mit den echten Fahrern, Fahrzeugen und Rekorden.</p>'}
            <h3>Zuschauer</h3>
            <div class="lc-cast-row">
              <button class="lc-btn ${cfg.broadcast ? 'on' : ''}" data-act="cast" aria-pressed="${cfg.broadcast}">Live übertragen: ${cfg.broadcast ? 'an' : 'aus'}</button>
              <button class="lc-btn lc-ghost" data-act="watch">Selbst zuschauen</button>
            </div>
            <p class="lc-note">Wenn an, sehen alle in der App unter „Live“ das laufende Rennen mit (nur lesen).</p>
          </section>
          <section class="lc-card">
            <div class="lc-card-head">
              <h3>Zuweisung</h3>
              ${canEdit() ? `<div class="lc-card-btns">
                <button class="lc-btn" data-act="rotateCars" ${entries.length >= 2 ? '' : 'disabled'} title="Jeder Fahrer behält seinen Regler, die Autos rücken einen Regler weiter">Autos rotieren</button>
                <span class="lc-draw-btns" role="group" aria-label="Fahrer wählen und Autos auslosen">${DRAW_METHODS.map(([m, ic, l]) =>
                  `<button class="lc-btn lc-primary lc-draw-btn" data-act="autoSetup" data-method="${m}" title="Fahrer wählen, Autos per ${l} auslosen" aria-label="Auslosen per ${l}">${window.Helpers.icon(ic)}</button>`).join('')}</span>
              </div>` : ''}
            </div>
            <div class="lc-tiles">${rows}</div>
            <p class="lc-hint ${problems.length ? 'warn' : ''}" id="lcHint">${problems.length ? problems.map(esc).join(' · ') : cfg.hint ? esc(cfg.hint) : 'Leere Regler fahren nicht mit.'}</p>
          </section>
          <section id="lcTune" class="lc-card lc-tune-card">${tuneCardHtml()}</section>
        </div>
        <footer class="lc-setup-foot">
          <div>${entries.length} ${entries.length === 1 ? 'Fahrer' : 'Fahrer'} · ${MODE_LABEL[cfg.mode]}${cfg.mode === 'race' ? ` über ${cfg.raceLaps} Runden` : cfg.mode === 'quali' ? ` · ${cfg.qualiLaps} Runden je Fahrer` : ''}</div>
          ${canEdit() ? '' : '<span class="lc-note">Starten nur mit Admin-Anmeldung</span>'}
          <button class="lc-btn lc-primary lc-big" data-act="start" ${entries.length && !problems.length && canEdit() && (cfg.source === 'sim' || cuHub()?.state === 'connected') ? '' : 'disabled'}>${cfg.mode === 'race' ? 'Zur Startaufstellung' : 'Strecke freigeben'}</button>
        </footer>
        ${carPick != null && canEdit() ? carPickHtml(carPick, cAll) : ''}
        ${drvPick != null && canEdit() ? drvPickHtml(drvPick, dAll) : ''}
      </div>`;
  }

  // ---------- Control Unit ----------
  const cuHub = () => window.LiveCU?.hub;
  function cuBox () {
    const h = cuHub();
    if (!h) return '<p class="lc-note">CU-Anbindung nicht geladen.</p>';
    if (!h.available()) return '<p class="lc-note warn">Dieser Browser kann kein Bluetooth. Auf dem iPad G!RP in <b>Bluefy</b> öffnen.</p>';
    const st = h.state;
    const txt = st === 'connected' ? `Verbunden${h.version ? ` · Firmware ${esc(h.version)}` : ''}`
      : st === 'connecting' ? 'Verbinde …' : st === 'lost' ? 'Verbindung verloren' : 'Nicht verbunden';
    return `<div class="lc-field-row lc-cu">
        ${st === 'idle' || st === 'disconnected' || !st ? '' : `<span class="lc-cu-state ${st}">${txt}</span>`}
        ${st === 'connected' ? '<button class="lc-btn" data-act="cuOff">Trennen</button>' : `<button class="lc-btn lc-primary" data-act="cuOn" ${st === 'connecting' ? 'disabled' : ''}>Mit CU verbinden</button>`}
      </div>
      ${h.error && st !== 'connected' ? `<p class="lc-note warn">${esc(h.error)}</p>` : ''}
`;
  }
  let cuWatch = null;
  /** Noch wegen leerem Tank gedrosselte Autos (Rennende, Absturz) in der Vorbereitung auf ihr Tuning zurücksetzen */
  function restoreThrottled () {
    if (session || cfg.source !== 'cu' || cuHub()?.state !== 'connected') return;
    const done = cuHub().restoreThrottled?.() || [];
    if (done.length) window.Helpers.showToast?.(`Tempo zurückgesetzt (leerer Tank): ${done.map(n => MD.CONTROLLERS.find(c => c.n === n)?.name || n).join(', ')} – einmal über einen Sensor fahren`);
  }
  function watchCu () {
    if (cuWatch || !cuHub()) return;
    cuWatch = cuHub().onState(() => {
      if (!session) restoreThrottled();
      if (root?.hidden) return;
      if (view === 'setup' && !session && cuHub().state === 'connected') releaseTrack();   // frisch verbunden: Strecke frei
      if (view === 'setup' && !session) renderSetup(); else { shellKey = ''; renderLive(); }
    });
    // Tuning: „gesendet“ → „im Auto“, sobald das Auto über einen Sensor fährt
    cuHub().onProgram?.(ctrl => {
      if (!cuHub().pending?.[ctrl]) tuneOk[ctrl] = true;
      if (session && menuCtrl !== ctrl) return;
      refreshTune();
    });
  }

  /** Paarungen (Fahrer + Auto) auf die Regler verteilen, nach Wunschregler der Fahrer */
  function applyPairs (pairs) {
    if (!pairs?.length) return;
    const { assignments, conflicts } = MD.suggestControllers(pairs.slice(0, 6), appData().drivers || []);
    cfg.assign = {};
    assignments.forEach(a => { if (a.controller) cfg.assign[a.controller] = { driverId: a.driverId, carId: a.carId }; });
    cfg.hint = conflicts.length
      ? conflicts.map(c => `${MD.controller(c.controller).name} wollten ${c.driverIds.map(driverName).join(' und ')} – ${driverName(c.driverIds[0])} hat ihn`).join(' · ')
      : 'Regler nach Wunsch der Fahrer verteilt. Du kannst alles ändern.';
    saveCfg(); renderSetup();
  }

  /** Auto-Setup (Fahrer → Fahrzeuge) öffnen; vorausgewählt sind die Fahrer auf den Reglern */
  const DRAW_METHODS = [['wheel', 'wheel', 'Glücksrad'], ['slot', 'slot', 'Slotmachine'], ['memory', 'cards', 'Memorykarten']];
  function openAutoSetup (driverIds = entriesFromCfg().map(e => e.driverId), method = null) {
    if (!window.RaceUI?.openAutoSetup) { window.Helpers.showToast?.('Auto-Setup nicht geladen'); return; }
    window.RaceUI.openAutoSetup({ drivers: driverIds, onDone: applyPairs, method, mode: cfg.mode });
  }

  /** Fahrer bleiben auf ihrem Regler, die Autos rücken einen belegten Regler weiter */
  function rotateCars () {
    const used = entriesFromCfg();
    if (used.length < 2) return;
    used.forEach((e, i) => { cfg.assign[e.ctrl] = { driverId: e.driverId, carId: used[(i + used.length - 1) % used.length].carId }; });
    cfg.hint = 'Autos rotiert: jeder Fahrer bleibt auf seinem Regler und fährt das Auto vom Regler davor.';
    saveCfg(); renderSetup();
  }

  /** Nach dem Rennen: zurück zur Vorbereitung mit gleichen Paarungen, getauschten Autos oder neuer Zuteilung */
  function nextRace (how) {
    const entries = [...session.cars.values()].map(c => ({ ctrl: c.ctrl, driverId: c.driverId, carId: c.carId }));
    stopSession(); view = 'setup'; releaseTrack();
    cfg.assign = {};
    entries.forEach(e => { cfg.assign[e.ctrl] = { driverId: e.driverId, carId: e.carId }; });
    cfg.hint = 'Gleiche Paarungen wie im letzten Rennen.';
    saveCfg();
    if (how === 'swap') rotateCars(); else renderSetup();
    if (how === 'new') openAutoSetup(entries.map(e => e.driverId));
  }

  // ---------- Start ----------
  function startSession ({ mode = cfg.mode, entries = entriesFromCfg(), fromQuali = false } = {}) {
    if (!entries.length) return;
    const notAllowed = entries.map(e => (appData().cars || []).find(c => c.id === e.carId)).filter(c => c && !allowedIn(c, mode));
    if (notAllowed.length) { window.Helpers.showToast?.(`Nur im Training: ${notAllowed.map(c => c.name).join(', ')}`); return; }
    if (!fromQuali) qualiBests = {};
    stopSession();
    delete cfg.hint; saveCfg();
    const t = track();
    const records = trackRecords();
    session = new window.RaceEngine.Session({
      mode,
      laps: mode === 'race' ? cfg.raceLaps : mode === 'quali' ? cfg.qualiLaps : 0,
      entries, track: t, settings: settings(), records, fuel: fuelOnFor(mode),
      finishCount: cfg.finishCount || 0, dqOpenPenalties: !!cfg.dqOpen, fullDistance: !!cfg.fullDistance,
      lapFalseStart: !(cfg.source === 'cu' && window.LiveCU)   // CU: Fehlstart kommt als Ampel 8/9, Durchfahrten vor dem Start sind Fehlmeldungen
    });
    resTab = 'result';
    redPen = {}; redReason = ''; endArmed = 0; resultOrder = null; recPick = new Set(); recState = ''; girpDone = false; girpShown = null; baseRecords = records.slice(); startWall = null;
    session.on(onEngine);
    attachSource(entries, records, t);
    ticker = []; lapFlash = {}; overlay = null; menuCtrl = null; shellKey = '';
    view = 'live';
    session.start(source.now());
    if (session.phase === 'green') source.release(); else source.stopCars?.();   // Rennen: Rot bis zur Startampel
    runLoop();
  }

  /** Datenquelle (CU oder Simulator) anlegen und mit der Sitzung verbinden */
  function attachSource (entries, records, t) {
    source = cfg.source === 'cu' && window.LiveCU ? new window.LiveCU.CuSource() : new window.LiveSim.SimSource();
    const ref = MD.trackSetup(t).refLapMs || 7000;
    const rnd = (a, b) => a + Math.random() * (b - a);
    source.prepare(entries.map(e => {
      const own = records.filter(r => r.driverId === e.driverId && r.carId === e.carId).map(r => r.ms);
      return { ctrl: e.ctrl, paceMs: own.length ? Math.min(...own) * rnd(1.01, 1.05) : ref * rnd(0.84, 0.95) };
    }), { refLapMs: ref });
    entries.forEach(e => source.setTuning?.(e.ctrl, tuningOf(e.carId)));   // Tuning merken (CU: ist im Auto gespeichert, nur bei Änderung senden)
    source.setPitInfo?.(ctrl => {
      const c = session?.cars.get(ctrl);
      return c ? { fuel: session.fuelOn ? c.fuel : null, penaltyLeftMs: c.inPit ? c.penaltyMs : 0, penaltyOpen: c.penaltyMs > 0 } : {};
    });
    source.on(ev => { session?.handle(ev); });
  }

  function runLoop () {
    clearInterval(loop);
    loop = setInterval(() => { if (!session) return; session.tick(source.now()); saveSnap(); renderLive(); }, 200);
    try { navigator.wakeLock?.request('screen').then(l => { wakeLock = l; }).catch(() => {}); } catch (e) {}
    saveSnap(true);
    renderLive();
  }

  // ---------- Sicherung: Rennen nach Absturz / Neuladen fortsetzen ----------
  const SNAP = 'lcSession';
  let snapAt = 0;
  function saveSnap (force = false) {
    broadcast(force);
    if (!session || !source || (!force && Date.now() - snapAt < 1000)) return;
    snapAt = Date.now();
    try {
      localStorage.setItem(SNAP, JSON.stringify({ at: snapAt, snap: session.snapshot(source.now()), qualiBests, baseRecords, redReason, startWall, lightsRunning: false }));
    } catch (e) { console.warn('Sicherung fehlgeschlagen', e); }
  }
  function readSnap () {
    try { const x = JSON.parse(localStorage.getItem(SNAP) || 'null'); return x?.snap?.v === 1 ? x : null; } catch (e) { return null; }
  }
  function clearSnap () { try { localStorage.removeItem(SNAP); } catch (e) {} }

  function restoreSession () {
    const saved = readSnap();
    if (!saved || session) return;
    const records = saved.snap.opts.records || [];
    const entries = saved.snap.cars.map(c => ({ ctrl: c.ctrl, driverId: c.driverId, carId: c.carId }));
    qualiBests = saved.qualiBests || {};
    baseRecords = saved.baseRecords || records.slice();
    resTab = 'result'; redPen = {}; endArmed = 0; resultOrder = null; recPick = new Set(); recState = ''; girpDone = false; girpShown = null;
    startWall = saved.startWall || null;
    attachSource(entries, records, saved.snap.opts.track || {});
    session = window.RaceEngine.Session.restore(saved.snap, source.now());
    session.on(onEngine);
    // CU: Boxenstatus wie vor dem Absturz annehmen, damit nur echte Änderungen gemeldet werden
    if (source.pit) for (const c of session.cars.values()) source.pit[c.ctrl] = !!c.inPit;
    redReason = session.phase === 'red' ? 'crash' : '';
    ticker = []; lapFlash = {}; overlay = null; menuCtrl = null; shellKey = '';
    note(null, 'Sitzung wiederhergestellt', 'red');
    view = 'live';
    if (session.phase === 'finished' && session.mode === 'race') recPick = new Set(recordCandidates().map(r => r.key));
    if (session.phase === 'finished' && session.mode === 'practice') source.release?.();
    else if (session.phase !== 'green') source.stopCars?.();
    runLoop();
  }

  /** Tuning eines Fahrzeugs (CU-Stufen); ohne Eintrag 100 % / 100 % */
  const tuningOf = carId => {
    const t = (appData().cars || []).find(c => c.id === carId)?.tuning;
    return { speed: t?.speed ?? MD.MAX_LEVEL, brake: t?.brake ?? MD.MAX_LEVEL };
  };
  /** Tuning sofort an die Bahn und ans Fahrzeug (Firestore, nur Admin) */
  function saveTuning (carId, tuning) {
    const car = (appData().cars || []).find(c => c.id === carId);
    if (car) car.tuning = tuning;
    if (window.isAdmin && window.Storage?.updateCarFields) window.Storage.updateCarFields(carId, { tuning }).catch(err => window.Helpers.showToast?.(`Tuning nicht gespeichert: ${err.message}`, { icon: 'alert' }));
  }
  const TUNE_DELAY_MS = 750;   // Tristan 18.11.: 0,75 s nach dem letzten Tipp senden
  const tuneCarId = ctrl => session ? session.cars.get(ctrl)?.carId : cfg.assign[ctrl]?.carId;
  /** −/+ für Gas oder Bremse: eine CU-Stufe (0–15) pro Tipp */
  function stepperHtml (ctrl, k, label, val) {
    return `<div class="lc-step" role="group" aria-label="${label}">
      <button class="lc-step-btn" data-act="tune" data-ctrl="${ctrl}" data-tune="${k}" data-dir="-1" aria-label="${label} eine Stufe weniger" ${val <= 0 ? 'disabled' : ''}>−</button>
      <b class="lc-step-val">${MD.levelToPct(val)} %</b>
      <button class="lc-step-btn" data-act="tune" data-ctrl="${ctrl}" data-tune="${k}" data-dir="1" aria-label="${label} eine Stufe mehr" ${val >= MD.MAX_LEVEL ? 'disabled' : ''}>+</button>
    </div>`;
  }
  /** Stand der Übertragung für einen Regler (Text für die Tuning-Zeile) */
  function tuneState (ctrl) {
    if (tuneTimers[ctrl]) return { cls: 'wait', txt: 'wird gesendet …' };
    if (cuHub()?.pending?.[ctrl]) return { cls: 'wait', txt: 'gesendet · Auto einmal über einen Sensor fahren' };
    if (tuneOk[ctrl]) return { cls: 'ok', txt: '✓ im Auto' };
    return null;
  }
  /** Tipp auf −/+: sofort anzeigen, kurz nach dem letzten Tipp speichern und an die CU senden */
  function tuneStep (ctrl, k, dir) {
    const carId = tuneCarId(ctrl);
    if (carId == null) return;
    const t = tuningOf(carId), v = MD.clampLevel(t[k] + dir);
    if (v === t[k]) return;
    t[k] = v;
    const car = (appData().cars || []).find(c => c.id === carId);
    if (car) car.tuning = { ...t };
    tuneOk[ctrl] = false;
    clearTimeout(tuneTimers[ctrl]);
    tuneTimers[ctrl] = setTimeout(() => { delete tuneTimers[ctrl]; tuneSend(ctrl, true); }, TUNE_DELAY_MS);
    refreshTune();
  }
  function tuneSend (ctrl, save) {
    const carId = tuneCarId(ctrl);
    if (carId == null) return;
    const t = tuningOf(carId);
    if (save) saveTuning(carId, t);
    tuneOk[ctrl] = false;
    // Freigeben (ESC) nur, wo nichts gewertet wird: Vorbereitung und Quali-Ergebnis
    if (session) source?.setTuning?.(ctrl, t, { send: true, release: session.mode === 'quali' && session.phase === 'finished' });
    else cuHub()?.program?.(ctrl, t, { release: true });
    refreshTune();
  }
  function refreshTune () {
    if (root?.hidden) return;
    if (session) { shellKey = ''; renderLive(); return; }
    const box = root?.querySelector('#lcTune');
    if (box) box.innerHTML = tuneCardHtml();
  }
  /** Vorbereitung: Tuning aller eingeteilten Fahrer auf einen Blick */
  /**
   * Tuning als Kacheln, zweispaltig in derselben Anordnung der Reglerfarben wie die Zuweisung (Tristan 21.11.).
   * In der Vorbereitung bleiben leere Regler als Platzhalter stehen, damit die Farben an derselben Stelle sind.
   */
  function tuneCardHtml () {
    const list = session ? [...session.cars.values()].map(c => ({ ctrl: c.ctrl, driverId: c.driverId, carId: c.carId })) : entriesFromCfg();
    if (!list.length || !canEdit()) return '';
    const h = cuHub(), on = cfg.source === 'cu' && h?.state === 'connected';
    const byCtrl = Object.fromEntries(list.map(e => [e.ctrl, e]));
    const slots = session ? MD.CONTROLLERS.filter(c => byCtrl[c.n]) : MD.CONTROLLERS;
    const tiles = slots.map(c => {
      const e = byCtrl[c.n];
      if (!e) return `<div class="lc-tune-tile empty" style="${ctrlStyle(c.n)}"></div>`;
      const t = tuningOf(e.carId), st = tuneState(e.ctrl);
      return `<div class="lc-tune-tile" style="${ctrlStyle(e.ctrl)}">
        <div class="lc-tune-top"><b>${esc(driverName(e.driverId))}</b>
          <button class="lc-btn lc-ghost lc-tune-send" data-act="tuneSend" data-ctrl="${e.ctrl}" ${on && !tuneTimers[e.ctrl] ? '' : 'disabled'} title="Werte noch einmal an das Auto senden">Senden</button></div>
        <small class="lc-tune-car">${esc(carName(e.carId))}</small>
        <div class="lc-tune-line"><span>Gas</span>${stepperHtml(e.ctrl, 'speed', 'Gas', t.speed)}</div>
        <div class="lc-tune-line"><span>Bremse</span>${stepperHtml(e.ctrl, 'brake', 'Bremse', t.brake)}</div>
        ${st ? `<em class="lc-tune-st ${st.cls}">${esc(st.txt)}</em>` : ''}
      </div>`;
    }).join('');
    return `<h3>Tuning</h3>
      <div class="lc-tune-tiles">${tiles}</div>
      <p class="lc-note">${cfg.source !== 'cu' ? 'Wird am Fahrzeug gespeichert.' : on ? 'Jeder Tipp ist eine Stufe. Autos codiert auf die Bahn stellen, gesendet wird kurz nach dem letzten Tipp und am Fahrzeug gespeichert.' : 'Wird am Fahrzeug gespeichert. An die Autos geht es erst, wenn die CU verbunden ist (dann „Senden“).'}</p>`;
  }

  /** Simulator: Grundtempo einer Paarung aus ihrem Rekord, sonst aus der Referenzrunde */
  function simPace (driverId, carId) {
    const rnd = (a, b) => a + Math.random() * (b - a);
    const own = baseRecords.filter(r => r.driverId === driverId && r.carId === carId).map(r => r.ms);
    return own.length ? Math.min(...own) * rnd(1.01, 1.05) : (MD.trackSetup(track()).refLapMs || 7000) * rnd(0.84, 0.95);
  }

  /**
   * Neue Rekorde der Sitzung: beste (nicht unterbrochene) Runde je Paarung, schneller als der bisherige
   * persönliche Rekord dieser Paarung auf der Strecke.
   */
  function recordCandidates () {
    if (!session) return [];
    const min = list => list.reduce((m, r) => (m == null || r.ms < m ? r.ms : m), null);
    const trackBest = min(baseRecords) ?? Infinity;
    const list = [];
    for (const c of session.allCars()) {
      for (const [carKey, best] of Object.entries(c.pairBests)) {
        const carId = isNaN(+carKey) ? carKey : +carKey;
        const ms = Math.round(best);
        const pairPrev = min(baseRecords.filter(r => r.driverId === c.driverId && r.carId === carId));
        if (pairPrev != null && ms >= pairPrev) continue;
        const driverPrev = min(baseRecords.filter(r => r.driverId === c.driverId));
        const carPrev = min(baseRecords.filter(r => r.carId === carId));
        list.push({
          key: `${c.driverId}|${carId}`, ctrl: c.ctrl, driverId: c.driverId, carId, ms, pairPrev, driverPrev, carPrev,
          driverBest: driverPrev == null || ms < driverPrev, carBest: carPrev == null || ms < carPrev
        });
      }
    }
    list.sort((a, b) => a.ms - b.ms);
    if (list[0] && list[0].ms < trackBest) list[0].track = true;   // nur die schnellste kann Streckenrekord sein
    return list;
  }

  async function saveRecords () {
    const picked = recordCandidates().filter(r => recPick.has(r.key));
    if (!picked.length) return;
    if (!(window.RecordsUI?.persistRecord && window.isAdmin)) { window.Helpers.showToast?.('Rekorde speichern geht nur in der App mit Admin-Anmeldung'); return; }
    recState = 'saving'; renderLive();
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let saved = 0;
    for (const r of picked) {
      try { if (await window.RecordsUI.persistRecord({ driverId: r.driverId, carId: r.carId, time: r.ms / 1000, date }) !== 'slower') saved++; } catch (err) { window.Helpers.showToast?.(`Fehler beim Speichern: ${err.message}`, { icon: 'alert' }); }
    }
    recState = 'done';
    window.Helpers.showToast?.(saved === 1 ? '1 Rekord übernommen' : `${saved} Rekorde übernommen`);
    renderLive();
  }

  // ---------- Ergebnis direkt in G!RP speichern ----------
  const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function resultEntries () {
    const byCtrl = new Map([...session.cars.values()].map(c => [c.ctrl, c]));
    return (resultOrder || []).map((c, i) => ({ ctrl: c, position: i + 1, driverId: byCtrl.get(c).driverId, carId: byCtrl.get(c).carId,
      carLaps: window.RaceEngine.Session.carLapsOf(byCtrl.get(c)).map(({ carId, laps }) => ({ carId, laps })) }));
  }
  /** Vorschau der G!RP-Änderung je Regler – dieselbe Rechnung wie beim Speichern (Elo.applyRace), auf einer Kopie */
  function girpPreview () {
    if (!window.Elo?.applyRace || !resultOrder) return null;
    const drivers = structuredClone(appData().drivers || []), cars = structuredClone(appData().cars || []);
    const entries = resultEntries();
    const results = [];
    for (const e of entries) {
      const d = drivers.find(x => String(x.id) === String(e.driverId)), c = cars.find(x => String(x.id) === String(e.carId));
      if (!d || !c) return null;
      results.push({ ctrl: e.ctrl, position: e.position, driverId: d.id, carId: c.id });
    }
    if (results.length < 2) return null;
    const race = { rounds: session.laps, baseK: appData().raceSettings?.baseK, results };
    const k = window.Elo.applyRace(race, drivers, cars);
    const out = { k };
    race.results.forEach(r => { out[r.ctrl] = { d: r.driverEloChange, c: r.carEloChange, dNew: r.newDriverElo, cNew: r.newCarElo }; });
    return out;
  }
  let girpSaving = false, girpShown = null;   // girpShown: Änderungen für die Zuschauer
  async function saveGirp () {
    if (!session || !resultOrder || girpDone || girpSaving || !canEdit()) return;
    if (!window.RaceUI?.saveRaceResult) { window.Helpers.showToast?.('Speichern geht nur in der App'); return; }
    girpSaving = true; shellKey = ''; renderLive();
    if (!recState && recPick.size) await saveRecords();     // angehakte Rekorde gleich mit
    const preview = girpPreview();
    const d = new Date(startWall || Date.now());   // Rennbeginn, nicht Speicherzeitpunkt
    const res = window.RaceUI.saveRaceResult({
      date: isoDate(d), time: d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
      rounds: session.laps, entries: resultEntries()
    });
    girpSaving = false;
    if (res.error) { window.Helpers.showToast?.(`Nicht gespeichert: ${res.error}`, { icon: 'alert' }); shellKey = ''; renderLive(); return; }
    girpDone = true; girpShown = preview;
    clearSnap();
    window.Helpers.showToast?.('Ergebnis in G!RP gespeichert');
    castFull = false; broadcast(true);
    shellKey = ''; renderLive();
  }

  /** Quali bzw. Rennen mit denselben Fahrern, Autos und derselben Startaufstellung von vorn */
  function restartEvent () {
    if (!session || session.mode === 'practice') return;
    const mode = session.mode;
    const entries = [...session.cars.values()].sort((a, b) => a.grid - b.grid).map(c => ({ ctrl: c.ctrl, driverId: c.driverId, carId: c.carId }));
    cfg.mode = mode; saveCfg();
    endArmed = 0; restartArmed = false;
    startSession({ mode, entries, fromQuali: true });
    note(null, `${MODE_LABEL[mode]} neu gestartet`);
  }
  const restartLabel = () => `${session.mode === 'race' ? 'Rennen' : 'Quali'} neu starten`;

  /** Nach dem Qualifying: Rennen mit der Quali-Reihenfolge als Startaufstellung */
  function raceFromQuali () {
    const grid = session.standings().map(s => ({ ctrl: s.ctrl, driverId: s.driverId, carId: s.carId }));
    qualiBests = Object.fromEntries(session.standings().filter(s => s.best != null).map(s => [`${s.driverId}|${s.carId}`, s.best]));
    cfg.mode = 'race'; saveCfg();
    startSession({ mode: 'race', entries: grid, fromQuali: true });
  }

  function lightsGo () {
    if (!session || session.phase !== 'lights') return;
    window.Voice?.preload?.()?.catch?.(() => {});   // Countdown-Ansagen ohne Ladeverzögerung
    source.startLights();
    session.lightsRunning = true;
    renderLive();
  }

  // Tankbalken: orange ab „muss an die Box“, rot ab „jetzt tanken“, blinkend wenn leer
  const fuelClass = s => s.fuelEmpty ? 'empty' : s.fuel <= session.settings.fuelCritPct ? 'low crit' : s.fuel <= session.settings.pitCallFuelPct ? 'low' : '';

  // ---------- Meldungen der Engine → Sprache + Laufschrift ----------
  const PRIO = { lights: 9, go: 9, redFlag: 10, resume: 9, win: 8, pole: 8, trackRecord: 7, finishPlace: 7, falseStart: 7, lastLap: 6, fiveToGo: 6, halfway: 6, status: 6, carRecord: 6, personalRecord: 5, pitCall: 5, fuelCritical: 6, noSignal: 6, leadChange: 5, fastestLap: 4, penaltyServed: 4, refueled: 3, qualiDone: 3, pitIn: 2 };
  // So lange darf nichts Unwichtigeres dazwischenreden (ms, sonst 2,2 s) – z. B. der Glückwunsch zum Sieg / zur Pole
  const HOLD = { win: 4500, pole: 4000, trackRecord: 3500 };
  // Diese Ansagen werden nicht verworfen, sondern nachgeholt, wenn gerade Wichtigeres läuft
  // (und unterbrechen sich nicht gegenseitig: Platz 2 und Platz 3 kurz hintereinander)
  const WAIT = new Set(['finishPlace', 'status', 'qualiDone', 'noSignal', 'fuelCritical']);
  function say (type, key, driverId, tries = 0) {
    if (!voiceOn || !window.Voice) return;
    if (type === 'qualiDone' && (session?.phase === 'finished' || tries && session?.mode !== 'quali')) return;   // nach der Pole nicht mehr nachholen
    const now = performance.now();
    const prio = PRIO[type] || 1;
    if (now < lastSay.until && (prio < lastSay.prio || (WAIT.has(type) && WAIT.has(lastSay.type)))) {   // Wichtiges nicht abwürgen
      if (WAIT.has(type) && tries < 4) setTimeout(() => say(type, key, driverId, tries + 1), lastSay.until - now + 150);
      return;
    }
    lastSay = { prio, type, at: now, until: now + (HOLD[type] || 2200) };
    try { window.Voice.announce(key, driverId)?.catch?.(() => {}); } catch (e) {}
  }
  function note (ctrl, text, kind = '') {
    ticker.unshift({ ctrl, text, kind, at: Date.now() });
    ticker = ticker.slice(0, 4);
  }

  function onEngine (type, d) {
    const name = d?.driverId != null ? driverName(d.driverId) : '';
    switch (type) {
      case 'lights': say(type, `count_${6 - d.step}`); break;
      case 'go':
        say(type, 'count_go');
        if (!d.restart && startWall == null) startWall = Date.now();
        if (session.mode === 'race') overlay = { kind: 'go', until: performance.now() + 1400 };
        else if (d.restart) note(null, 'Strecke wieder frei');
        session.lightsRunning = false;
        break;
      case 'lap': lapFlash[d.ctrl] = performance.now(); break;
      case 'trackRecord': say(type, 'track_record', d.driverId); note(d.ctrl, `${name}: Streckenrekord ${fmt(d.ms)} s`, 'rec'); break;
      case 'personalRecord': say(type, 'personal_record', d.driverId); note(d.ctrl, `${name}: persönlicher Rekord ${fmt(d.ms)} s`, 'pb'); break;
      case 'fastestLap':
        if (session.mode === 'race' && (session.cars.get(d.ctrl)?.laps ?? 0) >= 2) { say(type, 'fastest_lap', d.driverId); note(d.ctrl, `${name}: schnellste Runde ${fmt(d.ms)} s`, 'fl'); }
        break;
      case 'pitCall': say(type, 'pit_call', d.driverId); note(d.ctrl, `${name}: Tank bald leer`, 'warn'); break;
      case 'fuelCritical': say(type, 'fuel_critical', d.driverId); note(d.ctrl, `${name}: jetzt tanken!`, 'warn'); break;
      case 'fuelEmpty': source?.limitSpeed?.(d.ctrl, d.level); note(d.ctrl, `${name}: Tank leer – gedrosselt`, 'warn'); break;
      case 'fuelRestored': source?.limitSpeed?.(d.ctrl, null); break;
      case 'noSignal': say(type, 'no_signal', d.driverId); note(d.ctrl, `${name}: seit ${d.sec} s keine Runde gezählt – Auto prüfen`, 'warn'); break;
      case 'signalBack': note(d.ctrl, `${name}: Runden kommen wieder an`); break;
      case 'status':
        if (d.status) { say(type, d.status === 'dq' ? 'dq' : 'dnf', d.driverId); note(d.ctrl, `${name}: ${d.status === 'dq' ? 'disqualifiziert' : 'ausgefallen'}`, 'warn'); }
        break;
      case 'carRecord':   // nur wenn das Fahrzeug schon eine Zeit hatte und es kein Streckenrekord ist (der wird eigens angesagt)
        if (d.previous != null && !d.trackRecord) { say(type, 'car_record', d.driverId); note(d.ctrl, `${name}: Fahrzeugrekord ${fmt(d.ms)} s`, 'rec'); }
        break;
      case 'leadChange': say(type, 'lead_change', d.driverId); note(d.ctrl, `${name} übernimmt die Führung`); break;
      case 'finish': if (session.mode === 'race' && (d.position === 2 || d.position === 3)) say('finishPlace', `place_${d.position}`, d.driverId); break;
      case 'halfway': say(type, 'halfway'); note(null, 'Halbzeit'); break;
      case 'fiveToGo': say(type, 'five_to_go'); note(null, 'Noch 5 Runden'); break;
      case 'pitIn': say(type, 'in_pit', d.driverId); break;
      case 'refueled': say(type, 'refueled', d.driverId); break;
      case 'penalty': note(d.ctrl, `${name}: ${d.reason} +${d.sec} s`, 'warn'); break;
      case 'penaltyServed': say(type, 'penalty_served', d.driverId); note(d.ctrl, `${name}: Strafe abgesessen`); break;
      case 'falseStart': say(type, 'false_start', d.driverId); break;
      case 'redFlag': say(type, 'red_flag'); source?.stopCars(); session.lightsRunning = false; redReason = d.reason; redPen = {}; menuCtrl = null; note(null, { short: 'Rote Flagge – Kurzschluss', falseStart: 'Rote Flagge – Fehlstart', buzzer: 'Rote Flagge – Buzzer' }[d.reason] || 'Rote Flagge', 'red'); break;
      case 'resume':
        say(type, 'race_resume');
        overlay = { kind: 'resume', until: performance.now() + 1800 };
        if (d.lights) setTimeout(() => lightsGo(), 1800); else source?.release();
        break;
      case 'lastLap': say(type, 'last_lap'); note(null, 'Letzte Runde!'); break;
      case 'win': say(type, 'race_win', d.driverId); note(d.ctrl, `${name} gewinnt!`, 'win'); break;
      case 'qualiDone': say(type, 'quali_done', d.driverId); note(d.ctrl, `${name}: Quali beendet`); break;
      case 'pole': say(type, 'pole', d.driverId); break;
      case 'end': if (session.mode === 'practice') source?.release(); else source?.stopCars();   // Training: Strecke gleich wieder frei (Tristan 20.11.)
        try { countLaps(); } catch (e) { console.error(e); } recPick = new Set(recordCandidates().map(r => r.key)); break;
    }
    if (type !== 'lap' && type !== 'change') { renderLive(); saveSnap(true); }   // Wichtiges (Strafen, Rote Flagge …) sofort sichern
  }

  // ---------- Live-Ansicht ----------
  const sec1 = ms => (ms / 1000).toFixed(1).replace('.', ',');
  /** Rundenzahl; in jeder Session (Training, Quali, Rennen) läuft in der ersten Runde (nach der ersten Durchfahrt) stattdessen eine Stoppuhr */
  function lapsCell (s) {
    const c = session?.cars.get(s.ctrl);
    if (c && c.started && c.laps === 0 && !c.finished && !s.status && c.lastCross != null) {
      const tNow = session.phase === 'green' ? source.now() : (session.redAt ?? session.endT ?? source.now());
      return `<div class="lc-num lc-laps lc-watch${s.noSignal ? ' lc-nosignal' : ''}">${sec1(Math.max(0, tNow - c.lastCross - (c.pausedMs || 0)))}</div>`;
    }
    // Nur im Rennen: nach „Los“ noch nicht über Start/Ziel (ab 0,5 s) blinkender Strich – fällt sofort auf, wenn ein Auto nicht erfasst wird.
    // Im Training/in der Quali fahren die Autos aus der Box los, da wäre der Strich nur Unruhe.
    if (session?.mode === 'race' && c && !c.started && !s.status && session.phase === 'green' && session.goT != null && source.now() - session.goT > 500) {
      return '<div class="lc-num lc-laps lc-waiting">–</div>';
    }
    // Rennen: lange keine Durchfahrt (Diode kaputt?) → Rundenzahl blinkt
    if (s.noSignal) return `<div class="lc-num lc-laps lc-nosignal" title="Keine Runde mehr gezählt – Auto prüfen">${s.laps}</div>`;
    return `<div class="lc-num lc-laps">${s.laps}</div>`;
  }

  /** Fahrzeugbild (eigenes Bild aus dem Setup oder assets/cars/NN.png), einmal pro Fahrzeug geladen */
  const carImgs = {};
  let setupRaf = 0;
  const renderSetupSoon = () => { if (!setupRaf) setupRaf = requestAnimationFrame(() => { setupRaf = 0; if (!session && view === 'setup' && !root?.hidden) renderSetup(); }); };
  function carImg (carId) {
    if (!(carId in carImgs)) {
      carImgs[carId] = null;
      const car = (appData().cars || []).find(c => c.id === carId);
      const hook = window.Livecenter?.carImage;
      const p = hook ? Promise.resolve(hook(car)) : window.SetupUI?.carImageSrc ? window.SetupUI.carImageSrc(car) : Promise.resolve(null);
      p.then(src => { carImgs[carId] = src || ''; if (!src || root?.hidden) return; if (session) { shellKey = ''; renderLive(); } else if (view === 'setup') renderSetupSoon(); }).catch(() => { carImgs[carId] = ''; });
    }
    return carImgs[carId];
  }

  const carCell = (carId, img) => `<div class="lc-car">${img ? `<img src="${img}" alt="${esc(carName(carId))}">` : `<small>${esc(carName(carId))}</small>`}</div>`;

  // ---------- Nach dem Event: Tabelle, Runden, Statistik ----------
  const swatchName = s => `<span class="lc-st-who" style="${ctrlStyle(s.ctrl)}"><i></i>${who(s.driverId)}</span>`;

  /** Abschlusstabelle: Position, Fahrer, Fahrzeug, Beste, Ø, Quali, Runden, Stopps, Gesamtzeit/Abstand */
  function detailsHtml (ordered, stats, fastestMs, race) {
    const lead = ordered[0];
    const gapCell = s => {
      if (s.status) return s.status === 'dq' ? 'DQ' : 'DNF';
      if (!race) return s.ctrl === lead.ctrl ? '' : fmtGap(s);
      if (s.ctrl === session.standings()[0].ctrl) return fmtTotal(s.total);
      if (s.gapLaps > 0) return `+${s.gapLaps} Rd.`;
      return s.gap != null ? `+${(s.gap / 1000).toFixed(3).replace('.', ',')}` : '–';
    };
    const q = s => qualiBests[`${s.driverId}|${s.carId}`];
    return `<div class="lc-table-wrap"><table class="lc-table">
      <thead><tr><th>Pos</th><th class="l">Fahrer</th><th>Auto</th><th>Beste</th><th>Ø Runde</th>${race ? '<th>Quali</th>' : ''}<th>Runden</th>${race ? '<th>Stopps</th><th>Strafen</th>' : ''}<th>${race ? 'Zeit / Abstand' : 'Abstand'}</th></tr></thead>
      <tbody>${ordered.map((s, i) => `<tr class="${s.status ? 'out' : ''}">
        <td class="c"><b>${i + 1}</b></td><td class="l">${swatchName(s)}</td>
        <td class="c lc-table-car">${carImg(s.carId) ? `<img src="${carImg(s.carId)}" alt="${esc(carName(s.carId))}">` : esc(carName(s.carId))}</td>
        <td class="${s.best != null && s.best === fastestMs ? 'fl' : ''}">${fmt(s.best)}</td>
        <td>${fmt(stats.avgMs[s.ctrl] != null ? Math.round(stats.avgMs[s.ctrl]) : null)}</td>
        ${race ? `<td>${fmt(q(s) ?? null)}</td>` : ''}
        <td>${s.laps}</td>${race ? `<td>${s.pitStops}</td><td>${s.penaltyTotalSec ? `${sec1(s.penaltyTotalSec * 1000)} s` : '–'}</td>` : ''}<td>${gapCell(s)}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="lc-note">Ø ohne unterbrochene Runden (Rote Flagge, Fahrzeugwechsel).${race ? ' Strafen: Summe aller vergebenen Strafen, abzüglich Gutschriften.' : ''}${race && !Object.keys(qualiBests).length ? ' Quali-Zeiten gibt es, wenn das Rennen direkt aus dem Qualifying gestartet wurde.' : ''}</p>`;
  }

  /** Alle Runden aller Fahrer: Zeile je Runde, schnellste markiert, Boxenstopp markiert */
  function lapsHtml (ordered, stats, fastestMs) {
    if (!stats.maxLaps) return '<p class="lc-note">Keine Runden gefahren.</p>';
    const rows = [];
    for (let n = 1; n <= stats.maxLaps; n++) {
      rows.push(`<tr><td class="c">${n}</td>${ordered.map(s => {
        const l = stats.laps[s.ctrl][n - 1];
        if (!l) return '<td></td>';
        const cls = [l.ms === fastestMs && !l.interrupted ? 'fl' : !l.interrupted && l.ms === s.best ? 'pb' : '', l.interrupted ? 'int' : ''].join(' ');
        return `<td class="${cls}">${fmt(l.ms)}${l.pit ? '<em class="lc-pitmark" title="Boxenstopp">B</em>' : ''}</td>`;
      }).join('')}</tr>`);
    }
    return `<div class="lc-table-wrap lc-laps-wrap"><table class="lc-table lc-laps">
      <thead><tr><th>Rd.</th>${ordered.map(s => `<th style="${ctrlStyle(s.ctrl)}" class="lc-laps-head">${who(s.driverId)}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>
      <p class="lc-legend"><span class="fl">lila</span> schnellste Runde des Events · <span class="pb">grün</span> beste Runde des Fahrers · <em class="lc-pitmark">B</em> Boxenstopp in dieser Runde · <span class="int">grau</span> unterbrochen</p>`;
  }

  /** Statistik: Boxenstopps, Führungsrunden (Balken), Entwicklung der Position (Linien in Reglerfarbe) */
  function statsHtml (ordered, stats) {
    const bars = (title, val) => {
      const max = Math.max(1, ...ordered.map(val));
      return `<section class="lc-chart"><h3>${title}</h3>${ordered.map(s => `<div class="lc-bar-row" title="${who(s.driverId)}: ${val(s)}">
          ${swatchName(s)}<span class="lc-bar-track"><i style="${ctrlStyle(s.ctrl)};width:${(val(s) / max * 100).toFixed(1)}%"></i></span><b>${val(s)}</b></div>`).join('')}</section>`;
    };
    // Liniendiagramm: x = Runde, y = Position (1 oben)
    const n = ordered.length, L = stats.maxLaps;
    const W = 760, H = 300, l = 40, r = 120, t = 14, b = 30;
    const x = k => l + (L <= 1 ? 0 : (k - 1) / (L - 1) * (W - l - r));
    const y = p => t + (n <= 1 ? 0 : (p - 1) / (n - 1) * (H - t - b));
    const ticks = Array.from({ length: L }, (_, i) => i + 1).filter(k => k === 1 || k === L || k % Math.max(1, Math.ceil(L / 10)) === 0);
    const lines = ordered.map(s => {
      const pts = stats.positions[s.ctrl].map((p, i) => p ? `${x(i + 1).toFixed(1)},${y(p).toFixed(1)}` : null).filter(Boolean);
      if (!pts.length) return '';
      const last = stats.positions[s.ctrl].length;
      const c = MD.controller(s.ctrl);
      return `<g><title>${who(s.driverId)}</title>
        <polyline points="${pts.join(' ')}" fill="none" stroke="#0E0F12" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/>
        <polyline points="${pts.join(' ')}" fill="none" stroke="${c.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" ${c.color === '#000000' ? 'class="lc-line-black"' : ''}/>
        <text x="${x(last) + 8}" y="${y(stats.positions[s.ctrl][last - 1]) + 5}" class="lc-line-label">${who(s.driverId)}</text></g>`;
    }).join('');
    const chart = `<section class="lc-chart lc-chart-wide"><h3>Entwicklung der Position</h3>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Position nach jeder Runde">
        ${Array.from({ length: n }, (_, i) => `<line x1="${l}" x2="${W - r}" y1="${y(i + 1)}" y2="${y(i + 1)}" class="lc-grid-line"/><text x="${l - 10}" y="${y(i + 1) + 5}" class="lc-axis" text-anchor="end">${i + 1}</text>`).join('')}
        ${ticks.map(k => `<text x="${x(k)}" y="${H - 8}" class="lc-axis" text-anchor="middle">${k}</text>`).join('')}
        ${lines}
      </svg><p class="lc-note">Position nach jeder Runde (Runde unten, Platz links).</p></section>`;
    return `<div class="lc-stats">${chart}<div class="lc-stats-side">${bars('Boxenstopps', s => s.pitStops)}${bars('Führungsrunden', s => stats.leadLaps[s.ctrl] || 0)}</div></div>`;
  }

  function renderLive () {
    if (!root || view !== 'live' || !session) return;
    const st = session.standings();
    const now = performance.now();
    const t = source.now();
    const phase = session.phase;
    const race = session.mode === 'race';
    const leadLaps = session.leaderLaps();
    const clocks = session.clocks(t);

    let progress = '';
    if (race) progress = `<span class="lc-lapno">${Math.min(leadLaps + (session.goT != null && phase !== 'finished' && !session.leaderFinished ? 1 : 0), session.laps)}</span><span class="lc-lapof">/ ${session.laps}</span>`;
    else if (session.mode === 'quali') progress = `<span class="lc-lapof">${session.laps} Runden je Fahrer</span>`;
    const flag = {
      ready: ['Startaufstellung', 'ready'], lights: [session.restarts ? 'Neustart' : 'Start', 'ready'],
      green: session.leaderFinished ? ['Zielflagge', 'chk'] : ['Grüne Flagge', 'green'],
      red: ['Rote Flagge', 'red'], finished: ['Beendet', 'chk']
    }[phase];
    const clockHtml = race
      ? `<div class="lc-clock"><small>Rennzeit</small><b>${fmtTotal(clocks.race)}</b></div><div class="lc-clock"><small>Gesamt</small><b>${clock(clocks.total)}</b></div>`
      : `<div class="lc-clock"><small>Zeit</small><b>${clock(clocks.total)}</b></div>`;
    const tr = session.trackRecord;
    const trHtml = tr ? `<small>Streckenrekord</small><b>${fmt(tr.ms)}</b><small>${who(tr.driverId)}${tr.session ? ' · heute' : ''}</small>` : '<small>Noch kein<br>Streckenrekord</small>';

    const rows = st.map(s => {
      const flash = now - (lapFlash[s.ctrl] || 0) < 900;
      const img = carImg(s.carId);
      const bestCls = s.sessionBest ? 'sb' : (s.best != null && s.personalRecord != null && s.best <= s.personalRecord ? 'pb' : '');
      const out = s.status === 'dq' ? 'DQ' : s.status === 'dnf' ? 'DNF' : '';
      const cls = ['lc-row', flash && 'flash', (s.finished || s.done || out) && 'done', menuCtrl === s.ctrl && 'menu', s.servingPenalty && 'serving', s.inPit && 'inpit', out && 'out'].filter(Boolean).join(' ');
      const common = `<div class="lc-pos"><span>${out ? '–' : s.pos}</span></div>${carCell(s.carId, img)}<div class="lc-who"><b>${who(s.driverId)}</b></div>
        ${lapsCell(s)}
        <div class="lc-num lc-last ${s.lastInterrupted ? 'int' : ''}">${fmt(s.last)}</div>
        <div class="lc-num lc-best ${bestCls}">${fmt(s.best)}</div>
        <div class="lc-num lc-gap">${out ? '' : fmtGap(s)}</div>`;
      const fuel = `<div class="lc-fuel ${fuelClass(s)} ${s.inPit && !s.servingPenalty ? 'filling' : ''}"><i style="width:${s.fuel.toFixed(1)}%"></i><span>${s.fuelEmpty ? 'leer' : Math.round(s.fuel) + ' %'}</span></div>`;
      if (!race) {
        const status = s.done ? '<span class="lc-badge chk">Fertig</span>' : s.inPit ? '<span class="lc-badge pit">Box</span>' : '';
        return `<div class="${cls}" style="${ctrlStyle(s.ctrl)}" data-ctrl="${s.ctrl}">${common}
          ${session.fuelOn ? `<div class="lc-fuelcell">${fuel}</div>` : ''}<div class="lc-num lc-rec">${fmt(s.personalRecord)}</div><div class="lc-status">${status}</div></div>`;
      }
      const box = s.inPit
        ? `<div class="lc-box on"><b>BOX</b><span>${sec1(s.pitStandMs)} s</span></div>`
        : `<div class="lc-box"><b>${s.pitStops}</b><span>Stopp${s.pitStops === 1 ? '' : 's'}</span></div>`;
      const pen = out ? `<span class="lc-badge out">${out}</span>`
        : s.penaltySec > 0 ? `<span class="lc-pen ${s.servingPenalty ? 'run' : ''}">${s.servingPenalty ? '' : '+'}${sec1(s.penaltySec * 1000)}</span>`
          : s.finished ? '<span class="lc-badge chk">Ziel</span>' : '';
      return `<div class="${cls}" style="${ctrlStyle(s.ctrl)}" data-ctrl="${s.ctrl}">${common}
        <div class="lc-fuelcell">${fuel}</div>${box}<div class="lc-status">${pen}</div></div>`;
    }).join('');

    const lightsHtml = (() => {
      if (overlay && now < overlay.until && overlay.kind === 'go') return `<div class="lc-lights go"><div class="lc-lamps">${'<i></i>'.repeat(5)}</div><div class="lc-go">LOS!</div></div>`;
      // Startaufstellung mit Tank (vor dem Start alle 100 %, nach Roter Flagge der echte Stand)
      const gridHtml = `<div class="lc-grid-list">${st.map(s => `<span style="${ctrlStyle(s.ctrl)}"><i></i>${who(s.driverId)}${session.fuelOn && !s.status ? `<span class="lc-fuel lc-grid-fuel ${fuelClass(s)}"><i style="width:${s.fuel.toFixed(1)}%"></i><span>${s.fuelEmpty ? 'leer' : Math.round(s.fuel) + ' %'}</span></span>` : ''}</span>`).join('')}</div>`;
      if (overlay && now < overlay.until && overlay.kind === 'resume') return `<div class="lc-lights"><div class="lc-go">Weiter geht's!</div>${gridHtml}</div>`;
      if (phase !== 'lights') return '';
      const lit = session.lights;
      const ready = !session.lightsRunning;
      return `<div class="lc-lights">
        <div class="lc-lamps">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= lit ? 'on' : ''}"></i>`).join('')}</div>
        ${ready && !canEdit() ? '<p class="lc-note">Start nur mit Admin-Anmeldung</p>' : ''}
        ${gridHtml}
        ${ready && canEdit() ? `<button class="lc-btn lc-primary lc-big" data-act="lights">${session.restarts ? 'Weiter geht\'s' : 'Rennen starten'}</button>` : ''}
      </div>`;
    })();

    // Rote Flagge: im Rennen sofort der Strafendialog. Keiner, einer oder mehrere Fahrer – je eine eigene Strafe.
    const redHtml = phase !== 'red' ? '' : race ? `<div class="lc-red lc-red-pen">
        <div class="lc-red-head"><div class="lc-red-title">ROTE FLAGGE</div><p>${redReason === 'short' ? 'Kurzschluss – Strom ist aus.' : redReason === 'crash' ? 'Verbindung war weg – Rennen wiederhergestellt.' : 'Rennen unterbrochen.'} ${canEdit() ? 'Strafen in Sekunden vergeben, Fahrzeuge einsetzen, dann „Weiter geht\'s“.' : 'Weiter geht es, sobald der Admin freigibt.'}</p></div>
        <div class="lc-pen-list">${st.map(s => {
          const sel = redPen[s.ctrl] || 0;
          const out = s.status;
          const state = s.inPit ? `<em class="lc-pen-pit">Box ${sec1(s.pitStandMs)} s</em>` : '';
          const gap = out ? '' : s.pos === 1 ? `Rd. ${s.laps}` : fmtGap(s);
          return `<div class="lc-pen-row ${sel ? 'on' : ''} ${out ? 'out' : ''}" style="${ctrlStyle(s.ctrl)}">
            <span class="lc-pen-pos">${out ? '–' : s.pos}</span>
            <span class="lc-pen-name"><span class="lc-pen-nm">${who(s.driverId)}</span>${state}${s.penaltySec ? `<em class="lc-pen-open">offen ${sec1(s.penaltySec * 1000)} s</em>` : ''}</span>
            ${(() => {
              // Laufende Rundenzeit beim Abbruch: 0,xxx → Durchfahrt wurde gezählt, 6,xxx → noch nicht über der Linie
              const lapMs = session.redLapMs(s.ctrl), car = session.cars.get(s.ctrl), manual = !!car?.manualUndo;
              // „+1 Rd.“ nur, wenn die laufende Runde länger als die minimale Rundenzeit ist – sonst kann sie nicht schon über der Linie gewesen sein
              const canPlus = session.canAddManualLap(s.ctrl);
              const btn = canEdit() ? (manual
                ? `<button class="lc-btn lc-pen-plus on" data-act="lapUndo" data-ctrl="${s.ctrl}" title="Nachgezählte Runde zurücknehmen">−1 Rd.</button>`
                : `<button class="lc-btn lc-pen-plus" data-act="lapAdd" data-ctrl="${s.ctrl}" title="Runde nachzählen: war schon über Start/Ziel, die CU hat es nicht mehr erfasst" ${canPlus ? '' : 'style="visibility:hidden" disabled'}>+1 Rd.</button>`) : '';
              return `<span class="lc-pen-lap ${manual ? 'manual' : ''}" title="Laufende Rundenzeit beim Abbruch">${lapMs == null ? '–' : fmt(lapMs)}</span>${btn}`;
            })()}
            <span class="lc-pen-gap">${gap}</span>
            ${session.fuelOn ? `<span class="lc-fuel lc-pen-fuel ${fuelClass(s)}" title="Tank"><i style="width:${s.fuel.toFixed(1)}%"></i><span>${s.fuelEmpty ? 'leer' : Math.round(s.fuel) + ' %'}</span></span>` : ''}
            ${canEdit() ? `<span class="lc-pen-opts">${[0, ...session.settings.penaltyOptionsSec].map(sec => `<button class="lc-btn ${sel === sec ? 'on' : ''}" data-act="redPen" data-ctrl="${s.ctrl}" data-sec="${sec}" ${out ? 'disabled' : ''}>${sec ? `+${String(sec).replace('.', ',')}` : '0'}</button>`).join('')}<button class="lc-btn lc-credit" data-act="credit" data-ctrl="${s.ctrl}" title="Gutschrift: 5 s von der offenen Strafe abziehen" ${s.penaltySec && !out ? '' : 'style="visibility:hidden" disabled'}>−5</button></span>
            <span class="lc-pen-acts">
              <button class="lc-btn lc-pen-dmg" data-act="dmgOpen" data-ctrl="${s.ctrl}" ${out ? 'disabled' : ''}>Schaden</button>
              <button class="lc-btn lc-pen-st ${out === 'dnf' ? 'on' : ''}" data-act="redStatus" data-s="dnf" data-ctrl="${s.ctrl}">DNF</button>
              <button class="lc-btn lc-pen-st ${out === 'dq' ? 'on' : ''}" data-act="redStatus" data-s="dq" data-ctrl="${s.ctrl}">DQL</button>
            </span>` : `<span class="lc-pen-gap">${out === 'dq' ? 'DQL' : out === 'dnf' ? 'DNF' : ''}</span>`}
          </div>`;
        }).join('')}</div>
        ${canEdit() ? `<div class="lc-red-actions">
          <button class="lc-btn lc-big lc-white" data-act="resume">Weiter geht's</button>
          <button class="lc-btn lc-ghost" data-act="restart">${restartArmed ? 'Wirklich neu starten?' : restartLabel()}</button>
          <button class="lc-btn lc-ghost" data-act="finish">Beenden</button>
        </div>` : ''}
      </div>` : `<div class="lc-red">
        <div class="lc-red-title">ROTE FLAGGE</div>
        <p>${redReason === 'short' ? 'Kurzschluss – Strom ist aus.' : redReason === 'crash' ? 'Verbindung war weg – Sitzung wiederhergestellt.' : 'Unterbrochen.'} Fahrzeuge wieder einsetzen.</p>
        ${canEdit() ? `<div class="lc-red-actions">
          <button class="lc-btn lc-big lc-white" data-act="resume">Weiter</button>
          ${session.mode === 'quali' ? `<button class="lc-btn lc-ghost" data-act="restart">${restartArmed ? 'Wirklich neu starten?' : restartLabel()}</button>` : ''}
          <button class="lc-btn lc-ghost" data-act="finish">Beenden</button>
        </div>` : ''}
      </div>`;

    // „Hauptmenü“ während der Sitzung: Rückfrage. Die Sitzung läuft im Hintergrund weiter, „Live“ führt direkt hierher zurück.
    const endHtml = !endArmed || phase === 'finished' || phase === 'ready' ? '' : `<div class="lc-endask"><div class="lc-endask-box">
        <h3>Wirklich ins Hauptmenü zurückkehren?</h3>
        <p class="lc-note">${MODE_LABEL[session.mode]} bleibt erhalten${phase === 'green' ? ' und läuft weiter' : ''}. Über „Live“ kommst du direkt hierher zurück.</p>
        <button class="lc-btn lc-primary lc-big" data-act="toMenu">Ja</button>
        <button class="lc-btn lc-ghost" data-act="endCancel">Nein</button>
      </div></div>`;

    // G!RP-Änderung je Zeile: Admin = Vorschau (bzw. gespeichert), Zuschauer = was das iPad mitschickt
    let girpData = null;   // wird im Ergebnis berechnet, sobald die Reihenfolge feststeht
    // Kästchen: neuer Gesamtwert + Änderung, z. B. „1100 (+6)“
    const chip = (v, total) => (v == null ? '' : `<em>${total ?? ''} (<span class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v)}</span>)</em>`);
    const girpLine = ctrl => { const g = girpData?.[ctrl]; return g ? `<small class="lc-girp ${girpDone || source.kind === 'view' ? 'saved' : ''}">G!RP ${chip(g.d, g.dNew)} · Auto ${chip(g.c, g.cNew)}</small>` : ''; };

    // ---------- Ergebnis: Reihenfolge korrigierbar, Rekorde übernehmen, G!RP auswerten ----------
    const resultHtml = phase !== 'finished' ? '' : (() => {
      if (!resultOrder) resultOrder = st.map(s => s.ctrl);
      girpData = !race ? null : source.kind === 'view' ? girpShown : canEdit() ? (girpDone ? girpShown : girpPreview()) : null;
      const byCtrl = new Map(st.map(s => [s.ctrl, s]));
      const ordered = resultOrder.map(c => byCtrl.get(c)).filter(Boolean);
      const edited = resultOrder.join() !== st.map(s => s.ctrl).join();
      const lead = st[0];
      // Schnellste Runde des Events: besonders markiert
      const fastestMs = st.reduce((m, s) => (s.best != null && (m == null || s.best < m) ? s.best : m), null);
      const flCell = s => `<span class="lc-num ${s.best != null && s.best === fastestMs ? 'lc-fl' : ''}">${fmt(s.best)}${s.best != null && s.best === fastestMs ? '<em>Schnellste</em>' : ''}</span>`;
      const timeCell = s => {
        if (!race) return fmt(s.best);
        if (s.status) return '';
        if (s.ctrl === lead.ctrl) return fmtTotal(s.total);
        if (s.gapLaps > 0) return `+${s.gapLaps} Rd.`;
        return s.gap != null ? `+${(s.gap / 1000).toFixed(3).replace('.', ',')}` : '–';
      };
      const recs = recordCandidates();
      const canSave = !!(window.RecordsUI?.persistRecord && window.isAdmin);
      const recHtml = !recs.length || source.kind === 'view' ? '' : `<section class="lc-res-box">
          <h3>Neue Rekorde</h3>
          ${recs.map(r => `<label class="lc-rec-row" style="${ctrlStyle(r.ctrl)}"><input type="checkbox" data-rec="${r.key}" ${recPick.has(r.key) ? 'checked' : ''} ${recState === 'done' || !canEdit() ? 'disabled' : ''}>
            <i></i><b>${who(r.driverId)}</b>${carImg(r.carId) ? `<img src="${carImg(r.carId)}" alt="${esc(carName(r.carId))}">` : `<small>${esc(carName(r.carId))}</small>`}<span class="lc-num">${fmt(r.ms)}</span>
            <span class="lc-tags">
              ${r.track ? '<em class="t-track">Streckenrekord</em>' : ''}
              ${r.driverBest ? `<em class="t-driver">Fahrer-Rekord${r.driverPrev != null ? ` · bisher ${fmt(r.driverPrev)}` : ' · erster'}</em>` : ''}
              ${r.carBest ? `<em class="t-car">Fahrzeug-Rekord${r.carPrev != null ? ` · bisher ${fmt(r.carPrev)}` : ' · erster'}</em>` : ''}
              ${!r.driverBest && !r.carBest ? `<em>Bestzeit dieser Paarung · bisher ${fmt(r.pairPrev)}</em>` : ''}
            </span></label>`).join('')}
          <button class="lc-btn ${recState === 'done' ? '' : 'lc-primary'}" data-act="saveRecords" ${recState || !recPick.size || !canEdit() ? 'disabled' : ''}>${recState === 'done' ? 'Rekorde übernommen' : recState === 'saving' ? 'Speichere …' : 'Neue Rekorde übernehmen'}</button>
          ${canSave ? '' : '<p class="lc-note">Speichern geht nur in der App mit Admin-Anmeldung.</p>'}
        </section>`;
      const tabs = [['result', 'Übersicht'], ['details', 'Tabelle'], ['laps', 'Runden'], ...(race ? [['stats', 'Statistik']] : [])];
      const tabHtml = `<div class="lc-seg lc-res-tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-act="resTab" data-t="${k}" class="${resTab === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
      const girpNote = girpData && resTab === 'result' ? `<p class="lc-note lc-girp-note">${girpDone || source.kind === 'view' ? 'In G!RP gespeichert' : 'Vorschau G!RP-Änderung'} · ${session.laps} Runden · K ${girpData.k ?? '–'}</p>` : '';
      const head = `<h2>${race ? 'Ergebnis' : session.mode === 'quali' ? 'Qualifying' : 'Training'}</h2>${tabHtml}${girpNote}`;
      const qualiTune = session.mode === 'quali' && canEdit() && source.kind !== 'view' ? `<div class="lc-tune-card lc-res-tune">${tuneCardHtml()}</div>` : '';
      const actions = `${qualiTune}<div class="lc-red-actions">
          ${race && canEdit() ? `<button class="lc-btn lc-primary lc-big" data-act="girp" ${girpDone || girpSaving ? 'disabled' : ''}>${girpDone ? 'In G!RP gespeichert ✓' : girpSaving ? 'Speichere …' : `Ergebnis speichern${recPick.size && !recState ? ' (mit Rekorden)' : ''}`}</button>` : ''}
          ${session.mode === 'quali' && canEdit() ? `<button class="lc-btn lc-primary lc-big" data-act="raceFromQuali">Rennen mit ${cfg.raceLaps} Runden starten</button>
            <span class="lc-laps-adj"><button class="lc-btn" data-act="raceLaps" data-d="-1" aria-label="eine Runde weniger">−</button><button class="lc-btn" data-act="raceLaps" data-d="1" aria-label="eine Runde mehr">+</button></span>` : ''}
          ${session.mode !== 'practice' && canEdit() && !girpDone ? `<button class="lc-btn" data-act="restartNow">${restartLabel()}</button>` : ''}
          ${source.kind === 'view' || (race && girpDone && canEdit()) ? '' : '<button class="lc-btn" data-act="again">Zurück zur Vorbereitung</button>'}
          ${race && girpDone && canEdit() ? `<div class="lc-next"><span>Nächstes Rennen</span>
            <button class="lc-btn" data-act="next" data-how="same">Gleiche Paarungen</button>
            <button class="lc-btn" data-act="next" data-how="swap">Autos rotieren</button>
            <button class="lc-btn lc-primary" data-act="next" data-how="new">Neue Zuteilung</button></div>` : ''}
          ${race && canEdit() && !girpDone ? `<button class="lc-link-btn" data-act="noScore">${noScoreArmed ? 'Wirklich verwerfen?' : 'Nicht werten'}</button>` : ''}
          ${session.mode === 'practice' && source.kind !== 'view' ? '' : '<button class="lc-btn lc-ghost" data-act="close">Schließen</button>'}
        </div>`;
      if (resTab !== 'result') {
        const stats = session.stats();
        const page = resTab === 'details' ? detailsHtml(ordered, stats, fastestMs, race) : resTab === 'laps' ? lapsHtml(ordered, stats, fastestMs) : statsHtml(ordered, stats);
        return `<div class="lc-result">${head}${page}${actions}</div>`;
      }
      return `<div class="lc-result">
        ${head}
        <div class="lc-res-grid ${race ? 'is-race' : ''} ${race && canEdit() && !girpDone ? 'can-move' : ''}">
          <div class="lc-res-head"><span>Pos</span><span>Auto</span><span>Fahrer</span><span>${race ? 'Runden' : ''}</span><span>${race ? 'Gesamtzeit' : 'Beste Runde'}</span><span>${race ? 'Schnellste Runde' : 'Abstand'}</span><span></span>${race && canEdit() && !girpDone ? '<span>Reihenfolge</span>' : ''}</div>
          ${ordered.map((s, i) => {
            const out = s.status === 'dq' ? `DQ${s.dqReason ? ` · ${s.dqReason}` : ''}` : s.status === 'dnf' ? 'DNF' : '';
            return `<div class="lc-res-row ${out ? 'out' : ''} ${i === 0 ? 'first' : ''}" style="${ctrlStyle(s.ctrl)}">
              <span class="lc-pos"><span>${i + 1}</span></span>
              ${carCell(s.carId, carImg(s.carId))}
              <span class="lc-res-who"><b>${who(s.driverId)}</b>${girpLine(s.ctrl)}</span>
              <span class="lc-num">${race ? s.laps : ''}</span>
              ${race ? `<span class="lc-num">${timeCell(s)}</span>` : flCell(s)}
              ${race ? flCell(s) : `<span class="lc-num">${fmtGap(s)}</span>`}
              ${out ? `<span class="lc-badge out">${esc(out)}</span>` : s.penaltySec ? `<span class="lc-badge pen">+${sec1(s.penaltySec * 1000)} s</span>` : '<span></span>'}
              ${race && canEdit() && !girpDone ? `<span class="lc-move"><button class="lc-btn" data-act="move" data-ctrl="${s.ctrl}" data-d="-1" ${i === 0 || girpDone ? 'disabled' : ''} aria-label="nach oben">▲</button><button class="lc-btn" data-act="move" data-ctrl="${s.ctrl}" data-d="1" ${i === ordered.length - 1 || girpDone ? 'disabled' : ''} aria-label="nach unten">▼</button></span>` : ''}
            </div>`;
          }).join('')}
        </div>
        ${race && canEdit() && !girpDone ? `<p class="lc-note">${edited ? 'Reihenfolge von Hand geändert. ' : ''}Mit ▲ ▼ korrigierst du die Zielreihenfolge, bevor sie in die G!RP-Wertung geht.</p>` : ''}
        ${recHtml}
        ${actions}
      </div>`;
    })();

    // Fahrzeug wechseln und Tuning: Training/Quali jederzeit, im Rennen nur bei Roter Flagge
    function carTuneHtml (c, locked) {
      // Rennen: Autotausch nur noch über „Schaden“ (kritisch → Ersatzauto), Tuning steckt schon im Auto
      if (race) return `<div class="lc-menu-label">Autotausch im Rennen nur über „Schaden“${locked ? ' bei Roter Flagge' : ''} (kritisch → Ersatzauto). Tuning: vor dem Rennen in der Vorbereitung oder nach der Quali.</div>`;
      if (locked) return '<div class="lc-menu-label">Fahrzeug tauschen: bei Roter Flagge.</div>';
      const used = [...session.cars.values()].filter(x => x.ctrl !== c.ctrl).map(x => x.carId);
      const opts = cars([c.carId], session.mode).filter(x => !used.includes(x.id));
      const tu = tuningOf(c.carId);
      const st = tuneState(c.ctrl);
      const slider = (k, label) => `<div class="lc-tune"><span>${label}</span>${stepperHtml(c.ctrl, k, label, tu[k])}</div>`;
      const sel = `<div class="lc-menu-label">Fahrzeug</div>
        <select class="lc-menu-sel" data-carswap="${c.ctrl}">${opts.map(x => `<option value="${x.id}" ${x.id === c.carId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`;
      return `${sel}
        <div class="lc-menu-label">Tuning · wird ans Fahrzeug gespeichert${st ? ` · <span class="lc-tune-st ${st.cls}">${esc(st.txt)}</span>` : ''}</div>
        ${slider('speed', 'Gas')}${slider('brake', 'Bremse')}`;
    }

    const menuHtml = menuCtrl != null && session.cars.get(menuCtrl) && phase !== 'finished' && canEdit() ? (() => {
      const c = session.cars.get(menuCtrl);
      return `<div class="lc-menu" style="${ctrlStyle(menuCtrl)}">
        <div class="lc-menu-head"><span class="lc-swatch"></span><b>${who(c.driverId)}</b><button class="lc-icon-btn" data-act="menuClose" aria-label="Schließen">×</button></div>
        ${race && phase !== 'red' ? `<div class="lc-menu-label">Zeitstrafe (in der Box absitzen)${c.penaltyMs ? ` · offen +${sec1(c.penaltyMs)} s` : ''}</div>
        <div class="lc-menu-btns">${session.settings.penaltyOptionsSec.map(sec => `<button class="lc-btn" data-act="penalty" data-sec="${sec}">+${String(sec).replace('.', ',')} s</button>`).join('')}</div>
        <div class="lc-menu-btns">
          ${c.penaltyMs ? '<button class="lc-btn lc-credit" data-act="credit" data-ctrl="' + c.ctrl + '">Gutschrift −5 s</button><button class="lc-btn lc-ghost" data-act="penaltyClear">Alles zurücknehmen</button>' : ''}
        </div>
        <div class="lc-menu-btns">
          ${c.status ? `<button class="lc-btn" data-act="status" data-s="">${c.status === 'dq' ? 'DQ' : 'DNF'} aufheben</button>`
            : '<button class="lc-btn" data-act="status" data-s="dnf">Ausgefallen (DNF)</button><button class="lc-btn lc-danger" data-act="status" data-s="dq">Disqualifizieren</button>'}
        </div>` : ''}
        ${carTuneHtml(c, race && phase !== 'red')}
        ${session.mode === 'practice' && session.cars.size > 1 ? `<div class="lc-menu-btns"><button class="lc-btn lc-ghost" data-act="removeCar" data-ctrl="${c.ctrl}">Training verlassen</button></div>` : ''}
        ${race && phase !== 'red' ? '<div class="lc-menu-label">Schaden melden: bei Roter Flagge.</div>' : `<div class="lc-menu-btns"><button class="lc-btn lc-dmg-btn" data-act="dmgOpen" data-ctrl="${c.ctrl}">${window.Helpers.icon('alert')}Schaden melden</button></div>`}
      </div>`;
    })() : '';

    // Training: Fahrer auf einem freien Regler dazunehmen
    const freeCtrls = MD.CONTROLLERS.map(x => x.n).filter(n => !session.cars.has(n));
    if (addPanel && (session.mode !== 'practice' || phase === 'finished' || !freeCtrls.length)) addPanel = null;
    if (addPanel && !freeCtrls.includes(addPanel.ctrl)) addPanel.ctrl = freeCtrls[0];
    const addHtml = !addPanel || !canEdit() ? '' : (() => {
      const onD = [...session.cars.values()].map(c => c.driverId), onC = [...session.cars.values()].map(c => c.carId);
      const dOpts = drivers().filter(d => !onD.includes(d.id)), cOpts = cars([], session.mode).filter(x => !onC.includes(x.id));
      const ok = addPanel.driverId != null && addPanel.carId != null;
      return `<div class="lc-menu lc-add" style="${ctrlStyle(addPanel.ctrl)}">
        <div class="lc-menu-head"><span class="lc-swatch"></span><b>Fahrer dazunehmen</b><button class="lc-icon-btn" data-act="addClose" aria-label="Schließen">×</button></div>
        <div class="lc-menu-label">Regler</div>
        <div class="lc-menu-btns lc-add-ctrls">${freeCtrls.map(n => `<button class="lc-btn ${n === addPanel.ctrl ? 'on' : ''}" data-act="addCtrl" data-ctrl="${n}" style="${ctrlStyle(n)}"><span class="lc-swatch"></span>${MD.controller(n).name}</button>`).join('')}</div>
        <div class="lc-menu-label">Fahrer</div>
        <select class="lc-menu-sel" data-add="driverId"><option value="">– Fahrer wählen –</option>${dOpts.map(d => `<option value="${d.id}" ${d.id === addPanel.driverId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
        <div class="lc-menu-label">Fahrzeug</div>
        <select class="lc-menu-sel" data-add="carId"><option value="">– Fahrzeug wählen –</option>${cOpts.map(x => `<option value="${x.id}" ${x.id === addPanel.carId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <div class="lc-menu-btns"><button class="lc-btn lc-primary" data-act="addDo" ${ok ? '' : 'disabled'}>Dazunehmen</button></div>
        <p class="lc-note">Seine Zeit läuft ab der ersten Durchfahrt.</p>
      </div>`;
    })();

    // Schaden melden (Training/Quali jederzeit, Rennen nur bei Roter Flagge); kritisch → gleich Ersatzauto
    if (dmgPanel && (!session.cars.get(dmgPanel.ctrl) || phase === 'finished' || !canEdit() || (race && phase !== 'red'))) dmgPanel = null;
    const dmgHtml = !dmgPanel ? '' : (() => {
      const c = session.cars.get(dmgPanel.ctrl);
      const D = window.Damage;
      // Rennen + kritischer Schaden: kein „Später“ und kein × – entweder Ersatzauto oder DNF
      const mustDecide = race && dmgPanel.step === 'swap';
      const head = `<div class="lc-menu-head"><span class="lc-swatch"></span><b>${dmgPanel.step === 'swap' ? 'Ersatzauto' : 'Schaden'} · ${who(c.driverId)}</b>${mustDecide ? '' : '<button class="lc-icon-btn" data-act="dmgClose" aria-label="Schließen">×</button>'}</div>`;
      if (dmgPanel.step === 'swap') {
        // Genau EIN Vorschlag: freies, nicht gesperrtes, aktives Auto mit der G!RP am nächsten am beschädigten (damage.js)
        const used = [...session.cars.values()].filter(x => x.ctrl !== c.ctrl).map(x => x.carId);
        const damaged = (appData().cars || []).find(x => x.id === dmgPanel.carId);
        const sug = D.suggestReplacement(damaged, appData().cars || [], { exclude: [...used, c.carId], isActive: x => isActive(x) && allowedIn(x, session.mode) });
        const girp = x => Math.round(x?.elo ?? 1000);
        const alt = race || session.mode === 'quali' ? '<button class="lc-btn lc-danger" data-act="dmgDnf">Ohne Ersatz: DNF</button>'
          : session.mode === 'practice' && session.cars.size > 1 ? `<button class="lc-btn lc-danger" data-act="removeCar" data-ctrl="${c.ctrl}">Entfernen</button>` : '';
        return `<div class="lc-menu lc-dmg" style="${ctrlStyle(c.ctrl)}">${head}
          <div class="lc-menu-label"><b class="lc-dmg-crit">${esc(carName(dmgPanel.carId))} ist gesperrt</b> (G!RP ${girp(damaged)}) · ${sug ? 'Vorschlag Ersatzauto' + (race ? ' (gilt ab dem Neustart)' : '') : 'kein freies Fahrzeug'}</div>
          ${sug ? `<button class="lc-btn lc-primary lc-dmg-sug" data-act="dmgSwap" data-car="${sug.id}">${sug && carImg(sug.id) ? `<img src="${carImg(sug.id)}" alt="">` : ''}<span><b>${esc(sug.name)}</b><small>G!RP ${girp(sug)} · übernehmen</small></span></button>` : ''}
          <div class="lc-menu-btns">${alt}${race ? '' : '<button class="lc-btn lc-ghost" data-act="dmgClose">Später</button>'}</div>
        </div>`;
      }
      const openKeys = D.openDamages((appData().cars || []).find(x => x.id === c.carId)).map(d => d.type);
      const group = cat => D.TYPES.filter(t => t.category === cat).map(t => {
        const already = !t.custom && openKeys.includes(t.key);
        return `<button class="lc-btn lc-dmg-type ${t.critical ? 'crit' : 'light'} ${dmgPanel.type === t.key ? 'on' : ''}" data-act="dmgType" data-type="${t.key}" ${already ? 'disabled title="schon offen"' : ''}>${esc(t.category === 'light' ? t.label.replace('Licht ', '') : t.label)}${already ? ' ✓' : ''}</button>`;
      }).join('');
      const sel = dmgPanel.type && D.type(dmgPanel.type);
      const other = !!sel?.custom;
      const crit = other ? !!dmgPanel.critical : !!sel?.critical;
      return `<div class="lc-menu lc-dmg" style="${ctrlStyle(c.ctrl)}">${head}
        <div class="lc-menu-label">${esc(carName(c.carId))} · Licht (fährt weiter)</div>
        <div class="lc-dmg-grid">${group('light')}</div>
        <div class="lc-menu-label">Kritisch (Auto wird gesperrt)</div>
        <div class="lc-dmg-grid">${group('motor')}${group('sensor')}</div>
        <div class="lc-menu-label">Anderer Schaden</div>
        <div class="lc-dmg-grid">${group('other')}${other ? `<button class="lc-btn lc-dmg-crit-tgl ${crit ? 'on' : ''}" data-act="dmgCrit" aria-pressed="${crit}">${crit ? 'kritisch: ja' : 'kritisch: nein'}</button>` : ''}</div>
        <input class="lc-menu-sel lc-dmg-note" data-dmgnote placeholder="${other ? 'Beschreibung (Pflicht)' : 'Notiz (optional)'}" value="${esc(dmgPanel.note || '')}" maxlength="200" enterkeyhint="done">
        <div class="lc-menu-btns"><button class="lc-btn ${crit ? 'lc-danger' : 'lc-primary'}" data-act="dmgSave" ${sel ? '' : 'disabled'}>${sel ? (crit ? 'Eintragen und Auto sperren' : 'Eintragen') : 'Schadensart wählen'}</button></div>
      </div>`;
    })();

    const simHtml = source.kind !== 'sim' ? '' : `<div class="lc-sim ${simOpen ? 'open' : ''}">
        <div class="lc-sim-row"><b>Simulator</b>
          ${[1, 2, 5, 10].map(x => `<button class="lc-btn ${source.speed === x ? 'on' : ''}" data-act="speed" data-x="${x}">×${x}</button>`).join('')}
          <button class="lc-btn lc-danger" data-act="short" ${['green', 'lights'].includes(phase) ? '' : 'disabled'}>Kurzschluss</button>
        </div>
        <div class="lc-sim-row">${st.map(s => `<span class="lc-sim-car" style="${ctrlStyle(s.ctrl)}"><span class="lc-swatch"></span>
          <button class="lc-btn" data-act="simPit" data-ctrl="${s.ctrl}" ${phase === 'green' ? '' : 'disabled'}>Box</button>
          <button class="lc-btn" data-act="simFalse" data-ctrl="${s.ctrl}" ${phase === 'lights' && session.lightsRunning && race ? '' : 'disabled'}>Fehlstart</button>
          <button class="lc-btn ${source.diodeOff?.(s.ctrl) ? 'on' : ''}" data-act="simDiode" data-ctrl="${s.ctrl}" title="Diode aus: Auto fährt, meldet aber keine Runden">Diode</button></span>`).join('')}</div>
      </div>`;

    const tick = ticker.map(n => `<span class="lc-tick ${n.kind}" ${n.ctrl ? `style="${ctrlStyle(n.ctrl)}"` : ''}>${n.ctrl ? '<i></i>' : ''}${esc(n.text)}</span>`).join('');
    const cuWarn = source.kind === 'cu' && cuHub()?.state !== 'connected' ? '<span class="lc-tick red">CU nicht verbunden – Bluetooth prüfen</span>' : '';
    const dg = /[?&]diag\b/.test(location.search) ? source.diag : null;   // Diagnosezeile nur mit ?diag
    const cuDiag = dg ? `<span class="lc-tick muted">CU: ${dg.msgs} Meldungen · ${dg.timers} Durchfahrten (${dg.used} gewertet)${dg.last ? ` · zuletzt ${esc(MD.controller(dg.last.addr)?.name || 'Regler ' + dg.last.addr)} Sensor ${dg.last.sector}` : ''} · Ampel ${cuHub()?.lastStatus?.start ?? '–'} · Phase ${phase}${(() => { const c = dg.last && session.cars.get(dg.last.addr); return c ? ` · Wertung: ${c.laps} Rd., Start ${c.lastCross != null ? 'ja' : 'nein'}${c.rejectedMs != null ? `, verworfen ${Math.round(c.rejectedMs)} ms` : ''}, Mindestzeit ${MD.trackSetup(session.track).minLapMs ?? '–'}` : (dg.last ? ' · Regler nicht im Livecenter' : ''); })()}</span>` : '';
    const stale = source.kind === 'view' && session.phase !== 'finished' && Date.now() - watchAt > 15000 ? `<span class="lc-tick warn">Letzte Übertragung vor ${Math.round((Date.now() - watchAt) / 1000)} s</span>` : '';
    const tickHtml = stale + cuWarn + cuDiag + tick || `<span class="lc-tick muted">${!canEdit() ? 'Eingaben nur mit Admin-Anmeldung.' : race ? 'Fahrer antippen für Strafe, Ausfall oder Disqualifikation.' : 'Fahrer antippen für Fahrzeug und Tuning.'}</span>`;

    // Nur neu aufbauen, wenn sich Knöpfe/Overlays ändern – sonst gehen Fingertipps während des Neuzeichnens verloren
    const overlayOn = overlay && now < overlay.until ? overlay.kind : '';
    const menuCar = menuCtrl != null ? session.cars.get(menuCtrl) : null;
    const key = [canEdit(), phase, session.leaderFinished, simOpen, menuCtrl, JSON.stringify(addPanel), dmgPanel ? `${dmgPanel.ctrl}${dmgPanel.type}${dmgPanel.step}${dmgPanel.carId}${dmgPanel.critical}` : '', menuCar?.carId, session.cars.size, menuCar ? `${menuCar.penaltyMs}${menuCar.status}` : '', voiceOn, overlayOn,
      session.lights, session.lightsRunning, endArmed, restartArmed, noScoreArmed, cfg.broadcast, source.speed, st.length, session.restarts, redReason, JSON.stringify(redPen), cfg.raceLaps, (resultOrder || []).join(), [...recPick].join(), recState, girpDone, girpSaving, resTab,
      phase === 'red' ? st.map(s => s.ctrl + s.status + s.penaltySec + s.inPit + Math.round(s.pitStandMs / 100) + 'L' + s.laps).join() : ''].join('|');
    if (key === shellKey && root.querySelector('.lc-live')) {
      root.querySelector('.lc-board').innerHTML = rows;
      root.querySelector('.lc-progress').innerHTML = progress;
      root.querySelector('.lc-clocks').innerHTML = clockHtml;
      root.querySelector('.lc-trackrec').innerHTML = trHtml;
      root.querySelector('.lc-ticker').innerHTML = tickHtml;
      return;
    }
    shellKey = key;
    const head = race
      ? '<span>Pos</span><span>Auto</span><span>Fahrer</span><span>Rd.</span><span>Letzte</span><span>Beste</span><span>Abstand</span><span>Tank</span><span>Box</span><span>Strafe</span>'
      : `<span>Pos</span><span>Auto</span><span>Fahrer</span><span>Rd.</span><span>Letzte</span><span>Beste</span><span>Abstand</span>${session.fuelOn ? '<span>Tank</span>' : ''}<span>Rekord</span><span></span>`;
    root.innerHTML = `
      <div class="lc-live ${race ? 'is-race' : 'is-free'}${!race && session.fuelOn ? ' has-fuel' : ''} phase-${phase} rows-${st.length}">
        <header class="lc-top">
          <div class="lc-brand">${MODE_LABEL[session.mode]}</div>
          <div class="lc-progress">${progress}</div>
          <div class="lc-flag ${flag[1]}">${flag[0]}</div>
          <div class="lc-clocks">${clockHtml}</div>
          <div class="lc-trackrec">${trHtml}</div>
          <div class="lc-actions">
            ${source.kind === 'view' ? '<span class="lc-btn lc-viewing">Zuschauen</span>' : `<button class="lc-btn lc-ico ${voiceOn ? '' : 'off'}" data-act="voice" aria-pressed="${voiceOn}" title="Ton ${voiceOn ? 'an – antippen zum Ausschalten' : 'aus – antippen zum Einschalten'}" aria-label="Ton ${voiceOn ? 'an' : 'aus'}">${window.Helpers.icon(voiceOn ? 'volume' : 'volume-off')}</button>`}
            ${canEdit() && source.kind !== 'view' ? `<button class="lc-btn lc-ico lc-cast ${cfg.broadcast ? 'on' : 'off'}" data-act="cast" aria-pressed="${cfg.broadcast}" title="Live-Übertragung für Zuschauer ${cfg.broadcast ? 'an – antippen zum Ausschalten' : 'aus – antippen zum Einschalten'}" aria-label="Live-Übertragung ${cfg.broadcast ? 'an' : 'aus'}">${window.Helpers.icon('cast')}</button>` : ''}
            ${canEdit() && source.kind === 'sim' ? `<button class="lc-btn ${simOpen ? 'on' : ''}" data-act="sim">Sim</button>` : ''}
            ${canEdit() && session.mode === 'practice' && ['green', 'red'].includes(phase) ? '<button class="lc-btn lc-yellow" data-act="reset">Zurücksetzen</button>' : ''}
            ${canEdit() && (phase === 'green' || (phase === 'lights' && session.lightsRunning)) ? '<button class="lc-btn lc-danger" data-act="red">Rote Flagge</button>' : ''}
            ${source.kind === 'view' ? '<button class="lc-btn lc-ghost" data-act="close">Schließen</button>' : phase === 'finished' ? '' : '<button class="lc-btn lc-ghost" data-act="end">Hauptmenü</button>'}
          </div>
        </header>
        <div class="lc-head-row">${head}</div>
        <div class="lc-board">${rows}</div>
        ${canEdit() && session.mode === 'practice' && ['green', 'red'].includes(phase) ? `<div class="lc-addbar">
          ${MD.CONTROLLERS.some(x => !session.cars.has(x.n)) ? '<button class="lc-btn" data-act="addOpen">+ Fahrer</button>' : ''}
          <button class="lc-btn" data-act="toPrep">Beenden</button>
        </div>` : ''}
        <footer class="lc-ticker">${tickHtml}</footer>
        ${simHtml}${menuHtml}${addHtml}${dmgHtml}${lightsHtml}${redHtml}${resultHtml}${endHtml}
      </div>`;
  }

  // ---------- Bedienung ----------
  function onClick (e) {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (!canEdit() && !['close', 'voice', 'end', 'again', 'mode'].includes(act)) return;
    const ctrl = b.dataset.ctrl ? +b.dataset.ctrl : null;
    switch (act) {
      case 'close': close(); break;
      case 'mode': cfg.mode = b.dataset.mode; saveCfg(); renderSetup(); break;
      case 'clear': delete cfg.assign[ctrl]; saveCfg(); renderSetup(); break;
      case 'carStep': stepCar(ctrl, +b.dataset.dir); break;
      case 'carPick': if (performance.now() - lastSwipe > 400) { carPick = ctrl; renderSetup(); } break;
      case 'carPickClose': case 'pickClose': carPick = null; drvPick = null; renderSetup(); break;
      case 'drvPick': drvPick = ctrl; carPick = null; renderSetup(); break;
      case 'drvSet': drvPick = null; assignSlot(ctrl, 'driverId', b.dataset.driver === '' ? null : (isNaN(+b.dataset.driver) ? b.dataset.driver : +b.dataset.driver)); break;
      case 'carSet': carPick = null; assignSlot(ctrl, 'carId', b.dataset.car === '' ? null : (isNaN(+b.dataset.car) ? b.dataset.car : +b.dataset.car)); break;
      case 'autoSetup': openAutoSetup(undefined, b.dataset.method || null); break;
      case 'rotateCars': rotateCars(); break;
      case 'next': nextRace(b.dataset.how); break;
      case 'src': cfg.source = b.dataset.src; saveCfg(); renderSetup(); break;
      case 'cuOn': cuHub()?.connect(); renderSetup(); break;
      case 'cuOff': cuHub()?.disconnect(); break;
      case 'tune': tuneStep(ctrl, b.dataset.tune, +b.dataset.dir); break;
      case 'tuneSend': tuneSend(ctrl, false); break;
      case 'start': startSession(); break;
      case 'cast': toggleBroadcast(); if (session) { shellKey = ''; renderLive(); } else renderSetup(); break;
      case 'watch': startWatch(); break;
      case 'resumeSaved': discardArmed = false; restoreSession(); break;
      case 'discardSaved': if (discardArmed) { clearSnap(); discardArmed = false; } else discardArmed = true; renderSetup(); break;
      case 'lights': lightsGo(); break;
      case 'red': session.redFlag(source.now(), 'manual'); break;
      case 'reset': session.reset(source.now()); ticker = []; lapFlash = {}; note(null, 'Zeiten und Runden zurückgesetzt'); renderLive(); break;
      case 'redStatus': session.setStatus(ctrl, session.cars.get(ctrl)?.status === b.dataset.s ? null : b.dataset.s); renderLive(); break;
      case 'resume':
        // Kritischer Schaden im Rennen: erst Ersatzauto übernehmen oder DNF
        if (dmgPanel?.step === 'swap' && session.mode === 'race') { window.Helpers.showToast?.(`Erst entscheiden: Ersatzauto oder DNF für ${driverName(session.cars.get(dmgPanel.ctrl)?.driverId)}`); break; }
        // Strafen aus dem Dialog vergeben, dann „Weiter geht's!“ + Startampel
        for (const [c, sec] of Object.entries(redPen)) if (sec > 0) session.addPenalty(+c, sec, 'Strafe (Rote Flagge)');
        redPen = {};
        session.resume(source.now()); renderLive();
        break;
      case 'lapAdd': if (session.addManualLap(ctrl)) note(ctrl, `${driverName(session.cars.get(ctrl).driverId)}: Runde nachgezählt (+1 Rd.)`); shellKey = ''; saveSnap(true); renderLive(); break;
      case 'lapUndo': if (session.undoManualLap(ctrl)) note(ctrl, `${driverName(session.cars.get(ctrl).driverId)}: nachgezählte Runde zurückgenommen`); shellKey = ''; saveSnap(true); renderLive(); break;
      case 'redPen': redPen[ctrl] = +b.dataset.sec; if (!redPen[ctrl]) delete redPen[ctrl]; renderLive(); break;
      case 'raceFromQuali': raceFromQuali(); break;
      case 'resTab': resTab = b.dataset.t; renderLive(); break;
      case 'move': {
        const i = resultOrder.indexOf(ctrl), j = i + +b.dataset.d;
        if (i >= 0 && j >= 0 && j < resultOrder.length) [resultOrder[i], resultOrder[j]] = [resultOrder[j], resultOrder[i]];
        renderLive(); break;
      }
      case 'saveRecords': saveRecords(); break;
      case 'girp': saveGirp(); break;
      case 'raceLaps': cfg.raceLaps = Math.max(1, cfg.raceLaps + +b.dataset.d); saveCfg(); renderLive(); break;
      case 'openMenu': menuCtrl = ctrl; addPanel = null; dmgPanel = null; renderLive(); break;
      case 'status': session.setStatus(menuCtrl, b.dataset.s || null); menuCtrl = null; renderLive(); break;
      case 'finish': session.finish(source.now()); break;
      case 'again': stopSession(); enterSetup(); break;
      case 'noScore':   // Testrennen: nichts speichern, Sicherung verwerfen
        if (noScoreArmed) { noScoreArmed = false; try { countLaps({ unscored: true }); } catch (err) { console.error(err); } stopSession(); enterSetup(); window.Helpers.showToast?.('Rennen nicht gewertet'); }
        else { noScoreArmed = true; shellKey = ''; renderLive(); setTimeout(() => { noScoreArmed = false; shellKey = ''; renderLive(); }, 3000); }
        break;
      case 'end':
        if (session.phase === 'finished' || session.phase === 'ready') { close(); break; }
        if (!canEdit()) break;
        // Laufende Sitzung: eigene Rückfrage (kein Browser-Dialog, der das Livecenter blockiert)
        endArmed = 1; renderLive();
        break;
      case 'toMenu': endArmed = 0; hide(); break;
      case 'endCancel': endArmed = 0; renderLive(); break;
      case 'restartNow': restartEvent(); break;
      case 'restart':
        if (restartArmed) restartEvent();
        else { restartArmed = true; renderLive(); setTimeout(() => { restartArmed = false; renderLive(); }, 3000); }
        break;
      case 'voice': voiceOn = !voiceOn; try { localStorage.setItem(VOICE_KEY, voiceOn ? 'on' : 'off'); } catch (err) {} if (!voiceOn) window.Voice?.stop?.(); renderLive(); break;
      case 'sim': simOpen = !simOpen; renderLive(); break;
      case 'speed': source.setSpeed(+b.dataset.x); renderLive(); break;
      case 'short': source.short(); break;
      case 'simPit': source.pit(ctrl); break;
      case 'simDiode': source.toggleDiode(ctrl); shellKey = ''; renderLive(); break;
      case 'simFalse': source.falseStart(ctrl); break;
      case 'menuClose': menuCtrl = null; renderLive(); break;
      case 'dmgOpen': if (dmgPanel?.step === 'swap' && session.mode === 'race') break;
        menuCtrl = null; addPanel = null; dmgPanel = { ctrl, type: null, note: '', critical: false, step: 'pick' }; renderLive(); break;
      case 'dmgClose': dmgPanel = null; renderLive(); break;
      case 'dmgType': if (dmgPanel) { dmgPanel.note = root.querySelector('[data-dmgnote]')?.value ?? dmgPanel.note; dmgPanel.type = b.dataset.type; } renderLive(); break;
      case 'dmgSave': saveDamage(); break;
      case 'dmgCrit': if (dmgPanel) { dmgPanel.note = root.querySelector('[data-dmgnote]')?.value ?? dmgPanel.note; dmgPanel.critical = !dmgPanel.critical; } renderLive(); break;
      case 'dmgSwap': if (dmgPanel) { swapCar(dmgPanel.ctrl, isNaN(+b.dataset.car) ? b.dataset.car : +b.dataset.car); dmgPanel = null; } renderLive(); break;
      case 'dmgDnf': if (dmgPanel) { session.setStatus(dmgPanel.ctrl, 'dnf'); note(dmgPanel.ctrl, `${driverName(session.cars.get(dmgPanel.ctrl)?.driverId)}: DNF (Schaden)`); dmgPanel = null; } renderLive(); break;
      case 'penalty': session.addPenalty(menuCtrl, +b.dataset.sec, 'Zeitstrafe'); menuCtrl = null; renderLive(); break;
      case 'credit': {
        const c = session.cars.get(ctrl);
        const got = session.creditPenalty(ctrl, 5);
        if (got) note(ctrl, `${driverName(c.driverId)}: Gutschrift ${sec1(got * 1000)} s`);
        renderLive(); break;
      }
      case 'toPrep': session.finish(source.now()); renderLive(); break;   // Training beenden: Ergebnis mit Rekorden, von dort nur zurück zur Vorbereitung
      case 'addOpen': menuCtrl = null; addPanel = { ctrl: MD.CONTROLLERS.map(x => x.n).find(n => !session.cars.has(n)), driverId: null, carId: null }; renderLive(); break;
      case 'addClose': addPanel = null; renderLive(); break;
      case 'addCtrl': if (addPanel) addPanel.ctrl = ctrl; renderLive(); break;
      case 'addDo': addDriver(); break;
      case 'removeCar': {
        const c = session.cars.get(ctrl);
        if (c && session.removeCar(ctrl)) {
          source?.removeCar?.(ctrl);
          delete cfg.assign[ctrl]; saveCfg();
          note(ctrl, `${driverName(c.driverId)} ist raus, ${MD.controller(ctrl).name} ist frei`);
        }
        menuCtrl = null; dmgPanel = null; renderLive(); break;
      }
      case 'penaltyClear': session.clearPenalty(menuCtrl); note(menuCtrl, `${driverName(session.cars.get(menuCtrl).driverId)}: Strafe zurückgenommen`); menuCtrl = null; renderLive(); break;
    }
  }

  /** Fahrzeug eines Reglers tauschen (Menü „Fahrzeug“ und Ersatzauto nach Schaden) */
  function swapCar (ctrl, carId) {
    if (!session?.changeCar(ctrl, carId)) return false;
    const c = session.cars.get(ctrl);
    source?.setPace?.(ctrl, simPace(c.driverId, carId));
    if (session.mode !== 'race') source?.setTuning?.(ctrl, tuningOf(carId), { send: true });   // Rennen: Tuning steckt schon im Auto
    if (cfg.assign[ctrl]) { cfg.assign[ctrl].carId = carId; saveCfg(); }
    note(ctrl, `${driverName(c.driverId)} fährt jetzt ${carName(carId)}`);
    saveSnap(true);
    return true;
  }

  /**
   * Schaden sofort ins Werkstatttagebuch des Fahrzeugs (Firestore) – nicht erst mit dem Ergebnis,
   * damit er auch bei „Nicht werten“ erhalten bleibt. Kritisch → Ersatzauto-Auswahl.
   */
  function saveDamage () {
    if (!dmgPanel || !session || !canEdit()) return;
    const c = session.cars.get(dmgPanel.ctrl);
    const car = c && (appData().cars || []).find(x => x.id === c.carId);
    const t = window.Damage?.type(dmgPanel.type);
    if (!car || !t) return;
    const noteTxt = (root.querySelector('[data-dmgnote]')?.value ?? dmgPanel.note ?? '').trim();
    if (t.custom && !noteTxt) { window.Helpers.showToast?.('Bitte den Schaden beschreiben'); root.querySelector('[data-dmgnote]')?.focus(); return; }
    const crit = t.custom ? !!dmgPanel.critical : t.critical;
    const tot = MD.carTotals(car.id, appData().allRaces || appData().races || [], car);
    const { damages, duplicate } = window.Damage.addDamage(car, {
      type: t.key, note: noteTxt, critical: crit, context: { practice: 'Training', quali: 'Quali', race: 'Rennen' }[session.mode],
      // bisherige Runden + in dieser Sitzung schon mit genau diesem Fahrzeug gefahrene (alle Regler, Autotausch berücksichtigt)
      lapsAtDamage: tot.laps + (session.carLapTotals()[car.id] || 0)
    });
    if (duplicate) { window.Helpers.showToast?.(`${t.label} ist bei ${car.name} schon eingetragen`); dmgPanel = null; renderLive(); return; }
    car.damages = damages;   // sofort wirksam (Sperre), der Listener bestätigt
    window.Storage?.updateCarFields?.(car.id, { damages })
      .catch(err => window.Helpers.showToast?.(`Schaden nicht gespeichert: ${err.message}`, { icon: 'alert' }));
    note(c.ctrl, `${car.name}: Schaden ${t.custom ? `Sonstige (${noteTxt})` : t.label}${crit ? ' – gesperrt' : ''}`, crit ? 'red' : 'warn');
    dmgPanel = crit ? { ctrl: c.ctrl, step: 'swap', carId: car.id } : null;
    shellKey = ''; renderLive();
  }

  /** Training: Fahrer aus dem Dazunehmen-Feld auf den freien Regler setzen */
  function addDriver () {
    if (!addPanel || !session) return;
    const { ctrl, driverId, carId } = addPanel;
    if (!session.addCar({ ctrl, driverId, carId })) { window.Helpers.showToast?.('Geht nicht: Regler oder Fahrer schon belegt'); return; }
    source?.addCar?.({ ctrl, paceMs: simPace(driverId, carId) });
    source?.setTuning?.(ctrl, tuningOf(carId), { send: true });
    cfg.assign[ctrl] = { driverId, carId }; saveCfg();
    note(ctrl, `${driverName(driverId)} fährt jetzt mit, ${carName(carId)} auf ${MD.controller(ctrl).name}`);
    addPanel = null; saveSnap(true); renderLive();
  }

  function onChange (e) {
    if (session && !canEdit()) return;
    const add = e.target.closest('select[data-add]');
    if (add && addPanel) {
      addPanel[add.dataset.add] = add.value ? (isNaN(+add.value) ? add.value : +add.value) : null;
      renderLive(); return;
    }
    const swap = e.target.closest('select[data-carswap]');
    if (swap && session) {
      const ctrl = +swap.dataset.carswap, carId = isNaN(+swap.value) ? swap.value : +swap.value;
      swapCar(ctrl, carId);
      shellKey = ''; renderLive(); return;
    }
    const rec = e.target.closest('input[data-rec]');
    if (rec) { rec.checked ? recPick.add(rec.dataset.rec) : recPick.delete(rec.dataset.rec); renderLive(); return; }
    const sel = e.target.closest('select[data-ctrl]');
    if (sel) {
      assignSlot(+sel.dataset.ctrl, sel.dataset.kind, sel.value ? (isNaN(+sel.value) ? sel.value : +sel.value) : null);
      return;
    }
    const inp = e.target.closest('[data-cfg]');
    if (inp) {
      const k = inp.dataset.cfg;
      if (k === 'dqOpen') cfg.dqOpen = inp.checked;
      else if (k === 'fullDistance') cfg.fullDistance = inp.checked;
      else if (k === 'fuelPractice' || k === 'fuelQuali') cfg[k] = inp.checked;
      else if (k === 'finishCount') cfg.finishCount = +inp.value || 0;
      else cfg[k] = Math.max(1, Math.min(999, Math.round(+inp.value || 0)));
      saveCfg(); renderSetup();
    }
  }

  window.Livecenter = { open, close, onClose: null, get session () { return session; } };
})();
