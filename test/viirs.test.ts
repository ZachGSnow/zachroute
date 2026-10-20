// FIRMS VIIRS via the area API -> /api/fires, against real area API answers for the western US
// (-125,30,-100,50) captured 2026-10-20 on a preview deployment: NOAA-20 and Suomi-NPP (first 80
// rows each), NOAA-21 (no detections in that window), and the answer to a malformed area.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pagesContext, readFixture } from './helpers';
import { onRequest as fires, parseViirs, clusterViirs, VIIRS_SOURCES } from '../functions/api/fires';

const json = async (res: Response) => JSON.parse(await res.text());
const noaa20 = readFixture('firms-viirs-noaa20-westus.csv');
const snpp = readFixture('firms-viirs-snpp-westus.csv');
const noaa21 = readFixture('firms-viirs-noaa21-westus.csv');
const NOW = Date.parse('2026-10-20T12:00:00Z');
const KEY = 'test-key-0123456789abcdef';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Area API stub answering each VIIRS source with its fixture; records the URLs asked for. */
function stubArea(answers: Record<string, () => Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      const hit = Object.keys(answers).find((k) => url.includes(k));
      return hit ? answers[hit]() : new Response('unexpected', { status: 500 });
    })
  );
  return calls;
}

describe('VIIRS detections', () => {
  it('reads the area API CSV: one-letter confidence, unpadded times', () => {
    const d = parseViirs(noaa20, NOW)!;
    expect(d).toHaveLength(80);
    expect(d[0]).toMatchObject({ lat: 47.98431, lon: -103.11333, frp: 0.55, time: '2026-10-20T08:25:00Z', pass: 'N20|2026-10-20|825' });
  });

  it('drops low confidence and detections older than 24 hours', () => {
    const lines = noaa20.trim().split('\n');
    const low = lines[1].replace(',VIIRS,n,', ',VIIRS,l,');
    expect(parseViirs([lines[0], low, lines[2]].join('\n'), NOW)).toHaveLength(1);
    expect(parseViirs(noaa20, Date.parse('2026-10-21T12:00:00Z'))).toEqual([]);
  });

  it('knows an error message is not a CSV', () => {
    expect(parseViirs(readFixture('firms-area-bad.txt'))).toBeNull();
    expect(parseViirs('Invalid MAP_KEY.')).toBeNull();
    expect(parseViirs(noaa21, NOW)).toEqual([]);
  });

  it('sums detections of one pass within about 1 km into one fire', () => {
    const d = parseViirs(noaa20, NOW)!;
    const out = clusterViirs(d);
    expect(out.length).toBeLessThan(d.length);
    expect(out.reduce((s, f) => s + (f.pixels || 0), 0)).toBe(d.length);
    expect(out.reduce((s, f) => s + f.frp, 0)).toBeCloseTo(d.reduce((s, x) => s + x.frp, 0), 1);
    expect(out.map((f) => f.frp)).toEqual([...out.map((f) => f.frp)].sort((a, b) => b - a));
    // two passes over the same spot stay two fires
    const one = { lat: 40, lon: -110, frp: 5, time: '2026-10-20T08:25:00Z', pass: 'N20|2026-10-20|825' };
    expect(clusterViirs([one, { ...one, lat: 40.002, frp: 3 }])).toEqual([expect.objectContaining({ frp: 8, pixels: 2 })]);
    expect(clusterViirs([one, { ...one, pass: 'N|2026-10-20|946' }])).toHaveLength(2);
  });
});

describe('/api/fires with the FIRMS key', () => {
  const ctx = (env: Record<string, unknown>) => ({ ...pagesContext('https://x/api/fires?bbox=30,-125,50,-100'), env });

  it('asks the area API for all three satellites over the box and serves VIIRS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const calls = stubArea({
      VIIRS_NOAA20_NRT: () => new Response(noaa20),
      VIIRS_NOAA21_NRT: () => new Response(noaa21),
      VIIRS_SNPP_NRT: () => new Response(snpp),
    });
    const res = await fires(ctx({ FIRMS_MAP_KEY: KEY }) as any);
    const text = await res.clone().text();
    const out = JSON.parse(text);
    expect(out.source).toBe('VIIRS');
    expect(out.fires.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(VIIRS_SOURCES.length);
    expect(calls[0]).toContain('/api/area/csv/');
    expect(calls[0]).toContain('/-125,30,-100,50/1');
    expect(text).not.toContain(KEY);
  });

  it('falls back to MODIS when FIRMS refuses the key, without passing on what it said', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-16T12:00:00Z'));
    stubArea({
      '/api/area/csv/': () => new Response('Invalid MAP_KEY.'),
      MODIS_C6_1_Global_24h: () => new Response(readFixture('firms-modis-24h.csv')),
    });
    const res = await fires(ctx({ FIRMS_MAP_KEY: KEY }) as any);
    const text = await res.text();
    expect(JSON.parse(text).source).toBe('MODIS');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('Invalid MAP_KEY');
  });

  it('keeps the error out of the response when the area API cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes('/api/area/')) throw new TypeError(`connection failed for ${url}`);
        return new Response('upstream error', { status: 502 });
      })
    );
    const text = await (await fires(ctx({ FIRMS_MAP_KEY: KEY }) as any)).text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text).available).toBe(false);
  });

  it('uses MODIS without a key, as before', async () => {
    const calls = stubArea({ MODIS_C6_1_Global_24h: () => new Response(readFixture('firms-modis-24h.csv')) });
    const out = await json(await fires(ctx({}) as any));
    expect(out.source).toBe('MODIS');
    expect(calls.every((u) => !u.includes('/api/area/'))).toBe(true);
  });
});
