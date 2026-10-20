// Live track: pure helpers for the header button's feature (no Leaflet, no DOM), so tests can
// check them. The server side is functions/api/live.ts and live-route.ts.

/** One aircraft from /api/live (functions/api/live.ts LiveAircraft). */
export interface LiveAircraft {
  hex: string;
  callsign?: string;
  reg?: string;
  type?: string;
  lat: number;
  lon: number;
  altFt: number;
  aglFt: number;
  gs: number;
  track: number | null;
  rate: number | null;
  squawk?: string;
  emergency?: string;
  distNm: number;
  bearing: number;
  seenPos: number;
}

/** From /api/live-route (functions/api/live-route.ts). */
export interface RouteAirport {
  iata?: string;
  icao?: string;
  name?: string;
  lat: number;
  lon: number;
}

export interface LiveRoute {
  callsign: string;
  airline?: string;
  airports: RouteAirport[];
}

export const NM_PER_MI = 0.868976;
export const METERS_PER_MI = 1609.344;
/** How often the aircraft refresh while tracking. */
export const POLL_MS = 10_000;
/** Tracking pauses after this long, until Continue is tapped. */
export const SESSION_MS = 5 * 60 * 1000;
/** Points kept per aircraft for the path flown since tracking started. */
export const TRAIL_POINTS = 60;

const EARTH_RADIUS_NM = 3440.065;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function distanceNm(a: [number, number], b: [number, number]): number {
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDeg(a: [number, number], b: [number, number]): number {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** The point `nm` nautical miles from `from` along `bearing` degrees true. */
export function pointAhead(from: [number, number], bearing: number, nm: number): [number, number] {
  const d = nm / EARTH_RADIUS_NM;
  const lat1 = rad(from[0]);
  const lon1 = rad(from[1]);
  const b = rad(bearing);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [deg(lat2), ((deg(lon2) + 540) % 360) - 180];
}

const angleBetween = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/**
 * Whether a looked-up route fits what the aircraft is doing. adsb.lol's own check is lenient
 * (it called a flight landing at ORD "plausible" for DFW to CLT), so the route is kept only when
 * the aircraft is near the line between its last two airports (no more than 15% plus 30 nm out of
 * the way) and, unless it is within 40 nm of the destination where approaches turn, heading
 * roughly toward it (within 60 degrees).
 */
export function routeFits(route: LiveRoute | null, pos: [number, number], track: number | null): boolean {
  if (!route || route.airports.length < 2) return false;
  const from = route.airports[route.airports.length - 2];
  const to = route.airports[route.airports.length - 1];
  const a: [number, number] = [from.lat, from.lon];
  const b: [number, number] = [to.lat, to.lon];
  const direct = distanceNm(a, b);
  const toDest = distanceNm(pos, b);
  if (distanceNm(a, pos) + toDest > direct * 1.15 + 30) return false;
  if (toDest <= 40 || track == null) return true;
  return angleBetween(track, bearingDeg(pos, b)) <= 60;
}

/** "ORD to DEN" (IATA where known, else ICAO). */
export function routeLabel(route: LiveRoute): string {
  const code = (a: RouteAirport) => a.iata || a.icao || '?';
  return route.airports.map(code).join(' to ');
}

/** "Climbing 1,200 ft/min", "Descending 800 ft/min" or "Level" (under 300 ft/min either way). */
export function verticalLabel(rate: number | null): string {
  if (rate == null || Math.abs(rate) < 300) return 'Level';
  return `${rate > 0 ? 'Climbing' : 'Descending'} ${Math.abs(Math.round(rate / 100) * 100).toLocaleString('en-US')} ft/min`;
}

/** Map color by altitude above sea level: low warm to high cool, the convention flight trackers use. */
export function altitudeColor(altFt: number): string {
  if (altFt < 2000) return '#f97316';
  if (altFt < 5000) return '#facc15';
  if (altFt < 10000) return '#4ade80';
  if (altFt < 20000) return '#22d3ee';
  if (altFt < 30000) return '#60a5fa';
  return '#c084fc';
}

export const ALTITUDE_BANDS: Array<[number, string]> = [
  [0, 'under 2,000 ft'],
  [2000, '2,000-5,000 ft'],
  [5000, '5,000-10,000 ft'],
  [10000, '10,000-20,000 ft'],
  [20000, '20,000-30,000 ft'],
  [30000, '30,000 ft and up'],
];

/** The legend shown while Live track is on: icon colors by altitude, and what the lines mean. */
export function liveLegend(): { kind: 'items'; title: string; items: Array<{ color: string; label: string; mark?: 'dot' | 'line' | 'dash' }>; note: string } {
  return {
    kind: 'items',
    title: 'Live track: altitude',
    items: [
      ...ALTITUDE_BANDS.map(([ft, label]) => ({ color: altitudeColor(ft), label, mark: 'dot' as const })),
      { color: '#e2e8f0', label: 'to destination', mark: 'dash' as const },
    ],
    note: 'Solid: path since tracking started. Dotted: one minute ahead. Aircraft data: adsb.lol contributors, ODbL 1.0',
  };
}

/** Adds a position to an aircraft's path, skipping repeats, keeping the last TRAIL_POINTS. */
export function extendTrail(trail: Array<[number, number]>, pos: [number, number]): Array<[number, number]> {
  const last = trail[trail.length - 1];
  if (last && last[0] === pos[0] && last[1] === pos[1]) return trail;
  return [...trail, pos].slice(-TRAIL_POINTS);
}

/** The query string for /api/live. */
export function liveQuery(o: { lat: number; lon: number; mi: number; minFt: number; minKt: number; elevFt: number; keep: string[] }): string {
  const p = new URLSearchParams({
    lat: o.lat.toFixed(5),
    lon: o.lon.toFixed(5),
    mi: String(o.mi),
    minft: String(o.minFt),
    minkt: String(o.minKt),
    elev: String(Math.round(o.elevFt)),
  });
  if (o.keep.length) p.set('keep', o.keep.join(','));
  return p.toString();
}
