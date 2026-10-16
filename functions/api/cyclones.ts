import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/cyclones
// Active tropical cyclones worldwide (every ocean basin) from GDACS, the UN / European Commission
// Global Disaster Alert and Coordination System (free, no key). GDACS republishes the official
// advisories (NHC, JTWC, ...). Each storm is trimmed to its position, track and forecast
// uncertainty cone. KV-cached 30 minutes; GDACS updates storms every 6 to 12 hours.

interface Env {
  LORE_KV?: KVNamespace;
}

export interface TrackPoint {
  lat: number;
  lon: number;
  /** ISO time (UTC). */
  time: string;
  forecast: boolean;
}

export interface Cyclone {
  id: number;
  /** "Champi" */
  name: string;
  /** Strength at the latest advisory: "HU" (hurricane / typhoon), "TS", "TD" or undefined. */
  category?: string;
  /** GDACS alert level for expected impact: Green, Orange or Red. */
  alert: string;
  lat: number;
  lon: number;
  /** Time of the latest advisory (ISO, UTC). */
  asOf: string;
  /** Agency the advisory came from ("NOAA", "JTWC", ...). */
  source?: string;
  track: TrackPoint[];
  /** Forecast uncertainty cone as [lat, lon], longitudes kept continuous across the antimeridian. */
  cone?: [number, number][];
  report?: string;
}

const CACHE_KEY = 'cyclones:v1';
const CACHE_TTL_SECONDS = 30 * 60;
const EVENTS_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP';
const MAX_STORMS = 12;
const MAX_CONE_POINTS = 90;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
  });

/** GDACS times have no zone but are UTC. */
const utc = (t: string) => (/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);

/** "Tropical Cyclone CHAMPI-26" / "CHAMPI-26" -> "Champi". */
export function stormName(eventName: string): string {
  const bare = eventName.replace(/^Tropical Cyclone\s+/i, '').replace(/-\d{2}$/, '');
  return bare.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Track point labels look like "16/10 12:00 UTC" (day/month); the year comes from the advisory. */
export function trackTime(label: string, advisoryIso: string): string | undefined {
  const m = label.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return undefined;
  const adv = new Date(utc(advisoryIso));
  let year = adv.getUTCFullYear();
  const month = Number(m[2]) - 1;
  // A December advisory can forecast into January.
  if (adv.getUTCMonth() === 11 && month === 0) year += 1;
  return new Date(Date.UTC(year, month, Number(m[1]), Number(m[3]), Number(m[4]))).toISOString();
}

function ringCenter(ring: number[][]): [number, number] {
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  let lat = 0;
  let lon = 0;
  for (const [x, y] of pts) {
    lon += x;
    lat += y;
  }
  return [lat / pts.length, lon / pts.length];
}

/** GeoJSON [lon, lat] ring -> [lat, lon], thinned and unwrapped across the antimeridian. */
function toLatLonRing(ring: number[][], maxPoints: number): [number, number][] {
  const step = Math.max(1, Math.ceil(ring.length / maxPoints));
  const out: [number, number][] = [];
  for (let i = 0; i < ring.length; i += step) {
    let lon = ring[i][0];
    if (out.length > 0) {
      const prev = out[out.length - 1][1];
      while (lon - prev > 180) lon -= 360;
      while (lon - prev < -180) lon += 360;
    }
    out.push([ring[i][1], lon]);
  }
  return out;
}

const near = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) < 0.05 && Math.abs(a[1] - b[1]) < 0.05;

/** One storm from its event-list entry and its GDACS geometry collection. */
export function parseStorm(event: any, geometry: any): Cyclone {
  const p = event.properties;
  const [lon, lat] = event.geometry.coordinates;
  const asOf = utc(p.todate);
  const features: any[] = geometry?.features || [];

  const track: TrackPoint[] = features
    .filter((f) => String(f.properties?.Class).startsWith('Point_Polygon_Point') && f.geometry?.type === 'Polygon')
    .map((f) => {
      const time = trackTime(String(f.properties.polygonlabel || ''), asOf);
      const [tLat, tLon] = ringCenter(f.geometry.coordinates[0]);
      return time ? { lat: Math.round(tLat * 100) / 100, lon: Math.round(tLon * 100) / 100, time, forecast: time > asOf } : null;
    })
    .filter((t): t is TrackPoint => !!t)
    .sort((a, b) => a.time.localeCompare(b.time));

  // Strength now: the track segment that starts at the current position (or, failing that, ends there).
  const lines = features.filter((f) => String(f.properties?.Class).startsWith('Line_') && f.geometry?.type === 'LineString');
  const here = [lon, lat];
  const seg =
    lines.find((f) => near(f.geometry.coordinates[0], here)) || lines.find((f) => near(f.geometry.coordinates[f.geometry.coordinates.length - 1], here));
  const category = seg?.properties?.polygonlabel || undefined;

  const coneFeature = features.find((f) => f.properties?.Class === 'Poly_Cones' && f.geometry?.type === 'Polygon');
  const cone = coneFeature ? toLatLonRing(coneFeature.geometry.coordinates[0], MAX_CONE_POINTS) : undefined;

  return {
    id: p.eventid,
    name: stormName(p.eventname || p.name || ''),
    category,
    alert: p.alertlevel || 'Green',
    lat,
    lon,
    asOf: new Date(asOf).toISOString(),
    source: p.source || undefined,
    track,
    cone: cone && cone.length >= 3 ? cone : undefined,
    report: p.url?.report || undefined,
  };
}

/** Current tropical cyclones from the GDACS event list. */
export function currentStorms(events: any): any[] {
  return (events?.features || []).filter(
    (f: any) => f?.properties?.eventtype === 'TC' && String(f.properties.iscurrent) === 'true' && f.geometry?.type === 'Point'
  );
}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.env.LORE_KV) {
    const cached = await context.env.LORE_KV.get(CACHE_KEY, { type: 'json' });
    if (cached) return json(cached);
  }

  const events = await getJson(EVENTS_URL);
  if (!events) return json({ available: false, storms: [] });

  const list = currentStorms(events).slice(0, MAX_STORMS);
  const geometries = await Promise.all(list.map((e) => (e.properties?.url?.geometry ? getJson(e.properties.url.geometry) : null)));
  // A storm whose geometry fails still gets a position marker.
  const storms = list.map((e, i) => parseStorm(e, geometries[i]));

  const result = { available: true, storms };
  if (context.env.LORE_KV) {
    await context.env.LORE_KV.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  }
  return json(result);
};
