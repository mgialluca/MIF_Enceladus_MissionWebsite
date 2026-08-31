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

  // --- Cloud Function (separate from HIVE's collect_sample) ---
  COLLECT_STATION_SAMPLE_URL:
    "https://us-central1-enceladus-mission-simulation.cloudfunctions.net/collect_station_sample"
};

// Travel time (seconds) for a station heading to `depthM` metres below the ice.
export function stationTravelSeconds(depthM) {
  return (depthM / 1000) * TETHER_CONFIG.STATION_TRAVEL_SECONDS_PER_KM;
}
