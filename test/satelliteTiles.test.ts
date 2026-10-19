import { describe, expect, it } from 'vitest';
import {
  SATELLITES,
  cloudPixel,
  coldCoreMask,
  isPinkBand,
  isRedBand,
  lonDistance,
  satelliteCovers,
  satelliteTileUrl,
  satellitesFor,
  satellitesForRange,
  viewCos,
  viewWeight,
} from '../src/ts/satelliteTiles';
import { satelliteLegend } from '../src/ts/legends';

const byName = (name: string) => SATELLITES.find((s) => s.name === name)!;

describe('satellite coverage', () => {
  it('measures longitude distance across the date line', () => {
    expect(lonDistance(170, -170)).toBe(20);
    expect(lonDistance(-75, -75)).toBe(0);
  });

  it('prefers the satellite nearest overhead', () => {
    expect(satellitesFor(-80)[0].name).toBe('GOES-East');
    expect(satellitesFor(-125)[0].name).toBe('GOES-West');
    expect(satellitesFor(150)[0].name).toBe('Himawari');
    expect(satellitesFor(-170).map((s) => s.name)).toEqual(['GOES-West', 'Himawari']);
    expect(satellitesFor(30)).toEqual([]);
  });

  it('loads every satellite a tile could need, including across the date line', () => {
    expect(satellitesForRange(170, -170).map((s) => s.name).sort()).toEqual(['GOES-West', 'Himawari']);
    expect(satellitesForRange(-180, 180)).toHaveLength(3);
  });

  it('fades out toward the edge of the view, using latitude as well as longitude', () => {
    const east = byName('GOES-East');
    expect(viewWeight(viewCos(25.8, -80.3, east))).toBe(1); // Miami
    expect(viewWeight(viewCos(51.5, -0.1, east))).toBe(0); // London: far too slanted
    const edge = viewWeight(viewCos(0, east.lon + 66, east));
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(1);
  });

  it('knows where this source has no satellite', () => {
    expect(satelliteCovers(25.8, -80.3)).toBe(true);
    expect(satelliteCovers(35.7, 139.7)).toBe(true); // Tokyo
    expect(satelliteCovers(48.9, 2.4)).toBe(false); // Paris
    expect(satelliteCovers(25.3, 55.4)).toBe(false); // Dubai
  });

  it('asks GIBS for the newest image', () => {
    expect(satelliteTileUrl(byName('Himawari'))).toBe(
      'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Himawari_AHI_Band13_Clean_Infrared/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png'
    );
  });
});

describe('cloud pixels', () => {
  it('clears warm gray (ground, sea), whitens cold gray and keeps the color enhancement', () => {
    expect(cloudPixel(120, 120, 120, 255)[3]).toBe(0);
    const cloud = cloudPixel(220, 220, 220, 255);
    expect(cloud.slice(0, 3)).toEqual([255, 255, 255]);
    expect(cloud[3]).toBeGreaterThan(0);
    expect(cloudPixel(240, 240, 240, 255)[3]).toBeGreaterThan(cloud[3]);
    expect(cloudPixel(0, 200, 40, 255)).toEqual([0, 200, 40, 220]);
    expect(cloudPixel(200, 200, 200, 0)[3]).toBe(0);
  });
});

describe('cold storm cores', () => {
  const SIZE = 32;
  /** A tile painted by a function of (x, y) -> [r, g, b]. */
  const paint = (fn: (x: number, y: number) => [number, number, number]) => {
    const d = new Uint8ClampedArray(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const [r, g, b] = fn(x, y);
        d.set([r, g, b, 255], (y * SIZE + x) * 4);
      }
    return d;
  };
  const dist = (x: number, y: number) => Math.hypot(x - 16, y - 16);

  // A storm as NASA draws it: gray ground, a yellow ring (-52 C), a red ring (-62 C), then the
  // coldest core in gray, from near-black at the red edge to lighter in the middle.
  const storm = paint((x, y) => {
    const r = dist(x, y);
    if (r > 12) return [130, 130, 130];
    if (r > 9) return [255, 230, 0];
    if (r > 7) return [230, 0, 0];
    const v = Math.round(20 + (7 - r) * 25);
    return [v, v, v];
  });

  it('finds the gray core inside the red ring and leaves the ground alone', () => {
    const mask = coldCoreMask(storm, SIZE);
    expect(mask[16 * SIZE + 16]).toBe(1); // center
    expect(mask[0]).toBe(0); // ground in the corner
    expect(mask[16 * SIZE + 2]).toBe(0);
  });

  it('does not spread from red straight onto mid-gray ground (downscaled low-zoom tiles)', () => {
    const touching = paint((x) => (x < 16 ? [230, 0, 0] : [130, 130, 130]));
    expect(coldCoreMask(touching, SIZE).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('tells red and pink storm bands from other colors', () => {
    expect(isRedBand(230, 0, 0)).toBe(true);
    expect(isRedBand(51, 0, 0)).toBe(true);
    expect(isRedBand(255, 230, 0)).toBe(false);
    expect(isPinkBand(242, 114, 195)).toBe(true);
    expect(isPinkBand(26, 255, 0)).toBe(false);
  });

  it('labels the satellite legend in the chosen units', () => {
    const c = satelliteLegend('metric');
    expect(c.title).toBe('Satellite clouds: storm strength');
    expect(c.kind === 'gradient' && c.labels).toEqual(['cloud', 'tall', 'strong', 'very strong', 'extreme']);
    expect(c.note).toContain('-40\u00b0C to -75\u00b0C and colder');
    expect(satelliteLegend('us').note).toContain('-40\u00b0F to -103\u00b0F and colder');
  });
});
