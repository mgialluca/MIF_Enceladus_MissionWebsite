# Firestore Schema Reference — Orbiter View and Drill View

Shared by HIVE and WhiteWhale (one set per group). Code: `js/games/orbiter/`,
`pages/{HIVE,WhiteWhale}/Phase0_OrbiterView.html`, `Phase0_DrillView.html`.
Cloud Function: `orbiter_upload_plume_data`.

## Path: groups/{group}/orbiter/state

- startedAt: <epoch ms> | null   // written when an admin unlocks the Orbiter View; the whole timeline is anchored here
- plume1Status / plume2Status: "pending" | "uploading" | "uploaded" | "error"
- plume1Filename / plume2Filename: <string>   // set on upload
- landingConfirmedAt: <epoch ms> | null       // written when the team confirms a landing site
- landingUnlocked: false | true               // true once the Drill View has been added to the unlock list
- lastUpdated: <epoch ms>

The landing site position itself is not recorded (purely game feedback).

Timeline, in seconds after startedAt:
  0–30    Time to Arrival (circle with "?")
  30–60   Time to First Plume Fly-by
  60–70   Collecting Plume Data  -> upload PlumeFlyby1.dat at 70
  70–100  Time to Second Plume Fly-by
  100–110 Collecting Plume Data  -> upload PlumeFlyby2.dat at 110
  110+    Please Select Landing Site
  confirm +30  Landing Successful; Drill View added to {group}_unlocked

Drill View: starts at landingConfirmedAt + 30 s, descends 5200 m over 30 s, depth rounded to whole metres.

## Unlocks

- Admin unlocks Orbiter View (starts the timeline).
- Landing success adds `drill-view` to `missionState/unlocks.{group}_unlocked`.
- Reset {group} clears `groups/{group}/orbiter/state` and sets `{group}_unlocked` to `[]`, re-locking every page for that group.

## Notes

- Upload triggers are run by any open Orbiter View page once due, claimed with a transaction so each file uploads once. If no page is open at the due time, the next visitor triggers it.
- A status stuck at "uploading" (e.g. a page closed mid-upload) is not retried automatically.
