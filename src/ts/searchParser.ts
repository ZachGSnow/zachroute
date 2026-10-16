import type { Airport } from './geoMath';
import connectionsData from '../data/connections.json';

export type SearchIntent =
  | { mode: 'SINGLE'; airport: Airport; alternatives?: Airport[] }
  | { mode: 'ROUTE'; origin: Airport; destination: Airport }
  | { mode: 'INVALID'; rawQuery: string; error: string };

const AIRPORT_DB: Record<string, Airport> = {};

interface SearchEntry {
  airport: Airport;
  city: string;
  words: string[];
  phrases: string[];
  /** Location qualifiers that may follow a name: "ky", "kentucky", "us", "usa", "uk" ... */
  hints: Set<string>;
  boost: number;
}

// Everyday names for countries whose ISO code people don't type.
const COUNTRY_ALIASES: Record<string, string[]> = {
  US: ['usa', 'america'],
  GB: ['uk', 'britain', 'england', 'scotland', 'wales'],
  AE: ['uae'],
  KR: ['korea'],
  NL: ['holland'],
};

let searchIndex: SearchEntry[] = [];

/** Lowercase, strip accents and punctuation so an accented "Sao Paulo" (with a tilde) matches "sao paulo". */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '') // O'Hare -> ohare
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CONNECTIONS = connectionsData as Record<string, string[]>;

/**
 * Ranking nudge so the airport people mean wins a shared city name. The `type` field
 * can't carry this alone (the seed data tags many big hubs "regional"), so the number
 * of known direct destinations is the main signal.
 */
function typeBoost(airport: Airport): number {
  let boost = 0;
  switch (airport.type) {
    case 'large_airport':
    case 'regional': boost += 20; break; // 'regional' is the seed-data tag for major hubs
    case 'medium_airport': boost += 12; break;
    case 'heliport':
    case 'seaplane_base':
    case 'closed': boost -= 15; break;
    default: break;
  }
  if (airport.airportType === 'Passenger airport') boost += 10;
  if (airport.iata) boost += 6;
  const destinations = (CONNECTIONS[airport.iata] || CONNECTIONS[airport.icao] || []).length;
  boost += Math.min(Math.round(destinations / 4), 70);
  return boost;
}

function buildSearchIndex(airports: Airport[]) {
  searchIndex = airports.map((airport) => {
    const keywordPhrases = (airport.keywords || '')
      .split(',')
      .map((k) => normalize(k))
      .filter(Boolean);
    const city = normalize(airport.city || '');
    const phrases = [city, normalize(airport.name || ''), ...keywordPhrases].filter(Boolean);
    const hay = [airport.city, airport.name, airport.keywords, airport.state, airport.countryName]
      .filter(Boolean)
      .join(' ');
    const hints = new Set<string>(
      [
        airport.regionCode,
        airport.country,
        ...(COUNTRY_ALIASES[airport.country] || []),
        ...normalize(airport.state || '').split(' '),
        ...normalize(airport.countryName || '').split(' '),
      ]
        .filter(Boolean)
        .map((h) => normalize(h as string))
    );
    const words = Array.from(new Set([...normalize(hay).split(' ').filter(Boolean), ...hints]));
    return { airport, city, words, phrases, hints, boost: typeBoost(airport) };
  });
}

export function loadAirports(data: Record<string, Airport>) {
  Object.assign(AIRPORT_DB, data);
  // Alias keys (ICAO / FAA LID) point at the same object as the primary key.
  const seen = new Set<Airport>();
  const unique: Airport[] = [];
  for (const key in data) {
    const airport = data[key];
    if (!airport || seen.has(airport)) continue;
    seen.add(airport);
    unique.push(airport);
  }
  buildSearchIndex(unique);
}

export function resolveCode(code: string): Airport | null {
  const upper = code.toUpperCase().trim();
  return AIRPORT_DB[upper] || null;
}

interface SearchHit {
  airport: Airport;
  /** How well the text matches (100 exact city, 80 exact name/alias, ... 10 loose); no ranking boost. */
  match: number;
  score: number;
}

/**
 * Ranked name / city / keyword search. Every query word must prefix-match a word of the
 * airport's text. Trailing location hints ("Portland ME", "London UK") narrow the match
 * and are ignored when judging how exact the name is.
 */
export function searchAirports(query: string, limit = 6): SearchHit[] {
  const q = normalize(query);
  if (q.length < 2) return [];
  const tokens = q.split(' ');

  const hits: SearchHit[] = [];
  for (const entry of searchIndex) {
    if (!tokens.every((t) => entry.words.some((w) => w.startsWith(t)))) continue;

    const coreTokens = tokens.filter((t) => !entry.hints.has(t));
    const core = (coreTokens.length ? coreTokens : tokens).join(' ');

    let match = 10;
    if (entry.city === core) match = 100;
    else if (entry.phrases.includes(core)) match = 80;
    else if (entry.city.startsWith(core)) match = 60;
    else if (entry.phrases.some((p) => p.startsWith(core))) match = 40;
    else if (entry.phrases.some((p) => p.includes(core))) match = 25;

    hits.push({ airport: entry.airport, match, score: match + entry.boost });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

const ROUTE_SEPARATOR = /\s+(?:to|and|vs)\s+|\s*(?:->|\u2192|\u2013|\u2014|>|\|)\s*|\s+-\s+/i;

function isWeakAirport(airport: Airport): boolean {
  return ['small_airport', 'heliport', 'seaplane_base', 'closed'].includes(airport.type);
}

interface ResolvedPart {
  airport: Airport;
  alternatives: Airport[];
  match: number; // 100 for an airport code
}

/** Resolves one side of a search: an airport code wins, otherwise the best name match. */
function resolvePart(text: string): ResolvedPart | null {
  const code = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const byCode = code && !text.trim().includes(' ') ? resolveCode(code) : null;

  const hits = searchAirports(text, 6);
  const best = hits[0];

  if (byCode) {
    // A short English word can collide with an obscure local/ICAO code ("Reno", "Mesa").
    // Prefer an exact city match when the code only hits a small field.
    const codeIsIata = byCode.iata === code;
    if (!codeIsIata && isWeakAirport(byCode) && best && best.match >= 100 && best.airport !== byCode) {
      return {
        airport: best.airport,
        alternatives: [byCode, ...hits.slice(1).map((h) => h.airport)].slice(0, 5),
        match: best.match,
      };
    }
    return { airport: byCode, alternatives: [], match: 100 };
  }

  if (!best) return null;
  return {
    airport: best.airport,
    alternatives: hits.slice(1).map((h) => h.airport).slice(0, 5),
    match: best.match,
  };
}

// A name match at least this good counts as "they meant this place".
const STRONG_MATCH = 60;
const PAIR_MATCH = 40;

/**
 * "chicago denver", "salt lake city boston", "ord denver": no separator, so try every
 * split point and keep the one where both sides match best.
 */
function bestSplit(query: string): { a: ResolvedPart; b: ResolvedPart } | null {
  const words = query.trim().split(/\s+/);
  let best: { a: ResolvedPart; b: ResolvedPart; total: number } | null = null;
  for (let i = 1; i < words.length; i++) {
    const a = resolvePart(words.slice(0, i).join(' '));
    if (!a || a.match < PAIR_MATCH) continue;
    const b = resolvePart(words.slice(i).join(' '));
    if (!b || b.match < PAIR_MATCH) continue;
    const total = a.match + b.match;
    if (!best || total > best.total) best = { a, b, total };
  }
  return best ? { a: best.a, b: best.b } : null;
}

export function parseQuery(query: string): SearchIntent {
  const cleaned = query
    .toUpperCase()
    .replace(/[\u2192\-\u2013\u2014>]/g, ' ')
    .replace(/\b(TO|AND)\b/g, ' ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = cleaned.split(' ').filter(Boolean);

  if (tokens.length === 0) {
    return { mode: 'INVALID', rawQuery: query, error: 'Empty query' };
  }

  // Two airport codes: a route, exactly as before ("ORD DEN").
  if (tokens.length === 2) {
    const origin = resolveCode(tokens[0]);
    const dest = resolveCode(tokens[1]);
    if (origin && dest) {
      return { mode: 'ROUTE', origin, destination: dest };
    }
  }

  // "Chicago to Denver", "ORD -> Denver", "Boston - Chicago"
  const parts = query.trim().split(ROUTE_SEPARATOR).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const a = resolvePart(parts[0]);
    const b = resolvePart(parts[1]);
    if (!a) {
      return { mode: 'INVALID', rawQuery: query, error: `No airport found for "${parts[0]}"` };
    }
    if (!b) {
      return { mode: 'INVALID', rawQuery: query, error: `No airport found for "${parts[1]}"` };
    }
    return { mode: 'ROUTE', origin: a.airport, destination: b.airport };
  }

  // A single code, or a city / airport name ("new york", "portland me").
  const one = resolvePart(query.trim());
  if (one && (tokens.length === 1 || one.match >= STRONG_MATCH)) {
    return { mode: 'SINGLE', airport: one.airport, alternatives: one.alternatives };
  }

  // Two places with no separator: "chicago denver", "ord denver".
  if (tokens.length >= 2) {
    const split = bestSplit(query);
    if (split) return { mode: 'ROUTE', origin: split.a.airport, destination: split.b.airport };
  }

  if (one) {
    return { mode: 'SINGLE', airport: one.airport, alternatives: one.alternatives };
  }
  if (tokens.length === 1) {
    return { mode: 'INVALID', rawQuery: query, error: `Airport not recognized: ${tokens[0]}` };
  }
  return { mode: 'INVALID', rawQuery: query, error: `No airport found for "${query.trim()}"` };
}

// ---------------------------------------------------------------------------
// Suggestions while typing
// ---------------------------------------------------------------------------

export interface Suggestion {
  /** The search to run when this suggestion is picked, e.g. "ORD" or "ORD DEN". */
  query: string;
  title: string;
  detail: string;
  kind: 'airport' | 'route';
}

const codeOf = (a: Airport) => a.iata || a.icao;

/** Airports for a partial entry: an exact code first, then code prefixes, then name matches. */
/** `short` allows a one-letter code prefix (used for the second airport of a route). */
function airportCandidates(text: string, limit: number, short = false): Airport[] {
  const out: Airport[] = [];
  const add = (a: Airport | null | undefined) => {
    if (a && !out.includes(a)) out.push(a);
  };
  const raw = text.trim();
  const isCodeLike = (short ? /^[a-z0-9]{1,4}$/i : /^[a-z0-9]{2,4}$/i).test(raw);

  if (isCodeLike) add(resolveCode(raw));
  if (isCodeLike && raw.length < 4) {
    const prefix = raw.toUpperCase();
    searchIndex
      .filter((e) => e.airport.iata && e.airport.iata.startsWith(prefix))
      .sort((a, b) => b.boost - a.boost)
      .slice(0, limit)
      .forEach((e) => add(e.airport));
  }
  for (const hit of searchAirports(raw, limit)) add(hit.airport);
  return out.slice(0, limit);
}

function airportSuggestion(a: Airport): Suggestion {
  const place = [a.city, a.state || a.countryName].filter(Boolean).join(', ');
  return { query: codeOf(a), title: `${codeOf(a)}  ${a.name}`, detail: place, kind: 'airport' };
}

function routeSuggestion(from: Airport, to: Airport): Suggestion {
  return {
    query: `${codeOf(from)} ${codeOf(to)}`,
    title: `${codeOf(from)} \u2192 ${codeOf(to)}`,
    detail: `${from.city || from.name} to ${to.city || to.name}`,
    kind: 'route',
  };
}

/**
 * Suggestions for what has been typed so far. A settled first airport plus a partial second
 * one ("chicago den", "ord to d") suggests routes; anything else suggests airports.
 */
export function suggest(query: string, limit = 6): Suggestion[] {
  const text = query.replace(/^\s+/, '');
  if (text.trim().length < 2) return [];

  const routes: Suggestion[] = [];
  const parts = text.split(ROUTE_SEPARATOR);
  if (parts.length >= 2) {
    // Explicit separator: the left side is settled, suggest the right side.
    const from = resolvePart(parts[0]);
    const rest = parts.slice(1).join(' ').trim();
    if (from && rest.length >= 1) {
      for (const to of airportCandidates(rest, limit, true)) if (to !== from.airport) routes.push(routeSuggestion(from.airport, to));
    }
    return routes.slice(0, limit);
  }

  const words = text.trim().split(/\s+/);
  if (words.length >= 2) {
    // No separator: find a split where the left side is a confident match.
    for (let i = words.length - 1; i >= 1; i--) {
      const from = resolvePart(words.slice(0, i).join(' '));
      if (!from || from.match < STRONG_MATCH) continue;
      const rest = words.slice(i).join(' ');
      for (const to of airportCandidates(rest, 4, true)) if (to !== from.airport) routes.push(routeSuggestion(from.airport, to));
      if (routes.length) break;
    }
  }

  const singles = airportCandidates(text, limit).map(airportSuggestion);
  const whole = resolvePart(text);
  const singleIsStrong = !!whole && whole.match >= STRONG_MATCH && words.length > 1;
  const merged = singleIsStrong ? [...singles, ...routes] : [...routes, ...singles];
  const seen = new Set<string>();
  return merged.filter((s) => (seen.has(s.query) ? false : (seen.add(s.query), true))).slice(0, limit);
}
