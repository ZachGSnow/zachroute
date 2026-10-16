import connectionsData from '../data/connections.json';
import type { Airport } from './geoMath';
import { haversineDistance, blockTimeMiles } from './geoMath';
import { resolveCode } from './searchParser';

const connections = connectionsData as Record<string, string[]>;

/** Hard cap so a mega-hub pair (e.g. ORD -> LHR) doesn't paint the whole map purple. */
export const MAX_VIA_ROUTES = 24;
export const MAX_TWO_STOP_LIST = 12;
export const MAX_TWO_STOP_DRAW = 8;

export type ConnectingDepth = 'one-stop' | 'two-stop' | 'none';

export interface ViaOption {
  /** Stable id: `"ATL"` or `"ATL-LAX"`. */
  key: string;
  hubs: Airport[];
  viaMiles: number;
  directMiles: number;
  detourRatio: number;
  blockMinutes: number;
}

export interface ViaSearchResult {
  depth: ConnectingDepth;
  options: ViaOption[];
  totalFound: number;
  /** How many of `options` to draw on the map initially (1-stop: all; 2-stop: draw cap). */
  drawLimit: number;
}

const destSetCache = new Map<string, Set<string>>();

export function destinationCodesFor(airport: Airport): string[] {
  return connections[airport.iata] || connections[airport.icao] || [];
}

function destSetFor(airport: Airport): Set<string> {
  const id = airport.iata || airport.icao;
  let cached = destSetCache.get(id);
  if (!cached) {
    cached = new Set(destinationCodesFor(airport));
    destSetCache.set(id, cached);
  }
  return cached;
}

function codesMatch(airport: Airport, code: string): boolean {
  const upper = code.toUpperCase();
  return airport.iata === upper || airport.icao === upper;
}

export function airportCode(airport: Airport): string {
  return airport.iata || airport.icao;
}

export function isKnownDirect(origin: Airport, destination: Airport): boolean {
  const dests = destSetFor(origin);
  return (!!destination.iata && dests.has(destination.iata)) || (!!destination.icao && dests.has(destination.icao));
}

function fliesTo(from: Airport, to: Airport): boolean {
  const dests = destSetFor(from);
  return (!!to.iata && dests.has(to.iata)) || (!!to.icao && dests.has(to.icao));
}

function typeRank(type: string | undefined): number {
  if (type === 'large_airport') return 0;
  if (type === 'medium_airport') return 1;
  if (type === 'regional') return 2;
  return 3;
}

function hubsTypeRank(hubs: Airport[]): number {
  return Math.min(...hubs.map((hub) => typeRank(hub.type)));
}

function compareVia(a: ViaOption, b: ViaOption): number {
  if (a.detourRatio !== b.detourRatio) return a.detourRatio - b.detourRatio;
  const typeDiff = hubsTypeRank(a.hubs) - hubsTypeRank(b.hubs);
  if (typeDiff !== 0) return typeDiff;
  return a.key.localeCompare(b.key);
}

function buildViaOption(origin: Airport, destination: Airport, hubs: Airport[]): ViaOption {
  const points = [origin, ...hubs, destination];
  let viaMiles = 0;
  let blockMinutes = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const leg = haversineDistance(points[i], points[i + 1]);
    viaMiles += leg;
    blockMinutes += blockTimeMiles(leg);
  }
  const directMiles = haversineDistance(origin, destination);
  return {
    key: hubs.map(airportCode).join('-'),
    hubs,
    viaMiles,
    directMiles,
    detourRatio: directMiles > 0 ? viaMiles / directMiles : 1,
    blockMinutes,
  };
}

export function oneStopOptions(origin: Airport, destination: Airport): ViaSearchResult {
  const seen = new Set<string>();
  const found: ViaOption[] = [];

  for (const code of destinationCodesFor(origin)) {
    const hub = resolveCode(code);
    if (!hub) continue;

    const hubKey = airportCode(hub);
    if (!hubKey || seen.has(hubKey)) continue;
    if (codesMatch(origin, hubKey) || codesMatch(destination, hubKey)) continue;
    if (!fliesTo(hub, destination)) continue;
    seen.add(hubKey);
    found.push(buildViaOption(origin, destination, [hub]));
  }

  found.sort(compareVia);
  const options = found.slice(0, MAX_VIA_ROUTES);
  return {
    depth: options.length > 0 ? 'one-stop' : 'none',
    options,
    totalFound: found.length,
    drawLimit: options.length,
  };
}

export function twoStopOptions(origin: Airport, destination: Airport): ViaSearchResult {
  const seen = new Set<string>();
  const found: ViaOption[] = [];

  for (const h1Code of destinationCodesFor(origin)) {
    const h1 = resolveCode(h1Code);
    if (!h1) continue;
    const h1Key = airportCode(h1);
    if (!h1Key || codesMatch(origin, h1Key) || codesMatch(destination, h1Key)) continue;

    for (const h2Code of destinationCodesFor(h1)) {
      const h2 = resolveCode(h2Code);
      if (!h2) continue;
      const h2Key = airportCode(h2);
      if (!h2Key || h2Key === h1Key) continue;
      if (codesMatch(origin, h2Key) || codesMatch(destination, h2Key)) continue;

      const pairKey = `${h1Key}-${h2Key}`;
      if (seen.has(pairKey)) continue;
      if (!fliesTo(h2, destination)) continue;
      seen.add(pairKey);
      found.push(buildViaOption(origin, destination, [h1, h2]));
    }
  }

  found.sort(compareVia);
  const options = found.slice(0, MAX_TWO_STOP_LIST);
  return {
    depth: options.length > 0 ? 'two-stop' : 'none',
    options,
    totalFound: found.length,
    drawLimit: Math.min(MAX_TWO_STOP_DRAW, options.length),
  };
}

/** Fewest hops that exist: 1-stop, else 2-stop, else empty (3+ is a UI note only). */
export function findConnectingRoutes(origin: Airport, destination: Airport): ViaSearchResult {
  const one = oneStopOptions(origin, destination);
  if (one.totalFound > 0) return one;
  return twoStopOptions(origin, destination);
}
