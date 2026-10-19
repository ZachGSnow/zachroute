import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonFixture, pagesContext, stubBrowser, stubFetch } from './helpers';
import { buildTfrs, notamId, onRequest as tfrFn } from '../functions/api/tfr';
import { describeTfr, tfrPlace, tfrsCrossed, tfrsNear, tfrTypeLabel, type Tfr } from '../src/ts/tfr';

const json = async (res: Response) => JSON.parse(await res.text());

// Real FAA responses, trimmed: a VIP TFR (Dallas), a security TFR (Raleigh), a hazards TFR
// (Merced, left off the list fixture to stand in for one that is no longer active) and a security
// TFR drawn as two shapes (Grand Forks AFB).
const shapes = jsonFixture<any>('faa-tfr-shapes.json');
const list = jsonFixture<any[]>('faa-tfr-list.json');

beforeEach(() => {
  stubBrowser();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FAA TFRs -> /api/tfr', () => {
  it('reads the NOTAM number from the map service key', () => {
    expect(notamId('6/9169-1-FDC-F')).toBe('6/9169');
    expect(notamId(undefined)).toBeNull();
  });

  it('keeps only TFRs on the current list, merging shapes of one TFR', () => {
    const active = new Map(list.map((t) => [t.notam_id, t]));
    const tfrs = buildTfrs(shapes.features, active);
    expect(tfrs.map((t) => t.id).sort()).toEqual(['6/4348', '6/9169', '9/2934']);
    const forks = tfrs.find((t) => t.id === '6/4348')!;
    expect(forks.rings).toHaveLength(2);
    const raleigh = tfrs.find((t) => t.id === '6/9169')!;
    expect(raleigh.type).toBe('SECURITY');
    expect(raleigh.url).toBe('https://tfr.faa.gov/tfr3/?page=detail_6_9169');
    // [lat, lon], from GeoJSON's [lon, lat]
    const [lon, lat] = shapes.features.find((f: any) => f.properties.NOTAM_KEY.startsWith('6/9169')).geometry.coordinates[0][0];
    expect(raleigh.rings[0][0]).toEqual([Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5]);
  });

  it('keeps every shape when the list cannot be read, and says the answer is incomplete', async () => {
    const fn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('exportTfrList')) return new Response('busy', { status: 503 });
      return new Response(JSON.stringify(shapes));
    });
    vi.stubGlobal('fetch', fn);
    const out = await json(await tfrFn(pagesContext('https://x/api/tfr')));
    expect(out.tfrs).toHaveLength(4);
    expect(out.complete).toBe(false);
  });

  it('joins both FAA responses', async () => {
    stubFetch([
      ['geoserver/TFR', shapes],
      ['exportTfrList', list],
    ]);
    const out = await json(await tfrFn(pagesContext('https://x/api/tfr')));
    expect(out.tfrs).toHaveLength(3);
    expect(out.complete).toBe(true);
  });
});

describe('TFRs in the app', () => {
  const tfrs: Tfr[] = buildTfrs(shapes.features, new Map(list.map((t) => [t.notam_id, t])));
  const raleigh = tfrs.find((t) => t.id === '6/9169')!;
  const inside = raleigh.rings[0].reduce(([a, b], [lat, lon]) => [a + lat / raleigh.rings[0].length, b + lon / raleigh.rings[0].length], [0, 0]);

  it('names the type and softens the FAA capitals in the place', () => {
    expect(tfrTypeLabel('VIP')).toBe('VIP movement');
    expect(tfrTypeLabel('NEW KIND')).toBe('New Kind');
    expect(tfrPlace('RALEIGH, NC, Thursday, October 15, 2026 through Sunday, October 25, 2026 Local')).toBe(
      'Raleigh, NC, Thursday, October 15, 2026 through Sunday, October 25, 2026 Local'
    );
    expect(tfrPlace('34NM SE CRESCENT CITY, CA, Monday, October 19, 2026')).toBe('34NM SE Crescent City, CA, Monday, October 19, 2026');
    expect(describeTfr(raleigh)).toMatch(/^Flight restriction \(Security\): Raleigh, NC/);
  });

  it('finds the TFRs a route passes through', () => {
    const route: Array<[number, number]> = [
      [inside[0] - 1, inside[1]],
      [inside[0], inside[1]],
      [inside[0] + 1, inside[1]],
    ];
    expect(tfrsCrossed(route, tfrs).map((t) => t.id)).toEqual(['6/9169']);
    expect(tfrsCrossed([[0, 0]], tfrs)).toEqual([]);
  });

  it('finds TFRs near an airport, closest first', () => {
    const near = tfrsNear(inside[0], inside[1], tfrs);
    expect(near[0].tfr.id).toBe('6/9169');
    expect(near[0].miles).toBe(0);
    expect(tfrsNear(0, 0, tfrs)).toEqual([]);
  });
});
