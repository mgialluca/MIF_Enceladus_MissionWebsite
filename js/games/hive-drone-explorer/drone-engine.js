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

  const command = {
    commandId: crypto.randomUUID(),
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
  const legs = decomposeMove(drone.position, command.destination).map(enrichLegWithHazards);

  if (legs.length === 0) {
    // Destination equals current position — treat as instant arrival.
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
    destruction
  });
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

    // Collection complete. Stage 4 will trigger the real Cloud Function
    // call here, using command.destination as the box coordinates.
    console.log(`[placeholder] Would collect data at`, command.destination, `for ${group}/${droneId}`);

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
  await saveDrone(group, droneId, {
    position: stoppedPosition,
    hazardWarning: null,
    commandQueue: remainingQueue
  });
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
