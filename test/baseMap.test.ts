// Base map styles. Stadia serves the dark and light maps; its satellite style answered 403 for
// zachroute.pages.dev on the free plan (checked 2026-10-20), so satellite is EOX Sentinel-2
// cloudless, whose WMTS path puts the row before the column.
import { describe, expect, it } from 'vitest';
import { baseLayerSpecs, EOX_YEAR } from '../src/ts/baseMap';

const tile = (url: string, z: number, x: number, y: number) => url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)).replace('{r}', '');

describe('base map styles', () => {
  it('keeps the dark map the app has always used', () => {
    const [dark] = baseLayerSpecs('dark');
    expect(tile(dark.url, 5, 8, 12)).toBe('https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/5/8/12.png');
    expect(tile(baseLayerSpecs('light')[0].url, 5, 8, 12)).toBe('https://tiles.stadiamaps.com/tiles/alidade_smooth/5/8/12.png');
  });

  it('builds satellite from EOX imagery with place names above the weather layers', () => {
    const [imagery, labels] = baseLayerSpecs('satellite');
    // O'Hare at zoom 13 is column 2096, row 3043
    expect(tile(imagery.url, 13, 2096, 3043)).toBe(`https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${EOX_YEAR}_3857/default/g/13/3043/2096.jpg`);
    expect(imagery.options.maxNativeZoom).toBeLessThanOrEqual(15);
    expect(labels.url).toContain('stamen_toner_labels');
    expect(labels.options.pane).toBe('baseLabels');
  });

  it('credits every source on the map', () => {
    for (const style of ['dark', 'light', 'satellite'] as const) {
      for (const spec of baseLayerSpecs(style)) expect(spec.options.attribution).toMatch(/href="https:\/\//);
    }
    expect(baseLayerSpecs('satellite')[0].options.attribution).toContain(`Copernicus Sentinel data ${EOX_YEAR}`);
  });
});
