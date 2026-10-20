// Airline names by ICAO code (the 3 letters that start an airline callsign: DAL1234 is Delta 1234),
// for Live track. Built from OpenFlights airlines.dat (ODbL 1.0) by scripts/build_airlines.js into
// src/data/airline-icao.json. OpenFlights stopped updating in 2017, so its "active" flag is stale
// (it lists UPS and FedEx as inactive) and newer airlines are missing: codes are kept when marked
// active or when they have an IATA code, and CORRECTIONS fixes and adds current carriers.

/** Current names that OpenFlights lacks or has wrong, by ICAO code: [name, IATA]. */
export const CORRECTIONS = {
  UPS: ['UPS', '5X'],
  FDX: ['FedEx', 'FX'],
  ABX: ['ABX Air', 'GB'],
  ATN: ['Air Transport International', '8C'],
  GTI: ['Atlas Air', '5Y'],
  MXY: ['Breeze Airways', 'MX'],
  VXP: ['Avelo Airlines', 'XP'],
  EDV: ['Endeavor Air', '9E'],
  JIA: ['PSA Airlines', 'OH'],
  PDT: ['Piedmont Airlines', 'PT'],
  ENY: ['Envoy Air', 'MQ'],
  JSX: ['JSX', 'XE'],
  LXJ: ['Flexjet', ''],
  EJA: ['NetJets', '1I'],
  KAP: ['Cape Air', '9K'],
  AWI: ['Air Wisconsin', 'ZW'],
  CJT: ['Cargojet', 'W8'],
  SKW: ['SkyWest Airlines', 'OO'],
  RPA: ['Republic Airways', 'YX'],
  ASH: ['Mesa Airlines', 'YV'],
  QXE: ['Horizon Air', 'QX'],
};

/** Splits one airlines.dat line (CSV with quoted fields and \N for empty). */
function fields(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((f) => (f === '\\N' ? '' : f));
}

const usableIata = (v) => (/^[A-Z0-9]{2}$/.test(v || '') ? v : '');

/**
 * { ICAO: [name, IATA] } from airlines.dat text (columns: id, name, alias, IATA, ICAO, callsign,
 * country, active). Where a code appears more than once, an active row with an IATA code wins.
 * @param {string} text
 * @returns {Record<string, [string, string]>}
 */
export function airlinesByIcao(text) {
  const best = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = fields(line);
    if (f.length < 8) continue;
    const icao = f[4];
    if (!/^[A-Z]{3}$/.test(icao)) continue;
    const iata = usableIata(f[3]);
    const active = f[7] === 'Y';
    if (!active && !iata) continue;
    const score = (active ? 2 : 0) + (iata ? 1 : 0);
    const prev = best.get(icao);
    if (!prev || score > prev.score) best.set(icao, { score, entry: [f[1].trim(), iata] });
  }
  const out = {};
  for (const [icao, { entry }] of [...best.entries()].sort(([a], [b]) => a.localeCompare(b))) out[icao] = entry;
  for (const [icao, entry] of Object.entries(CORRECTIONS)) out[icao] = entry;
  return out;
}
