# Firestore Schema Reference

This is documentation only — Firestore is schemaless, so nothing here is
"installed" or uploaded. Collections/documents are created automatically
the first time code writes to them. This file exists purely so every
script touching these paths stays consistent.

## Path: groups/{groupName}/drones/{droneId}
groupName: "HIVE" | "WhiteWhale"
droneId: e.g. "HIVE-01" ... "HIVE-50"

Fields:
- status: "awaiting_command" | "in_route" | "collecting_sample"
- position: { x: <meters>, y: <meters>, z: <meters> }   // current true position
- commandQueue: [
    {
      commandId: <string>,          // unique, for cancel/edit targeting
      destination: { x, y, z },     // user-specified final target (meters)
      legs: [                       // 1-2 legs, from decomposeMove()
        {
          scale: "km" | "m",
          from: { x, y, z },
          to: { x, y, z },
          travelTimeSeconds: <number>,
          startedAt: <timestamp|null>,
          arrivalAt: <timestamp|null>
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