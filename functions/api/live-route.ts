import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/live-route?callsign=AAL1696&lat=&lon=
// Where a live-tracked flight is going: the route adsb.lol knows for a callsign (from the Virtual
// Radar Server standing data, community maintained, ODbL 1.0 via adsb.lol). It is often missing
// for private aircraft and sometimes wrong, so the app keeps it only when the aircraft's position
// and track fit it (src/ts/liveTrack.ts routeFits). Answers are reused for 6 hours per callsign by
// this isolate. The documented batch endpoint (/api/0/routeset) answered 201 with an empty body
// when tried on 2026-10-20, so this uses the per-callsign one adsb.lol's own map uses.

interface Env {
  ADSBLOL_API_KEY?: string;
}

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
  /** Origin first, destination last, any stops between. */
  airports: RouteAirport[];
}

const REUSE_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; data: Promise<LiveRoute | null> }>();

/** A callsign as adsb.lol takes it: letters and digits, 2 to 8 long. */
export const cleanCallsign = (v: string | null) => {
  const c = (v || '').trim().toUpperCase();
  return /^[A-Z0-9]{2,8}$/.test(c) ? c : null;
};

/** The airports of an adsb.lol route answer, or null when it has none. */
export function parseRoute(callsign: string, body: any): LiveRoute | null {
  const airports: RouteAirport[] = (body?._airports || [])
    .filter((a: any) => Number.isFinite(a?.lat) && Number.isFinite(a?.lon))
    .map((a: any) => ({ iata: a.iata || undefined, icao: a.icao || undefined, name: a.name || undefined, lat: a.lat, lon: a.lon }));
  if (airports.length < 2 || body?.airport_codes === 'unknown') return null;
  return { callsign, airline: typeof body.airline_code === 'string' ? body.airline_code : undefined, airports };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': status === 200 ? 'public, max-age=3600' : 'no-store' } });

export const onRequest: PagesFunction<Env> = async (context) => {
  const key = context.env.ADSBLOL_API_KEY;
  if (!key) return json({ error: 'not configured' }, 503);
  const params = new URL(context.request.url).searchParams;
  const callsign = cleanCallsign(params.get('callsign'));
  const lat = Math.round(Number(params.get('lat')) * 100) / 100;
  const lon = Math.round(Number(params.get('lon')) * 100) / 100;
  if (!callsign || !Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: 'callsign, lat and lon are required' }, 400);

  let hit = cache.get(callsign);
  if (!hit || Date.now() - hit.at > REUSE_MS) {
    const data = fetch(`https://api.adsb.lol/api/0/route/${callsign}/${lat}/${lon}`, { headers: { 'User-Agent': USER_AGENT, 'x-api-key': key } })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => parseRoute(callsign, body))
      .catch(() => null);
    hit = { at: Date.now(), data };
    cache.set(callsign, hit);
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  }
  const route = await hit.data;
  return json({ route });
};
