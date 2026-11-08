import { USER_AGENT } from '../../shared/userAgent';
import { readCache, writeCache } from '../../shared/apiCache';
// Cloudflare Pages Function: /api/metar-bbox?bbox=minLat,minLon,maxLat,maxLon
// Every METAR station in a map rectangle in one request (flight category, wind, temperature),
// for the map's weather layer. Trimmed and KV-cached 5 minutes per rounded box.

interface Env {
  LORE_KV?: KVNamespace;
}

const CACHE_TTL_SECONDS = 300;
const MAX_SPAN_DEG = 40;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' },
  });

export const onRequest: PagesFunction<Env> = async (context) => {
  const raw = new URL(context.request.url).searchParams.get('bbox') || '';
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return json({ error: 'bbox must be minLat,minLon,maxLat,maxLon' }, 400);
  }
  let [minLat, minLon, maxLat, maxLon] = parts;
  minLat = Math.max(-90, Math.floor(minLat));
  maxLat = Math.min(90, Math.ceil(maxLat));
  minLon = Math.max(-180, Math.floor(minLon));
  maxLon = Math.min(180, Math.ceil(maxLon));
  if (maxLat - minLat > MAX_SPAN_DEG || maxLon - minLon > MAX_SPAN_DEG * 2) {
    return json({ error: 'bbox too large, zoom in', stations: [] }, 400);
  }

  const key = `${minLat},${minLon},${maxLat},${maxLon}`;
  const cacheKey = `metarbox:v2:${key}`; // v2: stations carry temperature and dewpoint
  const cached = await readCache(context, cacheKey, CACHE_TTL_SECONDS);
  if (cached) return json(cached);

  try {
    const res = await fetch(`https://aviationweather.gov/api/data/metar?bbox=${key}&format=json`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return json({ stations: [] });

    const data: any[] = (await res.json()) || [];
    const stations = data
      .filter((m) => m && typeof m.lat === 'number' && typeof m.lon === 'number' && m.icaoId)
      .map((m) => ({
        id: m.icaoId,
        lat: Math.round(m.lat * 1000) / 1000,
        lon: Math.round(m.lon * 1000) / 1000,
        cat: m.fltCat || undefined,
        wd: typeof m.wdir === 'number' ? m.wdir : undefined,
        ws: typeof m.wspd === 'number' ? m.wspd : undefined,
        wg: typeof m.wgst === 'number' ? m.wgst : undefined,
        t: typeof m.temp === 'number' ? m.temp : undefined, // degrees C
        d: typeof m.dewp === 'number' ? m.dewp : undefined, // degrees C
      }));

    const result = { stations };
    writeCache(context, cacheKey, result, CACHE_TTL_SECONDS);
    return json(result);
  } catch {
    return json({ stations: [], error: 'METAR box lookup failed' });
  }
};
