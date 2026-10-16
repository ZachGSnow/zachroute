import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/metar-bbox?bbox=minLat,minLon,maxLat,maxLon
// Every METAR station in a map rectangle in one request (flight category + wind),
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
  const cacheKey = `metarbox:${key}`;
  if (context.env.LORE_KV) {
    const cached = await context.env.LORE_KV.get(cacheKey, { type: 'json' });
    if (cached) return json(cached);
  }

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
      }));

    const result = { stations };
    if (context.env.LORE_KV) {
      await context.env.LORE_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
    }
    return json(result);
  } catch (err: any) {
    return json({ stations: [], error: err.message || 'METAR box lookup failed' });
  }
};
