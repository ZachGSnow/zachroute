// National Hurricane Center storms -> /api/cyclones, against real responses captured 19 Oct 2026:
// CurrentStorms.json with Tropical Storm Trudy (EP1, advisory 26, 21:00 UTC), and her cone,
// forecast points and best-track points from NOAA's tropical map service.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonFixture, pagesContext, stubFetch } from './helpers';
import {
  onRequest as cyclones,
  parseNhcStorm,
  mergeNhc,
  nhcLayerIds,
  nhcCategory,
  nhcForecastTime,
  nhcPastTime,
  type Cyclone,
} from '../functions/api/cyclones';

const json = async (res: Response) => JSON.parse(await res.text());
const current = jsonFixture<any>('nhc-current-storms.json');
const cone = jsonFixture<any>('nhc-ep1-cone.json');
const forecast = jsonFixture<any>('nhc-ep1-forecast-points.json');
const past = jsonFixture<any>('nhc-ep1-past-points.json');
const trudy = () => parseNhcStorm(current.activeStorms[0], cone, forecast, past);

afterEach(() => vi.unstubAllGlobals());

describe('NHC helpers', () => {
  it('finds layers by name in the map service', () => {
    const ids = nhcLayerIds(jsonFixture('nhc-mapserver-layers.json'));
    expect(ids['EP1 Forecast Cone']).toBe(138);
    expect(ids['EP1 Past Points']).toBe(141);
    expect(ids['AT1 Forecast Points']).toBe(6);
  });

  it('maps classifications, subtropical by strength', () => {
    expect(['HU', 'MH', 'TS', 'STS', 'TD', 'STD', 'PTC', 'PC'].map(nhcCategory)).toEqual(['HU', 'HU', 'TS', 'TS', 'TD', 'TD', undefined, undefined]);
  });

  it('reads forecast and best-track times', () => {
    expect(nhcForecastTime('21/1800', '2026-10-19T21:00:00.000Z')).toBe('2026-10-21T18:00:00.000Z');
    expect(nhcForecastTime('02/0000', '2026-10-30T21:00:00.000Z')).toBe('2026-11-02T00:00:00.000Z');
    expect(nhcForecastTime('03/0000', '2026-12-30T21:00:00.000Z')).toBe('2027-01-03T00:00:00.000Z');
    expect(nhcForecastTime('nonsense', '2026-10-19T21:00:00.000Z')).toBeUndefined();
    expect(nhcPastTime(2026101106)).toBe('2026-10-11T06:00:00.000Z');
  });
});

describe('NHC storms', () => {
  it('builds the storm from the advisory, best track and forecast', () => {
    const s = trudy();
    expect(s).toMatchObject({ name: 'Trudy', category: 'TS', source: 'NHC', alert: '', lat: 19.3, lon: -107.9, asOf: '2026-10-19T21:00:00.000Z' });
    expect(s.report).toBe('https://www.nhc.noaa.gov/text/MIATCPEP1.shtml');
    expect(s.track.filter((t) => !t.forecast)).toHaveLength(past.features.length);
    // tau 0 is the current position, already the last best-track point
    expect(s.track.filter((t) => t.forecast)).toHaveLength(forecast.features.filter((f: any) => f.properties.tau > 0).length);
    expect(s.track.map((t) => t.time)).toEqual([...s.track.map((t) => t.time)].sort());
    expect(s.cone!.length).toBeGreaterThanOrEqual(3);
    // strongest best-track wind, kt -> km/h
    const peakKt = Math.max(...past.features.map((f: any) => f.properties.intensity));
    expect(s.peakWindKmh).toBe(Math.round(Math.max(peakKt, 35) * 1.852));
  });

  it('replaces the same storm from GDACS, keeping its id and impact alert', () => {
    const gdacs: Cyclone = { id: 1001400, name: 'Trudy', category: 'TS', alert: 'Orange', lat: 18.9, lon: -107.1, asOf: '2026-10-19T09:00:00.000Z', source: 'NOAA', track: [] };
    const champi: Cyclone = { ...gdacs, id: 1001338, name: 'Champi', lat: 9, lon: 150 };
    const [a, b] = mergeNhc([gdacs, champi], [trudy()]);
    expect(a).toMatchObject({ id: 1001400, alert: 'Orange', source: 'NHC', asOf: '2026-10-19T21:00:00.000Z' });
    expect(a.cone).toBeDefined();
    expect(b).toBe(champi);
  });

  it('adds an NHC storm GDACS does not list yet, and leaves far-away namesakes alone', () => {
    const far: Cyclone = { id: 5, name: 'Trudy', alert: 'Green', lat: -20, lon: 60, asOf: '', track: [] };
    const out = mergeNhc([far], [trudy()]);
    expect(out).toHaveLength(2);
    expect(out[1].id).toBeLessThan(0);
  });
});

describe('/api/cyclones with NHC', () => {
  it('merges NHC into the GDACS list', async () => {
    const { calls } = stubFetch([
      ['geteventlist', { features: [] }],
      ['CurrentStorms.json', current],
      ['/MapServer/138/query', cone],
      ['/MapServer/136/query', forecast],
      ['/MapServer/141/query', past],
      ['/MapServer?f=json', jsonFixture('nhc-mapserver-layers.json')],
    ]);
    const out = await json(await cyclones(pagesContext('https://x/api/cyclones')));
    expect(out.available).toBe(true);
    expect(out.storms.map((s: any) => [s.name, s.source])).toEqual([['Trudy', 'NHC']]);
    expect(calls.some((u) => u.includes('MapServer?f=json'))).toBe(true);
  });

  it('still serves GDACS when NHC is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes('geteventlist')) return new Response(JSON.stringify({ features: [] }));
        return new Response('down', { status: 503 });
      })
    );
    const out = await json(await cyclones(pagesContext('https://x/api/cyclones')));
    expect(out).toEqual({ available: true, storms: [] });
  });
});
