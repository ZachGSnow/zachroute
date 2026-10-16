// Satellite fire and heat detections from the last 24 hours (via /api/fires, from NASA FIRMS):
// fetching by map rectangle, and the summary the airport card shows. No Leaflet here.

import { haversineDistanceLatLon, bearingBetween } from './geoMath';

export interface Fire {
  lat: number;
  lon: number;
  /** Fire radiative power, megawatts. */
  frp: number;
  time: string;
}

/** Detections within this distance of an airport are summarized on its card. */
export const AIRPORT_FIRE_RADIUS_MI = 50;

const cache = new Map<string, { at: number; data: Promise<Fire[]> }>();
const CACHE_MS = 15 * 60 * 1000;

/** Detections in a rectangle; the server rounds it out to whole degrees, so this key does too. */
export function fetchFires(minLat: number, minLon: number, maxLat: number, maxLon: number): Promise<Fire[]> {
  const box = [Math.floor(minLat), Math.floor(minLon), Math.ceil(maxLat), Math.ceil(maxLon)].map((n, i) =>
    i % 2 === 0 ? Math.max(-90, Math.min(90, n)) : Math.max(-180, Math.min(180, n))
  );
  const key = box.join(',');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = (async (): Promise<Fire[]> => {
    if (!navigator.onLine) return [];
    try {
      const res = await fetch(`/api/fires?bbox=${key}`);
      if (!res.ok) return [];
      const json = await res.json();
      return (json.fires || []) as Fire[];
    } catch {
      return [];
    }
  })();
  cache.set(key, { at: Date.now(), data });
  return data;
}

/** Rectangle around a point that contains everything within `miles` of it. */
export function boxAround(lat: number, lon: number, miles: number): [number, number, number, number] {
  const dLat = miles / 69;
  const dLon = miles / (69 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

export interface FireSummary {
  count: number;
  /** The most intense detection: distance (mi) and bearing (deg true) from the point. */
  strongest: { fire: Fire; miles: number; bearing: number };
  nearestMiles: number;
}

/** Detections within `radiusMi` of a point, summarized; null when there are none. */
export function summarizeFiresNear(lat: number, lon: number, fires: Fire[], radiusMi = AIRPORT_FIRE_RADIUS_MI): FireSummary | null {
  let count = 0;
  let nearestMiles = Infinity;
  let strongest: FireSummary['strongest'] | null = null;
  for (const fire of fires) {
    const miles = haversineDistanceLatLon(lat, lon, fire.lat, fire.lon);
    if (miles > radiusMi) continue;
    count += 1;
    if (miles < nearestMiles) nearestMiles = miles;
    if (!strongest || fire.frp > strongest.fire.frp) strongest = { fire, miles, bearing: bearingBetween(lat, lon, fire.lat, fire.lon) };
  }
  return strongest ? { count, strongest, nearestMiles } : null;
}
