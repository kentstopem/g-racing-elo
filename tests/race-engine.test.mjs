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

test('Absturz: Sitzung sichern und mit neuer Uhr fortsetzen (steht auf Rot, danach Ampel)', () => {
  const { s } = race(10, { settings: { pitDriveMs: 0 } });
  lap(s, 1, 7000); lap(s, 1, 15000); lap(s, 2, 7200); lap(s, 2, 15500);
  s.addPenalty(2, 5);
  const snap = JSON.parse(JSON.stringify(s.snapshot(18000)));
  const r = RaceEngine.Session.restore(snap, 500);             // Seite neu geladen: Uhr fängt wieder klein an
  assert.equal(r.phase, 'red');
  assert.equal(r.cars.get(1).laps, 1);
  assert.equal(r.cars.get(2).penaltyMs, 5000);
  assert.equal(r.cars.get(1).lastCross, 15000 - 17500);
  assert.ok(r.resume(2000));
  assert.equal(r.phase, 'lights');
  r.handle({ type: 'go', t: 4000 });
  lap(r, 1, 7000);                                             // 3 s vor dem Absturz + 3 s nach Los
  assert.equal(r.cars.get(1).laps, 2);
  assert.equal(r.cars.get(1).last, 6000);
  assert.equal(r.cars.get(1).lapTimes.at(-1).interrupted, true);
});

test('Absturz vor dem Start: Ampel bleibt bereit', () => {
  const s = new RaceEngine.Session({ mode: 'race', laps: 5, entries, track });
  s.start(0);
  const r = RaceEngine.Session.restore(s.snapshot(1000), 10);
  assert.equal(r.phase, 'lights');
  assert.equal(r.goT, null);
});

test('Rennstart: Box-Status aus der Aufstellung wird gelöscht', () => {
  const s = new RaceEngine.Session({ mode: 'race', laps: 5, entries, track });
  s.start(0);
  s.handle({ type: 'pit', ctrl: 1, inPit: true, t: 100 });
  assert.equal(s.cars.get(1).inPit, true);
  s.handle({ type: 'go', t: 6000 });
  assert.equal(s.cars.get(1).inPit, false);
  assert.equal(s.cars.get(1).pitStops, 0);
});

test('Training: Fahrer im laufenden Training dazunehmen und herausnehmen', () => {
  const s = new RaceEngine.Session({ mode: 'practice', entries, track });
  s.start(0);
  lap(s, 1, 1000); lap(s, 1, 7000); lap(s, 2, 1200); lap(s, 2, 7400);
  assert.equal(s.addCar({ ctrl: 2, driverId: 12, carId: 22 }), false, 'Regler belegt');
  assert.equal(s.addCar({ ctrl: 3, driverId: 10, carId: 22 }), false, 'Fahrer fährt schon');
  assert.ok(s.addCar({ ctrl: 3, driverId: 12, carId: 22 }));
  lap(s, 3, 8000); lap(s, 3, 14000);
  assert.equal(s.cars.get(3).laps, 1);
  assert.ok(s.removeCar(2));
  assert.equal(s.cars.has(2), false);
  lap(s, 2, 14000);                                   // freier Regler zählt nicht
  assert.equal(s.allCars().find(c => c.driverId === 11).laps, 1);
  // wieder dazu (anderer Regler): Runden laufen weiter, erste Durchfahrt startet nur die Zeit
  assert.ok(s.addCar({ ctrl: 4, driverId: 11, carId: 21 }));
  lap(s, 4, 15000); lap(s, 4, 21000);
  assert.equal(s.cars.get(4).laps, 2);
  assert.equal(s.retired.length, 0);
  // Sicherung enthält herausgenommene Fahrer
  s.removeCar(4);
  const r = RaceEngine.Session.restore(s.snapshot(22000), 50000);
  assert.equal(r.allCars().length, 3);
  // im Rennen nicht erlaubt
  const rr = new RaceEngine.Session({ mode: 'race', laps: 3, entries, track });
  assert.equal(rr.addCar({ ctrl: 3, driverId: 12, carId: 22 }), false);
  assert.equal(rr.removeCar(1), false);
});

test('Ansagen: Führungswechsel ab Runde 2, Halbzeit, noch 5 Runden, letzte Runde je einmal', () => {
  const { s, types, events } = race(12);
  let t = 6000;
  lap(s, 1, t += 100); lap(s, 2, t += 100);                 // Start/Ziel-Durchfahrt
  for (let n = 1; n <= 3; n++) { lap(s, 1, t += 7000); lap(s, 2, t += 100); }
  assert.ok(!types().includes('leadChange'));
  lap(s, 2, t += 6000); lap(s, 1, t += 500);               // Runde 4: Fahrer 2 überholt
  assert.equal(events.find(e => e[0] === 'leadChange')[1].ctrl, 2);
  for (let n = 5; n <= 12; n++) { lap(s, 2, t += 7000); lap(s, 1, t += 100); }
  const t2 = types();
  for (const k of ['halfway', 'fiveToGo', 'lastLap']) assert.equal(t2.filter(x => x === k).length, 1, k);
  assert.equal(events.find(e => e[0] === 'halfway')[1].lap, 6);
  assert.equal(events.find(e => e[0] === 'fiveToGo')[1].lap, 7);
  assert.equal(events.filter(e => e[0] === 'finish')[1][1].position, 2);
});

test('Rennen: 20 s ohne Durchfahrt → noSignal, nicht in der Box und nicht bei Roter Flagge', () => {
  const { s, events } = race(50);
  const tickTo = (from, to) => { for (let t = from; t <= to; t += 200) s.tick(t); };
  lap(s, 1, 6500); lap(s, 2, 6600);
  tickTo(6600, 13400);
  lap(s, 1, 13500); lap(s, 2, 13600);
  // Regler 2 steht in der Box (Strafe/Tanken): keine Warnung
  s.handle({ type: 'pit', ctrl: 2, inPit: true, t: 14000 });
  tickTo(13600, 33000);
  assert.equal(s.cars.get(1).noSignal, false);   // 19,5 s
  tickTo(33200, 34000);
  assert.equal(s.cars.get(1).noSignal, true);
  assert.equal(s.cars.get(2).noSignal, false);
  assert.equal(events.filter(e => e[0] === 'noSignal').length, 1);
  assert.equal(s.standings().find(x => x.ctrl === 1).noSignal, true);
  tickTo(34000, 40000);
  assert.equal(events.filter(e => e[0] === 'noSignal').length, 1);   // nur einmal melden
  lap(s, 1, 40000);
  assert.equal(s.cars.get(1).noSignal, false);
  assert.ok(events.some(e => e[0] === 'signalBack'));
  // Rote Flagge: Zeit steht
  s.handle({ type: 'pit', ctrl: 2, inPit: false, t: 40100 });
  s.redFlag(41000);
  tickTo(41000, 90000);
  assert.equal(s.cars.get(1).noSignal, false);
  assert.equal(s.cars.get(2).noSignal, false);
});

test('Training/Quali: keine Warnung ohne Signal; 0 s schaltet sie im Rennen ab', () => {
  const p = new RaceEngine.Session({ mode: 'practice', entries, track });
  p.start(0); lap(p, 1, 1000);
  for (let t = 0; t <= 60000; t += 500) p.tick(t);
  assert.equal(p.cars.get(1).noSignal, false);
  const { s } = race(50, { settings: { noSignalSec: 0 } });
  lap(s, 1, 6500);
  for (let t = 6000; t <= 60000; t += 500) s.tick(t);
  assert.equal(s.cars.get(1).noSignal, false);
});

test('Nach „kein Signal“ zählt die nächste Runde nicht für Bestzeiten', () => {
  const { s } = race(50);
  lap(s, 1, 6500);
  for (let t = 6600; t <= 40000; t += 200) s.tick(t);
  assert.equal(s.cars.get(1).noSignal, true);
  lap(s, 1, 40100);
  assert.equal(s.cars.get(1).laps, 1);
  assert.equal(s.cars.get(1).best, null);
  assert.equal(s.cars.get(1).lapTimes[0].interrupted, true);
});

test('Autotausch mitten im Training: Runden-Segmente je Fahrzeug, auch über Zurücksetzen hinweg', () => {
  const s = new RaceEngine.Session({ mode: 'practice', entries, track });
  s.start(0);
  lap(s, 1, 1000); lap(s, 1, 8000); lap(s, 1, 15000);          // 2 Runden mit Auto 20
  s.changeCar(1, 30);
  lap(s, 1, 22000); lap(s, 1, 28500); lap(s, 1, 35000);          // 3 Runden mit Auto 30 (erste unterbrochen)
  s.reset(36000);                                                // Anzeige auf 0, Segmente bleiben
  lap(s, 1, 37000); lap(s, 1, 44000);                            // +1 Runde Auto 30
  s.changeCar(1, 20);
  lap(s, 1, 51000);                                              // +1 Runde Auto 20
  const c = s.cars.get(1);
  assert.equal(c.laps, 2, 'Anzeige seit dem Zurücksetzen');
  assert.deepEqual(JSON.parse(JSON.stringify(c.carLaps.map(x => [x.carId, x.laps]))), [[20, 2], [30, 4], [20, 1]]);
  assert.deepEqual(JSON.parse(JSON.stringify(RaceEngine.Session.carLapsOf(c).map(x => [x.carId, x.laps]))), [[20, 3], [30, 4]]);
  assert.equal(RaceEngine.Session.carLapsOf(c).find(x => x.carId === 30).best, 6500, 'Bestzeit gehört dem Auto, mit dem sie gefahren wurde');
  assert.equal(c.pairBests[30], 6500);
  assert.equal(c.pairBests[20], 7000);
  assert.ok(s.records.some(r => r.carId === 30 && r.ms === 6500 && r.driverId === 10));
  lap(s, 2, 1000); lap(s, 2, 8000);
  assert.deepEqual({ ...s.carLapTotals() }, { 20: 3, 21: 1, 30: 4 });
});

test('Autotausch bei Roter Flagge im Rennen: Ergebnis fahrerbezogen, Runden je Auto, Sicherung behält Segmente', () => {
  const { s } = race(4);
  lap(s, 1, 6500); lap(s, 2, 6600);
  lap(s, 1, 13500); lap(s, 2, 13700);                            // je 1 Runde
  s.redFlag(14000);
  assert.equal(s.changeCar(1, 30), true);
  // Absturz + Fortsetzen: Segmente müssen mit
  const r = RaceEngine.Session.restore(JSON.parse(JSON.stringify(s.snapshot(15000))), 100);
  assert.deepEqual(JSON.parse(JSON.stringify(r.cars.get(1).carLaps.map(x => [x.carId, x.laps]))), [[20, 1]]);
  r.resume(110);
  for (let i = 1; i <= 5; i++) r.handle({ type: 'lights', step: i, t: 110 + i * 100 });
  r.handle({ type: 'go', t: 800 });
  for (const [t1, t2] of [[7000, 7200], [14000, 14300], [21000, 21400]]) { lap(r, 1, t1); lap(r, 2, t2); }   // Regler 1 mit Auto 30 ins Ziel (4 Runden)
  assert.equal(r.phase, 'finished');
  const res = r.result();
  assert.equal(res[0].driverId, 10);
  assert.equal(res[0].carId, 30, 'gewertet wird das Auto im Ziel');
  assert.equal(res[0].laps, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(res[0].carLaps.map(x => [x.carId, x.laps]))), [[20, 1], [30, 3]]);
  assert.deepEqual(JSON.parse(JSON.stringify(res[1].carLaps.map(x => [x.carId, x.laps]))), [[21, 4]]);
});

test('Alte Sicherung ohne Segmente: alle Runden dem aktuellen Auto', () => {
  const { s } = race(5);
  lap(s, 1, 6500); lap(s, 1, 13500); lap(s, 1, 20500);
  const snap = JSON.parse(JSON.stringify(s.snapshot(21000)));
  snap.cars.forEach(c => delete c.carLaps);
  const r = RaceEngine.Session.restore(snap, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(RaceEngine.Session.carLapsOf(r.cars.get(1)).map(x => [x.carId, x.laps]))), [[20, 2]]);
});

test('Rote Flagge: „+1 Rd.“ zählt die Runde nach, neue Runde beginnt beim Startversatz', () => {
  const { s, events } = race(10, { settings: { manualLapStartMs: 250 } });
  lap(s, 1, 6500); lap(s, 2, 6700);
  lap(s, 1, 13500); lap(s, 2, 13700);
  s.redFlag(20480, 'buzzer');                                   // Regler 1 genau an der Linie (7,0 s Runde)
  assert.equal(s.redLapMs(1), 6980);
  assert.equal(s.redLapMs(2), 6780);
  const fuelBefore = s.cars.get(1).fuel;
  assert.equal(s.addManualLap(1), true);
  const c = s.cars.get(1);
  assert.equal(c.laps, 2);
  assert.equal(c.last, 6730, 'Runde endet 0,25 s vor der Roten Flagge');
  assert.equal(c.crossings[2], 20230);
  assert.equal(c.lapTimes.at(-1).interrupted, true, 'zählt nicht für Bestzeiten');
  assert.equal(c.lapTimes.at(-1).manual, true);
  assert.equal(c.best, 7000, 'Bestzeit unverändert');
  assert.ok(c.fuel < fuelBefore, 'Tank normal abgezogen');
  assert.equal(s.addManualLap(1), false, 'nur einmal je Rote Flagge');
  assert.equal(s.redLapMs(1), 250, 'Anzeige: neue Runde steht beim Startversatz');
  assert.ok(events.some(([t, d]) => t === 'lap' && d.manual));
  // Weiter: Startampel, die neue Runde läuft ab 0,25 s
  s.resume(30000);
  for (let i = 1; i <= 5; i++) s.handle({ type: 'lights', step: i, t: 30000 + i * 1000 });
  s.handle({ type: 'go', t: 36000 });
  assert.equal(c.manualUndo, null, 'nach dem Start nicht mehr rückgängig');
  lap(s, 1, 42750);                                             // 6,75 s nach Grün + 0,25 s = 7,0 s
  assert.equal(c.laps, 3);
  assert.equal(c.last, 7000);
  assert.equal(s.standings()[0].ctrl, 1);
});

test('Rote Flagge: „+1 Rd.“ rückgängig, Zielrunde zählt als Sieg', () => {
  const { s, types } = race(2);
  lap(s, 1, 6500); lap(s, 2, 6700);
  lap(s, 1, 13500); lap(s, 2, 13600);
  s.redFlag(20400);
  const before = JSON.stringify({ ...s.cars.get(2), manualUndo: null });
  assert.ok(s.addManualLap(2));
  assert.equal(s.cars.get(2).laps, 2);
  assert.equal(s.leaderFinished, true, 'Zielrunde: Fahrer 2 gewinnt');
  assert.ok(!types().includes('win'), 'Sieg-Ansage erst nach dem Neustart');
  assert.equal(s.standings()[0].ctrl, 2);
  assert.ok(s.undoManualLap(2));
  assert.equal(s.cars.get(2).laps, 1);
  assert.equal(s.leaderFinished, false);
  assert.equal(JSON.stringify(s.cars.get(2)), before, 'Fahrer wieder wie vorher');
  assert.equal(s.phase, 'red');
  assert.equal(s.undoManualLap(2), false);
});

test('„+1 Rd.“: echte Überquerung (Rote Flagge − 250 ms), Abstand erst gemessen, wenn der Fahrer selbst drüber ist', () => {
  const entries3 = [{ ctrl: 1, driverId: 10, carId: 20 }, { ctrl: 2, driverId: 11, carId: 21 }, { ctrl: 3, driverId: 12, carId: 22 }];
  const { s } = race(20, { entries: entries3 });
  lap(s, 1, 6500); lap(s, 2, 6600); lap(s, 3, 6700);
  lap(s, 1, 13500); lap(s, 2, 13700); lap(s, 3, 14000);        // Rd. 1
  lap(s, 1, 20500); lap(s, 2, 20800); lap(s, 3, 21300);        // Rd. 2: Abstände 0,3 / 0,8
  s.redFlag(27450);                                             // 1 bei 6,95 s, 2 bei 6,65 s, 3 bei 6,15 s
  let st = s.standings();
  assert.equal(st[1].gap, 300); assert.equal(st[2].gap, 800);
  // Führender bekommt +1: die anderen haben diese Linie noch nicht überquert → Rundendifferenz „+1 Rd.“
  assert.ok(s.addManualLap(1));
  st = s.standings();
  assert.deepEqual([...st.map(x => x.ctrl)], [1, 2, 3]);
  assert.equal(st[1].gap, null); assert.equal(st[1].gapLaps, 1);
  assert.equal(st[2].gap, null); assert.equal(st[2].gapLaps, 1);
  assert.ok(s.undoManualLap(1));
  // Zweiter bekommt +1 und übernimmt die Führung: kein +0,000 für den bisherigen Führenden
  assert.ok(s.addManualLap(2));
  st = s.standings();
  assert.deepEqual([...st.map(x => x.ctrl)], [2, 1, 3]);
  assert.equal(st[1].gapLaps, 1, 'statt +0,000');
  assert.equal(st[2].gapLaps, 1);
  assert.ok(s.undoManualLap(2));
  // Dritter mit +1: Überquerung 27450 − 250 = 27200
  assert.ok(s.addManualLap(3));
  assert.equal(s.cars.get(3).crossings[3], 27200);
  st = s.standings();
  assert.deepEqual([...st.map(x => x.ctrl)], [3, 1, 2]);
  assert.equal(st[1].gapLaps, 1); assert.equal(st[2].gapLaps, 1);
  // Neustart nach langer Pause: Abstand in Rennzeit, die Pause zählt nicht mit
  s.resume(30000);
  for (let i = 1; i <= 5; i++) s.handle({ type: 'lights', step: i, t: 80000 + i * 1000 });
  s.handle({ type: 'go', t: 87450 });
  lap(s, 1, 87950);                                             // 1 kommt 0,5 s nach Grün über die Linie
  st = s.standings();
  const one = st.find(x => x.ctrl === 1);
  assert.equal(one.gap, 750, '0,5 s nach Grün + die 0,25 s, die 3 schon hinter der Linie stand');
  assert.equal(st.find(x => x.ctrl === 2).gapLaps, 1, '2 noch nicht über der Linie');
});

test('„+1 Rd.“ des Führenden: wer schon eine Runde zurück war, zeigt „+2 Rd.“', () => {
  const { s } = race(20);
  lap(s, 1, 6500); lap(s, 2, 6600);
  lap(s, 1, 13500); lap(s, 1, 20500); lap(s, 2, 20800);        // 2 eine Runde zurück (Rd. 2 vs. 1)
  s.redFlag(27400);
  assert.equal(s.standings()[1].gapLaps, 1);
  assert.ok(s.addManualLap(1));
  assert.equal(s.standings()[1].gapLaps, 2);
});

test('„+1 Rd.“ mit Führungswechsel: sofort neu sortiert, Ansage erst nach dem Neustart, Führungsrunden', () => {
  const { s, events } = race(20);
  const lead = () => events.filter(e => e[0] === 'leadChange').length;
  lap(s, 1, 6500); lap(s, 2, 6600); lap(s, 1, 13500); lap(s, 2, 13700); lap(s, 1, 20500); lap(s, 2, 20700);
  s.redFlag(27600);
  const before = lead();
  assert.ok(s.addManualLap(2));
  assert.equal(s.standings()[0].ctrl, 2, 'sofort vorn');
  assert.equal(s.standings()[1].gapLaps, 1);
  assert.equal(lead(), before, 'keine Ansage während der Roten Flagge');
  assert.ok(s.undoManualLap(2));
  assert.equal(s.standings()[0].ctrl, 1);
  assert.ok(s.addManualLap(2));
  s.resume(30000);
  for (let i = 1; i <= 5; i++) s.handle({ type: 'lights', step: i, t: 30000 + i * 1000 });
  s.handle({ type: 'go', t: 36000 });
  assert.equal(lead(), before + 1, 'Führungswechsel nach dem Neustart angesagt');
  assert.equal(events.filter(e => e[0] === 'leadChange').at(-1)[1].ctrl, 2);
  lap(s, 1, 36400); lap(s, 2, 43100);
  assert.equal(s.stats().leadLaps[2], 2, 'Linien 3 (nachgezählt) und 4 hat Fahrer 2 zuerst überquert');
  assert.equal(s.stats().leadLaps[1], 2);
});

test('„+1 Rd.“ ohne Führungswechsel bzw. zurückgenommen: keine Ansage', () => {
  const { s, events } = race(20);
  lap(s, 1, 6500); lap(s, 2, 6600); lap(s, 1, 13500); lap(s, 2, 13700);
  s.redFlag(20400);
  const n = events.filter(e => e[0] === 'leadChange').length;
  assert.ok(s.addManualLap(2)); assert.ok(s.undoManualLap(2));
  s.resume(30000);
  for (let i = 1; i <= 5; i++) s.handle({ type: 'lights', step: i, t: 30000 + i * 1000 });
  s.handle({ type: 'go', t: 36000 });
  assert.equal(events.filter(e => e[0] === 'leadChange').length, n);
});

test('„+1 Rd.“ entscheidet das Rennen: Sieg-Ansage erst nach dem Neustart, bei „−1“ gar nicht', () => {
  const { s, types } = race(3, { entries: [...entries, { ctrl: 3, driverId: 12, carId: 22 }] });
  lap(s, 1, 6500); lap(s, 2, 6600); lap(s, 3, 6700);
  lap(s, 1, 13500); lap(s, 2, 13600); lap(s, 3, 13800);
  lap(s, 1, 20500); lap(s, 2, 20600); lap(s, 3, 20900);
  s.redFlag(27400);                                             // 1 genau an der Ziellinie (Runde 3)
  const n = types().filter(t => t === 'win').length;
  assert.ok(s.addManualLap(1));
  assert.equal(s.leaderFinished, true);
  assert.equal(s.cars.get(1).finished, true);
  assert.equal(types().filter(t => t === 'win').length, n, 'noch keine Ansage');
  assert.ok(s.undoManualLap(1));
  assert.equal(s.leaderFinished, false);
  assert.ok(s.addManualLap(1));
  s.resume(30000);
  for (let i = 1; i <= 5; i++) s.handle({ type: 'lights', step: i, t: 30000 + i * 1000 });
  s.handle({ type: 'go', t: 36000 });
  assert.equal(types().filter(t => t === 'win').length, n + 1, 'genau einmal, nach dem Neustart');
  lap(s, 2, 36300);                                             // 2 und 3 kommen nach dem Neustart ins Ziel
  lap(s, 3, 36800);
  assert.equal(s.phase, 'finished');
  assert.deepEqual([...s.standings().map(x => x.ctrl)], [1, 2, 3]);
});

test('„+1 Rd.“ ins Ziel mit offener Strafe: gleiche Regel wie bei echter Überquerung (DQ bei Haken)', () => {
  const { s } = race(3, { dqOpenPenalties: true });
  lap(s, 1, 6500); lap(s, 2, 6600);
  lap(s, 1, 13500); lap(s, 2, 13600);
  lap(s, 1, 20500); lap(s, 2, 20600);
  s.addPenalty(1, 5);                                           // offen, nicht abgesessen
  s.redFlag(27400);
  assert.ok(s.addManualLap(1));                                 // Ziel per +1 mit offener Strafe
  s.resume(30000);
  for (let i = 1; i <= 5; i++) s.handle({ type: 'lights', step: i, t: 30000 + i * 1000 });
  s.handle({ type: 'go', t: 36000 });
  lap(s, 2, 36300);
  assert.equal(s.phase, 'finished');
  assert.equal(s.cars.get(1).status, 'dq');
  assert.equal(s.cars.get(1).dqReason, 'offene Strafe');
  assert.equal(s.standings()[0].ctrl, 2);
});

test('Rote Flagge: „+1 Rd.“ nur, wenn die laufende Runde länger als die minimale Rundenzeit ist', () => {
  const { s } = race(10);
  lap(s, 1, 6500); lap(s, 2, 6700);
  lap(s, 1, 13500); lap(s, 2, 13700);
  s.redFlag(16500, 'buzzer');                                   // Regler 1: 3,0 s, Regler 2: 2,8 s (min. 4,0 s)
  assert.equal(s.canAddManualLap(1), false);
  assert.equal(s.addManualLap(1), false, 'kann noch nicht über der Linie gewesen sein');
  assert.equal(s.cars.get(1).laps, 1);
  const { s: s2 } = race(10);
  lap(s2, 1, 6500); lap(s2, 2, 6700);
  lap(s2, 1, 13500); lap(s2, 2, 13700);
  s2.redFlag(17600, 'buzzer');                                  // Regler 1: 4,1 s, Regler 2: 3,9 s
  assert.equal(s2.canAddManualLap(1), true);
  assert.equal(s2.canAddManualLap(2), false);
});

test('Training mit Tanken: Verbrauch, Tanken in der Box, Zurücksetzen füllt auf', () => {
  const s = new RaceEngine.Session({ mode: 'practice', entries, track, settings: {}, fuel: true });
  s.start(0);
  lap(s, 1, 1000); lap(s, 1, 8000); lap(s, 1, 15000);
  const f = s.standings().find(x => x.ctrl === 1).fuel;
  assert.ok(f > 0 && f < 100);
  s.handle({ type: 'pit', ctrl: 1, inPit: true, t: 16000 });
  s.tick?.(20000);
  assert.ok(s.cars.get(1).fuel > f);
  s.reset(21000);
  assert.equal(s.cars.get(1).fuel, 100);
  assert.equal(s.cars.get(2).fuel, 100);
});

test('Quali mit Tanken: Option bleibt im Snapshot erhalten', () => {
  const s = new RaceEngine.Session({ mode: 'quali', laps: 3, entries, track, settings: {}, fuel: true });
  s.start(0);
  assert.equal(s.fuelOn, true);
  assert.equal(s.snapshot().opts.fuel, true);
});

test('Tank: zweite Warnung „jetzt tanken“ ab 5 %, einmal je Tankfüllung', () => {
  const { s, events } = race(60, { settings: { fullTankLaps: 25, pitCallFuelPct: 20, fuelCritPct: 5, pitDriveMs: 0 } });
  let t = 6500;
  lap(s, 1, t);
  for (let i = 0; i < 24; i++) { t += 7000; lap(s, 1, t); }   // 24 Runden à 4 % → 4 %
  const c = s.cars.get(1);
  assert.ok(Math.abs(c.fuel - 4) < 1e-9);
  const n = k => events.filter(e => e[0] === k).length;
  assert.equal(n('pitCall'), 1);
  assert.equal(n('fuelCritical'), 1);
  s.handle({ type: 'pit', ctrl: 1, inPit: true, t: t + 1000 });
  s.tick(t + 1000 + 20000);
  assert.equal(c.fuel, 100);
  assert.equal(c.fuelCritCalled, false);
});

test('Tank: fällt der Tank in einer Runde unter beide Schwellen, kommt nur „jetzt tanken“', () => {
  const { s, events } = race(60, { settings: { fullTankLaps: 25, pitCallFuelPct: 19, fuelCritPct: 17, pitDriveMs: 0 } });
  let t = 6500;
  lap(s, 1, t);
  for (let i = 0; i < 21; i++) { t += 7000; lap(s, 1, t); }   // 20 % → 16 %
  assert.equal(events.filter(e => e[0] === 'pitCall').length, 0);
  assert.equal(events.filter(e => e[0] === 'fuelCritical').length, 1);
});

test('Rote Flagge: Letzter Fahrer DNF/DQ, alle anderen im Ziel → Rennen sofort beendet', () => {
  const n = entries.length;
  const { s, events } = race(2);
  for (let i = 1; i <= n; i++) lap(s, i, 6500 + i * 100);                  // Zeitnahme beginnt
  for (let i = 1; i <= n; i++) lap(s, i, 13500 + i * 100);                 // Runde 1
  for (let i = 1; i < n; i++) lap(s, i, 20500 + i * 100);                  // alle außer dem Letzten im Ziel
  assert.ok(s.leaderFinished);
  assert.notEqual(s.phase, 'finished');
  s.redFlag(22000, 'buzzer');
  s.setStatus(n, 'dnf');
  assert.equal(s.phase, 'finished', 'kein „Weiter geht\'s“ nötig');
  assert.ok(events.some(([t]) => t === 'end'));
});

test('Rote Flagge: DNF eines Fahrers beendet das Rennen nicht, solange andere noch fahren', () => {
  const { s } = race(2);
  for (let i = 1; i <= entries.length; i++) lap(s, i, 6500 + i * 100);
  s.redFlag(9000, 'buzzer');
  s.setStatus(1, 'dq');
  assert.equal(s.phase, 'red');
});
