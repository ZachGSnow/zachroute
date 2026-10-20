import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/spaceweather
// NOAA Space Weather Prediction Center (free, no key): the current NOAA space weather scales
// (R radio blackouts, S solar radiation storms, G geomagnetic storms, each 0-5) with tomorrow's
// forecast, the latest planetary Kp, and the OVATION aurora forecast (chance of aurora overhead, on
// a 1-degree grid, about 30-90 minutes ahead). Polar flights reroute for radiation storms, and HF
// radio fails near the poles and on the day side during storms. Only aurora cells with a chance of
// 5% or more are sent. KV-cached 15 minutes.

interface Env {
  LORE_KV?: KVNamespace;
}

export interface Scales {
  R: number;
  S: number;
  G: number;
}

export interface SpaceWeather {
  now: Scales;
  /** Tomorrow: the G level forecast, and the chance (%) of R1-R2, R3+ and S1+ events. */
  tomorrow?: { G: number; minorRadioPct?: number; majorRadioPct?: number; radiationPct?: number };
  kp?: number;
  kpTime?: string;
  aurora?: {
    observed?: string;
    forecast?: string;
    /** [lon 0-359, lat -90..90, chance %]. */
    cells: [number, number, number][];
  };
}

const CACHE_KEY = 'spaceweather:v1';
const CACHE_TTL_SECONDS = 15 * 60;
const SCALES_URL = 'https://services.swpc.noaa.gov/products/noaa-scales.json';
const KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
const AURORA_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const MIN_AURORA_PCT = 5;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });

const level = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 0;
};
const pct = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

/** SWPC noaa-scales.json -> current levels ("0") and tomorrow's forecast ("1"). */
export function readScales(data: any): Pick<SpaceWeather, 'now' | 'tomorrow'> {
  const now = data?.['0'] || {};
  const next = data?.['1'];
  return {
    now: { R: level(now.R?.Scale), S: level(now.S?.Scale), G: level(now.G?.Scale) },
    tomorrow: next
      ? { G: level(next.G?.Scale), minorRadioPct: pct(next.R?.MinorProb), majorRadioPct: pct(next.R?.MajorProb), radiationPct: pct(next.S?.Prob) }
      : undefined,
  };
}

/** Latest Kp from the planetary K index list (objects with time_tag and Kp). */
export function latestKp(data: any): { kp?: number; kpTime?: string } {
  const rows: any[] = Array.isArray(data) ? data : [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const kp = Number(rows[i]?.Kp);
    if (Number.isFinite(kp)) return { kp, kpTime: rows[i]?.time_tag ? `${String(rows[i].time_tag).replace(/Z?$/, 'Z')}` : undefined };
  }
  return {};
}

/** OVATION grid -> the cells with a chance of aurora of 5% or more. */
export function auroraCells(data: any): SpaceWeather['aurora'] {
  const coords: any[] = Array.isArray(data?.coordinates) ? data.coordinates : [];
  const cells = coords
    .filter((c) => Array.isArray(c) && Number(c[2]) >= MIN_AURORA_PCT && Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1])))
    .map((c) => [Number(c[0]), Number(c[1]), Math.min(100, Math.round(Number(c[2])))] as [number, number, number]);
  return { observed: data?.['Observation Time'], forecast: data?.['Forecast Time'], cells };
}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.env.LORE_KV) {
    const cached = await context.env.LORE_KV.get(CACHE_KEY, { type: 'json' });
    if (cached) return json(cached);
  }
  const [scales, kp, aurora] = await Promise.all([getJson(SCALES_URL), getJson(KP_URL), getJson(AURORA_URL)]);
  if (!scales) return json({ error: 'upstream' }, 502);
  const result: SpaceWeather = { ...readScales(scales), ...latestKp(kp), aurora: aurora ? auroraCells(aurora) : undefined };
  if (kp && aurora && context.env.LORE_KV) {
    await context.env.LORE_KV.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  }
  return json(result);
};
