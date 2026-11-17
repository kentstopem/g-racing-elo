// livecenter.js – Livecenter: Training, Qualifying und Rennen live (Feature Flag "live", window.Livecenter)
//
// Vollbild über der App, für iPad quer und per AirPlay auf dem Fernseher (große Schrift, dunkel).
// Rennlogik: race-engine.js. Datenquelle: live-sim.js (Simulator) – die CU-Quelle kommt mit dem Live-Kern
// und liefert dieselben Ereignisse.
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
  let endArmed = 0;            // „Beenden“ zweimal tippen
  let redPen = {};             // Strafendialog bei Roter Flagge: { ctrl: Sekunden }
  let redReason = '';
  let resultOrder = null;      // Ergebnis-Reihenfolge (Regler), von Hand korrigierbar
  let recPick = new Set();     // ausgewählte neue Rekorde
  let recState = '';           // '' | 'saving' | 'done'
  let girpDone = false;
  let baseRecords = [];        // Rekorde dieser Strecke beim Start der Sitzung

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
    return { mode: c.mode || 'practice', raceLaps: c.raceLaps || 60, qualiLaps: c.qualiLaps || 3, assign: c.assign || {}, lastCar: c.lastCar || {}, finishCount: c.finishCount || 0, dqOpen: !!c.dqOpen };
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
    if (!session) { view = 'setup'; renderSetup(); } else renderLive();
  }

  function close () {
    stopSession();
    root.hidden = true;
    document.documentElement.classList.remove('lc-open');
    window.Livecenter.onClose?.();
  }

  function stopSession () {
    clearInterval(loop); loop = null;
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
      <label class="lc-check"><input type="checkbox" data-cfg="dqOpen" ${cfg.dqOpen ? 'checked' : ''}> Offene Strafen bei Rennende: disqualifizieren<small>Sonst wird die offene Zeit auf die Gesamtzeit addiert.</small></label>` : '';
    const fuelNote = cfg.mode === 'race' ? (() => {
      const plan = MD.raceFuelPlan(cfg.raceLaps, MD.trackSetup(t).refLapMs, t, settings());
      const ref = MD.trackSetup(t).refLapMs;
      return `<p class="lc-note">Voller Tank reicht ca. ${Math.round(plan.lapsPerTank)} Runden bei ${ref} ms Rundenzeit${plan.stops ? ` · ${plan.stops} Boxenstopp${plan.stops > 1 ? 's' : ''} nötig` : ''}</p>`;
    })() : '';

    root.innerHTML = `
      <div class="lc-setup">
        <header class="lc-top">
          <div class="lc-brand">Livecenter</div>
          <div class="lc-track">${esc(t.name || 'Keine Strecke')}</div>
          <button class="lc-btn lc-ghost" data-act="close">Schließen</button>
        </header>
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
              <button class="on">Simulator</button>
              <button disabled title="kommt mit dem Live-Kern">Control Unit</button>
            </div>
            <p class="lc-note">Der Simulator fährt mit den echten Fahrern, Fahrzeugen und Rekorden. Die Anbindung an die CU folgt nach dem Test an der Bahn.</p>
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
          <button class="lc-btn lc-primary lc-big" data-act="start" ${entries.length && !problems.length && canEdit() ? '' : 'disabled'}>${cfg.mode === 'race' ? 'Zur Startaufstellung' : 'Strecke freigeben'}</button>
        </footer>
      </div>`;
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
  function startSession ({ mode = cfg.mode, entries = entriesFromCfg() } = {}) {
    if (!entries.length) return;
    stopSession();
    delete cfg.hint; saveCfg();
    const t = track();
    const records = trackRecords();
    session = new window.RaceEngine.Session({
      mode,
      laps: mode === 'race' ? cfg.raceLaps : mode === 'quali' ? cfg.qualiLaps : 0,
      entries, track: t, settings: settings(), records,
      finishCount: cfg.finishCount || 0, dqOpenPenalties: !!cfg.dqOpen
    });
    redPen = {}; redReason = ''; endArmed = 0; resultOrder = null; recPick = new Set(); recState = ''; girpDone = false; baseRecords = records.slice();
    session.on(onEngine);
    source = new window.LiveSim.SimSource();
    const ref = MD.trackSetup(t).refLapMs || 7000;
    const rnd = (a, b) => a + Math.random() * (b - a);
    source.prepare(entries.map(e => {
      const own = records.filter(r => r.driverId === e.driverId && r.carId === e.carId).map(r => r.ms);
      return { ctrl: e.ctrl, paceMs: own.length ? Math.min(...own) * rnd(1.01, 1.05) : ref * rnd(0.84, 0.95) };
    }), { refLapMs: ref });
    entries.forEach(e => source.setTuning?.(e.ctrl, tuningOf(e.carId)));   // Tuning der Fahrzeuge an die Bahn
    source.setPitInfo(ctrl => {
      const c = session?.cars.get(ctrl);
      return c ? { fuel: session.fuelOn ? c.fuel : null, penaltyLeftMs: c.inPit ? c.penaltyMs : 0, penaltyOpen: c.penaltyMs > 0 } : {};
    });
    source.on(ev => { session?.handle(ev); });
    ticker = []; lapFlash = {}; overlay = null; menuCtrl = null; shellKey = '';
    view = 'live';
    session.start(source.now());
    if (session.phase === 'green') source.release();
    loop = setInterval(() => { if (!session) return; session.tick(source.now()); renderLive(); }, 200);
    try { navigator.wakeLock?.request('screen').then(l => { wakeLock = l; }).catch(() => {}); } catch (e) {}
    renderLive();
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
  function toGirp () {
    if (!session || !resultOrder) return;
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

  /** Nach dem Qualifying: Rennen mit der Quali-Reihenfolge als Startaufstellung */
  function raceFromQuali () {
    const grid = session.standings().map(s => ({ ctrl: s.ctrl, driverId: s.driverId, carId: s.carId }));
    cfg.mode = 'race'; saveCfg();
    startSession({ mode: 'race', entries: grid });
  }

  function lightsGo () {
    if (!session || session.phase !== 'lights') return;
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
      case 'redFlag': say(type, 'red_flag'); source?.stopCars(); session.lightsRunning = false; redReason = d.reason; redPen = {}; menuCtrl = null; note(null, d.reason === 'short' ? 'Rote Flagge – Kurzschluss' : 'Rote Flagge', 'red'); break;
      case 'resume':
        say(type, 'race_resume');
        overlay = { kind: 'resume', until: performance.now() + 1800 };
        if (d.lights) setTimeout(() => lightsGo(), 1800); else source?.release();
        break;
      case 'lastLap': say(type, 'last_lap'); note(null, 'Letzte Runde!'); break;
      case 'win': say(type, 'race_win', d.driverId); note(d.ctrl, `${name} gewinnt!`, 'win'); break;
      case 'qualiDone': note(d.ctrl, `${name}: Quali beendet`); break;
      case 'pole': say(type, 'pole', d.driverId); break;
      case 'end': source?.stopCars(); recPick = new Set(recordCandidates().map(r => r.key)); break;
    }
    if (type !== 'lap' && type !== 'change') renderLive();
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
        <div class="lc-red-head"><div class="lc-red-title">ROTE FLAGGE</div><p>${redReason === 'short' ? 'Kurzschluss – Strom ist aus.' : 'Rennen unterbrochen.'} ${canEdit() ? 'Strafen in Sekunden vergeben, Fahrzeuge einsetzen, dann „Weiter geht\'s“.' : 'Weiter geht es, sobald der Admin freigibt.'}</p></div>
        <div class="lc-pen-list">${st.map(s => {
          const sel = redPen[s.ctrl] || 0;
          const out = s.status;
          const state = s.inPit ? `<em class="lc-pen-pit">Box ${sec1(s.pitStandMs)} s</em>` : '';
          const gap = out ? '' : s.pos === 1 ? `Rd. ${s.laps}` : fmtGap(s);
          return `<div class="lc-pen-row ${sel ? 'on' : ''} ${out ? 'out' : ''}" style="${ctrlStyle(s.ctrl)}">
            <span class="lc-pen-pos">${out ? '–' : s.pos}</span>
            <span class="lc-pen-name">${who(s.driverId)}${state}${s.penaltySec ? `<em class="lc-pen-open">offen ${sec1(s.penaltySec * 1000)} s</em>` : ''}</span>
            <span class="lc-pen-gap">${gap}</span>
            ${canEdit() ? `<span class="lc-pen-opts">${[0, ...session.settings.penaltyOptionsSec].map(sec => `<button class="lc-btn ${sel === sec ? 'on' : ''}" data-act="redPen" data-ctrl="${s.ctrl}" data-sec="${sec}" ${out ? 'disabled' : ''}>${sec ? `+${String(sec).replace('.', ',')}` : '0'}</button>`).join('')}</span>
            <span class="lc-pen-acts">
              <button class="lc-btn lc-pen-car" data-act="openMenu" data-ctrl="${s.ctrl}" ${out ? 'disabled' : ''}>Auto / Tuning</button>
              <button class="lc-btn lc-pen-st ${out === 'dnf' ? 'on' : ''}" data-act="redStatus" data-s="dnf" data-ctrl="${s.ctrl}">DNF</button>
              <button class="lc-btn lc-pen-st ${out === 'dq' ? 'on' : ''}" data-act="redStatus" data-s="dq" data-ctrl="${s.ctrl}">DQL</button>
            </span>` : `<span class="lc-pen-gap">${out === 'dq' ? 'DQL' : out === 'dnf' ? 'DNF' : ''}</span>`}
          </div>`;
        }).join('')}</div>
        ${canEdit() ? `<div class="lc-red-actions">
          <button class="lc-btn lc-big lc-white" data-act="resume">Weiter geht's</button>
          <button class="lc-btn lc-ghost" data-act="finish">Rennen abbrechen und werten</button>
        </div>` : ''}
      </div>` : `<div class="lc-red">
        <div class="lc-red-title">ROTE FLAGGE</div>
        <p>${redReason === 'short' ? 'Kurzschluss – Strom ist aus.' : 'Unterbrochen.'} Fahrzeuge wieder einsetzen.</p>
        ${canEdit() ? `<div class="lc-red-actions">
          <button class="lc-btn lc-big lc-white" data-act="resume">Weiter</button>
          <button class="lc-btn lc-ghost" data-act="finish">Beenden</button>
        </div>` : ''}
      </div>`;

    // ---------- Ergebnis: Reihenfolge korrigierbar, Rekorde übernehmen, G!RP auswerten ----------
    const resultHtml = phase !== 'finished' ? '' : (() => {
      if (!resultOrder) resultOrder = st.map(s => s.ctrl);
      const byCtrl = new Map(st.map(s => [s.ctrl, s]));
      const ordered = resultOrder.map(c => byCtrl.get(c)).filter(Boolean);
      const edited = resultOrder.join() !== st.map(s => s.ctrl).join();
      const lead = st[0];
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
      return `<div class="lc-result">
        <h2>${race ? 'Ergebnis' : session.mode === 'quali' ? 'Qualifying – Startaufstellung' : 'Training – Bestzeiten'}</h2>
        <div class="lc-res-grid ${race ? 'is-race' : ''} ${race && canEdit() ? 'can-move' : ''}">
          <div class="lc-res-head"><span>Pos</span><span>Auto</span><span>Fahrer</span><span>${race ? 'Runden' : ''}</span><span>${race ? 'Gesamtzeit' : 'Beste Runde'}</span><span>${race ? 'Schnellste Runde' : 'Abstand'}</span><span></span>${race && canEdit() ? '<span>Reihenfolge</span>' : ''}</div>
          ${ordered.map((s, i) => {
            const out = s.status === 'dq' ? `DQ${s.dqReason ? ` · ${s.dqReason}` : ''}` : s.status === 'dnf' ? 'DNF' : '';
            return `<div class="lc-res-row ${out ? 'out' : ''} ${i === 0 ? 'first' : ''}" style="${ctrlStyle(s.ctrl)}">
              <span class="lc-pos"><span>${i + 1}</span></span>
              ${carCell(s.carId, carImg(s.carId))}
              <span class="lc-res-who"><b>${who(s.driverId)}</b></span>
              <span class="lc-num">${race ? s.laps : ''}</span>
              <span class="lc-num">${timeCell(s)}</span>
              <span class="lc-num">${race ? fmt(s.best) : fmtGap(s)}</span>
              ${out ? `<span class="lc-badge out">${esc(out)}</span>` : s.penaltySec ? `<span class="lc-badge pen">+${sec1(s.penaltySec * 1000)} s</span>` : '<span></span>'}
              ${race && canEdit() ? `<span class="lc-move"><button class="lc-btn" data-act="move" data-ctrl="${s.ctrl}" data-d="-1" ${i === 0 || girpDone ? 'disabled' : ''} aria-label="nach oben">▲</button><button class="lc-btn" data-act="move" data-ctrl="${s.ctrl}" data-d="1" ${i === ordered.length - 1 || girpDone ? 'disabled' : ''} aria-label="nach unten">▼</button></span>` : ''}
            </div>`;
          }).join('')}
        </div>
        ${race && canEdit() ? `<p class="lc-note">${edited ? 'Reihenfolge von Hand geändert. ' : ''}Mit ▲ ▼ korrigierst du die Zielreihenfolge, bevor sie in die G!RP-Wertung geht.</p>` : ''}
        ${recHtml}
        <div class="lc-red-actions">
          ${race && canEdit() ? `<button class="lc-btn lc-primary lc-big" data-act="girp" ${girpDone ? 'disabled' : ''}>G!RP auswerten</button>` : ''}
          ${session.mode === 'quali' && canEdit() ? `<button class="lc-btn lc-primary lc-big" data-act="raceFromQuali">Rennen mit ${cfg.raceLaps} Runden starten</button>
            <span class="lc-laps-adj"><button class="lc-btn" data-act="raceLaps" data-d="-1" aria-label="eine Runde weniger">−</button><button class="lc-btn" data-act="raceLaps" data-d="1" aria-label="eine Runde mehr">+</button></span>` : ''}
          <button class="lc-btn" data-act="again">Zurück zur Vorbereitung</button>
          <button class="lc-btn lc-ghost" data-act="close">Schließen</button>
        </div>
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
          ${c.penaltyMs ? '<button class="lc-btn lc-ghost" data-act="penaltyClear">Strafe zurücknehmen</button>' : ''}
          ${c.status ? `<button class="lc-btn" data-act="status" data-s="">${c.status === 'dq' ? 'DQ' : 'DNF'} aufheben</button>`
            : '<button class="lc-btn" data-act="status" data-s="dnf">Ausgefallen (DNF)</button><button class="lc-btn lc-danger" data-act="status" data-s="dq">Disqualifizieren</button>'}
        </div>` : ''}
        ${carTuneHtml(c, race && phase !== 'red')}
      </div>`;
    })() : '';

    const simHtml = `<div class="lc-sim ${simOpen ? 'open' : ''}">
        <div class="lc-sim-row"><b>Simulator</b>
          ${[1, 2, 5, 10].map(x => `<button class="lc-btn ${source.speed === x ? 'on' : ''}" data-act="speed" data-x="${x}">×${x}</button>`).join('')}
          <button class="lc-btn lc-danger" data-act="short" ${['green', 'lights'].includes(phase) ? '' : 'disabled'}>Kurzschluss</button>
        </div>
        <div class="lc-sim-row">${st.map(s => `<span class="lc-sim-car" style="${ctrlStyle(s.ctrl)}"><span class="lc-swatch"></span>
          <button class="lc-btn" data-act="simPit" data-ctrl="${s.ctrl}" ${phase === 'green' ? '' : 'disabled'}>Box</button>
          <button class="lc-btn" data-act="simFalse" data-ctrl="${s.ctrl}" ${phase === 'lights' && session.lightsRunning && race ? '' : 'disabled'}>Fehlstart</button></span>`).join('')}</div>
      </div>`;

    const tick = ticker.map(n => `<span class="lc-tick ${n.kind}" ${n.ctrl ? `style="${ctrlStyle(n.ctrl)}"` : ''}>${n.ctrl ? '<i></i>' : ''}${esc(n.text)}</span>`).join('');
    const tickHtml = tick || `<span class="lc-tick muted">${!canEdit() ? 'Eingaben nur mit Admin-Anmeldung.' : race ? 'Fahrer antippen für Strafe, Ausfall oder Disqualifikation.' : 'Fahrer antippen für Fahrzeug und Tuning.'}</span>`;

    // Nur neu aufbauen, wenn sich Knöpfe/Overlays ändern – sonst gehen Fingertipps während des Neuzeichnens verloren
    const overlayOn = overlay && now < overlay.until ? overlay.kind : '';
    const menuCar = menuCtrl != null ? session.cars.get(menuCtrl) : null;
    const key = [canEdit(), phase, session.leaderFinished, simOpen, menuCtrl, menuCar ? `${!!menuCar.penaltyMs}${menuCar.status}` : '', voiceOn, overlayOn,
      session.lights, session.lightsRunning, endArmed, source.speed, st.length, session.restarts, redReason, JSON.stringify(redPen), cfg.raceLaps, (resultOrder || []).join(), [...recPick].join(), recState, girpDone,
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
            ${canEdit() ? `<button class="lc-btn ${simOpen ? 'on' : ''}" data-act="sim">Sim</button>` : ''}
            ${canEdit() && session.mode === 'practice' && ['green', 'red'].includes(phase) ? '<button class="lc-btn lc-yellow" data-act="reset">Zurücksetzen</button>' : ''}
            ${canEdit() && (phase === 'green' || (phase === 'lights' && session.lightsRunning)) ? '<button class="lc-btn lc-danger" data-act="red">Rote Flagge</button>' : ''}
            <button class="lc-btn lc-ghost" data-act="end">${phase === 'finished' ? 'Schließen' : endArmed ? 'Nochmal tippen' : 'Beenden'}</button>
          </div>
        </header>
        <div class="lc-head-row">${head}</div>
        <div class="lc-board">${rows}</div>
        <footer class="lc-ticker">${tickHtml}</footer>
        ${simHtml}${menuHtml}${lightsHtml}${redHtml}${resultHtml}
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
      case 'start': startSession(); break;
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
        // Laufende Sitzung: zweimal tippen (kein Browser-Dialog, der das Livecenter blockiert)
        if (endArmed) { endArmed = 0; session.finish(source.now()); }
        else { endArmed = 1; renderLive(); setTimeout(() => { endArmed = 0; renderLive(); }, 2500); }
        break;
      case 'voice': voiceOn = !voiceOn; try { localStorage.setItem(VOICE_KEY, voiceOn ? 'on' : 'off'); } catch (err) {} if (!voiceOn) window.Voice?.stop?.(); renderLive(); break;
      case 'sim': simOpen = !simOpen; renderLive(); break;
      case 'speed': source.setSpeed(+b.dataset.x); renderLive(); break;
      case 'short': source.short(); break;
      case 'simPit': source.pit(ctrl); break;
      case 'simFalse': source.falseStart(ctrl); break;
      case 'menuClose': menuCtrl = null; renderLive(); break;
      case 'penalty': session.addPenalty(menuCtrl, +b.dataset.sec, 'Zeitstrafe'); menuCtrl = null; renderLive(); break;
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
        source?.setTuning?.(ctrl, tuningOf(carId));
        note(ctrl, `${driverName(c.driverId)} fährt jetzt ${carName(carId)}`);
      }
      shellKey = ''; renderLive(); return;
    }
    const tune = e.target.closest('input[data-tune]');
    if (tune && session) {
      const c = session.cars.get(+tune.dataset.ctrl);
      const t = { ...tuningOf(c.carId), [tune.dataset.tune]: MD.clampLevel(tune.value) };
      saveTuning(c.carId, t);
      source?.setTuning?.(c.ctrl, t);
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
      else if (k === 'finishCount') cfg.finishCount = +inp.value || 0;
      else cfg[k] = Math.max(1, Math.min(999, Math.round(+inp.value || 0)));
      saveCfg(); renderSetup();
    }
  }

  window.Livecenter = { open, close, onClose: null, get session () { return session; } };
})();
