export type LatLon = [number, number]; // [lat, lon]

export type BeaconPlan = {
  beacons: LatLon[];
  samples: LatLon[];
  indices: number[];
  driftMeters: number;
  angleDeg: number;
  maxChordMeters: number | null;
  minSpacingMeters: number | null;
};

const EARTH_RADIUS_M = 6371000;
const DEG_TO_M = (Math.PI / 180) * EARTH_RADIUS_M;

export function distanceMeters(a: LatLon, b: LatLon): number {
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function bearingDegrees(a: LatLon, b: LatLon): number {
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function angleDiffDegrees(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

export function resamplePolyline(coords: readonly LatLon[], stepMeters: number): LatLon[] {
  if (coords.length < 2) return coords.map((coord) => [coord[0], coord[1]]);

  const out: LatLon[] = [[coords[0][0], coords[0][1]]];
  let leftover = 0;

  for (let i = 0; i < coords.length - 1; i += 1) {
    const a = coords[i];
    const b = coords[i + 1];
    const segmentMeters = distanceMeters(a, b);
    if (segmentMeters === 0) continue;

    let d = stepMeters - leftover;
    while (d <= segmentMeters) {
      const t = d / segmentMeters;
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      d += stepMeters;
    }

    leftover = segmentMeters - (d - stepMeters);
  }

  const last = coords[coords.length - 1];
  const tail = out[out.length - 1];
  if (tail[0] !== last[0] || tail[1] !== last[1]) {
    out.push([last[0], last[1]]);
  }

  return out;
}

function placeBeacons(
  coords: readonly LatLon[],
  angleThresholdDeg: number,
  stepMeters: number,
  maxChordMeters: number | null
): Pick<BeaconPlan, "beacons" | "samples" | "indices"> {
  const samples = resamplePolyline(coords, stepMeters);
  if (samples.length < 2) {
    return {
      beacons: samples.map((sample) => [sample[0], sample[1]]),
      samples,
      indices: samples.map((_, index) => index)
    };
  }

  const beacons: LatLon[] = [samples[0]];
  const indices: number[] = [0];
  let anchor = 0;

  while (anchor < samples.length - 1) {
    const referenceBearing = bearingDegrees(samples[anchor], samples[anchor + 1]);
    let nextAnchor = samples.length - 1;

    for (let index = anchor + 2; index < samples.length; index += 1) {
      const bearing = bearingDegrees(samples[anchor], samples[index]);
      const angleOver = angleDiffDegrees(bearing, referenceBearing) > angleThresholdDeg;
      const chordOver =
        maxChordMeters !== null &&
        distanceMeters(samples[anchor], samples[index]) > maxChordMeters;

      if (angleOver || chordOver) {
        nextAnchor = index - 1;
        break;
      }
    }

    if (nextAnchor <= anchor) nextAnchor = anchor + 1;
    beacons.push(samples[nextAnchor]);
    indices.push(nextAnchor);
    anchor = nextAnchor;
  }

  return { beacons, samples, indices };
}

function chordDriftMeters(samples: readonly LatLon[], indices: readonly number[]): number {
  let worst = 0;

  for (let i = 0; i < indices.length - 1; i += 1) {
    const a = samples[indices[i]];
    const b = samples[indices[i + 1]];
    const lat0 = (((a[0] + b[0]) / 2) * Math.PI) / 180;
    const sx = DEG_TO_M * Math.cos(lat0);
    const sy = DEG_TO_M;
    const bx = (b[1] - a[1]) * sx;
    const by = (b[0] - a[0]) * sy;
    const length = Math.hypot(bx, by) || 1;

    for (let j = indices[i] + 1; j < indices[i + 1]; j += 1) {
      const p = samples[j];
      const px = (p[1] - a[1]) * sx;
      const py = (p[0] - a[0]) * sy;
      const drift = Math.abs(px * by - py * bx) / length;
      if (drift > worst) worst = drift;
    }
  }

  return worst;
}

function enforceMinSpacing(
  base: Pick<BeaconPlan, "beacons" | "samples" | "indices">,
  minSpacingMeters: number | null
): Pick<BeaconPlan, "beacons" | "samples" | "indices"> {
  if (!minSpacingMeters || minSpacingMeters <= 0 || base.beacons.length <= 2) return base;

  const keep: number[] = [0];
  let last = base.beacons[0];

  for (let i = 1; i < base.beacons.length - 1; i += 1) {
    if (distanceMeters(last, base.beacons[i]) >= minSpacingMeters) {
      keep.push(i);
      last = base.beacons[i];
    }
  }

  keep.push(base.beacons.length - 1);

  return {
    beacons: keep.map((index) => base.beacons[index]),
    samples: base.samples,
    indices: keep.map((index) => base.indices[index])
  };
}

export function buildBeaconPlan(
  coords: readonly LatLon[],
  maxDriftMeters = 2.5,
  stepMeters = 6
): BeaconPlan {
  const angles = [2, 3, 4, 6, 8, 12, 16];
  const maxChords: Array<number | null> = [18, 27, 36, 50, 75, 100, 150, null];
  const spacings: Array<number | null> = [null, 9, 15, 20, 30, 45, 60];
  const candidates: BeaconPlan[] = [];

  for (const angleDeg of angles) {
    for (const maxChordMeters of maxChords) {
      const base = placeBeacons(coords, angleDeg, stepMeters, maxChordMeters);

      for (const minSpacingMeters of spacings) {
        const result = enforceMinSpacing(base, minSpacingMeters);
        candidates.push({
          ...result,
          driftMeters: chordDriftMeters(result.samples, result.indices),
          angleDeg,
          maxChordMeters,
          minSpacingMeters
        });
      }
    }
  }

  const withinBudget = candidates
    .filter((candidate) => candidate.driftMeters <= maxDriftMeters)
    .sort((a, b) => {
      if (a.beacons.length !== b.beacons.length) return a.beacons.length - b.beacons.length;
      return (b.minSpacingMeters ?? 0) - (a.minSpacingMeters ?? 0);
    });

  if (withinBudget[0]) return withinBudget[0];

  return candidates.sort((a, b) => a.driftMeters - b.driftMeters)[0];
}

export function cumulativePolylineMeters(coords: readonly LatLon[]): number[] {
  const out = new Array<number>(coords.length);
  out[0] = 0;
  for (let i = 1; i < coords.length; i += 1) {
    out[i] = out[i - 1] + distanceMeters(coords[i - 1], coords[i]);
  }
  return out;
}

export type ProjectionResult = {
  foot: LatLon;
  distanceAlongRouteMeters: number;
  offRouteMeters: number;
  segmentIndex: number;
};

export function projectPointOntoPolylineMeters(
  point: LatLon,
  coords: readonly LatLon[],
  cumulative: readonly number[]
): ProjectionResult {
  let bestOff = Number.POSITIVE_INFINITY;
  let bestAlong = 0;
  let bestFoot: LatLon = coords[0];
  let bestSegment = 0;

  for (let i = 0; i < coords.length - 1; i += 1) {
    const a = coords[i];
    const b = coords[i + 1];
    const segmentLength = cumulative[i + 1] - cumulative[i];
    if (segmentLength === 0) continue;

    const lat0 = (a[0] * Math.PI) / 180;
    const metersPerLon = DEG_TO_M * Math.cos(lat0);
    const metersPerLat = DEG_TO_M;
    const bx = (b[1] - a[1]) * metersPerLon;
    const by = (b[0] - a[0]) * metersPerLat;
    const px = (point[1] - a[1]) * metersPerLon;
    const py = (point[0] - a[0]) * metersPerLat;
    const lengthSq = bx * bx + by * by;
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / lengthSq)) : 0;
    const fx = bx * t;
    const fy = by * t;
    const off = Math.hypot(px - fx, py - fy);

    if (off < bestOff) {
      bestOff = off;
      bestAlong = cumulative[i] + segmentLength * t;
      bestFoot = [a[0] + fy / metersPerLat, a[1] + fx / metersPerLon];
      bestSegment = i;
    }
  }

  return {
    foot: bestFoot,
    distanceAlongRouteMeters: bestAlong,
    offRouteMeters: bestOff,
    segmentIndex: bestSegment
  };
}
