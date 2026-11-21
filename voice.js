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
      media: id => `driver_voice_${id}`, rev: 'voiceRev', text: 'voiceText' },
    leni:   { key: 'leni', label: 'Leni (Schweiz)', id: 'de-CH-LeniNeural', lang: 'de-CH', base: 'assets/voice/leni',
      media: id => `driver_voice_leni_${id}`, rev: 'voiceRevLeni', text: 'voiceTextLeni' }
  };
  // Reihenfolge der festen Ansagen und wo der Fahrername gesprochen wird:
  // 'before' = [Fahrer] + Ansage, 'after' = Ansage + [Fahrer]
  const PHRASES = [
    ['count_5'], ['count_4'], ['count_3'], ['count_2'], ['count_1'], ['count_go'],
    ['false_start', 'after'], ['pole', 'before'], ['fastest_lap', 'after'], ['personal_record', 'after'], ['track_record', 'before'],
    ['pit_call', 'before'], ['fuel_critical', 'before'], ['in_pit', 'before'], ['refueled', 'before'], ['penalty_served', 'before'],
    ['last_lap'], ['red_flag'], ['race_resume'], ['race_win', 'before'],
    ['lead_change', 'before'], ['place_2', 'after'], ['place_3', 'after'], ['dnf', 'before'], ['dq', 'before'],
    ['car_record', 'after'], ['halfway'], ['five_to_go'], ['quali_done', 'before'], ['no_signal', 'before']
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
    if (!cfg) throw new Error('Sprach-Schlüssel fehlt (Setup → Renneinstellungen → Sprachausgabe)');
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

  async function ownClip (d, v) {
    if (!d?.[v.rev]) return null;
    try {
      const data = (await window.Storage.getMedia(v.media(d.id)))?.data ?? null;
      return data && trimmedSrc(data, `${v.key}|${d.id}|${d[v.rev]}`);
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
  // Bevorzugt Web Audio: Alle Teile einer Ansage ([Name] + Satz) werden vorher dekodiert und lückenlos
  // hintereinander eingeplant. Mit <audio> entstand zwischen den Teilen eine Pause, weil jedes Element
  // erst laden und starten muss. Beim Dekodieren wird die Stille vorne/hinten bis auf einen kleinen Rest
  // entfernt und lange Pausen mitten im Satz werden gekürzt (gilt auch für eigene Namens-Töne).
  // Geht Web Audio nicht (noch nicht freigeschaltet, Fehler), bleibt es beim bisherigen <audio>-Weg.
  // Stille: Schwelle ≈ −50 dB, vorne bleiben 0,02 s. Hinten und mitten im Satz: Setup → Renneinstellungen → Sprachausgabe
  const CUT = { thresh: 0.003, lead: 0.02 };
  const cutCfg = () => {
    const r = window.appData?.raceSettings || {};
    const ms = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(0, Number(v)) : d) / 1000;
    return { tail: ms(r.voiceTailMs, 40), gap: ms(r.voiceGapMs, 250) };
  };
  let ctx = null, nodes = [];
  let current = null;   // <audio> im Rückfall-Weg
  let token = 0;

  function audioCtx () {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { return null; }
    return ctx;
  }
  // iOS: Web Audio soll wie Musik klingen, auch wenn das Gerät stumm geschaltet ist (wie bisher <audio>)
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
  // Web Audio darf erst nach einer Berührung starten → bei jeder Berührung freischalten
  const unlock = () => { const c = audioCtx(); if (c && c.state !== 'running') c.resume().catch(() => {}); };
  ['pointerdown', 'touchend', 'keydown'].forEach(ev => document.addEventListener(ev, unlock, { capture: true, passive: true }));

  /** Stille vorne/hinten weg, lange Pausen im Satz auf CUT.keepGap kürzen */
  function tighten (buf, cfg) {
    const sr = buf.sampleRate, ch = buf.numberOfChannels, n = buf.length;
    const d0 = buf.getChannelData(0);
    const loud = i => { for (let c = 0; c < ch; c++) if (Math.abs((c ? buf.getChannelData(c) : d0)[i]) >= CUT.thresh) return true; return false; };
    let first = 0, last = n - 1;
    while (first < n && !loud(first)) first++;
    while (last > first && !loud(last)) last--;
    if (first >= last) return buf;
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
    const len = keep.reduce((a, [x, y]) => a + (y - x), 0);
    if (len >= n - Math.round(0.01 * sr)) return buf;
    const out = ctx.createBuffer(ch, len, sr);
    for (let c = 0; c < ch; c++) {
      const src = buf.getChannelData(c), dst = out.getChannelData(c);
      let o = 0;
      for (const [x, y] of keep) { dst.set(src.subarray(x, y), o); o += y - x; }
    }
    return out;
  }

  const buffers = new Map();   // Quelle → Promise<AudioBuffer>
  function decoded (src) {
    const cfg = cutCfg(), key = `${cfg.tail}|${cfg.gap}|${src}`;
    let p = buffers.get(key);
    if (!p) {
      p = fetch(src).then(r => { if (!r.ok) throw new Error('Ton fehlt'); return r.arrayBuffer(); })
        .then(ab => new Promise((resolve, reject) => { const q = ctx.decodeAudioData(ab, resolve, reject); if (q?.catch) q.catch(reject); }))
        .then(buf => tighten(buf, cfg));
      p.catch(() => buffers.delete(key));
      buffers.set(key, p);
      if (buffers.size > 120) buffers.delete(buffers.keys().next().value);
    }
    return p;
  }

  function stop () {
    token++;
    for (const s of nodes) { try { s.onended = null; s.stop(); } catch (e) {} }
    nodes = [];
    if (current) { current.pause(); current.src = ''; current = null; }
  }

  async function playWebAudio (sources, my) {
    const bufs = await Promise.all(sources.map(decoded));
    if (my !== token) return true;
    let t = ctx.currentTime + 0.03;
    const list = bufs.map(b => { const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(t); t += b.duration; return s; });
    nodes = list;
    await new Promise(resolve => { list[list.length - 1].onended = resolve; });
    if (my === token) nodes = [];
    return true;
  }

  /** Spielt eine Folge von Quellen (URLs/Data-URLs) nacheinander; unterbricht Laufendes. */
  async function playSources (sources) {
    stop();
    const my = token;
    sources = sources.filter(Boolean);
    if (!sources.length) return;
    const c = audioCtx();
    // Countdown (5 4 3 2 1 Los) wie bisher direkt über <audio>: Er hängt an den CU-Lampen und ist darauf abgestimmt
    const countdown = sources.every(src => typeof src === 'string' && /\/phrases\/count_[^/]*\.mp3$/.test(src));
    if (c && c.state === 'running' && !countdown) {
      try { if (await playWebAudio(sources, my)) return; } catch (e) { console.warn('Web Audio', e); }
      if (my !== token) return;
    }
    // Rückfall <audio>: alle Teile vorab laden, damit zwischen [Name] und Ansage keine Lade-Pause entsteht
    const clips = sources.map(src => { const a = new Audio(src); a.preload = 'auto'; try { a.load(); } catch (e) {} return a; });
    for (const a of clips) {
      if (my !== token) return;
      await new Promise(resolve => {
        current = a;
        a.onended = a.onerror = () => resolve();
        a.play().catch(() => resolve());
      });
    }
    if (my === token) current = null;
  }

  /**
   * Ansage abspielen. Teile: Phrasen-Schlüssel (z. B. 'race_win') oder { driver: id }.
   * Beispiel: Voice.say({ driver: id }, 'race_win')
   */
  async function say (...parts) {
    const my = ++token;   // sofort reservieren, damit ein späterer Aufruf diesen verdrängt
    const sources = await Promise.all(parts.map(p => (typeof p === 'string' ? phraseSrc(p) : nameSrc(p.driver))));
    if (my !== token) return;
    return playSources(sources);
  }

  /** Ansage mit Fahrername an der richtigen Stelle, z. B. Voice.announce('fastest_lap', driverId) */
  function announce (key, driverId) {
    const pos = NAME_POS[key];
    if (!pos || driverId == null) return say(key);
    return pos === 'after' ? say(key, { driver: driverId }) : say({ driver: driverId }, key);
  }

  /** Alle festen Ansagen vorladen (landen im Offline-Cache des Service Workers). */
  async function preload () {
    const man = await loadManifest();
    await Promise.all(Object.keys(man.phrases || {}).map(k => fetch(phraseSrc(k)).catch(() => {})));
    if (audioCtx()) Object.keys(man.phrases || {}).forEach(k => decoded(phraseSrc(k)).catch(() => {}));   // schon dekodiert bereithalten
  }

  window.Voice = {
    VOICES, PHRASES, NAME_POS, announce, RATE, voice, savedText, spokenText, listText, azureConfig, setAzureConfig, synthesize,
    loadManifest, phraseSrc, nameSrc, say, playSources, stop, preload, trimTail
  };
})();
