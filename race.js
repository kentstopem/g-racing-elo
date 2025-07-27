(function(){
  const { showToast } = window.Helpers;
  const { calculateExpectedScore, calculateActualScore, calculateKFactor } = window.Elo;
  const MIN_RACES_FOR_RANK = 5; // ab so vielen Rennen gilt ein Fahrer/Fahrzeug als „aktiv“

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
      </div>
      <div class="form-group flex-1" style="margin:0;">
        <label>Fahrzeug:</label>
        <select class="car-select">
          <option value="">Fahrzeug wählen...</option>
          ${[...window.appData.cars].sort((a,b)=>a.name.localeCompare(b.name)).map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}
        </select>
      </div>
      <button class="btn btn-danger" onclick="removeRaceEntry(this)">Entfernen</button>`;
    container.appendChild(entry);
  }

  function removeRaceEntry(btn){
    const container=document.getElementById('raceEntries');
    if(container.children.length<=2){showToast('Mindestens 2 Teilnehmer erforderlich!');return;}
    btn.parentElement.remove();
    updateRacePositions();
  }

  function updateRacePositions(){
    document.querySelectorAll('.race-entry').forEach((e,i)=>{
      const lbl=e.querySelector('label');
      if(lbl) lbl.textContent=`Platz ${i+1}:`;
    });
    window.appData.raceCounter=document.querySelectorAll('.race-entry').length;
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
    if(container.children.length===0){for(let i=0;i<6;i++) addRaceEntry();}
    const headerEl=document.getElementById('raceEntriesHeader');
    if(headerEl) headerEl.textContent='Rennen manuell eingeben (Platz 1 bis 6):';
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
    ordered.forEach(r=>{r.results.forEach(res=>{
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
  let selectedDrivers=[];let selectedCars=[];
  let prevSelectedDrivers=[];

  function openSetupModal(){
    if(!setupModal)return;
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
    const rank=window.appData.cars.filter(x=>x.races>=MIN_RACES_FOR_RANK && !x.hideFromRanking).sort((a,b)=>b.elo-a.elo).findIndex(x=>x.id===c.id);
    const rankVal=rank===-1?Number.POSITIVE_INFINITY:rank;
    return [ -rankVal, c.races, c.elo, c.name]; // sort ascending later => weakest first
  }

  finishBtn?.addEventListener('click',()=>{
    if(selectedCars.length!==selectedDrivers.length){showToast('Anzahl Fahrer/Fahrzeuge ungleich');return;}
    // Build pairing
    const drvs=selectedDrivers.map(id=>window.appData.drivers.find(d=>d.id===id));
    const cars=selectedCars.map(id=>window.appData.cars.find(c=>c.id===id));
    const driversSorted=[...drvs].sort((a,b)=>{
      const k1=strengthKeyDriver(a);const k2=strengthKeyDriver(b);
      return k1<k2?-1:1;
    });
    const carsSorted=[...cars].sort((a,b)=>{
      const k1=strengthKeyCar(a);const k2=strengthKeyCar(b);
      return k1<k2?-1:1;
    });
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
    // Platzierungs-Dropdowns anlegen & Entfernen-Buttons ausblenden
    const entries=document.querySelectorAll('.race-entry');
    entries.forEach((entry,idx)=>{
       entry.querySelector('button.btn-danger')?.remove();
       const sel=document.createElement('select');
       sel.className='place-select';
       for(let i=1;i<=entries.length;i++){
          const opt=document.createElement('option');opt.value=i;opt.textContent=`Platz ${i}`;sel.appendChild(opt);
       }
       sel.value=idx+1;
       const wrapper=document.createElement('div');
       wrapper.className='form-group';
       wrapper.style.margin='0';
       const lbl=document.createElement('label');lbl.textContent='Platz:';
       wrapper.appendChild(lbl);
       wrapper.appendChild(sel);
       entry.appendChild(wrapper);
    });
    const headerEl=document.getElementById('raceEntriesHeader');
    if(headerEl) headerEl.textContent='Bitte Platzierungen angeben und Rennen auswerten:';
    setupModal.classList.add('hidden');
  });

  function closeSetup(){setupModal.classList.add('hidden');}
  cancelBtn1?.addEventListener('click',closeSetup);
  cancelBtn2?.addEventListener('click',closeSetup);

  // -------------------- Init --------------------
  function init(){
    const setupBtn=document.getElementById('setupRaceBtn');
    const calcBtn=document.getElementById('calculateRaceBtn');
    if(setupBtn) setupBtn.addEventListener('click', openSetupModal);
    if(calcBtn) calcBtn.addEventListener('click', calculateRace);
    document.getElementById('rebuildEloBtn')?.addEventListener('click', rebuildElo);
    // Erst nach dem Laden der Daten wird das Formular aufgebaut
  }

  window.RaceUI={ init, updateForm:updateRaceForm };
  document.addEventListener('DOMContentLoaded', init);

  // global needed by inline onclicks
  window.removeRaceEntry=removeRaceEntry;
  window.deleteRace=deleteRace;
})(); 