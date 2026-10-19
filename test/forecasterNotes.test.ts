import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonFixture, loadAirportSubset, pagesContext, stubBrowser, stubFetch } from './helpers';
import { aviationSection, onRequest as afd } from '../functions/api/afd';
import { fetchForecasterNotes, forecasterNotesLabel } from '../src/ts/forecasterNotes';

const json = async (res: Response) => JSON.parse(await res.text());
const airports = loadAirportSubset();

// Real api.weather.gov responses for ORD: the point lookup, the Chicago office, its discussion
// list and the latest discussion, captured 2026-10-19.
const nwsRoutes = (): Array<[string, unknown]> => [
  ['/points/', jsonFixture('nws-points-ord.json')],
  ['/offices/LOT', jsonFixture('nws-office-lot.json')],
  ['/products/types/AFD/locations/LOT', jsonFixture('nws-afd-list-lot.json')],
  ['/products/', jsonFixture('nws-afd-lot.json')],
];

beforeEach(() => {
  stubBrowser();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NWS forecast discussion -> /api/afd', () => {
  it('cuts a real discussion down to its aviation paragraphs', () => {
    const out = aviationSection(jsonFixture<any>('nws-afd-lot.json').productText)!;
    expect(out.heading).toBe('18Z TAFS THROUGH 00Z WEDNESDAY');
    expect(out.paragraphs).toHaveLength(1);
    expect(out.paragraphs[0]).toMatch(/^Light and variable winds/);
    expect(out.paragraphs[0]).toMatch(/Shallow ground fog may develop in the vicinity of ORD\/MDW/);
    expect(out.paragraphs.join(' ')).not.toMatch(/Issued at|Borchardt|WATCHES/);
  });

  it('stops at the next section and keeps several paragraphs', () => {
    const text = [
      '.AVIATION...',
      'VFR through the evening.',
      '',
      'MVFR ceilings late tonight with',
      'light rain.',
      '',
      '.MARINE...',
      'Small craft advisory.',
    ].join('\n');
    expect(aviationSection(text)).toEqual({ heading: '', paragraphs: ['VFR through the evening.', 'MVFR ceilings late tonight with light rain.'] });
    expect(aviationSection('.SYNOPSIS...\nQuiet.')).toBeNull();
    // Miami's layout: the TAF time and issue time on lines of their own, no blank line before the text.
    const miami = '.AVIATION...\n(18Z TAFS)\nIssued at 107 PM EDT Mon Oct 19 2026\nGenerally VFR through the period.\n\n&&';
    expect(aviationSection(miami)!.paragraphs).toEqual(['Generally VFR through the period.']);
  });

  it('finds the office for the airport and returns its aviation notes', async () => {
    stubFetch(nwsRoutes());
    const out = await json(await afd(pagesContext('https://x/api/afd?lat=41.98&lon=-87.90')));
    expect(out.available).toBe(true);
    expect(out.office).toBe('LOT');
    expect(out.officeName).toBe('Chicago, IL');
    expect(out.issued).toBe(jsonFixture<any>('nws-afd-lot.json').issuanceTime);
    expect(out.paragraphs[0]).toMatch(/^Light and variable winds/);
  });

  it('says not available outside the US, and rejects a bad position', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"status":404}', { status: 404 })));
    expect((await json(await afd(pagesContext('https://x/api/afd?lat=51.47&lon=-0.46')))).available).toBe(false);
    expect((await afd(pagesContext('https://x/api/afd?lat=abc'))).status).toBe(400);
  });
});

describe('Forecaster notes on the airport card', () => {
  it('only asks for US airports', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect(await fetchForecasterNotes(airports.LHR)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('labels the notes with the office and the issue time in the airport time zone', () => {
    const label = forecasterNotesLabel(
      { office: 'LOT', officeName: 'Chicago, IL', issued: '2026-10-19T17:23:00+00:00', paragraphs: ['x'] },
      'America/Chicago'
    );
    expect(label).toBe('Forecaster notes (NWS Chicago, IL, issued 12:23 PM)');
  });
});
