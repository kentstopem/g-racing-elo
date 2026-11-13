// storage.js – zentrale Datenzugriffe auf Firestore
// Erwartet, dass firebase.js geladen ist und die globale Variable `firebase` existiert.

(function () {
  const db = firebase.firestore();

  const driversCol = db.collection('drivers');
  const carsCol    = db.collection('cars');
  const racesCol   = db.collection('races');

  function docsToArray (snap) {
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  const Storage = {
    // Alle Collections gleichzeitig laden
    async fetchAll () {
      const [driversSnap, carsSnap, racesSnap] = await Promise.all([
        driversCol.get(),
        carsCol.get(),
        racesCol.orderBy('id', 'desc').get()
      ]);
      return {
        drivers: docsToArray(driversSnap),
        cars:    docsToArray(carsSnap),
        races:   docsToArray(racesSnap)
      };
    },

    // Gesamten Zustand synchen (nur für Neuberechnung/Löschen von Rennen).
    // Firestore erlaubt max. 500 Schreibvorgänge pro Batch → in Blöcken schreiben.
    async syncAll (appData) {
      const ops = [
        ...appData.drivers.map(d => [driversCol.doc(String(d.id)), d]),
        ...appData.cars.map(c    => [carsCol.doc(String(c.id)), c]),
        ...appData.races.map(r   => [racesCol.doc(String(r.id)), r])
      ];
      const CHUNK = 400;
      for (let i = 0; i < ops.length; i += CHUNK) {
        const batch = db.batch();
        ops.slice(i, i + CHUNK).forEach(([ref, data]) => batch.set(ref, data));
        await batch.commit();
      }
    },

    // Neues Rennen inkl. beteiligter Fahrer/Fahrzeuge in einem Rutsch (atomar) speichern
    saveRace (race, drivers, cars) {
      const batch = db.batch();
      batch.set(racesCol.doc(String(race.id)), race);
      drivers.forEach(d => batch.set(driversCol.doc(String(d.id)), d));
      cars.forEach(c    => batch.set(carsCol.doc(String(c.id)), c));
      return batch.commit();
    },

    // Einzel-CRUD – Fahrer
    addDriver      : (d) => driversCol.doc(String(d.id)).set(d),
    updateDriver   : (d) => driversCol.doc(String(d.id)).set(d),
    deleteDriver   : (id) => driversCol.doc(String(id)).delete(),

    // Einzel-CRUD – Fahrzeuge
    addCar         : (c) => carsCol.doc(String(c.id)).set(c),
    updateCar      : (c) => carsCol.doc(String(c.id)).set(c),
    deleteCar      : (id) => carsCol.doc(String(id)).delete(),

    // Einzel-CRUD – Rennen
    addRace        : (r) => racesCol.doc(String(r.id)).set(r),
    deleteRace     : (id) => racesCol.doc(String(id)).delete()
  };

  // global verfügbar machen
  window.Storage = Storage;
})(); 