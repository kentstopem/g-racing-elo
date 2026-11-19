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
  const places={first:1,second:2,third:3};

  /**
   * Rangliste für Fahrer oder Fahrzeuge.
   * Saison: sortiert nach G!RP. „Alle Saisons“: ewige Tabelle nach Siegen, dann Rennen.
   */
  // Fahrzeugbilder in der Rangliste: Standardbild zur Startnummer sofort, eigenes Bild (Firestore „media“) nachgeladen
  const imgCache={};
  const carImg=(x,cls)=>`<img class="${cls}" data-rankimg="${x.id}" alt="" decoding="async" style="visibility:hidden">`;
  function fillCarImgs(root){
    root?.querySelectorAll('img[data-rankimg]').forEach(img=>{
      const car=(window.appData.cars||[]).find(c=>String(c.id)===img.dataset.rankimg);
      const show=src=>{ if(src){ img.onerror=()=>{img.style.display='none';}; img.onload=()=>{img.style.visibility='';}; img.src=src; } else img.style.display='none'; };
      const UI=window.SetupUI;
      if(!car||!UI) return;
      const key=`${car.id}|${car.imageRev||''}`;
      if(imgCache[key]!==undefined){ show(imgCache[key]); return; }
      if(car.imageRev&&UI.carImageSrc){ UI.carImageSrc(car).then(src=>{ imgCache[key]=src||null; show(src); }).catch(()=>show(UI.carAssetSrc(car))); }
      else { imgCache[key]=UI.carAssetSrc(car); show(imgCache[key]); }
    });
  }

  function renderRanking(kind){
    const isDriver=kind==='driver';
    const all=window.Seasons.isAll();
    const S=window.Seasons;
    const minRaces=isDriver?(filterMin||DEFAULT_MIN):1;
    const pool=(isDriver?window.appData.drivers:window.appData.cars)
      .filter(x=>window.Elo.isActive(x) && x.races>=minRaces);
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
      const title=isDriver?'Fahrer':'Fahrzeug';
      const text=all?`${title}-Ewige Tabelle`:(S.hasSeasons()?`${title}-Rangliste · ${S.label(S.selectedSeason())}`:`${title}-Rangliste`);
      header.innerHTML=window.Helpers.icon(isDriver?'trophy':'car')+esc(text);
    }

    const showPodium=sorted.length>=3;
    if(podium){
      podium.innerHTML=showPodium?[[1,'second'],[0,'first'],[2,'third']].map(([i,cls])=>{
        const x=sorted[i];
        return `<div class="podium-item ${cls}" ${idAttr}="${x.id}" onclick="${open(x)}">
            <div class="podium-position">${places[cls]}</div>
            ${isDriver?'':carImg(x,'podium-car-img')}
            <div class="podium-name">${esc(x.name)}</div>
            <div class="podium-elo">${scoreLong(x)}</div>
            <div style="font-size:0.75em;opacity:.9;">${x.races}R · ${x.wins||0}S · ${x.totalRounds||0}Rd</div>
          </div>`;
      }).join(''):'';
      podium.classList.toggle('hidden',!showPodium);
      if(!isDriver) fillCarImgs(podium);
    }

    if(list){
      if(!sorted.length){
        list.innerHTML=`<p class="empty-state">${window.appData.races.length?'Keine Einträge für diesen Filter':'Noch keine Rennen in dieser Saison'}</p>`;
        return;
      }
      let rank=showPodium?4:1;
      list.innerHTML=sorted.slice(showPodium?3:0).map(x=>`<div class="list-item${isDriver?'':' rank-car'}" ${idAttr}="${x.id}" onclick="${open(x)}">
          ${isDriver?'':`<span class="rank-car-thumb">${carImg(x,'rank-car-img')}</span>`}
          <div class="rank-car-txt"><strong>#${rank++} ${esc(x.name)}</strong><div>${x.races} Rennen · ${x.wins||0} Siege · ${x.totalRounds||0} Runden</div></div>
          <span class="elo-score">${score(x)}</span></div>`).join('');
      if(!isDriver) fillCarImgs(list);
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

    const label=()=>{ btn.innerHTML=window.Helpers.icon('filter')+`ab ${filterMin||DEFAULT_MIN} Rennen`; btn.classList.toggle('filter-active',!!filterMin&&filterMin!==DEFAULT_MIN); };
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