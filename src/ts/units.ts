// Display units chosen in the settings menu (stored on this device). Distances are computed
// in statute miles everywhere and converted only for display. Wind stays in knots, altitude
// and runway length in feet, and visibility in statute miles, as aviation sources report them.

export type DistanceUnit = 'mi' | 'km' | 'nm';
export type ClockFormat = '12h' | '24h';

const DISTANCE_KEY = 'zachroute:distance-unit';
const CLOCK_KEY = 'zachroute:clock';
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

export const getDistanceUnit = () => distanceUnit;
export const getClockFormat = () => clockFormat;

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
