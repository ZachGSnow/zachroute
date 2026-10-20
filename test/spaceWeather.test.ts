// NOAA SWPC space weather -> /api/spaceweather, against real responses captured 19-20 Oct 2026: the
// NOAA scales (now R0 S0 G0; yesterday R1; G1 forecast for tomorrow), the last 8 planetary Kp
// values, and the OVATION aurora grid trimmed to longitudes 0-29.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonFixture, pagesContext } from './helpers';
import { onRequest as spaceweather, readScales, latestKp, auroraCells } from '../functions/api/spaceweather';
import { polarConcerns, scaleSeverity, maxAbsLat, scalesLabel, auroraLookup, auroraRgba, POLAR_LAT } from '../src/ts/spaceWeather';
import { auroraLegend } from '../src/ts/legends';

const json = async (res: Response) => JSON.parse(await res.text());
const scales = jsonFixture<any>('swpc-noaa-scales.json');
const kp = jsonFixture<any[]>('swpc-planetary-k-index.json');
const ovation = jsonFixture<any>('swpc-ovation-aurora-lon0-29.json');

afterEach(() => vi.unstubAllGlobals());

describe('SWPC feeds', () => {
  it('reads the current scales and the forecast for tomorrow', () => {
    const s = readScales(scales);
    expect(s.now).toEqual({ R: 0, S: 0, G: 0 });
    expect(s.tomorrow).toEqual({ G: 1, minorRadioPct: 25, majorRadioPct: 5, radiationPct: 5 });
    expect(readScales({}).now).toEqual({ R: 0, S: 0, G: 0 });
  });

  it('takes the latest Kp', () => {
    const last = kp[kp.length - 1];
    expect(latestKp(kp)).toEqual({ kp: last.Kp, kpTime: `${last.time_tag}Z` });
    expect(latestKp(null)).toEqual({});
  });

  it('keeps only aurora cells with a 5% chance or more', () => {
    const a = auroraCells(ovation)!;
    expect(a.observed).toBe(ovation['Observation Time']);
    expect(a.cells.length).toBe(ovation.coordinates.filter((c: number[]) => c[2] >= 5).length);
    expect(a.cells.every(([, , p]) => p >= 5 && p <= 100)).toBe(true);
  });

  it('serves the combined answer, and 502 when the scales are down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        const body = url.includes('noaa-scales') ? scales : url.includes('k-index') ? kp : ovation;
        return new Response(JSON.stringify(body));
      })
    );
    const out = await json(await spaceweather(pagesContext('https://x/api/spaceweather')));
    expect(out.now).toEqual({ R: 0, S: 0, G: 0 });
    expect(out.kp).toBe(kp[kp.length - 1].Kp);
    expect(out.aurora.cells.length).toBeGreaterThan(0);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    expect((await spaceweather(pagesContext('https://x/api/spaceweather'))).status).toBe(502);
  });
});

describe('space weather on routes and the map', () => {
  it('flags only what matters to a polar route, worst first', () => {
    expect(polarConcerns({ R: 1, S: 0, G: 1 })).toEqual([]);
    expect(polarConcerns({ R: 2, S: 3, G: 2 }).map((c) => c.code)).toEqual(['S3', 'R2', 'G2']);
    expect(polarConcerns({ R: 0, S: 1, G: 0 })[0].text).toContain('polar flights may be rerouted');
    expect([1, 2, 3, 4, 5].map(scaleSeverity)).toEqual([1, 2, 3, 4, 4]);
    expect(scalesLabel({ R: 1, S: 0, G: 2 })).toBe('R1 S0 G2');
  });

  it('knows a polar route', () => {
    // JFK to Hong Kong goes over the pole region; JFK to London does not reach 60.
    expect(maxAbsLat([[40.6, -73.8], [78, 20], [22.3, 113.9]])).toBe(78);
    expect(maxAbsLat([[40.6, -73.8], [55, -30], [51.5, -0.5]])).toBeLessThan(POLAR_LAT);
  });

  it('looks up the aurora chance between grid cells', () => {
    const at = auroraLookup([[10, 65, 40], [11, 65, 60], [10, 66, 40], [11, 66, 60]]);
    expect(at(65, 10)).toBe(40);
    expect(at(65.5, 10.5)).toBeCloseTo(50);
    expect(at(0, 0)).toBe(0);
    const real = auroraLookup(auroraCells(ovation)!.cells);
    const [lon, lat, p] = auroraCells(ovation)!.cells[0];
    expect(real(lat, lon)).toBe(p);
  });

  it('draws aurora green from 10%, more solid when likely', () => {
    expect(auroraRgba(9)[3]).toBe(0);
    expect(auroraRgba(10).slice(0, 3)).toEqual([74, 222, 128]);
    expect(auroraRgba(90)[3]).toBeGreaterThan(auroraRgba(30)[3]);
    expect(auroraLegend('R0 S0 G0').note).toContain('NOAA scales now: R0 S0 G0');
  });
});
