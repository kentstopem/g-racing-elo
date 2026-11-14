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
  const esc=window.Helpers.escapeHtml;
  const medals={first:'🥇',second:'🥈',third:'🥉'};

  /**
   * Rangliste für Fahrer oder Fahrzeuge.
   * Saison: sortiert nach G!RP. „Alle Saisons“: ewige Tabelle nach Siegen, dann Rennen.
   */
  function renderRanking(kind){
    const isDriver=kind==='driver';
    const all=window.Seasons.isAll();
    const S=window.Seasons;
    const minRaces=isDriver?(filterMin||DEFAULT_MIN):1;
    const pool=(isDriver?window.appData.drivers:window.appData.cars)
      .filter(x=>!x.archived && (isDriver||!x.hideFromRanking) && x.races>=minRaces);
    const sorted=[...pool].sort(all
      ? (a,b)=>(b.wins-a.wins)||(b.races-a.races)||(b.totalRounds-a.totalRounds)
      : (a,b)=>b.elo-a.elo);
    const podium=document.getElementById(isDriver?'driverPodium':'carPodium');
    const list=document.getElementById(isDriver?'driversRanking':'carsRanking');
    const header=document.getElementById(isDriver?'driversRankHeader':'carsRankHeader');
    const idAttr=isDriver?'data-driver-id':'data-car-id';
    const open=x=>`openEloModal('${kind}',${x.id})`;
    const score=x=>all?`${x.wins} S`:`${x.elo}`;
    const scoreLong=x=>all?`${x.wins} Siege`:`${x.elo} G!RP`;

    if(header){
      const title=isDriver?'🏆 Fahrer':'🏎️ Fahrzeug';
      header.textContent=all?`${title}-Ewige Tabelle`:(S.hasSeasons()?`${title}-Rangliste · ${S.label(S.selectedSeason())}`:`${title}-Rangliste`);
    }

    const showPodium=sorted.length>=3;
    if(podium){
      podium.innerHTML=showPodium?[[1,'second'],[0,'first'],[2,'third']].map(([i,cls])=>{
        const x=sorted[i];
        return `<div class="podium-item ${cls}" ${idAttr}="${x.id}" onclick="${open(x)}">
            <div class="podium-position">${medals[cls]}</div>
            <div class="podium-name">${esc(x.name)}</div>
            <div class="podium-elo">${scoreLong(x)}</div>
            <div style="font-size:0.75em;opacity:.9;">${x.races}R · ${x.wins||0}S · ${x.totalRounds||0}Rd</div>
          </div>`;
      }).join(''):'';
      podium.classList.toggle('hidden',!showPodium);
    }

    if(list){
      if(!sorted.length){
        list.innerHTML=`<p class="empty-state">${window.appData.races.length?'Keine Einträge für diesen Filter':'Noch keine Rennen in dieser Saison'}</p>`;
        return;
      }
      let rank=showPodium?4:1;
      list.innerHTML=sorted.slice(showPodium?3:0).map(x=>`<div class="list-item" ${idAttr}="${x.id}" onclick="${open(x)}">
          <div><strong>#${rank++} ${esc(x.name)}</strong><div>${x.races} Rennen · ${x.wins||0} Siege · ${x.totalRounds||0} Runden</div></div>
          <span class="elo-score">${score(x)}</span></div>`).join('');
    }
  }

  function updateDriverRanking(){
    renderRanking('driver');
    if(typeof window.updateTagline==='function'){window.updateTagline();}
  }
  function updateCarRanking(){ renderRanking('car'); }

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