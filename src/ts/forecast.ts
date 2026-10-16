import { decodeWxPhenomena, categoryDot } from './weather';
import { hourOptions, formatVisibility } from './units';

export interface TafCloud {
  cover: string;
  base?: number;
}

export interface TafPeriod {
  from: number;
  to: number;
  change?: string; // FM, BECMG, TEMPO, PROB
  probability?: number;
  wdir?: number | string;
  wspd?: number;
  wgst?: number;
  wshearSpd?: number;
  wshearHgt?: number;
  visib?: string;
  wxString?: string;
  clouds: TafCloud[];
}

export interface TafSnapshot {
  available: boolean;
  issueTime?: string;
  validFrom?: number;
  validTo?: number;
  rawText?: string;
  periods?: TafPeriod[];
}

const tafCache = new Map<string, Promise<TafSnapshot>>();
const CACHE_MS = 10 * 60 * 1000;

export function fetchTaf(icao: string): Promise<TafSnapshot> {
  if (!icao) return Promise.resolve({ available: false });
  const cached = tafCache.get(icao);
  if (cached) return cached;

  const promise = (async (): Promise<TafSnapshot> => {
    if (!navigator.onLine) return { available: false };
    try {
      const res = await fetch(`/api/taf?icao=${icao}`);
      if (!res.ok) return { available: false };
      return (await res.json()) as TafSnapshot;
    } catch {
      return { available: false };
    }
  })();

  tafCache.set(icao, promise);
  setTimeout(() => tafCache.delete(icao), CACHE_MS);
  return promise;
}

// ---------------------------------------------------------------------------
// Plain-English decoding
// ---------------------------------------------------------------------------

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compassPoint(deg: number): string {
  return COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

/** Parses TAF/METAR visibility strings like "6+", "10+", "3", "1 1/2", "1/2" into statute miles. */
export function parseVisibilityMiles(visib?: string): number | undefined {
  if (!visib) return undefined;
  const cleaned = visib.replace('+', '').trim();
  if (!cleaned) return undefined;
  let total = 0;
  for (const part of cleaned.split(' ')) {
    if (part.includes('/')) {
      const [n, d] = part.split('/').map(Number);
      if (!d) return undefined;
      total += n / d;
    } else {
      const v = Number(part);
      if (isNaN(v)) return undefined;
      total += v;
    }
  }
  return total;
}

/** Standard aviation flight category from visibility (mi) and ceiling (ft). */
export function flightCategoryFor(visMi: number | undefined, ceilingFt: number | undefined): string | undefined {
  if (visMi === undefined && ceilingFt === undefined) return undefined;
  const v = visMi ?? 99;
  const c = ceilingFt ?? 99999;
  if (c < 500 || v < 1) return 'LIFR';
  if (c < 1000 || v < 3) return 'IFR';
  if (c <= 3000 || v <= 5) return 'MVFR';
  return 'VFR';
}

const CATEGORY_RANK: Record<string, number> = { VFR: 3, MVFR: 2, IFR: 1, LIFR: 0 };
const CATEGORY_WORDS: Record<string, string> = {
  VFR: 'good flying conditions',
  MVFR: 'reduced visibility or lower clouds',
  IFR: 'poor visibility',
  LIFR: 'very poor visibility',
};

function ceilingOf(clouds: TafCloud[]): number | undefined {
  const layers = clouds.filter((c) => (c.cover === 'BKN' || c.cover === 'OVC') && typeof c.base === 'number');
  if (layers.length === 0) return undefined;
  return Math.min(...layers.map((c) => c.base as number));
}

function hasSkyInfo(p: TafPeriod): boolean {
  return p.visib !== undefined || p.clouds.length > 0;
}

export function periodCategory(p: TafPeriod): string | undefined {
  if (!hasSkyInfo(p)) return undefined;
  const hasCover = p.clouds.length > 0;
  // "SKC/CLR" style groups carry no base; a cloud list with only FEW/SCT has no ceiling.
  return flightCategoryFor(parseVisibilityMiles(p.visib), hasCover ? ceilingOf(p.clouds) : undefined);
}

const COVER_WORDS: Record<string, string> = {
  SKC: 'clear skies',
  CLR: 'clear skies',
  NSC: 'no significant clouds',
  FEW: 'a few clouds',
  SCT: 'scattered clouds',
  BKN: 'broken clouds',
  OVC: 'overcast',
  VV: 'sky obscured',
};

function describeClouds(clouds: TafCloud[]): string | null {
  if (clouds.length === 0) return null;
  // Describe the lowest layer that matters: ceiling first, else lowest layer.
  const ceiling = ceilingOf(clouds);
  if (ceiling !== undefined) {
    const layer = clouds.find((c) => c.base === ceiling && (c.cover === 'BKN' || c.cover === 'OVC'))!;
    return `${layer.cover === 'OVC' ? 'overcast' : 'broken clouds'} at ${ceiling.toLocaleString()} ft`;
  }
  const lowest = [...clouds].sort((a, b) => (a.base ?? 99999) - (b.base ?? 99999))[0];
  const word = COVER_WORDS[lowest.cover] || lowest.cover.toLowerCase();
  return lowest.base !== undefined ? `${word} at ${lowest.base.toLocaleString()} ft` : word;
}

function describeWind(p: TafPeriod): string | null {
  if (p.wspd === undefined) return null;
  if (p.wspd < 3) return 'calm winds';
  const dir =
    typeof p.wdir === 'number' ? `from the ${compassPoint(p.wdir)}` : p.wdir === 'VRB' ? 'variable' : '';
  const gust = p.wgst !== undefined && p.wgst !== null ? `, gusting ${p.wgst}kt` : '';
  return `wind ${dir} ${p.wspd}kt${gust}`.replace(/\s+/g, ' ');
}

export function describePeriod(p: TafPeriod): string {
  const parts: string[] = [];
  const wind = describeWind(p);
  if (wind) parts.push(wind);

  const vis = parseVisibilityMiles(p.visib);
  if (vis !== undefined && vis < 6) parts.push(`visibility ${formatVisibility(p.visib!)}`);

  const wx = decodeWxPhenomena(p.wxString);
  if (wx) parts.push(wx.toLowerCase());

  const clouds = describeClouds(p.clouds);
  if (clouds) parts.push(clouds);

  if (p.wshearSpd !== undefined && p.wshearSpd !== null && p.wshearHgt !== undefined) {
    parts.push(`wind shear at ${(p.wshearHgt * 1).toLocaleString()} ft`);
  }

  if (parts.length === 0) return 'no change expected';
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function hourLabel(unixSec: number, timeZone?: string): string {
  const d = new Date(unixSec * 1000);
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, ...hourOptions() }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-US', hourOptions()).format(d);
  }
}

function dayKey(unixSec: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      new Date(unixSec * 1000)
    );
  } catch {
    return new Date(unixSec * 1000).toDateString();
  }
}

function weekdayShort(unixSec: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(unixSec * 1000));
  } catch {
    return '';
  }
}

/** "Fri 6 PM" when the day differs from today in the airport's zone, else "6 PM". */
function whenLabel(unixSec: number, timeZone?: string): string {
  const hour = hourLabel(unixSec, timeZone);
  const today = dayKey(Math.floor(Date.now() / 1000), timeZone);
  return dayKey(unixSec, timeZone) === today ? hour : `${weekdayShort(unixSec, timeZone)} ${hour}`;
}

function windowLabel(p: TafPeriod, timeZone?: string): string {
  const prob = p.probability ? `${p.probability}% chance ` : '';
  switch (p.change) {
    case 'FM':
      return `From ${whenLabel(p.from, timeZone)}`;
    case 'BECMG':
      return `Becoming by ${whenLabel(p.to, timeZone)}`;
    case 'TEMPO':
      return `${prob}Temporarily ${whenLabel(p.from, timeZone)} to ${whenLabel(p.to, timeZone)}`.trim();
    case 'PROB':
      return `${prob || 'Chance '}${whenLabel(p.from, timeZone)} to ${whenLabel(p.to, timeZone)}`.trim();
    default:
      return `Now until ${whenLabel(p.to, timeZone)}`;
  }
}

export interface DecodedTaf {
  headline: string;
  rows: string[]; // HTML rows
  count: number;
}

/** Turns a TAF into a one-line outlook plus a plain-English list of expected changes. */
export function decodeTaf(taf: TafSnapshot, timeZone?: string): DecodedTaf | null {
  if (!taf.available || !taf.periods || taf.periods.length === 0) return null;
  const now = Math.floor(Date.now() / 1000);
  const periods = taf.periods.filter((p) => p.to > now);
  if (periods.length === 0) return null;

  const rows = periods.slice(0, 12).map((p) => {
    const cat = periodCategory(p);
    const dot = cat ? `${categoryDot(cat)} ` : '';
    const label = windowLabel(p, timeZone);
    return `<div class="detail-row forecast-row"><span class="forecast-when">${label}</span><span>${dot}${describePeriod(p)}</span></div>`;
  });

  // Outlook: compare the current period's category with the first lasting change.
  const first = periods[0];
  const baseCat = periodCategory(first);
  let headline = '';
  if (baseCat) {
    const changeIdx = periods.findIndex(
      (p, i) => i > 0 && p.change !== 'TEMPO' && p.change !== 'PROB' && periodCategory(p) && periodCategory(p) !== baseCat
    );
    if (changeIdx > 0) {
      const next = periods[changeIdx];
      const nextCat = periodCategory(next)!;
      const worse = CATEGORY_RANK[nextCat] < CATEGORY_RANK[baseCat];
      headline = `${categoryDot(nextCat)} ${worse ? 'Conditions drop' : 'Conditions improve'} to ${nextCat} (${CATEGORY_WORDS[nextCat]}) around ${whenLabel(next.from, timeZone)}`;
    } else {
      const end = periods[periods.length - 1].to;
      headline = `${categoryDot(baseCat)} Expected to stay ${baseCat} (${CATEGORY_WORDS[baseCat]}) through ${whenLabel(end, timeZone)}`;
    }
    const tempoWorse = periods.find(
      (p) => (p.change === 'TEMPO' || p.change === 'PROB') && periodCategory(p) && CATEGORY_RANK[periodCategory(p)!] < CATEGORY_RANK[baseCat]
    );
    if (tempoWorse && !headline.includes('drop')) {
      headline += `; brief ${periodCategory(tempoWorse)} possible around ${whenLabel(tempoWorse.from, timeZone)}`;
    }
  }

  return { headline, rows, count: rows.length };
}
