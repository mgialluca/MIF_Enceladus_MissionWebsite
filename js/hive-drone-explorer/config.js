// Configuration constants specific to HIVE's drone-explorer game.
// Time values are rough placeholders — recalculate once real workshop timing is known.
// Access to this game is controlled entirely by the unlock/relock system
// (Firestore missionState/unlocks doc) — there is no in-game time budget or clock.

export const MISSION_CONFIG = {
  // --- Grid dimensions (testing scale) ---
  GRID_X_KM: 10,
  GRID_Y_KM: 10,
  GRID_Z_KM: 40,

  // --- Travel time rates (placeholders, tune freely later) ---
  KM_SCALE_SECONDS_PER_KM: 10,     // simulated seconds per km, for km-leg travel
  M_SCALE_SECONDS_PER_METER: 0.05, // simulated seconds per meter, for m-leg travel
  // Note: crossing 1000m via the m-leg = 50s, vs. 1000m via the km-leg = 10s
  // -> moving finely stays deliberately slower per unit distance, by design

  // --- Collection (dwell) time ---
  COLLECTION_TIME_SECONDS: 15, // constant, every arrival, regardless of location

  // --- Fleet size ---
  DRONE_COUNT: 50
};