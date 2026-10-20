import { describe, expect, it } from 'vitest';
import { jsonFixture } from './helpers';
import { faaChartTileUrl, faaChartInfoUrl, faaChartName, chartUpdated, chartAgeNote, CHART_CYCLE_DAYS } from '../src/ts/faaCharts';

// The FAA VFR sectional tile service's description, captured 2026-10-19 (trimmed to the fields the
// app reads and the zoom range): "Updated with the latest charts on 07-09-2026."
const vfr = jsonFixture<any>('faa-vfr-sectional-service.json');

describe('FAA charts', () => {
  it('points at the FAA tile service for each chart', () => {
    expect(faaChartTileUrl('vfr')).toBe('https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}');
    expect(faaChartTileUrl('ifr')).toContain('/IFR_AreaLow/MapServer/tile/');
    expect(faaChartInfoUrl('ifr')).toContain('/IFR_AreaLow/MapServer?f=json');
    expect(faaChartName('ifr')).toBe('IFR low enroute');
    expect([vfr.minLOD, vfr.maxLOD]).toEqual([8, 12]);
  });

  it('reads when the service was last updated', () => {
    expect(chartUpdated(vfr)).toBe(Date.UTC(2026, 6, 9));
    expect(chartUpdated({})).toBeNull();
  });

  it('says how old the edition is, warning once it is past one chart cycle', () => {
    const updated = Date.UTC(2026, 6, 9);
    expect(chartAgeNote(updated, updated + 10 * 86_400_000)).toBe('edition of 9 Jul 2026');
    expect(chartAgeNote(updated, updated + (CHART_CYCLE_DAYS + 1) * 86_400_000)).toBe('edition of 9 Jul 2026, older than the current one');
    expect(chartAgeNote(null)).toBe('edition date unknown; may be out of date');
  });
});
