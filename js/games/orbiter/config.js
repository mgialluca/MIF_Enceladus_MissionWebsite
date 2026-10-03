// Configuration for the Orbiter View and Drill View pages — shared by HIVE and
// WhiteWhale. All timings are raw seconds; edit directly to retune.
//
// Access: the Orbiter View is unlocked by an admin (which also starts its
// timeline). Landing success unlocks the Drill View automatically.

export const ORBITER_CONFIG = {
  ARRIVAL_SECONDS: 30,           // "Time to Arrival"
  FLYBY_SECONDS: 30,             // each "Time to ... Plume Fly-by" countdown
  PLUME_COLLECT_SECONDS: 10,     // "Collecting Plume Data" after each fly-by
  LANDING_SECONDS: 30,           // "Landing in" after the site is confirmed

  DRILL_SECONDS: 30,             // drill view: time to reach the ocean interface
  DRILL_TOTAL_M: 5200,           // total depth, metres

  ORBITER_GAME_ID: "orbiter-view",
  DRILL_GAME_ID: "drill-view",

  PLUME_FILE_NAMES: { 1: "PlumeFlyby1.dat", 2: "PlumeFlyby2.dat" },

  UPLOAD_PLUME_URL:
    "https://us-central1-enceladus-mission-simulation.cloudfunctions.net/orbiter_upload_plume_data"
};
