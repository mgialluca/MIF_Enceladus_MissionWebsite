// Core movement/queue engine for HIVE's drone-explorer game.
// Handles issuing commands, processing the queue over time, cancellation,
// editing, and catch-up after a closed browser tab reopens.
//
// Stage 3b adds hazard warnings and destroyed-drone handling.

import { db } from "../../firebase-init.js";
import {
  doc, getDoc, setDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { MISSION_CONFIG, scaledSeconds } from "./config.js";
import {
  decomposeMove, interpolateLegPosition, clampToBounds, roundToMeter
} from "./grid-math.js";
import {
  collisionTimeMs, enrichLegWithHazards, warningTimeMs
} from "./hazards.js";

function droneRef(group, droneId) {
  return doc(db, "groups", group, "drones", droneId);
}

async function getDrone(group, droneId) {
  const snap = await getDoc(droneRef(group, droneId));
  return snap.exists() ? snap.data() : null;
}

async function saveDrone(group, droneId, data) {
  await setDoc(droneRef(group, droneId), { ...data, lastUpdated: Date.now() }, { merge: true });
}

// Tracks pending setTimeout handles per drone, so re-scheduling doesn't stack up duplicates.
const scheduledTimers = {};

const HIVE_COLLECT_BASIC_DATA_SAMPLE_URL = "https://us-central1-enceladus-mission-simulation.cloudfunctions.net/hive_collect_basic_data_sample";

function scheduleTick(group, droneId, atTimestampMs) {
  const key = `${group}/${droneId}`;
  if (scheduledTimers[key]) clearTimeout(scheduledTimers[key]);
  const delay = Math.max(0, atTimestampMs - Date.now());
  scheduledTimers[key] = setTimeout(() => tick(group, droneId), delay);
}

function nextDueTimestamp(command) {
  if (command.state === "active") {
    const leg = command.legs[command.currentLegIndex];
    const warningAt = warningTimeMs(leg);
    if (leg.scale === "m" && warningAt && !leg.warningIssued) return warningAt;
    return collisionTimeMs(leg) || leg.arrivalAt;
  }

  return command.collectionEndsAt;
}

/**
 * Issues a new destination command for a drone. Appends to the queue;
 * if the drone was idle, activates it immediately.
 */
export async function issueCommand(group, droneId, destination) {
  const drone = await getDrone(group, droneId);
  if (!drone) throw new Error(`Drone ${droneId} not found`);
  if (drone.status === "destroyed") return; // no-op, drone is gone
  if (drone.status === "docked_to_base") {
    throw new Error(`${droneId} is docked at the base station and cannot accept new commands.`);
  }

  const command = {
    commandId: crypto.randomUUID(),
    type: "collect",
    destination: clampToBounds({
      x: roundToMeter(destination.x),
      y: roundToMeter(destination.y),
      z: roundToMeter(destination.z)
    }),
    legs: null,
    currentLegIndex: 0,
    collectionEndsAt: null,
    hazardWarning: null,
    state: "queued"
  };

  const queue = [...(drone.commandQueue || []), command];
  await saveDrone(group, droneId, { commandQueue: queue });

  if (queue.length === 1) {
    await activateFrontCommand(group, droneId);
  }
}

/**
 * Activates the front command in the queue, computing its legs fresh from
 * the drone's CURRENT actual position — never precomputed ahead of time.
 */
async function activateFrontCommand(group, droneId) {
  const drone = await getDrone(group, droneId);
  if (!drone || drone.status === "destroyed") return;

  const queue = drone.commandQueue || [];
  if (queue.length === 0) {
    await saveDrone(group, droneId, { status: "awaiting_command" });
    return;
  }

  const command = { ...queue[0] };
  let legs = decomposeMove(drone.position, command.destination).map(enrichLegWithHazards);
  if (command.type === "return_sample" && MISSION_CONFIG.RETURN_TRIP_SPEED_MULTIPLIER !== 1) {
    legs = legs.map((leg) => ({
      ...leg,
      travelTimeSeconds: leg.travelTimeSeconds * MISSION_CONFIG.RETURN_TRIP_SPEED_MULTIPLIER
    }));
  }

  if (legs.length === 0) {
    // Destination equals current position — treat as instant arrival.
    if (command.type === "return_sample") {
      await saveDrone(group, droneId, { status: "docked_to_base", commandQueue: [] });
      return;
    }
    command.legs = [];
    command.state = "collecting";
    command.collectionEndsAt = Date.now() + scaledSeconds(MISSION_CONFIG.COLLECTION_TIME_SECONDS) * 1000;
    const newQueue = [command, ...queue.slice(1)];
    await saveDrone(group, droneId, { status: "collecting_sample", commandQueue: newQueue });
    scheduleTick(group, droneId, command.collectionEndsAt);
    return;
  }

  legs[0].startedAt = Date.now();
  legs[0].arrivalAt = legs[0].startedAt + legs[0].travelTimeSeconds * 1000;
  command.legs = legs;
  command.currentLegIndex = 0;
  command.state = "active";

  const newQueue = [command, ...queue.slice(1)];
  await saveDrone(group, droneId, { status: "in_route", commandQueue: newQueue });
  scheduleTick(group, droneId, nextDueTimestamp(command));
}

async function destroyDrone(group, droneId, command, leg, now, collision) {
  const destructionPoint = collision.point;
  const destruction = {
    cause: collision.type,
    hazardId: collision.hazardId,
    label: collision.label,
    point: destructionPoint,
    destroyedAt: now,
    legScale: leg.scale,
    commandId: command.commandId
  };

  await saveDrone(group, droneId, {
    status: "destroyed",
    position: destructionPoint,
    commandQueue: [],
    hazardWarning: null,
    destructionPoint,
    destruction,
    sample: null
  });
}

/**
 * Calls the hive_collect_basic_data_sample Cloud Function to generate and upload a data
 * file for the box the drone just arrived at. Failures are logged but
 * don't block gameplay from proceeding — a missed upload here shouldn't
 * strand a drone. The result (success or failure) is recorded on the
 * drone document so a future UI can surface it.
 */
async function triggerDataCollection(group, droneId, boxCoordinates) {
  try {
    const response = await fetch(HIVE_COLLECT_BASIC_DATA_SAMPLE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        group,
        x: boxCoordinates.x,
        y: boxCoordinates.y,
        z: boxCoordinates.z
      })
    });

    if (!response.ok) {
      throw new Error(`Cloud Function responded with status ${response.status}`);
    }

    const result = await response.json();
    await saveDrone(group, droneId, {
      lastCollection: {
        status: "success",
        filename: result.filename,
        driveFileId: result.driveFileId,
        collectedAt: Date.now(),
        box: boxCoordinates
      }
    });
  } catch (err) {
    console.error(`Data collection failed for ${group}/${droneId} at`, boxCoordinates, err);
    await saveDrone(group, droneId, {
      lastCollection: {
        status: "error",
        errorMessage: err.message,
        attemptedAt: Date.now(),
        box: boxCoordinates
      }
    });
  }
}

/**
 * Runs when a scheduled timer fires (leg arrival or collection end).
 * Must be safe to call "late" — this is also reused directly by catch-up.
 */
async function tick(group, droneId) {
  const drone = await getDrone(group, droneId);
  if (!drone || drone.status === "destroyed") return;

  const queue = drone.commandQueue || [];
  if (queue.length === 0) return;

  const command = { ...queue[0] };
  const now = Date.now();

  if (command.state === "active") {
    const leg = command.legs[command.currentLegIndex];

    const warningAt = warningTimeMs(leg);
    if (leg.scale === "m" && warningAt && !leg.warningIssued && now >= warningAt) {
      leg.warningIssued = true;
      command.hazardWarning = {
        active: true,
        issuedAt: now,
        impactAt: collisionTimeMs(leg),
        distanceBeforeImpactM: leg.warningAt.distanceBeforeImpactM,
        hazardType: leg.collision.type,
        hazardId: leg.collision.hazardId,
        label: leg.collision.label,
        impactPoint: leg.collision.point
      };

      const newQueue = [command, ...queue.slice(1)];
      await saveDrone(group, droneId, {
        hazardWarning: command.hazardWarning,
        commandQueue: newQueue
      });
      scheduleTick(group, droneId, collisionTimeMs(leg));
      return;
    }

    const impactAt = collisionTimeMs(leg);
    if (impactAt && now >= impactAt) {
      await destroyDrone(group, droneId, command, leg, now, leg.collision);
      return;
    }

    if (now < leg.arrivalAt) {
      scheduleTick(group, droneId, nextDueTimestamp(command));
      return;
    }

    const newPosition = leg.to; // exact, already meter-rounded by decomposeMove

    if (command.currentLegIndex + 1 < command.legs.length) {
      command.currentLegIndex += 1;
      const nextLeg = command.legs[command.currentLegIndex];
      nextLeg.startedAt = now;
      nextLeg.arrivalAt = now + nextLeg.travelTimeSeconds * 1000;
      const newQueue = [command, ...queue.slice(1)];
      await saveDrone(group, droneId, {
        position: newPosition,
        hazardWarning: null,
        commandQueue: newQueue
      });
      scheduleTick(group, droneId, nextDueTimestamp(command));
    } else if (command.type === "return_sample") {
      // Home — dock immediately, no collection dwell or basic-data upload.
      await saveDrone(group, droneId, {
        position: newPosition,
        status: "docked_to_base",
        hazardWarning: null,
        commandQueue: []
      });
    } else {
      command.state = "collecting";
      command.hazardWarning = null;
      command.collectionEndsAt = now + scaledSeconds(MISSION_CONFIG.COLLECTION_TIME_SECONDS) * 1000;
      const newQueue = [command, ...queue.slice(1)];
      await saveDrone(group, droneId, {
        position: newPosition,
        status: "collecting_sample",
        hazardWarning: null,
        commandQueue: newQueue
      });
      scheduleTick(group, droneId, command.collectionEndsAt);
    }
    return;
  }

  if (command.state === "collecting") {
    if (now < command.collectionEndsAt) {
      scheduleTick(group, droneId, command.collectionEndsAt);
      return;
    }

    // Collection complete — trigger the real data-generation/upload pipeline.
    await triggerDataCollection(group, droneId, command.destination);

    const remainingQueue = queue.slice(1);
    await saveDrone(group, droneId, { commandQueue: remainingQueue });
    await activateFrontCommand(group, droneId);
  }
}

/**
 * Cancels the currently active (in-transit) command only. Drone stops at
 * its true interpolated position, rounded to the nearest meter. No data is
 * collected. Immediately advances to the next queued command, if any.
 * No-op if the drone isn't currently in transit.
 */
export async function cancelActiveCommand(group, droneId) {
  const drone = await getDrone(group, droneId);
  if (!drone) return;

  const queue = drone.commandQueue || [];
  if (queue.length === 0) return;

  const command = queue[0];
  if (command.state !== "active") return;

  const leg = command.legs[command.currentLegIndex];
  const stoppedPosition = interpolateLegPosition(leg, Date.now());

  const remainingQueue = queue.slice(1);
  const patch = {
    position: stoppedPosition,
    hazardWarning: null,
    commandQueue: remainingQueue
  };
  if (command.type === "return_sample") {
    // Canceling a return trip loses the sample it was carrying.
    patch.sample = null;
  }
  await saveDrone(group, droneId, patch);
  await activateFrontCommand(group, droneId);
}

/**
 * Removes a not-yet-started queued command (anything except the active
 * front command) by its commandId.
 */
export async function removeQueuedCommand(group, droneId, commandId) {
  const drone = await getDrone(group, droneId);
  if (!drone) return;

  const queue = drone.commandQueue || [];
  const newQueue = queue.filter((cmd, idx) => !(idx > 0 && cmd.commandId === commandId));
  await saveDrone(group, droneId, { commandQueue: newQueue });
}

/**
 * Edits the destination of a not-yet-started queued command (index > 0).
 * The active command (index 0) can't be edited this way — cancel it instead.
 */
export async function editQueuedCommand(group, droneId, commandId, newDestination) {
  const drone = await getDrone(group, droneId);
  if (!drone) return;

  const queue = drone.commandQueue || [];
  const newQueue = queue.map((cmd, idx) => {
    if (idx > 0 && cmd.commandId === commandId) {
      return {
        ...cmd,
        destination: clampToBounds({
          x: roundToMeter(newDestination.x),
          y: roundToMeter(newDestination.y),
          z: roundToMeter(newDestination.z)
        })
      };
    }
    return cmd;
  });
  await saveDrone(group, droneId, { commandQueue: newQueue });
}

/**
 * Sends a drone that's currently idle back to base (0,0,0) carrying a
 * SAMPLE_VOLUME_L water sample drawn from wherever it is right now. Uses the
 * same decomposeMove/hazard pipeline as any other move, scaled by
 * RETURN_TRIP_SPEED_MULTIPLIER. On arrival the drone becomes "docked_to_base"
 * immediately — no collection dwell, no basic-data upload.
 */
export async function returnSample(group, droneId) {
  const drone = await getDrone(group, droneId);
  if (!drone) throw new Error(`Drone ${droneId} not found`);
  if (drone.status !== "awaiting_command") {
    throw new Error(`${droneId} must be awaiting command to return a sample.`);
  }
  if (drone.sample) {
    throw new Error(`${droneId} is already carrying a sample.`);
  }

  const sample = {
    volumeL: MISSION_CONFIG.SAMPLE_VOLUME_L,
    originPosition: { ...drone.position },
    collectedAt: Date.now()
  };

  const command = {
    commandId: crypto.randomUUID(),
    type: "return_sample",
    destination: { x: 0, y: 0, z: 0 },
    legs: null,
    currentLegIndex: 0,
    collectionEndsAt: null,
    hazardWarning: null,
    state: "queued"
  };

  await saveDrone(group, droneId, { sample, commandQueue: [command] });
  await activateFrontCommand(group, droneId);
}

/**
 * Returns a docked drone to the ocean: clears its sample, resets it to
 * (0,0,0)/awaiting_command. No-op if the drone isn't actually docked.
 */
export async function returnDroneToOcean(group, droneId) {
  const drone = await getDrone(group, droneId);
  if (!drone || drone.status !== "docked_to_base") return;

  await saveDrone(group, droneId, {
    status: "awaiting_command",
    position: { x: 0, y: 0, z: 0 },
    sample: null,
    commandQueue: []
  });
}

/** Thin exported wrapper so other engines (base-station-engine.js) can read a drone once. */
export async function getDroneSnapshot(group, droneId) {
  return getDrone(group, droneId);
}

/**
 * Deducts `consumedVolumeL` from a docked drone's sample after a base-station
 * analysis run completes. Returns the new remaining volume, or null if the
 * drone has no sample (e.g. it was already returned).
 */
export async function applyDroneSampleUpdate(group, droneId, consumedVolumeL) {
  const drone = await getDrone(group, droneId);
  if (!drone || !drone.sample) return null;

  const remaining = Math.max(0, Math.round((drone.sample.volumeL - consumedVolumeL) * 1000) / 1000);
  await saveDrone(group, droneId, { sample: { ...drone.sample, volumeL: remaining } });
  return remaining;
}

/**
 * Call once when a dashboard/test page loads. Resolves any elapsed time
 * that passed while no tab was open — ticking repeatedly until fully
 * caught up to the present (multiple full commands may complete at once).
 */
export async function catchUpDrone(group, droneId) {
  const drone = await getDrone(group, droneId);
  if (!drone || drone.status === "destroyed") return;

  const queue = drone.commandQueue || [];
  if (queue.length === 0) return;

  const command = queue[0];
  const now = Date.now();
  const dueTimestamp = nextDueTimestamp(command);

  if (dueTimestamp && now >= dueTimestamp) {
    await tick(group, droneId);
    await catchUpDrone(group, droneId); // keep resolving until caught up
  } else if (dueTimestamp) {
    scheduleTick(group, droneId, dueTimestamp);
  }
}

/**
 * Subscribes to live updates for a single drone. Returns the unsubscribe function.
 */
export function listenToDrone(group, droneId, callback) {
  return onSnapshot(droneRef(group, droneId), (snap) => {
    callback(snap.exists() ? snap.data() : null);
  });
}
