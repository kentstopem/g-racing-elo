// firebase.js – initialisiert Firebase für Carrera ELO Racing
// SDK: compat/cdn-Variante, daher liegt alles unter globalem Namespace "firebase".

// -------------------------------
// Firebase-Konfiguration (öffentlich)
// -------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyCgpQQQ4OW_HGLqCYmn8WRwclUW8DXqJC0",
  authDomain: "g-racing-elo.firebaseapp.com",
  projectId: "g-racing-elo",
  storageBucket: "g-racing-elo.appspot.com",
  messagingSenderId: "753006195268",
  appId: "1:753006195268:web:a3910bf020b77212de8211",
  measurementId: "G-DJW6T722W6"
};

// -------------------------------
// Initialisierung
// -------------------------------
firebase.initializeApp(firebaseConfig);

// Globale Helfer
window.auth = firebase.auth();
window.db   = firebase.firestore();

// Login / Logout Funktionen
window.login  = (mail, pw) => window.auth.signInWithEmailAndPassword(mail, pw);
window.logout = () => window.auth.signOut();

// Auth-Status global ablegen & Event feuern
window.isAdmin = false;
window.auth.onAuthStateChanged(user => {
  window.isAdmin = !!user;
  document.dispatchEvent(new CustomEvent('auth-changed', { detail: user }));
});

// -------------------------------
// Helfer – Referenzen auf window legen
// -------------------------------
function autoAttachGlobals () {
  // Damit app.js (vorerst) ohne Refactor auf globale Objekte zugreifen kann
  window.db   = firebase.firestore();
  window.auth = firebase.auth();
}