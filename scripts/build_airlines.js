// Builds src/data/airline-icao.json: airline names by ICAO code for Live track, from OpenFlights
// airlines.dat (ODbL 1.0) plus corrections (shared/airlines.js). Run with `npm run etl:airlines`
// (also part of `npm run data`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { airlinesByIcao } from '../shared/airlines.js';

const AIRLINES_URL = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'airline-icao.json');

async function main() {
  const res = await fetch(AIRLINES_URL);
  if (!res.ok) throw new Error(`airlines.dat: HTTP ${res.status}`);
  const table = airlinesByIcao(await res.text());
  const json = JSON.stringify(table);
  // Keep the file ASCII so it reads the same everywhere.
  const ascii = json.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  fs.writeFileSync(OUT, `${ascii}\n`);
  console.log(`airline-icao.json: ${Object.keys(table).length} airlines, ${(ascii.length / 1024).toFixed(0)} KB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
