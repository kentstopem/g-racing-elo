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
      await this.setup();
      return this.device.name || 'Control Unit';
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
      this.queue = [];
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
    requestVersion () { (this.queue ??= []).push('0'); }

    disconnect () { this.manual = true; this.polling = false; this.device?.gatt?.disconnect(); }

    get connected () { return !!this.device?.gatt?.connected; }
  }

  window.CU = { parse, timestamp, LapTracker, Connection, sessionBest, recordCandidates, SERVICE_UUID };
})();
