// The Aviation Weather Center's TFM Convective Forecast (from /api/tcf): where thunderstorms are
// expected over the US 4, 6 and 8 hours ahead. The layer shows one of the three forecasts at a time.

import type { Severity } from './severity';

export interface TcfArea {
  validTime: number;
  issueTime?: number;
  coverage: string;
  confidence: string;
  tops?: number;
  kind: 'area' | 'line';
  coords: [number, number][];
}

/** Which of the forecasts to show: the first (about 4 hours ahead), second (6) or third (8). */
export type TcfStep = 0 | 1 | 2;

export const TCF_STEP_HOURS = [4, 6, 8];

/** How much of the area storms will cover onto the ladder: sparse Moderate, medium Severe, solid or a line Extreme. */
export function tcfSeverity(a: Pick<TcfArea, 'coverage' | 'kind'>): Severity {
  if (a.kind === 'line') return 4;
  if (a.coverage === 'solid') return 4;
  if (a.coverage === 'medium') return 3;
  return 2;
}

const COVERAGE_WORDS: Record<string, string> = {
  sparse: 'sparse (25-39% of the area)',
  medium: 'medium (40-74% of the area)',
  solid: 'solid (75% or more of the area)',
};

export function tcfCoverageLabel(a: Pick<TcfArea, 'coverage' | 'kind'>): string {
  if (a.kind === 'line') return 'a line of storms';
  return COVERAGE_WORDS[a.coverage] || a.coverage || 'unknown coverage';
}

/** The distinct forecast times, earliest first. */
export function tcfTimes(areas: TcfArea[]): number[] {
  return [...new Set(areas.map((a) => a.validTime))].sort((a, b) => a - b);
}

/** The areas of one forecast step; when fewer forecasts are left (late in a cycle), the last one. */
export function tcfForStep(areas: TcfArea[], step: TcfStep): { time?: number; areas: TcfArea[] } {
  const times = tcfTimes(areas);
  if (!times.length) return { areas: [] };
  const time = times[Math.min(step, times.length - 1)];
  return { time, areas: areas.filter((a) => a.validTime === time) };
}

let cache: { at: number; data: Promise<TcfArea[]> } | null = null;

export function fetchTcf(): Promise<TcfArea[]> {
  if (cache && Date.now() - cache.at < 5 * 60 * 1000) return cache.data;
  const data = (async (): Promise<TcfArea[]> => {
    if (!navigator.onLine) return [];
    try {
      const res = await fetch('/api/tcf');
      if (!res.ok) return [];
      const json = await res.json();
      return (json.areas || []) as TcfArea[];
    } catch {
      return [];
    }
  })();
  cache = { at: Date.now(), data };
  return data;
}
