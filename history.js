(function(){
  const { tsForRace, showToast } = window.Helpers;

  // ▼ Öffentliche Funktion: Liste neu zeichnen
  function updateHistory(){
    const historyContainer = document.getElementById('raceHistory');
    if(!historyContainer) return;

    if(window.appData.races.length===0){
      historyContainer.innerHTML='<p style="text-align:center;color:#666;">Noch keine Rennen gefahren.</p>';
      return;
    }

    // Renn-Nummern (#1 = ältestes Rennen)
    const asc=[...window.appData.races].sort((a,b)=>tsForRace(a)-tsForRace(b));
    const raceNumberMap=new Map();
    asc.forEach((r,idx)=>raceNumberMap.set(r.id,idx+1));

    const driverFilterActive=Array.isArray(window.historyFilter)&&window.historyFilter.length>0;
    const carFilterActive=Array.isArray(window.carFilter)&&window.carFilter.length>0;

    historyContainer.innerHTML=[...window.appData.races]
      .sort((a,b)=>tsForRace(b)-tsForRace(a)) // neueste zuerst
      .filter(r=>{
          if(!driverFilterActive&&!carFilterActive) return true;
          const drvIds=r.results.map(x=>x.driverId);
          const carIds=r.results.map(x=>x.carId);
          if(driverFilterActive&&carFilterActive&&window.historyFilter.length===1&&window.carFilter.length===1){
             return r.results.some(res=>res.driverId===window.historyFilter[0]&&res.carId===window.carFilter[0]);
          }
          if(driverFilterActive&&!window.historyFilter.every(id=>drvIds.includes(id))) return false;
          if(carFilterActive   &&!window.carFilter.every(id=>carIds.includes(id)))   return false;
          return true;
      })
      .map(race=>{
          const header=`<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
              <div class="race-date">#${raceNumberMap.get(race.id)} · 📅 ${race.date} – ${race.time||''} – ${race.rounds} Rd.</div>
              ${window.isAdmin?`<button class="btn btn-danger btn-small" onclick="deleteRace(${race.id})">Löschen</button>`:''}
          </div>`;

          const sortedRes=[...race.results].sort((a,b)=>a.position-b.position);
          const rows=sortedRes.map(res=>{
              const drvChange=(res.driverEloChange!==undefined)?res.driverEloChange:res.eloChange;
              const carChange=(res.carEloChange!==undefined)?res.carEloChange:drvChange;
              const drvColor=drvChange>=0?'elo-up':'elo-down';
              const carColor=carChange>=0?'elo-up':'elo-down';
              return `<tr>
                        <td class="pos">${res.position}.</td>
                        <td><strong>${res.driverName}</strong></td>
                        <td>${res.oldDriverElo} → <span class="${drvColor}">${res.newDriverElo} (${drvChange>=0?'+':''}${drvChange})</span></td>
                      </tr>
                      <tr class="sub">
                        <td></td><td>${res.carName}</td>
                        <td>${res.oldCarElo} → <span class="${carColor}">${res.newCarElo} (${carChange>=0?'+':''}${carChange})</span></td>
                      </tr>`;
          }).join('');
          return `<div class="race-history-item"><table class="race-table"><tbody>${header}</tbody></table><table class="race-table"><tbody>${rows}</tbody></table></div>`;
      }).join('');
  }

  // ▼ Filter-Modal
  function initFilter(){
      const filterBtn=document.getElementById('historyFilterBtn');
      const filterModal=document.getElementById('filterModal');
      const filterList=document.getElementById('filterDriverList');
      const filterCarList=document.getElementById('filterCarList');
      const filterApply=document.getElementById('filterApplyBtn');
      const filterCancel=document.getElementById('filterCancelBtn');
      if(!filterBtn||!filterModal) return; // falscher Screen

      function openFilter(){
          // Fahrer
          filterList.innerHTML=[...window.appData.drivers]
              .sort((a,b)=>a.name.localeCompare(b.name))
              .map(d=>`<label style='display:flex;align-items:center;gap:6px;margin:4px 0;'><input type='checkbox' value='${d.id}' ${window.historyFilter.includes(d.id)?'checked':''}>${d.name}</label>`)
              .join('');
          // Fahrzeuge
          if(filterCarList){
              filterCarList.innerHTML=[...window.appData.cars]
                  .sort((a,b)=>a.name.localeCompare(b.name))
                  .map(c=>`<label style='display:flex;align-items:center;gap:6px;margin:4px 0;'><input type='checkbox' value='${c.id}' ${window.carFilter.includes(c.id)?'checked':''}>${c.name}</label>`)
                  .join('');
          }
          filterModal.classList.remove('hidden');
      }

      function closeFilter(){ filterModal.classList.add('hidden'); }

      filterBtn.addEventListener('click',openFilter);
      filterCancel?.addEventListener('click',closeFilter);
      filterApply?.addEventListener('click',()=>{
          window.historyFilter=[...filterList.querySelectorAll('input:checked')].map(i=>parseInt(i.value));
          if(filterCarList){window.carFilter=[...filterCarList.querySelectorAll('input:checked')].map(i=>parseInt(i.value));}
          closeFilter();

          // Anzahl Treffer ermitteln
          const driverActive=window.historyFilter.length>0;
          const carActive=window.carFilter.length>0;
          const matches=window.appData.races.filter(r=>{
              if(!driverActive&&!carActive) return true;
              const drv=r.results.map(x=>x.driverId);
              const car=r.results.map(x=>x.carId);
              if(driverActive&&carActive&&window.historyFilter.length===1&&window.carFilter.length===1){
                   return r.results.some(res=>res.driverId===window.historyFilter[0]&&res.carId===window.carFilter[0]);
              }
              if(driverActive&&!window.historyFilter.every(id=>drv.includes(id))) return false;
              if(carActive   &&!window.carFilter.every(id=>car.includes(id)))   return false;
              return true;
          }).length;

          updateHistory();
          showToast(`${matches} Rennen gefunden`);
      });
  }

  function init(){
     initFilter();
     // Erstmaliges Rendering, falls History-Tab Default ist
     if(document.getElementById('history').classList.contains('active')){
        updateHistory();
     }
  }

  window.HistoryUI={ init, update:updateHistory };
  // automatisch initialisieren, wenn DOM fertig
  document.addEventListener('DOMContentLoaded', init);
})(); 