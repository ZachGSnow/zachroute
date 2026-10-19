// Temperature view of the weather stations layer: the color for a station's temperature and
// whether it is at or below freezing or close enough to its dewpoint for fog. Pure functions,
// no Leaflet, so they can be tested directly.

import { formatTemp, tempSpread, fogSpread, getWeatherUnits, type WeatherUnits } from './units';

/** Color stops in degrees C, cold to hot. Colors between stops are blended. */
const STOPS: Array<[number, [number, number, number]]> = [
  [-30, [196, 181, 253]], // pale violet
  [-15, [129, 140, 248]], // indigo
  [0, [56, 189, 248]], // sky blue: freezing
  [10, [74, 222, 128]], // green
  [20, [250, 204, 21]], // yellow
  [30, [251, 146, 60]], // orange
  [40, [239, 68, 68]], // red
];

/** Hex color for a temperature in degrees C. */
export function tempColor(tempC: number): string {
  const first = STOPS[0];
  const last = STOPS[STOPS.length - 1];
  let rgb = tempC <= first[0] ? first[1] : last[1];
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [t0, c0] = STOPS[i];
    const [t1, c1] = STOPS[i + 1];
    if (tempC >= t0 && tempC <= t1) {
      const f = (tempC - t0) / (t1 - t0);
      rgb = [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * f)) as [number, number, number];
      break;
    }
  }
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
}

export interface StationTemp {
  /** "45" or "7" plus a degree sign: the number in the chosen units, the unit itself is in the settings. */
  label: string;
  /** "45 F, dewpoint 43 F" (with degree signs) for the tooltip. */
  detail: string;
  color: string;
  freezing: boolean;
  /** Temperature and dewpoint within the same spread the airport card uses for "fog likely". */
  fogRisk: boolean;
}

const cToF = (c: number) => (c * 9) / 5 + 32;

/** Display values for a station, or null when it reported no temperature. */
export function stationTemp(tempC?: number, dewpointC?: number, units: WeatherUnits = getWeatherUnits()): StationTemp | null {
  if (typeof tempC !== 'number' || !Number.isFinite(tempC)) return null;
  const hasDew = typeof dewpointC === 'number' && Number.isFinite(dewpointC);
  const full = formatTemp(cToF(tempC), tempC, units);
  const spread = hasDew ? tempSpread(cToF(tempC), cToF(dewpointC), tempC, dewpointC, units) : undefined;
  return {
    label: full.replace(/[CF]$/, ''),
    detail: hasDew ? `${full}, dewpoint ${formatTemp(cToF(dewpointC), dewpointC, units)}` : full,
    color: tempColor(tempC),
    freezing: tempC <= 0,
    fogRisk: spread !== undefined && spread <= fogSpread(units),
  };
}
