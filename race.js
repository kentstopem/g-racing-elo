(function(){
  const { showToast, escapeHtml: esc } = window.Helpers;
  const { calculateExpectedScore, calculateActualScore, calculateKFactor } = window.Elo;
  const MIN_RACES_FOR_RANK = window.Elo.MIN_RACES_FOR_RANK; // ab so vielen Rennen gilt ein Fahrer/Fahrzeug als „aktiv“

  // ---- Draft Speicher --------------------------------------------------
  const DRAFT_KEY='raceDraft';
  let draftLoading=false;

  function persistRaceDraft() {
    if(draftLoading) return;
    const rows = [...document.getElementById('raceEntries').children]
                 .filter(r => r.classList.contains('race-entry'));
    // only persist if at least one complete row exists
    const hasComplete = rows.some(r=>{
        const d=r.querySelector('.driver-select')?.value;
        const c=r.querySelector('.car-select')?.value;
        return d&&c;
    });
    if(!hasComplete) return;
  
    const entries = rows
      .map((e, idx) => {
        const drv = e.querySelector('.driver-select')?.value;
        const car = e.querySelector('.car-select')?.value;
        if (!drv || !car) return null;                // überspringen
        const plc = e.querySelector('.place-select')?.value || idx + 1;
        return { driverId: +drv, carId: +car, place: +plc };
      })
      .filter(Boolean);                               // nur vollständige Zeilen
  
    const draft = {
      date  : document.getElementById('raceDate')?.value || '',
      time  : document.getElementById('raceTime')?.value || '',
      rounds: document.getElementById('raceRounds')?.value || '',
      entries
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }

  function loadRaceDraft(){
    try{
      const raw=localStorage.getItem(DRAFT_KEY);
      if(!raw) return;
      const draft=JSON.parse(raw);
      if(!draft||!Array.isArray(draft.entries)) return;
      // Set Meta
      if(draft.date) document.getElementById('raceDate').value=draft.date;
      if(draft.time) document.getElementById('raceTime').value=draft.time;
      if(draft.rounds) document.getElementById('raceRounds').value=draft.rounds;

      // Ensure correct amount of entries
      const container=document.getElementById('raceEntries');
      if(container){container.innerHTML='';window.appData.raceCounter=0;}
      draft.entries.forEach(()=>addRaceEntry());
      const entriesDOM=[...document.querySelectorAll('.race-entry')];
      draft.entries.forEach((d,idx)=>{
        const entry=entriesDOM[idx];
        if(!entry) return;
        if(d.driverId) entry.querySelector('.driver-select').value=d.driverId;
        if(d.carId)    entry.querySelector('.car-select').value=d.carId;
        const placeSel=entry.querySelector('.place-select');
        if(placeSel && d.place) placeSel.value=d.place;
      });
      updateRacePositions();
      const headerEl=document.getElementById('raceEntriesHeader');
      if(headerEl) headerEl.textContent='Bitte Platzierungen angeben und Rennen auswerten:';
      updatePredictions();
      setTimeout(updatePredictions,0);
    }catch(e){console.error('Draft load error',e);}
  }

  function clearRaceDraft(){ localStorage.removeItem(DRAFT_KEY);}
  // -------------------- Formular & DOM --------------------
  function addRaceEntry(){
    window.appData.raceCounter++;
    const container=document.getElementById('raceEntries');
    if(!container) return;
    const entry=document.createElement('div');
    entry.className='race-entry';
    entry.innerHTML=`
      <div class="form-group flex-1" style="margin:0;">
        <label>Platz ${window.appData.raceCounter}:</label>
        <select class="driver-select">
          <option value="">Fahrer wählen...</option>
          ${[...window.appData.drivers].filter(d=>!d.archived).sort((a,b)=>a.name.localeCompare(b.name)).map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join('')}
        </select>
        <div class="pred driver-pred"></div>
      </div>
      <div class="form-group flex-1" style="margin:0;">
        <label>Fahrzeug:</label>
        <select class="car-select">
          <option value="">Fahrzeug wählen...</option>
          ${[...window.appData.cars].filter(c=>!c.archived&&!c.practiceOnly).sort((a,b)=>a.name.localeCompare(b.name)).map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}
        </select>
        <div class="pred car-pred"></div>
      </div>
      <button class="btn btn-danger pair-del-btn" onclick="removeRaceEntry(this)" aria-label="Paarung entfernen" title="Paarung entfernen">${window.Helpers.icon('trash')}</button>`;
    container.appendChild(entry);
    updateRacePositions();
    persistRaceDraft();
  }

  function removeRaceEntry(btn){
    const container=document.getElementById('raceEntries');
    if(container.children.length<=2){showToast('Mindestens 2 Teilnehmer erforderlich!');return;}
    btn.parentElement.remove();
    updateRacePositions();
    if(typeof persistRaceDraft==='function') persistRaceDraft();
  }

  function updateRacePositions(){
    const rows=[...document.getElementById('raceEntries').children].filter(r=>r.classList.contains('race-entry'));
    const usedPlaces=new Set();
    rows.forEach((e,i)=>{
      const lbl=e.querySelector('label');
      if(lbl) lbl.textContent=`Platz ${i+1}:`;
      // create place-select if missing
      let sel=e.querySelector('.place-select');
      const total=rows.length;
      if(!sel){
        sel=document.createElement('select');sel.className='place-select';
        const wrap=document.createElement('div');wrap.className='form-group';wrap.style.margin='0';
        const lbl2=document.createElement('label');lbl2.textContent='Platz:';wrap.appendChild(lbl2);wrap.appendChild(sel);
        const comb=document.createElement('div');comb.className='pred combined-pred';wrap.appendChild(comb);
        e.appendChild(wrap);
      }
      // rebuild options if count mismatch – bisherige Wahl behalten, sofern gültig und noch frei
      if(sel.options.length!==total){
        const prev=parseInt(sel.value);
        sel.innerHTML='';
        for(let p=1;p<=total;p++){
          const opt=document.createElement('option');opt.value=p;opt.textContent=`Platz ${p}`;sel.appendChild(opt);
        }
        sel.value=(prev>=1&&prev<=total&&!usedPlaces.has(prev))?prev:i+1;
      }
      if(!sel.value || sel.value>total){sel.value=i+1;}
      usedPlaces.add(parseInt(sel.value));
    });
    window.appData.raceCounter=rows.length;
  }

  /** „Rennen nachtragen“: Datum und Uhrzeit immer frisch vorbelegen, nie aus einem alten Entwurf */
  function resetDateTime(){
    const now=new Date();
    const dateInput=document.getElementById('raceDate');
    if(dateInput) dateInput.value=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const timeInput=document.getElementById('raceTime');
    if(timeInput) timeInput.value=now.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
    persistRaceDraft();
  }

  function updateRaceForm(){
    const container=document.getElementById('raceEntries');
    if(!container) return;
    const dateInput=document.getElementById('raceDate');
    if(dateInput&&!dateInput.value){const n=new Date();dateInput.value=`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;}
    const roundsInput=document.getElementById('raceRounds');
    if(roundsInput&&!roundsInput.value){roundsInput.value='60';}
    const timeInput=document.getElementById('raceTime');
    if(timeInput&&!timeInput.value){timeInput.value=new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});}
    if(!localStorage.getItem(DRAFT_KEY)){
      if(container.children.length===0){
        for(let i=0;i<6;i++) addRaceEntry();
      }
    }
    const headerEl=document.getElementById('raceEntriesHeader');
    if(headerEl) headerEl.textContent='Rennen manuell eingeben (Platz 1 bis 6):';
    draftLoading=true;
    loadRaceDraft();
    updateRacePositions();
    // remove empty rows (no driver & no car)
    [...document.querySelectorAll('.race-entry')].forEach(e=>{
        const drv=e.querySelector('.driver-select')?.value;
        const car=e.querySelector('.car-select')?.value;
        if(!drv && !car) e.remove();
    });
    updateRacePositions();
    renderAddEntryButton();
    draftLoading=false;
  }

  // K-Faktor aus dem Setup (Renneinstellungen); wird mit jedem neuen Rennen gespeichert
  const currentBaseK=()=>window.appData?.raceSettings?.baseK ?? window.Elo.BASE_K;
  const currentBaseRounds=()=>window.appData?.raceSettings?.baseRounds ?? window.Elo.BASE_ROUNDS;
  const currentBaseDrivers=()=>window.appData?.raceSettings?.baseDrivers ?? window.Elo.BASE_DRIVERS;

  // ---- Prognosen & Summen -------------------------------------------
  function updatePredictions(){
    const entries=[...document.querySelectorAll('.race-entry')];
    if(entries.length===0) return;
    // Runden für K-Faktor (Default 50, wie in calculateRace)
    const rounds=parseInt(document.getElementById('raceRounds')?.value)||50;
    const totalPlayers=entries.filter(e=>e.querySelector('.driver-select').value && e.querySelector('.car-select').value).length;
    if(totalPlayers<2) return; // keine sinnvolle Prognose
    const k=calculateKFactor(totalPlayers, rounds, currentBaseK(), currentBaseRounds(), currentBaseDrivers());

    // Sammeln Basisdaten
    const pairs=entries.map((e,idx)=>{
      const driverId=e.querySelector('.driver-select').value;
      const carId   =e.querySelector('.car-select').value;
      const placeSel=e.querySelector('.place-select');
      const place   =placeSel && placeSel.value?parseInt(placeSel.value):idx+1;
      const driver  =window.appData.drivers.find(d=>d.id==driverId);
      const car     =window.appData.cars.find(c=>c.id==carId);
      return {e, driver, car, place};
    });

    pairs.forEach(pair=>{
      const {e, driver, car, place}=pair;
      const drvDiv=e.querySelector('.driver-pred');
      const carDiv=e.querySelector('.car-pred');
      const combDiv=e.querySelector('.combined-pred');

      if(!(driver&&car)){
        if(drvDiv) drvDiv.textContent='';
        if(carDiv) carDiv.textContent='';
        if(combDiv) combDiv.textContent='';
        return;
      }

      // ELO-Summen
      const combined=driver.elo+car.elo;
      if(combDiv){combDiv.textContent=`Σ ${combined} G!RP`;}

      // Δ-Prognosen
      const otherDrvElos=pairs.filter(p=>p!==pair&&p.driver).map(p=>p.driver.elo);
      const otherCarElos=pairs.filter(p=>p!==pair&&p.car).map(p=>p.car.elo);
      if(otherDrvElos.length!==totalPlayers-1){return;} // warten bis alle gewählt

      const expDrv=calculateExpectedScore(driver.elo, otherDrvElos);
      const expCar=calculateExpectedScore(car.elo,    otherCarElos);
      const act   =calculateActualScore(place, totalPlayers);
      const dΔ=Math.round(k*(act-expDrv));
      const cΔ=Math.round(k*(act-expCar));

      if(drvDiv){
        const sign=dΔ>0?'+':'';
        drvDiv.textContent=`${driver.elo} → ${sign}${dΔ} G!RP`;
        drvDiv.classList.toggle('posChange',dΔ>0);
        drvDiv.classList.toggle('negChange',dΔ<0);
      }
      if(carDiv){
        const sign=cΔ>0?'+':'';
        carDiv.textContent=`${car.elo} → ${sign}${cΔ} G!RP`;
        carDiv.classList.toggle('posChange',cΔ>0);
        carDiv.classList.toggle('negChange',cΔ<0);
      }
    });
  }

  // -------------------- Berechnung --------------------
  function calculateRace(){
    const entries=document.querySelectorAll('.race-entry');
    const results=[];
    const chosenPlaces=new Set();
    const raceDateInput=document.getElementById('raceDate');
    const raceRoundsInput=document.getElementById('raceRounds');
    const raceDate=raceDateInput.value||(n=>`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`)(new Date());
    const rounds=parseInt(raceRoundsInput.value)||50;
    if(rounds<1||rounds>999){showToast('Rundenzahl muss zwischen 1 und 999 liegen!');return;}

    // Validierung & Sammeln
    let foundGap=false;
    const entriesArr=[...entries];
    for(let i=0;i<entriesArr.length;i++){
      const driverId=entriesArr[i].querySelector('.driver-select').value;
      const carId   =entriesArr[i].querySelector('.car-select').value;
      const placeSel=entriesArr[i].querySelector('.place-select');
      const placeVal=placeSel?parseInt(placeSel.value):i+1;
      const hasSel=driverId&&carId;
      if(!hasSel){
        foundGap=true;
        const laterFilled=entriesArr.slice(i+1).some(e=>e.querySelector('.driver-select').value&&e.querySelector('.car-select').value);
        if(laterFilled){showToast('Plätze müssen ohne Lücke ausgefüllt werden!');return;}
        continue;
      }
      if(foundGap){showToast('Plätze müssen ohne Lücke ausgefüllt werden!');return;}
      if(results.some(r=>r.driverId==driverId)){showToast('Fahrer kann nicht mehrmals teilnehmen!');return;}
      if(results.some(r=>r.carId==carId)){showToast('Fahrzeug kann nicht mehrmals verwendet werden!');return;}
      const driver=window.appData.drivers.find(d=>d.id==driverId);
      const car   =window.appData.cars.find(c=>c.id==carId);
      if(!(driver&&car)){showToast('Fahrer/Fahrzeug nicht gefunden!');return;}
      if(chosenPlaces.has(placeVal)){showToast('Platzierung doppelt vergeben!');return;}
      chosenPlaces.add(placeVal);
      results.push({
        position:placeVal,
        driverId:+driverId,
        carId:+carId,
        driverName:driver.name,
        carName:car.name,
        oldDriverElo:driver.elo,
        oldCarElo:car.elo
      });
    }
    const totalPlayers=results.length;
    if(totalPlayers<2){showToast('Mindestens 2 Teilnehmer erforderlich!');return;}
    // Validierung Platzlücken
    const missing=[];for(let p=1;p<=totalPlayers;p++){if(!chosenPlaces.has(p)) missing.push(p);}if(missing.length){showToast('Platzierungen lückenhaft');return;}
    const formattedDate=new Date(raceDate).toLocaleDateString('de-DE');
    const raceTimeInput=document.getElementById('raceTime');
    const raceTime=raceTimeInput&&raceTimeInput.value?raceTimeInput.value:new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
    const race={id:Date.now(),date:formattedDate,time:raceTime,rounds,baseK:currentBaseK(),baseRounds:currentBaseRounds(),baseDrivers:currentBaseDrivers(),results};

    const { kFactor, saved } = commitRace(race);
    saved.catch(()=>{});   // Fehler zeigt commitRace als Hinweis an

    // UI auffrischen – Datum und Runden bleiben für das nächste Rennen stehen, Uhrzeit wird aktualisiert
    clearRaceDraft();
    const container=document.getElementById('raceEntries');
    if(container){container.innerHTML='';window.appData.raceCounter=0;}
    const timeInput=document.getElementById('raceTime');
    if(timeInput) timeInput.value=new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
    updateRaceForm();
    showToast(`Rennen ausgewertet!\nRunden: ${rounds}\nK: ${kFactor}`);
  }

  /**
   * Rennen berechnen und speichern (einzige Stelle – Formular „Neues Rennen“ und Livecenter).
   * Gibt den K-Faktor und das Speicher-Promise zurück.
   */
  function commitRace(race){
    const totalPlayers=race.results.length, rounds=race.rounds;
    // Rennen nachgetragen (liegt zeitlich vor dem letzten gespeicherten Rennen)?
    // Dann müssen alle späteren Rennen neu bewertet werden.
    // Gehört das Rennen in eine frühere Saison oder liegt es vor dem letzten Rennen der Saison?
    // Dann müssen spätere Rennen neu bewertet werden.
    const S=window.Seasons;
    const lastRace=window.Elo.sortChronologically(window.appData.races).pop();
    const isBackfill=S.seasonOfRace(race)!==S.current().id
      || (lastRace && window.Helpers.tsForRace(race) < window.Helpers.tsForRace(lastRace));

    let kFactor;
    if(isBackfill){
      // Ergebnis auf einer Kopie der gesamten Historie (pro Saison) berechnen.
      // Die Werte aller späteren Rennen korrigiert anschließend sync.js automatisch.
      const copy=structuredClone({drivers:window.appData.drivers,cars:window.appData.cars,races:[race,...(window.appData.allRaces||window.appData.races)]});
      window.Elo.recomputeSeasons(copy, S.seasonOfRace);
      race.results=copy.races[0].results;
      kFactor=calculateKFactor(totalPlayers, rounds, race.baseK, race.baseRounds, race.baseDrivers);
    }else{
      // Ansicht ist beim Erfassen immer die aktuelle Saison → appData.drivers/cars = aktuelle Werte
      kFactor=window.Elo.applyRace(race, window.appData.drivers, window.appData.cars);
      window.Elo.storeOverallPositions(race, window.appData.drivers, window.appData.cars);
    }
    window.appData.races.unshift(race);
    // Nur das Rennen speichern – G!RP der Fahrer/Fahrzeuge wird aus den Rennen berechnet.
    const saved=window.Storage.saveRace(race)
      .then(()=>{ if(isBackfill) window.Sync.schedule(0); })
      .catch(err=>{console.error(err);showToast('Rennen konnte nicht gespeichert werden!', { icon: 'alert' }); throw err;});
    window.RankingUI?.update();
    window.HistoryUI?.update();
    return { kFactor, saved };
  }

  /**
   * Für das Livecenter: Ergebnis direkt speichern, ohne Formular.
   * entries: [{ position, driverId, carId, carLaps? }], date: 'YYYY-MM-DD', time: 'HH:MM'
   * carLaps: [{ carId, laps }] Runden je Fahrzeug, wenn der Fahrer das Auto getauscht hat (→ results[i].carLaps)
   */
  function saveRaceResult({ date, time, rounds, entries }){
    const results=[];
    for(const e of entries){
      const driver=window.appData.drivers.find(d=>String(d.id)===String(e.driverId));
      const car   =window.appData.cars.find(c=>String(c.id)===String(e.carId));
      if(!(driver&&car)) return { error:'Fahrer oder Fahrzeug nicht gefunden' };
      const res={ position:e.position, driverId:driver.id, carId:car.id, driverName:driver.name, carName:car.name, oldDriverElo:driver.elo, oldCarElo:car.elo };
      // Autotausch während des Rennens: Runden je Fahrzeug (nur dann – sonst zählt wie bisher die Renndistanz fürs gewertete Auto)
      const segs=(e.carLaps||[]).filter(s=>s&&s.carId!=null&&s.laps>0).map(s=>({ carId:s.carId, laps:s.laps }));
      if(segs.length>1||(segs.length===1&&String(segs[0].carId)!==String(car.id))) res.carLaps=segs;
      results.push(res);
    }
    if(results.length<2) return { error:'Mindestens 2 Teilnehmer erforderlich' };
    const race={ id:Date.now(), date:new Date(date).toLocaleDateString('de-DE'), time, rounds, baseK:currentBaseK(), baseRounds:currentBaseRounds(), baseDrivers:currentBaseDrivers(), results };
    const { kFactor, saved }=commitRace(race);
    return { race, kFactor, saved };
  }

  // -------------------- Rennen löschen --------------------
  // Danach berechnet sync.js alle Werte aus der verbleibenden Historie neu und speichert die Abweichungen.
  async function deleteRace(id){
    const race=window.appData.races.find(r=>r.id===id);
    if(!race){showToast('Rennen nicht gefunden');return;}
    if(!confirm(`Rennen vom ${race.date} wirklich löschen?\nAlle G!RP-Werte werden danach neu berechnet.`))return;
    try{
      await window.Storage.deleteRace(id);
      await window.Sync.heal();
      showToast('Rennen gelöscht, G!RP neu berechnet');
    }catch(err){
      console.error(err);
      showToast('Löschen fehlgeschlagen – Verbindung prüfen!', { icon: 'alert' });
    }
  }

  // -------------------- Rebuild Elo --------------------
  // Prüft alle gespeicherten Werte gegen die Renn-Historie und korrigiert Abweichungen.
  async function rebuildElo(){
    if(!window.isAdmin){showToast('Nur Admin');return;}
    if(!confirm('Alle G!RP-Werte neu berechnen?')) return;
    const n=await window.Sync.heal();
    showToast(n?`G!RP neu berechnet – ${n} Einträge korrigiert`:'Alle G!RP-Werte sind bereits korrekt');
  }

  // -------------------- Auto-Setup Modal --------------------
  const setupModal=document.getElementById('raceSetupModal');
  const step1=document.getElementById('setupStep1');
  const step2=document.getElementById('setupStep2');
  const driverListDiv=document.getElementById('setupDriverList');
  const carListDiv=document.getElementById('setupCarList');
  const nextBtn=document.getElementById('setupNextBtn');
  const backBtn=document.getElementById('setupBackBtn');
  const finishBtn=document.getElementById('setupFinishBtn');
  const cancelBtn1=document.getElementById('setupCancelBtn');
  const cancelBtn2=document.getElementById('setupCancelBtn2');
  const wheelBtn=document.getElementById('setupLuckyWheelBtn');
  const slotBtn=document.getElementById('setupSlotBtn');
  const memoryBtn=document.getElementById('setupMemoryBtn');
  let selectedDrivers=[];let selectedCars=[];
  let prevSelectedDrivers=[];
  let setupDone=null;   // Livecenter: fertige Paarungen an einen Callback statt ins Formular
  let autoMethod=null;  // Livecenter: 'wheel' | 'slot' | 'memory' startet nach „Weiter“ direkt die Auslosung
  let autoMode=null;    // Livecenter: Modus der Sitzung ('practice' | 'quali' | 'race')

  /** Auto-Setup für das Livecenter: Fahrer (vorausgewählt) → Fahrzeuge → onDone([{driverId, carId}]) */
  function openAutoSetup({ drivers, onDone, method, mode }={}){
    // vorausgewählt sind genau die Fahrer, die schon auf einem Regler sitzen (keiner → keiner)
    if(Array.isArray(drivers)) prevSelectedDrivers=drivers.map(Number);
    openSetupModal();
    setupDone=typeof onDone==='function'?onDone:null;
    autoMethod=['wheel','slot','memory'].includes(method)?method:null;
    autoMode=mode||null;
  }

  function openSetupModal(){
    if(!setupModal)return;
    setupDone=null;autoMethod=null;autoMode=null;
    selectedCars=[];
    // zuletzt gewählte (noch vorhandene) Fahrer sind vorausgewählt
    selectedDrivers=prevSelectedDrivers.filter(id=>window.appData.drivers.some(d=>d.id===id&&window.Elo.isActive(d)));
    // Fahrerliste: meiste Rennen insgesamt (alle Saisons) zuerst, bei Gleichstand alphabetisch; nur aktive
    const total=new Map();
    (window.appData.allRaces||window.appData.races||[]).forEach(r=>(r.results||[]).forEach(res=>total.set(res.driverId,(total.get(res.driverId)||0)+1)));
    const cnt=d=>total.get(d.id)||0;
    driverListDiv.innerHTML=[...window.appData.drivers].filter(d=>window.Elo.isActive(d))
      .sort((a,b)=>(cnt(b)-cnt(a))||a.name.localeCompare(b.name))
      .map(d=>{const n=cnt(d);return `<label class='pick-row'><input type='checkbox' value='${d.id}' ${selectedDrivers.includes(d.id)?'checked':''}><span class='pick-check' aria-hidden='true'><svg viewBox='0 0 24 24'><path d='M5 12.5l4.5 4.5L19 7.5'/></svg></span><span class='pick-name'>${esc(d.name)}</span><span class='pick-meta'>${n} Rennen</span></label>`;})
      .join('');
    updateDriverCount();
    nextBtn.disabled=selectedDrivers.length<2||selectedDrivers.length>6;
    step1.classList.remove('hidden');
    step2.classList.add('hidden');
    setupModal.classList.remove('hidden');
  }

  function updateDriverCount(){
    const n=selectedDrivers.length, ok=n>=2&&n<=6;
    const el=document.getElementById('setupDriverCount');
    if(el){
      el.textContent=n===0?'2 bis 6 Fahrer antippen':n===1?'1 Fahrer gewählt – mindestens 2':n>6?`${n} gewählt – höchstens 6`:`${n} Fahrer gewählt`;
      el.classList.toggle('ok',ok);
      el.classList.toggle('warn',n>6);
    }
    nextBtn.disabled=!ok;
  }

  driverListDiv?.addEventListener('change',()=>{
    selectedDrivers=[...driverListDiv.querySelectorAll('input:checked')].map(i=>parseInt(i.value));
    updateDriverCount();
  });

  nextBtn?.addEventListener('click',()=>{
    if(selectedDrivers.length<2||selectedDrivers.length>6){showToast('Bitte 2 bis 6 Fahrer auswählen');return;}
    prevSelectedDrivers=[...selectedDrivers];
    // Build car checklist (alphabetisch, nur aktive)
    carListDiv.classList.remove('hidden');
    // nur aktive und nicht wegen Schaden gesperrte (offener Motor-/Sensorschaden) – davon ziehen auch Glücksrad, Slotmachine, Memorykarten und Zufall
    carListDiv.innerHTML=[...window.appData.cars].filter(c=>window.Elo.isActive(c)&&!window.Damage?.isLocked(c)&&!c.practiceOnly)   /* Auslosen nie mit „Nur Training“-Autos, auch nicht im Training (Tristan 21.11.) – die gibt es nur in der Zuweisung von Hand */
      .sort((a,b)=>a.name.localeCompare(b.name))
      .map(c=>`<label class='pick-row'><input type='checkbox' value='${c.id}'><span class='pick-check' aria-hidden='true'><svg viewBox='0 0 24 24'><path d='M5 12.5l4.5 4.5L19 7.5'/></svg></span><span class='pick-name'>${esc(c.name)}</span></label>`)
      .join('');
    selectedCars=[];
    updateCarCount();
    step1.classList.add('hidden');
    step2.classList.remove('hidden');
    // aus dem Livecenter mit gewählter Methode: gleich auslosen (Abbrechen → normale Fahrzeugwahl)
    const m=autoMethod; autoMethod=null;
    if(m) ({wheel:wheelBtn,slot:slotBtn,memory:memoryBtn})[m]?.click();
  });

  carListDiv?.addEventListener('change',()=>{
    selectedCars=[...carListDiv.querySelectorAll('input:checked')].map(i=>parseInt(i.value));
    updateCarCount();
  });

  function updateCarCount(){
    const n=selectedCars.length, need=selectedDrivers.length;
    const el=document.getElementById('setupCarCount');
    if(el){
      el.textContent=n===0?`${need} Fahrzeuge antippen oder auslosen`:n>need?`${n} von ${need} gewählt – zu viele`:`${n} von ${need} Fahrzeugen gewählt`;
      el.classList.toggle('ok',n===need);
      el.classList.toggle('warn',n>need);
    }
    finishBtn.disabled=n!==need;
  }

  wheelBtn?.addEventListener('click',()=>{
     // choose cars randomly among selectable cars not yet picked
     const available=[...carListDiv.querySelectorAll('input:not(:checked)')].map(i=>parseInt(i.value));
     const need=selectedDrivers.length;
     if(need===0){showToast('Bitte erst Fahrer wählen');return;}
     const picked=Wheel.open?Wheel.open(available, need, (list)=>{
        // mark checkboxes
        carListDiv.querySelectorAll('input').forEach(i=>{i.checked=false;});
        list.forEach(id=>{
           const box=carListDiv.querySelector(`input[value="${id}"]`);
           if(box) box.checked=true;
        });
        // trigger change to update selection
        carListDiv.dispatchEvent(new Event('change'));
        finishIfComplete();
     }):null;
  });

  slotBtn?.addEventListener('click',()=>{
     const available=[...carListDiv.querySelectorAll('input:not(:checked)')].map(i=>parseInt(i.value));
     const need=selectedDrivers.length;
     if(need===0){showToast('Bitte erst Fahrer wählen');return;}
     Slot.open(available,need,(list)=>{
        carListDiv.querySelectorAll('input').forEach(i=>{i.checked=false;});
        list.forEach(id=>{
           const box=carListDiv.querySelector(`input[value="${id}"]`);
           if(box) box.checked=true;
        });
        carListDiv.dispatchEvent(new Event('change'));
        finishIfComplete();
     });
  });

  memoryBtn?.addEventListener('click',()=>{
     const available=[...carListDiv.querySelectorAll('input:not(:checked)')].map(i=>parseInt(i.value));
     const need=selectedDrivers.length;
     if(need===0){showToast('Bitte erst Fahrer wählen');return;}
     window.Memory?.open(available,need,(list)=>{
        carListDiv.querySelectorAll('input').forEach(i=>{i.checked=false;});
        list.forEach(id=>{
           const box=carListDiv.querySelector(`input[value="${id}"]`);
           if(box) box.checked=true;
        });
        carListDiv.dispatchEvent(new Event('change'));
        finishIfComplete();
     });
  });

  // Zufall: fehlende Fahrzeuge ohne Animation aus den noch nicht gewählten ziehen
  document.getElementById('setupRandomBtn')?.addEventListener('click',()=>{
     const need=selectedDrivers.length-selectedCars.length;
     if(need<=0){finishIfComplete();return;}
     const pool=[...carListDiv.querySelectorAll('input:not(:checked)')].map(i=>i.value);
     if(pool.length<need){showToast(`Zu wenige Fahrzeuge: ${pool.length} verfügbar, ${need} benötigt`);return;}
     for(let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
     pool.slice(0,need).forEach(id=>{const box=carListDiv.querySelector(`input[value="${id}"]`); if(box) box.checked=true;});
     carListDiv.dispatchEvent(new Event('change'));
     finishIfComplete();
  });

  // Glücksrad/Slotmachine haben alle Autos gezogen → direkt die fertigen Paarungen anzeigen
  function finishIfComplete(){
    if(selectedDrivers.length>=2 && selectedCars.length===selectedDrivers.length) finishBtn.click();
  }

  backBtn?.addEventListener('click',()=>{
    step2.classList.add('hidden');
    step1.classList.remove('hidden');
  });

  function strengthKeyDriver(d){
    const rank=window.appData.drivers.filter(x=>x.races>=MIN_RACES_FOR_RANK&&window.Elo.isActive(x)).sort((a,b)=>b.elo-a.elo).findIndex(x=>x.id===d.id);
    const rankVal=rank===-1?Number.POSITIVE_INFINITY:rank;
    return [rankVal, -d.races, -d.elo, d.name];
  }
  // Matching: Fahrzeuge werden ab dem ersten Rennen nach ihren G!RP-Punkten eingestuft.
  function strengthKeyCar(c){
    const rank=window.appData.cars.filter(x=>window.Elo.isActive(x)).sort((a,b)=>b.elo-a.elo).findIndex(x=>x.id===c.id);
    const rankVal=rank===-1?Number.POSITIVE_INFINITY:rank;
    return [ -rankVal, c.races, c.elo, c.name]; // sort ascending later => weakest first
  }

  finishBtn?.addEventListener('click',()=>{
    if(selectedCars.length!==selectedDrivers.length){showToast('Anzahl Fahrer/Fahrzeuge ungleich');return;}
    // Build pairing
    const drvs=selectedDrivers.map(id=>window.appData.drivers.find(d=>d.id===id));
    const cars=selectedCars.map(id=>window.appData.cars.find(c=>c.id===id));
    function cmpArrays(arr1,arr2){
      for(let i=0;i<Math.min(arr1.length,arr2.length);i++){
        if(arr1[i]<arr2[i]) return -1;
        if(arr1[i]>arr2[i]) return 1;
      }
      return 0;
    }
    const driversSorted=[...drvs].sort((a,b)=>cmpArrays(strengthKeyDriver(a),strengthKeyDriver(b)));
    const carsSorted=[...cars].sort((a,b)=>cmpArrays(strengthKeyCar(a),strengthKeyCar(b)));
    if(setupDone){
      const cb=setupDone; setupDone=null;
      setupModal.classList.add('hidden');
      cb(driversSorted.map((d,i)=>({driverId:d.id,carId:carsSorted[i].id})));
      return;
    }
    // Bisherigen Entwurf durch die neue Paarung ersetzen
    clearRaceDraft();
    const container=document.getElementById('raceEntries');
    if(container){container.innerHTML='';window.appData.raceCounter=0;}
    driversSorted.forEach((d,idx)=>{
      addRaceEntry();
      const entry=document.querySelectorAll('.race-entry')[idx];
      entry.querySelector('.driver-select').value=d.id;
      entry.querySelector('.car-select').value=carsSorted[idx].id;
    });
    updateRacePositions();
    // Labels von Platz → Fahrer ändern
    document.querySelectorAll('.race-entry').forEach((e,i)=>{
       const lbl=e.querySelector('label');
       if(lbl) lbl.textContent=`Fahrer ${i+1}:`;
    });
    // Platzierungs-Dropdowns werden nun zentral in updateRacePositions() erzeugt
    const headerEl=document.getElementById('raceEntriesHeader');
    if(headerEl) headerEl.textContent='Bitte Platzierungen angeben und Rennen auswerten:';
    setupModal.classList.add('hidden');
    updatePredictions();
    persistRaceDraft();
  });

  function closeSetup(){setupModal.classList.add('hidden');setupDone=null;autoMethod=null;}
  cancelBtn1?.addEventListener('click',closeSetup);
  cancelBtn2?.addEventListener('click',closeSetup);

  function renderAddEntryButton(){
    const container=document.getElementById('raceEntries');
    if(!container) return;
    let btnRow=document.getElementById('addEntryRow');
    if(container.children.length>=6){ btnRow?.remove(); return; }
    if(!btnRow){
       btnRow=document.createElement('div');
       btnRow.id='addEntryRow';
       btnRow.style.width='100%';btnRow.style.display='flex';btnRow.style.justifyContent='center';
       const btn=document.createElement('button');btn.className='btn';btn.innerHTML=`${window.Helpers.icon('plus')}Paarung hinzufügen`;
       btn.onclick=()=>{ addRaceEntry(); renderAddEntryButton(); persistRaceDraft?.(); };
       btnRow.appendChild(btn);
       btnRow.style.width='100%';btnRow.style.display='flex';btnRow.style.justifyContent='center';
       container.parentElement.insertBefore(btnRow, container.nextSibling);
    }
  }

  // -------------------- Init --------------------
  function init(){
    const setupBtn=document.getElementById('setupRaceBtn');
    const calcBtn=document.getElementById('calculateRaceBtn');
    if(setupBtn) setupBtn.addEventListener('click', ()=>openSetupModal());
    if(calcBtn) calcBtn.addEventListener('click', calculateRace);
    document.getElementById('rebuildEloBtn')?.addEventListener('click', rebuildElo);
    // Erst nach dem Laden der Daten wird das Formular aufgebaut
    // Live-Updates der Prognosen
    document.getElementById('raceEntries')?.addEventListener('change',e=>{
      if(e.target.matches('.driver-select, .car-select, .place-select')){
         updatePredictions();
         persistRaceDraft();
      }
    });
    // Draft speichern beim Ändern des Formulars
    document.getElementById('raceDate')?.addEventListener('change', persistRaceDraft);
    document.getElementById('raceTime')?.addEventListener('change', persistRaceDraft);
    document.getElementById('raceRounds')?.addEventListener('change', persistRaceDraft);
  }

  window.RaceUI={ init, updateForm:updateRaceForm, refreshPredictions:updatePredictions, saveRaceResult, openAutoSetup, resetDateTime };
  document.addEventListener('DOMContentLoaded', init);

  // global needed by inline onclicks
  window.removeRaceEntry=removeRaceEntry;
  window.deleteRace=deleteRace;
})(); 