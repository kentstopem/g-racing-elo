(function(){
  const db=firebase.firestore();
  const DRIVER_COLL='driverRecords';
  const CAR_COLL='carRecords';
  let currentMode='drivers'; // 'drivers' | 'cars'

  const headRow=document.getElementById('recordsHead');
  const tbody=document.getElementById('recordsBody');
  const podiumDiv=document.getElementById('recordPodium');
  const formDiv=document.getElementById('recordForm');
  const subNav=document.getElementById('recordSubNav');

  async function loadRecords(){
    const col=db.collection(currentMode==='drivers'?DRIVER_COLL:CAR_COLL);
    const snap=await col.get();
    window.appData.recordData= snap.docs.map(d=>({id:d.id,...d.data()}));
  }

  function renderHeader(){
    if(!headRow) return;
    headRow.innerHTML= currentMode==='drivers'
      ?'<th>#</th><th>Fahrer</th><th>Bestzeit</th><th>Datum</th><th>Fahrzeug</th>'
      :'<th>#</th><th>Fahrzeug</th><th>Bestzeit</th><th>Datum</th><th>Fahrer</th>';

    const hdr=document.getElementById('recordsHeader');
    if(hdr){hdr.textContent=currentMode==='drivers'?'🏅 Fahrer-Rekorde':'🏅 Fahrzeug-Rekorde';}
  }

  function renderForm(){
    if(!formDiv) return;
    if(currentMode==='drivers'){
      formDiv.innerHTML=`
        <div class="form-group"><label>Fahrer:</label><select id="recDriverSel"></select></div>
        <div class="form-group"><label>Fahrzeug:</label><select id="recCarSel"></select></div>
        <div class="form-group"><label>Bestzeit (Sekunden):</label><input type="number" id="recTime" step="0.001" min="0"></div>
        <div class="form-group"><label>Datum:</label><input type="date" id="recDate"></div>
        <button class="btn" id="saveRecordBtn">Speichern</button>`;
    }else{
      formDiv.innerHTML=`
        <div class="form-group"><label>Fahrzeug:</label><select id="recCarSel"></select></div>
        <div class="form-group"><label>Fahrer:</label><select id="recDriverSel"></select></div>
        <div class="form-group"><label>Bestzeit (Sekunden):</label><input type="number" id="recTime" step="0.001" min="0"></div>
        <div class="form-group"><label>Datum:</label><input type="date" id="recDate"></div>
        <button class="btn" id="saveRecordBtn">Speichern</button>`;
    }
    fillDropdowns();
    document.getElementById('saveRecordBtn')?.addEventListener('click',saveRecord);
  }

  function fillDropdowns(){
    const carSel=document.getElementById('recCarSel');
    const drvSel=document.getElementById('recDriverSel');
    if(carSel) carSel.innerHTML='<option value="">— wählen —</option>'+[...window.appData.cars].sort((a,b)=>a.name.localeCompare(b.name)).map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
    if(drvSel) drvSel.innerHTML='<option value="">— wählen —</option>'+[...window.appData.drivers].sort((a,b)=>a.name.localeCompare(b.name)).map(d=>`<option value="${d.id}">${d.name}</option>`).join('');
  }

  function renderPodium(sorted){
    if(!podiumDiv) return;
    const show=sorted.length>=3;
    if(show){
      const classes=['first','second','third'];
      const medals=['🥇','🥈','🥉'];
      podiumDiv.innerHTML=sorted.slice(0,3).map((rec,idx)=>{
        const mainName=currentMode==='drivers'
          ? window.appData.drivers.find(d=>d.id===rec.driverId)?.name||'?'
          : window.appData.cars.find(c=>c.id===rec.carId)?.name||'?';
        return `<div class="podium-item ${classes[idx]}"><div class="podium-position">${medals[idx]}</div><div class="podium-name">${mainName}</div><div class="podium-elo">${rec.time.toFixed(3)} s</div></div>`;
      }).join('');
    }
    podiumDiv.classList.toggle('hidden',!show);
  }

  function renderTable(){
    if(!tbody||!window.appData.recordData) return;
    const sorted=[...window.appData.recordData].sort((a,b)=>a.time-b.time);
    renderPodium(sorted);
    const rows=sorted.map((rec,idx)=>{
      const car = window.appData.cars.find(c=>c.id===rec.carId)?.name||'?';
      const drv = window.appData.drivers.find(d=>d.id===rec.driverId)?.name||'?';
      return currentMode==='drivers'
        ?`<tr><td>${idx+1}</td><td>${drv}</td><td>${rec.time.toFixed(3)} s</td><td>${rec.date}</td><td>${car}</td></tr>`
        :`<tr><td>${idx+1}</td><td>${car}</td><td>${rec.time.toFixed(3)} s</td><td>${rec.date}</td><td>${drv}</td></tr>`;
    });
    tbody.innerHTML=rows.join('');
  }

  async function saveRecord(){
    if(!window.isAdmin){window.Helpers.showToast('Nur Admin');return;}
    const carId=+document.getElementById('recCarSel')?.value;
    const driverId=+document.getElementById('recDriverSel')?.value;
    const time=parseFloat(document.getElementById('recTime').value);
    const date=document.getElementById('recDate').value;
    if(!(carId&&driverId&&time>0&&date)){window.Helpers.showToast('Alle Felder ausfüllen');return;}

    const col=db.collection(currentMode==='drivers'?DRIVER_COLL:CAR_COLL);
    const uniqueField=currentMode==='drivers'? 'driverId':'carId';
    const uniqueVal=currentMode==='drivers'? driverId:carId;
    const q=col.where(uniqueField,'==',uniqueVal);
    const snap=await q.get();
    if(!snap.empty){
       const doc=snap.docs[0];
       if(time<doc.data().time){
         await doc.ref.set({carId,driverId,time,date,createdAt:firebase.firestore.FieldValue.serverTimestamp()});
         window.Helpers.showToast('Rekord verbessert!');
       }else{window.Helpers.showToast('Langsamer als aktueller Rekord');return;}
    }else{
       await col.add({carId,driverId,time,date,createdAt:firebase.firestore.FieldValue.serverTimestamp()});
       window.Helpers.showToast('Rekord gespeichert');
    }
    await loadRecords();
    renderHeader();
    renderTable();
  }

  function switchMode(mode){
    if(currentMode===mode) return;
    currentMode=mode;
    subNav.querySelectorAll('.sub-tab').forEach(btn=>btn.classList.toggle('active',btn.getAttribute('data-record')===mode));
    initWorkflow();
  }

  async function initWorkflow(){
    renderHeader();
    renderForm();
    await loadRecords();
    renderTable();
  }

  function init(){
    if(subNav){
      subNav.addEventListener('click',e=>{
        if(e.target.matches('.sub-tab')) switchMode(e.target.getAttribute('data-record'));
      });
    }
    initWorkflow();
  }

  document.addEventListener('DOMContentLoaded',init);

  window.RecordsUI={ reload:initWorkflow };
})(); 