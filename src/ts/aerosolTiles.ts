// Dust and smoke from space: NASA GIBS tiles of the daily OMPS (NOAA-20) UV aerosol index, which
// lights up desert dust and wildfire smoke worldwide. The tiles paint clean air in greys, whites
// and pale yellows, which would wash out the dark base map, so each tile is drawn through a
// canvas that keeps only the strongly colored (yellow to red) pixels. No Leaflet here; the layer
// is in mapOverlays.ts.

export const AEROSOL_TILE_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/OMPS_NOAA20_NadirMapper_AerosolIndex_380/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png';

/** The source has tiles up to zoom 6; Leaflet scales them up beyond that. */
export const AEROSOL_MAX_NATIVE_ZOOM = 6;

/**
 * Below this saturation a pixel is grey, white or pale yellow (little or no aerosol) and is
 * dropped. Picked by eye on a Saharan dust day: 0.3 left a pale wash over everything, 0.7 lost
 * the moderate dust around the plume.
 */
const MIN_SATURATION = 0.55;
const MIN_BRIGHTNESS = 40;
/** Opacity of a just-kept pixel and of a fully saturated one, so stronger color shows stronger. */
const MIN_ALPHA = 80;
const MAX_ALPHA = 220;

/**
 * Makes grey, white, pale and near-black pixels transparent and gives the rest an opacity that
 * grows with how strongly colored they are, in place. `rgba` is canvas ImageData: four bytes
 * per pixel.
 */
export function keepAerosolPixels(rgba: Uint8ClampedArray): void {
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const max = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]);
    const min = Math.min(rgba[i], rgba[i + 1], rgba[i + 2]);
    const saturation = max === 0 ? 0 : (max - min) / max;
    rgba[i + 3] =
      saturation >= MIN_SATURATION && max >= MIN_BRIGHTNESS
        ? Math.round(MIN_ALPHA + ((MAX_ALPHA - MIN_ALPHA) * (saturation - MIN_SATURATION)) / (1 - MIN_SATURATION))
        : 0;
  }
}
