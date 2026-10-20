// openAIP airspace exports -> the app's airspace cells, against real features from the Germany and
// Australia export files (storage.openaip.net, 20 Oct 2026): the smallest two of each type, kept
// and dropped ones alike.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { jsonFixture, stubBrowser } from './helpers';
import { areasFrom, kindOf, limitOf, simplifyRing, cellsOf, splitIntoCells, KEPT_TYPES } from '../shared/openaipAirspace.js';
import { fetchAirspaceCell, airspaceStyle } from '../src/ts/airspace';

const de = jsonFixture<any>('openaip-de-asp-sample.json');
const au = jsonFixture<any>('openaip-au-asp-sample.json');

afterEach(() => vi.unstubAllGlobals());

describe('openAIP export -> areas', () => {
  it('keeps restricted, danger, prohibited and controlled airspace, and drops the rest', () => {
    const areas = areasFrom(de);
    const keptIn = de.features.filter((f: any) => KEPT_TYPES.has(f.properties.type));
    expect(areas).toHaveLength(keptIn.length);
    // gliding sectors (21), sport areas (28), FIS sectors (33) and "other" (0) are gone
    const dropped = de.features.filter((f: any) => [0, 21, 28, 33].includes(f.properties.type)).map((f: any) => `oaip:${f.properties._id}`);
    expect(areas.some((a: any) => dropped.includes(a.id))).toBe(false);
    // every kept Australian area (restricted, danger, CTR, CTA, ATZ) gets a real chart style
    const auAreas = areasFrom(au);
    expect(auAreas.length).toBeGreaterThan(0);
    for (const a of auAreas) expect(airspaceStyle(a.kind).label).not.toBe('Airspace');
  });

  it('names kinds by type for special use, by ICAO class otherwise', () => {
    expect(kindOf(3, 8)).toBe('P');
    expect(kindOf(1, 8)).toBe('R');
    expect(kindOf(2, 6)).toBe('D-AREA');
    expect(kindOf(4, 3)).toBe('D');
    expect(kindOf(7, 2)).toBe('C');
    expect(kindOf(26, 0)).toBe('CLASS-A');
    expect(kindOf(26, 4)).toBe('CLASS-E');
    expect(kindOf(4, 8)).toBe('CTL');
  });

  it('reads limits in feet, metres and flight levels from ground, sea level or standard', () => {
    expect(limitOf({ value: 0, unit: 1, referenceDatum: 0 })).toEqual({ ref: 'SFC' });
    expect(limitOf({ value: 1500, unit: 1, referenceDatum: 0 })).toEqual({ value: 1500, ref: 'AGL' });
    expect(limitOf({ value: 2500, unit: 1, referenceDatum: 1 })).toEqual({ value: 2500, ref: 'MSL' });
    expect(limitOf({ value: 100, unit: 6, referenceDatum: 2 })).toEqual({ value: 100, ref: 'FL' });
    expect(limitOf({ value: 300, unit: 0, referenceDatum: 1 })).toEqual({ value: 984, ref: 'MSL' });
    expect(limitOf(undefined)).toEqual({ ref: 'SFC' });
  });

  it('turns real geometry into [lat, lon] rings, simplified', () => {
    const f = de.features.find((x: any) => KEPT_TYPES.has(x.properties.type));
    const a = areasFrom({ features: [f] })[0];
    const [lon, lat] = f.geometry.coordinates[0][0];
    expect(a.polygons[0][0][0]).toEqual([Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4]);
    expect(a.polygons[0][0].length).toBeLessThanOrEqual(f.geometry.coordinates[0].length);
    expect(a.name).toBe(f.properties.name);
  });
});

describe('simplifying and splitting', () => {
  it('drops points closer than ~500 m to the line, keeping corners', () => {
    const square = [
      [0, 0],
      [0.5, 0.001],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ];
    expect(simplifyRing(square)).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ]);
  });

  it('lists every 4-degree cell an area touches', () => {
    const area = { polygons: [[[[47.5, 7.5], [48.5, 7.5], [48.5, 8.5], [47.5, 8.5]]]] };
    expect(cellsOf(area as any).sort()).toEqual(['44_4', '44_8', '48_4', '48_8']);
    const cells = splitIntoCells([{ id: 'x', ...area } as any]);
    expect(Object.keys(cells).sort()).toEqual(['44_4', '44_8', '48_4', '48_8']);
  });
});

describe('the map asks the right places', () => {
  it('reads the openAIP cell file only for cells the build listed, alongside the FAA', async () => {
    stubBrowser();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/data/airspace/index.json')) return new Response(JSON.stringify({ built: '2026-10-20', cells: ['48_0'] }));
        if (url.endsWith('/data/airspace/48_0.json')) return new Response(JSON.stringify({ areas: areasFrom(de).slice(0, 2) }));
        return new Response(JSON.stringify({ areas: [], complete: true, sources: [] }));
      })
    );
    const paris = await fetchAirspaceCell([48, 0]);
    expect(paris).toHaveLength(2);
    expect(paris[0]).toMatchObject({ source: 'openAIP', built: '2026-10-20' });
    await fetchAirspaceCell([-20, -140]); // open Pacific: not in the index
    expect(calls.filter((u) => u.includes('/data/airspace/') && !u.endsWith('index.json'))).toEqual(['/data/airspace/48_0.json']);
    expect(calls.filter((u) => u.includes('/api/airspace'))).toHaveLength(2);
    expect(airspaceStyle('CLASS-E').dash).toBeDefined();
  });
});
