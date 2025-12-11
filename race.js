(function(){
  const { showToast } = window.Helpers;
  const { calculateExpectedScore, calculateActualScore, calculateKFactor } = window.Elo;
  const MIN_RACES_FOR_RANK = 5; // ab so vielen Rennen gilt ein Fahrer/Fahrzeug als „aktiv“

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
      // Ensure place-select exists and remove remove-buttons (auto-setup style)
      entriesDOM.forEach((entry,idx)=>{
         if(!entry.querySelector('.place-select')){
            let delBtn=entry.querySelector('button.btn-danger');
            if(!delBtn){
               delBtn=document.createElement('button');
               delBtn.className='btn btn-danger';
               entry.appendChild(delBtn);
            }
            delBtn.classList.add('pair-del-btn');
            delBtn.textContent='🗑️';
            delBtn.onclick=function(){removeRaceEntry(delBtn);}
            // add place-select only if not present
            const selExists=false; // placeholder
         }
      });
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
          ${[...window.appData.drivers].sort((a,b)=>a.name.localeCompare(b.name)).map(d=>`<option value="${d.id}">${d.name}</option>`).join('')}
        </select>
        <div class="pred driver-pred"></div>
      </div>
      <div class="form-group flex-1" style="margin:0;">
        <label>Fahrzeug:</label>
        <select class="car-select">
          <option value="">Fahrzeug wählen...</option>
          ${[...window.appData.cars].sort((a,b)=>a.name.localeCompare(b.name)).map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}
        </select>
        <div class="pred car-pred"></div>
      </div>
      <button class="btn btn-danger pair-del-btn" onclick="removeRaceEntry(this)">🗑️</button>`;
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
      // rebuild options if count mismatch
      if(sel.options.length!==total){
        sel.innerHTML='';
        for(let p=1;p<=total;p++){
          const opt=document.createElement('option');opt.value=p;opt.textContent=`Platz ${p}`;sel.appendChild(opt);
        }
      }
      if(!sel.value || sel.value>total){sel.value=i+1;}
    });
    window.appData.raceCounter=rows.length;
  }

  function updateRaceForm(){
    const container=document.getElementById('raceEntries');
    if(!container) return;
    const dateInput=document.getElementById('raceDate');
    if(dateInput&&!dateInput.value){dateInput.value=new Date().toISOString().split('T')[0];}
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

  // ---- Prognosen & Summen -------------------------------------------
  function updatePredictions(){
    const entries=[...document.querySelectorAll('.race-entry')];
    if(entries.length===0) return;
    // Runden für K-Faktor (Default 50, wie in calculateRace)
    const rounds=parseInt(document.getElementById('raceRounds')?.value)||50;
    const totalPlayers=entries.filter(e=>e.querySelector('.driver-select').value && e.querySelector('.car-select').value).length;
    if(totalPlayers<2) return; // keine sinnvolle Prognose
    const k=calculateKFactor(totalPlayers, rounds);

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
    const raceDate=raceDateInput.value||new Date().toISOString().split('T')[0];
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
    // Validierung Platzlücken
    const missing=[];for(let p=1;p<=totalPlayers;p++){if(!chosenPlaces.has(p)) missing.push(p);}if(missing.length){showToast('Platzierungen lückenhaft');return;}
    const kFactor=calculateKFactor(totalPlayers, rounds);

    results.forEach(res=>{
      const otherDriverElos=results.filter(r=>r!==res).map(r=>r.oldDriverElo);
      const otherCarElos   =results.filter(r=>r!==res).map(r=>r.oldCarElo);
      const expectedDriver=calculateExpectedScore(res.oldDriverElo,otherDriverElos);
      const expectedCar   =calculateExpectedScore(res.oldCarElo, otherCarElos);
      const actualScore=calculateActualScore(res.position,totalPlayers);
      const driverEloChange=Math.round(kFactor*(actualScore-expectedDriver));
      const carEloChange   =Math.round(kFactor*(actualScore-expectedCar));
      const driver=window.appData.drivers.find(d=>d.id===res.driverId);
      const car   =window.appData.cars.find(c=>c.id===res.carId);
      if(driver&&car){
        driver.elo=Math.max(100, driver.elo+driverEloChange);
        car.elo   =Math.max(100, car.elo+carEloChange);
        driver.races++;car.races++;
        if(res.position===1){driver.wins=(driver.wins||0)+1;car.wins=(car.wins||0)+1;}
        driver.totalRounds=(driver.totalRounds||0)+rounds;
        car.totalRounds   =(car.totalRounds||0)+rounds;
        res.newDriverElo=driver.elo;
        res.newCarElo   =car.elo;
        res.driverEloChange=driverEloChange;
        res.carEloChange=carEloChange;
        res.eloChange=driverEloChange; // legacy
      }
    });

    // Ergebnisse nach Platzierung sortieren, damit History korrekt angezeigt wird
    results.sort((a,b)=>a.position-b.position);

    // Platzierungen im Gesamtclassement nach diesem Rennen speichern (nur aktive Fahrer/Fahrzeuge)
    const activeDrivers=[...window.appData.drivers].filter(d=>d.races>=MIN_RACES_FOR_RANK).sort((a,b)=>b.elo-a.elo);
    const activeCars   =[...window.appData.cars   ].filter(c=>c.races>=MIN_RACES_FOR_RANK && !c.hideFromRanking).sort((a,b)=>b.elo-a.elo);
    const drvRankMap=new Map(activeDrivers.map((d,i)=>[d.id,i+1]));
    const carRankMap=new Map(activeCars.map((c,i)=>[c.id,i+1]));
    results.forEach(res=>{
      res.positionOverallDriver=drvRankMap.get(res.driverId)??null;
      res.positionOverallCar   =carRankMap.get(res.carId)??null;
    });

    const formattedDate=new Date(raceDate).toLocaleDateString('de-DE');
    const raceTimeInput=document.getElementById('raceTime');
    const raceTime=raceTimeInput&&raceTimeInput.value?raceTimeInput.value:new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
    window.appData.races.unshift({id:Date.now(),date:formattedDate,time:raceTime,rounds,results});
    // Nur neues Rennen speichern
    window.Storage.addRace(window.appData.races[0]).catch(console.error);
    // Gezielte Updates für veränderte Fahrer/Fahrzeuge
    const updatedDrivers=new Set();
    const updatedCars=new Set();
    results.forEach(r=>{updatedDrivers.add(r.driverId);updatedCars.add(r.carId);});
    updatedDrivers.forEach(id=>{
      const d=window.appData.drivers.find(x=>x.id===id);
      if(d) window.Storage.updateDriver(d).catch(console.error);
    });
    updatedCars.forEach(id=>{
      const c=window.appData.cars.find(x=>x.id===id);
      if(c) window.Storage.updateCar(c).catch(console.error);
    });

    // UI auffrischen
    clearRaceDraft();
    const container=document.getElementById('raceEntries');
    if(container){container.innerHTML='';window.appData.raceCounter=0;updateRaceForm();}
    raceDateInput.value='';raceRoundsInput.value='';
    showToast(`Rennen ausgewertet!\nRunden: ${rounds}\nK: ${kFactor}`);
    window.RankingUI.update();
    window.HistoryUI.update();
  }

  // -------------------- Rennen löschen --------------------
  function deleteRace(id){
    const race=window.appData.races.find(r=>r.id===id);
    if(!race){showToast('Rennen nicht gefunden');return;}
    if(!confirm(`Rennen vom ${race.date} wirklich löschen?`))return;
    race.results.forEach(res=>{
      const d=window.appData.drivers.find(x=>x.id===res.driverId);
      const c=window.appData.cars.find(x=>x.id===res.carId);
      if(d&&c){d.elo=res.oldDriverElo;c.elo=res.oldCarElo;d.races--;c.races--;if(res.position===1){d.wins--;c.wins--;}
      d.totalRounds-=race.rounds;c.totalRounds-=race.rounds;}
    });
    window.appData.races=window.appData.races.filter(r=>r.id!==id);
    window.Storage.deleteRace(id).catch(console.error);
    // Fahrer/Fahrzeuge updaten
    const updDrv=new Set();const updCar=new Set();
    race.results.forEach(res=>{updDrv.add(res.driverId);updCar.add(res.carId);});
    updDrv.forEach(i=>{const d=window.appData.drivers.find(x=>x.id===i);if(d) window.Storage.updateDriver(d).catch(console.error);});
    updCar.forEach(i=>{const c=window.appData.cars.find(x=>x.id===i);if(c) window.Storage.updateCar(c).catch(console.error);});
    showToast('Rennen gelöscht');
    window.RankingUI.update();
    window.HistoryUI.update();
    if(typeof updateDriversList==='function') updateDriversList();
    if(typeof updateCarsList==='function') updateCarsList();
  }

  // -------------------- Rebuild Elo --------------------
  function rebuildElo(){
    if(!window.isAdmin){showToast('Nur Admin');return;}
    if(!confirm('Alle G!RP-Werte neu berechnen?')) return;
    window.appData.drivers.forEach(d=>{d.elo=1000;d.races=d.wins=d.totalRounds=0;});
    window.appData.cars.forEach(c=>{c.elo=1000;c.races=c.wins=c.totalRounds=0;});
    // chronologisch sortiert
    const ordered=[...window.appData.races].sort((a,b)=>window.Helpers.tsForRace(a)-window.Helpers.tsForRace(b));
    ordered.forEach(r=>{
      // Reihenfolge sicherstellen (Platz 1,2,3 ...)
      r.results.sort((a,b)=>a.position-b.position);
      r.results.forEach(res=>{
        const driver=window.appData.drivers.find(d=>d.id===res.driverId);
        const car   =window.appData.cars.find(c=>c.id===res.carId);
        if(!(driver&&car))return;
        res.oldDriverElo=driver.elo;res.oldCarElo=car.elo;
        const otherDriverElos=r.results.filter(x=>x!==res).map(x=>window.appData.drivers.find(d=>d.id===x.driverId).elo);
        const otherCarElos   =r.results.filter(x=>x!==res).map(x=>window.appData.cars.find(c=>c.id===x.carId).elo);
        const total=r.results.length;
        const k=calculateKFactor(total, r.rounds);
        const expectedD=calculateExpectedScore(driver.elo,otherDriverElos);
        const expectedC=calculateExpectedScore(car.elo,   otherCarElos);
        const actual=calculateActualScore(res.position,total);
        const dChange=Math.round(k*(actual-expectedD));
        const cChange=Math.round(k*(actual-expectedC));
        driver.elo=Math.max(100,driver.elo+dChange);
        car.elo   =Math.max(100,car.elo+cChange);
        driver.races++;car.races++;if(res.position===1){driver.wins++;car.wins++;}
        driver.totalRounds=(driver.totalRounds||0)+r.rounds;
        car.totalRounds   =(car.totalRounds||0)+r.rounds;
        res.newDriverElo=driver.elo;res.newCarElo=car.elo;res.driverEloChange=dChange;res.carEloChange=cChange;
      });
      // Platzierungen nach Update speichern
      const activeD=[...window.appData.drivers].filter(d=>d.races>=MIN_RACES_FOR_RANK).sort((a,b)=>b.elo-a.elo);
      const activeC=[...window.appData.cars   ].filter(c=>c.races>=MIN_RACES_FOR_RANK && !c.hideFromRanking).sort((a,b)=>b.elo-a.elo);
      const drvRank=new Map(activeD.map((d,i)=>[d.id,i+1]));
      const carRank=new Map(activeC.map((c,i)=>[c.id,i+1]));
      r.results.forEach(res=>{
        res.positionOverallDriver=drvRank.get(res.driverId)??null;
        res.positionOverallCar  =carRank.get(res.carId)??null;
      });
    });
    window.Storage.syncAll(window.appData).catch(console.error);
    showToast('G!RP neu berechnet');
    window.RankingUI.update();
    window.HistoryUI.update();
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
  const pairTableDiv=document.getElementById('pairTable');
  let selectedDrivers=[];let selectedCars=[];
  let prevSelectedDrivers=[];

  function openSetupModal(){
    if(!setupModal)return;
    clearRaceDraft();
    selectedDrivers=[];selectedCars=[];
    // Build driver checklist (alphabetisch)
    driverListDiv.innerHTML=[...window.appData.drivers]
      .sort((a,b)=>a.name.localeCompare(b.name))
      .map(d=>`<label style='display:flex;align-items:center;gap:6px;margin:4px 0;'><input type='checkbox' value='${d.id}' ${prevSelectedDrivers.includes(d.id)?'checked':''}>${d.name}</label>`)
      .join('');
    nextBtn.disabled=true;
    step1.classList.remove('hidden');
    step2.classList.add('hidden');
    setupModal.classList.remove('hidden');
  }

  driverListDiv?.addEventListener('change',()=>{
    selectedDrivers=[...driverListDiv.querySelectorAll('input:checked')].map(i=>parseInt(i.value));
    nextBtn.disabled=selectedDrivers.length<2 || selectedDrivers.length>6;
    if(selectedDrivers.length<2||selectedDrivers.length>6){
        showToast('Bitte 2 bis 6 Fahrer auswählen');
    }
  });

  nextBtn?.addEventListener('click',()=>{
    if(selectedDrivers.length<2||selectedDrivers.length>6){showToast('Bitte 2 bis 6 Fahrer auswählen');return;}
    prevSelectedDrivers=[...selectedDrivers];
    // Build car checklist (alphabetisch, nur im Ranking)
    carListDiv.classList.remove('hidden');
    carListDiv.innerHTML=[...window.appData.cars].filter(c=>!c.hideFromRanking)
      .sort((a,b)=>a.name.localeCompare(b.name))
      .map(c=>`<label style='display:flex;align-items:center;gap:6px;margin:4px 0;'><input type='checkbox' value='${c.id}'>${c.name}</label>`)
      .join('');
    finishBtn.disabled=true;
    step1.classList.add('hidden');
    step2.classList.remove('hidden');
  });

  carListDiv?.addEventListener('change',()=>{
    selectedCars=[...carListDiv.querySelectorAll('input:checked')].map(i=>parseInt(i.value));
    finishBtn.disabled=selectedCars.length!==selectedDrivers.length;
    if(selectedCars.length!==selectedDrivers.length){
        showToast(`Bitte genau ${selectedDrivers.length} Fahrzeuge wählen`);
    }
  });

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
     });
  });

  backBtn?.addEventListener('click',()=>{
    step2.classList.add('hidden');
    step1.classList.remove('hidden');
  });

  function strengthKeyDriver(d){
    const rank=window.appData.drivers.filter(x=>x.races>=MIN_RACES_FOR_RANK).sort((a,b)=>b.elo-a.elo).findIndex(x=>x.id===d.id);
    const rankVal=rank===-1?Number.POSITIVE_INFINITY:rank;
    return [rankVal, -d.races, -d.elo, d.name];
  }
  function strengthKeyCar(c){
    const rank=window.appData.cars.filter(x=>!x.hideFromRanking).sort((a,b)=>b.elo-a.elo).findIndex(x=>x.id===c.id);
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
    // Clear existing entries
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

  function closeSetup(){setupModal.classList.add('hidden');}
  cancelBtn1?.addEventListener('click',closeSetup);
  cancelBtn2?.addEventListener('click',closeSetup);

  function renderPairTable(){
    if(!pairTableDiv) return;
    const allCars=[...window.appData.cars].filter(c=>!c.hideFromRanking);
    let html='<table class="record-table"><thead><tr><th>Fahrer</th><th>Fahrzeug</th><th></th></tr></thead><tbody>';
    selectedDrivers.forEach((dId,idx)=>{
      const driver=window.appData.drivers.find(d=>d.id===dId);
      const carId=selectedCars[idx]||'';
      html+=`<tr><td>${driver?.name||'-'}</td><td><select data-idx="${idx}">`;
      allCars.forEach(c=>{
        const taken=selectedCars.includes(c.id)&&c.id!==carId;
        if(taken) return;
        html+=`<option value="${c.id}" ${c.id===carId?'selected':''}>${c.name}</option>`;
      });
      html+='</select></td>';
      html+=`<td><button class="btn-small" data-del="${idx}">🗑️</button></td></tr>`;
    });
    html+='</tbody></table>';
    pairTableDiv.innerHTML=html;
    // listeners
    pairTableDiv.querySelectorAll('select').forEach(sel=>{
      sel.addEventListener('change',e=>{
        const i=parseInt(e.target.dataset.idx);
        selectedCars[i]=parseInt(e.target.value);
        finishBtn.disabled=selectedCars.length!==selectedDrivers.length;
      });
    });
    pairTableDiv.querySelectorAll('button[data-del]').forEach(btn=>{
      btn.addEventListener('click',e=>{
        const i=parseInt(btn.dataset.del);
        selectedDrivers.splice(i,1);
        selectedCars.splice(i,1);
        renderPairTable();
        finishBtn.disabled=selectedCars.length!==selectedDrivers.length||selectedDrivers.length<2;
      });
    });
  }

  function renderAddEntryButton(){
    const container=document.getElementById('raceEntries');
    if(!container) return;
    let btnRow=document.getElementById('addEntryRow');
    if(container.children.length>=6){ btnRow?.remove(); return; }
    if(!btnRow){
       btnRow=document.createElement('div');
       btnRow.id='addEntryRow';
       btnRow.style.width='100%';btnRow.style.display='flex';btnRow.style.justifyContent='center';
       const btn=document.createElement('button');btn.className='btn';btn.textContent='➕ Paarung hinzufügen';
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
    if(setupBtn) setupBtn.addEventListener('click', openSetupModal);
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

  window.RaceUI={ init, updateForm:updateRaceForm };
  document.addEventListener('DOMContentLoaded', init);

  // global needed by inline onclicks
  window.removeRaceEntry=removeRaceEntry;
  window.deleteRace=deleteRace;
})(); 