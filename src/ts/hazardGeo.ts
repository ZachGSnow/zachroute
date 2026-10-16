// Geometry for advisory polygons, kept free of Leaflet so it can be tested on its own.
// Rings are [lat, lon] pairs; rings that cross the antimeridian arrive unwrapped past +/-180
// (see unwrapRing in functions/api/airsigmet.ts).

import { haversineDistanceLatLon } from './geoMath';

export type Ring = [number, number][];

function pointInRing(lat: number, lon: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point-in-polygon that also tries the point a world away, for rings unwrapped past +/-180. */
export function pointInPolygon(lat: number, lon: number, ring: Ring): boolean {
  return pointInRing(lat, lon, ring) || pointInRing(lat, lon + 360, ring) || pointInRing(lat, lon - 360, ring);
}

const EDGE_STEPS = 8;

/**
 * Approximate distance in statute miles from a point to a polygon: 0 inside, otherwise the
 * closest of a few points sampled along each edge. Good to a few miles for advisory-sized shapes.
 */
export function distanceToPolygonMi(lat: number, lon: number, ring: Ring): number {
  if (ring.length === 0) return Infinity;
  if (pointInPolygon(lat, lon, ring)) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [lat1, lon1] = ring[i];
    const [lat2, lon2] = ring[(i + 1) % ring.length];
    for (let s = 0; s < EDGE_STEPS; s++) {
      const t = s / EDGE_STEPS;
      const d = haversineDistanceLatLon(lat, lon, lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Advisories of one hazard within `radiusMi` of a point, closest first. */
export function advisoriesNear<T extends { hazard: string; coords: Ring }>(
  lat: number,
  lon: number,
  list: T[],
  hazard: string,
  radiusMi: number
): Array<{ advisory: T; miles: number }> {
  return list
    .filter((a) => a.hazard === hazard)
    .map((advisory) => ({ advisory, miles: distanceToPolygonMi(lat, lon, advisory.coords) }))
    .filter((x) => x.miles <= radiusMi)
    .sort((a, b) => a.miles - b.miles);
}
