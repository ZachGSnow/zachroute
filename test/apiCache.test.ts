// The Functions' shared cache: short answers in the Cache API, long ones in KV, and a failed
// read or write never costs a caller the answer it just fetched.
import { describe, expect, it, vi } from 'vitest';
import { jsonFixture, stubFetch } from './helpers';
import { KV_MIN_TTL_SECONDS, cacheUrl, readCache, writeCache } from '../shared/apiCache';
import { onRequest as weather } from '../functions/api/weather';
import { onRequest as taf } from '../functions/api/taf';
import { onRequest as lore } from '../functions/api/lore';

const json = async (res: Response) => res.json() as Promise<any>;

/** A Cache API stand-in (caches.default) backed by a Map. */
function stubEdgeCache(opts: { failPut?: boolean } = {}) {
  const store = new Map<string, string>();
  const cache = {
    match: vi.fn(async (url: string) => (store.has(url) ? new Response(store.get(url)) : undefined)),
    put: vi.fn(async (url: string, res: Response) => {
      if (opts.failPut) throw new Error('cache put failed');
      store.set(url, await res.text());
    }),
  };
  vi.stubGlobal('caches', { default: cache });
  return { store, cache };
}

/** A KV stand-in; failPut mimics the free plan's daily write limit being used up. */
function fakeKv(opts: { failPut?: boolean; failGet?: boolean } = {}) {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => {
      if (opts.failGet) throw new Error('KV get failed');
      return store.has(k) ? JSON.parse(store.get(k)!) : null;
    }),
    put: vi.fn(async (k: string, v: string) => {
      if (opts.failPut) throw new Error('KV put() limit exceeded for the day.');
      store.set(k, v);
    }),
  };
}

const ctx = (url: string, env: any = {}, waitUntil?: (p: Promise<unknown>) => void) =>
  ({ request: new Request(url), env, waitUntil }) as any;

describe('shared/apiCache', () => {
  it('keeps answers shorter than an hour in the Cache API and never writes them to KV', async () => {
    const { store } = stubEdgeCache();
    const kv = fakeKv();
    const c = ctx('https://zachroute.example/api/taf?icao=KORD', { LORE_KV: kv });
    await writeCache(c, 'taf:KORD', { ok: 1 }, 900);
    expect(kv.put).not.toHaveBeenCalled();
    expect([...store.keys()]).toEqual([cacheUrl(c.request, 'taf:KORD')]);
    expect(cacheUrl(c.request, 'taf:KORD')).toBe('https://zachroute.example/__api-cache/taf%3AKORD');
    expect(await readCache(c, 'taf:KORD', 900)).toEqual({ ok: 1 });
  });

  it('keeps answers of an hour or more in KV, with the TTL as its expiry', async () => {
    const { cache } = stubEdgeCache();
    const kv = fakeKv();
    const c = ctx('https://x/api/lore', { LORE_KV: kv });
    await writeCache(c, 'lore:k', { a: 1 }, KV_MIN_TTL_SECONDS);
    expect(cache.put).not.toHaveBeenCalled();
    expect(kv.put).toHaveBeenCalledWith('lore:k', '{"a":1}', { expirationTtl: KV_MIN_TTL_SECONDS });
    expect(await readCache(c, 'lore:k', KV_MIN_TTL_SECONDS)).toEqual({ a: 1 });
  });

  it('swallows a failed KV write or read instead of throwing', async () => {
    const c = ctx('https://x/', { LORE_KV: fakeKv({ failPut: true, failGet: true }) });
    await expect(writeCache(c, 'k', 1, 86400)).resolves.toBeUndefined();
    await expect(readCache(c, 'k', 86400)).resolves.toBeNull();
  });

  it('hands the write to waitUntil so the response does not wait for it', async () => {
    stubEdgeCache();
    const waitUntil = vi.fn();
    const write = writeCache(ctx('https://x/', {}, waitUntil), 'k', 1, 60);
    expect(waitUntil).toHaveBeenCalledWith(write);
    await write;
  });

  it('does nothing without a Cache API or KV (local tests, wrangler without bindings)', async () => {
    const c = ctx('https://x/');
    await writeCache(c, 'k', 1, 60);
    await writeCache(c, 'k', 1, 86400);
    expect(await readCache(c, 'k', 60)).toBeNull();
    expect(await readCache(c, 'k', 86400)).toBeNull();
  });
});

describe('Functions keep their answer when the cache fails', () => {
  it('/api/weather still returns the METAR when the cache write fails', async () => {
    stubEdgeCache({ failPut: true });
    stubFetch([['aviationweather.gov/api/data/metar', jsonFixture('awc-metar-kord.json')]]);
    const out = await json(await weather(ctx('https://x/api/weather?icao=KORD')));
    expect(out.available).toBe(true);
    expect(out.rawText).toMatch(/^METAR KORD/);
  });

  it('/api/weather answers a second request from the cache without calling upstream', async () => {
    stubEdgeCache();
    const { calls } = stubFetch([['aviationweather.gov/api/data/metar', jsonFixture('awc-metar-kord.json')]]);
    const first = await json(await weather(ctx('https://x/api/weather?icao=KORD')));
    const second = await json(await weather(ctx('https://x/api/weather?icao=KORD')));
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  it('/api/lore still returns the article when KV is out of writes for the day', async () => {
    stubFetch([
      ['/page/summary/', jsonFixture('wikipedia-summary-her.json')],
    ]);
    const kv = fakeKv({ failPut: true });
    const res = await lore(
      ctx('https://x/api/lore?iata=HER&title=Heraklion_International_Airport&lat=35.3397&lon=25.1803', { LORE_KV: kv })
    );
    expect(res.status).toBe(200);
    expect((await json(res)).title).toBe(jsonFixture('wikipedia-summary-her.json').title);
    expect(kv.put).toHaveBeenCalled();
  });
});

describe('Function input and errors', () => {
  it('/api/weather rejects a code that is not ICAO-shaped without calling upstream', async () => {
    const { calls } = stubFetch([]);
    for (const q of ['', 'icao=', 'icao=AD-ALV', 'icao=KORD1', `icao=${'A'.repeat(200)}`]) {
      const res = await weather(ctx(`https://x/api/weather?${q}`));
      expect(res.status).toBe(400);
      expect(res.headers.get('Content-Type')).toBe('application/json');
    }
    expect(calls).toHaveLength(0);
  });

  it('does not pass an internal error message on to the browser', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:443 key=abc');
    }));
    for (const fn of [weather, taf]) {
      const body = await (await fn(ctx('https://x/api/x?icao=KORD'))).text();
      expect(body).not.toContain('ECONNREFUSED');
      expect(JSON.parse(body).available).toBe(false);
    }
  });
});
