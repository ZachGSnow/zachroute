import { describe, expect, it, vi, afterEach } from 'vitest';
import { jsonFixture, pagesContext, stubFetch } from './helpers';
import { onRequest as tcf, buildTcf, tcfTime } from '../functions/api/tcf';
import { tcfSeverity, tcfForStep, tcfCoverageLabel, type TcfArea } from '../src/ts/tcf';
import { tcfLegend } from '../src/ts/legends';
import { severityColor } from '../src/ts/severity';

// Real TCF from the 23Z issuance on 19 Oct: sparse, high-confidence storms over New Mexico and off
// the Carolinas, for 03Z, 05Z and 07Z.
const features = jsonFixture<any>('awc-tcf.json').features;
const issued = Date.UTC(2026, 9, 19, 23) / 1000;
const json = async (res: Response) => JSON.parse(await res.text());

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('TFM Convective Forecast -> /api/tcf', () => {
  it('reads AWC time stamps', () => {
    expect(tcfTime('20261020_0300')).toBe(Date.UTC(2026, 9, 20, 3) / 1000);
    expect(tcfTime('2026-10-20')).toBeUndefined();
  });

  it('turns features into [lat, lon] areas with tops in feet', () => {
    const out = buildTcf(features, issued);
    expect(out).toHaveLength(features.length);
    expect(out[0]).toMatchObject({ coverage: 'sparse', confidence: 'high', tops: 29000, kind: 'area', issueTime: issued });
    expect(out[0].coords[0]).toEqual([features[0].geometry.coordinates[0][0][1], features[0].geometry.coordinates[0][0][0]]);
  });

  it('drops forecasts whose time has passed', () => {
    const out = buildTcf(features, Date.UTC(2026, 9, 20, 4) / 1000);
    expect(new Set(out.map((a) => a.validTime))).toEqual(new Set([Date.UTC(2026, 9, 20, 5) / 1000, Date.UTC(2026, 9, 20, 7) / 1000]));
  });

  it('keeps lines of storms and drops unusable shapes', () => {
    const line = { properties: { validTime: '20261020_0500', coverage: 'solid', confidence: 'low' }, geometry: { type: 'LineString', coordinates: [[-90, 35], [-88, 36]] } };
    const point = { properties: { validTime: '20261020_0500' }, geometry: { type: 'Point', coordinates: [-90, 35] } };
    const out = buildTcf([line, point], issued);
    expect(out).toEqual([expect.objectContaining({ kind: 'line', coords: [[35, -90], [36, -88]] })]);
  });

  it('serves the areas, and treats "no content" as no storms', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(issued * 1000));
    stubFetch([['aviationweather.gov/api/data/tcf', { type: 'FeatureCollection', features }]]);
    expect((await json(await tcf(pagesContext('https://x/api/tcf')))).areas).toHaveLength(5);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    expect(await json(await tcf(pagesContext('https://x/api/tcf')))).toEqual({ areas: [], complete: true });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 502 })));
    expect(await json(await tcf(pagesContext('https://x/api/tcf')))).toEqual({ areas: [], complete: false });
  });
});

describe('thunderstorm forecast layer', () => {
  const areas = buildTcf(features, issued) as TcfArea[];

  it('shows one forecast step at a time, falling back to the last one left', () => {
    expect(tcfForStep(areas, 0)).toMatchObject({ time: Date.UTC(2026, 9, 20, 3) / 1000 });
    expect(tcfForStep(areas, 1).areas).toHaveLength(2);
    expect(tcfForStep(areas, 2)).toMatchObject({ time: Date.UTC(2026, 9, 20, 7) / 1000 });
    expect(tcfForStep(areas.filter((a) => a.validTime < Date.UTC(2026, 9, 20, 7) / 1000), 2).time).toBe(Date.UTC(2026, 9, 20, 5) / 1000);
    expect(tcfForStep([], 0)).toEqual({ areas: [] });
  });

  it('ranks coverage on the severity ladder', () => {
    expect(tcfSeverity({ coverage: 'sparse', kind: 'area' })).toBe(2);
    expect(tcfSeverity({ coverage: 'medium', kind: 'area' })).toBe(3);
    expect(tcfSeverity({ coverage: 'solid', kind: 'area' })).toBe(4);
    expect(tcfSeverity({ coverage: '', kind: 'line' })).toBe(4);
    expect(tcfCoverageLabel({ coverage: 'medium', kind: 'area' })).toBe('medium (40-74% of the area)');
  });

  it('has a legend in the same colors', () => {
    const l = tcfLegend();
    expect(l.kind === 'items' && l.items.slice(0, 3).map((i) => i.color)).toEqual([2, 3, 4].map((s) => severityColor(s as 2)));
  });
});
