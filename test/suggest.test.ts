import { describe, expect, it } from 'vitest';
import { loadAirportSubset } from './helpers';
import { loadAirports, suggest } from '../src/ts/searchParser';

loadAirports(loadAirportSubset());
const queries = (q: string) => suggest(q).map((s) => s.query);

describe('suggest', () => {
  it('needs at least two characters', () => {
    expect(suggest('c')).toEqual([]);
    expect(suggest('  ')).toEqual([]);
  });

  it('suggests airports for a partial city, best match first', () => {
    const q = queries('chi');
    expect(q[0]).toBe('ORD');
    expect(q).toContain('MDW');
  });

  it('puts an exact code first, then other codes with that prefix', () => {
    expect(queries('den')[0]).toBe('DEN');
    expect(queries('lg')).toEqual(expect.arrayContaining(['LGA', 'LGW']));
  });

  it('suggests the second airport of a route once the first is settled', () => {
    const s = suggest('chicago den');
    expect(s[0]).toMatchObject({ query: 'ORD DEN', kind: 'route' });
  });

  it('handles an explicit separator with a partial right side', () => {
    const s = suggest('ord to d');
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((x) => x.kind === 'route' && x.query.startsWith('ORD '))).toBe(true);
    expect(s.map((x) => x.query)).toContain('ORD DEN');
  });

  it('keeps a multi-word single place ahead of route guesses', () => {
    const s = suggest('new york');
    expect(s[0]).toMatchObject({ query: 'JFK', kind: 'airport' });
  });

  it('never repeats a suggestion', () => {
    const q = queries('chicago d');
    expect(new Set(q).size).toBe(q.length);
  });
});
