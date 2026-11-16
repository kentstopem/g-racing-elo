import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './load.mjs';

const { CU } = loadApp(['helpers.js', 'cu.js']);

// Nachrichten wie die CU sie über Bluetooth schickt (ohne '?', mit '$'), gebaut nach carreralib
const nib = n => String.fromCharCode(48 + (n & 0xF));
const chk = s => nib([...s].reduce((a, c) => a + c.charCodeAt(0), 0));
const ts = t => [24, 28, 16, 20, 8, 12, 0, 4].map(sh => nib(t >>> sh)).join('');
const timerMsg = (addr, t, sector = 1) => { const b = nib(addr) + ts(t) + nib(sector); return b + chk(b) + '$'; };

test('Zeitstempel und Timer-Nachricht', () => {
  const ev = CU.parse(timerMsg(3, 123456789));
  assert.equal(ev.type, 'timer');
  assert.equal(ev.address, 3);
  assert.equal(ev.timestamp, 123456789);
  assert.equal(ev.sector, 1);
  assert.equal(ev.ok, true);
});

test('Status-Nachricht (auch mit zwei Zusatzzeichen)', () => {
  const body = ':' + [15, 14, 13, 12, 11, 10, 9, 8].map(nib).join('') + nib(2) + nib(5) + nib(0x21 & 0xF) + nib(0x21 >> 4) + nib(8);
  for (const b of [body, body + '00']) {
    const ev = CU.parse(b + chk(b) + '$');
    assert.equal(ev.type, 'status');
    assert.deepEqual([...ev.fuel], [15, 14, 13, 12, 11, 10, 9, 8]);
    assert.equal(ev.start, 2);
    assert.equal(ev.mode, 5);
    assert.deepEqual([...ev.pit], [true, false, false, false, false, true, false, false]);
    assert.equal(ev.display, 8);
    assert.equal(ev.ok, true);
  }
});

test('Version', () => {
  const ev = CU.parse('53376$');
  assert.equal(ev.type, 'version');
  assert.equal(ev.version, '5337');
});

test('Rundenzeiten je Controller, Doppelmeldungen und Sektoren ignoriert', () => {
  const t = new CU.LapTracker();
  const add = (a, ms, s = 1) => t.add(CU.parse(timerMsg(a, ms, s)));
  assert.equal(add(1, 1000), null);          // erste Durchfahrt
  assert.equal(add(1, 1000), null);          // doppelt
  assert.equal(add(1, 4000, 2), null);       // Check Lane
  const r1 = add(1, 8500);
  assert.equal(r1.time, 7500); assert.equal(r1.lap, 1); assert.equal(r1.isBest, true);
  const r2 = add(1, 16200);
  assert.equal(r2.time, 7700); assert.equal(r2.best, 7500); assert.equal(r2.isBest, false);
  assert.equal(add(2, 500), null);
  assert.equal(add(2, 7900).time, 7400);
});

test('Bestzeiten je Fahrer+Fahrzeug und Rekord-Kandidaten', () => {
  const bests = {};
  const assign = { 1: { driverId: 7, carId: 11 }, 3: { driverId: 8, carId: 12 } };
  CU.sessionBest(bests, assign, { address: 1, time: 8497 });
  CU.sessionBest(bests, assign, { address: 1, time: 8247 });
  CU.sessionBest(bests, assign, { address: 1, time: 8809 });
  CU.sessionBest(bests, assign, { address: 3, time: 7621 });
  assert.equal(CU.sessionBest(bests, assign, { address: 5, time: 7000 }), null); // nicht zugeordnet
  assert.equal(bests['7|11'].ms, 8247);
  const records = [
    { driverId: 7, carId: 11, time: 8.1, trackId: 'cdg' },   // schneller → kein neuer Rekord
    { driverId: 8, carId: 12, time: 7.9, trackId: 'cdg' },   // langsamer → neuer Rekord
    { driverId: 8, carId: 12, time: 7.0, trackId: 'alt' }    // andere Strecke zählt nicht
  ];
  const c = CU.recordCandidates(bests, records, 'cdg', r => r.trackId);
  assert.equal(c.length, 1);
  assert.equal(c[0].driverId, 8); assert.equal(c[0].time, 7.621); assert.equal(c[0].previous, 7.9);
  const none = CU.recordCandidates(bests, [], 'cdg', r => r.trackId);
  assert.equal(none.length, 2); assert.equal(none[0].previous, null);
});

test('Befehle an die CU (Testvektoren aus carreralib, Variante A)', () => {
  assert.equal(CU.Commands.word(6, 0, 9, 1), 'J60910');      // Positionsturm löschen
  assert.equal(CU.Commands.word(6, 5, 4, 1), 'J6:415');      // Position 4 für Regler 6
  assert.equal(CU.Commands.speed(1, 15), 'J00?2' + nib(0 + 0 + 15 + 2));
  assert.equal(CU.Commands.press(CU.BUTTON.START), 'T22');
  assert.equal(CU.Commands.resetTimer(), '=101');
});

test('Befehle an die CU (Variante B wie OpenLap)', () => {
  assert.equal(CU.Commands.word(6, 0, 9, 1, 'B'), 'J6091:');  // Prüfsumme inkl. 'J'
  assert.equal(CU.Commands.press(CU.BUTTON.START, 'B'), 'T2');
  assert.equal(CU.Commands.resetTimer('B'), '=10');
});

test('Status: Zusatzzeichen werden mitgeliefert', () => {
  const body = ':' + '00000000' + '0' + '4' + '00' + '8' + '7;';
  const ev = CU.parse(body + chk(body) + '$');
  assert.deepEqual([...ev.extra], [7, 11]);
});
