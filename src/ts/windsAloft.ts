import type { Airport } from './geoMath';
import { slerpArc, bearingBetween, headwindComponentKt } from './geoMath';
import { metersToFeet, nearestHourIndex } from './freezingLevel';

export interface WindSample {
  frac: number; // 0 at the origin, 1 at the destination
  headwindKt: number; // positive = headwind, negative = tailwind
}

export interface CruiseWind {
  headwindKt: number; // averaged along the route
  levelLabel: string; // e.g. "~34,000 ft"
  samples: WindSample[];
  /** Freezing level in feet above sea level at each sample point (NaN where missing). */
  freezingLevelsFt: number[];
}

const SAMPLE_COUNT = 7;

// Pressure level and approximate altitude by trip length: short hops fly low.
function levelFor(distanceMiles: number): { hPa: number; label: string } {
  if (distanceMiles >= 800) return { hPa: 250, label: '~34,000 ft' };
  if (distanceMiles >= 300) return { hPa: 500, label: '~18,000 ft' };
  return { hPa: 700, label: '~10,000 ft' };
}

const cache = new Map<string, Promise<CruiseWind | null>>();
const CACHE_MS = 15 * 60 * 1000;

/**
 * Forecast-model winds at cruise level at seven points along the route
 * (Open-Meteo, free, no key, CORS-enabled), each resolved against the local course,
 * plus the freezing level at the same points from the same request.
 * Winds from the model are true-north referenced, same as route bearings.
 */
export function fetchCruiseWind(origin: Airport, destination: Airport, distanceMiles: number): Promise<CruiseWind | null> {
  const key = `${origin.icao || origin.iata}-${destination.icao || destination.iata}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = (async (): Promise<CruiseWind | null> => {
    if (!navigator.onLine) return null;
    try {
      const pts = slerpArc(origin, destination, SAMPLE_COUNT - 1);
      const course = pts.map((p, i) => {
        const next = pts[Math.min(i + 1, pts.length - 1)];
        const prev = pts[Math.max(i - 1, 0)];
        // Last point uses the incoming course; others use the outgoing course.
        return i === pts.length - 1
          ? bearingBetween(prev.lat, prev.lon, p.lat, p.lon)
          : bearingBetween(p.lat, p.lon, next.lat, next.lon);
      });

      const { hPa, label } = levelFor(distanceMiles);
      const url =
        'https://api.open-meteo.com/v1/forecast' +
        `?latitude=${pts.map((p) => p.lat.toFixed(2)).join(',')}` +
        `&longitude=${pts.map((p) => p.lon.toFixed(2)).join(',')}` +
        `&hourly=wind_speed_${hPa}hPa,wind_direction_${hPa}hPa,freezing_level_height` +
        '&wind_speed_unit=kn&timezone=GMT&forecast_days=2';
      const res = await fetch(url);
      if (!res.ok) return null;
      const json = await res.json();
      const results: any[] = Array.isArray(json) ? json : [json];
      if (results.length !== pts.length) return null;

      const nowMs = Date.now();
      const samples: WindSample[] = [];
      const freezingLevelsFt: number[] = [];
      let sum = 0;
      for (let i = 0; i < pts.length; i++) {
        const hourly = results[i].hourly;
        const idx = nearestHourIndex(hourly.time, nowMs);
        freezingLevelsFt.push(metersToFeet(hourly.freezing_level_height?.[idx]));
        const speed = hourly[`wind_speed_${hPa}hPa`][idx];
        const dir = hourly[`wind_direction_${hPa}hPa`][idx];
        if (typeof speed !== 'number' || typeof dir !== 'number') return null;
        const headwind = headwindComponentKt(course[i], dir, speed);
        samples.push({ frac: i / (pts.length - 1), headwindKt: headwind });
        sum += headwind;
      }
      return { headwindKt: sum / pts.length, levelLabel: label, samples, freezingLevelsFt };
    } catch {
      return null;
    }
  })();

  cache.set(key, promise);
  setTimeout(() => cache.delete(key), CACHE_MS);
  return promise;
}
