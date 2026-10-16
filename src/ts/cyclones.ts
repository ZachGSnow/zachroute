// Tropical cyclones worldwide (via /api/cyclones, from GDACS): fetching, plus the distance and
// forecast-cone checks the airport card and the route use. No Leaflet here; the map layer is in
// mapOverlays.ts.

import { haversineDistanceLatLon, bearingBetween } from './geoMath';
import { pointInPolygon } from './hazardGeo';

export interface TrackPoint {
  lat: number;
  lon: number;
  time: string;
  forecast: boolean;
}

export interface Cyclone {
  id: number;
  name: string;
  category?: string;
  alert: string;
  lat: number;
  lon: number;
  asOf: string;
  source?: string;
  track: TrackPoint[];
  cone?: [number, number][];
  report?: string;
}

/** Storm center within this distance of an airport gets a chip on its card. */
export const AIRPORT_RADIUS_MI = 300;
/** A route passing this close to a storm center is flagged even outside the cone. */
export const ROUTE_RADIUS_MI = 150;

let cache: { at: number; data: Promise<Cyclone[]> } | null = null;
const CACHE_MS = 10 * 60 * 1000;

export function fetchCyclones(): Promise<Cyclone[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const data = (async (): Promise<Cyclone[]> => {
    if (!navigator.onLine) return [];
    try {
      const res = await fetch('/api/cyclones');
      if (!res.ok) return [];
      const json = await res.json();
      return (json.storms || []) as Cyclone[];
    } catch {
      return [];
    }
  })();
  cache = { at: Date.now(), data };
  return data;
}

const CATEGORY_WORDS: Record<string, string> = {
  HU: 'Hurricane / typhoon',
  TY: 'Hurricane / typhoon',
  TS: 'Tropical storm',
  TD: 'Tropical depression',
};

/** "Tropical storm Champi", "Hurricane / typhoon Simon", "Tropical cyclone One". */
export function stormTitle(storm: Cyclone): string {
  return `${CATEGORY_WORDS[storm.category || ''] || 'Tropical cyclone'} ${storm.name}`;
}

export interface StormNearPoint {
  storm: Cyclone;
  /** Distance from the point to the storm center, statute miles. */
  miles: number;
  /** Bearing from the point to the storm center, degrees true. */
  bearing: number;
  /** The point is inside the storm's forecast uncertainty cone. */
  inCone: boolean;
}

/** Storms whose center is within `radiusMi` of a point, or whose forecast cone covers it; closest first. */
export function stormsNearPoint(lat: number, lon: number, storms: Cyclone[], radiusMi = AIRPORT_RADIUS_MI): StormNearPoint[] {
  return storms
    .map((storm) => ({
      storm,
      miles: haversineDistanceLatLon(lat, lon, storm.lat, storm.lon),
      bearing: bearingBetween(lat, lon, storm.lat, storm.lon),
      inCone: !!storm.cone && pointInPolygon(lat, lon, storm.cone),
    }))
    .filter((s) => s.miles <= radiusMi || s.inCone)
    .sort((a, b) => a.miles - b.miles);
}

export interface StormOnRoute {
  storm: Cyclone;
  /** Closest the route comes to the storm center, statute miles. */
  miles: number;
  /** The route passes through the forecast cone. */
  crossesCone: boolean;
}

/** Storms the route passes near (within ROUTE_RADIUS_MI of the center) or through the forecast cone of. */
export function stormsAlongRoute(points: Array<[number, number]>, storms: Cyclone[]): StormOnRoute[] {
  if (points.length === 0) return [];
  return storms
    .map((storm) => {
      let miles = Infinity;
      let crossesCone = false;
      for (const [lat, lon] of points) {
        const d = haversineDistanceLatLon(lat, lon, storm.lat, storm.lon);
        if (d < miles) miles = d;
        if (!crossesCone && storm.cone && pointInPolygon(lat, lon, storm.cone)) crossesCone = true;
      }
      return { storm, miles, crossesCone };
    })
    .filter((s) => s.miles <= ROUTE_RADIUS_MI || s.crossesCone)
    .sort((a, b) => a.miles - b.miles);
}
