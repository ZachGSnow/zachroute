import { USER_AGENT } from '../../shared/userAgent';
// Cloudflare Pages Function: /api/airsigmet
// Active weather advisories as polygons from aviationweather.gov (free, no key):
//   - US SIGMETs (convection, severe turbulence and icing)
//   - US G-AIRMETs (graphical AIRMETs: turbulence, icing, low ceilings, mountain obscuration,
//     strong surface wind, low-level wind shear), which replaced the text AIRMETs the US feed
//     used to carry
//   - international SIGMETs issued for FIRs worldwide, including US oceanic FIRs
//     (thunderstorms, turbulence, icing, volcanic ash, tropical cyclones)
//   - US Center Weather Advisories: short-notice (up to 2 hours) warnings from an air route
//     traffic control center's weather unit, often ahead of a SIGMET
// The feeds are merged into one list. Trimmed, KV-cached 5 minutes.

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
  /** FIR (flight information region) that issued an international SIGMET, or the center ("Miami Center") that issued a CWA. */
  region?: string;
  validFrom?: number;
  validTo?: number;
  altLow?: number;
  altHigh?: number;
  raw?: string;
  coords: [number, number][];
}

const CACHE_KEY = 'airsigmet:v4'; // v4: includes G-AIRMETs
const CACHE_TTL_SECONDS = 300;

const US_URL = 'https://aviationweather.gov/api/data/airsigmet?format=json';
const INTL_URL = 'https://aviationweather.gov/api/data/isigmet?format=json';
const CWA_URL = 'https://aviationweather.gov/api/data/cwa?format=json';
// G-AIRMETs are snapshots every 3 hours from issuance; one of these three is nearest now.
const GAIRMET_URL = 'https://aviationweather.gov/api/data/gairmet?format=json&fore=';
const GAIRMET_HOURS = [0, 3, 6];

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

// Coordinates come as numbers in the AIRMET/SIGMET feeds and as strings in the CWA feed.
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN);

function toRing(points: unknown): [number, number][] | null {
  if (!Array.isArray(points)) return null;
  const ring = points
    .filter((c: any) => c && Number.isFinite(num(c.lat)) && Number.isFinite(num(c.lon)))
    .map((c: any) => [num(c.lat), num(c.lon)] as [number, number]);
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

// CWA hazard codes, mapped onto the names the map styles use.
const CWA_HAZARD: Record<string, string> = {
  TS: 'CONVECTIVE',
  TURB: 'TURB',
  ICE: 'ICE',
  IFR: 'IFR',
  PCPN: 'PCPN',
};

// Words a CWA qualifier uses for how widespread or how far along the hazard is.
const CWA_WORDS: Record<string, string> = {
  DVLPG: 'developing',
  ISOL: 'isolated',
  SCT: 'scattered',
  NMRS: 'numerous',
  EMBD: 'embedded',
  OCNL: 'occasional',
  FRQ: 'frequent',
  LN: 'line of',
  SEV: 'severe',
  MOD: 'moderate',
};

/** "DVLPG TSRA" -> "developing". The hazard itself (TS, TSRA, ...) is left to the hazard label. */
export function readCwaQualifier(qualifier: unknown): string | undefined {
  const words = (typeof qualifier === 'string' ? qualifier : '')
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .filter((w) => w && !/^(TS|TSRA|TSGR|TSRAGR|CB|AREA)$/.test(w));
  if (!words.length || !words.every((w) => w in CWA_WORDS)) return undefined;
  return words.map((w) => CWA_WORDS[w]).join(' ');
}

/** Center Weather Advisory records -> advisories. */
export function fromCwaFeed(data: any[], now: number): Advisory[] {
  return data
    .filter((a) => a && a.hazard && (!a.validTimeTo || a.validTimeTo > now))
    .flatMap((a): Advisory[] => {
      const coords = toRing(a.coords);
      if (!coords) return [];
      return [
        {
          type: 'CWA',
          hazard: CWA_HAZARD[a.hazard] || a.hazard,
          detail: readCwaQualifier(a.qualifier),
          region: a.name ? `${titleCase(String(a.name))} Center` : a.cwsu || undefined,
          validFrom: a.validTimeFrom,
          validTo: a.validTimeTo,
          altLow: typeof a.base === 'number' ? a.base : undefined,
          altHigh: typeof a.top === 'number' ? a.top : undefined,
          raw: a.rawText || undefined,
          coords,
        },
      ];
    });
}

// G-AIRMET hazard codes, mapped onto the names the map styles use. Freezing level contours
// (FZLVL, M_FZLVL) are left out: they are lines, and the freezing level layer covers them.
const GAIRMET_HAZARD: Record<string, string> = {
  'TURB-HI': 'TURB',
  'TURB-LO': 'TURB',
  ICE: 'ICE',
  IFR: 'IFR',
  MT_OBSC: 'MTN OBSCN',
  SFC_WND: 'SFC WND',
  LLWS: 'LLWS',
};

/** A G-AIRMET level in hundreds of feet ("080" -> 8000, "SFC" -> 0); "FZL" (the freezing level) and blanks -> undefined. */
export function gairmetLevel(value: unknown): number | undefined {
  const v = typeof value === 'string' ? value.trim().toUpperCase() : typeof value === 'number' ? String(value) : '';
  if (v === 'SFC') return 0;
  return /^\d{1,3}$/.test(v) ? parseInt(v, 10) * 100 : undefined;
}

const validAt = (r: any) => (typeof r?.validTime === 'string' ? Date.parse(r.validTime) / 1000 : NaN);

/**
 * The G-AIRMET snapshot nearest now. Each snapshot shows the hazards at one moment (issuance, +3h,
 * +6h, ...), so the records whose valid time is closest to now are kept.
 */
export function nearestGairmetSnapshot(records: any[], now: number): any[] {
  let best = NaN;
  for (const r of records) {
    const t = validAt(r);
    if (Number.isFinite(t) && (!Number.isFinite(best) || Math.abs(t - now) < Math.abs(best - now))) best = t;
  }
  return Number.isFinite(best) ? records.filter((r) => validAt(r) === best) : [];
}

const SNAPSHOT_HALF_SPAN = 90 * 60; // a snapshot stands for the 1.5 hours either side of it

/** G-AIRMET records (one snapshot) -> advisories, drawn and ranked as AIRMETs. */
export function fromGairmetFeed(data: any[], now: number): Advisory[] {
  return data.flatMap((a): Advisory[] => {
    const hazard = a && GAIRMET_HAZARD[a.hazard];
    const at = validAt(a);
    if (!hazard || !Number.isFinite(at)) return [];
    const expires = typeof a.expireTime === 'number' ? a.expireTime : Infinity;
    const validTo = Math.min(at + SNAPSHOT_HALF_SPAN, expires);
    if (validTo <= now) return [];
    const coords = toRing(a.coords);
    if (!coords) return [];
    const dueTo = typeof a.due_to === 'string' ? a.due_to.trim().toUpperCase() : '';
    const detail = [a.severity === 'MOD' ? 'moderate' : '', dueTo === 'MTN WAVE' ? 'mountain wave' : ''].filter(Boolean).join(' ');
    return [
      {
        type: 'AIRMET',
        hazard,
        detail: detail || undefined,
        validFrom: at - SNAPSHOT_HALF_SPAN,
        validTo,
        altLow: gairmetLevel(a.base),
        altHigh: gairmetLevel(a.top),
        raw: [`G-AIRMET ${a.product || ''} ${a.tag || ''}`.replace(/\s+/g, ' ').trim(), dueTo && dueTo !== 'MTN WAVE' && dueTo !== 'ICE' ? dueTo : '']
          .filter(Boolean)
          .join(': '),
        coords,
      },
    ];
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

  const [us, intl, cwa, ...gairmets] = await Promise.all([
    getFeed(US_URL),
    getFeed(INTL_URL),
    getFeed(CWA_URL),
    ...GAIRMET_HOURS.map((h) => getFeed(GAIRMET_URL + h)),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const gairmet = fromGairmetFeed(nearestGairmetSnapshot(gairmets.flatMap((g) => g || []), now), now);
  const advisories = dedupe([...fromUsFeed(us || [], now), ...gairmet, ...fromIntlFeed(intl || [], now), ...fromCwaFeed(cwa || [], now)]);
  const result = { advisories };

  // Only cache a complete answer, so one feed being down does not hide it for five minutes.
  if (us && intl && cwa && gairmets.every(Boolean) && context.env.LORE_KV) {
    await context.env.LORE_KV.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  }
  return json(result);
};
