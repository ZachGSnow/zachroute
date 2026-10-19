// One severity ladder for every hazard on the map, in the cards and in the lists:
//   1 Light (yellow): noticeable, usually no problem for airliners
//   2 Moderate (orange): expect bumps, ice or delays
//   3 Severe (red): flights avoid or reroute
//   4 Extreme (magenta): avoid at any altitude
// Each source maps its own scale onto these four levels here, so the map, the legend and the
// cards always agree.

import type { LegendItem } from './legend';

export type Severity = 1 | 2 | 3 | 4;

export const SEVERITY: Record<Severity, { name: string; color: string }> = {
  1: { name: 'Light', color: '#facc15' },
  2: { name: 'Moderate', color: '#fb923c' },
  3: { name: 'Severe', color: '#ef4444' },
  4: { name: 'Extreme', color: '#d946ef' },
};

export const severityName = (s: Severity) => SEVERITY[s].name;
export const severityColor = (s: Severity) => SEVERITY[s].color;

/** Card chip urgency: Light and Moderate are cautions, Severe and Extreme are alerts. */
export function chipLevel(s: Severity): 'warn' | 'alert' {
  return s >= 3 ? 'alert' : 'warn';
}

/** Legend swatches for the levels a layer uses (all four by default). */
export function severityLegendItems(levels: Severity[] = [1, 2, 3, 4], mark: LegendItem['mark'] = 'dot'): LegendItem[] {
  return levels.map((s) => ({ color: severityColor(s), label: severityName(s), mark }));
}

// Pilot report codes (turbulence and icing intensity) onto the ladder.
const PIREP_LEVEL: Record<string, Severity> = {
  TRC: 1,
  LGT: 1,
  'LGT-MOD': 2,
  MOD: 2,
  'MOD-SEV': 3,
  SEV: 3,
  EXTRM: 4,
  HVY: 4,
};

/** Severity of a pilot report's turbulence or icing code ("MOD", "LGT-MOD", ...); null for none. */
export function pirepCodeSeverity(code?: string): Severity | null {
  const c = (code || '').toUpperCase().trim();
  if (!c) return null;
  if (c in PIREP_LEVEL) return PIREP_LEVEL[c];
  // Unlisted combinations: go by the strongest word in them.
  if (/EXTRM|HVY/.test(c)) return 4;
  if (/SEV/.test(c)) return 3;
  if (/MOD/.test(c)) return 2;
  if (/LGT|TRC/.test(c)) return 1;
  return null;
}

/** Fire radiative power (MW) onto the ladder: under 30, 30-100, 100-500, 500 and up. */
export function fireSeverity(frpMw: number): Severity {
  if (frpMw >= 500) return 4;
  if (frpMw >= 100) return 3;
  if (frpMw >= 30) return 2;
  return 1;
}
