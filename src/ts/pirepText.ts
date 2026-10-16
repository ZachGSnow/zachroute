// Plain-English translation of pilot reports (PIREPs) for the card and the map.

import { formatVisibility } from './units';

export interface RawPirep {
  obsTime: number;
  acType?: string;
  lat: number;
  lon: number;
  fltLvl?: number;
  urgent?: boolean;
  turb?: string;
  icing?: string;
  icingType?: string;
  visib?: number;
  wxString?: string;
  raw?: string;
}

export type PirepKind = 'turb' | 'ice' | 'both' | 'vis';

export interface PirepSummary {
  headline: string; // e.g. "Moderate turbulence (rough ride)"
  kind: PirepKind;
  severe: boolean; // moderate or worse
}

const TURB_WORDS: Record<string, string> = {
  TRC: 'A few light bumps',
  LGT: 'Light bumps',
  'LGT-MOD': 'Light to moderate turbulence',
  MOD: 'Moderate turbulence (rough ride)',
  'MOD-SEV': 'Moderate to severe turbulence (very rough)',
  SEV: 'Severe turbulence (violent shaking)',
  EXTRM: 'Extreme turbulence',
};

const ICE_WORDS: Record<string, string> = {
  TRC: 'A trace of ice on the aircraft',
  LGT: 'Light ice building on the aircraft',
  'LGT-MOD': 'Light to moderate ice building on the aircraft',
  MOD: 'Moderate ice building on the aircraft',
  'MOD-SEV': 'Moderate to severe ice building on the aircraft',
  SEV: 'Severe ice building on the aircraft',
  HVY: 'Heavy ice building on the aircraft',
};

const NONE = new Set(['', 'NEG', 'SMTH', 'NONE']);

function clean(code?: string): string {
  return (code || '').toUpperCase().trim();
}

/** Returns a plain-English summary, or null when the report has nothing notable (smooth air, no ice, good visibility). */
export function summarizePirep(p: RawPirep): PirepSummary | null {
  const turb = clean(p.turb);
  const ice = clean(p.icing);
  const hasTurb = !NONE.has(turb);
  const hasIce = !NONE.has(ice);
  const lowVis = p.visib !== undefined && p.visib !== null && p.visib < 3;
  if (!hasTurb && !hasIce && !lowVis) return null;

  const parts: string[] = [];
  if (hasTurb) parts.push(TURB_WORDS[turb] || `${turb.toLowerCase()} turbulence`);
  if (hasIce) parts.push(ICE_WORDS[ice] || `${ice.toLowerCase()} icing`);
  if (lowVis && !hasTurb && !hasIce) parts.push(`Low visibility (${formatVisibility(p.visib!)})`);
  else if (lowVis) parts.push(`low visibility (${formatVisibility(p.visib!)})`);

  const kind: PirepKind = hasTurb && hasIce ? 'both' : hasTurb ? 'turb' : hasIce ? 'ice' : 'vis';
  const severe = !!p.urgent || /MOD|SEV|EXTRM|HVY/.test(turb) || /MOD|SEV|HVY/.test(ice);
  const headline = parts.join('; ');
  return { headline: headline.charAt(0).toUpperCase() + headline.slice(1), kind, severe };
}

export function pirepAgeLabel(obsTime: number): string {
  const mins = Math.max(Math.round((Date.now() / 1000 - obsTime) / 60), 0);
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} hr ago`;
}

export function pirepAltitudeLabel(p: RawPirep): string {
  if (p.fltLvl === undefined || p.fltLvl === null || p.fltLvl === 0) return '';
  return `${(p.fltLvl * 100).toLocaleString()} ft`;
}
