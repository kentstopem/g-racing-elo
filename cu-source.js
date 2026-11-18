// cu-source.js – Datenquelle „Control Unit“ für das Livecenter (window.LiveCU)
//
// Gleiche Schnittstelle wie der Simulator (live-sim.js): on, now, prepare, release, startLights,
// stopCars, limitSpeed, setTuning, close. Grundlage ist der Test an der Bahn vom 17.11.2026:
// • Ampel der CU: 0 = frei, 1 = Rot (Start-Taste/Buzzer bzw. Befehl START), 2–6 = Lampen 1–5,
//   7 ~1 s, danach 0. Ansagen eine Stufe früher: START aus Rot = „5“, 2–5 = „4“–„1“, 6 = „Los“. 8/9 = Fehlstart (ohne Angabe, wer).
// • Start-Taste und Buzzer während der Fahrt: 0 → 1 = Rote Flagge. Kurzschluss meldet die CU nicht.
// • START aus der App wirkt wie die Taste, ESC bei Ampel 1 gibt die Strecke frei (→ 0).
// • Box: Bit „in der Box“ ab dem Box-Sensor bis zum nächsten Sensor.
// • Gas/Bremse (Stufe 0–15) per Befehl, wird im Auto gespeichert.
(function () {
  const hub = {
    state: 'idle',            // idle | connecting | connected | lost
    conn: null,
    name: '',
    version: '',
    lastStatus: null,
    error: '',
    subs: new Set(),
    stateSubs: new Set(),
    progSubs: new Set(),
    pending: {},              // ctrl → Zeitpunkt, seit dem Gas/Bremse gesendet, aber noch kein Sensor gemeldet ist
    programmedAt: 0,

    available () { return !!window.CU?.Connection?.available?.(); },

    setState (s, error = '') { this.state = s; this.error = error; this.stateSubs.forEach(fn => { try { fn(s); } catch (e) {} }); },
    onState (fn) { this.stateSubs.add(fn); return () => this.stateSubs.delete(fn); },
    subscribe (fn) { this.subs.add(fn); return () => this.subs.delete(fn); },

    async connect () {
      if (this.state === 'connected' || this.state === 'connecting') return;
      this.setState('connecting');
      if (!this.conn) {
        this.conn = new window.CU.Connection({
          onMessage: raw => {
            const ev = window.CU.parse(raw);
            if (ev.ok === false) return;
            if (ev.type === 'status') this.lastStatus = ev;
            if (ev.type === 'version') this.version = ev.version;
            // Programmieren endet, wenn das Auto über einen Sensor fährt (Bahntest 17.11.2026)
            if (ev.type === 'timer' && this.pending[ev.address] && performance.now() - this.pending[ev.address] > 300) {
              delete this.pending[ev.address];
              this.progSubs.forEach(fn => { try { fn(ev.address); } catch (e) {} });
            }
            this.subs.forEach(fn => { try { fn(ev); } catch (e) { console.error(e); } });
          },
          onDisconnect: () => this.setState('lost', 'Verbindung zur CU getrennt'),
          onReconnect: () => this.setState('connected'),
          log: () => {}
        });
      }
      try {
        this.name = await this.conn.connect({ variant: 'name' });
        this.conn.startPolling();
        this.conn.requestVersion();
        this.setState('connected');
      } catch (err) {
        this.setState(this.conn.connected ? 'connected' : 'idle', err.message);
      }
    },

    disconnect () { this.conn?.disconnect(); this.lastStatus = null; this.setState('idle'); },

    send (cmd) { if (this.state === 'connected') this.conn.command(cmd); },

    /** Gas/Bremse (Stufe 0–15) ins Auto auf diesem Regler programmieren */
    // Bei Rot (Ampel 1) nimmt die CU kein Tuning an (Tristan 18.11.2026): vorher mit ESC freigeben.
    // Nur in der Vorbereitung (ohne laufende Sitzung) aufrufen, dort wird nichts gewertet.
    program (ctrl, { speed, brake } = {}) {
      if (this.state !== 'connected') return false;
      const C = window.CU.Commands;
      this.programmedAt = this.pending[ctrl] = performance.now();
      this.progSubs.forEach(fn => { try { fn(ctrl); } catch (e) {} });
      const go = () => { this.send(C.speed(ctrl, speed ?? 15)); this.send(C.brake(ctrl, brake ?? 15)); };
      const free = () => [0, undefined, null].includes(this.lastStatus?.start);
      if (free()) { go(); return true; }
      const t0 = performance.now(), esc = () => { this.send(C.press(window.CU.BUTTON.ESC)); lastEsc = performance.now(); };
      let lastEsc = 0;
      const wait = () => {
        if (free() || performance.now() - t0 > 3000) { go(); return; }
        if (performance.now() - lastEsc > 900) esc();                       // Befehle gehen per Bluetooth auch mal verloren
        setTimeout(wait, 150);
      };
      esc(); setTimeout(wait, 150);
      return true;
    },
    onProgram (fn) { this.progSubs.add(fn); return () => this.progSubs.delete(fn); }
  };

  const C = () => window.CU.Commands;
  const B = () => window.CU.BUTTON;
  const RESEND_MS = 900;

  class CuSource {
    constructor () {
      this.listeners = [];
      this.ctrls = new Set();
      this.tuning = {};          // ctrl → { speed, brake }
      this.limit = {};           // ctrl → Stufe bei leerem Tank
      this.offset = null;        // performance.now() − CU-Zeitstempel (kleinster gesehener Wert)
      this.lastTs = {};
      this.pit = {};
      this.prevStart = null;
      this.counting = false;     // Countdown der CU läuft
      this.want = null;          // null | 'start' | 'release' | 'hold'
      this.lastSend = 0;
      this.diag = { timers: 0, used: 0, last: null, msgs: 0 };   // Anzeige im Livecenter zur Fehlersuche
      // Boxen-Bits aus der vorigen Sitzung gelten nicht: nur Änderungen ab jetzt melden (Tristan 17.11.)
      (hub.lastStatus?.pit || []).forEach((inPit, i) => { this.pit[i + 1] = !!inPit; });
      this.unsub = hub.subscribe(ev => this.onCu(ev));
      this.loop = setInterval(() => this.drive(), 150);
    }

    get kind () { return 'cu'; }
    on (fn) { this.listeners.push(fn); }
    emit (ev) { ev.t ??= this.now(); for (const fn of this.listeners) fn(ev); }
    now () { return performance.now(); }

    prepare (cars) { this.ctrls = new Set(cars.map(c => Number(c.ctrl))); }
    /** Training: Regler dazunehmen / freigeben (nur noch Durchfahrten bekannter Regler zählen) */
    addCar ({ ctrl }) { this.ctrls.add(Number(ctrl)); }
    removeCar (ctrl) { this.ctrls.delete(Number(ctrl)); }

    /** Training/Quali und nach Roter Flagge im Training: Strecke freigeben */
    release () { this.want = 'release'; this.drive(); }
    /** Startampel über die CU (START, ggf. zweimal) – lights/go kommen von der CU zurück */
    startLights () { this.want = 'start'; this.drive(); }
    /** Rote Flagge / Rennende: CU auf Rot halten */
    stopCars () { this.want = 'hold'; this.drive(); }

    // Gas/Bremse programmiert die CU ins Auto (Lampen an der CU leuchten, bis das Auto über einen
    // Sensor fährt). Während dieser Zeit meldet die CU Durchfahrten/Ampel unzuverlässig (Test 17.11.2026).
    // Deshalb nur auf ausdrücklichen Wunsch senden (Tuning-Menü), nicht automatisch beim Start.
    setTuning (ctrl, { speed, brake } = {}, { send = false } = {}) {
      const t = this.tuning[ctrl] = { speed: speed ?? 15, brake: brake ?? 15 };
      if (!send) return;
      hub.program(ctrl, t);
    }

    /** Leerer Tank: vorerst ohne Drosselung über die CU (siehe setTuning) */
    limitSpeed (ctrl, level) { this.limit[ctrl] = level; }

    press (button) { hub.send(C().press(button)); this.lastSend = performance.now(); }

    /** Sorgt dafür, dass die CU im gewünschten Zustand ist (Befehle gehen per Bluetooth auch mal verloren) */
    drive () {
      const st = hub.lastStatus?.start;
      if (st == null || hub.state !== 'connected' || performance.now() - this.lastSend < RESEND_MS) return;
      const countdown = st >= 2 && st <= 7;
      if (this.want === 'start') {
        if (!countdown && [0, 1, 8, 9].includes(st)) {
          this.press(B().START);                                                // 0/9 → 1 → Countdown
          // Ansagen eine CU-Stufe früher (Tristan 17.11.): „5“ schon mit dem Start-Befehl aus Rot
          if (st === 1 && !this.counting) { this.counting = true; this.emit({ type: 'lights', step: 1 }); }
        }
      } else if (this.want === 'release') {
        if (st === 0) this.want = null;
        else if (!countdown) this.press(B().ESC);                              // 1 → 0
      } else if (this.want === 'hold') {
        if (st === 0 || st === 9) this.press(B().START);                       // → 1 (Rot)
        else if (countdown && !this.counting) this.press(B().ESC);             // fremder Countdown → abbrechen
      }
    }

    onCu (ev) {
      this.diag.msgs++;
      if (ev.type === 'timer') {
        this.diag.timers++; this.diag.last = { addr: ev.address, sector: ev.sector };
        if (ev.sector !== 1 || ev.address < 1 || ev.address > 8) return;
        if (this.lastTs[ev.address] === ev.timestamp) return;
        this.lastTs[ev.address] = ev.timestamp;
        const diff = performance.now() - ev.timestamp;
        // CU-Uhr → Uhr der App; springt die CU-Uhr (Neustart), neu ausrichten
        if (this.offset == null || diff < this.offset || diff - this.offset > 3000) this.offset = diff;
        if (this.ctrls.size && !this.ctrls.has(ev.address)) return;
        this.diag.used++;
        this.emit({ type: 'lap', ctrl: ev.address, t: ev.timestamp + this.offset });
        return;
      }
      if (ev.type !== 'status') return;
      const st = ev.start, prev = this.prevStart;
      this.prevStart = st;
      if (prev !== st && prev != null) {
        if (st >= 2 && st <= 5) {
          // Countdown eine Stufe früher als die Lampen der CU: 2 → „4“ … 5 → „1“, 6 → „Los“ (Tristan 17.11. an der Bahn)
          this.counting = this.counting || this.want === 'start' || this.want === null;
          if (this.counting) this.emit({ type: 'lights', step: st });
        } else if ((st === 6 || st === 7 || st === 0) && this.counting) {
          this.counting = false;
          if (this.want === 'start') this.want = null;
          this.emit({ type: 'go' });
        } else if (st === 9 || st === 8) {
          if (prev !== 8 && prev !== 9) { this.counting = false; this.want = 'hold'; this.emit({ type: 'falseStart' }); }
        } else if (st === 1 && prev === 0 && this.want !== 'start' && this.want !== 'hold' && !(performance.now() - (hub.programmedAt || 0) < 15000)) {
          this.want = 'hold';
          this.emit({ type: 'stop' });                                          // Start-Taste oder Buzzer
        }
      }
      ev.pit.forEach((inPit, i) => {
        const ctrl = i + 1;
        if (!!this.pit[ctrl] === inPit) return;
        this.pit[ctrl] = inPit;
        if (!this.ctrls.size || this.ctrls.has(ctrl)) this.emit({ type: 'pit', ctrl, inPit });
      });
    }

    close () {
      clearInterval(this.loop);
      this.unsub?.();
      this.listeners = [];
    }
  }

  window.LiveCU = { hub, CuSource };
})();
