import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/fires?bbox=minLat,minLon,maxLat,maxLon
// Satellite fire and heat detections from the last 24 hours, worldwide, from NASA FIRMS (MODIS
// near-real-time global file; free, no key). Detections include wildfires, agricultural burning
// and gas flares. The global file is about 1 MB; it is cached at the Cloudflare edge for 30
// minutes and scanned line by line, keeping only the requested rectangle, to stay within a
// function's CPU budget. Results are KV-cached 30 minutes per rectangle.

interface Env {
  LORE_KV?: KVNamespace;
}

export interface Fire {
  lat: number;
  lon: number;
  /** Fire radiative power, megawatts: a measure of how intense the fire is. */
  frp: number;
  /** Detection time, ISO UTC. */
  time: string;
}

const SOURCE_URL = 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv';
const CACHE_TTL_SECONDS = 30 * 60;
const MAX_SPAN_LAT = 40;
const MAX_SPAN_LON = 80;
/** MODIS confidence is 0-100; below 50 is mostly low-confidence noise. */
const MIN_CONFIDENCE = 50;
const MAX_FIRES = 500;

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
 * Scans the FIRMS CSV and returns detections inside the box with confidence >= 50, most intense
 * first. Columns are located from the header, and only the latitude and longitude are parsed
 * for rows outside the box.
 */
export function parseFires(csv: string, box: Box, max = MAX_FIRES): Fire[] {
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
          out.push({
            lat,
            lon,
            frp: Number(cells[iFrp]) || 0,
            time: `${cells[iDate]}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`,
          });
        }
      }
    }
    i = end + 1;
  }
  return out.sort((a, b) => b.frp - a.frp).slice(0, max);
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

  const cacheKey = `fires:${box.minLat},${box.minLon},${box.maxLat},${box.maxLon}`;
  if (context.env.LORE_KV) {
    const cached = await context.env.LORE_KV.get(cacheKey, { type: 'json' });
    if (cached) return json(cached);
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
    const result = { available: true, fires };
    if (context.env.LORE_KV) {
      await context.env.LORE_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
    }
    return json(result);
  } catch (err: any) {
    return json({ available: false, fires: [], error: err.message || 'FIRMS lookup failed' });
  }
};
