import { describe, expect, it } from 'vitest';
import { keepAerosolPixels, AEROSOL_TILE_URL } from '../src/ts/aerosolTiles';

/** Runs the filter over a list of [r, g, b, a] pixels and returns the resulting alphas. */
function alphas(pixels: number[][]): number[] {
  const data = new Uint8ClampedArray(pixels.flat());
  keepAerosolPixels(data);
  return pixels.map((_, i) => data[i * 4 + 3]);
}

describe('dust and smoke tiles', () => {
  it('drops the greys, whites and pale yellows that stand for clean air', () => {
    expect(alphas([
      [255, 255, 255, 255], // white
      [200, 200, 200, 255], // light grey
      [180, 175, 160, 255], // the warm grey the OMPS palette uses for low values
      [235, 230, 140, 255], // pale yellow (saturation 0.40): barely any aerosol
      [10, 10, 10, 255], // near black
      [30, 0, 0, 255], // near black with a tint (edge anti-aliasing)
    ])).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('keeps yellow to red, partly transparent', () => {
    const kept = alphas([
      [255, 255, 0, 255], // yellow: some dust or smoke
      [255, 140, 0, 255], // orange
      [200, 0, 0, 255], // red: thick
      [120, 20, 20, 255], // dark red
    ]);
    expect(kept.every((a) => a > 0 && a < 255)).toBe(true);
  });

  it('shows stronger color more strongly', () => {
    const [muted, vivid] = alphas([
      [230, 200, 80, 255], // muted yellow, just over the cut-off
      [255, 220, 0, 255], // vivid yellow
    ]);
    expect(muted).toBeGreaterThan(0);
    expect(vivid).toBeGreaterThan(muted);
  });

  it('leaves already transparent pixels alone', () => {
    expect(alphas([[255, 0, 0, 0]])).toEqual([0]);
  });

  it('asks GIBS for the latest daily NOAA-20 aerosol index', () => {
    expect(AEROSOL_TILE_URL).toContain('OMPS_NOAA20_NadirMapper_AerosolIndex_380/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png');
  });
});
