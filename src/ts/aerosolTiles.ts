// Dust and smoke from space: NASA GIBS tiles of the daily OMPS (NOAA-20) UV aerosol index, which
// lights up desert dust and wildfire smoke worldwide. The tiles paint clean air in greys, whites
// and pale yellows, which would wash out the dark base map, so each tile is drawn through a
// canvas that keeps only the strongly colored (yellow to red) pixels. No Leaflet here; the layer
// is in mapOverlays.ts.
//
// Each day's map is one UTC day built from the satellite's daily passes (about 13:30 local time
// everywhere), so a new day starts empty and fills in from east to west: at 19:49 UTC on
// 2026-10-16 the Americas had no data for the day yet. Each tile is therefore drawn from today's
// image where today has been observed and from yesterday's everywhere else.

const TILE_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/OMPS_NOAA20_NadirMapper_AerosolIndex_380/default';

/** Tile URL template for one UTC day ("2026-10-16"), with {z}/{y}/{x} left for Leaflet. */
export function aerosolTileUrl(day: string): string {
  return `${TILE_BASE}/${day}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`;
}

/** Today and yesterday as UTC dates, the two days a tile is drawn from. */
export function aerosolDays(now = new Date()): { today: string; yesterday: string } {
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { today, yesterday };
}

/** The source has tiles up to zoom 6; Leaflet scales them up beyond that. */
export const AEROSOL_MAX_NATIVE_ZOOM = 6;

/**
 * Fills the pixels today's image has not observed yet (transparent; observed clean air is drawn
 * grey) from yesterday's image, in place. Both are canvas ImageData of the same size.
 */
export function fillFromYesterday(today: Uint8ClampedArray, yesterday: Uint8ClampedArray): void {
  for (let i = 0; i < today.length; i += 4) {
    if (today[i + 3] !== 0) continue;
    today[i] = yesterday[i];
    today[i + 1] = yesterday[i + 1];
    today[i + 2] = yesterday[i + 2];
    today[i + 3] = yesterday[i + 3];
  }
}

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
