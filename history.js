(function(){
  const { tsForRace, showToast, escapeHtml: esc } = window.Helpers;

  // Filterzustand (Fahrer-/Fahrzeug-IDs)
  window.historyFilter = window.historyFilter || [];
  window.carFilter     = window.carFilter || [];

  // Trifft ein Rennen den aktuellen Filter?
  // Genau 1 Fahrer + 1 Fahrzeug ⇒ diese Paarung; sonst müssen alle gewählten Fahrer/Fahrzeuge dabei sein.
  function matchesFilter(r){
    const drvF=window.historyFilter, carF=window.carFilter;
    if(!drvF.length&&!carF.length) return true;
    if(drvF.length===1&&carF.length===1){
      return r.results.some(res=>res.driverId===drvF[0]&&res.carId===carF[0]);
    }
    const drvIds=r.results.map(x=>x.driverId), carIds=r.results.map(x=>x.carId);
    return drvF.every(id=>drvIds.includes(id)) && carF.every(id=>carIds.includes(id));
  }

  // ▼ Öffentliche Funktion: Liste neu zeichnen
  function updateHistory(){
    const historyContainer = document.getElementById('raceHistory');
    if(!historyContainer) return;

    if(window.appData.races.length===0){
      historyContainer.innerHTML='<p style="text-align:center;color:var(--text-muted);">Noch keine Rennen gefahren.</p>';
      return;
    }

    // Renn-Nummern (#1 = ältestes Rennen)
    const asc=[...window.appData.races].sort((a,b)=>tsForRace(a)-tsForRace(b));
    const raceNumberMap=new Map();
    asc.forEach((r,idx)=>raceNumberMap.set(r.id,idx+1));

    historyContainer.innerHTML=[...window.appData.races]
      .sort((a,b)=>tsForRace(b)-tsForRace(a)) // neueste zuerst
      .filter(matchesFilter)
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
              // Fahrer + Fahrzeug bilden ein Paar (eigener tbody); Trennlinie nur zwischen den Paaren
              return `<tbody class="pair">
                      <tr class="pair-driver">
                        <td class="pos" rowspan="2">${res.position}.</td>
                        <td class="who"><span class="pair-icon" aria-hidden="true">😎</span><strong>${esc(res.driverName)}</strong></td>
                        <td class="pts"><span class="old">${res.oldDriverElo} → </span><span class="${drvColor}">${res.newDriverElo} (${drvChange>=0?'+':''}${drvChange})</span></td>
                      </tr>
                      <tr class="pair-car">
                        <td class="who"><span class="pair-icon" aria-hidden="true">🏎️</span>${esc(res.carName)}</td>
                        <td class="pts"><span class="old">${res.oldCarElo} → </span><span class="${carColor}">${res.newCarElo} (${carChange>=0?'+':''}${carChange})</span></td>
                      </tr>
                    </tbody>`;
          }).join('');
          return `<div class="race-history-item"><table class="race-table"><tbody>${header}</tbody></table><table class="race-table">${rows}</table></div>`;
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

          const matches=window.appData.races.filter(matchesFilter).length;
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