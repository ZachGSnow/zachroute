// NASA FIRMS fire detections -> /api/fires, and the airport summary, against a real MODIS 24-hour
// file captured 2026-10-16 (trimmed to fires around Palembang, Indonesia plus a few elsewhere).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pagesContext, readFixture, stubFetch } from './helpers';
import { onRequest as fires, parseFires } from '../functions/api/fires';
import { summarizeFiresNear, boxAround } from '../src/ts/fires';
import { compassPoint } from '../src/ts/forecast';

const json = async (res: Response) => JSON.parse(await res.text());
const csv = () => readFixture('firms-modis-24h.csv');
const SUMATRA = { minLat: -5, minLon: 102, maxLat: -1, maxLon: 107 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NASA FIRMS -> /api/fires', () => {
  it('keeps confident detections inside the box, most intense first', () => {
    const rows = csv().trim().split('\n').slice(1).map((l) => l.split(','));
    const inBox = rows.filter(([lat, lon]) => +lat >= -5 && +lat <= -1 && +lon >= 102 && +lon <= 107);
    const confident = inBox.filter((r) => +r[8] >= 50);
    expect(confident.length).toBeLessThan(inBox.length); // the fixture has low-confidence rows too

    const out = parseFires(csv(), SUMATRA);
    expect(out).toHaveLength(confident.length);
    for (let i = 1; i < out.length; i++) expect(out[i].frp).toBeLessThanOrEqual(out[i - 1].frp);
    const top = confident.sort((a, b) => +b[11] - +a[11])[0];
    expect(out[0]).toEqual({ lat: +top[0], lon: +top[1], frp: +top[11], time: `${top[5]}T${top[6].slice(0, 2)}:${top[6].slice(2)}:00Z` });
  });

  it('caps the list', () => {
    expect(parseFires(csv(), SUMATRA, 5)).toHaveLength(5);
  });

  it('returns nothing for a box with no fires, or a file it does not recognise', () => {
    expect(parseFires(csv(), { minLat: 60, minLon: 0, maxLat: 61, maxLon: 1 })).toEqual([]);
    // columns in a different order: refuse rather than read longitude as latitude
    expect(parseFires('longitude,latitude,confidence,frp\n-2.9,104.7,90,10\n', SUMATRA)).toEqual([]);
  });

  it('serves a bbox request', async () => {
    stubFetch([['firms.modaps.eosdis.nasa.gov', csv()]]);
    const out = await json(await fires(pagesContext('https://x/api/fires?bbox=-4.5,102.5,-1.2,106.5')));
    expect(out.available).toBe(true);
    expect(out.fires).toHaveLength(parseFires(csv(), SUMATRA).length);
  });

  it('rejects a bad or oversized bbox', async () => {
    stubFetch([['firms', csv()]]);
    expect((await fires(pagesContext('https://x/api/fires?bbox=1,2,3'))).status).toBe(400);
    expect((await fires(pagesContext('https://x/api/fires?bbox=-60,-100,10,10'))).status).toBe(400);
  });

  it('reports unavailable when FIRMS is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const out = await json(await fires(pagesContext('https://x/api/fires?bbox=-4,103,-2,106')));
    expect(out).toEqual({ available: false, fires: [] });
  });
});

describe('fires near an airport', () => {
  const list = () => parseFires(csv(), SUMATRA);

  it('counts detections within 50 mi of Palembang and points to the most intense', () => {
    const plm = { lat: -2.898, lon: 104.7 }; // Sultan Mahmud Badaruddin II
    const s = summarizeFiresNear(plm.lat, plm.lon, list())!;
    expect(s.count).toBeGreaterThan(0);
    expect(s.count).toBeLessThan(list().length);
    expect(s.strongest.miles).toBeLessThanOrEqual(50);
    expect(compassPoint(s.strongest.bearing)).toMatch(/^[NESW]{1,3}$/);
    expect(s.nearestMiles).toBeLessThanOrEqual(s.strongest.miles);
  });

  it('returns null with no detections in range', () => {
    expect(summarizeFiresNear(1.36, 103.99, list())).toBeNull(); // Singapore
  });

  it('builds a box that covers the radius', () => {
    const [minLat, minLon, maxLat, maxLon] = boxAround(60, 11, 50); // Oslo
    expect(maxLat - minLat).toBeCloseTo(100 / 69, 2);
    // a degree of longitude is half as long at 60 degrees, so the box is twice as wide
    expect((maxLon - minLon) / (maxLat - minLat)).toBeCloseTo(2, 1);
  });
});
