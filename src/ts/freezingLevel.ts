// Freezing level: the height of the 0 C level above sea level, from Open-Meteo's forecast model
// (free, no key, CORS-enabled). Shown on the airport card and, from the same request as the
// cruise winds, along a route.

import type { Airport } from './geoMath';

const FT_PER_M = 3.28084;
const CACHE_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 4000;

/** Open-Meteo reports meters above sea level; feet, or NaN when missing. */
export function metersToFeet(m: unknown): number {
  return typeof m === 'number' && Number.isFinite(m) ? m * FT_PER_M : NaN;
}

/** Index of the hourly stamp closest to now. Open-Meteo returns GMT stamps without a zone suffix. */
export function nearestHourIndex(times: string[], nowMs = Date.now()): number {
  let idx = 0;
  let best = Infinity;
  times.forEach((t, j) => {
    const diff = Math.abs(new Date(`${t}:00Z`).getTime() - nowMs);
    if (diff < best) {
      best = diff;
      idx = j;
    }
  });
  return idx;
}

/** "about 8,500 ft" (nearest 500 ft), or "at the surface" when the 0 C level is at or below the ground. */
export function describeFreezingLevel(levelFt: number, groundFt = 0): string | null {
  if (!Number.isFinite(levelFt)) return null;
  if (levelFt <= groundFt + 250) return 'at the surface';
  return `about ${(Math.round(levelFt / 500) * 500).toLocaleString('en-US')} ft`;
}

/**
 * "ORD about 9,500 ft, lowest about 8,000 ft en route, DEN about 11,000 ft" from levels sampled
 * evenly from origin to destination (first and last at the airports). Null without usable values.
 */
export function routeFreezingSummary(levelsFt: number[], origin: Airport, destination: Airport): string | null {
  if (levelsFt.length < 2 || !levelsFt.every(Number.isFinite)) return null;
  const at = (ft: number, ground: number) => describeFreezingLevel(ft, ground);
  const first = at(levelsFt[0], origin.elevation);
  const last = at(levelsFt[levelsFt.length - 1], destination.elevation);
  const inner = levelsFt.slice(1, -1);
  const lowest = inner.length ? Math.min(...inner) : NaN;
  const ends = Math.min(levelsFt[0], levelsFt[levelsFt.length - 1]);
  const parts = [`${origin.iata || origin.icao} ${first}`];
  // Only worth a mention when en route is noticeably lower than both airports.
  if (Number.isFinite(lowest) && lowest < ends - 1000) parts.push(`lowest ${at(lowest, 0)} en route`);
  parts.push(`${destination.iata || destination.icao} ${last}`);
  return parts.join(', ');
}

const cache = new Map<string, Promise<number | null>>();

/** Current freezing level over the airport in feet above sea level, or null. */
export function fetchFreezingLevel(airport: Airport): Promise<number | null> {
  const key = `${airport.lat.toFixed(2)},${airport.lon.toFixed(2)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = (async (): Promise<number | null> => {
    if (!navigator.onLine) return null;
    try {
      const url =
        'https://api.open-meteo.com/v1/forecast' +
        `?latitude=${airport.lat.toFixed(2)}&longitude=${airport.lon.toFixed(2)}` +
        '&current=freezing_level_height&timezone=GMT';
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return null;
      const json = await res.json();
      const ft = metersToFeet(json?.current?.freezing_level_height);
      return Number.isFinite(ft) ? ft : null;
    } catch {
      return null;
    }
  })();

  cache.set(key, promise);
  setTimeout(() => cache.delete(key), CACHE_MS);
  return promise;
}
