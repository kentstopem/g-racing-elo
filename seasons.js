// seasons.js – Saisons und Strecken
//
// • Eine Saison hat Name, Startdatum (YYYY-MM-DD) und Strecke.
// • Ein Rennen gehört zu der Saison mit dem spätesten Startdatum ≤ Renndatum.
//   (Keine Felder an Rennen nötig – bestehende Daten bleiben unverändert.)
// • Ein Rekord gehört zur Strecke seiner Saison (bzw. zu rec.trackId, falls gesetzt).
// • Gibt es noch keine Saison in der Datenbank, gilt eine implizite Saison für alles.

(function () {
  const SELECT_KEY = 'selectedSeason';
  const ALL = 'all';
  const IMPLICIT = { id: 'implicit', name: 'Aktuell', start: '1970-01-01', trackId: null };

  let seasons = [];  // sortiert nach Start aufsteigend
  let tracks = [];
  let selected = null;
  try { selected = localStorage.getItem(SELECT_KEY); } catch (e) {}

  const startTs = s => new Date(`${s.start}T00:00:00`).getTime();
  const raceTs = r => window.Helpers.tsForRace(r);
  // Rekord-Datum ist ISO (YYYY-MM-DD)
  const recordTs = rec => new Date(`${rec.date || '1970-01-01'}T12:00:00`).getTime();

  function setData (seasonDocs = [], trackDocs = []) {
    seasons = [...seasonDocs].sort((a, b) => startTs(a) - startTs(b));
    tracks = [...trackDocs];
    if (selected && selected !== ALL && !seasons.some(s => s.id === selected)) selected = null;
  }

  const list = () => (seasons.length ? seasons : [IMPLICIT]);
  const current = () => list()[list().length - 1];

  function seasonAt (ts) {
    const l = list();
    let found = l[0];
    for (const s of l) if (startTs(s) <= ts) found = s;
    return found;
  }

  const seasonOfRace = race => seasonAt(raceTs(race)).id;
  const selectedId = () => selected || current().id;
  const isAll = () => selectedId() === ALL;
  const selectedSeason = () => (isAll() ? null : list().find(s => s.id === selectedId()) || current());

  function select (id) {
    selected = id === current().id ? null : id; // aktuelle Saison = Standard
    try { selected ? localStorage.setItem(SELECT_KEY, selected) : localStorage.removeItem(SELECT_KEY); } catch (e) {}
  }

  const track = id => tracks.find(t => t.id === id) || null;
  // Strecke der gewählten Ansicht (bei „Alle Saisons“: aktuelle Strecke)
  const viewTrackId = () => (selectedSeason() || current()).trackId ?? null;
  const trackOfRecord = rec => rec.trackId ?? seasonAt(recordTs(rec)).trackId ?? null;

  const label = s => (s.id === IMPLICIT.id ? 'Aktuelle Saison' : `Saison ${s.name}`);

  window.Seasons = {
    ALL, IMPLICIT,
    setData, list, current, seasonAt, seasonOfRace,
    selectedId, selectedSeason, isAll, select,
    tracks: () => tracks, track, viewTrackId, trackOfRecord, label,
    hasSeasons: () => seasons.length > 0
  };
})();
