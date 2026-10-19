import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/tcf
// The Aviation Weather Center's TFM Convective Forecast (TCF), from aviationweather.gov (free, no
// key): where thunderstorms are expected over the US 4, 6 and 8 hours ahead, with how much of each
// area they will cover, the forecasters' confidence and the storm tops. Air traffic flow planners
// use it to plan reroutes. Issued every 2 hours. Trimmed, KV-cached 10 minutes.

interface Env {
  LORE_KV?: KVNamespace;
}

export interface TcfArea {
  /** Unix seconds the forecast is for. */
  validTime: number;
  issueTime?: number;
  /** "sparse" (25-39% of the area), "medium" (40-74%), "solid" (75% or more). */
  coverage: string;
  /** "high" or "low". */
  confidence: string;
  /** Storm tops in feet. */
  tops?: number;
  /** "area" (a polygon) or "line" (a line of storms). */
  kind: 'area' | 'line';
  coords: [number, number][];
}

const CACHE_KEY = 'tcf:v1';
const CACHE_TTL_SECONDS = 600;

const TCF_URL = 'https://aviationweather.gov/api/data/tcf?format=geojson';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });

/** "20261020_0300" -> unix seconds; anything else -> undefined. */
export function tcfTime(value: unknown): number | undefined {
  const m = typeof value === 'string' ? value.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})$/) : null;
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000 : undefined;
}

/** "340" (hundreds of feet) -> 34000. */
function tops(value: unknown): number | undefined {
  const v = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return /^\d{1,3}$/.test(v) ? parseInt(v, 10) * 100 : undefined;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function points(list: unknown): [number, number][] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p) => [round2(p[1]), round2(p[0])] as [number, number]);
}

/** TCF GeoJSON features -> areas and lines, dropping forecasts already past. */
export function buildTcf(features: any[], now: number): TcfArea[] {
  return features.flatMap((f): TcfArea[] => {
    const p = f?.properties || {};
    const validTime = tcfTime(p.validTime);
    if (validTime === undefined || validTime <= now) return [];
    const g = f.geometry || {};
    const base = {
      validTime,
      issueTime: tcfTime(p.issueTime),
      coverage: String(p.coverage || '').toLowerCase(),
      confidence: String(p.confidence || '').toLowerCase(),
      tops: tops(p.tops),
    };
    if (g.type === 'Polygon') {
      const coords = points(g.coordinates?.[0]);
      return coords.length >= 3 ? [{ ...base, kind: 'area', coords }] : [];
    }
    if (g.type === 'LineString') {
      const coords = points(g.coordinates);
      return coords.length >= 2 ? [{ ...base, kind: 'line', coords }] : [];
    }
    return [];
  });
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.env.LORE_KV) {
    const cached = await context.env.LORE_KV.get(CACHE_KEY, { type: 'json' });
    if (cached) return json(cached);
  }

  let data: any = null;
  try {
    const res = await fetch(TCF_URL, { headers: { 'User-Agent': USER_AGENT } });
    // 204 (no content) means no thunderstorms forecast: an empty, complete answer.
    data = res.status === 204 ? { features: [] } : res.ok ? await res.json() : null;
  } catch {
    data = null;
  }
  const features: any[] = Array.isArray(data?.features) ? data.features : [];
  const result = { areas: buildTcf(features, Math.floor(Date.now() / 1000)), complete: !!data };

  if (result.complete && context.env.LORE_KV) {
    await context.env.LORE_KV.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  }
  return json(result);
};
