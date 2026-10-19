import { describe, expect, it, vi } from 'vitest';
import { jsonFixture, readFixture } from './helpers';
// @ts-expect-error plain JS module
import { buildRecords } from '../scripts/etl_ourairports.js';
// @ts-expect-error plain JS module
import { addWikiTitles, fetchWikidataTitles, parseTitles, sparqlFor } from '../scripts/wikidata_titles.js';
import { airportWikiLink } from '../src/ts/wikiPhoto';

describe('Wikidata titles for airports (ETL)', () => {
  it('asks for only well-formed codes, by ICAO or IATA property', () => {
    const q = sparqlFor('icao', ['KORD', 'LGIR', 'bad"} DROP', 'X']);
    expect(q).toContain('VALUES ?code { "KORD" "LGIR" }');
    expect(q).toContain('wdt:P239');
    expect(sparqlFor('iata', ['HER'])).toContain('wdt:P238');
  });

  it('reads code -> title from a real response', () => {
    const titles = parseTitles(jsonFixture('wikidata-titles-icao.json'));
    expect([...titles.get('LGIR')]).toEqual(['Heraklion International Airport "Nikos Kazantzakis"']);
    expect([...titles.get('KORD')]).toEqual(["O'Hare International Airport"]);
  });

  it('adds titles to airport records, ICAO first, skipping aliases and ambiguous codes', () => {
    const { records } = buildRecords(
      {
        airportsText: readFixture('ourairports-airports.csv'),
        runwaysText: readFixture('ourairports-runways.csv'),
        freqText: readFixture('ourairports-frequencies.csv'),
        countriesText: readFixture('ourairports-countries.csv'),
        regionsText: readFixture('ourairports-regions.csv'),
        navaidsText: readFixture('ourairports-navaids.csv'),
      },
      {},
      new Date('2026-10-16T00:00:00Z')
    );
    const byIcao = parseTitles(jsonFixture('wikidata-titles-icao.json'));
    byIcao.delete('KMDW');
    const byIata = parseTitles(jsonFixture('wikidata-titles-iata.json'));
    byIata.get('DEN').add('Some other Denver article'); // two titles: ambiguous, so not used

    const n = addWikiTitles(records, byIcao, byIata);
    expect(records.ORD.wikiTitle).toBe("O'Hare International Airport");
    expect(records.MDW.wikiTitle).toBe('Midway International Airport'); // from IATA when ICAO has none
    expect(records.KORD).toBe('ORD'); // aliases untouched
    expect(records.DEN.wikiTitle).toBe('Denver International Airport'); // ICAO wins before IATA is asked
    expect(n).toBe(4);
  });

  it('looks codes up in batches and fails loudly so the ETL can carry on without', async () => {
    const bodies: string[] = [];
    const fetchFn = vi.fn(async (_url: string, init: any) => {
      bodies.push(decodeURIComponent(String(init.body)));
      return new Response(JSON.stringify(jsonFixture('wikidata-titles-icao.json')));
    });
    const codes = Array.from({ length: 450 }, (_, i) => `K${String(i).padStart(3, '0')}`);
    const out = await fetchWikidataTitles(codes, [], { userAgent: 'test', fetch: fetchFn, delayMs: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(2); // 300 + 150
    expect(bodies[0]).toContain('K000');
    expect(bodies[1]).toContain('K449');
    expect(out.icao.get('LGIR')).toBeDefined();

    const failing = vi.fn(async () => new Response('timeout', { status: 500 }));
    await expect(fetchWikidataTitles(['KORD'], [], { userAgent: 'test', fetch: failing, delayMs: 0 })).rejects.toThrow('500');
  });
});

describe('Wikipedia link on the airport card', () => {
  it('uses the Wikidata title when there is one, else the OurAirports link', () => {
    expect(
      airportWikiLink({
        wikiTitle: 'Heraklion International Airport "Nikos Kazantzakis"',
        wikipediaLink: 'https://en.wikipedia.org/wiki/Heraklion_International_Airport_Nikos_Kazantzakis',
      })
    ).toBe('https://en.wikipedia.org/wiki/Heraklion_International_Airport_%22Nikos_Kazantzakis%22');
    expect(airportWikiLink({ wikipediaLink: 'https://en.wikipedia.org/wiki/Manchester_Airport' })).toBe(
      'https://en.wikipedia.org/wiki/Manchester_Airport'
    );
    expect(airportWikiLink({})).toBeUndefined();
  });
});
