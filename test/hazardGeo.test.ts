import { describe, expect, it } from 'vitest';
import { jsonFixture } from './helpers';
import { pointInPolygon, distanceToPolygonMi, advisoriesNear, type Ring } from '../src/ts/hazardGeo';
import { fromIntlFeed } from '../functions/api/airsigmet';
import { haversineDistanceLatLon } from '../src/ts/geoMath';

// A 2 x 2 degree box around (41, -88).
const box: Ring = [
  [40, -89],
  [42, -89],
  [42, -87],
  [40, -87],
];

describe('advisory polygon geometry', () => {
  it('tests points against a ring', () => {
    expect(pointInPolygon(41, -88, box)).toBe(true);
    expect(pointInPolygon(43, -88, box)).toBe(false);
  });

  it('matches a point against a ring unwrapped across the antimeridian', () => {
    // 175E to 178W, stored as 175 to 182
    const pacific: Ring = [
      [10, 175],
      [10, 182],
      [5, 182],
      [5, 175],
    ];
    expect(pointInPolygon(7, -179, pacific)).toBe(true);
    expect(pointInPolygon(7, 177, pacific)).toBe(true);
    expect(pointInPolygon(7, -170, pacific)).toBe(false);
  });

  it('measures zero inside and the gap to the nearest edge outside', () => {
    expect(distanceToPolygonMi(41, -88, box)).toBe(0);
    // One degree of latitude north of the box's top edge is about 69 statute miles.
    expect(distanceToPolygonMi(43, -88, box)).toBeCloseTo(haversineDistanceLatLon(43, -88, 42, -88), 0);
  });

  it('keeps only the requested hazard within the radius, closest first', () => {
    const far: Ring = box.map(([lat, lon]) => [lat + 5, lon] as [number, number]);
    const list = [
      { hazard: 'ASH', coords: far, id: 'far' },
      { hazard: 'TURB', coords: box, id: 'turb' },
      { hazard: 'ASH', coords: box, id: 'near' },
    ];
    const hits = advisoriesNear(43, -88, list, 'ASH', 500);
    expect(hits.map((h) => h.advisory.id)).toEqual(['near', 'far']);
    expect(advisoriesNear(43, -88, list, 'ASH', 100).map((h) => h.advisory.id)).toEqual(['near']);
  });

  it('finds the real Mt Ibu ash SIGMET from Ternate airport but not from Manado', () => {
    const advisories = fromIntlFeed(jsonFixture<any[]>('awc-isigmet.json'), 1792172000);
    // Ternate (TTE) sits about 40 mi south of Mt Ibu; Manado (MDC) about 115 mi southwest.
    const fromTernate = advisoriesNear(0.83, 127.38, advisories, 'ASH', 100);
    expect(fromTernate).toHaveLength(1);
    expect(fromTernate[0].advisory.name).toBe('Mt Ibu');
    expect(fromTernate[0].miles).toBeGreaterThan(20);
    expect(fromTernate[0].miles).toBeLessThan(60);
    expect(advisoriesNear(1.55, 124.93, advisories, 'ASH', 100)).toHaveLength(0);
  });
});
