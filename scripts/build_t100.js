// Builds route and airport traffic from BTS T-100 Segment (All Carriers): every flight touching
// the US, by US and foreign airlines, month by month (public domain, US DOT). TranStats has no API
// for it, so this fills in its download form for each of the last 24 published months.
//
// Writes:
//   public/data/t100/{IATA}.json     traffic per airport and route, last 12 months (generated, gitignored)
//   public/data/t100/index.json      the months covered and the airports with a file
//   src/data/us-intl-routes.json     current nonstops between US and foreign airports, with airlines
//                                    (used by scripts/build_connections.js)
//
// Usage: node scripts/build_t100.js [--latest 2026-07]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseT100, aggregatePairs, airportFiles, internationalNonstops, windows, usTestFromRows } from '../shared/t100.js';
import { usAirportSet } from './build_connections.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'data', 't100');
const INTL_PATH = path.join(ROOT, 'src', 'data', 'us-intl-routes.json');
const AIRPORTS_PATH = path.join(ROOT, 'public', 'data', 'airports.json');
const FORM = 'https://www.transtats.bts.gov/DL_SelectFields.aspx?gnoyr_VQ=FMG&QO_fu146_anzr=Nv4%20Pn44vr45';
const LOOKUP = 'https://www.transtats.bts.gov/Download_Lookup.asp?Y11x72=';
const FIELDS = ['DEPARTURES_PERFORMED', 'SEATS', 'PASSENGERS', 'UNIQUE_CARRIER', 'ORIGIN', 'ORIGIN_COUNTRY', 'DEST', 'DEST_COUNTRY', 'AIRCRAFT_TYPE', 'YEAR', 'MONTH', 'CLASS'];
const UA = 'Mozilla/5.0 (ZachRoute data build; https://github.com/ZachGSnow/zachroute)';

/** The file named `want` from a zip, using the central directory (no external tools). */
export function readZipEntry(buf, want) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === want) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 8 ? zlib.inflateRawSync(data) : data;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${want} not in zip`);
}

/** A TranStats lookup CSV ("Code","Description") -> { code: description }. */
async function lookup(id) {
  const res = await fetch(LOOKUP + id, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`lookup ${id}: HTTP ${res.status}`);
  const out = {};
  for (const line of (await res.text()).split(/\r?\n/).slice(1)) {
    const m = line.match(/^"([^"]*)","(.*)"$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** The download form's hidden fields and session cookie, and the latest month it offers. */
async function openForm() {
  const res = await fetch(FORM, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`TranStats form: HTTP ${res.status}`);
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const page = await res.text();
  const hidden = Object.fromEntries([...page.matchAll(/<input type="hidden" name="([^"]+)" id="[^"]*" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const latest = page.match(/Latest Available Data:\s*([A-Za-z]+)\s+(\d{4})/);
  const month = latest ? new Date(`${latest[1]} 1, ${latest[2]} UTC`).getUTCMonth() + 1 : null;
  return { cookie, hidden, latest: latest && month ? `${latest[2]}-${String(month).padStart(2, '0')}` : null };
}

async function downloadMonth(form, key) {
  const [year, month] = key.split('-').map(Number);
  const body = new URLSearchParams({ ...form.hidden, cboGeography: 'All', cboYear: String(year), cboPeriod: String(month), btnDownload: 'Download', chkDownloadZip: 'on' });
  for (const f of FIELDS) body.set(f, 'on');
  const res = await fetch(FORM, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: form.cookie },
    body,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok || buf.readUInt32LE(0) !== 0x04034b50) throw new Error(`${key}: download failed (HTTP ${res.status})`);
  return parseT100(readZipEntry(buf, 'T_T100_SEGMENT_ALL_CARRIER.csv').toString('utf8'));
}

async function main() {
  if (!fs.existsSync(AIRPORTS_PATH)) throw new Error('public/data/airports.json not found. Run `node scripts/etl_ourairports.js` first.');
  const started = Date.now();
  const form = await openForm();
  const arg = process.argv.indexOf('--latest');
  const latest = arg !== -1 ? process.argv[arg + 1] : form.latest;
  if (!latest) throw new Error('could not read the latest month from TranStats; pass --latest YYYY-MM');
  const { prev, last } = windows(latest);
  console.log(`T-100: ${prev[0]} to ${last[11]}`);

  const [aircraftNames, carrierNames] = await Promise.all([lookup('Y_NVePeNSg_glcR'), lookup('Y_haVdhR_PNeeVRef')]);
  const rows = [];
  for (const key of [...prev, ...last]) {
    const got = await downloadMonth(form, key);
    rows.push(...got);
    process.stdout.write(`  ${key}: ${got.length} rows\n`);
  }

  const pairs = aggregatePairs(rows, latest);
  const files = airportFiles(pairs, latest, aircraftNames);
  const used = new Set();
  for (const f of files.values()) for (const r of Object.values(f.routes)) for (const [c] of r.airlines) used.add(c);

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let bytes = 0;
  for (const f of files.values()) {
    if (!/^[A-Z0-9]{3}$/.test(f.code)) continue;
    const text = JSON.stringify(f);
    fs.writeFileSync(path.join(OUT_DIR, `${f.code}.json`), text);
    bytes += text.length;
  }
  const airlines = Object.fromEntries([...used].sort().map((c) => [c, carrierNames[c] || c]));
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify({ months: { from: last[0], to: last[11] }, airports: [...files.keys()].sort(), airlines }));

  const us = usAirportSet(JSON.parse(fs.readFileSync(AIRPORTS_PATH, 'utf8')));
  const intl = internationalNonstops(pairs, usTestFromRows(rows, (code) => us.has(code)));
  fs.writeFileSync(INTL_PATH, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), months: { from: last[0], to: last[11] }, names: airlines, routes: intl }));
  const intlPairs = Object.values(intl).reduce((n, d) => n + Object.keys(d).length, 0) / 2;
  console.log(
    `T-100: ${rows.length} rows -> ${pairs.size} routes, ${files.size} airports, ${(bytes / 1e6).toFixed(1)} MB; ` +
      `${intlPairs} US-international nonstops; ${((Date.now() - started) / 1000).toFixed(0)} s`
  );
}

const isEntryPoint = () => !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
