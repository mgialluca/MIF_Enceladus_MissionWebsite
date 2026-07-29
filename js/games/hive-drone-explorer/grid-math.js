// Pure grid/coordinate logic for HIVE's drone-explorer game.
// No Firestore, no DOM — fully unit-testable in isolation.

import { MISSION_CONFIG, scaledSeconds } from "./config.js";

export const BOUNDS_M = {
  xMin: -(MISSION_CONFIG.GRID_X_KM * 1000) / 2,
  xMax: (MISSION_CONFIG.GRID_X_KM * 1000) / 2,
  yMin: -(MISSION_CONFIG.GRID_Y_KM * 1000) / 2,
  yMax: (MISSION_CONFIG.GRID_Y_KM * 1000) / 2,
  zMin: 0,
  zMax: MISSION_CONFIG.DRONE_DEPTH_RATING_KM * 1000
};

export function roundToMeter(value) {
  return Math.round(value);
}

export function clampToBounds(pos) {
  return {
    x: Math.min(Math.max(BOUNDS_M.xMin, pos.x), BOUNDS_M.xMax),
    y: Math.min(Math.max(BOUNDS_M.yMin, pos.y), BOUNDS_M.yMax),
    z: Math.min(Math.max(BOUNDS_M.zMin, pos.z), BOUNDS_M.zMax)
  };
}

export function distanceMeters(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function computeLegTime(a, b, scale) {
  const dist = distanceMeters(a, b);
  const realSeconds = scale === "km"
    ? dist / MISSION_CONFIG.KM_JUMP_SPEED_M_PER_S
    : dist * (60 / MISSION_CONFIG.M_JUMP_SPEED_M_PER_MIN);
  return scaledSeconds(realSeconds);
}

/**
 * Decomposes a move from `current` to `destination` into up to two ordered legs:
 * 1. A "km" leg — the largest whole-km displacement (per axis) toward the destination
 * 2. An "m" leg — whatever meter-scale remainder is left to reach the exact destination
 * Returns 0, 1, or 2 legs (0 only if destination === current).
 * Each leg's travelTimeSeconds already reflects DEBUG_FAST_MODE if enabled.
 */
export function decomposeMove(current, destination) {
  const dest = clampToBounds({
    x: roundToMeter(destination.x),
    y: roundToMeter(destination.y),
    z: roundToMeter(destination.z)
  });

  const kmIntermediate = { x: 0, y: 0, z: 0 };
  ["x", "y", "z"].forEach((axis) => {
    const delta = dest[axis] - current[axis];
    const wholeKmMeters = Math.trunc(delta / 1000) * 1000;
    kmIntermediate[axis] = current[axis] + wholeKmMeters;
  });

  const legs = [];

  if (distanceMeters(current, kmIntermediate) > 0) {
    legs.push({
      scale: "km",
      from: { ...current },
      to: { ...kmIntermediate },
      travelTimeSeconds: computeLegTime(current, kmIntermediate, "km"),
      startedAt: null,
      arrivalAt: null
    });
  }

  if (distanceMeters(kmIntermediate, dest) > 0) {
    legs.push({
      scale: "m",
      from: { ...kmIntermediate },
      to: { ...dest },
      travelTimeSeconds: computeLegTime(kmIntermediate, dest, "m"),
      startedAt: null,
      arrivalAt: null
    });
  }

  return legs;
}

/**
 * Given an active leg (with from/to/travelTimeSeconds/startedAt already set)
 * and the current time (epoch ms), computes the drone's true interpolated
 * position — rounded to the nearest whole meter on each axis.
 */
export function interpolateLegPosition(leg, nowMs) {
  const elapsedSeconds = (nowMs - leg.startedAt) / 1000;
  const fraction = Math.min(Math.max(elapsedSeconds / leg.travelTimeSeconds, 0), 1);

  const raw = {
    x: leg.from.x + (leg.to.x - leg.from.x) * fraction,
    y: leg.from.y + (leg.to.y - leg.from.y) * fraction,
    z: leg.from.z + (leg.to.z - leg.from.z) * fraction
  };

  return {
    x: roundToMeter(raw.x),
    y: roundToMeter(raw.y),
    z: roundToMeter(raw.z)
  };
}

// Builds a canonical box ID string, used for CSV filenames and Firestore doc IDs.
export function boxId(pos) {
  return `X${pos.x}_Y${pos.y}_Z${pos.z}`;
}
