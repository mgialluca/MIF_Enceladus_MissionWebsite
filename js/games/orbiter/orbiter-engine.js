// Orbiter-view timeline engine, shared by HIVE and WhiteWhale (one doc per group).
//
// Firestore doc: groups/{group}/orbiter/state
//
// The whole timeline is anchored to `startedAt`, written when an admin unlocks
// the Orbiter View. Every phase is computed from that absolute timestamp, so
// visitors never restart it. Side effects (plume uploads, the drill unlock)
// are performed by whichever open page reaches them first, guarded by
// Firestore status flags so each happens once.

import { db } from "../../firebase-init.js";
import {
  doc, getDoc, setDoc, onSnapshot, runTransaction
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { unlockGame } from "../../mission-data.js";
import { ORBITER_CONFIG } from "./config.js";

const C = ORBITER_CONFIG;

// Phase boundaries, in seconds after startedAt.
const END_ARRIVAL = C.ARRIVAL_SECONDS;                       // 30
const END_FLYBY1 = END_ARRIVAL + C.FLYBY_SECONDS;            // 60
const END_COLLECT1 = END_FLYBY1 + C.PLUME_COLLECT_SECONDS;   // 70  -> upload flyby 1
const END_FLYBY2 = END_COLLECT1 + C.FLYBY_SECONDS;           // 100
const END_COLLECT2 = END_FLYBY2 + C.PLUME_COLLECT_SECONDS;   // 110 -> upload flyby 2, landing site opens

function orbiterRef(group) {
  return doc(db, "groups", group, "orbiter", "state");
}

async function getOrbiter(group) {
  const snap = await getDoc(orbiterRef(group));
  return snap.exists() ? snap.data() : null;
}

export function initialOrbiterState() {
  return {
    startedAt: null,
    plume1Status: "pending",   // "pending" | "uploading" | "uploaded" | "error"
    plume2Status: "pending",
    landingConfirmedAt: null,
    landingUnlocked: false
  };
}

/** Called by the admin page when the Orbiter View is unlocked. Restarts the timeline. */
export async function startOrbiterTimeline(group) {
  const now = Date.now();
  await setDoc(orbiterRef(group), { ...initialOrbiterState(), startedAt: now, lastUpdated: now });
}

/**
 * Derives what the page should show right now from the stored timestamps.
 * Returns { phase, remainingS? } where remainingS is set for countdown phases.
 */
export function orbiterPhase(s, nowMs = Date.now()) {
  if (!s?.startedAt) return { phase: "not_started" };

  const t = (nowMs - s.startedAt) / 1000;
  if (t < END_ARRIVAL) return { phase: "arrival", remainingS: END_ARRIVAL - t };
  if (t < END_FLYBY1) return { phase: "flyby1", remainingS: END_FLYBY1 - t };
  if (t < END_COLLECT1) return { phase: "collect1" };
  if (t < END_FLYBY2) return { phase: "flyby2", remainingS: END_FLYBY2 - t };
  if (t < END_COLLECT2) return { phase: "collect2" };

  if (!s.landingConfirmedAt) return { phase: "select_landing" };

  const landingEndMs = s.landingConfirmedAt + C.LANDING_SECONDS * 1000;
  if (nowMs < landingEndMs) return { phase: "landing", remainingS: (landingEndMs - nowMs) / 1000 };
  return { phase: "landed" };
}

/** Locks in the landing site. Purely a game event — the site itself is not recorded. */
export async function confirmLandingSite(group) {
  const s = await getOrbiter(group);
  if (orbiterPhase(s).phase !== "select_landing") {
    throw new Error("Landing site selection is not open yet.");
  }
  const now = Date.now();
  await setDoc(orbiterRef(group), { landingConfirmedAt: now, lastUpdated: now }, { merge: true });
  await tickOrbiter(group);
}

// ===================== Plume data uploads =====================

// Claims an upload with a transaction so two open pages can't both send it.
async function claimPlumeUpload(group, flyby) {
  const ref = orbiterRef(group);
  const field = `plume${flyby}Status`;
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists() || snap.data()[field] !== "pending") return false;
    tx.update(ref, { [field]: "uploading" });
    return true;
  });
}

async function uploadPlume(group, flyby) {
  const claimed = await claimPlumeUpload(group, flyby);
  if (!claimed) return;

  const field = `plume${flyby}Status`;
  try {
    const datUrl = new URL(`../../../assets/PlumeData/${C.PLUME_FILE_NAMES[flyby]}`, import.meta.url);
    const content = await (await fetch(datUrl)).text();

    const response = await fetch(C.UPLOAD_PLUME_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group, flyby, content })
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Cloud Function HTTP ${response.status}: ${raw.slice(0, 200)}`);
    const result = JSON.parse(raw);

    await setDoc(orbiterRef(group), {
      [field]: "uploaded",
      [`plume${flyby}Filename`]: result.filename
    }, { merge: true });
  } catch (err) {
    console.error(`Plume flyby ${flyby} upload failed for ${group}`, err);
    await setDoc(orbiterRef(group), { [field]: "error" }, { merge: true });
  }
}

// ===================== Tick: runs every side effect that's now due =====================

const scheduledTimers = {};

function scheduleTick(group, atMs) {
  clearTimeout(scheduledTimers[group]);
  if (atMs == null) return;
  scheduledTimers[group] = setTimeout(
    () => tickOrbiter(group).catch(console.error),
    Math.max(0, atMs - Date.now())
  );
}

function nextDueMs(s) {
  if (!s?.startedAt) return null;
  const times = [];
  if (s.plume1Status === "pending") times.push(s.startedAt + END_COLLECT1 * 1000);
  if (s.plume2Status === "pending") times.push(s.startedAt + END_COLLECT2 * 1000);
  if (s.landingConfirmedAt && !s.landingUnlocked) {
    times.push(s.landingConfirmedAt + C.LANDING_SECONDS * 1000);
  }
  return times.length ? Math.min(...times) : null;
}

/** Idempotent: safe to call late, repeatedly, or from several open pages. */
export async function tickOrbiter(group) {
  const s = await getOrbiter(group);
  if (!s?.startedAt) return;

  const now = Date.now();
  const elapsedS = (now - s.startedAt) / 1000;

  if (elapsedS >= END_COLLECT1 && s.plume1Status === "pending") await uploadPlume(group, 1);
  if (elapsedS >= END_COLLECT2 && s.plume2Status === "pending") await uploadPlume(group, 2);

  if (s.landingConfirmedAt && !s.landingUnlocked && now >= s.landingConfirmedAt + C.LANDING_SECONDS * 1000) {
    await unlockGame(group, C.DRILL_GAME_ID);
    await setDoc(orbiterRef(group), { landingUnlocked: true }, { merge: true });
  }

  scheduleTick(group, nextDueMs(await getOrbiter(group)));
}

/** Drill starts the moment landing succeeds. Null until the site is confirmed. */
export function drillStartMs(s) {
  return s?.landingConfirmedAt ? s.landingConfirmedAt + C.LANDING_SECONDS * 1000 : null;
}

/** Subscribes to the orbiter doc. Returns the unsubscribe function. */
export function listenToOrbiter(group, callback) {
  return onSnapshot(orbiterRef(group), (snap) => {
    callback(snap.exists() ? snap.data() : null);
  });
}
