import { describe, expect, it, vi, afterEach } from 'vitest';
import { jsonFixture, pagesContext, stubFetch } from './helpers';
import { onRequest as spc, buildOutlook } from '../functions/api/spc';
import { spcLevel, spcCategoryName, spcRiskWord } from '../src/ts/spc';
import { spcLegend } from '../src/ts/legends';
import { severityColor } from '../src/ts/severity';

// Real SPC categorical outlooks from 19 Oct 2026: day 1 (issued 19:58 UTC) with general
// thunderstorms and a marginal risk, day 2 with general thunderstorms in two areas.
const day1 = jsonFixture<any>('spc-day1-cat.json');
const day2 = jsonFixture<any>('spc-day2-cat.json');
const json = async (res: Response) => JSON.parse(await res.text());

afterEach(() => vi.unstubAllGlobals());

describe('SPC convective outlook -> /api/spc', () => {
  it('turns the outlook into [lat, lon] polygons, lowest risk first, with its times', () => {
    const out = buildOutlook(1, day1);
    expect(out.areas.map((a) => a.category)).toEqual(['TSTM', 'MRGL']);
    expect(out.validFrom).toBe('2026-10-19T20:00:00+00:00');
    expect(out.validTo).toBe('2026-10-20T12:00:00+00:00');
    const [lon, lat] = day1.features[1].geometry.coordinates[0][0][0];
    expect(out.areas[1].polygons[0][0][0]).toEqual([Math.round(lat * 1000) / 1000, Math.round(lon * 1000) / 1000]);
  });

  it('keeps every polygon of a multipolygon, holes included', () => {
    const out = buildOutlook(2, day2);
    expect(out.areas[0].polygons).toHaveLength(day2.features[0].geometry.coordinates.length);
    const withHole = {
      features: [{ properties: { LABEL: 'SLGT' }, geometry: { type: 'Polygon', coordinates: [[[-100, 35], [-95, 35], [-95, 40], [-100, 35]], [[-98, 36], [-97, 36], [-97, 37], [-98, 36]]] } }],
    };
    expect(buildOutlook(1, withHole).areas[0].polygons[0]).toHaveLength(2);
  });

  it('drops unknown categories and empty shapes', () => {
    const odd = { features: [{ properties: { LABEL: 'XYZ' }, geometry: day1.features[0].geometry }, { properties: { LABEL: 'ENH' }, geometry: null }] };
    expect(buildOutlook(1, odd).areas).toEqual([]);
  });

  it('serves day 1 by default and day 2 on request, and reports an upstream failure', async () => {
    const { calls } = stubFetch([
      ['day1otlk_cat', day1],
      ['day2otlk_cat', day2],
    ]);
    expect((await json(await spc(pagesContext('https://x/api/spc')))).day).toBe(1);
    expect((await json(await spc(pagesContext('https://x/api/spc?day=2')))).areas).toHaveLength(1);
    expect(calls).toHaveLength(2);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const res = await spc(pagesContext('https://x/api/spc'));
    expect(res.status).toBe(502);
  });
});

describe('severe storm outlook layer', () => {
  it('puts SPC risk on the ladder', () => {
    expect(['TSTM', 'MRGL', 'SLGT', 'ENH', 'MDT', 'HIGH'].map(spcLevel)).toEqual([0, 1, 2, 3, 4, 4]);
    expect(spcCategoryName('ENH')).toBe('Enhanced risk of severe storms (3 of 5)');
    expect(spcRiskWord('MRGL')).toBe('marginal');
  });

  it('has a legend in the same colors', () => {
    const l = spcLegend();
    expect(l.kind === 'items' && l.items.slice(1).map((i) => i.color)).toEqual([1, 2, 3, 4].map((s) => severityColor(s as 1)));
  });
});
