import { describe, expect, it } from 'vitest';
import { stationTemp, tempColor } from '../src/ts/stationTemp';

describe('weather stations temperature view', () => {
  it('colors cold to hot, clamped at both ends', () => {
    expect(tempColor(-40)).toBe(tempColor(-30));
    expect(tempColor(0)).toBe('#38bdf8');
    expect(tempColor(20)).toBe('#facc15');
    expect(tempColor(55)).toBe(tempColor(40));
    expect(tempColor(5)).not.toBe(tempColor(0)); // blended between stops
  });

  it('labels in the chosen units', () => {
    expect(stationTemp(7.2, 2.8, 'us')?.label).toBe('45°');
    expect(stationTemp(7.2, 2.8, 'metric')?.label).toBe('7°');
    expect(stationTemp(7.2, 2.8, 'metric')?.detail).toBe('7°C, dewpoint 3°C');
  });

  it('marks freezing at or below 0 C', () => {
    expect(stationTemp(0, -5, 'metric')?.freezing).toBe(true);
    expect(stationTemp(-3.5, -6, 'us')?.freezing).toBe(true);
    expect(stationTemp(0.4, -5, 'metric')?.freezing).toBe(false);
  });

  it('marks fog risk with the same spread the airport card uses (3 C / 5 F)', () => {
    expect(stationTemp(10, 7, 'metric')?.fogRisk).toBe(true);
    expect(stationTemp(10, 6, 'metric')?.fogRisk).toBe(false);
    expect(stationTemp(10, 7.5, 'us')?.fogRisk).toBe(true); // 4.5 F spread
    expect(stationTemp(10, undefined, 'us')?.fogRisk).toBe(false);
  });

  it('returns nothing for a station without a temperature', () => {
    expect(stationTemp(undefined, 3)).toBeNull();
  });
});
