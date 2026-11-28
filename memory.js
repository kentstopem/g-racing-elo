// memory.js – Memorykarten: alle verfügbaren Fahrzeuge liegen verdeckt, es werden so viele
// Karten aufgedeckt, wie Fahrer mitfahren (window.Memory.open(ids, count, cb) wie Slot/Wheel)
(function(){
  const modal=document.getElementById('memoryModal');
  const grid=document.getElementById('memoryGrid');
  const status=document.getElementById('memoryStatus');
  const okBtn=document.getElementById('memoryConfirmBtn');
  const closeBtn=document.getElementById('memoryCloseBtn');
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let callback=null, need=0, picked=[];

  const imgSrc=car=>window.MasterData.carAssetSrc(car);

  function updateStatus(){
    const left=need-picked.length;
    status.textContent=left>0?`Noch ${left} ${left===1?'Karte':'Karten'} aufdecken`:'Alle Fahrzeuge gezogen';
    status.classList.toggle('ok',left<=0);
    okBtn.disabled=left>0;
  }

  function open(ids,count,cb){
    if(ids.length<count){window.Helpers.showToast(`Zu wenige Fahrzeuge: ${ids.length} verfügbar, ${count} benötigt`);return;}
    callback=cb; need=count; picked=[];
    const cars=ids.map(id=>window.appData.cars.find(c=>c.id===id)).filter(Boolean);
    for(let i=cars.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[cars[i],cars[j]]=[cars[j],cars[i]];}
    grid.innerHTML=cars.map((c,i)=>{
      const src=imgSrc(c);
      return `<button type="button" class="mem-card" data-id="${c.id}" aria-label="Karte ${i+1}">
        <span class="mem-inner">
          <span class="mem-face mem-back"><span class="mem-logo">G!RP</span></span>
          <span class="mem-face mem-front">${src?`<img src="${src}" alt="" onerror="this.remove()">`:''}<span class="mem-name">${esc(c.name)}</span></span>
        </span>
      </button>`;
    }).join('');
    // möglichst quadratisch (12 → 3 Reihen à 4); die letzte Reihe darf kürzer sein
    const cols=Math.min(6,Math.max(2,Math.ceil(Math.sqrt(cars.length))));
    grid.style.setProperty('--mem-cols',cols);
    modal.querySelector('.modal-content').style.maxWidth=(cols*118+80)+'px';
    updateStatus();
    modal.classList.remove('hidden');
  }

  grid.addEventListener('click',e=>{
    const card=e.target.closest('.mem-card');
    if(!card||card.classList.contains('flipped')||picked.length>=need) return;
    card.classList.add('flipped','picked');
    picked.push(Number(card.dataset.id));
    window.Voice?.sayCar?.(Number(card.dataset.id));   // aufgedecktes Auto ansagen
    updateStatus();
    // Fertig: die restlichen Karten zeigen, was es noch gegeben hätte
    if(picked.length>=need) setTimeout(()=>grid.querySelectorAll('.mem-card:not(.flipped)').forEach(c=>c.classList.add('flipped','rest')),700);
  });

  function close(){modal.classList.add('hidden');grid.innerHTML='';}
  closeBtn.addEventListener('click',close);
  modal.addEventListener('click',e=>{if(e.target===modal) close();});
  okBtn.addEventListener('click',()=>{const list=[...picked];close();callback?.(list);});

  window.Memory={open};
})();
