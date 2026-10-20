// Client modules run against real upstream responses (fixtures) and the real bundled data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonFixture, loadAirportSubset, pagesContext, readFixture, stubBrowser, stubFetch } from './helpers';

import { onRequest as tafFn } from '../functions/api/taf';
import { onRequest as faaFn } from '../functions/api/faa-status';
import { onRequest as pirepFn } from '../functions/api/pireps';
import { decodeTaf, parseVisibilityMiles, flightCategoryFor, describePeriod } from '../src/ts/forecast';
import { summarizePirep } from '../src/ts/pirepText';
import { faaDelayChips, nwsAlertChips } from '../src/ts/advisories';
import { fetchCruiseWind } from '../src/ts/windsAloft';
import { fetchAirportPhoto } from '../src/ts/wikiPhoto';
import { loadAirports, parseQuery } from '../src/ts/searchParser';
import { findRunwayEnd, approachTicks, departureLine, bestEndForCourse } from '../src/ts/approach';
import { carriersFor, carrierNames } from '../src/ts/carriers';
import { haversineDistance, destinationPoint, haversineDistanceLatLon } from '../src/ts/geoMath';

const json = async (res: Response) => JSON.parse(await res.text());
const airports = loadAirportSubset();

beforeEach(() => {
  stubBrowser();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('TAF decoding (aviationweather.gov TAF through /api/taf)', () => {
  it('turns the real forecast into plain-English rows and an outlook', async () => {
    const raw = jsonFixture('awc-taf-kord.json')[0];
    stubFetch([['aviationweather.gov', jsonFixture('awc-taf-kord.json')]]);
    const snapshot = await json(await tafFn(pagesContext('https://x/api/taf?icao=KORD')));

    vi.useFakeTimers();
    vi.setSystemTime(new Date((raw.validTimeFrom + 1800) * 1000));
    const decoded = decodeTaf(snapshot, 'America/Chicago');
    expect(decoded).not.toBeNull();
    expect(decoded!.count).toBe(raw.fcsts.length);
    expect(decoded!.headline).toMatch(/^\S+ (Expected to stay|Conditions (drop|improve))/u);
    expect(decoded!.rows[0]).toContain('Now until');
    expect(describePeriod(snapshot.periods[0])).toMatch(/wind|calm/i);
  });

  it('parses visibility strings and flight categories', () => {
    expect(parseVisibilityMiles('6+')).toBe(6);
    expect(parseVisibilityMiles('1 1/2')).toBe(1.5);
    expect(flightCategoryFor(10, 800)).toBe('IFR');
    expect(flightCategoryFor(4, 5000)).toBe('MVFR');
    expect(flightCategoryFor(10, undefined)).toBe('VFR');
  });
});

describe('PIREP wording (aviationweather.gov PIREP)', () => {
  it('summarizes every notable real report and skips smooth ones', async () => {
    const raw = jsonFixture<any[]>('awc-pirep-bbox.json');
    stubFetch([['pirep?bbox=', raw]]);
    const out = await json(await pirepFn(pagesContext('https://x/api/pireps?bbox=36,-95,46,-80')));
    for (const r of out.reports) expect(summarizePirep(r)).not.toBeNull();
    expect(summarizePirep({ obsTime: 0, lat: 0, lon: 0, turb: 'NEG', icing: 'NEG' })).toBeNull();
    expect(summarizePirep({ obsTime: 0, lat: 0, lon: 0, turb: 'MOD' })!.headline).toBe('Moderate turbulence (rough ride)');
    expect(summarizePirep({ obsTime: 0, lat: 0, lon: 0, icing: 'LGT' })!.kind).toBe('ice');
  });
});

describe('FAA delay chips (nasstatus.faa.gov through /api/faa-status)', () => {
  it('shows a ground delay program for an affected airport', async () => {
    stubFetch([['nasstatus.faa.gov', readFixture('faa-status-delays.xml')]]);
    const status = await json(await faaFn(pagesContext('https://x/api/faa-status')));
    stubFetch([['/api/faa-status', status]]);
    const chips = await faaDelayChips({ ...airports.ORD });
    expect(chips.map((c) => c.text).join(' | ')).toMatch(/Ground delay program, avg 1 hour and 21 minutes/);
    expect(chips.some((c) => /Departure delays/.test(c.text))).toBe(true);
  });
});

describe('NWS alerts (api.weather.gov)', () => {
  it('turns active alerts into chips ordered by severity', async () => {
    const fixture = jsonFixture('nws-alerts.json');
    stubFetch([['api.weather.gov/alerts/active', fixture]]);
    const chips = await nwsAlertChips({ ...airports.DEN, lat: 39.9, lon: -104.6 });
    expect(chips.length).toBe(Math.min(fixture.features.length, 4));
    const events = fixture.features.map((f: any) => f.properties.event);
    for (const c of chips) expect(events).toContain(c.text);
    const order = { alert: 0, warn: 1, info: 2 } as const;
    for (let i = 1; i < chips.length; i++) expect(order[chips[i - 1].level]).toBeLessThanOrEqual(order[chips[i].level]);
  });
});

describe('Cruise winds (Open-Meteo)', () => {
  it('resolves seven forecast points into headwind samples', async () => {
    const fixture = jsonFixture<any[]>('open-meteo-250hpa-7pts.json');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${fixture[0].hourly.time[6]}:00Z`));
    stubFetch([['api.open-meteo.com', fixture]]);
    const miles = haversineDistance(airports.ORD, airports.DEN);
    const wind = await fetchCruiseWind(airports.ORD, airports.DEN, miles);
    expect(wind).not.toBeNull();
    expect(wind!.samples).toHaveLength(7);
    expect(wind!.levelLabel).toBe('~34,000 ft'); // ORD-DEN is about 888 miles, so the 250 hPa level
    expect(Number.isFinite(wind!.headwindKt)).toBe(true);
    expect(wind!.samples[0].frac).toBe(0);
    expect(wind!.samples[6].frac).toBe(1);
  });
});

describe('Airport photo (Wikipedia REST summary)', () => {
  it('returns the article thumbnail and caches it', async () => {
    const summary = jsonFixture('wikipedia-summary-ord.json');
    const { calls } = stubFetch([['rest_v1/page/summary', summary]]);
    const link = "https://en.wikipedia.org/wiki/O'Hare_International_Airport";
    expect(await fetchAirportPhoto(link)).toBe(summary.thumbnail.source);
    expect(await fetchAirportPhoto(link)).toBe(summary.thumbnail.source);
    expect(calls).toHaveLength(1);
  });
});

describe('Search', () => {
  loadAirports(airports);
  const code = (a: any) => a.iata || a.icao;
  const route = (q: string) => {
    const i: any = parseQuery(q);
    return i.mode === 'ROUTE' ? `${code(i.origin)}-${code(i.destination)}` : i.mode === 'SINGLE' ? code(i.airport) : i.mode;
  };

  it.each([
    ['ORD', 'ORD'],
    ['ord den', 'ORD-DEN'],
    ['Chicago', 'ORD'],
    ['chicago to denver', 'ORD-DEN'],
    ['chicago denver', 'ORD-DEN'],
    ['ord denver', 'ORD-DEN'],
    ['salt lake city boston', 'SLC-BOS'],
    ['new york', 'JFK'],
    ['ohare', 'ORD'],
    ['portland or', 'PDX'],
    ['portland me', 'PWM'],
    ['london uk', 'LHR'],
    ['denver', 'DEN'],
    ['kansas city new york', 'MCI-JFK'],
    ['san jose costa rica', 'SJO'],
    ['zzzz', 'INVALID'],
  ])('%s -> %s', (q, expected) => {
    expect(route(q)).toBe(expected);
  });

  it('offers other airports in the same city', () => {
    const i: any = parseQuery('chicago');
    expect(i.alternatives.map(code)).toContain('MDW');
  });
});

describe('Approach geometry (OurAirports runway ends)', () => {
  it('builds a 10 nm approach with 3 degree glide heights', () => {
    const end = findRunwayEnd(airports.DEN, '16R');
    expect(end).not.toBeNull();
    const ticks = approachTicks(end!);
    expect(ticks.map((t) => t.distNm)).toEqual([2, 4, 6, 8, 10]);
    expect(ticks.map((t) => t.heightFt)).toEqual([600, 1300, 1900, 2500, 3200]);
    const tenOut = ticks[4].center;
    expect(haversineDistanceLatLon(end!.threshold.lat, end!.threshold.lon, tenOut.lat, tenOut.lon)).toBeCloseTo(11.5, 0); // 10 nm in statute miles
  });

  it('departs straight out past the far end and picks the best-aligned end', () => {
    const end = findRunwayEnd(airports.DEN, '16R')!;
    expect(departureLine(end)).toHaveLength(3);
    expect(bestEndForCourse(airports.DEN, 270)!.headingDegT).toBeGreaterThan(240);
    const p = destinationPoint(0, 0, 90, 60);
    expect(p.lat).toBeCloseTo(0, 5);
    expect(p.lon).toBeCloseTo(1, 1);
  });
});

describe('Airlines (bundled US DOT-derived data)', () => {
  it('lists current carriers for a US route', () => {
    const list = carriersFor(airports.ORD, airports.DEN);
    expect(list.length).toBeGreaterThan(0);
    expect(carrierNames(list)).toMatch(/United/);
    // routes between US and foreign airports have airlines from T-100, foreign ones named from US DOT
    const intl = carriersFor(airports.ORD, airports.LHR);
    expect(intl.map((c) => c.code)).toContain('BA');
    expect(intl.find((c) => c.code === 'BA')!.name).toBe('British Airways');
  });
});
