// Advanced-data-collection engine for WhiteWhale — one shared "session" doc
// for the whole group. Only one station can hold the power lock (filtering or
// analyzing) at a time; every other advanced action AND every station's basic
// "Collect Sample" is blocked while it's held — there's only one tether's
// worth of power to go around.
//
// Firestore doc: groups/WhiteWhale/advancedStation/state
//
// Mirrors HIVE's base-station-engine.js: setup fields (size bin/instrument/
// reagent) persist immediately; "Begin Filtration" / "Analyze Sample" lock
// things into a currentRun and drive a client-side setTimeout, with catch-up
// on load. The tether doc owns each station's `cytometer` wear/status; this
// engine calls into tether-engine.js to read/mutate it.

import { db } from "../../firebase-init.js";
import {
  doc, getDoc, setDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import {
  TETHER_CONFIG, filtrationSeconds, cytometerBreakProbability, cytometerWearStatus, formatDurationShort
} from "./config.js";
import { getTetherSnapshot, updateStationCytometer } from "./tether-engine.js";

const GROUP = "WhiteWhale";
const SIZE_BIN_LABELS = TETHER_CONFIG.SIZE_BINS.reduce((map, b) => {
  map[b.id] = b.label;
  return map;
}, {});

function advancedRef() {
  return doc(db, "groups", GROUP, "advancedStation", "state");
}

async function getAdvanced() {
  const snap = await getDoc(advancedRef());
  return snap.exists() ? snap.data() : null;
}

async function saveAdvanced(patch) {
  await setDoc(advancedRef(), { ...patch, lastUpdated: Date.now() }, { merge: true });
}

function initialAdvancedState() {
  return {
    lockedStationId: null,
    phase: "idle", // "idle" | "filtering" | "awaiting_analysis" | "analyzing"
    requestedVolumeL: null,
    currentFiltrationNumber: null,
    sizeBinsUsed: [],
    selectedSizeBin: null,
    selectedInstrument: null,
    selectedReagent: null,
    currentRun: null,
    statusLog: []
  };
}

function appendLog(existingLog, message) {
  return [{ message, at: Date.now() }, ...(existingLog || [])].slice(0, 20);
}

function findStation(t, stationId) {
  return (t?.stations || []).find((s) => s.id === stationId) || null;
}

// ===================== Timer scheduling =====================

let scheduledTimer = null;

function scheduleTick(atTimestampMs) {
  if (scheduledTimer) { clearTimeout(scheduledTimer); scheduledTimer = null; }
  if (atTimestampMs == null) return;
  const delay = Math.max(0, atTimestampMs - Date.now());
  scheduledTimer = setTimeout(() => { tick().catch(console.error); }, delay);
}

// ===================== Begin Filtration =====================

/**
 * Attempts to begin filtering `volumeL` litres of water at `stationId`.
 * The break-or-not outcome is resolved IMMEDIATELY, before any filtration
 * time passes: a broken roll marks the cytometer broken and returns without
 * claiming the lock (filtration never actually starts); a successful roll
 * claims the lock and starts the timer. Throws a player-facing Error for any
 * setup/validation problem (station not ready, already locked elsewhere, bad
 * volume, etc).
 */
export async function beginFiltration(stationId, volumeL) {
  const adv = await getAdvanced();
  if (adv && adv.phase !== "idle") {
    throw new Error("Advanced data collection is already in progress at another station.");
  }

  const t = await getTetherSnapshot();
  const station = findStation(t, stationId);
  if (!station) throw new Error(`${stationId} not found.`);
  if (station.status !== "standby") {
    throw new Error(`${station.label} is not ready for advanced data collection.`);
  }
  if (station.cytometer?.status === "broken") {
    throw new Error(`${station.label}'s flow cytometer is broken.`);
  }

  const volume = Number(volumeL);
  if (!(volume > 0) || volume > TETHER_CONFIG.MAX_FILTRATION_REQUEST_L) {
    throw new Error(`Enter a volume between 0 and ${TETHER_CONFIG.MAX_FILTRATION_REQUEST_L} L.`);
  }

  const existingLog = adv?.statusLog || [];
  const currentTotal = station.cytometer?.totalVolumeFilteredL || 0;
  const endingVolume = currentTotal + volume;
  const broke = Math.random() < cytometerBreakProbability(endingVolume);

  if (broke) {
    await updateStationCytometer(stationId, { status: "broken" });
    await saveAdvanced({
      ...(adv ? {} : initialAdvancedState()),
      statusLog: appendLog(existingLog, `${station.label}'s flow cytometer has broken while attempting to filter ${volume} L.`)
    });
    return; // no lock claimed — filtration never actually started
  }

  const now = Date.now();
  const durationSeconds = filtrationSeconds(volume);

  await saveAdvanced({
    lockedStationId: stationId,
    phase: "filtering",
    requestedVolumeL: volume,
    currentFiltrationNumber: null,
    sizeBinsUsed: [],
    selectedSizeBin: null,
    selectedInstrument: null,
    selectedReagent: null,
    currentRun: {
      type: "filtration",
      stationId,
      volumeL: volume,
      startedAt: now,
      endsAt: now + durationSeconds * 1000
    },
    statusLog: appendLog(
      existingLog,
      `Filtering ${volume} L of Water from ${station.label}. Time for sample analysis: ${formatDurationShort(durationSeconds)}`
    )
  });
  scheduleTick(now + durationSeconds * 1000);
}

// ===================== Size bin / instrument / reagent setup =====================
// All no-ops outside "awaiting_analysis" — nothing to configure while
// filtering, analyzing, or idle.

export async function selectSizeBin(binId) {
  const adv = await getAdvanced();
  if (!adv || adv.phase !== "awaiting_analysis") return;
  if ((adv.sizeBinsUsed || []).includes(binId)) return;
  await saveAdvanced({ selectedSizeBin: binId });
}

export async function selectInstrument(instrument) {
  const adv = await getAdvanced();
  if (!adv || adv.phase !== "awaiting_analysis") return;
  const patch = { selectedInstrument: instrument };
  if (instrument !== "Incubations") patch.selectedReagent = null;
  await saveAdvanced(patch);
}

export async function selectReagent(reagent) {
  const adv = await getAdvanced();
  if (!adv || adv.phase !== "awaiting_analysis") return;
  await saveAdvanced({ selectedReagent: reagent });
}

// ===================== Analyze Sample =====================

export async function startAnalysis() {
  const adv = await getAdvanced();
  if (!adv || adv.phase !== "awaiting_analysis") {
    throw new Error("No filtered sample is ready for analysis.");
  }
  if (!adv.selectedSizeBin) throw new Error("Select a size bin.");
  if ((adv.sizeBinsUsed || []).includes(adv.selectedSizeBin)) {
    throw new Error("That size bin has already been analyzed for this sample.");
  }
  if (!adv.selectedInstrument) throw new Error("Select an instrument.");
  if (adv.selectedInstrument === "Incubations" && !adv.selectedReagent) {
    throw new Error("Select a reagent for incubation.");
  }

  const t = await getTetherSnapshot();
  const station = findStation(t, adv.lockedStationId);
  if (!station) throw new Error("Station not found.");

  const now = Date.now();
  const durationSeconds = TETHER_CONFIG.ANALYSIS_SECONDS;
  const binLabel = SIZE_BIN_LABELS[adv.selectedSizeBin] || adv.selectedSizeBin;

  await saveAdvanced({
    phase: "analyzing",
    currentRun: {
      type: "analysis",
      stationId: adv.lockedStationId,
      sizeBin: adv.selectedSizeBin,
      instrument: adv.selectedInstrument,
      reagent: adv.selectedInstrument === "Incubations" ? adv.selectedReagent : null,
      volumeL: adv.requestedVolumeL,
      startedAt: now,
      endsAt: now + durationSeconds * 1000
    },
    statusLog: appendLog(
      adv.statusLog,
      `Analyzing ${binLabel} Size bin with ${adv.selectedInstrument} Instrument. Time for sample analysis: ${formatDurationShort(durationSeconds)}`
    )
  });
  scheduleTick(now + durationSeconds * 1000);
}

// ===================== Eject Sample =====================

/**
 * Releases the currently locked station, discarding any not-yet-analyzed
 * size bins, and frees the whole group's advanced tab + basic data
 * collection back up. Only valid while awaiting a fresh analysis request
 * (not mid-filtration or mid-analysis). The confirmation dialog lives in the
 * UI layer, not here.
 */
export async function ejectSample() {
  const adv = await getAdvanced();
  if (!adv || adv.phase !== "awaiting_analysis") return;

  const t = await getTetherSnapshot();
  const station = findStation(t, adv.lockedStationId);
  const label = station?.label || adv.lockedStationId;

  await saveAdvanced({
    lockedStationId: null,
    phase: "idle",
    requestedVolumeL: null,
    currentFiltrationNumber: null,
    sizeBinsUsed: [],
    selectedSizeBin: null,
    selectedInstrument: null,
    selectedReagent: null,
    currentRun: null,
    statusLog: appendLog(adv.statusLog, `${label} ejected. Returning to standby.`)
  });
}

// ===================== Tick: completes filtration or analysis =====================

async function tick() {
  const adv = await getAdvanced();
  if (!adv || !adv.currentRun) return;

  const now = Date.now();
  if (now < adv.currentRun.endsAt) {
    scheduleTick(adv.currentRun.endsAt);
    return;
  }

  const run = adv.currentRun;
  const t = await getTetherSnapshot();
  const station = findStation(t, run.stationId);

  if (run.type === "filtration") {
    let log = adv.statusLog || [];
    try {
      const response = await fetch(TETHER_CONFIG.FILTER_SAMPLE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          group: GROUP,
          stationId: run.stationId,
          stationLabel: station?.label,
          volumeL: run.volumeL,
          depthM: station?.assignedDepthM
        })
      });
      const rawResponse = await response.text();
      if (!response.ok) throw new Error(`Cloud Function HTTP ${response.status}: ${rawResponse.slice(0, 200)}`);
      const result = JSON.parse(rawResponse);

      await saveAdvanced({
        phase: "awaiting_analysis",
        currentFiltrationNumber: result.filtrationNumber,
        currentRun: null,
        statusLog: appendLog(log, "Filtration complete, awaiting sample analysis request")
      });
    } catch (err) {
      console.error(`Filtration upload failed for ${GROUP}/${run.stationId}`, err);
      await saveAdvanced({
        phase: "awaiting_analysis",
        currentRun: null,
        statusLog: appendLog(log, `Filtration data upload failed for ${station?.label || run.stationId}: ${err.message}`)
      });
    }

    // The water was physically filtered regardless of upload success —
    // credit it toward cytometer wear either way.
    const currentTotal = station?.cytometer?.totalVolumeFilteredL || 0;
    const newTotal = currentTotal + run.volumeL;
    await updateStationCytometer(run.stationId, {
      totalVolumeFilteredL: newTotal,
      status: cytometerWearStatus(newTotal)
    });
    return;
  }

  // run.type === "analysis"
  let log = adv.statusLog || [];
  try {
    const url = TETHER_CONFIG.INSTRUMENT_FUNCTION_URLS[run.instrument];
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        group: GROUP,
        stationId: run.stationId,
        stationLabel: station?.label,
        filtrationNumber: adv.currentFiltrationNumber,
        sizeBin: run.sizeBin,
        volumeL: run.volumeL,
        depthM: station?.assignedDepthM,
        ...(run.reagent ? { reagent: run.reagent } : {})
      })
    });
    const rawResponse = await response.text();
    if (!response.ok) throw new Error(`Cloud Function HTTP ${response.status}: ${rawResponse.slice(0, 200)}`);
    const result = JSON.parse(rawResponse);
    log = appendLog(log, `Analysis Complete, see file ${result.filename}`);
  } catch (err) {
    console.error(`Analysis failed for ${GROUP}/${run.stationId}`, err);
    log = appendLog(log, `Analysis failed for ${station?.label || run.stationId}: ${err.message}`);
  }

  const sizeBinsUsed = [...new Set([...(adv.sizeBinsUsed || []), run.sizeBin])];
  const allBinsUsed = sizeBinsUsed.length >= TETHER_CONFIG.SIZE_BINS.length;

  if (allBinsUsed) {
    log = appendLog(log, `All size bins analyzed — ${station?.label || run.stationId} automatically released.`);
    await saveAdvanced({
      lockedStationId: null,
      phase: "idle",
      requestedVolumeL: null,
      currentFiltrationNumber: null,
      sizeBinsUsed: [],
      selectedSizeBin: null,
      selectedInstrument: null,
      selectedReagent: null,
      currentRun: null,
      statusLog: log
    });
  } else {
    await saveAdvanced({
      phase: "awaiting_analysis",
      sizeBinsUsed,
      selectedSizeBin: null,
      selectedInstrument: null,
      selectedReagent: null,
      currentRun: null,
      statusLog: log
    });
  }
}

// ===================== Load-time catch-up + live updates =====================

export async function catchUpAdvancedStation() {
  const adv = await getAdvanced();
  if (!adv || !adv.currentRun) return;

  if (Date.now() >= adv.currentRun.endsAt) {
    await tick();
    await catchUpAdvancedStation();
  } else {
    scheduleTick(adv.currentRun.endsAt);
  }
}

/** Subscribes to live updates for the advanced-station doc. Returns the unsubscribe fn. */
export function listenToAdvancedStation(callback) {
  return onSnapshot(advancedRef(), (snap) => {
    callback(snap.exists() ? snap.data() : null);
  });
}
