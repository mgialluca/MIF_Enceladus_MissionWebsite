// Hardcoded username -> role/group map used by auth.js to determine access after login

const USERS = {
  "ADMIN": {
    role: "admin",
    group: null,
    passcode: "meganisgreat",
    displayName: "Mission Simulation Team"
  },
  "HIVE": {
    role: "participant",
    group: "HIVE",
    passcode: "hive2026",
    displayName: "HIVE Mission Control"
  },
  "WHITEWHALE": {
    role: "participant",
    group: "WhiteWhale",
    passcode: "whale2026",
    displayName: "White Whale Mission Control"
  }
};