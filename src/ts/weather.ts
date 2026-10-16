import type { RunwayDetail } from './geoMath';

export interface WeatherSnapshot {
  available: boolean;
  flightCategory?: 'VFR' | 'MVFR' | 'IFR' | 'LIFR' | string;
  windDirDeg?: number;
  windSpeedKt?: number;
  windGustKt?: number;
  visibility?: string;
  tempF?: number;
  dewpointF?: number;
  weatherPhenomena?: string;
  ceilingFt?: number;
  ceilingCover?: string;
  altimeterInHg?: number;
  rawText?: string;
  observedIso?: string;
}

export interface FavoredRunwayEnd {
  ident: string;
  headingDegT: number;
}

interface CategoryInfo {
  label: string;
  className: string;
}

const FLIGHT_CATEGORY_INFO: Record<string, CategoryInfo> = {
  VFR: { label: 'Good flying conditions', className: 'wx-vfr' },
  MVFR: { label: 'Some clouds, reduced visibility', className: 'wx-mvfr' },
  IFR: { label: 'Poor visibility', className: 'wx-ifr' },
  LIFR: { label: 'Very poor visibility', className: 'wx-lifr' },
};

export function categoryInfo(cat?: string): CategoryInfo | null {
  if (!cat) return null;
  return FLIGHT_CATEGORY_INFO[cat] || { label: cat, className: '' };
}

const CATEGORY_DOT: Record<string, string> = {
  VFR: '🟢',
  MVFR: '🔵',
  IFR: '🔴',
  LIFR: '🟣',
};

/** Colored-circle emoji matching the flight category, mobile-friendly stand-in for a CSS dot. */
export function categoryDot(cat?: string): string {
  if (!cat) return '';
  return CATEGORY_DOT[cat] || '⚪';
}

// Plain-English labels for common METAR present-weather codes. Intensity prefix
// (- light, + heavy) is parsed once per group; "VC" (vicinity) prefix is stripped.
const WX_CODE_LABELS: Record<string, string> = {
  TS: 'Thunderstorm',
  RA: 'Rain',
  SN: 'Snow',
  DZ: 'Drizzle',
  GR: 'Hail',
  GS: 'Small hail',
  BR: 'Mist',
  FG: 'Fog',
  HZ: 'Haze',
  FZ: 'Freezing',
  SQ: 'Squall',
  FC: 'Funnel cloud',
  SS: 'Sandstorm',
  DS: 'Duststorm',
};

/** Decodes a raw METAR present-weather string (e.g. "-RA BR") into plain English ("Light Rain, Mist"). */
export function decodeWxPhenomena(wxString?: string): string | null {
  if (!wxString) return null;
  const groups = wxString.split(' ').filter(Boolean);
  const labels: string[] = [];

  for (let group of groups) {
    let prefix = '';
    if (group.startsWith('+')) {
      prefix = 'Heavy ';
      group = group.slice(1);
    } else if (group.startsWith('-')) {
      prefix = 'Light ';
      group = group.slice(1);
    }
    if (group.startsWith('VC')) group = group.slice(2);

    const codes: string[] = [];
    for (let i = 0; i < group.length; i += 2) codes.push(group.slice(i, i + 2));
    const parts = codes.map((c) => WX_CODE_LABELS[c]).filter(Boolean) as string[];
    if (parts.length) labels.push(prefix + parts.join(' '));
  }

  return labels.length ? labels.join(', ') : null;
}

/**
 * Picks a single emoji representing current conditions, prioritizing active
 * precipitation/obstruction-to-vision over generic cloud cover over clear skies.
 */
export function weatherEmoji(wx: WeatherSnapshot, isDaytime: boolean): string {
  const wxStr = (wx.weatherPhenomena || '').toUpperCase();
  if (wxStr.includes('TS')) return '⛈️';
  if (wxStr.includes('FZ')) return '🧊';
  if (wxStr.includes('SN')) return '❄️';
  if (wxStr.includes('RA') || wxStr.includes('SH')) return '🌧️';
  if (wxStr.includes('DZ')) return '🌦️';
  if (wxStr.includes('FG') || wxStr.includes('BR') || wxStr.includes('HZ')) return '🌫️';
  if (wx.ceilingCover === 'OVC' || wx.ceilingCover === 'BKN') return '☁️';
  if (wx.flightCategory === 'MVFR' || wx.flightCategory === 'IFR' || wx.flightCategory === 'LIFR') return '☁️';
  return isDaytime ? '☀️' : '🌙';
}

/**
 * Headwind/crosswind components (knots) for a given runway heading and wind.
 * Positive headwindKt = headwind, negative = tailwind. METAR/TAF winds and
 * OurAirports runway headings are both referenced to true north, so no
 * magnetic variation is needed here.
 */
export function crosswindComponents(
  headingDegT: number,
  windDirDeg: number,
  windSpeedKt: number
): { headwindKt: number; crosswindKt: number } {
  const diffRad = ((windDirDeg - headingDegT) * Math.PI) / 180;
  const headwindKt = Math.round(windSpeedKt * Math.cos(diffRad));
  const crosswindKt = Math.round(Math.abs(windSpeedKt * Math.sin(diffRad)));
  return { headwindKt, crosswindKt };
}

/**
 * Rough density altitude estimate: pressure altitude (approximated here by field
 * elevation, since we don't have a station pressure reading distinct from altimeter)
 * plus ~120ft per degree C the actual temp deviates from the ISA standard for that
 * elevation. A hint for GA performance planning, not a substitute for a POH chart.
 */
export function densityAltitudeFt(elevationFt: number, tempF: number): number {
  const isaTempAtElevC = 15 - (elevationFt / 1000) * 2;
  const actualTempC = ((tempF - 32) * 5) / 9;
  const tempDeviationC = actualTempC - isaTempAtElevC;
  return Math.round(elevationFt + 120 * tempDeviationC);
}

// Short-lived in-memory cache so re-rendering the same card during one session
// doesn't refire the request; the Worker + KV layer behind /api/weather is the
// real cache with a short TTL since weather goes stale fast.
const weatherCache = new Map<string, Promise<WeatherSnapshot>>();
const CACHE_MS = 5 * 60 * 1000;

export function fetchWeather(icao: string): Promise<WeatherSnapshot> {
  if (!icao) return Promise.resolve({ available: false });

  const cached = weatherCache.get(icao);
  if (cached) return cached;

  const promise = (async (): Promise<WeatherSnapshot> => {
    if (!navigator.onLine) return { available: false };
    try {
      const res = await fetch(`/api/weather?icao=${icao}`);
      if (!res.ok) return { available: false };
      return (await res.json()) as WeatherSnapshot;
    } catch {
      return { available: false };
    }
  })();

  weatherCache.set(icao, promise);
  setTimeout(() => weatherCache.delete(icao), CACHE_MS);
  return promise;
}

export function relativeTimeLabel(iso?: string): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (isNaN(then)) return null;
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 min ago';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours === 1) return '1 hr ago';
  return `${hours} hrs ago`;
}

/**
 * Picks the runway end best aligned with the current wind direction.
 * This is a simple heuristic, not an ATC determination (traffic and noise
 * abatement also decide the active runway). METAR wind is true-north
 * referenced, as are the runway headings, so they compare directly.
 */
export function favoredRunwayEnd(
  runways: RunwayDetail[] | undefined,
  windDirDeg: number | undefined
): FavoredRunwayEnd | null {
  if (!runways || runways.length === 0 || windDirDeg === undefined || isNaN(windDirDeg)) {
    return null;
  }

  let best: { ident: string; heading: number; diff: number } | null = null;

  for (const rwy of runways) {
    const [leIdent, heIdent] = rwy.ident.split('/');
    const ends: Array<[string | undefined, number | undefined]> = [
      [leIdent, rwy.leHeadingDegT],
      [heIdent, rwy.heHeadingDegT],
    ];
    for (const [ident, heading] of ends) {
      if (!ident || heading === undefined) continue;
      const rawDiff = Math.abs(windDirDeg - heading) % 360;
      const diff = rawDiff > 180 ? 360 - rawDiff : rawDiff;
      if (!best || diff < best.diff) best = { ident, heading, diff };
    }
  }

  return best ? { ident: best.ident, headingDegT: best.heading } : null;
}

/**
 * Converts a true-north wind direction to magnetic, the way ATIS and tower
 * state it. variationEastDeg is the airport's declination (east positive).
 */
export function trueToMagnetic(trueDeg: number, variationEastDeg: number): number {
  return Math.round((((trueDeg - variationEastDeg) % 360) + 360) % 360);
}
