// Settings that the settings window stores itself (route drawing and airport card choices), as
// opposed to the map layers main.ts wires. Readers call readPref/readFlag when they draw; the
// window fires PREF_CHANGED after a change. Storage can be missing (private mode): defaults apply.

export const PREF_CHANGED = 'zachroute:pref-changed';

export function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`zachroute:${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

export function readFlag(key: string, fallback: boolean): boolean {
  const v = readPref(key, fallback ? 'true' : 'false');
  return v === 'true';
}

export function writePref(key: string, value: string) {
  try {
    localStorage.setItem(`zachroute:${key}`, value);
  } catch {
    /* convenience only */
  }
  window.dispatchEvent(new CustomEvent(PREF_CHANGED, { detail: { key, value } }));
}

/** Which kinds of hazard to draw along a route, and whether the full layers step aside. */
export interface RouteDraw {
  advisories: boolean;
  pireps: boolean;
  cyclones: boolean;
  tfrs: boolean;
  focus: boolean;
}

export function routeDraw(): RouteDraw {
  return {
    advisories: readFlag('route-advisories', true),
    pireps: readFlag('route-pireps', true),
    cyclones: readFlag('route-cyclones', true),
    tfrs: readFlag('route-tfrs', true),
    focus: readFlag('route-focus', true),
  };
}

export type AlertsMode = 'auto' | 'open' | 'folded';

/** Whether an alert list starts open: always, never, or (auto) when one is Severe or Extreme. */
export function alertsStartOpen(urgent: boolean): boolean {
  const mode = readPref('card-alerts', 'auto') as AlertsMode;
  return mode === 'open' || (mode !== 'folded' && urgent);
}

/** Whether a folding card section starts open. */
export const sectionStartsOpen = (section: string) => readFlag(`card-open-${section}`, false);
