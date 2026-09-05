# Firestore Schema Reference — WhiteWhale Tether Game

Documentation only. Firestore is schemaless; these paths are created the first
time code writes to them. This file keeps every script touching them consistent.

Game code: `js/games/whitewhale-tether/` + `pages/WhiteWhale/Phase1_DeployTether.html`
Cloud Functions: `whale_collect_basic_data_sample`, `whale_filter_sample`,
`whale_analyze_sample_{lcmsms,xrdxrf,epr,gcms,incubation}`, `reset_group` (WhiteWhale branch)

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
    },
    cytometer: {                 // advanced-data-collection hardware, persists across
      status: "operational" | "service_worn" | "broken",  // sessions; only touched by a
      totalVolumeFilteredL: <number>                       // filtration or an admin swap
    }
  } ]
- lastUpdated: <epoch ms> (engine) or serverTimestamp (reset)

Cytometer status/break rules (hidden from players):
  - < CYTOMETER_WEAR_START_L (50) total filtered: "operational".
  - >= 50 and < CYTOMETER_FAIL_AT_L (100): "service_worn"; each new filtration
    request rolls a break chance, evaluated once at "Begin Filtration" against
    the ENDING volume (current total + this request), linear 0%→100% across
    the 50-100L range.
  - Ending volume >= 100: guaranteed break.
  - A broken cytometer never repairs itself — only an admin's
    `swapStationCytometers()` (admin.html) can move a functional one in.

Status flow per station:
  awaiting_depth_assignment
    → (Set Station Depths)        → en_route
    → (reaches assignedDepthM)    → deploying         (STATION_DEPLOYING_SECONDS)
    → (deploy finishes)           → standby
    → (Collect Sample pressed)    → collecting_data   (SAMPLE_COLLECT_SECONDS)
    → (collection finishes)       → standby   + triggers whale_collect_basic_data_sample upload

## Path: groups/WhiteWhale/stationSamples/{stationId}

stationId: "station-1" ... "station-4"

Fields:
- sampleCount: <number>   // atomic counter owned by whale_collect_basic_data_sample;
                          // names files StationN_Sample1.txt, _Sample2.txt, ...

## Path: groups/WhiteWhale/filtrationSamples/{stationId}

Fields:
- sampleCount: <number>   // atomic counter owned by whale_filter_sample; one per station,
                          // shared across every filtration run at that station. Names
                          // StationN_FiltrationM.txt and is passed to every downstream
                          // size-bin analysis as `filtrationNumber` so those files tag
                          // back to the batch: StationN_FiltrationM_{sizeBin}_{Instrument}.txt

## Path: groups/WhiteWhale/advancedStation/state

Single shared doc — one "session" for the whole group; only one station can
hold the power lock (filtering or analyzing) at a time. Written by
`advanced-station-engine.js`, initialized by `reset_group`.

Fields:
- lockedStationId: <string> | null    // which station currently holds the lock
- phase: "idle" | "filtering" | "awaiting_analysis" | "analyzing"
- requestedVolumeL: <number> | null   // this session's filtration volume
- currentFiltrationNumber: <number> | null   // from whale_filter_sample's response
- sizeBinsUsed: [ <sizeBin id>, ... ]  // each size bin may only be analyzed once per sample
- selectedSizeBin: <string> | null
- selectedInstrument: "LCMSMS" | "XRD/XRF" | "EPR" | "GCMS" | "Incubations" | null
- selectedReagent: <string> | null    // only meaningful when instrument === "Incubations"
- currentRun: null | {
    type: "filtration" | "analysis",
    stationId, volumeL, startedAt: <epoch ms>, endsAt: <epoch ms>,
    sizeBin, instrument, reagent   // analysis runs only
  }
- statusLog: [ up to 20 × { message: <string>, at: <epoch ms>|null }, newest first ]
- lastUpdated: <epoch ms> (engine) or serverTimestamp (reset)

Phase flow:
  idle
    → (Begin Filtration, roll succeeds)      → filtering       (volumeL * FILTRATION_SECONDS_PER_L)
    → (filtration finishes, upload fires)    → awaiting_analysis
    → (size bin + instrument + Analyze)      → analyzing       (ANALYSIS_SECONDS)
    → (analysis finishes, upload fires)      → awaiting_analysis (or back to idle if all 5 bins used)
    → (Eject Sample, only while awaiting_analysis) → idle

  A broken roll on "Begin Filtration" never enters "filtering" — the cytometer
  goes straight to "broken" and phase stays "idle" (filtration never happened).
  While phase !== "idle", every station's basic "Collect Sample" is blocked
  too — there's only one tether's worth of power to go around.

## Notes / known limitations

- Timers are client-side (`setTimeout`). Transitions only advance while a tab
  is open; `catchUpTether()` / `catchUpAdvancedStation()` resolve elapsed time
  on load.
- Multiple open tabs each run their own timers. Transitions are status-gated so
  late ticks are harmless no-ops, but an upload call at the end of a phase
  (basic collection, filtration, or analysis) can fire once per open tab.
  Acceptable for a single shared workshop account. The same applies to the
  "Begin Filtration" break roll — it isn't wrapped in a Firestore transaction,
  so two near-simultaneous presses on different stations could race.
