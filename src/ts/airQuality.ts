// Air quality, smoke and haze at an airport, worldwide, from the Open-Meteo air-quality API
// (CAMS global and European models; CORS-enabled, no key). Fetched directly by the browser.

export interface AqHour {
  time: string;
  usAqi?: number;
  euAqi?: number;
  aod?: number;
}

export interface AirQuality {
  time: string;
  usAqi?: number;
  euAqi?: number;
  /** Fine particles (PM2.5), micrograms per cubic metre. */
  pm25?: number;
  pm10?: number;
  /** Mineral dust near the surface, micrograms per cubic metre. */
  dust?: number;
  /** Aerosol optical depth at 550 nm: how much haze, smoke or dust is in the whole air column. */
  aod?: number;
  hours: AqHour[];
}

export type AqiScale = 'us' | 'eu';

// Countries covered by the European Environment Agency's European Air Quality Index
// (EU members, EEA members and cooperating countries) plus the UK.
const EAQI_COUNTRIES = new Set(
  'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO CH TR AL BA ME MK RS XK GB'.split(' ')
);

/** European AQI for European airports, the US AQI (the most widely used scale) everywhere else. */
export function aqiScaleFor(country?: string): AqiScale {
  return country && EAQI_COUNTRIES.has(country) ? 'eu' : 'us';
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Open-Meteo response -> current values plus the hours from the current one on. */
export function parseAirQuality(json: any): AirQuality | null {
  const c = json?.current;
  if (!c || typeof c.time !== 'string') return null;
  const h = json.hourly || {};
  const times: string[] = Array.isArray(h.time) ? h.time : [];
  const hours: AqHour[] = times
    .map((t, i) => ({ time: `${t}:00Z`, usAqi: num(h.us_aqi?.[i]), euAqi: num(h.european_aqi?.[i]), aod: num(h.aerosol_optical_depth?.[i]) }))
    .filter((x) => x.time >= `${c.time}:00Z`);
  return {
    time: `${c.time}:00Z`,
    usAqi: num(c.us_aqi),
    euAqi: num(c.european_aqi),
    pm25: num(c.pm2_5),
    pm10: num(c.pm10),
    dust: num(c.dust),
    aod: num(c.aerosol_optical_depth),
    hours,
  };
}

export interface AqiCategory {
  label: string;
  /** 0 (best) to 5 (worst), comparable across both scales. */
  level: number;
}

const US_BANDS: Array<[number, string]> = [
  [50, 'Good'],
  [100, 'Moderate'],
  [150, 'Unhealthy for sensitive groups'],
  [200, 'Unhealthy'],
  [300, 'Very unhealthy'],
  [Infinity, 'Hazardous'],
];

const EU_BANDS: Array<[number, string]> = [
  [20, 'Good'],
  [40, 'Fair'],
  [60, 'Moderate'],
  [80, 'Poor'],
  [100, 'Very poor'],
  [Infinity, 'Extremely poor'],
];

export function aqiCategory(value: number, scale: AqiScale): AqiCategory {
  const bands = scale === 'eu' ? EU_BANDS : US_BANDS;
  const level = bands.findIndex(([max]) => value <= max);
  return { label: bands[level][1], level };
}

export const aqiValue = (x: { usAqi?: number; euAqi?: number }, scale: AqiScale) => (scale === 'eu' ? x.euAqi : x.usAqi);

/** Optical depth above which the air is noticeably hazy, and above which haze is thick. */
const HAZY_AOD = 0.6;
const THICK_AOD = 1.0;
/** Near-surface dust above which blowing dust is likely to cut visibility. */
const DUSTY = 200;

/** A note when smoke, dust or haze may reduce visibility, else null. */
export function hazeNote(aq: AirQuality): string | null {
  if (aq.dust !== undefined && aq.dust >= DUSTY) return 'Dusty air: blowing dust may reduce visibility';
  if (aq.aod !== undefined && aq.aod >= THICK_AOD) return 'Thick haze, smoke or dust: visibility may be reduced';
  if (aq.aod !== undefined && aq.aod >= HAZY_AOD) return 'Hazy: smoke, dust or pollution in the air';
  return null;
}

const LOOKAHEAD_HOURS = 12;
/** A coming hour must also be this much above now, so 40 -> 42 across a band edge is not news. */
const MIN_RISE = 1.1;

/** The worst hour in the next 12 when it falls in a worse category than now (and at least 10% higher), else null. */
export function worseningAhead(aq: AirQuality, scale: AqiScale): { hour: AqHour; value: number; category: AqiCategory } | null {
  const now = aqiValue(aq, scale);
  if (now === undefined) return null;
  const nowLevel = aqiCategory(now, scale).level;
  let worst: { hour: AqHour; value: number } | null = null;
  for (const hour of aq.hours.slice(1, LOOKAHEAD_HOURS + 1)) {
    const v = aqiValue(hour, scale);
    if (v !== undefined && (!worst || v > worst.value)) worst = { hour, value: v };
  }
  if (!worst) return null;
  const category = aqiCategory(worst.value, scale);
  return category.level > nowLevel && worst.value >= now * MIN_RISE ? { ...worst, category } : null;
}

const cache = new Map<string, { at: number; data: Promise<AirQuality | null> }>();
const CACHE_MS = 30 * 60 * 1000;

export function fetchAirQuality(lat: number, lon: number): Promise<AirQuality | null> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = (async (): Promise<AirQuality | null> => {
    if (!navigator.onLine) return null;
    try {
      const url =
        'https://air-quality-api.open-meteo.com/v1/air-quality' +
        `?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}` +
        '&current=us_aqi,european_aqi,pm2_5,pm10,dust,aerosol_optical_depth' +
        '&hourly=us_aqi,european_aqi,aerosol_optical_depth&forecast_days=2&timezone=GMT';
      const res = await fetch(url);
      if (!res.ok) return null;
      return parseAirQuality(await res.json());
    } catch {
      return null;
    }
  })();
  cache.set(key, { at: Date.now(), data });
  return data;
}
