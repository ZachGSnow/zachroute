// Fetches real Wikipedia summaries for a hub airport and its nonstop destinations and saves them to seed_lore.json
// Run with: node scripts/prefetch_wiki_lore.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAirportLore, titleFromWikipediaLink } from '../shared/wikiLore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'scripts', 'seed_lore.json');

// Seed set: the hub plus every airport it has a known nonstop to (src/data/connections.json,
// so run scripts/build_connections.js first). Usage: node scripts/prefetch_wiki_lore.js [HUB]
const HUB = (process.argv[2] || 'ORD').toUpperCase();
const CONNECTIONS = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'connections.json'), 'utf8'));
const SEED_AIRPORTS = [HUB, ...(CONNECTIONS[HUB] || [])];
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const USER_AGENT = `ZachRoute/${PKG.version} (${PKG.homepage})`;

// Airport details (linked article, name, position) from the ETL output when it exists, so the
// lookup can use the linked article and check search hits. Without it only the code is searched.
const AIRPORTS_PATH = path.join(ROOT, 'public', 'data', 'airports.json');
const AIRPORTS = fs.existsSync(AIRPORTS_PATH) ? JSON.parse(fs.readFileSync(AIRPORTS_PATH, 'utf8')) : {};

function airportFor(code) {
  let a = AIRPORTS[code];
  if (typeof a === 'string') a = AIRPORTS[a];
  return a && typeof a === 'object' ? a : null;
}

async function fetchLore(iata) {
  const a = airportFor(iata);
  try {
    const found = await resolveAirportLore(
      { iata, title: titleFromWikipediaLink(a?.wikipediaLink), name: a?.name, lat: a?.lat, lon: a?.lon },
      { userAgent: USER_AGENT }
    );
    if (!found) return null;
    return {
      lore: found.extract || undefined,
      type: 'regional',
      primaryOperator: undefined
    };
  } catch {
    return null;
  }
}

async function main() {
  console.log(`Fetching real Wikipedia lore for ${HUB} and its ${SEED_AIRPORTS.length - 1} nonstop destinations...`);
  const result = {};

  for (const code of SEED_AIRPORTS) {
    const data = await fetchLore(code);
    if (data && data.lore) {
      result[code] = data;
      console.log(`Saved: ${code}`);
    }
    // Polite delay to avoid rate limits
    await new Promise(r => setTimeout(r, 250));
  }

  // Non-ASCII (accents, dashes in Wikipedia text) is written as \uXXXX escapes so the file stays ASCII.
  const text = JSON.stringify(result, null, 2);
  fs.writeFileSync(OUT_PATH, text.replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
  console.log(`\nSaved real Wikipedia lore for ${Object.keys(result).length} airports into scripts/seed_lore.json`);
}

main().catch(console.error);