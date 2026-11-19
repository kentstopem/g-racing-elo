// damage.js – Schadenserfassung und Werkstatttagebuch der Fahrzeuge (reine Funktionen, ohne Firebase testbar)
//
// Datenmodell: im Fahrzeug-Dokument cars/{id} als Array (keine neue Collection, Firestore-Regeln unverändert)
//   damages: [{ id, type, category, critical, at (ISO), note, context ('Training'|'Quali'|'Rennen'|'Setup'),
//               raceId?, lapsAtDamage?, fixedAt (ISO | null), fixNote?, lapsAtFix? }]
//   lapsAtDamage / lapsAtFix: gefahrene Runden des Fahrzeugs (Rennen + Training) zu diesem Zeitpunkt –
//   daraus ergibt sich „Runden seit letzter Reparatur“, auch mit Trainingsrunden.
//
// Sperre: Ein Fahrzeug mit offenem kritischen Schaden (Motor, Sensor) ist gesperrt. Das wird immer aus
// den Schäden berechnet und ist unabhängig von „aktiv“/„archiviert“ – nach der Reparatur gilt wieder der alte Zustand.
(function () {
  const CATEGORIES = Object.freeze({
    light:  { key: 'light',  label: 'Licht',  critical: false },
    motor:  { key: 'motor',  label: 'Motor',  critical: true },
    sensor: { key: 'sensor', label: 'Sensor', critical: true },
    other:  { key: 'other',  label: 'Sonstige', critical: null }   // kritisch je Eintrag (Schalter)
  });

  const TYPES = Object.freeze([
    { key: 'light_fl', label: 'Licht vorne links',  category: 'light',  critical: false },
    { key: 'light_fr', label: 'Licht vorne rechts', category: 'light',  critical: false },
    { key: 'light_rl', label: 'Licht hinten links', category: 'light',  critical: false },
    { key: 'light_rr', label: 'Licht hinten rechts', category: 'light', critical: false },
    { key: 'motor',    label: 'Motor',              category: 'motor',  critical: true },
    { key: 'sensor',   label: 'Sensor',             category: 'sensor', critical: true },
    // Sonstige: Beschreibung ist Pflicht, „kritisch“ wird beim Eintragen gewählt (sperrt dann wie Motor/Sensor)
    { key: 'other',    label: 'Sonstige',           category: 'other',  critical: false, custom: true }
  ]);

  const type = key => TYPES.find(t => t.key === key) || null;
  const typeLabel = key => type(key)?.label ?? String(key ?? '?');
  const categoryLabel = key => CATEGORIES[key]?.label ?? String(key ?? '?');
  /** Bezeichnung eines Eintrags: bei „Sonstige“ die Beschreibung */
  const entryLabel = d => (type(d?.type)?.custom && d.note ? `Sonstige: ${d.note}` : typeLabel(d?.type));

  const list = car => (Array.isArray(car?.damages) ? car.damages : []);
  const isOpen = d => !!d && !d.fixedAt;
  const openDamages = car => list(car).filter(isOpen);
  const openCritical = car => openDamages(car).filter(d => d.critical);
  /** Gesperrt = mindestens ein offener kritischer Schaden */
  const isLocked = car => openCritical(car).length > 0;

  const newId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const iso = at => (at instanceof Date ? at : at ? new Date(at) : new Date()).toISOString();

  /**
   * Neuer Schaden → neues Array (das alte bleibt unverändert).
   * Derselbe Schaden (gleiche Art) wird nicht doppelt offen eingetragen: dann bleibt das Array gleich.
   */
  function addDamage (car, { type: key, note = '', critical = false, at, context = null, raceId = null, lapsAtDamage = null } = {}) {
    const t = type(key);
    if (!t) throw new Error(`Unbekannte Schadensart: ${key}`);
    const text = String(note || '').trim();
    if (t.custom && !text) throw new Error('Bei „Sonstige“ bitte den Schaden beschreiben');
    const cur = list(car);
    // „Sonstige“ darf mehrfach offen sein (verschiedene Beschreibungen), nur nicht exakt gleich
    if (cur.some(d => isOpen(d) && d.type === key && (!t.custom || d.note === text))) return { damages: cur, entry: null, duplicate: true };
    const entry = {
      id: newId(), type: t.key, category: t.category, critical: t.custom ? !!critical : t.critical,
      at: iso(at), note: text, context: context || null,
      raceId: raceId ?? null, lapsAtDamage: Number.isFinite(lapsAtDamage) ? lapsAtDamage : null,
      fixedAt: null
    };
    return { damages: [...cur, entry], entry, duplicate: false };
  }

  /** Schaden als repariert markieren → neues Array */
  function fixDamage (car, id, { at, note = '', lapsAtFix = null } = {}) {
    return list(car).map(d => d.id !== id || !isOpen(d) ? d : {
      ...d, fixedAt: iso(at), fixNote: String(note || '').trim(),
      lapsAtFix: Number.isFinite(lapsAtFix) ? lapsAtFix : null
    });
  }

  /** Versehentlich eingetragenen Schaden entfernen → neues Array */
  const removeDamage = (car, id) => list(car).filter(d => d.id !== id);

  /** Reparatur zurücknehmen (wieder offen) → neues Array */
  const reopenDamage = (car, id) => list(car).map(d => d.id !== id ? d : { ...d, fixedAt: null, fixNote: '', lapsAtFix: null });

  /** Werkstatttagebuch: neueste zuerst (nach Schadenszeitpunkt) */
  const journal = car => [...list(car)].sort((a, b) => String(b.at).localeCompare(String(a.at)));

  /** Kurzüberblick für Badges: offene Schäden, davon kritisch, offene Kategorien */
  function summary (car) {
    const open = openDamages(car);
    return {
      open: open.length,
      critical: open.filter(d => d.critical).length,
      categories: [...new Set(open.map(d => d.category))],
      locked: open.some(d => d.critical)
    };
  }

  /** Filter „Alle / Licht / Motor / Sensor“: hat das Fahrzeug offene Schäden dieser Kategorie? */
  const hasOpenCategory = (car, cat) => (cat === 'all' || !cat) ? true : openDamages(car).some(d => d.category === cat);

  /**
   * Statistik aus Werkstatttagebuch + Rennen.
   * totalLaps: aktuelle Rundenzahl (Rennen + Training, z. B. aus MasterData.carTotals – zählt nach Autotausch je Fahrzeug).
   * races/tsForRace: für ältere Reparaturen ohne lapsAtFix (Runden der Rennen nach der Reparatur).
   */
  function stats (car, { totalLaps = 0, races = [], tsForRace = null, carId = car?.id } = {}) {
    const all = list(car);
    const fixed = all.filter(d => d.fixedAt).sort((a, b) => String(a.fixedAt).localeCompare(String(b.fixedAt)));
    const last = fixed[fixed.length - 1] || null;
    let lapsSinceRepair = null;
    if (last) {
      if (Number.isFinite(last.lapsAtFix)) lapsSinceRepair = Math.max(0, totalLaps - last.lapsAtFix);
      else if (tsForRace) {
        const since = new Date(last.fixedAt).getTime();
        // Runden je Fahrzeug (results[i].carLaps nach Autotausch, sonst Renndistanz) – siehe MasterData.raceCarLaps
        const lapsIn = window.MasterData?.raceCarLaps
          || ((r, id) => ((r.results || []).some(res => res.carId === id) ? (r.rounds || 0) : null));
        lapsSinceRepair = races
          .filter(r => tsForRace(r) > since)
          .reduce((n, r) => n + (lapsIn(r, carId) || 0), 0);
      }
    }
    return {
      damages: all.length,
      open: all.filter(isOpen).length,
      repairs: fixed.length,
      lastRepairAt: last?.fixedAt ?? null,
      lapsSinceRepair,
      per100Laps: totalLaps > 0 ? all.length / totalLaps * 100 : null
    };
  }

  /**
   * Ersatzauto-Vorschlag nach kritischem Schaden: genau EIN Fahrzeug – das freie, nicht gesperrte, aktive
   * Auto, dessen aktuelle G!RP am nächsten an der G!RP des beschädigten Autos liegt.
   * Gleichstand (deterministisch): weniger Rennen, dann Name, dann id.
   * exclude: ids, die schon vergeben sind (andere Regler); isActive: wie Elo.isActive (Standard: nicht archiviert, „aktiv“).
   */
  function suggestReplacement (damaged, cars = [], { exclude = [], isActive = c => !!c && !c.archived && !c.hideFromRanking } = {}) {
    const same = (a, b) => a != null && b != null && String(a) === String(b);
    const ref = Number.isFinite(+damaged?.elo) ? +damaged.elo : 1000;
    const girp = c => (Number.isFinite(+c?.elo) ? +c.elo : 1000);
    const pool = (cars || []).filter(c => c && !same(c.id, damaged?.id) && !exclude.some(x => same(x, c.id)) && isActive(c) && !isLocked(c));
    pool.sort((a, b) => Math.abs(girp(a) - ref) - Math.abs(girp(b) - ref)
      || (a.races || 0) - (b.races || 0)
      || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'de')
      || String(a.id).localeCompare(String(b.id)));
    return pool[0] || null;
  }

  window.Damage = {
    CATEGORIES, TYPES, type, typeLabel, categoryLabel, entryLabel,
    list, isOpen, openDamages, openCritical, isLocked, summary, hasOpenCategory,
    addDamage, fixDamage, removeDamage, reopenDamage, journal, stats, suggestReplacement
  };
})();
