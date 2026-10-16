import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/weather?icao=XXXX
// Resolves current METAR conditions via aviationweather.gov's public Data API
// (no key required) and caches briefly in KV - weather goes stale fast, so this
// uses a much shorter TTL than the lore cache (10 minutes vs 7 days).

interface Env {
  LORE_KV?: KVNamespace;
}

const CACHE_TTL_SECONDS = 600; // 10 minutes

function computeCeiling(clouds: any): { ceilingFt?: number; ceilingCover?: string } {
  if (!Array.isArray(clouds)) return {};
  const layers = clouds.filter(
    (c: any) => c && (c.cover === 'BKN' || c.cover === 'OVC') && typeof c.base === 'number'
  );
  if (layers.length === 0) return {};
  const lowest = layers.reduce((a: any, b: any) => (a.base < b.base ? a : b));
  return { ceilingFt: lowest.base, ceilingCover: lowest.cover };
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const icao = url.searchParams.get('icao')?.toUpperCase();

  if (!icao) {
    return new Response(JSON.stringify({ error: 'Missing icao parameter' }), { status: 400 });
  }

  const cacheKey = `weather:${icao}`;

  if (context.env.LORE_KV) {
    const cached = await context.env.LORE_KV.get(cacheKey, { type: 'json' });
    if (cached) {
      return new Response(JSON.stringify(cached), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
      });
    }
  }

  try {
    const metarUrl = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(icao)}&format=json`;
    const res = await fetch(metarUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ available: false }), { status: 200 });
    }

    const data: any[] = await res.json();
    const ob = data?.[0];

    let result: Record<string, unknown>;

    if (!ob) {
      result = { available: false };
    } else {
      result = {
        available: true,
        flightCategory: ob.fltCat || undefined,
        windDirDeg: typeof ob.wdir === 'number' ? ob.wdir : undefined,
        windSpeedKt: typeof ob.wspd === 'number' ? ob.wspd : undefined,
        windGustKt: typeof ob.wgst === 'number' ? ob.wgst : undefined,
        visibility: ob.visib !== undefined ? String(ob.visib) : undefined,
        tempF: typeof ob.temp === 'number' ? Math.round((ob.temp * 9) / 5 + 32) : undefined,
        dewpointF: typeof ob.dewp === 'number' ? Math.round((ob.dewp * 9) / 5 + 32) : undefined,
        // As reported (whole degrees C, hPa), so metric display is not converted twice.
        tempC: typeof ob.temp === 'number' ? ob.temp : undefined,
        dewpointC: typeof ob.dewp === 'number' ? ob.dewp : undefined,
        weatherPhenomena: ob.wxString || undefined,
        ...computeCeiling(ob.clouds),
        altimeterInHg: typeof ob.altim === 'number' ? Math.round(ob.altim * 0.0295299 * 100) / 100 : undefined,
        altimeterHpa: typeof ob.altim === 'number' ? Math.round(ob.altim) : undefined,
        rawText: ob.rawOb || undefined,
        observedIso: ob.reportTime || undefined,
      };
    }

    if (context.env.LORE_KV) {
      await context.env.LORE_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
    }

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ available: false, error: err.message || 'Weather lookup failed' }), {
      status: 200,
    });
  }
};
