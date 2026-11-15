// storage.js – zentrale Datenzugriffe auf Firestore
// Erwartet, dass firebase.js geladen ist und die globale Variable `firebase` existiert.
//
// Synchronisation zwischen Geräten:
// • subscribe() hält Fahrer, Fahrzeuge, Rennen und Rekorde per Live-Listener aktuell.
// • Geschrieben werden nur einzelne Felder (update), nie ganze Dokumente aus einem
//   evtl. veralteten Gerätestand. G!RP/Rennen/Siege der Fahrer und Fahrzeuge werden ab
//   Version 2.1 nur noch im Browser aus den Rennen berechnet (pro Saison); die Werte in
//   den Rennergebnissen hält sync.js aktuell.

(function () {
  const db = firebase.firestore();

  const driversCol = db.collection('drivers');
  const carsCol    = db.collection('cars');
  const racesCol   = db.collection('races');
  const recordsCol = db.collection('lapRecords');
  const seasonsCol = db.collection('seasons');
  const tracksCol  = db.collection('tracks');
  const ALL_COLLECTIONS = { drivers: driversCol, cars: carsCol, races: racesCol, lapRecords: recordsCol, seasons: seasonsCol, tracks: tracksCol };


  function docsToArray (snap) {
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  // Schreibvorgänge in Blöcken (Firestore erlaubt max. 500 pro Batch)
  async function commitInChunks (ops) {
    const CHUNK = 400;
    for (let i = 0; i < ops.length; i += CHUNK) {
      const batch = db.batch();
      ops.slice(i, i + CHUNK).forEach(fn => fn(batch));
      await batch.commit();
    }
  }

  const Storage = {
    /**
     * Live-Listener auf alle Collections.
     * onChange({ drivers, cars, races, lapRecords }, info) wird bei jeder Änderung aufgerufen.
     * info.fromCache: Daten stammen (noch) aus dem Offline-Cache
     * info.remote:    Änderung kam von einem anderen Gerät (nicht von eigenen Schreibvorgängen)
     * Liefert ein Promise, das nach dem ersten vollständigen Datenstand erfüllt ist.
     */
    subscribe (onChange) {
      const state = { drivers: null, cars: null, races: null, lapRecords: [], seasons: null, tracks: null };
      const meta  = { drivers: true, cars: true, races: true, seasons: true, tracks: true };
      const serverSynced = {};
      let resolveReady;
      const ready = new Promise(res => { resolveReady = res; });
      let firstDone = false;

      const listen = (key, query) => query.onSnapshot({ includeMetadataChanges: true }, snap => {
        // Echte Datenänderung ohne eigene ausstehende Schreibvorgänge ⇒ kam von einem anderen Gerät.
        // (Reine Metadaten-Änderungen wie „Schreibvorgang bestätigt“ zählen nicht.)
        // Erst ab dem zweiten Server-Stand je Collection (der erste ist nur das Nachladen beim Start).
        const remote = serverSynced[key] && !snap.metadata.hasPendingWrites && snap.docChanges({ includeMetadataChanges: false }).length > 0;
        if (!snap.metadata.fromCache) serverSynced[key] = true;
        state[key] = docsToArray(snap);
        if (key in meta) meta[key] = snap.metadata.fromCache;
        if (state.drivers && state.cars && state.races && state.seasons && state.tracks) {
          const info = { fromCache: Object.values(meta).some(Boolean), remote, collection: key };
          onChange(state, info);
          if (!firstDone) { firstDone = true; resolveReady(); }
        }
      }, err => {
        console.error(`Listener ${key}:`, err);
        if (!firstDone) { firstDone = true; resolveReady(); }
      });

      listen('drivers', driversCol);
      listen('cars', carsCol);
      listen('races', racesCol.orderBy('id', 'desc'));
      listen('lapRecords', recordsCol);
      listen('seasons', seasonsCol);
      listen('tracks', tracksCol);
      return ready;
    },

    // Abgeleitete Werte in den Rennergebnissen schreiben (nur abweichende Rennen)
    async writeDerived ({ races = [] }) {
      await commitInChunks(races.map(r => b => b.update(racesCol.doc(String(r.id)), { results: r.results })));
    },

    // Neues Rennen speichern (G!RP der Fahrer/Fahrzeuge wird aus den Rennen berechnet)
    saveRace (race) {
      return racesCol.doc(String(race.id)).set(race);
    },

    // Einzelne Felder ändern (z. B. archived, hideFromRanking) – überschreibt keine anderen Felder
    updateDriverFields : (id, fields) => driversCol.doc(String(id)).update(fields),
    updateCarFields    : (id, fields) => carsCol.doc(String(id)).update(fields),

    // Saisons / Strecken
    addSeason      : (s) => seasonsCol.doc(String(s.id)).set(s),
    addTrack       : (t) => tracksCol.doc(String(t.id)).set(t),

    /**
     * Ersteinrichtung der Saisons in einem Rutsch: Strecke + Saison anlegen und
     * Feld-Änderungen (z. B. Namen ohne Krone) an Fahrern/Rennen schreiben.
     */
    async setupSeasons ({ track, season, driverUpdates = [], raceUpdates = [] }) {
      const ops = [
        b => b.set(tracksCol.doc(String(track.id)), track),
        b => b.set(seasonsCol.doc(String(season.id)), season),
        ...driverUpdates.map(([id, fields]) => b => b.update(driversCol.doc(String(id)), fields)),
        ...raceUpdates.map(([id, fields])   => b => b.update(racesCol.doc(String(id)), fields))
      ];
      await commitInChunks(ops);
    },

    // Komplette Sicherung aller Collections direkt vom Server
    async exportAll () {
      const out = { exportedAt: new Date().toISOString(), project: 'g-racing-elo' };
      for (const [name, col] of Object.entries(ALL_COLLECTIONS)) {
        const snap = await col.get({ source: 'server' });
        out[name] = snap.docs.map(d => ({ _docId: d.id, ...d.data() }));
      }
      return out;
    },

    // Anlegen / Löschen
    addDriver      : (d) => driversCol.doc(String(d.id)).set(d),
    deleteDriver   : (id) => driversCol.doc(String(id)).delete(),
    addCar         : (c) => carsCol.doc(String(c.id)).set(c),
    deleteCar      : (id) => carsCol.doc(String(id)).delete(),
    deleteRace     : (id) => racesCol.doc(String(id)).delete()
  };

  // global verfügbar machen
  window.Storage = Storage;
})();
