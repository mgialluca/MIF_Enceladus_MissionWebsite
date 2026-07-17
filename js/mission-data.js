// Handles all reads/writes to the shared unlock-state document in Firestore.

import { db } from "./firebase-init.js";
import {
  doc, onSnapshot, setDoc, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const unlocksRef = doc(db, "missionState", "unlocks");

// Subscribes to live changes in the unlock document.
// callback receives an object like { HIVE_unlocked: [...], WhiteWhale_unlocked: [...] }
export function listenToUnlocks(callback) {
  return onSnapshot(unlocksRef, (snap) => {
    callback(snap.exists() ? snap.data() : {});
  });
}

// Adds a game ID to a group's unlocked array. Safe to call even if the
// document or field doesn't exist yet — setDoc with merge:true creates it.
export async function unlockGame(group, gameId) {
  const fieldName = `${group}_unlocked`;
  await setDoc(unlocksRef, { [fieldName]: arrayUnion(gameId) }, { merge: true });
}

// removes a game ID from a group's unlocked array
export async function relockGame(group, gameId) {
  const fieldName = `${group}_unlocked`;
  await setDoc(unlocksRef, { [fieldName]: arrayRemove(gameId) }, { merge: true });
}