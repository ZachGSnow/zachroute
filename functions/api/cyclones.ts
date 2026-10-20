import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/cyclones
// Active tropical cyclones worldwide (every ocean basin) from GDACS, the UN / European Commission
// Global Disaster Alert and Coordination System (free, no key). GDACS republishes the official
// advisories (NHC, JTWC, ...), but hours late. For the Atlantic, East and Central Pacific the
// National Hurricane Center's own current advisory replaces it (CurrentStorms.json, plus cone and
// track from NOAA's tropical map service as GeoJSON; free, no key). Each storm is trimmed to its
// position, track and forecast uncertainty cone. KV-cached 30 minutes.

interface Env {
  LORE_KV?: KVNamespace;
}

export interface TrackPoint {
  lat: number;
  lon: number;
  /** ISO time (UTC). */
  time: string;
  forecast: boolean;
}

export interface Cyclone {
  id: number;
  /** "Champi" */
  name: string;
  /** Strength at the latest advisory: "HU" (hurricane / typhoon), "TS", "TD" or undefined. */
  category?: string;
  /** GDACS alert level for expected impact: Green, Orange or Red ('' for an NHC storm GDACS does not list). */
  alert: string;
  lat: number;
  lon: number;
  /** Time of the latest advisory (ISO, UTC). */
  asOf: string;
  /** Agency the advisory came from ("NOAA", "JTWC", ...). */
  source?: string;
  track: TrackPoint[];
  /** Forecast uncertainty cone as [lat, lon], longitudes kept continuous across the antimeridian. */
  cone?: [number, number][];
  /** GDACS report page, or the NHC public advisory. */
  report?: string;
  /** Strongest wind so far, km/h (GDACS, or the NHC best track). */
  peakWindKmh?: number;
}

const CACHE_KEY = 'cyclones:v2'; // v2: NHC advisories for its basins
const CACHE_TTL_SECONDS = 30 * 60;
const EVENTS_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP';
const MAX_STORMS = 12;
const MAX_CONE_POINTS = 90;
const NHC_STORMS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const NHC_MAP = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
const NHC_LAYERS_KEY = 'nhc:layers:v1';
const MAX_NHC_STORMS = 8;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
  });

/** GDACS times have no zone but are UTC. */
const utc = (t: string) => (/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);

/** "Tropical Cyclone CHAMPI-26" / "CHAMPI-26" -> "Champi". */
export function stormName(eventName: string): string {
  const bare = eventName.replace(/^Tropical Cyclone\s+/i, '').replace(/-\d{2}$/, '');
  return bare.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Track point labels look like "16/10 12:00 UTC" (day/month); the year comes from the advisory. */
export function trackTime(label: string, advisoryIso: string): string | undefined {
  const m = label.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return undefined;
  const adv = new Date(utc(advisoryIso));
  let year = adv.getUTCFullYear();
  const month = Number(m[2]) - 1;
  // A December advisory can forecast into January.
  if (adv.getUTCMonth() === 11 && month === 0) year += 1;
  return new Date(Date.UTC(year, month, Number(m[1]), Number(m[3]), Number(m[4]))).toISOString();
}

function ringCenter(ring: number[][]): [number, number] {
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  let lat = 0;
  let lon = 0;
  for (const [x, y] of pts) {
    lon += x;
    lat += y;
  }
  return [lat / pts.length, lon / pts.length];
}

/** GeoJSON [lon, lat] ring -> [lat, lon], thinned and unwrapped across the antimeridian. */
function toLatLonRing(ring: number[][], maxPoints: number): [number, number][] {
  const step = Math.max(1, Math.ceil(ring.length / maxPoints));
  const out: [number, number][] = [];
  for (let i = 0; i < ring.length; i += step) {
    let lon = ring[i][0];
    if (out.length > 0) {
      const prev = out[out.length - 1][1];
      while (lon - prev > 180) lon -= 360;
      while (lon - prev < -180) lon += 360;
    }
    out.push([ring[i][1], lon]);
  }
  return out;
}

const near = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) < 0.05 && Math.abs(a[1] - b[1]) < 0.05;

/** Strongest wind the storm has reached so far, km/h, from GDACS's severity data. */
export function peakWind(severity: any): number | undefined {
  const v = Number(severity?.severity);
  if (!Number.isFinite(v) || v <= 0) return undefined;
  const unit = String(severity?.severityunit || '').toLowerCase();
  if (unit === 'km/h') return Math.round(v);
  if (unit === 'kt' || unit === 'knots') return Math.round(v * 1.852);
  if (unit === 'mph') return Math.round(v * 1.609344);
  return undefined;
}

/** One storm from its event-list entry and its GDACS geometry collection. */
export function parseStorm(event: any, geometry: any): Cyclone {
  const p = event.properties;
  const [lon, lat] = event.geometry.coordinates;
  const asOf = utc(p.todate);
  const features: any[] = geometry?.features || [];

  const track: TrackPoint[] = features
    .filter((f) => String(f.properties?.Class).startsWith('Point_Polygon_Point') && f.geometry?.type === 'Polygon')
    .map((f) => {
      const time = trackTime(String(f.properties.polygonlabel || ''), asOf);
      const [tLat, tLon] = ringCenter(f.geometry.coordinates[0]);
      return time ? { lat: Math.round(tLat * 100) / 100, lon: Math.round(tLon * 100) / 100, time, forecast: time > asOf } : null;
    })
    .filter((t): t is TrackPoint => !!t)
    .sort((a, b) => a.time.localeCompare(b.time));

  // Strength now: the track segment that starts at the current position (or, failing that, ends there).
  const lines = features.filter((f) => String(f.properties?.Class).startsWith('Line_') && f.geometry?.type === 'LineString');
  const here = [lon, lat];
  const seg =
    lines.find((f) => near(f.geometry.coordinates[0], here)) || lines.find((f) => near(f.geometry.coordinates[f.geometry.coordinates.length - 1], here));
  const category = seg?.properties?.polygonlabel || undefined;

  const coneFeature = features.find((f) => f.properties?.Class === 'Poly_Cones' && f.geometry?.type === 'Polygon');
  const cone = coneFeature ? toLatLonRing(coneFeature.geometry.coordinates[0], MAX_CONE_POINTS) : undefined;

  return {
    id: p.eventid,
    name: stormName(p.eventname || p.name || ''),
    category,
    alert: p.alertlevel || 'Green',
    lat,
    lon,
    asOf: new Date(asOf).toISOString(),
    source: p.source || undefined,
    track,
    cone: cone && cone.length >= 3 ? cone : undefined,
    report: p.url?.report || undefined,
    peakWindKmh: peakWind(p.severitydata),
  };
}

// ---------------------------------------------------------------------------
// National Hurricane Center
// ---------------------------------------------------------------------------

/** The tropical map service's layers by name ("EP1 Forecast Cone" -> 138). Each active storm has a bin (EP1, AT2, ...). */
export function nhcLayerIds(mapService: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of Array.isArray(mapService?.layers) ? mapService.layers : []) {
    if (typeof l?.name === 'string' && Number.isInteger(l?.id)) out[l.name] = l.id;
  }
  return out;
}

/** NHC classification -> HU, TS or TD (subtropical ones by strength); post-tropical and others undefined. */
export function nhcCategory(classification: unknown): string | undefined {
  const c = String(classification || '').toUpperCase();
  if (c === 'HU' || c === 'MH') return 'HU';
  if (c === 'TS' || c === 'STS') return 'TS';
  if (c === 'TD' || c === 'STD') return 'TD';
  return undefined;
}

/** Forecast point time "21/1800" (day/hhmm, UTC); month and year from the advisory, rolling into the next month. */
export function nhcForecastTime(validtime: unknown, advisoryIso: string): string | undefined {
  const m = typeof validtime === 'string' ? validtime.match(/^(\d{1,2})\/(\d{2})(\d{2})$/) : null;
  const adv = new Date(advisoryIso);
  if (!m || isNaN(adv.getTime())) return undefined;
  let month = adv.getUTCMonth();
  let year = adv.getUTCFullYear();
  if (Number(m[1]) < adv.getUTCDate() - 7) {
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return new Date(Date.UTC(year, month, Number(m[1]), Number(m[2]), Number(m[3]))).toISOString();
}

/** Best-track time 2026101106 (yyyymmddhh, UTC). */
export function nhcPastTime(dtg: unknown): string | undefined {
  const m = String(dtg ?? '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})$/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4])).toISOString() : undefined;
}

const ktToKmh = (kt: number) => Math.round(kt * 1.852);

/** Stable negative id for an NHC storm GDACS does not list ("ep212026" -> -2026521). */
function nhcId(id: string): number {
  const m = id.match(/^([a-z]{2})(\d{2})(\d{4})$/i);
  const basin = { al: 1, at: 1, ep: 5, cp: 7 }[m?.[1].toLowerCase() as 'al'] || 9;
  return m ? -(Number(m[3]) * 1000 + basin * 100 + Number(m[2])) : -1;
}

/** One NHC storm from CurrentStorms.json and its cone, forecast points and best-track points (GeoJSON). */
export function parseNhcStorm(storm: any, cone: any, forecast: any, past: any): Cyclone {
  const asOf = new Date(storm?.publicAdvisory?.issuance || storm?.lastUpdate).toISOString();
  const pastTrack: TrackPoint[] = (past?.features || [])
    .map((f: any) => {
      const time = nhcPastTime(f?.properties?.dtg);
      const [lon, lat] = f?.geometry?.coordinates || [];
      return time && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon, time, forecast: false } : null;
    })
    .filter((t: TrackPoint | null): t is TrackPoint => !!t);
  const forecastTrack: TrackPoint[] = (forecast?.features || [])
    .filter((f: any) => Number(f?.properties?.tau) > 0)
    .map((f: any) => {
      const time = nhcForecastTime(f?.properties?.validtime, asOf);
      const [lon, lat] = f?.geometry?.coordinates || [];
      return time && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon, time, forecast: true } : null;
    })
    .filter((t: TrackPoint | null): t is TrackPoint => !!t);
  const winds = [Number(storm?.intensity), ...(past?.features || []).map((f: any) => Number(f?.properties?.intensity))].filter(
    (v) => Number.isFinite(v) && v > 0
  );
  const coneRing = (cone?.features || []).find((f: any) => f?.geometry?.type === 'Polygon')?.geometry.coordinates[0];
  const coneLatLon = coneRing ? toLatLonRing(coneRing, MAX_CONE_POINTS) : undefined;
  return {
    id: nhcId(String(storm?.id || '')),
    name: String(storm?.name || ''),
    category: nhcCategory(storm?.classification),
    alert: '',
    lat: Number(storm?.latitudeNumeric),
    lon: Number(storm?.longitudeNumeric),
    asOf,
    source: 'NHC',
    track: [...pastTrack, ...forecastTrack].sort((a, b) => a.time.localeCompare(b.time)),
    cone: coneLatLon && coneLatLon.length >= 3 ? coneLatLon : undefined,
    report: storm?.publicAdvisory?.url || undefined,
    peakWindKmh: winds.length ? ktToKmh(Math.max(...winds)) : undefined,
  };
}

/**
 * NHC storms replace the same storm from GDACS (same name, within 6 degrees), keeping GDACS's
 * impact alert; NHC storms GDACS does not list yet are added.
 */
export function mergeNhc(gdacs: Cyclone[], nhc: Cyclone[]): Cyclone[] {
  const used = new Set<Cyclone>();
  const merged = gdacs.map((g) => {
    const n = nhc.find((s) => !used.has(s) && s.name.toLowerCase() === g.name.toLowerCase() && Math.abs(s.lat - g.lat) < 6 && Math.abs(s.lon - g.lon) < 6);
    if (!n) return g;
    used.add(n);
    return { ...n, id: g.id, alert: g.alert, peakWindKmh: Math.max(n.peakWindKmh ?? 0, g.peakWindKmh ?? 0) || undefined };
  });
  return [...merged, ...nhc.filter((s) => !used.has(s))];
}

async function nhcLayers(env: Env): Promise<Record<string, number> | null> {
  if (env.LORE_KV) {
    const cached = await env.LORE_KV.get(NHC_LAYERS_KEY, { type: 'json' });
    if (cached) return cached as Record<string, number>;
  }
  const ids = nhcLayerIds(await getJson(`${NHC_MAP}?f=json`));
  if (!Object.keys(ids).length) return null;
  if (env.LORE_KV) await env.LORE_KV.put(NHC_LAYERS_KEY, JSON.stringify(ids), { expirationTtl: 24 * 60 * 60 });
  return ids;
}

/** Current NHC storms, or null when NHC could not be read (GDACS then stands alone). */
async function nhcStorms(env: Env): Promise<Cyclone[] | null> {
  const current = await getJson(NHC_STORMS_URL);
  if (!current) return null;
  const active: any[] = (Array.isArray(current.activeStorms) ? current.activeStorms : []).slice(0, MAX_NHC_STORMS);
  if (!active.length) return [];
  const ids = await nhcLayers(env);
  if (!ids) return null;
  const query = (name: string) => (ids[name] === undefined ? Promise.resolve(null) : getJson(`${NHC_MAP}/${ids[name]}/query?where=1%3D1&outFields=*&f=geojson`));
  return Promise.all(
    active.map(async (s) => {
      const bin = String(s.binNumber || '');
      const [cone, forecast, past] = await Promise.all([query(`${bin} Forecast Cone`), query(`${bin} Forecast Points`), query(`${bin} Past Points`)]);
      return parseNhcStorm(s, cone, forecast, past);
    })
  );
}

/** Current tropical cyclones from the GDACS event list. */
export function currentStorms(events: any): any[] {
  return (events?.features || []).filter(
    (f: any) => f?.properties?.eventtype === 'TC' && String(f.properties.iscurrent) === 'true' && f.geometry?.type === 'Point'
  );
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

  const [events, nhc] = await Promise.all([getJson(EVENTS_URL), nhcStorms(context.env).catch(() => null)]);
  if (!events && !nhc) return json({ available: false, storms: [] });

  const list = currentStorms(events).slice(0, MAX_STORMS);
  const geometries = await Promise.all(list.map((e) => (e.properties?.url?.geometry ? getJson(e.properties.url.geometry) : null)));
  // A storm whose geometry fails still gets a position marker.
  const gdacs = list.map((e, i) => parseStorm(e, geometries[i]));
  const storms = mergeNhc(gdacs, nhc || []);

  const result = { available: true, storms };
  // Only cache when both sources answered, so an outage does not stick for half an hour.
  if (events && nhc && context.env.LORE_KV) {
    await context.env.LORE_KV.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  }
  return json(result);
};
