// Lädt die Browser-Module (helpers.js, elo.js, sync.js) in einen isolierten Kontext,
// damit sie ohne Browser und ohne Firebase getestet werden können.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadApp (files = ['helpers.js', 'elo.js', 'sync.js']) {
  const toasts = [];
  const ctx = { console, structuredClone, setTimeout, clearTimeout };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
  ctx.Helpers.showToast = msg => toasts.push(msg);
  ctx.toasts = toasts;
  return ctx;
}

// Kleiner, synthetischer Datenbestand
export function sampleData () {
  const drivers = [1, 2, 3, 4].map(i => ({ id: i, name: `Fahrer ${i}`, elo: 1000, races: 0, wins: 0, totalRounds: 0 }));
  const cars    = [11, 12, 13, 14].map(i => ({ id: i, name: `Auto ${i}`, elo: 1000, races: 0, wins: 0, totalRounds: 0 }));
  const race = (id, date, time, rounds, order) => ({
    id, date, time, rounds,
    results: order.map(([d, c], idx) => ({ position: idx + 1, driverId: d, carId: c, driverName: `Fahrer ${d}`, carName: `Auto ${c}` }))
  });
  const races = [
    race(100, '01.01.2026', '20:00', 60, [[1, 11], [2, 12], [3, 13]]),
    race(101, '01.01.2026', '20:30', 40, [[2, 14], [1, 12]]),
    race(102, '02.01.2026', '19:00', 75, [[3, 11], [4, 13], [1, 14], [2, 12]]),
    race(103, '05.01.2026', '21:00', 20, [[4, 12], [3, 11]])
  ];
  return { drivers, cars, races };
}
