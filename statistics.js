/* Statistik-Modul */
(function(){
  const tblWrap=document.getElementById('statsTableWrap');
  const drvBtn=document.getElementById('statsDriversBtn');
  const carBtn=document.getElementById('statsCarsBtn');
  const filterBtn=document.getElementById('statsFilterBtn');
  const filterModal=document.getElementById('statsFilterModal');
  const filterList=document.getElementById('statsFilterList');
  const filterSave=document.getElementById('statsFilterSaveBtn');
  const filterCancel=document.getElementById('statsFilterCancelBtn');
  let current='driver', sortKey='name', sortDir=1;

  drvBtn?.addEventListener('click',()=>{setMode('driver');});
  carBtn?.addEventListener('click',()=>{setMode('car');});
  if(filterBtn) filterBtn.addEventListener('click',openFilter);
  filterCancel?.addEventListener('click',()=>filterModal.classList.add('hidden'));
  filterSave?.addEventListener('click',saveFilter);

  function setMode(m){current=m;drvBtn.classList.toggle('active',m==='driver');carBtn.classList.toggle('active',m==='car');render();}

  function calcStats(){
     const statsMap={driver:{},car:{}};
     appData.races.forEach(r=>{
        r.results.forEach(res=>{
           const dId=res.driverId,cId=res.carId;
           const dObj=statsMap.driver[dId]||(statsMap.driver[dId]={id:dId,races:0,wins:0,rounds:0,elo:0});
           const cObj=statsMap.car[cId]||(statsMap.car[cId]={id:cId,races:0,wins:0,rounds:0,elo:0});
           dObj.races++;cObj.races++;
           if(res.position===1){dObj.wins++;cObj.wins++;}
           dObj.rounds+=r.rounds;
           // Fahrzeug-Runden: nach Autotausch je Fahrzeug (carLaps), sonst die Renndistanz für das gewertete Auto
           if(Array.isArray(res.carLaps)&&res.carLaps.length){
             res.carLaps.forEach(sg=>{const o=statsMap.car[sg.carId]||(statsMap.car[sg.carId]={id:sg.carId,races:0,wins:0,rounds:0,elo:0});o.rounds+=sg.laps||0;});
           }else cObj.rounds+=r.rounds;
           // track dates
           const dt=r.date;
           if(dt){
             if(!dObj.firstDate||compareDate(dt,dObj.firstDate)<0) dObj.firstDate=dt;
             if(!dObj.lastDate ||compareDate(dt,dObj.lastDate)>0) dObj.lastDate =dt;
             if(!cObj.firstDate||compareDate(dt,cObj.firstDate)<0) cObj.firstDate=dt;
             if(!cObj.lastDate ||compareDate(dt,cObj.lastDate)>0) cObj.lastDate =dt;
           }
        });
     });
     // add names + elo
     appData.drivers.forEach(d=>{const o=statsMap.driver[d.id];if(o){o.name=d.name;o.elo=d.elo;}});
     appData.cars.forEach(c=>{const o=statsMap.car[c.id];if(o){o.name=c.name;o.elo=c.elo;}});
     // Bestzeiten
     if(appData.lapRecords){
       const bestDrv={};const bestCar={};
       window.recordsInView().forEach(r=>{
          if(!bestDrv[r.driverId]||r.time<bestDrv[r.driverId]) bestDrv[r.driverId]=r.time;
          if(!bestCar[r.carId]   ||r.time<bestCar[r.carId])    bestCar[r.carId] =r.time;
       });
       Object.entries(statsMap.driver).forEach(([id,o])=>{ if(bestDrv[id]) o.best=bestDrv[id]; });
       Object.entries(statsMap.car).forEach(([id,o])=>{ if(bestCar[id]) o.best=bestCar[id]; });
     }
     return statsMap;
  }

  function render(){
     if(!tblWrap) return;
     const stats=calcStats()[current];
     // Filter: standardmäßig nur aktive; inaktive lassen sich im Filter zuschalten
     for(const key in stats){ if(!isShown(current, key)) delete stats[key]; }
     updateFilterBtn();
     let rows=Object.values(stats).map(o=>{
        const winRate=o.races?(o.wins/o.races*100):0;
        return {...o,winRate};
     });
     rows.sort((a,b)=>{
        const av=a[sortKey], bv=b[sortKey];
        if(av==bv) return 0;
        let cmp;
        if(sortKey==='firstDate'||sortKey==='lastDate'){
           if(!av) cmp=1; else if(!bv) cmp=-1; else cmp=compareDate(av,bv);
        }else if(sortKey==='name'){
           cmp=av.localeCompare(bv);
        }else{
           cmp=(av>bv?1:-1);
        }
        return cmp*sortDir;
     });
     const headers=[
        {key:'name',label:'Name'},
        {key:'races',label:'Rennen'},
        {key:'wins',label:'Siege'},
        {key:'winRate',label:'Siegquote %'},
        {key:'rounds',label:'Runden'},
        {key:'firstDate',label:'Erstes Rennen'},
        {key:'lastDate',label:'Letztes Rennen'},
        {key:'best',label:'Bestzeit (s)'},
        {key:'elo',label:'G!RP'}
     ];
     let html=`<table class="record-table"><thead><tr>`;
     headers.forEach(h=>{
        const dir=(sortKey===h.key? (sortDir===1?'▲':'▼'):'');
        html+=`<th data-key="${h.key}">${h.label} ${dir}</th>`;
     });
     html+=`</tr></thead><tbody>`;
     rows.forEach(r=>{
        html+=`<tr><td>${r.name?window.Helpers.escapeHtml(r.name):'-'}</td><td>${r.races}</td><td>${r.wins}</td><td>${r.winRate.toFixed(1)}</td><td>${r.rounds}</td><td>${r.firstDate||'-'}</td><td>${r.lastDate||'-'}</td><td>${r.best? r.best.toFixed(3):'-'}</td><td>${r.elo}</td></tr>`;
     });
     html+=`</tbody></table>`;
     tblWrap.innerHTML=html;
     tblWrap.querySelectorAll('th').forEach(th=>{
        th.style.cursor='pointer';
        th.onclick=()=>{
           const k=th.dataset.key; if(k===sortKey){sortDir*=-1;}else{sortKey=k;sortDir=1;} render();
        };
     });
  }

  // ---------- Filter ----------
  // Vorauswahl: alle aktiven (Haken „aktiv“ bei Fahrer/Fahrzeug, nicht archiviert).
  // Abweichungen davon merkt sich jedes Gerät selbst (localStorage):
  //   show = inaktive, die trotzdem angezeigt werden; hide = aktive, die ausgeblendet werden.
  const STORE_KEY = 'statsFilter';
  function loadOverrides(){
    try{ const o=JSON.parse(localStorage.getItem(STORE_KEY)||'{}'); return { driver:o.driver||{show:[],hide:[]}, car:o.car||{show:[],hide:[]} }; }
    catch(e){ return { driver:{show:[],hide:[]}, car:{show:[],hide:[]} }; }
  }
  let overrides=loadOverrides();
  function saveOverrides(){ try{ localStorage.setItem(STORE_KEY, JSON.stringify(overrides)); }catch(e){} }
  function entity(kind,id){ return (kind==='driver'?appData.drivers:appData.cars).find(x=>x.id==id); }
  function isShown(kind,id){
    const o=overrides[kind]; const n=Number(id);
    return window.Elo.isActive(entity(kind,id)) ? !o.hide.includes(n) : o.show.includes(n);
  }
  function updateFilterBtn(){
    const o=overrides[current];
    filterBtn?.classList.toggle('filter-active', o.show.length>0 || o.hide.length>0);
  }

  function saveFilter(){
    const show=[], hide=[];
    filterList.querySelectorAll('input[type=checkbox]').forEach(cb=>{
      const id=Number(cb.dataset.id);
      const active=window.Elo.isActive(entity(current,id));
      if(active && !cb.checked) hide.push(id);
      if(!active && cb.checked) show.push(id);
    });
    overrides[current]={show,hide};
    saveOverrides();
    filterModal.classList.add('hidden');
    render();
  }

  function openFilter(){
    buildFilterList();
    filterModal.classList.remove('hidden');
  }
  function buildFilterList(){
    const ids=Object.keys(calcStats()[current]);   // nur wer in der Ansicht Rennen gefahren ist
    const items=ids.map(id=>entity(current,id)).filter(Boolean).sort((a,b)=>a.name.localeCompare(b.name,'de',{sensitivity:'base'}));
    const row=e=>`<label class="filter-row"><input type="checkbox" data-id="${e.id}" ${isShown(current,e.id)?'checked':''}>${window.Helpers.escapeHtml(e.name)}${e.archived?' <span class="status-inactive">archiviert</span>':''}</label>`;
    const active=items.filter(e=>window.Elo.isActive(e)), inactive=items.filter(e=>!window.Elo.isActive(e));
    filterList.innerHTML=
      `<div class="filter-quick"><button type="button" class="btn" data-pick="active">Nur aktive</button><button type="button" class="btn" data-pick="all">Alle</button></div>`+
      `<div class="filter-group">Aktiv</div>`+(active.map(row).join('')||'<p class="muted">–</p>')+
      `<div class="filter-group">Inaktiv</div>`+(inactive.map(row).join('')||'<p class="muted">–</p>');
    filterList.querySelectorAll('[data-pick]').forEach(btn=>btn.onclick=()=>{
      const all=btn.dataset.pick==='all';
      filterList.querySelectorAll('input[type=checkbox]').forEach(cb=>{ cb.checked = all || window.Elo.isActive(entity(current,cb.dataset.id)); });
    });
  }

  function compareDate(a,b){
     const [y1,m1,d1]=a.split(/[-.]/).reverse().map(Number);
     const [y2,m2,d2]=b.split(/[-.]/).reverse().map(Number);
     return (y1-y2)|| (m1-m2)|| (d1-d2);
  }

  window.StatsUI={reload:render};
})();
