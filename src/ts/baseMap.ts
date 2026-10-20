// Base map tile sources. Kept apart from mapRenderer.ts (which needs Leaflet) so tests can check them.

export type BaseStyle = 'dark' | 'light' | 'satellite';

export interface BaseLayerOptions {
  maxZoom: number;
  maxNativeZoom?: number;
  pane?: string;
  attribution: string;
}

// Stadia Maps needs no API key: it authenticates browser requests by domain (*.zachroute.pages.dev
// is registered in the Stadia dashboard; localhost works without registration). A fork deployed on
// another domain must register that domain with its own Stadia account. Stadia's satellite style
// is refused on the free plan (403), so satellite imagery is EOX's Sentinel-2 cloudless mosaic
// (CC BY-NC-SA 4.0, non-commercial use with credit) with Stadia's free label layer on top.
const STADIA_CREDIT =
  '&copy; <a href="https://stadiamaps.com/" target="_blank" rel="noopener">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const STAMEN_CREDIT = '&copy; <a href="https://stamen.com/" target="_blank" rel="noopener">Stamen Design</a>';
export const EOX_YEAR = 2025;
const EOX_CREDIT = `<a href="https://cloudless.eox.at" target="_blank" rel="noopener">EOxCloudless ${EOX_YEAR}</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data ${EOX_YEAR})`;

export function baseLayerSpecs(style: BaseStyle): Array<{ url: string; options: BaseLayerOptions }> {
  if (style === 'satellite') {
    return [
      {
        url: `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${EOX_YEAR}_3857/default/g/{z}/{y}/{x}.jpg`,
        options: { maxZoom: 20, maxNativeZoom: 15, attribution: EOX_CREDIT },
      },
      {
        url: 'https://tiles.stadiamaps.com/tiles/stamen_toner_labels/{z}/{x}/{y}{r}.png',
        options: { maxZoom: 20, pane: 'baseLabels', attribution: `${STADIA_CREDIT} ${STAMEN_CREDIT}` },
      },
    ];
  }
  const name = style === 'light' ? 'alidade_smooth' : 'alidade_smooth_dark';
  return [{ url: `https://tiles.stadiamaps.com/tiles/${name}/{z}/{x}/{y}{r}.png`, options: { maxZoom: 20, attribution: STADIA_CREDIT } }];
}
