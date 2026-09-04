// Configuration constants specific to HIVE's drone-explorer game.
// Access to this game is controlled entirely by the unlock/relock system
// (Firestore missionState/unlocks doc) — there is no in-game time budget or clock.

export const MISSION_CONFIG = {
  // --- Grid dimensions (finalized production scale) ---
  GRID_X_KM: 10,
  GRID_Y_KM: 10,
  TRUE_OCEAN_DEPTH_KM: 50,
  DISPLAY_Z_KM: 70,
  DRONE_DEPTH_RATING_KM: 70,

  // --- Real drone speeds ---
  KM_JUMP_SPEED_M_PER_S: 5,      // 5 meters/second during km-scale legs
  M_JUMP_SPEED_M_PER_MIN: 1,     // 1 meter/minute during m-scale legs

  // --- Collection (dwell) time ---
  COLLECTION_TIME_SECONDS: 300,  // 5 minutes, constant, every arrival

  // --- Fleet size ---
  DRONE_COUNT: 50,

  // --- Hazards ---
  ENABLE_FLOOR_COLLISIONS: true,
  ENABLE_VENT_COLLISIONS: true,
  ENABLE_METER_JUMP_WARNINGS: true,
  IMPACT_WARNING_DISTANCE_M: 5,
  VENTS: [
    {
      id: "vent-01",
      label: "Hydrothermal Vent 01",
      center: { x: 0, y: 0 },
      footprintXM: 2,
      footprintYM: 2,
      heightM: 100
    }
  ],

  // --- Return-sample trips ---
  SAMPLE_VOLUME_L: 10,               // volume a drone carries per "Return Sample"
  RETURN_TRIP_SPEED_MULTIPLIER: 1,   // multiplies return-leg travel time; uses the same DEBUG_FAST_MODE scaling as normal moves

  // --- Base station: advanced data collection ---
  // Its own debug time scale, independent of DEBUG_FAST_MODE above — testing
  // wants "1 real minute = 10 seconds" specifically for this feature.
  BASE_STATION_INSTRUMENT_SECONDS: 60,
  BASE_STATION_FILTRATION_SECONDS: 60, // additional, only if filtration !== "none"
  BASE_STATION_DEBUG_FAST_MODE: true,
  BASE_STATION_DEBUG_TIME_SCALE: 10 / 60,

  FILTRATION_OPTIONS: [
    { id: "none", label: "No Filtration" },
    { id: "0.5um", label: "0.5 µm" },
    { id: "1um", label: "1 µm" },
    { id: "5um", label: "5 µm" },
    { id: "10um", label: "10 µm" },
    { id: "20um", label: "20 µm" }
  ],

  INSTRUMENTS: ["CE-LIF", "CE-C4D", "GCMS", "FC", "Microscope", "Incubation"],

  REAGENTS: ["14C-formate", "14C-acetate", "14C-D-glycine", "14C-L-glycine"],

  // One Cloud Function per instrument — see functions/main.py.
  INSTRUMENT_FUNCTION_URLS: {
    "CE-LIF": "https://us-central1-enceladus-mission-simulation.cloudfunctions.net/hive_analyze_sample_celif",
    "CE-C4D": "https://us-central1-enceladus-mission-simulation.cloudfunctions.net/hive_analyze_sample_cec4d",
    "GCMS": "https://us-central1-enceladus-mission-simulation.cloudfunctions.net/hive_analyze_sample_gcms",
    "FC": "https://us-central1-enceladus-mission-simulation.cloudfunctions.net/hive_analyze_sample_fc",
    "Microscope": "https://us-central1-enceladus-mission-simulation.cloudfunctions.net/hive_analyze_sample_microscope",
    "Incubation": "https://us-central1-enceladus-mission-simulation.cloudfunctions.net/hive_analyze_sample_incubation"
  },

  // --- Testing helper: speeds everything up during development. ---
  // Set DEBUG_FAST_MODE to false before a real workshop session.
  DEBUG_FAST_MODE: true,
  DEBUG_TIME_SCALE: 0.002 // 0.0002 = all real-world timings run 5000x faster
};

// Applies the fast-mode scale factor (if enabled) to any real-seconds value.
export function scaledSeconds(realSeconds) {
  return MISSION_CONFIG.DEBUG_FAST_MODE
    ? realSeconds * MISSION_CONFIG.DEBUG_TIME_SCALE
    : realSeconds;
}

// Separate scale for base-station analysis timings (see BASE_STATION_* above).
export function scaledBaseStationSeconds(realSeconds) {
  return MISSION_CONFIG.BASE_STATION_DEBUG_FAST_MODE
    ? realSeconds * MISSION_CONFIG.BASE_STATION_DEBUG_TIME_SCALE
    : realSeconds;
}
