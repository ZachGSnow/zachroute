import { describe, expect, it } from 'vitest';
import {
  SATELLITES,
  cloudPixel,
  lonDistance,
  satelliteCovers,
  satelliteTileUrl,
  satellitesFor,
  satellitesForRange,
  viewCos,
  viewWeight,
} from '../src/ts/satelliteTiles';

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
