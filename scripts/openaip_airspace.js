// Builds world airspace outside the US from openAIP's daily per-country exports (keyless, CC BY-NC
// 4.0): restricted, danger and prohibited areas and the controlled airspace around airports and
// airways, simplified and split into 4-degree cells, written to public/data/airspace/ (generated,
// gitignored). The US comes live from the FAA instead (functions/api/airspace.ts).
//
//   node scripts/openaip_airspace.js            all countries but the US
//   node scripts/openaip_airspace.js --if-due   only when a newer AIRAC cycle has taken effect
//   node scripts/openaip_airspace.js DE FR      only these (for a quick look; not recorded)
//
// A full build records its date and AIRAC cycle in scripts/airspace-build.json (committed with the
// release) and in the index.json it writes, so `npm run airspace:due` can tell when the next one is
// needed (shared/airac.js).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { areasFrom, splitIntoCells } from '../shared/openaipAirspace.js';
import { airacCycle } from '../shared/airac.js';
import { checkDue, RECORD } from './airspace_due.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'public', 'data', 'airspace');
const BUCKET = 'https://storage.openaip.net/openaip-system-exports/';
const SKIP = new Set(['us']);
const UA = 'ZachRoute airspace build (https://github.com/ZachGSnow/zachroute)';

/** Every "<cc>_asp.geojson" in the export bucket (S3-style listing, 1,000 keys a page). */
async function countryFiles() {
  const keys = [];
  let marker = '';
  for (;;) {
    const res = await fetch(`${BUCKET}?marker=${encodeURIComponent(marker)}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`listing failed: HTTP ${res.status}`);
    const xml = await res.text();
    const page = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    keys.push(...page.filter((k) => /^[a-z]{2}_asp\.geojson$/.test(k)));
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !page.length) break;
    marker = page[page.length - 1];
  }
  return keys;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--if-due')) {
    const { due, reason } = checkDue();
    if (!due) {
      console.log(`openAIP: skipped, ${reason}`);
      return;
    }
    console.log(`openAIP: rebuilding, ${reason}`);
  }
  const only = args.filter((a) => !a.startsWith('--')).map((c) => c.toLowerCase());
  const started = Date.now();
  const files = (await countryFiles()).filter((k) => !SKIP.has(k.slice(0, 2)) && (!only.length || only.includes(k.slice(0, 2))));
  console.log(`openAIP: ${files.length} country files`);
  const areas = [];
  let downloaded = 0;
  for (const key of files) {
    const res = await fetch(BUCKET + key, { headers: { 'User-Agent': UA } });
    if (!res.ok) {
      console.warn(`  ${key}: HTTP ${res.status}, skipped`);
      continue;
    }
    const text = await res.text();
    downloaded += text.length;
    const got = areasFrom(JSON.parse(text));
    areas.push(...got);
    if (text.length > 2e6) console.log(`  ${key}: ${(text.length / 1e6).toFixed(1)} MB -> ${got.length} areas`);
  }
  const cells = splitIntoCells(areas);
  const built = new Date().toISOString().slice(0, 10);
  const cycle = airacCycle(new Date());
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let written = 0;
  for (const [cell, list] of Object.entries(cells)) {
    const body = JSON.stringify({ built, source: 'openAIP', areas: list });
    fs.writeFileSync(path.join(OUT_DIR, `${cell}.json`), body);
    written += body.length;
  }
  fs.writeFileSync(
    path.join(OUT_DIR, 'index.json'),
    JSON.stringify({ built, airac: cycle.id, source: 'openAIP', license: 'CC BY-NC 4.0', cells: Object.keys(cells).sort() })
  );
  if (!only.length) {
    const record = {
      built,
      airac: cycle.id,
      airacEffective: cycle.effective,
      nextAirac: cycle.next.id,
      nextAiracEffective: cycle.next.effective,
      countries: files.length,
      areas: areas.length,
      cells: Object.keys(cells).length,
    };
    fs.writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}
`);
    console.log(`openAIP: recorded AIRAC ${cycle.id} in scripts/airspace-build.json; next rebuild after ${cycle.next.effective} (AIRAC ${cycle.next.id})`);
  }
  console.log(
    `openAIP: ${areas.length} areas from ${(downloaded / 1e6).toFixed(0)} MB -> ${Object.keys(cells).length} cells, ` +
      `${(written / 1e6).toFixed(1)} MB, in ${((Date.now() - started) / 1000).toFixed(0)} s`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
