// OpenAIP airspace (one country's export GeoJSON) -> the app's airspace areas, split into 4-degree
// cells. Pure functions, shared by the build script (scripts/openaip_airspace.js) and its tests.
// OpenAIP data is CC BY-NC 4.0: free for non-commercial use with credit to openAIP.

export const CELL_DEG = 4;
/** About 500 m: shapes are simplified to this before drawing at airspace zooms. */
export const SIMPLIFY_DEG = 0.005;

// OpenAIP airspace "type" codes (api.core.openaip.net schema).
const TYPE = { RESTRICTED: 1, DANGER: 2, PROHIBITED: 3, CTR: 4, TMA: 7, ATZ: 13, MATZ: 14, CTA: 26, MCTR: 36 };
/** Kept types: restricted, danger, prohibited, and the controlled airspace around airports and airways. */
export const KEPT_TYPES = new Set(Object.values(TYPE));
const CLASS_KIND = { 0: 'CLASS-A', 1: 'B', 2: 'C', 3: 'D', 4: 'CLASS-E' };

/** The app's kind for an OpenAIP airspace: special use by type, controlled airspace by ICAO class. */
export function kindOf(type, icaoClass) {
  if (type === TYPE.PROHIBITED) return 'P';
  if (type === TYPE.RESTRICTED) return 'R';
  if (type === TYPE.DANGER) return 'D-AREA';
  return CLASS_KIND[icaoClass] || 'CTL';
}

const M_TO_FT = 3.28084;

/** OpenAIP limit {value, unit (0 m, 1 ft, 6 FL), referenceDatum (0 GND, 1 MSL, 2 STD)} -> the app's Limit. */
export function limitOf(limit) {
  const v = Number(limit?.value);
  if (!Number.isFinite(v)) return { ref: 'SFC' };
  if (limit.unit === 6 || limit.referenceDatum === 2) return { value: Math.round(v), ref: 'FL' };
  const ft = Math.round(limit.unit === 0 ? v * M_TO_FT : v);
  if (limit.referenceDatum === 0) return ft > 0 ? { value: ft, ref: 'AGL' } : { ref: 'SFC' };
  return { value: ft, ref: 'MSL' };
}

/** Perpendicular distance (degrees) from p to the segment a-b. */
function segDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas-Peucker simplification of one ring of [x, y] points. */
export function simplifyRing(ring, tol = SIMPLIFY_DEG) {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let max = 0;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(ring[k], ring[i], ring[j]);
      if (d > max) {
        max = d;
        at = k;
      }
    }
    if (max > tol && at > 0) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return ring.filter((_, k) => keep[k]);
}

const round4 = (n) => Math.round(n * 1e4) / 1e4;

/** GeoJSON Polygon / MultiPolygon -> simplified [outer, ...holes] polygons of [lat, lon]. */
export function polygonsOf(geometry) {
  const list = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  return list
    .map((poly) =>
      (Array.isArray(poly) ? poly : [])
        .map((ring) => simplifyRing(ring.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))))
        .filter((ring) => ring.length >= 4)
        .map((ring) => ring.map(([lon, lat]) => [round4(lat), round4(lon)]))
    )
    .filter((poly) => poly.length > 0);
}

/** "by NOTAM", "on request", "on demand" when activation is not permanent. */
function activation(p) {
  const parts = [p.byNotam && 'by NOTAM', p.onRequest && 'on request', p.onDemand && 'on demand'].filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
}

/** One country's OpenAIP export -> the app's airspace areas (kept types only). */
export function areasFrom(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const out = [];
  for (const f of features) {
    const p = f?.properties || {};
    if (!KEPT_TYPES.has(p.type)) continue;
    const polygons = polygonsOf(f.geometry);
    if (!polygons.length) continue;
    out.push({
      id: `oaip:${p._id || p.name}`,
      kind: kindOf(p.type, p.icaoClass),
      name: String(p.name || ''),
      lower: limitOf(p.lowerLimit),
      upper: limitOf(p.upperLimit),
      times: activation(p),
      country: p.country || undefined,
      polygons,
    });
  }
  return out;
}

/** "lat_lon" names of the 4-degree cells an area's outline touches. */
export function cellsOf(area) {
  let s = 90;
  let n = -90;
  let w = 180;
  let e = -180;
  for (const poly of area.polygons) {
    for (const [lat, lon] of poly[0]) {
      s = Math.min(s, lat);
      n = Math.max(n, lat);
      w = Math.min(w, lon);
      e = Math.max(e, lon);
    }
  }
  const out = [];
  // An area spanning the date line (or nearly the whole world) is listed by its outline's west part only.
  if (e - w > 180) e = w;
  for (let lat = Math.floor(s / CELL_DEG) * CELL_DEG; lat <= n; lat += CELL_DEG) {
    for (let lon = Math.floor(w / CELL_DEG) * CELL_DEG; lon <= e; lon += CELL_DEG) out.push(`${lat}_${lon}`);
  }
  return out;
}

/** Areas from many countries -> { "lat_lon": areas[] }. */
export function splitIntoCells(areas) {
  const cells = {};
  for (const a of areas) for (const c of cellsOf(a)) (cells[c] ||= []).push(a);
  return cells;
}
