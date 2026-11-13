// Carrera GRP Racing Web-App
// Hinweis: Datenspeicherung durch Firebase-Integration.

// Globale Variablen
let appData = {
    drivers: [],
    cars: [],
    races: [],
    raceCounter: 0
};

let currentSection = 'rankings';
let historyFilter=[]; // Fahrer-IDs
let carFilter=[];     // Fahrzeug-IDs

// → global verfügbar für andere Module
window.appData = appData;
window.historyFilter = historyFilter;
window.carFilter = carFilter;

// Neue Modul-Imports
const { showToast, tsForRace, escapeHtml } = window.Helpers;

// Chart handling
let eloChartInstance=null;
let currentChartType='pos';let currentEntityType=null;let currentEntityId=null;

// Aktuelle Rangliste (wie in elo.js storeOverallPositions): aktive, nicht archivierte, nach G!RP sortiert
function activeRanking(type){
  const min=window.Elo.MIN_RACES_FOR_RANK;
  const list = type==='driver'
      ? appData.drivers.filter(d=>d.races>=min && !d.archived)
      : appData.cars.filter(c=>c.races>=min && !c.hideFromRanking && !c.archived);
  return [...list].sort((a,b)=>b.elo-a.elo);
}

function renderChart(mode){
  const canvas=document.getElementById('eloChart');
  if(!canvas||!currentEntityType) return;
  const ordered=[...appData.races].sort((a,b)=>tsForRace(a)-tsForRace(b));
  const numMap=new Map();ordered.forEach((r,i)=>numMap.set(r.id,i+1));
  const labels=[];const data=[];const dateArr=[];const posArr=[];const totalArr=[];const raceNrArr=[];const partnerArr=[];
  if(currentEntityType==='driver'){
    const driver=appData.drivers.find(d=>d.id==currentEntityId);
    if(!driver) return;
    let cnt=0;
    ordered.forEach(r=>{
      const res=r.results.find(x=>x.driverId==currentEntityId);
      if(res){
        cnt++;
        const rankVal=res.positionOverallDriver;
        const shouldInclude = mode==='elo' || rankVal!=null;
        if(!shouldInclude) return;
        labels.push(cnt.toString());
        if(mode==='elo') data.push(res.newDriverElo); else data.push(rankVal);
        dateArr.push(r.date);
        posArr.push(res.position);
        totalArr.push(r.results.length);
        raceNrArr.push(numMap.get(r.id));
        partnerArr.push(res.carName);
      }
    });
  }else{
    const car=appData.cars.find(c=>c.id==currentEntityId);
    if(!car) return;
    let cnt=0;
    ordered.forEach(r=>{
      const res=r.results.find(x=>x.carId==currentEntityId);
      if(res){
        cnt++;
        const rankVal=res.positionOverallCar;
        const shouldInclude = mode==='elo' || rankVal!=null;
        if(!shouldInclude) return;
        labels.push(cnt.toString());
        if(mode==='elo') data.push(res.newCarElo); else data.push(rankVal);
        dateArr.push(r.date);
        posArr.push(res.position);
        totalArr.push(r.results.length);
        raceNrArr.push(numMap.get(r.id));
        partnerArr.push(res.driverName);
      }
    });
  }
  // ▼ Synthetischer Schluss-Punkt (heutiger Rang)
  if(mode==='pos'){
    const active=activeRanking(currentEntityType);
    const idx=active.findIndex(x=>x.id==currentEntityId);
    if(idx!==-1){
      labels.push('heute');
      data.push(idx+1);
      dateArr.push(new Date().toLocaleDateString('de-DE'));
      posArr.push(idx+1);
      totalArr.push(active.length);
      raceNrArr.push('-');
      partnerArr.push(null);
    }
  }
  if(!labels.length){
    if(eloChartInstance){eloChartInstance.destroy(); eloChartInstance=null;}
    const ctx=canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle='#666';ctx.textAlign='center';ctx.font='16px sans-serif';
    const msg=mode==='pos'?`Rang erst nach dem ${window.Elo.MIN_RACES_FOR_RANK}. Rennen`:'Noch keine G!RP-Daten';
    ctx.fillText(msg, canvas.width/2, canvas.height/2);
    return;
  }

  if(eloChartInstance) eloChartInstance.destroy();
  const yOpts = mode==='elo'
      ? {title:{display:true,text:'G!RP'},beginAtZero:false}
      : (()=>{
          const activeCount = activeRanking(currentEntityType).length;
          const maxRank=Math.max(activeCount, ...data,1);
          return {title:{display:true,text:'Rang'},reverse:true,min:1,max:maxRank,ticks:{stepSize:1,callback:v=>Number.isInteger(v)?v:''}};
        })();
  eloChartInstance=new Chart(canvas.getContext('2d'),{
    type:'line',
    data:{labels,datasets:[{label:mode==='elo'?'G!RP':'Rang',data,borderColor:'#007bff',backgroundColor:'rgba(0,123,255,0.1)',tension:0.2,pointRadius:10,pointHoverRadius:12}]},
    options:{
      scales:{y:yOpts},
      interaction:{mode:'index',intersect:false},
      responsive:true,
      plugins:{
        legend:{display:false},
        tooltip:{
          displayColors:false,
          callbacks:{
            title:(ctx)=>`${mode==='elo'?'GRP':'Rang'}: ${data[ctx[0].dataIndex]}`,
            label:(ctx)=>{
              const idx=ctx.dataIndex;
              return raceNrArr[idx]==='-' ? `${dateArr[idx]}` : `#${raceNrArr[idx]} – ${dateArr[idx]}`;
            },
            afterLabel:(ctx)=>{
                const part = partnerArr[ctx.dataIndex];
                const line1 = `${posArr[ctx.dataIndex]}. von ${totalArr[ctx.dataIndex]} ${currentEntityType==='driver'?'Fahrern':'Fahrzeugen'}`;
                return part? [line1, part] : [line1];
            }
          }
        }
      }
    }
  });
}

function openEloModal(type,id){
    currentEntityType=type;currentEntityId=id;currentChartType='elo';
    const modal=document.getElementById('eloModal');
    const titleEl=document.getElementById('eloModalTitle');
    if(!modal||!titleEl) return;
    if(type==='driver'){
      const d=appData.drivers.find(x=>x.id==id);if(!d){showToast('Fahrer nicht gefunden');return;}
      titleEl.textContent=`${d.name}`;
    }else{
      const c=appData.cars.find(x=>x.id==id);if(!c){showToast('Fahrzeug nicht gefunden');return;}
      titleEl.textContent=`${c.name}`;
    }
    renderChart('elo');
    const eloBtn=document.getElementById('modeEloBtn');
    const posBtn=document.getElementById('modePosBtn');
    const detBtn=document.getElementById('modeDetailsBtn');
    eloBtn?.classList.add('active');
    posBtn?.classList.remove('active');
    detBtn?.classList.remove('active');
    renderView();
    modal.classList.remove('hidden');
}
window.openEloModal=openEloModal;

const eloBtn=document.getElementById('modeEloBtn');
const posBtn=document.getElementById('modePosBtn');
const detBtn=document.getElementById('modeDetailsBtn');
eloBtn?.addEventListener('click',()=>{currentChartType='elo';eloBtn.classList.add('active');posBtn.classList.remove('active');detBtn?.classList.remove('active');renderView();});
posBtn?.addEventListener('click',()=>{currentChartType='pos';posBtn.classList.add('active');eloBtn.classList.remove('active');detBtn?.classList.remove('active');renderView();});
detBtn?.addEventListener('click',()=>{currentChartType='details';detBtn.classList.add('active');eloBtn.classList.remove('active');posBtn.classList.remove('active');renderView();});

function renderView(){
  const canvas=document.getElementById('eloChart');
  const detailsDiv=document.getElementById('detailsContent');
  if(currentChartType==='details'){
     canvas.classList.add('hidden');
     detailsDiv.classList.remove('hidden');
     renderDetails();
  }else{
     detailsDiv.classList.add('hidden');
     canvas.classList.remove('hidden');
     renderChart(currentChartType);
  }
}

function renderDetails(){
    const div=document.getElementById('detailsContent'); if(!div) return;
    let stats={races:0,wins:0,rounds:0,dates:[]};
    const races=appData.races||[];
    races.forEach(r=>{
        const res=r.results||[];
        res.forEach(entry=>{
            if((currentEntityType==='driver'&&entry.driverId==currentEntityId)||
               (currentEntityType==='car'&&entry.carId==currentEntityId)){
                 stats.races++;
                 if(entry.position===1) stats.wins++;
                 stats.rounds+=r.rounds||0;
                 if(r.date) stats.dates.push(r.date);
            }
        });
    });
    stats.dates.sort((a,b)=>{
        const partsA=a.split(/[.\-]/);
        const partsB=b.split(/[.\-]/);
        if(partsA.length===3&&partsB.length===3){
            const [d1,m1,y1]=partsA.map(Number);
            const [d2,m2,y2]=partsB.map(Number);
            return y1-y2 || m1-m2 || d1-d2;
        }
        return a.localeCompare(b);
    });
    const firstDate=stats.dates[0]||'-';
    const lastDate=stats.dates[stats.dates.length-1]||'-';
    let imgHTML='';
    if(currentEntityType==='car'){
        const car=appData.cars.find(c=>c.id==currentEntityId);
        if(car){
           const num=/^\((\d+)\)/.exec(car.name||'')?.[1];
           if(num){
               const src=`assets/cars/${String(num).padStart(2,'0')}.png`;
               imgHTML=`<div style="flex:0 0 200px;text-align:center;"><img src="${src}" alt="${car.name}" class="stats-img"></div>`;
           }
        }
    }
    // Bestzeit ermitteln – Daten kommen jetzt aus lapRecords
    let bestLine = 'Bestzeit: <strong>-</strong>';
    const recs = window.appData.lapRecords || [];
    if (recs.length) {
        if (currentEntityType === 'driver') {
            const rec = recs.filter(r => r.driverId == currentEntityId)
                            .sort((a, b) => a.time - b.time)[0];
            if (rec) {
                const car = appData.cars.find(c => c.id === rec.carId)?.name || '?';
                bestLine = `Bestzeit: <strong>${Number(rec.time).toFixed(3)} Sek.</strong> – ${car}`;
            }
        } else { // car
            const rec = recs.filter(r => r.carId == currentEntityId)
                            .sort((a, b) => a.time - b.time)[0];
            if (rec) {
                const drv = appData.drivers.find(d => d.id === rec.driverId)?.name || '?';
                bestLine = `Bestzeit: <strong>${Number(rec.time).toFixed(3)} Sek.</strong> – ${drv}`;
            }
        }
    }
    const listHTML=`<ul style="list-style:none;padding-left:0;font-size:14px;line-height:1.6;">
        <li>Rennen: <strong>${stats.races}</strong></li>
        <li>Siege: <strong>${stats.wins}</strong></li>
        <li>Siegquote: <strong>${stats.races?((stats.wins/stats.races*100).toFixed(1)):0}%</strong></li>
        <li>Runden: <strong>${stats.rounds}</strong></li>
        <li>${bestLine}</li>
        <li>Erstes Rennen: <strong>${firstDate}</strong></li>
        <li>Letztes Rennen: <strong>${lastDate}</strong></li>
    </ul>`;
    div.innerHTML=`<div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap;">${listHTML}${imgHTML}</div>`;
}

// Daten laden (Firestore)
async function loadData() {
    try {
        const data = await window.Storage.fetchAll();
        appData.drivers = data.drivers || [];
        appData.cars    = data.cars    || [];
        appData.races   = data.races   || [];

        // Rekorde gleichzeitig laden
        try{
          const db=firebase.firestore();
          const snap=await db.collection('lapRecords').get();
          appData.lapRecords = snap.docs.map(d=>({id:d.id,...d.data()}));
        }catch(e){console.error('lapRecords konnten nicht geladen werden',e);}
    } catch (e) {
        console.error('Fehler beim Laden der Daten aus Firestore:', e);
    }
}

// Schreibvorgang absichern: Fehler werden sichtbar gemeldet statt nur in der Konsole
function persist(promise) {
    return promise.catch(err => {
        console.error('Speicherfehler:', err);
        showToast('⚠️ Speichern fehlgeschlagen – Verbindung prüfen!');
    });
}

// --- Kopfzeile Spitzenreiter-Tagline ---
function updateTagline() {
    const taglineEl = document.getElementById('tagline');
    if (!taglineEl) return;

    let topName = 'Christian L.';
    if (appData.drivers && appData.drivers.length) {
        const topDriver = activeRanking('driver')[0];
        if (topDriver && topDriver.name) topName = topDriver.name;
    }
    taglineEl.textContent = `Kannst Du mit ${topName} mithalten?`;
}

// Navigation
function initNavigation() {
    const navButtons = document.querySelectorAll('.nav-btn');
    navButtons.forEach(button => {
        button.addEventListener('click', function () {
            const sectionName = this.getAttribute('data-section');
            showSection(sectionName);
        });
    });
}

function showSection(sectionName) {
    // Alle Sections verstecken
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    // Default: beide Sub-Navigations ausblenden
    document.getElementById('rankSubNav')?.classList.add('hidden');
    document.getElementById('recordSubNav')?.classList.add('hidden');

    const section = document.getElementById(sectionName);
    if (section) section.classList.add('active');

    const button = document.querySelector(`[data-section="${sectionName}"]`);
    if (button) button.classList.add('active');

    currentSection = sectionName;

    if (sectionName === 'rankings') {
        RankingUI.update();
        document.getElementById('rankSubNav').classList.remove('hidden');
    } else if (sectionName === 'history') {
        HistoryUI.update();
        // rankSubNav bleibt versteckt
    } else if (sectionName === 'race') {
        RaceUI.updateForm(
            appData.raceCounter,
            appData.drivers,
            appData.cars,
            appData.races,
            historyFilter,
            carFilter
        );
        // rankSubNav bleibt versteckt
    } else if (sectionName==='records'){
        if(window.RecordsUI?.reload) window.RecordsUI.reload();
        document.getElementById('recordSubNav').classList.remove('hidden');
    } else {
        document.getElementById('rankSubNav').classList.add('hidden');
        document.getElementById('recordSubNav').classList.add('hidden');
    }
}

// Fahrer Management
function initDriverManagement() {
    const addBtn = document.getElementById('addDriverBtn');
    const input = document.getElementById('newDriverName');

    addBtn.addEventListener('click', addDriver);
    input.addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            addDriver();
        }
    });
}

function addDriver() {
    const input = document.getElementById('newDriverName');
    const name = input.value.trim();

    if (!name) {
        showToast('Bitte einen Namen eingeben!');
        return;
    }

    if (appData.drivers.some(d => d.name.toLowerCase() === name.toLowerCase())) {
        showToast('Fahrer existiert bereits!');
        return;
    }

    const driver = { id: Date.now(), name, elo: 1000, races: 0, wins: 0, totalRounds: 0 };
    appData.drivers.push(driver);

    input.value = '';
    persist(window.Storage.addDriver(driver));
    updateDriversList();
    RaceUI.updateForm();
}

// Fahrer/Fahrzeuge mit Rennen werden archiviert statt gelöscht, damit die Historie vollständig bleibt.
// Archivierte erscheinen nicht mehr in Rangliste, Rennformular und Auto-Setup.
function hasRaces(field, id) {
    return appData.races.some(r => (r.results || []).some(res => res[field] === id));
}

function deleteDriver(id) {
    if (hasRaces('driverId', id)) {
        showToast('Fahrer hat bereits Rennen – bitte archivieren statt löschen');
        return;
    }
    if (!confirm('Fahrer wirklich löschen?')) return;
    appData.drivers = appData.drivers.filter(d => d.id !== id);
    persist(window.Storage.deleteDriver(id));
    updateDriversList();
    RaceUI.updateForm();
}

function toggleArchiveDriver(id) {
    const d = appData.drivers.find(x => x.id === id);
    if (!d) return;
    d.archived = !d.archived;
    persist(window.Storage.updateDriver(d));
    updateDriversList();
    RankingUI.update();
    RaceUI.updateForm();
}

function updateDriversList() {
    const list = document.getElementById('driversList');
    if (!list) return;

    if (appData.drivers.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: #666;">Noch keine Fahrer hinzugefügt.</p>';
        return;
    }

    const sortedDrivers=[...appData.drivers].sort((a,b)=>(!!a.archived-!!b.archived)||a.name.localeCompare(b.name,'de',{sensitivity:'base'}));
    list.innerHTML = sortedDrivers.map(driver => `
        <div class="list-item${driver.archived?' archived':''}" data-id="${driver.id}">
            <div>
                <strong>${escapeHtml(driver.name)}</strong>${driver.archived?' <span class="status-inactive">archiviert</span>':''}
                <div style="font-size: 0.9em; color: #666;">
                    ${driver.races||0} Rennen · ${driver.wins||0} Siege · ${driver.totalRounds||0} Rd.
                </div>
            </div>
            <div style="display: flex; align-items: center; gap:8px;">
                <span class="elo-score">${driver.elo}</span>
                ${driver.races>0
                  ? `<button class="btn archive-driver" data-id="${driver.id}">${driver.archived?'Reaktivieren':'Archivieren'}</button>`
                  : `<button class="btn btn-danger delete-driver" data-id="${driver.id}">Löschen</button>`}
            </div>
        </div>
    `).join('');

    // Event-Delegation nur einmal binden
    if (!list._delegationBound) {
        list.addEventListener('click', (e) => {
            const id = parseInt(e.target.dataset.id, 10);
            if (e.target.classList.contains('delete-driver')) deleteDriver(id);
            if (e.target.classList.contains('archive-driver')) toggleArchiveDriver(id);
        });
        list._delegationBound = true;
    }
}

// Fahrzeug Management
function initCarManagement() {
    const addBtn = document.getElementById('addCarBtn');
    const input = document.getElementById('newCarName');

    addBtn.addEventListener('click', addCar);
    input.addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            addCar();
        }
    });
}

function addCar() {
    const input = document.getElementById('newCarName');
    const name = input.value.trim();

    if (!name) {
        showToast('Bitte einen Namen eingeben!');
        return;
    }

    if (appData.cars.some(c => c.name.toLowerCase() === name.toLowerCase())) {
        showToast('Fahrzeug existiert bereits!');
        return;
    }

    const car = { id: Date.now(), name, elo: 1000, races: 0, wins: 0, totalRounds: 0, hideFromRanking: false };
    appData.cars.push(car);

    input.value = '';
    persist(window.Storage.addCar(car));
    updateCarsList();
    RaceUI.updateForm();
}

function deleteCar(id) {
    if (hasRaces('carId', id)) {
        showToast('Fahrzeug hat bereits Rennen – bitte archivieren statt löschen');
        return;
    }
    if (!confirm('Fahrzeug wirklich löschen?')) return;
    appData.cars = appData.cars.filter(c => c.id !== id);
    persist(window.Storage.deleteCar(id));
    updateCarsList();
    RaceUI.updateForm();
}

function toggleArchiveCar(id) {
    const c = appData.cars.find(x => x.id === id);
    if (!c) return;
    c.archived = !c.archived;
    persist(window.Storage.updateCar(c));
    updateCarsList();
    RankingUI.update();
    RaceUI.updateForm();
}

function updateCarsList() {
    const list = document.getElementById('carsList');
    if (!list) return;

    if (appData.cars.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: #666;">Noch keine Fahrzeuge hinzugefügt.</p>';
        return;
    }

    const sortedCars=[...appData.cars].sort((a,b)=>(!!a.archived-!!b.archived)||a.name.localeCompare(b.name,'de',{sensitivity:'base'}));
    list.innerHTML = sortedCars.map(car => `
        <div class="list-item${car.archived?' archived':''}" data-id="${car.id}">
            <div>
                <strong>${escapeHtml(car.name)}</strong>${car.archived?' <span class="status-inactive">archiviert</span>':''}
                <div style="font-size: 0.9em; color: #666;">
                    ${car.races||0} Rennen · ${car.wins||0} Siege · ${car.totalRounds||0} Rd.
                </div>
            </div>
            <div style="display: flex; align-items: center; gap:8px;">
                ${window.isAdmin && !car.archived?`<label style="display:flex;align-items:center;gap:4px;font-size:12px;">
                    <input type="checkbox" class="toggle-hide" data-id="${car.id}" ${car.hideFromRanking?'' :'checked'}>
                    im Ranking
                </label>`:''}
                <span class="elo-score">${car.elo}</span>
                ${car.races>0
                  ? `<button class="btn archive-car" data-id="${car.id}">${car.archived?'Reaktivieren':'Archivieren'}</button>`
                  : `<button class="btn btn-danger delete-car" data-id="${car.id}">Löschen</button>`}
            </div>
        </div>
    `).join('');

    if (!list._delegationBound) {
        list.addEventListener('click', (e) => {
            const id = parseInt(e.target.dataset.id, 10);
            if (e.target.classList.contains('delete-car')) deleteCar(id);
            if (e.target.classList.contains('archive-car')) toggleArchiveCar(id);
        });
        list.addEventListener('change',(e)=>{
            if(e.target.classList.contains('toggle-hide')){
               const id=parseInt(e.target.dataset.id,10);
               const car=appData.cars.find(c=>c.id===id);
               if(car){car.hideFromRanking=!e.target.checked;persist(window.Storage.updateCar(car));RankingUI.update();}
            }
        });
        list._delegationBound = true;
    }
}

// Auth UI Handling
function updateAuthUI() {
    const admin = window.isAdmin;
    // Nav-Buttons
    document.querySelectorAll('.admin-only').forEach(btn => {
        btn.style.display = admin ? '' : 'none';
    });

    const authBtn = document.getElementById('authBtn');
    if (authBtn) authBtn.textContent = admin ? 'Logout' : 'Admin';

    // Wenn aktueller Tab admin-only und kein Admin → Rankings zeigen
    const activeBtn = document.querySelector('.nav-btn.active');
    if (!admin && activeBtn && activeBtn.classList.contains('admin-only')) {
        showSection('rankings');
    }
}

// Auth-Event Listener
document.addEventListener('auth-changed', updateAuthUI);

// Auth-Button Click
document.addEventListener('DOMContentLoaded', () => {
    const authBtn = document.getElementById('authBtn');
    if (authBtn) {
        const modal = document.getElementById('loginModal');
        const emailInput = document.getElementById('loginEmail');
        const pwInput    = document.getElementById('loginPassword');
        const submitBtn  = document.getElementById('loginSubmitBtn');
        const cancelBtn  = document.getElementById('loginCancelBtn');

        function openModal() {
            emailInput.value = '';
            pwInput.value = '';
            modal.classList.remove('hidden');
            emailInput.focus();
        }
        function closeModal() { modal.classList.add('hidden'); }

        authBtn.addEventListener('click', () => {
            if (window.isAdmin) {
                window.logout();
            } else {
                openModal();
            }
        });

        cancelBtn.addEventListener('click', closeModal);
        submitBtn.addEventListener('click', () => {
            const mail = emailInput.value.trim();
            const pw   = pwInput.value;
            if (!mail || !pw) { showToast('Bitte E-Mail und Passwort eingeben'); return; }
            window.login(mail, pw)
                .then(closeModal)
                .catch(err => showToast('Login fehlgeschlagen: '+err.message));
        });
    }

    // sub navigation logic for rankings
    // Close GRP modal
    document.getElementById('eloModalClose')?.addEventListener('click',()=>{
        document.getElementById('eloModal')?.classList.add('hidden');
    });
  
    // Neuberechnung: siehe race.js / elo.js
});

// App Initialisierung
async function init() {
    try {
        await loadData();
        updateAuthUI();
        updateTagline();
        showSection('rankings');
        initNavigation();
        initDriverManagement();
        initCarManagement();
        /* initRaceManagement(); */
        updateDriversList();
        updateCarsList();
        RaceUI.updateForm();
        console.log('App erfolgreich initialisiert');
    } catch (error) {
        console.error('Fehler bei der Initialisierung:', error);
        showToast('Fehler beim Starten der App. Bitte Seite neu laden.');
    }
}

// App starten, wenn DOM geladen
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
} else {
    init();
}

// ————————————————————————————————————
// Funktionen global verfügbar machen (wegen Inline-HTML-Handlers)
// ————————————————————————————————————
window.deleteDriver = deleteDriver;
window.deleteCar = deleteCar;
window.updateTagline = updateTagline; 