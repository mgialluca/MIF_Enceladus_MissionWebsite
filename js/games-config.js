// Master list of games/pages per group.
// To add a new game later: just add a new object to the relevant array.
// "id" must be unique within a group and is what gets stored in Firestore's unlock array.
// "file" is the actual filename inside that group's pages/ folder.

export const GAMES_CONFIG = {
  HIVE: [
    //{ id: "dashboard", title: "Mission Dashboard", file: "dashboard.html" },
    // Example of adding a new game later:
    // { id: "signal-decode", title: "Signal Decode", file: "signal-decode.html" },
    { id: "operate-drones", title: "Drone Release and Movement", file: "Phase1_ReleaseDrones.html" },
  ],
  WhiteWhale: [
    //{ id: "dashboard", title: "Mission Dashboard", file: "dashboard.html" }
    // { id: "sonar-mapping", title: "Sonar Mapping", file: "sonar-mapping.html" },
  ]
};