// Satellite clouds: NASA GIBS infrared (band 13, "clean" longwave window) from the three
// geostationary satellites GIBS carries, newest image (every 10 minutes). Each pixel comes from
// the satellite nearest overhead, and ground is cleared so only cloud shows over the base map.
// There is no satellite here for Europe, Africa or the Middle East, and only the faded edge of
// Himawari's view over India (GIBS has no Meteosat).
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

/** Longitude reach used to decide which satellites' tiles to load for a map tile. */
export const MAX_VIEW_DEG = 75;
/**
 * Angle (degrees, measured at the Earth's center) from the point below the satellite. Past about
 * 62 degrees the view is so slanted that ordinary cloud reads as cold storm tops, so pixels fade
 * out from there and are dropped past 70.
 */
export const FADE_START_DEG = 62;
export const FADE_END_DEG = 70;
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

/** Cosine of the angle between a point and the point below the satellite (on the equator). */
export function viewCos(lat: number, lon: number, sat: Satellite): number {
  const rad = Math.PI / 180;
  return Math.cos(lat * rad) * Math.cos(lonDistance(lon, sat.lon) * rad);
}

const COS_FADE_START = Math.cos((FADE_START_DEG * Math.PI) / 180);
const COS_FADE_END = Math.cos((FADE_END_DEG * Math.PI) / 180);

/** 1 where the view is fine, fading to 0 toward the edge of the satellite's view. */
export function viewWeight(cos: number): number {
  if (cos >= COS_FADE_START) return 1;
  if (cos <= COS_FADE_END) return 0;
  return (cos - COS_FADE_END) / (COS_FADE_START - COS_FADE_END);
}

/** Whether any satellite here sees this point well enough to draw. */
export function satelliteCovers(lat: number, lon: number): boolean {
  return SATELLITES.some((sat) => viewWeight(viewCos(lat, lon, sat)) > 0);
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

/**
 * NASA's palette draws the coldest storm tops (about -80 to -70 C) with the same gray ramp as
 * warm ground, so a gray pixel alone cannot say which it is. A cold core always sits between the
 * red band (-70 to -60 C, whose cold edge is near-black) and the pink band (-91 to -80 C, whose
 * warm edge is near-white), and its gray changes gradually across it. So the core is found by
 * spreading from red pixels into near-black gray and from pink pixels into near-white gray, then
 * on through gray that changes by no more than a step at a time, at most a few pixels deep.
 * Checked on live tiles: on downscaled, low-zoom tiles red can touch ground directly, which an
 * unguarded fill spread across the whole tile.
 */
export function isRedBand(r: number, g: number, b: number): boolean {
  return r >= 20 && g <= 30 && b <= 30 && r - Math.max(g, b) >= 20;
}

export function isPinkBand(r: number, g: number, b: number): boolean {
  return r >= 120 && b >= 100 && r - g >= 60 && b - g >= 60;
}

function isGray(r: number, g: number, b: number): boolean {
  return Math.max(r, g, b) - Math.min(r, g, b) <= 24;
}

const MAX_DEPTH = 12;
const STEP = 50;
const NEAR_BLACK = 60;
const NEAR_WHITE = 180;
const FROM_RED = -2;
const FROM_PINK = -3;

/** Marks (1) the gray pixels of cold storm cores in one square RGBA tile. */
export function coldCoreMask(rgba: Uint8ClampedArray, size = 256): Uint8Array {
  const n = size * size;
  const mask = new Uint8Array(n);
  const depth = new Uint8Array(n);
  const value = new Int16Array(n).fill(-1);
  const queue: number[] = [];
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (rgba[i + 3] === 0) continue;
    if (isRedBand(rgba[i], rgba[i + 1], rgba[i + 2])) {
      value[p] = FROM_RED;
      queue.push(p);
    } else if (isPinkBand(rgba[i], rgba[i + 1], rgba[i + 2])) {
      value[p] = FROM_PINK;
      queue.push(p);
    }
  }
  const steps = [1, -1, size, -size];
  for (let k = 0; k < queue.length; k++) {
    const p = queue[k];
    if (depth[p] >= MAX_DEPTH) continue;
    const x = p % size;
    for (const step of steps) {
      const q = p + step;
      if (q < 0 || q >= n || (step === 1 && x === size - 1) || (step === -1 && x === 0) || mask[q]) continue;
      const i = q * 4;
      if (rgba[i + 3] === 0 || !isGray(rgba[i], rgba[i + 1], rgba[i + 2])) continue;
      const v = (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3;
      const from = value[p];
      const ok = from === FROM_RED ? v <= NEAR_BLACK : from === FROM_PINK ? v >= NEAR_WHITE : Math.abs(v - from) <= STEP;
      if (!ok) continue;
      mask[q] = 1;
      value[q] = Math.round(v);
      depth[q] = depth[p] + 1;
      queue.push(q);
    }
  }
  return mask;
}

/** Color the cold cores are drawn in: the "extreme" magenta of the severity ladder. */
export const COLD_CORE_RGBA: [number, number, number, number] = [217, 70, 239, 235];
