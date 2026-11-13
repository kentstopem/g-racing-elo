(function(){
  const { tsForRace } = window.Helpers;

  // Filter der Fahrerliste: „nur Fahrer mit mindestens x Rennen“ (null = kein Filter)
  const DEFAULT_MIN=window.Elo.MIN_RACES_FOR_RANK;
  const FILTER_KEY='rankingMinRaces';
  let filterMin=null;
  try{ const v=parseInt(localStorage.getItem(FILTER_KEY)); if(v>0) filterMin=v; }catch(e){}

  function saveFilter(){
    try{ filterMin?localStorage.setItem(FILTER_KEY,filterMin):localStorage.removeItem(FILTER_KEY); }catch(e){}
  }

  // —————————————— Rendering
  function updateDriverRanking(){
    // Auswahl & Filter anwenden
    const minRaces=filterMin||DEFAULT_MIN;
    const selected=[...window.appData.drivers].filter(d=>!d.archived);
    const active=selected.filter(d=>d.races>=minRaces);
    // Sortierung nach GRP
    active.sort((a,b)=>b.elo-a.elo);
    const podium=document.getElementById('driverPodium');
    const list=document.getElementById('driversRanking');

    // Podium bei mindestens drei gewerteten Fahrern
    const showPodium=active.length>=3;
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
      if(selected.length===0){list.innerHTML='<p style="text-align:center;color:var(--text-muted);">Keine Fahrer</p>';return;}
      let rank=showPodium?4:1;
      const html=[];
      active.slice(showPodium?3:0).forEach(d=>{
        html.push(`<div class="list-item" data-driver-id="${d.id}" onclick="openEloModal('driver',${d.id})">
          <div><strong>#${rank++} ${d.name}</strong><div style="font-size:0.9em;color:var(--text-muted);">${d.races} Rennen · ${d.wins||0} Siege · ${d.totalRounds||0} Runden</div></div>
          <span class="elo-score">${d.elo}</span></div>`);
      });
      // Ohne Filter: Fahrer mit zu wenigen Rennen unten anhängen. Mit Filter: ausblenden.
      const inactive=filterMin?[]:selected.filter(d=>d.races<minRaces).sort((a,b)=>b.elo-a.elo);
      inactive.forEach(d=>{
        html.push(`<div class="list-item" data-driver-id="${d.id}" onclick="openEloModal('driver',${d.id})">
          <div><strong>— ${d.name}</strong><div class="status-inactive">Ranking ab Rennen ${minRaces}</div><div style="font-size:0.9em;color:var(--text-muted);">${d.races} Rennen · ${d.wins||0} Siege · ${d.totalRounds||0} Runden</div></div>
          <span class="elo-score">${d.elo}</span></div>`);
      });
      list.innerHTML=html.join('');
    }

    if(typeof window.updateTagline==='function'){window.updateTagline();}
  }

  function updateCarRanking(){
    const selected=[...window.appData.cars].filter(c=>!c.hideFromRanking&&!c.archived);
    const active=[...selected].sort((a,b)=>b.elo-a.elo);
    const podium=document.getElementById('carPodium');
    const list=document.getElementById('carsRanking');
    const showPodium=active.length>=3;
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
      if(selected.length===0){list.innerHTML='<p style="text-align:center;color:var(--text-muted);">Keine Fahrzeuge</p>';return;}
      let rank=showPodium?4:1;
      const html=[];
      active.slice(showPodium?3:0).forEach(c=>{
        html.push(`<div class="list-item" data-car-id="${c.id}" onclick="openEloModal('car',${c.id})">
          <div><strong>#${rank++} ${c.name}</strong><div style="font-size:0.9em;color:var(--text-muted);">${c.races} Rennen · ${c.wins||0} Siege · ${c.totalRounds||0} Runden</div></div>
          <span class="elo-score">${c.elo}</span></div>`);
      });
      // Kein Inaktiv-Bereich für Fahrzeuge; sie sind ab dem ersten Rennen direkt gültig
      list.innerHTML=html.join('');
    }
  }

  function update(){ updateDriverRanking(); updateCarRanking(); }

  // —————————————— Sub-Navigation (Fahrer / Fahrzeuge)
  // Nur die Ranglisten-Buttons (oben in der Navigation und in der Sektion), nicht die von Rekorden/Statistik
  function initSubNav(){
    const buttons=document.querySelectorAll('#rankSubNav .sub-tab');
    buttons.forEach(btn=>{
      btn.addEventListener('click',()=>{
        const sel=btn.getAttribute('data-rank');
        buttons.forEach(b=>b.classList.toggle('active', b.getAttribute('data-rank')===sel));
        document.getElementById('driversRankWrapper').classList.toggle('hidden', sel!=='drivers');
        document.getElementById('carsRankWrapper').classList.toggle('hidden', sel!=='cars');
      });
    });
  }

  function initFilter(){
    const modal=document.getElementById('rankingFilterModal');
    const btn=document.getElementById('driverFilterBtn');
    const slider=document.getElementById('minRacesSlider');
    const valSpan=document.getElementById('minRacesVal');
    if(!modal||!btn) return;

    const label=()=>{ btn.textContent=filterMin?`🔍 ab ${filterMin} Rennen`:'🔍 Filter'; btn.classList.toggle('filter-active',!!filterMin); };
    label();

    btn.addEventListener('click',()=>{
      slider.value=filterMin||DEFAULT_MIN;
      valSpan.textContent=slider.value;
      modal.classList.remove('hidden');
    });
    slider.addEventListener('input',()=>{ valSpan.textContent=slider.value; });
    document.getElementById('rankingFilterApply').addEventListener('click',()=>{
      filterMin=parseInt(slider.value);
      saveFilter(); label(); modal.classList.add('hidden'); update();
    });
    document.getElementById('rankingFilterReset').addEventListener('click',()=>{
      filterMin=null;
      saveFilter(); label(); modal.classList.add('hidden'); update();
    });
    document.getElementById('rankingFilterCancel').addEventListener('click',()=>modal.classList.add('hidden'));
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