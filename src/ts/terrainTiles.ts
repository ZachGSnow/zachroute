// Terrain shading: relief computed in the browser from the AWS Open Data terrain tiles (Terrarium
// format: elevation in meters packed into RGB), drawn as see-through gray shadows and highlights so
// the dark base map and the weather layers stay readable, with a faint pale tint on high ground
// (above 10,000 ft). Sea and lakes at or below sea level are left clear.
// No Leaflet here; mapOverlays.ts draws it.

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRAIN_MAX_NATIVE_ZOOM = 12;
export const HIGH_GROUND_M = 3048; // 10,000 ft

/** Terrarium pixel -> elevation in meters. */
export function terrariumMeters(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Ground size of one pixel (meters) on a 256-pixel Web Mercator tile at a latitude and zoom. */
export function pixelMeters(lat: number, z: number): number {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** z);
}

/**
 * Relief is exaggerated more the further out the map is: a whole mountain range at zoom 5 is only
 * a few pixels across, and true slopes over 5 km pixels look flat.
 */
export function exaggeration(z: number): number {
  return Math.max(1, Math.min(8, 2 ** ((10 - z) / 2)));
}

// Light from the northwest (azimuth 315, the cartographic convention) at 45 degrees, in the
// mathematical angle the formula uses (ESRI: 360 - azimuth + 90).
const LIGHT = ((360 - 315 + 90) % 360) * (Math.PI / 180);
const ALTITUDE = (45 * Math.PI) / 180;

/**
 * Hillshade (0 dark to 1 lit; a flat surface is sin(45 deg), about 0.71) from the 3 x 3 elevation
 * neighbourhood around a pixel, Horn's method. `cell` is the pixel size in meters.
 */
export function hillshade(e: number[], cell: number, zFactor = 1): number {
  const [a, b, c, d, , f, g, h, i] = e;
  const dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * cell);
  const dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * cell);
  const slope = Math.atan(zFactor * Math.hypot(dzdx, dzdy));
  const aspect = Math.atan2(dzdy, -dzdx);
  const shade = Math.sin(ALTITUDE) * Math.cos(slope) + Math.cos(ALTITUDE) * Math.sin(slope) * Math.cos(LIGHT - aspect);
  return Math.max(0, Math.min(1, shade));
}

const FLAT = Math.sin(ALTITUDE);

/**
 * RGBA for one pixel: shadows darken (black, up to about 45% opaque), lit slopes brighten a little
 * (white, up to about 20%), flat ground is clear; high ground adds a faint pale tint.
 */
export function reliefPixel(shade: number, elevationM: number): [number, number, number, number] {
  if (elevationM <= 0) return [0, 0, 0, 0];
  const high = elevationM >= HIGH_GROUND_M ? 0.12 : 0;
  if (shade < FLAT) {
    const a = Math.min(0.45, ((FLAT - shade) / FLAT) * 0.9);
    // Over high ground, the pale tint shows through the shadow a little.
    return high ? [40, 44, 52, Math.round(Math.max(a, high) * 255)] : [0, 0, 0, Math.round(a * 255)];
  }
  const lit = Math.min(0.2, ((shade - FLAT) / (1 - FLAT)) * 0.4);
  return [235, 238, 242, Math.round(Math.max(lit, high) * 255)];
}

/**
 * Redraws one Terrarium tile (RGBA, size x size) into relief in place. Edge pixels reuse their own
 * row or column for the missing neighbours.
 */
export function reliefTile(rgba: Uint8ClampedArray, lat: number, z: number, size = 256): void {
  const elev = new Float32Array(size * size);
  for (let p = 0; p < size * size; p++) elev[p] = terrariumMeters(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]);
  const cell = pixelMeters(lat, z);
  const zf = exaggeration(z);
  const at = (x: number, y: number) => elev[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))];
  const win = new Array<number>(9);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) win[k++] = at(x + dx, y + dy);
      const [r, g, b, a] = reliefPixel(hillshade(win, cell, zf), elev[y * size + x]);
      const i = (y * size + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    }
  }
}
