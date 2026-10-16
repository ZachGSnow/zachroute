// Open-Meteo air quality, against real responses captured 2026-10-16 18:00 UTC.
import { describe, expect, it } from 'vitest';
import { jsonFixture } from './helpers';
import { parseAirQuality, aqiCategory, aqiScaleFor, hazeNote, worseningAhead, type AirQuality } from '../src/ts/airQuality';

const load = (code: string) => parseAirQuality(jsonFixture(`open-meteo-aq-${code}.json`))!;

describe('air quality', () => {
  it('reads current values and the hours from now on', () => {
    const del = load('del');
    const raw = jsonFixture('open-meteo-aq-del.json');
    expect(del.time).toBe('2026-10-16T18:00:00Z');
    expect(del.usAqi).toBe(raw.current.us_aqi);
    expect(del.euAqi).toBe(raw.current.european_aqi);
    expect(del.pm25).toBe(raw.current.pm2_5);
    expect(del.aod).toBe(raw.current.aerosol_optical_depth);
    expect(del.hours[0].time).toBe('2026-10-16T18:00:00Z');
    expect(del.hours.every((h) => h.time >= del.time)).toBe(true);
  });

  it('returns null without a current block', () => {
    expect(parseAirQuality({ error: true, reason: 'bad request' })).toBeNull();
  });

  it('bands the US and European indexes', () => {
    expect(aqiCategory(180, 'us')).toEqual({ label: 'Unhealthy', level: 3 });
    expect(aqiCategory(50, 'us')).toEqual({ label: 'Good', level: 0 });
    expect(aqiCategory(51, 'us').label).toBe('Moderate');
    expect(aqiCategory(320, 'us').label).toBe('Hazardous');
    expect(aqiCategory(29, 'eu')).toEqual({ label: 'Fair', level: 1 });
    expect(aqiCategory(116, 'eu').label).toBe('Extremely poor');
  });

  it('uses the European index for European airports only', () => {
    expect(aqiScaleFor('GB')).toBe('eu');
    expect(aqiScaleFor('DE')).toBe('eu');
    expect(aqiScaleFor('IN')).toBe('us');
    expect(aqiScaleFor('US')).toBe('us');
    expect(aqiScaleFor(undefined)).toBe('us');
  });

  it('notes haze when the air column is hazy, and stays quiet when it is clear', () => {
    expect(hazeNote(load('del'))).toMatch(/^Hazy/); // optical depth 0.64
    expect(hazeNote(load('syd'))).toBeNull(); // 0.12
    expect(hazeNote({ ...load('pek'), aod: 1.1 })).toMatch(/^Thick haze/);
    expect(hazeNote({ ...load('syd'), dust: 450 })).toMatch(/^Dusty/);
  });

  it('warns only when a coming hour falls in a worse category', () => {
    // Beijing: 159 now, up to 190 within 12 h, still "Unhealthy": no warning
    expect(worseningAhead(load('pek'), 'us')).toBeNull();
    // Sydney with one hour pushed into "Unhealthy for sensitive groups"
    const syd = load('syd');
    const hours = syd.hours.map((h, i) => (i === 5 ? { ...h, usAqi: 130 } : h));
    const ahead = worseningAhead({ ...syd, hours } as AirQuality, 'us');
    expect(ahead?.value).toBe(130);
    expect(ahead?.category.label).toBe('Unhealthy for sensitive groups');
    expect(ahead?.hour.time).toBe(hours[5].time);
    // ...but not for a small rise that only just crosses a band edge (London: 40 -> 42)
    const edge = { ...syd, euAqi: 40, hours: syd.hours.map((h, i) => (i === 3 ? { ...h, euAqi: 42 } : { ...h, euAqi: 40 })) };
    expect(worseningAhead(edge as AirQuality, 'eu')).toBeNull();
    // ...and not when that hour is more than 12 hours out
    const late = syd.hours.map((h, i) => (i === 20 ? { ...h, usAqi: 130 } : h));
    expect(worseningAhead({ ...syd, hours: late } as AirQuality, 'us')).toBeNull();
  });
});
