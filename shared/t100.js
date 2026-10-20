// BTS T-100 Segment (All Carriers): monthly flights, seats and passengers for every flight that
// touches the US, by US and foreign airlines. Pure functions shared by scripts/build_t100.js and
// its tests: CSV rows -> per-airport traffic summaries and the list of US-international nonstops.
// Public domain (US DOT Bureau of Transportation Statistics).

import { currentIata } from './iataRenames.js';

/**
 * Scheduled passenger service (class F) only. Class L is non-scheduled (charter) passenger service:
 * tour charters, sports teams and immigration removal flights, which nobody can book; G and P are
 * freight.
 */
export const SERVICE_CLASSES = new Set(['F']);
export const TOP_AIRLINES = 5;
export const TOP_AIRCRAFT = 3;
export const TOP_ROUTES = 5;
/** A nonstop counts as current when it had at least this many flights in one month (about twice a week). */
export const MIN_MONTHLY_FLIGHTS = 8;
/** Routes with fewer passengers a year are counted in airport totals but not listed (air taxis, one-offs). */
export const MIN_ROUTE_PAX = 1000;

/** One CSV line -> fields, honouring quotes. */
export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * T-100 CSV text -> scheduled-service rows {origin, dest, carrier, aircraft, deps, seats, pax, year,
 * month}, plus originCountry and destCountry when the file has those columns.
 */
export function parseT100(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const head = parseCsvLine(lines[0]);
  const at = (name) => head.indexOf(name);
  const i = {
    deps: at('DEPARTURES_PERFORMED'),
    seats: at('SEATS'),
    pax: at('PASSENGERS'),
    carrier: at('UNIQUE_CARRIER'),
    origin: at('ORIGIN'),
    dest: at('DEST'),
    aircraft: at('AIRCRAFT_TYPE'),
    year: at('YEAR'),
    month: at('MONTH'),
    cls: at('CLASS'),
  };
  if (Object.values(i).some((n) => n < 0)) throw new Error(`T-100 CSV is missing columns: ${head.join(',')}`);
  const oc = at('ORIGIN_COUNTRY');
  const dc = at('DEST_COUNTRY');
  const rows = [];
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    if (!SERVICE_CLASSES.has(c[i.cls])) continue;
    const deps = Number(c[i.deps]) || 0;
    const pax = Number(c[i.pax]) || 0;
    if (!deps && !pax) continue;
    if (!c[i.origin] || !c[i.dest] || c[i.origin] === c[i.dest]) continue;
    rows.push({
      // Months before an airport's code change report the old code (PBI for DJT); both add up
      // to the current one.
      origin: currentIata(c[i.origin]),
      dest: currentIata(c[i.dest]),
      carrier: c[i.carrier],
      aircraft: c[i.aircraft],
      deps,
      seats: Number(c[i.seats]) || 0,
      pax,
      year: Number(c[i.year]),
      month: Number(c[i.month]),
      ...(oc >= 0 && dc >= 0 ? { originCountry: c[oc], destCountry: c[dc] } : {}),
    });
  }
  return rows;
}

/** Countries BTS counts as domestic: the states and US territories. */
export const US_COUNTRIES = new Set(['US', 'PR', 'VI', 'GU', 'MP', 'AS']);

/**
 * A "is this airport in the US" test from the rows' own country columns, so US airports without an
 * IATA code (Alaska's seaplane bases use FAA codes like 7AK) are not mistaken for foreign ones.
 * Airports the rows give no country for fall back to `fallback`.
 */
export function usTestFromRows(rows, fallback = () => false) {
  const country = new Map();
  for (const r of rows) {
    if (r.originCountry) country.set(r.origin, r.originCountry);
    if (r.destCountry) country.set(r.dest, r.destCountry);
  }
  return (code) => (country.has(code) ? US_COUNTRIES.has(country.get(code)) : fallback(code));
}

/** "2026-07" for a year and month. */
export const monthKey = (year, month) => `${year}-${String(month).padStart(2, '0')}`;

/** The 12 month keys ending at `latest` ("2026-07"), oldest first, and the 12 before them. */
export function windows(latest) {
  const [y, m] = latest.split('-').map(Number);
  const keys = Array.from({ length: 24 }, (_, k) => {
    const d = new Date(Date.UTC(y, m - 1 - (23 - k), 1));
    return monthKey(d.getUTCFullYear(), d.getUTCMonth() + 1);
  });
  return { prev: keys.slice(0, 12), last: keys.slice(12) };
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function blankPair() {
  return { pax: 0, paxPrev: 0, seats: 0, deps: 0, monthly: new Array(12).fill(0), airlines: new Map(), aircraft: new Map(), monthlyDeps: new Map() };
}

/**
 * Rows from 24 months -> per-pair totals for the last 12 months (both directions together), the
 * passengers in the 12 before, monthly passengers, airline and aircraft mixes, and flights per month.
 */
export function aggregatePairs(rows, latest) {
  const { prev, last } = windows(latest);
  const lastIdx = new Map(last.map((k, n) => [k, n]));
  const prevSet = new Set(prev);
  const pairs = new Map();
  for (const r of rows) {
    const key = monthKey(r.year, r.month);
    const inLast = lastIdx.has(key);
    if (!inLast && !prevSet.has(key)) continue;
    const pk = pairKey(r.origin, r.dest);
    let p = pairs.get(pk);
    if (!p) pairs.set(pk, (p = blankPair()));
    if (!inLast) {
      p.paxPrev += r.pax;
      continue;
    }
    p.pax += r.pax;
    p.seats += r.seats;
    p.deps += r.deps;
    p.monthly[lastIdx.get(key)] += r.pax;
    p.airlines.set(r.carrier, (p.airlines.get(r.carrier) || 0) + r.pax);
    p.aircraft.set(r.aircraft, (p.aircraft.get(r.aircraft) || 0) + r.deps);
    // flights per month per direction and carrier, to tell a current nonstop from a one-off
    const dk = `${r.origin}>${r.dest}|${r.carrier}|${key}`;
    p.monthlyDeps.set(dk, (p.monthlyDeps.get(dk) || 0) + r.deps);
  }
  return pairs;
}

/**
 * BTS aircraft names, tidied: "Airbus Industrie A320-100/200" -> "Airbus A320-100/200",
 * "A220-300 BD-500-1A11" -> "Airbus A220-300", "Airbus 350-1000" -> "Airbus A350-1000",
 * "B787-900 Dreamliner" -> "Boeing 787-900 Dreamliner".
 */
export function aircraftLabel(code, names) {
  const n = names[code];
  if (!n) return `type ${code}`;
  return n
    .replace(/Airbus Industrie/i, 'Airbus')
    .replace(/\s+BD-\S+$/, '')
    .replace(/^A(\d{3})/, 'Airbus A$1')
    .replace(/^Airbus (\d{3})/, 'Airbus A$1')
    .replace(/^B(7\d7)/, 'Boeing $1')
    .replace(/\s+/g, ' ')
    .trim();
}

const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

/** One pair's summary as stored for the app. */
export function pairSummary(p, aircraftNames) {
  const totalPax = p.pax || 1;
  return {
    pax: Math.round(p.pax),
    paxPrev: Math.round(p.paxPrev),
    seats: Math.round(p.seats),
    deps: Math.round(p.deps),
    monthly: p.monthly.map(Math.round),
    airlines: top(p.airlines, TOP_AIRLINES).map(([c, v]) => [c, Math.round((100 * v) / totalPax)]),
    aircraft: top(p.aircraft, TOP_AIRCRAFT).map(([c]) => aircraftLabel(c, aircraftNames)),
  };
}

/**
 * Per-airport files: the airport's totals (passengers on and off), monthly passengers, its busiest
 * routes, and the summary of every route with at least 1,000 passengers in the last 12 months.
 * Airports with no such route get no file.
 */
export function airportFiles(pairs, latest, aircraftNames) {
  const { last } = windows(latest);
  const files = new Map();
  const file = (code) => {
    let f = files.get(code);
    if (!f) files.set(code, (f = { code, months: { from: last[0], to: last[11] }, total: { pax: 0, paxPrev: 0, seats: 0, deps: 0 }, monthly: new Array(12).fill(0), routes: {} }));
    return f;
  };
  for (const [pk, p] of pairs) {
    if (p.pax <= 0) continue;
    const [a, b] = pk.split('|');
    const s = pairSummary(p, aircraftNames);
    for (const [here, there] of [
      [a, b],
      [b, a],
    ]) {
      const f = file(here);
      if (s.pax >= MIN_ROUTE_PAX) f.routes[there] = s;
      f.total.pax += s.pax;
      f.total.paxPrev += s.paxPrev;
      f.total.seats += s.seats;
      f.total.deps += s.deps;
      s.monthly.forEach((v, n) => (f.monthly[n] += v));
    }
  }
  for (const [code, f] of files) {
    if (!Object.keys(f.routes).length) {
      files.delete(code);
      continue;
    }
    f.top = Object.entries(f.routes)
      .sort((x, y) => y[1].pax - x[1].pax)
      .slice(0, TOP_ROUTES)
      .map(([code]) => code);
  }
  return files;
}

/**
 * Current nonstops between a US airport and a foreign one, with the airlines flying them: a
 * direction and airline count when it had at least 8 flights in some month of the last 12.
 * Returns { ORG: { DST: [carriers] } } for both directions.
 */
export function internationalNonstops(pairs, isUs) {
  const out = {};
  const add = (a, b, carrier) => {
    const list = ((out[a] ||= {})[b] ||= []);
    if (!list.includes(carrier)) list.push(carrier);
  };
  for (const [pk, p] of pairs) {
    const [a, b] = pk.split('|');
    if (isUs(a) === isUs(b)) continue;
    for (const [dk, n] of p.monthlyDeps) {
      if (n < MIN_MONTHLY_FLIGHTS) continue;
      const [dir, carrier] = dk.split('|');
      const [o, d] = dir.split('>');
      add(o, d, carrier);
      add(d, o, carrier);
    }
  }
  for (const dests of Object.values(out)) for (const list of Object.values(dests)) list.sort();
  return out;
}
