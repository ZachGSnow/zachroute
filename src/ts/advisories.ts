import { nwsFocus, type FocusTarget } from './focusTarget';
import { severityBadge } from './severityBadge';
import type { Airport } from './geoMath';
import { formatDistance } from './units';
import { haversineDistanceLatLon, bearingBetween } from './geoMath';
import { compassPoint } from './forecast';
import { summarizePirep, pirepAgeLabel, pirepAltitudeLabel, type RawPirep } from './pirepText';
import type { Severity } from './severity';

// ---------------------------------------------------------------------------
// FAA delay programs (US only), via /api/faa-status
// ---------------------------------------------------------------------------

interface FaaAirportStatus {
  groundStop?: { reason?: string; endTime?: string };
  groundDelay?: { reason?: string; avg?: string; max?: string };
  delay?: { reason?: string; type?: string; min?: string; max?: string; trend?: string };
}

interface FaaStatusResponse {
  available: boolean;
  airports: Record<string, FaaAirportStatus>;
}

let faaCache: { at: number; data: Promise<FaaStatusResponse> } | null = null;
const FAA_CACHE_MS = 5 * 60 * 1000;

function fetchFaaStatus(): Promise<FaaStatusResponse> {
  if (faaCache && Date.now() - faaCache.at < FAA_CACHE_MS) return faaCache.data;
  const data = (async (): Promise<FaaStatusResponse> => {
    if (!navigator.onLine) return { available: false, airports: {} };
    try {
      const res = await fetch('/api/faa-status');
      if (!res.ok) return { available: false, airports: {} };
      return (await res.json()) as FaaStatusResponse;
    } catch {
      return { available: false, airports: {} };
    }
  })();
  faaCache = { at: Date.now(), data };
  return data;
}

function tidyReason(reason?: string): string {
  if (!reason) return '';
  // Delay reasons look like "WX:Low Ceilings" or "RWY:Construction"
  const cleaned = reason.includes(':') ? reason.split(':')[1] : reason;
  return cleaned.trim().toLowerCase();
}

export interface Chip {
  level: 'info' | 'warn' | 'alert';
  text: string;
  title?: string;
  /** Light to Extreme, where the source grades it (FAA delays do not). */
  severity?: Severity;
  /** What a tap shows on the map; FAA delays have nothing to show. */
  focus?: FocusTarget;
}

/** "4 alerts" with the worst severity among them, for the folded alerts header. */
export function alertsSummary(chips: Chip[]): string {
  const graded = chips.map((c) => c.severity).filter((s): s is Severity => s != null);
  const worst = graded.length ? (Math.max(...graded) as Severity) : null;
  const n = chips.length;
  return `\u26a0\ufe0f ${n} alert${n === 1 ? '' : 's'}${worst ? ` ${severityBadge(worst)}` : ''}`;
}

/** Delay / ground-stop chips for a US airport. Empty when everything is normal or unavailable. */
export async function faaDelayChips(airport: Airport): Promise<Chip[]> {
  if (airport.country !== 'US' || !airport.iata) return [];
  const status = await fetchFaaStatus();
  if (!status.available) return [];
  const s = status.airports[airport.iata];
  if (!s) return [];

  const chips: Chip[] = [];
  if (s.groundStop) {
    const why = tidyReason(s.groundStop.reason);
    chips.push({
      level: 'alert',
      text: `Ground stop${why ? ` (${why})` : ''}`,
      title: s.groundStop.endTime ? `Until ${s.groundStop.endTime}` : undefined,
    });
  }
  if (s.groundDelay) {
    const why = tidyReason(s.groundDelay.reason);
    const avg = s.groundDelay.avg ? `avg ${s.groundDelay.avg}` : '';
    chips.push({
      level: 'warn',
      text: `Ground delay program${avg ? `, ${avg}` : ''}${why ? ` (${why})` : ''}`,
      title: s.groundDelay.max ? `Longest delay: ${s.groundDelay.max}` : undefined,
    });
  }
  if (s.delay) {
    const why = tidyReason(s.delay.reason);
    const kind = s.delay.type ? `${s.delay.type} delays` : 'Delays';
    const range =
      s.delay.min && s.delay.max ? `${s.delay.min.replace(' minutes', '')} to ${s.delay.max}` : s.delay.max || s.delay.min || '';
    const trend = s.delay.trend ? `, ${s.delay.trend.toLowerCase()}` : '';
    chips.push({
      level: 'warn',
      text: `${kind}${range ? ` ${range}` : ''}${trend}${why ? ` (${why})` : ''}`,
    });
  }
  return chips;
}

// ---------------------------------------------------------------------------
// NWS alerts (US only), straight from api.weather.gov (CORS-enabled, no key)
// ---------------------------------------------------------------------------

interface NwsAlert {
  event: string;
  severity: string;
  headline: string;
  expires?: string;
  focus: FocusTarget;
}

const nwsCache = new Map<string, { at: number; data: Promise<NwsAlert[]> }>();
const NWS_CACHE_MS = 5 * 60 * 1000;

function fetchNwsAlerts(lat: number, lon: number): Promise<NwsAlert[]> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = nwsCache.get(key);
  if (hit && Date.now() - hit.at < NWS_CACHE_MS) return hit.data;

  const data = (async (): Promise<NwsAlert[]> => {
    if (!navigator.onLine) return [];
    try {
      const res = await fetch(`https://api.weather.gov/alerts/active?status=actual&point=${lat.toFixed(4)},${lon.toFixed(4)}`, {
        headers: { Accept: 'application/geo+json' },
      });
      if (!res.ok) return [];
      const json = await res.json();
      return (json.features || []).map((f: any) => ({
        event: f.properties?.event || 'Weather alert',
        severity: f.properties?.severity || 'Unknown',
        headline: f.properties?.headline || f.properties?.event || '',
        expires: f.properties?.expires,
        focus: nwsFocus(f, [lat, lon]),
      }));
    } catch {
      return [];
    }
  })();
  nwsCache.set(key, { at: Date.now(), data });
  return data;
}

const NWS_SEVERITY: Record<string, Severity> = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };

const SEVERITY_LEVEL: Record<string, Chip['level']> = {
  Extreme: 'alert',
  Severe: 'alert',
  Moderate: 'warn',
  Minor: 'info',
  Unknown: 'info',
};

export async function nwsAlertChips(airport: Airport): Promise<Chip[]> {
  if (airport.country !== 'US') return [];
  const alerts = await fetchNwsAlerts(airport.lat, airport.lon);
  const order: Record<string, number> = { alert: 0, warn: 1, info: 2 };
  return alerts
    .map((a): Chip => ({ level: SEVERITY_LEVEL[a.severity] || 'info', text: a.event, title: a.headline, severity: NWS_SEVERITY[a.severity], focus: a.focus }))
    .sort((a, b) => order[a.level] - order[b.level])
    .slice(0, 4);
}

// ---------------------------------------------------------------------------
// Pilot reports (turbulence / icing), via /api/pireps
// ---------------------------------------------------------------------------

export interface PirepLine {
  text: string;
  severe: boolean;
  severity: Severity | null;
  focus: FocusTarget;
}

/** Notable recent pilot reports within ~75nm, in plain English. */
export async function fetchPirepLines(airport: Airport): Promise<PirepLine[]> {
  if (!airport.icao || !navigator.onLine) return [];
  try {
    const res = await fetch(`/api/pireps?icao=${airport.icao}`);
    if (!res.ok) return [];
    const json = await res.json();
    const reports: RawPirep[] = json.reports || [];

    const lines: PirepLine[] = [];
    for (const p of reports) {
      const summary = summarizePirep(p);
      if (!summary) continue;

      const miles = Math.round(haversineDistanceLatLon(airport.lat, airport.lon, p.lat, p.lon));
      const dir = compassPoint(bearingBetween(airport.lat, airport.lon, p.lat, p.lon));
      const where = miles < 3 ? 'at the airport' : `${formatDistance(miles)} ${dir} of here`;
      const meta = [pirepAltitudeLabel(p), where, p.acType, pirepAgeLabel(p.obsTime)].filter(Boolean).join(' - ');
      const focus: FocusTarget = { title: `${summary.headline} (${meta})`, shapes: [], points: [[p.lat, p.lon]] };
      lines.push({ text: `${summary.headline} <span class="muted">(${meta})</span>`, severe: summary.severe, severity: summary.severity, focus });
    }
    // Worst first; the feed's own order (newest first) breaks ties.
    return lines.map((l, i) => ({ l, i })).sort((a, b) => (b.l.severity ?? 0) - (a.l.severity ?? 0) || a.i - b.i).map((x) => x.l).slice(0, 8);
  } catch {
    return [];
  }
}
