import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/spc?day=1|2
// NOAA Storm Prediction Center categorical convective outlook (free, no key): where severe
// thunderstorms (large hail, damaging wind, tornadoes) are expected over the US today (day 1) or
// tomorrow (day 2), by risk category. Updated several times a day. Trimmed, KV-cached 15 minutes.

interface Env {
  LORE_KV?: KVNamespace;
}

export interface SpcArea {
  /** "TSTM", "MRGL", "SLGT", "ENH", "MDT" or "HIGH". */
  category: string;
  /** Polygons, each as [outer ring, ...holes], points [lat, lon]. */
  polygons: [number, number][][][];
}

export interface SpcOutlook {
  day: 1 | 2;
  issued?: string;
  validFrom?: string;
  validTo?: string;
  /** Lowest risk first, so higher risks draw on top. */
  areas: SpcArea[];
}

const CACHE_TTL_SECONDS = 15 * 60;
const URLS: Record<1 | 2, string> = {
  1: 'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.lyr.geojson',
  2: 'https://www.spc.noaa.gov/products/outlook/day2otlk_cat.lyr.geojson',
};
const CATEGORIES = ['TSTM', 'MRGL', 'SLGT', 'ENH', 'MDT', 'HIGH'];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function ring(points: unknown): [number, number][] {
  if (!Array.isArray(points)) return [];
  return points
    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p) => [round3(p[1]), round3(p[0])] as [number, number]);
}

function polygons(geometry: any): [number, number][][][] {
  const list = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  return (list as unknown[])
    .map((poly) => (Array.isArray(poly) ? poly.map(ring).filter((r) => r.length >= 3) : []))
    .filter((poly) => poly.length > 0);
}

/** SPC GeoJSON -> the outlook, with unknown categories dropped and areas ordered lowest risk first. */
export function buildOutlook(day: 1 | 2, data: any): SpcOutlook {
  const features: any[] = Array.isArray(data?.features) ? data.features : [];
  const p = features[0]?.properties || {};
  const areas = features
    .map((f): SpcArea => ({ category: String(f?.properties?.LABEL || '').toUpperCase(), polygons: polygons(f?.geometry) }))
    .filter((a) => CATEGORIES.includes(a.category) && a.polygons.length > 0)
    .sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
  return { day, issued: p.ISSUE_ISO, validFrom: p.VALID_ISO, validTo: p.EXPIRE_ISO, areas };
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const day = new URL(context.request.url).searchParams.get('day') === '2' ? 2 : 1;
  const key = `spc:v1:${day}`;
  if (context.env.LORE_KV) {
    const cached = await context.env.LORE_KV.get(key, { type: 'json' });
    if (cached) return json(cached);
  }
  let data: any = null;
  try {
    const res = await fetch(URLS[day], { headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' } });
    data = res.ok ? await res.json() : null;
  } catch {
    data = null;
  }
  if (!data) return json({ day, areas: [], error: 'upstream' }, 502);
  const result = buildOutlook(day, data);
  if (context.env.LORE_KV) {
    await context.env.LORE_KV.put(key, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  }
  return json(result);
};
