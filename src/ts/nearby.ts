import type { Airport } from './geoMath';
import { bearingBetween, haversineDistanceLatLon } from './geoMath';

export const NEARBY_COUNT = 5;

export interface NearbyAirport {
  airport: Airport;
  miles: number;
  bearingDeg: number; // from the user to the airport, true north
}

/**
 * The closest airports with an IATA code (the ones people fly from), nearest first.
 * `airports` may contain alias entries pointing at the same object; each is counted once.
 */
export function nearestAirports(lat: number, lon: number, airports: Iterable<Airport>, count = NEARBY_COUNT): NearbyAirport[] {
  const seen = new Set<Airport>();
  const out: NearbyAirport[] = [];
  for (const a of airports) {
    if (!a || seen.has(a) || !a.iata || typeof a.lat !== 'number') continue;
    seen.add(a);
    if (['heliport', 'seaplane_base', 'closed'].includes(a.type)) continue;
    out.push({ airport: a, miles: haversineDistanceLatLon(lat, lon, a.lat, a.lon), bearingDeg: bearingBetween(lat, lon, a.lat, a.lon) });
  }
  out.sort((x, y) => x.miles - y.miles);
  return out.slice(0, count);
}

export type LocateResult = { ok: true; lat: number; lon: number } | { ok: false; reason: 'denied' | 'unavailable' | 'unsupported' };

/** Asks the browser for the current position once (coarse is fine for "nearest airport"). */
export function locate(): Promise<LocateResult> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve({ ok: false, reason: 'unsupported' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ ok: true, lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => resolve({ ok: false, reason: err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60 * 1000 }
    );
  });
}
