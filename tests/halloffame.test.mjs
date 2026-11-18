import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, sampleData } from './load.mjs';

const SEASONS = [
  { id: 'a', name: '2025/26', start: '2025-07-01', trackId: 'cdg' },
  { id: 'b', name: '2026/27', start: '2026-01-03', trackId: 't2' }
];
const TRACKS = [{ id: 'cdg', name: 'Circuit du Garage' }, { id: 't2', name: 'Neu' }];

function setup (seasons = SEASONS) {
  const W = loadApp(['helpers.js', 'elo.js', 'seasons.js', 'halloffame.js']);
  W.Seasons.setData(seasons, TRACKS);
  return W;
}

test('Ruhmeshalle: nur abgeschlossene Saisons, Endstand nach G!RP', () => {
  const W = setup();
  const raw = { ...sampleData(), lapRecords: [
    { driverId: 2, carId: 12, time: 5.5, date: '2026-01-01', trackId: 'cdg' },
    { driverId: 1, carId: 11, time: 5.4, date: '2026-01-02', trackId: 'cdg' },
    { driverId: 3, carId: 13, time: 5.1, date: '2026-01-05', trackId: 't2' }
  ] };
  const list = W.HallOfFame.compute(raw);
  assert.equal(list.length, 1);
  const h = list[0];
  assert.equal(h.season.id, 'a');
  assert.equal(h.raceCount, 3);
  assert.equal(h.laps, 175);
  assert.equal(h.from, '01.01.2026');
  assert.equal(h.to, '02.01.2026');
  for (let i = 1; i < h.drivers.length; i++) assert.ok(h.drivers[i - 1].elo >= h.drivers[i].elo);
  assert.equal(h.drivers.length, 4);
  assert.equal(h.lap.who, 'Fahrer 1');           // Rekord der neuen Strecke zählt nicht
  assert.equal(h.lap.time, 5.4);
  assert.equal(raw.drivers[0].elo, 1000);        // Rohdaten bleiben unverändert
});

test('Ruhmeshalle: leer, solange nur eine Saison existiert', () => {
  const W = setup([SEASONS[0]]);
  assert.equal(W.HallOfFame.compute({ ...sampleData(), lapRecords: [] }).length, 0);
});
