// Freezing level map layer: Open-Meteo's current freezing level sampled on a coarse grid over the
// visible map, in one multi-point request from the browser (each visitor's own allowance). The
// grid snaps to whole cells so panning back and forth reuses values already fetched. No Leaflet
// here; mapOverlays.ts draws it.

import { metersToFeet } from './freezingLevel';

/** Cell sizes in degrees, finest first. The finest that keeps the grid under MAX_POINTS is used. */
const CELLS = [0.5, 1, 2, 3, 5, 10, 15];
export const MAX_POINTS = 100;
const MAX_LAT = 75; // the model grid and Mercator both get unhelpful toward the poles
const CACHE_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 8000;

export interface Grid {
  cell: number;
  lats: number[]; // south to north
  lons: number[]; // west to east
}

const snapDown = (v: number, cell: number) => Math.floor(v / cell) * cell;
const snapUp = (v: number, cell: number) => Math.ceil(v / cell) * cell;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

function axis(min: number, max: number, cell: number): number[] {
  const out: number[] = [];
  for (let v = snapDown(min, cell); v <= snapUp(max, cell) + 1e-9; v += cell) out.push(round3(v));
  return out;
}

/** Sample grid covering the view (one cell beyond each edge), or null when it would be too coarse to help. */
export function gridFor(south: number, west: number, north: number, east: number): Grid | null {
  const s = Math.max(-MAX_LAT, south);
  const n = Math.min(MAX_LAT, north);
  if (n <= s) return null;
  // Leaflet can report longitudes past +-180 after panning around the world; keep the view's own span.
  for (const cell of CELLS) {
    const lats = axis(s, n, cell).filter((v) => Math.abs(v) <= MAX_LAT);
    const lons = axis(west, east, cell);
    if (lats.length * lons.length <= MAX_POINTS) return { cell, lats, lons };
  }
  return null;
}

/** Longitude folded into -180..180 for the request (the grid itself keeps the map's longitudes). */
export function wrapLon(lon: number): number {
  return round3(((((lon + 180) % 360) + 360) % 360) - 180);
}

/** Color stops in feet above sea level: dark blue where the 0 C level is low, fading out when high. */
const STOPS: Array<[number, [number, number, number, number]]> = [
  [0, [30, 58, 138, 0.75]],
  [3000, [37, 99, 235, 0.6]],
  [6000, [56, 189, 248, 0.45]],
  [10000, [125, 211, 252, 0.28]],
  [14000, [186, 230, 253, 0.12]],
];

/** RGBA for a freezing level in feet (NaN gives fully transparent). */
export function freezingColor(ft: number): [number, number, number, number] {
  if (!Number.isFinite(ft)) return [0, 0, 0, 0];
  if (ft <= STOPS[0][0]) return STOPS[0][1];
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [f0, c0] = STOPS[i];
    const [f1, c1] = STOPS[i + 1];
    if (ft <= f1) {
      const t = (ft - f0) / (f1 - f0);
      return c0.map((v, k) => (k < 3 ? Math.round(v + (c1[k] - v) * t) : v + (c1[k] - v) * t)) as [number, number, number, number];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

/** "8" for 8,000 ft: the label drawn at each sample point, in thousands of feet. */
export function freezingLabel(ft: number): string {
  if (!Number.isFinite(ft)) return '';
  return String(Math.max(0, Math.round(ft / 1000)));
}

const pointCache = new Map<string, { ft: number; at: number }>();
const keyOf = (lat: number, lon: number) => `${lat},${wrapLon(lon)}`;

/**
 * Freezing level in feet at every grid point, row by row (south to north, west to east).
 * Only points not fetched in the last 30 minutes are requested. NaN where unknown.
 */
export async function fetchFreezingGrid(grid: Grid, now = Date.now()): Promise<number[][]> {
  const missing: Array<[number, number]> = [];
  for (const lat of grid.lats) {
    for (const lon of grid.lons) {
      const hit = pointCache.get(keyOf(lat, lon));
      if (!hit || now - hit.at > CACHE_MS) missing.push([lat, wrapLon(lon)]);
    }
  }
  const unique = [...new Map(missing.map((p) => [`${p[0]},${p[1]}`, p])).values()];

  if (unique.length && navigator.onLine) {
    try {
      const url =
        'https://api.open-meteo.com/v1/forecast' +
        `?latitude=${unique.map((p) => p[0]).join(',')}` +
        `&longitude=${unique.map((p) => p[1]).join(',')}` +
        '&current=freezing_level_height&timezone=GMT';
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const json = await res.json();
        const results: any[] = Array.isArray(json) ? json : [json];
        if (results.length === unique.length) {
          unique.forEach(([lat, lon], i) => {
            pointCache.set(`${lat},${lon}`, { ft: metersToFeet(results[i]?.current?.freezing_level_height), at: now });
          });
        }
      }
    } catch {
      /* offline or rate limited: draw whatever is cached */
    }
  }

  return grid.lats.map((lat) => grid.lons.map((lon) => pointCache.get(keyOf(lat, lon))?.ft ?? NaN));
}
