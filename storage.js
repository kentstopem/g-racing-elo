// storage.js – zentrale Datenzugriffe auf Firestore
// Erwartet, dass firebase.js geladen ist und die globale Variable `firebase` existiert.
//
// Synchronisation zwischen Geräten:
// • subscribe() hält Fahrer, Fahrzeuge, Rennen und Rekorde per Live-Listener aktuell.
// • Geschrieben werden nur einzelne Felder (update), nie ganze Dokumente aus einem
//   evtl. veralteten Gerätestand. Abgeleitete Werte (G!RP, Rennen, Siege …) repariert
//   sync.js automatisch aus der Renn-Historie.

(function () {
  const db = firebase.firestore();

  const driversCol = db.collection('drivers');
  const carsCol    = db.collection('cars');
  const racesCol   = db.collection('races');
  const recordsCol = db.collection('lapRecords');

  // Abgeleitete Felder (werden aus der Renn-Historie berechnet)
  const DERIVED_FIELDS = ['elo', 'races', 'wins', 'totalRounds'];

  function docsToArray (snap) {
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  function pick (obj, fields) {
    const out = {};
    fields.forEach(f => { out[f] = obj[f] ?? 0; });
    return out;
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
      const state = { drivers: null, cars: null, races: null, lapRecords: [] };
      const meta  = { drivers: true, cars: true, races: true };
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
        if (state.drivers && state.cars && state.races) {
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
      return ready;
    },

    // Abgeleitete Werte schreiben: nur die Felder, die sich wirklich unterscheiden
    async writeDerived ({ drivers = [], cars = [], races = [] }) {
      const ops = [
        ...drivers.map(d => b => b.update(driversCol.doc(String(d.id)), pick(d, DERIVED_FIELDS))),
        ...cars.map(c    => b => b.update(carsCol.doc(String(c.id)),    pick(c, DERIVED_FIELDS))),
        ...races.map(r   => b => b.update(racesCol.doc(String(r.id)),   { results: r.results }))
      ];
      await commitInChunks(ops);
    },

    // Neues Rennen + abgeleitete Werte der Teilnehmer gemeinsam (atomar) speichern
    saveRace (race, drivers, cars) {
      const batch = db.batch();
      batch.set(racesCol.doc(String(race.id)), race);
      drivers.forEach(d => batch.update(driversCol.doc(String(d.id)), pick(d, DERIVED_FIELDS)));
      cars.forEach(c    => batch.update(carsCol.doc(String(c.id)),    pick(c, DERIVED_FIELDS)));
      return batch.commit();
    },

    // Einzelne Felder ändern (z. B. archived, hideFromRanking) – überschreibt keine anderen Felder
    updateDriverFields : (id, fields) => driversCol.doc(String(id)).update(fields),
    updateCarFields    : (id, fields) => carsCol.doc(String(id)).update(fields),

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
