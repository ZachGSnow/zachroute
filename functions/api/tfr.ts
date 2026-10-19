import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/tfr
// US temporary flight restrictions (TFRs) with their shapes, from the FAA (free, no key): the
// FAA's map service for the polygons, joined with its current TFR list to keep only active ones.
// Altitudes and exact times are only in each TFR's own file, so this links to the FAA page for
// those. Trimmed, KV-cached 10 minutes.

interface Env {
  LORE_KV?: KVNamespace;
}

export interface Tfr {
  id: string; // NOTAM number, "6/9169"
  type: string; // "SECURITY", "VIP", "HAZARDS", ...
  description: string; // "RALEIGH, NC, Thursday, October 15, 2026 through Sunday, October 25, 2026 Local"
  state?: string;
  url: string; // FAA detail page
  rings: [number, number][][]; // [lat, lon] rings
}

const CACHE_KEY = 'tfr:v1';
const CACHE_TTL_SECONDS = 600;

const SHAPES_URL =
  'https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&maxFeatures=1000&outputFormat=application/json&srsname=EPSG:4326';
const LIST_URL = 'https://tfr.faa.gov/tfrapi/exportTfrList';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });

/** "6/9169-1-FDC-F" -> "6/9169". */
export function notamId(key: unknown): string | null {
  const m = typeof key === 'string' ? key.match(/^(\d+\/\d+)/) : null;
  return m ? m[1] : null;
}

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** GeoJSON Polygon / MultiPolygon outer rings as [lat, lon]. */
function outerRings(geometry: any): [number, number][][] {
  if (!geometry) return [];
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polys
    .map((poly: any) => (Array.isArray(poly?.[0]) ? poly[0] : []))
    .map((ring: any[]) =>
      ring.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [round5(p[1]), round5(p[0])] as [number, number])
    )
    .filter((ring: [number, number][]) => ring.length >= 3);
}

/**
 * Joins the FAA shapes with its TFR list. `active` is the set of NOTAM numbers on the list; when
 * the list could not be read (null), every shape is kept. Several shapes of one TFR are merged.
 */
export function buildTfrs(features: any[], active: Map<string, any> | null): Tfr[] {
  const byId = new Map<string, Tfr>();
  for (const f of features) {
    const id = notamId(f?.properties?.NOTAM_KEY);
    if (!id || (active && !active.has(id))) continue;
    const rings = outerRings(f.geometry);
    if (!rings.length) continue;
    const listed = active?.get(id);
    const existing = byId.get(id);
    if (existing) {
      existing.rings.push(...rings);
      continue;
    }
    byId.set(id, {
      id,
      type: String(listed?.type || f.properties.LEGAL || 'TFR').toUpperCase(),
      description: String(listed?.description || f.properties.TITLE || '').trim(),
      state: listed?.state || f.properties.STATE || undefined,
      url: `https://tfr.faa.gov/tfr3/?page=detail_${id.replace('/', '_')}`,
      rings,
    });
  }
  return [...byId.values()];
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

  const [shapes, list] = await Promise.all([getJson(SHAPES_URL), getJson(LIST_URL)]);
  const features: any[] = Array.isArray(shapes?.features) ? shapes.features : [];
  const active = Array.isArray(list) ? new Map(list.map((t: any) => [String(t.notam_id), t])) : null;
  const result = { tfrs: buildTfrs(features, active), complete: !!shapes && !!active };

  // Only cache a complete answer, so one FAA endpoint being down does not stick for ten minutes.
  if (result.complete && context.env.LORE_KV) {
    await context.env.LORE_KV.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  }
  return json(result);
};
