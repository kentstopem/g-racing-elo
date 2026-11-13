(function(){
  const BASE_K = 32;
  const START_ELO = 1000;
  const MIN_ELO = 100;
  const MIN_RACES_FOR_RANK = 5; // ab so vielen Rennen gilt ein Fahrer/Fahrzeug als „aktiv“

  function calculateExpectedScore(playerElo, opponentElos) {
    return opponentElos.reduce((acc, opponentElo) => acc + 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400)), 0) / opponentElos.length;
  }

  function calculateActualScore(position, totalPlayers) {
    return (totalPlayers - position) / (totalPlayers - 1);
  }

  function calculateKFactor(totalPlayers, rounds = 50) {
    // Rundengewichtung: 20 → 0.5  |  75 → 1.0 (max.)
    const roundWeight = Math.min(1, Math.max(0.5, 0.5 + ((rounds - 20) / 55) * 0.5));
    // Spielergewichtung: 2 → 0.5  |  6 → 1.0 (max.)
    const playerWeight = Math.min(1, Math.max(0.5, (totalPlayers - 2) / 4 + 0.5));
    return Math.round(BASE_K * roundWeight * playerWeight);
  }

  // Chronologische Reihenfolge der Rennen (Datum/Uhrzeit, bei Gleichstand nach Erfassungs-ID)
  function sortChronologically(races) {
    const ts = window.Helpers.tsForRace;
    return [...races].sort((a, b) => (ts(a) - ts(b)) || (a.id - b.id));
  }

  /**
   * Wendet ein Rennen auf die Fahrer/Fahrzeuge an (einzige Stelle, an der G!RP berechnet wird).
   * Maßstab ist die „Live-Methode“: Alle Erwartungswerte werden mit den Werten von VOR dem
   * Rennen berechnet, die Reihenfolge der Ergebnisse spielt also keine Rolle.
   *
   * Schreibt in jedes Ergebnis: oldDriverElo, oldCarElo, newDriverElo, newCarElo,
   * driverEloChange, carEloChange (und den alten Schlüssel eloChange).
   * Ergebnisse mit unbekanntem (gelöschtem) Fahrer oder Fahrzeug werden nicht verändert,
   * zählen aber mit ihrem zuletzt gespeicherten Wert als Gegner.
   *
   * @returns {number} der verwendete K-Faktor
   */
  function applyRace(race, drivers, cars) {
    const results = race.results || [];
    results.sort((a, b) => a.position - b.position);
    const total = results.length;
    const k = calculateKFactor(total, race.rounds);

    const driverOf = res => drivers.find(d => d.id === res.driverId);
    const carOf    = res => cars.find(c => c.id === res.carId);

    // Snapshot: Werte vor dem Rennen
    const before = results.map(res => {
      const d = driverOf(res), c = carOf(res);
      return {
        d, c,
        driverElo: d ? d.elo : (res.oldDriverElo ?? START_ELO),
        carElo:    c ? c.elo : (res.oldCarElo    ?? START_ELO)
      };
    });

    results.forEach((res, idx) => {
      const { d, c, driverElo, carElo } = before[idx];
      if (!(d && c)) return;
      const others = before.filter((_, i) => i !== idx);
      const actual = calculateActualScore(res.position, total);
      const dChange = Math.round(k * (actual - calculateExpectedScore(driverElo, others.map(o => o.driverElo))));
      const cChange = Math.round(k * (actual - calculateExpectedScore(carElo,    others.map(o => o.carElo))));

      d.elo = Math.max(MIN_ELO, driverElo + dChange);
      c.elo = Math.max(MIN_ELO, carElo + cChange);
      d.races = (d.races || 0) + 1;
      c.races = (c.races || 0) + 1;
      if (res.position === 1) {
        d.wins = (d.wins || 0) + 1;
        c.wins = (c.wins || 0) + 1;
      }
      d.totalRounds = (d.totalRounds || 0) + (race.rounds || 0);
      c.totalRounds = (c.totalRounds || 0) + (race.rounds || 0);

      res.oldDriverElo    = driverElo;
      res.oldCarElo       = carElo;
      res.newDriverElo    = d.elo;
      res.newCarElo       = c.elo;
      res.driverEloChange = dChange;
      res.carEloChange    = cChange;
      res.eloChange       = dChange; // Kompatibilität: alter Schlüssel
    });
    return k;
  }

  // Gesamtrang aller aktiven Fahrer/Fahrzeuge nach einem Rennen im Ergebnis festhalten
  function storeOverallPositions(race, drivers, cars) {
    const activeD = drivers.filter(d => d.races >= MIN_RACES_FOR_RANK && !d.archived).sort((a, b) => b.elo - a.elo);
    const activeC = cars.filter(c => c.races >= MIN_RACES_FOR_RANK && !c.hideFromRanking && !c.archived).sort((a, b) => b.elo - a.elo);
    const drvRank = new Map(activeD.map((d, i) => [d.id, i + 1]));
    const carRank = new Map(activeC.map((c, i) => [c.id, i + 1]));
    (race.results || []).forEach(res => {
      res.positionOverallDriver = drvRank.get(res.driverId) ?? null;
      res.positionOverallCar    = carRank.get(res.carId) ?? null;
    });
  }

  // Alle Werte von Grund auf aus der Renn-Historie neu berechnen
  function recomputeAll(data) {
    data.drivers.forEach(d => { d.elo = START_ELO; d.races = 0; d.wins = 0; d.totalRounds = 0; });
    data.cars.forEach(c    => { c.elo = START_ELO; c.races = 0; c.wins = 0; c.totalRounds = 0; });
    sortChronologically(data.races).forEach(race => {
      applyRace(race, data.drivers, data.cars);
      storeOverallPositions(race, data.drivers, data.cars);
    });
  }

  window.Elo = {
    START_ELO, MIN_RACES_FOR_RANK,
    calculateExpectedScore, calculateActualScore, calculateKFactor,
    sortChronologically, applyRace, storeOverallPositions, recomputeAll
  };
})();
