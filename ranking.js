(function(){
  const { tsForRace } = window.Helpers;

  // Filter state
  let minRaces=5;
  let driverFilter=[]; // ids
  let carFilter   =[];

  function isFilterActive(){
    return minRaces!==5 || driverFilter.length>0 || carFilter.length>0;
  }

  // —————————————— Rendering
  function updateDriverRanking(){
    // Auswahl & Filter anwenden
    const selected=[...window.appData.drivers].filter(d=>{
      if(driverFilter.length>0 && !driverFilter.includes(d.id)) return false;
      return true;
    });
    const active=selected.filter(d=>d.races>=minRaces);
    // Sortierung nach GRP
    active.sort((a,b)=>b.elo-a.elo);
    const podium=document.getElementById('driverPodium');
    const list=document.getElementById('driversRanking');

    // Podium nur bei keinem Filter und ausreichend aktiven Fahrern
    const showPodium=!isFilterActive() && active.length>=3;
    if(podium){
      podium.innerHTML = showPodium ? ( ()=>{
        const order=[1,0,2];
        const classes=['second','first','third'];
        const medals=['🥈','🥇','🥉'];
        return order.map(i=>active[i]).filter(Boolean).map((d,idx)=>`
          <div class="podium-item ${classes[idx]}" data-driver-id="${d.id}" onclick="openEloModal('driver',${d.id})">
            <div class="podium-position">${medals[idx]}</div>
            <div class="podium-name">${d.name}</div>
            <div class="podium-elo">${d.elo} G!RP</div>
            <div style="font-size:0.75em;opacity:.9;">${d.races}R · ${d.wins||0}S · ${d.totalRounds||0}Rd</div>
          </div>`).join('');
      })():'';
      podium.classList.toggle('hidden',!showPodium);
    }

    // Liste rendern
    if(list){
      if(selected.length===0){list.innerHTML='<p style="text-align:center;color:#666;">Keine Fahrer</p>';return;}
      let rank=showPodium?4:1;
      const html=[];
      active.slice(showPodium?3:0).forEach(d=>{
        html.push(`<div class="list-item" data-driver-id="${d.id}" onclick="openEloModal('driver',${d.id})">
          <div><strong>#${rank++} ${d.name}</strong><div style="font-size:0.9em;color:#666;">${d.races} Rennen · ${d.wins||0} Siege · ${d.totalRounds||0} Runden</div></div>
          <span class="elo-score">${d.elo}</span></div>`);
      });
      // Inaktive ausgewählte Fahrer anhängen
      const inactive=selected.filter(d=>d.races<minRaces).sort((a,b)=>b.elo-a.elo);
      inactive.forEach(d=>{
        html.push(`<div class="list-item" data-driver-id="${d.id}" onclick="openEloModal('driver',${d.id})">
          <div><strong>— ${d.name}</strong><div class="status-inactive">Ranking ab Rennen ${minRaces}</div><div style="font-size:0.9em;color:#666;">${d.races} Rennen · ${d.wins||0} Siege · ${d.totalRounds||0} Runden</div></div>
          <span class="elo-score">${d.elo}</span></div>`);
      });
      list.innerHTML=html.join('');
    }

    if(typeof window.updateTagline==='function'){window.updateTagline();}
  }

  function updateCarRanking(){
    const selected=[...window.appData.cars].filter(c=>{
      if(c.hideFromRanking) return false;
      if(carFilter.length>0 && !carFilter.includes(c.id)) return false;
      return true;
    });
    const active=selected.filter(c=>c.races>=minRaces).sort((a,b)=>b.elo-a.elo);
    const podium=document.getElementById('carPodium');
    const list=document.getElementById('carsRanking');
    const showPodium=!isFilterActive() && active.length>=3;
    if(podium){
      podium.innerHTML= showPodium ?(()=>{
        const order=[1,0,2];const classes=['second','first','third'];const medals=['🥈','🥇','🥉'];
        return order.map(i=>active[i]).filter(Boolean).map((c,idx)=>`
          <div class="podium-item ${classes[idx]}" data-car-id="${c.id}" onclick="openEloModal('car',${c.id})">
            <div class="podium-position">${medals[idx]}</div>
            <div class="podium-name">${c.name}</div>
            <div class="podium-elo">${c.elo} G!RP</div>
            <div style="font-size:0.75em;opacity:.9;">${c.races}R · ${c.wins||0}S · ${c.totalRounds||0}Rd</div>
          </div>`).join('');
      })():'';
      podium.classList.toggle('hidden',!showPodium);
    }
    if(list){
      if(selected.length===0){list.innerHTML='<p style="text-align:center;color:#666;">Keine Fahrzeuge</p>';return;}
      let rank=showPodium?4:1;
      const html=[];
      active.slice(showPodium?3:0).forEach(c=>{
        html.push(`<div class="list-item" data-car-id="${c.id}" onclick="openEloModal('car',${c.id})">
          <div><strong>#${rank++} ${c.name}</strong><div style="font-size:0.9em;color:#666;">${c.races} Rennen · ${c.wins||0} Siege · ${c.totalRounds||0} Runden</div></div>
          <span class="elo-score">${c.elo}</span></div>`);
      });
      const inactive=selected.filter(c=>c.races<minRaces).sort((a,b)=>b.elo-a.elo);
      inactive.forEach(c=>{
        html.push(`<div class="list-item" data-car-id="${c.id}" onclick="openEloModal('car',${c.id})">
          <div><strong>— ${c.name}</strong><div class="status-inactive">Rang erst ab ${minRaces}. Rennen</div><div style="font-size:0.9em;color:#666;">${c.races} Rennen · ${c.wins||0} Siege · ${c.totalRounds||0} Runden</div></div>
          <span class="elo-score">${c.elo}</span></div>`);
      });
      list.innerHTML=html.join('');
    }
  }

  function update(){ updateDriverRanking(); updateCarRanking(); }

  // —————————————— Sub-Navigation (Fahrer / Fahrzeuge)
  function initSubNav(){
    document.querySelectorAll('.sub-tab').forEach(btn=>{
      btn.addEventListener('click',()=>{
        document.querySelectorAll('.sub-tab').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        const sel=btn.getAttribute('data-rank');
        document.getElementById('driversRankWrapper').classList.toggle('hidden', sel!=='drivers');
        document.getElementById('carsRankWrapper').classList.toggle('hidden', sel!=='cars');
      });
    });
  }

  function initFilter(){
    
    const modal=document.getElementById('rankingFilterModal');
    const listDiv=document.getElementById('rankingFilterList');
    const slider=document.getElementById('minRacesSlider');
    const valSpan=document.getElementById('minRacesVal');
    const applyBtn=document.getElementById('rankingFilterApply');
    const resetBtn=document.getElementById('rankingFilterReset');
    const cancelBtn=document.getElementById('rankingFilterCancel');
    if(!modal) return;

    const allowed=[1,3,5,8,10,15];

    function populateList(){
      const isDriversTab=!document.getElementById('driversRankWrapper').classList.contains('hidden');
      if(isDriversTab){
        listDiv.innerHTML=[...window.appData.drivers].sort((a,b)=>a.name.localeCompare(b.name)).map(d=>`<label style='display:flex;align-items:center;gap:6px;margin:4px 0;'><input type='checkbox' value='${d.id}' ${driverFilter.includes(d.id)?'checked':''}>${d.name}</label>`).join('');
      }else{
        listDiv.innerHTML=[...window.appData.cars].filter(c=>!c.hideFromRanking).sort((a,b)=>a.name.localeCompare(b.name)).map(c=>`<label style='display:flex;align-items:center;gap:6px;margin:4px 0;'><input type='checkbox' value='${c.id}' ${carFilter.includes(c.id)?'checked':''}>${c.name}</label>`).join('');
      }
    }

    document.querySelectorAll('#rankings .ranking-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        // Werte zurücksetzen
        slider.value = minRaces;
        valSpan.textContent = minRaces;
    
        // Liste passend zum aktiven Tab neu aufbauen
        populateList();
    
        // Modal anzeigen
        modal.classList.remove('hidden');
      });
    });

    slider.addEventListener('input',()=>{
      // snap to closest allowed value
      const v=parseInt(slider.value);
      let nearest=allowed.reduce((prev,curr)=>Math.abs(curr-v)<Math.abs(prev-v)?curr:prev);
      slider.value=nearest;valSpan.textContent=nearest;
    });

    applyBtn.addEventListener('click',()=>{
      minRaces=parseInt(slider.value);
      const isDriversTab=!document.getElementById('driversRankWrapper').classList.contains('hidden');
      const checked=[...listDiv.querySelectorAll('input:checked')].map(i=>parseInt(i.value));
      if(isDriversTab){driverFilter=checked;}else{carFilter=checked;}
      modal.classList.add('hidden');
      update();
    });

    resetBtn.addEventListener('click',()=>{
      minRaces=5;driverFilter=[];carFilter=[];
      modal.classList.add('hidden');
      update();
    });

    cancelBtn.addEventListener('click',()=>modal.classList.add('hidden'));
  }

  function init(){
    initSubNav();
    initFilter();
    // Wenn Rankings-Tab initial aktiv ist ⇒ direkt rendern
    if(document.getElementById('rankings').classList.contains('active')){
      update();
    }
  }

  window.RankingUI={ update, init };
  document.addEventListener('DOMContentLoaded', init);
})(); 