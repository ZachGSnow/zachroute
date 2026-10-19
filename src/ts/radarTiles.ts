// Weather radar: the US from NEXRAD (Iowa Environmental Mesonet tiles, about 1 km detail) and the
// rest of the world from RainViewer (zoom 7 at most, latest frame only: its free API allows 100
// requests a minute per viewer). Each tile is read back to radar strength (dBZ) from the source's
// own color table and redrawn on the severity ladder, so both sources look the same. Storm tops
// (US only) come from IEM's NEXRAD echo tops, in thousands of feet.
// No Leaflet here; mapOverlays.ts draws it.

import { IEM_N0Q, IEM_N0Q_FROM_INDEX, IEM_EET, IEM_EET_FROM_KFT, RAINVIEWER, RAINVIEWER_FROM_DBZ } from './radarPalettes';
import { severityColor, type Severity } from './severity';

export const IEM_REFLECTIVITY_URL = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png';
export const IEM_ECHO_TOPS_URL = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-eet-900913/{z}/{x}/{y}.png';
export const IEM_REFLECTIVITY_TIME_URL = 'https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.json';
export const IEM_ECHO_TOPS_TIME_URL = 'https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/eet_0.json';

/** What the radar layer shows: precipitation (worldwide) or storm tops (US). */
export type RadarMode = 'precip' | 'tops';
export const RAINVIEWER_MAPS_URL = 'https://api.rainviewer.com/public/weather-maps.json';
/** The IEM composite is about 1 km per pixel; past zoom 8 the map just enlarges its tiles. */
export const IEM_MAX_NATIVE_ZOOM = 8;
/** RainViewer's free API stops at zoom 7. */
export const RAINVIEWER_MAX_NATIVE_ZOOM = 7;

/**
 * Where the IEM US composite is used (south, west, north, east). Outside it, RainViewer. NEXRAD
 * reaches a little into Canada and Mexico, which this box takes in.
 */
export const US_RADAR_BOX: [number, number, number, number] = [23, -127, 50, -65];

export function inUsRadarBox(lat: number, lon: number): boolean {
  const [s, w, n, e] = US_RADAR_BOX;
  return lat >= s && lat <= n && lon >= w && lon <= e;
}

/** Whether a tile (by its edges) lies entirely inside the US box, so RainViewer is not needed there. */
export function tileInsideUsBox(south: number, west: number, north: number, east: number): boolean {
  return inUsRadarBox(south, west) && inUsRadarBox(north, east);
}

/** Whether a tile touches the US box at all, so IEM is worth asking. */
export function tileTouchesUsBox(south: number, west: number, north: number, east: number): boolean {
  const [s, w, n, e] = US_RADAR_BOX;
  return north >= s && south <= n && east >= w && west <= e;
}

/** {packed rgb: value} from a table of hex colors, value = start + step * position. */
function lookup(table: string, start: number, step: number): Map<number, number> {
  const map = new Map<number, number>();
  table
    .trim()
    .split(/\s+/)
    .forEach((hex, i) => {
      const key = parseInt(hex, 16);
      if (!map.has(key)) map.set(key, start + step * i);
    });
  return map;
}

const pack = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;

const IEM_DBZ = lookup(IEM_N0Q, IEM_N0Q_FROM_INDEX / 2 - 32.5, 0.5);
const IEM_KFT = lookup(IEM_EET, IEM_EET_FROM_KFT, 1);
const RAINVIEWER_DBZ = lookup(RAINVIEWER, RAINVIEWER_FROM_DBZ, 1);

/** dBZ of an IEM reflectivity pixel, or undefined for no echo or anything under 20 dBZ. */
export function iemDbz(r: number, g: number, b: number, a: number): number | undefined {
  return a === 0 ? undefined : IEM_DBZ.get(pack(r, g, b));
}

/** Echo top in thousands of feet of an IEM echo tops pixel, or undefined. */
export function iemTopsKft(r: number, g: number, b: number, a: number): number | undefined {
  return a === 0 ? undefined : IEM_KFT.get(pack(r, g, b));
}

/** dBZ of a RainViewer Universal Blue pixel, or undefined for no echo or anything under 20 dBZ. */
export function rainviewerDbz(r: number, g: number, b: number, a: number): number | undefined {
  return a < 255 ? undefined : RAINVIEWER_DBZ.get(pack(r, g, b));
}

/**
 * Radar strength onto the ladder. Under 20 dBZ is not drawn (drizzle, clutter); 20-30 is rain,
 * drawn soft blue (0); then Light 30-40, Moderate 40-45, Severe 45-50, Extreme 50 and up (hail is
 * possible; airliners keep about 20 nm from anything over 40).
 */
export function radarLevel(dbz: number | undefined): 0 | Severity | null {
  if (dbz === undefined || dbz < 20) return null;
  if (dbz < 30) return 0;
  if (dbz < 40) return 1;
  if (dbz < 45) return 2;
  if (dbz < 50) return 3;
  return 4;
}

/** Storm tops onto the ladder: under 20,000 ft not drawn, then Light, Moderate, Severe from 20, 30, 40 and Extreme from 50. */
export function topsLevel(kft: number | undefined): Severity | null {
  if (kft === undefined || kft < 20) return null;
  if (kft < 30) return 1;
  if (kft < 40) return 2;
  if (kft < 50) return 3;
  return 4;
}

/** Soft blue for plain rain, so it reads as weather but not as a hazard. */
export const RAIN_RGBA: [number, number, number, number] = [96, 165, 250, 120];
const LEVEL_ALPHA = 200;

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const LEVEL_RGBA: Array<[number, number, number, number]> = [RAIN_RGBA, ...([1, 2, 3, 4] as Severity[]).map((s) => [...hexRgb(severityColor(s)), LEVEL_ALPHA] as [number, number, number, number])];

/** Color a level is drawn in (0 = rain). */
export function levelRgba(level: 0 | Severity): [number, number, number, number] {
  return LEVEL_RGBA[level];
}

/**
 * Redraws one RGBA tile in place: each pixel is read back to a value and drawn in its level's
 * color, or cleared. `keep(x, y)` can clear pixels another source covers.
 */
export function recolorTile(
  rgba: Uint8ClampedArray,
  level: (r: number, g: number, b: number, a: number) => 0 | Severity | null,
  keep?: (x: number, y: number) => boolean,
  size = 256
): void {
  for (let p = 0; p < size * size; p++) {
    const i = p * 4;
    const l = keep && !keep(p % size, Math.floor(p / size)) ? null : level(rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]);
    if (l === null) {
      rgba[i + 3] = 0;
      continue;
    }
    const c = LEVEL_RGBA[l];
    rgba[i] = c[0];
    rgba[i + 1] = c[1];
    rgba[i + 2] = c[2];
    rgba[i + 3] = c[3];
  }
}

export const iemReflectivityLevel = (r: number, g: number, b: number, a: number) => radarLevel(iemDbz(r, g, b, a));
export const rainviewerLevel = (r: number, g: number, b: number, a: number) => radarLevel(rainviewerDbz(r, g, b, a));
export const iemTopsLevel = (r: number, g: number, b: number, a: number) => topsLevel(iemTopsKft(r, g, b, a));

/** Newest RainViewer frame: its tile URL template (Universal Blue, no smoothing, no snow colors) and time. */
export function rainviewerFrame(maps: any): { url: string; time: number } | null {
  const past = maps?.radar?.past;
  const host = typeof maps?.host === 'string' ? maps.host : '';
  if (!Array.isArray(past) || !past.length || !host.startsWith('https://')) return null;
  const last = past[past.length - 1];
  if (typeof last?.path !== 'string' || typeof last?.time !== 'number') return null;
  return { url: `${host}${last.path}/256/{z}/{x}/{y}/2/0_0.png`, time: last.time };
}

/** Valid time (unix seconds) of the IEM composite from its JSON sidecar. */
export function iemTime(meta: any): number | null {
  const t = Date.parse(meta?.meta?.valid);
  return Number.isFinite(t) ? t / 1000 : null;
}
