import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// CU-Uhr → App-Uhr: eine verspätete Bluetooth-Meldung darf die nächste Runde nicht verkürzen (Bahn 24.11.)
function load () {
  const clock = { now: 0 };
  const ctx = {
    console, performance: { now: () => clock.now },
    setInterval: () => 0, clearInterval () {},
    localStorage: { getItem: () => null, setItem () {} },
    CU: { Commands: { press: b => 'press:' + b }, BUTTON: { ESC: 'ESC', START: 'START' } }
  };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../cu-source.js', import.meta.url), 'utf8'), ctx);
  const src = new ctx.LiveCU.CuSource();
  const laps = [];
  src.on(ev => { if (ev.type === 'lap') laps.push(ev.t); });
  // Durchfahrt bei CU-Zeit ts, kommt mit delay ms Verzögerung in der App an
  let base = 100000;
  const cross = (ts, delay = 50) => { clock.now = base + ts + delay; src.onCu({ type: 'timer', address: 1, sector: 1, timestamp: ts }); };
  return { cross, laps, restart: () => { base = clock.now + 2000; } };
}

test('verspätete Meldung (> 3 s) verschiebt die folgenden Runden nicht', () => {
  const { cross, laps } = load();
  cross(10000); cross(16000); cross(22000, 4000); cross(28000); cross(34000);
  const d = laps.slice(1).map((t, i) => t - laps[i]);
  assert.deepEqual(d, [6000, 6000, 6000, 6000]);
});

test('CU-Neustart (Uhr springt zurück) richtet neu aus', () => {
  const { cross, laps, restart } = load();
  cross(50000); cross(56000);
  restart(); cross(1000); cross(7000);   // CU neu gestartet, App-Uhr läuft weiter
  assert.equal(laps[3] - laps[2], 6000);
  assert.ok(laps[2] > laps[1]);
});
