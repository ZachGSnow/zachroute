import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/live?lat=&lon=&mi=&minft=&minkt=&elev=&keep=
// Live track (header button): aircraft in the air within a small circle around the viewer, from
// adsb.lol (ODbL 1.0, https://adsb.lol). Usage is kept small on purpose:
//   - the radius is 1 to 15 statute miles (the API takes nautical miles);
//   - only aircraft off the ground, at least `minft` above the ground (`elev`, feet) and at least
//     `minkt` fast are kept, and at most 5 of them: those already tracked (`keep`, hex codes) while
//     they still qualify, then the closest;
//   - adsb.lol sees the viewer's position rounded to 0.01 degree (about 1 km), and one answer per
//     rounded area is reused for 8 seconds by this isolate.
// The key (Pages secret ADSBLOL_API_KEY) goes in the x-api-key header and never leaves the server.
// The output is a derived database of adsb.lol data and is offered under ODbL 1.0 as well.

interface Env {
  ADSBLOL_API_KEY?: string;
}

export const MAX_AIRCRAFT = 5;
export const NM_PER_MI = 0.868976;
const API = 'https://api.adsb.lol/v2/point';
const REUSE_MS = 8000;
const EARTH_RADIUS_NM = 3440.065;
export const LICENSE = 'Aircraft data (c) adsb.lol contributors, ODbL 1.0 (https://opendatacommons.org/licenses/odbl/1-0/)';

export interface LiveAircraft {
  hex: string;
  callsign?: string;
  reg?: string;
  type?: string;
  lat: number;
  lon: number;
  /** Feet above sea level (GNSS altitude when reported, else barometric). */
  altFt: number;
  /** Feet above the ground at the viewer. */
  aglFt: number;
  /** Ground speed, knots. */
  gs: number;
  /** Degrees true, or null when not reported. */
  track: number | null;
  /** Feet per minute, climbing positive. */
  rate: number | null;
  squawk?: string;
  emergency?: string;
  /** Nautical miles from the viewer. */
  distNm: number;
  /** Degrees true from the viewer to the aircraft. */
  bearing: number;
  /** Seconds since the position was received. */
  seenPos: number;
}

export interface LiveQuery {
  lat: number;
  lon: number;
  mi: number;
  minFt: number;
  minKt: number;
  elevFt: number;
  keep: string[];
}

const num = (v: string | null, fallback: number) => {
  const n = Number(v);
  return v !== null && v !== '' && Number.isFinite(n) ? n : fallback;
};
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The query, clamped to what the feature allows, or null when the position is missing. */
export function parseLiveQuery(params: URLSearchParams): LiveQuery | null {
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  if (!params.get('lat') || !params.get('lon') || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    lat,
    lon,
    mi: clamp(num(params.get('mi'), 5), 1, 15),
    minFt: clamp(num(params.get('minft'), 500), 0, 10000),
    minKt: clamp(num(params.get('minkt'), 60), 0, 300),
    elevFt: clamp(num(params.get('elev'), 0), -1500, 15000),
    keep: (params.get('keep') || '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => /^~?[0-9a-f]{6}$/.test(h))
      .slice(0, MAX_AIRCRAFT),
  };
}

const rad = (d: number) => (d * Math.PI) / 180;

export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** The area adsb.lol is asked about: the position rounded to 0.01 degree, and a radius that still covers the circle. */
export function upstreamArea(q: LiveQuery): { lat: number; lon: number; nm: number } {
  const lat = Math.round(q.lat * 100) / 100;
  const lon = Math.round(q.lon * 100) / 100;
  // Rounding moves the center by up to about 0.43 nm; ask for that much more.
  const nm = Math.ceil((q.mi * NM_PER_MI + 0.5) * 10) / 10;
  return { lat, lon, nm };
}

/** Aircraft from an adsb.lol /v2/point answer that are in the circle and in the air above the cut-offs, at most 5. */
export function selectAircraft(upstream: any, q: LiveQuery): { aircraft: LiveAircraft[]; qualifying: number } {
  const radiusNm = q.mi * NM_PER_MI;
  const qualifying: LiveAircraft[] = [];
  for (const a of upstream?.ac || []) {
    if (typeof a?.hex !== 'string' || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
    if (a.alt_baro === 'ground') continue;
    const altFt = Number.isFinite(a.alt_geom) ? a.alt_geom : Number.isFinite(a.alt_baro) ? a.alt_baro : null;
    if (altFt === null || !Number.isFinite(a.gs)) continue;
    const aglFt = Math.round(altFt - q.elevFt);
    if (aglFt < q.minFt || a.gs < q.minKt) continue;
    const distNm = distanceNm(q.lat, q.lon, a.lat, a.lon);
    if (distNm > radiusNm) continue;
    const rate = Number.isFinite(a.baro_rate) ? a.baro_rate : Number.isFinite(a.geom_rate) ? a.geom_rate : null;
    qualifying.push({
      hex: a.hex.toLowerCase(),
      callsign: typeof a.flight === 'string' && a.flight.trim() ? a.flight.trim() : undefined,
      reg: typeof a.r === 'string' ? a.r : undefined,
      type: typeof a.t === 'string' ? a.t : undefined,
      lat: a.lat,
      lon: a.lon,
      altFt: Math.round(altFt),
      aglFt,
      gs: Math.round(a.gs),
      track: Number.isFinite(a.track) ? a.track : Number.isFinite(a.true_heading) ? a.true_heading : null,
      rate,
      squawk: typeof a.squawk === 'string' ? a.squawk : undefined,
      emergency: typeof a.emergency === 'string' && a.emergency !== 'none' ? a.emergency : undefined,
      distNm: Math.round(distNm * 100) / 100,
      bearing: Math.round(bearingDeg(q.lat, q.lon, a.lat, a.lon)),
      seenPos: Number.isFinite(a.seen_pos) ? a.seen_pos : 0,
    });
  }
  // Already tracked aircraft keep their place while they qualify, so the list does not flicker;
  // the closest of the rest fill it up to 5.
  const keep = new Set(q.keep);
  const byDistance = (x: LiveAircraft, y: LiveAircraft) => x.distNm - y.distNm;
  const kept = qualifying.filter((a) => keep.has(a.hex)).sort(byDistance);
  const rest = qualifying.filter((a) => !keep.has(a.hex)).sort(byDistance);
  return { aircraft: [...kept, ...rest].slice(0, MAX_AIRCRAFT), qualifying: qualifying.length };
}

const reuse = new Map<string, { at: number; data: Promise<any> }>();

async function fetchArea(area: { lat: number; lon: number; nm: number }, key: string): Promise<any> {
  const id = `${area.lat},${area.lon},${area.nm}`;
  const hit = reuse.get(id);
  if (hit && Date.now() - hit.at < REUSE_MS) return hit.data;
  const data = fetch(`${API}/${area.lat}/${area.lon}/${area.nm}`, { headers: { 'User-Agent': USER_AGENT, 'x-api-key': key } }).then(async (res) => {
    if (!res.ok) throw new Error(`adsb.lol ${res.status}`);
    return res.json();
  });
  reuse.set(id, { at: Date.now(), data });
  data.catch(() => reuse.delete(id));
  if (reuse.size > 200) reuse.delete(reuse.keys().next().value as string);
  return data;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const onRequest: PagesFunction<Env> = async (context) => {
  const key = context.env.ADSBLOL_API_KEY;
  if (!key) return json({ error: 'not configured' }, 503);
  const q = parseLiveQuery(new URL(context.request.url).searchParams);
  if (!q) return json({ error: 'lat and lon are required' }, 400);
  try {
    const upstream = await fetchArea(upstreamArea(q), key);
    const { aircraft, qualifying } = selectAircraft(upstream, q);
    return json({ now: Date.now(), radiusNm: Math.round(q.mi * NM_PER_MI * 100) / 100, qualifying, aircraft, license: LICENSE });
  } catch {
    // Never pass the upstream error on: it could name the request.
    return json({ error: 'unavailable' }, 502);
  }
};
