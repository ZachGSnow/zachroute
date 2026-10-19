// Satellite clouds: infrared cloud-top images from five geostationary satellites. Each pixel comes
// from the satellite nearest overhead, and ground is cleared so only cloud shows over the base map.
//   - GOES-East, GOES-West and Himawari from NASA GIBS (band 13, "clean" longwave window), newest
//     image (every 10 minutes).
//   - Meteosat-12 (Europe, Africa) and Meteosat-9 (Middle East, India) from EUMETSAT, the newest
//     top-of-the-hour image: EUMETSAT's hourly images are free and unrestricted, its 15-minute ones
//     only after 3 hours. These are 8-bit gray, read back to temperature with the tables in
//     meteosatCalibration.ts and drawn in NASA's colors so the seams match.
// No Leaflet here; mapOverlays.ts draws it.

import { METEOSAT_12_GRAY, METEOSAT_9_GRAY_WEST, METEOSAT_9_GRAY_EAST, GIBS_IR_COLORS } from './meteosatCalibration';

/** Color the cold cores are drawn in: the "extreme" magenta of the severity ladder. */
export const COLD_CORE_RGBA: [number, number, number, number] = [217, 70, 239, 235];

/** A EUMETSAT WMS layer, and how its gray reads back to temperature. */
export interface EumetsatSource {
  /** WMS layer, "mtg_fd:ir105_hrfi". */
  layer: string;
  style: string;
  /** Path of the layer's own (small) capabilities document, which gives its newest image time. */
  capabilities: string;
  /** Gray tables by longitude: one is used as is, two are blended between their longitudes. */
  calibration: Array<{ lon: number; table: Array<[number, number]> }>;
}

export interface Satellite {
  name: string;
  /** NASA GIBS layer, for the GIBS satellites. */
  layer?: string;
  eumetsat?: EumetsatSource;
  /** Longitude of the point the satellite sits over. */
  lon: number;
}

export const SATELLITES: Satellite[] = [
  { name: 'GOES-East', layer: 'GOES-East_ABI_Band13_Clean_Infrared', lon: -75.2 },
  { name: 'GOES-West', layer: 'GOES-West_ABI_Band13_Clean_Infrared', lon: -137.2 },
  { name: 'Himawari', layer: 'Himawari_AHI_Band13_Clean_Infrared', lon: 140.7 },
  {
    name: 'Meteosat-12',
    lon: 0,
    eumetsat: {
      layer: 'mtg_fd:ir105_hrfi',
      style: 'mtg_fd:mtg_fd_ir105_hrfi_grayscale',
      capabilities: 'mtg_fd/ir105_hrfi',
      calibration: [{ lon: 0, table: METEOSAT_12_GRAY }],
    },
  },
  {
    name: 'Meteosat-9',
    lon: 45.5,
    eumetsat: {
      layer: 'msg_iodc:ir108',
      style: '',
      capabilities: 'msg_iodc/ir108',
      // Matched to Meteosat-12 at their midpoint and to Himawari at theirs.
      calibration: [
        { lon: 22.75, table: METEOSAT_9_GRAY_WEST },
        { lon: 93.1, table: METEOSAT_9_GRAY_EAST },
      ],
    },
  },
];

export const EUMETSAT_WMS = 'https://view.eumetsat.int/geoserver';

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

const WEB_MERCATOR_HALF = 20037508.342789244;

/** A EUMETSAT image for one map tile (Web Mercator bounds of tile x, y at zoom z) at `time`. */
export function eumetsatTileUrl(src: EumetsatSource, x: number, y: number, z: number, time: string): string {
  const size = (2 * WEB_MERCATOR_HALF) / 2 ** z;
  const west = -WEB_MERCATOR_HALF + x * size;
  const north = WEB_MERCATOR_HALF - y * size;
  const bbox = [west, north - size, west + size, north].map((v) => v.toFixed(2)).join(',');
  const q = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetMap',
    layers: src.layer,
    styles: src.style,
    crs: 'EPSG:3857',
    bbox,
    width: '256',
    height: '256',
    format: 'image/png',
    transparent: 'true',
    time,
  });
  return `${EUMETSAT_WMS}/ows?${q.toString()}`;
}

export function eumetsatCapabilitiesUrl(src: EumetsatSource): string {
  return `${EUMETSAT_WMS}/${src.capabilities}/ows?service=WMS&version=1.3.0&request=GetCapabilities`;
}

/**
 * The newest top-of-the-hour image time from a layer's capabilities: its newest image, rounded
 * down to the hour (an hourly image is free; asking for a later time would get a 15-minute one).
 */
export function latestHourlyTime(capabilitiesXml: string): string | null {
  const m = capabilitiesXml.match(/name="time"\s+default="(\d{4}-\d{2}-\d{2}T\d{2}):\d{2}:\d{2}(?:\.\d+)?Z"/);
  return m ? `${m[1]}:00:00Z` : null;
}

/** Temperature (C) from a gray value through one table (warm to cold, gray rising). */
export function grayToTemp(table: Array<[number, number]>, gray: number): number {
  if (gray <= table[0][1]) return table[0][0];
  for (let i = 1; i < table.length; i++) {
    const [t1, g1] = table[i];
    if (gray <= g1) {
      const [t0, g0] = table[i - 1];
      return t0 + ((t1 - t0) * (gray - g0)) / (g1 - g0);
    }
  }
  return table[table.length - 1][0];
}

/** Temperature of a Meteosat gray pixel at a longitude, blending two calibrations between their longitudes. */
export function meteosatTemp(src: EumetsatSource, gray: number, lon: number): number {
  const cal = src.calibration;
  if (cal.length === 1 || lon <= cal[0].lon) return grayToTemp(cal[0].table, gray);
  const last = cal[cal.length - 1];
  if (lon >= last.lon) return grayToTemp(last.table, gray);
  const w = (lon - cal[0].lon) / (last.lon - cal[0].lon);
  return (1 - w) * grayToTemp(cal[0].table, gray) + w * grayToTemp(last.table, gray);
}

const GIBS_COLORS: Array<[number, number, number, number]> = GIBS_IR_COLORS.trim()
  .split(/\s+/)
  .map((tok) => {
    const [t, hex] = tok.split(':');
    const n = parseInt(hex, 16);
    return [parseFloat(t), (n >> 16) & 255, (n >> 8) & 255, n & 255];
  });

/** NASA's color for a cloud-top temperature (the GIBS entry whose range holds it). */
export function gibsColor(tempC: number): [number, number, number] {
  // Entries run cold to warm: the last one whose lower bound is below the temperature holds it.
  for (let i = GIBS_COLORS.length - 1; i >= 0; i--) {
    const [lower, r, g, b] = GIBS_COLORS[i];
    if (tempC > lower) return [r, g, b];
  }
  const [, r, g, b] = GIBS_COLORS[0];
  return [r, g, b];
}

/**
 * Coldest temperature a Meteosat pixel is drawn at. Both images saturate between about -60 and
 * -70 C, so a saturated top is only known to be about this cold or colder: it is drawn in solid
 * "extreme" red, not the near-black of NASA's -70 C edge (which reads as missing data) nor the
 * magenta core (which would claim -70 to -80 C).
 */
export const METEOSAT_COLDEST_C = -65;

/**
 * New RGBA for one Meteosat pixel: its temperature drawn as the GIBS satellites' pixel would be
 * (white cloud, colored cold tops), warm ground and sea cleared.
 */
export function meteosatPixel(src: EumetsatSource, gray: number, alpha: number, lon: number): [number, number, number, number] {
  if (alpha === 0 || gray === 0) return [0, 0, 0, 0];
  const t = Math.max(METEOSAT_COLDEST_C, meteosatTemp(src, gray, lon));
  if (t >= 0) return [0, 0, 0, 0];
  const [r, g, b] = gibsColor(t);
  return cloudPixel(r, g, b, 255);
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


