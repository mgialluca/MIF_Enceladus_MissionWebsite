// Hazard geometry for HIVE's drone-explorer game, measured against the real
// seafloor (see seafloor-model.js).
//
// A leg is a straight line. The terrain has no closed-form intersection with
// a line, so each leg is sampled every HAZARD_SAMPLE_STEP_M metres. The first
// sample inside a hazard brackets the entry point, which is then narrowed by
// bisection. All collision points are rounded to whole metres, as before.
//
// The proximity warning is issued IMPACT_WARNING_DISTANCE_M before the entry
// point, whatever the hazard is.

import { MISSION_CONFIG } from "./config.js";
import { distanceMeters, roundToMeter } from "./grid-math.js";
import { loadSeafloor, hazardAt } from "./seafloor-model.js";

const BISECTION_STEPS = 40;

/** Must resolve before any leg is enriched. drone-engine.js awaits this. */
export function ensureSeafloorLoaded() {
  return loadSeafloor();
}

function pointAtT(from, to, t) {
  return {
    x: roundToMeter(from.x + (to.x - from.x) * t),
    y: roundToMeter(from.y + (to.y - from.y) * t),
    z: roundToMeter(from.z + (to.z - from.z) * t)
  };
}

// Hazard at the point a fraction t along the leg, or null when clear.
function hazardOnLeg(leg, t) {
  const p = pointAtT(leg.from, leg.to, t);
  return hazardAt(p.x, p.y, p.z);
}

function findLegCollision(leg) {
  const length = distanceMeters(leg.from, leg.to);
  if (length === 0) return null;

  const steps = Math.max(1, Math.ceil(length / MISSION_CONFIG.HAZARD_SAMPLE_STEP_M));
  let clearT = 0;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (hazardOnLeg(leg, t)) {
      // Narrow the entry point between the last clear sample and this hit.
      let lo = clearT;
      let hi = t;
      for (let k = 0; k < BISECTION_STEPS; k++) {
        const mid = (lo + hi) / 2;
        if (hazardOnLeg(leg, mid)) hi = mid;
        else lo = mid;
      }
      const hazard = hazardOnLeg(leg, hi);
      return {
        type: hazard.type,
        hazardId: hazard.hazardId,
        label: hazard.label,
        t: hi,
        point: pointAtT(leg.from, leg.to, hi)
      };
    }
    clearT = t;
  }
  return null;
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
