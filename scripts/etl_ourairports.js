// ETL: Downloads OurAirports CSVs, filters large/medium + force-include from seed_lore.json,
// maps to Airport schema, joins runway/frequency/region/country detail, resolves timezone
// offline from lat/lon, adds each airport's English Wikipedia title from Wikidata, and writes
// public/data/airports.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { find as findTimeZone } from 'geo-tz';
import geomagnetism from 'geomagnetism';
import { fetchWikidataTitles, addWikiTitles } from './wikidata_titles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SEED_PATH = path.join(ROOT, 'scripts', 'seed_lore.json');
const OUT_PATH = path.join(ROOT, 'public', 'data', 'airports.json');

const AIRPORTS_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const RUNWAYS_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/runways.csv';
const FREQUENCIES_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv';
const COUNTRIES_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/countries.csv';
const REGIONS_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/regions.csv';
const NAVAIDS_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/navaids.csv';

// Plain-English surface labels for OurAirports' abbreviated surface codes.
const SURFACE_LABELS = {
  ASPH: 'asphalt',
  BIT: 'bitumen',
  BRICK: 'brick',
  CLAY: 'clay',
  CON: 'concrete',
  CONC: 'concrete',
  CORAL: 'coral',
  GRVL: 'gravel',
  GRAVEL: 'gravel',
  GRASS: 'grass',
  GRE: 'grass',
  GRS: 'grass',
  TURF: 'turf',
  DIRT: 'dirt',
  SAND: 'sand',
  SNOW: 'snow',
  ICE: 'ice',
  WATER: 'water',
  WOOD: 'wood',
  MAT: 'landing mat',
  MATS: 'landing mat',
  PEM: 'part concrete/asphalt',
  PSP: 'steel planking',
  UNK: 'unknown surface',
};

function surfaceLabel(raw) {
  if (!raw) return undefined;
  const base = raw.split('-')[0].toUpperCase();
  return SURFACE_LABELS[base] || raw.toLowerCase();
}

async function main() {
  console.log('Fetching OurAirports data...');

  const [airportsRes, runwaysRes, freqRes, countriesRes, regionsRes, navaidsRes] = await Promise.all([
    fetch(AIRPORTS_CSV_URL),
    fetch(RUNWAYS_CSV_URL),
    fetch(FREQUENCIES_CSV_URL),
    fetch(COUNTRIES_CSV_URL),
    fetch(REGIONS_CSV_URL),
    fetch(NAVAIDS_CSV_URL),
  ]);

  for (const [name, res] of [
    ['airports', airportsRes], ['runways', runwaysRes], ['frequencies', freqRes],
    ['countries', countriesRes], ['regions', regionsRes], ['navaids', navaidsRes],
  ]) {
    if (!res.ok) throw new Error(`Failed to fetch ${name} CSV: ${res.status}`);
  }

  const [airportsText, runwaysText, freqText, countriesText, regionsText, navaidsText] = await Promise.all([
    airportsRes.text(), runwaysRes.text(), freqRes.text(), countriesRes.text(), regionsRes.text(), navaidsRes.text(),
  ]);

  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const { records, kept } = buildRecords(
    { airportsText, runwaysText, freqText, countriesText, regionsText, navaidsText },
    seed
  );

  // Exact Wikipedia titles for the history and photo. Optional: without Wikidata the app falls
  // back to the OurAirports link and a checked search.
  try {
    const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const userAgent = `ZachRoute/${PKG.version} (${PKG.homepage})`;
    const airports = Object.values(records).filter((r) => r && typeof r === 'object');
    const byIcao = (await fetchWikidataTitles(airports.map((a) => a.icao).filter(Boolean), [], { userAgent, log: console.log })).icao;
    // IATA lookups are slower, so only for airports the ICAO lookup did not match.
    const rest = airports.filter((a) => a.iata && !byIcao.has(a.icao)).map((a) => a.iata);
    const byIata = (await fetchWikidataTitles([], rest, { userAgent, log: console.log })).iata;
    console.log(`Wikipedia titles from Wikidata: ${addWikiTitles(records, byIcao, byIata)} airports.`);
  } catch (err) {
    console.warn(`Skipping Wikidata titles: ${err.message}`);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(records));
  console.log(`ETL complete. Wrote ${Object.keys(records).length} indexed entries (${kept} source rows kept).`);
}

/**
 * Turns the six OurAirports CSV files into the app's airport dictionary. Pure (no I/O) so
 * it can be tested against real CSV samples. `date` picks the magnetic model epoch.
 */
export function buildRecords({ airportsText, runwaysText, freqText, countriesText, regionsText, navaidsText }, seed, date = new Date()) {
  const airportLines = airportsText.trim().split('\n');
  const runwayLines = runwaysText.trim().split('\n');
  const freqLines = freqText.trim().split('\n');
  const countryLines = countriesText.trim().split('\n');
  const regionLines = regionsText.trim().split('\n');
  const navaidLines = navaidsText.trim().split('\n');

  // countries.csv: id, code, name, continent, wikipedia_link, keywords
  const countryNames = {};
  for (let i = 1; i < countryLines.length; i++) {
    const row = parseCSVLine(countryLines[i]);
    if (!row || row.length < 3) continue;
    countryNames[(row[1] || '').toUpperCase()] = row[2] || '';
  }

  // regions.csv: id, code, local_code, name, continent, iso_country, wikipedia_link, keywords
  const regionNames = {};
  for (let i = 1; i < regionLines.length; i++) {
    const row = parseCSVLine(regionLines[i]);
    if (!row || row.length < 4) continue;
    regionNames[(row[1] || '').toUpperCase()] = row[3] || '';
  }

  // Build runway detail list by airport_ident (ICAO)
  const runwaysByIdent = {};
  for (let i = 1; i < runwayLines.length; i++) {
    const row = parseCSVLine(runwayLines[i]);
    if (!row || row.length < 20) continue;
    const airportIdent = (row[2] || '').toUpperCase();
    if (!airportIdent) continue;

    const lengthFt = parseInt(row[3]) || 0;
    const widthFt = parseInt(row[4]) || undefined;
    const surface = surfaceLabel(row[5]);
    const lighted = row[6] === '1';
    const closed = row[7] === '1';
    const leIdent = row[8] || '';
    const leHeading = row[12] ? parseFloat(row[12]) : undefined;
    const heIdent = row[14] || '';
    const heHeading = row[18] ? parseFloat(row[18]) : undefined;
    const coord = (v) => {
      const n = v ? parseFloat(v) : NaN;
      return Number.isFinite(n) ? Math.round(n * 1e5) / 1e5 : undefined;
    };
    const leLat = coord(row[9]);
    const leLon = coord(row[10]);
    const heLat = coord(row[15]);
    const heLon = coord(row[16]);

    if (closed) continue; // don't surface permanently closed runways in the card

    const ident = leIdent && heIdent ? `${leIdent}/${heIdent}` : (leIdent || heIdent || 'RWY');

    if (!runwaysByIdent[airportIdent]) runwaysByIdent[airportIdent] = [];
    runwaysByIdent[airportIdent].push({
      ident,
      lengthFt,
      widthFt,
      surface,
      lighted,
      closed,
      leHeadingDegT: leHeading,
      heHeadingDegT: heHeading,
      leLat,
      leLon,
      heLat,
      heLon,
    });
  }
  // Longest runway first, looks best in the card
  for (const ident of Object.keys(runwaysByIdent)) {
    runwaysByIdent[ident].sort((a, b) => b.lengthFt - a.lengthFt);
  }

  // airport-frequencies.csv: id, airport_ref, airport_ident, type, description, frequency_mhz
  const freqByIdent = {};
  for (let i = 1; i < freqLines.length; i++) {
    const row = parseCSVLine(freqLines[i]);
    if (!row || row.length < 6) continue;
    const airportIdent = (row[2] || '').toUpperCase();
    if (!airportIdent) continue;
    const type = row[3] || '';
    const description = row[4] || type;
    const frequencyMhz = row[5] || '';
    if (!frequencyMhz) continue;

    if (!freqByIdent[airportIdent]) freqByIdent[airportIdent] = [];
    freqByIdent[airportIdent].push({ type, description, frequencyMhz });
  }

  // navaids.csv: id, filename, ident, name, type, frequency_khz, latitude_deg, longitude_deg,
  // elevation_ft, iso_country, dme_*, slaved_variation_deg, magnetic_variation_deg, usageType, power, associated_airport
  const navaidsByIdent = {};
  for (let i = 1; i < navaidLines.length; i++) {
    const row = parseCSVLine(navaidLines[i]);
    if (!row || row.length < 20) continue;
    const assoc = (row[19] || '').toUpperCase();
    if (!assoc) continue;
    const freqKhz = row[5] ? parseInt(row[5]) : undefined;
    if (!navaidsByIdent[assoc]) navaidsByIdent[assoc] = [];
    navaidsByIdent[assoc].push({ ident: row[2] || '', name: row[3] || '', type: row[4] || '', freqKhz });
  }

  const magModel = geomagnetism.model(date);
  const forceInclude = new Set(Object.keys(seed));

  const records = {};
  let kept = 0;

  for (let i = 1; i < airportLines.length; i++) {
    const row = parseCSVLine(airportLines[i]);
    if (!row || row.length < 18) continue;

    const type = row[2];
    const icao = (row[1] || '').toUpperCase();
    const name = row[3];
    const lat = parseFloat(row[4]);
    const lon = parseFloat(row[5]);
    const elev = parseInt(row[6]) || 0;
    const isoCountry = (row[8] || '').toUpperCase();
    const isoRegion = (row[9] || '').toUpperCase();
    const municipality = row[10] || '';
    const scheduled = row[11] === 'yes';
    const iata = (row[13] || '').toUpperCase();
    const homeLink = row[16] || undefined;
    const wikipediaLink = row[17] || undefined;
    const localCode = (row[15] || '').toUpperCase();
    const keywords = row[18] || undefined;

    const isLargeOrMedium = type === 'large_airport' || type === 'medium_airport';
    const hasIata = iata.length === 3;
    const forced = forceInclude.has(iata) || forceInclude.has(icao);

    if (!isLargeOrMedium && !hasIata && !forced) continue;

    // Derive airportType (plain English)
    let airportType = 'General aviation airport';
    if (scheduled) {
      airportType = 'Passenger airport';
    } else if (isLargeOrMedium) {
      airportType = 'Cargo airport';
    }

    // Allow seed override
    if (seed[iata]?.airportType) airportType = seed[iata].airportType;
    if (seed[icao]?.airportType) airportType = seed[icao].airportType;

    const runways = runwaysByIdent[icao] || undefined;
    const runwayCount = runways?.length || undefined;
    const longestRunwayFeet = runways?.[0]?.lengthFt || undefined;
    const frequencies = freqByIdent[icao] || undefined;

    // OurAirports puts places without a first-level division in a placeholder region named
    // "(unassigned)" (Guam, for one): treat that as no region rather than show it.
    const unassigned = regionNames[isoRegion] === '(unassigned)';
    const regionName = (!unassigned && regionNames[isoRegion]) || undefined;
    const countryName = countryNames[isoCountry] || isoCountry;

    let timeZone;
    if (!isNaN(lat) && !isNaN(lon)) {
      try {
        timeZone = findTimeZone(lat, lon)[0];
      } catch {
        timeZone = undefined;
      }
    }

    const entry = {
      iata: hasIata ? iata : '',
      icao: icao || '',
      name: name || municipality,
      city: municipality.split(',')[0] || municipality,
      state: regionName && regionName !== countryName ? regionName : undefined,
      country: isoCountry || '',
      countryName,
      lat: isNaN(lat) ? 0 : lat,
      lon: isNaN(lon) ? 0 : lon,
      elevation: elev,
      type: seed[iata]?.type || seed[icao]?.type || type,
      primaryOperator: seed[iata]?.primaryOperator || seed[icao]?.primaryOperator,
      lore: seed[iata]?.lore || seed[icao]?.lore || undefined,
      airportType,
      runwayCount,
      longestRunwayFeet,
      runways,
      frequencies,
      timeZone,
      wikipediaLink,
      homeLink,
      localCode: localCode && localCode !== icao && localCode !== iata ? localCode : undefined,
      regionCode: !unassigned && isoRegion.includes('-') ? isoRegion.split('-')[1] : undefined,
      keywords,
      navaids: navaidsByIdent[icao] || undefined,
      magVarDeg: magVar(magModel, lat, lon),
    };

    // Index by IATA, ICAO and FAA local code. The primary key holds the record;
    // the others are string aliases (resolved to the same object at load time)
    // so the file doesn't carry every airport two or three times.
    let primary = entry.iata || entry.icao;
    if (!primary) continue;
    // Two source rows can share an IATA code; the later one is keyed by ICAO instead.
    if (records[primary] && typeof records[primary] === 'object' && entry.icao) primary = entry.icao;
    records[primary] = entry;
    if (entry.iata && entry.iata !== primary && !(entry.iata in records)) records[entry.iata] = primary;
    if (entry.icao && entry.icao !== primary && !(entry.icao in records)) records[entry.icao] = primary;
    if (entry.localCode && !(entry.localCode in records)) records[entry.localCode] = primary;
    kept++;
  }

  return { records, kept };
}

/** Magnetic declination in degrees (east positive), 1 decimal, from the World Magnetic Model. */
function magVar(model, lat, lon) {
  if (isNaN(lat) || isNaN(lon)) return undefined;
  try {
    const d = model.point([lat, lon]).decl;
    return Math.round(d * 10) / 10;
  } catch {
    return undefined;
  }
}

export function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}


// Run main() only when executed directly (node scripts/x.js), not when imported by tests.
const isEntryPoint = () => !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntryPoint()) main().catch((err) => {
  console.error(err);
  process.exit(1);
});
