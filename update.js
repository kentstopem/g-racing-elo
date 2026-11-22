// update.js – neue Version selbst erkennen und laden
//
// Hintergrund: Bluefy (Web-Bluetooth-Browser auf dem Garagen-iPad) hat keinen Service Worker und hält
// die Seite oft stundenlang offen. Darum prüft die App selbst, ob auf dem Server eine neuere Release-
// Nummer liegt (version.js), beim Start, beim Zurückholen in den Vordergrund und alle 5 Minuten.
// Neu geladen wird NIE während einer Livecenter-Sitzung oder bei offenem Livecenter (die CU-Verbindung
// ginge verloren), sondern erst, wenn man wieder im Hauptmenü ist.
(function () {
  const cur = window.APP_RELEASE;
  if (cur == null) return;   // lokal (dev): nichts tun
  const KEY = 'grpUpdateTried';
  let pending = null, checking = false, timer = null;

  const busy = () => document.documentElement.classList.contains('lc-open') || !!window.Livecenter?.session;

  async function latest () {
    const res = await fetch(`version.js?check=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const m = /APP_RELEASE\s*=\s*(\d+)\s*;/.exec(await res.text());
    return m ? +m[1] : null;
  }

  async function check () {
    if (checking || navigator.onLine === false) return;
    checking = true;
    try {
      const n = await latest();
      if (n && n > cur) {
        // Schon einmal für diese Nummer neu geladen und trotzdem alt? Dann nicht in einer Schleife hängen.
        let tried = null; try { tried = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) {}
        if (tried && tried.n === n && Date.now() - tried.at < 10 * 60 * 1000) return;
        pending = n; apply();
      }
    } catch (e) { /* offline o. ä.: später wieder */ } finally { checking = false; }
  }

  async function apply () {
    if (!pending) return;
    if (busy()) { if (!timer) timer = setInterval(apply, 15000); return; }   // nach dem Livecenter nachholen
    clearInterval(timer); timer = null;
    const n = pending; pending = null;
    try { sessionStorage.setItem(KEY, JSON.stringify({ n, at: Date.now() })); } catch (e) {}
    // Service Worker (Safari/Chrome) aktualisieren und den HTTP-Cache der App-Dateien frisch holen (Bluefy)
    try { const reg = await navigator.serviceWorker?.getRegistration(); await reg?.update(); } catch (e) {}
    const files = ['./', ...[...document.querySelectorAll('script[src], link[rel="stylesheet"][href]')]
      .map(el => el.getAttribute('src') || el.getAttribute('href'))
      .filter(u => u && !/^(https?:)?\/\//.test(u))];
    await Promise.all(files.map(f => fetch(f, { cache: 'reload' }).catch(() => {})));
    location.reload();
  }

  window.addEventListener('load', () => setTimeout(check, 3000));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  window.addEventListener('online', check);
  setInterval(check, 5 * 60 * 1000);
  window.AppUpdate = { check };
})();
