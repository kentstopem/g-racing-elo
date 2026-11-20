// cu.js – Verbindung zur Carrera Control Unit (D132/D124) über Bluetooth (AppConnect)
//
// Protokoll nach dem offenen Projekt carreralib (github.com/tkem/carreralib):
// • Die App schreibt "?" an die CU, die CU antwortet per Benachrichtigung.
// • Über Bluetooth fehlt der Antwort das führende Kommando-Zeichen, dafür endet sie mit "$".
// • Durchfahrt (Timer):  <Adresse 1..8><Zeitstempel 8 Zeichen><Sektor><Prüfsumme>
// • Status:             :<Tank 8×><Startampel><Modus><Boxen 2×><Anzeige>[2 unbekannte]<Prüfsumme>
// • Jede Ziffer steht im unteren Halbbyte (Zeichen '0'+Wert).
// Rundenzeit = Differenz zweier Durchfahrten derselben Adresse an Start/Ziel (Sektor 1).
// Web Bluetooth gibt es auf iPhone/iPad nicht in Safari – dort z. B. im Bluefy-Browser öffnen.

(function () {
  const SERVICE_UUID = '39df7777-b1b4-b90b-57f1-7144ae4e4a6a';
  const OUTPUT_UUID  = '39df8888-b1b4-b90b-57f1-7144ae4e4a6a';
  const NOTIFY_UUID  = '39df9999-b1b4-b90b-57f1-7144ae4e4a6a';

  const nib = s => s.split('').map(c => c.charCodeAt(0) & 0x0F);

  // Prüfsumme: Summe der Zeichen (ohne Kommando-Zeichen) mod 16
  const checksumOk = (body, chk) =>
    (body.split('').reduce((a, c) => a + c.charCodeAt(0), 0) & 0x0F) === (chk.charCodeAt(0) & 0x0F);

  // Zeitstempel: 8 Halbbytes in der Reihenfolge 24,28,16,20,8,12,0,4
  function timestamp (s) {
    const v = nib(s);
    return ((v[0] << 24) | (v[1] << 28) | (v[2] << 16) | (v[3] << 20) |
            (v[4] << 8)  | (v[5] << 12) | (v[6] << 0)  | (v[7] << 4)) >>> 0;
  }

  /**
   * Eine Bluetooth-Benachrichtigung der CU deuten.
   * Liefert {type:'timer', address(1..8), timestamp, sector, ok}
   *       | {type:'status', fuel[8], start, mode, pit[8], display, ok}
   *       | {type:'version', version} | {type:'unknown', raw}
   */
  function parse (raw) {
    let s = raw.endsWith('$') ? raw.slice(0, -1) : raw;
    if (s.startsWith('?')) s = s.slice(1);  // falls doch mit Kommando-Zeichen
    if (raw.endsWith('$') && raw.length === 6) return { type: 'version', version: s.slice(0, 4) };
    if (s.startsWith(':') && s.length >= 14) {
      const v = nib(s.slice(1));
      const pitmask = v[10] | (v[11] << 4);
      const body = s.slice(0, -1);
      return {
        type: 'status', fuel: v.slice(0, 8), start: v[8], mode: v[9],
        pit: [...Array(8)].map((_, n) => (pitmask & (1 << n)) !== 0), display: v[12],
        extra: s.length >= 17 ? v.slice(13, 15) : null,  // neuere CUs: 2 unbekannte Zeichen
        ok: checksumOk(body, s.slice(-1))
      };
    }
    if (s.length === 11) {
      return {
        type: 'timer', address: s.charCodeAt(0) & 0x0F, timestamp: timestamp(s.slice(1, 9)),
        sector: s.charCodeAt(9) & 0x0F, ok: checksumOk(s.slice(0, 10), s.slice(10))
      };
    }
    return { type: 'unknown', raw };
  }

  // ── Befehle an die CU ──────────────────────────────────────────────
  // Jeder Wert wird als Zeichen '0'+Wert gesendet, am Ende eine Prüfsumme (Summe mod 16).
  // Variante 'A' (carreralib): Prüfsumme ohne Kommando-Zeichen.
  // Variante 'B' (OpenLap): Prüfsumme mit Kommando-Zeichen, T/= ganz ohne Prüfsumme.
  // Welche die CU annimmt, wird an der Bahn getestet (cu-test.html).
  const nibChar = n => String.fromCharCode(0x30 | (n & 0x0F));
  function pack (cmd, nibbles, variant = 'A', withChecksum = true) {
    const body = nibbles.map(nibChar).join('');
    if (variant === 'B' && !withChecksum) return cmd + body;
    let sum = body.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    if (variant === 'B') sum += cmd.charCodeAt(0);
    return cmd + body + nibChar(sum);
  }
  const BUTTON = { ESC: 1, START: 2, SPEED: 5, BRAKE: 6, FUEL: 7, CODE: 8 };
  const Commands = {
    /** Datenwort setzen: word 0 Speed, 1 Bremse, 2 Tank, 6 Positionsturm; address 0..7 (= Regler-1), value 0..15 */
    word: (word, address, value, repeat = 1, v = 'A') =>
      pack('J', [word & 0x0F, (word >> 4) | (address << 1), value, repeat], v),
    speed: (ctrl, value, v) => Commands.word(0, ctrl - 1, value, 2, v),
    brake: (ctrl, value, v) => Commands.word(1, ctrl - 1, value, 2, v),
    fuel:  (ctrl, value, v) => Commands.word(2, ctrl - 1, value, 2, v),
    press: (id, v = 'A') => pack('T', [id], v, false),
    resetTimer: (v = 'A') => pack('=', [1, 0], v, false)
  };

  /** Rundenzähler je Controller-Adresse aus Timer-Ereignissen */
  class LapTracker {
    constructor () { this.reset(); }
    reset () { this.cars = {}; }
    /** Gibt {address, lap, time, best, isBest} zurück, wenn eine Runde abgeschlossen wurde */
    add (ev) {
      if (ev.type !== 'timer' || ev.sector !== 1) return null;
      const c = this.cars[ev.address] ??= { laps: 0, last: null, best: null, lastTs: null };
      // gleiche Durchfahrt doppelt gemeldet → ignorieren
      if (c.lastTs === ev.timestamp) return null;
      const prev = c.lastTs;
      c.lastTs = ev.timestamp;
      if (prev === null || ev.timestamp < prev) return null; // erste Durchfahrt bzw. CU-Uhr zurückgesetzt
      const time = ev.timestamp - prev;
      c.laps += 1;
      c.last = time;
      const isBest = c.best === null || time < c.best;
      if (isBest) c.best = time;
      return { address: ev.address, lap: c.laps, time, best: c.best, isBest };
    }
  }

  /**
   * Bestzeiten eines Abends je Fahrer+Fahrzeug (unabhängig vom Regler, falls umgesteckt wird).
   * assignment: { [address]: { driverId, carId } }
   */
  function sessionBest (bests, assignment, lap) {
    const a = assignment[lap.address];
    if (!a?.driverId || !a?.carId) return null;
    const key = `${a.driverId}|${a.carId}`;
    const prev = bests[key];
    if (!prev || lap.time < prev.ms) bests[key] = { driverId: a.driverId, carId: a.carId, ms: lap.time };
    return bests[key];
  }

  /**
   * Welche Bestzeiten sind neue Rekorde? records: lapRecords-Dokumente (time in Sekunden),
   * trackOf(rec) → Strecke eines Rekords, trackId: Strecke von heute.
   * Liefert [{driverId, carId, time (s), previous (s|null)}], schnellste zuerst.
   */
  function recordCandidates (bests, records, trackId, trackOf) {
    return Object.values(bests).map(b => {
      const time = Math.round(b.ms) / 1000;
      const existing = records.filter(r => r.driverId === b.driverId && r.carId === b.carId && trackOf(r) === trackId)
        .reduce((m, r) => (m === null || r.time < m ? r.time : m), null);
      return { driverId: b.driverId, carId: b.carId, time, previous: existing };
    }).filter(c => c.previous === null || c.time < c.previous).sort((x, y) => x.time - y.time);
  }

  /** Bluetooth-Verbindung: fragt die CU laufend ab und meldet jede Antwort an onMessage(raw) */
  class Connection {
    constructor ({ onMessage, onDisconnect, onReconnect, log = () => {} }) {
      Object.assign(this, { onMessage, onDisconnect, onReconnect, log });
      this.polling = false;
      this.queue = [];
      this.dec = new TextDecoder('ascii');
      this.enc = new TextEncoder();
    }

    static available () { return !!(globalThis.navigator && navigator.bluetooth); }

    // Suchvarianten für requestDevice (Bluefy verhält sich teils anders als Chrome)
    static VARIANTS = {
      name:      { filters: [{ name: 'Control_Unit' }], optionalServices: [SERVICE_UUID] },
      prefix:    { filters: [{ namePrefix: 'Control' }, { namePrefix: 'Carrera' }], optionalServices: [SERVICE_UUID] },
      service:   { filters: [{ services: [SERVICE_UUID] }] },
      all:       { acceptAllDevices: true, optionalServices: [SERVICE_UUID] },
      allPlain:  { acceptAllDevices: true }
    };

    async connect ({ variant = 'name' } = {}) {
      const opts = Connection.VARIANTS[variant] || Connection.VARIANTS.name;
      this.log(`Suche (${variant}): ${JSON.stringify(opts)}`);
      this.device = await navigator.bluetooth.requestDevice(opts);
      this.log(`Gewählt: ${this.device.name || '(ohne Namen)'} · ${this.device.id}`);
      this.manual = false;
      this.device.addEventListener('gattserverdisconnected', () => this.lost());
      this.device._grpListen = true;
      try { localStorage.setItem('cuDeviceId', this.device.id); } catch (e) {}
      await this.setup();
      return this.device.name || 'Control Unit';
    }

    /** Nach Neuladen: schon erlaubte CU ohne Auswahlfenster wieder verbinden (navigator.bluetooth.getDevices,
     *  nicht in jedem Browser vorhanden). Liefert den Namen oder null, wenn es so nicht geht. */
    async reconnectKnown () {
      if (!navigator.bluetooth?.getDevices) return null;
      const list = await navigator.bluetooth.getDevices();
      let lastId = null; try { lastId = localStorage.getItem('cuDeviceId'); } catch (e) {}
      const dev = list.find(d => d.id === lastId) || list.find(d => /control|carrera/i.test(d.name || ''));
      if (!dev) return null;
      this.device = dev;
      this.manual = false;
      if (!dev._grpListen) { dev.addEventListener('gattserverdisconnected', () => this.lost()); dev._grpListen = true; }
      await this.setup();
      return dev.name || 'Control Unit';
    }

    async setup () {
      const server = await this.device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      this.out = await service.getCharacteristic(OUTPUT_UUID);
      this.notify = await service.getCharacteristic(NOTIFY_UUID);
      this.log(`Ausgang kann: ${['write', 'writeWithoutResponse'].filter(k => this.out.properties[k]).join(', ') || '?'}`);
      if (!this.listening) {
        this.notify.addEventListener('characteristicvaluechanged', e => this.handle(e.target.value));
        this.listening = this.notify;
      }
      await this.notify.startNotifications();
    }

    // Unerwartet getrennt → bis zu 3 Mal neu verbinden, sonst onDisconnect
    async lost () {
      this.polling = false;
      if (this.manual) { this.onDisconnect?.(); return; }
      for (let i = 1; i <= 3; i++) {
        this.log(`Verbindung verloren, neuer Versuch ${i}/3 …`);
        await new Promise(r => setTimeout(r, 1000));
        try {
          this.listening = null;
          await this.setup();
          this.log('Wieder verbunden');
          this.onReconnect?.();
          this.startPolling();
          return;
        } catch (err) { this.log(`Fehlgeschlagen: ${err.message}`); }
      }
      this.onDisconnect?.();
    }

    handle (value) {
      const raw = this.dec.decode(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      this.onMessage?.(raw);
      this.waiting?.();
    }

    async send (str) {
      const data = this.enc.encode(str);
      if (this.out.properties.writeWithoutResponse && this.out.writeValueWithoutResponse) await this.out.writeValueWithoutResponse(data);
      else await this.out.writeValue(data);
    }

    // Abfrage-Schleife: "?" (oder einen wartenden Befehl) senden, auf Antwort warten (max. 250 ms), weiter
    async startPolling () {
      if (this.polling) return;
      this.polling = true;
      while (this.polling) {
        try {
          const answered = new Promise(res => { this.waiting = res; setTimeout(res, 250); });
          await this.send(this.queue.shift() || '?');
          await answered;
          await new Promise(r => setTimeout(r, 15));
        } catch (err) {
          this.log(`Fehler beim Senden: ${err.message}`);
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }

    // Firmware-Version abfragen (Antwort kommt über onMessage als type 'version')
    requestVersion () { this.queue.push('0'); }

    /** Beliebigen Befehl (z. B. aus CU.Commands) in die Abfrage-Schleife einreihen */
    command (str) { this.queue.push(str); }

    disconnect () { this.manual = true; this.polling = false; this.device?.gatt?.disconnect(); }

    get connected () { return !!this.device?.gatt?.connected; }
  }

  window.CU = { parse, timestamp, LapTracker, Connection, sessionBest, recordCandidates, Commands, BUTTON, pack, SERVICE_UUID };
})();
