// Build-time data scripts run against real samples of each source file format.
import { describe, expect, it } from 'vitest';
import { fixturePath, readFixture } from './helpers';

// @ts-expect-error plain JS module
import { buildRecords, parseCSVLine } from '../scripts/etl_ourairports.js';
// @ts-expect-error plain JS module
import { countMonth, MIN_FLIGHTS_PER_MONTH } from '../scripts/build_us_routes.js';
// @ts-expect-error plain JS module
import { mergeRoutes } from '../scripts/build_connections.js';

describe('OurAirports CSVs -> buildRecords', () => {
  const texts = {
    airportsText: readFixture('ourairports-airports.csv'),
    runwaysText: readFixture('ourairports-runways.csv'),
    freqText: readFixture('ourairports-frequencies.csv'),
    countriesText: readFixture('ourairports-countries.csv'),
    regionsText: readFixture('ourairports-regions.csv'),
    navaidsText: readFixture('ourairports-navaids.csv'),
  };
  const { records } = buildRecords(texts, {}, new Date('2026-10-16T00:00:00Z'));

  it('keys each airport once by IATA, with ICAO as an alias', () => {
    expect(records.ORD.icao).toBe('KORD');
    expect(records.KORD).toBe('ORD');
    expect(records.LHR.country).toBe('GB');
  });

  it('resolves region and country names and codes', () => {
    expect(records.ORD.state).toBe('Illinois');
    expect(records.ORD.regionCode).toBe('IL');
    expect(records.ORD.countryName).toBe('United States');
  });

  it('drops the "(unassigned)" placeholder region OurAirports uses', () => {
    // Guam's airports sit in region GU-U-A, named "(unassigned)"
    expect(records.GUM.state).toBeUndefined();
    expect(records.GUM.regionCode).toBeUndefined();
    expect(records.GUM.countryName).toBe('Guam');
  });

  it('keeps runway end coordinates and true headings', () => {
    const rwys = records.DEN.runways;
    expect(rwys.length).toBeGreaterThan(3);
    for (const r of rwys) {
      // Both ends sit within a few miles of the airport reference point.
      for (const [lat, lon] of [[r.leLat, r.leLon], [r.heLat, r.heLon]]) {
        expect(Math.abs(lat - records.DEN.lat)).toBeLessThan(0.1);
        expect(Math.abs(lon - records.DEN.lon)).toBeLessThan(0.1);
      }
      expect(r.ident).toMatch(/^\d{1,2}[LCR]?\/\d{1,2}[LCR]?$/);
    }
    expect(rwys[0].lengthFt).toBeGreaterThanOrEqual(rwys[rwys.length - 1].lengthFt); // longest first
  });

  it('adds frequencies, a time zone and magnetic variation', () => {
    expect(records.ORD.frequencies.length).toBeGreaterThan(0);
    expect(records.ORD.timeZone).toBe('America/Chicago');
    expect(records.ORD.magVarDeg).toBeLessThan(0); // west variation around Chicago
    expect(records.ORD.magVarDeg).toBeGreaterThan(-10);
  });

  it('parses quoted CSV fields with commas', () => {
    expect(parseCSVLine('1,"a, b",c')).toEqual(['1', 'a, b', 'c']);
  });
});

describe('BTS on-time CSV -> countMonth', () => {
  it('counts flights per route and reporting airline', async () => {
    const counts: Map<string, number> = await countMonth(fixturePath('bts-ontime-sample.csv'));
    const ordDen = [...counts.entries()].filter(([k]) => k.startsWith('ORD-DEN|'));
    expect(ordDen.length).toBeGreaterThan(0);
    const total = ordDen.reduce((n, [, v]) => n + v, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(12); // the fixture holds 12 ORD-DEN rows (cancelled ones are skipped)
    for (const [key] of counts) expect(key).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}\|[A-Z0-9]{2}$/);
    expect(MIN_FLIGHTS_PER_MONTH).toBe(8);
  });
});

describe('OpenFlights routes.dat + BTS + overrides -> mergeRoutes', () => {
  const routeLines = readFixture('openflights-routes.dat').trim().split('\n');

  it('keeps OpenFlights for international pairs and replaces US pairs', () => {
    const usAirports = new Set(['ORD', 'DEN', 'ATL', 'BOS', 'LAX', 'SFO', 'MSP', 'DFW', 'IAH', 'EWR', 'JFK', 'LGA', 'PHX', 'SEA', 'MIA', 'CLT', 'DTW', 'PHL', 'LAS', 'SLC', 'MCO', 'BWI', 'IAD', 'DCA', 'SAN', 'TPA', 'PDX', 'STL', 'MDW', 'BNA', 'AUS', 'MSY', 'SJC', 'OAK', 'SMF', 'SAT', 'RDU', 'CLE', 'IND', 'CMH', 'CVG', 'MCI', 'MKE', 'PIT', 'OMA', 'ABQ', 'TUS', 'BOI', 'ELP']);
    const usRoutes = { generated: '2026-10-16', months: ['2026_7'], routes: { ORD: { DEN: ['UA', 'WN'] } } };
    const overrides = { add: [{ from: 'ORD', to: 'GRB', carriers: ['MX'] }], remove: [] };
    const { connections, carriers, skippedUs } = mergeRoutes({ routeLines, usRoutes, overrides, usAirports });

    expect(connections.LHR.length).toBeGreaterThan(0); // international rows survive
    expect(skippedUs).toBeGreaterThan(0); // some fixture rows are US-to-US
    expect(connections.ORD).toContain('DEN'); // from BTS
    expect(connections.DEN).toContain('ORD'); // symmetrized
    expect(connections.GRB).toContain('ORD'); // override, both ways
    expect(carriers.routes.ORD.DEN).toBe('UA,WN');
    expect(carriers.routes.DEN.ORD).toBe('UA,WN');
    expect(carriers.routes.ORD.GRB).toBe('MX');
  });
});
