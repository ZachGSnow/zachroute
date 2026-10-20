// FAA airspace -> /api/airspace, against real FAA open data answers captured 2026-10-20 with the
// function's own queries: class B/C/D in the cell 40,-92 (Chicago: 6 B, 15 C, 15 D shapes) and
// special use airspace in the cell 32,-120 (southern California: restricted, warning, MOAs).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonFixture, pagesContext } from './helpers';
import { onRequest as airspace, parseCell, cellTouchesUs, faaLimit, classAreas, specialUseAreas } from '../functions/api/airspace';
import { cellsFor, describeLimit, airspaceStyle, mergeCells, type AirspaceArea } from '../src/ts/airspace';
import { airspaceLegend } from '../src/ts/legends';

const json = async (res: Response) => JSON.parse(await res.text());
const chicago = jsonFixture<any>('faa-class-airspace-cell-40-92.json');
const socal = jsonFixture<any>('faa-special-use-airspace-cell-32-120.json');

afterEach(() => vi.unstubAllGlobals());

describe('FAA airspace', () => {
  it('reads floors and ceilings in every form the FAA uses', () => {
    expect(faaLimit(0, 'SFC', 'FT')).toEqual({ ref: 'SFC' });
    expect(faaLimit('3000', 'SFC', 'FT')).toEqual({ value: 3000, ref: 'AGL' });
    expect(faaLimit(4700, 'MSL', 'FT')).toEqual({ value: 4700, ref: 'MSL' });
    expect(faaLimit('180', 'STD', 'FL')).toEqual({ value: 180, ref: 'FL' });
    expect(faaLimit('-9998', 'UNLTD', null)).toEqual({ ref: 'UNL' });
    expect(faaLimit(null, 'BYNOTAM', null)).toEqual({ ref: 'NOTAM' });
  });

  it('turns class airspace into areas with [lat, lon] polygons', () => {
    const areas = classAreas(chicago);
    expect(areas).toHaveLength(36);
    const b = areas.filter((a) => a.kind === 'B');
    expect(b).toHaveLength(6);
    expect(b[0].name).toBe('CHICAGO CLASS B');
    const [lon, lat] = chicago.features[0].geometry.coordinates[0][0];
    expect(areas[0].polygons[0][0][0]).toEqual([lat, lon]);
    expect(areas.every((a) => a.id && a.polygons.length > 0)).toBe(true);
  });

  it('turns special use airspace into areas with times of use', () => {
    const areas = specialUseAreas(socal);
    expect(areas).toHaveLength(61);
    expect(new Set(areas.map((a) => a.kind))).toEqual(new Set(['MOA', 'R', 'W']));
    expect(areas.some((a) => a.times)).toBe(true);
    expect(areas.some((a) => a.upper.ref === 'FL' || a.upper.ref === 'UNL')).toBe(true);
  });

  it('accepts only cell corners, and asks the FAA only near the US', () => {
    expect(parseCell('40,-92')).toEqual([40, -92]);
    expect(parseCell('41,-92')).toBeNull();
    expect(parseCell('x')).toBeNull();
    expect(cellTouchesUs([40, -92])).toBe(true);
    expect(cellTouchesUs([60, -152])).toBe(true); // Alaska
    expect(cellTouchesUs([48, 0])).toBe(false); // France
  });
});

describe('/api/airspace', () => {
  it('queries both FAA services for the cell and serves the areas', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        calls.push(url);
        return new Response(JSON.stringify(url.includes('Class_Airspace') ? chicago : socal));
      })
    );
    const out = await json(await airspace(pagesContext('https://x/api/airspace?cell=40,-92')));
    expect(out.complete).toBe(true);
    expect(out.areas).toHaveLength(36 + 61);
    expect(calls).toHaveLength(2);
    const q = new URL(calls.find((u) => u.includes('Class_Airspace'))!).searchParams;
    expect(q.get('where')).toBe("CLASS IN ('B','C','D')");
    expect(q.get('geometry')).toBe('-92,40,-88,44');
    expect(q.get('maxAllowableOffset')).toBe('0.005');
  });

  it('answers far from the US without asking the FAA, rejects bad cells, and reports partial answers', async () => {
    const fn = vi.fn(async () => new Response('{"error":{"code":500}}'));
    vi.stubGlobal('fetch', fn);
    expect(await json(await airspace(pagesContext('https://x/api/airspace?cell=48,0')))).toEqual({ areas: [], complete: true, sources: [] });
    expect(fn).not.toHaveBeenCalled();
    expect((await airspace(pagesContext('https://x/api/airspace?cell=41,1'))).status).toBe(400);
    expect((await json(await airspace(pagesContext('https://x/api/airspace?cell=40,-92')))).complete).toBe(false);
  });
});

describe('airspace layer', () => {
  it('covers a view with 4-degree cells, wrapping longitudes, and gives up on huge views', () => {
    expect(cellsFor(41, -89, 43, -87)).toEqual([
      [40, -92],
      [40, -88],
    ]);
    expect(cellsFor(60, 178, 62, 181)).toEqual([
      [60, 176],
      [60, -180],
    ]);
    expect(cellsFor(-60, -180, 60, 180)).toEqual([]);
  });

  it('describes limits in words', () => {
    expect(describeLimit({ ref: 'SFC' })).toBe('surface');
    expect(describeLimit({ value: 3000, ref: 'AGL' })).toBe('3,000 ft above ground');
    expect(describeLimit({ value: 10000, ref: 'MSL' })).toBe('10,000 ft');
    expect(describeLimit({ value: 180, ref: 'FL' })).toBe('FL180');
    expect(describeLimit({ value: 60, ref: 'FL' })).toBe('FL060');
    expect(describeLimit({ ref: 'UNL' })).toBe('unlimited');
  });

  it('de-duplicates areas across cells and draws wide military areas under airport airspace', () => {
    const a = (id: string, kind: string): AirspaceArea => ({ id, kind, name: id, lower: { ref: 'SFC' }, upper: { ref: 'UNL' }, polygons: [] });
    expect(mergeCells([[a('1', 'D'), a('2', 'MOA')], [a('1', 'D'), a('3', 'B')]]).map((x) => x.id)).toEqual(['2', '3', '1']);
  });

  it('styles each kind in chart colors, matching the legend', () => {
    expect(airspaceStyle('D').dash).toBeDefined();
    expect(airspaceStyle('B').dash).toBeUndefined();
    const l = airspaceLegend();
    const colors = l.kind === 'items' ? l.items.map((i) => i.color) : [];
    for (const k of ['B', 'C', 'P', 'R', 'W', 'MOA', 'A']) expect(colors).toContain(airspaceStyle(k).color);
  });
});
