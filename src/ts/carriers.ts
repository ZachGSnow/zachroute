import carrierData from '../data/carriers.json';
import type { Airport } from './geoMath';

// Which airlines fly a US domestic route, from the U.S. DOT Bureau of Transportation
// Statistics on-time data (scripts/build_us_routes.js) plus hand-kept overrides
// (scripts/route_overrides.json). Non-US routes have no airline data.

interface CarrierFile {
  meta: { generated: string | null; months: string[] };
  routes: Record<string, Record<string, string>>;
}

const DATA = carrierData as unknown as CarrierFile;

interface CarrierInfo {
  name: string;
  /** Regional partner flying under a major airline's brand; the major isn't in the data. */
  note?: string;
}

const CARRIERS: Record<string, CarrierInfo> = {
  WN: { name: 'Southwest' },
  DL: { name: 'Delta' },
  AA: { name: 'American' },
  UA: { name: 'United' },
  AS: { name: 'Alaska' },
  B6: { name: 'JetBlue' },
  NK: { name: 'Spirit' },
  F9: { name: 'Frontier' },
  G4: { name: 'Allegiant' },
  HA: { name: 'Hawaiian' },
  SY: { name: 'Sun Country' },
  MX: { name: 'Breeze' },
  XP: { name: 'Avelo' },
  OO: { name: 'SkyWest (regional)', note: 'regional, flies for Delta, United, American and Alaska' },
  YX: { name: 'Republic (regional)', note: 'regional, flies for Delta, United and American' },
  MQ: { name: 'American Eagle', note: 'regional, flies as American Eagle' },
  OH: { name: 'American Eagle (PSA)', note: 'regional, flies as American Eagle' },
  '9E': { name: 'Endeavor (Delta Connection)', note: 'regional, flies for Delta' },
  YV: { name: 'Mesa', note: 'regional' },
  QX: { name: 'Horizon (Alaska)', note: 'regional, flies for Alaska' },
  CP: { name: 'Compass', note: 'regional' },
  G7: { name: 'GoJet', note: 'regional' },
  ZW: { name: 'Air Wisconsin', note: 'regional' },
  C5: { name: 'CommuteAir', note: 'regional, flies for United' },
};

export interface RouteCarrier {
  code: string;
  name: string;
  note?: string;
  seasonal: boolean;
}

export function carriersFor(a: Airport, b: Airport): RouteCarrier[] {
  const from = a.iata || a.icao;
  const to = b.iata || b.icao;
  const raw = DATA.routes[from]?.[to];
  if (!raw) return [];
  return raw.split(',').map((token) => {
    const seasonal = token.endsWith('*');
    const code = seasonal ? token.slice(0, -1) : token;
    const info = CARRIERS[code];
    return { code, name: info?.name || code, note: info?.note, seasonal };
  });
}

/** "United, Southwest" (seasonal ones marked). */
export function carrierNames(list: RouteCarrier[], max = 4): string {
  const shown = list.slice(0, max).map((c) => (c.seasonal ? `${c.name} (seasonal)` : c.name));
  const more = list.length > max ? ` +${list.length - max}` : '';
  return shown.join(', ') + more;
}

/** Where the airline data comes from, for tooltips and footnotes. */
export function carrierDataNote(): string {
  const months = DATA.meta.months;
  if (months.length === 0) return 'Airline data: U.S. DOT';
  return `Airline data: U.S. DOT schedules sampled ${months[months.length - 1].replace('_', '/')} to ${months[0].replace('_', '/')}`;
}
