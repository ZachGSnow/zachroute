import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/airsigmet
// Active weather advisories as polygons from aviationweather.gov (free, no key):
//   - US AIRMETs/SIGMETs (turbulence, icing, IFR, mountain obscuration, convection)
//   - international SIGMETs issued for FIRs worldwide, including US oceanic FIRs
//     (thunderstorms, turbulence, icing, volcanic ash, tropical cyclones)
// Both feeds are merged into one list. Trimmed, KV-cached 5 minutes.

interface Env {
  LORE_KV?: KVNamespace;
}

export interface Advisory {
  type: string;
  hazard: string;
  severity?: number;
  /** Intensity in words for international SIGMETs ("embedded", "severe mountain wave"). */
  detail?: string;
  /** Volcano or tropical cyclone name. */
  name?: string;
  /** FIR (flight information region) that issued an international SIGMET. */
  region?: string;
  validFrom?: number;
  validTo?: number;
  altLow?: number;
  altHigh?: number;
  raw?: string;
  coords: [number, number][];
}

const CACHE_KEY = 'airsigmet:v2';
const CACHE_TTL_SECONDS = 300;

const US_URL = 'https://aviationweather.gov/api/data/airsigmet?format=json';
const INTL_URL = 'https://aviationweather.gov/api/data/isigmet?format=json';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' },
  });

// International SIGMET hazard codes, mapped onto the names the US feed (and the map styles) use.
const INTL_HAZARD: Record<string, string> = {
  TS: 'CONVECTIVE',
  TURB: 'TURB',
  ICE: 'ICE',
  VA: 'ASH',
  TC: 'TC',
  MTW: 'TURB',
};

// Intensity qualifiers ICAO SIGMETs use (Annex 3), in plain English.
const QUALIFIER_WORDS: Record<string, string> = {
  OBSC: 'obscured',
  EMBD: 'embedded',
  FRQ: 'frequent',
  SQL: 'squall line',
  OCNL: 'occasional',
  ISOL: 'isolated',
  SEV: 'severe',
  MOD: 'moderate',
  MTW: 'mountain wave',
  HVY: 'heavy',
};

function titleCase(text: string): string {
  return text.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Splits an international SIGMET qualifier into intensity words or a volcano / storm name. */
export function readQualifier(hazard: string, qualifier: unknown): { detail?: string; name?: string } {
  const q = typeof qualifier === 'string' ? qualifier.trim().toUpperCase() : '';
  if (!q) return {};
  const words = q.split(/\s+/);
  if (words.every((w) => w in QUALIFIER_WORDS)) return { detail: words.map((w) => QUALIFIER_WORDS[w]).join(' ') };
  if (hazard === 'VA' || hazard === 'TC') {
    // "ERUPTION MT IBU" -> "Mt Ibu"; "FUEGO" -> "Fuego"; "CHAMPI" -> "Champi"
    return { name: titleCase(q.replace(/^ERUPTION\s+/, '')) };
  }
  return {};
}

/**
 * Makes a ring's longitudes continuous so a polygon that crosses the antimeridian is not drawn
 * the long way around the world (175, -178 becomes 175, 182).
 */
export function unwrapRing(ring: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [lat, lon] of ring) {
    let l = lon;
    if (out.length > 0) {
      const prev = out[out.length - 1][1];
      while (l - prev > 180) l -= 360;
      while (l - prev < -180) l += 360;
    }
    out.push([lat, l]);
  }
  return out;
}

function toRing(points: unknown): [number, number][] | null {
  if (!Array.isArray(points)) return null;
  const ring = points
    .filter((c: any) => c && Number.isFinite(c.lat) && Number.isFinite(c.lon))
    .map((c: any) => [c.lat, c.lon] as [number, number]);
  return ring.length >= 3 ? unwrapRing(ring) : null;
}

/** US AIRMET/SIGMET records -> advisories. */
export function fromUsFeed(data: any[], now: number): Advisory[] {
  return data
    .filter((a) => a && (!a.validTimeTo || a.validTimeTo > now))
    .flatMap((a): Advisory[] => {
      const coords = toRing(a.coords);
      if (!coords) return [];
      return [
        {
          type: a.airSigmetType || 'AIRMET',
          hazard: a.hazard || 'OTHER',
          severity: a.severity ?? undefined,
          validFrom: a.validTimeFrom,
          validTo: a.validTimeTo,
          altLow: a.altitudeLow1 ?? a.altitudeLow2 ?? undefined,
          altHigh: a.altitudeHi1 ?? a.altitudeHi2 ?? undefined,
          raw: a.rawAirSigmet || undefined,
          coords,
        },
      ];
    });
}

/**
 * International SIGMET records -> advisories. A record's `coords` is either one ring or, for
 * geom "AREAS", a list of rings; each ring becomes its own advisory. Rings with fewer than three
 * points (a few records give a single position) are dropped.
 */
export function fromIntlFeed(data: any[], now: number): Advisory[] {
  return data
    .filter((a) => a && a.hazard && (!a.validTimeTo || a.validTimeTo > now))
    .flatMap((a): Advisory[] => {
      const rings = Array.isArray(a.coords) && Array.isArray(a.coords[0]) ? a.coords : [a.coords];
      const { detail, name } = readQualifier(a.hazard, a.qualifier);
      return rings.flatMap((r: unknown): Advisory[] => {
        const coords = toRing(r);
        if (!coords) return [];
        return [
          {
            type: 'SIGMET',
            hazard: INTL_HAZARD[a.hazard] || a.hazard,
            detail,
            name,
            region: a.firName ? titleCase(String(a.firName).replace(/^[A-Z]{4}\s+/, '')) : undefined,
            validFrom: a.validTimeFrom,
            validTo: a.validTimeTo,
            altLow: typeof a.base === 'number' ? a.base : undefined,
            altHigh: typeof a.top === 'number' ? a.top : undefined,
            raw: a.rawSigmet || undefined,
            coords,
          },
        ];
      });
    });
}

/** The international feed sometimes lists the same SIGMET twice; keep one of each. */
export function dedupe(list: Advisory[]): Advisory[] {
  const seen = new Set<string>();
  return list.filter((a) => {
    const key = `${a.hazard}|${a.validFrom}|${a.raw ?? ''}|${a.coords.join(';')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getFeed(url: string): Promise<any[] | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return null;
  }
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.env.LORE_KV) {
    const cached = await context.env.LORE_KV.get(CACHE_KEY, { type: 'json' });
    if (cached) return json(cached);
  }

  const [us, intl] = await Promise.all([getFeed(US_URL), getFeed(INTL_URL)]);
  const now = Math.floor(Date.now() / 1000);
  const advisories = dedupe([...fromUsFeed(us || [], now), ...fromIntlFeed(intl || [], now)]);
  const result = { advisories };

  // Only cache a complete answer, so one feed being down does not hide it for five minutes.
  if (us && intl && context.env.LORE_KV) {
    await context.env.LORE_KV.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  }
  return json(result);
};
