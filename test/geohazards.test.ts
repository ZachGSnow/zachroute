// USGS earthquakes and elevated volcanoes -> /api/geohazards, against real responses captured
// 19 Oct 2026: the M4.5+ day feed (trimmed to the 6 strongest and 6 weakest), the four US volcanoes
// at an elevated alert (Great Sitkin ORANGE; Shishaldin, Kilauea, Ahyi Seamount YELLOW), and Great
// Sitkin's volcano record.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonFixture, pagesContext, stubBrowser, stubFetch } from './helpers';
import { onRequest as geohazards, buildQuakes, buildVolcano } from '../functions/api/geohazards';
import { quakeSeverity, quakeRadius, volcanoSeverity, colorCodeLabel, volcanoesNear, volcanoChips, type Volcano } from '../src/ts/geohazards';
import { geohazardsLegend } from '../src/ts/legends';
import { severityColor } from '../src/ts/severity';

const json = async (res: Response) => JSON.parse(await res.text());
const quakeFeed = jsonFixture<any>('usgs-quakes-4.5-day.json');
const notices = jsonFixture<any[]>('usgs-elevated-volcanoes.json');
const sitkin = jsonFixture<any>('usgs-volcano-311120.json');

afterEach(() => vi.unstubAllGlobals());

describe('USGS earthquakes', () => {
  it('keeps earthquakes with a position, strongest first', () => {
    const out = buildQuakes(quakeFeed);
    expect(out).toHaveLength(quakeFeed.features.length);
    expect(out[0].mag).toBe(6);
    expect(out.map((q) => q.mag)).toEqual([...out.map((q) => q.mag)].sort((a, b) => b - a));
    const f = quakeFeed.features.find((x: any) => x.id === out[0].id);
    expect(out[0]).toMatchObject({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], place: f.properties.place, tsunami: false });
  });

  it('drops non-earthquakes and records without a magnitude', () => {
    const odd = structuredClone(quakeFeed);
    odd.features[0].properties.type = 'quarry blast';
    odd.features[1].properties.mag = null;
    expect(buildQuakes(odd)).toHaveLength(quakeFeed.features.length - 2);
  });

  it('puts magnitude on the ladder and sizes markers by it', () => {
    expect([4.5, 5.4, 5.5, 6.4, 6.5, 7.4, 7.5, 9].map(quakeSeverity)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(quakeRadius(4.5)).toBe(4);
    expect(quakeRadius(7.5)).toBe(16);
  });
});

describe('USGS volcanoes', () => {
  it('joins a notice with its volcano record for the position', () => {
    const v = buildVolcano(notices[0], sitkin)!;
    expect(v).toMatchObject({ name: 'Great Sitkin', colorCode: 'ORANGE', alertLevel: 'WATCH', lat: sitkin.latitude, lon: sitkin.longitude });
    expect(v.url).toContain('volcanoes.usgs.gov/hans-public/notice/');
    expect(buildVolcano(notices[0], null)).toBeNull();
  });

  it('puts the aviation color code on the ladder', () => {
    expect(['GREEN', 'YELLOW', 'ORANGE', 'RED', 'unassigned'].map(volcanoSeverity)).toEqual([null, 1, 2, 4, null]);
    expect(colorCodeLabel('RED')).toBe('RED (eruption with significant ash in the air)');
  });

  const greatSitkin = (): Volcano => buildVolcano(notices[0], sitkin)!;

  it('finds elevated volcanoes near an airport', () => {
    // Adak (ADK) is about 26 miles from Great Sitkin; Anchorage is far away.
    const [hit] = volcanoesNear(51.88, -176.65, [greatSitkin()]);
    expect(hit.miles).toBeLessThan(40);
    expect(volcanoesNear(61.17, -149.99, [greatSitkin()])).toEqual([]);
    expect(volcanoesNear(51.88, -176.65, [{ ...greatSitkin(), colorCode: 'GREEN' }])).toEqual([]);
  });

  it('turns a nearby volcano into an airport card chip', async () => {
    stubBrowser();
    stubFetch([['/api/geohazards', { quakes: [], volcanoes: [greatSitkin()] }]]);
    const chips = await volcanoChips({ lat: 51.88, lon: -176.65, country: 'US' } as any);
    expect(chips).toHaveLength(1);
    expect(chips[0].level).toBe('warn');
    expect(chips[0].text).toContain('Great Sitkin volcano');
    expect(chips[0].text).toContain('aviation code ORANGE (moderate)');
  });
});

describe('/api/geohazards', () => {
  it('serves quakes and positioned volcanoes', async () => {
    const records: Record<string, any> = { '311120': sitkin };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes('4.5_day.geojson')) return new Response(JSON.stringify(quakeFeed));
        if (url.includes('getElevatedVolcanoes')) return new Response(JSON.stringify(notices));
        const vnum = url.split('/').pop()!;
        return records[vnum] ? new Response(JSON.stringify(records[vnum])) : new Response('not found', { status: 404 });
      })
    );
    const out = await json(await geohazards(pagesContext('https://x/api/geohazards')));
    expect(out.complete).toBe(true);
    expect(out.quakes).toHaveLength(quakeFeed.features.length);
    // only the volcano whose record could be read has a position
    expect(out.volcanoes.map((v: any) => v.name)).toEqual(['Great Sitkin']);
  });

  it('still serves volcanoes when the quake feed is down, without caching', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes('getElevatedVolcanoes')) return new Response('[]');
        return new Response('down', { status: 503 });
      })
    );
    expect(await json(await geohazards(pagesContext('https://x/api/geohazards')))).toEqual({ quakes: [], volcanoes: [], complete: false });
  });

  it('has a legend in the ladder colors', () => {
    const l = geohazardsLegend();
    expect(l.kind === 'items' && l.items.slice(0, 4).map((i) => i.color)).toEqual([1, 2, 3, 4].map((s) => severityColor(s as 1)));
  });
});
