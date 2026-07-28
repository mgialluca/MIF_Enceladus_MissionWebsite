// Configuration constants specific to HIVE's drone-explorer game.
// Access to this game is controlled entirely by the unlock/relock system
// (Firestore missionState/unlocks doc) — there is no in-game time budget or clock.

export const MISSION_CONFIG = {
  // --- Grid dimensions (finalized production scale) ---
  GRID_X_KM: 10,
  GRID_Y_KM: 10,
  GRID_Z_KM: 50,

  // --- Real drone speeds ---
  KM_JUMP_SPEED_M_PER_S: 5,      // 5 meters/second during km-scale legs
  M_JUMP_SPEED_M_PER_MIN: 1,     // 1 meter/minute during m-scale legs

  // --- Collection (dwell) time ---
  COLLECTION_TIME_SECONDS: 300,  // 5 minutes, constant, every arrival

  // --- Fleet size ---
  DRONE_COUNT: 50,

  // --- Testing helper: speeds everything up during development. ---
  // Set DEBUG_FAST_MODE to false before a real workshop session.
  DEBUG_FAST_MODE: true,
  DEBUG_TIME_SCALE: 0.0002 // 0.02 = all real-world timings run 50x faster
};

// Applies the fast-mode scale factor (if enabled) to any real-seconds value.
export function scaledSeconds(realSeconds) {
  return MISSION_CONFIG.DEBUG_FAST_MODE
    ? realSeconds * MISSION_CONFIG.DEBUG_TIME_SCALE
    : realSeconds;
}