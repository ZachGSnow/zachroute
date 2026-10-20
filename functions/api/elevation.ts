import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/elevation?from=lat,lon&to=lat,lon
// Terrain height along the great circle between two points, for the route terrain profile, from
// the Open-Meteo elevation API (about 90 m terrain data; free, no key; 100 points per request).
// Points are about every 5 miles, at least 20 and at most 200. Terrain does not change, so each
// route is KV-cached 30 days and shared by everyone who looks it up.

interface Env {
  LORE_KV?: KVNamespace;
}

export interface ElevationProfile {
  /** [lat, lon] of each sample, origin first. */
  points: [number, number][];
  /** Meters above sea level at each point (sea is 0). */
  elevationsM: number[];
  /** Miles between samples. */
  spacingMi: number;
}

const API = 'https://api.open-meteo.com/v1/elevation';
const BATCH = 100;
const MIN_POINTS = 20;
const MAX_POINTS = 200;
const TARGET_SPACING_MI = 5;
const EARTH_RADIUS_MI = 3958.8;
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': status === 200 ? 'public, max-age=86400' : 'no-store' },
  });

/** "41.98,-87.9" -> [41.98, -87.9], or null when not a valid position. */
export function parsePoint(v: string | null): [number, number] | null {
  const m = (v || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in miles. */
export function distanceMi(a: [number, number], b: [number, number]): number {
  const [lat1, lon1, lat2, lon2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** `count` points evenly along the great circle, both ends included, rounded to 4 decimals. */
export function greatCirclePoints(a: [number, number], b: [number, number], count: number): [number, number][] {
  const [lat1, lon1, lat2, lon2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const d = distanceMi(a, b) / EARTH_RADIUS_MI;
  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  if (d === 0) return [a, b];
  return Array.from({ length: count }, (_, i) => {
    const f = i / (count - 1);
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    return [round(deg(Math.atan2(z, Math.hypot(x, y)))), round(deg(Math.atan2(y, x)))] as [number, number];
  });
}

/** How many samples for a route: about every 5 miles, 20 to 200. */
export function sampleCount(miles: number): number {
  return Math.max(MIN_POINTS, Math.min(MAX_POINTS, Math.ceil(miles / TARGET_SPACING_MI) + 1));
}

async function elevations(points: [number, number][]): Promise<number[] | null> {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += BATCH) {
    const chunk = points.slice(i, i + BATCH);
    const url = `${API}?latitude=${chunk.map((p) => p[0]).join(',')}&longitude=${chunk.map((p) => p[1]).join(',')}`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) return null;
      const data: any = await res.json();
      const e = data?.elevation;
      if (!Array.isArray(e) || e.length !== chunk.length) return null;
      out.push(...e.map((v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0)));
    } catch {
      return null;
    }
  }
  return out;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const q = new URL(context.request.url).searchParams;
  const from = parsePoint(q.get('from'));
  const to = parsePoint(q.get('to'));
  if (!from || !to) return json({ error: 'from and to must be lat,lon' }, 400);

  const key = `elev:v1:${from.map((n) => n.toFixed(3)).join(',')}:${to.map((n) => n.toFixed(3)).join(',')}`;
  if (context.env.LORE_KV) {
    const cached = await context.env.LORE_KV.get(key, { type: 'json' });
    if (cached) return json(cached);
  }
  const miles = distanceMi(from, to);
  const count = sampleCount(miles);
  const points = greatCirclePoints(from, to, count);
  const elevationsM = await elevations(points);
  if (!elevationsM) return json({ error: 'upstream' }, 502);
  const result: ElevationProfile = { points, elevationsM, spacingMi: Math.round((miles / (count - 1)) * 10) / 10 };
  if (context.env.LORE_KV) await context.env.LORE_KV.put(key, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  return json(result);
};
