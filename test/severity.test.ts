import { describe, expect, it } from 'vitest';
import { chipLevel, fireSeverity, pirepCodeSeverity, severityColor, severityLegendItems, severityName } from '../src/ts/severity';
import { severityBadge } from '../src/ts/severityBadge';
import { summarizePirep } from '../src/ts/pirepText';
import { fireLegend, pirepLegend } from '../src/ts/legends';

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
