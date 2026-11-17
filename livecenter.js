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
  let cfg = loadCfg();
  let ticker = [];
  let lapFlash = {};
  let overlay = null;          // { kind: 'go' | 'resume', until }
  let simOpen = false;
  let menuCtrl = null;         // Regler, dessen Strafen-Menü offen ist
  let voiceOn = readVoice();
  let lastSay = { prio: 0, at: 0 };
  let shellKey = '';
  let endArmed = 0;            // „Beenden“: Auswahl (werten / neu starten / weiterfahren) offen
  let restartArmed = false;    // „Neu starten“ in der Roten Flagge zweimal tippen
  let redPen = {};             // Strafendialog bei Roter Flagge: { ctrl: Sekunden }
  let redReason = '';
  let resultOrder = null;      // Ergebnis-Reihenfolge (Regler), von Hand korrigierbar
  let recPick = new Set();     // ausgewählte neue Rekorde
  let recState = '';           // '' | 'saving' | 'done'
  let girpDone = false;
  let baseRecords = [];        // Rekorde dieser Strecke beim Start der Sitzung
  let resTab = 'result';       // Ergebnis-Seite: result | details | laps | stats
  let discardArmed = false;   // „Verwerfen“ der gesicherten Sitzung zweimal tippen
  let qualiBests = {};         // beste Quali-Runde je Paarung ("driverId|carId" → ms), fürs Rennen danach

  // ---------- Daten aus der App ----------
  const appData = () => window.appData || {};
  // Auswahl nur aktive Fahrer/Fahrzeuge (wie „Nur aktive“ in den Listen); bereits eingeteilte bleiben sichtbar
  const isActive = x => (window.Elo?.isActive ? window.Elo.isActive(x) : !!x && !x.archived && !x.hideFromRanking);
  const drivers = (keep = []) => [...(appData().drivers || [])].filter(d => isActive(d) || keep.includes(d.id)).sort((a, b) => a.name.localeCompare(b.name));
  const cars = (keep = []) => [...(appData().cars || [])].filter(c => isActive(c) || keep.includes(c.id)).sort((a, b) => a.name.localeCompare(b.name));
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
    return { source: c.source === 'sim' ? 'sim' : 'cu', mode: c.mode || 'practice', raceLaps: c.raceLaps || 60, qualiLaps: c.qualiLaps || 3, assign: c.assign || {}, lastCar: c.lastCar || {}, finishCount: c.finishCount || 0, dqOpen: !!c.dqOpen, fullDistance: !!c.fullDistance };
  }
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
  const canEdit = () => !!window.isAdmin;

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
        menuCtrl = menuCtrl === ctrl ? null : ctrl;
        renderLive();
      });
      root.addEventListener('change', onChange);
    }
    document.documentElement.classList.add('lc-open');
    root.hidden = false;
    shellKey = '';
    watchCu();
    if (!session) { view = 'setup'; renderSetup(); } else renderLive();
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
  function countLaps () {
    if (!session || session.lapsCounted || session.mode === 'race' || !window.isAdmin || !window.Storage?.updateDriverFields) return;
    session.lapsCounted = true;
    const inc = n => firebase.firestore.FieldValue.increment(n);
    const byDriver = {}, byCar = {};
    for (const c of session.cars.values()) {
      if (!(c.laps > 0)) continue;
      byDriver[c.driverId] = (byDriver[c.driverId] || 0) + c.laps;
      byCar[c.carId] = (byCar[c.carId] || 0) + c.laps;
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
    try { countLaps(); } catch (e) { console.error(e); }
    clearInterval(loop); loop = null;
    if (session && !keepSnap) clearSnap();
    source?.close(); source = null;
    session = null;
    wakeLock?.release?.(); wakeLock = null;
    window.Voice?.stop?.();
  }

  // ---------- Vorbereitung ----------
  function entriesFromCfg () {
    return MD.CONTROLLERS.map(c => ({ ctrl: c.n, ...(cfg.assign[c.n] || {}) })).filter(e => e.driverId && e.carId);
  }

  function renderSetup () {
    const dAll = drivers(Object.values(cfg.assign).map(a => a?.driverId)), cAll = cars(Object.values(cfg.assign).map(a => a?.carId));
    const t = track();
    const entries = entriesFromCfg();
    const usedD = Object.values(cfg.assign).map(a => a?.driverId).filter(Boolean);
    const usedC = Object.values(cfg.assign).map(a => a?.carId).filter(Boolean);
    const draft = readDraft();
    const rows = MD.CONTROLLERS.map(c => {
      const a = cfg.assign[c.n] || {};
      // Nur verfügbare: aktiv und noch nicht auf einem anderen Regler
      const dOpts = dAll.filter(d => d.id === a.driverId || !usedD.includes(d.id));
      const cOpts = cAll.filter(x => x.id === a.carId || !usedC.includes(x.id));
      return `<div class="lc-slot ${a.driverId ? 'used' : ''}" style="${ctrlStyle(c.n)}">
        <span class="lc-swatch" title="${c.name}"></span>
        <span class="lc-slot-name">${c.name}</span>
        <select data-ctrl="${c.n}" data-kind="driverId" aria-label="Fahrer ${c.name}">
          <option value="">– frei –</option>
          ${dOpts.map(d => `<option value="${d.id}" ${d.id === a.driverId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select>
        <select data-ctrl="${c.n}" data-kind="carId" aria-label="Fahrzeug ${c.name}">
          <option value="">– Fahrzeug –</option>
          ${cOpts.map(x => `<option value="${x.id}" ${x.id === a.carId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
        </select>
        <button class="lc-icon-btn" data-act="clear" data-ctrl="${c.n}" aria-label="${c.name} leeren" ${a.driverId || a.carId ? '' : 'disabled'}>×</button>
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
    const fuelNote = cfg.mode === 'race' ? (() => {
      const plan = MD.raceFuelPlan(cfg.raceLaps, MD.trackSetup(t).refLapMs, t, settings());
      const ref = MD.trackSetup(t).refLapMs;
      return `<p class="lc-note">Voller Tank reicht ca. ${Math.round(plan.lapsPerTank)} Runden bei ${ref} ms Rundenzeit${plan.stops ? ` · ${plan.stops} Boxenstopp${plan.stops > 1 ? 's' : ''} nötig` : ''}</p>`;
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
            ${fuelNote}
            <h3>Datenquelle</h3>
            <div class="lc-seg">
              <button data-act="src" data-src="cu" class="${cfg.source === 'cu' ? 'on' : ''}">Control Unit</button>
              <button data-act="src" data-src="sim" class="${cfg.source === 'sim' ? 'on' : ''}">Simulator</button>
            </div>
            ${cfg.source === 'cu' ? cuBox() : '<p class="lc-note">Der Simulator fährt mit den echten Fahrern, Fahrzeugen und Rekorden.</p>'}
          </section>
          <section class="lc-card">
            <div class="lc-card-head">
              <h3>Regler</h3>
              <button class="lc-btn" data-act="fromDraft" ${draft.length ? '' : 'disabled'} title="Paarungen aus „Neues Rennen“ / Auto-Setup, Regler nach Wunsch der Fahrer">Aus Auto-Setup${draft.length ? ` (${draft.length})` : ''}</button>
            </div>
            <div class="lc-slots">${rows}</div>
            <p class="lc-hint ${problems.length ? 'warn' : ''}" id="lcHint">${problems.length ? problems.map(esc).join(' · ') : cfg.hint ? esc(cfg.hint) : 'Leere Regler fahren nicht mit.'}</p>
          </section>
        </div>
        <footer class="lc-setup-foot">
          <div>${entries.length} ${entries.length === 1 ? 'Fahrer' : 'Fahrer'} · ${MODE_LABEL[cfg.mode]}${cfg.mode === 'race' ? ` über ${cfg.raceLaps} Runden` : cfg.mode === 'quali' ? ` · ${cfg.qualiLaps} Runden je Fahrer` : ''}</div>
          ${canEdit() ? '' : '<span class="lc-note">Starten nur mit Admin-Anmeldung</span>'}
          <button class="lc-btn lc-primary lc-big" data-act="start" ${entries.length && !problems.length && canEdit() && (cfg.source === 'sim' || cuHub()?.state === 'connected') ? '' : 'disabled'}>${cfg.mode === 'race' ? 'Zur Startaufstellung' : 'Strecke freigeben'}</button>
        </footer>
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
        <span class="lc-cu-state ${st}">${txt}</span>
        ${st === 'connected' ? '<button class="lc-btn" data-act="cuOff">Trennen</button>' : `<button class="lc-btn lc-primary" data-act="cuOn" ${st === 'connecting' ? 'disabled' : ''}>Mit CU verbinden</button>`}
      </div>
      ${h.error && st !== 'connected' ? `<p class="lc-note warn">${esc(h.error)}</p>` : ''}
      <p class="lc-note">SmartRace vorher schließen – die CU nimmt nur eine Verbindung an.</p>`;
  }
  let cuWatch = null;
  function watchCu () {
    if (cuWatch || !cuHub()) return;
    cuWatch = cuHub().onState(() => {
      if (root?.hidden) return;
      if (view === 'setup' && !session) renderSetup(); else { shellKey = ''; renderLive(); }
    });
  }

  function readDraft () {
    try { return JSON.parse(localStorage.getItem('raceDraft') || '{}').entries || []; } catch (e) { return []; }
  }

  function fromDraft () {
    const draft = readDraft();
    if (!draft.length) return;
    const { assignments, conflicts } = MD.suggestControllers(draft.slice(0, 6), appData().drivers || []);
    cfg.assign = {};
    assignments.forEach(a => { if (a.controller) cfg.assign[a.controller] = { driverId: a.driverId, carId: a.carId }; });
    try { const r = +JSON.parse(localStorage.getItem('raceDraft') || '{}').rounds; if (r > 0) cfg.raceLaps = r; } catch (e) {}
    cfg.hint = conflicts.length
      ? conflicts.map(c => `${MD.controller(c.controller).name} wollten ${c.driverIds.map(driverName).join(' und ')} – ${driverName(c.driverIds[0])} hat ihn`).join(' · ')
      : 'Regler nach Wunsch der Fahrer verteilt. Du kannst alles ändern.';
    saveCfg(); renderSetup();
  }

  // ---------- Start ----------
  function startSession ({ mode = cfg.mode, entries = entriesFromCfg(), fromQuali = false } = {}) {
    if (!entries.length) return;
    if (!fromQuali) qualiBests = {};
    stopSession();
    delete cfg.hint; saveCfg();
    const t = track();
    const records = trackRecords();
    session = new window.RaceEngine.Session({
      mode,
      laps: mode === 'race' ? cfg.raceLaps : mode === 'quali' ? cfg.qualiLaps : 0,
      entries, track: t, settings: settings(), records,
      finishCount: cfg.finishCount || 0, dqOpenPenalties: !!cfg.dqOpen, fullDistance: !!cfg.fullDistance,
      lapFalseStart: !(cfg.source === 'cu' && window.LiveCU)   // CU: Fehlstart kommt als Ampel 8/9, Durchfahrten vor dem Start sind Fehlmeldungen
    });
    resTab = 'result';
    redPen = {}; redReason = ''; endArmed = 0; resultOrder = null; recPick = new Set(); recState = ''; girpDone = false; baseRecords = records.slice();
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
    if (!session || !source || (!force && Date.now() - snapAt < 1000)) return;
    snapAt = Date.now();
    try {
      localStorage.setItem(SNAP, JSON.stringify({ at: snapAt, snap: session.snapshot(source.now()), qualiBests, baseRecords, redReason, lightsRunning: false }));
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
    resTab = 'result'; redPen = {}; endArmed = 0; resultOrder = null; recPick = new Set(); recState = ''; girpDone = false;
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
    if (session.phase !== 'green') source.stopCars?.();
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
    for (const c of session.cars.values()) {
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

  /**
   * G!RP auswerten: Ergebnis (Reihenfolge wie korrigiert) als Entwurf in „Neues Rennen“ eintragen.
   * Dort prüfst du es und speicherst wie gewohnt mit „Rennen auswerten“ – derselbe Weg wie bisher.
   */
  async function toGirp () {
    if (!session || !resultOrder) return;
    // Ausgewählte neue Rekorde vorher übernehmen – sonst gehen sie beim Wechsel zu „Neues Rennen“ verloren
    if (!recState && recPick.size && canEdit()) await saveRecords();
    const byCtrl = new Map([...session.cars.values()].map(c => [c.ctrl, c]));
    const d = new Date();
    const draft = {
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      time: d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
      rounds: String(session.laps),
      entries: resultOrder.map((c, i) => ({ driverId: byCtrl.get(c).driverId, carId: byCtrl.get(c).carId, place: i + 1 })),
      fromLivecenter: true
    };
    try { localStorage.setItem('raceDraft', JSON.stringify(draft)); } catch (e) {}
    girpDone = true;
    if (typeof window.showSection === 'function' && window.RaceUI) {
      close();
      window.showSection('race');
      window.RaceUI.updateForm?.();
      window.Helpers.showToast?.('Ergebnis eingetragen – prüfen und „Rennen auswerten“');
    } else {
      window.Helpers.showToast?.('In der Vorschau nicht verfügbar – in der App landet das Ergebnis in „Neues Rennen“');
      renderLive();
    }
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

  // ---------- Meldungen der Engine → Sprache + Laufschrift ----------
  const PRIO = { lights: 9, go: 9, redFlag: 10, resume: 9, win: 8, pole: 8, trackRecord: 7, falseStart: 7, lastLap: 6, personalRecord: 5, pitCall: 5, fastestLap: 4, penaltyServed: 4, refueled: 3, pitIn: 2 };
  function say (type, key, driverId) {
    if (!voiceOn || !window.Voice) return;
    const now = performance.now();
    const prio = PRIO[type] || 1;
    if (prio < lastSay.prio && now - lastSay.at < 2200) return;   // Wichtiges nicht abwürgen
    lastSay = { prio, at: now };
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
      case 'fuelEmpty': source?.limitSpeed?.(d.ctrl, d.level); note(d.ctrl, `${name}: Tank leer – gedrosselt`, 'warn'); break;
      case 'fuelRestored': source?.limitSpeed?.(d.ctrl, null); break;
      case 'status': if (d.status) note(d.ctrl, `${name}: ${d.status === 'dq' ? 'disqualifiziert' : 'ausgefallen'}`, 'warn'); break;
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
      case 'qualiDone': note(d.ctrl, `${name}: Quali beendet`); break;
      case 'pole': say(type, 'pole', d.driverId); break;
      case 'end': source?.stopCars(); try { countLaps(); } catch (e) { console.error(e); } recPick = new Set(recordCandidates().map(r => r.key)); break;
    }
    if (type !== 'lap' && type !== 'change') { renderLive(); saveSnap(true); }   // Wichtiges (Strafen, Rote Flagge …) sofort sichern
  }

  // ---------- Live-Ansicht ----------
  const sec1 = ms => (ms / 1000).toFixed(1).replace('.', ',');

  /** Fahrzeugbild (eigenes Bild aus dem Setup oder assets/cars/NN.png), einmal pro Fahrzeug geladen */
  const carImgs = {};
  function carImg (carId) {
    if (!(carId in carImgs)) {
      carImgs[carId] = null;
      const car = (appData().cars || []).find(c => c.id === carId);
      const hook = window.Livecenter?.carImage;
      const p = hook ? Promise.resolve(hook(car)) : window.SetupUI?.carImageSrc ? window.SetupUI.carImageSrc(car) : Promise.resolve(null);
      p.then(src => { carImgs[carId] = src || ''; if (src) { shellKey = ''; renderLive(); } }).catch(() => { carImgs[carId] = ''; });
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
      green: session.leaderFinished ? ['Zielflagge', 'chk'] : ['Strecke freigegeben', 'green'],
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
        <div class="lc-num lc-laps">${s.laps}</div>
        <div class="lc-num lc-last ${s.lastInterrupted ? 'int' : ''}">${fmt(s.last)}</div>
        <div class="lc-num lc-best ${bestCls}">${fmt(s.best)}</div>
        <div class="lc-num lc-gap">${out ? '' : fmtGap(s)}</div>`;
      if (!race) {
        const status = s.done ? '<span class="lc-badge chk">Fertig</span>' : s.inPit ? '<span class="lc-badge pit">Box</span>' : '';
        return `<div class="${cls}" style="${ctrlStyle(s.ctrl)}" data-ctrl="${s.ctrl}">${common}
          <div class="lc-num lc-rec">${fmt(s.personalRecord)}</div><div class="lc-status">${status}</div></div>`;
      }
      const fuel = `<div class="lc-fuel ${s.fuelEmpty ? 'empty' : s.fuel <= session.settings.pitCallFuelPct ? 'low' : ''} ${s.inPit && !s.servingPenalty ? 'filling' : ''}"><i style="width:${s.fuel.toFixed(1)}%"></i><span>${s.fuelEmpty ? 'leer' : Math.round(s.fuel) + ' %'}</span></div>`;
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
      if (overlay && now < overlay.until && overlay.kind === 'resume') return '<div class="lc-lights"><div class="lc-go">Weiter geht\'s!</div></div>';
      if (phase !== 'lights') return '';
      const lit = session.lights;
      const ready = !session.lightsRunning;
      return `<div class="lc-lights">
        <div class="lc-lamps">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= lit ? 'on' : ''}"></i>`).join('')}</div>
        ${ready && !canEdit() ? '<p class="lc-note">Start nur mit Admin-Anmeldung</p>' : ''}
        ${ready && canEdit() ? `<div class="lc-grid-list">${st.map(s => `<span style="${ctrlStyle(s.ctrl)}"><i></i>${who(s.driverId)}</span>`).join('')}</div>
          <button class="lc-btn lc-primary lc-big" data-act="lights">${session.restarts ? 'Weiter geht\'s' : 'Rennen starten'}</button>` : ''}
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
            <span class="lc-pen-gap">${gap}</span>
            ${session.fuelOn ? `<span class="lc-fuel lc-pen-fuel ${s.fuelEmpty ? 'empty' : s.fuel <= session.settings.pitCallFuelPct ? 'low' : ''}" title="Tank"><i style="width:${s.fuel.toFixed(1)}%"></i><span>${s.fuelEmpty ? 'leer' : Math.round(s.fuel) + ' %'}</span></span>` : ''}
            ${canEdit() ? `<span class="lc-pen-opts">${[0, ...session.settings.penaltyOptionsSec].map(sec => `<button class="lc-btn ${sel === sec ? 'on' : ''}" data-act="redPen" data-ctrl="${s.ctrl}" data-sec="${sec}" ${out ? 'disabled' : ''}>${sec ? `+${String(sec).replace('.', ',')}` : '0'}</button>`).join('')}<button class="lc-btn lc-credit" data-act="credit" data-ctrl="${s.ctrl}" title="Gutschrift: 5 s von der offenen Strafe abziehen" ${s.penaltySec && !out ? '' : 'style="visibility:hidden" disabled'}>−5</button></span>
            <span class="lc-pen-acts">
              <button class="lc-btn lc-pen-car" data-act="openMenu" data-ctrl="${s.ctrl}" ${out ? 'disabled' : ''}>Auto / Tuning</button>
              <button class="lc-btn lc-pen-st ${out === 'dnf' ? 'on' : ''}" data-act="redStatus" data-s="dnf" data-ctrl="${s.ctrl}">DNF</button>
              <button class="lc-btn lc-pen-st ${out === 'dq' ? 'on' : ''}" data-act="redStatus" data-s="dq" data-ctrl="${s.ctrl}">DQL</button>
            </span>` : `<span class="lc-pen-gap">${out === 'dq' ? 'DQL' : out === 'dnf' ? 'DNF' : ''}</span>`}
          </div>`;
        }).join('')}</div>
        ${canEdit() ? `<div class="lc-red-actions">
          <button class="lc-btn lc-big lc-white" data-act="resume">Weiter geht's</button>
          <button class="lc-btn lc-ghost" data-act="restart">${restartArmed ? 'Wirklich neu starten?' : restartLabel()}</button>
          <button class="lc-btn lc-ghost" data-act="finish">Rennen abbrechen und werten</button>
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

    // „Beenden“ während der Sitzung: werten, neu starten oder weiterfahren
    const endHtml = !endArmed || phase === 'finished' || phase === 'ready' ? '' : `<div class="lc-endask"><div class="lc-endask-box">
        <h3>${MODE_LABEL[session.mode]} beenden?</h3>
        <button class="lc-btn lc-primary lc-big" data-act="finishNow">Beenden und werten</button>
        ${session.mode !== 'practice' ? `<button class="lc-btn lc-big" data-act="restartNow">${restartLabel()}</button>` : ''}
        <button class="lc-btn lc-ghost" data-act="endCancel">Weiterfahren</button>
      </div></div>`;

    // ---------- Ergebnis: Reihenfolge korrigierbar, Rekorde übernehmen, G!RP auswerten ----------
    const resultHtml = phase !== 'finished' ? '' : (() => {
      if (!resultOrder) resultOrder = st.map(s => s.ctrl);
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
      const recHtml = !recs.length ? '' : `<section class="lc-res-box">
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
      const head = `<h2>${race ? 'Ergebnis' : session.mode === 'quali' ? 'Qualifying' : 'Training'}</h2>${tabHtml}`;
      const actions = `<div class="lc-red-actions">
          ${race && canEdit() ? `<button class="lc-btn lc-primary lc-big" data-act="girp" ${girpDone ? 'disabled' : ''}>G!RP auswerten</button>` : ''}
          ${session.mode === 'quali' && canEdit() ? `<button class="lc-btn lc-primary lc-big" data-act="raceFromQuali">Rennen mit ${cfg.raceLaps} Runden starten</button>
            <span class="lc-laps-adj"><button class="lc-btn" data-act="raceLaps" data-d="-1" aria-label="eine Runde weniger">−</button><button class="lc-btn" data-act="raceLaps" data-d="1" aria-label="eine Runde mehr">+</button></span>` : ''}
          ${session.mode !== 'practice' && canEdit() ? `<button class="lc-btn" data-act="restartNow">${restartLabel()}</button>` : ''}
          <button class="lc-btn" data-act="again">Zurück zur Vorbereitung</button>
          <button class="lc-btn lc-ghost" data-act="close">Schließen</button>
        </div>`;
      if (resTab !== 'result') {
        const stats = session.stats();
        const page = resTab === 'details' ? detailsHtml(ordered, stats, fastestMs, race) : resTab === 'laps' ? lapsHtml(ordered, stats, fastestMs) : statsHtml(ordered, stats);
        return `<div class="lc-result">${head}${page}${actions}</div>`;
      }
      return `<div class="lc-result">
        ${head}
        <div class="lc-res-grid ${race ? 'is-race' : ''} ${race && canEdit() ? 'can-move' : ''}">
          <div class="lc-res-head"><span>Pos</span><span>Auto</span><span>Fahrer</span><span>${race ? 'Runden' : ''}</span><span>${race ? 'Gesamtzeit' : 'Beste Runde'}</span><span>${race ? 'Schnellste Runde' : 'Abstand'}</span><span></span>${race && canEdit() ? '<span>Reihenfolge</span>' : ''}</div>
          ${ordered.map((s, i) => {
            const out = s.status === 'dq' ? `DQ${s.dqReason ? ` · ${s.dqReason}` : ''}` : s.status === 'dnf' ? 'DNF' : '';
            return `<div class="lc-res-row ${out ? 'out' : ''} ${i === 0 ? 'first' : ''}" style="${ctrlStyle(s.ctrl)}">
              <span class="lc-pos"><span>${i + 1}</span></span>
              ${carCell(s.carId, carImg(s.carId))}
              <span class="lc-res-who"><b>${who(s.driverId)}</b></span>
              <span class="lc-num">${race ? s.laps : ''}</span>
              ${race ? `<span class="lc-num">${timeCell(s)}</span>` : flCell(s)}
              ${race ? flCell(s) : `<span class="lc-num">${fmtGap(s)}</span>`}
              ${out ? `<span class="lc-badge out">${esc(out)}</span>` : s.penaltySec ? `<span class="lc-badge pen">+${sec1(s.penaltySec * 1000)} s</span>` : '<span></span>'}
              ${race && canEdit() ? `<span class="lc-move"><button class="lc-btn" data-act="move" data-ctrl="${s.ctrl}" data-d="-1" ${i === 0 || girpDone ? 'disabled' : ''} aria-label="nach oben">▲</button><button class="lc-btn" data-act="move" data-ctrl="${s.ctrl}" data-d="1" ${i === ordered.length - 1 || girpDone ? 'disabled' : ''} aria-label="nach unten">▼</button></span>` : ''}
            </div>`;
          }).join('')}
        </div>
        ${race && canEdit() ? `<p class="lc-note">${edited ? 'Reihenfolge von Hand geändert. ' : ''}Mit ▲ ▼ korrigierst du die Zielreihenfolge, bevor sie in die G!RP-Wertung geht.</p>` : ''}
        ${recHtml}
        ${actions}
      </div>`;
    })();

    // Fahrzeug wechseln und Tuning: Training/Quali jederzeit, im Rennen nur bei Roter Flagge
    function carTuneHtml (c, locked) {
      if (locked) return '<div class="lc-menu-label">Fahrzeug und Tuning ändern: bei Roter Flagge.</div>';
      const used = [...session.cars.values()].filter(x => x.ctrl !== c.ctrl).map(x => x.carId);
      const opts = cars([c.carId]).filter(x => !used.includes(x.id));
      const tu = tuningOf(c.carId);
      const slider = (k, label) => `<label class="lc-tune"><span>${label}</span><input type="range" min="0" max="15" step="1" value="${tu[k]}" data-tune="${k}" data-ctrl="${c.ctrl}"><b>${MD.levelToPct(tu[k])} %</b></label>`;
      return `<div class="lc-menu-label">Fahrzeug${race ? ' (gilt ab dem Neustart)' : ' – die laufende Runde zählt nicht'}</div>
        <select class="lc-menu-sel" data-carswap="${c.ctrl}">${opts.map(x => `<option value="${x.id}" ${x.id === c.carId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <div class="lc-menu-label">Tuning · wird ans Fahrzeug gespeichert</div>
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
      </div>`;
    })() : '';

    const simHtml = source.kind !== 'sim' ? '' : `<div class="lc-sim ${simOpen ? 'open' : ''}">
        <div class="lc-sim-row"><b>Simulator</b>
          ${[1, 2, 5, 10].map(x => `<button class="lc-btn ${source.speed === x ? 'on' : ''}" data-act="speed" data-x="${x}">×${x}</button>`).join('')}
          <button class="lc-btn lc-danger" data-act="short" ${['green', 'lights'].includes(phase) ? '' : 'disabled'}>Kurzschluss</button>
        </div>
        <div class="lc-sim-row">${st.map(s => `<span class="lc-sim-car" style="${ctrlStyle(s.ctrl)}"><span class="lc-swatch"></span>
          <button class="lc-btn" data-act="simPit" data-ctrl="${s.ctrl}" ${phase === 'green' ? '' : 'disabled'}>Box</button>
          <button class="lc-btn" data-act="simFalse" data-ctrl="${s.ctrl}" ${phase === 'lights' && session.lightsRunning && race ? '' : 'disabled'}>Fehlstart</button></span>`).join('')}</div>
      </div>`;

    const tick = ticker.map(n => `<span class="lc-tick ${n.kind}" ${n.ctrl ? `style="${ctrlStyle(n.ctrl)}"` : ''}>${n.ctrl ? '<i></i>' : ''}${esc(n.text)}</span>`).join('');
    const cuWarn = source.kind === 'cu' && cuHub()?.state !== 'connected' ? '<span class="lc-tick red">CU nicht verbunden – Bluetooth prüfen</span>' : '';
    const dg = source.diag;
    const cuDiag = dg ? `<span class="lc-tick muted">CU: ${dg.msgs} Meldungen · ${dg.timers} Durchfahrten (${dg.used} gewertet)${dg.last ? ` · zuletzt ${esc(MD.controller(dg.last.addr)?.name || 'Regler ' + dg.last.addr)} Sensor ${dg.last.sector}` : ''} · Ampel ${cuHub()?.lastStatus?.start ?? '–'} · Phase ${phase}${(() => { const c = dg.last && session.cars.get(dg.last.addr); return c ? ` · Wertung: ${c.laps} Rd., Start ${c.lastCross != null ? 'ja' : 'nein'}${c.rejectedMs != null ? `, verworfen ${Math.round(c.rejectedMs)} ms` : ''}, Mindestzeit ${MD.trackSetup(session.track).minLapMs ?? '–'}` : (dg.last ? ' · Regler nicht im Livecenter' : ''); })()}</span>` : '';
    const tickHtml = cuWarn + cuDiag + tick || `<span class="lc-tick muted">${!canEdit() ? 'Eingaben nur mit Admin-Anmeldung.' : race ? 'Fahrer antippen für Strafe, Ausfall oder Disqualifikation.' : 'Fahrer antippen für Fahrzeug und Tuning.'}</span>`;

    // Nur neu aufbauen, wenn sich Knöpfe/Overlays ändern – sonst gehen Fingertipps während des Neuzeichnens verloren
    const overlayOn = overlay && now < overlay.until ? overlay.kind : '';
    const menuCar = menuCtrl != null ? session.cars.get(menuCtrl) : null;
    const key = [canEdit(), phase, session.leaderFinished, simOpen, menuCtrl, menuCar ? `${menuCar.penaltyMs}${menuCar.status}` : '', voiceOn, overlayOn,
      session.lights, session.lightsRunning, endArmed, restartArmed, source.speed, st.length, session.restarts, redReason, JSON.stringify(redPen), cfg.raceLaps, (resultOrder || []).join(), [...recPick].join(), recState, girpDone, resTab,
      phase === 'red' ? st.map(s => s.ctrl + s.status + s.penaltySec + s.inPit + Math.round(s.pitStandMs / 100)).join() : ''].join('|');
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
      : '<span>Pos</span><span>Auto</span><span>Fahrer</span><span>Rd.</span><span>Letzte</span><span>Beste</span><span>Abstand</span><span>Rekord</span><span></span>';
    root.innerHTML = `
      <div class="lc-live ${race ? 'is-race' : 'is-free'} phase-${phase} rows-${st.length}">
        <header class="lc-top">
          <div class="lc-brand">${MODE_LABEL[session.mode]}</div>
          <div class="lc-progress">${progress}</div>
          <div class="lc-flag ${flag[1]}">${flag[0]}</div>
          <div class="lc-clocks">${clockHtml}</div>
          <div class="lc-trackrec">${trHtml}</div>
          <div class="lc-actions">
            <button class="lc-btn ${voiceOn ? 'on' : ''}" data-act="voice" aria-pressed="${voiceOn}">Ton ${voiceOn ? 'an' : 'aus'}</button>
            ${canEdit() && source.kind === 'sim' ? `<button class="lc-btn ${simOpen ? 'on' : ''}" data-act="sim">Sim</button>` : ''}
            ${canEdit() && session.mode === 'practice' && ['green', 'red'].includes(phase) ? '<button class="lc-btn lc-yellow" data-act="reset">Zurücksetzen</button>' : ''}
            ${canEdit() && (phase === 'green' || (phase === 'lights' && session.lightsRunning)) ? '<button class="lc-btn lc-danger" data-act="red">Rote Flagge</button>' : ''}
            ${phase === 'finished' ? '' : '<button class="lc-btn lc-ghost" data-act="end">Beenden</button>'}
          </div>
        </header>
        <div class="lc-head-row">${head}</div>
        <div class="lc-board">${rows}</div>
        <footer class="lc-ticker">${tickHtml}</footer>
        ${simHtml}${menuHtml}${lightsHtml}${redHtml}${resultHtml}${endHtml}
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
      case 'fromDraft': fromDraft(); break;
      case 'src': cfg.source = b.dataset.src; saveCfg(); renderSetup(); break;
      case 'cuOn': cuHub()?.connect(); renderSetup(); break;
      case 'cuOff': cuHub()?.disconnect(); break;
      case 'start': startSession(); break;
      case 'resumeSaved': discardArmed = false; restoreSession(); break;
      case 'discardSaved': if (discardArmed) { clearSnap(); discardArmed = false; } else discardArmed = true; renderSetup(); break;
      case 'lights': lightsGo(); break;
      case 'red': session.redFlag(source.now(), 'manual'); break;
      case 'reset': session.reset(source.now()); ticker = []; lapFlash = {}; note(null, 'Zeiten und Runden zurückgesetzt'); renderLive(); break;
      case 'redStatus': session.setStatus(ctrl, session.cars.get(ctrl)?.status === b.dataset.s ? null : b.dataset.s); renderLive(); break;
      case 'resume':
        // Strafen aus dem Dialog vergeben, dann „Weiter geht's!“ + Startampel
        for (const [c, sec] of Object.entries(redPen)) if (sec > 0) session.addPenalty(+c, sec, 'Strafe (Rote Flagge)');
        redPen = {};
        session.resume(source.now()); renderLive();
        break;
      case 'redPen': redPen[ctrl] = +b.dataset.sec; if (!redPen[ctrl]) delete redPen[ctrl]; renderLive(); break;
      case 'raceFromQuali': raceFromQuali(); break;
      case 'resTab': resTab = b.dataset.t; renderLive(); break;
      case 'move': {
        const i = resultOrder.indexOf(ctrl), j = i + +b.dataset.d;
        if (i >= 0 && j >= 0 && j < resultOrder.length) [resultOrder[i], resultOrder[j]] = [resultOrder[j], resultOrder[i]];
        renderLive(); break;
      }
      case 'saveRecords': saveRecords(); break;
      case 'girp': toGirp(); break;
      case 'raceLaps': cfg.raceLaps = Math.max(1, cfg.raceLaps + +b.dataset.d); saveCfg(); renderLive(); break;
      case 'openMenu': menuCtrl = ctrl; renderLive(); break;
      case 'status': session.setStatus(menuCtrl, b.dataset.s || null); menuCtrl = null; renderLive(); break;
      case 'finish': session.finish(source.now()); break;
      case 'again': stopSession(); view = 'setup'; renderSetup(); break;
      case 'end':
        if (session.phase === 'finished' || session.phase === 'ready') { close(); break; }
        if (!canEdit()) break;
        // Laufende Sitzung: eigene Auswahl (kein Browser-Dialog, der das Livecenter blockiert)
        endArmed = 1; renderLive();
        break;
      case 'finishNow': endArmed = 0; session.finish(source.now()); renderLive(); break;
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
      case 'simFalse': source.falseStart(ctrl); break;
      case 'menuClose': menuCtrl = null; renderLive(); break;
      case 'penalty': session.addPenalty(menuCtrl, +b.dataset.sec, 'Zeitstrafe'); menuCtrl = null; renderLive(); break;
      case 'credit': {
        const c = session.cars.get(ctrl);
        const got = session.creditPenalty(ctrl, 5);
        if (got) note(ctrl, `${driverName(c.driverId)}: Gutschrift ${sec1(got * 1000)} s`);
        renderLive(); break;
      }
      case 'penaltyClear': session.clearPenalty(menuCtrl); note(menuCtrl, `${driverName(session.cars.get(menuCtrl).driverId)}: Strafe zurückgenommen`); menuCtrl = null; renderLive(); break;
    }
  }

  function onChange (e) {
    if (session && !canEdit()) return;
    const swap = e.target.closest('select[data-carswap]');
    if (swap && session) {
      const ctrl = +swap.dataset.carswap, carId = isNaN(+swap.value) ? swap.value : +swap.value;
      if (session.changeCar(ctrl, carId)) {
        const c = session.cars.get(ctrl);
        source?.setPace?.(ctrl, simPace(c.driverId, carId));
        source?.setTuning?.(ctrl, tuningOf(carId), { send: true });
        note(ctrl, `${driverName(c.driverId)} fährt jetzt ${carName(carId)}`);
      }
      shellKey = ''; renderLive(); return;
    }
    const tune = e.target.closest('input[data-tune]');
    if (tune && session) {
      const c = session.cars.get(+tune.dataset.ctrl);
      const t = { ...tuningOf(c.carId), [tune.dataset.tune]: MD.clampLevel(tune.value) };
      saveTuning(c.carId, t);
      source?.setTuning?.(c.ctrl, t, { send: true });
      shellKey = ''; renderLive(); return;
    }
    const rec = e.target.closest('input[data-rec]');
    if (rec) { rec.checked ? recPick.add(rec.dataset.rec) : recPick.delete(rec.dataset.rec); renderLive(); return; }
    const sel = e.target.closest('select[data-ctrl]');
    if (sel) {
      const n = +sel.dataset.ctrl;
      const val = sel.value ? (isNaN(+sel.value) ? sel.value : +sel.value) : null;
      cfg.assign[n] = { ...(cfg.assign[n] || {}), [sel.dataset.kind]: val };
      // Derselbe Fahrer / dasselbe Fahrzeug auf einem anderen Regler → dort herausnehmen (Regler tauschen)
      if (val != null) {
        for (const [k, a] of Object.entries(cfg.assign)) {
          if (+k === n || a?.[sel.dataset.kind] !== val) continue;
          a[sel.dataset.kind] = null;
          if (!a.driverId && !a.carId) delete cfg.assign[k];
        }
      }
      if (sel.dataset.kind === 'driverId' && val != null && !cfg.assign[n].carId) {
        // Fahrzeug vorschlagen: das, mit dem der Fahrer zuletzt auf diesem Regler oder überhaupt gefahren ist
        const last = cfg.lastCar?.[val];
        if (last && !Object.values(cfg.assign).some(a => a?.carId === last)) cfg.assign[n].carId = last;
      }
      if (cfg.assign[n].driverId && cfg.assign[n].carId) { cfg.lastCar = { ...(cfg.lastCar || {}), [cfg.assign[n].driverId]: cfg.assign[n].carId }; }
      if (!cfg.assign[n].driverId && !cfg.assign[n].carId) delete cfg.assign[n];
      delete cfg.hint;
      saveCfg(); renderSetup();
      return;
    }
    const inp = e.target.closest('[data-cfg]');
    if (inp) {
      const k = inp.dataset.cfg;
      if (k === 'dqOpen') cfg.dqOpen = inp.checked;
      else if (k === 'fullDistance') cfg.fullDistance = inp.checked;
      else if (k === 'finishCount') cfg.finishCount = +inp.value || 0;
      else cfg[k] = Math.max(1, Math.min(999, Math.round(+inp.value || 0)));
      saveCfg(); renderSetup();
    }
  }

  window.Livecenter = { open, close, onClose: null, get session () { return session; } };
})();
