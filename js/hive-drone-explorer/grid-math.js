// Pure grid/coordinate logic for HIVE's drone-explorer game.
// No Firestore, no DOM — fully unit-testable in isolation.

import { MISSION_CONFIG } from "./config.js";

export const BOUNDS_M = {
  xMax: MISSION_CONFIG.GRID_X_KM * 1000,
  yMax: MISSION_CONFIG.GRID_Y_KM * 1000,
  zMax: MISSION_CONFIG.GRID_Z_KM * 1000
};

export function roundToMeter(value) {
  return Math.round(value);
}

export function clampToBounds(pos) {
  return {
    x: Math.min(Math.max(0, pos.x), BOUNDS_M.xMax),
    y: Math.min(Math.max(0, pos.y), BOUNDS_M.yMax),
    z: Math.min(Math.max(0, pos.z), BOUNDS_M.zMax)
  };
}

export function distanceMeters(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function computeLegTime(a, b, scale) {
  const dist = distanceMeters(a, b);
  return scale === "km"
    ? (dist / 1000) * MISSION_CONFIG.KM_SCALE_SECONDS_PER_KM
    : dist * MISSION_CONFIG.M_SCALE_SECONDS_PER_METER;
}

/**
 * Decomposes a move from `current` to `destination` into up to two ordered legs:
 * 1. A "km" leg — the largest whole-km displacement (per axis) toward the destination
 * 2. An "m" leg — whatever meter-scale remainder is left to reach the exact destination
 *
 * Example: current.x = 5000, destination.x = 7500
 *   -> km leg moves x from 5000 -> 7000 (2 km), m leg covers 7000 -> 7500 (500m)
 *
 * Only the FINAL leg's arrival counts as the command's true destination for
 * data-collection purposes; the km-leg's intermediate stop is purely transit.
 * Returns 0, 1, or 2 legs (0 only if destination === current).
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
 * and the current time, computes the drone's true interpolated position —
 * rounded to the nearest whole meter on each axis, so a mid-leg cancel can
 * never leave a drone at a fractional-meter position.
 */
export function interpolateLegPosition(leg, now) {
  const elapsedSeconds = (now - leg.startedAt) / 1000;
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