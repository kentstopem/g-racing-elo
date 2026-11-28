// voice.js – Sprachausgabe: feste Ansagen + gesprochene Fahrernamen (window.Voice)
//
// • Feste Ansagen liegen als MP3 in assets/voice/<stimme>/phrases/<key>.mp3 (erzeugt vom GitHub-Workflow
//   „Stimmen erzeugen“, Texte in tools/voice/phrases.json).
// • Fahrernamen: eigener Ton aus Firestore (media/driver_voice_<id>, im Fahrer-Dialog live erzeugt
//   oder hochgeladen), sonst assets/voice/<stimme>/drivers/<id>.mp3 vom Workflow.
// • Live-Erzeugung im Fahrer-Dialog über Azure Speech (gleiche Stimme wie die Ansagen). Schlüssel
//   und Region liegen nur auf dem Gerät (localStorage), weil Firestore öffentlich lesbar ist.
// • Ein neuer Ton unterbricht immer den laufenden.
(function () {
  const RATE = '+5%';
  const AZURE_KEY = 'grp.azureSpeech';
  // Umschaltbare Stimmen (Setup → Renneinstellungen → Sprachausgabe, gilt für alle Geräte).
  // Jede Stimme hat eigene Ansagen-Dateien und eigene gespeicherte Fahrernamen.
  const VOICES = {
    ingrid: { key: 'ingrid', label: 'Ingrid (Österreich)', id: 'de-AT-IngridNeural', lang: 'de-AT', base: 'assets/voice/ingrid',
      media: id => `driver_voice_${id}`, carMedia: id => `car_voice_${id}`, rev: 'voiceRev', text: 'voiceText' },
    leni:   { key: 'leni', label: 'Leni (Schweiz)', id: 'de-CH-LeniNeural', lang: 'de-CH', base: 'assets/voice/leni',
      media: id => `driver_voice_leni_${id}`, carMedia: id => `car_voice_leni_${id}`, rev: 'voiceRevLeni', text: 'voiceTextLeni' }
  };
  // Reihenfolge der festen Ansagen und wo der Fahrername gesprochen wird:
  // 'before' = [Fahrer] + Ansage, 'after' = Ansage + [Fahrer]
  const PHRASES = [
    ['count_5'], ['count_4'], ['count_3'], ['count_2'], ['count_1'], ['count_go'],
    ['false_start', 'after'], ['pole', 'before'], ['fastest_lap', 'after'], ['personal_record', 'after'], ['track_record', 'before'],
    ['pit_call', 'before'], ['fuel_critical', 'before'], ['in_pit', 'before'], ['refueled', 'before'], ['penalty_served', 'before'],
    ['last_lap'], ['red_flag'], ['race_resume'], ['race_win', 'before'],
    ['lead_change', 'before'], ['place_2', 'after'], ['place_3', 'after'], ['dnf', 'before'], ['dq', 'before'],
    ['car_record', 'after'], ['halfway'], ['five_to_go'], ['quali_done', 'before'], ['no_signal', 'before'],
    ['win_with', 'before'], ['win_rest'], ['pole_with', 'before'], ['pole_rest'], ['record_with', 'before'], ['record_rest']
  ];
  const NAME_POS = Object.fromEntries(PHRASES.filter(p => p[1]).map(p => [p[0], p[1]]));
  const voice = key => VOICES[key] || VOICES[window.appData?.raceSettings?.voice] || VOICES.ingrid;
  /** Aus welcher Schreibweise der gespeicherte Name dieser Stimme stammt (null = keiner gespeichert) */
  const savedText = (d, key) => { const v = voice(key); return d?.[v.rev] ? (d[v.text] ?? (d.pronunciation || d.name)) : null; };
  const spokenText = d => (d?.pronunciation || d?.name || '');
  /** Schreibweise für die Fahrerliste: gespeicherter Ton der aktiven Stimme, sonst einer anderen, sonst die Aussprache */
  const listText = d => savedText(d) ?? Object.keys(VOICES).map(k => savedText(d, k)).find(Boolean) ?? (d?.pronunciation || null);

  // ---------- Azure-Zugang (nur dieses Gerät) ----------
  function azureConfig () {
    try { const c = JSON.parse(localStorage.getItem(AZURE_KEY) || 'null'); return c?.key && c?.region ? c : null; } catch (e) { return null; }
  }
  function setAzureConfig (key, region) {
    try {
      if (!key) localStorage.removeItem(AZURE_KEY);
      else localStorage.setItem(AZURE_KEY, JSON.stringify({ key: key.trim(), region: (region || 'westeurope').trim().toLowerCase() }));
    } catch (e) {}
  }

  const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** Text live erzeugen → MP3-Blob. Wirft mit verständlicher Meldung. */
  async function synthesize (text, key) {
    const v = voice(key);
    const cfg = azureConfig();
    if (!cfg) throw new Error('Sprach-Schlüssel fehlt (Setup → Settings → Sprachausgabe)');
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${v.lang}">` +
      `<voice name="${v.id}"><prosody rate="${RATE}">${xml(text)}</prosody></voice></speak>`;
    let res;
    try {
      res = await fetch(`https://${cfg.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': cfg.key,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3'
        },
        body: ssml
      });
    } catch (e) { throw new Error('Sprachdienst nicht erreichbar – Internet prüfen'); }
    if (res.status === 401) throw new Error('Sprach-Schlüssel oder Region falsch');
    if (res.status === 429) throw new Error('Sprachdienst: Limit erreicht, später nochmal');
    if (!res.ok) throw new Error(`Sprachdienst-Fehler ${res.status}`);
    return trimTail(await res.blob());
  }

  // ---------- Stille am Ende abschneiden ----------
  // Die Stimmen hängen hinten 0,5–1,3 s Stille an (vorne ~0,2 s). Die Workflow-Dateien kürzt
  // tools/voice/trim.py, live erzeugte und hochgeladene Namen kürzt das hier: MP3-Frames vor dem ersten
  // und hinter dem letzten Laut (bis auf einen kleinen Rest) werden weggelassen, ohne neu zu kodieren.
  // Geht etwas schief, bleibt der Ton wie er ist.
  const TAIL_KEEP = 0.04, LEAD_KEEP = 0.02;   // s Stille, die stehen bleibt
  const MP3_BR = [[0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]];
  const MP3_SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  async function trimTail (blob) {
    try {
      const buf = await blob.arrayBuffer();
      const b = new Uint8Array(buf);
      const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!AC || b.length < 4) return blob;
      const audio = await new Promise((resolve, reject) => {
        const p = new AC(1, 1, 24000).decodeAudioData(buf.slice(0), resolve, reject);
        if (p?.catch) p.catch(reject);
      });
      const data = audio.getChannelData(0);
      let last = data.length - 1, first = 0;
      while (last > 0 && Math.abs(data[last]) < 0.003) last--;   // ≈ −50 dB
      while (first < last && Math.abs(data[first]) < 0.003) first++;
      if (last <= 0) return blob;
      const from = first / audio.sampleRate - LEAD_KEEP, keep = last / audio.sampleRate + TAIL_KEEP;
      let start = -1;
      let i = 0;
      if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) i = 10 + ((b[6] & 127) << 21 | (b[7] & 127) << 14 | (b[8] & 127) << 7 | (b[9] & 127));
      let t = 0;
      while (i + 4 <= b.length) {
        if (b[i] !== 0xFF || (b[i + 1] & 0xE0) !== 0xE0 || ((b[i + 1] >> 1) & 3) !== 1) return blob;   // kein MP3 (Layer III)
        const ver = (b[i + 1] >> 3) & 3, br = MP3_BR[ver === 3 ? 0 : 1][b[i + 2] >> 4], sr = MP3_SR[ver]?.[(b[i + 2] >> 2) & 3];
        if (!br || !sr) return blob;
        const spf = ver === 3 ? 1152 : 576;
        const len = Math.floor((spf / 8) * br * 1000 / sr) + ((b[i + 2] >> 1) & 1);
        if (start < 0 && t + spf / sr > from) start = i;   // erster Frame, der noch gebraucht wird
        if (t >= keep) break;
        t += spf / sr;
        i += len;
      }
      i = Math.min(i, b.length);
      if (start < 0 || (start < 256 && b.length - i < 512)) return blob;   // nichts Nennenswertes zu kürzen
      return new Blob([b.subarray(start, i)], { type: 'audio/mpeg' });
    } catch (e) { return blob; }
  }
  /** Gespeicherten Namen (Data-URL) gekürzt abspielen – auch Töne, die vor dem Kürzen gespeichert wurden */
  const trimmed = {};
  function trimmedSrc (src, cacheKey) {
    if (typeof src !== 'string' || !src.startsWith('data:audio')) return src;
    if (!trimmed[cacheKey]) {
      trimmed[cacheKey] = fetch(src).then(r => r.blob()).then(trimTail).then(blob => URL.createObjectURL(blob)).catch(() => src);
    }
    return trimmed[cacheKey];
  }

  // ---------- Quellen ----------
  const manifests = {};
  function loadManifest (key) {
    const v = voice(key);
    if (!manifests[v.key]) manifests[v.key] = fetch(`${v.base}/manifest.json`).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
    return manifests[v.key];
  }
  const phraseSrc = (k, key) => `${voice(key).base}/phrases/${k}.mp3`;

  async function ownClip (d, v, car = false) {
    if (!d?.[v.rev]) return null;
    try {
      const data = (await window.Storage.getMedia((car ? v.carMedia : v.media)(d.id)))?.data ?? null;
      return data && trimmedSrc(data, `${v.key}|${car ? 'car' : ''}${d.id}|${d[v.rev]}`);
    } catch (e) { console.warn(e); return null; }
  }

  /** Ton für den Namen eines Fahrers in der (aktiven) Stimme: eigener Ton, sonst Workflow-Datei, sonst die andere Stimme. */
  async function nameSrc (driverOrId, key) {
    const d = typeof driverOrId === 'object' ? driverOrId : window.appData?.drivers?.find(x => x.id === driverOrId);
    if (!d) return null;
    const v = voice(key);
    const own = await ownClip(d, v);
    if (own) return own;
    if ((await loadManifest(v.key)).drivers?.[d.id]) return `${v.base}/drivers/${d.id}.mp3`;
    for (const o of Object.values(VOICES).filter(o => o !== v)) {
      const other = await ownClip(d, o);
      if (other) return other;
      if ((await loadManifest(o.key)).drivers?.[d.id]) return `${o.base}/drivers/${d.id}.mp3`;
    }
    return null;
  }

  // ---------- Wiedergabe ----------
  // Alle Teile einer Ansage ([Name] + Satz) werden vorab dekodiert, die Stille vorne/hinten bis auf einen
  // kleinen Rest entfernt, lange Pausen mitten im Satz gekürzt und alles zu EINER WAV-Datei zusammengefügt.
  // Die spielt ein normales <audio>-Element ab: lückenlos und so laut wie bisher. (Direkt über Web Audio
  // abgespielt blieb es auf dem iPad in Bluefy stumm, weil iOS Web Audio anders behandelt als <audio>.)
  // Klappt das Zusammenfügen nicht, werden die Teile wie früher einzeln nacheinander gespielt.
  // Stille: Schwelle ≈ −50 dB, vorne bleiben 0,02 s. Hinten und mitten im Satz: Setup → Sprachausgabe
  const CUT = { thresh: 0.003, lead: 0.02 };
  const SR = 24000;   // so liegen die Schnipsel vor
  const cutCfg = () => {
    const r = window.appData?.raceSettings || {};
    const ms = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(0, Number(v)) : d) / 1000;
    return { tail: ms(r.voiceTailMs, 40), gap: ms(r.voiceGapMs, 250) };
  };
  let ctx = null;       // nur zum Dekodieren (OfflineAudioContext, braucht keine Freigabe und gibt nichts aus)
  let current = null;   // laufendes <audio>
  let token = 0;

  // iOS (Bluefy): Ein Ton darf nur kurz nach einer Berührung neu starten. Der Countdown direkt nach
  // „Rennen starten“ klappte deshalb, eine Warnung 20 s später ohne Berührung blieb stumm.
  // Lösung: EIN festes <audio>-Element, das bei der ersten Berührung mit einem stillen Ton freigeschaltet
  // wird. Danach darf es jederzeit neue Töne spielen.
  const player = new Audio();
  player.preload = 'auto';
  let unlocked = false;
  const SILENT = 'data:audio/wav;base64,UklGRgQCAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YeABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';   // 10 ms Stille
  const unlock = () => {
    if (unlocked || current) return;
    try {
      player.src = SILENT;
      const p = player.play();
      if (p?.then) p.then(() => { unlocked = true; }, () => {}); else unlocked = true;
    } catch (e) {}
  };
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach(ev => document.addEventListener(ev, unlock, { capture: true, passive: true }));

  function decodeCtx () {
    if (ctx) return ctx;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return null;
    try { ctx = new OAC(1, SR, SR); } catch (e) { return null; }
    return ctx;
  }

  /** Stille vorne/hinten weg, lange Pausen im Satz kürzen → Float32Array (mono) */
  function tighten (buf, cfg) {
    const sr = buf.sampleRate, n = buf.length;
    const d = buf.getChannelData(0);
    const loud = i => Math.abs(d[i]) >= CUT.thresh;
    let first = 0, last = n - 1;
    while (first < n && !loud(first)) first++;
    while (last > first && !loud(last)) last--;
    if (first >= last) return d;
    const keep = [];   // [von, bis) in Samples
    const keepGap = Math.round(cfg.gap * sr), maxGap = cfg.gap > 0 ? keepGap : Infinity;
    let segStart = Math.max(0, first - Math.round(CUT.lead * sr)), quiet = 0;
    for (let i = first; i <= last; i++) {
      if (loud(i)) {
        if (quiet > maxGap) { keep.push([segStart, i - quiet + Math.round(keepGap / 2)]); segStart = i - Math.round(keepGap / 2); }
        quiet = 0;
      } else quiet++;
    }
    keep.push([segStart, Math.min(n, last + 1 + Math.round(cfg.tail * sr))]);
    const out = new Float32Array(keep.reduce((a, [x, y]) => a + (y - x), 0));
    let o = 0;
    for (const [x, y] of keep) { out.set(d.subarray(x, y), o); o += y - x; }
    return out;
  }

  const parts = new Map();   // Einstellung + Quelle → Promise<Float32Array>
  function decoded (src, cfg) {
    const key = `${cfg.tail}|${cfg.gap}|${src}`;
    let p = parts.get(key);
    if (!p) {
      p = fetch(src).then(r => { if (!r.ok) throw new Error('Ton fehlt'); return r.arrayBuffer(); })
        .then(ab => new Promise((resolve, reject) => { const q = ctx.decodeAudioData(ab, resolve, reject); if (q?.catch) q.catch(reject); }))
        .then(buf => { if (buf.sampleRate !== SR) throw new Error('Abtastrate'); return tighten(buf, cfg); });
      p.catch(() => parts.delete(key));
      parts.set(key, p);
      if (parts.size > 120) parts.delete(parts.keys().next().value);
    }
    return p;
  }

  /** Float32 mono → WAV (16 Bit) */
  function wav (samples) {
    const b = new ArrayBuffer(44 + samples.length * 2), v = new DataView(b);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, SR, true);
    v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data');
    v.setUint32(40, samples.length * 2, true);
    for (let i = 0, o = 44; i < samples.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, samples[i])) * 0x7FFF, true);
    return new Blob([b], { type: 'audio/wav' });
  }

  const joined = new Map();   // Einstellung + alle Quellen → Promise<blob-URL>
  function joinedUrl (sources) {
    const cfg = cutCfg(), key = `${cfg.tail}|${cfg.gap}|${sources.join('\n')}`;
    let p = joined.get(key);
    if (!p) {
      p = Promise.all(sources.map(src => decoded(src, cfg))).then(list => {
        const all = new Float32Array(list.reduce((a, x) => a + x.length, 0));
        let o = 0;
        for (const x of list) { all.set(x, o); o += x.length; }
        return URL.createObjectURL(wav(all));
      });
      p.catch(() => joined.delete(key));
      joined.set(key, p);
      if (joined.size > 60) { const [k, old] = joined.entries().next().value; joined.delete(k); old.then(u => URL.revokeObjectURL(u)).catch(() => {}); }
    }
    return p;
  }

  function stop () {
    token++;
    if (current) { try { current.pause(); } catch (e) {} current.onended = current.onerror = null; current = null; }
  }

  /** → 'ok' | 'unterbrochen' | Fehlertext */
  function playClip (src, my) {
    return new Promise(resolve => {
      if (my !== token) return resolve('unterbrochen');
      const a = player;
      a.src = src;
      current = a;
      a.onended = () => resolve(my === token ? 'ok' : 'unterbrochen');
      a.onerror = () => resolve('Ton nicht ladbar');
      // AbortError = ein neuer Ton (oder die Freischaltung beim ersten Tippen) kam dazwischen: kein echter Ausfall
      a.play().catch(e => resolve(e?.name === 'AbortError' || my !== token ? 'unterbrochen' : `Abspielen blockiert (${e?.name || e})`));
    });
  }

  /** Spielt eine Folge von Quellen (URLs/Data-URLs) nacheinander; unterbricht Laufendes.
   *  Ergebnis: 'ok', 'unterbrochen' (ein neuerer Ton kam dazwischen) oder ein Fehlertext. */
  async function playSources (sources) {
    stop();
    const my = token;
    sources = sources.filter(Boolean);
    if (!sources.length) return 'kein Ton';
    // Countdown (5 4 3 2 1 Los) direkt: Er hängt an den CU-Lampen und ist darauf abgestimmt
    const countdown = sources.every(src => typeof src === 'string' && /\/phrases\/count_[^/]*\.mp3$/.test(src));
    if (!countdown && decodeCtx()) {
      let url = null;
      try { url = await joinedUrl(sources); } catch (e) { console.warn('Ansage zusammenfügen', e); }
      if (my !== token) return 'unterbrochen';
      if (url) { const r = await playClip(url, my); if (my === token) current = null; return r; }
    }
    // Countdown und Rückfall: Teile nacheinander über dasselbe Element
    let r = 'ok';
    for (const a of sources) {
      if (my !== token) return 'unterbrochen';
      const x = await playClip(a, my);
      if (x !== 'ok') r = x;
    }
    if (my === token) current = null;
    return r;
  }

  /**
   * Ansage abspielen. Teile: Phrasen-Schlüssel (z. B. 'race_win') oder { driver: id }.
   * Beispiel: Voice.say({ driver: id }, 'race_win')
   */
  // ---------- Fahrzeugnamen ----------
  // Standard: nur die Startnummer („Nummer sechs“ aus „(06) …“). Ein eigener gesprochener Name (Fahrzeug-Dialog,
  // Feld pronunciation) ersetzt die Nummer. Ohne Startnummer wird der Name ohne Spitznamen gesprochen.
  const carNumber = c => { const m = /^\s*\((\d+)\)/.exec(c?.name || ''); return m ? Number(m[1]) : null; };
  const carSpoken = c => (c?.pronunciation || '').trim() || (carNumber(c) != null ? `Nummer ${carNumber(c)}` : String(c?.name || '').replace(/[„"“].*$/, '').trim());
  /** Ton für ein Fahrzeug: eigener Ton, sonst Workflow-Datei (assets/voice/<stimme>/cars/<id>.mp3), sonst die andere Stimme */
  async function carSrc (carOrId, key) {
    const c = typeof carOrId === 'object' ? carOrId : window.appData?.cars?.find(x => x.id === carOrId);
    if (!c) return null;
    const v = voice(key);
    for (const o of [v, ...Object.values(VOICES).filter(o => o !== v)]) {
      const own = await ownClip(c, o, true);
      if (own) return own;
      if ((await loadManifest(o.key)).cars?.[c.id]) return `${o.base}/cars/${c.id}.mp3`;
    }
    return null;
  }

  async function say (...parts) {
    const my = ++token;   // sofort reservieren, damit ein späterer Aufruf diesen verdrängt
    const sources = await Promise.all(parts.map(p => (typeof p === 'string' ? phraseSrc(p) : p.car != null ? carSrc(p.car) : nameSrc(p.driver))));
    if (parts.some((p, i) => p?.car != null && !sources[i])) return 'kein Ton für das Fahrzeug';   // dann lieber die Ansage ohne Auto
    if (my !== token) return 'unterbrochen';
    return playSources(sources);
  }

  /** Ansage mit Fahrername an der richtigen Stelle, z. B. Voice.announce('fastest_lap', driverId) */
  function announce (key, driverId) {
    const pos = NAME_POS[key];
    if (!pos || driverId == null) return say(key);
    return pos === 'after' ? say(key, { driver: driverId }) : say({ driver: driverId }, key);
  }

  // Ansagen mit Fahrer UND Fahrzeug (Tristan 28.11.: Sieg, Streckenrekord, Pole). Fehlt der Fahrzeug-Ton,
  // kommt die bisherige Ansage nur mit dem Fahrer.
  const WITH_CAR = {
    race_win: ['win_with', 'win_rest'],            // [Fahrer] gewinnt mit [Auto] das Rennen! Herzlichen Glückwunsch!
    pole: ['pole_with', 'pole_rest'],              // [Fahrer] holt sich mit [Auto] die Pole-Position. Glückwunsch!
    track_record: ['record_with', 'record_rest']   // [Fahrer] mit [Auto]: neuer Streckenrekord! Krass!
  };
  async function announceCar (key, driverId, carId) {
    const w = WITH_CAR[key];
    if (!w || driverId == null || carId == null) return announce(key, driverId);
    const r = await say({ driver: driverId }, w[0], { car: carId }, w[1]);
    return r === 'kein Ton für das Fahrzeug' ? announce(key, driverId) : r;
  }
  /** Nur das Fahrzeug, z. B. beim Auslosen */
  const sayCar = carId => say({ car: carId });

  /** Alle festen Ansagen vorladen (landen im Offline-Cache des Service Workers). */
  async function preload () {
    const man = await loadManifest();
    await Promise.all(Object.keys(man.phrases || {}).map(k => fetch(phraseSrc(k)).catch(() => {})));
    if (decodeCtx()) { const cfg = cutCfg(); Object.keys(man.phrases || {}).forEach(k => decoded(phraseSrc(k), cfg).catch(() => {})); }   // schon dekodiert bereithalten
  }

  window.Voice = {
    VOICES, PHRASES, NAME_POS, announce, RATE, voice, savedText, spokenText, listText, azureConfig, setAzureConfig, synthesize,
    loadManifest, phraseSrc, nameSrc, carSrc, carNumber, carSpoken, say, sayCar, announceCar, playSources, stop, preload, trimTail
  };
})();
