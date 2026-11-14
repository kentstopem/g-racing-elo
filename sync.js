// sync.js – hält die abgeleiteten Werte auf allen Geräten konsistent.
//
// Grundidee: Die Rennen sind die einzige „Wahrheit“. G!RP, Rennen, Siege, Runden der
// Fahrer/Fahrzeuge (pro Saison) werden im Browser daraus berechnet. Die Vorher/Nachher-
// Werte in den gespeicherten Rennergebnissen hält dieses Modul aktuell (Elo.recomputeSeasons).
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

  let timer = null;
  let running = false;
  let again = false;

  const same = (a, b) => (a ?? null) === (b ?? null) || ((a ?? 0) === (b ?? 0) && typeof (a ?? 0) === 'number');

  function resultsEqual (stored = [], calc = []) {
    if (stored.length !== calc.length) return false;
    const s = [...stored].sort((a, b) => a.position - b.position);
    return s.every((res, i) => RESULT_FIELDS.every(f => same(res[f], calc[i][f])));
  }

  // Vergleicht die gespeicherten Rennergebnisse mit der Neuberechnung (pro Saison)
  function computeDiff () {
    const data = window.appData;
    const races = data.allRaces || data.races;
    const calc = structuredClone({ drivers: data.drivers, cars: data.cars, races });
    const seasonOf = window.Seasons ? window.Seasons.seasonOfRace : undefined;
    window.Elo.recomputeSeasons(calc, seasonOf);
    const stored = new Map(races.map(r => [r.id, r]));
    return { races: calc.races.filter(r => !resultsEqual(stored.get(r.id).results, r.results)) };
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
      count = diff.races.length;
      if (count > 0) {
        console.info(`Sync: korrigiere ${count} Rennen`);
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
