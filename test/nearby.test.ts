import { describe, expect, it } from 'vitest';
import { loadAirportSubset } from './helpers';
import { nearestAirports, NEARBY_COUNT } from '../src/ts/nearby';

const airports = loadAirportSubset();

describe('airports near me', () => {
  it('orders by distance and counts alias entries once', () => {
    // A point in the Chicago suburbs between O'Hare and Midway.
    const list = nearestAirports(41.86, -87.8, Object.values(airports));
    expect(list.map((n) => n.airport.iata).slice(0, 2).sort()).toEqual(['MDW', 'ORD']);
    expect(list).toHaveLength(NEARBY_COUNT);
    for (let i = 1; i < list.length; i++) expect(list[i].miles).toBeGreaterThanOrEqual(list[i - 1].miles);
    expect(new Set(list.map((n) => n.airport)).size).toBe(list.length);
  });

  it('reports a sensible distance and direction', () => {
    // Aurora, east of Denver (from downtown, Rocky Mountain Metropolitan BJC is closer than DEN).
    const [first] = nearestAirports(39.75, -104.8, Object.values(airports), 1);
    expect(first.airport.iata).toBe('DEN');
    expect(first.miles).toBeGreaterThan(6);
    expect(first.miles).toBeLessThan(14);
    expect(first.bearingDeg).toBeGreaterThan(20); // DEN is northeast of Aurora
    expect(first.bearingDeg).toBeLessThan(70);
  });
});
