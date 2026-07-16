// Initializes Firebase and exports the Firestore database connection
// for use by other modules (dashboard pages, admin page).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBXJ3afTj1Y5o0Ag1pOjJc8kJwdQutN7BA",
  authDomain: "enceladus-mission-simulation.firebaseapp.com",
  projectId: "enceladus-mission-simulation",
  storageBucket: "enceladus-mission-simulation.firebasestorage.app",
  messagingSenderId: "106311185917",
  appId: "1:106311185917:web:71ca61b837c0f453d25594"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);