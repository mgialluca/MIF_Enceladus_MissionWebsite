// Hardcoded username -> role/group map used by auth.js to determine access after login
const USERS = {
  "Admin": { role: "admin", group: null, passcode: "meganisgreat" },
  "HIVEMissionControl": { role: "participant", group: "HIVE", passcode: "hive2026" },
  "WWMissionControl": { role: "participant", group: "WhiteWhale", passcode: "whale2026" }
};