// Route and airport traffic from US DOT T-100 (built by scripts/build_t100.js into
// public/data/t100/): passengers, flights, how full the flights were, the airlines and aircraft, and
// the change on the year before. Covers flights touching the US only. Files load on demand.

import { airlineName, shortCarrierName } from './carriers';

export interface RouteTraffic {
  pax: number;
  paxPrev: number;
  seats: number;
  deps: number;
  /** Passengers per month, oldest first, ending at the index's last month. */
  monthly: number[];
  /** [airline code, % of passengers], biggest first, up to 5. */
  airlines: Array<[string, number]>;
  aircraft: string[];
}

export interface AirportTraffic {
  code: string;
  months: { from: string; to: string };
  total: { pax: number; paxPrev: number; seats: number; deps: number };
  monthly: number[];
  top: string[];
  routes: Record<string, RouteTraffic>;
}

interface TrafficIndex {
  months: { from: string; to: string };
  airports: Set<string>;
  airlines: Record<string, string>;
}

let index: Promise<TrafficIndex | null> | null = null;
const files = new Map<string, Promise<AirportTraffic | null>>();

function loadIndex(): Promise<TrafficIndex | null> {
  if (!index) {
    index = fetch('/data/t100/index.json')
      .then((res) => (res.ok ? res.json() : null))
      .then((j) => (j ? { months: j.months, airports: new Set<string>(j.airports || []), airlines: j.airlines || {} } : null))
      .catch(() => null);
    void index.then((i) => !i && (index = null));
  }
  return index;
}

/** The airport's traffic file, or null when it has none (no scheduled service to or from the US). */
export async function fetchAirportTraffic(code: string | undefined): Promise<AirportTraffic | null> {
  if (!code || !navigator.onLine) return null;
  const i = await loadIndex();
  if (!i || !i.airports.has(code)) return null;
  let hit = files.get(code);
  if (!hit) {
    hit = fetch(`/data/t100/${code}.json`)
      .then((res) => (res.ok ? (res.json() as Promise<AirportTraffic>) : null))
      .catch(() => null);
    files.set(code, hit);
  }
  return hit;
}

/** Airline names for traffic lines: the app's own short names first, then the US DOT name. */
export async function trafficAirlineName(code: string): Promise<string> {
  const known = airlineName(code);
  if (known !== code) return known;
  const i = await loadIndex();
  return shortCarrierName(i?.airlines[code] || code);
}

export { shortCarrierName };

/** "84.7M", "126K", "950". */
export function compactCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
  return Math.round(n).toLocaleString('en-US');
}

/** "up 6% on the year before", "down 3% ...", "about the same as ...", or '' with no earlier data. */
export function yearChange(now: number, before: number): string {
  if (before <= 0) return '';
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return 'about the same as the year before';
  return `${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}% on the year before`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2025-08" -> "Aug 2025". */
export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** The calendar month name of the busiest of the 12 months ending at `to` ("2026-07"). */
export function busiestMonth(monthly: number[], to: string): string {
  let best = 0;
  monthly.forEach((v, n) => {
    if (v > monthly[best]) best = n;
  });
  const last = Number(to.split('-')[1]) - 1;
  return MONTHS[(last - (monthly.length - 1 - best) + 1200) % 12];
}

/** Share of seats filled, in percent, or null without seats. */
export const loadFactor = (pax: number, seats: number) => (seats > 0 ? Math.round((100 * pax) / seats) : null);
