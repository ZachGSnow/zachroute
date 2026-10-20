// Tap a chip to see it on the map: the geometry each kind of item hands the map, from real data.
// nws-alerts-shapes.json holds a storm-based Flood Warning (its own polygon) and a zone-based Flood
// Watch (AZZ001 only); nws-zone-azz001.json is that zone's outline (api.weather.gov, 2026-10-20).
import { beforeEach, describe, expect, it } from 'vitest';
import { jsonFixture, loadAirportSubset, stubBrowser, stubFetch } from './helpers';
import { focusAttrs, focusBounds, geoJsonRings, getFocus, nwsFocus, resolveZones, clearFocusRegistry, type FocusTarget } from '../src/ts/focusTarget';
import { nwsAlertChips } from '../src/ts/advisories';
import { stormFocus } from '../src/ts/cyclones';
import { tfrFocus } from '../src/ts/tfr';

const shapes = jsonFixture('nws-alerts-shapes.json');
const [warning, watch] = shapes.features;
const zone = jsonFixture('nws-zone-azz001.json');

beforeEach(() => {
  stubBrowser();
  clearFocusRegistry();
});

describe('NWS alerts', () => {
  it('uses a warning area as drawn, flipped to lat, lon', () => {
    const t = nwsFocus(warning, [28.4, -81.3]);
    expect(t.shapes).toHaveLength(1);
    const [lon, lat] = warning.geometry.coordinates[0][0];
    expect(t.shapes[0][0]).toEqual([lat, lon]);
    expect(t.zones).toEqual([]);
    const b = focusBounds(t)!;
    expect(b.south).toBeLessThan(b.north);
    expect(b.west).toBeLessThan(b.east);
    expect(b.west).toBeGreaterThan(-82); // Lake and Volusia counties, Florida
    expect(b.east).toBeLessThan(-80);
  });

  it('fetches the forecast zones of an alert without an area', async () => {
    const t = nwsFocus(watch, [35.6, -112.1]);
    expect(t.shapes).toEqual([]);
    expect(t.zones).toEqual(['https://api.weather.gov/zones/forecast/AZZ001']);
    const { calls } = stubFetch([['zones/forecast/AZZ001', zone]]);
    const full = await resolveZones(t);
    expect(full.shapes).toHaveLength(1);
    expect(full.shapes[0].length).toBe(zone.geometry.coordinates[0].length);
    await resolveZones(t);
    expect(calls).toHaveLength(1); // zones are cached
    const b = focusBounds(full)!;
    expect(b.north).toBeGreaterThan(35);
    expect(b.east).toBeLessThan(-111);
  });

  it('falls back to the airport when a zone will not load', async () => {
    stubFetch([['zones/forecast/', { status: 404 }]]);
    const t = await resolveZones(nwsFocus({ ...watch, properties: { ...watch.properties, affectedZones: ['https://api.weather.gov/zones/forecast/XXZ999'] } }, [35, -112]));
    expect(t.shapes).toEqual([]);
    expect(focusBounds(t)).toEqual({ south: 35, west: -112, north: 35, east: -112 });
  });

  it('gives each card chip its alert, and asks only for real (not test) alerts', async () => {
    const { calls } = stubFetch([['api.weather.gov/alerts/active', shapes]]);
    const chips = await nwsAlertChips({ ...loadAirportSubset().ORD, lat: 28.6, lon: -81.2 });
    expect(chips).toHaveLength(2);
    expect(chips.every((c) => c.focus)).toBe(true);
    expect(calls[0]).toContain('status=actual');
  });
});

describe('other items', () => {
  it('frames a storm by its center, track and cone', () => {
    const t = stormFocus(
      { id: 1, name: 'Test', alert: 'Red', lat: 20, lon: -60, asOf: '', track: [{ lat: 18, lon: -55, time: '', forecast: false }, { lat: 20, lon: -60, time: '', forecast: false }, { lat: 24, lon: -66, time: '', forecast: true }], cone: [[20, -60], [26, -64], [22, -70]] },
      'Hurricane Test'
    );
    expect(t.points).toEqual([[20, -60]]);
    expect(t.lines).toHaveLength(1);
    expect(focusBounds(t)).toEqual({ south: 18, west: -70, north: 26, east: -55 });
  });

  it('frames a TFR by its rings', () => {
    const t = tfrFocus({ id: '6/1234', type: 'SECURITY', description: 'WASHINGTON, DC', url: 'https://tfr.faa.gov', rings: [[[38.8, -77.1], [38.9, -77.0], [38.8, -76.9]]] });
    expect(focusBounds(t)).toEqual({ south: 38.8, west: -77.1, north: 38.9, east: -76.9 });
  });

  it('keeps a shape across the antimeridian narrow', () => {
    const t: FocusTarget = { title: 'Pacific SIGMET', shapes: [[[50, 175], [52, -175], [48, -178]]], points: [] };
    const b = focusBounds(t)!;
    expect(b.east - b.west).toBeLessThan(20);
    expect(b.west).toBe(175);
  });

  it('reads GeoJSON multipolygons, outer rings only', () => {
    const rings = geoJsonRings({ type: 'MultiPolygon', coordinates: [[[[1, 2], [3, 4], [5, 6]], [[0, 0], [0, 1], [1, 1]]], [[[7, 8], [9, 10], [11, 12]]]] });
    expect(rings).toEqual([
      [[2, 1], [4, 3], [6, 5]],
      [[8, 7], [10, 9], [12, 11]],
    ]);
  });
});

describe('tappable markup', () => {
  it('marks items with a place and leaves the rest alone', () => {
    const attrs = focusAttrs({ title: 'Report', shapes: [], points: [[41, -87]] });
    expect(attrs).toMatch(/^ data-focus="f\d+" role="button" tabindex="0"$/);
    const id = attrs.match(/data-focus="(f\d+)"/)![1];
    expect(getFocus(id)!.title).toBe('Report');
    expect(focusAttrs(undefined)).toBe('');
    expect(focusAttrs({ title: 'FAA delay', shapes: [], points: [] })).toBe('');
    clearFocusRegistry();
    expect(getFocus(id)).toBeUndefined();
  });
});
