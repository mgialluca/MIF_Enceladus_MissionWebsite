# Firestore Schema Reference — WhiteWhale Tether Game

Documentation only. Firestore is schemaless; these paths are created the first
time code writes to them. This file keeps every script touching them consistent.

Game code: `js/games/whitewhale-tether/` + `pages/WhiteWhale/Phase1_DeployTether.html`
Cloud Functions: `collect_station_sample`, `reset_group` (WhiteWhale branch)

## Path: groups/WhiteWhale/tether/state

Single document holding all shared game state. Written by the client engine
(`tether-engine.js`) and initialized by `reset_group` / first `deployTether`.

Fields:
- tetherStatus: "not_deployed" | "deploying" | "deployed"
- tetherDeployStartedAt: <epoch ms> | null
- tetherDeployedAt: <epoch ms> | null
- oceanDepthM: null  → 50000 once the tether reaches the floor
- depthsLocked: false | true          // true after "Set Station Depths" (irreversible)
- depthsSetAt: <epoch ms> | null
- stations: [ 4 × {
    id: "station-1" ... "station-4",
    label: "Station 1" ... "Station 4",
    assignedDepthM: <meters> | null,
    status: "awaiting_depth_assignment" | "en_route" | "deploying"
          | "standby" | "collecting_data",
    travelStartedAt: <epoch ms> | null,
    arrivalAt: <epoch ms> | null,        // travel = (assignedDepthM/1000) * STATION_TRAVEL_SECONDS_PER_KM
    deployingEndsAt: <epoch ms> | null,  // arrivalAt + STATION_DEPLOYING_SECONDS
    collectingEndsAt: <epoch ms> | null, // set while status === "collecting_data"
    lastCollection: null | {
      status: "success" | "error",
      filename: <string>,        // success
      driveFileId: <string>,     // success
      sampleNumber: <number>,    // success
      collectedAt: <epoch ms>,   // success
      errorMessage: <string>,    // error
      attemptedAt: <epoch ms>    // error
    }
  } ]
- lastUpdated: <epoch ms> (engine) or serverTimestamp (reset)

Status flow per station:
  awaiting_depth_assignment
    → (Set Station Depths)        → en_route
    → (reaches assignedDepthM)    → deploying         (STATION_DEPLOYING_SECONDS)
    → (deploy finishes)           → standby
    → (Collect Sample pressed)    → collecting_data   (SAMPLE_COLLECT_SECONDS)
    → (collection finishes)       → standby   + triggers collect_station_sample upload

## Path: groups/WhiteWhale/stationSamples/{stationId}

stationId: "station-1" ... "station-4"

Fields:
- sampleCount: <number>   // atomic counter owned by collect_station_sample;
                          // names files StationN_Sample1.txt, _Sample2.txt, ...

## Notes / known limitations

- Timers are client-side (`setTimeout`). Transitions only advance while a tab
  is open; `catchUpTether()` resolves elapsed time on load.
- Multiple open tabs each run their own timers. Transitions are status-gated so
  late ticks are harmless no-ops, but the `collect_station_sample` upload at the
  end of "collecting_data" can fire once per open tab. Acceptable for a single
  shared workshop account.
