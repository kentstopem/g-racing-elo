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
    ['pit_call', 'before'], ['in_pit', 'before'], ['refueled', 'before'], ['penalty_served', 'before'],
    ['last_lap'], ['red_flag'], ['race_resume'], ['race_win', 'before']
  ];
  const NAME_POS = Object.fromEntries(PHRASES.filter(p => p[1]).map(p => [p[0], p[1]]));
  const voice = key => VOICES[key] || VOICES[window.appData?.raceSettings?.voice] || VOICES.ingrid;
  /** Aus welcher Schreibweise der gespeicherte Name dieser Stimme stammt (null = keiner gespeichert) */
  const savedText = (d, key) => { const v = voice(key); return d?.[v.rev] ? (d[v.text] ?? (d.pronunciation || d.name)) : null; };
  const spokenText = d => (d?.pronunciation || d?.name || '');

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
    return res.blob();
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
    try { return (await window.Storage.getMedia(v.media(d.id)))?.data ?? null; } catch (e) { console.warn(e); return null; }
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
    for (const src of sources.filter(Boolean)) {
      if (my !== token) return;
      await new Promise(resolve => {
        const a = new Audio(src);
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
    VOICES, PHRASES, NAME_POS, announce, RATE, voice, savedText, spokenText, azureConfig, setAzureConfig, synthesize,
    loadManifest, phraseSrc, nameSrc, say, playSources, stop, preload
  };
})();
