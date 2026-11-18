// halloffame.js – Ruhmeshalle: Endstand und Höhepunkte jeder abgeschlossenen Saison
//
// Alles wird aus der Renn-Historie berechnet (keine eigenen Daten in Firestore).
// Abgeschlossen = jede Saison außer der aktuellen (eine neue Saison beendet die vorige).
(function () {
  const esc = s => window.Helpers.escapeHtml(s);
  const ic = n => window.Helpers.icon(n);
  const num = n => Number(n).toLocaleString('de-DE');
  const sec = t => `${t.toFixed(3).replace('.', ',')} s`;
  const deIso = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${+m[3]}.${+m[2]}.${m[1]}` : ''; };

  /** Saisonbilanz für alle abgeschlossenen Saisons, neueste zuerst. */
  function compute (raw) {
    const S = window.Seasons, E = window.Elo;
    if (!S.hasSeasons() || S.list().length < 2) return [];
    const calc = structuredClone({ drivers: raw.drivers, cars: raw.cars, races: raw.races });
    const per = E.recomputeSeasons(calc, S.seasonOfRace);
    const curId = S.current().id;
    const dName = id => raw.drivers.find(d => d.id === id)?.name || '?';
    const cName = id => raw.cars.find(c => c.id === id)?.name || '?';

    return S.list().filter(s => s.id !== curId && per.has(s.id)).reverse().map(season => {
      const st = per.get(season.id);
      const races = E.sortChronologically(calc.races.filter(r => S.seasonOfRace(r) === season.id));
      const rank = list => list.filter(x => x.races > 0).sort((a, b) => (b.elo - a.elo) || (b.wins - a.wins) || (b.races - a.races));
      const drivers = rank(st.drivers), cars = rank(st.cars);

      // Höhepunkte aus den einzelnen Ergebnissen
      let jump = null, peak = null;
      const streak = new Map(), duo = new Map();
      for (const r of races) {
        for (const res of r.results || []) {
          if (res.driverEloChange != null && (!jump || res.driverEloChange > jump.v)) jump = { v: res.driverEloChange, who: dName(res.driverId), car: cName(res.carId), date: r.date };
          if (res.newDriverElo != null && (!peak || res.newDriverElo > peak.v)) peak = { v: res.newDriverElo, who: dName(res.driverId), date: r.date };
          const s = streak.get(res.driverId) || { cur: 0, max: 0 };
          s.cur = res.position === 1 ? s.cur + 1 : 0; s.max = Math.max(s.max, s.cur);
          streak.set(res.driverId, s);
          const k = `${res.driverId}|${res.carId}`;
          const p = duo.get(k) || { d: res.driverId, c: res.carId, n: 0, w: 0 };
          p.n++; if (res.position === 1) p.w++;
          duo.set(k, p);
        }
      }
      const bestStreak = [...streak.entries()].sort((a, b) => b[1].max - a[1].max)[0];
      const bestDuo = [...duo.values()].sort((a, b) => (b.w - a.w) || (a.n - b.n))[0];
      const byWins = [...drivers].sort((a, b) => (b.wins - a.wins) || (a.races - b.races))[0];
      const byRaces = [...drivers].sort((a, b) => (b.races - a.races) || (b.totalRounds - a.totalRounds))[0];
      const lap = (raw.lapRecords || [])
        .filter(rec => S.trackOfRecord(rec) === season.trackId && S.seasonAt(new Date(`${rec.date}T12:00:00`).getTime()).id === season.id)
        .sort((a, b) => a.time - b.time)[0];

      const highlights = [
        byWins && { icon: 'trophy', title: 'Meiste Siege', value: num(byWins.wins), who: byWins.name, sub: `in ${byWins.races} Rennen` },
        bestStreak && bestStreak[1].max > 1 && { icon: 'flag', title: 'Längste Siegesserie', value: `${bestStreak[1].max} in Folge`, who: dName(bestStreak[0]) },
        peak && { icon: 'chart', title: 'Höchster G!RP-Wert', value: num(peak.v), who: peak.who, sub: peak.date },
        jump && { icon: 'refresh', title: 'Größter Sprung', value: `+${jump.v} G!RP`, who: jump.who, sub: `${jump.car} · ${jump.date}` },
        bestDuo && bestDuo.w > 0 && { icon: 'car', title: 'Erfolgreichstes Duo', value: `${bestDuo.w} Siege`, who: dName(bestDuo.d), sub: `mit ${cName(bestDuo.c)} · ${bestDuo.n} Rennen` },
        byRaces && { icon: 'driver', title: 'Dauerbrenner', value: `${byRaces.races} Rennen`, who: byRaces.name, sub: `${num(byRaces.totalRounds)} Runden` }
      ].filter(Boolean);

      return {
        season, track: S.track(season.trackId),
        from: races[0]?.date, to: races.at(-1)?.date,
        raceCount: races.length, laps: races.reduce((n, r) => n + (r.rounds || 0), 0),
        drivers, cars, highlights,
        lap: lap && { time: lap.time, who: dName(lap.driverId), car: cName(lap.carId), date: deIso(lap.date) }
      };
    });
  }

  // ---------- Darstellung ----------
  const places = { first: 1, second: 2, third: 3 };
  function podium (list, kind) {
    if (list.length < 3) return '';
    return `<div class="podium hof-podium">${[[1, 'second'], [0, 'first'], [2, 'third']].map(([i, cls]) => {
      const x = list[i];
      return `<div class="podium-item ${cls}" onclick="openEloModal('${kind}',${x.id})">
        <div class="podium-position">${places[cls]}</div>
        <div class="podium-name">${esc(x.name)}</div>
        <div class="podium-elo">${x.elo} G!RP</div>
        <div class="hof-podium-meta">${x.races} R · ${x.wins} S</div>
      </div>`;
    }).join('')}</div>`;
  }

  function table (list, kind) {
    return `<details class="hof-table"><summary>Kompletter Endstand (${list.length})</summary>
      ${list.map((x, i) => `<div class="list-item" onclick="openEloModal('${kind}',${x.id})">
        <div><strong>#${i + 1} ${esc(x.name)}</strong><div>${x.races} Rennen · ${x.wins} Siege · ${num(x.totalRounds)} Runden</div></div>
        <span class="elo-score">${x.elo}</span></div>`).join('')}
    </details>`;
  }

  function seasonCard (h, tab) {
    const champ = h.drivers[0], champCar = h.cars[0];
    return `<section class="hof-season card">
      <div class="hof-head">
        <div>
          <div class="hof-title">Saison ${esc(h.season.name)}</div>
          <div class="hof-meta">${esc(h.track?.name || '')}${h.from ? ` · ${esc(h.from)} – ${esc(h.to)}` : ''}</div>
        </div>
        <div class="hof-count"><strong>${num(h.raceCount)}</strong> Rennen<br><strong>${num(h.laps)}</strong> Runden</div>
      </div>
      ${champ ? `<div class="hof-champs">
        <div class="hof-champ">${ic('trophy')}<div><span>Meister</span><strong>${esc(champ.name)}</strong><em>${champ.elo} G!RP</em><small>${champ.races} Rennen · ${champ.wins} Siege</small></div></div>
        ${champCar ? `<div class="hof-champ">${ic('car')}<div><span>Meister-Fahrzeug</span><strong>${esc(champCar.name)}</strong><em>${champCar.elo} G!RP</em><small>${champCar.races} Rennen · ${champCar.wins} Siege</small></div></div>` : ''}
        ${h.lap ? `<div class="hof-champ hof-champ-wide">${ic('timer')}<div><span>Streckenrekord · ${sec(h.lap.time)}</span><strong>${esc(h.lap.who)}</strong><em class="hof-champ-car">${esc(h.lap.car)} · ${esc(h.lap.date)}</em></div></div>` : ''}
      </div>` : ''}
      <div class="sub-nav hof-tabs" data-season="${esc(h.season.id)}">
        <button class="sub-tab ${tab === 'driver' ? 'active' : ''}" data-hof="driver">${ic('driver')}Fahrer</button>
        <button class="sub-tab ${tab === 'car' ? 'active' : ''}" data-hof="car">${ic('car')}Fahrzeuge</button>
      </div>
      ${tab === 'driver' ? podium(h.drivers, 'driver') + table(h.drivers, 'driver') : podium(h.cars, 'car') + table(h.cars, 'car')}
      <h4 class="hof-sub">Höhepunkte</h4>
      <div class="hof-grid">${h.highlights.map(x => `<div class="hof-tile">
        <div class="hof-tile-title">${ic(x.icon)}${esc(x.title)}</div>
        <div class="hof-tile-value">${esc(x.value)}</div>
        <div class="hof-tile-who">${esc(x.who)}</div>
        ${x.sub ? `<div class="hof-tile-sub">${esc(x.sub)}</div>` : ''}
      </div>`).join('')}</div>
    </section>`;
  }

  const tabs = {};
  function render (el, raw) {
    if (!el) return;
    const list = compute(raw);
    el.innerHTML = `<div class="ranking-header">${ic('crown')}Ruhmeshalle</div>` + (list.length
      ? list.map(h => seasonCard(h, tabs[h.season.id] || 'driver')).join('')
      : '<p class="empty-state">Hier erscheinen die Sieger, sobald die erste Saison abgeschlossen ist.</p>');
    el.querySelectorAll('.hof-tabs .sub-tab').forEach(b => b.onclick = () => {
      tabs[b.parentElement.dataset.season] = b.dataset.hof;
      render(el, raw);
    });
  }

  window.HallOfFame = { compute, render };
})();
