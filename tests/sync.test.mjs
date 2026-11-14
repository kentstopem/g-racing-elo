import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, sampleData } from './load.mjs';

// Objekte aus dem VM-Kontext haben eigene Prototypen → vor dem Vergleich normalisieren
const plain = v => JSON.parse(JSON.stringify(v));
const same = (a, b) => assert.deepStrictEqual(plain(a), plain(b));

// Ab Version 2.1 schreibt die Synchronisation nur noch Rennergebnisse (Vorher/Nachher-Werte).
// G!RP der Fahrer/Fahrzeuge wird im Browser aus den Rennen berechnet.
function setup ({ admin = true } = {}) {
  const W = loadApp();
  const data = sampleData();
  W.Elo.recomputeAll(data);
  W.appData = data;
  W.isAdmin = admin;
  W.writes = [];
  W.Storage = {
    async writeDerived ({ races }) {
      W.writes.push(races.map(r => r.id));
      races.forEach(r => { data.races.find(x => x.id === r.id).results = r.results; });
    }
  };
  return W;
}

test('Konsistenter Stand: keine Korrektur nötig', async () => {
  const W = setup();
  assert.equal(await W.Sync.heal(), 0);
  assert.equal(W.writes.length, 0);
});

test('Falsch gespeichertes Ergebnis wird repariert und bleibt danach stabil', async () => {
  const W = setup();
  W.appData.races.find(r => r.id === 101).results[0].newDriverElo = 1;
  assert.equal(await W.Sync.heal(), 1);
  same(W.writes[0], [101]);
  assert.equal(await W.Sync.heal(), 0);
});

test('Gleichzeitig auf zwei Geräten eingetragene Rennen werden korrekt zusammengeführt', async () => {
  const W = setup();
  const copies = [structuredClone(W.appData), structuredClone(W.appData)];
  const newRaces = [
    { id: 200, date: '10.01.2026', time: '20:00', rounds: 60, results: [{ position: 1, driverId: 1, carId: 11 }, { position: 2, driverId: 2, carId: 12 }] },
    { id: 201, date: '10.01.2026', time: '20:00', rounds: 60, results: [{ position: 1, driverId: 3, carId: 13 }, { position: 2, driverId: 1, carId: 14 }] }
  ];
  // Beide Geräte rechnen auf demselben (alten) Stand
  newRaces.forEach((race, i) => { W.Elo.applyRace(race, copies[i].drivers, copies[i].cars); W.appData.races.unshift(race); });
  const before = newRaces[1].results.find(r => r.driverId === 1).oldDriverElo;
  await W.Sync.heal();
  // Rennen 201 kommt nach 200 → Fahrer 1 startet dort mit dem Wert nach Rennen 200
  const after200 = W.appData.races.find(r => r.id === 200).results.find(r => r.driverId === 1).newDriverElo;
  assert.equal(W.appData.races.find(r => r.id === 201).results.find(r => r.driverId === 1).oldDriverElo, after200);
  assert.notEqual(before, after200);
  // Berechnete Rennanzahl zählt beide Rennen
  const calc = structuredClone(W.appData); W.Elo.recomputeAll(calc);
  assert.equal(calc.drivers.find(d => d.id === 1).races, 5);
  assert.equal(await W.Sync.heal(), 0);
});

test('Gelöschtes Rennen: alle späteren Ergebnisse werden neu berechnet', async () => {
  const W = setup();
  W.appData.races = W.appData.races.filter(r => r.id !== 100);
  const n = await W.Sync.heal();
  assert.ok(n > 0);
  const expected = sampleData();
  expected.races = expected.races.filter(r => r.id !== 100);
  W.Elo.recomputeAll(expected);
  same(W.appData.races.map(r => r.results), expected.races.map(r => r.results));
});

test('Ohne Login wird nichts geschrieben', async () => {
  const W = setup({ admin: false });
  W.appData.races[0].results[0].newDriverElo = 1;
  assert.equal(await W.Sync.heal(), 0);
  assert.equal(W.writes.length, 0);
});
