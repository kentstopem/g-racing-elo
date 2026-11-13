import { test } from 'node:test';
import assert from 'node:assert/strict';

// Objekte aus dem VM-Kontext haben eigene Prototypen → vor dem Vergleich normalisieren
const plain = v => JSON.parse(JSON.stringify(v));
const same = (a, b) => assert.deepStrictEqual(plain(a), plain(b));
import { loadApp, sampleData } from './load.mjs';

// Fake-Speicher: schreibt die Korrekturen so in appData, wie es der Live-Listener tun würde
function setup ({ admin = true } = {}) {
  const W = loadApp();
  const data = sampleData();
  W.Elo.recomputeAll(data);
  W.appData = data;
  W.isAdmin = admin;
  W.writes = [];
  W.Storage = {
    async writeDerived ({ drivers, cars, races }) {
      W.writes.push({ drivers: drivers.length, cars: cars.length, races: races.length });
      const pick = ({ elo, races, wins, totalRounds }) => ({ elo, races, wins, totalRounds });
      drivers.forEach(d => Object.assign(data.drivers.find(x => x.id === d.id), pick(d)));
      cars.forEach(c => Object.assign(data.cars.find(x => x.id === c.id), pick(c)));
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

test('Veralteter Gerätestand wird repariert und bleibt danach stabil', async () => {
  const W = setup();
  // Gerät mit altem Stand überschreibt Fahrer 1
  Object.assign(W.appData.drivers[0], { elo: 1234, races: 1 });
  const n = await W.Sync.heal();
  assert.equal(n, 1);
  same(W.writes[0], { drivers: 1, cars: 0, races: 0 });
  assert.equal(await W.Sync.heal(), 0); // konvergiert
});

test('Gleichzeitig auf zwei Geräten eingetragene Rennen werden korrekt zusammengeführt', async () => {
  const W = setup();
  const before = W.appData.drivers.find(d => d.id === 1).races;
  // Beide Geräte rechnen auf demselben (alten) Stand und speichern ihr Rennen + Teilnehmerwerte
  const copies = [structuredClone(W.appData), structuredClone(W.appData)];
  const newRaces = [
    { id: 200, date: '10.01.2026', time: '20:00', rounds: 60, results: [{ position: 1, driverId: 1, carId: 11 }, { position: 2, driverId: 2, carId: 12 }] },
    { id: 201, date: '10.01.2026', time: '20:00', rounds: 60, results: [{ position: 1, driverId: 3, carId: 13 }, { position: 2, driverId: 1, carId: 14 }] }
  ];
  newRaces.forEach((race, i) => {
    W.Elo.applyRace(race, copies[i].drivers, copies[i].cars);
    race.results.forEach(r => {
      Object.assign(W.appData.drivers.find(d => d.id === r.driverId), { races: copies[i].drivers.find(d => d.id === r.driverId).races });
    });
    W.appData.races.unshift(race);
  });
  assert.equal(W.appData.drivers.find(d => d.id === 1).races, before + 1); // last write wins → falsch
  await W.Sync.heal();
  assert.equal(W.appData.drivers.find(d => d.id === 1).races, before + 2);
  assert.equal(await W.Sync.heal(), 0);
});

test('Gelöschtes Rennen: alle späteren Werte werden neu berechnet', async () => {
  const W = setup();
  W.appData.races = W.appData.races.filter(r => r.id !== 100);
  const n = await W.Sync.heal();
  assert.ok(n > 0);
  const expected = sampleData();
  expected.races = expected.races.filter(r => r.id !== 100);
  W.Elo.recomputeAll(expected);
  same(W.appData.drivers.map(d => d.elo), expected.drivers.map(d => d.elo));
});

test('Ohne Login wird nichts geschrieben', async () => {
  const W = setup({ admin: false });
  W.appData.drivers[0].elo = 1;
  assert.equal(await W.Sync.heal(), 0);
  assert.equal(W.writes.length, 0);
});
