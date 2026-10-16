// Pages Functions run against real upstream responses captured in test/fixtures.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { jsonFixture, pagesContext, readFixture, stubFetch } from './helpers';

import { onRequest as weather } from '../functions/api/weather';
import { onRequest as taf } from '../functions/api/taf';
import { onRequest as pireps } from '../functions/api/pireps';
import { onRequest as metarBbox } from '../functions/api/metar-bbox';
import { onRequest as airsigmet } from '../functions/api/airsigmet';
import { onRequest as faaStatus } from '../functions/api/faa-status';
import { onRequest as lore } from '../functions/api/lore';

const json = async (res: Response) => JSON.parse(await res.text());

afterEach(() => {
  vi.useRealTimers();
});

describe('aviationweather.gov METAR -> /api/weather', () => {
  it('maps the real METAR fields', async () => {
    const raw = jsonFixture('awc-metar-kord.json')[0];
    stubFetch([['aviationweather.gov/api/data/metar', jsonFixture('awc-metar-kord.json')]]);
    const out = await json(await weather(pagesContext('https://x/api/weather?icao=KORD')));
    expect(out.available).toBe(true);
    expect(out.flightCategory).toBe(raw.fltCat);
    expect(out.windDirDeg).toBe(raw.wdir);
    expect(out.windSpeedKt).toBe(raw.wspd);
    expect(out.tempF).toBe(Math.round((raw.temp * 9) / 5 + 32));
    expect(out.ceilingFt).toBe(3600); // lowest BKN/OVC layer in the fixture
    expect(out.observedIso).toBe(raw.reportTime);
  });

  it('reports unavailable for an empty response', async () => {
    stubFetch([['aviationweather.gov', []]]);
    const out = await json(await weather(pagesContext('https://x/api/weather?icao=KXYZ')));
    expect(out.available).toBe(false);
  });
});

describe('aviationweather.gov TAF -> /api/taf', () => {
  it('keeps every forecast period with its times and change type', async () => {
    const raw = jsonFixture('awc-taf-kord.json')[0];
    stubFetch([['aviationweather.gov/api/data/taf', jsonFixture('awc-taf-kord.json')]]);
    const out = await json(await taf(pagesContext('https://x/api/taf?icao=KORD')));
    expect(out.available).toBe(true);
    expect(out.periods).toHaveLength(raw.fcsts.length);
    expect(out.periods[0].from).toBe(raw.fcsts[0].timeFrom);
    expect(out.periods.map((p: any) => p.change ?? null)).toEqual(raw.fcsts.map((f: any) => f.fcstChange ?? null));
    expect(out.periods[0].clouds.length).toBe(raw.fcsts[0].clouds.length);
  });
});

describe('aviationweather.gov PIREP -> /api/pireps', () => {
  it('returns trimmed reports for an airport', async () => {
    const raw = jsonFixture<any[]>('awc-pirep-kord.json');
    stubFetch([['pirep?id=KORD', raw]]);
    const out = await json(await pireps(pagesContext('https://x/api/pireps?icao=KORD')));
    expect(out.reports).toHaveLength(raw.length);
    for (const r of out.reports) {
      expect(typeof r.lat).toBe('number');
      expect(typeof r.obsTime).toBe('number');
    }
  });

  it('keeps only notable reports in bbox mode', async () => {
    const raw = jsonFixture<any[]>('awc-pirep-bbox.json');
    stubFetch([['pirep?bbox=', raw]]);
    const out = await json(await pireps(pagesContext('https://x/api/pireps?bbox=36,-95,46,-80')));
    const none = new Set(['', 'NEG', 'SMTH', 'NONE']);
    const expected = raw.filter(
      (p) =>
        !none.has(String(p.tbInt1 || '').toUpperCase()) ||
        !none.has(String(p.icgInt1 || '').toUpperCase()) ||
        (typeof p.visib === 'number' && p.visib < 3)
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(out.reports).toHaveLength(expected.length);
    expect(out.reports.every((r: any) => r.turb || r.icing || (r.visib ?? 99) < 3)).toBe(true);
  });

  it('rejects an oversized bbox', async () => {
    stubFetch([]);
    const res = await pireps(pagesContext('https://x/api/pireps?bbox=0,-170,60,10'));
    expect(res.status).toBe(400);
  });
});

describe('aviationweather.gov METAR bbox -> /api/metar-bbox', () => {
  it('returns one station per METAR with category and wind', async () => {
    const raw = jsonFixture<any[]>('awc-metar-bbox.json');
    stubFetch([['metar?bbox=', raw]]);
    const out = await json(await metarBbox(pagesContext('https://x/api/metar-bbox?bbox=41,-89,43,-87')));
    expect(out.stations).toHaveLength(raw.length);
    expect(out.stations[0].id).toBe(raw[0].icaoId);
    expect(out.stations[0].cat).toBe(raw[0].fltCat);
  });
});

describe('aviationweather.gov AIRMET/SIGMET -> /api/airsigmet', () => {
  it('turns coordinate objects into [lat, lon] polygons', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1792149000 * 1000)); // inside every fixture advisory's validity
    const raw = jsonFixture<any[]>('awc-airsigmet.json');
    stubFetch([['airsigmet', raw]]);
    const out = await json(await airsigmet(pagesContext('https://x/api/airsigmet')));
    expect(out.advisories).toHaveLength(raw.length);
    expect(out.advisories[0].coords[0]).toEqual([raw[0].coords[0].lat, raw[0].coords[0].lon]);
    expect(out.advisories[0].hazard).toBe(raw[0].hazard);
  });

  it('drops expired advisories', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1792160000 * 1000)); // after every fixture advisory ended
    stubFetch([['airsigmet', jsonFixture('awc-airsigmet.json')]]);
    const out = await json(await airsigmet(pagesContext('https://x/api/airsigmet')));
    expect(out.advisories).toHaveLength(0);
  });
});

describe('FAA NAS status XML -> /api/faa-status', () => {
  it('parses ground delay programs and arrival/departure delays', async () => {
    stubFetch([['nasstatus.faa.gov', readFixture('faa-status-delays.xml')]]);
    const out = await json(await faaStatus(pagesContext('https://x/api/faa-status')));
    expect(out.available).toBe(true);
    expect(out.airports.SAN.groundDelay.avg).toBe('39 minutes');
    expect(out.airports.ORD.groundDelay.reason).toBe('other');
    expect(out.airports.BOS.delay).toMatchObject({ type: 'Departure', min: '31 minutes', max: '45 minutes', trend: 'Increasing' });
  });

  it('ignores airport closures (often partial NOTAM closures)', async () => {
    stubFetch([['nasstatus.faa.gov', readFixture('faa-status-closures.xml')]]);
    const out = await json(await faaStatus(pagesContext('https://x/api/faa-status')));
    expect(out.available).toBe(true);
    expect(out.airports.SNA).toBeUndefined();
  });
});

describe('Wikipedia search + summary -> /api/lore', () => {
  it('returns the summary of the first search hit', async () => {
    const summary = jsonFixture('wikipedia-summary-ord.json');
    stubFetch([
      ['w/api.php', jsonFixture('wikipedia-search-ord.json')],
      ['rest_v1/page/summary', summary],
    ]);
    const out = await json(await lore(pagesContext('https://x/api/lore?iata=ORD')));
    expect(out.title).toBe(summary.title);
    expect(out.extract).toBe(summary.extract);
    expect(out.thumbnail).toBe(summary.thumbnail.source);
  });
});
