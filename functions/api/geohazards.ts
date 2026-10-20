import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/geohazards
// Earthquakes of magnitude 4.5 and up worldwide in the last day (USGS earthquake feed) and US
// volcanoes at an elevated alert (USGS Volcano Hazards Program notices, with the aviation color
// code). Both free, no key. Volcano notices carry no coordinates, so each volcano's position comes
// from the USGS volcano API, KV-cached 30 days. The result is KV-cached 10 minutes.

interface Env {
  LORE_KV?: KVNamespace;
}

export interface Quake {
  id: string;
  mag: number;
  place: string;
  /** Unix ms. */
  time: number;
  lat: number;
  lon: number;
  depthKm?: number;
  /** USGS sets this when a tsunami is possible (it is not a tsunami warning). */
  tsunami: boolean;
  url?: string;
}

export interface Volcano {
  name: string;
  /** Aviation color code: GREEN, YELLOW, ORANGE or RED. */
  colorCode: string;
  /** Ground alert level: NORMAL, ADVISORY, WATCH or WARNING. */
  alertLevel: string;
  /** Observatory ("Alaska Volcano Observatory"). */
  observatory?: string;
  /** Unix seconds of the latest notice. */
  sent?: number;
  url?: string;
  lat: number;
  lon: number;
}

const CACHE_KEY = 'geohazards:v1';
const CACHE_TTL_SECONDS = 600;
const QUAKES_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
const VOLCANOES_URL = 'https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes';
const VOLCANO_URL = 'https://volcanoes.usgs.gov/hans-public/api/volcano/getVolcano/';
const MAX_QUAKES = 200;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });

/** USGS earthquake GeoJSON -> quakes, strongest first. */
export function buildQuakes(data: any): Quake[] {
  const features: any[] = Array.isArray(data?.features) ? data.features : [];
  return features
    .flatMap((f): Quake[] => {
      const p = f?.properties || {};
      const [lon, lat, depth] = f?.geometry?.coordinates || [];
      if (!Number.isFinite(p.mag) || !Number.isFinite(lat) || !Number.isFinite(lon) || p.type !== 'earthquake') return [];
      return [
        {
          id: String(f.id || ''),
          mag: Math.round(p.mag * 10) / 10,
          place: String(p.place || ''),
          time: Number(p.time),
          lat,
          lon,
          depthKm: Number.isFinite(depth) ? Math.round(depth) : undefined,
          tsunami: p.tsunami === 1,
          url: typeof p.url === 'string' ? p.url : undefined,
        },
      ];
    })
    .sort((a, b) => b.mag - a.mag)
    .slice(0, MAX_QUAKES);
}

/** An elevated-volcano notice plus that volcano's record (for its position) -> a volcano, or null. */
export function buildVolcano(notice: any, record: any): Volcano | null {
  const lat = Number(record?.latitude);
  const lon = Number(record?.longitude);
  const colorCode = String(notice?.color_code || '').toUpperCase();
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !colorCode) return null;
  return {
    name: String(notice?.volcano_name || record?.volcano_name || ''),
    colorCode,
    alertLevel: String(notice?.alert_level || '').toUpperCase(),
    observatory: notice?.obs_fullname || undefined,
    sent: Number.isFinite(Number(notice?.sent_unixtime)) ? Number(notice.sent_unixtime) : undefined,
    url: typeof notice?.notice_url === 'string' ? notice.notice_url : undefined,
    lat,
    lon,
  };
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

/** A volcano's record from the USGS API, KV-cached 30 days (volcanoes do not move). */
async function volcanoRecord(env: Env, vnum: string): Promise<any | null> {
  const key = `volcano:v1:${vnum}`;
  if (env.LORE_KV) {
    const cached = await env.LORE_KV.get(key, { type: 'json' });
    if (cached) return cached;
  }
  const rec = await getJson(VOLCANO_URL + encodeURIComponent(vnum));
  if (rec && Number.isFinite(Number(rec.latitude)) && env.LORE_KV) {
    const slim = { volcano_name: rec.volcano_name, latitude: rec.latitude, longitude: rec.longitude };
    await env.LORE_KV.put(key, JSON.stringify(slim), { expirationTtl: 30 * 24 * 60 * 60 });
  }
  return rec;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.env.LORE_KV) {
    const cached = await context.env.LORE_KV.get(CACHE_KEY, { type: 'json' });
    if (cached) return json(cached);
  }
  const [quakeData, notices] = await Promise.all([getJson(QUAKES_URL), getJson(VOLCANOES_URL)]);
  const list: any[] = Array.isArray(notices) ? notices.filter((n) => /^\d+$/.test(String(n?.vnum || ''))).slice(0, 40) : [];
  const records = await Promise.all(list.map((n) => volcanoRecord(context.env, String(n.vnum))));
  const volcanoes = list.map((n, i) => buildVolcano(n, records[i])).filter((v): v is Volcano => !!v);
  const result = { quakes: buildQuakes(quakeData), volcanoes, complete: !!quakeData && Array.isArray(notices) };
  if (result.complete && context.env.LORE_KV) {
    await context.env.LORE_KV.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  }
  return json(result);
};
