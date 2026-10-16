import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/pireps
//   ?icao=XXXX                      pilot reports within 75nm of an airport (last 3 hours)
//   ?bbox=minLat,minLon,maxLat,maxLon  notable pilot reports in a map rectangle (map layer / route corridor)
// Source: aviationweather.gov (free, no key). KV-cached 5 minutes.
// Bbox mode returns only notable reports (turbulence, icing, low visibility) to keep the payload small.

interface Env {
  LORE_KV?: KVNamespace;
}

const CACHE_TTL_SECONDS = 300;
const MAX_SPAN_LAT = 40;
const MAX_SPAN_LON = 80;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' },
  });

const NONE = new Set(['', 'NEG', 'SMTH', 'NONE']);

function isNotable(p: any): boolean {
  const turb = String(p.tbInt1 || '').toUpperCase();
  const ice = String(p.icgInt1 || '').toUpperCase();
  const lowVis = typeof p.visib === 'number' && p.visib < 3;
  return !NONE.has(turb) || !NONE.has(ice) || lowVis;
}

function trim(p: any) {
  return {
    obsTime: p.obsTime,
    acType: p.acType || undefined,
    lat: p.lat,
    lon: p.lon,
    fltLvl: typeof p.fltLvl === 'number' ? p.fltLvl : undefined,
    urgent: p.pirepType === 'UUA' || undefined,
    turb: p.tbInt1 || undefined,
    icing: p.icgInt1 || undefined,
    icingType: p.icgType1 || undefined,
    visib: p.visib ?? undefined,
    wxString: p.wxString || undefined,
    raw: p.rawOb || undefined,
  };
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const params = new URL(context.request.url).searchParams;
  const icao = params.get('icao')?.toUpperCase();
  const bboxRaw = params.get('bbox');

  let upstream: string;
  let cacheKey: string;
  let notableOnly = false;

  if (bboxRaw) {
    const parts = bboxRaw.split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      return json({ error: 'bbox must be minLat,minLon,maxLat,maxLon' }, 400);
    }
    const minLat = Math.max(-90, Math.floor(parts[0]));
    const minLon = Math.max(-180, Math.floor(parts[1]));
    const maxLat = Math.min(90, Math.ceil(parts[2]));
    const maxLon = Math.min(180, Math.ceil(parts[3]));
    if (maxLat - minLat > MAX_SPAN_LAT || maxLon - minLon > MAX_SPAN_LON) {
      return json({ error: 'bbox too large, zoom in', reports: [] }, 400);
    }
    const key = `${minLat},${minLon},${maxLat},${maxLon}`;
    upstream = `https://aviationweather.gov/api/data/pirep?bbox=${key}&age=3&format=json`;
    cacheKey = `pirepbox:${key}`;
    notableOnly = true;
  } else if (icao && /^[A-Z0-9]{3,4}$/.test(icao)) {
    upstream = `https://aviationweather.gov/api/data/pirep?id=${encodeURIComponent(icao)}&distance=75&age=3&format=json`;
    cacheKey = `pirep:${icao}`;
  } else {
    return json({ error: 'Provide icao or bbox' }, 400);
  }

  if (context.env.LORE_KV) {
    const cached = await context.env.LORE_KV.get(cacheKey, { type: 'json' });
    if (cached) return json(cached);
  }

  try {
    const res = await fetch(upstream, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return json({ available: false, reports: [] });

    const data: any[] = (await res.json()) || [];
    const reports = data
      .filter((p) => p && typeof p.lat === 'number' && typeof p.lon === 'number')
      .filter((p) => !notableOnly || isNotable(p))
      .map(trim)
      .sort((a, b) => b.obsTime - a.obsTime)
      .slice(0, notableOnly ? 300 : 40);

    const result = { available: true, reports };
    if (context.env.LORE_KV) {
      await context.env.LORE_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
    }
    return json(result);
  } catch (err: any) {
    return json({ available: false, reports: [], error: err.message || 'PIREP lookup failed' });
  }
};
