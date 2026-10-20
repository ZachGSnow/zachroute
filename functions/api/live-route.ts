import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/live-route?callsign=AAL1696&lat=&lon=
// Where a live-tracked flight is going: the route known for a callsign, from the Virtual Radar
// Server standing data that adsb.lol publishes as one static file per callsign
// (vrs-standing-data.adsb.lol/routes/AA/AAL1696.json; community maintained, ODbL 1.0). It is often
// missing for private aircraft and sometimes wrong, so the app keeps only a leg that fits the
// aircraft's position, track and climb (src/ts/liveTrack.ts routeLeg).
// adsb.lol's route API answered 500 for every callsign tried from Cloudflare on 2026-10-20 (and its
// batch endpoint 201 with an empty body), so the static files are used; they need no key. A route
// or a definite "none" (404) is reused for 6 hours per callsign by this isolate; a failed request
// only for 2 minutes, so a passing outage does not hide routes for hours.

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
const RETRY_MS = 2 * 60 * 1000;
const cache = new Map<string, { at: number; ttl: number; data: Promise<LiveRoute | null> }>();

/** The static route file for a callsign: routes/<first 2 letters>/<callsign>.json. */
export const routeFileUrl = (callsign: string) => `https://vrs-standing-data.adsb.lol/routes/${callsign.slice(0, 2)}/${callsign}.json`;

/** For tests: forget cached routes. */
export const resetRouteCache = () => cache.clear();

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
  // Live track as a whole is off without the key, so this is too.
  if (!context.env.ADSBLOL_API_KEY) return json({ error: 'not configured' }, 503);
  const params = new URL(context.request.url).searchParams;
  const callsign = cleanCallsign(params.get('callsign'));
  const lat = Math.round(Number(params.get('lat')) * 100) / 100;
  const lon = Math.round(Number(params.get('lon')) * 100) / 100;
  if (!callsign || !Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: 'callsign, lat and lon are required' }, 400);

  let hit = cache.get(callsign);
  if (!hit || Date.now() - hit.at > hit.ttl) {
    const entry: { at: number; ttl: number; data: Promise<LiveRoute | null> } = { at: Date.now(), ttl: REUSE_MS, data: Promise.resolve(null) };
    entry.data = fetch(routeFileUrl(callsign), { headers: { 'User-Agent': USER_AGENT } })
      .then((res) => {
        if (res.status === 404) return null; // no route for this callsign: a real answer
        if (!res.ok) throw new Error(`route ${res.status}`);
        return res.json().then((body) => parseRoute(callsign, body));
      })
      .catch(() => {
        entry.ttl = RETRY_MS;
        return null;
      });
    hit = entry;
    cache.set(callsign, hit);
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  }
  const route = await hit.data;
  return json({ route });
};
