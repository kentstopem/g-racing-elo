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
