// Configuration constants specific to WhiteWhale's tether-deployment game.
// Access to this game is controlled entirely by the unlock/relock system
// (Firestore missionState/unlocks doc) — there is no in-game time budget or clock.
//
// All timings are "raw" here — edit the numbers directly to retune the game.
// There is no debug fast-mode toggle for this game (unlike HIVE).

export const TETHER_CONFIG = {
  GROUP: "WhiteWhale",
  TETHER_GAME_ID: "deploy-tether",

  // --- True ocean depth (same as HIVE's TRUE_OCEAN_DEPTH_KM = 50) ---
  // Hidden from the player until the tether finishes deploying.
  OCEAN_DEPTH_M: 50000,

  // --- Seafloor scan (first tab, before any station work) ---
  // Starts the moment an admin unlocks this page (see admin.html), same
  // pattern as ORBITER_CONFIG. Left-to-right reveal of assets/seafloor/
  // scan.webp; the player can click to place the tether's x,y at any time,
  // even mid-reveal. real value TBD — 20s is a placeholder for now.
  SCAN_DURATION_SECONDS: 20,

  // --- Fleet ---
  STATION_COUNT: 4,

  // --- Timings (seconds) ---
  TETHER_DEPLOY_SECONDS: 20,          // tether -> sea floor
  STATION_TRAVEL_SECONDS_PER_KM: 1,   // travel time = (assignedDepthM / 1000) * this
  STATION_DEPLOYING_SECONDS: 10,      // "Deploying" phase once a station reaches its depth
  SAMPLE_COLLECT_SECONDS: 10,         // "Collecting Data" phase per Collect Sample press

  // --- Cloud Function (separate from HIVE's hive_collect_basic_data_sample) ---
  WHALE_COLLECT_BASIC_DATA_SAMPLE_URL:
    "https://us-central1-enceladus-mission-simulation.cloudfunctions.net/whale_collect_basic_data_sample",

  // --- Advanced data collection: flow cytometer wear/failure ---
  // Hidden from players — cumulative volume filtered per station, tracked on
  // each station's `cytometer` field. Below WEAR_START_L: "Operational"/green.
  // WEAR_START_L..FAIL_AT_L: "Service-worn"/orange, break chance ramps 0%->100%
  // linearly against the ENDING volume (current total + this request). At or
  // above FAIL_AT_L: guaranteed break.
  CYTOMETER_WEAR_START_L: 50,
  CYTOMETER_FAIL_AT_L: 100,
  MIN_FILTRATION_REQUEST_L: 0.001,  // 1 mL — the Flow Cytometer's fixed first pass
  MAX_FILTRATION_REQUEST_L: 10,     // single-request cap on the volume input

  // --- Timings: developer speed (edit these raw numbers before a workshop —
  // real values noted alongside, same "no debug toggle" pattern as the rest
  // of this game). ---
  // Every filtration run is two stages: a fixed-length Flow Cytometer pass on
  // the first 1 mL, then FACS on whatever's left (0 if exactly 1 mL was
  // requested — the stage still runs, just near-instantly).
  FLOW_CYTOMETER_SECONDS: 10,      // fixed, regardless of total requested volume
  FACS_SECONDS_PER_L: 0.5,         // real: 180 (3 min/L) — applies only to the volume AFTER the first 1 mL
  ANALYSIS_SECONDS: 10,            // real: per-instrument, see INSTRUMENT_ANALYSIS_MINUTES

  // Real per-instrument analysis minutes — not used yet (ANALYSIS_SECONDS above
  // is flat for now); kept here so switching to real per-instrument timing
  // later is a one-line change in startAnalysis() in advanced-station-engine.js.
  INSTRUMENT_ANALYSIS_MINUTES: {
    LCMSMS: 5, "XRD/XRF": 2, EPR: 2, GCMS: 4, Incubations: 2
  },

  // Seven selectable items in the Size Bin window: six particle bins plus
  // "Dissolved Water Fraction" — always available, never shows a count.
  // `id` is this website's own identifier (filename/attribute-safe — no "<").
  // `particleBin` is the literal key sort_particles_flow_cytometer.py uses in
  // its SIZE_BIN_NAMES / facsBinTotals — look counts up by THAT, not `id`.
  // Every bin but the first happens to share the same string for both, which
  // is exactly what let this one go unnoticed.
  SIZE_BINS: [
    { id: "lt0.5um", label: "<0.5 µm", particleBin: "<0.5um" },
    { id: "0.5-1um", label: "0.5 - 1 µm", particleBin: "0.5-1um" },
    { id: "1-5um", label: "1 - 5 µm", particleBin: "1-5um" },
    { id: "5-10um", label: "5 - 10 µm", particleBin: "5-10um" },
    { id: "10-20um", label: "10 - 20 µm", particleBin: "10-20um" },
    { id: "20-40um", label: "20 - 40 µm", particleBin: "20-40um" },
    { id: "dissolved", label: "Dissolved Water Fraction", particleBin: null }
  ],

  INSTRUMENTS: ["LCMSMS", "XRD/XRF", "EPR", "GCMS", "Incubations"],

  REAGENTS: ["14C-formate", "14C-acetate", "14C-D-glycine", "14C-L-glycine"],

  FLOW_CYTOMETER_URL:
    "https://us-central1-enceladus-mission-simulation.cloudfunctions.net/whale_flow_cytometer_sample",
  FACS_URL:
    "https://us-central1-enceladus-mission-simulation.cloudfunctions.net/whale_facs_sample",

  // One Cloud Function per instrument — see functions/main.py.
  INSTRUMENT_FUNCTION_URLS: {
    "LCMSMS": "https://us-central1-enceladus-mission-simulation.cloudfunctions.net/whale_analyze_sample_lcmsms",
    "XRD/XRF": "https://us-central1-enceladus-mission-simulation.cloudfunctions.net/whale_analyze_sample_xrdxrf",
    "EPR": "https://us-central1-enceladus-mission-simulation.cloudfunctions.net/whale_analyze_sample_epr",
    "GCMS": "https://us-central1-enceladus-mission-simulation.cloudfunctions.net/whale_analyze_sample_gcms",
    "Incubations": "https://us-central1-enceladus-mission-simulation.cloudfunctions.net/whale_analyze_sample_incubation"
  }
};

// Travel time (seconds) for a station heading to `depthM` metres below the ice.
export function stationTravelSeconds(depthM) {
  return (depthM / 1000) * TETHER_CONFIG.STATION_TRAVEL_SECONDS_PER_KM;
}

// FACS sorting time (seconds) for a given volume — the volume remaining
// after the Flow Cytometer's fixed first-1-mL pass.
export function facsSeconds(remainingVolumeL) {
  return remainingVolumeL * TETHER_CONFIG.FACS_SECONDS_PER_L;
}

/**
 * Linear break probability (0..1) for a filtration request, evaluated against
 * the ENDING cumulative volume (current total + this request) — so a request
 * that would push the total at/over CYTOMETER_FAIL_AT_L is a guaranteed break.
 */
export function cytometerBreakProbability(endingVolumeL) {
  const { CYTOMETER_WEAR_START_L, CYTOMETER_FAIL_AT_L } = TETHER_CONFIG;
  if (endingVolumeL <= CYTOMETER_WEAR_START_L) return 0;
  if (endingVolumeL >= CYTOMETER_FAIL_AT_L) return 1;
  return (endingVolumeL - CYTOMETER_WEAR_START_L) / (CYTOMETER_FAIL_AT_L - CYTOMETER_WEAR_START_L);
}

/** "operational" | "service_worn" for a non-broken cytometer at this cumulative volume. */
export function cytometerWearStatus(totalVolumeFilteredL) {
  return totalVolumeFilteredL >= TETHER_CONFIG.CYTOMETER_WEAR_START_L ? "service_worn" : "operational";
}

// Short "12s" / "2m" / "2m 5s" formatting for status-log time estimates.
export function formatDurationShort(totalSeconds) {
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}
