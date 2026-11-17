import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './load.mjs';

const { RaceEngine } = loadApp(['helpers.js', 'masterdata.js', 'race-engine.js']);

const entries = [{ ctrl: 1, driverId: 10, carId: 20 }, { ctrl: 2, driverId: 11, carId: 21 }];
const track = { refLapMs: 7000, minLapMs: 4000 };

function race (laps = 3, extra = {}) {
  const s = new RaceEngine.Session({ mode: 'race', laps, entries, track, settings: {}, ...extra });
  const events = [];
  s.on((type, data) => events.push([type, data]));
  s.start(0);
  for (let i = 1; i <= 5; i++) s.handle({ type: 'lights', step: i, t: i * 1000 });
  s.handle({ type: 'go', t: 6000 });
  return { s, events, types: () => events.map(e => e[0]) };
}
const lap = (s, ctrl, t) => s.handle({ type: 'lap', ctrl, t });

test('Training startet ohne Ampel, Bestzeit und Sortierung nach Bestzeit', () => {
  const s = new RaceEngine.Session({ mode: 'practice', entries, track });
  s.start(0);
  assert.equal(s.phase, 'green');
  lap(s, 1, 1000); lap(s, 1, 8000); lap(s, 1, 14800);
  lap(s, 2, 1200); lap(s, 2, 7700);
  const st = s.standings();
  assert.equal(st[0].ctrl, 2);           // 6,5 s
  assert.equal(st[0].best, 6500);
  assert.equal(st[1].best, 6800);
  assert.equal(st[1].gap, 300);
  assert.equal(st[0].fuel, null);        // Tank nur im Rennen
});

test('Mindest-Rundenzeit filtert Doppelmeldungen', () => {
  const s = new RaceEngine.Session({ mode: 'practice', entries, track });
  s.start(0);
  lap(s, 1, 1000); lap(s, 1, 1100); lap(s, 1, 8000);
  assert.equal(s.cars.get(1).laps, 1);
  assert.equal(s.cars.get(1).last, 7000);
});

test('Rennen: Positionen, Abstand, Runden-Rückstand, Sieg und Zieleinlauf', () => {
  const { s, types } = race(3);
  lap(s, 1, 6500); lap(s, 2, 6700);                   // Zeitnahme beginnt
  lap(s, 1, 13500); lap(s, 2, 14000);
  let st = s.standings();
  assert.equal(st[0].ctrl, 1);
  assert.equal(st[1].gap, 500);
  lap(s, 1, 20500);                                    // Führender wieder über der Linie: Abstand bleibt Zeit
  st = s.standings();
  assert.equal(st[1].gapLaps, 0);
  assert.equal(st[1].gap, 500);
  assert.ok(types().includes('lastLap'));
  lap(s, 1, 27500);                                    // Sieg nach 3 Runden
  assert.ok(types().includes('win'));
  st = s.standings();
  assert.equal(st[1].gapLaps, 1);          // zwischen 1 und 2 Runden zurück
  lap(s, 2, 28500);                                    // Zweiter kommt ins Ziel (eine Runde zurück)
  assert.equal(s.phase, 'finished');
  assert.equal(s.result().map(r => r.driverId).join(), '10,11');
});

test('Fehlstart: Durchfahrt vor Ampel aus → Strafe aus den Renneinstellungen', () => {
  const s = new RaceEngine.Session({ mode: 'race', laps: 5, entries, track, settings: { falseStartPenaltySec: 5 } });
  const ev = [];
  s.on(t => ev.push(t));
  s.start(0);
  s.handle({ type: 'lights', step: 3, t: 3000 });
  lap(s, 2, 3500);
  assert.ok(ev.includes('falseStart'));
  assert.equal(s.standings().find(x => x.ctrl === 2).penaltySec, 5);
});

test('CU: Durchfahrten vor dem Start geben keine Fehlstart-Strafe (lapFalseStart: false)', () => {
  const s = new RaceEngine.Session({ mode: 'race', laps: 5, entries, track, settings: { falseStartPenaltySec: 5 }, lapFalseStart: false });
  const ev = [];
  s.on(t => ev.push(t));
  s.start(0);
  lap(s, 1, 500); lap(s, 2, 600);
  s.handle({ type: 'lights', step: 3, t: 3000 });
  lap(s, 2, 3500);
  assert.ok(!ev.includes('falseStart'));
  assert.ok(s.standings().every(x => !x.penaltySec));
});

test('Boxenzeit steht bei Roter Flagge und während der Startampel danach', () => {
  const { s } = race(30, { settings: { pitDriveMs: 0 } });
  s.addPenalty(1, 20);
  lap(s, 1, 6500);
  s.handle({ type: 'pit', ctrl: 1, inPit: true, t: 10000 });
  s.tick(12000);                                                // 2 s abgesessen
  s.redFlag(12000, 'buzzer');
  s.tick(30000);
  s.resume(30000);                                              // Startampel läuft
  s.tick(40000);
  assert.equal(s.cars.get(1).penaltyMs, 18000);
  assert.equal(s.cars.get(1).pitStandMs, 2000);
  s.handle({ type: 'go', t: 45000 });
  s.tick(48000);
  assert.equal(s.cars.get(1).penaltyMs, 15000);
});

test('Strafen summieren sich und werden scheibchenweise in der Box abgesessen, erst danach wird getankt', () => {
  const { s, types } = race(30, { settings: { pitDriveMs: 0 } });
  s.addPenalty(1, 10); s.addPenalty(1, 13);
  assert.equal(s.standings().find(x => x.ctrl === 1).penaltySec, 23);
  lap(s, 1, 6500);
  s.cars.get(1).fuel = 50;
  s.handle({ type: 'pit', ctrl: 1, inPit: true, t: 10000 });
  s.tick(15000); s.tick(20000);
  s.handle({ type: 'pit', ctrl: 1, inPit: false, t: 20000 });   // nach 10 s raus
  assert.equal(s.cars.get(1).penaltyMs, 13000);
  assert.equal(s.cars.get(1).fuel, 50);                         // nicht getankt
  s.handle({ type: 'pit', ctrl: 1, inPit: true, t: 30000 });
  s.tick(43000);                                                // Rest abgesessen
  assert.ok(types().includes('penaltyServed'));
  assert.equal(s.cars.get(1).penaltyMs, 0);
  s.tick(45000);                                                // 2 s tanken → +20 %
  assert.ok(Math.abs(s.cars.get(1).fuel - 70) < 1e-9);
});

test('Leerer Tank meldet Drosselung, Tanken hebt sie auf', () => {
  const { s, events } = race(60, { settings: { fullTankLaps: 2, pitDriveMs: 0 } });
  lap(s, 1, 6500); lap(s, 1, 13500); lap(s, 1, 20500);
  const empty = events.find(e => e[0] === 'fuelEmpty');
  assert.equal(empty[1].level, 4);
  s.handle({ type: 'pit', ctrl: 1, inPit: true, t: 21000 });
  s.tick(22000);
  assert.ok(events.some(e => e[0] === 'fuelRestored'));
});

test('Offene Strafe bei Rennende → Disqualifikation (wenn eingestellt)', () => {
  const { s } = race(1, { dqOpenPenalties: true });
  s.addPenalty(1, 5);
  lap(s, 1, 6500); lap(s, 2, 6700);
  lap(s, 1, 13500); lap(s, 2, 14000);
  assert.equal(s.phase, 'finished');
  const st = s.standings();
  assert.equal(st[0].ctrl, 2);
  assert.equal(st[1].status, 'dq');
});

test('Rennende nach x Fahrern im Ziel, Ausfall (DNF) zählt nicht mit', () => {
  const three = [...entries, { ctrl: 3, driverId: 12, carId: 22 }];
  const { s } = race(1, { entries: three, finishCount: 2 });
  s.setStatus(3, 'dnf');
  lap(s, 1, 6500); lap(s, 2, 6700);
  lap(s, 1, 13500);
  assert.equal(s.phase, 'green');
  lap(s, 2, 14000);
  assert.equal(s.phase, 'finished');
  assert.equal(s.standings()[2].status, 'dnf');
});

test('Rennzeit pausiert bei Roter Flagge, Gesamtzeit läuft weiter', () => {
  const { s } = race(10);
  s.handle({ type: 'short', t: 16000 });          // 10 s nach dem Start
  let c = s.clocks(26000);
  assert.equal(c.race, 10000); assert.equal(c.total, 20000);
  s.resume(30000);
  s.handle({ type: 'go', t: 36000 });
  c = s.clocks(40000);
  assert.equal(c.race, 14000); assert.equal(c.total, 34000);
});

test('Tank: Verbrauch je Runde, Boxenfunk, Tanken mit 10 %/s', () => {
  const { s, types } = race(60, { settings: { fullTankLaps: 25, pitCallFuelPct: 20, pitDriveMs: 0 } });
  let t = 6500;
  lap(s, 1, t);
  for (let i = 0; i < 21; i++) { t += 7000; lap(s, 1, t); }   // 21 Runden à 4 %
  const c = s.cars.get(1);
  assert.ok(Math.abs(c.fuel - 16) < 1e-9);
  assert.ok(types().includes('pitCall'));
  s.handle({ type: 'pit', ctrl: 1, inPit: true, t: t + 1000 });
  s.tick(t + 1000 + 5000);                                       // 5 s → +50 %
  assert.ok(Math.abs(c.fuel - 66) < 1e-9);
  s.tick(t + 1000 + 20000);
  assert.equal(c.fuel, 100);
  assert.ok(types().includes('refueled'));
});

test('Schneller als Referenz verbraucht mehr', () => {
  const { s } = race(60);
  lap(s, 1, 6500); lap(s, 1, 6500 + 5600);                     // 5,6 s statt 7 s → ×1,25
  assert.ok(Math.abs(s.cars.get(1).fuel - (100 - 4 * 1.25)) < 1e-9);
});

test('Rote Flagge: keine Wertung, Neustart mit Ampel, Unterbrechung zählt nicht als Bestzeit', () => {
  const { s, types } = race(10);
  lap(s, 1, 6500); lap(s, 1, 13500);
  s.handle({ type: 'short', t: 15000 });
  assert.equal(s.phase, 'red');
  lap(s, 1, 16000);                                             // während Rot ignoriert
  assert.equal(s.cars.get(1).laps, 1);
  assert.equal(s.resume(), true);
  assert.equal(s.phase, 'lights');
  assert.ok(types().includes('resume'));
  for (let i = 1; i <= 5; i++) s.handle({ type: 'lights', step: i, t: 60000 + i * 1000 });
  s.handle({ type: 'go', t: 66000 });                           // 51 s Pause
  lap(s, 1, 66000 + 5500);                                      // Rest der Runde
  const c = s.cars.get(1);
  assert.equal(c.laps, 2);
  assert.equal(c.last, 7000);                                   // 1,5 s vor + 5,5 s nach der Pause
  assert.equal(c.best, 7000);                                   // unterbrochene Runde zählt nicht
  assert.equal(s.standings()[0].lastInterrupted, true);
});

test('Qualifying ohne Ampel, endet wenn alle ihre Runden haben; Pole = schnellste Runde', () => {
  const s = new RaceEngine.Session({ mode: 'quali', laps: 2, entries, track });
  const ev = [];
  s.on((t, d) => ev.push([t, d]));
  s.start(6000);
  assert.equal(s.phase, 'green');
  lap(s, 1, 6500); lap(s, 1, 13500); lap(s, 1, 20300);
  lap(s, 1, 27000);                                             // nach 2 Runden ignoriert
  assert.equal(s.cars.get(1).laps, 2);
  lap(s, 2, 6800); lap(s, 2, 13400); lap(s, 2, 20200);
  assert.equal(s.phase, 'finished');
  const pole = ev.find(e => e[0] === 'pole');
  assert.equal(pole[1].driverId, 11);
});

test('Rekorde: Strecke, Fahrzeug, persönlich', () => {
  const records = [{ driverId: 10, carId: 20, ms: 6900 }, { driverId: 11, carId: 21, ms: 6600 }];
  const s = new RaceEngine.Session({ mode: 'practice', entries, track, records });
  const ev = [];
  s.on((t, d) => ev.push([t, d]));
  s.start(0);
  lap(s, 1, 1000); lap(s, 1, 7800);                             // 6,8: persönlicher Rekord
  assert.ok(ev.some(e => e[0] === 'personalRecord' && e[1].driverId === 10));
  lap(s, 1, 14300);                                             // 6,5: Streckenrekord
  assert.ok(ev.some(e => e[0] === 'trackRecord' && e[1].ms === 6500 && e[1].previous === 6600));
  assert.equal(s.trackRecord.ms, 6500);
});

test('Nach Zieleinlauf zählen keine Runden mehr', () => {
  const { s } = race(1);
  lap(s, 1, 6500); lap(s, 2, 6700);
  lap(s, 1, 13500);                                   // Sieg
  lap(s, 1, 20500); lap(s, 1, 27500);                 // fährt weiter, zählt nicht
  assert.equal(s.cars.get(1).laps, 1);
});

test('Persönlicher Rekord gilt je Fahrer über alle Fahrzeuge', () => {
  const records = [{ driverId: 10, carId: 99, ms: 6000 }];
  const s = new RaceEngine.Session({ mode: 'practice', entries, track, records });
  const ev = [];
  s.on(t => ev.push(t));
  s.start(0);
  lap(s, 1, 1000); lap(s, 1, 7500);                   // 6,5 s: schneller als nichts mit Auto 20, aber langsamer als 6,0 mit Auto 99
  assert.ok(!ev.includes('personalRecord'));
  assert.ok(ev.includes('carRecord'));
});

test('Fahrzeugwechsel: Training jederzeit, Rennen nur bei Roter Flagge', () => {
  const p = new RaceEngine.Session({ mode: 'practice', entries, track });
  p.start(0);
  lap(p, 1, 1000); lap(p, 1, 7500);
  assert.equal(p.changeCar(1, 30), true);
  assert.equal(p.cars.get(1).best, null);
  lap(p, 1, 15000);                                   // Wechselrunde zählt nicht als Bestzeit
  assert.equal(p.cars.get(1).best, null);
  assert.equal(p.cars.get(1).pairBests[20], 6500);
  const { s } = race(10);
  assert.equal(s.changeCar(1, 30), false);
  s.handle({ type: 'short', t: 9000 });
  assert.equal(s.changeCar(1, 30), true);
});

test('Rekorde nach Fahrzeugwechsel: je Paarung getrennt, Fahrzeug-Rekord zählt sofort mit', () => {
  const records = [{ driverId: 11, carId: 30, ms: 6400 }];
  const s = new RaceEngine.Session({ mode: 'practice', entries, track, records });
  const ev = [];
  s.on((t, d) => ev.push([t, d]));
  s.start(0);
  lap(s, 1, 1000); lap(s, 1, 7500);                    // Fahrer 10 mit Auto 20: 6,5 s
  s.changeCar(1, 30);
  lap(s, 1, 14500);                                     // Wechselrunde zählt nicht
  lap(s, 1, 20800);                                     // Auto 30: 6,3 s → Fahrzeug-Rekord (bisher 6,4 von Fahrer 11)
  assert.equal(JSON.stringify(s.cars.get(1).pairBests), JSON.stringify({ 20: 6500, 30: 6300 }));
  assert.equal(ev.filter(e => e[0] === 'carRecord' && e[1].carId === 30).length, 1);
  lap(s, 1, 27150);                                     // 6,35 s: kein neuer Fahrzeug-Rekord mehr
  assert.equal(ev.filter(e => e[0] === 'carRecord' && e[1].carId === 30).length, 1);
});

test('Training zurücksetzen: Runden, Zeiten und Uhr auf 0, Paarungs-Bestzeiten bleiben', () => {
  const s = new RaceEngine.Session({ mode: 'practice', entries, track });
  s.start(0);
  lap(s, 1, 1000); lap(s, 1, 7500); lap(s, 1, 14200);
  assert.equal(s.reset(20000), true);
  const c = s.cars.get(1);
  assert.equal(c.laps, 0); assert.equal(c.best, null); assert.equal(c.last, null);
  assert.equal(s.clocks(20000).total, 0);
  assert.equal(c.pairBests[20], 6500);
  lap(s, 1, 21000);                                     // erste Durchfahrt startet die Zeitnahme neu
  lap(s, 1, 28000);
  assert.equal(c.laps, 1); assert.equal(c.best, 7000);
  const { s: r } = race(5);
  assert.equal(r.reset(9000), false);                   // nur im Training
});

test('Statistik: Positionen je Runde, Führungsrunden, Durchschnitt, Boxenrunde', () => {
  const { s } = race(3);
  lap(s, 1, 6500); lap(s, 2, 6700);
  lap(s, 1, 13500); lap(s, 2, 13400);                 // Runde 1: Regler 2 vorn
  s.handle({ type: 'pit', ctrl: 1, inPit: true, t: 14000 });
  s.handle({ type: 'pit', ctrl: 1, inPit: false, t: 16000 });
  lap(s, 2, 20200); lap(s, 1, 22000);                 // Runde 2: Regler 2 vorn, Regler 1 mit Boxenstopp
  lap(s, 1, 29000); lap(s, 2, 27100);                 // Runde 3: Regler 2 gewinnt
  const st = s.stats();
  assert.equal(st.maxLaps, 3);
  assert.equal(st.positions[1].join(), '2,2,2');
  assert.equal(st.positions[2].join(), '1,1,1');
  assert.equal(st.leadLaps[2], 3);
  assert.equal(st.laps[1][1].pit, true);
  assert.equal(Math.round(st.avgMs[2]), Math.round((6700 + 6800 + 6900) / 3));
});

test('Gutschrift: nur von offener Strafe, in 5-s-Schritten, nie unter 0', () => {
  const { s } = race(10);
  assert.equal(s.creditPenalty(1), 0);                // keine offene Strafe → keine Gutschrift
  s.addPenalty(1, 7);
  assert.equal(s.creditPenalty(1), 5);
  assert.equal(s.cars.get(1).penaltyMs, 2000);
  assert.equal(s.creditPenalty(1), 2);                // Rest kleiner als 5 s → 0
  assert.equal(s.cars.get(1).penaltyMs, 0);
  s.addPenalty(1, 10);
  const st = s.standings().find(x => x.ctrl === 1);
  assert.equal(st.penaltyTotalSec, 10);               // Summe: 7 − 7 Gutschrift + 10
});

test('Alle fahren volle Distanz: Überrundete fahren nach dem Sieg weiter', () => {
  const { s } = race(2, { fullDistance: true });
  lap(s, 1, 6500); lap(s, 2, 6700);
  lap(s, 1, 13000); lap(s, 1, 19500);                 // Regler 1 gewinnt nach 2 Runden
  lap(s, 2, 14000);                                   // Regler 2 hat erst 1 Runde → fährt weiter
  assert.equal(s.cars.get(2).finished, false);
  assert.equal(s.phase, 'green');
  lap(s, 2, 21000);                                   // 2. Runde → im Ziel, Rennen vorbei
  assert.equal(s.cars.get(2).finished, true);
  assert.equal(s.cars.get(2).laps, 2);
  assert.equal(s.phase, 'finished');
  const { s: n } = race(2);                           // Standard: Zielflagge auch für Überrundete
  lap(n, 1, 6500); lap(n, 2, 6700); lap(n, 1, 13000); lap(n, 1, 19500); lap(n, 2, 14000);
  assert.equal(n.cars.get(2).finished, true);
  assert.equal(n.cars.get(2).laps, 1);
});

test('Boxendurchfahrt: zählt live, wird beim Rausfahren abgezogen (erst Tanken, dann Strafe)', () => {
  const { s, events } = race(30);                               // Standard 2000 ms
  assert.equal(s.settings.pitDriveMs, 2000);
  s.addPenalty(1, 5);
  lap(s, 1, 6500);
  s.cars.get(1).fuel = 50;
  // nur durchgefahren (1,5 s): live abgesessen, danach komplett zurück
  s.handle({ type: 'pit', ctrl: 1, inPit: true, t: 10000 });
  s.tick(11500);
  assert.equal(s.cars.get(1).penaltyMs, 3500);                  // live sichtbar
  s.handle({ type: 'pit', ctrl: 1, inPit: false, t: 11500 });
  assert.equal(s.cars.get(1).penaltyMs, 5000);
  assert.ok(events.some(e => e[0] === 'pitCorrection'));
  // Stopp: 9 s in der Box = 5 s Strafe + 4 s Tanken (+40 %), beim Rausfahren 2 s Tanken zurück (−20 %)
  s.handle({ type: 'pit', ctrl: 1, inPit: true, t: 30000 });
  s.tick(35000); s.tick(37000); s.tick(39000);
  assert.equal(s.cars.get(1).penaltyMs, 0);
  assert.ok(Math.abs(s.cars.get(1).fuel - 90) < 1e-9);
  s.handle({ type: 'pit', ctrl: 1, inPit: false, t: 39000 });
  assert.ok(Math.abs(s.cars.get(1).fuel - 70) < 1e-9);
  assert.equal(s.cars.get(1).penaltyMs, 0);
  // Stopp mit 1 s Tanken: 1 s vom Tanken, 1 s zurück auf die Strafe
  s.addPenalty(1, 2);
  s.handle({ type: 'pit', ctrl: 1, inPit: true, t: 50000 });
  s.tick(51000); s.tick(52000); s.tick(53000);
  s.handle({ type: 'pit', ctrl: 1, inPit: false, t: 53000 });
  assert.ok(Math.abs(s.cars.get(1).fuel - 70) < 1e-9);
  assert.equal(s.cars.get(1).penaltyMs, 1000);
  // schon voll und noch gewartet: nichts wird abgezogen
  s.handle({ type: 'pit', ctrl: 1, inPit: true, t: 60000 });
  s.tick(70000); s.tick(75000);
  assert.equal(s.cars.get(1).fuel, 100);
  s.handle({ type: 'pit', ctrl: 1, inPit: false, t: 75000 });
  assert.equal(s.cars.get(1).fuel, 100);
});

test('CU: Buzzer = Rote Flagge, Fehlstart ohne Fahrer = Rote Flagge vor dem Start', () => {
  const { s, types } = race(30);
  s.handle({ type: 'stop', t: 8000 });
  assert.equal(s.phase, 'red');
  const s2 = new RaceEngine.Session({ mode: 'race', laps: 5, entries, track, settings: {} });
  s2.start(0);
  s2.handle({ type: 'lights', step: 2, t: 2000 });
  s2.handle({ type: 'falseStart', t: 2500 });
  assert.equal(s2.phase, 'red');
  assert.ok(s2.resume(4000));
  assert.equal(s2.phase, 'lights');
  s2.handle({ type: 'go', t: 9000 });
  assert.equal(s2.phase, 'green');
  assert.equal(s2.goT, 9000);
});
