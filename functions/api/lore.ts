import { USER_AGENT } from '../../shared/userAgent';
import { readCache, writeCache } from '../../shared/apiCache';
import { resolveAirportLore, WikiUpstreamError } from '../../shared/wikiLore.js';
// Cloudflare Pages Function: /api/lore?iata=XXX[&title=...&name=...&lat=..&lon=..]
// Resolves the airport's Wikipedia summary (linked article first, then a checked search; see
// shared/wikiLore.js) and caches it in KV.

interface Env {
  LORE_KV?: KVNamespace;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const LORE_TTL_SECONDS = 7 * 24 * 60 * 60;

function clean(value: string | null, max: number): string | undefined {
  const v = value?.trim();
  return v ? v.slice(0, max) : undefined;
}

function coord(value: string | null, limit: number): number | undefined {
  if (value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : undefined;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const iata = clean(url.searchParams.get('iata'), 4)?.toUpperCase();

  if (!iata) {
    return new Response(JSON.stringify({ error: 'Missing iata parameter' }), { status: 400, headers: JSON_HEADERS });
  }

  const query = {
    iata,
    title: clean(url.searchParams.get('title'), 256),
    name: clean(url.searchParams.get('name'), 200),
    lat: coord(url.searchParams.get('lat'), 90),
    lon: coord(url.searchParams.get('lon'), 180),
  };

  // The answer depends on every input, so the key does too: a request can only fill the cache
  // entry that the same inputs would read back.
  const place = query.lat !== undefined && query.lon !== undefined ? `${query.lat.toFixed(2)},${query.lon.toFixed(2)}` : '';
  const cacheKey = (
    query.title ? `lore:v2:t:${query.title}:${place}` : `lore:v2:q:${iata}:${query.name || ''}:${place}`
  ).slice(0, 480);

  const cached: any = await readCache(context, cacheKey, LORE_TTL_SECONDS);
  if (cached) {
    return new Response(JSON.stringify({ ...cached, iata }), {
      headers: { ...JSON_HEADERS, 'Cache-Control': 'public, max-age=86400' },
    });
  }

  try {
    const found = await resolveAirportLore(query, { userAgent: USER_AGENT });
    if (!found) {
      return new Response(JSON.stringify({ error: 'No Wikipedia article found for this airport' }), {
        status: 404,
        headers: JSON_HEADERS,
      });
    }

    // Cache in KV (7 days) if bound
    writeCache(context, cacheKey, found, LORE_TTL_SECONDS);

    return new Response(JSON.stringify({ iata, ...found }), {
      headers: { ...JSON_HEADERS, 'Cache-Control': 'public, max-age=86400' },
    });
  } catch (err: any) {
    const limited = err instanceof WikiUpstreamError && err.status === 429;
    return new Response(JSON.stringify({ error: limited ? 'Wikipedia is busy, try again shortly' : 'Wikipedia lookup failed' }), {
      status: limited ? 503 : 502,
      headers: { ...JSON_HEADERS, ...(limited ? { 'Retry-After': '60' } : {}) },
    });
  }
};
