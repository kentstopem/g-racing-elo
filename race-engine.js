// race-engine.js – Rennlogik des Livecenters (window.RaceEngine), ohne Oberfläche und ohne Hardware
//
// Die Engine bekommt Ereignisse von einer Datenquelle (Simulator jetzt, Control Unit später) und
// rechnet daraus Runden, Positionen, Abstände, Tank, Box, Strafen und Rekorde.
//
// Ereignisse der Datenquelle (alle Zeiten t in ms, eine gemeinsame Uhr der Quelle):
//   { type: 'lights', step: 1..5, t }      Startampel: so viele rote Lampen leuchten
//   { type: 'go', t }                      Ampel aus – Los
//   { type: 'lap', ctrl: 1..6, t }         Durchfahrt Start/Ziel
//   { type: 'pit', ctrl, inPit, t }        Fahrzeug fährt in die Box / verlässt sie
//   { type: 'falseStart', ctrl, t }        Fehlstart (von der CU erkannt)
//   { type: 'short', t }                   Kurzschluss → sofort Rote Flagge
//
// Ausgehende Meldungen (on(fn) → fn(type, data)), z. B. für Sprachausgabe und Laufschrift:
//   lap, fastestLap, personalRecord, carRecord, trackRecord, pitCall, fuelEmpty, pitIn, pitOut, refueled,
//   penalty, penaltyServed, falseStart, lights, go, redFlag, resume, lastLap, finish, win, qualiDone, pole, end
(function () {
  const MODES = { practice: 'Freies Training', quali: 'Qualifying', race: 'Rennen' };
  const MD = () => window.MasterData;

  class Session {
    /**
     * mode: 'practice' | 'quali' | 'race'
     * laps: Renn-Runden bzw. Quali-Runden je Fahrer (Training: egal)
     * entries: [{ ctrl, driverId, carId }]
     * track: Strecken-Dokument (refLapMs, minLapMs …), settings: Renneinstellungen
     * records: [{ driverId, carId, ms }] bisherige Rekorde dieser Strecke
     */
    constructor ({ mode = 'practice', laps = 0, entries = [], track = {}, settings = {}, records = [], fuel, finishCount = 0, dqOpenPenalties = false, fullDistance = false } = {}) {
      this.mode = MODES[mode] ? mode : 'practice';
      this.laps = Math.max(0, Math.round(laps || 0));
      this.track = track || {};
      this.settings = MD().raceSettings(settings);
      this.fuelOn = fuel ?? this.mode === 'race';
      this.records = records.filter(r => r.ms > 0);
      this.phase = 'ready';     // ready | lights | green | red | finished
      this.lights = 0;
      this.goT = null;
      this.redAt = null;
      this.restarts = 0;
      this.redTotalMs = 0;      // Summe aller Unterbrechungen (für die Rennzeit)
      this.finishCount = Math.max(0, Math.round(finishCount || 0));   // Rennende, wenn so viele im Ziel sind (0 = alle)
      this.dqOpenPenalties = !!dqOpenPenalties;
      this.fullDistance = !!fullDistance;   // alle fahren die volle Rundenzahl (Überrundete fahren nach dem Sieg weiter)                      // offene Strafen bei Rennende → disqualifiziert
      this.sessionBest = null;  // { ctrl, ms }
      this.leaderFinished = false;
      this.listeners = [];
      this.cars = new Map(entries.map((e, i) => [Number(e.ctrl), {
        ctrl: Number(e.ctrl), driverId: e.driverId, carId: e.carId, grid: i + 1,
        laps: 0, last: null, best: null, lastCross: null, crossings: [], lapTimes: [],
        pausedMs: 0, interrupted: false,
        fuel: 100, pitCalled: false, fuelEmpty: false,
        inPit: false, pitLastT: null, pitStandMs: 0, pitStops: 0,
        penaltyMs: 0, penaltyLog: [], status: null, pairBests: {},       // status: null | 'dnf' | 'dq'
        finished: false, finishT: null, done: false, started: false
      }]));
    }

    on (fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(f => f !== fn); }; }
    emit (type, data = {}) { for (const fn of this.listeners) { try { fn(type, data); } catch (e) { console.error(e); } } }

    get needsLights () { return this.mode === 'race'; }

    /** Training/Quali: Strecke sofort frei. Rennen: auf Ampel warten (lights/go der Quelle). */
    start (t) {
      if (this.phase !== 'ready') return;
      if (this.needsLights) { this.phase = 'lights'; this.lights = 0; return; }
      this.goT = t ?? 0;
      this.phase = 'green';
      this.emit('go', { t: this.goT, restart: false });
    }

    /** Ereignis der Datenquelle verarbeiten */
    handle (ev) {
      switch (ev.type) {
        case 'lights': return this.onLights(ev);
        case 'go': return this.onGo(ev);
        case 'lap': return this.onLap(ev);
        case 'pit': return this.onPit(ev);
        case 'falseStart': return this.onFalseStart(ev.ctrl, ev.t);
        case 'short': return this.redFlag(ev.t, 'short');
      }
    }

    onLights ({ step }) {
      if (this.phase !== 'lights') return;
      this.lights = step;
      this.emit('lights', { step });
    }

    onGo ({ t }) {
      if (this.phase !== 'lights') return;
      const restart = this.goT != null;
      this.lights = 0;
      if (restart) {
        // Unterbrechung aus der laufenden Runde herausrechnen, die Runde zählt aber nicht für Bestzeiten
        const pause = t - this.redAt;
        this.redTotalMs += pause;
        for (const c of this.cars.values()) {
          if (c.lastCross != null) { c.pausedMs += pause; c.interrupted = true; }
          if (c.inPit) c.pitLastT = t;
        }
        this.redAt = null;
      } else {
        this.goT = t;
      }
      this.phase = 'green';
      this.emit('go', { t, restart });
    }

    onFalseStart (ctrl, t) {
      const c = this.cars.get(Number(ctrl));
      if (!c || this.mode !== 'race' || c.falseStart) return;
      c.falseStart = true;
      this.addPenalty(ctrl, this.settings.falseStartPenaltySec, 'Fehlstart');
      this.emit('falseStart', { ctrl: c.ctrl, driverId: c.driverId, t });
    }

    /**
     * Zeitstrafe vergeben. Strafen werden summiert und in der Box abgesessen – auch scheibchenweise:
     * wer die Box früher verlässt, behält den Rest. Erst ohne offene Strafe wird getankt.
     */
    addPenalty (ctrl, sec, reason = 'Strafe') {
      const c = this.cars.get(Number(ctrl));
      if (!c || !(sec > 0)) return;
      c.penaltyMs += sec * 1000;
      c.penaltyLog.push({ sec, reason });
      this.emit('penalty', { ctrl: c.ctrl, driverId: c.driverId, sec, reason, openSec: c.penaltyMs / 1000 });
    }

    /** Offene Strafe zurücknehmen */
    clearPenalty (ctrl) {
      const c = this.cars.get(Number(ctrl));
      if (!c || !c.penaltyMs) return;
      c.penaltyLog.push({ sec: -c.penaltyMs / 1000, reason: 'zurückgenommen' });
      c.penaltyMs = 0;
      this.emit('change');
    }

    /**
     * Gutschrift: zieht von der offenen Strafe ab (Standard 5 s), nie unter 0.
     * Ohne offene Strafe gibt es keine Gutschrift.
     */
    creditPenalty (ctrl, sec = 5) {
      const c = this.cars.get(Number(ctrl));
      if (!c || !c.penaltyMs || !(sec > 0)) return 0;
      const ms = Math.min(c.penaltyMs, sec * 1000);
      c.penaltyMs -= ms;
      c.penaltyLog.push({ sec: -ms / 1000, reason: 'Gutschrift' });
      this.emit('penaltyCredit', { ctrl: c.ctrl, driverId: c.driverId, sec: ms / 1000, openSec: c.penaltyMs / 1000 });
      this.emit('change');
      return ms / 1000;
    }

    openPenaltySec (c) { return c.penaltyMs / 1000; }

    /** Fahrer aus der Wertung nehmen: 'dnf' (ausgefallen) oder 'dq' (disqualifiziert); null hebt es auf */
    setStatus (ctrl, status) {
      const c = this.cars.get(Number(ctrl));
      if (!c) return;
      c.status = ['dnf', 'dq'].includes(status) ? status : null;
      this.emit('status', { ctrl: c.ctrl, driverId: c.driverId, status: c.status });
      if (this.mode === 'race' && this.phase === 'green') this.checkRaceEnd(this.lastT ?? 0);
      this.emit('change');
    }

    onLap ({ ctrl, t }) {
      const c = this.cars.get(Number(ctrl));
      if (!c || c.status || c.finished) return;   // im Ziel: weitere Durchfahrten zählen nicht
      this.lastT = t;
      if (this.phase === 'lights') {
        // Über die Linie, bevor die Ampel aus ist → Fehlstart (nur beim ersten Start des Rennens)
        if (this.goT == null) this.onFalseStart(c.ctrl, t);
        return;
      }
      if (this.phase !== 'green') return;            // Rote Flagge / beendet: keine Wertung
      if (c.done) return;                            // Quali-Runden fertig
      if (c.lastCross == null) {                     // erste Durchfahrt: Zeitnahme beginnt
        c.lastCross = t; c.started = true; c.crossings[0] = t;
        if (this.mode === 'race' && this.leaderFinished) this.finishCar(c, t);
        this.emit('change');
        return;
      }
      const raw = t - c.lastCross - c.pausedMs;
      const minLap = MD().trackSetup(this.track).minLapMs || 0;
      if (!c.interrupted && raw < minLap) return;    // zu kurz (Doppelmeldung / Fehlimpuls)
      const interrupted = c.interrupted;
      c.lastCross = t; c.pausedMs = 0; c.interrupted = false;
      c.laps += 1;
      c.crossings[c.laps] = t;
      c.last = raw;
      c.lapTimes.push({ ms: raw, interrupted, pit: c.pitThisLap || false });
      c.pitThisLap = c.inPit;

      if (this.fuelOn && !c.inPit) this.burnFuel(c, interrupted ? null : raw);

      const info = { ctrl: c.ctrl, driverId: c.driverId, carId: c.carId, lap: c.laps, ms: raw, interrupted };
      this.emit('lap', info);
      if (!interrupted) this.checkBest(c, raw);

      if (this.mode === 'race') this.raceProgress(c, t);
      else if (this.mode === 'quali' && this.laps && c.laps >= this.laps) {
        c.done = true;
        this.emit('qualiDone', { ctrl: c.ctrl, driverId: c.driverId });
        if ([...this.cars.values()].every(x => x.done)) this.finish(t);
      }
      this.emit('change');
    }

    burnFuel (c, lapMs) {
      const before = c.fuel;
      c.fuel = Math.max(0, c.fuel - MD().fuelPerLap(lapMs ?? MD().trackSetup(this.track).refLapMs, this.track, this.settings));
      if (!c.pitCalled && c.fuel <= this.settings.pitCallFuelPct && before > this.settings.pitCallFuelPct) {
        c.pitCalled = true;
        this.emit('pitCall', { ctrl: c.ctrl, driverId: c.driverId, fuel: c.fuel });
      }
      // Tank leer: das Fahrzeug wird über die CU gedrosselt (emptyTankSpeed), bis wieder getankt ist
      if (c.fuel === 0 && !c.fuelEmpty) { c.fuelEmpty = true; this.emit('fuelEmpty', { ctrl: c.ctrl, driverId: c.driverId, level: this.settings.emptyTankSpeed }); }
    }

    checkBest (c, ms) {
      const personalBefore = c.best;
      if (c.best == null || ms < c.best) c.best = ms;
      if (c.pairBests[c.carId] == null || ms < c.pairBests[c.carId]) c.pairBests[c.carId] = ms;
      const rec = this.recordInfo(c);
      let kind = null;
      if (rec.track == null || ms < rec.track.ms) kind = 'trackRecord';
      else if (rec.personal == null || ms < rec.personal) kind = 'personalRecord';
      if (rec.car == null || ms < rec.car) this.emit('carRecord', { ctrl: c.ctrl, driverId: c.driverId, carId: c.carId, ms });
      const fastest = this.sessionBest == null || ms < this.sessionBest.ms;
      if (fastest) this.sessionBest = { ctrl: c.ctrl, driverId: c.driverId, carId: c.carId, ms };
      // Jede neue Paarungs-Bestzeit zählt ab sofort mit (auch für Fahrzeug-Rekorde nach einem Autowechsel)
      if (rec.pair == null || ms < rec.pair) this.records.push({ driverId: c.driverId, carId: c.carId, ms, session: true });
      if (kind) {
        this.emit(kind, { ctrl: c.ctrl, driverId: c.driverId, carId: c.carId, ms, previous: kind === 'trackRecord' ? rec.track?.ms ?? null : rec.personal });
      } else if (fastest) {
        this.emit('fastestLap', { ctrl: c.ctrl, driverId: c.driverId, ms });
      }
      return { personalBefore, kind, fastest };
    }

    /**
     * Rekorde dieser Strecke (ms). Gespeichert wird je Paarung Fahrer+Fahrzeug; daraus ergeben sich
     * persönlicher Rekord (Fahrer, egal mit welchem Fahrzeug), Fahrzeug-Rekord (egal welcher Fahrer) und Streckenrekord.
     */
    recordInfo (c) {
      const min = list => list.reduce((m, r) => (m == null || r.ms < m.ms ? r : m), null);
      const track = min(this.records);
      const car = min(this.records.filter(r => r.carId === c.carId));
      const personal = min(this.records.filter(r => r.driverId === c.driverId));
      const pair = min(this.records.filter(r => r.carId === c.carId && r.driverId === c.driverId));
      return { track, car: car?.ms ?? null, personal: personal?.ms ?? null, pair: pair?.ms ?? null };
    }

    /**
     * Fahrzeug eines Reglers wechseln (Training/Quali jederzeit, Rennen bei Roter Flagge).
     * Die laufende Runde zählt nicht für Bestzeiten; im Training/Quali beginnt die Bestzeit neu.
     */
    changeCar (ctrl, carId) {
      const c = this.cars.get(Number(ctrl));
      if (!c || carId == null || c.carId === carId) return false;
      if (this.mode === 'race' && this.phase !== 'red') return false;
      c.carId = carId;
      if (c.lastCross != null) c.interrupted = true;
      if (this.mode !== 'race') { c.best = c.pairBests[carId] ?? null; c.last = null; }
      this.emit('carChanged', { ctrl: c.ctrl, driverId: c.driverId, carId });
      this.emit('change');
      return true;
    }

    /**
     * Training: alle Zeiten und Runden auf 0, die Uhr beginnt neu. Die nächste Durchfahrt startet die Zeitnahme.
     * Bestzeiten je Paarung (pairBests) bleiben erhalten, damit neue Rekorde nicht verloren gehen.
     */
    reset (t) {
      if (this.mode !== 'practice' || this.phase === 'finished') return false;
      for (const c of this.cars.values()) {
        Object.assign(c, { laps: 0, last: null, best: null, lastCross: null, crossings: [], lapTimes: [], pausedMs: 0, interrupted: false, started: false, pitStops: 0, pitStandMs: 0 });
      }
      this.goT = t ?? this.goT;
      this.redTotalMs = 0;
      if (this.phase === 'red') this.redAt = t;
      this.sessionBest = null;
      this.emit('reset', { t });
      this.emit('change');
      return true;
    }

    /**
     * Auswertung nach dem Event: Position nach jeder Runde (Reihenfolge der Durchfahrten),
     * Führungsrunden, Durchschnittsrunde (ohne unterbrochene Runden) und alle Runden je Fahrer.
     */
    stats () {
      const cars = [...this.cars.values()];
      const maxLaps = Math.max(0, ...cars.map(c => c.laps));
      const positions = {}, leadLaps = {}, avgMs = {}, laps = {};
      for (const c of cars) {
        positions[c.ctrl] = []; leadLaps[c.ctrl] = 0;
        const clean = c.lapTimes.filter(l => !l.interrupted);
        avgMs[c.ctrl] = clean.length ? clean.reduce((a, l) => a + l.ms, 0) / clean.length : null;
        laps[c.ctrl] = c.lapTimes.map(l => ({ ...l }));
      }
      for (let n = 1; n <= maxLaps; n++) {
        const order = cars.filter(c => c.crossings[n] != null).sort((a, b) => a.crossings[n] - b.crossings[n]);
        order.forEach((c, i) => { positions[c.ctrl][n - 1] = i + 1; });
        if (order[0]) leadLaps[order[0].ctrl] += 1;
      }
      return { maxLaps, positions, leadLaps, avgMs, laps };
    }

    get trackRecord () { return this.records.reduce((m, r) => (m == null || r.ms < m.ms ? r : m), null); }

    raceProgress (c, t) {
      if (c.finished) return;
      if (this.leaderFinished && (!this.fullDistance || c.laps >= this.laps)) { this.finishCar(c, t); return; }
      if (this.leaderFinished) return;
      if (this.laps && c.laps >= this.laps) {
        this.leaderFinished = true;
        this.finishCar(c, t);
        this.emit('win', { ctrl: c.ctrl, driverId: c.driverId });
        return;
      }
      if (this.laps && c.laps === this.laps - 1 && this.leaderLaps() === c.laps) {
        this.emit('lastLap', { ctrl: c.ctrl, driverId: c.driverId });
      }
    }

    leaderLaps () { return Math.max(0, ...[...this.cars.values()].map(x => x.laps)); }

    finishCar (c, t) {
      c.finished = true; c.finishT = t;
      this.emit('finish', { ctrl: c.ctrl, driverId: c.driverId, position: this.standings().findIndex(s => s.ctrl === c.ctrl) + 1 });
      this.checkRaceEnd(t);
    }

    /** Rennende: alle (noch gewerteten) Fahrer im Ziel bzw. die eingestellte Anzahl */
    checkRaceEnd (t) {
      if (!this.leaderFinished) return;
      const active = [...this.cars.values()].filter(x => !x.status);
      const done = active.filter(x => x.finished).length;
      if (done === active.length || (this.finishCount && done >= this.finishCount)) this.finish(t);
    }

    onPit ({ ctrl, inPit, t }) {
      const c = this.cars.get(Number(ctrl));
      if (!c || c.inPit === !!inPit) return;
      c.inPit = !!inPit;
      if (c.inPit) {
        c.pitStops += 1;
        c.pitLastT = t; c.pitStandMs = 0; c.pitThisLap = true;
        c.pitLog = [];                                // für die Korrektur beim Rausfahren
        this.emit('pitIn', { ctrl: c.ctrl, driverId: c.driverId, penaltySec: c.penaltyMs / 1000 });
      } else {
        c.inPit = true; this.updatePit(c, t); c.inPit = false;
        c.pitLastT = null;
        this.pitDriveCorrection(c);
        this.emit('pitOut', { ctrl: c.ctrl, driverId: c.driverId, fuel: c.fuel, penaltySec: c.penaltyMs / 1000 });
      }
      this.emit('change');
    }

    /**
     * Beim Rausfahren: Die CU meldet „raus“ erst am nächsten Sensor nach der Box, die Fahrzeit dorthin
     * (pitDriveMs) wurde live mitgezählt. Was in dieser Zeit gutgeschrieben wurde (Strafe bzw. Tanken), wird jetzt wieder abgezogen.
     */
    pitDriveCorrection (c) {
      // Nur was in den letzten pitDriveMs gutgeschrieben wurde, geht zurück (wer schon voll war, verliert nichts)
      let window = this.settings.pitDriveMs, pen = 0, fuel = 0;
      const log = c.pitLog || [];
      for (let k = log.length - 1; k >= 0 && window > 0; k--) {
        const e = log[k], part = e.dt > 0 ? Math.min(1, window / e.dt) : 1;
        pen += e.pen * part; fuel += e.fuel * part; window -= e.dt;
      }
      c.pitLog = [];
      if (fuel > 0) c.fuel = Math.max(0, c.fuel - fuel);
      if (pen > 0) c.penaltyMs += Math.round(pen);
      if (fuel > 0 || pen > 0) this.emit('pitCorrection', { ctrl: c.ctrl, driverId: c.driverId, fuelPct: fuel, penaltySec: Math.round(pen) / 1000 });
    }

    /** Box: erst Strafe absitzen (auch teilweise), dann tanken (refuelPctPerSec). Läuft über tick(). Fahrzeit siehe pitDriveCorrection. */
    updatePit (c, t) {
      if (!c.inPit || c.pitLastT == null) return;
      if (this.phase === 'red' || this.phase === 'finished') { c.pitLastT = t; return; }
      let dt = Math.max(0, t - c.pitLastT);
      c.pitLastT = t;
      c.pitStandMs += dt;
      const entry = { dt, pen: 0, fuel: 0 };
      (c.pitLog ??= []).push(entry);
      if (c.pitLog.length > 600) c.pitLog.splice(0, c.pitLog.length - 600);
      if (c.penaltyMs > 0) {
        const serve = Math.min(dt, c.penaltyMs);
        c.penaltyMs -= serve; dt -= serve; entry.pen = serve;
        if (c.penaltyMs <= 0) { c.penaltyMs = 0; this.emit('penaltyServed', { ctrl: c.ctrl, driverId: c.driverId }); }
      }
      if (c.penaltyMs > 0 || !this.fuelOn || dt <= 0) return;
      const before = c.fuel;
      c.fuel = Math.min(100, c.fuel + dt / 1000 * this.settings.refuelPctPerSec);
      entry.fuel = c.fuel - before;
      if (c.fuel > this.settings.pitCallFuelPct) c.pitCalled = false;
      if (c.fuelEmpty && c.fuel > 0) { c.fuelEmpty = false; this.emit('fuelRestored', { ctrl: c.ctrl, driverId: c.driverId }); }
      if (c.fuel >= 100 && before < 100) this.emit('refueled', { ctrl: c.ctrl, driverId: c.driverId });
    }

    /** Regelmäßig aufrufen (z. B. alle 100 ms) mit der Uhr der Quelle */
    tick (t) {
      this.lastT = t;
      for (const c of this.cars.values()) if (c.inPit) this.updatePit(c, t);
    }

    /** Rennzeit (ohne Unterbrechungen) und Gesamtzeit seit dem Start, in ms */
    clocks (t) {
      if (this.goT == null) return { race: 0, total: 0 };
      const end = this.phase === 'finished' ? (this.endT ?? t) : t;
      const openRed = this.redAt != null ? end - this.redAt : 0;
      return { race: Math.max(0, end - this.goT - this.redTotalMs - openRed), total: Math.max(0, end - this.goT) };
    }

    redFlag (t, reason = 'manual') {
      if (!['green', 'lights'].includes(this.phase)) return;
      if (this.phase === 'lights' && this.goT == null) { this.phase = 'ready'; this.lights = 0; this.emit('redFlag', { reason, beforeStart: true }); return; }
      if (this.phase === 'green') this.redAt = t;
      for (const c of this.cars.values()) if (c.inPit) this.updatePit(c, t);
      this.phase = 'red';
      this.lights = 0;
      this.emit('redFlag', { reason });
      this.emit('change');
    }

    /** Nach Roter Flagge: „Weiter geht's!“, danach volle Startampel (Quelle schickt lights/go); Training sofort */
    resume (t) {
      if (this.phase === 'red') {
        this.phase = 'lights'; this.restarts++;
        this.emit('resume', { lights: this.needsLights });
        if (!this.needsLights) this.onGo({ t });      // Training: ohne Ampel sofort weiter
        return true;
      }
      if (this.phase === 'ready') { this.start(); return true; }
      return false;
    }

    finish (t) {
      if (this.phase === 'finished') return;
      for (const c of this.cars.values()) if (c.inPit) this.updatePit(c, t);
      this.phase = 'finished';
      this.endT = t;
      if (this.mode === 'race' && this.dqOpenPenalties) {
        for (const c of this.cars.values()) if (!c.status && c.penaltyMs > 0) { c.status = 'dq'; c.dqReason = 'offene Strafe'; }
      }
      if (this.mode === 'quali') {
        const pole = this.standings()[0];
        if (pole?.best != null) this.emit('pole', { ctrl: pole.ctrl, driverId: pole.driverId, ms: pole.best });
      }
      this.emit('end', { standings: this.standings() });
      this.emit('change');
    }

    /** Gesamtzeit im Ziel inkl. nicht abgesessener Strafen */
    totalMs (c) {
      if (c.finishT == null || this.goT == null) return null;
      return c.finishT - this.goT - this.redTotalMs + c.penaltyMs;
    }

    /**
     * Aktuelle Reihenfolge mit Anzeige-Werten.
     * Rennen: Runden ↓, dann wer die Runde zuerst beendet hat; im Ziel zählt die Gesamtzeit inkl. offener Strafen.
     * Training/Quali: beste Runde ↑ (ohne Zeit hinten).
     */
    standings () {
      const list = [...this.cars.values()];
      const rank = c => (c.status === 'dq' ? 2 : c.status === 'dnf' ? 1 : 0);
      if (this.mode === 'race') {
        list.sort((a, b) => {
          if (rank(a) !== rank(b)) return rank(a) - rank(b);
          if (b.laps !== a.laps) return b.laps - a.laps;
          if (a.finished && b.finished) return this.totalMs(a) - this.totalMs(b);
          const ta = a.crossings[a.laps], tb = b.crossings[b.laps];
          if (ta == null || tb == null) return (ta == null) - (tb == null) || a.grid - b.grid;
          return ta - tb;
        });
      } else {
        list.sort((a, b) => (a.best ?? Infinity) - (b.best ?? Infinity) || b.laps - a.laps || a.grid - b.grid);
      }
      const lead = list[0];
      return list.map((c, i) => {
        let gap = null, gapLaps = 0;
        if (i > 0 && lead) {
          if (this.mode === 'race') ({ gap, gapLaps } = this.raceGap(c, lead));
          else if (c.best != null && lead.best != null) gap = c.best - lead.best;
        }
        const rec = this.recordInfo(c);
        return {
          pos: i + 1, ctrl: c.ctrl, driverId: c.driverId, carId: c.carId,
          laps: c.laps, last: c.last, best: c.best, gap, gapLaps,
          fuel: this.fuelOn ? c.fuel : null, fuelEmpty: c.fuelEmpty, inPit: c.inPit, pitStops: c.pitStops, pitStandMs: c.inPit ? c.pitStandMs : 0,
          penaltySec: c.penaltyMs / 1000, penaltyTotalSec: Math.max(0, c.penaltyLog.reduce((a, p) => a + p.sec, 0)), servingPenalty: c.inPit && c.penaltyMs > 0, status: c.status, dqReason: c.dqReason || null,
          finished: c.finished, done: c.done, started: c.started,
          lastInterrupted: c.lapTimes.at(-1)?.interrupted || false,
          sessionBest: this.sessionBest?.ctrl === c.ctrl && c.best === this.sessionBest.ms,
          personalRecord: rec.personal, carRecord: rec.car, total: this.totalMs(c)
        };
      });
    }

    /**
     * Abstand zum Führenden wie bei der Zeitnahme üblich: an der letzten gemeinsamen Linie gemessen.
     * Rundenrückstand erst, wenn der Führende das Fahrzeug wirklich überrundet hat.
     */
    raceGap (c, lead) {
      if (c.status) return { gap: null, gapLaps: 0 };
      if (c.finished && lead.finished && c.laps === lead.laps) return { gap: this.totalMs(c) - this.totalMs(lead), gapLaps: 0 };
      const mine = c.crossings[c.laps];
      if (mine == null) return { gap: null, gapLaps: lead.laps - c.laps };
      // Führender war nach meiner letzten Durchfahrt erst einmal über der Linie → weniger als eine Runde zurück
      const diff = lead.laps - c.laps;
      const gapLaps = diff - (diff > 0 && lead.crossings[c.laps + 1] > mine ? 1 : 0);
      if (gapLaps) return { gap: null, gapLaps };
      const ref = lead.crossings[c.laps];
      // Negativ nur, wenn der Führende an dieser Linie noch hinten lag (z. B. Überholen nach Boxenstopp) → 0
      return { gap: ref == null ? null : Math.max(0, mine - ref), gapLaps: 0 };
    }

    /** Für das Ergebnis: Reihenfolge + Paarungen, so wie sie später bestätigt und gespeichert werden */
    result () {
      return this.standings().map(s => ({ position: s.pos, driverId: s.driverId, carId: s.carId, laps: s.laps, best: s.best, total: s.total, penaltySec: s.penaltySec }));
    }
  }

  window.RaceEngine = { Session, MODES };
})();
