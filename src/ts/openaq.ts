// Measured PM2.5 near an airport (from /api/openaq: the nearest OpenAQ ground station reporting in
// the last 3 hours), turned into the AQI the airport card already shows, so the measurement and
// the model estimate can be compared.

import { aqiCategory, type AqiScale, type AqiCategory } from './airQuality';

export interface Pm25Reading {
  pm25: number;
  time: string;
  station: string;
  provider?: string;
  distanceKm: number;
  monitor: boolean;
  locationId: number;
}

/** Linear interpolation of a concentration onto an index through breakpoints [concentration, index]. */
function onBreakpoints(c: number, bp: Array<[number, number]>): number {
  if (c <= bp[0][0]) return bp[0][1];
  for (let i = 1; i < bp.length; i++) {
    const [c1, i1] = bp[i];
    if (c <= c1) {
      const [c0, i0] = bp[i - 1];
      return Math.round(i0 + ((i1 - i0) * (c - c0)) / (c1 - c0));
    }
  }
  return bp[bp.length - 1][1];
}

// US EPA PM2.5 breakpoints (2024 revision): good to 9.0, moderate to 35.4, sensitive groups to
// 55.4, unhealthy to 125.4, very unhealthy to 225.4, hazardous to 325.4 (index 500).
const US_PM25: Array<[number, number]> = [
  [0, 0],
  [9.0, 50],
  [35.4, 100],
  [55.4, 150],
  [125.4, 200],
  [225.4, 300],
  [325.4, 500],
];

// European AQI PM2.5 bands as Open-Meteo computes its european_aqi (the model figure on the card):
// good to 10, fair 20, moderate 25, poor 50, very poor 75, extremely poor beyond (index 100+).
const EU_PM25: Array<[number, number]> = [
  [0, 0],
  [10, 20],
  [20, 40],
  [25, 60],
  [50, 80],
  [75, 100],
  [800, 120],
];

export function pm25Aqi(pm25: number, scale: AqiScale): number {
  return onBreakpoints(Math.max(0, pm25), scale === 'eu' ? EU_PM25 : US_PM25);
}

export function pm25Category(pm25: number, scale: AqiScale): AqiCategory {
  return aqiCategory(pm25Aqi(pm25, scale), scale);
}

/** "35 min ago", "2 h ago". */
export function readingAge(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  return min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

const cache = new Map<string, Promise<Pm25Reading | null>>();

export function fetchMeasuredPm25(lat: number, lon: number): Promise<Pm25Reading | null> {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = (async () => {
      if (!navigator.onLine) return null;
      try {
        const res = await fetch(`/api/openaq?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
        if (!res.ok) return null;
        const json = await res.json();
        return (json?.reading as Pm25Reading) || null;
      } catch {
        return null;
      }
    })();
    cache.set(key, hit);
  }
  return hit;
}
