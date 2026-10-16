// Fetches real Wikipedia summaries for a hub airport and its nonstop destinations and saves them to seed_lore.json
// Run with: node scripts/prefetch_wiki_lore.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function fetchLore(iata) {
  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(iata + ' airport')}&format=json&origin=*`;
    const searchRes = await fetch(searchUrl, {
      headers: { 'User-Agent': USER_AGENT }
    });
    const searchJson = await searchRes.json();
    const pageTitle = searchJson.query?.search?.[0]?.title;
    if (!pageTitle) return null;

    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`;
    const summaryRes = await fetch(summaryUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': USER_AGENT
      }
    });
    if (!summaryRes.ok) return null;
    const summary = await summaryRes.json();

    return {
      lore: summary.extract || undefined,
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