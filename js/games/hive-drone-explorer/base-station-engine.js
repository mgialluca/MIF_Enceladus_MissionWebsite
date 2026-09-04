// Base-station engine for HIVE's "advanced data collection" feature.
// One shared doc for the whole HIVE group — a single physical base station
// that can select/prep/analyze exactly one drone's sample at a time. Setup
// fields (selection/filtration/instrument/volume/reagent) persist immediately
// on change; "Analyze Sample" locks them into a currentRun and drives a
// client-side setTimeout, same pattern as drone-engine.js and the WhiteWhale
// tether engine, including catch-up on load.
//
// Firestore doc: groups/HIVE/baseStation/state (see docs/firestore-schema-dronegame.md)

import { db } from "../../firebase-init.js";
import {
  doc, getDoc, setDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { MISSION_CONFIG, scaledBaseStationSeconds } from "./config.js";
import { getDroneSnapshot, applyDroneSampleUpdate, returnDroneToOcean } from "./drone-engine.js";

const GROUP = "HIVE";
const DEPLETED_EPSILON = 0.001;

const FILTRATION_LABELS = MISSION_CONFIG.FILTRATION_OPTIONS.reduce((map, f) => {
  map[f.id] = f.label;
  return map;
}, {});

function baseStationRef() {
  return doc(db, "groups", GROUP, "baseStation", "state");
}

async function getBaseStation() {
  const snap = await getDoc(baseStationRef());
  return snap.exists() ? snap.data() : null;
}

async function saveBaseStation(patch) {
  await setDoc(baseStationRef(), { ...patch, lastUpdated: Date.now() }, { merge: true });
}

function initialBaseStationState() {
  return {
    selectedDroneId: null,
    filtration: null,
    volumeToAnalyzeL: null,
    instrument: null,
    reagent: null,
    stationStatus: "standby",
    currentRun: null,
    statusLog: []
  };
}

// Newest-first, capped to the most recent 20 — matches the scrollable log's display order.
function appendLog(existingLog, message) {
  return [{ message, at: Date.now() }, ...(existingLog || [])].slice(0, 20);
}

// ===================== Timer scheduling =====================

let scheduledTimer = null;

function scheduleTick(atTimestampMs) {
  if (scheduledTimer) { clearTimeout(scheduledTimer); scheduledTimer = null; }
  if (atTimestampMs == null) return;
  const delay = Math.max(0, atTimestampMs - Date.now());
  scheduledTimer = setTimeout(() => { tick().catch(console.error); }, delay);
}

// ===================== Setup actions (persist immediately, no timers) =====================
// All four are no-ops while an analysis is in progress — the whole setup is
// locked until the current run completes.

export async function selectDrone(droneId) {
  const bs = await getBaseStation();
  if (bs?.stationStatus === "analyzing") {
    throw new Error("Cannot change the selected drone while an analysis is running.");
  }
  if (!bs) {
    await saveBaseStation({ ...initialBaseStationState(), selectedDroneId: droneId });
    return;
  }
  await saveBaseStation({ selectedDroneId: droneId });
}

export async function setFiltration(filtration) {
  const bs = await getBaseStation();
  if (bs?.stationStatus === "analyzing") return;
  await saveBaseStation({ filtration: filtration || null });
}

export async function setVolumeToAnalyze(volumeL) {
  const bs = await getBaseStation();
  if (bs?.stationStatus === "analyzing") return;
  await saveBaseStation({ volumeToAnalyzeL: volumeL });
}

export async function setInstrument(instrument) {
  const bs = await getBaseStation();
  if (bs?.stationStatus === "analyzing") return;
  const patch = { instrument: instrument || null };
  if (instrument !== "Incubation") patch.reagent = null;
  await saveBaseStation(patch);
}

export async function setReagent(reagent) {
  const bs = await getBaseStation();
  if (bs?.stationStatus === "analyzing") return;
  await saveBaseStation({ reagent: reagent || null });
}

// ===================== Return to Ocean (callable from the base-station tab) =====================

/**
 * Returns any docked drone to the ocean, from the base-station tab. Blocked
 * only for the drone currently being analyzed; every other docked drone
 * (including the selected-but-not-yet-analyzing one) can be returned anytime.
 */
export async function returnToOcean(droneId) {
  const bs = await getBaseStation();
  if (bs?.stationStatus === "analyzing" && bs.currentRun?.droneId === droneId) {
    throw new Error(`${droneId} is currently being analyzed and cannot be returned yet.`);
  }
  await returnDroneToOcean(GROUP, droneId);
  if (bs?.selectedDroneId === droneId) {
    await saveBaseStation({ selectedDroneId: null });
  }
}

// ===================== Analyze Sample =====================

export async function analyzeSample() {
  const bs = await getBaseStation();
  if (!bs) throw new Error("Base station state not found — ask an admin to reset HIVE.");
  if (bs.stationStatus === "analyzing") throw new Error("An analysis is already running.");
  if (!bs.selectedDroneId) throw new Error("Select a drone first.");
  if (!bs.filtration) throw new Error("Choose a filtration option.");
  if (!bs.instrument) throw new Error("Choose an instrument.");
  if (bs.instrument === "Incubation" && !bs.reagent) throw new Error("Choose a reagent for incubation.");

  const volumeL = Number(bs.volumeToAnalyzeL);
  if (!(volumeL > 0)) throw new Error("Enter a sample volume greater than 0.");

  const drone = await getDroneSnapshot(GROUP, bs.selectedDroneId);
  if (!drone || drone.status !== "docked_to_base" || !drone.sample) {
    throw new Error(`${bs.selectedDroneId} is not currently docked with a sample.`);
  }
  if (volumeL > drone.sample.volumeL + DEPLETED_EPSILON) {
    throw new Error(`Only ${drone.sample.volumeL} L remain in ${bs.selectedDroneId}'s sample.`);
  }

  const now = Date.now();
  const durationSeconds =
    scaledBaseStationSeconds(MISSION_CONFIG.BASE_STATION_INSTRUMENT_SECONDS) +
    (bs.filtration !== "none" ? scaledBaseStationSeconds(MISSION_CONFIG.BASE_STATION_FILTRATION_SECONDS) : 0);

  const currentRun = {
    droneId: bs.selectedDroneId,
    filtration: bs.filtration,
    volumeToAnalyzeL: volumeL,
    instrument: bs.instrument,
    reagent: bs.instrument === "Incubation" ? bs.reagent : null,
    originPosition: drone.sample.originPosition,
    startedAt: now,
    endsAt: now + durationSeconds * 1000
  };

  const filtrationLabel = FILTRATION_LABELS[bs.filtration] || bs.filtration;
  const message =
    `Analyzing Sample: ${bs.instrument} on ${bs.selectedDroneId} — ${volumeL} L, ${filtrationLabel}` +
    (currentRun.reagent ? `, ${currentRun.reagent}` : "");

  await saveBaseStation({
    stationStatus: "analyzing",
    currentRun,
    statusLog: appendLog(bs.statusLog, message)
  });
  scheduleTick(currentRun.endsAt);
}

// ===================== Tick: completes the run in progress =====================

async function tick() {
  const bs = await getBaseStation();
  if (!bs || bs.stationStatus !== "analyzing" || !bs.currentRun) return;

  const now = Date.now();
  if (now < bs.currentRun.endsAt) {
    scheduleTick(bs.currentRun.endsAt);
    return;
  }

  const run = bs.currentRun;
  let log = bs.statusLog || [];

  try {
    const url = MISSION_CONFIG.INSTRUMENT_FUNCTION_URLS[run.instrument];
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        group: GROUP,
        droneId: run.droneId,
        volumeL: run.volumeToAnalyzeL,
        filtration: run.filtration,
        originPosition: run.originPosition,
        ...(run.reagent ? { reagent: run.reagent } : {})
      })
    });
    const rawResponse = await response.text();
    if (!response.ok) throw new Error(`Cloud Function HTTP ${response.status}: ${rawResponse.slice(0, 200)}`);
    const result = JSON.parse(rawResponse);

    log = appendLog(log, `Analyzation complete, results in ${result.filename}`);

    const remaining = await applyDroneSampleUpdate(GROUP, run.droneId, run.volumeToAnalyzeL);
    if (remaining != null && remaining <= DEPLETED_EPSILON) {
      await returnDroneToOcean(GROUP, run.droneId);
      log = appendLog(log, `${run.droneId}: Sample Depleted, Returning to Ocean`);
    }
  } catch (err) {
    console.error(`Base station analysis failed for ${run.droneId}`, err);
    log = appendLog(log, `Analysis failed for ${run.droneId}: ${err.message}`);
  }

  const patch = {
    stationStatus: "standby",
    currentRun: null,
    statusLog: log
  };

  // If the analyzed drone is no longer docked (e.g. depleted -> auto-returned),
  // drop the selection so the UI naturally greys back out.
  const stillDocked = await getDroneSnapshot(GROUP, run.droneId);
  if (bs.selectedDroneId === run.droneId && (!stillDocked || stillDocked.status !== "docked_to_base")) {
    patch.selectedDroneId = null;
  }

  await saveBaseStation(patch);
}

// ===================== Load-time catch-up + live updates =====================

export async function catchUpBaseStation() {
  const bs = await getBaseStation();
  if (!bs || bs.stationStatus !== "analyzing" || !bs.currentRun) return;

  if (Date.now() >= bs.currentRun.endsAt) {
    await tick();
    await catchUpBaseStation();
  } else {
    scheduleTick(bs.currentRun.endsAt);
  }
}

/** Subscribes to live updates for the base station doc. Returns the unsubscribe function. */
export function listenToBaseStation(callback) {
  return onSnapshot(baseStationRef(), (snap) => {
    callback(snap.exists() ? snap.data() : null);
  });
}
