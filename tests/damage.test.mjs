// Schadenserfassung / Werkstatttagebuch: offene und kritische Schäden, Sperre, Statistik
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './load.mjs';

const app = loadApp(['helpers.js', 'masterdata.js', 'damage.js']);
const D = app.Damage;

test('Schadensarten: Licht nicht kritisch, Motor und Sensor kritisch, Sonstige frei', () => {
  assert.equal(D.TYPES.length, 7);
  assert.equal(D.type('other').custom, true);
  assert.deepEqual([...D.TYPES.filter(t => t.critical).map(t => t.key)], ['motor', 'sensor']);
  assert.ok(D.TYPES.filter(t => t.category === 'light').every(t => !t.critical));
  assert.equal(D.typeLabel('light_rr'), 'Licht hinten rechts');
});

test('Licht-Schaden: offen, aber nicht gesperrt', () => {
  const car = { id: 1 };
  const { damages, entry } = D.addDamage(car, { type: 'light_fl', note: 'abgebrochen', context: 'Training', at: '2026-11-18T20:00:00Z' });
  assert.equal(car.damages, undefined, 'Original bleibt unverändert');
  assert.equal(entry.category, 'light');
  assert.equal(entry.fixedAt, null);
  const c = { ...car, damages };
  assert.equal(D.openDamages(c).length, 1);
  assert.equal(D.isLocked(c), false);
  assert.deepEqual({ ...D.summary(c), categories: [...D.summary(c).categories] }, { open: 1, critical: 0, categories: ['light'], locked: false });
});

test('Kritischer Schaden sperrt bis zur Reparatur; archived bleibt unberührt', () => {
  const car = { id: 2, archived: false, hideFromRanking: false };
  let { damages, entry } = D.addDamage(car, { type: 'motor' });
  const c = { ...car, damages };
  assert.equal(D.isLocked(c), true);
  damages = D.fixDamage(c, entry.id, { at: '2026-11-19T10:00:00Z', note: 'neuer Motor', lapsAtFix: 120 });
  const fixed = { ...c, damages };
  assert.equal(D.isLocked(fixed), false);
  assert.equal(fixed.archived, false);
  assert.equal(fixed.damages[0].fixNote, 'neuer Motor');
  assert.equal(fixed.damages[0].lapsAtFix, 120);
});

test('Gleiche Schadensart wird nicht doppelt offen eingetragen, nach Reparatur wieder möglich', () => {
  let car = { id: 3 };
  let r = D.addDamage(car, { type: 'sensor' }); car = { ...car, damages: r.damages };
  r = D.addDamage(car, { type: 'sensor' });
  assert.equal(r.duplicate, true);
  assert.equal(r.damages.length, 1);
  car = { ...car, damages: D.fixDamage(car, car.damages[0].id) };
  r = D.addDamage(car, { type: 'sensor' });
  assert.equal(r.duplicate, false);
  assert.equal(r.damages.length, 2);
});

test('Unbekannte Schadensart wirft', () => {
  assert.throws(() => D.addDamage({}, { type: 'reifen' }));
});

test('Filter nach Kategorie nur für offene Schäden', () => {
  let car = { id: 4 };
  car = { ...car, damages: D.addDamage(car, { type: 'light_rl' }).damages };
  car = { ...car, damages: D.addDamage(car, { type: 'motor' }).damages };
  const motor = car.damages.find(d => d.type === 'motor');
  assert.ok(D.hasOpenCategory(car, 'motor'));
  assert.ok(D.hasOpenCategory(car, 'light'));
  assert.ok(!D.hasOpenCategory(car, 'sensor'));
  assert.ok(D.hasOpenCategory(car, 'all'));
  car = { ...car, damages: D.fixDamage(car, motor.id) };
  assert.ok(!D.hasOpenCategory(car, 'motor'));
});

test('Werkstatttagebuch: neueste zuerst, Löschen entfernt Eintrag', () => {
  let car = { id: 5 };
  car = { ...car, damages: D.addDamage(car, { type: 'light_fl', at: '2026-01-01T10:00:00Z' }).damages };
  car = { ...car, damages: D.addDamage(car, { type: 'motor', at: '2026-03-01T10:00:00Z' }).damages };
  assert.deepEqual([...D.journal(car).map(d => d.type)], ['motor', 'light_fl']);
  const del = D.removeDamage(car, car.damages[0].id);
  assert.deepEqual([...del.map(d => d.type)], ['motor']);
});

test('Statistik: Reparaturen, Runden seit Reparatur (lapsAtFix), Schäden pro 100 Runden', () => {
  let car = { id: 6 };
  car = { ...car, damages: D.addDamage(car, { type: 'motor', at: '2026-01-01T10:00:00Z' }).damages };
  car = { ...car, damages: D.fixDamage(car, car.damages[0].id, { at: '2026-01-02T10:00:00Z', lapsAtFix: 150 }) };
  car = { ...car, damages: D.addDamage(car, { type: 'light_fl', at: '2026-01-03T10:00:00Z' }).damages };
  const st = D.stats(car, { totalLaps: 200 });
  assert.equal(st.damages, 2);
  assert.equal(st.repairs, 1);
  assert.equal(st.open, 1);
  assert.equal(st.lapsSinceRepair, 50);
  assert.equal(st.per100Laps, 1);
});

test('Statistik ohne lapsAtFix: Runden der Rennen nach der Reparatur', () => {
  const car = { id: 11, damages: [{ id: 'x', type: 'sensor', category: 'sensor', critical: true, at: '2026-01-01T08:00:00', fixedAt: '2026-01-01T21:00:00' }] };
  const races = [
    { id: 1, date: '01.01.2026', time: '20:00', rounds: 60, results: [{ carId: 11 }] },
    { id: 2, date: '02.01.2026', time: '19:00', rounds: 75, results: [{ carId: 11 }] },
    { id: 3, date: '05.01.2026', time: '21:00', rounds: 20, results: [{ carId: 12 }] }
  ];
  const st = D.stats(car, { totalLaps: 135, races, tsForRace: app.Helpers.tsForRace });
  assert.equal(st.lapsSinceRepair, 75);
});

test('Ohne Reparatur: Runden seit Reparatur unbekannt, ohne Runden keine Quote', () => {
  const st = D.stats({ id: 7 }, { totalLaps: 0 });
  assert.equal(st.lapsSinceRepair, null);
  assert.equal(st.per100Laps, null);
  assert.equal(st.repairs, 0);
});

test('Sonstige: Beschreibung Pflicht, kritisch per Schalter', () => {
  assert.throws(() => D.addDamage({ id: 8 }, { type: 'other', note: '  ' }));
  const harmlos = D.addDamage({ id: 8 }, { type: 'other', note: 'Aufkleber ab' });
  assert.equal(harmlos.entry.category, 'other');
  assert.equal(harmlos.entry.critical, false);
  assert.equal(D.isLocked({ damages: harmlos.damages }), false);
  assert.equal(D.entryLabel(harmlos.entry), 'Sonstige: Aufkleber ab');
  const krit = D.addDamage({ damages: harmlos.damages }, { type: 'other', note: 'Achse verbogen', critical: true });
  assert.equal(krit.duplicate, false, 'andere Beschreibung → eigener Eintrag');
  const car = { damages: krit.damages };
  assert.equal(D.isLocked(car), true);
  assert.ok(D.hasOpenCategory(car, 'other'));
  assert.equal(D.categoryLabel('other'), 'Sonstige');
  assert.equal(D.addDamage(car, { type: 'other', note: 'Achse verbogen' }).duplicate, true);
  const fixed = { damages: D.fixDamage(car, krit.entry.id) };
  assert.equal(D.isLocked(fixed), false);
});

test('Kritisch-Schalter gilt nur für Sonstige', () => {
  const r = D.addDamage({}, { type: 'light_fl', critical: true });
  assert.equal(r.entry.critical, false);
});

test('Rennen mit Autotausch (carLaps): Runden je Fahrzeug; alte Rennen ohne carLaps → Renndistanz fürs gewertete Auto', () => {
  const M = app.MasterData;
  const races = [
    { id: 1, date: '01.01.2026', time: '20:00', rounds: 60, results: [{ driverId: 1, carId: 11 }, { driverId: 2, carId: 12 }] },
    // Fahrer 1 hat nach 20 Runden von Auto 11 auf Auto 13 gewechselt und ist damit ins Ziel gefahren
    { id: 2, date: '02.01.2026', time: '19:00', rounds: 50, results: [{ driverId: 1, carId: 13, carLaps: [{ carId: 11, laps: 20 }, { carId: 13, laps: 30 }] }, { driverId: 2, carId: 12 }] }
  ];
  assert.equal(M.raceCarLaps(races[1], 11), 20);
  assert.equal(M.raceCarLaps(races[1], 13), 30);
  assert.equal(M.raceCarLaps(races[1], 12), 50);
  assert.equal(M.raceCarLaps(races[1], 14), null);
  assert.deepEqual({ ...M.carTotals(11, races, { practiceLaps: 5 }) }, { races: 2, raceLaps: 80, practiceLaps: 5, laps: 85 });
  assert.deepEqual({ ...M.carTotals(13, races) }, { races: 1, raceLaps: 30, practiceLaps: 0, laps: 30 });
  // Reparatur an Auto 11 nach Rennen 1, ohne lapsAtFix: nur die 20 Runden aus Rennen 2 zählen
  const car = { id: 11, damages: [{ id: 'x', type: 'motor', category: 'motor', critical: true, at: '2026-01-01T08:00:00', fixedAt: '2026-01-01T21:00:00' }] };
  const st = D.stats(car, { totalLaps: 80, races, tsForRace: app.Helpers.tsForRace });
  assert.equal(st.lapsSinceRepair, 20);
  assert.equal(st.per100Laps, 1 / 80 * 100);
});

test('Elo: Fahrzeug-Runden (totalRounds) nach Autotausch je Auto, Wertung bleibt beim Auto im Ziel', () => {
  const E = loadApp(['helpers.js', 'elo.js']).Elo;
  const drivers = [{ id: 1, elo: 1000 }, { id: 2, elo: 1000 }];
  const cars = [11, 12, 13].map(id => ({ id, elo: 1000 }));
  E.applyRace({ rounds: 50, results: [{ position: 1, driverId: 1, carId: 13, carLaps: [{ carId: 11, laps: 20 }, { carId: 13, laps: 30 }] }, { position: 2, driverId: 2, carId: 12 }] }, drivers, cars);
  const by = id => cars.find(c => c.id === id);
  assert.equal(by(11).totalRounds, 20);
  assert.equal(by(13).totalRounds, 30);
  assert.equal(by(12).totalRounds, 50);
  assert.equal(by(13).races, 1); assert.equal(by(13).wins, 1);
  assert.equal(by(11).races, undefined, 'nur das Auto im Ziel bekommt Rennen/Sieg/G!RP');
  assert.equal(drivers[0].totalRounds, 50);
});

test('Ersatzauto-Vorschlag: genau ein Auto, G!RP am nächsten am beschädigten', () => {
  const crit = [{ id: 'x', type: 'motor', category: 'motor', critical: true, fixedAt: null }];
  const damaged = { id: 1, name: '(01) Kaputt', elo: 1050, damages: crit };
  const cars = [
    damaged,
    { id: 2, name: '(02) Weit weg', elo: 900 },
    { id: 3, name: '(03) Nah, aber vergeben', elo: 1049 },
    { id: 4, name: '(04) Nah, aber gesperrt', elo: 1051, damages: crit },
    { id: 5, name: '(05) Nah, aber inaktiv', elo: 1050, hideFromRanking: true },
    { id: 6, name: '(06) Nah, archiviert', elo: 1050, archived: true },
    { id: 7, name: '(07) Licht kaputt, fährt', elo: 1062, damages: [{ id: 'l', type: 'light_fl', category: 'light', critical: false, fixedAt: null }] },
    { id: 8, name: '(08) Unter', elo: 1035 }
  ];
  const s = D.suggestReplacement(damaged, cars, { exclude: [3] });
  assert.equal(s.id, 7, 'nicht kritischer Schaden sperrt nicht; |1062-1050| < |1035-1050|');
  assert.equal(D.suggestReplacement(damaged, cars, { exclude: [3, 7] }).id, 8);
  assert.equal(D.suggestReplacement(damaged, cars, { exclude: [3, 7, 8] }).id, 2);
  assert.equal(D.suggestReplacement(damaged, [damaged, cars[3]]), null, 'kein freies Auto → null');
});

test('Ersatzauto-Vorschlag: Gleichstand deterministisch (weniger Rennen, dann Name)', () => {
  const damaged = { id: 1, elo: 1000 };
  const cars = [
    { id: 2, name: 'B', elo: 1010, races: 5 },
    { id: 3, name: 'C', elo: 990, races: 2 },
    { id: 4, name: 'A', elo: 990, races: 2 }
  ];
  assert.equal(D.suggestReplacement(damaged, cars).id, 4);
  assert.equal(D.suggestReplacement(damaged, [...cars].reverse()).id, 4, 'Reihenfolge der Liste egal');
  assert.equal(D.suggestReplacement({ id: 9 }, [{ id: 2, name: 'x', elo: 1003 }, { id: 3, name: 'y', elo: 1100 }]).id, 2, 'ohne G!RP gilt 1000');
});
