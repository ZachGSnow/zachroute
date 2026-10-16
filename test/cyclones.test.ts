// GDACS tropical cyclones -> /api/cyclones, against real responses captured in test/fixtures.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonFixture, pagesContext, stubFetch } from './helpers';
import { onRequest as cyclones, parseStorm, currentStorms, stormName, trackTime } from '../functions/api/cyclones';
import { stormsNearPoint, stormsAlongRoute, stormTitle, AIRPORT_RADIUS_MI, ROUTE_RADIUS_MI } from '../src/ts/cyclones';
import { compassPoint } from '../src/ts/forecast';

const json = async (res: Response) => JSON.parse(await res.text());

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GDACS tropical cyclones -> /api/cyclones', () => {
  it('keeps only current tropical cyclones from the event list', () => {
    const events = jsonFixture('gdacs-events.json');
    const list = currentStorms(events);
    expect(list.length).toBe(events.features.filter((f: any) => f.properties.eventtype === 'TC').length);
    expect(list.every((f: any) => f.properties.eventtype === 'TC')).toBe(true);

    // a storm GDACS has closed is dropped
    const ended = structuredClone(events);
    ended.features.find((f: any) => f.properties.eventtype === 'TC').properties.iscurrent = 'false';
    expect(currentStorms(ended)).toHaveLength(list.length - 1);
  });

  it('trims a storm to position, strength, track and cone', () => {
    const event = currentStorms(jsonFixture('gdacs-events.json')).find((e: any) => e.properties.eventid === 1001338);
    const storm = parseStorm(event, jsonFixture('gdacs-tc-geometry.json'));
    expect(storm.name).toBe('Champi');
    expect(storm.alert).toBe('Orange');
    expect(storm.source).toBe('JTWC');
    expect([storm.lat, storm.lon]).toEqual([11.4, 151.4]);
    expect(storm.asOf).toBe('2026-10-16T12:00:00.000Z');
    expect(storm.category).toBe('HU');

    // 17 track points from 14 Oct 12:00 to 21 Oct 12:00, in order; after the advisory they are forecasts
    expect(storm.track).toHaveLength(17);
    expect(storm.track[0].time).toBe('2026-10-14T12:00:00.000Z');
    expect(storm.track[16].time).toBe('2026-10-21T12:00:00.000Z');
    expect(storm.track.filter((t) => !t.forecast).map((t) => t.time).at(-1)).toBe('2026-10-16T12:00:00.000Z');
    expect(storm.track.filter((t) => t.forecast)).toHaveLength(8);
    // the advisory-time point sits on the storm position
    const nowPoint = storm.track.find((t) => t.time === '2026-10-16T12:00:00.000Z')!;
    expect(nowPoint.lat).toBeCloseTo(storm.lat, 0);
    expect(nowPoint.lon).toBeCloseTo(storm.lon, 0);

    expect(storm.cone!.length).toBeGreaterThan(20);
    expect(storm.cone!.length).toBeLessThanOrEqual(90);
    expect(storm.report).toContain('gdacs.org/report.aspx');
  });

  it('still returns a position when the geometry request fails', () => {
    const event = currentStorms(jsonFixture('gdacs-events.json'))[0];
    const storm = parseStorm(event, null);
    expect(storm.track).toEqual([]);
    expect(storm.cone).toBeUndefined();
    expect(Number.isFinite(storm.lat)).toBe(true);
  });

  it('serves every current storm, fetching each geometry', async () => {
    const events = jsonFixture('gdacs-events.json');
    const { calls } = stubFetch([
      ['geteventlist', events],
      ['getgeometry', jsonFixture('gdacs-tc-geometry.json')],
    ]);
    const out = await json(await cyclones(pagesContext('https://x/api/cyclones')));
    expect(out.available).toBe(true);
    expect(out.storms).toHaveLength(currentStorms(events).length);
    expect(calls.filter((u) => u.includes('getgeometry'))).toHaveLength(currentStorms(events).length);
  });

  it('reports unavailable when GDACS is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const out = await json(await cyclones(pagesContext('https://x/api/cyclones')));
    expect(out).toEqual({ available: false, storms: [] });
  });
});

describe('GDACS helpers', () => {
  it('names storms the way advisories do', () => {
    expect(stormName('CHAMPI-26')).toBe('Champi');
    expect(stormName('Tropical Cyclone FUNG-WONG-25')).toBe('Fung-Wong');
  });

  it('dates track labels in the advisory year, rolling into January', () => {
    expect(trackTime('16/10 12:00 UTC', '2026-10-16T12:00:00')).toBe('2026-10-16T12:00:00.000Z');
    expect(trackTime('02/01 00:00 UTC', '2026-12-30T18:00:00')).toBe('2027-01-02T00:00:00.000Z');
    expect(trackTime('Centroid', '2026-10-16T12:00:00')).toBeUndefined();
  });
});

describe('tropical cyclones near airports and routes', () => {
  // Typhoon Champi (JTWC via GDACS, 16 Oct 2026 12:00 UTC): at 11.4N 151.4E, forecast to pass
  // close to Guam on 18 Oct.
  const champi = () => {
    const event = currentStorms(jsonFixture('gdacs-events.json')).find((e: any) => e.properties.eventid === 1001338);
    return parseStorm(event, jsonFixture('gdacs-tc-geometry.json'));
  };

  it('flags an airport inside the forecast cone even when the storm is still far away', () => {
    const [hit] = stormsNearPoint(13.48, 144.8, [champi()]); // Guam
    expect(hit.inCone).toBe(true);
    expect(hit.miles).toBeGreaterThan(AIRPORT_RADIUS_MI);
    expect(compassPoint(hit.bearing)).toBe('ESE');
  });

  it('flags an airport near the center but outside the cone, and ignores far ones', () => {
    const [chuuk] = stormsNearPoint(7.46, 151.84, [champi()]);
    expect(chuuk.inCone).toBe(false);
    expect(chuuk.miles).toBeLessThan(AIRPORT_RADIUS_MI);
    expect(stormsNearPoint(15.12, 145.73, [champi()])).toEqual([]); // Saipan: 460 mi, north of the cone
    expect(stormsNearPoint(14.51, 121.02, [champi()])).toEqual([]); // Manila
  });

  it('finds a route that passes near the storm and through its cone', () => {
    const route = slerp([13.48, 144.8], [7.06, 171.27]); // Guam to Majuro
    const [hit] = stormsAlongRoute(route, [champi()]);
    expect(hit.crossesCone).toBe(true);
    expect(hit.miles).toBeLessThan(ROUTE_RADIUS_MI);
  });

  it('ignores a route that stays clear of the storm and its cone', () => {
    expect(stormsAlongRoute(slerp([7.37, 134.54], [14.51, 121.02]), [champi()])).toEqual([]); // Palau to Manila
  });

  it('names the storm by its current strength', () => {
    expect(stormTitle(champi())).toBe('Hurricane / typhoon Champi');
    expect(stormTitle({ ...champi(), category: undefined })).toBe('Tropical cyclone Champi');
  });
});

/** Points along a straight lat/lon line, dense enough for these checks. */
function slerp(a: [number, number], b: [number, number], n = 200): Array<[number, number]> {
  return Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n] as [number, number]);
}
