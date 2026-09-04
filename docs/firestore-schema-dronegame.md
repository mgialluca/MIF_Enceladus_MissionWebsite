# Firestore Schema Reference

This is documentation only — Firestore is schemaless, so nothing here is
"installed" or uploaded. Collections/documents are created automatically
the first time code writes to them. This file exists purely so every
script touching these paths stays consistent.

## Path: groups/{groupName}/drones/{droneId}
groupName: "HIVE" | "WhiteWhale"
droneId: e.g. "HIVE-01" ... "HIVE-50"

Fields:
- status: "awaiting_command" | "in_route" | "collecting_sample" | "destroyed" | "docked_to_base"
- position: { x: <meters>, y: <meters>, z: <meters> }   // current true position
- sample: null | {
    volumeL: <number>,             // starts at SAMPLE_VOLUME_L (10), depletes as the base station analyzes it
    originPosition: { x, y, z },   // where the water was drawn from when "Return Sample" was pressed
    collectedAt: <epoch ms>
  }
  // Set by returnSample(); travels with the drone through its return trip and
  // while docked_to_base. Cleared (null) on cancel, destruction, or "Return to Ocean".
- hazardWarning: null | {
    active: true,
    issuedAt: <epoch ms>,
    impactAt: <epoch ms>,
    distanceBeforeImpactM: 5,
    hazardType: "floor" | "vent",
    hazardId: <string>,
    label: <string>,
    impactPoint: { x, y, z }
  }
- destructionPoint: { x, y, z } | null
- destruction: null | {
    cause: "floor" | "vent",
    hazardId: <string>,
    label: <string>,
    point: { x, y, z },
    destroyedAt: <epoch ms>,
    legScale: "km" | "m",
    commandId: <string>
  }
- commandQueue: [
    {
      commandId: <string>,          // unique, for cancel/edit targeting
      type: "collect" | "return_sample",  // return_sample: no collection dwell/upload on arrival; docks instead
      destination: { x, y, z },     // user-specified final target (meters); (0,0,0) for return_sample
      legs: [                       // 1-2 legs, from decomposeMove()
        {
          scale: "km" | "m",
          from: { x, y, z },
          to: { x, y, z },
          travelTimeSeconds: <number>,
          startedAt: <timestamp|null>,
          arrivalAt: <timestamp|null>,
          collision: null | {
            type: "floor" | "vent",
            hazardId: <string>,
            label: <string>,
            t: <0-1 segment fraction>,
            point: { x, y, z },
            distanceFromStartM: <number>
          },
          warningAt: null | {
            t: <0-1 segment fraction>,
            distanceBeforeImpactM: 5,
            point: { x, y, z }
          },
          warningIssued: <boolean|null>
        }
      ],
      currentLegIndex: 0,
      collectionEndsAt: <timestamp|null>   // set once final leg arrives
    }
  ]
- lastUpdated: <timestamp>

## Path: groups/{groupName}/boxVisits/{boxId}
boxId: "X{x}_Y{y}_Z{z}" (meters, e.g. "X7500_Y5000_Z39500")

Fields:
- visitCount: <number>   // used by Cloud Function to name files _V2, _V3, etc.

## Path: groups/HIVE/baseStation/state
HIVE-only. Single shared doc — one physical base station for the whole group;
it can select/prep/analyze exactly one drone's sample at a time. Written by
`js/games/hive-drone-explorer/base-station-engine.js`.

Fields:
- selectedDroneId: <string> | null
- filtration: "none" | "0.5um" | "1um" | "5um" | "10um" | "20um" | null
- volumeToAnalyzeL: <number> | null
- instrument: "CE-LIF" | "CE-C4D" | "GCMS" | "FC" | "Microscope" | "Incubation" | null
- reagent: <string> | null   // only meaningful when instrument === "Incubation"
- stationStatus: "standby" | "analyzing"
- currentRun: null | {
    droneId, filtration, volumeToAnalyzeL, instrument, reagent,
    originPosition: { x, y, z },
    startedAt: <epoch ms>, endsAt: <epoch ms>
  }
- statusLog: [ up to 20 × { message: <string>, at: <epoch ms>|null }, newest first ]
- lastUpdated: <epoch ms>

## Path: groups/HIVE/analysisSamples/{droneId}
HIVE-only. Atomic counter, one per drone, shared across all 6 instruments —
names analysis files `{droneId}_Analysis{N}_{Instrument}.txt`.

Fields:
- sampleCount: <number>
