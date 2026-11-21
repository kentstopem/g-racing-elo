import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './load.mjs';

const plain = v => JSON.parse(JSON.stringify(v));
const { MasterData: M } = loadApp(['helpers.js', 'masterdata.js']);

test('Controller heißen nach Farben', () => {
  assert.deepEqual(plain(M.CONTROLLERS.map(c => c.name)), ['Gelb', 'Rot', 'Blau', 'Grün', 'Schwarz', 'Grau']);
  assert.equal(M.controller(3).color, '#6666FF');
  assert.equal(M.controller(null), null);
  assert.equal(M.controller(7), null);
});

test('CU-Stufen 0–15 als Prozent', () => {
  assert.equal(M.levelToPct(0), 0);
  assert.equal(M.levelToPct(15), 100);
  assert.equal(M.levelToPct(8), 53);
  assert.equal(M.levelToPct(20), 100);
  assert.equal(M.clampLevel(-3), 0);
});

test('Renneinstellungen: Standardwerte und Bereinigung', () => {
  assert.deepEqual(plain(M.raceSettings()), { fullTankLaps: 25, refuelPctPerSec: 10, falseStartPenaltySec: 5, penaltyOptionsSec: [2, 5, 7, 10], pitCallFuelPct: 20, fuelCritPct: 5, fuelSpeedFactor: 1, emptyTankSpeed: 4, pitDriveMs: 2000, noSignalSec: 20, manualLapStartMs: 250, baseK: 32, voiceTailMs: 40, voiceGapMs: 250, voice: 'ingrid' });
  const s = M.raceSettings({ refuelPctPerSec: 12.5, penaltyOptionsSec: [10, 3, 3, 0], pitCallFuelPct: 150, falseStartPenaltySec: '' });
  assert.equal(s.refuelPctPerSec, 12.5);
  assert.deepEqual(plain(s.penaltyOptionsSec), [3, 10]);
  assert.equal(s.pitCallFuelPct, 100);
  assert.equal(s.falseStartPenaltySec, 5);
  assert.equal(M.raceSettings({ baseK: '40' }).baseK, 40);
  assert.equal(M.raceSettings({ baseK: 0 }).baseK, 1);
});

test('Spritverbrauch: schneller als Referenz = mehr Verbrauch', () => {
  const track = { refLapMs: 6000 };
  assert.equal(M.fuelPerLap(6000, track), 4);
  assert.ok(M.fuelPerLap(5500, track) > 4);
  assert.ok(M.fuelPerLap(6500, track) < 4);
  assert.equal(Math.round(M.lapsPerTank(6000, track) * 100) / 100, 25);
  // ohne Referenzzeit oder Faktor 0: fester Verbrauch
  assert.equal(M.fuelPerLap(3000, {}, { fullTankLaps: 20 }), 5);
  assert.equal(M.fuelPerLap(3000, track, { fuelSpeedFactor: 0 }), 4);
  // Ausreißer (abgeflogen) werden begrenzt
  assert.equal(M.fuelPerLap(60000, track), 2);
});

test('Controller-Vorschlag nach bevorzugtem Controller, Rest auffüllen', () => {
  const drivers = [
    { id: 1, preferredController: 2 }, { id: 2, preferredController: 2 },
    { id: 3 }, { id: 4, preferredController: 1 }
  ];
  const entries = [1, 2, 3, 4].map(d => ({ driverId: d, carId: 10 + d }));
  const { assignments, conflicts } = M.suggestControllers(entries, drivers);
  assert.deepEqual(plain(assignments.map(a => a.controller)), [2, 3, 4, 1]);
  assert.deepEqual(plain(assignments.map(a => a.preferred)), [true, false, false, true]);
  assert.deepEqual(plain(conflicts), [{ controller: 2, driverIds: [1, 2] }]);
});

test('Fahrzeug-Runden über alle Rennen plus Training', () => {
  const races = [
    { rounds: 40, results: [{ carId: 5 }, { carId: 6 }] },
    { rounds: 20, results: [{ carId: 6 }] },
    { rounds: 30, results: [{ carId: 5 }] }
  ];
  assert.deepEqual(plain(M.carTotals(5, races, { practiceLaps: 12 })), { races: 2, raceLaps: 70, practiceLaps: 12, laps: 82 });
});

test('Rundenzeit-Eingabe mit Komma oder Punkt', () => {
  assert.equal(M.parseLapTime('6,512'), 6512);
  assert.equal(M.parseLapTime('6.5'), 6500);
  assert.equal(M.parseLapTime(''), null);
  assert.equal(M.formatLapTime(6512), '6,512');
});

test('Mindest-Rundenzeit: kürzere Durchfahrten zählen nicht', () => {
  assert.equal(M.isValidLap(4000, { minLapMs: 5000 }), false);
  assert.equal(M.isValidLap(5000, { minLapMs: 5000 }), true);
  assert.equal(M.isValidLap(1200, {}), true);
  assert.equal(M.isValidLap(0, {}), false);
});

test('Sprit-Plan fürs Rennen: Stopps und Tankzeit', () => {
  const track = { refLapMs: 6500 };
  const ref = M.raceFuelPlan(70, 6500, track);
  assert.equal(Math.round(ref.fuelPct), 280);
  assert.equal(ref.stops, 2);
  assert.equal(Math.round(ref.refuelSec), 18);
  assert.equal(M.raceFuelPlan(75, 6500, track).stops, 2);   // genau 3 Tankfüllungen
  assert.equal(M.raceFuelPlan(75, 6175, track).stops, 3);   // 5 % schneller → ein Stopp mehr
  assert.equal(M.raceFuelPlan(20, 6500, track).stops, 0);
});

test('Fahrzeugbild: Startnummer, sonst nach Name (Rover)', () => {
  assert.equal(M.carAssetSrc({ name: '(7) Porsche 911' }), 'assets/cars/07.png');
  assert.equal(M.carAssetSrc({ name: '(46) BMW M1' }), 'assets/cars/46.png');
  assert.equal(M.carAssetSrc({ name: 'Rover Mini Cooper S' }), 'assets/cars/rover.png');
  assert.equal(M.carAssetSrc({ name: 'Ohne Nummer' }), null);
  assert.equal(M.carAssetSrc(null), null);
});

test('„Nur Training“-Fahrzeuge nur im Freien Training', () => {
  const mini = { name: 'Rover Mini Cooper S', practiceOnly: true }, bmw = { name: '(46) BMW' };
  assert.equal(M.carAllowedIn(mini, 'practice'), true);
  assert.equal(M.carAllowedIn(mini, 'quali'), false);
  assert.equal(M.carAllowedIn(mini, 'race'), false);
  assert.equal(M.carAllowedIn(mini, null), false);
  assert.equal(M.carAllowedIn(bmw, 'race'), true);
});
