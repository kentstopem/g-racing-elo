import { test } from 'node:test';
import assert from 'node:assert/strict';

// Objekte aus dem VM-Kontext haben eigene Prototypen → vor dem Vergleich normalisieren
const plain = v => JSON.parse(JSON.stringify(v));
const same = (a, b) => assert.deepStrictEqual(plain(a), plain(b));
import { loadApp, sampleData } from './load.mjs';

const W = loadApp();
const { Elo, Helpers } = W;

test('K-Faktor: Runden- und Spielergewichtung mit Grenzen', () => {
  assert.equal(Elo.calculateKFactor(2, 20), 8);    // 32 · 0.5 · 0.5
  assert.equal(Elo.calculateKFactor(6, 75), 32);   // volle Gewichtung
  assert.equal(Elo.calculateKFactor(10, 999), 32); // gedeckelt
  assert.equal(Elo.calculateKFactor(2, 1), 8);     // Untergrenze
});

test('Erwartungswert: Gleichstarke = 0.5, Summe zweier Gegner = 1', () => {
  assert.equal(Elo.calculateExpectedScore(1000, [1000, 1000]), 0.5);
  const a = Elo.calculateExpectedScore(1100, [900]);
  const b = Elo.calculateExpectedScore(900, [1100]);
  assert.ok(Math.abs(a + b - 1) < 1e-12);
});

test('Ist-Wert: Sieger 1, Letzter 0', () => {
  assert.equal(Elo.calculateActualScore(1, 4), 1);
  assert.equal(Elo.calculateActualScore(4, 4), 0);
});

test('applyRace nutzt die Werte VOR dem Rennen (Reihenfolge egal)', () => {
  const mk = () => {
    const d = [{ id: 1, elo: 1100 }, { id: 2, elo: 1000 }, { id: 3, elo: 900 }];
    const c = [{ id: 11, elo: 1000 }, { id: 12, elo: 1000 }, { id: 13, elo: 1000 }];
    return { d, c };
  };
  const a = mk(), b = mk();
  const resA = [{ position: 1, driverId: 3, carId: 11 }, { position: 2, driverId: 2, carId: 12 }, { position: 3, driverId: 1, carId: 13 }];
  const resB = [...resA].reverse().map(r => ({ ...r }));
  Elo.applyRace({ rounds: 60, results: resA }, a.d, a.c);
  Elo.applyRace({ rounds: 60, results: resB }, b.d, b.c);
  same(a.d.map(x => x.elo), b.d.map(x => x.elo));
  // alle Vorher-Werte stammen aus dem Snapshot
  const r1 = resA.find(r => r.driverId === 1);
  assert.equal(r1.oldDriverElo, 1100);
  assert.equal(r1.newDriverElo, 1100 + r1.driverEloChange);
});

test('applyRace: Siege, Rennen, Runden und Mindestwert 100', () => {
  const d = [{ id: 1, elo: 3000 }, { id: 2, elo: 100 }];
  const c = [{ id: 11, elo: 1000 }, { id: 12, elo: 1000 }];
  Elo.applyRace({ rounds: 50, results: [{ position: 1, driverId: 2, carId: 11 }, { position: 2, driverId: 1, carId: 12 }] }, d, c);
  assert.equal(d[1].wins, 1);
  assert.equal(c[0].wins, 1);
  assert.equal(d[0].races, 1);
  assert.equal(d[0].totalRounds, 50);
  const d2 = [{ id: 1, elo: 100 }, { id: 2, elo: 3000 }];
  Elo.applyRace({ rounds: 50, results: [{ position: 1, driverId: 2, carId: 11 }, { position: 2, driverId: 1, carId: 12 }] }, d2, c);
  assert.equal(d2[0].elo, 100); // nie unter 100
});

test('applyRace überspringt gelöschte Fahrer ohne Absturz', () => {
  const d = [{ id: 1, elo: 1000 }];
  const c = [{ id: 11, elo: 1000 }, { id: 12, elo: 1000 }];
  const results = [{ position: 1, driverId: 1, carId: 11 }, { position: 2, driverId: 99, carId: 12, oldDriverElo: 1200 }];
  assert.doesNotThrow(() => Elo.applyRace({ rounds: 60, results }, d, c));
  assert.ok(d[0].elo > 1000);
  assert.equal(results[1].newDriverElo, undefined);
});

test('recomputeAll ist deterministisch und unabhängig von der Speicherreihenfolge', () => {
  const a = sampleData();
  const b = sampleData();
  b.races.reverse();
  Elo.recomputeAll(a);
  Elo.recomputeAll(b);
  same(a.drivers.map(d => d.elo), b.drivers.map(d => d.elo));
  same(a.cars.map(c => c.elo), b.cars.map(c => c.elo));
  assert.equal(a.drivers.find(d => d.id === 1).races, 3);
  assert.equal(a.drivers.find(d => d.id === 1).totalRounds, 60 + 40 + 75);
});

test('recomputeAll: Rang ab dem ersten Rennen, Archivierte nie', () => {
  const data = sampleData();
  data.cars[0].archived = true;
  Elo.recomputeAll(data);
  const first = Elo.sortChronologically(data.races)[0];
  assert.ok(first.results.every(r => Number.isInteger(r.positionOverallDriver)));
  assert.equal(first.results.find(r => r.carId === 11).positionOverallCar, null);
  assert.ok(Number.isInteger(first.results.find(r => r.carId === 12).positionOverallCar));
});

test('recomputeSeasons: jede Saison startet bei 1000, Rennen bleiben getrennt', () => {
  const data = sampleData();
  const seasonOf = r => (r.id >= 102 ? 'S2' : 'S1');
  const per = Elo.recomputeSeasons(data, seasonOf);
  same([...per.keys()], ['S1', 'S2']);
  const r102 = data.races.find(r => r.id === 102);
  assert.ok(r102.results.every(res => res.oldDriverElo === 1000 && res.oldCarElo === 1000));
  const d1s1 = per.get('S1').drivers.find(d => d.id === 1);
  const d1s2 = per.get('S2').drivers.find(d => d.id === 1);
  assert.equal(d1s1.races, 2);
  assert.equal(d1s2.races, 1);
  // Saison 1 allein entspricht der Berechnung nur mit ihren Rennen
  const only1 = sampleData(); only1.races = only1.races.filter(r => r.id < 102);
  Elo.recomputeAll(only1);
  same(per.get('S1').drivers.map(d => d.elo), only1.drivers.map(d => d.elo));
});

test('Chronologie: gleiche Zeit wird nach Erfassungs-ID sortiert', () => {
  const races = [{ id: 2, date: '01.01.2026', time: '20:00' }, { id: 1, date: '01.01.2026', time: '20:00' }, { id: 3, date: '31.12.2025', time: '23:00' }];
  same(Elo.sortChronologically(races).map(r => r.id), [3, 1, 2]);
});

test('Helpers: Datum parsen und HTML escapen', () => {
  assert.ok(Helpers.tsForRace({ date: '02.01.2026', time: '10:00' }) > Helpers.tsForRace({ date: '01.01.2026', time: '23:59' }));
  assert.equal(Helpers.escapeHtml('<img src=x onerror="a">&'), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;');
});

test('Inaktive Fahrer/Fahrzeuge (Haken „aktiv“ aus) zählen nicht in der Gesamtrangliste', () => {
  const W = loadApp();
  const drivers = [{ id: 1, elo: 1100, races: 3 }, { id: 2, elo: 1050, races: 3, hideFromRanking: true }, { id: 3, elo: 1000, races: 3 }];
  const cars = [{ id: 11, elo: 1100, races: 3, hideFromRanking: true }, { id: 12, elo: 1000, races: 3 }];
  const race = { results: [{ driverId: 3, carId: 12 }, { driverId: 2, carId: 11 }] };
  W.Elo.storeOverallPositions(race, drivers, cars);
  assert.equal(race.results[0].positionOverallDriver, 2);
  assert.equal(race.results[0].positionOverallCar, 1);
  assert.equal(race.results[1].positionOverallDriver, null);
  assert.equal(race.results[1].positionOverallCar, null);
});

test('baseK: Rennen nutzt den gespeicherten K-Faktor, ältere ohne Feld 32', () => {

  assert.equal(Elo.calculateKFactor(6, 75), 32);
  assert.equal(Elo.calculateKFactor(6, 75, 40), 40);
  assert.equal(Elo.calculateKFactor(3, 3, 40), 15);
  const mk = () => ({ drivers: [{ id: 1, elo: 1000 }, { id: 2, elo: 1000 }], cars: [{ id: 1, elo: 1000 }, { id: 2, elo: 1000 }] });
  const race = baseK => ({ rounds: 75, baseK, results: [{ position: 1, driverId: 1, carId: 1 }, { position: 2, driverId: 2, carId: 2 }] });
  const a = mk(); assert.equal(Elo.applyRace(race(undefined), a.drivers, a.cars), 16);
  const b = mk(); assert.equal(Elo.applyRace(race(64), b.drivers, b.cars), 32);
});

test('Basis-Runden/-Fahrer: Standard 75/4 wie bisher, pro Rennen gespeichert', () => {
  assert.equal(Elo.calculateKFactor(4, 75), 32);              // bisher schon ab 4 Fahrern volle Gewichtung
  assert.equal(Elo.calculateKFactor(4, 75, 32, 75, 6), 24);   // Basis 6 Fahrer → 4 Fahrer = 0.75
  assert.equal(Elo.calculateKFactor(6, 50, 32, 50, 6), 32);   // Basis 50 Runden → 50 Runden voll
  assert.equal(Elo.calculateKFactor(6, 50, 32, 0, 0), Elo.calculateKFactor(6, 50)); // ungültig → Standard
  const mk = () => ({ drivers: [1, 2, 3, 4].map(id => ({ id, elo: 1000 })), cars: [1, 2, 3, 4].map(id => ({ id, elo: 1000 })) });
  const race = extra => ({ rounds: 75, baseK: 32, ...extra, results: [1, 2, 3, 4].map(p => ({ position: p, driverId: p, carId: p })) });
  const a = mk(); assert.equal(Elo.applyRace(race({}), a.drivers, a.cars), 32);
  const b = mk(); assert.equal(Elo.applyRace(race({ baseDrivers: 6 }), b.drivers, b.cars), 24);
});
