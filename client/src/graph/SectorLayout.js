/**
 * SectorLayout — assigns each cluster to a fixed angular sector around the origin.
 *
 * The core insight: forceRadial constrains distance but NOT angle. Without an
 * angular constraint, link springs rotate clusters toward each other until
 * they collapse. SectorLayout fixes this by giving each cluster a fixed angle.
 *
 * Sectors are assigned in evenly-spaced increments (360 / clusterCount).
 * Within each sector, the cluster hub sits at the sector center angle, and
 * satellites are distributed in a fan around it.
 */

const toRad = deg => (deg * Math.PI) / 180;

// Fixed sector assignments for known clusters (prevents reassignment drift
// when the cluster set changes). New clusters get the next available slot.
const KNOWN_SECTORS = {
  runtime: 0,
  models: 72,
  interface: 144,
  integrate: 216,
  infra: 288,
};

/**
 * Compute sector angles for a set of clusters.
 * Known clusters keep their fixed angle; unknown clusters get evenly-spaced
 * slots in the gaps between known ones.
 *
 * @param {string[]} clusterIds - ordered list of cluster names
 * @returns {Map<string, { angleDeg: number, angleRad: number }>}
 */
export function assignSectors(clusterIds) {
  const sectors = new Map();
  const knownAngles = [];

  // First pass: assign known sectors
  for (const id of clusterIds) {
    if (KNOWN_SECTORS[id] !== undefined) {
      sectors.set(id, {
        angleDeg: KNOWN_SECTORS[id],
        angleRad: toRad(KNOWN_SECTORS[id]),
      });
      knownAngles.push(KNOWN_SECTORS[id]);
    }
  }

  // Second pass: assign unknown clusters to gaps
  const unassigned = clusterIds.filter(id => !sectors.has(id));

  if (unassigned.length === 0) return sectors;

  // If no known clusters, distribute evenly
  if (knownAngles.length === 0) {
    const step = 360 / unassigned.length;
    unassigned.forEach((id, i) => {
      sectors.set(id, { angleDeg: i * step, angleRad: toRad(i * step) });
    });
    return sectors;
  }

  // Find the largest gap between known angles and split it
  knownAngles.sort((a, b) => a - b);
  let bestGap = { start: 0, size: 0 };

  for (let i = 0; i < knownAngles.length; i++) {
    const start = knownAngles[i];
    const end = knownAngles[(i + 1) % knownAngles.length];
    const size = ((end - start + 360) % 360);
    if (size > bestGap.size) bestGap = { start, size };
  }

  // Distribute unassigned clusters in the largest gap
  const gapStep = bestGap.size / (unassigned.length + 1);
  unassigned.forEach((id, i) => {
    const angle = (bestGap.start + gapStep * (i + 1)) % 360;
    sectors.set(id, { angleDeg: angle, angleRad: toRad(angle) });
  });

  return sectors;
}

/**
 * Target position for a cluster hub at its sector angle + radius.
 */
export function hubTarget(sector, radius) {
  return {
    x: Math.cos(sector.angleRad) * radius,
    y: Math.sin(sector.angleRad) * radius,
  };
}

/**
 * Target position for a satellite node within a cluster's sector.
 * Spreads nodes in a fan around the hub using a deterministic hash
 * so positions are stable across re-layouts.
 *
 * @param {string} nodeId - for deterministic hashing
 * @param {object} sector - { angleDeg, angleRad } from assignSectors
 * @param {number} hubX - x position of the cluster hub (world coords)
 * @param {number} hubY - y position of the cluster hub (world coords)
 * @param {number} ringRadius - satellite ring radius around hub
 * @returns {{ x: number, y: number }}
 */
export function satelliteTarget(nodeId, hubX, hubY, ringRadius, index = -1) {
  // Use FNV-1a (no integer truncation) for good distribution across UUID-ish IDs.
  let hash = 2166136261 >>> 0;
  if (nodeId) {
    for (let i = 0; i < nodeId.length; i++) {
      hash ^= nodeId.charCodeAt(i);
      hash = (hash * 16777619) >>> 0; // keep it in uint32
    }
  }
  hash = hash >>> 0;

  // If an index within the cluster is known, use golden-angle layout — this is the
  // optimal packing angle and guarantees siblings don't overlap at the same hash.
  const localAngle = index >= 0
    ? toRad((index * 137.508) % 360)
    : toRad(hash % 360);
  const r = ringRadius + (index >= 0 ? index * 4 : ((hash >> 8) % 7) * 15);

  return {
    x: hubX + Math.cos(localAngle) * r,
    y: hubY + Math.sin(localAngle) * r,
  };
}

/**
 * Compute the ideal sector radius for a cluster based on its node count.
 * Each node needs ~44px of ring circumference to avoid overlap.
 */
export function clusterRadius(nodeCount) {
  const ringCircumference = nodeCount * 44;
  return Math.max(140, ringCircumference / (2 * Math.PI) + 30);
}

export { toRad };
