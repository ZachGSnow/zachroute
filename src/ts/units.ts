// Display units chosen in the settings menu (stored on this device). Distances are computed
// in statute miles everywhere and converted only for display. Weather units are US (F, inHg,
// statute-mile visibility) or metric (C, hPa QNH, km / m visibility); the default follows the
// device locale. Wind stays in knots and altitude and runway length in feet everywhere, as
// aviation sources report them worldwide.

export type DistanceUnit = 'mi' | 'km' | 'nm';
export type ClockFormat = '12h' | '24h';
export type WeatherUnits = 'us' | 'metric';

const DISTANCE_KEY = 'zachroute:distance-unit';
const CLOCK_KEY = 'zachroute:clock';
const WEATHER_KEY = 'zachroute:weather-units';
export const UNITS_CHANGED = 'zachroute:units-changed';

const KM_PER_MI = 1.609344;
const NM_PER_MI = 0.868976;

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

let distanceUnit: DistanceUnit = read(DISTANCE_KEY, ['mi', 'km', 'nm'] as const, 'mi');
let clockFormat: ClockFormat = read(CLOCK_KEY, ['12h', '24h'] as const, '12h');

// Regions that use Fahrenheit and inches of mercury: the US and its territories, plus Liberia,
// Palau, the Bahamas, Belize and the Cayman Islands (CLDR's "US" measurement / temperature
// regions). Everywhere else gets metric.
const US_UNIT_REGIONS = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'LR', 'PW', 'BS', 'BZ', 'KY']);

/** "us" for a locale like "en-US" or "es-PR", "metric" for "en-GB", "de", "pt-BR". */
export function defaultWeatherUnits(locale?: string): WeatherUnits {
  const region = (locale || '').split(/[-_]/)[1]?.toUpperCase();
  return region && US_UNIT_REGIONS.has(region) ? 'us' : locale ? 'metric' : 'us';
}

function deviceLocale(): string | undefined {
  try {
    return navigator.language;
  } catch {
    return undefined;
  }
}

let weatherUnits: WeatherUnits = read(WEATHER_KEY, ['us', 'metric'] as const, defaultWeatherUnits(deviceLocale()));

export const getDistanceUnit = () => distanceUnit;
export const getClockFormat = () => clockFormat;
export const getWeatherUnits = () => weatherUnits;

function announce() {
  try {
    window.dispatchEvent(new CustomEvent(UNITS_CHANGED));
  } catch {
    /* no window in tests */
  }
}

export function setDistanceUnit(unit: DistanceUnit) {
  distanceUnit = unit;
  try {
    localStorage.setItem(DISTANCE_KEY, unit);
  } catch {
    /* convenience only */
  }
  announce();
}

export function setClockFormat(format: ClockFormat) {
  clockFormat = format;
  try {
    localStorage.setItem(CLOCK_KEY, format);
  } catch {
    /* convenience only */
  }
  announce();
}

export function setWeatherUnits(units: WeatherUnits) {
  weatherUnits = units;
  try {
    localStorage.setItem(WEATHER_KEY, units);
  } catch {
    /* convenience only */
  }
  announce();
}

const fToC = (f: number) => ((f - 32) * 5) / 9;
const cToF = (c: number) => (c * 9) / 5 + 32;

/** "57 F" or "14 C" (with a degree sign). Pass the reported Celsius value when there is one so it is not converted twice. */
export function formatTemp(tempF: number, tempC?: number, units: WeatherUnits = weatherUnits): string {
  if (units === 'metric') return `${Math.round(tempC ?? fToC(tempF))}\u00b0C`;
  return `${Math.round(tempC !== undefined ? cToF(tempC) : tempF)}\u00b0F`;
}

/** Temperature / dewpoint spread in the chosen unit, as a number of degrees. */
export function tempSpread(tempF: number, dewpointF: number, tempC?: number, dewpointC?: number, units: WeatherUnits = weatherUnits): number {
  if (units === 'metric') return Math.round(tempC !== undefined && dewpointC !== undefined ? tempC - dewpointC : ((tempF - dewpointF) * 5) / 9);
  return Math.round(tempF - dewpointF);
}

/** Spread at or below which fog is likely: 5 degrees F, or 3 degrees C. */
export const fogSpread = (units: WeatherUnits = weatherUnits) => (units === 'metric' ? 3 : 5);

/** "Altimeter 29.92 inHg" or "QNH 1013 hPa", the way each convention names it. */
export function formatPressure(inHg: number, hpa?: number, units: WeatherUnits = weatherUnits): string {
  if (units === 'metric') return `QNH ${Math.round(hpa ?? inHg / 0.0295299)} hPa`;
  return `Altimeter ${inHg.toFixed(2)} inHg`;
}

const KM_PER_SM = 1.609344;

/**
 * Visibility from a report in statute miles ("6+", "10", "1 1/2", "1/4", or a number), in the
 * chosen unit: "6+ mi" / "9.7+ km" / "800 m". Strings that are not a mile value pass through.
 */
export function formatVisibility(visib: string | number, units: WeatherUnits = weatherUnits): string {
  const text = String(visib).trim();
  const plus = text.endsWith('+');
  const body = plus ? text.slice(0, -1).trim() : text;
  let miles: number | undefined;
  const mixed = body.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  const frac = body.match(/^(\d+)\/(\d+)$/);
  if (mixed) miles = Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  else if (frac) miles = Number(frac[1]) / Number(frac[2]);
  else if (/^\d+(\.\d+)?$/.test(body)) miles = Number(body);
  if (miles === undefined) return text;

  if (units === 'us') return `${body}${plus ? '+' : ''} mi`;
  const km = miles * KM_PER_SM;
  // ICAO reports visibility in metres below 5 km, rounded to 100 m.
  if (km < 5) return `${Math.max(100, Math.round((km * 1000) / 100) * 100).toLocaleString('en-US')}${plus ? '+' : ''} m`;
  return `${km < 10 ? Math.floor(km * 10) / 10 : Math.round(km)}${plus ? '+' : ''} km`;
}

/**
 * Metric visibility straight from an ICAO METAR's own group, which is already in metres
 * ("9999" = 10 km or more, "CAVOK"), so it is not rounded through statute miles. Returns
 * undefined for US-style METARs ("10SM") or when the group cannot be found.
 */
export function metarVisibilityMetric(raw?: string): string | undefined {
  if (!raw) return undefined;
  // after the wind group (and optional variable-direction group): 4-digit metres or CAVOK
  const m = raw.match(/\s(?:\d{3}|VRB)\d{2,3}(?:G\d{2,3})?(?:KT|MPS)\s(?:\d{3}V\d{3}\s)?(\d{4}|CAVOK)(?:NDV)?\s/);
  if (!m) return undefined;
  if (m[1] === 'CAVOK' || m[1] === '9999') return '10+ km';
  const metres = Number(m[1]);
  return metres < 5000 ? `${metres.toLocaleString('en-US')} m` : `${Math.round(metres / 1000)} km`;
}

/** Converts statute miles into the chosen unit. */
export function convertMiles(miles: number, unit: DistanceUnit = distanceUnit): number {
  if (unit === 'km') return miles * KM_PER_MI;
  if (unit === 'nm') return miles * NM_PER_MI;
  return miles;
}

/** "1,234 mi", "1,986 km" or "1,072 nm", rounded to whole units. */
export function formatDistance(miles: number, unit: DistanceUnit = distanceUnit): string {
  return `${Math.round(convertMiles(miles, unit)).toLocaleString('en-US')} ${unit}`;
}

/** Intl options for a clock time ("6:40 PM" or "18:40"). */
export function clockOptions(format: ClockFormat = clockFormat): Intl.DateTimeFormatOptions {
  return format === '24h' ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : { hour: 'numeric', minute: '2-digit', hour12: true };
}

/** Intl options for an hour-only label ("6 PM" or "18:00"). */
export function hourOptions(format: ClockFormat = clockFormat): Intl.DateTimeFormatOptions {
  return format === '24h' ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : { hour: 'numeric', hour12: true };
}
