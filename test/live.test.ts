// Live track against real adsb.lol answers captured 2026-10-20: aircraft within 4.34 nm (5 statute
// miles) of O'Hare (some on the ground, some on approach), and the route adsb.lol gave for AAL1696,
// which was landing at ORD at the time but is listed as DFW to CLT.
import { describe, expect, it } from 'vitest';
import { jsonFixture, pagesContext, stubFetch } from './helpers';
import { onRequest as liveFn, parseLiveQuery, selectAircraft, upstreamArea, MAX_AIRCRAFT, NM_PER_MI, type LiveQuery } from '../functions/api/live';
import { onRequest as routeFn, parseRoute, cleanCallsign } from '../functions/api/live-route';
import { routeFits, routeLabel, verticalLabel, pointAhead, distanceNm, extendTrail, liveQuery, altitudeColor, TRAIL_POINTS } from '../src/ts/liveTrack';

const point = jsonFixture('adsblol-point-ord-4nm.json');
const route = jsonFixture('adsblol-route-aal1696.json');
const ORD: [number, number] = [41.97, -87.9];
const q = (over: Partial<LiveQuery> = {}): LiveQuery => ({ lat: ORD[0], lon: ORD[1], mi: 5, minFt: 0, minKt: 0, elevFt: 680, keep: [], ...over });
const json = async (res: Response) => JSON.parse(await res.text());

describe('which aircraft are tracked', () => {
  it('drops aircraft on the ground and keeps at most 5, closest first', () => {
    const onGround = point.ac.filter((a: any) => a.alt_baro === 'ground').length;
    expect(onGround).toBeGreaterThan(0);
    const { aircraft, qualifying } = selectAircraft(point, q());
    expect(qualifying).toBeLessThanOrEqual(point.ac.length - onGround);
    expect(aircraft.length).toBe(Math.min(MAX_AIRCRAFT, qualifying));
    for (let i = 1; i < aircraft.length; i++) expect(aircraft[i].distNm).toBeGreaterThanOrEqual(aircraft[i - 1].distNm);
    expect(aircraft.every((a) => a.distNm <= 5 * NM_PER_MI)).toBe(true);
    expect(aircraft[0].callsign).not.toMatch(/\s$/);
  });

  it('cuts aircraft below the height and speed set', () => {
    const all = selectAircraft(point, q()).qualifying;
    const high = selectAircraft(point, q({ minFt: 500, minKt: 60 }));
    expect(high.qualifying).toBeLessThanOrEqual(all);
    expect(high.aircraft.every((a) => a.aglFt >= 500 && a.gs >= 60)).toBe(true);
    // AAL1696 was on short final at about 700 ft GNSS, about 20 ft above O'Hare
    expect(selectAircraft(point, q({ minFt: 100 })).aircraft.some((a) => a.callsign === 'AAL1696')).toBe(false);
  });

  it('keeps already tracked aircraft ahead of closer newcomers', () => {
    const { aircraft } = selectAircraft(point, q());
    const farthest = aircraft[aircraft.length - 1];
    const sticky = selectAircraft(point, q({ keep: [farthest.hex] }));
    expect(sticky.aircraft[0].hex).toBe(farthest.hex);
  });

  it('only searches inside a small radius', () => {
    expect(selectAircraft(point, q({ mi: 1 })).aircraft.every((a) => a.distNm <= NM_PER_MI)).toBe(true);
    expect(upstreamArea(q({ lat: 41.97321, lon: -87.90488, mi: 5 }))).toEqual({ lat: 41.97, lon: -87.9, nm: 4.9 });
  });

  it('clamps the query to what the feature allows', () => {
    const p = parseLiveQuery(new URLSearchParams('lat=41.9&lon=-87.9&mi=40&minft=-5&minkt=999&keep=a11a84,nothex,ABCDEF'))!;
    expect([p.mi, p.minFt, p.minKt]).toEqual([15, 0, 300]);
    expect(p.keep).toEqual(['a11a84', 'abcdef']);
    expect(parseLiveQuery(new URLSearchParams('lat=91&lon=0'))).toBeNull();
    expect(parseLiveQuery(new URLSearchParams('mi=5'))).toBeNull();
  });
});

describe('/api/live', () => {
  it('asks adsb.lol with the key in x-api-key about the rounded area and returns the selection', async () => {
    const { fn, calls } = stubFetch([['api.adsb.lol/v2/point/', point]]);
    const ctx = pagesContext('https://x/api/live?lat=41.97321&lon=-87.90488&mi=5&minft=0&minkt=0&elev=680');
    ctx.env.ADSBLOL_API_KEY = 'test-key';
    const out = await json(await liveFn(ctx));
    expect(calls[0]).toBe('https://api.adsb.lol/v2/point/41.97/-87.9/4.9');
    expect((fn.mock.calls[0][1] as any).headers['x-api-key']).toBe('test-key');
    expect(out.aircraft.length).toBeGreaterThan(0);
    expect(out.license).toContain('ODbL');
    expect(JSON.stringify(out)).not.toContain('test-key');
  });

  it('is off without a key and says nothing about the upstream on failure', async () => {
    expect((await liveFn(pagesContext('https://x/api/live?lat=1&lon=1'))).status).toBe(503);
    stubFetch([['api.adsb.lol', { status: 'x' }]]);
    const ctx = pagesContext('https://x/api/live?lat=10.5&lon=10.5');
    ctx.env.ADSBLOL_API_KEY = 'test-key';
    const res = await liveFn(ctx);
    expect(res.status).toBe(200); // a body without aircraft is simply none in the air
    expect((await json(res)).aircraft).toEqual([]);
  });
});

describe('where a flight is going', () => {
  it('reads the airports of a route', () => {
    const r = parseRoute('AAL1696', route)!;
    expect(routeLabel(r)).toBe('DFW to CLT');
    expect(parseRoute('N170PT', { airport_codes: 'unknown', _airports: [] })).toBeNull();
    expect(cleanCallsign(' aal1696 ')).toBe('AAL1696');
    expect(cleanCallsign('AAL 1696')).toBeNull();
  });

  it('rejects a route the aircraft is not flying (adsb.lol called this one plausible)', () => {
    const aal = point.ac.find((a: any) => a.flight?.trim() === 'AAL1696');
    expect(route.plausible).toBe(true);
    expect(routeFits(parseRoute('AAL1696', route), [aal.lat, aal.lon], aal.track)).toBe(false);
  });

  it('accepts a route the aircraft is on, heading the right way', () => {
    const r = parseRoute('AAL1696', route)!;
    const dfw: [number, number] = [r.airports[0].lat, r.airports[0].lon];
    const clt: [number, number] = [r.airports[1].lat, r.airports[1].lon];
    const midway = pointAhead(dfw, 72, distanceNm(dfw, clt) / 2);
    expect(routeFits(r, midway, 75)).toBe(true);
    expect(routeFits(r, midway, 255)).toBe(false); // flying away from Charlotte
    expect(routeFits(r, pointAhead(clt, 250, 20), 160)).toBe(true); // turning onto the approach
  });

  it('asks adsb.lol once per callsign with the key', async () => {
    const { calls, fn } = stubFetch([['api.adsb.lol/api/0/route/', route]]);
    const ctx = () => {
      const c = pagesContext('https://x/api/live-route?callsign=AAL1696&lat=41.96568&lon=-87.93719');
      c.env.ADSBLOL_API_KEY = 'test-key';
      return c;
    };
    const first = await json(await routeFn(ctx()));
    await routeFn(ctx());
    expect(first.route.airports.map((a: any) => a.iata)).toEqual(['DFW', 'CLT']);
    expect(calls).toEqual(['https://api.adsb.lol/api/0/route/AAL1696/41.97/-87.94']);
    expect((fn.mock.calls[0][1] as any).headers['x-api-key']).toBe('test-key');
  });
});

describe('drawing helpers', () => {
  it('labels climb and descent, colors by altitude and keeps a short path', () => {
    expect(verticalLabel(-832)).toBe('Descending 800 ft/min');
    expect(verticalLabel(1250)).toBe('Climbing 1,300 ft/min');
    expect(verticalLabel(120)).toBe('Level');
    expect(altitudeColor(700)).not.toBe(altitudeColor(35000));
    let trail: Array<[number, number]> = [];
    for (let i = 0; i < TRAIL_POINTS + 10; i++) trail = extendTrail(trail, [41 + i / 1000, -87]);
    expect(trail).toHaveLength(TRAIL_POINTS);
    expect(extendTrail(trail, trail[trail.length - 1])).toBe(trail);
  });

  it('builds the request with the settings and tracked aircraft', () => {
    expect(liveQuery({ lat: 41.973214, lon: -87.904881, mi: 5, minFt: 500, minKt: 60, elevFt: 680.4, keep: ['a11a84'] })).toBe(
      'lat=41.97321&lon=-87.90488&mi=5&minft=500&minkt=60&elev=680&keep=a11a84'
    );
  });
});
