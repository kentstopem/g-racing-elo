// updateRecords.js – automatischer Import neuer Bestzeiten aus SmartRace-Backup
// Aufruf: node updateRecords.js path/to/sr/  [serviceAccount.json]
//
// 1. Sucht die neueste *.srbk-Datei im sr-Verzeichnis
// 2. Parsed das JSON, ermittelt Bestzeiten pro Fahrer & Fahrzeug
// 3. Vergleicht sie mit den vorhandenen Firestore-Einträgen (driverRecords & carRecords)
// 4. Schreibt nur echte Verbesserungen
//
// Voraussetzungen:
// • node >= 14
// • npm i firebase-admin
// • serviceAccount-JSON entweder via 2. CLI-Argument übergeben oder per ENV "GOOGLE_APPLICATION_CREDENTIALS"

import fs from 'fs';
import path from 'path';
import admin from 'firebase-admin';

//////////////////////////////
// Konfiguration            //
//////////////////////////////

const SR_DIR = process.argv[2] || 'sr';
const SERVICE_JSON = process.argv[3] || process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!SERVICE_JSON) {
  console.error('Fehlender Service-Account-Key – Übergib serviceAccount.json als 2. Parameter oder setze $GOOGLE_APPLICATION_CREDENTIALS');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(fs.readFileSync(SERVICE_JSON, 'utf8'))),
});

const db = admin.firestore();

//////////////////////////////
// Hilfsfunktionen          //
//////////////////////////////

function findLatestBackup(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.srbk'));
  if (!files.length) throw new Error('Keine *.srbk Datei im Verzeichnis gefunden');
  files.sort(); // Zeitstempel steckt im Namen => lexikographisch reicht
  return path.join(dir, files[files.length - 1]);
}

function parseBackup(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function bestPer(key, arr) {
  const best = new Map();
  for (const rec of arr) {
    const k = rec[key];
    if (!k) continue;
    if (!best.has(k) || rec.laptime < best.get(k).laptime) {
      best.set(k, rec);
    }
  }
  return [...best.values()];
}

async function upsertPairRecord(rec) {
  const col = db.collection('lapRecords');
  const q = await col.where('driverId','==',rec.driver_id).where('carId','==',rec.car_id).get();
  const data = {
    driverId: rec.driver_id,
    carId   : rec.car_id,
    time    : rec.laptime/1000,
    date    : rec.date,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if(q.empty){ await col.add(data); return 'added'; }
  const doc=q.docs[0];
  if(data.time<doc.data().time){ await doc.ref.set(data); return 'updated'; }
  return 'skipped';
}

//////////////////////////////
// Hauptablauf              //
//////////////////////////////
(async () => {
  try {
    const backupFile = findLatestBackup(SR_DIR);
    console.log('Neuestes Backup:', backupFile);
    const dump = parseBackup(backupFile);
    const records = dump.db.data.inserts.records;
    if (!records) throw new Error('Keine records-Tabelle im Backup');

    const bestPairs = bestPer('combined', records.map(r=>({ ...r, combined:`${r.driver_id}-${r.car_id}` })));
    let adds=0, ups=0;
    for(const r of bestPairs){
       const res=await upsertPairRecord(r);
       if(res==='added') adds++; else if(res==='updated') ups++;
    }
    console.log(`Fertig. Neu: ${adds}, Aktualisiert: ${ups}`);
    process.exit(0);
  } catch (e) {
    console.error('Fehler:', e.message);
    process.exit(1);
  }
})();