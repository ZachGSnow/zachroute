import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/fires?bbox=minLat,minLon,maxLat,maxLon
// Satellite fire and heat detections from the last 24 hours, worldwide, from NASA FIRMS.
// Detections include wildfires, agricultural burning and gas flares.
//   - With the FIRMS_MAP_KEY secret: VIIRS (375 m pixels) from NOAA-20, NOAA-21 and Suomi-NPP via
//     the FIRMS area API, which returns only the rectangle asked for. VIIRS pixels cover about a
//     seventh of a MODIS pixel, so each reports less fire power; detections of one pass within
//     about 1 km are summed into one fire so the intensity scale means the same as for MODIS.
//   - Without the key, or when FIRMS fails: the MODIS (1 km) near-real-time global file (free, no
//     key). Despite its "24h" name it spans about two days, so older detections are dropped. It is
//     about 1.4 MB, cached at the Cloudflare edge for 30 minutes and scanned line by line.
// The key goes in the FIRMS URL path, so no upstream URL or error text is ever returned or logged.
// Results are KV-cached 30 minutes per rectangle.

interface Env {
  LORE_KV?: KVNamespace;
  FIRMS_MAP_KEY?: string;
}

export interface Fire {
  lat: number;
  lon: number;
  /** Fire radiative power, megawatts: a measure of how intense the fire is. */
  frp: number;
  /** Detection time, ISO UTC. */
  time: string;
  /** VIIRS fires: how many 375 m detections were summed into this one. */
  pixels?: number;
}

const SOURCE_URL = 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv';
const CACHE_TTL_SECONDS = 30 * 60;
const MAX_SPAN_LAT = 40;
const MAX_SPAN_LON = 80;
/** MODIS confidence is 0-100; below 50 is mostly low-confidence noise. */
const MIN_CONFIDENCE = 50;
const MAX_FIRES = 500;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const AREA_API = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
export const VIIRS_SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT'];
/** About 1 km: VIIRS detections of one pass this close together are one fire. */
const CLUSTER_DEG = 0.01;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
  });

export interface Box {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/**
 * Scans the FIRMS CSV and returns detections inside the box with confidence >= 50 from the 24
 * hours before `now`, most intense first. Columns are located from the header, and only the
 * latitude and longitude are parsed for rows outside the box.
 */
export function parseFires(csv: string, box: Box, max = MAX_FIRES, now = Date.now()): Fire[] {
  const oldest = now - MAX_AGE_MS;
  const headerEnd = csv.indexOf('\n');
  if (headerEnd < 0) return [];
  const header = csv.slice(0, headerEnd).trim().split(',');
  const col = (name: string) => header.indexOf(name);
  const [iLat, iLon, iConf, iFrp, iDate, iTime] = ['latitude', 'longitude', 'confidence', 'frp', 'acq_date', 'acq_time'].map(col);
  if (iLat !== 0 || iLon !== 1 || iConf < 0 || iFrp < 0) return [];

  const out: Fire[] = [];
  let i = headerEnd + 1;
  while (i < csv.length) {
    let end = csv.indexOf('\n', i);
    if (end < 0) end = csv.length;
    const c1 = csv.indexOf(',', i);
    const c2 = c1 < 0 ? -1 : csv.indexOf(',', c1 + 1);
    if (c1 > 0 && c2 > 0 && c2 < end) {
      const lat = Number(csv.slice(i, c1));
      const lon = Number(csv.slice(c1 + 1, c2));
      if (lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon) {
        const cells = csv.slice(i, end).trim().split(',');
        const conf = Number(cells[iConf]);
        if (conf >= MIN_CONFIDENCE) {
          const hhmm = String(cells[iTime] || '').padStart(4, '0');
          const time = `${cells[iDate]}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`;
          if (Date.parse(time) >= oldest) out.push({ lat, lon, frp: Number(cells[iFrp]) || 0, time });
        }
      }
    }
    i = end + 1;
  }
  return out.sort((a, b) => b.frp - a.frp).slice(0, max);
}

const timeOf = (date: string, t: string) => {
  const hhmm = String(t || '').padStart(4, '0');
  return `${date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`;
};

interface Detection extends Fire {
  pass: string;
}

/**
 * FIRMS area API VIIRS CSV -> detections from the last 24 hours with nominal or high confidence
 * ("n", "h"; "l" is low). Null when the text is not a FIRMS CSV (an error message instead).
 */
export function parseViirs(csv: string, now = Date.now()): Detection[] | null {
  const lines = csv.trim().split('\n');
  const header = lines[0]?.trim().split(',') || [];
  if (header[0] !== 'latitude') return null;
  const col = (name: string) => header.indexOf(name);
  const [iLat, iLon, iDate, iTime, iSat, iConf, iFrp] = ['latitude', 'longitude', 'acq_date', 'acq_time', 'satellite', 'confidence', 'frp'].map(col);
  if ([iLat, iLon, iDate, iTime, iConf, iFrp].some((i) => i < 0)) return null;
  const oldest = now - MAX_AGE_MS;
  const out: Detection[] = [];
  for (const line of lines.slice(1)) {
    const c = line.trim().split(',');
    const conf = String(c[iConf] || '').toLowerCase();
    if (conf !== 'n' && conf !== 'h' && conf !== 'nominal' && conf !== 'high') continue;
    const lat = Number(c[iLat]);
    const lon = Number(c[iLon]);
    const time = timeOf(c[iDate], c[iTime]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(Date.parse(time) >= oldest)) continue;
    out.push({ lat, lon, frp: Number(c[iFrp]) || 0, time, pass: `${c[iSat] || ''}|${c[iDate]}|${c[iTime]}` });
  }
  return out;
}

/**
 * Sums detections of the same pass that fall in the same ~1 km cell into one fire, placed at
 * their power-weighted middle; strongest first.
 */
export function clusterViirs(dets: Detection[], max = MAX_FIRES): Fire[] {
  const groups = new Map<string, Detection[]>();
  for (const d of dets) {
    const lonStep = CLUSTER_DEG / Math.max(0.2, Math.cos((d.lat * Math.PI) / 180));
    const key = `${d.pass}|${Math.floor(d.lat / CLUSTER_DEG)}|${Math.floor(d.lon / lonStep)}`;
    const g = groups.get(key);
    if (g) g.push(d);
    else groups.set(key, [d]);
  }
  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  return [...groups.values()]
    .map((g): Fire => {
      const frp = g.reduce((s, d) => s + d.frp, 0);
      const w = frp > 0 ? (d: Detection) => d.frp / frp : () => 1 / g.length;
      return {
        lat: round(g.reduce((s, d) => s + d.lat * w(d), 0)),
        lon: round(g.reduce((s, d) => s + d.lon * w(d), 0)),
        frp: Math.round(frp * 100) / 100,
        time: g[0].time,
        pixels: g.length,
      };
    })
    .sort((a, b) => b.frp - a.frp)
    .slice(0, max);
}

/** VIIRS fires for the box from the area API, or null when no source could be read. */
async function viirsFires(key: string, box: Box): Promise<Fire[] | null> {
  const area = `${box.minLon},${box.minLat},${box.maxLon},${box.maxLat}`;
  const texts = await Promise.all(
    VIIRS_SOURCES.map(async (src) => {
      try {
        const res = await fetch(`${AREA_API}/${encodeURIComponent(key)}/${src}/${area}/1`, { headers: { 'User-Agent': USER_AGENT } });
        return res.ok ? await res.text() : null;
      } catch {
        return null; // never pass the error on: it could carry the URL, and the URL carries the key
      }
    })
  );
  const parsed = texts.map((t) => (t === null ? null : parseViirs(t)));
  if (parsed.every((p) => p === null)) return null;
  return clusterViirs(parsed.flatMap((p) => p || []));
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const raw = new URL(context.request.url).searchParams.get('bbox') || '';
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return json({ error: 'bbox must be minLat,minLon,maxLat,maxLon' }, 400);
  }
  const box: Box = {
    minLat: Math.max(-90, Math.floor(parts[0])),
    minLon: Math.max(-180, Math.floor(parts[1])),
    maxLat: Math.min(90, Math.ceil(parts[2])),
    maxLon: Math.min(180, Math.ceil(parts[3])),
  };
  if (box.maxLat - box.minLat > MAX_SPAN_LAT || box.maxLon - box.minLon > MAX_SPAN_LON) {
    return json({ error: 'bbox too large, zoom in', fires: [] }, 400);
  }

  const cacheKey = `fires:v2:${box.minLat},${box.minLon},${box.maxLat},${box.maxLon}`;
  if (context.env.LORE_KV) {
    const cached = await context.env.LORE_KV.get(cacheKey, { type: 'json' });
    if (cached) return json(cached);
  }

  const key = context.env.FIRMS_MAP_KEY;
  if (key) {
    const fires = await viirsFires(key, box);
    if (fires) {
      const result = { available: true, source: 'VIIRS', fires };
      if (context.env.LORE_KV) await context.env.LORE_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
      return json(result);
    }
  }

  try {
    // `cf` asks Cloudflare to cache the global file at the edge, so NASA sees one request per
    // half hour per location instead of one per visitor (ignored outside Cloudflare).
    const res = await fetch(SOURCE_URL, {
      headers: { 'User-Agent': USER_AGENT },
      cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
    } as RequestInit);
    if (!res.ok) return json({ available: false, fires: [] });
    const fires = parseFires(await res.text(), box);
    const result = { available: true, source: 'MODIS', fires };
    if (context.env.LORE_KV) {
      await context.env.LORE_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
    }
    return json(result);
  } catch (err: any) {
    return json({ available: false, fires: [], error: err.message || 'FIRMS lookup failed' });
  }
};
