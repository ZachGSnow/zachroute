// Earthquakes (M4.5+ worldwide, last day) and US volcanoes at an elevated alert (from
// /api/geohazards), on the severity ladder, and airport card chips for nearby volcanoes.

import type { Airport } from './geoMath';
import { haversineDistanceLatLon } from './geoMath';
import type { Chip } from './advisories';
import { formatDistance } from './units';
import { chipLevel, severityName, type Severity } from './severity';

export interface Quake {
  id: string;
  mag: number;
  place: string;
  time: number;
  lat: number;
  lon: number;
  depthKm?: number;
  tsunami: boolean;
  url?: string;
}

export interface Volcano {
  name: string;
  colorCode: string;
  alertLevel: string;
  observatory?: string;
  sent?: number;
  url?: string;
  lat: number;
  lon: number;
}

export interface Geohazards {
  quakes: Quake[];
  volcanoes: Volcano[];
}

/** Magnitude onto the ladder: under 5.5 Light, under 6.5 Moderate, under 7.5 Severe, 7.5 and up Extreme. */
export function quakeSeverity(mag: number): Severity {
  if (mag >= 7.5) return 4;
  if (mag >= 6.5) return 3;
  if (mag >= 5.5) return 2;
  return 1;
}

const COLOR_LEVEL: Record<string, Severity> = { YELLOW: 1, ORANGE: 2, RED: 4 };

/**
 * The aviation color code onto the ladder: YELLOW (unrest) Light, ORANGE (eruption likely, or
 * under way with little ash) Moderate, RED (significant ash in the air) Extreme, the level ash
 * SIGMETs get. GREEN or unknown: null (not drawn).
 */
export function volcanoSeverity(colorCode: string): Severity | null {
  return COLOR_LEVEL[colorCode.toUpperCase()] ?? null;
}

const COLOR_WORDS: Record<string, string> = {
  YELLOW: 'signs of unrest',
  ORANGE: 'eruption likely or under way, little ash',
  RED: 'eruption with significant ash in the air',
};

/** "ORANGE (eruption likely or under way, little ash)". */
export function colorCodeLabel(colorCode: string): string {
  const c = colorCode.toUpperCase();
  return COLOR_WORDS[c] ? `${c} (${COLOR_WORDS[c]})` : c;
}

/** Map marker radius in pixels for a magnitude: 4 at M4.5, growing with energy. */
export function quakeRadius(mag: number): number {
  return Math.round(4 + Math.max(0, mag - 4.5) * 4);
}

export const AIRPORT_VOLCANO_RADIUS_MI = 100;

/** Elevated volcanoes within the radius of a point, closest first. */
export function volcanoesNear(lat: number, lon: number, list: Volcano[], radiusMi = AIRPORT_VOLCANO_RADIUS_MI): Array<{ volcano: Volcano; miles: number }> {
  return list
    .filter((v) => volcanoSeverity(v.colorCode) !== null)
    .map((v) => ({ volcano: v, miles: haversineDistanceLatLon(lat, lon, v.lat, v.lon) }))
    .filter((x) => x.miles <= radiusMi)
    .sort((a, b) => a.miles - b.miles);
}

let cache: { at: number; data: Promise<Geohazards> } | null = null;

export function fetchGeohazards(): Promise<Geohazards> {
  if (cache && Date.now() - cache.at < 5 * 60 * 1000) return cache.data;
  const data = (async (): Promise<Geohazards> => {
    const empty = { quakes: [], volcanoes: [] };
    if (!navigator.onLine) return empty;
    try {
      const res = await fetch('/api/geohazards');
      if (!res.ok) return empty;
      const json = await res.json();
      return { quakes: json.quakes || [], volcanoes: json.volcanoes || [] };
    } catch {
      return empty;
    }
  })();
  cache = { at: Date.now(), data };
  return data;
}

/** Airport card chips for elevated volcanoes within 100 miles. */
export async function volcanoChips(airport: Airport): Promise<Chip[]> {
  const near = volcanoesNear(airport.lat, airport.lon, (await fetchGeohazards()).volcanoes);
  return near.slice(0, 2).map(({ volcano, miles }) => {
    const level = volcanoSeverity(volcano.colorCode)!;
    return {
      level: chipLevel(level),
      severity: level,
      focus: { title: `${volcano.name} volcano: aviation code ${volcano.colorCode}`, shapes: [], points: [[volcano.lat, volcano.lon]] },
      text: `\u{1F30B} ${volcano.name} volcano ${formatDistance(miles)} away: aviation code ${volcano.colorCode} (${severityName(level).toLowerCase()})`,
      title: `${colorCodeLabel(volcano.colorCode)}. ${volcano.observatory || 'USGS'}${volcano.url ? `: ${volcano.url}` : ''}`,
    };
  });
}
