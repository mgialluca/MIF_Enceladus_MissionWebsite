// Core state/timer engine for WhiteWhale's tether-deployment game.
//
// Concept mirrors HIVE's drone engine: all game state lives in one Firestore
// document, transitions are driven by client-side setTimeout timers, and a
// catch-up pass on page load resolves any time that elapsed while no tab was
// open. State is shared across all WhiteWhale participants.
//
// Firestore doc: groups/WhiteWhale/tether/state   (see docs/firestore-schema-tethergame.md)
//
// Known limitation (same as HIVE): if several tabs are open at once, each runs
// its own timers. Status transitions are status-gated so a late tick is a
// harmless no-op, but the sample-upload call at the end of "Collecting Data"
// can fire once per open tab. Acceptable for a single shared workshop account.

import { db } from "../../firebase-init.js";
import {
  doc, getDoc, setDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { TETHER_CONFIG, stationTravelSeconds } from "./config.js";

const {
  GROUP, OCEAN_DEPTH_M, STATION_COUNT,
  TETHER_DEPLOY_SECONDS, STATION_DEPLOYING_SECONDS, SAMPLE_COLLECT_SECONDS,
  WHALE_COLLECT_BASIC_DATA_SAMPLE_URL
} = TETHER_CONFIG;

function tetherRef() {
  return doc(db, "groups", GROUP, "tether", "state");
}

async function getTether() {
  const snap = await getDoc(tetherRef());
  return snap.exists() ? snap.data() : null;
}

async function saveTether(patch) {
  // merge:true — note Firestore replaces (does not element-merge) array fields,
  // so every write that changes a station passes the FULL stations array.
  await setDoc(tetherRef(), { ...patch, lastUpdated: Date.now() }, { merge: true });
}

// Keep this shape in sync with reset_whitewhale() in functions/main.py.
export function initialStations() {
  return Array.from({ length: STATION_COUNT }, (_, i) => ({
    id: `station-${i + 1}`,
    label: `Station ${i + 1}`,
    assignedDepthM: null,
    status: "awaiting_depth_assignment",
    travelStartedAt: null,
    arrivalAt: null,
    deployingEndsAt: null,
    collectingEndsAt: null,
    lastCollection: null
  }));
}

export function initialTetherState() {
  return {
    tetherStatus: "not_deployed",
    tetherDeployStartedAt: null,
    tetherDeployedAt: null,
    oceanDepthM: null,
    depthsLocked: false,
    depthsSetAt: null,
    stations: initialStations()
  };
}

// ===================== Timer scheduling =====================

let scheduledTimer = null;

function scheduleTick(atTimestampMs) {
  if (scheduledTimer) { clearTimeout(scheduledTimer); scheduledTimer = null; }
  if (atTimestampMs == null) return;
  const delay = Math.max(0, atTimestampMs - Date.now());
  scheduledTimer = setTimeout(() => { tick().catch(console.error); }, delay);
}

// Earliest future moment at which some state transition is due, or null.
function nextDueMs(t) {
  if (!t) return null;
  const times = [];

  if (t.tetherStatus === "deploying" && t.tetherDeployStartedAt != null) {
    times.push(t.tetherDeployStartedAt + TETHER_DEPLOY_SECONDS * 1000);
  }
  for (const s of t.stations || []) {
    if (s.status === "en_route" && s.arrivalAt != null) times.push(s.arrivalAt);
    if (s.status === "deploying" && s.deployingEndsAt != null) times.push(s.deployingEndsAt);
    if (s.status === "collecting_data" && s.collectingEndsAt != null) times.push(s.collectingEndsAt);
  }

  return times.length ? Math.min(...times) : null;
}

async function reschedule() {
  scheduleTick(nextDueMs(await getTether()));
}

// ===================== The tick =====================

/**
 * Resolves every state transition that is now due. Safe to call late and
 * repeatedly — every transition is status-gated and strictly advances state.
 */
async function tick() {
  const t = await getTether();
  if (!t) return;

  const now = Date.now();
  const patch = {};
  let changed = false;

  // --- Tether finished deploying: reveal the ocean depth ---
  if (t.tetherStatus === "deploying" && t.tetherDeployStartedAt != null) {
    const doneAt = t.tetherDeployStartedAt + TETHER_DEPLOY_SECONDS * 1000;
    if (now >= doneAt) {
      patch.tetherStatus = "deployed";
      patch.tetherDeployedAt = doneAt;
      patch.oceanDepthM = OCEAN_DEPTH_M;
      changed = true;
    }
  }

  // --- Station transitions ---
  const stations = (t.stations || []).map((s) => ({ ...s }));
  const uploads = [];
  let stationsChanged = false;

  for (const s of stations) {
    if (s.status === "en_route" && s.arrivalAt != null && now >= s.arrivalAt) {
      s.status = "deploying";
      s.deployingEndsAt = s.arrivalAt + STATION_DEPLOYING_SECONDS * 1000;
      stationsChanged = true;
    }
    if (s.status === "deploying" && s.deployingEndsAt != null && now >= s.deployingEndsAt) {
      s.status = "standby";
      stationsChanged = true;
    }
    if (s.status === "collecting_data" && s.collectingEndsAt != null && now >= s.collectingEndsAt) {
      s.status = "standby";
      s.collectingEndsAt = null;
      stationsChanged = true;
      uploads.push({ id: s.id, label: s.label, assignedDepthM: s.assignedDepthM });
    }
  }

  if (stationsChanged) { patch.stations = stations; changed = true; }
  if (changed) await saveTether(patch);

  // Fire the data-file upload(s) for any collection that just finished.
  for (const u of uploads) await triggerStationCollection(u);

  await reschedule();
}

// ===================== Player actions =====================

/**
 * Begins deploying the tether. One-time: no-op if already deploying/deployed.
 */
export async function deployTether() {
  const t = await getTether();
  if (t && t.tetherStatus !== "not_deployed") return;

  const now = Date.now();
  const patch = t ? {} : initialTetherState();
  patch.tetherStatus = "deploying";
  patch.tetherDeployStartedAt = now;
  patch.tetherDeployedAt = null;
  patch.oceanDepthM = null;

  await saveTether(patch);
  scheduleTick(now + TETHER_DEPLOY_SECONDS * 1000);
}

/**
 * Locks in all 4 station depths and starts every station travelling.
 * Irreversible. Requires the tether to be fully deployed and every depth
 * to be a number in [0, OCEAN_DEPTH_M] (values past the floor are clamped).
 * Throws Error with a player-facing message on any validation failure.
 */
export async function setStationDepths(rawDepths) {
  const t = await getTether();
  if (!t || t.tetherStatus !== "deployed") {
    throw new Error("The tether has not finished deploying yet.");
  }
  if (t.depthsLocked) {
    throw new Error("Station depths are already set.");
  }
  if (!Array.isArray(rawDepths) || rawDepths.length !== STATION_COUNT) {
    throw new Error(`All ${STATION_COUNT} station depths are required.`);
  }

  const depthsM = rawDepths.map((raw, i) => {
    const n = Number(raw);
    if (raw === "" || raw === null || raw === undefined || Number.isNaN(n)) {
      throw new Error(`Station ${i + 1}: enter a depth in metres.`);
    }
    if (n < 0) throw new Error(`Station ${i + 1}: depth cannot be negative.`);
    return Math.min(Math.round(n), OCEAN_DEPTH_M); // clamp to the sea floor
  });

  const now = Date.now();
  // All stations start travelling at `now`. To switch to one-at-a-time later,
  // stagger `travelStartedAt` here (e.g. add the running total of prior
  // travel+deploy times) and recompute arrivalAt from it.
  const stations = t.stations.map((s, i) => {
    const depthM = depthsM[i];
    return {
      ...s,
      assignedDepthM: depthM,
      status: "en_route",
      travelStartedAt: now,
      arrivalAt: now + stationTravelSeconds(depthM) * 1000,
      deployingEndsAt: null,
      collectingEndsAt: null
    };
  });

  await saveTether({ depthsLocked: true, depthsSetAt: now, stations });
  await reschedule();
}

/**
 * Starts a data collection for one deployed station. No-op unless that
 * station is in "standby". Throws a player-facing Error otherwise.
 */
export async function collectSample(stationId) {
  const t = await getTether();
  if (!t) return;

  const idx = (t.stations || []).findIndex((s) => s.id === stationId);
  if (idx === -1) return;
  if (t.stations[idx].status !== "standby") {
    throw new Error(`${t.stations[idx].label} is not ready to collect a sample.`);
  }

  const now = Date.now();
  const stations = t.stations.map((s, i) =>
    i === idx
      ? { ...s, status: "collecting_data", collectingEndsAt: now + SAMPLE_COLLECT_SECONDS * 1000 }
      : s
  );

  await saveTether({ stations });
  await reschedule();
}

/**
 * Calls the WhiteWhale-only Cloud Function to generate + upload the station's
 * data file. Failures are logged and recorded on the station, not thrown —
 * a missed upload shouldn't strand the station.
 */
async function triggerStationCollection(station) {
  let rawResponse = "";
  try {
    const response = await fetch(WHALE_COLLECT_BASIC_DATA_SAMPLE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        group: GROUP,
        stationId: station.id,
        stationLabel: station.label,
        depthM: station.assignedDepthM
      })
    });
    rawResponse = await response.text();
    if (!response.ok) {
      throw new Error(`Cloud Function HTTP ${response.status}: ${rawResponse.slice(0, 200)}`);
    }
    const result = JSON.parse(rawResponse);
    await patchStation(station.id, {
      lastCollection: {
        status: "success",
        filename: result.filename,
        driveFileId: result.driveFileId,
        sampleNumber: result.sampleNumber,
        collectedAt: Date.now()
      }
    });
  } catch (err) {
    console.error(
      `Station sample collection failed for ${GROUP}/${station.id}`,
      err, "\nRaw response body:", rawResponse
    );
    await patchStation(station.id, {
      lastCollection: {
        status: "error",
        errorMessage: err.message,
        attemptedAt: Date.now()
      }
    });
  }
}

async function patchStation(stationId, fields) {
  const t = await getTether();
  if (!t) return;
  const stations = t.stations.map((s) => (s.id === stationId ? { ...s, ...fields } : s));
  await saveTether({ stations });
}

// ===================== Load-time catch-up + live updates =====================

/**
 * Call once on page load. Ticks repeatedly until all elapsed transitions are
 * resolved, then schedules the next pending one.
 */
export async function catchUpTether() {
  const t = await getTether();
  if (!t) return;

  const due = nextDueMs(t);
  if (due != null && Date.now() >= due) {
    await tick();
    await catchUpTether();
  } else if (due != null) {
    scheduleTick(due);
  }
}

/** Subscribes to live updates for the tether doc. Returns the unsubscribe fn. */
export function listenToTether(callback) {
  return onSnapshot(tetherRef(), (snap) => {
    callback(snap.exists() ? snap.data() : null);
  });
}

// ===================== Pure view helpers (for the visualization) =====================

/** 0..1 progress of the tether growing from the ice interface to the sea floor. */
export function tetherVisualFraction(t, nowMs = Date.now()) {
  if (!t || t.tetherStatus === "not_deployed") return 0;
  if (t.tetherStatus === "deployed") return 1;
  if (t.tetherStatus === "deploying" && t.tetherDeployStartedAt != null) {
    const frac = (nowMs - t.tetherDeployStartedAt) / (TETHER_DEPLOY_SECONDS * 1000);
    return Math.min(Math.max(frac, 0), 1);
  }
  return 0;
}

/**
 * Depth (metres) at which to draw a station's marker right now — interpolated
 * down the tether while "en_route", pinned at its assigned depth once it has
 * arrived. null before depths are assigned.
 */
export function stationVisualDepthM(station, nowMs = Date.now()) {
  if (station.assignedDepthM == null) return null;
  if (station.status === "en_route" && station.travelStartedAt != null && station.arrivalAt != null) {
    const span = station.arrivalAt - station.travelStartedAt;
    const frac = span <= 0 ? 1 : Math.min(Math.max((nowMs - station.travelStartedAt) / span, 0), 1);
    return station.assignedDepthM * frac;
  }
  if (["deploying", "standby", "collecting_data"].includes(station.status)) {
    return station.assignedDepthM;
  }
  return null;
}
