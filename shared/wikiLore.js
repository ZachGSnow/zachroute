// Finds the English Wikipedia article for an airport and returns its page summary. Used by the
// /api/lore Pages Function and by scripts/prefetch_wiki_lore.js. Plain JS so the Node script can
// import it without a build step.
//
// Order: the article OurAirports links to (when it is on en.wikipedia.org), then a search by the
// airport's name, then a search by "<IATA> airport". A search hit is used only when its summary
// looks like an airport and, when both sides have coordinates, sits near the airport. Taking the
// first hit blindly matched codes that are also words (HER -> "Her", SHE -> "She").

const API = 'https://en.wikipedia.org/w/api.php';
const SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const SEARCH_LIMIT = 5;
const MAX_SUMMARIES_PER_SEARCH = 3;
export const MAX_DISTANCE_KM = 40;

const AIRPORT_WORDS =
  /\b(airports?|aerodromes?|airfields?|air ?bases?|air (force )?stations?|airstrips?|heliports?|airparks?|seaplane bases?|airways? terminal)\b/i;

/** Thrown when Wikipedia itself fails (rate limit, outage), so callers can tell it from "not found". */
export class WikiUpstreamError extends Error {
  /** @param {number} status */
  constructor(status) {
    super(status === 429 ? 'Wikipedia is rate limiting requests, try again shortly' : `Wikipedia request failed (${status})`);
    this.status = status;
  }
}

/**
 * Article title from an OurAirports wikipedia_link, or null unless it points at English Wikipedia.
 * @param {string | undefined | null} link
 * @returns {string | null}
 */
export function titleFromWikipediaLink(link) {
  if (!link) return null;
  const m = link.match(/^https?:\/\/en\.(?:m\.)?wikipedia\.org\/wiki\/([^?#]+)/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).replace(/_/g, ' ').trim() || null;
  } catch {
    return null;
  }
}

/** Great-circle distance in km. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function hasCoords(q) {
  return Number.isFinite(q.lat) && Number.isFinite(q.lon);
}

// Words that say what kind of place it is rather than which one, so they don't count as a match.
const GENERIC_WORDS = new Set(
  'airport airports international regional national municipal county city area field airfield aerodrome air base station force naval army military heliport seaplane airstrip airpark strip domestic metropolitan memorial executive general aviation the and del de la le los las des do da di of san santa sao new old north south east west'.split(
    ' '
  )
);

function words(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
}

/** True when the title shares a distinctive word with the airport's name. */
function sharesNameWord(title, name) {
  const want = new Set(words(name));
  return words(title).some((w) => want.has(w));
}

/**
 * Whether a page summary is plausibly the airport's article.
 * `linked` is the article OurAirports links to: only the distance check applies.
 * A search hit must be a single article (not a list or disambiguation page) worded as an airport,
 * and must either sit near the airport or, when there are no coordinates to compare, share a
 * distinctive word with its name or quote its IATA code.
 * @returns {boolean}
 */
export function summaryMatchesAirport(summary, query, linked = false) {
  if (!summary || !summary.extract) return false;
  if (summary.type && summary.type !== 'standard') return false; // disambiguation, no-extract, ...
  const c = summary.coordinates;
  const comparable = c && hasCoords(query) && Number.isFinite(c.lat) && Number.isFinite(c.lon);
  if (comparable && distanceKm(query.lat, query.lon, c.lat, c.lon) > MAX_DISTANCE_KM) return false;
  if (linked) return true;

  const title = String(summary.title || '');
  if (/^(list|lists|index|outline|timeline|infrastructure) of\b/i.test(title)) return false;
  const firstSentence = String(summary.extract).split(/(?<=\.)\s/)[0];
  if (!AIRPORT_WORDS.test(`${title} ${summary.description || ''} ${firstSentence}`)) return false;
  if (comparable) return true;

  const quotesCode = /^[A-Z0-9]{3,4}$/.test(query.iata || '') && new RegExp(`\\b${query.iata}\\b`).test(summary.extract);
  return quotesCode || sharesNameWord(title, query.name);
}

async function getJson(url, fetchFn, userAgent, notFoundOk) {
  const res = await fetchFn(url, { headers: { Accept: 'application/json', 'User-Agent': userAgent } });
  if (notFoundOk && res.status === 404) return null;
  if (!res.ok) throw new WikiUpstreamError(res.status);
  try {
    return await res.json();
  } catch {
    throw new WikiUpstreamError(502);
  }
}

function fetchSummary(title, fetchFn, userAgent) {
  return getJson(SUMMARY + encodeURIComponent(title.replace(/ /g, '_')), fetchFn, userAgent, true);
}

async function searchTitles(text, fetchFn, userAgent) {
  const url = `${API}?action=query&list=search&srlimit=${SEARCH_LIMIT}&format=json&srsearch=${encodeURIComponent(text)}`;
  const json = await getJson(url, fetchFn, userAgent, false);
  return (json?.query?.search || []).map((s) => s.title).filter(Boolean);
}

function searchQueries(query) {
  const out = [];
  const name = (query.name || '').trim();
  if (name) out.push(AIRPORT_WORDS.test(name) ? name : `${name} airport`);
  if (query.iata) out.push(`${query.iata} airport`);
  return [...new Set(out)];
}

/**
 * @param {{ iata?: string, title?: string | null, name?: string, lat?: number, lon?: number }} query
 * @param {{ fetch?: typeof fetch, userAgent: string }} opts
 * @returns {Promise<{ title: string, extract: string, thumbnail: string | null, url: string | null } | null>}
 *   null when no matching article was found; throws WikiUpstreamError when Wikipedia fails.
 */
export async function resolveAirportLore(query, opts) {
  const fetchFn = opts.fetch || fetch;
  const ua = opts.userAgent;
  const tried = new Set();

  const accept = (s) => ({
    title: s.title,
    extract: s.extract,
    thumbnail: s.thumbnail?.source || null,
    url: s.content_urls?.desktop?.page || null,
  });

  if (query.title) {
    tried.add(query.title);
    const s = await fetchSummary(query.title, fetchFn, ua);
    if (summaryMatchesAirport(s, query, true)) return accept(s);
  }

  for (const text of searchQueries(query)) {
    const titles = (await searchTitles(text, fetchFn, ua)).filter((t) => !tried.has(t));
    for (const t of titles.slice(0, MAX_SUMMARIES_PER_SEARCH)) {
      tried.add(t);
      const s = await fetchSummary(t, fetchFn, ua);
      if (summaryMatchesAirport(s, query)) return accept(s);
    }
  }
  return null;
}
