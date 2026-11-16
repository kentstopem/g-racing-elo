// setup-ui.js – Stammdaten bearbeiten (Fahrer, Fahrzeuge, Strecken) und zentraler Setup-Bereich
// (Renneinstellungen). Alles hinter dem Feature Flag "live" und nur für den Admin –
// ohne Flag sieht und verhält sich die App wie bisher.
(function () {
  const { showToast, escapeHtml: esc, icon } = window.Helpers;
  const M = window.MasterData;
  const FLAG = 'live';
  const enabled = () => window.isAdmin && window.Helpers.feature(FLAG);

  const MAX_MEDIA_CHARS = 900 * 1024;   // Firestore-Dokumente dürfen max. 1 MB groß sein
  const parseNum = v => { const n = parseFloat(String(v ?? '').trim().replace(',', '.')); return Number.isFinite(n) ? n : null; };
  const fmtNum = (v, digits = 2) => (v == null ? '' : String(+Number(v).toFixed(digits)).replace('.', ','));
  const del = () => firebase.firestore.FieldValue.delete();

  function persist (promise, ok) {
    return promise.then(() => { if (ok) showToast(ok); })
      .catch(err => { console.error('Speicherfehler:', err); showToast('Speichern fehlgeschlagen – Verbindung prüfen!', { icon: 'alert' }); throw err; });
  }

  // ---------- Medien (Bilder, Töne) ----------

  function readAsDataUrl (file) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  }

  // Bild verkleinern; mit Transparenz (Fahrzeuge) als WebP bzw. PNG, sonst JPEG
  async function imageToDataUrl (file, { max = 640, alpha = false } = {}) {
    const src = await readAsDataUrl(file);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    let w = img.naturalWidth, h = img.naturalHeight;
    const scale = Math.min(1, max / Math.max(w, h));
    w = Math.round(w * scale); h = Math.round(h * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    let out = alpha ? canvas.toDataURL('image/webp', 0.85) : canvas.toDataURL('image/jpeg', 0.82);
    if (alpha && !out.startsWith('data:image/webp')) out = canvas.toDataURL('image/png');
    for (let m = max; out.length > MAX_MEDIA_CHARS && m > 160; m = Math.round(m * 0.75)) {
      canvas.width = Math.round(w * m / max); canvas.height = Math.round(h * m / max);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      out = canvas.toDataURL(alpha ? 'image/png' : 'image/jpeg', 0.8);
    }
    return out;
  }

  const carNumber = car => /^\((\d+)\)/.exec(car?.name || '')?.[1] ?? null;
  const carAssetSrc = car => { const n = carNumber(car); return n ? `assets/cars/${String(n).padStart(2, '0')}.png` : null; };

  /** Bild eines Fahrzeugs: eigenes hochgeladenes Bild, sonst assets/cars/<Nummer>.png */
  async function carImageSrc (car) {
    if (car?.imageRev) {
      try { const m = await window.Storage.getMedia(`car_${car.id}`); if (m?.data) return m.data; } catch (e) { console.warn(e); }
    }
    return carAssetSrc(car);
  }
  async function trackImageSrc (track) {
    if (!track?.imageRev) return null;
    try { return (await window.Storage.getMedia(`track_${track.id}`))?.data ?? null; } catch (e) { return null; }
  }
  const driverVoiceSrc = driver => window.Voice.nameSrc(driver);

  // ---------- Bausteine ----------

  function controllerChip (n, { small = false } = {}) {
    const c = M.controller(n);
    if (!c) return '';
    return `<span class="ctrl-chip${small ? ' ctrl-chip-sm' : ''}" style="background:${c.color};color:${c.text}">${esc(c.name)}</span>`;
  }

  function tuningLabel (car) {
    const t = car?.tuning;
    if (!t) return '';
    return `Gas ${M.levelToPct(t.speed)} % · Bremse ${M.levelToPct(t.brake)} %`;
  }

  // ---------- Bearbeiten-Dialog ----------

  let modal = null;
  function openModal (title, bodyHtml) {
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'editModal';
      modal.className = 'modal hidden';
      modal.innerHTML = '<div class="modal-content edit-modal"><div class="modal-header"><h3 id="editModalTitle" style="margin:0;"></h3></div><div id="editModalBody"></div></div>';
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    }
    modal.querySelector('#editModalTitle').textContent = title;
    const body = modal.querySelector('#editModalBody');
    body.innerHTML = bodyHtml;
    modal.classList.remove('hidden');
    return body;
  }
  function closeModal () {
    window.Voice?.stop();
    modal?.classList.add('hidden');
    modal?.querySelectorAll('audio').forEach(a => a.pause());
  }
  const footer = (extra = '') => `<div class="edit-foot">${extra}<span style="flex:1"></span><button type="button" class="btn btn-modal" data-act="cancel">Abbrechen</button><button type="submit" class="btn btn-primary btn-modal">Speichern</button></div>`;

  // ---------- Fahrer ----------

  function editDriver (id) {
    const d = window.appData.drivers.find(x => x.id === id);
    if (!d) return;
    const others = n => window.appData.drivers.filter(x => x.id !== id && !x.archived && x.preferredController === n).map(x => x.name);
    const chips = [`<label class="ctrl-pick" title="keiner"><input type="radio" name="ctrl" value="" aria-label="keiner" ${d.preferredController ? '' : 'checked'}><span class="ctrl-swatch ctrl-none"></span></label>`]
      .concat(M.CONTROLLERS.map(c => `<label class="ctrl-pick" title="${c.name}"><input type="radio" name="ctrl" value="${c.n}" aria-label="${c.name}" ${d.preferredController === c.n ? 'checked' : ''}><span class="ctrl-swatch" style="background:${c.color}"></span></label>`)).join('');

    const body = openModal(d.name, `
      <form id="driverForm">
        <div class="form-group">
          <label for="drvName">Name</label>
          <input id="drvName" name="dname" value="${esc(d.name)}" required>
        </div>
        <div class="form-group">
          <label>Bevorzugter Controller: <strong id="ctrlName"></strong></label>
          <div class="ctrl-picks">${chips}</div>
          <p class="muted edit-note" id="ctrlNote"></p>
        </div>
        <div class="form-group">
          <label for="drvPron">Gesprochener Name</label>
          <div class="media-row">
            <input id="drvPron" name="pron" value="${esc(d.pronunciation || '')}" placeholder="${esc(d.name)}" style="flex:1;min-width:0;">
            <button type="button" class="btn btn-small" id="voicePlay" style="align-self:stretch;">Anhören</button>
          </div>
        </div>
        ${footer()}
      </form>`);

    const form = body.querySelector('#driverForm');
    const note = () => {
      const n = Number(form.ctrl.value) || null;
      const o = n ? others(n) : [];
      body.querySelector('#ctrlName').textContent = M.controller(n)?.name ?? 'keiner';
      body.querySelector('#ctrlNote').textContent = o.length ? `Auch bevorzugt von: ${o.join(', ')}. Beim Rennen bekommt ihn der zuerst gewählte Fahrer, die anderen erhalten einen freien Controller.` : '';
    };
    form.addEventListener('change', e => { if (e.target.name === 'ctrl') note(); });
    note();

    // „Anhören“: passt der gespeicherte Ton zur Schreibweise, wird er gespielt, sonst (mit Azure-Schlüssel)
    // neu erzeugt. Ein neu erzeugter Ton wird erst beim Speichern übernommen.
    let pending = null;   // { data, text }
    const pronText = () => form.pron.value.trim() || form.dname.value.trim() || d.name;
    form.dname.addEventListener('input', () => { form.pron.placeholder = form.dname.value.trim() || d.name; });
    const playBtn = body.querySelector('#voicePlay');
    playBtn.onclick = async () => {
      const cur = window.appData.drivers.find(x => x.id === id);
      const text = pronText();
      if (pending?.text === text) return window.Voice.playSources([pending.data]);
      if (window.Voice.savedText(cur) === text) {
        const src = await window.Voice.nameSrc(cur);
        if (src) return window.Voice.playSources([src]);
      }
      if (window.Voice.azureConfig()) {
        playBtn.disabled = true;
        try {
          pending = { data: await readAsDataUrl(await window.Voice.synthesize(text)), text };
          window.Voice.playSources([pending.data]);
        } catch (err) { showToast(err.message || 'Erzeugen fehlgeschlagen', { icon: 'alert' }); }
        finally { playBtn.disabled = false; }
        return;
      }
      const src = await window.Voice.nameSrc(cur);
      if (src) window.Voice.playSources([src]);
      showToast(src ? 'Gespeicherter Ton – für neue Schreibweise Sprach-Schlüssel eintragen' : 'Kein Ton – Sprach-Schlüssel fehlt (Setup → Renneinstellungen)', { icon: src ? undefined : 'alert' });
    };
    body.querySelector('[data-act="cancel"]').onclick = closeModal;
    form.onsubmit = e => {
      e.preventDefault();
      const ctrl = Number(form.ctrl.value) || null;
      const pron = form.pron.value.trim();
      const name = form.dname.value.trim();
      if (!name) { showToast('Bitte einen Namen eingeben!'); return; }
      if (window.appData.drivers.some(x => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) { showToast('Fahrer existiert bereits!'); return; }
      const fields = { name, preferredController: ctrl, pronunciation: pron || del() };
      const save = (async () => {
        const cur = window.appData.drivers.find(x => x.id === id);
        const text = pronText();
        // Noch kein eigener Ton oder Schreibweise geändert, aber nicht angehört → beim Speichern erzeugen
        if (pending?.text !== text && window.Voice.savedText(cur) !== text && window.Voice.azureConfig()) {
          try { pending = { data: await readAsDataUrl(await window.Voice.synthesize(text)), text }; } catch (err) { console.warn(err); }
        }
        if (pending?.text !== text) return;
        const v = window.Voice.voice();   // gespeichert wird in der gerade aktiven Stimme
        await window.Storage.setMedia(v.media(id), pending.data, 'audio/mpeg');
        fields[v.rev] = Date.now();
        fields[v.text] = pending.text;
      })();
      persist(save.then(() => window.Storage.updateDriverFields(id, fields)), 'Fahrer gespeichert').catch(() => {});
      window.Voice.stop();
      closeModal();
    };
  }

  // ---------- Fahrzeuge ----------

  function editCar (id) {
    const c = window.appData.cars.find(x => x.id === id);
    if (!c) return;
    const tot = M.carTotals(id, window.appData.allRaces || window.appData.races, c);
    const t = c.tuning || { speed: M.MAX_LEVEL, brake: M.MAX_LEVEL };
    const slider = (name, label, val) => `
      <div class="form-group tuning-row">
        <label for="tun_${name}">${label} <strong id="tunVal_${name}">${M.levelToPct(val)} %</strong> <span class="muted">(Stufe ${val})</span></label>
        <div class="tick-range" style="--pct:${val / M.MAX_LEVEL * 100}%">
          <div class="tick-track"><div class="tick-fill"></div>${Array.from({ length: M.MAX_LEVEL + 1 }, (_, i) => `<span class="tick${i <= val ? ' on' : ''}"></span>`).join('')}</div>
          <input type="range" class="level-range" id="tun_${name}" name="${name}" min="0" max="${M.MAX_LEVEL}" step="1" value="${val}">
        </div>
      </div>`;

    const body = openModal(c.name, `
      <form id="carForm">
        <div class="car-edit-top">
          <div class="media-preview" id="carImgBox"><span class="muted">Kein Bild</span></div>
          <div>
            <p class="car-stats"><strong>${tot.races}</strong> Rennen · <strong>${tot.laps}</strong> Runden gefahren${tot.practiceLaps ? ` <span class="muted">(davon ${tot.practiceLaps} im Training)</span>` : ''}</p>
            <div class="media-row">
              <label class="btn btn-small">Bild wählen<input type="file" id="carImgFile" accept="image/*" hidden></label>
              <button type="button" class="btn btn-small btn-danger" id="carImgDel" ${c.imageRev ? '' : 'disabled'}>Eigenes Bild entfernen</button>
            </div>
            <p class="muted edit-note">${carAssetSrc(c) ? 'Ohne eigenes Bild wird das Standardbild zur Startnummer verwendet.' : ''}</p>
          </div>
        </div>
        <div class="form-group" style="margin-top:12px;">
          <label class="check-label"><input type="checkbox" name="hasTuning" ${c.tuning ? 'checked' : ''}> Tuning festlegen (wird beim Rennen an die CU übertragen)</label>
        </div>
        <div id="tuningFields" class="${c.tuning ? '' : 'hidden'}">
          ${slider('speed', 'Gas (Höchstgeschwindigkeit)', t.speed)}
          ${slider('brake', 'Bremse', t.brake)}
        </div>
        ${footer()}
      </form>`);

    const form = body.querySelector('#carForm');
    const showImg = async car => {
      const src = await carImageSrc(car);
      body.querySelector('#carImgBox').innerHTML = src ? `<img src="${src}" alt="">` : '<span class="muted">Kein Bild</span>';
    };
    showImg(c);
    form.hasTuning.onchange = () => body.querySelector('#tuningFields').classList.toggle('hidden', !form.hasTuning.checked);
    ['speed', 'brake'].forEach(n => {
      form[n].oninput = () => {
        const box = form[n].closest('.tick-range');
        box.style.setProperty('--pct', `${form[n].value / M.MAX_LEVEL * 100}%`);
        box.querySelectorAll('.tick').forEach((t, i) => t.classList.toggle('on', i <= form[n].value));
        body.querySelector(`#tunVal_${n}`).textContent = `${M.levelToPct(form[n].value)} %`;
        body.querySelector(`#tunVal_${n}`).nextElementSibling.textContent = `(Stufe ${form[n].value})`;
      };
    });
    body.querySelector('#carImgFile').onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = await imageToDataUrl(file, { max: 640, alpha: true });
        await window.Storage.setMedia(`car_${id}`, data, data.slice(5, data.indexOf(';')));
        const rev = Date.now();
        await persist(window.Storage.updateCarFields(id, { imageRev: rev }), 'Bild gespeichert');
        showImg({ ...c, imageRev: rev });
        body.querySelector('#carImgDel').disabled = false;
      } catch (err) { console.error(err); showToast('Bild konnte nicht gespeichert werden', { icon: 'alert' }); }
    };
    body.querySelector('#carImgDel').onclick = async () => {
      if (!confirm('Eigenes Bild entfernen?')) return;
      await window.Storage.deleteMedia(`car_${id}`).catch(console.error);
      await persist(window.Storage.updateCarFields(id, { imageRev: del() }), 'Bild entfernt');
      showImg({ ...c, imageRev: null });
      body.querySelector('#carImgDel').disabled = true;
    };
    body.querySelector('[data-act="cancel"]').onclick = closeModal;
    form.onsubmit = e => {
      e.preventDefault();
      const tuning = form.hasTuning.checked ? { speed: M.clampLevel(form.speed.value), brake: M.clampLevel(form.brake.value) } : del();
      persist(window.Storage.updateCarFields(id, { tuning }), 'Fahrzeug gespeichert');
      closeModal();
    };
  }

  // ---------- Strecken ----------

  const ms = v => `${Math.round(v)} ms`;
  const parseMs = v => { const n = Math.round(parseNum(v)); return n > 0 ? n : null; };

  function fuelExample (track, settings) {
    const t = M.trackSetup(track);
    const laps = M.raceSettings(settings).fullTankLaps;
    if (!t.refLapMs) return `Voller Tank reicht für ${laps} Runden (aus den Renneinstellungen). Mit Referenz-Rundenzeit hängt der Verbrauch vom Tempo ab.`;
    const fast = t.refLapMs * 0.95, slow = t.refLapMs * 1.05;
    return `Voller Tank (laut Renneinstellungen): ${laps} Runden bei ${ms(t.refLapMs)} · ` +
      `${fmtNum(M.lapsPerTank(fast, track, settings), 1)} Runden bei ${ms(fast)} (5 % schneller) · ` +
      `${fmtNum(M.lapsPerTank(slow, track, settings), 1)} Runden bei ${ms(slow)} (5 % langsamer)`;
  }

  function editTrack (id) {
    const isNew = !id;
    const tr = isNew ? { name: '', short: '' } : window.Seasons.track(id);
    if (!tr) return;
    const t = M.trackSetup(tr);
    const body = openModal(isNew ? 'Neue Strecke' : tr.name, `
      <form id="trackForm">
        <div class="race-meta-grid" style="grid-template-columns:2fr 1fr;">
          <div class="form-group"><label for="trName">Name</label><input id="trName" name="name" value="${esc(tr.name)}" required></div>
          <div class="form-group"><label for="trShort">Kürzel</label><input id="trShort" name="short" maxlength="6" value="${esc(tr.short || '')}"></div>
        </div>
        <div class="race-meta-grid" style="grid-template-columns:1fr 1fr;">
          <div class="form-group"><label for="trOuter">Länge Außenbahn (m)</label><input id="trOuter" name="outer" inputmode="decimal" value="${fmtNum(t.lengthOuterM)}" placeholder="z. B. 18,86"></div>
          <div class="form-group"><label for="trInner">Länge Innenbahn (m)</label><input id="trInner" name="inner" inputmode="decimal" value="${fmtNum(t.lengthInnerM)}" placeholder="z. B. 17,73"></div>
        </div>
        <div class="race-meta-grid" style="grid-template-columns:1fr 1fr;">
          <div class="form-group"><label for="trRef">Referenz-Rundenzeit (ms)</label><input id="trRef" name="ref" type="number" inputmode="numeric" min="0" step="1" value="${t.refLapMs ?? ''}" placeholder="z. B. 6500"></div>
          <div class="form-group"><label for="trMin">Minimale Rundenzeit (ms)</label><input id="trMin" name="min" type="number" inputmode="numeric" min="0" step="1" value="${t.minLapMs ?? ''}" placeholder="z. B. 4500"></div>
        </div>
        <p class="muted edit-note" style="margin-top:-8px;">Durchfahrten, die schneller als die minimale Rundenzeit sind (z. B. nach einer Unterbrechung nahe Start/Ziel), werden in Training, Quali und Rennen ignoriert.</p>
        <p class="muted edit-note" id="fuelExample" style="margin-bottom:16px;"></p>
        ${isNew ? '' : `
        <div class="form-group">
          <label>Bild der Strecke</label>
          <div class="media-preview media-preview-wide" id="trImgBox"><span class="muted">Kein Bild</span></div>
          <div class="media-row" style="margin-top:8px;">
            <label class="btn btn-small">Bild wählen<input type="file" id="trImgFile" accept="image/*" hidden></label>
            <button type="button" class="btn btn-small btn-danger" id="trImgDel" ${tr.imageRev ? '' : 'disabled'}>Entfernen</button>
          </div>
        </div>`}
        ${footer()}
      </form>`);

    const form = body.querySelector('#trackForm');
    const values = () => ({
      lengthOuterM: parseNum(form.outer.value),
      lengthInnerM: parseNum(form.inner.value),
      refLapMs: parseMs(form.ref.value),
      minLapMs: parseMs(form.min.value)
    });
    const example = () => { body.querySelector('#fuelExample').textContent = fuelExample(values(), window.appData.raceSettings); };
    form.addEventListener('input', example);
    example();

    if (!isNew) {
      const showImg = async rev => {
        const src = await trackImageSrc({ ...tr, imageRev: rev });
        body.querySelector('#trImgBox').innerHTML = src ? `<img src="${src}" alt="">` : '<span class="muted">Kein Bild</span>';
      };
      showImg(tr.imageRev);
      body.querySelector('#trImgFile').onchange = async e => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const data = await imageToDataUrl(file, { max: 1280 });
          await window.Storage.setMedia(`track_${id}`, data, 'image/jpeg');
          const rev = Date.now();
          await persist(window.Storage.updateTrackFields(id, { imageRev: rev }), 'Bild gespeichert');
          showImg(rev);
          body.querySelector('#trImgDel').disabled = false;
        } catch (err) { console.error(err); showToast('Bild konnte nicht gespeichert werden', { icon: 'alert' }); }
      };
      body.querySelector('#trImgDel').onclick = async () => {
        if (!confirm('Bild der Strecke entfernen?')) return;
        await window.Storage.deleteMedia(`track_${id}`).catch(console.error);
        await persist(window.Storage.updateTrackFields(id, { imageRev: del() }), 'Bild entfernt');
        showImg(null);
        body.querySelector('#trImgDel').disabled = true;
      };
    }
    body.querySelector('[data-act="cancel"]').onclick = closeModal;
    form.onsubmit = e => {
      e.preventDefault();
      const name = form.name.value.trim();
      if (!name) { showToast('Namen angeben'); return; }
      const v = values();
      if (isNew) {
        if (window.Seasons.tracks().some(x => x.name.toLowerCase() === name.toLowerCase())) { showToast('Diese Strecke gibt es schon'); return; }
        const track = { id: `t${Date.now()}`, name, short: form.short.value.trim() || null, createdAt: new Date().toISOString() };
        Object.entries(v).forEach(([k, val]) => { if (val != null) track[k] = val; });
        persist(window.Storage.addTrack(track), 'Strecke angelegt');
      } else {
        const fields = { name, short: form.short.value.trim() || null };
        Object.entries(v).forEach(([k, val]) => { fields[k] = val ?? del(); });
        persist(window.Storage.updateTrackFields(id, fields), 'Strecke gespeichert');
      }
      closeModal();
    };
  }

  // ---------- Setup-Bereich ----------

  let tab = 'tracks';

  function renderTracks (el) {
    const S = window.Seasons;
    const cur = S.current().trackId;
    const rows = S.tracks().map(tr => {
      const t = M.trackSetup(tr);
      const seasons = S.list().filter(s => s.trackId === tr.id).map(s => s.name);
      const bits = [
        t.lengthOuterM != null || t.lengthInnerM != null ? `${fmtNum(t.lengthOuterM) || '–'} / ${fmtNum(t.lengthInnerM) || '–'} m` : null,
        t.refLapMs ? `Referenz ${ms(t.refLapMs)}` : 'keine Referenzzeit',
        t.minLapMs ? `min. ${ms(t.minLapMs)}` : null,
        seasons.length ? `Saison ${seasons.join(', ')}` : 'noch keine Saison'
      ].filter(Boolean);
      return `<div class="list-item"><div><strong>${esc(tr.name)}</strong>${tr.short ? ` <span class="muted">(${esc(tr.short)})</span>` : ''}${tr.id === cur ? ' <span class="badge">aktuell</span>' : ''}${tr.imageRev ? ' <span class="badge">Bild</span>' : ''}
        <div>${esc(bits.join(' · '))}</div></div>
        <button class="btn edit-track" data-id="${esc(tr.id)}">Bearbeiten</button></div>`;
    }).join('');
    el.innerHTML = `
      <p class="muted" style="margin-bottom:12px;">Die Referenz-Rundenzeit bestimmt später im Rennen den Spritverbrauch: Wer schneller als die Referenz fährt, verbraucht mehr, wer langsamer ist, weniger. Eine neue Strecke bekommt ihre Saison weiterhin unter „Saisons“.</p>
      ${rows || '<p class="muted">Noch keine Strecken.</p>'}
      <button class="btn" id="newTrackBtn" style="margin-top:12px;">${icon('plus')}Neue Strecke</button>`;
    el.querySelectorAll('.edit-track').forEach(b => { b.onclick = () => editTrack(b.dataset.id); });
    el.querySelector('#newTrackBtn').onclick = () => editTrack(null);
  }

  function renderRace (el) {
    const s = window.appData.raceSettings || M.raceSettings();
    const fPct = Math.round(Math.min(2, s.fuelSpeedFactor) * 10) * 10;   // 0–200 % in 10er-Schritten
    el.innerHTML = `
      <form id="raceSettingsForm">
        <h3 class="setup-h">Box &amp; Tank</h3>
        <div class="race-meta-grid" style="grid-template-columns:1fr 1fr;">
          <div class="form-group"><label for="rsTank">Voller Tank reicht (Runden)</label><input id="rsTank" name="tank" type="number" min="1" max="500" value="${s.fullTankLaps}"></div>
          <div class="form-group"><label for="rsRefuel">Tanken (% pro Sekunde)</label><input id="rsRefuel" name="refuel" inputmode="decimal" value="${fmtNum(s.refuelPctPerSec, 1)}"></div>
          <div class="form-group"><label for="rsPitCall">„Muss an die Box“ ab Tank (%)</label><input id="rsPitCall" name="pitCall" type="number" min="0" max="100" value="${s.pitCallFuelPct}"></div>
        </div>
        <div class="form-group"><label for="rsFactor">Einfluss des Tempos auf den Verbrauch <strong id="rsFactorVal">${fPct} %</strong></label>
          <div class="tick-range" style="--pct:${fPct / 2}%">
            <div class="tick-track"><div class="tick-fill"></div>${Array.from({ length: 21 }, (_, i) => `<span class="tick${i * 10 <= fPct ? ' on' : ''}${i % 5 === 0 ? ' major' : ''}"></span>`).join('')}</div>
            <input type="range" class="level-range" id="rsFactor" name="factor" min="0" max="200" step="10" value="${fPct}">
          </div>
          <div class="tick-labels"><span>0 % · Tempo egal</span><span>100 % · proportional</span><span>200 %</span></div>
          <p class="muted edit-note" id="rsFactorNote"></p>
        </div>
        <h3 class="setup-h">Strafen</h3>
        <div class="race-meta-grid" style="grid-template-columns:1fr 1fr;">
          <div class="form-group"><label for="rsFalse">Fehlstart (Sekunden)</label><input id="rsFalse" name="falseStart" inputmode="decimal" value="${fmtNum(s.falseStartPenaltySec, 1)}"></div>
          <div class="form-group"><label for="rsOpts">Zeitstrafen zur Auswahl (Sekunden)</label><input id="rsOpts" name="opts" value="${s.penaltyOptionsSec.map(v => fmtNum(v, 1)).join('; ')}" placeholder="2; 5; 7; 10"></div>
        </div>
        <div class="edit-foot"><button type="button" class="btn" id="rsReset">Standardwerte</button><span style="flex:1"></span><button type="submit" class="btn btn-primary">Speichern</button></div>
      </form>
      <details class="bal-details" id="balDetails">
        <summary class="setup-h">Balancing prüfen</summary>
        <p class="muted edit-note" style="margin:-4px 0 12px;">Rechnet mit den Werten oben (auch ungespeichert) und der Referenzzeit der aktuellen Strecke. Nur zum Ausprobieren, wird nicht gespeichert.</p>
        <div class="race-meta-grid" style="grid-template-columns:1fr 1fr;">
          <div class="form-group"><label for="balLaps">Renndistanz (Runden)</label><input id="balLaps" type="number" min="1" max="500" value="70"></div>
          <div class="form-group"><label for="balPit">Zeitverlust je Boxenstopp ohne Tanken (s)</label><input id="balPit" inputmode="decimal" value="4"></div>
        </div>
        <div class="live-table-wrap"><table class="live-table bal-table" id="balTable"></table></div>
        <p class="muted edit-note" id="balNote"></p>
      </details>
      <details class="bal-details" id="voiceDetails">
        <summary class="setup-h">Sprachausgabe</summary>
        <div class="form-group"><label for="voiceSel">Stimme (gilt für alle Geräte)</label>
          <select id="voiceSel">${Object.values(window.Voice?.VOICES || {}).map(v => `<option value="${v.key}" ${s.voice === v.key ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
        </div>
        <p class="muted edit-note" style="margin:-4px 0 12px;">Jede Stimme hat eigene Ansagen und eigene gesprochene Namen. Fehlt ein Name in der gewählten Stimme, wird er mit der anderen gesprochen. Für das Erzeugen von Fahrernamen im Fahrer-Dialog braucht dieses Gerät einen Azure-Speech-Schlüssel (Gratis-Tarif F0). Er wird nur auf diesem Gerät gespeichert.</p>
        <div class="race-meta-grid" style="grid-template-columns:2fr 1fr;">
          <div class="form-group"><label for="azKey">Azure-Speech-Schlüssel</label><input id="azKey" type="password" autocomplete="off" value="${esc(window.Voice?.azureConfig()?.key || '')}" placeholder="Schlüssel 1 aus dem Azure-Portal"></div>
          <div class="form-group"><label for="azRegion">Region</label><input id="azRegion" value="${esc(window.Voice?.azureConfig()?.region || 'westeurope')}"></div>
        </div>
        <div class="edit-foot"><button type="button" class="btn" id="azTest">Testen</button><span style="flex:1"></span><button type="button" class="btn btn-primary" id="azSave">Auf diesem Gerät speichern</button></div>
        <h3 class="setup-h" style="margin-top:16px;">Feste Ansagen</h3>
        <div id="phraseList" class="muted">Wird geladen …</div>
      </details>`;
    const form = el.querySelector('#raceSettingsForm');
    const note = () => {
      const f = Number(form.factor.value) / 100;
      const box = form.factor.closest('.tick-range');
      box.style.setProperty('--pct', `${form.factor.value / 2}%`);
      box.querySelectorAll('.tick').forEach((t, i) => t.classList.toggle('on', i * 10 <= form.factor.value));
      el.querySelector('#rsFactorVal').textContent = `${form.factor.value} %`;
      const laps = Math.max(1, Math.round(parseNum(form.tank.value) || M.RACE_DEFAULTS.fullTankLaps));
      const ex = d => fmtNum(M.lapsPerTank(1 + d, { refLapMs: 1 }, { fullTankLaps: laps, fuelSpeedFactor: f }), 1);
      el.querySelector('#rsFactorNote').textContent = `Bei Referenztempo reicht der Tank ${laps} Runden, 5 % schneller ${ex(-0.05)} Runden, 5 % langsamer ${ex(0.05)} Runden.`;
    };
    const balance = () => {
      const track = window.Seasons.track(window.Seasons.current().trackId);
      const ref = M.trackSetup(track).refLapMs || 6500;
      const settings = {
        fullTankLaps: parseNum(form.tank.value), refuelPctPerSec: parseNum(form.refuel.value), fuelSpeedFactor: Number(form.factor.value) / 100
      };
      const laps = Math.max(1, Math.round(parseNum(el.querySelector('#balLaps').value) || 70));
      const pitLoss = Math.max(0, parseNum(el.querySelector('#balPit').value) ?? 4);
      const base = M.raceFuelPlan(laps, ref, { refLapMs: ref }, settings);
      const total = (lap, p) => laps * lap / 1000 + p.refuelSec + p.stops * pitLoss;
      const rows = [-10, -5, -2, 0, 2, 5, 10].map(d => {
        const lap = ref * (1 + d / 100);
        const p = M.raceFuelPlan(laps, lap, { refLapMs: ref }, settings);
        const diff = total(lap, p) - total(ref, base);
        const label = d === 0 ? 'Referenz' : `${Math.abs(d)} % ${d < 0 ? 'schneller' : 'langsamer'}`;
        const res = d === 0 ? '–' : `${diff < 0 ? 'Vorteil' : 'Nachteil'} ${fmtNum(Math.abs(diff), 1)} s`;
        return `<tr${d === 0 ? ' class="bal-ref"' : ''}><td>${label}</td><td>${ms(lap)}</td><td>${fmtNum(p.lapsPerTank, 1)}</td><td>${p.stops}</td><td>${fmtNum(p.refuelSec, 1)} s</td><td>${res}</td></tr>`;
      }).join('');
      el.querySelector('#balTable').innerHTML = `<thead><tr><th>Tempo</th><th>Runde</th><th>Runden/Tank</th><th>Stopps</th><th>Tankzeit</th><th>Gesamt ggü. Referenz</th></tr></thead><tbody>${rows}</tbody>`;
      el.querySelector('#balNote').textContent = (M.trackSetup(track).refLapMs ? '' : 'Die aktuelle Strecke hat noch keine Referenzzeit, gerechnet wird mit 6500 ms. ') +
        'Start mit vollem Tank, getankt wird nur so viel wie nötig.';
    };
    // Sprachausgabe
    el.querySelector('#voiceSel').onchange = e => {
      const v = window.Voice.VOICES[e.target.value];
      if (window.appData.raceSettings) window.appData.raceSettings.voice = v.key;   // sofort wirksam, Sync folgt
      persist(window.Storage.updateRaceSettings({ voice: v.key }), `Stimme: ${v.label}`);
      const box = el.querySelector('#phraseList');
      if (box) renderPhrases(box);
    };
    const azKey = el.querySelector('#azKey'), azRegion = el.querySelector('#azRegion');
    el.querySelector('#azSave').onclick = () => {
      window.Voice.setAzureConfig(azKey.value, azRegion.value);
      showToast(azKey.value.trim() ? 'Schlüssel auf diesem Gerät gespeichert' : 'Schlüssel entfernt');
    };
    el.querySelector('#azTest').onclick = async () => {
      const before = window.Voice.azureConfig();
      window.Voice.setAzureConfig(azKey.value, azRegion.value);
      try {
        const blob = await window.Voice.synthesize('Die Sprachausgabe funktioniert.');
        window.Voice.playSources([URL.createObjectURL(blob)]);
        showToast('Verbindung klappt');
      } catch (err) {
        showToast(err.message, { icon: 'alert' });
        if (before) window.Voice.setAzureConfig(before.key, before.region); else window.Voice.setAzureConfig('');
      }
    };
    const renderPhrases = box => window.Voice?.loadManifest().then(man => {
      if (!box) return;
      const order = window.Voice.PHRASES.map(p => p[0]);
      const rank = k => (order.includes(k) ? order.indexOf(k) : 999);
      const entries = Object.entries(man.phrases || {}).sort((a, b) => rank(a[0]) - rank(b[0]));
      box.innerHTML = entries.length
        ? entries.map(([k, t]) => `<div class="media-row" style="margin-bottom:6px;"><button type="button" class="btn btn-small" data-phrase="${esc(k)}">Anhören</button><span>${window.Voice.WITH_NAME.has(k) ? '<span class="muted">[Fahrername]</span> ' : ''}${esc(t)}</span></div>`).join('')
        : 'Noch keine Ansagen erzeugt.';
      box.querySelectorAll('[data-phrase]').forEach(b => { b.onclick = () => window.Voice.say(b.dataset.phrase); });
    });
    renderPhrases(el.querySelector('#phraseList'));
    const update = () => { note(); balance(); };
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    el.querySelector('#balDetails').addEventListener('input', balance);
    update();
    el.querySelector('#rsReset').onclick = () => {
      if (!confirm('Alle Renneinstellungen auf die Standardwerte zurücksetzen?')) return;
      persist(window.Storage.updateRaceSettings({ ...M.RACE_DEFAULTS, penaltyOptionsSec: [...M.RACE_DEFAULTS.penaltyOptionsSec], voice: s.voice }), 'Standardwerte gesetzt');
    };
    form.onsubmit = e => {
      e.preventDefault();
      const opts = form.opts.value.split(/[;\s]+/).map(parseNum).filter(v => v > 0);
      const fields = M.raceSettings({
        fullTankLaps: parseNum(form.tank.value),
        refuelPctPerSec: parseNum(form.refuel.value),
        pitCallFuelPct: parseNum(form.pitCall.value),
        fuelSpeedFactor: Number(form.factor.value) / 100,
        falseStartPenaltySec: parseNum(form.falseStart.value),
        penaltyOptionsSec: opts,
        voice: window.appData.raceSettings?.voice
      });
      persist(window.Storage.updateRaceSettings(fields), 'Renneinstellungen gespeichert');
    };
  }

  function render () {
    const el = document.getElementById('setupRoot');
    if (!el) return;
    // Formular nicht überschreiben, während jemand tippt
    if (el.contains(document.activeElement) && document.activeElement.matches('input, select')) return;
    const title = document.getElementById('setupTitle');
    if (title) title.textContent = tab === 'race' ? 'Renneinstellungen' : 'Strecken';
    document.getElementById('setupIcon')?.setAttribute('href', tab === 'race' ? '#i-timer' : '#i-flag');
    tab === 'race' ? renderRace(el) : renderTracks(el);
  }
  const setTab = t => { tab = t === 'race' ? 'race' : 'tracks'; };

  window.SetupUI = {
    enabled, render, setTab, editDriver, editCar, editTrack, closeModal,
    controllerChip, tuningLabel, carImageSrc, carAssetSrc, trackImageSrc, driverVoiceSrc
  };
})();
