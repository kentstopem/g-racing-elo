(function(){
  const modal=document.getElementById('slotModal');
  const reelsDiv=document.getElementById('slotReels');
  const closeBtn=document.getElementById('slotCloseBtn');

  let callback=null, selectedIds=[], runningReels=[], imgMap={};

  // ------- Reel class ---------
  class Reel{
    constructor(cars, idx){
      this.cars=[...cars];
      this.idx=idx;
      this.frozen=false;
      this.heightMap=this.cars.map(c=>this.itemHeight(c));
      this.totalHeight=0; // will be set after DOM ready
      this.offset=0;
      this.speed=0;
      this.animId=null;
      this.stopped=false;
      this.buildDom();
    }
    itemHeight(car){
      const maxR=Math.max(...this.cars.map(c=>c.races));
      const minR=Math.min(...this.cars.map(c=>c.races));
      const w=(maxR - car.races)+1; // höheres w = weniger Rennen
      const minW=1;
      const maxW=(maxR - minR)+1;
      const minH=50, maxH=100;
      if(maxW===minW) return (minH+maxH)/2;
      return minH + (w - minW)/(maxW - minW)*(maxH - minH);
    }
    buildDom(){
      this.wrap=document.createElement('div');
      this.wrap.className='reel-wrap';
      this.startBtn=document.createElement('button');
      this.startBtn.className='btn btn-small reel-start-btn';
      this.startBtn.textContent='Start';
      this.stopBtn=document.createElement('button');
      this.stopBtn.className='btn btn-small reel-stop-btn';
      this.stopBtn.textContent='Stopp';
      this.stopBtn.disabled=true;
      // Ergebnis-Feld: ersetzt nach dem Stoppen den Stopp-Knopf und bleibt stehen
      this.result=document.createElement('div');
      this.result.className='reel-result hidden';
      this.reel=document.createElement('div');
      this.reel.className='reel'; // viewport
      this.track=document.createElement('div');
      this.track.className='reel-track';

      // create items once
      this.cars.forEach((car,i)=>{
        const item=document.createElement('div');
        item.className='reel-item';
        item.dataset.carId=car.id;
        item.style.height=this.heightMap[i]+'px';
        const img=imgMap[car.id];
        if(img){
          const el=document.createElement('img');
          el.src=img.src;
          el.alt=car.name;
          el.className='reel-img';
          item.appendChild(el);
        }else{
          item.textContent=car.name;
        }
        this.track.appendChild(item);
      });
      // erst ins DOM hängen, damit Höhen messbar sind
      this.reel.appendChild(this.track);
      this.wrap.appendChild(this.startBtn);
      this.wrap.appendChild(this.reel);
      this.wrap.appendChild(this.stopBtn);
      this.wrap.appendChild(this.result);
      reelsDiv.appendChild(this.wrap);

      this.fill();
      this.offset=Math.random()*this.totalHeight;
      this.startBtn.addEventListener('click',()=>this.start());
      this.stopBtn.addEventListener('click',()=>this.stop());
    }
    /**
     * Walze nahtlos füllen: Grundsatz der Autos so oft wiederholen, dass nach einer vollen Periode noch
     * mindestens eine Fensterhöhe Autos folgt. totalHeight = Höhe einer Periode (danach wiederholt sich das Bild
     * exakt, auch die Schwarz/Weiß-Abfolge). Vorher lief offset bis zur Gesamthöhe der Spur, unter deren Ende
     * kam bis zu einer Fensterhöhe lang nur schwarzer Hintergrund (Tristan 24.11.).
     */
    fill(){
      const seen=new Set(), base=[];
      for(const el of [...this.track.children]){ if(seen.has(el.dataset.carId)) break; seen.add(el.dataset.carId); base.push(el); }
      this.track.replaceChildren(...base);
      if(!base.length){ this.totalHeight=0; return; }
      const period=base.length%2 ? base.length*2 : base.length; // gerade Anzahl, damit die Farbfolge passt
      const add=()=>base.forEach(n=>this.track.appendChild(n.cloneNode(true)));
      while(this.track.children.length<period) add();
      const kids=[...this.track.children];
      const cycle=kids.slice(0,period).reduce((h,el)=>h+el.offsetHeight,0);
      const viewH=this.reel.clientHeight||360;
      for(let r=0;cycle>0 && r<50 && this.track.scrollHeight<cycle+viewH;r++){ for(let i=0;i<period;i++) this.track.appendChild(kids[i].cloneNode(true)); }
      this.totalHeight=cycle;
      if(this.totalHeight>0) this.offset=((this.offset%this.totalHeight)+this.totalHeight)%this.totalHeight;
    }
    loopFrame(){
      if(this.stopped){cancelAnimationFrame(this.animId);return;}
      this.offset=(this.offset+this.speed)%this.totalHeight;
      this.track.style.transform=`translateY(${-this.offset}px)`;
      this.animId=requestAnimationFrame(()=>this.loopFrame());
    }
    start(){
      if(this.speed>0) return;
      if(this.totalHeight===0){
         this.fill();
         this.offset=Math.random()*this.totalHeight;
      }
      this.speed=8+Math.random()*8; // px per frame
      this.startBtn.disabled=true;
      this.stopBtn.disabled=false;
      this.stopped=false;
      this.loopFrame();
    }
    stop(){
      if(this.stopped||this.speed<=0) return;
      this.stopBtn.disabled=true;
      const startSpeed=this.speed;
      const randomFactor=0.5+Math.random()*1.5
      const duration=1000*randomFactor; // ms
      const startTime=performance.now();
      const decelFrame=(t)=>{
        const p=Math.min(1,(t-startTime)/duration);
        this.speed=startSpeed*(1-p);
        if(this.speed<=0.1){
          this.speed=0;this.snap();return;}
        requestAnimationFrame(decelFrame);
      };
      requestAnimationFrame(decelFrame);
    }
    snap(){
      // find item at center
      const lineEl=document.getElementById('slotSelectLine');
      const viewCenter=lineEl.getBoundingClientRect().top - this.reel.getBoundingClientRect().top;
      const relative=(this.offset+viewCenter)%this.totalHeight;
      let acc=0;let chosenEl=null;
      for(const el of this.track.children){
         const h=el.offsetHeight;
         if(relative>=acc && relative<acc+h){chosenEl=el;break;}
         acc+=h;
      }
      if(!chosenEl){console.error('No chosen');return;}
      const carId=parseInt(chosenEl.dataset.carId);
      const chosen=window.appData.cars.find(c=>c.id===carId);
      if(!chosen){console.error('car not found');return;}
      // compute precise offset of chosen center
      const segTop=acc; const segH=chosenEl.offsetHeight;
      const current=this.offset%this.totalHeight;
      const segTopViewport=segTop-current; // position of segment top in viewport
      const center=segTopViewport+segH/2;
      const delta=center-viewCenter; // positive → segment below line, need move up (increase offset)
      const startOffset=this.offset;
      const targetOffset=this.offset+delta;
      const startTime=performance.now();
      // immediate align (no animation)
      this.offset=((targetOffset%this.totalHeight)+this.totalHeight)%this.totalHeight;
      this.track.style.transform=`translateY(${-this.offset}px)`;
      // finalize selection
      selectedIds[this.idx]=chosen.id;
      this.stopped=true;this.frozen=true;
      this.stopBtn.classList.add('hidden');
      this.result.textContent=chosen.name;
      this.result.title=chosen.name;
      this.result.classList.remove('hidden');
      chosenEl.classList.add('reel-item-chosen');
      runningReels.forEach(r=>{ if(r!==this) r.removeCar(carId);});
      // enable confirm if all stopped
      checkAllStopped();
      return;
    }
    removeCar(id){
      if(this.frozen) return;
      const items=[...this.track.querySelectorAll(`.reel-item[data-car-id="${id}"]`)];
      if(items.length===0) return;
      // mindestens ein Fahrzeug muss auf der Walze bleiben
      if(items.length>=this.track.children.length) return;
      items.forEach(el=>el.remove());
      this.fill(); // nahtlos neu füllen
    }
  }

  function checkAllStopped(){
    if(runningReels.length && runningReels.every(r=>r.stopped)){
      document.getElementById('slotConfirmBtn').disabled=false;
    }
  }

  function open(ids,count,cb){
    if(ids.length<count){window.Helpers.showToast(`Zu wenige Fahrzeuge: ${ids.length} verfügbar, ${count} benötigt`);return;}
    reelsDiv.innerHTML='';
    // recreate selection line
    const sel=document.createElement('div'); sel.id='slotSelectLine'; reelsDiv.appendChild(sel);
    callback=cb; selectedIds=new Array(count); runningReels=[];
    const cars=ids.map(id=>window.appData.cars.find(c=>c.id===id));
    loadImages(ids).then(map=>{
       imgMap=map;
       // erst sichtbar machen, dann Walzen bauen – sonst sind alle Höhen 0
       const modalContent=modal.querySelector('.modal-content');
       modalContent.style.maxWidth=(count*132+80)+'px';
       modal.classList.remove('hidden');
       for(let i=0;i<count;i++) runningReels.push(new Reel(cars,i));
       document.getElementById('slotConfirmBtn').disabled=true;
    });
  }
  function close(){
     modal.classList.add('hidden');
     reelsDiv.innerHTML='';
     runningReels.forEach(r=>cancelAnimationFrame(r.animId));
     runningReels=[];
  }
  closeBtn.addEventListener('click',close);
  modal.addEventListener('click',e=>{if(e.target===modal) close();});
  document.getElementById('slotConfirmBtn').addEventListener('click',()=>{
     close(); if(callback) callback(selectedIds);
  });

  window.Slot={open};

  function loadImages(ids){
     const promises=ids.map(id=>{
        const car=window.appData.cars.find(c=>c.id===id);
        const num=/^\((\d+)\)/.exec(car?.name||'')?.[1];
        return new Promise(res=>{
           if(!num){res([id,null]);return;}
           const img=new Image();
           img.src=`assets/cars/${String(num).padStart(2,'0')}.png`;
           img.onload=()=>res([id,img]);
           img.onerror=()=>res([id,null]);
        });
     });
     return Promise.all(promises).then(arr=>Object.fromEntries(arr));
  }
})();