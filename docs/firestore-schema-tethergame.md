# Firestore Schema Reference — WhiteWhale Tether Game

Documentation only. Firestore is schemaless; these paths are created the first
time code writes to them. This file keeps every script touching them consistent.

Game code: `js/games/whitewhale-tether/` + `pages/WhiteWhale/Phase1_DeployTether.html`
Cloud Functions: `whale_collect_basic_data_sample`, `whale_flow_cytometer_sample`, `whale_facs_sample`,
`whale_analyze_sample_{lcmsms,xrdxrf,epr,gcms,incubation}`, `reset_group` (WhiteWhale branch)

Every data file this game uploads (basic collection, Flow Cytometer, FACS, and
each instrument analysis) is prefixed with the same `#`-comment metadata
block: Mission, Instrument, X/Y/Z (m), Water Volume (mL), Sample Type
("bulk" | "size bin" | "dissolved"), and Method File (always the literal
string "method file" for now). See `_build_file_header()` in `functions/main.py`.
WhiteWhale's station x,y is the tether's own confirmed drop location
(`tetherX`/`tetherY` on the tether state doc below) — every Cloud Function
call reads it from there. It's chosen once, before anything else in this
game, on the "Seafloor Scan" tab (see that section below).

## Path: groups/WhiteWhale/tether/state

Single document holding all shared game state. Written by the client engine
(`tether-engine.js`) and initialized by `reset_group` / first `deployTether`.

Fields:
- scanStartedAt: <epoch ms> | null    // Seafloor Scan reveal timer start — see below
- tetherX: <meters> | null            // confirmed on the Seafloor Scan tab; null until then
- tetherY: <meters> | null
- tetherLocationConfirmedAt: <epoch ms> | null   // set once; irreversible short of a reset
- tetherStatus: "not_deployed" | "deploying" | "deployed"
- tetherDeployStartedAt: <epoch ms> | null
- tetherDeployedAt: <epoch ms> | null
- oceanDepthM: null  → real terrain depth at (tetherX, tetherY) once the tether
    reaches the floor (depthAt() in js/games/shared/seafloor-model.js) — NOT a
    flat 50000; varies with the chosen drop location
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

### Seafloor Scan tab (first page tab, before Basic Data Collection)

Every image in `assets/seafloor/` (including `scan.webp`) shares the same
terrain and vent catalogue as the HIVE drone's hazard model, so a click here
lands on the exact same (x, y) convention `depthAt()`/`hazardAt()` use.

- `scanStartedAt` is set the moment an admin unlocks the `deploy-tether`
  page (`startSeafloorScan()`, called from both `admin.html`'s unlock click
  — same pattern as `startOrbiterTimeline` — and defensively on every
  `catchUpTether()`, so a mid-session "Reset WhiteWhale" restarts the scan
  the next time anyone has the page open, with no separate unlock event to
  do it). Idempotent: a no-op once already set.
- The page renders `scan.webp` (the real multibeam-style render of the
  website's own seafloor terrain — see `enceladus_MIF/seafloor/
  plot_seafloor_multibeam.py`) behind a mask that shrinks left-to-right over
  `SCAN_DURATION_SECONDS`, via `scanProgress(tether, now)`. The player can
  click anywhere on the image at any time, even mid-reveal, to place a
  (non-persisted) red X; `confirmTetherLocation(x, y)` is the only thing
  that actually writes `tetherX`/`tetherY`/`tetherLocationConfirmedAt`, and
  only once — a second call throws.
- The "Basic Data Collection & Site Selection" tab (and `deployTether()`
  itself) stay disabled/rejected until `tetherLocationConfirmedAt` is set.

## Path: groups/WhiteWhale/stationSamples/{stationId}

stationId: "station-1" ... "station-4"

Fields:
- sampleCount: <number>   // atomic counter owned by whale_collect_basic_data_sample;
                          // names files StationN_Sample1.txt, _Sample2.txt, ...

## Path: groups/WhiteWhale/filtrationSamples/{stationId}

Fields:
- sampleCount: <number>   // atomic counter owned by whale_flow_cytometer_sample; one per
                          // station, claimed once per filtration run (shared by that run's
                          // Flow Cytometer file, FACS file, and every downstream analysis).
                          // Names StationN_FiltrationM_FlowCytometer.csv /
                          // StationN_FiltrationM_FACS.csv /
                          // StationN_FiltrationM_{sizeBins}_{Instrument}.txt

## Path: groups/WhiteWhale/advancedStation/state

Single shared doc — one "session" for the whole group; only one station can
hold the power lock at a time (Flow Cytometer pass, FACS sorting, or
analyzing). Written by `advanced-station-engine.js`, initialized by `reset_group`.

Fields:
- lockedStationId: <string> | null    // which station currently holds the lock
- phase: "idle" | "flow_cytometer" | "facs_sorting" | "awaiting_analysis" | "analyzing"
- requestedVolumeL: <number> | null   // this session's TOTAL requested filtration volume
- currentFiltrationNumber: <number> | null   // from whale_flow_cytometer_sample's response;
                                              // reused by the FACS call and every analysis call
- facsBinTotals: { [sizeBinId]: <number> } | null  // from whale_facs_sample; shown on the
                                                    // size-bin buttons once FACS finishes
- sizeBinsUsed: [ <sizeBin id>, ... ]  // each of the 7 items may only be analyzed once per sample
- selectedSizeBins: [ <sizeBin id>, ... ]  // multi-select — combine several into one analysis
- selectedInstrument: "LCMSMS" | "XRD/XRF" | "EPR" | "GCMS" | "Incubations" | null
- selectedReagent: <string> | null    // only meaningful when instrument === "Incubations"
- currentRun: null | {
    type: "flow_cytometer" | "facs_sorting" | "analysis",
    stationId, startedAt: <epoch ms>, endsAt: <epoch ms>,
    volumeL,                        // flow_cytometer / analysis runs
    sizeBins, instrument, reagent   // analysis runs only
  }
- statusLog: [ up to 20 × { message: <string>, at: <epoch ms>|null }, newest first ]
- lastUpdated: <epoch ms> (engine) or serverTimestamp (reset)

Phase flow:
  idle
    → (Begin Filtration, roll succeeds)        → flow_cytometer  (FLOW_CYTOMETER_SECONDS, fixed)
    → (FC finishes, upload fires)              → facs_sorting    ((volumeL - 1 mL) * FACS_SECONDS_PER_L)
    → (FACS finishes, upload fires)            → awaiting_analysis
    → (size bin(s) + instrument + Analyze)     → analyzing       (ANALYSIS_SECONDS)
    → (analysis finishes, upload fires)        → awaiting_analysis (or idle if all 7 items used)
    → (Eject Sample, only while awaiting_analysis) → idle

  A broken roll on "Begin Filtration" never enters "flow_cytometer" — the
  cytometer goes straight to "broken" and phase stays "idle" (filtration
  never happened). While phase !== "idle", every station's basic "Collect
  Sample" is blocked too — there's only one tether's worth of power to go
  around. Cytometer wear is credited once, for the FULL requested volume,
  when the FACS stage finishes (Flow Cytometer and FACS count as the same
  instrument for wear purposes).

  "Dissolved Water Fraction" is one of the 7 selectable items in
  selectedSizeBins/sizeBinsUsed; it never appears in facsBinTotals (no
  particle count applies to it).

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
