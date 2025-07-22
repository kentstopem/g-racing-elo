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

    // Gesamten Zustand synchen (Schreiblast gering, aber einfach)
    async syncAll (appData) {
      const batch = db.batch();

      appData.drivers.forEach(d => batch.set(driversCol.doc(String(d.id)), d));
      appData.cars.forEach(c    => batch.set(carsCol.doc(String(c.id)), c));
      appData.races.forEach(r   => batch.set(racesCol.doc(String(r.id)), r));

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