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
           dObj.rounds+=r.rounds;cObj.rounds+=r.rounds;
        });
     });
     // add names + elo
     appData.drivers.forEach(d=>{const o=statsMap.driver[d.id];if(o){o.name=d.name;o.elo=d.elo;}});
     appData.cars.forEach(c=>{const o=statsMap.car[c.id];if(o){o.name=c.name;o.elo=c.elo;}});
     return statsMap;
  }

  function render(){
     if(!tblWrap) return;
     const stats=calcStats()[current];
     // remove hidden
     for(const key in stats){
        const master=(current==='driver'?appData.drivers.find(d=>d.id==key):appData.cars.find(c=>c.id==key));
        if(master?.hideInStats) delete stats[key];
     }
     let rows=Object.values(stats).map(o=>{
        const winRate=o.races?(o.wins/o.races*100):0;
        return {...o,winRate};
     });
     rows.sort((a,b)=>{
        const av=a[sortKey], bv=b[sortKey];
        if(av==bv) return 0;
        return (av>bv?1:-1)*sortDir;
     });
     const headers=[
        {key:'name',label:'Name'},
        {key:'races',label:'Rennen'},
        {key:'wins',label:'Siege'},
        {key:'winRate',label:'Siegquote %'},
        {key:'rounds',label:'Runden'},
        {key:'elo',label:'G!RP'}
     ];
     let html=`<table class="record-table"><thead><tr>`;
     headers.forEach(h=>{
        const dir=(sortKey===h.key? (sortDir===1?'▲':'▼'):'');
        html+=`<th data-key="${h.key}">${h.label} ${dir}</th>`;
     });
     html+=`</tr></thead><tbody>`;
     rows.forEach(r=>{
        html+=`<tr><td>${r.name||'-'}</td><td>${r.races}</td><td>${r.wins}</td><td>${r.winRate.toFixed(1)}</td><td>${r.rounds}</td><td>${r.elo}</td></tr>`;
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

  async function saveFilter(){
   const checks=[...filterList.querySelectorAll('input')];
   const batch=window.db.batch();
   for(const cb of checks){
       const id=cb.dataset.id;
       const hide=!cb.checked;
       if(current==='driver'){
           const ref=window.db.collection('drivers').doc(String(id));
           batch.update(ref,{hideInStats:hide});
       }else{
           const ref=window.db.collection('cars').doc(String(id));
           batch.update(ref,{hideInStats:hide});
       }
   }
   try{await batch.commit();}
   catch(e){console.error(e);window.Helpers.showToast('Speichern fehlgeschlagen');return;}
   filterModal.classList.add('hidden');
   await window.loadData?.();
   render();
 }

 function openFilter(){
   buildFilterList();
   filterModal.classList.remove('hidden');
 }
 function buildFilterList(){
   filterList.innerHTML='';
   const arr=current==='driver'?appData.drivers:appData.cars;
   arr.forEach(e=>{
      const row=document.createElement('div'); row.style.display='flex'; row.style.alignItems='center'; row.style.gap='8px'; row.style.margin='4px 0';
      const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=!e.hideInStats;
      cb.dataset.id=e.id;
      const label=document.createElement('span'); label.textContent=e.name;
      row.appendChild(cb); row.appendChild(label);
      filterList.appendChild(row);
   });
 }

  window.StatsUI={reload:render};
})();
