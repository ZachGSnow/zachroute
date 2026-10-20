import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/live?lat=&lon=&mi=&minft=&minkt=&elev=&max=&keep=
// Live track (header button): aircraft in the air within a small circle around the viewer, from
// the adsb.lol re-api (ODbL 1.0, https://adsb.lol). Usage is kept small on purpose:
//   - the radius is 1 to 15 statute miles (the re-api takes nautical miles);
//   - adsb.lol already leaves out aircraft well below the height asked for (above_alt_baro), and
//     here only aircraft off the ground, at least `minft` above the ground (`elev`, feet) and at
//     least `minkt` fast are kept, `max` of them (5 to 10): those already tracked (`keep`, hex
//     codes) while they still qualify, then the closest;
//   - adsb.lol sees the viewer's position rounded to 0.01 degree (about 1 km), and one answer per
//     rounded area is reused for 8 seconds by this isolate;
//   - when adsb.lol answers 429, no request goes out until its Retry-After has passed; the last
//     answer for the area is served meanwhile, marked busy.
// The key (Pages secret ADSBLOL_API_KEY) goes in the x-api-key header and never leaves the server.
// The output is a derived database of adsb.lol data and is offered under ODbL 1.0 as well.

interface Env {
  ADSBLOL_API_KEY?: string;
}

export const MAX_AIRCRAFT = 10;
export const DEFAULT_AIRCRAFT = 5;
export const NM_PER_MI = 0.868976;
const API = 'https://re-api.adsb.lol/';
/** Barometric altitude can read a few hundred feet off true height; ask adsb.lol for this much lower. */
const BARO_MARGIN_FT = 1000;
const REUSE_MS = 8000;
/** adsb.lol has taken 20 s to answer at busy times; give up sooner and let the app try again. */
const UPSTREAM_TIMEOUT_MS = 12000;
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
  /** How many aircraft to return, 5 to 10. */
  max: number;
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
    max: Math.round(clamp(num(params.get('max'), DEFAULT_AIRCRAFT), DEFAULT_AIRCRAFT, MAX_AIRCRAFT)),
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

export interface UpstreamArea {
  lat: number;
  lon: number;
  nm: number;
  /** Lowest barometric altitude adsb.lol should send, feet, in steps of 500 (null: no floor). */
  floorFt: number | null;
}

/** The area adsb.lol is asked about: the position rounded to 0.01 degree, a radius that still covers the circle, and a height floor. */
export function upstreamArea(q: LiveQuery): UpstreamArea {
  const lat = Math.round(q.lat * 100) / 100;
  const lon = Math.round(q.lon * 100) / 100;
  // Rounding moves the center by up to about 0.43 nm; ask for that much more.
  const nm = Math.ceil((q.mi * NM_PER_MI + 0.5) * 10) / 10;
  const floor = Math.floor((q.elevFt + q.minFt - BARO_MARGIN_FT) / 500) * 500;
  return { lat, lon, nm, floorFt: floor > 0 ? floor : null };
}

/** The re-api request for an area. */
export function upstreamUrl(a: UpstreamArea): string {
  return `${API}?circle=${a.lat},${a.lon},${a.nm}${a.floorFt != null ? `&above_alt_baro=${a.floorFt}` : ''}`;
}

/** Aircraft from an adsb.lol answer (re-api `aircraft`, or /v2 `ac`) in the circle and in the air above the cut-offs, at most `max`. */
export function selectAircraft(upstream: any, q: LiveQuery): { aircraft: LiveAircraft[]; qualifying: number } {
  const radiusNm = q.mi * NM_PER_MI;
  const qualifying: LiveAircraft[] = [];
  for (const a of upstream?.aircraft || upstream?.ac || []) {
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
  return { aircraft: [...kept, ...rest].slice(0, q.max), qualifying: qualifying.length };
}

/** Seconds to wait from a Retry-After header (seconds or an HTTP date), 1 to 3600, default 60. */
export function retryAfterSeconds(header: string | null, now = Date.now()): number {
  if (!header) return 60;
  const secs = /^\d+$/.test(header.trim()) ? Number(header) : (Date.parse(header) - now) / 1000;
  return Number.isFinite(secs) ? Math.min(3600, Math.max(1, Math.ceil(secs))) : 60;
}

class Busy extends Error {
  constructor(public retryIn: number) {
    super('busy');
  }
}

const reuse = new Map<string, { at: number; data: Promise<any> }>();
/** The last good answer per area, served while adsb.lol asks us to wait. */
const lastGood = new Map<string, any>();
let blockedUntil = 0;

const areaId = (a: UpstreamArea) => `${a.lat},${a.lon},${a.nm},${a.floorFt}`;

async function fetchArea(area: UpstreamArea, key: string): Promise<any> {
  const id = areaId(area);
  const hit = reuse.get(id);
  if (hit && Date.now() - hit.at < REUSE_MS) return hit.data;
  if (Date.now() < blockedUntil) throw new Busy(Math.ceil((blockedUntil - Date.now()) / 1000));
  const data = fetch(upstreamUrl(area), { headers: { 'User-Agent': USER_AGENT, 'x-api-key': key }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }).then(async (res) => {
    if (res.status === 429) {
      const wait = retryAfterSeconds(res.headers.get('retry-after'));
      blockedUntil = Date.now() + wait * 1000;
      throw new Busy(wait);
    }
    if (!res.ok) throw new Error(`adsb.lol ${res.status}`);
    const body = await res.json();
    lastGood.set(id, body);
    if (lastGood.size > 200) lastGood.delete(lastGood.keys().next().value as string);
    return body;
  });
  reuse.set(id, { at: Date.now(), data });
  data.catch(() => reuse.delete(id));
  if (reuse.size > 200) reuse.delete(reuse.keys().next().value as string);
  return data;
}

/** For tests: forget answers and any wait. */
export function resetLiveState() {
  reuse.clear();
  lastGood.clear();
  blockedUntil = 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const onRequest: PagesFunction<Env> = async (context) => {
  const key = context.env.ADSBLOL_API_KEY;
  if (!key) return json({ error: 'not configured' }, 503);
  const q = parseLiveQuery(new URL(context.request.url).searchParams);
  if (!q) return json({ error: 'lat and lon are required' }, 400);
  const area = upstreamArea(q);
  const answer = (upstream: any, extra: Record<string, unknown> = {}) => {
    const { aircraft, qualifying } = selectAircraft(upstream, q);
    return json({ now: Date.now(), radiusNm: Math.round(q.mi * NM_PER_MI * 100) / 100, qualifying, aircraft, license: LICENSE, ...extra });
  };
  try {
    return answer(await fetchArea(area, key));
  } catch (e) {
    if (e instanceof Busy) {
      const stale = lastGood.get(areaId(area));
      return stale ? answer(stale, { busy: true, retryIn: e.retryIn }) : json({ error: 'busy', retryIn: e.retryIn }, 429);
    }
    // Never pass the upstream error on: it could name the request.
    return json({ error: 'unavailable' }, 502);
  }
};
