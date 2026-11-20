import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Vorbereitung: hub.releaseTrack() drückt ESC, bis die CU „frei“ (Ampel 0) meldet
function load () {
  let now = 0; const timers = [];
  const ctx = {
    console, performance: { now: () => now },
    setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval: id => { if (id) timers[id - 1] = null; },
    localStorage: { getItem: () => null, setItem () {} },
    CU: { Commands: { press: b => 'press:' + b }, BUTTON: { ESC: 'ESC', START: 'START' } }
  };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../cu-source.js', import.meta.url), 'utf8'), ctx);
  const hub = ctx.LiveCU.hub, sent = [];
  hub.state = 'connected'; hub.conn = { command: c => sent.push(c) };
  const run = ms => { for (let t = 0; t < ms; t += 150) { now += 150; timers.forEach(f => f && f()); } };
  return { hub, sent, run };
}

test('Rot → ESC bis frei, dann Schluss', () => {
  const { hub, sent, run } = load();
  hub.lastStatus = { start: 1 };
  hub.releaseTrack();
  assert.deepEqual(sent, ['press:ESC']);
  run(1000);
  assert.equal(sent.length, 2);              // Befehl verloren → wiederholt
  hub.lastStatus = { start: 0 };
  run(3000);
  assert.equal(sent.length, 2);
  assert.equal(hub.releaseLoop, null);
});

test('Laufender Countdown wird nicht abgebrochen, schon frei = nichts senden', () => {
  const { hub, sent, run } = load();
  hub.lastStatus = { start: 3 };
  hub.releaseTrack(); run(2000);
  assert.equal(sent.length, 0);
  hub.cancelRelease();
  hub.lastStatus = { start: 0 };
  hub.releaseTrack(); run(500);
  assert.equal(sent.length, 0);
});
