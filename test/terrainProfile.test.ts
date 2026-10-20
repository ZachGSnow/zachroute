// Route terrain profile: /api/elevation and the chart, against a real Open-Meteo elevation answer
// for the 79 points the function asks for between Denver (DEN) and Salt Lake City (SLC), captured
// 2026-10-20.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonFixture, pagesContext } from './helpers';
import { onRequest as elevation, parsePoint, distanceMi, greatCirclePoints, sampleCount } from '../functions/api/elevation';
import { highestPoint, freezingAt, frozenTerrainMiles, axisTopFt, profileSvg, type ElevationProfile } from '../src/ts/terrainProfile';

const json = async (res: Response) => JSON.parse(await res.text());
const DEN: [number, number] = [39.8617, -104.6731];
const SLC: [number, number] = [40.7884, -111.9778];
const answer = jsonFixture<{ elevation: number[] }>('open-meteo-elevation-den-slc.json');

afterEach(() => vi.unstubAllGlobals());

describe('/api/elevation', () => {
  it('parses positions and refuses bad ones', () => {
    expect(parsePoint('39.86,-104.67')).toEqual([39.86, -104.67]);
    expect(parsePoint('95,0')).toBeNull();
    expect(parsePoint('denver')).toBeNull();
  });

  it('samples about every 5 miles, 20 to 200 points, along the great circle', () => {
    expect(Math.round(distanceMi(DEN, SLC))).toBe(390);
    expect(sampleCount(390)).toBe(79);
    expect(sampleCount(30)).toBe(20);
    expect(sampleCount(7000)).toBe(200);
    const pts = greatCirclePoints(DEN, SLC, 79);
    expect(pts[0]).toEqual([39.8617, -104.6731]);
    expect(pts[78]).toEqual([40.7884, -111.9778]);
    // a great circle between these bows north of the straight lat/lon line
    expect(pts[39][0]).toBeGreaterThan((DEN[0] + SLC[0]) / 2);
  });

  it('serves the profile from Open-Meteo in batches of 100', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(JSON.stringify(answer));
      })
    );
    const out = await json(await elevation(pagesContext(`https://x/api/elevation?from=${DEN.join(',')}&to=${SLC.join(',')}`)));
    expect(calls).toHaveLength(1);
    expect(out.points).toHaveLength(79);
    expect(out.elevationsM).toEqual(answer.elevation.map((m) => Math.round(m)));
    expect(out.spacingMi).toBe(5);
  });

  it('rejects a bad request and reports an upstream failure', async () => {
    expect((await elevation(pagesContext('https://x/api/elevation?from=1,2'))).status).toBe(400);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    expect((await elevation(pagesContext(`https://x/api/elevation?from=${DEN.join(',')}&to=${SLC.join(',')}`))).status).toBe(502);
  });
});

describe('terrain profile chart', () => {
  const profile = (): ElevationProfile => ({ points: greatCirclePoints(DEN, SLC, 79), elevationsM: answer.elevation, spacingMi: 5 });

  it('finds the highest terrain and where it is', () => {
    const hi = highestPoint(profile());
    expect(hi.ft).toBe(Math.round(Math.max(...answer.elevation) * 3.28084));
    expect(hi.mi).toBe(answer.elevation.indexOf(Math.max(...answer.elevation)) * 5);
  });

  it('interpolates the freezing level along the route', () => {
    expect(freezingAt([8000, 12000], 0.5)).toBe(10000);
    expect(freezingAt([8000, 10000, 6000], 1)).toBe(6000);
    expect(freezingAt([7000], 0.3)).toBe(7000);
  });

  it('measures terrain above the freezing level', () => {
    expect(frozenTerrainMiles(profile(), [30000, 30000])).toBe(0);
    // freezing at 9,000 ft: the Front Range and the Wasatch poke above it
    const miles = frozenTerrainMiles(profile(), [9000, 9000]);
    expect(miles).toBeGreaterThan(0);
    expect(miles).toBeLessThan(390);
    expect(frozenTerrainMiles(profile(), [])).toBe(0);
  });

  it('rounds the height axis up to 5,000 ft steps', () => {
    expect(axisTopFt(11742)).toBe(15000);
    expect(axisTopFt(0)).toBe(5000);
  });

  it('draws terrain, the freezing level and the frozen part', () => {
    const svg = profileSvg(profile(), [9000, 10000, 9000], 'DEN', 'SLC');
    expect(svg).toContain('<svg');
    expect(svg).toContain('stroke-dasharray'); // freezing line
    expect(svg).toContain('#bae6fd'); // terrain above it
    expect(svg).toContain('>DEN<');
    expect(svg).toContain('>SLC<');
    expect(profileSvg(profile(), [], 'DEN', 'SLC')).not.toContain('stroke-dasharray');
    expect(svg).toContain('>7.5k<'); // the middle of a 15,000 ft axis
  });
});
