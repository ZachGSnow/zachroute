import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/airspace?cell=lat,lon
// Airspace for one 4 x 4 degree cell (south-west corner lat,lon, multiples of 4). In the US, from
// the FAA's open data services (NASR; public domain, no key): class B, C and D airspace (class E
// covers most of the country and is left out), and special use airspace (prohibited, restricted,
// warning, alert, danger areas and military operations areas). Shapes are simplified to about 500 m
// and coordinates rounded. Airspace changes on the 56-day cycle, so each cell is KV-cached a day.

interface Env {
  LORE_KV?: KVNamespace;
}

/** A floor or ceiling. `ref` says what `value` is measured from. */
export interface Limit {
  /** Feet for MSL and AGL, hundreds of feet for FL; absent for SFC, UNL and NOTAM. */
  value?: number;
  ref: 'MSL' | 'AGL' | 'FL' | 'SFC' | 'UNL' | 'NOTAM';
}

export interface AirspaceArea {
  id: string;
  /** "B", "C", "D" (class) or "P", "R", "W", "A", "D-AREA" (danger), "MOA" (special use). */
  kind: string;
  name: string;
  lower: Limit;
  upper: Limit;
  /** Special use airspace: when it is active ("INTERMITTENT BY NOTAM 48 HOURS IN ADVANCE"). */
  times?: string;
  /** Polygons as [outer ring, ...holes] of [lat, lon]. */
  polygons: [number, number][][][];
}

const SERVICE = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services';
export const CELL_DEG = 4;
const SIMPLIFY_DEG = 0.005;
const CACHE_TTL_SECONDS = 24 * 60 * 60;
// Rough box around the US and its territories with FAA airspace; elsewhere the FAA is not asked.
const US_BOXES: Array<[number, number, number, number]> = [
  [17, -180, 72, -64], // the states, Alaska, Hawaii, Puerto Rico
  [12, 143, 21, 147], // Guam and the Northern Marianas
  [-15, -171, -14, -168], // American Samoa
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': status === 200 ? 'public, max-age=21600' : 'no-store' },
  });

/** "32,-120" -> the cell's corner, when it is a valid cell corner. */
export function parseCell(v: string | null): [number, number] | null {
  const m = (v || '').match(/^(-?\d+),(-?\d+)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (lat % CELL_DEG || lon % CELL_DEG || lat < -88 || lat > 84 || lon < -180 || lon > 176) return null;
  return [lat, lon];
}

export function cellTouchesUs([lat, lon]: [number, number]): boolean {
  return US_BOXES.some(([s, w, n, e]) => lat + CELL_DEG >= s && lat <= n && lon + CELL_DEG >= w && lon <= e);
}

/** An FAA floor or ceiling (value, code, unit) in one shape. */
export function faaLimit(value: unknown, code: unknown, uom: unknown): Limit {
  const c = String(code || '').toUpperCase();
  const v = Number(value);
  if (c === 'UNLTD' || v === -9998) return { ref: 'UNL' };
  if (c === 'BYNOTAM') return { ref: 'NOTAM' };
  if (!Number.isFinite(v)) return { ref: 'SFC' };
  if (c === 'STD' || String(uom).toUpperCase() === 'FL') return { value: v >= 1000 ? Math.round(v / 100) : v, ref: 'FL' };
  if (c === 'SFC') return v > 0 ? { value: v, ref: 'AGL' } : { ref: 'SFC' };
  return { value: v, ref: 'MSL' };
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

function polygons(geometry: any): [number, number][][][] {
  const list = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  return (list as any[])
    .map((poly) =>
      (Array.isArray(poly) ? poly : [])
        .map((ring: any[]) => ring.filter((p) => Array.isArray(p)).map((p) => [round4(p[1]), round4(p[0])] as [number, number]))
        .filter((r: [number, number][]) => r.length >= 3)
    )
    .filter((p) => p.length > 0);
}

const SUA_KINDS: Record<string, string> = { P: 'P', R: 'R', W: 'W', A: 'A', D: 'D-AREA', MOA: 'MOA' };

/** FAA class airspace GeoJSON -> areas (classes B, C, D). */
export function classAreas(data: any): AirspaceArea[] {
  return (Array.isArray(data?.features) ? data.features : []).flatMap((f: any): AirspaceArea[] => {
    const p = f?.properties || {};
    const kind = String(p.CLASS || '').toUpperCase();
    const polys = polygons(f.geometry);
    if (!['B', 'C', 'D'].includes(kind) || !polys.length) return [];
    return [
      {
        id: String(p.GLOBAL_ID || f.id || p.NAME),
        kind,
        name: String(p.NAME || `Class ${kind}`),
        lower: faaLimit(p.LOWER_VAL, p.LOWER_CODE, p.LOWER_UOM),
        upper: faaLimit(p.UPPER_VAL, p.UPPER_CODE, p.UPPER_UOM),
        polygons: polys,
      },
    ];
  });
}

/** FAA special use airspace GeoJSON -> areas. */
export function specialUseAreas(data: any): AirspaceArea[] {
  return (Array.isArray(data?.features) ? data.features : []).flatMap((f: any): AirspaceArea[] => {
    const p = f?.properties || {};
    const kind = SUA_KINDS[String(p.TYPE_CODE || '').toUpperCase()];
    const polys = polygons(f.geometry);
    if (!kind || !polys.length) return [];
    return [
      {
        id: String(p.GLOBAL_ID || f.id || p.NAME),
        kind,
        name: String(p.NAME || kind),
        lower: faaLimit(p.LOWER_VAL, p.LOWER_CODE, p.LOWER_UOM),
        upper: faaLimit(p.UPPER_VAL, p.UPPER_CODE, p.UPPER_UOM),
        times: typeof p.TIMESOFUSE === 'string' && p.TIMESOFUSE.trim() ? p.TIMESOFUSE.trim() : undefined,
        polygons: polys,
      },
    ];
  });
}

function query(layer: string, where: string, fields: string, [lat, lon]: [number, number]): string {
  const q = new URLSearchParams({
    where,
    geometry: `${lon},${lat},${lon + CELL_DEG},${lat + CELL_DEG}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: fields,
    outSR: '4326',
    maxAllowableOffset: String(SIMPLIFY_DEG),
    geometryPrecision: '4',
    f: 'geojson',
  });
  return `${SERVICE}/${layer}/FeatureServer/0/query?${q.toString()}`;
}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return null;
    const data: any = await res.json();
    return data && !data.error ? data : null;
  } catch {
    return null;
  }
}

const LIMIT_FIELDS = 'UPPER_VAL,UPPER_CODE,UPPER_UOM,LOWER_VAL,LOWER_CODE,LOWER_UOM';

export const onRequest: PagesFunction<Env> = async (context) => {
  const cell = parseCell(new URL(context.request.url).searchParams.get('cell'));
  if (!cell) return json({ error: `cell must be lat,lon of a ${CELL_DEG}-degree cell corner` }, 400);
  if (!cellTouchesUs(cell)) return json({ areas: [], complete: true, sources: [] });

  const key = `airspace:v1:${cell.join(',')}`;
  if (context.env.LORE_KV) {
    const cached = await context.env.LORE_KV.get(key, { type: 'json' });
    if (cached) return json(cached);
  }
  const [cls, sua] = await Promise.all([
    getJson(query('Class_Airspace', "CLASS IN ('B','C','D')", `GLOBAL_ID,NAME,CLASS,${LIMIT_FIELDS}`, cell)),
    getJson(query('Special_Use_Airspace', '1=1', `GLOBAL_ID,NAME,TYPE_CODE,TIMESOFUSE,${LIMIT_FIELDS}`, cell)),
  ]);
  const result = { areas: [...specialUseAreas(sua), ...classAreas(cls)], complete: !!cls && !!sua, sources: ['FAA'] };
  if (result.complete && context.env.LORE_KV) {
    await context.env.LORE_KV.put(key, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  }
  return json(result);
};
