import { describe, expect, it } from 'vitest';
import { keepAerosolPixels, fillFromYesterday, aerosolDays, aerosolTileUrl } from '../src/ts/aerosolTiles';

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

  it('asks GIBS for a given day of the NOAA-20 aerosol index', () => {
    expect(aerosolTileUrl('2026-10-16')).toBe(
      'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/OMPS_NOAA20_NadirMapper_AerosolIndex_380/default/2026-10-16/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png'
    );
  });

  it('uses UTC days, including across a month boundary', () => {
    expect(aerosolDays(new Date('2026-10-16T19:49:00Z'))).toEqual({ today: '2026-10-16', yesterday: '2026-10-15' });
    expect(aerosolDays(new Date('2026-11-01T00:30:00Z'))).toEqual({ today: '2026-11-01', yesterday: '2026-10-31' });
  });

  it('fills only the pixels today has not observed yet from yesterday', () => {
    const today = new Uint8ClampedArray([
      0, 0, 0, 0, // not observed yet today
      200, 200, 200, 255, // observed today: clean air (grey)
      255, 0, 0, 255, // observed today: thick
    ]);
    const yesterday = new Uint8ClampedArray([
      255, 200, 0, 255, // yesterday: dust here
      255, 0, 0, 255, // yesterday: thick here, but today is newer
      0, 0, 0, 0,
    ]);
    fillFromYesterday(today, yesterday);
    expect([...today]).toEqual([255, 200, 0, 255, 200, 200, 200, 255, 255, 0, 0, 255]);
  });
});
