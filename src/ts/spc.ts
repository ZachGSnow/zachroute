// NOAA Storm Prediction Center convective outlook (from /api/spc): where severe thunderstorms are
// expected over the US today or tomorrow, by risk category, on the severity ladder.

import type { Severity } from './severity';

export interface SpcArea {
  category: string;
  polygons: [number, number][][][];
}

export interface SpcOutlook {
  day: 1 | 2;
  issued?: string;
  validFrom?: string;
  validTo?: string;
  areas: SpcArea[];
}

export type SpcDay = 1 | 2;

const LEVEL: Record<string, 0 | Severity> = { TSTM: 0, MRGL: 1, SLGT: 2, ENH: 3, MDT: 4, HIGH: 4 };

/**
 * SPC risk onto the ladder: general thunderstorms 0 (not severe; drawn soft blue like rain on
 * radar), Marginal Light, Slight Moderate, Enhanced Severe, Moderate and High Extreme.
 */
export function spcLevel(category: string): 0 | Severity {
  return LEVEL[category] ?? 0;
}

const NAMES: Record<string, string> = {
  TSTM: 'General thunderstorms (not severe)',
  MRGL: 'Marginal risk of severe storms (1 of 5)',
  SLGT: 'Slight risk of severe storms (2 of 5)',
  ENH: 'Enhanced risk of severe storms (3 of 5)',
  MDT: 'Moderate risk of severe storms (4 of 5)',
  HIGH: 'High risk of severe storms (5 of 5)',
};

export function spcCategoryName(category: string): string {
  return NAMES[category] || category;
}

const WORDS: Record<string, string> = { MRGL: 'marginal', SLGT: 'slight', ENH: 'enhanced', MDT: 'moderate', HIGH: 'high' };

/** "marginal", "enhanced": SPC's own word for a risk category. */
export function spcRiskWord(category: string): string {
  return WORDS[category] || category.toLowerCase();
}

const cache = new Map<SpcDay, { at: number; data: Promise<SpcOutlook | null> }>();

export function fetchSpcOutlook(day: SpcDay): Promise<SpcOutlook | null> {
  const hit = cache.get(day);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
  const data = (async (): Promise<SpcOutlook | null> => {
    if (!navigator.onLine) return null;
    try {
      const res = await fetch(`/api/spc?day=${day}`);
      if (!res.ok) return null;
      return (await res.json()) as SpcOutlook;
    } catch {
      return null;
    }
  })();
  cache.set(day, { at: Date.now(), data });
  return data;
}
