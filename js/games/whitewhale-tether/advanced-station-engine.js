// Advanced-data-collection engine for WhiteWhale — one shared "session" doc
// for the whole group. Only one station can hold the power lock at a time
// (flow-cytometer pass, FACS sorting, or analyzing); every other advanced
// action AND every station's basic "Collect Sample" is blocked while it's
// held — there's only one tether's worth of power to go around.
//
// Firestore doc: groups/WhiteWhale/advancedStation/state
//
// Every filtration run is two stages: a fixed-length Flow Cytometer pass on
// the first 1 mL (the real per-event science model, uploaded and available
// in Drive as soon as that stage ends), then FACS on whatever volume is left
// (bin totals only — becomes the numbers shown on the size-bin buttons).
// Mirrors HIVE's base-station-engine.js otherwise: setup fields (size
// bins/instrument/reagent) persist immediately; "Analyze Sample" locks them
// into a currentRun and drives a client-side setTimeout, with catch-up on
// load. The tether doc owns each station's `cytometer` wear/status; this
// engine calls into tether-engine.js to read/mutate it.

import { db } from "../../firebase-init.js";
import {
  doc, getDoc, setDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import {
  TETHER_CONFIG, facsSeconds, cytometerBreakProbability, cytometerWearStatus, formatDurationShort
} from "./config.js";
import { getTetherSnapshot, updateStationCytometer } from "./tether-engine.js";

const GROUP = "WhiteWhale";
const SIZE_BIN_LABELS = TETHER_CONFIG.SIZE_BINS.reduce((map, b) => {
  map[b.id] = b.label;
  return map;
}, {});

// WhiteWhale's station x,y isn't chosen by players yet — every Cloud
// Function call uses this placeholder until that feature exists. (0,0) also
// happens to sit inside a real vent field's influence, so deep stations
// already read as Hydrothermal Hotspot today — see sort_particles_flow_cytometer.py.
const PLACEHOLDER_X_M = 0;
const PLACEHOLDER_Y_M = 0;

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
    // "idle" | "flow_cytometer" | "facs_sorting" | "awaiting_analysis" | "analyzing"
    phase: "idle",
    requestedVolumeL: null,
    currentFiltrationNumber: null,
    facsBinTotals: null,       // { [sizeBinId]: count } — shown on the bin buttons once FACS finishes
    sizeBinsUsed: [],
    selectedSizeBins: [],      // multi-select: combine several bins into one analysis
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
 * claims the lock and starts the Flow Cytometer stage. Throws a player-facing
 * Error for any setup/validation problem (station not ready, already locked
 * elsewhere, bad volume, etc).
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
  const { MIN_FILTRATION_REQUEST_L: MIN_L, MAX_FILTRATION_REQUEST_L: MAX_L } = TETHER_CONFIG;
  if (!(volume >= MIN_L) || volume > MAX_L) {
    throw new Error(`Enter a volume between ${MIN_L * 1000} mL and ${MAX_L} L.`);
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
  const fcDurationSeconds = TETHER_CONFIG.FLOW_CYTOMETER_SECONDS;

  await saveAdvanced({
    lockedStationId: stationId,
    phase: "flow_cytometer",
    requestedVolumeL: volume,
    currentFiltrationNumber: null,
    facsBinTotals: null,
    sizeBinsUsed: [],
    selectedSizeBins: [],
    selectedInstrument: null,
    selectedReagent: null,
    currentRun: {
      type: "flow_cytometer",
      stationId,
      volumeL: volume,
      startedAt: now,
      endsAt: now + fcDurationSeconds * 1000
    },
    statusLog: appendLog(
      existingLog,
      `Filtering ${volume} L of Water from ${station.label} — sorting first 1 mL through Flow Cytometer. ` +
      `Time for sample analysis: ${formatDurationShort(fcDurationSeconds)}`
    )
  });
  scheduleTick(now + fcDurationSeconds * 1000);
}

// ===================== Size bin / instrument / reagent setup =====================
// All no-ops outside "awaiting_analysis" — nothing to configure while
// filtering, analyzing, or idle.

/** Toggles one size bin (or "dissolved") in the multi-select set. */
export async function selectSizeBin(binId) {
  const adv = await getAdvanced();
  if (!adv || adv.phase !== "awaiting_analysis") return;
  if ((adv.sizeBinsUsed || []).includes(binId)) return;

  const selected = adv.selectedSizeBins || [];
  const nextSelected = selected.includes(binId)
    ? selected.filter((b) => b !== binId)
    : [...selected, binId];
  await saveAdvanced({ selectedSizeBins: nextSelected });
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
  const selectedBins = adv.selectedSizeBins || [];
  if (selectedBins.length === 0) throw new Error("Select at least one size bin.");
  const usedSet = new Set(adv.sizeBinsUsed || []);
  if (selectedBins.some((b) => usedSet.has(b))) {
    throw new Error("One of the selected bins has already been analyzed for this sample.");
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
  const binLabels = selectedBins.map((b) => SIZE_BIN_LABELS[b] || b).join(", ");
  const binWord = selectedBins.length > 1 ? "Size Bins" : "Size Bin";

  await saveAdvanced({
    phase: "analyzing",
    currentRun: {
      type: "analysis",
      stationId: adv.lockedStationId,
      sizeBins: selectedBins,
      instrument: adv.selectedInstrument,
      reagent: adv.selectedInstrument === "Incubations" ? adv.selectedReagent : null,
      volumeL: adv.requestedVolumeL,
      startedAt: now,
      endsAt: now + durationSeconds * 1000
    },
    statusLog: appendLog(
      adv.statusLog,
      `Analyzing ${binLabels} ${binWord} with ${adv.selectedInstrument} Instrument. Time for sample analysis: ${formatDurationShort(durationSeconds)}`
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
    facsBinTotals: null,
    sizeBinsUsed: [],
    selectedSizeBins: [],
    selectedInstrument: null,
    selectedReagent: null,
    currentRun: null,
    statusLog: appendLog(adv.statusLog, `${label} ejected. Returning to standby.`)
  });
}

// ===================== Tick: completes each stage in turn =====================

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

  if (run.type === "flow_cytometer") {
    await finishFlowCytometer(adv, run, station);
    return;
  }
  if (run.type === "facs_sorting") {
    await finishFacsSorting(adv, run, station);
    return;
  }
  await finishAnalysis(adv, run, station);
}

async function finishFlowCytometer(adv, run, station) {
  let log = adv.statusLog || [];
  let filtrationNumber = null;

  try {
    const response = await fetch(TETHER_CONFIG.FLOW_CYTOMETER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        group: GROUP,
        stationId: run.stationId,
        stationLabel: station?.label,
        depthM: station?.assignedDepthM,
        xM: PLACEHOLDER_X_M,
        yM: PLACEHOLDER_Y_M
      })
    });
    const rawResponse = await response.text();
    if (!response.ok) throw new Error(`Cloud Function HTTP ${response.status}: ${rawResponse.slice(0, 200)}`);
    const result = JSON.parse(rawResponse);
    filtrationNumber = result.filtrationNumber;
    log = appendLog(log, `Flow Cytometer data available, see file ${result.filename}`);
  } catch (err) {
    console.error(`Flow Cytometer upload failed for ${GROUP}/${run.stationId}`, err);
    log = appendLog(log, `Flow Cytometer data upload failed for ${station?.label || run.stationId}: ${err.message}`);
  }

  // The Flow Cytometer only ever handles the first 1 mL — whatever's left of
  // the requested volume goes through FACS next (0 if exactly 1 mL was
  // requested; that stage still runs, just near-instantly).
  const remainingL = Math.max(0, run.volumeL - TETHER_CONFIG.MIN_FILTRATION_REQUEST_L);
  const now = Date.now();
  const facsDurationSeconds = facsSeconds(remainingL);

  await saveAdvanced({
    phase: "facs_sorting",
    currentFiltrationNumber: filtrationNumber,
    currentRun: {
      type: "facs_sorting",
      stationId: run.stationId,
      startedAt: now,
      endsAt: now + facsDurationSeconds * 1000
    },
    statusLog: appendLog(
      log,
      `Sorting remaining ${remainingL.toFixed(3)} L through FACS. Time for sample analysis: ${formatDurationShort(facsDurationSeconds)}`
    )
  });
  scheduleTick(now + facsDurationSeconds * 1000);
}

async function finishFacsSorting(adv, run, station) {
  let log = adv.statusLog || [];
  let binTotals = null;

  try {
    const response = await fetch(TETHER_CONFIG.FACS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        group: GROUP,
        stationId: run.stationId,
        stationLabel: station?.label,
        filtrationNumber: adv.currentFiltrationNumber,
        totalVolumeMl: adv.requestedVolumeL * 1000,
        depthM: station?.assignedDepthM,
        xM: PLACEHOLDER_X_M,
        yM: PLACEHOLDER_Y_M
      })
    });
    const rawResponse = await response.text();
    if (!response.ok) throw new Error(`Cloud Function HTTP ${response.status}: ${rawResponse.slice(0, 200)}`);
    const result = JSON.parse(rawResponse);
    binTotals = result.binTotals;
    log = appendLog(log, `FACS sorting complete, see file ${result.filename}`);
  } catch (err) {
    console.error(`FACS upload failed for ${GROUP}/${run.stationId}`, err);
    log = appendLog(log, `FACS data upload failed for ${station?.label || run.stationId}: ${err.message}`);
  }
  log = appendLog(log, "Filtration complete, awaiting sample analysis request");

  // The water was physically filtered regardless of upload success — credit
  // the FULL requested volume toward cytometer wear either way. Flow
  // Cytometer and FACS are two modes of the same instrument, so this is the
  // one place the whole run's volume gets credited.
  const currentTotal = station?.cytometer?.totalVolumeFilteredL || 0;
  const newTotal = currentTotal + (adv.requestedVolumeL || 0);
  await updateStationCytometer(run.stationId, {
    totalVolumeFilteredL: newTotal,
    status: cytometerWearStatus(newTotal)
  });

  await saveAdvanced({
    phase: "awaiting_analysis",
    facsBinTotals: binTotals,
    currentRun: null,
    statusLog: log
  });
}

async function finishAnalysis(adv, run, station) {
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
        sizeBins: run.sizeBins,
        volumeL: run.volumeL,
        depthM: station?.assignedDepthM,
        xM: PLACEHOLDER_X_M,
        yM: PLACEHOLDER_Y_M,
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

  const sizeBinsUsed = [...new Set([...(adv.sizeBinsUsed || []), ...run.sizeBins])];
  const allBinsUsed = sizeBinsUsed.length >= TETHER_CONFIG.SIZE_BINS.length;

  if (allBinsUsed) {
    log = appendLog(log, `All size bins analyzed — ${station?.label || run.stationId} automatically released.`);
    await saveAdvanced({
      lockedStationId: null,
      phase: "idle",
      requestedVolumeL: null,
      currentFiltrationNumber: null,
      facsBinTotals: null,
      sizeBinsUsed: [],
      selectedSizeBins: [],
      selectedInstrument: null,
      selectedReagent: null,
      currentRun: null,
      statusLog: log
    });
  } else {
    await saveAdvanced({
      phase: "awaiting_analysis",
      sizeBinsUsed,
      selectedSizeBins: [],
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
