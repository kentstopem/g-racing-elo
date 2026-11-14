import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, sampleData } from './load.mjs';

const plain = v => JSON.parse(JSON.stringify(v));
const same = (a, b) => assert.deepStrictEqual(plain(a), plain(b));

function setup (seasons = [], tracks = []) {
  const W = loadApp(['helpers.js', 'elo.js', 'seasons.js', 'sync.js']);
  W.Seasons.setData(seasons, tracks);
  return W;
}

const SEASONS = [
  { id: 'b', name: '2026/27', start: '2026-01-03', trackId: 't2' },
  { id: 'a', name: '2025/26', start: '2025-07-01', trackId: 'cdg' }
];
const TRACKS = [{ id: 'cdg', name: 'Circuit du Garage', short: 'CDG' }, { id: 't2', name: 'Neu' }];

test('Ohne Saisons: implizite Saison für alle Rennen', () => {
  const { Seasons } = setup();
  assert.equal(Seasons.hasSeasons(), false);
  assert.equal(Seasons.seasonOfRace({ date: '01.01.2020', time: '10:00' }), 'implicit');
  assert.equal(Seasons.viewTrackId(), null);
});

test('Rennen werden per Datum der richtigen Saison zugeordnet', () => {
  const { Seasons } = setup(SEASONS, TRACKS);
  assert.equal(Seasons.current().id, 'b');
  assert.equal(Seasons.seasonOfRace({ date: '02.01.2026', time: '23:00' }), 'a');
  assert.equal(Seasons.seasonOfRace({ date: '03.01.2026', time: '00:00' }), 'b');
  // vor der ersten Saison → erste Saison
  assert.equal(Seasons.seasonOfRace({ date: '01.01.2024', time: '10:00' }), 'a');
});

test('Rekorde gehören zur Strecke ihrer Saison bzw. zu trackId', () => {
  const { Seasons } = setup(SEASONS, TRACKS);
  assert.equal(Seasons.trackOfRecord({ date: '2025-09-24' }), 'cdg');
  assert.equal(Seasons.trackOfRecord({ date: '2026-02-01' }), 't2');
  assert.equal(Seasons.trackOfRecord({ date: '2026-02-01', trackId: 'cdg' }), 'cdg');
});

test('Auswahl: Standard ist die aktuelle Saison, „Alle Saisons“ möglich', () => {
  const { Seasons } = setup(SEASONS, TRACKS);
  assert.equal(Seasons.selectedId(), 'b');
  Seasons.select('a');
  assert.equal(Seasons.selectedSeason().id, 'a');
  assert.equal(Seasons.viewTrackId(), 'cdg');
  Seasons.select(Seasons.ALL);
  assert.equal(Seasons.isAll(), true);
  assert.equal(Seasons.viewTrackId(), 't2'); // aktuelle Strecke
  Seasons.select('b');
  assert.equal(Seasons.selectedId(), 'b');
});

test('Sync rechnet pro Saison und repariert Ergebnisse der neuen Saison', async () => {
  const W = setup([{ id: 's1', name: '1', start: '2025-01-01' }, { id: 's2', name: '2', start: '2026-01-02' }], []);
  const data = sampleData();
  W.Elo.recomputeAll(data); // gespeicherter Stand: alles als eine Saison
  W.appData = { ...data, allRaces: data.races };
  W.isAdmin = true;
  const written = [];
  W.Storage = { async writeDerived ({ races }) { written.push(...races.map(r => r.id)); races.forEach(r => { data.races.find(x => x.id === r.id).results = r.results; }); } };
  await W.Sync.heal();
  same(written.sort(), [102, 103]); // nur Rennen der neuen Saison ändern sich
  const r102 = data.races.find(r => r.id === 102);
  assert.ok(r102.results.every(res => res.oldDriverElo === 1000));
  assert.equal(await W.Sync.heal(), 0);
});
