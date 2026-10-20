// BTS T-100 Segment -> route and airport traffic, against real July 2026 rows (TranStats, all
// carriers): ORD-LGA, JFK-LHR and ORD-NRT both ways, plus three charter and freight rows.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixturePath, readFixture } from './helpers';
import {
  parseT100,
  aggregatePairs,
  airportFiles,
  internationalNonstops,
  windows,
  pairSummary,
  aircraftLabel,
  MIN_ROUTE_PAX,
} from '../shared/t100.js';
import { readZipEntry } from '../scripts/build_t100.js';

const csv = readFixture('bts-t100-segment-2026-07-sample.csv');
const names = { '614': 'Boeing 737-800', '694': 'Airbus Industrie A320-100/200', '889': 'B787-900 Dreamliner' };
const us = new Set(['ORD', 'LGA', 'JFK']);

describe('reading T-100', () => {
  it('keeps scheduled passenger service, dropping charters, freight and empty rows', () => {
    const rows = parseT100(csv);
    expect(rows.every((r) => r.origin !== r.dest)).toBe(true);
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.length).toBeLessThan(csv.trim().split('\n').length - 1);
    expect(rows[0]).toEqual(expect.objectContaining({ year: 2026, month: 7 }));
  });

  it('reads the CSV out of a BTS-style zip', () => {
    const text = readZipEntry(fs.readFileSync(fixturePath('bts-t100-segment-sample.zip')), 'T_T100_SEGMENT_ALL_CARRIER.csv').toString('utf8');
    expect(text.replace(/\r/g, '')).toBe(csv.replace(/\r/g, ''));
    expect(() => readZipEntry(Buffer.from('not a zip'), 'x')).toThrow();
  });

  it('works out the last 12 months and the 12 before', () => {
    const w = windows('2026-07');
    expect([w.last[0], w.last[11], w.prev[0], w.prev[11]]).toEqual(['2025-08', '2026-07', '2024-08', '2025-07']);
    expect(windows('2026-01').last[0]).toBe('2025-02');
  });
});

describe('route and airport summaries', () => {
  const rows = parseT100(csv);
  const pairs = aggregatePairs(rows, '2026-07');

  it('combines both directions of a route', () => {
    const p = pairs.get('LGA|ORD')!;
    const both = rows.filter((r) => (r.origin === 'ORD' && r.dest === 'LGA') || (r.origin === 'LGA' && r.dest === 'ORD'));
    expect(p.pax).toBe(both.reduce((s, r) => s + r.pax, 0));
    expect(p.monthly[11]).toBe(p.pax); // all of it is July, the last month
    const s = pairSummary(p, names);
    expect(s.airlines.length).toBeLessThanOrEqual(5);
    expect(s.airlines[0][0]).toBe('UA');
    expect(s.airlines.reduce((t: number, [, share]: [string, number]) => t + share, 0)).toBeLessThanOrEqual(100);
    expect(s.aircraft[0]).not.toMatch(/^type /);
  });

  it('names aircraft from the BTS lookup', () => {
    expect(aircraftLabel('694', names)).toBe('Airbus A320-100/200');
    expect(aircraftLabel('999', names)).toBe('type 999');
  });

  it('writes per-airport files with totals and busiest routes', () => {
    const files = airportFiles(pairs, '2026-07', names);
    const ord = files.get('ORD')!;
    expect(ord.months).toEqual({ from: '2025-08', to: '2026-07' });
    expect(Object.keys(ord.routes).sort()).toEqual(['LGA', 'NRT']);
    expect(ord.top[0]).toBe('LGA');
    expect(ord.total.pax).toBe(ord.routes.LGA.pax + ord.routes.NRT.pax);
    expect(files.get('LGA')!.routes.ORD).toEqual(ord.routes.LGA);
    expect(Object.values(ord.routes).every((r: any) => r.pax >= MIN_ROUTE_PAX)).toBe(true);
  });

  it('lists current US-international nonstops with their airlines, both ways', () => {
    const intl = internationalNonstops(pairs, (c: string) => us.has(c));
    expect(intl.JFK.LHR).toEqual(['AA', 'B6', 'BA', 'DL', 'VS']);
    expect(intl.LHR.JFK).toEqual(intl.JFK.LHR);
    expect(intl.ORD.NRT).toEqual(['JL', 'NH']);
    expect(intl.ORD?.LGA).toBeUndefined(); // domestic pairs come from the on-time data
  });
});
