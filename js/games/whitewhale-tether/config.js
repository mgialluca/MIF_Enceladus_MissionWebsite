// Configuration constants specific to WhiteWhale's tether-deployment game.
// Access to this game is controlled entirely by the unlock/relock system
// (Firestore missionState/unlocks doc) — there is no in-game time budget or clock.
//
// All timings are "raw" here — edit the numbers directly to retune the game.
// There is no debug fast-mode toggle for this game (unlike HIVE).

export const TETHER_CONFIG = {
  GROUP: "WhiteWhale",

  // --- True ocean depth (same as HIVE's TRUE_OCEAN_DEPTH_KM = 50) ---
  // Hidden from the player until the tether finishes deploying.
  OCEAN_DEPTH_M: 50000,

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
  MAX_FILTRATION_REQUEST_L: 100,   // single-request cap on the volume input

  // --- Timings: developer speed (edit these raw numbers before a workshop —
  // real values noted alongside, same "no debug toggle" pattern as the rest
  // of this game). ---
  FILTRATION_SECONDS_PER_L: 0.5,   // real: 180 (3 min/L)
  ANALYSIS_SECONDS: 10,            // real: per-instrument, see INSTRUMENT_ANALYSIS_MINUTES

  // Real per-instrument analysis minutes — not used yet (ANALYSIS_SECONDS above
  // is flat for now); kept here so switching to real per-instrument timing
  // later is a one-line change in startAnalysis() in advanced-station-engine.js.
  INSTRUMENT_ANALYSIS_MINUTES: {
    LCMSMS: 5, "XRD/XRF": 2, EPR: 2, GCMS: 4, Incubations: 2
  },

  SIZE_BINS: [
    { id: "lt0.5um", label: "<0.5 µm" },
    { id: "0.5-1um", label: "0.5 - 1 µm" },
    { id: "1-5um", label: "1 - 5 µm" },
    { id: "5-10um", label: "5 - 10 µm" },
    { id: "10-20um", label: "10 - 20 µm" }
  ],

  INSTRUMENTS: ["LCMSMS", "XRD/XRF", "EPR", "GCMS", "Incubations"],

  REAGENTS: ["14C-formate", "14C-acetate", "14C-D-glycine", "14C-L-glycine"],

  FILTER_SAMPLE_URL:
    "https://us-central1-enceladus-mission-simulation.cloudfunctions.net/whale_filter_sample",

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

// Filtration time (seconds) for a given volume.
export function filtrationSeconds(volumeL) {
  return volumeL * TETHER_CONFIG.FILTRATION_SECONDS_PER_L;
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
