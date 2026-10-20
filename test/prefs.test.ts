// Route drawing and airport card choices (Settings, On a route and Airport cards), and the folded
// alerts summary built from real NWS alerts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonFixture, loadAirportSubset, stubBrowser, stubFetch } from './helpers';
import { alertsStartOpen, readFlag, routeDraw, sectionStartsOpen, writePref, PREF_CHANGED } from '../src/ts/prefs';
import { alertsSummary, nwsAlertChips, type Chip } from '../src/ts/advisories';
import { FEATURES } from '../src/ts/features';

let events: string[] = [];
beforeEach(() => {
  stubBrowser();
  events = [];
  vi.stubGlobal('window', { dispatchEvent: (e: Event) => events.push(e.type) });
});

describe('route drawing choices', () => {
  it('draws everything and focuses on the route until told otherwise', () => {
    expect(routeDraw()).toEqual({ advisories: true, pireps: true, cyclones: true, tfrs: true, focus: true });
    writePref('route-pireps', 'false');
    writePref('route-focus', 'false');
    expect(routeDraw()).toEqual({ advisories: true, pireps: false, cyclones: true, tfrs: true, focus: false });
    expect(events).toEqual([PREF_CHANGED, PREF_CHANGED]);
  });

  it('defaults in the settings window match what the readers assume', () => {
    for (const f of FEATURES.filter((f) => f.pref)) {
      const { key, default: fallback } = f.pref!;
      if (key.startsWith('route-')) expect(fallback).toBe('true');
      if (key.startsWith('card-open-')) expect(fallback).toBe('false');
    }
    expect(FEATURES.find((f) => f.id === 'card-photo')!.pref!.default).toBe('true');
    expect(readFlag('card-photo', true)).toBe(true);
  });
});

describe('airport card choices', () => {
  it('opens alerts when one is urgent, or always, or never', () => {
    expect([alertsStartOpen(true), alertsStartOpen(false)]).toEqual([true, false]);
    writePref('card-alerts', 'open');
    expect([alertsStartOpen(true), alertsStartOpen(false)]).toEqual([true, true]);
    writePref('card-alerts', 'folded');
    expect([alertsStartOpen(true), alertsStartOpen(false)]).toEqual([false, false]);
  });

  it('keeps sections folded unless set to start open', () => {
    expect(sectionStartsOpen('runways')).toBe(false);
    writePref('card-open-runways', 'true');
    expect(sectionStartsOpen('runways')).toBe(true);
    expect(sectionStartsOpen('navaids')).toBe(false);
  });
});

describe('folded alerts summary', () => {
  it('counts the alerts and shows the worst grade from real NWS alerts', async () => {
    const fixture = jsonFixture('nws-alerts.json');
    stubFetch([['api.weather.gov/alerts/active', fixture]]);
    const chips = await nwsAlertChips({ ...loadAirportSubset().DEN, lat: 39.9, lon: -104.6 });
    expect(chips.length).toBeGreaterThan(0);
    const grades: Record<string, string> = { Extreme: 'Extreme', Severe: 'Severe', Moderate: 'Moderate', Minor: 'Light' };
    const worst = ['Extreme', 'Severe', 'Moderate', 'Minor'].find((s) => fixture.features.slice(0, 50).some((f: any) => f.properties.severity === s && chips.some((c) => c.text === f.properties.event)));
    const summary = alertsSummary(chips);
    expect(summary).toContain(`${chips.length} alert${chips.length === 1 ? '' : 's'}`);
    if (worst) expect(summary).toContain(`>${grades[worst]}</span>`);
  });

  it('leaves out the grade when no alert has one (FAA delays)', () => {
    const delays: Chip[] = [{ level: 'warn', text: 'Departure delays' }];
    expect(alertsSummary(delays)).toBe('\u26a0\ufe0f 1 alert');
    expect(alertsSummary([...delays, { level: 'alert', text: 'Ash', severity: 4 }])).toMatch(/2 alerts <span class="sev-badge"[^>]*>Extreme<\/span>$/);
  });
});
