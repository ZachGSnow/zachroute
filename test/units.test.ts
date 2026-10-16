import { afterEach, describe, expect, it } from 'vitest';
import { stubBrowser } from './helpers';
import {
  clockOptions,
  convertMiles,
  formatDistance,
  hourOptions,
  setClockFormat,
  setDistanceUnit,
  getDistanceUnit,
  setWeatherUnits,
  defaultWeatherUnits,
  formatTemp,
  formatPressure,
  formatVisibility,
  tempSpread,
  metarVisibilityMetric,
} from '../src/ts/units';

const at = (iso: string, tz: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(new Date(iso));

describe('units', () => {
  afterEach(() => {
    stubBrowser();
    setDistanceUnit('mi');
    setClockFormat('12h');
    setWeatherUnits('us');
  });

  it('defaults to miles and converts for display', () => {
    expect(getDistanceUnit()).toBe('mi');
    expect(formatDistance(886.2)).toBe('886 mi');
    expect(formatDistance(886.2, 'km')).toBe('1,426 km');
    expect(formatDistance(886.2, 'nm')).toBe('770 nm');
    expect(convertMiles(1, 'km')).toBeCloseTo(1.609, 3);
  });

  it('follows the chosen unit and remembers it', () => {
    const store = stubBrowser();
    setDistanceUnit('km');
    expect(formatDistance(100)).toBe('161 km');
    expect(store.get('zachroute:distance-unit')).toBe('km');
  });

  it('formats clock and hour labels in 12 or 24 hours', () => {
    const iso = '2026-10-16T23:40:00Z'; // 6:40 PM in Chicago (CDT)
    expect(at(iso, 'America/Chicago', clockOptions('12h'))).toBe('6:40 PM');
    expect(at(iso, 'America/Chicago', clockOptions('24h'))).toBe('18:40');
    expect(at(iso, 'America/Chicago', hourOptions('12h'))).toBe('6 PM');
    expect(at(iso, 'America/Chicago', hourOptions('24h'))).toBe('18:40');
  });
});

describe('weather units', () => {
  afterEach(() => setWeatherUnits('us'));

  it('defaults to US units only for US-style regions', () => {
    expect(defaultWeatherUnits('en-US')).toBe('us');
    expect(defaultWeatherUnits('es-PR')).toBe('us');
    expect(defaultWeatherUnits('en-GB')).toBe('metric');
    expect(defaultWeatherUnits('pt-BR')).toBe('metric');
    expect(defaultWeatherUnits('de')).toBe('metric');
    expect(defaultWeatherUnits(undefined)).toBe('us');
  });

  it('formats temperature, preferring the reported Celsius value', () => {
    expect(formatTemp(57, 14, 'us')).toBe('57\u00b0F');
    expect(formatTemp(57, 14, 'metric')).toBe('14\u00b0C');
    expect(formatTemp(57, undefined, 'metric')).toBe('14\u00b0C');
    // 14.6 C rounds to 58 F, which converts back to 14.4 C: use the reported value (15)
    expect(formatTemp(58, 14.6, 'metric')).toBe('15\u00b0C');
    // -1 C is reported as 30 F; converting 30 F back would give -1.1, still -1
    expect(formatTemp(30, -1, 'metric')).toBe('-1\u00b0C');
    expect(tempSpread(57, 54, 14, 12, 'metric')).toBe(2);
    expect(tempSpread(57, 54, 14, 12, 'us')).toBe(3);
  });

  it('formats pressure as inHg or QNH hPa', () => {
    expect(formatPressure(29.92, 1013, 'us')).toBe('Altimeter 29.92 inHg');
    expect(formatPressure(29.92, 1013, 'metric')).toBe('QNH 1013 hPa');
    expect(formatPressure(29.92, undefined, 'metric')).toBe('QNH 1013 hPa');
  });

  it('converts statute-mile visibility to km or metres', () => {
    expect(formatVisibility('6+', 'us')).toBe('6+ mi');
    expect(formatVisibility('6+', 'metric')).toBe('9.6+ km');
    expect(formatVisibility('10', 'metric')).toBe('16 km');
    expect(formatVisibility('3', 'metric')).toBe('4,800 m');
    expect(formatVisibility('1 1/2', 'metric')).toBe('2,400 m');
    expect(formatVisibility('1/4', 'metric')).toBe('400 m');
    expect(formatVisibility(0.5, 'metric')).toBe('800 m');
    expect(formatVisibility('1 1/2', 'us')).toBe('1 1/2 mi');
    expect(formatVisibility('M1/4', 'metric')).toBe('M1/4');
  });

  it('reads metric visibility from the METAR group itself', () => {
    expect(metarVisibilityMetric('METAR EGLL 161820Z AUTO 31005KT 9999 NCD 12/05 Q1027')).toBe('10+ km');
    expect(metarVisibilityMetric('METAR LFPG 161800Z 24008KT 210V280 CAVOK 14/09 Q1019 NOSIG')).toBe('10+ km');
    expect(metarVisibilityMetric('METAR EDDF 161750Z 05004KT 0800 FG VV002 08/08 Q1022')).toBe('800 m');
    expect(metarVisibilityMetric('METAR UUEE 161800Z 18003MPS 6000 BR OVC004 07/06 Q1012')).toBe('6 km');
    expect(metarVisibilityMetric('METAR KORD 161751Z 28012G20KT 10SM BKN035 14/04 A3002')).toBeUndefined();
    expect(metarVisibilityMetric(undefined)).toBeUndefined();
  });

  it('follows the chosen setting and remembers it', () => {
    const store = stubBrowser();
    setWeatherUnits('metric');
    expect(formatTemp(57, 14)).toBe('14\u00b0C');
    expect(formatVisibility('6+')).toBe('9.6+ km');
    expect(store.get('zachroute:weather-units')).toBe('metric');
  });
});
