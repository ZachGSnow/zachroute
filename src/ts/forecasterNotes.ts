// Forecaster notes: the aviation section of the National Weather Service forecast discussion for
// a US airport (from /api/afd), in the forecaster's own words. Cached 15 minutes per airport.

import type { Airport } from './geoMath';
import { clockOptions } from './units';

export interface ForecasterNotes {
  office: string; // "LOT"
  officeName?: string; // "Chicago, IL"
  issued?: string; // ISO time
  paragraphs: string[];
}

/** Places weather.gov forecast offices cover: the US and its territories. */
const NWS_COUNTRIES = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP']);
const CACHE_MS = 15 * 60 * 1000;

const cache = new Map<string, Promise<ForecasterNotes | null>>();

export function fetchForecasterNotes(airport: Airport): Promise<ForecasterNotes | null> {
  if (!NWS_COUNTRIES.has(airport.country)) return Promise.resolve(null);
  const key = `${airport.lat.toFixed(2)},${airport.lon.toFixed(2)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = (async (): Promise<ForecasterNotes | null> => {
    if (!navigator.onLine) return null;
    try {
      const res = await fetch(`/api/afd?lat=${airport.lat.toFixed(2)}&lon=${airport.lon.toFixed(2)}`);
      if (!res.ok) return null;
      const json = await res.json();
      if (!json.available || !Array.isArray(json.paragraphs) || !json.paragraphs.length) return null;
      return { office: json.office, officeName: json.officeName, issued: json.issued, paragraphs: json.paragraphs };
    } catch {
      return null;
    }
  })();

  cache.set(key, promise);
  setTimeout(() => cache.delete(key), CACHE_MS);
  return promise;
}

/** "Forecaster notes (NWS Chicago, IL, issued 12:23 PM)", the time in the airport's time zone. */
export function forecasterNotesLabel(notes: ForecasterNotes, timeZone?: string): string {
  const who = `NWS ${notes.officeName || notes.office}`;
  let when = '';
  if (notes.issued) {
    const d = new Date(notes.issued);
    if (!Number.isNaN(d.getTime())) {
      try {
        when = `, issued ${d.toLocaleTimeString('en-US', { ...clockOptions(), timeZone })}`;
      } catch {
        when = `, issued ${d.toLocaleTimeString('en-US', clockOptions())}`;
      }
    }
  }
  return `Forecaster notes (${who}${when})`;
}
