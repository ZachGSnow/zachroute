// US temporary flight restrictions (from /api/tfr): what kind each is in plain English, which ones
// a route crosses, and which are near an airport. Most TFRs reach only a few thousand feet (drone
// and fire restrictions often just 400 ft), far below an airliner's cruise, so the wording says so.

import type { FocusTarget } from './focusTarget';
import type { Airport } from './geoMath';
import { pointInPolygon, distanceToPolygonMi } from './hazardGeo';
import type { Chip } from './advisories';
import { formatDistance } from './units';
import { tfrSeverity, chipLevel, severityName } from './severity';

export interface Tfr {
  id: string;
  type: string;
  description: string;
  state?: string;
  url: string;
  rings: [number, number][][];
}

export const AIRPORT_TFR_RADIUS_MI = 30;

const TYPE_LABEL: Record<string, string> = {
  SECURITY: 'Security',
  VIP: 'VIP movement',
  HAZARDS: 'Hazard (fire, rescue or similar)',
  'UAS PUBLIC GATHERING': 'Drones (public gathering)',
  'SPACE OPERATIONS': 'Space launch or reentry',
  'AIR SHOWS/SPORTS': 'Air show or stadium',
  SPECIAL: 'Special',
};

/** "VIP movement", "Security"; unknown types title-cased. */
export function tfrTypeLabel(type: string): string {
  return TYPE_LABEL[type] || type.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** "Raleigh, NC, Thursday, October 15, 2026 through ..." with the FAA's capitals softened in the place name. */
export function tfrPlace(description: string): string {
  const [place, ...rest] = description.split(/,\s*(?=[A-Z][a-z]+day,)/);
  const softened = place.replace(/\b([A-Z])([A-Z]+)\b/g, (w, a, b) => (w.length <= 2 ? w : a + b.toLowerCase()));
  return [softened, ...rest].join(', ');
}

export function describeTfr(t: Tfr): string {
  return `Flight restriction (${tfrTypeLabel(t.type)}): ${tfrPlace(t.description)}`;
}

/** Closest distance in miles from a point to any of the TFR's shapes (0 inside). */
export function tfrDistanceMi(lat: number, lon: number, t: Tfr): number {
  return Math.min(...t.rings.map((ring) => distanceToPolygonMi(lat, lon, ring)));
}

/** TFRs the route (sampled as [lat, lon]) passes through. */
export function tfrsCrossed(points: Array<[number, number]>, tfrs: Tfr[]): Tfr[] {
  return tfrs.filter((t) => t.rings.some((ring) => points.some(([lat, lon]) => pointInPolygon(lat, lon, ring))));
}

/** TFRs within the radius of a point, closest first. */
export function tfrsNear(lat: number, lon: number, tfrs: Tfr[], radiusMi = AIRPORT_TFR_RADIUS_MI): Array<{ tfr: Tfr; miles: number }> {
  return tfrs
    .map((tfr) => ({ tfr, miles: tfrDistanceMi(lat, lon, tfr) }))
    .filter((x) => x.miles <= radiusMi)
    .sort((a, b) => a.miles - b.miles);
}

let cache: { at: number; data: Promise<Tfr[]> } | null = null;

export function fetchTfrs(): Promise<Tfr[]> {
  if (cache && Date.now() - cache.at < 5 * 60 * 1000) return cache.data;
  const data = (async (): Promise<Tfr[]> => {
    if (!navigator.onLine) return [];
    try {
      const res = await fetch('/api/tfr');
      if (!res.ok) return [];
      const json = await res.json();
      return (json.tfrs || []) as Tfr[];
    } catch {
      return [];
    }
  })();
  cache = { at: Date.now(), data };
  return data;
}

/** Airport card chips for TFRs within 30 miles of a US airport. */
/** A TFR's outline, for tap to focus. */
export const tfrFocus = (tfr: Tfr): FocusTarget => ({ title: `TFR: ${tfrTypeLabel(tfr.type)}, ${tfrPlace(tfr.description)}`, shapes: tfr.rings, points: [] });

export async function tfrChips(airport: Airport): Promise<Chip[]> {
  if (airport.country !== 'US') return [];
  const near = tfrsNear(airport.lat, airport.lon, await fetchTfrs());
  return near.slice(0, 3).map(({ tfr, miles }) => ({
    level: chipLevel(tfrSeverity(tfr.type)),
    severity: tfrSeverity(tfr.type),
    focus: tfrFocus(tfr),
    text: `\u{1F6AB} TFR ${miles < 1 ? 'over the airport' : `${formatDistance(miles)} away`}: ${tfrTypeLabel(tfr.type)} (${severityName(tfrSeverity(tfr.type)).toLowerCase()})`,
    title: `${tfrPlace(tfr.description)} (NOTAM ${tfr.id}). Details: ${tfr.url}`,
  }));
}
