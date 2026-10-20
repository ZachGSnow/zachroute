// Builds the route data the app uses:
//   src/data/connections.json  { ORIGIN: [DEST, ...] }  every known nonstop pair
//   src/data/carriers.json     { meta, routes: { ORIGIN: { DEST: "DL,UA*" } } }  airlines per US route
//
// Sources, in priority order:
//   1. src/data/us-routes.json   current US domestic routes + airlines (scripts/build_us_routes.js, DOT/BTS)
//   2. src/data/us-intl-routes.json   current nonstops between US and foreign airports + airlines
//      (scripts/build_t100.js, DOT/BTS T-100 all carriers)
//   3. scripts/route_overrides.json   hand-kept additions / removals
//   4. OpenFlights routes.dat   everything else (between two foreign airports). That file has not
//      been updated since 2017, so it is only used where no better source exists: a pair with a US
//      airport at either end is taken from sources 1 to 3 only.
//
// Usage: node scripts/etl_ourairports.js && node scripts/build_us_routes.js && node scripts/build_connections.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { currentIata } from '../shared/iataRenames.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'src', 'data', 'connections.json');
const CARRIERS_PATH = path.join(ROOT, 'src', 'data', 'carriers.json');
const US_ROUTES_PATH = path.join(ROOT, 'src', 'data', 'us-routes.json');
const US_INTL_PATH = path.join(ROOT, 'src', 'data', 'us-intl-routes.json');
const OVERRIDES_PATH = path.join(__dirname, 'route_overrides.json');
const AIRPORTS_PATH = path.join(ROOT, 'public', 'data', 'airports.json');

const ROUTES_URL = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/routes.dat';

// BTS "domestic" covers the states and US territories.
const US_COUNTRIES = new Set(['US', 'PR', 'VI', 'GU', 'MP', 'AS']);

/** IATA codes of US / territory airports from the ETL output (aliases are strings and skipped). */
export function usAirportSet(airportsData) {
  const set = new Set();
  for (const key of Object.keys(airportsData)) {
    const a = airportsData[key];
    if (a && typeof a === 'object' && a.iata && US_COUNTRIES.has(a.country)) set.add(a.iata);
  }
  return set;
}

/**
 * Merges the three route sources. Pure (no I/O) so it can be tested against real samples.
 * @param {object} input
 * @param {string[]} input.routeLines  OpenFlights routes.dat lines
 * @param {object|null} input.usRoutes  contents of us-routes.json, or null
 * @param {object|null} [input.usIntlRoutes]  contents of us-intl-routes.json, or null
 * @param {object|null} input.overrides contents of route_overrides.json, or null
 * @param {Set<string>} input.usAirports IATA codes treated as US
 */
export function mergeRoutes({ routeLines, usRoutes, usIntlRoutes = null, overrides, usAirports }) {
  const connections = {};
  const add = (a, b) => {
    if (!a || !b || a === b) return;
    if (!connections[a]) connections[a] = new Set();
    connections[a].add(b);
  };
  const isUsPair = (a, b) => usAirports.has(a) && usAirports.has(b);
  // With T-100 data, a pair with a US airport at one end is known better than OpenFlights knows it.
  const isUsIntl = (a, b) => !!usIntlRoutes && usAirports.has(a) !== usAirports.has(b);

  let skippedUs = 0;
  let skippedIntl = 0;
  for (const line of routeLines) {
    // Format: Airline,AirlineID,Source,SourceID,Dest,DestID,Codeshare,Stops,Equipment
    const parts = line.split(',');
    if (parts.length < 6) continue;
    // OpenFlights still has codes that have since changed (PBI for DJT).
    const origin = currentIata(parts[2].toUpperCase());
    const dest = currentIata(parts[4].toUpperCase());
    if (isUsPair(origin, dest)) {
      skippedUs++;
      continue; // superseded by current BTS data below
    }
    if (isUsIntl(origin, dest)) {
      skippedIntl++;
      continue; // superseded by current T-100 data below
    }
    add(origin, dest);
  }

  // carriers[ORG][DST] = ["DL", "UA*"]
  const carriers = {};
  const setCarriers = (a, b, list) => {
    if (!carriers[a]) carriers[a] = {};
    carriers[a][b] = list;
  };

  let meta = { generated: null, months: [] };
  if (usRoutes) {
    meta = { generated: usRoutes.generated, months: usRoutes.months };
    for (const [org, dests] of Object.entries(usRoutes.routes)) {
      for (const [dst, list] of Object.entries(dests)) {
        add(org, dst);
        add(dst, org); // services run both ways; a sampled month can miss one direction
        setCarriers(org, dst, list);
        if (!(usRoutes.routes[dst] && usRoutes.routes[dst][org])) setCarriers(dst, org, list);
      }
    }
  }

  if (usIntlRoutes) {
    meta = { ...meta, intlMonths: usIntlRoutes.months, names: usIntlRoutes.names || {} };
    for (const [org, dests] of Object.entries(usIntlRoutes.routes || {})) {
      for (const [dst, list] of Object.entries(dests)) {
        add(org, dst);
        setCarriers(org, dst, list);
      }
    }
  }

  if (overrides) {
    // Hand-kept entries may use an airport's former code.
    const current = (r) => ({ ...r, from: currentIata(r.from), to: currentIata(r.to) });
    overrides = { add: (overrides.add || []).map(current), remove: (overrides.remove || []).map(current) };
    for (const r of overrides.add) {
      add(r.from, r.to);
      add(r.to, r.from);
      const list = (r.carriers || []).filter(Boolean);
      for (const [a, b] of [[r.from, r.to], [r.to, r.from]]) {
        const existing = carriers[a]?.[b] || [];
        setCarriers(a, b, Array.from(new Set([...list, ...existing])));
      }
    }
    for (const r of overrides.remove) {
      connections[r.from]?.delete(r.to);
      connections[r.to]?.delete(r.from);
      if (carriers[r.from]) delete carriers[r.from][r.to];
      if (carriers[r.to]) delete carriers[r.to][r.from];
    }
  }

  const final = {};
  for (const [code, set] of Object.entries(connections)) {
    if (set.size) final[code] = Array.from(set).sort();
  }

  const carrierRoutes = {};
  for (const [org, dests] of Object.entries(carriers)) {
    for (const [dst, list] of Object.entries(dests)) {
      if (!list.length) continue;
      if (!carrierRoutes[org]) carrierRoutes[org] = {};
      carrierRoutes[org][dst] = list.join(',');
    }
  }

  return { connections: final, carriers: { meta, routes: carrierRoutes }, skippedUs, skippedIntl };
}

async function main() {
  if (!fs.existsSync(AIRPORTS_PATH)) {
    // Without it every US pair would silently fall back to the 2017 OpenFlights data.
    throw new Error('public/data/airports.json not found. Run `node scripts/etl_ourairports.js` first.');
  }
  const usAirports = usAirportSet(JSON.parse(fs.readFileSync(AIRPORTS_PATH, 'utf8')));

  console.log('Downloading OpenFlights routes...');
  const res = await fetch(ROUTES_URL);
  if (!res.ok) throw new Error(`Failed to fetch routes: ${res.status}`);
  const routeLines = (await res.text()).trim().split('\n');

  const usRoutes = fs.existsSync(US_ROUTES_PATH) ? JSON.parse(fs.readFileSync(US_ROUTES_PATH, 'utf8')) : null;
  if (!usRoutes) console.warn('src/data/us-routes.json not found (run scripts/build_us_routes.js); no carrier data.');
  const overrides = fs.existsSync(OVERRIDES_PATH) ? JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8')) : null;
  const usIntlRoutes = fs.existsSync(US_INTL_PATH) ? JSON.parse(fs.readFileSync(US_INTL_PATH, 'utf8')) : null;
  if (!usIntlRoutes) console.warn('src/data/us-intl-routes.json not found (run scripts/build_t100.js); US-international routes fall back to OpenFlights.');

  const { connections, carriers, skippedUs, skippedIntl } = mergeRoutes({ routeLines, usRoutes, usIntlRoutes, overrides, usAirports });

  console.log(`OpenFlights: skipped ${skippedUs} US-to-US rows (replaced by BTS data) and ${skippedIntl} US-international rows (replaced by T-100)`);
  if (usRoutes) console.log(`BTS: ${Object.keys(usRoutes.routes).length} airports, months ${usRoutes.months.join(', ')}`);
  if (overrides) console.log(`Overrides: ${(overrides.add || []).length} added, ${(overrides.remove || []).length} removed`);

  fs.writeFileSync(OUT_PATH, JSON.stringify(connections));
  console.log(`Saved connections for ${Object.keys(connections).length} airports to src/data/connections.json`);
  fs.writeFileSync(CARRIERS_PATH, JSON.stringify(carriers));
  console.log(`Saved carriers for ${Object.keys(carriers.routes).length} airports to src/data/carriers.json`);
}

// Run main() only when executed directly (node scripts/x.js), not when imported by tests.
const isEntryPoint = () => !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntryPoint()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
