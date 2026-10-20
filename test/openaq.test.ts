// OpenAQ measured PM2.5 -> /api/openaq, against real OpenAQ v3 answers captured 2026-10-20 on a
// preview deployment: PM2.5 locations within 25 km of LAX and ORD (trimmed to the reference
// monitors plus a few fresh and stale low-cost sensors), latest readings for five locations, and
// an empty answer from the open Pacific.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonFixture, pagesContext } from './helpers';
import { onRequest as openaq, candidates, pm25FromLatest } from '../functions/api/openaq';
import { pm25Aqi, pm25Category, readingAge } from '../src/ts/openaq';

const json = async (res: Response) => JSON.parse(await res.text());
const NOW = Date.parse('2026-10-20T10:30:00Z');
const lax = jsonFixture<any>('openaq-locations-pm25-lax.json');
const ord = jsonFixture<any>('openaq-locations-pm25-ord.json');
const latest = (id: number) => jsonFixture<any>(`openaq-latest-${id}.json`);
const KEY = 'fake-openaq-key'; // a stand-in: tests check it never reaches a response

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('choosing a station', () => {
  it('keeps fresh, fixed PM2.5 stations, reference monitors first, nearest first', () => {
    const c = candidates(lax, NOW);
    expect(c[0]).toMatchObject({ id: 1948, name: 'Compton', monitor: true, pm25Sensors: [25551], provider: 'AirNow' });
    const firstLowCost = c.findIndex((x) => !x.monitor);
    expect(c.slice(0, firstLowCost).every((x) => x.monitor)).toBe(true);
    expect(c.slice(firstLowCost).every((x) => !x.monitor)).toBe(true);
    // the monitor that stopped reporting in 2017 is not a candidate
    expect(c.some((x) => x.id === 1575)).toBe(false);
  });

  it('finds nothing where there are no stations', () => {
    expect(candidates(jsonFixture('openaq-locations-none.json'), NOW)).toEqual([]);
  });
});

describe('reading the latest values', () => {
  it('takes the value of the PM2.5 sensor, ignoring the other sensors of the station', () => {
    const [compton] = candidates(lax, NOW);
    expect(pm25FromLatest(latest(1948), compton, NOW)).toEqual({
      pm25: 11.4,
      time: '2026-10-20T09:00:00.000Z',
      station: 'Compton',
      provider: 'AirNow',
      distanceKm: 19.3,
      monitor: true,
      locationId: 1948,
    });
  });

  it('skips a PM2.5 reading older than 3 hours', () => {
    const [compton] = candidates(lax, NOW);
    expect(pm25FromLatest(latest(1948), compton, Date.parse('2026-10-20T13:00:00Z'))).toBeNull();
    // the low-cost sensor's other channels date from 2024; its PM2.5 is current
    const clarity = { id: 947154, name: '54th St ES (3781)', distanceKm: 8.2, monitor: false, pm25Sensors: [2000905] };
    expect(pm25FromLatest(latest(947154), clarity, NOW)).toMatchObject({ pm25: 9, monitor: false });
  });
});

describe('/api/openaq', () => {
  const ctx = (url: string, env: Record<string, unknown>) => ({ ...pagesContext(url), env });

  function stubOpenAq(locations: any) {
    const calls: Array<{ url: string; key: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        calls.push({ url, key: new Headers(init?.headers).get('X-API-Key') });
        if (url.includes('/v3/locations?')) return new Response(JSON.stringify(locations));
        const id = Number(url.match(/locations\/(\d+)\/latest/)?.[1]);
        try {
          return new Response(JSON.stringify(latest(id)));
        } catch {
          return new Response('{"detail":"not found"}', { status: 404 });
        }
      })
    );
    return calls;
  }

  it('serves the nearest fresh monitor, sending the key only as a header', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const calls = stubOpenAq(lax);
    const res = await openaq(ctx('https://x/api/openaq?lat=33.9416&lon=-118.4085', { OPENAQ_API_KEY: KEY }) as any);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ available: true, reading: { station: 'Compton', pm25: 11.4 } });
    expect(text).not.toContain(KEY);
    // one lookup from the center of the 0.1-degree cell, then one latest
    expect(calls[0].url).toContain('coordinates=33.9,-118.4&radius=25000&limit=1000&parameters_id=2');
    expect(calls.every((c) => c.key === KEY && !c.url.includes(KEY))).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('gives up after three stations without a fresh reading', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const calls = stubOpenAq(ord);
    const out = await json(await openaq(ctx('https://x/api/openaq?lat=41.9786&lon=-87.9048', { OPENAQ_API_KEY: KEY }) as any));
    expect(out).toEqual({ available: true, reading: null });
    expect(calls.filter((c) => c.url.includes('/latest'))).toHaveLength(3);
  });

  it('answers without calling OpenAQ when there is no key, and rejects a bad position', async () => {
    const calls = stubOpenAq(lax);
    expect(await json(await openaq(ctx('https://x/api/openaq?lat=33.9&lon=-118.4', {}) as any))).toEqual({ available: false, reading: null });
    expect(calls).toHaveLength(0);
    expect((await openaq(ctx('https://x/api/openaq?lat=x', { OPENAQ_API_KEY: KEY }) as any)).status).toBe(400);
  });
});

describe('measured PM2.5 on the card', () => {
  it('converts PM2.5 to the US AQI (EPA 2024 breakpoints)', () => {
    expect([0, 9, 9.1, 35.4, 35.5, 55.4, 125.4, 225.4, 500].map((c) => pm25Aqi(c, 'us'))).toEqual([0, 50, 50, 100, 100, 150, 200, 300, 500]);
    expect(pm25Category(11.4, 'us').label).toBe('Moderate');
    expect(pm25Category(40, 'us').label).toBe('Unhealthy for sensitive groups');
  });

  it('converts PM2.5 to the European AQI bands the card already uses', () => {
    expect(pm25Category(8, 'eu').label).toBe('Good');
    expect(pm25Category(15, 'eu').label).toBe('Fair');
    expect(pm25Category(30, 'eu').label).toBe('Poor');
  });

  it('says how old the reading is', () => {
    expect(readingAge('2026-10-20T09:55:00Z', NOW)).toBe('35 min ago');
    expect(readingAge('2026-10-20T08:00:00Z', NOW)).toBe('3 h ago');
  });
});
