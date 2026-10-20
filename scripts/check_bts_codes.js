// Lists airport codes in the US DOT (BTS) data that do not match the IATA codes the OurAirports
// ETL produced, so a code change like PBI -> DJT shows up before it hides an airport's routes and
// traffic. Compares the origins and destinations in src/data/us-routes.json and the airports in
// public/data/t100/index.json with public/data/airports.json. Read only; exits 1 on a mismatch.
//
// Usage: node scripts/check_bts_codes.js   (after npm run data)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AIRPORTS_PATH = path.join(ROOT, 'public', 'data', 'airports.json');
const US_ROUTES_PATH = path.join(ROOT, 'src', 'data', 'us-routes.json');
const T100_INDEX_PATH = path.join(ROOT, 'public', 'data', 't100', 'index.json');

/** Every airport code in us-routes.json and the T-100 index, with where it was seen. */
export function btsCodes(usRoutes, t100Index) {
  const seen = new Map();
  const note = (code, source) => {
    if (!seen.has(code)) seen.set(code, new Set());
    seen.get(code).add(source);
  };
  for (const [org, dests] of Object.entries(usRoutes?.routes || {})) {
    note(org, 'us-routes');
    for (const dst of Object.keys(dests)) note(dst, 'us-routes');
  }
  for (const code of t100Index?.airports || []) note(code, 't100');
  return seen;
}

/**
 * BTS codes the app cannot match to an airport by IATA code.
 * `alias`: the code resolves, but to an airport whose IATA code is different (a code change, or a
 * code OurAirports files under ICAO or FAA LID), so data keyed by it never reaches that card.
 * `missing`: no airport has the code at all (not in the ETL output).
 */
export function codeMismatches(airports, codes) {
  const alias = [];
  const missing = [];
  for (const [code, sources] of codes) {
    let a = airports[code];
    if (typeof a === 'string') a = airports[a];
    const from = [...sources].sort().join('+');
    if (!a) missing.push({ code, from });
    else if (a.iata !== code) alias.push({ code, iata: a.iata, icao: a.icao, name: a.name, from });
  }
  const byCode = (x, y) => x.code.localeCompare(y.code);
  return { alias: alias.sort(byCode), missing: missing.sort(byCode) };
}

function main() {
  const airports = JSON.parse(fs.readFileSync(AIRPORTS_PATH, 'utf8'));
  const usRoutes = JSON.parse(fs.readFileSync(US_ROUTES_PATH, 'utf8'));
  const t100Index = fs.existsSync(T100_INDEX_PATH) ? JSON.parse(fs.readFileSync(T100_INDEX_PATH, 'utf8')) : null;
  const codes = btsCodes(usRoutes, t100Index);
  const { alias, missing } = codeMismatches(airports, codes);
  console.log(`${codes.size} BTS airport codes checked against public/data/airports.json`);
  console.log(`\nResolve to an airport with a different IATA code (${alias.length}):`);
  for (const m of alias) console.log(`  ${m.code} -> ${m.iata || '(no IATA)'} ${m.icao} ${m.name} [${m.from}]`);
  console.log(`\nNot in airports.json (${missing.length}):`);
  for (const m of missing) console.log(`  ${m.code} [${m.from}]`);
  if (alias.length || missing.length) process.exitCode = 1;
}

const isEntryPoint = () => !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntryPoint()) main();
