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
  let current = null;   // { audio, token }
  let token = 0;

  function stop () {
    token++;
    if (current) { current.pause(); current.src = ''; current = null; }
  }

  /** Spielt eine Folge von Quellen (URLs/Data-URLs) nacheinander; unterbricht Laufendes. */
  async function playSources (sources) {
    stop();
    const my = token;
    // Alle Teile vorab laden, damit zwischen [Name] und Ansage keine Lade-Pause entsteht
    const clips = sources.filter(Boolean).map(src => { const a = new Audio(src); a.preload = 'auto'; try { a.load(); } catch (e) {} return a; });
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
  }

  window.Voice = {
    VOICES, PHRASES, NAME_POS, announce, RATE, voice, savedText, spokenText, listText, azureConfig, setAzureConfig, synthesize,
    loadManifest, phraseSrc, nameSrc, say, playSources, stop, preload, trimTail
  };
})();
