import { afterEach, describe, expect, it } from 'vitest';
import { stubBrowser } from './helpers';
import { clockOptions, convertMiles, formatDistance, hourOptions, setClockFormat, setDistanceUnit, getDistanceUnit } from '../src/ts/units';

const at = (iso: string, tz: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(new Date(iso));

describe('units', () => {
  afterEach(() => {
    stubBrowser();
    setDistanceUnit('mi');
    setClockFormat('12h');
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
