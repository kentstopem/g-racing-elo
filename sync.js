// sync.js – hält die abgeleiteten Werte auf allen Geräten konsistent.
//
// Grundidee: Die Rennen sind die einzige „Wahrheit“. G!RP, Rennen, Siege, Runden der
// Fahrer/Fahrzeuge sowie die Vorher/Nachher-Werte in den Rennergebnissen lassen sich
// jederzeit deterministisch daraus berechnen (Elo.recomputeAll).
//
// Nach jeder Datenänderung (eigenes Gerät oder anderes Gerät) wird im Hintergrund neu
// berechnet und mit dem gespeicherten Stand verglichen. Weicht etwas ab – z. B. weil zwei
// Geräte gleichzeitig ein Rennen eingetragen haben oder ein Gerät mit veraltetem Stand
// gespeichert hat – schreibt ein eingeloggtes Gerät nur die abweichenden Felder zurück.
// Da alle Geräte aus denselben Rennen dasselbe Ergebnis berechnen, ist das konfliktfrei.

(function () {
  const RESULT_FIELDS = [
    'position', 'driverId', 'carId',
    'oldDriverElo', 'oldCarElo', 'newDriverElo', 'newCarElo',
    'driverEloChange', 'carEloChange',
    'positionOverallDriver', 'positionOverallCar'
  ];
  const ENTITY_FIELDS = ['elo', 'races', 'wins', 'totalRounds'];

  let timer = null;
  let running = false;
  let again = false;

  const same = (a, b) => (a ?? null) === (b ?? null) || ((a ?? 0) === (b ?? 0) && typeof (a ?? 0) === 'number');

  function resultsEqual (stored = [], calc = []) {
    if (stored.length !== calc.length) return false;
    const s = [...stored].sort((a, b) => a.position - b.position);
    return s.every((res, i) => RESULT_FIELDS.every(f => same(res[f], calc[i][f])));
  }

  function entityEqual (stored, calc) {
    return ENTITY_FIELDS.every(f => same(stored[f], calc[f]));
  }

  // Vergleicht gespeicherten Stand mit der Neuberechnung und liefert nur die Abweichungen
  function computeDiff () {
    const data = window.appData;
    const calc = structuredClone({ drivers: data.drivers, cars: data.cars, races: data.races });
    window.Elo.recomputeAll(calc);

    const byId = arr => new Map(arr.map(x => [x.id, x]));
    const sD = byId(data.drivers), sC = byId(data.cars), sR = byId(data.races);
    return {
      drivers: calc.drivers.filter(d => !entityEqual(sD.get(d.id), d)),
      cars:    calc.cars.filter(c => !entityEqual(sC.get(c.id), c)),
      races:   calc.races.filter(r => !resultsEqual(sR.get(r.id).results, r.results))
    };
  }

  /**
   * Abweichungen ermitteln und (nur als Admin) zurückschreiben.
   * @returns {Promise<number>} Anzahl korrigierter Dokumente
   */
  async function heal () {
    if (!window.isAdmin) return 0;
    if (running) { again = true; return 0; }
    running = true;
    let count = 0;
    try {
      const diff = computeDiff();
      count = diff.drivers.length + diff.cars.length + diff.races.length;
      if (count > 0) {
        console.info(`Sync: korrigiere ${diff.drivers.length} Fahrer, ${diff.cars.length} Fahrzeuge, ${diff.races.length} Rennen`);
        await window.Storage.writeDerived(diff);
      }
    } catch (err) {
      console.error('Sync-Fehler:', err);
      window.Helpers.showToast('⚠️ Synchronisierung fehlgeschlagen – Verbindung prüfen!');
    } finally {
      running = false;
      if (again) { again = false; schedule(); }
    }
    return count;
  }

  // Mehrere schnell aufeinanderfolgende Änderungen zusammenfassen
  function schedule (delay = 500) {
    clearTimeout(timer);
    timer = setTimeout(heal, delay);
  }

  window.Sync = { heal, schedule, computeDiff };
})();
