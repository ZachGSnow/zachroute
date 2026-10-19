import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonFixture, loadAirportSubset, stubBrowser, stubFetch } from './helpers';
import { describeFreezingLevel, fetchFreezingLevel, metersToFeet, routeFreezingSummary } from '../src/ts/freezingLevel';
import { fetchCruiseWind } from '../src/ts/windsAloft';
import { haversineDistance } from '../src/ts/geoMath';

const airports = loadAirportSubset();

beforeEach(() => {
  stubBrowser();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('freezing level wording', () => {
  it('converts meters to feet and rounds to the nearest 500 ft', () => {
    expect(metersToFeet(1000)).toBeCloseTo(3280.84, 1);
    expect(Number.isNaN(metersToFeet(null))).toBe(true);
    expect(describeFreezingLevel(metersToFeet(3940))).toBe('about 13,000 ft');
    expect(describeFreezingLevel(8740)).toBe('about 8,500 ft');
  });

  it('says "at the surface" when the 0 C level is at or just above the ground', () => {
    expect(describeFreezingLevel(5400, 5434)).toBe('at the surface'); // DEN elevation
    expect(describeFreezingLevel(5600, 5434)).toBe('at the surface');
    expect(describeFreezingLevel(6000, 5434)).toBe('about 6,000 ft');
    expect(describeFreezingLevel(NaN)).toBeNull();
  });

  it('summarizes a route, mentioning en route only when it is clearly lower', () => {
    const { ORD, DEN } = airports;
    expect(routeFreezingSummary([9500, 9400, 9600, 11000], ORD, DEN)).toBe('ORD about 9,500 ft, DEN about 11,000 ft');
    expect(routeFreezingSummary([9500, 7000, 9600, 11000], ORD, DEN)).toBe(
      'ORD about 9,500 ft, lowest about 7,000 ft en route, DEN about 11,000 ft'
    );
    expect(routeFreezingSummary([9500, NaN, 11000], ORD, DEN)).toBeNull();
  });
});

describe('freezing level from Open-Meteo', () => {
  it('comes with the cruise winds at each of the seven route points', async () => {
    const fixture = jsonFixture<any[]>('open-meteo-250hpa-fzl-7pts.json');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${fixture[0].hourly.time[12]}:00Z`));
    stubFetch([['api.open-meteo.com', fixture]]);
    const wind = await fetchCruiseWind(airports.ORD, airports.DEN, haversineDistance(airports.ORD, airports.DEN));
    expect(wind!.freezingLevelsFt).toHaveLength(7);
    expect(wind!.freezingLevelsFt[0]).toBeCloseTo(metersToFeet(fixture[0].hourly.freezing_level_height[12]), 3);
    expect(routeFreezingSummary(wind!.freezingLevelsFt, airports.ORD, airports.DEN)).toMatch(/^ORD about [\d,]+ ft, .*DEN about [\d,]+ ft$/);
  });

  it('reads the current level over an airport and caches it', async () => {
    const fixture = jsonFixture('open-meteo-fzl-anc.json');
    const { calls } = stubFetch([['current=freezing_level_height', fixture]]);
    const anc = { ...airports.ORD, iata: 'ANC', lat: 61.1744, lon: -149.996 };
    const ft = await fetchFreezingLevel(anc);
    expect(ft).toBeCloseTo(metersToFeet(fixture.current.freezing_level_height), 3);
    expect(await fetchFreezingLevel(anc)).toBe(ft);
    expect(calls).toHaveLength(1);
  });

  it('gives null rather than failing when the request does', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })));
    expect(await fetchFreezingLevel({ ...airports.ORD, lat: 10.5, lon: 20.5 })).toBeNull();
  });
});
