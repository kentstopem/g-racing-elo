(function(){
  const db=firebase.firestore();
  const recCol=db.collection('carRecords');

  async function loadRecords(){
    const snap=await recCol.get();
    window.appData.carRecords=snap.docs.map(d=>({id:d.id,...d.data()}));
  }

  async function saveRecord(){
    if(!window.isAdmin){window.Helpers.showToast('Nur Admin');return;}
    const carId=+document.getElementById('recCarSel').value;
    const driverId=+document.getElementById('recDriverSel').value;
    const time=parseFloat(document.getElementById('recTime').value);
    const date=document.getElementById('recDate').value;
    if(!(carId&&driverId&&time>0&&date)){
      window.Helpers.showToast('Alle Felder ausfüllen');return;
    }
    const q=recCol.where('carId','==',carId);
    const snap=await q.get();
    if(!snap.empty){
      const doc=snap.docs[0];
      if(time<doc.data().time){
        await doc.ref.set({carId,driverId,time,date,createdAt:firebase.firestore.FieldValue.serverTimestamp()});
        window.Helpers.showToast('Rekord verbessert!');
      }else{
        window.Helpers.showToast('Langsamer als aktueller Rekord');
        return;
      }
    }else{
      await recCol.add({carId,driverId,time,date,createdAt:firebase.firestore.FieldValue.serverTimestamp()});
      window.Helpers.showToast('Rekord gespeichert');
    }
    await loadRecords();
    renderTable();
  }

  function renderTable(){
    const tbody=document.getElementById('recordsBody');
    if(!tbody||!window.appData.carRecords) return;
    const rows=[...window.appData.carRecords]
      .sort((a,b)=>a.time-b.time)
      .map(rec=>{
        const car=window.appData.cars.find(c=>c.id===rec.carId)?.name||'?';
        const drv=window.appData.drivers.find(d=>d.id===rec.driverId)?.name||'?';
        return `<tr><td>${car}</td><td>${rec.time.toFixed(3)} s</td><td>${rec.date}</td><td>${drv}</td></tr>`;
      });
    tbody.innerHTML=rows.join('');
  }

  function fillDropdowns(){
    const carSel=document.getElementById('recCarSel');
    const drvSel=document.getElementById('recDriverSel');
    if(!(carSel&&drvSel)) return;
    carSel.innerHTML='<option value="">— wählen —</option>'+[...window.appData.cars].sort((a,b)=>a.name.localeCompare(b.name)).map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
    drvSel.innerHTML='<option value="">— wählen —</option>'+[...window.appData.drivers].sort((a,b)=>a.name.localeCompare(b.name)).map(d=>`<option value="${d.id}">${d.name}</option>`).join('');
  }

  async function init(){
    fillDropdowns();
    await loadRecords();
    renderTable();
    document.getElementById('saveRecordBtn')?.addEventListener('click',saveRecord);
  }

  document.addEventListener('DOMContentLoaded',init);

  window.RecordsUI={ reload:async()=>{await loadRecords();renderTable();fillDropdowns();} };
})(); 