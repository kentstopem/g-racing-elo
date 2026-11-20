// workshop.js – Hauptmenü-Reiter „Werkstatt“: alle Fahrzeuge mit offenen Schäden, Filter nach Kategorie,
// Werkstatttagebuch je Fahrzeug aufklappbar. Für alle lesbar (Firestore ist öffentlich lesbar);
// nur der Admin markiert als repariert und trägt Schäden ein (Löschen nur im Fahrzeug-Dialog unter Setup).
(function () {
  const { escapeHtml: esc, icon } = window.Helpers;
  const D = () => window.Damage;
  const FILTER_KEY = 'workshopFilter';

  const filters = new Set();   // gewählt: none (ohne offenen Schaden) | crit (gesperrt) | ok (offen, aber fahrbereit); leer = alle, ODER-verknüpft
  const KINDS = { none: 'Ohne Schaden', crit: 'Kritisch', ok: 'Unkritisch' };
  const opened = new Set();    // aufgeklappte Fahrzeuge (bleiben beim Neuzeichnen offen)
  try {
    const f = JSON.parse(localStorage.getItem(FILTER_KEY) || '{}');
    const list = Array.isArray(f.filters) ? f.filters : (f.filter && f.filter !== 'all' ? [f.filter] : []);   // alte Form { filter }
    list.filter(k => k in KINDS).forEach(k => filters.add(k));   // alte Kategorie-Filter fallen weg
  } catch (e) {}
  const remember = () => { try { localStorage.setItem(FILTER_KEY, JSON.stringify({ filters: [...filters] })); } catch (e) {} };
  const isActive = k => filters.has(k);

  const cars = () => (window.appData?.cars || []);
  const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '–' : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }); };

  function badges (car) {
    const Dm = D(), open = Dm.openDamages(car);
    const byCat = {};
    open.forEach(d => { (byCat[d.category] = byCat[d.category] || []).push(d); });
    return Object.entries(byCat).map(([cat, list]) => {
      const crit = list.some(d => d.critical);
      return `<span class="dmg-badge ${crit ? 'crit' : 'warn'}" title="${esc(list.map(Dm.entryLabel).join(', '))}">${icon(cat === 'light' ? 'light-off' : 'alert')}${esc(Dm.categoryLabel(cat))}${list.length > 1 ? ' ×' + list.length : ''}</span>`;
    }).join(' ');   // gesperrt: Motor/Sensor sind schon tiefrot, kein extra Hinweis
  }

  function subline (car) {
    const Dm = D(), open = Dm.openDamages(car), all = Dm.list(car);
    if (open.length) {
      const oldest = open.map(d => d.at).sort()[0];
      return `${open.length} offen${open.length === 1 ? 'er Schaden' : 'e Schäden'} · seit ${fmtDate(oldest)}`;
    }
    const fixed = all.filter(d => d.fixedAt).map(d => d.fixedAt).sort();
    return fixed.length ? `fahrbereit · zuletzt repariert ${fmtDate(fixed[fixed.length - 1])}` : 'fahrbereit · keine Einträge';
  }

  function render () {
    const root = document.getElementById('workshopRoot');
    if (!root || !D()) return;
    const Dm = D();
    const all = cars();
    const withOpen = all.filter(c => Dm.openDamages(c).length);
    const matches = (c, k) => (k === 'none' ? !Dm.openDamages(c).length : k === 'crit' ? Dm.isLocked(c) : !Dm.isLocked(c) && Dm.openDamages(c).length > 0);
    const base = all.filter(c => !c.archived || Dm.openDamages(c).length);   // „Alle“ = wirklich alle Fahrzeuge (archivierte nur mit offenem Schaden)
    const count = k => base.filter(c => matches(c, k)).length;
    const shown = base.filter(c => !filters.size || [...filters].some(k => matches(c, k)))
      .sort((a, b) => (Dm.isLocked(b) - Dm.isLocked(a)) || (Dm.openDamages(b).length - Dm.openDamages(a).length)
        || a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
    const locked = withOpen.filter(Dm.isLocked).length;

    root.innerHTML = `
      <div class="ws-tools">
        <div class="dmg-filter" role="group" aria-label="Schäden filtern">
          ${Object.entries(KINDS).map(([k, l]) => {
            const n = count(k), crit = k === 'crit';   // nichts gewählt = alle Fahrzeuge
            return `<button type="button" class="dmg-chip${isActive(k) ? ' active' : ''}${crit ? ' crit' : ''}${k === 'none' ? ' none' : ''}" data-wsfilter="${k}" aria-pressed="${isActive(k)}">${esc(l)}${n ? ` <span class="dmg-chip-n">${n}</span>` : ''}</button>`;
          }).join('')}
        </div>
      </div>
      <p class="ws-summary">${withOpen.length ? `<strong>${withOpen.length}</strong> Fahrzeug${withOpen.length === 1 ? '' : 'e'} mit offenen Schäden${locked ? ` · <strong class="ws-locked">${locked}</strong> gesperrt` : ''}` : 'Alle Fahrzeuge sind fahrbereit.'}
</p>
      <div class="ws-list">${shown.map(c => `
        <details class="ws-car${Dm.isLocked(c) ? ' is-locked' : ''}" data-id="${esc(String(c.id))}" ${opened.has(String(c.id)) ? 'open' : ''}>
          <summary>
            <span class="ws-img"><img alt="" data-wsimg="${esc(String(c.id))}" hidden></span>
            <span class="ws-head"><strong>${esc(c.name)}</strong>${c.archived ? ' <span class="status-inactive">archiviert</span>' : ''} ${badges(c)}
              <small class="muted">${subline(c)}</small></span>
            <span class="ws-chev" aria-hidden="true"></span>
          </summary>
          <div class="ws-body"></div>
        </details>`).join('') || `<p class="dmg-empty" style="text-align:center;">${!filters.size ? 'Keine Fahrzeuge.' : `Keine Fahrzeuge (${esc([...filters].map(k => KINDS[k]).join(' / '))}).`}</p>`}
      </div>`;

    // aufgeklappte Fahrzeuge: Schäden + Tagebuch (Admin: reparieren / eintragen, sonst nur lesen)
    root.querySelectorAll('details.ws-car[open]').forEach(fill);
    // Bilder (eigenes Bild oder Standardbild zur Startnummer)
    root.querySelectorAll('img[data-wsimg]').forEach(img => {
      const car = all.find(c => String(c.id) === img.dataset.wsimg);
      const fallback = window.SetupUI?.carAssetSrc?.(car);
      const show = src => { if (src) { img.src = src; img.hidden = false; img.onerror = () => { img.hidden = true; }; } };
      if (car?.imageRev && window.SetupUI?.carImageSrc) window.SetupUI.carImageSrc(car).then(show).catch(() => show(fallback));
      else show(fallback);
    });

    if (!root._bound) {
      root._bound = true;
      root.addEventListener('click', e => {
        const b = e.target.closest('[data-wsfilter]');
        if (!b) return;
        const k = b.dataset.wsfilter;
        if (filters.has(k)) filters.delete(k);
        else filters.add(k);
        remember(); render();
      });
      root.addEventListener('toggle', e => {
        const d = e.target.closest?.('details.ws-car');
        if (!d || e.target !== d) return;   // Tagebuch-Klappe im Auto zählt nicht als Auto auf/zu
        if (d.open) d.querySelectorAll('details.dmg-diary[open]').forEach(x => { x.open = false; });   // Tagebuch beim Öffnen des Autos immer zu
        if (d.open) { opened.add(d.dataset.id); fill(d); } else opened.delete(d.dataset.id);
      }, true);
      // Admin hat repariert/eingetragen: Kopfzeile + Zähler aktualisieren, Tagebuch bleibt offen
      root.addEventListener('damages-changed', () => setTimeout(render));
    }
  }

  function fill (det) {
    const body = det.querySelector('.ws-body');
    if (!body || body.dataset.filled) return;
    const car = cars().find(c => String(c.id) === det.dataset.id);
    if (!car || !window.SetupUI?.damageSection) return;
    body.dataset.filled = '1';
    window.SetupUI.damageSection(body, car.id, { readOnly: !window.isAdmin, noDelete: true, detailsLink: true });
  }

  window.WorkshopUI = { render };
})();
