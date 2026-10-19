// Satellite clouds: NASA GIBS infrared (band 13, "clean" longwave window) from the three
// geostationary satellites GIBS carries, newest image (every 10 minutes). Each pixel comes from
// the satellite nearest overhead, and ground is cleared so only cloud shows over the base map.
// There is no satellite here for Europe, Africa, the Middle East or India (GIBS has no Meteosat).
// No Leaflet here; mapOverlays.ts draws it.

export interface Satellite {
  name: string;
  layer: string;
  /** Longitude of the point the satellite sits over. */
  lon: number;
}

export const SATELLITES: Satellite[] = [
  { name: 'GOES-East', layer: 'GOES-East_ABI_Band13_Clean_Infrared', lon: -75.2 },
  { name: 'GOES-West', layer: 'GOES-West_ABI_Band13_Clean_Infrared', lon: -137.2 },
  { name: 'Himawari', layer: 'Himawari_AHI_Band13_Clean_Infrared', lon: 140.7 },
];

/** Past this distance from the point below a satellite, its view is too slanted to use. */
export const MAX_VIEW_DEG = 75;
export const SATELLITE_MAX_NATIVE_ZOOM = 6;

/** "default" asks GIBS for the newest image it has. */
export function satelliteTileUrl(sat: Satellite): string {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${sat.layer}/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`;
}

/** Shortest distance between two longitudes in degrees. */
export function lonDistance(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return d;
}

/** Satellites that can see a longitude, nearest overhead first. */
export function satellitesFor(lon: number): Satellite[] {
  return SATELLITES.filter((s) => lonDistance(lon, s.lon) <= MAX_VIEW_DEG).sort(
    (a, b) => lonDistance(lon, a.lon) - lonDistance(lon, b.lon)
  );
}

/** Satellites that can see any part of a longitude range (west to east, may cross the date line). */
export function satellitesForRange(west: number, east: number): Satellite[] {
  const span = east >= west ? east - west : east + 360 - west;
  if (span >= 180) return [...SATELLITES];
  const out = new Set<Satellite>();
  for (let i = 0; i <= 8; i++) for (const s of satellitesFor(west + (span * i) / 8)) out.add(s);
  return SATELLITES.filter((s) => out.has(s));
}

/** Whether any satellite here covers this longitude. */
export function satelliteCovers(lon: number): boolean {
  return satellitesFor(lon).length > 0;
}

/**
 * New RGBA for one pixel of GIBS's enhanced infrared palette. Gray is the warm end (ground, sea,
 * low cloud): darker gray is cleared, lighter gray becomes white cloud fading in. The colored
 * enhancement marks cold, high cloud tops and is kept.
 */
export function cloudPixel(r: number, g: number, b: number, a: number): [number, number, number, number] {
  if (a === 0) return [0, 0, 0, 0];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min > 24) return [r, g, b, 220]; // colored: cold tops
  const light = (r + g + b) / 3;
  const LOW = 165;
  const HIGH = 235;
  if (light <= LOW) return [0, 0, 0, 0];
  const t = Math.min(1, (light - LOW) / (HIGH - LOW));
  return [255, 255, 255, Math.round(40 + t * 150)];
}
