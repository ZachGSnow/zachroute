// Route and airport traffic on the cards, against ORD's real traffic file from the T-100 build
// (August 2025 to July 2026; trimmed to its LGA, NRT, LHR and DEN routes) and a matching index.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonFixture, stubBrowser } from './helpers';
import {
  fetchAirportTraffic,
  trafficAirlineName,
  shortCarrierName,
  compactCount,
  yearChange,
  monthLabel,
  busiestMonth,
  loadFactor,
} from '../src/ts/traffic';

const ord = jsonFixture<any>('t100-airport-ord.json');
const index = jsonFixture<any>('t100-index-sample.json');

afterEach(() => vi.unstubAllGlobals());

function stubFiles() {
  stubBrowser();
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/data/t100/index.json')) return new Response(JSON.stringify(index));
      if (url.endsWith('/data/t100/ORD.json')) return new Response(JSON.stringify(ord));
      return new Response('not found', { status: 404 });
    })
  );
  return calls;
}

describe('loading traffic', () => {
  it('loads an airport file only when the index lists the airport', async () => {
    const calls = stubFiles();
    const t = (await fetchAirportTraffic('ORD'))!;
    expect(t.top[0]).toBe('LGA');
    expect(t.routes.LGA.airlines[0][0]).toBe('UA');
    expect(await fetchAirportTraffic('ZZZ')).toBeNull();
    expect(calls.filter((u) => u.includes('ZZZ'))).toEqual([]);
  });

  it('names airlines: the app short name first, then the US DOT name without company suffixes', async () => {
    stubFiles();
    expect(await trafficAirlineName('UA')).toBe('United');
    expect(await trafficAirlineName('JL')).toBe('Japan Air Lines');
    expect(await trafficAirlineName('BA')).toBe('British Airways');
    expect(shortCarrierName('Global Crossing Airlines, Inc.')).toBe('Global Crossing Airlines');
  });
});

describe('traffic wording', () => {
  it('writes counts compactly', () => {
    expect(compactCount(84744100)).toBe('85M');
    expect(compactCount(2736974)).toBe('2.7M');
    expect(compactCount(126135)).toBe('126K');
    expect(compactCount(950)).toBe('950');
  });

  it('describes the change on the year before', () => {
    expect(yearChange(106, 100)).toBe('up 6% on the year before');
    expect(yearChange(97, 100)).toBe('down 3% on the year before');
    expect(yearChange(100, 100)).toBe('about the same as the year before');
    expect(yearChange(100, 0)).toBe('');
  });

  it('labels months and finds the busiest one', () => {
    expect(monthLabel('2025-08')).toBe('Aug 2025');
    // ORD-LGA's monthly passengers peak in the third month of Aug 2025 to Jul 2026: October
    expect(busiestMonth(ord.routes.LGA.monthly, ord.months.to)).toBe('Oct');
    expect(busiestMonth([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5], '2026-01')).toBe('Jan');
  });

  it('works out how full the flights were', () => {
    expect(loadFactor(ord.routes.LGA.pax, ord.routes.LGA.seats)).toBe(84);
    expect(loadFactor(5, 0)).toBeNull();
  });
});
