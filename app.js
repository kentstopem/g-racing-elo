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
const { showToast, tsForRace } = window.Helpers;
const { calculateExpectedScore, calculateActualScore, calculateKFactor } = window.Elo;

// Chart handling
let eloChartInstance=null;
let currentChartType='pos';let currentEntityType=null;let currentEntityId=null;

function renderChart(mode){
  const canvas=document.getElementById('eloChart');
  if(!canvas||!currentEntityType) return;
  const ordered=[...appData.races].sort((a,b)=>tsForRace(a)-tsForRace(b));
  const numMap=new Map();ordered.forEach((r,i)=>numMap.set(r.id,i+1));
  const labels=[];const data=[];const dateArr=[];const posArr=[];const totalArr=[];const raceNrArr=[];
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
      }
    });
  }
  if(!labels.length){showToast('Keine Daten');return;}

  // ▼ Synthetischer Schluss-Punkt (heutiger Rang)
  if(mode==='pos'){
    const MIN_RACES_FOR_RANK=5;
    if(currentEntityType==='driver'){
      const active=[...appData.drivers].filter(d=>d.races>=MIN_RACES_FOR_RANK).sort((a,b)=>b.elo-a.elo);
      const idx=active.findIndex(d=>d.id===currentEntityId);
      if(idx!==-1){
        labels.push('heute');
        data.push(idx+1);
        dateArr.push(new Date().toLocaleDateString('de-DE'));
        posArr.push(idx+1);
        totalArr.push(active.length);
        raceNrArr.push('-');
      }
    }else{
      const active=[...appData.cars].filter(c=>c.races>=MIN_RACES_FOR_RANK && !c.hideFromRanking).sort((a,b)=>b.elo-a.elo);
      const idx=active.findIndex(c=>c.id===currentEntityId);
      if(idx!==-1){
        labels.push('heute');
        data.push(idx+1);
        dateArr.push(new Date().toLocaleDateString('de-DE'));
        posArr.push(idx+1);
        totalArr.push(active.length);
        raceNrArr.push('-');
      }
    }
  }
  if(eloChartInstance) eloChartInstance.destroy();
  const yOpts = mode==='elo'
      ? {title:{display:true,text:'G!RP'},beginAtZero:false}
      : (()=>{
          const activeCount = currentEntityType==='driver'
              ? appData.drivers.filter(d=>d.races>=5).length
              : appData.cars   .filter(c=>c.races>=5 && !c.hideFromRanking).length;
          const maxRank=Math.max(activeCount, ...data,1);
          return {title:{display:true,text:'Rang'},reverse:true,min:1,max:maxRank,ticks:{stepSize:1,callback:v=>Number.isInteger(v)?v:''}};
        })();
  eloChartInstance=new Chart(canvas.getContext('2d'),{
    type:'line',
    data:{labels,datasets:[{label:mode==='elo'?'G!RP':'Rang',data,borderColor:'#007bff',backgroundColor:'rgba(0,123,255,0.1)',tension:0.2,pointRadius:3}]},
    options:{
      scales:{y:yOpts},
      responsive:true,
      plugins:{
        legend:{display:false},
        tooltip:{
          displayColors:false,
          callbacks:{
            title:(ctx)=>`Rang: ${data[ctx[0].dataIndex]}`,
            label:(ctx)=>`#${raceNrArr[ctx.dataIndex]} – ${dateArr[ctx.dataIndex]}`,
            afterLabel:(ctx)=>`${posArr[ctx.dataIndex]}. von ${totalArr[ctx.dataIndex]} ${currentEntityType==='driver'?'Fahrern':'Fahrzeugen'}`
          }
        }
      }
    }
  });
}

function openEloModal(type,id){
    currentEntityType=type;currentEntityId=id;currentChartType='pos';
    const modal=document.getElementById('eloModal');
    const titleEl=document.getElementById('eloModalTitle');
    if(!modal||!titleEl) return;
    if(type==='driver'){
      const d=appData.drivers.find(x=>x.id==id);if(!d){showToast('Fahrer nicht gefunden');return;}
      titleEl.textContent=`Verlauf: ${d.name}`;
    }else{
      const c=appData.cars.find(x=>x.id==id);if(!c){showToast('Fahrzeug nicht gefunden');return;}
      titleEl.textContent=`Verlauf: ${c.name}`;
    }
    renderChart('pos');
    const eloBtn=document.getElementById('modeEloBtn');
    const posBtn=document.getElementById('modePosBtn');
    eloBtn?.classList.remove('active');
    posBtn?.classList.add('active');
    modal.classList.remove('hidden');
}

const eloBtn=document.getElementById('modeEloBtn');
const posBtn=document.getElementById('modePosBtn');
eloBtn?.addEventListener('click',()=>{currentChartType='elo';eloBtn.classList.add('active');posBtn.classList.remove('active');renderChart('elo');});
posBtn?.addEventListener('click',()=>{currentChartType='pos';posBtn.classList.add('active');eloBtn.classList.remove('active');renderChart('pos');});

// Daten laden (Firestore)
async function loadData() {
    try {
        const data = await window.Storage.fetchAll();
        appData.drivers = data.drivers || [];
        appData.cars    = data.cars    || [];
        appData.races   = data.races   || [];
    } catch (e) {
        console.error('Fehler beim Laden der Daten aus Firestore:', e);
    }
}

// Daten synchronisieren (Batch)
function saveData() {
    // Fire-and-forget; wir warten nicht zwingend auf das Promise
    window.Storage.syncAll(appData).catch(err => console.error('Sync-Fehler:', err));
}

// --- Kopfzeile Spitzenreiter-Tagline ---
function updateTagline() {
    const taglineEl = document.getElementById('tagline');
    if (!taglineEl) return;

    let topName = 'Christian L.';
    if (appData.drivers && appData.drivers.length) {
        const topDriver = [...appData.drivers].sort((a,b)=>b.elo - a.elo)[0];
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

    appData.drivers.push({
        id: Date.now(),
        name,
        elo: 1000,
        races: 0
    });

    input.value = '';
    saveData();
    updateDriversList();
    RaceUI.updateForm();
}

function deleteDriver(id) {
    if (!confirm('Fahrer wirklich löschen? Alle Renndaten gehen verloren!')) return;

    appData.drivers = appData.drivers.filter(d => d.id !== id);
    appData.races   = appData.races.filter(race => !race.results.some(r => r.driverId === id));

    // Firestore-Dokument direkt löschen
    window.Storage.deleteDriver(id).catch(err => console.error('deleteDriver Firestore:', err));

    saveData();
    updateDriversList();
    RaceUI.updateForm();
}

function updateDriversList() {
    const list = document.getElementById('driversList');
    if (!list) return;

    if (appData.drivers.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: #666;">Noch keine Fahrer hinzugefügt.</p>';
        return;
    }

    list.innerHTML = appData.drivers.map(driver => `
        <div class="list-item" data-id="${driver.id}">
            <div>
                <strong>${driver.name}</strong>
                <div style="font-size: 0.9em; color: #666;">
                    ${driver.races} Rennen · ${driver.wins||0} Siege · ${driver.totalRounds||0} Rd.
                </div>
            </div>
            <div style="display: flex; align-items: center;">
                <span class="elo-score">${driver.elo}</span>
                <button class="btn btn-danger delete-driver" data-id="${driver.id}">Löschen</button>
            </div>
        </div>
    `).join('');

    // Event-Delegation nur einmal binden
    if (!list._delegationBound) {
        list.addEventListener('click', (e) => {
            if (e.target.classList.contains('delete-driver')) {
                const id = parseInt(e.target.dataset.id, 10);
                deleteDriver(id);
            }
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

    appData.cars.push({
        id: Date.now(),
        name,
        elo: 1000,
        races: 0,
        wins: 0,
        totalRounds: 0,
        hideFromRanking: false
    });

    input.value = '';
    saveData();
    updateCarsList();
    RaceUI.updateForm();
}

function deleteCar(id) {
    if (!confirm('Fahrzeug wirklich löschen? Alle Renndaten gehen verloren!')) return;

    appData.cars  = appData.cars.filter(c => c.id !== id);
    appData.races = appData.races.filter(race => !race.results.some(r => r.carId === id));

    window.Storage.deleteCar(id).catch(err => console.error('deleteCar Firestore:', err));

    saveData();
    updateCarsList();
    RaceUI.updateForm();
}

function updateCarsList() {
    const list = document.getElementById('carsList');
    if (!list) return;

    if (appData.cars.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: #666;">Noch keine Fahrzeuge hinzugefügt.</p>';
        return;
    }

    list.innerHTML = appData.cars.map(car => `
        <div class="list-item" data-id="${car.id}">
            <div>
                <strong>${car.name}</strong>
                <div style="font-size: 0.9em; color: #666;">
                    ${car.races} Rennen · ${car.wins||0} Siege · ${car.totalRounds||0} Rd.
                </div>
            </div>
            <div style="display: flex; align-items: center; gap:8px;">
                ${window.isAdmin?`<label style="display:flex;align-items:center;gap:4px;font-size:12px;">
                    <input type="checkbox" class="toggle-hide" data-id="${car.id}" ${car.hideFromRanking?'' :'checked'}>
                    im Ranking
                </label>`:''}
                <span class="elo-score">${car.elo}</span>
                <button class="btn btn-danger delete-car" data-id="${car.id}">Löschen</button>
            </div>
        </div>
    `).join('');

    if (!list._delegationBound) {
        list.addEventListener('click', (e) => {
            if (e.target.classList.contains('delete-car')) {
                const id = parseInt(e.target.dataset.id, 10);
                deleteCar(id);
            }
        });
        list.addEventListener('change',(e)=>{
            if(e.target.classList.contains('toggle-hide')){
               const id=parseInt(e.target.dataset.id,10);
               const car=appData.cars.find(c=>c.id===id);
               if(car){car.hideFromRanking=!e.target.checked;window.Storage.updateCar(car).catch(console.error);saveData();RankingUI.update();}
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
  
    function rebuildElo(){
        console.log('Rebuild Elo triggered');
        if(!window.isAdmin){showToast('Nur Admin');return;}
        if(!confirm('Alle GRP-Werte neu berechnen?')) return;
        // Alle Fahrer und Fahrzeuge auf 1000 zurücksetzen
        appData.drivers.forEach(driver => {
            driver.elo = 1000;
            driver.races = 0;
            driver.wins = 0;
            driver.totalRounds = 0;
        });
        appData.cars.forEach(car => {
            car.elo = 1000;
            car.races = 0;
            car.wins = 0;
            car.totalRounds = 0;
        });

        // Rennen nach Datum+Zeit sortieren (chronologisch)
        const ordered = [...appData.races].sort((a, b) => {
            const ts = r => {
                const dateStr = r.date || '01.01.1970'; // dd.mm.yyyy
                const timeStr = (r.time || '00:00').replace(/[^0-9:]/g,''); // HH:MM
                const parts = dateStr.split('.');
                const iso = (parts.length===3) ? `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}` : dateStr;
                return new Date(`${iso}T${timeStr}:00`).getTime();
            };
            return ts(a) - ts(b);
        });

        // Alle Rennen chronologisch neu berechnen
        ordered.forEach(race => {
            const totalPlayers = race.results.length;
            const kFactor = calculateKFactor(totalPlayers, race.rounds);

            // aktuelle Elo-Listen nach Reset / vorherigen Rennen
            const currDriverElos = race.results.map(res=>{
                const d=appData.drivers.find(x=>x.id===res.driverId);return d?d.elo:1000;});
            const currCarElos = race.results.map(res=>{
                const c=appData.cars.find(x=>x.id===res.carId);return c?c.elo:1000;});

            race.results.forEach((res,idx) => {
                const driverObj = appData.drivers.find(d => d.id === res.driverId);
                const carObj    = appData.cars.find(c => c.id === res.carId);
                if(!(driverObj&&carObj)) return;

                // save old ELO before update
                res.oldDriverElo = driverObj.elo;
                res.oldCarElo    = carObj.elo;

                const otherDriverElos = currDriverElos.filter((_,i)=>i!==idx);
                const otherCarElos    = currCarElos.filter((_,i)=>i!==idx);

                const expectedDriver = calculateExpectedScore(driverObj.elo, otherDriverElos);
                const expectedCar    = calculateExpectedScore(carObj.elo,    otherCarElos);

                const actualScore = calculateActualScore(res.position, totalPlayers);

                const driverEloChange = Math.round(kFactor * (actualScore - expectedDriver));
                const carEloChange    = Math.round(kFactor * (actualScore - expectedCar));

                const driver = appData.drivers.find(d => d.id === res.driverId);
                const car    = appData.cars.find(c => c.id === res.carId);
                if (driver && car) {
                    driverObj.elo = Math.max(100, driverObj.elo + driverEloChange);
                    carObj.elo    = Math.max(100, carObj.elo + carEloChange);

                    driverObj.races++;
                    carObj.races++;

                    // Siege & Runden
                    if (res.position === 1) {
                        driverObj.wins = (driverObj.wins || 0) + 1;
                        carObj.wins    = (carObj.wins || 0) + 1;
                    }
                    driverObj.totalRounds = (driverObj.totalRounds || 0) + race.rounds;
                    carObj.totalRounds    = (carObj.totalRounds || 0) + race.rounds;

                    res.newDriverElo    = driverObj.elo;
                    res.newCarElo       = carObj.elo;
                    res.driverEloChange = driverEloChange;
                    res.carEloChange    = carEloChange;

                    // Kompatibilität: alter Schlüssel
                    res.eloChange = driverEloChange;
                }
            });
        });

        saveData();
        RankingUI.update();
        showToast('Alle G!RP-Werte wurden neu berechnet und gespeichert!');
    }

    // Entfernt – neuer Listener ist in race.js
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