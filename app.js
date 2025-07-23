// Carrera ELO Racing – ausgelagerte App-Logik
// Hinweis: Aktuell weiterhin localStorage-basiert. Firebase-Integration folgt.

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

// Toast Helper
function showToast(message,duration=2500){
    const t=document.createElement('div');
    t.className='toast';
    t.textContent=message;
    document.body.appendChild(t);
    // small delay to allow insertion
    setTimeout(()=>t.classList.add('show'),10);
    setTimeout(()=>{
        t.classList.remove('show');
        setTimeout(()=>t.remove(),300);
    },duration);
}

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

    const section = document.getElementById(sectionName);
    if (section) section.classList.add('active');

    const button = document.querySelector(`[data-section="${sectionName}"]`);
    if (button) button.classList.add('active');

    currentSection = sectionName;

    if (sectionName === 'rankings') {
        updateRankings();
        document.getElementById('rankSubNav').classList.remove('hidden');
    } else if (sectionName === 'history') {
        updateHistory();
        document.getElementById('rankSubNav').classList.add('hidden');
    } else if (sectionName === 'race') {
        updateRaceForm();
        document.getElementById('rankSubNav').classList.add('hidden');
    } else {
        document.getElementById('rankSubNav').classList.add('hidden');
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
    updateRaceForm();
}

function deleteDriver(id) {
    if (!confirm('Fahrer wirklich löschen? Alle Renndaten gehen verloren!')) return;

    appData.drivers = appData.drivers.filter(d => d.id !== id);
    appData.races   = appData.races.filter(race => !race.results.some(r => r.driverId === id));

    // Firestore-Dokument direkt löschen
    window.Storage.deleteDriver(id).catch(err => console.error('deleteDriver Firestore:', err));

    saveData();
    updateDriversList();
    updateRaceForm();
}

function updateDriversList() {
    const list = document.getElementById('driversList');
    if (!list) return;

    if (appData.drivers.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: #666;">Noch keine Fahrer hinzugefügt.</p>';
        return;
    }

    list.innerHTML = appData.drivers.map(driver => `
        <div class="list-item">
            <div>
                <strong>${driver.name}</strong>
                <div style="font-size: 0.9em; color: #666;">
                    ${driver.races} Rennen · ${driver.wins||0} Siege · ${driver.totalRounds||0} Rd.
                </div>
            </div>
            <div style="display: flex; align-items: center;">
                <span class="elo-score">${driver.elo}</span>
                <button class="btn btn-danger" onclick="deleteDriver(${driver.id})">Löschen</button>
            </div>
        </div>
    `).join('');
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
        totalRounds: 0
    });

    input.value = '';
    saveData();
    updateCarsList();
    updateRaceForm();
}

function deleteCar(id) {
    if (!confirm('Fahrzeug wirklich löschen? Alle Renndaten gehen verloren!')) return;

    appData.cars  = appData.cars.filter(c => c.id !== id);
    appData.races = appData.races.filter(race => !race.results.some(r => r.carId === id));

    window.Storage.deleteCar(id).catch(err => console.error('deleteCar Firestore:', err));

    saveData();
    updateCarsList();
    updateRaceForm();
}

function updateCarsList() {
    const list = document.getElementById('carsList');
    if (!list) return;

    if (appData.cars.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: #666;">Noch keine Fahrzeuge hinzugefügt.</p>';
        return;
    }

    list.innerHTML = [...appData.cars].sort((a,b)=>a.name.localeCompare(b.name)).map(car => `
        <div class="list-item">
            <div>
                <strong>${car.name}</strong>
                <div style="font-size: 0.9em; color: #666;">
                    ${car.races} Rennen · ${car.wins||0} Siege · ${car.totalRounds||0} Rd.
                </div>
            </div>
            <div style="display: flex; align-items: center;">
                <span class="elo-score">${car.elo}</span>
                <button class="btn btn-danger" onclick="deleteCar(${car.id})">Löschen</button>
            </div>
        </div>
    `).join('');
}

// Renn-Management
function initRaceManagement() {
    const addBtn = document.getElementById('addRaceEntryBtn');
    const calculateBtn = document.getElementById('calculateRaceBtn');

    addBtn.addEventListener('click', addRaceEntry);
    calculateBtn.addEventListener('click', calculateRace);
}

function updateRaceForm() {
    const container = document.getElementById('raceEntries');
    if (!container) return;

    // Datum auf heute setzen, falls leer
    const raceDateInput = document.getElementById('raceDate');
    if (raceDateInput && !raceDateInput.value) {
        raceDateInput.value = new Date().toISOString().split('T')[0];
    }

    // Standardrunden setzen, falls leer
    const raceRoundsInput = document.getElementById('raceRounds');
    if (raceRoundsInput && !raceRoundsInput.value) {
        raceRoundsInput.value = '60';
    }

    if (container.children.length === 0) {
        for (let i = 0; i < 6; i++) addRaceEntry();
    }
}

function addRaceEntry() {
    appData.raceCounter++;
    const container = document.getElementById('raceEntries');
    if (!container) return;

    const entry = document.createElement('div');
    entry.className = 'race-entry';
    entry.innerHTML = `
        <div class="form-group flex-1" style="margin:0;">
            <label>Platz ${appData.raceCounter}:</label>
            <select class="driver-select">
                <option value="">Fahrer wählen...</option>
                ${[...appData.drivers].sort((a,b)=>a.name.localeCompare(b.name)).map(d => `<option value="${d.id}">${d.name}</option>`).join('')}
            </select>
        </div>
        <div class="form-group flex-1" style="margin:0;">
            <label>Fahrzeug:</label>
            <select class="car-select">
                <option value="">Fahrzeug wählen...</option>
                ${[...appData.cars].sort((a,b)=>a.name.localeCompare(b.name)).map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
            </select>
        </div>
        <button class="btn btn-danger" onclick="removeRaceEntry(this)">Entfernen</button>
    `;
    container.appendChild(entry);
}

function removeRaceEntry(button) {
    const container = document.getElementById('raceEntries');
    if (container.children.length <= 2) {
        showToast('Mindestens 2 Teilnehmer erforderlich!');
        return;
    }
    button.parentElement.remove();
    updateRacePositions();
}

function updateRacePositions() {
    const entries = document.querySelectorAll('.race-entry');
    entries.forEach((entry, index) => {
        const label = entry.querySelector('label');
        if (label) label.textContent = `Platz ${index + 1}:`;
    });
    appData.raceCounter = entries.length;
}

// ELO Berechnung
function calculateExpectedScore(playerElo, opponentElos) {
    return opponentElos.reduce((acc, opponentElo) => acc + 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400)), 0) / opponentElos.length;
}

function calculateActualScore(position, totalPlayers) {
    return (totalPlayers - position) / (totalPlayers - 1);
}

function calculateKFactor(totalPlayers, rounds = 50) {
    const baseK = 32; // Grundwert

    // Skaliert linear: 20 → 0.5  |  75 → 1.0
    const roundWeight = Math.min(1, Math.max(0.5, 0.5 + ((rounds - 20) / 55) * 0.5));

    // Gewicht nach Teilnehmerzahl (2 Fahrer → 0.5, 6 Fahrer → 1.0)
    const playerWeight = Math.min(1, Math.max(0.5, (totalPlayers - 2) / 4 + 0.5));

    return Math.round(baseK * roundWeight * playerWeight);
}

function calculateRace() {
    const entries = document.querySelectorAll('.race-entry');
    const results = [];

    // Datum & Runden holen
    const raceDateInput = document.getElementById('raceDate');
    const raceRoundsInput = document.getElementById('raceRounds');

    const raceDate = raceDateInput.value || new Date().toISOString().split('T')[0];
    const rounds = parseInt(raceRoundsInput.value) || 50;

    if (rounds < 1 || rounds > 999) {
        showToast('Rundenzahl muss zwischen 1 und 999 liegen!');
        return;
    }

    // Validierung der Teilnehmer
    let foundGap = false;
    for (let i = 0; i < entries.length; i++) {
        const driverId = entries[i].querySelector('.driver-select').value;
        const carId = entries[i].querySelector('.car-select').value;

        const hasSel = driverId && carId;
        if (!hasSel) {
            foundGap = true;
            // ensure no later selections
            const laterFilled = Array.from(entries).slice(i+1).some(e => {
                const d = e.querySelector('.driver-select').value;
                const c = e.querySelector('.car-select').value;
                return d && c;
            });
            if (laterFilled) {
                showToast('Plätze müssen ohne Lücke ausgefüllt werden!');
                return;
            }
            continue;
        }
        if (foundGap) {
            showToast('Plätze müssen ohne Lücke ausgefüllt werden!');
            return;
        }

        if (results.some(r => r.driverId == driverId)) {
            showToast('Fahrer kann nicht mehrmals teilnehmen!');
            return;
        }
        if (results.some(r => r.carId == carId)) {
            showToast('Fahrzeug kann nicht mehrmals verwendet werden!');
            return;
        }

        const driver = appData.drivers.find(d => d.id == driverId);
        const car = appData.cars.find(c => c.id == carId);
        if (!driver || !car) {
            showToast('Fehler beim Finden von Fahrer oder Fahrzeug!');
            return;
        }

        results.push({
            position: i + 1,
            driverId: parseInt(driverId),
            carId: parseInt(carId),
            driverName: driver.name,
            carName: car.name,
            oldDriverElo: driver.elo,
            oldCarElo: car.elo
        });
    }

    const totalPlayers = results.length;
    const kFactor = calculateKFactor(totalPlayers, rounds);

    results.forEach(res => {
        // Erwartungswerte separat für Fahrer & Fahrzeuge berechnen
        const otherDriverElos = results.filter(r => r !== res).map(r => r.oldDriverElo);
        const otherCarElos    = results.filter(r => r !== res).map(r => r.oldCarElo);

        const expectedDriver = calculateExpectedScore(res.oldDriverElo, otherDriverElos);
        const expectedCar    = calculateExpectedScore(res.oldCarElo,  otherCarElos);

        const actualScore = calculateActualScore(res.position, totalPlayers);

        const driverEloChange = Math.round(kFactor * (actualScore - expectedDriver));
        const carEloChange    = Math.round(kFactor * (actualScore - expectedCar));

        const driver = appData.drivers.find(d => d.id === res.driverId);
        const car    = appData.cars.find(c => c.id === res.carId);
        if (driver && car) {
            driver.elo = Math.max(100, driver.elo + driverEloChange);
            car.elo    = Math.max(100, car.elo + carEloChange);

            driver.races++;
            car.races++;

            // Siege & Runden
            if (res.position === 1) {
                driver.wins = (driver.wins || 0) + 1;
                car.wins    = (car.wins || 0) + 1;
            }
            driver.totalRounds = (driver.totalRounds || 0) + rounds;
            car.totalRounds    = (car.totalRounds || 0) + rounds;

            res.newDriverElo    = driver.elo;
            res.newCarElo       = car.elo;
            res.driverEloChange = driverEloChange;
            res.carEloChange    = carEloChange;

            // Kompatibilität: alter Schlüssel
            res.eloChange = driverEloChange;
        }
    });

    const formattedDate = new Date(raceDate).toLocaleDateString('de-DE');
    const raceTimeInput = document.getElementById('raceTime');
    const raceTime = (raceTimeInput && raceTimeInput.value) ? raceTimeInput.value : new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

    appData.races.unshift({
        id: Date.now(),
        date: formattedDate,
        time: raceTime,
        rounds: rounds,
        results: results
    });

    saveData();

    const container = document.getElementById('raceEntries');
    if (container) {
        container.innerHTML = '';
        appData.raceCounter = 0;
        updateRaceForm();
    }

    raceDateInput.value = '';
    raceRoundsInput.value = '';

    showToast(`Rennen erfolgreich ausgewertet!\nRunden: ${rounds}\nK-Faktor: ${kFactor}`);
    updateDriversList();
    updateCarsList();
}

function deleteRace(raceId) {
    const race = appData.races.find(r => r.id === raceId);
    if (!race) {
        showToast('Rennen nicht gefunden!');
        return;
    }

    const raceInfo = `${race.date} um ${race.time || ''}`;
    if (!confirm(`Rennen vom ${raceInfo} wirklich löschen?\n${race.rounds || 50} Runden, ${race.results.length} Teilnehmer\n\nAlle ELO-Änderungen werden rückgängig gemacht!`)) {
        return;
    }

    race.results.forEach(res => {
        const driver = appData.drivers.find(d => d.id === res.driverId);
        const car = appData.cars.find(c => c.id === res.carId);
        if (driver && car) {
            driver.elo = res.oldDriverElo;
            car.elo = res.oldCarElo;
            driver.races = Math.max(0, driver.races - 1);
            car.races = Math.max(0, car.races - 1);
            // Siege & Runden zurück
            if (res.position === 1) {
                driver.wins = Math.max(0, (driver.wins||0) - 1);
                car.wins    = Math.max(0, (car.wins||0) - 1);
            }
            driver.totalRounds = Math.max(0, (driver.totalRounds||0) - race.rounds);
            car.totalRounds    = Math.max(0, (car.totalRounds||0) - race.rounds);
        }
    });

    appData.races = appData.races.filter(r => r.id !== raceId);

    window.Storage.deleteRace(raceId).catch(err => console.error('deleteRace Firestore:', err));

    saveData();
    updateHistory();
    updateDriversList();
    updateCarsList();

    showToast('Rennen erfolgreich gelöscht und ELO-Werte zurückgesetzt!');
}

function updateRankings() {
    updateDriverRanking();
    updateCarRanking();
}

function updateDriverRanking() {
    const sortedDrivers = [...appData.drivers].sort((a, b) => b.elo - a.elo);
    const podiumContainer = document.getElementById('driverPodium');
    if (podiumContainer) {
        if (sortedDrivers.length === 0) {
            podiumContainer.innerHTML = '';
        } else {
            const order=[1,0,2];
            const classes=['second','first','third'];
            const medals=['🥈','🥇','🥉'];
            podiumContainer.innerHTML = order.map(idx=>sortedDrivers[idx]).filter(Boolean).map((driver,i)=>`
                <div class="podium-item ${classes[i]}">
                    <div class="podium-position">${medals[i]}</div>
                    <div class="podium-name">${driver.name}</div>
                    <div class="podium-elo">${driver.elo} ELO</div>
                    <div style="font-size:0.75em;opacity:0.9;">${driver.races}R · ${driver.wins||0}S · ${driver.totalRounds||0}Rd</div>
                </div>
            `).join('');
        }
    }

    const rankingContainer = document.getElementById('driversRanking');
    if (rankingContainer) {
        if (sortedDrivers.length === 0) {
            rankingContainer.innerHTML = '<p style="text-align: center; color: #666;">Noch keine Fahrer vorhanden.</p>';
        } else {
            rankingContainer.innerHTML = sortedDrivers.slice(3).map((driver, index) => `
                <div class="list-item">
                    <div>
                        <strong>#${index + 4} ${driver.name}</strong>
                        <div style="font-size: 0.9em; color: #666;">${driver.races} Rennen · ${driver.wins||0} Siege · ${driver.totalRounds||0} Runden</div>
                    </div>
                    <span class="elo-score">${driver.elo}</span>
                </div>
            `).join('');
        }
    }

    // Tagline mit neuem Spitzenreiter aktualisieren
    updateTagline();
}

function updateCarRanking() {
    const sortedCars = [...appData.cars].sort((a, b) => b.elo - a.elo);
    const podiumContainer = document.getElementById('carPodium');
    if (podiumContainer) {
        if (sortedCars.length === 0) {
            podiumContainer.innerHTML = '';
        } else {
            const order=[1,0,2];
            const classes=['second','first','third'];
            const medals=['🥈','🥇','🥉'];
            podiumContainer.innerHTML = order.map(idx=>sortedCars[idx]).filter(Boolean).map((car,i)=>`
                <div class="podium-item ${classes[i]}">
                    <div class="podium-position">${medals[i]}</div>
                    <div class="podium-name">${car.name}</div>
                    <div class="podium-elo">${car.elo} ELO</div>
                    <div style="font-size:0.75em;opacity:0.9;">${car.races}R · ${car.wins||0}S · ${car.totalRounds||0}Rd</div>
                </div>
            `).join('');
        }
    }

    const rankingContainer = document.getElementById('carsRanking');
    if (rankingContainer) {
        if (sortedCars.length === 0) {
            rankingContainer.innerHTML = '<p style="text-align: center; color: #666;">Noch keine Fahrzeuge vorhanden.</p>';
        } else {
            rankingContainer.innerHTML = sortedCars.slice(3).map((car, index) => `
                <div class="list-item">
                    <div>
                        <strong>#${index + 4} ${car.name}</strong>
                        <div style="font-size: 0.9em; color: #666;">${car.races} Rennen · ${car.wins||0} Siege · ${car.totalRounds||0} Runden</div>
                    </div>
                    <span class="elo-score">${car.elo}</span>
                </div>
            `).join('');
        }
    }
}

function updateHistory() {
    const historyContainer = document.getElementById('raceHistory');
    if (!historyContainer) return;

    if (appData.races.length === 0) {
        historyContainer.innerHTML = '<p style="text-align: center; color: #666;">Noch keine Rennen gefahren.</p>';
        return;
    }

    const driverFilterActive = Array.isArray(historyFilter) && historyFilter.length > 0;
    const carFilterActive = Array.isArray(carFilter) && carFilter.length > 0;

    const ts=r=>{
        const dateStr=r.date||'01.01.1970';
        const dParts=dateStr.split('.');
        const iso=dParts.length===3?`${dParts[2]}-${dParts[1].padStart(2,'0')}-${dParts[0].padStart(2,'0')}`:dateStr;
        const timeStr=(r.time||'00:00').replace(/[^0-9:]/g,'');
        return new Date(`${iso}T${timeStr}:00`).getTime();
    };

    historyContainer.innerHTML = [...appData.races]
        .sort((a,b)=>ts(b)-ts(a)) // neueste zuerst
        .filter(r=>{
            // Wenn keine Filter aktiv → alles zulassen
            if(!driverFilterActive && !carFilterActive) return true;

            const drvIds=r.results.map(x=>x.driverId);
            const carIds=r.results.map(x=>x.carId);

            // Fall 1: Kombination (genau 1 Fahrer & 1 Fahrzeug gewählt) → beide müssen im selben Ergebnis-Datensatz vorkommen
            if(driverFilterActive && carFilterActive && historyFilter.length===1 && carFilter.length===1){
                return r.results.some(res=>res.driverId===historyFilter[0] && res.carId===carFilter[0]);
            }

            // Fall 2: Standard-Logik (jede Liste einzeln prüfen)
            if(driverFilterActive && !historyFilter.every(id=>drvIds.includes(id))) return false;
            if(carFilterActive    && !carFilter.every(id=>carIds.includes(id)))   return false;

            return true;
        })
        .map(race => {
        const header = `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
            <div class="race-date">📅 ${race.date} – ${race.time || ''} – ${race.rounds} Rd.</div>
            ${window.isAdmin ? `<button class="btn btn-danger" style="padding:6px 12px;font-size:12px;" onclick="deleteRace(${race.id})">Löschen</button>` : ''}
        </div>`;

        const rows = race.results.map(res => {
            const drvChange = (res.driverEloChange !== undefined) ? res.driverEloChange : res.eloChange;
            const carChange = (res.carEloChange   !== undefined) ? res.carEloChange   : drvChange;

            const drvColor = drvChange >= 0 ? 'elo-up' : 'elo-down';
            const carColor = carChange >= 0 ? 'elo-up' : 'elo-down';
            return `
                <tr>
                    <td class="pos">${res.position}.</td>
                    <td><strong>${res.driverName}</strong></td>
                    <td>${res.oldDriverElo} → <span class="${drvColor}">${res.newDriverElo} (${drvChange>=0?'+':''}${drvChange})</span></td>
                </tr>
                <tr class="sub">
                    <td></td>
                    <td>${res.carName}</td>
                    <td>${res.oldCarElo} → <span class="${carColor}">${res.newCarElo} (${carChange>=0?'+':''}${carChange})</span></td>
                </tr>`;
        }).join('');

        return `<div class="race-history-item"><table class="race-table"><tbody>${header}</tbody></table><table class="race-table"><tbody>${rows}</tbody></table></div>`;
    }).join('');
}

// Auth UI Handling
function updateAuthUI() {
    const admin = window.isAdmin;
    // Nav-Buttons
    document.querySelectorAll('.admin-only').forEach(btn => {
        btn.style.display = admin ? '' : 'none';
    });

    const authBtn = document.getElementById('authBtn');
    if (authBtn) authBtn.textContent = admin ? 'Logout' : 'Login';

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
    document.querySelectorAll('.sub-tab').forEach(btn=>{
        btn.addEventListener('click',()=>{
            document.querySelectorAll('.sub-tab').forEach(b=>b.classList.remove('active'));
            btn.classList.add('active');
            const sel=btn.getAttribute('data-rank');
            document.getElementById('driversRankWrapper').classList.toggle('hidden', sel!=='drivers');
            document.getElementById('carsRankWrapper').classList.toggle('hidden', sel!=='cars');
        });
    });

    // History filter button & modal
    const filterBtn=document.getElementById('historyFilterBtn');
    const filterModal=document.getElementById('filterModal');
    const filterList=document.getElementById('filterDriverList');
    const filterCarList=document.getElementById('filterCarList');
    const filterApply=document.getElementById('filterApplyBtn');
    const filterCancel=document.getElementById('filterCancelBtn');

    function openFilter(){
        // Fahrer-Liste
        filterList.innerHTML=[...appData.drivers]
            .sort((a,b)=>a.name.localeCompare(b.name))
            .map(d=>`<label style='display:flex;align-items:center;gap:6px;margin:4px 0;'><input type='checkbox' value='${d.id}' ${historyFilter.includes(d.id)?'checked':''}>${d.name}</label>`)
            .join('');
        // Fahrzeug-Liste
        if(filterCarList){
            filterCarList.innerHTML=[...appData.cars]
                .sort((a,b)=>a.name.localeCompare(b.name))
                .map(c=>`<label style='display:flex;align-items:center;gap:6px;margin:4px 0;'><input type='checkbox' value='${c.id}' ${carFilter.includes(c.id)?'checked':''}>${c.name}</label>`)
                .join('');
        }
        filterModal.classList.remove('hidden');
    }
    function closeFilter(){filterModal.classList.add('hidden');}

    if(filterBtn){filterBtn.addEventListener('click',openFilter);} 
    if(filterCancel){filterCancel.addEventListener('click',closeFilter);} 
    if(filterApply){filterApply.addEventListener('click',()=>{
        historyFilter=[...filterList.querySelectorAll('input:checked')].map(i=>parseInt(i.value));
        if(filterCarList){ carFilter=[...filterCarList.querySelectorAll('input:checked')].map(i=>parseInt(i.value)); }
        closeFilter();

        // Treffer zählen mit derselben Logik wie in updateHistory()
        const driverActive = Array.isArray(historyFilter) && historyFilter.length > 0;
        const carActive    = Array.isArray(carFilter)    && carFilter.length > 0;

        const matches = appData.races.filter(r=>{
            if(!driverActive && !carActive) return true;

            const drvIds=r.results.map(x=>x.driverId);
            const carIds=r.results.map(x=>x.carId);

            // Kombination exakt 1+1
            if(driverActive && carActive && historyFilter.length===1 && carFilter.length===1){
                return r.results.some(res=>res.driverId===historyFilter[0] && res.carId===carFilter[0]);
            }

            if(driverActive && !historyFilter.every(id=>drvIds.includes(id))) return false;
            if(carActive    && !carFilter.every(id=>carIds.includes(id)))   return false;

            return true;
        }).length;

        updateHistory();
        showToast(`${matches} Rennen gefunden`);
    });}

    function rebuildElo(){
        console.log('Rebuild Elo triggered');
        if(!window.isAdmin){showToast('Nur Admin');return;}
        if(!confirm('Alle ELO-Werte neu berechnen?')) return;
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
        updateRankings();
        showToast('Alle ELO-Werte wurden neu berechnet und gespeichert!');
    }

    document.getElementById('rebuildEloBtn')?.addEventListener('click',rebuildElo);
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
        initRaceManagement();
        updateDriversList();
        updateCarsList();
        updateRaceForm();
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
window.removeRaceEntry = removeRaceEntry;
window.deleteRace = deleteRace;
window.updateTagline = updateTagline; 