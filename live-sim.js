// live-sim.js – Simulierte Datenquelle für das Livecenter (window.LiveSim)
//
// Liefert dieselben Ereignisse wie später die Control Unit (siehe race-engine.js):
// lights / go / lap / pit / falseStart / short. Damit lässt sich das Livecenter ohne Bahn testen.
//
// Schnittstelle einer Datenquelle (gilt auch für die spätere CU-Quelle):
//   on(fn)            Ereignisse abonnieren, fn(ev)
//   now()             aktuelle Zeit der Quelle in ms (für engine.tick)
//   prepare(cars, o)  Fahrzeuge auf die Regler legen: [{ ctrl, paceMs }], o.refLapMs
//   release()         Training: Strecke sofort frei
//   startLights()     Startampel 5-4-3-2-1 → go (Quali, Rennen, Neustart nach Roter Flagge)
//   stopCars()        Strom aus (Rote Flagge)
//   limitSpeed(c, l)  Tempo eines Reglers auf CU-Stufe l begrenzen (null = frei), z. B. bei leerem Tank
//   close()
// Auch für die CU: setTuning(ctrl, { speed, brake })
// Nur im Simulator: setSpeed(x), short(), falseStart(ctrl), pit(ctrl), setPitInfo(fn), setPace(ctrl, ms)
(function () {
  const rnd = (a, b) => a + Math.random() * (b - a);

  class SimSource {
    constructor () {
      this.listeners = [];
      this.speed = 1;
      this.base = 0;
      this.realStart = performance.now();
      this.cars = new Map();
      this.timers = [];
      this.running = false;      // Strom an, Fahrzeuge fahren
      this.refLapMs = 7000;
      this.pitInfo = () => ({ fuel: null, penaltyLeftMs: 0 });
      this.loop = setInterval(() => this.step(), 40);
    }

    get kind () { return 'sim'; }
    on (fn) { this.listeners.push(fn); }
    emit (ev) { ev.t ??= this.now(); for (const fn of this.listeners) fn(ev); }
    now () { return this.base + (performance.now() - this.realStart) * this.speed; }

    setSpeed (x) {
      this.base = this.now(); this.realStart = performance.now(); this.speed = x;
    }
    /** fn(ctrl) → { fuel (% | null ohne Tank), penaltyLeftMs } aus der Engine, damit die Box realistisch wirkt */
    setPitInfo (fn) { this.pitInfo = fn; }

    /** Zeitgesteuertes Ereignis in Simulator-Zeit */
    at (t, fn, start = false) { this.timers.push({ t, fn, start }); }

    prepare (cars, { refLapMs } = {}) {
      this.refLapMs = refLapMs || 7000;
      this.cars = new Map(cars.map((c, i) => [c.ctrl, {
        ctrl: c.ctrl,
        pace: c.paceMs || this.refLapMs * rnd(0.85, 0.97),    // Grundtempo dieser Paarung
        next: null, frozenLeft: null, inPit: false, pitUntil: null, wantPit: false, grid: i
      }]));
    }

    /** Tempo eines Reglers begrenzen (CU-Stufe 0–15, null = frei) – z. B. bei leerem Tank */
    limitSpeed (ctrl, level) { const c = this.cars.get(ctrl); if (c) c.limit = level; }

    /** Tuning (CU-Stufe 0–15) – im Simulator wirkt nur das Tempo */
    setTuning (ctrl, { speed } = {}) { const c = this.cars.get(ctrl); if (c) c.tune = speed ?? 15; }

    /** Neues Fahrzeug auf dem Regler: anderes Grundtempo */
    setPace (ctrl, paceMs) { const c = this.cars.get(ctrl); if (c && paceMs) c.pace = paceMs; }

    lapTime (car) {
      let t = car.pace * rnd(0.985, 1.03);
      if (car.limit != null) t *= 1 + (15 - car.limit) / 15 * 1.2;   // Stufe 4 ≈ 1,9× so lange
      else if (car.tune != null) t *= 1 + (15 - car.tune) / 15 * 0.6;
      if (Math.random() < 0.06) t += rnd(1500, 4500);           // abgeflogen, wieder eingesetzt
      return t;
    }

    release () { this.resumeCars(); }

    startLights () {
      this.clearStart();
      const t0 = this.now();
      for (let s = 1; s <= 5; s++) this.at(t0 + s * 1000, () => this.emit({ type: 'lights', step: s }), true);
      this.at(t0 + 6000, () => { this.emit({ type: 'go' }); this.resumeCars(); }, true);
    }
    clearStart () { this.timers = this.timers.filter(x => !x.start); }

    resumeCars () {
      this.running = true;
      const now = this.now();
      for (const c of this.cars.values()) {
        if (c.frozenLeft != null) { c.next = now + c.frozenLeft + rnd(300, 900); c.frozenLeft = null; }
        else if (c.next == null) c.next = now + rnd(250, 700) + c.grid * 120;   // Startaufstellung kurz vor der Linie
        if (c.inPit && c.pitFrozen != null) { c.pitUntil = now + c.pitFrozen; c.pitFrozen = null; }
      }
    }

    stopCars () {
      this.running = false;
      this.clearStart();
      const now = this.now();
      for (const c of this.cars.values()) {
        if (c.next != null) { c.frozenLeft = Math.max(0, c.next - now); c.next = null; }
        if (c.inPit && c.pitUntil != null) { c.pitFrozen = Math.max(0, c.pitUntil - now); c.pitUntil = null; }
      }
    }

    /** Kurzschluss auslösen (Simulator-Knopf) */
    short () { this.stopCars(); this.emit({ type: 'short' }); }

    /** Fehlstart eines Reglers (wirkt nur während der Startampel) */
    falseStart (ctrl) { this.emit({ type: 'falseStart', ctrl }); }

    /** Fahrzeug beim nächsten Vorbeikommen an die Box schicken */
    pit (ctrl) { const c = this.cars.get(ctrl); if (c) c.wantPit = true; }

    step () {
      const now = this.now();
      const due = this.timers.filter(x => x.t <= now).sort((a, b) => a.t - b.t);
      if (due.length) { this.timers = this.timers.filter(x => x.t > now); due.forEach(x => x.fn()); }
      if (!this.running) return;
      for (const c of this.cars.values()) {
        if (c.inPit) {
          // Box verlassen, wenn genug im Tank (oder die Standzeit um ist)
          const { fuel, penaltyLeftMs } = this.pitInfo(c.ctrl);
          if (c.pitUntil != null && now >= c.pitUntil && !(penaltyLeftMs > 0) && (fuel == null || fuel >= c.fuelTarget)) {
            c.inPit = false; c.pitUntil = null;
            this.emit({ type: 'pit', ctrl: c.ctrl, inPit: false, t: now });
            c.next = now + this.lapTime(c) * 0.75;
          }
          continue;
        }
        if (c.next == null || now < c.next) continue;
        this.emit({ type: 'lap', ctrl: c.ctrl, t: c.next });
        const { fuel, penaltyOpen } = this.pitInfo(c.ctrl);
        const lowFuel = fuel != null && fuel < rnd(12, 22);
        if (c.wantPit || lowFuel || (penaltyOpen && Math.random() < 0.35)) {
          c.wantPit = false;
          c.inPit = true;
          c.fuelTarget = fuel == null ? 0 : rnd(55, 100);
          c.pitUntil = c.next + 1200 + rnd(1000, 2500);                // mindestens kurz stehen
          this.at(c.next + 900, () => this.emit({ type: 'pit', ctrl: c.ctrl, inPit: true }));
          c.next = null;
          continue;
        }
        c.next += this.lapTime(c);
      }
    }

    close () { clearInterval(this.loop); this.listeners = []; this.timers = []; this.running = false; }
  }

  window.LiveSim = { SimSource };
})();
