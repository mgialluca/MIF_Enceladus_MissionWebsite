// Pure hazard geometry for HIVE's drone-explorer game.
// No Firestore, no DOM. All collision points are rounded to whole meters.

import { MISSION_CONFIG } from "./config.js";
import { distanceMeters, roundToMeter } from "./grid-math.js";

const EPSILON = 1e-9;

export const FLOOR_Z_M = MISSION_CONFIG.TRUE_OCEAN_DEPTH_KM * 1000;

export function getVentBoxes() {
  return MISSION_CONFIG.VENTS.map((vent) => {
    const halfX = vent.footprintXM / 2;
    const halfY = vent.footprintYM / 2;
    return {
      id: vent.id,
      label: vent.label,
      min: {
        x: vent.center.x - halfX,
        y: vent.center.y - halfY,
        z: FLOOR_Z_M - vent.heightM
      },
      max: {
        x: vent.center.x + halfX,
        y: vent.center.y + halfY,
        z: FLOOR_Z_M
      }
    };
  });
}

function pointAtT(from, to, t) {
  return {
    x: roundToMeter(from.x + (to.x - from.x) * t),
    y: roundToMeter(from.y + (to.y - from.y) * t),
    z: roundToMeter(from.z + (to.z - from.z) * t)
  };
}

function floorIntersection(leg) {
  if (!MISSION_CONFIG.ENABLE_FLOOR_COLLISIONS) return null;

  const zDelta = leg.to.z - leg.from.z;
  if (Math.abs(zDelta) < EPSILON) return null;

  const t = (FLOOR_Z_M - leg.from.z) / zDelta;
  if (t < 0 || t > 1) return null;

  return {
    type: "floor",
    hazardId: "ocean-floor",
    label: "Ocean floor",
    t,
    point: pointAtT(leg.from, leg.to, t)
  };
}

function axisInterval(fromValue, toValue, minValue, maxValue) {
  const delta = toValue - fromValue;
  if (Math.abs(delta) < EPSILON) {
    if (fromValue < minValue || fromValue > maxValue) return null;
    return { enter: -Infinity, exit: Infinity };
  }

  const t1 = (minValue - fromValue) / delta;
  const t2 = (maxValue - fromValue) / delta;
  return { enter: Math.min(t1, t2), exit: Math.max(t1, t2) };
}

function boxIntersection(leg, box) {
  const intervals = [
    axisInterval(leg.from.x, leg.to.x, box.min.x, box.max.x),
    axisInterval(leg.from.y, leg.to.y, box.min.y, box.max.y),
    axisInterval(leg.from.z, leg.to.z, box.min.z, box.max.z)
  ];
  if (intervals.some((interval) => interval === null)) return null;

  const tEnter = Math.max(...intervals.map((interval) => interval.enter), 0);
  const tExit = Math.min(...intervals.map((interval) => interval.exit), 1);
  if (tEnter > tExit) return null;

  return {
    type: "vent",
    hazardId: box.id,
    label: box.label,
    t: tEnter,
    point: pointAtT(leg.from, leg.to, tEnter)
  };
}

export function findLegCollision(leg) {
  const collisions = [];
  const floor = floorIntersection(leg);
  if (floor) collisions.push(floor);

  if (MISSION_CONFIG.ENABLE_VENT_COLLISIONS) {
    getVentBoxes().forEach((box) => {
      const vent = boxIntersection(leg, box);
      if (vent) collisions.push(vent);
    });
  }

  if (collisions.length === 0) return null;
  collisions.sort((a, b) => a.t - b.t);
  return collisions[0];
}

export function enrichLegWithHazards(leg) {
  const collision = findLegCollision(leg);
  if (!collision) {
    return { ...leg, collision: null, warningAt: null };
  }

  const collisionDistance = distanceMeters(leg.from, collision.point);
  const warningDistance = Math.max(0, collisionDistance - MISSION_CONFIG.IMPACT_WARNING_DISTANCE_M);
  const warningFractionOfCollision = collisionDistance === 0 ? 0 : warningDistance / collisionDistance;
  const warningT = Math.min(Math.max(warningFractionOfCollision * collision.t, 0), collision.t);

  return {
    ...leg,
    collision: {
      ...collision,
      distanceFromStartM: collisionDistance
    },
    warningAt: leg.scale === "m" && MISSION_CONFIG.ENABLE_METER_JUMP_WARNINGS
      ? {
          t: warningT,
          distanceBeforeImpactM: MISSION_CONFIG.IMPACT_WARNING_DISTANCE_M,
          point: pointAtT(leg.from, leg.to, warningT)
        }
      : null
  };
}

export function collisionTimeMs(leg) {
  if (!leg.collision || leg.startedAt === null) return null;
  return leg.startedAt + leg.travelTimeSeconds * leg.collision.t * 1000;
}

export function warningTimeMs(leg) {
  if (!leg.warningAt || leg.startedAt === null) return null;
  return leg.startedAt + leg.travelTimeSeconds * leg.warningAt.t * 1000;
}
