// Pages Functions run against real upstream responses captured in test/fixtures.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { jsonFixture, pagesContext, readFixture, stubFetch } from './helpers';

import { onRequest as weather } from '../functions/api/weather';
import { onRequest as taf } from '../functions/api/taf';
import { onRequest as pireps } from '../functions/api/pireps';
import { onRequest as metarBbox } from '../functions/api/metar-bbox';
import { onRequest as airsigmet, readQualifier, unwrapRing } from '../functions/api/airsigmet';
import { onRequest as faaStatus } from '../functions/api/faa-status';
import { onRequest as lore } from '../functions/api/lore';
import { summaryMatchesAirport, titleFromWikipediaLink } from '../shared/wikiLore.js';
import { englishWikiTitle } from '../src/ts/wikiPhoto';

/** [URL substring, status, body]: like stubFetch, but with a status per route. First match wins. */
type Route = [string, number, unknown];
function routeFetch(routes: Route[]) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      const hit = routes.find(([needle]) => url.includes(needle));
      if (!hit) throw new Error(`Unexpected fetch in test: ${url}`);
      return new Response(typeof hit[2] === 'string' ? hit[2] : JSON.stringify(hit[2]), { status: hit[1] });
    })
  );
  return { calls };
}

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
    expect(out.tempC).toBe(raw.temp);
    expect(out.dewpointC).toBe(raw.dewp);
    expect(out.altimeterHpa).toBe(Math.round(raw.altim));
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

  it('keeps temperature and dewpoint in degrees C, and leaves them out when not reported', async () => {
    const raw = jsonFixture<any[]>('awc-metar-bbox.json');
    stubFetch([['metar?bbox=', raw]]);
    const out = await json(await metarBbox(pagesContext('https://x/api/metar-bbox?bbox=41,-89,43,-87')));
    expect(out.stations[0].t).toBe(raw[0].temp);
    expect(out.stations[0].d).toBe(raw[0].dewp);
    const missing = raw.findIndex((m) => typeof m.temp !== 'number');
    expect(missing).toBeGreaterThan(-1);
    expect(out.stations[missing].t).toBeUndefined();
    expect(out.stations[missing].d).toBeUndefined();
  });
});

describe('aviationweather.gov AIRMET/SIGMET + international SIGMET -> /api/airsigmet', () => {
  it('turns US coordinate objects into [lat, lon] polygons', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1792149000 * 1000)); // inside every US fixture advisory's validity
    const raw = jsonFixture<any[]>('awc-airsigmet.json');
    stubFetch([
      ['/airsigmet', raw],
      ['/isigmet', []],
    ]);
    const out = await json(await airsigmet(pagesContext('https://x/api/airsigmet')));
    expect(out.advisories).toHaveLength(raw.length);
    expect(out.advisories[0].coords[0]).toEqual([raw[0].coords[0].lat, raw[0].coords[0].lon]);
    expect(out.advisories[0].hazard).toBe(raw[0].hazard);
  });

  it('drops expired advisories', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1792190000 * 1000)); // after every fixture advisory ended
    stubFetch([
      ['/airsigmet', jsonFixture('awc-airsigmet.json')],
      ['/isigmet', jsonFixture('awc-isigmet.json')],
    ]);
    const out = await json(await airsigmet(pagesContext('https://x/api/airsigmet')));
    expect(out.advisories).toHaveLength(0);
  });

  it('adds international SIGMETs with hazards mapped to the US names', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1792172000 * 1000)); // inside every international fixture record's validity
    const raw = jsonFixture<any[]>('awc-isigmet.json');
    stubFetch([
      ['/airsigmet', []],
      ['/isigmet', raw],
    ]);
    const out = await json(await airsigmet(pagesContext('https://x/api/airsigmet')));
    const hazards = out.advisories.map((a: any) => a.hazard);
    expect(hazards).toContain('ASH');
    expect(hazards).toContain('TC');
    expect(hazards).toContain('CONVECTIVE');
    expect(hazards).not.toContain('TS');
    expect(out.advisories.every((a: any) => a.type === 'SIGMET' && a.coords.length >= 3)).toBe(true);

    const ash = out.advisories.find((a: any) => a.hazard === 'ASH');
    expect(ash.name).toBe('Mt Ibu');
    expect(ash.region).toBe('Ujung Pandang');
    expect(ash.altLow).toBe(0);
    expect(ash.altHigh).toBe(6000);
    expect(out.advisories.find((a: any) => a.hazard === 'TC').name).toBe('Champi');
  });

  it('splits multi-area SIGMETs and drops ones without a usable polygon', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1792172000 * 1000));
    const raw = jsonFixture<any[]>('awc-isigmet.json');
    stubFetch([
      ['/airsigmet', []],
      ['/isigmet', raw],
    ]);
    const out = await json(await airsigmet(pagesContext('https://x/api/airsigmet')));
    const multi = raw.find((r) => r.geom === 'AREAS');
    const single = raw.filter((r) => r.geom !== 'AREAS' && Array.isArray(r.coords) && r.coords.length >= 3);
    // one advisory per usable ring; the record with a single position is dropped
    expect(out.advisories).toHaveLength(single.length + multi.coords.length);
  });

  it('drops a SIGMET the international feed lists twice', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1792172000 * 1000));
    const raw = jsonFixture<any[]>('awc-isigmet.json');
    const tc = raw.find((r) => r.hazard === 'TC');
    stubFetch([
      ['/airsigmet', []],
      ['/isigmet', [...raw, structuredClone(tc)]],
    ]);
    const out = await json(await airsigmet(pagesContext('https://x/api/airsigmet')));
    expect(out.advisories.filter((a: any) => a.hazard === 'TC')).toHaveLength(1);
  });

  it('keeps the US list when the international feed fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1792149000 * 1000));
    const raw = jsonFixture<any[]>('awc-airsigmet.json');
    const fn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/isigmet')) return new Response('upstream error', { status: 502 });
      return new Response(JSON.stringify(raw), { status: 200 });
    });
    vi.stubGlobal('fetch', fn);
    const out = await json(await airsigmet(pagesContext('https://x/api/airsigmet')));
    expect(out.advisories).toHaveLength(raw.length);
  });
});

describe('international SIGMET helpers', () => {
  it('reads intensity words, volcano names and storm names from the qualifier', () => {
    expect(readQualifier('TS', 'EMBD')).toEqual({ detail: 'embedded' });
    expect(readQualifier('TURB', 'SEV MTW')).toEqual({ detail: 'severe mountain wave' });
    expect(readQualifier('VA', 'ERUPTION MT NEVADOS DE CHILLAN')).toEqual({ name: 'Mt Nevados De Chillan' });
    expect(readQualifier('VA', 'FUEGO')).toEqual({ name: 'Fuego' });
    expect(readQualifier('TC', 'TRUDY')).toEqual({ name: 'Trudy' });
    expect(readQualifier('TS', null)).toEqual({});
  });

  it('unwraps a ring that crosses the antimeridian', () => {
    expect(
      unwrapRing([
        [10, 175],
        [10, -178],
        [5, -178],
        [5, 175],
      ])
    ).toEqual([
      [10, 175],
      [10, 182],
      [5, 182],
      [5, 175],
    ]);
    expect(
      unwrapRing([
        [10, -178],
        [10, 175],
        [5, -178],
      ])
    ).toEqual([
      [10, -178],
      [10, -185],
      [5, -178],
    ]);
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

describe('Wikipedia article lookup -> /api/lore', () => {
  // Real responses for Heraklion (HER), whose code is also an English word. The title OurAirports
  // links to no longer exists on Wikipedia (404), the "HER airport" search ranks the pronoun's
  // disambiguation page first, and a search by the airport's name finds the real article.
  const HER = '&name=Heraklion%20International%20Nikos%20Kazantzakis%20Airport&lat=35.3397&lon=25.1803';
  const herRoutes = (): Route[] => [
    ['summary/Heraklion_International_Airport_Nikos_Kazantzakis', 404, { type: 'Internal error' }],
    ['summary/Heraklion_International_Airport_%22Nikos_Kazantzakis%22', 200, jsonFixture('wikipedia-summary-her.json')],
    ['summary/Her', 200, jsonFixture('wikipedia-summary-her-disambiguation.json')],
    ['summary/', 404, { type: 'Internal error' }],
    ['srsearch=Heraklion', 200, jsonFixture('wikipedia-search-her-name.json')],
    ['srsearch=HER%20airport', 200, jsonFixture('wikipedia-search-her-code.json')],
  ];

  it('finds the airport by name when the linked article is missing (HER is not "Her")', async () => {
    const { calls } = routeFetch(herRoutes());
    const res = await lore(
      pagesContext(`https://x/api/lore?iata=HER&title=Heraklion%20International%20Airport%20Nikos%20Kazantzakis${HER}`)
    );
    const out = await json(res);
    expect(res.status).toBe(200);
    expect(out.iata).toBe('HER');
    expect(out.title).toBe(jsonFixture('wikipedia-summary-her.json').title);
    expect(out.extract).not.toMatch(/pronoun/);
    expect(calls.some((u) => u.includes('srsearch=HER%20airport'))).toBe(false);
  });

  it('uses the linked article directly when it exists, without searching', async () => {
    const summary = jsonFixture('wikipedia-summary-ord.json');
    const { calls } = routeFetch([["summary/O'Hare_International_Airport", 200, summary]]);
    const out = await json(
      await lore(pagesContext("https://x/api/lore?iata=ORD&title=O'Hare%20International%20Airport&lat=41.9786&lon=-87.9048"))
    );
    expect(out.title).toBe(summary.title);
    expect(out.extract).toBe(summary.extract);
    expect(out.thumbnail).toBe(summary.thumbnail.source);
    expect(calls).toHaveLength(1);
  });

  it('checks search hits against the airport name', async () => {
    const summary = jsonFixture('wikipedia-summary-ord.json');
    routeFetch([
      ['w/api.php', 200, jsonFixture('wikipedia-search-ord.json')],
      ['rest_v1/page/summary', 200, summary],
    ]);
    const out = await json(await lore(pagesContext("https://x/api/lore?iata=ORD&name=Chicago%20O'Hare%20International%20Airport")));
    expect(out.title).toBe(summary.title);
  });

  it('returns 404 rather than an unrelated article when nothing checks out', async () => {
    routeFetch(herRoutes());
    const res = await lore(pagesContext('https://x/api/lore?iata=HER'));
    expect(res.status).toBe(404);
    expect((await json(res)).extract).toBeUndefined();
  });

  it('reports a Wikipedia rate limit as a retryable 503', async () => {
    routeFetch([['w/api.php', 429, 'You are making too many requests to the API.']]);
    const res = await lore(pagesContext(`https://x/api/lore?iata=HER${HER}`));
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('60');
  });

  it('keys the KV cache on every input, so a request only fills the entry it would read', async () => {
    routeFetch(herRoutes());
    const store = new Map<string, string>();
    const kv = {
      get: async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : null),
      put: async (k: string, v: string) => void store.set(k, v),
    };
    const ctx = (q: string) => ({ request: new Request(`https://x/api/lore?${q}`), env: { LORE_KV: kv } }) as any;
    await lore(ctx(`iata=HER${HER}`));
    expect([...store.keys()]).toEqual(['lore:v2:q:HER:Heraklion International Nikos Kazantzakis Airport:35.34,25.18']);
    const again = await json(await lore(ctx(`iata=HER${HER}`)));
    expect(again.title).toBe(jsonFixture('wikipedia-summary-her.json').title);
    expect((await lore(ctx('iata=HER'))).status).toBe(404); // different inputs, no cache hit
  });
});

describe('shared/wikiLore article checks', () => {
  const her = { iata: 'HER', name: 'Heraklion International Nikos Kazantzakis Airport', lat: 35.3397, lon: 25.1803 };

  it('rejects a disambiguation page', () => {
    expect(summaryMatchesAirport(jsonFixture('wikipedia-summary-her-disambiguation.json'), her)).toBe(false);
  });

  it('rejects an airport article far from the airport', () => {
    const lhr = jsonFixture('wikipedia-summary-lhr.json');
    expect(summaryMatchesAirport(lhr, her)).toBe(false);
    expect(summaryMatchesAirport(lhr, { iata: 'LHR', name: 'London Heathrow Airport', lat: 51.4706, lon: -0.4619 })).toBe(true);
  });

  it('rejects list pages and, without coordinates, hits that share nothing with the name', () => {
    const base = { type: 'standard', extract: 'An airport serving the town.', description: 'Airport in Wisconsin' };
    const q = { iata: 'BCK', name: 'Bolwarra Airport' };
    expect(summaryMatchesAirport({ ...base, title: 'List of airports in Kiribati' }, q)).toBe(false);
    expect(summaryMatchesAirport({ ...base, title: 'Black River Falls Area Airport' }, q)).toBe(false);
    expect(summaryMatchesAirport({ ...base, title: 'Bolwarra Airport' }, q)).toBe(true);
    expect(summaryMatchesAirport({ ...base, title: 'Some Field', extract: 'An airport (IATA: BCK) in Queensland.' }, q)).toBe(true);
  });

  it('reads only English Wikipedia links, the same way on server and client', () => {
    const links = [
      'https://en.wikipedia.org/wiki/Heraklion_International_Airport_%22Nikos_Kazantzakis%22',
      'https://en.m.wikipedia.org/wiki/Manchester_Airport',
      'https://de.wikipedia.org/wiki/Flughafen_Bolzano',
      'https://www.wikidata.org/wiki/Q123',
      undefined,
    ];
    expect(links.map((l) => titleFromWikipediaLink(l))).toEqual([
      'Heraklion International Airport "Nikos Kazantzakis"',
      'Manchester Airport',
      null,
      null,
      null,
    ]);
    expect(links.map((l) => englishWikiTitle(l))).toEqual(links.map((l) => titleFromWikipediaLink(l)));
  });
});
