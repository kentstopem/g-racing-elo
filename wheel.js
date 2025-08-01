(function(){
  const modal=document.getElementById('wheelModal');
  const canvas=document.getElementById('wheelCanvas');
  const ctx=canvas.getContext('2d');
  const spinBtn=document.getElementById('spinBtn');
  const closeBtn=document.getElementById('wheelCloseBtn');
  let segments=[],totalWeight=0,targetCount=0,callback=null,angle=0,animId=null,spinning=false;
  let imgMap={};
  // Ton deaktiviert

  /* playTick entfernt */

  function drawWheel(){
    const n=segments.length;
    const radius=canvas.width/2;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if(n===0) return;
    let start=angle;
    segments.forEach((seg,idx)=>{
       const slice=2*Math.PI*seg.weight/totalWeight;
       const end=start+slice;
      ctx.beginPath();
      ctx.moveTo(radius,radius);
      ctx.arc(radius,radius,radius,start,end);
      ctx.fillStyle='#fff';
      ctx.fill();
      // farbiger Ring
      const hue=Math.round(360*idx/n);
      ctx.lineWidth=radius*0.12; // ca. 12 % Breite
      ctx.strokeStyle=`hsl(${hue}, 60%, 80%)`;
      ctx.stroke();
      ctx.lineWidth=1; // reset
      ctx.strokeStyle='#666';
      ctx.stroke();
      const img=imgMap[seg.id];
      if(img){
         const imgMax=radius*0.75; // desired max side
         const scale=imgMax/Math.max(img.width,img.height);
         const w=img.width*scale;
         const h=img.height*scale;
         const midAngle=start+(end-start)/2;
         const dist     = radius*0.75;
         const x = radius + dist * Math.cos(midAngle);
         const y = radius + dist * Math.sin(midAngle);
         ctx.drawImage(img, x - w/2, y - h/2, w, h);
      }else{
         ctx.save();
         ctx.translate(radius,radius);
         ctx.rotate(start+(end-start)/2);
         ctx.textAlign='right';
         ctx.fillStyle='#000';
         ctx.font='12px sans-serif';
         const car=window.appData.cars.find(c=>c.id===seg.id);
         ctx.fillText(car?car.name:'' , radius-10,4);
         ctx.restore();
      }
      start=end;
    });
  }

  function spin(){
    if(spinning||segments.length===0) return;

    spinning=true;
    spinBtn.disabled=true;
    let lastTick=-1;
    const duration=3000; // 3s
    const rotations=4+Math.random()*2; // 4-6 Umdrehungen
    const start=performance.now();
    const startAngle=angle;
    const targetAngle=startAngle+rotations*2*Math.PI;
    function frame(t){
      const p=Math.min(1,(t-start)/duration);
      const ease=1-Math.pow(1-p,3); // cubic ease-out
      angle=startAngle+ease*(targetAngle-startAngle);
      drawWheel();
      // kein Sound mehr
      if(p<1){animId=requestAnimationFrame(frame);}else{
        spinning=false;
        spinBtn.disabled=false;
        angle%=2*Math.PI;
        pickResult();
      }
    }
    animId=requestAnimationFrame(frame);
  }

  function pickResult(){
    // 0 ° soll jetzt exakt unter dem Zeiger (oben) liegen
    const pointer = ((-angle + Math.PI/2 + Math.PI + 2*Math.PI) % (2*Math.PI));
    let acc=0;let pickedId=null;let pickedIdx=-1;
    for(let i=0;i<segments.length;i++){
       const slice=2*Math.PI*segments[i].weight/totalWeight;
       if(pointer>=acc && pointer<acc+slice){pickedId=segments[i].id;pickedIdx=i;break;}
       acc+=slice;
    }
    if(pickedId==null) return;
    const pickedName=window.appData.cars.find(c=>c.id===pickedId)?.name;
    window.Helpers.showToast(`Gewählt: ${pickedName}`);
    // 1s Verzögerung, damit Segment sichtbar bleibt
    setTimeout(()=>{
       totalWeight-=segments[pickedIdx].weight;
       segments.splice(pickedIdx,1);
       drawWheel();
       if(segments.length===0){
         close();
         if(callback) callback(selectedIds);
         return;
       }
       selectedIds.push(pickedId);
       if(selectedIds.length===targetCount){
         close();
         if(callback) callback(selectedIds);
       }
    },1500);
  }

  function buildSegments(ids){
      const cars=ids.map(id=>window.appData.cars.find(c=>c.id===id));
      const maxR=Math.max(...cars.map(c=>c.races));
      return cars.map(c=>({id:c.id, weight:(maxR - c.races)+1}));
  }

  function loadImages(segs){
    const promises=segs.map(s=>{
      const car=window.appData.cars.find(c=>c.id===s.id);
      const num=/^\((\d+)\)/.exec(car?.name||'')?.[1];
      return new Promise(res=>{
        if(!num){res([s.id,null]);return;}
        const img=new Image();
        const file=`assets/cars/${String(num).padStart(2,'0')}.png`;
        img.src=file;
        img.onload=()=>res([s.id,img]);
        img.onerror=()=>res([s.id,null]);
      });
    });
    return Promise.all(promises).then(arr=>Object.fromEntries(arr));
  }

  let selectedIds=[];
  function open(ids,count,cb){
    segments=buildSegments(ids);
    totalWeight=segments.reduce((s,x)=>s+x.weight,0);
    targetCount=count;callback=cb;selectedIds=[];angle=0;
    loadImages(segments).then(map=>{
       imgMap=map;drawWheel();
    });
    modal.classList.remove('hidden');
  }
  function close(){
    cancelAnimationFrame(animId);
    modal.classList.add('hidden');
  }
  spinBtn.addEventListener('click',spin);
  closeBtn.addEventListener('click',close);
  modal.addEventListener('click',e=>{if(e.target===modal) close();});

  window.Wheel={open};
})(); 