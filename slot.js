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
      // bounded duplication (max 3 extra copies)
      const viewH=360;
      for(let r=0;r<5 && this.track.scrollHeight<viewH*4;r++){
        const clones=[...this.track.children].map(n=>n.cloneNode(true));
        clones.forEach(cl=>this.track.appendChild(cl));
      }
      this.reel.appendChild(this.track);

      // now that track is in DOM, measure height
      this.totalHeight=this.track.scrollHeight;
      this.offset=Math.random()*this.totalHeight;

      this.wrap.appendChild(this.startBtn);
      this.wrap.appendChild(this.reel);
      this.wrap.appendChild(this.stopBtn);
      reelsDiv.appendChild(this.wrap);
      this.startBtn.addEventListener('click',()=>this.start());
      this.stopBtn.addEventListener('click',()=>this.stop());
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
         this.totalHeight=this.track.scrollHeight;
         if(this.totalHeight===0) this.totalHeight=[...this.track.children].reduce((s,e)=>s+e.offsetHeight,0);
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
      const viewCenter=180; // px
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
      window.Helpers.showToast(`Walze ${this.idx+1}: ${chosen.name}`);
      runningReels.forEach(r=>{ if(r!==this) r.removeCar(carId);});
      // enable confirm if all stopped
      checkAllStopped();
      return;
    }
    removeCar(id){
      if(this.frozen) return;
      const items=[...this.track.querySelectorAll(`.reel-item[data-car-id="${id}"]`)];
      if(items.length===0) return;
      items.forEach(el=>el.remove());
      this.totalHeight=this.track.scrollHeight;
      this.offset=this.offset%this.totalHeight;
      // refill to maintain seamless scroll
      const viewH=360;
      let attempts=0;
      while(this.track.scrollHeight<viewH*2 && attempts<3){
        const clones=[...this.track.children].map(n=>n.cloneNode(true));
        clones.forEach(cl=>this.track.appendChild(cl));
        attempts++;
      }
      this.totalHeight=this.track.scrollHeight;
    }
  }

  function checkAllStopped(){
    if(runningReels.length && runningReels.every(r=>r.stopped)){
      document.getElementById('slotConfirmBtn').disabled=false;
    }
  }

  function open(ids,count,cb){
    reelsDiv.innerHTML='';
    // recreate selection line
    const sel=document.createElement('div'); sel.id='slotSelectLine'; reelsDiv.appendChild(sel);
    callback=cb; selectedIds=new Array(count); runningReels=[];
    const cars=ids.map(id=>window.appData.cars.find(c=>c.id===id));
    loadImages(ids).then(map=>{
       imgMap=map;
       for(let i=0;i<count;i++) runningReels.push(new Reel(cars,i));
       const modalContent=modal.querySelector('.modal-content');
       modalContent.style.maxWidth=(count*132+80)+'px';
       modal.classList.remove('hidden');
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

  function debug(){
     const r=runningReels[0];
     if(!r){console.log('no reels');return;}
     console.table({speed:r.speed,offset:r.offset,totalHeight:r.totalHeight,children:r.track.children.length});
  }

  window.Slot={open,_debug:debug};

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