// masterdata.js – Stammdaten-Logik für Fahrer, Fahrzeuge, Strecken und Renneinstellungen
// (Grundlage für die Ablösung von SmartRace; reine Funktionen, ohne Firebase testbar)
//
// Datenmodell in Firestore (alle neuen Felder sind optional, bestehende Daten bleiben gültig):
//   drivers/{id}   + preferredController (1–6 | null), pronunciation (Aussprache-Schreibweise für die Sprachausgabe),
//                    voiceRev (Zeitstempel, wenn ein Namens-Ton hinterlegt ist)
//   cars/{id}      + tuning { speed: 0–15, brake: 0–15 } (CU-Stufen; fehlt = nicht festgelegt),
//                    imageRev (eigenes Bild hochgeladen), practiceLaps (Runden außerhalb gewerteter Rennen)
//   tracks/{id}    + lengthOuterM, lengthInnerM, refLapMs, minLapMs (kürzere Runden werden ignoriert), imageRev
//   settings/race  { fullTankLaps, refuelPctPerSec, falseStartPenaltySec, penaltyOptionsSec[], pitCallFuelPct, fuelSpeedFactor, emptyTankSpeed, pitDriveMs }
//   media/{key}    { data (Data-URL), type, bytes, updatedAt } – Bilder/Töne getrennt von den Stammdaten,
//                  key: car_<id> | driver_voice_<id> | track_<id>
(function () {
  // Controller werden immer über ihre Farbe benannt (Nummer = CU-Adresse 1–6)
  const CONTROLLERS = [
    { n: 1, name: 'Gelb',    color: '#FFFF66', text: '#1D1D1F' },
    { n: 2, name: 'Rot',     color: '#FF3333', text: '#FFFFFF' },
    { n: 3, name: 'Blau',    color: '#6666FF', text: '#FFFFFF' },
    { n: 4, name: 'Grün',    color: '#00CC00', text: '#1D1D1F' },
    { n: 5, name: 'Schwarz', color: '#000000', text: '#FFFFFF' },
    { n: 6, name: 'Grau',    color: '#A0A0A0', text: '#1D1D1F' }
  ];
  const controller = n => CONTROLLERS.find(c => c.n === Number(n)) || null;

  // CU-Stufen 0–15 als Prozent (0 = 0 %, 15 = 100 %)
  const MAX_LEVEL = 15;
  const clampLevel = v => Math.max(0, Math.min(MAX_LEVEL, Math.round(Number(v) || 0)));
  const levelToPct = level => Math.round(clampLevel(level) / MAX_LEVEL * 100);

  const RACE_DEFAULTS = Object.freeze({
    fullTankLaps: 25,           // so viele Runden reicht ein voller Tank bei Referenztempo
    refuelPctPerSec: 10,        // Tanken: Prozent pro Sekunde in der Box
    falseStartPenaltySec: 5,    // Strafe für Fehlstart
    penaltyOptionsSec: [2, 5, 7, 10], // Auswahl im Strafendialog
    pitCallFuelPct: 20,         // „[Fahrer] muss an die Box“ ab diesem Tankstand
    emptyTankSpeed: 4,          // CU-Tempostufe (0–15), solange der Tank leer ist
    pitDriveMs: 2000,           // Fahrzeit durch die Boxengasse: so lange nach der Einfahrt wird weder Strafe abgesessen noch getankt
    fuelSpeedFactor: 1,         // 0 = Verbrauch unabhängig vom Tempo, 1 = proportional zum Tempo
    voice: 'ingrid'             // Sprachausgabe: 'ingrid' | 'leni' (siehe voice.js)
  });

  const TRACK_DEFAULTS = Object.freeze({
    refLapMs: null,
    minLapMs: null,
    lengthOuterM: null,
    lengthInnerM: null
  });

  const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback);

  /** Renneinstellungen mit Standardwerten auffüllen */
  function raceSettings (doc = {}) {
    const d = doc || {};
    const opts = Array.isArray(d.penaltyOptionsSec) && d.penaltyOptionsSec.length
      ? [...new Set(d.penaltyOptionsSec.map(Number).filter(v => v > 0))].sort((a, b) => a - b)
      : [...RACE_DEFAULTS.penaltyOptionsSec];
    return {
      fullTankLaps:         Math.max(1, Math.round(num(d.fullTankLaps, RACE_DEFAULTS.fullTankLaps))),
      refuelPctPerSec:      Math.max(0.1, num(d.refuelPctPerSec, RACE_DEFAULTS.refuelPctPerSec)),
      falseStartPenaltySec: Math.max(0, num(d.falseStartPenaltySec, RACE_DEFAULTS.falseStartPenaltySec)),
      penaltyOptionsSec:    opts.length ? opts : [...RACE_DEFAULTS.penaltyOptionsSec],
      pitCallFuelPct:       Math.max(0, Math.min(100, num(d.pitCallFuelPct, RACE_DEFAULTS.pitCallFuelPct))),
      fuelSpeedFactor:      Math.max(0, Math.min(3, num(d.fuelSpeedFactor, RACE_DEFAULTS.fuelSpeedFactor))),
      emptyTankSpeed:       clampLevel(num(d.emptyTankSpeed, RACE_DEFAULTS.emptyTankSpeed)),
      pitDriveMs:           Math.max(0, Math.min(30000, Math.round(num(d.pitDriveMs, RACE_DEFAULTS.pitDriveMs)))),
      voice:                ['ingrid', 'leni'].includes(d.voice) ? d.voice : RACE_DEFAULTS.voice
    };
  }

  /** Strecken-Werte mit Standardwerten auffüllen */
  function trackSetup (track = {}) {
    const t = track || {};
    return {
      refLapMs:     num(t.refLapMs, null) > 0 ? Number(t.refLapMs) : null,
      minLapMs:     num(t.minLapMs, null) > 0 ? Number(t.minLapMs) : null,
      lengthOuterM: num(t.lengthOuterM, null),
      lengthInnerM: num(t.lengthInnerM, null)
    };
  }

  /**
   * Spritverbrauch einer Runde in Prozent des vollen Tanks.
   * Grundverbrauch = 100 / fullTankLaps (Renneinstellungen). Wer schneller als die Referenzrunde fährt,
   * verbraucht mehr, wer langsamer ist, weniger: × (Referenz / Rundenzeit) ^ fuelSpeedFactor.
   * Das Verhältnis wird auf 0,5–2 begrenzt (Ausreißer wie abgeflogene Runden).
   */
  function fuelPerLap (lapMs, track, settings) {
    const t = trackSetup(track);
    const s = raceSettings(settings);
    const base = 100 / s.fullTankLaps;
    if (!t.refLapMs || !(lapMs > 0) || s.fuelSpeedFactor === 0) return base;
    const ratio = Math.max(0.5, Math.min(2, t.refLapMs / lapMs));
    return base * Math.pow(ratio, s.fuelSpeedFactor);
  }

  /** Wie viele Runden reicht ein voller Tank bei dieser Rundenzeit? */
  const lapsPerTank = (lapMs, track, settings) => 100 / fuelPerLap(lapMs, track, settings);

  /**
   * Controller-Vorschlag für ein Rennen.
   * entries: [{ driverId, carId }] in Startreihenfolge, drivers: Fahrer mit preferredController.
   * 1. Wer einen bevorzugten Controller hat, bekommt ihn – bei mehreren Fahrern mit gleichem
   *    Wunsch der zuerst genannte. 2. Alle anderen werden mit den freien Controllern (1, 2, 3 …) aufgefüllt.
   * Liefert [{ ...entry, controller, preferred: true|false }] in Eingabereihenfolge
   * und conflicts: [{ controller, driverIds }] für die Anzeige.
   */
  function suggestControllers (entries = [], drivers = []) {
    const pref = new Map(drivers.map(d => [d.id, controller(d.preferredController)?.n ?? null]));
    const taken = new Map();
    const out = entries.map(e => ({ ...e, controller: null, preferred: false }));
    const wanted = new Map();
    out.forEach(e => {
      const p = pref.get(e.driverId);
      if (!p) return;
      if (!wanted.has(p)) wanted.set(p, []);
      wanted.get(p).push(e.driverId);
      if (!taken.has(p)) { taken.set(p, e.driverId); e.controller = p; e.preferred = true; }
    });
    const free = CONTROLLERS.map(c => c.n).filter(n => !taken.has(n));
    out.forEach(e => { if (e.controller == null) e.controller = free.shift() ?? null; });
    const conflicts = [...wanted].filter(([, ids]) => ids.length > 1).map(([n, driverIds]) => ({ controller: n, driverIds }));
    return { assignments: out, conflicts };
  }

  /**
   * Zählt eine Start/Ziel-Durchfahrt als Runde? Zeiten unter der Mindest-Rundenzeit der Strecke
   * (z. B. nach einer Unterbrechung nahe Start/Ziel) werden ignoriert – keine falschen Rekorde.
   */
  const isValidLap = (lapMs, track) => lapMs > 0 && lapMs >= (trackSetup(track).minLapMs || 0);

  /**
   * Sprit-Plan für ein Rennen (Start mit vollem Tank, getankt wird nur so viel wie nötig).
   * Liefert Spritbedarf gesamt (%), Runden pro Tank, nötige Boxenstopps und reine Tankzeit (s).
   */
  function raceFuelPlan (laps, lapMs, track, settings) {
    const s = raceSettings(settings);
    const per = fuelPerLap(lapMs, track, settings);
    const fuelPct = per * laps;
    const refill = Math.max(0, fuelPct - 100);
    const stops = refill > 1e-9 ? Math.ceil(refill / 100 - 1e-9) : 0;
    return { fuelPct, lapsPerTank: 100 / per, stops, refuelSec: refill / s.refuelPctPerSec };
  }

  /** Runden und Rennen eines Fahrzeugs über alle Saisons (aus den gewerteten Rennen + Training) */
  function carTotals (carId, races = [], car = {}) {
    let racesCount = 0, laps = 0;
    for (const r of races) {
      if ((r.results || []).some(res => res.carId === carId)) { racesCount++; laps += r.rounds || 0; }
    }
    return { races: racesCount, raceLaps: laps, practiceLaps: car.practiceLaps || 0, laps: laps + (car.practiceLaps || 0) };
  }

  // Rundenzeit „17,345“ / „17.345“ (Sekunden) → Millisekunden
  function parseLapTime (text) {
    const v = parseFloat(String(text ?? '').trim().replace(',', '.'));
    return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : null;
  }
  const formatLapTime = ms => (ms > 0 ? (ms / 1000).toFixed(3).replace('.', ',') : '');

  window.MasterData = {
    CONTROLLERS, controller, MAX_LEVEL, clampLevel, levelToPct,
    RACE_DEFAULTS, TRACK_DEFAULTS, raceSettings, trackSetup,
    fuelPerLap, lapsPerTank, raceFuelPlan, isValidLap, suggestControllers, carTotals,
    parseLapTime, formatLapTime
  };
})();
