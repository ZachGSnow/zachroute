import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/airsigmet
// Active US AIRMETs/SIGMETs (turbulence, icing, IFR, mountain obscuration, convection)
// as polygons from aviationweather.gov (free, no key). Trimmed, KV-cached 5 minutes.

interface Env {
  LORE_KV?: KVNamespace;
}

const CACHE_KEY = 'airsigmet:all';
const CACHE_TTL_SECONDS = 300;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' },
  });

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.env.LORE_KV) {
    const cached = await context.env.LORE_KV.get(CACHE_KEY, { type: 'json' });
    if (cached) return json(cached);
  }

  try {
    const res = await fetch('https://aviationweather.gov/api/data/airsigmet?format=json', {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return json({ advisories: [] });

    const data: any[] = (await res.json()) || [];
    const now = Math.floor(Date.now() / 1000);
    const advisories = data
      .filter((a) => a && Array.isArray(a.coords) && a.coords.length >= 3 && (!a.validTimeTo || a.validTimeTo > now))
      .map((a) => ({
        type: a.airSigmetType || 'AIRMET',
        hazard: a.hazard || 'OTHER',
        severity: a.severity ?? undefined,
        validFrom: a.validTimeFrom,
        validTo: a.validTimeTo,
        altLow: a.altitudeLow1 ?? a.altitudeLow2 ?? undefined,
        altHigh: a.altitudeHi1 ?? a.altitudeHi2 ?? undefined,
        raw: a.rawAirSigmet || undefined,
        coords: a.coords.map((c: any) => [c.lat, c.lon]),
      }));

    const result = { advisories };
    if (context.env.LORE_KV) {
      await context.env.LORE_KV.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
    }
    return json(result);
  } catch (err: any) {
    return json({ advisories: [], error: err.message || 'AIRMET/SIGMET lookup failed' });
  }
};
