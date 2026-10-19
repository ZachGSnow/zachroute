// English Wikipedia article titles for airports, from Wikidata: the item whose ICAO code (P239)
// or IATA code (P238) matches, and its en.wikipedia sitelink. Used by etl_ourairports.js so the
// app can ask for an airport's article by its exact title instead of searching (searching
// "HER airport" finds the pronoun). Codes are looked up in batches, which uses Wikidata's index;
// one query over every airport code runs past the service's 60 second limit.

const ENDPOINT = 'https://query.wikidata.org/sparql';
const BATCH = 300;
const DELAY_MS = 1000;

const PROPS = { icao: 'P239', iata: 'P238' };

/** SPARQL for the en.wikipedia titles of items with one of these codes. Codes are A-Z/0-9 only. */
export function sparqlFor(kind, codes) {
  const values = codes.filter((c) => /^[A-Z0-9]{3,4}$/.test(c)).map((c) => `"${c}"`).join(' ');
  return `SELECT ?code ?title WHERE {
  VALUES ?code { ${values} }
  ?item wdt:${PROPS[kind]} ?code .
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?title .
}`;
}

/** Code -> set of titles from a SPARQL JSON response. */
export function parseTitles(json, into = new Map()) {
  for (const row of json?.results?.bindings || []) {
    const code = row.code?.value;
    const title = row.title?.value;
    if (!code || !title) continue;
    if (!into.has(code)) into.set(code, new Set());
    into.get(code).add(title);
  }
  return into;
}

/** The one title for a code, or undefined when there is none or more than one (ambiguous). */
function only(map, code) {
  const titles = code ? map.get(code) : undefined;
  return titles && titles.size === 1 ? [...titles][0] : undefined;
}

/**
 * Sets `wikiTitle` on each airport record (ICAO match first, then IATA), skipping string aliases.
 * Returns how many records got one.
 */
export function addWikiTitles(records, byIcao, byIata) {
  let n = 0;
  for (const rec of Object.values(records)) {
    if (!rec || typeof rec !== 'object') continue;
    const title = only(byIcao, rec.icao) || only(byIata, rec.iata);
    if (title) {
      rec.wikiTitle = title;
      n++;
    }
  }
  return n;
}

/** Looks up every code in batches. Throws when Wikidata fails, so the caller can carry on without. */
export async function fetchWikidataTitles(icaoCodes, iataCodes, { userAgent, fetch: fetchFn = fetch, delayMs = DELAY_MS, log = () => {} }) {
  const out = { icao: new Map(), iata: new Map() };
  for (const [kind, codes] of [['icao', icaoCodes], ['iata', iataCodes]]) {
    const unique = [...new Set(codes)].filter((c) => /^[A-Z0-9]{3,4}$/.test(c));
    for (let i = 0; i < unique.length; i += BATCH) {
      const body = new URLSearchParams({ query: sparqlFor(kind, unique.slice(i, i + BATCH)) });
      const res = await fetchFn(ENDPOINT, {
        method: 'POST',
        headers: { Accept: 'application/sparql-results+json', 'User-Agent': userAgent },
        body,
      });
      if (!res.ok) throw new Error(`Wikidata query failed: ${res.status}`);
      parseTitles(await res.json(), out[kind]);
      log(`Wikidata ${kind}: ${Math.min(i + BATCH, unique.length)}/${unique.length}`);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return out;
}
