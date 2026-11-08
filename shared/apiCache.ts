// Server-side cache for the Pages Functions.
//
// Answers that expire within an hour (weather, advisories, outlooks) go to the Cloudflare Cache
// API: free, no daily write limit, kept per data center. Longer-lived answers (lore, forecast
// offices, elevation profiles, airspace) go to the LORE_KV namespace, which is shared worldwide
// but allows only 1,000 writes a day on the free plan.
//
// Neither a read nor a write ever throws: a used-up KV write budget or a cache hiccup must not
// cost a caller the answer the function just fetched.

/** TTLs at or above this go to KV; shorter ones to the Cache API. */
export const KV_MIN_TTL_SECONDS = 3600;

export interface CacheEnv {
  LORE_KV?: KVNamespace;
}

/** The parts of a Pages Function context the cache needs. */
export interface CacheContext {
  request: Request;
  env: CacheEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
}

const usesKv = (ttlSeconds: number) => ttlSeconds >= KV_MIN_TTL_SECONDS;

function edgeCache(): Cache | null {
  try {
    return typeof caches !== 'undefined' && (caches as any).default ? ((caches as any).default as Cache) : null;
  } catch {
    return null;
  }
}

/** The Cache API keys entries by URL: a path on this site that nothing serves. */
export function cacheUrl(request: Request, key: string): string {
  return `${new URL(request.url).origin}/__api-cache/${encodeURIComponent(key)}`;
}

/** A cached answer, or null when there is none or the cache could not be read. */
export async function readCache<T = any>(ctx: CacheContext, key: string, ttlSeconds: number): Promise<T | null> {
  try {
    if (usesKv(ttlSeconds)) {
      return ctx.env.LORE_KV ? ((await ctx.env.LORE_KV.get(key, { type: 'json' })) as T | null) : null;
    }
    const cache = edgeCache();
    if (!cache) return null;
    const hit = await cache.match(cacheUrl(ctx.request, key));
    return hit ? ((await hit.json()) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Stores an answer for ttlSeconds. Never throws. The write is handed to waitUntil when the
 * context has one, so the response does not wait for it; the returned promise is for tests.
 */
export function writeCache(ctx: CacheContext, key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const write = (async () => {
    try {
      const body = JSON.stringify(value);
      if (usesKv(ttlSeconds)) {
        if (ctx.env.LORE_KV) await ctx.env.LORE_KV.put(key, body, { expirationTtl: ttlSeconds });
        return;
      }
      const cache = edgeCache();
      if (!cache) return;
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttlSeconds}` };
      await cache.put(cacheUrl(ctx.request, key), new Response(body, { headers }));
    } catch {
      // Nothing to do: the next request fetches upstream again.
    }
  })();
  try {
    ctx.waitUntil?.(write);
  } catch {
    // Outside a request (tests), there is nothing to extend.
  }
  return write;
}
