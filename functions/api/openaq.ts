import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/openaq?lat=..&lon=..
// The nearest ground station's measured PM2.5 (fine particles) within 25 km, from OpenAQ v3 (free
// key: the OPENAQ_API_KEY Pages secret, sent as a header and never returned). Many listed stations
// stopped reporting years ago, and a station's sensors report separately, so only a PM2.5 sensor
// reading from the last 3 hours counts. Reference monitors are preferred over low-cost sensors.
// KV-cached 30 minutes per 0.1-degree cell, to stay well inside the key's hourly limit.

interface Env {
  LORE_KV?: KVNamespace;
  OPENAQ_API_KEY?: string;
}

export interface Pm25Reading {
  /** Micrograms per cubic metre. */
  pm25: number;
  /** ISO UTC time of the reading. */
  time: string;
  station: string;
  /** Data provider ("AirNow", "CPCB", "Clarity", ...). */
  provider?: string;
  /** Kilometres from the requested point. */
  distanceKm: number;
  /** A reference (regulatory-grade) monitor, rather than a low-cost sensor. */
  monitor: boolean;
  locationId: number;
}

const API = 'https://api.openaq.org/v3';
const RADIUS_M = 25000;
const MAX_AGE_MS = 3 * 60 * 60 * 1000;
const MAX_LATEST_CALLS = 3;
const CACHE_TTL_SECONDS = 30 * 60;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': status === 200 ? 'public, max-age=900' : 'no-store' },
  });

export interface Candidate {
  id: number;
  name: string;
  provider?: string;
  distanceKm: number;
  monitor: boolean;
  pm25Sensors: number[];
}

/**
 * Locations that may have a fresh PM2.5 reading: not mobile, with a PM2.5 sensor, last reporting
 * within 3 hours. Reference monitors first, then low-cost sensors, each nearest first.
 */
export function candidates(data: any, now = Date.now()): Candidate[] {
  const results: any[] = Array.isArray(data?.results) ? data.results : [];
  return results
    .filter((r) => !r?.isMobile && Date.parse(r?.datetimeLast?.utc) >= now - MAX_AGE_MS)
    .map((r): Candidate => ({
      id: Number(r.id),
      name: String(r.name || ''),
      provider: r.provider?.name || undefined,
      distanceKm: Math.round((Number(r.distance) / 1000) * 10) / 10,
      monitor: r.isMonitor === true,
      pm25Sensors: (Array.isArray(r.sensors) ? r.sensors : []).filter((s: any) => s?.parameter?.name === 'pm25').map((s: any) => Number(s.id)),
    }))
    .filter((c) => c.pm25Sensors.length > 0 && Number.isFinite(c.distanceKm))
    .sort((a, b) => Number(b.monitor) - Number(a.monitor) || a.distanceKm - b.distanceKm);
}

/** The location's latest PM2.5 value, when its PM2.5 sensor reported within 3 hours. */
export function pm25FromLatest(data: any, c: Candidate, now = Date.now()): Pm25Reading | null {
  const results: any[] = Array.isArray(data?.results) ? data.results : [];
  const hit = results
    .filter((r) => c.pm25Sensors.includes(Number(r?.sensorsId)) && Number.isFinite(Number(r?.value)) && Number(r.value) >= 0)
    .filter((r) => Date.parse(r?.datetime?.utc) >= now - MAX_AGE_MS)
    .sort((a, b) => Date.parse(b.datetime.utc) - Date.parse(a.datetime.utc))[0];
  if (!hit) return null;
  return {
    pm25: Math.round(Number(hit.value) * 10) / 10,
    time: new Date(Date.parse(hit.datetime.utc)).toISOString(),
    station: c.name,
    provider: c.provider,
    distanceKm: c.distanceKm,
    monitor: c.monitor,
    locationId: c.id,
  };
}

async function getJson(url: string, key: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'X-API-Key': key, Accept: 'application/json' } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const q = new URL(context.request.url).searchParams;
  const lat = Number(q.get('lat'));
  const lon = Number(q.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return json({ error: 'lat and lon required' }, 400);
  }
  const key = context.env.OPENAQ_API_KEY;
  if (!key) return json({ available: false, reading: null });

  // Everyone in the same 0.1-degree cell (about 11 km) shares one lookup, made from its center.
  const cLat = Math.round(lat * 10) / 10;
  const cLon = Math.round(lon * 10) / 10;
  const cacheKey = `openaq:v1:${cLat.toFixed(1)},${cLon.toFixed(1)}`;
  if (context.env.LORE_KV) {
    const cached = await context.env.LORE_KV.get(cacheKey, { type: 'json' });
    if (cached) return json(cached);
  }

  const locations = await getJson(`${API}/locations?coordinates=${cLat},${cLon}&radius=${RADIUS_M}&limit=1000&parameters_id=2`, key);
  if (!locations) return json({ available: false, reading: null });
  let reading: Pm25Reading | null = null;
  for (const c of candidates(locations).slice(0, MAX_LATEST_CALLS)) {
    reading = pm25FromLatest(await getJson(`${API}/locations/${c.id}/latest`, key), c);
    if (reading) break;
  }
  const result = { available: true, reading };
  if (context.env.LORE_KV) await context.env.LORE_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  return json(result);
};
