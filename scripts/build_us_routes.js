// Builds src/data/us-routes.json: which airlines currently fly which US domestic routes.
//
// Source: U.S. DOT Bureau of Transportation Statistics "Reporting Carrier On-Time
// Performance" monthly files (one zip of ~33 MB per month, about 3 months behind).
// They list every scheduled flight of the reporting carriers, so a route + carrier
// that operates several times a month is a real, current service. Several months from
// different seasons are combined so seasonal routes are not missed.
//
// Not covered: carriers too small to be BTS reporting carriers (e.g. Breeze, Avelo).
// Add those by hand in scripts/route_overrides.json.
//
// Usage: node scripts/build_us_routes.js [--months 2025_10,2026_1,2026_4,2026_7]
// With no --months it probes for the latest published month and also takes the
// months 3, 6 and 9 before it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'src', 'data', 'us-routes.json');
const BASE = 'https://transtats.bts.gov/PREZIP/On_Time_Reporting_Carrier_On_Time_Performance_1987_present_';

// A route + carrier must have at least this many scheduled flights in a month to count
// (about twice a week). Filters out one-off charters and ferry flights.
export const MIN_FLIGHTS_PER_MONTH = 8;

function monthKey(date) {
  return `${date.getUTCFullYear()}_${date.getUTCMonth() + 1}`;
}

function shiftMonths(date, delta) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1));
}

async function exists(key) {
  const res = await fetch(`${BASE}${key}.zip`, { method: 'HEAD' });
  return res.ok && Number(res.headers.get('content-length') || 0) > 1_000_000;
}

async function pickMonths() {
  const arg = process.argv.indexOf('--months');
  if (arg !== -1) return process.argv[arg + 1].split(',').map((m) => m.trim());

  let latest = shiftMonths(new Date(), -1);
  for (let i = 0; i < 8; i++) {
    if (await exists(monthKey(latest))) break;
    latest = shiftMonths(latest, -1);
  }
  return [0, -3, -6, -9].map((d) => monthKey(shiftMonths(latest, d)));
}

function unzip(zipPath, destDir) {
  // bsdtar (Windows, macOS) reads zips; Linux usually has unzip.
  try {
    execFileSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'ignore' });
  } catch {
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { stdio: 'ignore' });
  }
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Streams one month's CSV and returns Map("ORG-DST|CARRIER" -> flights). */
export async function countMonth(csvPath) {
  const counts = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(csvPath), crlfDelay: Infinity });
  let idx = null;
  for await (const line of rl) {
    if (!idx) {
      idx = {};
      parseCsvLine(line).forEach((h, i) => (idx[h] = i));
      for (const need of ['Origin', 'Dest', 'IATA_CODE_Reporting_Airline', 'Cancelled']) {
        if (idx[need] === undefined) throw new Error(`Column ${need} missing from ${csvPath}`);
      }
      continue;
    }
    const f = parseCsvLine(line);
    if (f[idx.Cancelled] === '1.00' || f[idx.Cancelled] === '1') continue;
    const key = `${f[idx.Origin]}-${f[idx.Dest]}|${f[idx.IATA_CODE_Reporting_Airline]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

async function main() {
  const months = await pickMonths();
  console.log('Months:', months.join(', '));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zachroute-bts-'));
  // route -> carrier -> { flights: total scheduled across months, months: how many months it qualified }
  const agg = new Map();
  const used = [];

  try {
    for (const key of months) {
      if (!(await exists(key))) {
        console.warn(`  ${key}: not published, skipping`);
        continue;
      }
      const dir = path.join(work, key);
      fs.mkdirSync(dir);
      const zipPath = path.join(dir, 'data.zip');
      console.log(`  ${key}: downloading...`);
      const res = await fetch(`${BASE}${key}.zip`);
      if (!res.ok) throw new Error(`Download failed for ${key}: ${res.status}`);
      fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
      unzip(zipPath, dir);
      const csv = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.csv'));
      if (!csv) throw new Error(`No CSV found in ${key} zip`);

      const counts = await countMonth(path.join(dir, csv));
      let kept = 0;
      for (const [k, n] of counts) {
        if (n < MIN_FLIGHTS_PER_MONTH) continue;
        const [route, carrier] = k.split('|');
        if (!agg.has(route)) agg.set(route, new Map());
        const m = agg.get(route);
        const cur = m.get(carrier) || { flights: 0, months: 0 };
        cur.flights += n;
        cur.months += 1;
        m.set(carrier, cur);
        kept++;
      }
      used.push(key);
      console.log(`  ${key}: ${counts.size} route+carrier pairs, ${kept} kept`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  if (used.length === 0) throw new Error('No months could be processed');

  // Directed routes: routes[ORG][DST] = carriers sorted by volume. A trailing "*" marks a
  // route that only ran in some of the sampled months (seasonal).
  const routes = {};
  for (const [route, carriers] of agg) {
    const [org, dst] = route.split('-');
    if (!org || !dst || org === dst) continue;
    const list = [...carriers.entries()]
      .sort((a, b) => b[1].flights - a[1].flights)
      .map(([code, v]) => (v.months < used.length ? `${code}*` : code));
    if (!routes[org]) routes[org] = {};
    routes[org][dst] = list;
  }

  const out = { generated: new Date().toISOString().slice(0, 10), months: used, routes };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  const pairs = Object.values(routes).reduce((n, r) => n + Object.keys(r).length, 0);
  console.log(`Saved ${pairs} directed routes from ${Object.keys(routes).length} airports to src/data/us-routes.json`);
}


// Run main() only when executed directly (node scripts/x.js), not when imported by tests.
const isEntryPoint = () => !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntryPoint()) main().catch((err) => {
  console.error(err);
  process.exit(1);
});
