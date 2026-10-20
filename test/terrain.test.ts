import { describe, expect, it } from 'vitest';
import { decodeRgbaPng } from './helpers';
import { terrariumMeters, pixelMeters, exaggeration, hillshade, reliefPixel, reliefTile, HIGH_GROUND_M } from '../src/ts/terrainTiles';

// A real Terrarium tile over the Colorado Front Range (zoom 9, x 106, y 195), with Pikes Peak
// (4,302 m) in it, from the AWS Open Data terrain tiles.
const tile = () => decodeRgbaPng('terrarium-9-106-195.png').data;

describe('Terrarium elevation', () => {
  it('unpacks meters from RGB', () => {
    expect(terrariumMeters(128, 0, 0)).toBe(0);
    expect(terrariumMeters(128, 100, 128)).toBe(100.5);
    expect(terrariumMeters(127, 255, 0)).toBe(-1);
  });

  it('reads Pikes Peak from the real tile', () => {
    const d = tile();
    let max = -Infinity;
    let min = Infinity;
    for (let i = 0; i < d.length; i += 4) {
      const m = terrariumMeters(d[i], d[i + 1], d[i + 2]);
      max = Math.max(max, m);
      min = Math.min(min, m);
    }
    expect(Math.abs(max - 4302)).toBeLessThan(15);
    expect(min).toBeGreaterThan(1500); // the plains east of Colorado Springs
  });

  it('sizes pixels by latitude and zoom, and exaggerates when zoomed out', () => {
    expect(pixelMeters(0, 0)).toBeCloseTo(156543, 0);
    expect(pixelMeters(60, 10)).toBeCloseTo(pixelMeters(0, 10) / 2, 3);
    expect(exaggeration(12)).toBe(1);
    expect(exaggeration(4)).toBe(8);
    expect(exaggeration(8)).toBe(2);
  });
});

describe('relief', () => {
  // Rows run north to south. A plane rising toward the southeast faces the northwest light.
  const facesNw = [0, 10, 20, 10, 20, 30, 20, 30, 40];
  const facesSe = facesNw.map((v) => 40 - v);
  const flat = [5, 5, 5, 5, 5, 5, 5, 5, 5];

  it('lights slopes facing the northwest and shades the far side', () => {
    expect(hillshade(flat, 10)).toBeCloseTo(Math.SQRT1_2, 5);
    expect(hillshade(facesNw, 10)).toBeGreaterThan(hillshade(flat, 10));
    expect(hillshade(facesSe, 10)).toBeLessThan(hillshade(flat, 10));
    expect(hillshade(facesSe, 100, 4)).toBeLessThan(hillshade(facesSe, 100));
  });

  it('leaves flat ground and the sea clear, and tints high ground', () => {
    expect(reliefPixel(Math.SQRT1_2, 500)[3]).toBe(0);
    expect(reliefPixel(0.2, 0)[3]).toBe(0);
    expect(reliefPixel(0.2, 500)).toEqual([0, 0, 0, expect.any(Number)]);
    expect(reliefPixel(0.2, 500)[3]).toBeLessThanOrEqual(Math.round(0.45 * 255));
    expect(reliefPixel(Math.SQRT1_2, HIGH_GROUND_M + 1)[3]).toBeGreaterThan(0);
  });

  it('turns the real tile into see-through relief', () => {
    const d = tile();
    reliefTile(d, 38.8, 9);
    let shadow = 0;
    let lit = 0;
    let maxAlpha = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      maxAlpha = Math.max(maxAlpha, d[i + 3]);
      if (d[i] < 100) shadow++;
      else lit++;
    }
    expect(shadow).toBeGreaterThan(1000);
    expect(lit).toBeGreaterThan(1000);
    expect(maxAlpha).toBeLessThanOrEqual(Math.round(0.45 * 255));
  });
});
