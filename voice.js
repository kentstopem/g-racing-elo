// voice.js – Sprachausgabe: feste Ansagen + gesprochene Fahrernamen (window.Voice)
//
// • Feste Ansagen liegen als MP3 in assets/voice/phrases/<key>.mp3 (erzeugt vom GitHub-Workflow
//   „Stimmen erzeugen“, Texte in tools/voice/phrases.json).
// • Fahrernamen: eigener Ton aus Firestore (media/driver_voice_<id>, im Fahrer-Dialog live erzeugt
//   oder hochgeladen), sonst assets/voice/drivers/<id>.mp3 vom Workflow.
// • Live-Erzeugung im Fahrer-Dialog über Azure Speech (gleiche Stimme wie die Ansagen). Schlüssel
//   und Region liegen nur auf dem Gerät (localStorage), weil Firestore öffentlich lesbar ist.
// • Ein neuer Ton unterbricht immer den laufenden.
(function () {
  const VOICE = 'de-AT-IngridNeural';
  const RATE = '+5%';
  const AZURE_KEY = 'grp.azureSpeech';
  const BASE = 'assets/voice';

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
  async function synthesize (text) {
    const cfg = azureConfig();
    if (!cfg) throw new Error('Sprach-Schlüssel fehlt (Setup → Renneinstellungen → Sprachausgabe)');
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="de-AT">` +
      `<voice name="${VOICE}"><prosody rate="${RATE}">${xml(text)}</prosody></voice></speak>`;
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
  let manifest = null;
  async function loadManifest () {
    if (!manifest) manifest = fetch(`${BASE}/manifest.json`).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
    return manifest;
  }
  const phraseSrc = key => `${BASE}/phrases/${key}.mp3`;

  /** Ton für den Namen eines Fahrers (eigener Ton vor Workflow-Datei), oder null. */
  async function nameSrc (driverOrId) {
    const d = typeof driverOrId === 'object' ? driverOrId : window.appData?.drivers?.find(x => x.id === driverOrId);
    if (!d) return null;
    if (d.voiceRev) {
      try { const m = await window.Storage.getMedia(`driver_voice_${d.id}`); if (m?.data) return m.data; } catch (e) { console.warn(e); }
    }
    const man = await loadManifest();
    return man.drivers?.[d.id] ? `${BASE}/drivers/${d.id}.mp3` : null;
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

  /** Alle festen Ansagen vorladen (landen im Offline-Cache des Service Workers). */
  async function preload () {
    const man = await loadManifest();
    await Promise.all(Object.keys(man.phrases || {}).map(k => fetch(phraseSrc(k)).catch(() => {})));
  }

  window.Voice = {
    VOICE, RATE, azureConfig, setAzureConfig, synthesize,
    loadManifest, phraseSrc, nameSrc, say, playSources, stop, preload
  };
})();
