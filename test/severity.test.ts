import { describe, expect, it } from 'vitest';
import { advisorySeverity, chipLevel, cycloneSeverity, fireSeverity, pirepCodeSeverity, severityColor, severityLegendItems, severityName, tfrSeverity } from '../src/ts/severity';
import { peakWind } from '../functions/api/cyclones';
import { severityBadge } from '../src/ts/severityBadge';
import { summarizePirep } from '../src/ts/pirepText';
import { cycloneLegend, fireLegend, hazardLegend, pirepLegend, tfrLegend } from '../src/ts/legends';

describe('severity ladder', () => {
  it('names and colors four levels', () => {
    expect([1, 2, 3, 4].map((s) => severityName(s as 1))).toEqual(['Light', 'Moderate', 'Severe', 'Extreme']);
    expect(severityColor(4)).toBe('#d946ef');
    expect(chipLevel(2)).toBe('warn');
    expect(chipLevel(3)).toBe('alert');
    expect(severityLegendItems([1, 3]).map((i) => i.label)).toEqual(['Light', 'Severe']);
    expect(severityBadge(3)).toContain('>Severe<');
  });

  it('maps pilot report intensity codes', () => {
    expect(pirepCodeSeverity('LGT')).toBe(1);
    expect(pirepCodeSeverity('TRC')).toBe(1);
    expect(pirepCodeSeverity('LGT-MOD')).toBe(2);
    expect(pirepCodeSeverity('MOD')).toBe(2);
    expect(pirepCodeSeverity('MOD-SEV')).toBe(3);
    expect(pirepCodeSeverity('SEV')).toBe(3);
    expect(pirepCodeSeverity('EXTRM')).toBe(4);
    expect(pirepCodeSeverity('HVY')).toBe(4);
    expect(pirepCodeSeverity('SEV-EXTRM')).toBe(4); // unlisted: strongest word wins
    expect(pirepCodeSeverity('')).toBeNull();
  });

  it('maps fire radiative power', () => {
    expect([10, 30, 99, 100, 499, 500].map(fireSeverity)).toEqual([1, 2, 2, 3, 3, 4]);
  });
});

describe('pilot reports by severity', () => {
  const base = { obsTime: 0, lat: 0, lon: 0 };

  it('no longer calls moderate turbulence severe', () => {
    const s = summarizePirep({ ...base, turb: 'MOD' })!;
    expect(s.severity).toBe(2);
    expect(s.severe).toBe(false);
  });

  it('takes the worse of turbulence and icing', () => {
    const s = summarizePirep({ ...base, turb: 'LGT', icing: 'SEV' })!;
    expect(s.kind).toBe('both');
    expect(s.severity).toBe(3);
    expect(s.severe).toBe(true);
  });

  it('treats an urgent report as at least severe, and low visibility alone as no severity', () => {
    expect(summarizePirep({ ...base, turb: 'LGT', urgent: true })!.severity).toBe(3);
    expect(summarizePirep({ ...base, visib: 1 })!.severity).toBeNull();
  });
});

describe('severity legends', () => {
  it('pilot reports show the four levels and the shapes', () => {
    const spec = pirepLegend();
    const labels = spec.kind === 'items' ? spec.items.map((i) => i.label) : [];
    expect(labels).toEqual(['Light', 'Moderate', 'Severe', 'Extreme', 'turbulence', 'icing', 'both', 'low visibility']);
  });

  it('fires give the power range for each level', () => {
    const spec = fireLegend();
    expect(spec.kind === 'items' && spec.items[2].label).toBe('Severe, 100-500 MW');
    expect(spec.kind === 'items' && spec.items[2].color).toBe(severityColor(3));
  });
});

describe('severity of advisories, cyclones and TFRs', () => {
  it('rates advisories by type, hazard and wording', () => {
    expect(advisorySeverity({ type: 'AIRMET', hazard: 'IFR' })).toBe(1);
    expect(advisorySeverity({ type: 'AIRMET', hazard: 'MTN OBSCN' })).toBe(1);
    expect(advisorySeverity({ type: 'AIRMET', hazard: 'TURB' })).toBe(2);
    expect(advisorySeverity({ type: 'CWA', hazard: 'CONVECTIVE', detail: 'developing' })).toBe(2);
    expect(advisorySeverity({ type: 'CWA', hazard: 'TURB', detail: 'isolated severe' })).toBe(3);
    expect(advisorySeverity({ type: 'SIGMET', hazard: 'TURB' })).toBe(3);
    expect(advisorySeverity({ type: 'SIGMET', hazard: 'CONVECTIVE', detail: 'isolated' })).toBe(3);
    expect(advisorySeverity({ type: 'SIGMET', hazard: 'CONVECTIVE', detail: 'embedded' })).toBe(4);
    expect(advisorySeverity({ type: 'SIGMET', hazard: 'CONVECTIVE', raw: 'LINE EMBD TS 20 NM WIDE' })).toBe(4);
    expect(advisorySeverity({ type: 'SIGMET', hazard: 'ASH' })).toBe(4);
    expect(advisorySeverity({ type: 'AIRMET', hazard: 'ASH' })).toBe(4);
  });

  it('rates tropical cyclones by class and strongest wind so far', () => {
    expect(cycloneSeverity('TD')).toBe(1);
    expect(cycloneSeverity('TS', 250)).toBe(2);
    expect(cycloneSeverity('HU', 150)).toBe(3);
    expect(cycloneSeverity('HU', 178)).toBe(4);
    expect(cycloneSeverity('TY')).toBe(3);
    expect(cycloneSeverity(undefined)).toBe(2);
  });

  it('reads GDACS peak wind in any unit', () => {
    expect(peakWind({ severity: 249.9984, severityunit: 'km/h' })).toBe(250);
    expect(peakWind({ severity: 100, severityunit: 'kt' })).toBe(185);
    expect(peakWind({ severity: 0, severityunit: 'km/h' })).toBeUndefined();
    expect(peakWind(undefined)).toBeUndefined();
  });

  it('rates TFRs by how restrictive they are', () => {
    expect(tfrSeverity('UAS PUBLIC GATHERING')).toBe(1);
    expect(tfrSeverity('HAZARDS')).toBe(2);
    expect(tfrSeverity('AIR SHOWS/SPORTS')).toBe(2);
    expect(tfrSeverity('SECURITY')).toBe(3);
    expect(tfrSeverity('VIP')).toBe(3);
    expect(tfrSeverity('SPACE OPERATIONS')).toBe(3);
    expect(tfrSeverity('SOMETHING NEW')).toBe(2);
  });

  it('legends explain each level in the layer terms', () => {
    const h = hazardLegend();
    expect(h.kind === 'items' && h.items.slice(0, 4).map((i) => i.color)).toEqual([1, 2, 3, 4].map((s) => severityColor(s as 1)));
    const c = cycloneLegend();
    expect(c.kind === 'items' && c.items[3].label).toBe('Extreme: has reached Category 3+');
    const t = tfrLegend();
    expect(t.kind === 'items' && t.items.map((i) => i.label)).toEqual([
      'Light: drones, to 400 ft',
      'Moderate: hazards, air shows, stadiums',
      'Severe: security, VIP, space launch',
    ]);
  });
});
