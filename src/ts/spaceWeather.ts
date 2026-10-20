// Space weather (from /api/spaceweather): NOAA's R/S/G scales, Kp and the aurora forecast, and the
// route check: polar flights reroute in radiation storms, and HF radio, the only voice link far from
// land near the poles, degrades in radio blackouts and geomagnetic storms.

import type { Severity } from './severity';

export interface Scales {
  R: number;
  S: number;
  G: number;
}

export interface SpaceWeather {
  now: Scales;
  tomorrow?: { G: number; minorRadioPct?: number; majorRadioPct?: number; radiationPct?: number };
  kp?: number;
  kpTime?: string;
  aurora?: { observed?: string; forecast?: string; cells: [number, number, number][] };
}

/** Routes reaching this far north or south are polar enough for space weather to matter. */
export const POLAR_LAT = 60;

/** A NOAA scale level (1-5) onto the ladder: 1 Light, 2 Moderate, 3 Severe, 4-5 Extreme. */
export function scaleSeverity(n: number): Severity {
  return n >= 4 ? 4 : (Math.max(1, n) as Severity);
}

const WORDS = ['none', 'minor', 'moderate', 'strong', 'severe', 'extreme'];

/** "S2 (moderate) radiation storm" style pieces for the levels that matter to a polar route. */
export function polarConcerns(s: Scales): Array<{ code: string; level: number; text: string }> {
  const out: Array<{ code: string; level: number; text: string }> = [];
  if (s.S >= 1) out.push({ code: `S${s.S}`, level: s.S, text: `${WORDS[s.S]} solar radiation storm: polar flights may be rerouted to lower latitudes` });
  if (s.R >= 2) out.push({ code: `R${s.R}`, level: s.R, text: `${WORDS[s.R]} radio blackout: HF radio unreliable on the sunlit side` });
  if (s.G >= 2) out.push({ code: `G${s.G}`, level: s.G, text: `${WORDS[s.G]} geomagnetic storm: HF radio and GPS degraded near the poles` });
  return out.sort((a, b) => b.level - a.level);
}

/** Highest latitude (absolute) a route reaches. */
export function maxAbsLat(points: Array<[number, number]>): number {
  return points.reduce((m, [lat]) => Math.max(m, Math.abs(lat)), 0);
}

/** "R1 S0 G0" */
export function scalesLabel(s: Scales): string {
  return `R${s.R} S${s.S} G${s.G}`;
}

/** Aurora chance (%) at a point from the sparse 1-degree cells, bilinear between cell centers. */
export function auroraLookup(cells: [number, number, number][]): (lat: number, lon: number) => number {
  const grid = new Map<number, number>();
  for (const [lon, lat, p] of cells) grid.set(((lon % 360) + 360) % 360 * 181 + (lat + 90), p);
  const at = (lon: number, lat: number) => (lat < -90 || lat > 90 ? 0 : grid.get((((lon % 360) + 360) % 360) * 181 + (lat + 90)) ?? 0);
  return (lat, lon) => {
    const x = ((lon % 360) + 360) % 360;
    const x0 = Math.floor(x);
    const y0 = Math.floor(lat);
    const fx = x - x0;
    const fy = lat - y0;
    const a = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const b = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    return a * (1 - fy) + b * fy;
  };
}

/** Aurora green with opacity by chance: nothing under 10%, then up to fairly solid at 90%+. */
export function auroraRgba(chance: number): [number, number, number, number] {
  if (chance < 10) return [0, 0, 0, 0];
  return [74, 222, 128, Math.round(40 + Math.min(1, (chance - 10) / 80) * 160)];
}

let cache: { at: number; data: Promise<SpaceWeather | null> } | null = null;

export function fetchSpaceWeather(): Promise<SpaceWeather | null> {
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.data;
  const data = (async (): Promise<SpaceWeather | null> => {
    if (!navigator.onLine) return null;
    try {
      const res = await fetch('/api/spaceweather');
      return res.ok ? ((await res.json()) as SpaceWeather) : null;
    } catch {
      return null;
    }
  })();
  cache = { at: Date.now(), data };
  return data;
}
