import { USER_AGENT } from '../../shared/userAgent';
import { readCache, writeCache } from '../../shared/apiCache';
// Cloudflare Pages Function: /api/taf?icao=XXXX
// Terminal Aerodrome Forecast from aviationweather.gov (free, no key), trimmed to
// the fields the client decodes into plain English. Edge-cached 15 minutes.

interface Env {
  LORE_KV?: KVNamespace;
}

const CACHE_TTL_SECONDS = 900;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });

export const onRequest: PagesFunction<Env> = async (context) => {
  const icao = new URL(context.request.url).searchParams.get('icao')?.toUpperCase();
  if (!icao || !/^[A-Z0-9]{3,4}$/.test(icao)) {
    return new Response(JSON.stringify({ error: 'Missing or invalid icao parameter' }), { status: 400 });
  }

  const cacheKey = `taf:${icao}`;
  const cached = await readCache(context, cacheKey, CACHE_TTL_SECONDS);
  if (cached) return json(cached);

  try {
    const res = await fetch(`https://aviationweather.gov/api/data/taf?ids=${encodeURIComponent(icao)}&format=json`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return json({ available: false });

    const data: any[] = await res.json();
    const taf = data?.[0];
    let result: Record<string, unknown>;

    if (!taf || !Array.isArray(taf.fcsts)) {
      result = { available: false };
    } else {
      result = {
        available: true,
        issueTime: taf.issueTime || undefined,
        validFrom: taf.validTimeFrom,
        validTo: taf.validTimeTo,
        rawText: taf.rawTAF || undefined,
        periods: taf.fcsts.map((f: any) => ({
          from: f.timeFrom,
          to: f.timeTo,
          change: f.fcstChange || undefined,
          probability: f.probability ?? undefined,
          wdir: f.wdir ?? undefined,
          wspd: f.wspd ?? undefined,
          wgst: f.wgst ?? undefined,
          wshearSpd: f.wshearSpd ?? undefined,
          wshearHgt: f.wshearHgt ?? undefined,
          visib: f.visib !== undefined && f.visib !== null ? String(f.visib) : undefined,
          wxString: f.wxString || undefined,
          clouds: Array.isArray(f.clouds)
            ? f.clouds.map((c: any) => ({ cover: c.cover, base: c.base ?? undefined }))
            : [],
        })),
      };
    }

    writeCache(context, cacheKey, result, CACHE_TTL_SECONDS);
    return json(result);
  } catch {
    return json({ available: false, error: 'TAF lookup failed' });
  }
};
