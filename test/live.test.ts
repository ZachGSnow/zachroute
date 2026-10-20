// Live track against real adsb.lol answers captured 2026-10-20: aircraft within 4.34 nm (5 statute
// miles) of O'Hare from /v2/point (some on the ground, some on approach), the same circle from the
// re-api (4.9 nm, all of it and above 1,500 ft barometric), and the route adsb.lol gave for AAL1696,
// which was landing at ORD at the time but is listed as DFW to CLT.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonFixture, pagesContext, stubFetch } from './helpers';
import { onRequest as liveFn, parseLiveQuery, selectAircraft, upstreamArea, upstreamUrl, retryAfterSeconds, resetLiveState, MAX_AIRCRAFT, DEFAULT_AIRCRAFT, NM_PER_MI, type LiveQuery } from '../functions/api/live';
import { onRequest as routeFn, parseRoute, cleanCallsign } from '../functions/api/live-route';
import { routeFits, routeLeg, routeLabel, routePlaces, verticalLabel, pointAhead, distanceNm, extendTrail, liveQuery, altitudeColor, liveLegend, ALTITUDE_BANDS, TRAIL_POINTS } from '../src/ts/liveTrack';
import { aircraftTypeName } from '../src/ts/aircraftTypes';

const point = jsonFixture('adsblol-point-ord-4nm.json');
const circle = jsonFixture('adsblol-reapi-circle-ord.json');
const circleAbove = jsonFixture('adsblol-reapi-circle-ord-above1500.json');
const route = jsonFixture('adsblol-route-aal1696.json');
const ORD: [number, number] = [41.97, -87.9];
const q = (over: Partial<LiveQuery> = {}): LiveQuery => ({ lat: ORD[0], lon: ORD[1], mi: 5, minFt: 0, minKt: 0, elevFt: 680, max: DEFAULT_AIRCRAFT, keep: [], ...over });
const json = async (res: Response) => JSON.parse(await res.text());

describe('which aircraft are tracked', () => {
  it('drops aircraft on the ground and keeps at most 5, closest first', () => {
    const onGround = point.ac.filter((a: any) => a.alt_baro === 'ground').length;
    expect(onGround).toBeGreaterThan(0);
    const { aircraft, qualifying } = selectAircraft(point, q());
    expect(qualifying).toBeLessThanOrEqual(point.ac.length - onGround);
    expect(aircraft.length).toBe(Math.min(DEFAULT_AIRCRAFT, qualifying));
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
    expect(upstreamArea(q({ lat: 41.97321, lon: -87.90488, mi: 5 }))).toEqual({ lat: 41.97, lon: -87.9, nm: 4.9, floorFt: null });
  });

  it('reads the re-api answer and shows up to 10 when asked', () => {
    expect(circle.aircraft.length).toBe(circle.resultCount);
    const five = selectAircraft(circle, q());
    const ten = selectAircraft(circle, q({ max: 10 }));
    expect(five.aircraft.length).toBe(Math.min(5, five.qualifying));
    expect(ten.aircraft.length).toBe(Math.min(10, ten.qualifying));
    expect(ten.aircraft.slice(0, 5)).toEqual(five.aircraft);
  });

  it('asks adsb.lol to leave out aircraft well below the height set', () => {
    // 680 ft ground + 2,000 ft wanted - 1,000 ft margin, down to a step of 500
    const area = upstreamArea(q({ minFt: 2000 }));
    expect(area.floorFt).toBe(1500);
    expect(upstreamUrl(area)).toBe('https://re-api.adsb.lol/?circle=41.97,-87.9,4.9&above_alt_baro=1500');
    expect(upstreamUrl(upstreamArea(q({ minFt: 500 })))).toBe('https://re-api.adsb.lol/?circle=41.97,-87.9,4.9');
    // the real answer to that floor holds only aircraft above it, and the local cut keeps working
    expect(circleAbove.aircraft.every((a: any) => typeof a.alt_baro === 'number' && a.alt_baro >= 1500)).toBe(true);
    expect(selectAircraft(circleAbove, q({ minFt: 2000 })).aircraft.every((a) => a.aglFt >= 2000)).toBe(true);
  });

  it('clamps the query to what the feature allows', () => {
    const p = parseLiveQuery(new URLSearchParams('lat=41.9&lon=-87.9&mi=40&minft=-5&minkt=999&max=50&keep=a11a84,nothex,ABCDEF'))!;
    expect([p.mi, p.minFt, p.minKt, p.max]).toEqual([15, 0, 300, MAX_AIRCRAFT]);
    expect(parseLiveQuery(new URLSearchParams('lat=1&lon=1&max=2'))!.max).toBe(DEFAULT_AIRCRAFT);
    expect(parseLiveQuery(new URLSearchParams('lat=1&lon=1'))!.max).toBe(DEFAULT_AIRCRAFT);
    expect(p.keep).toEqual(['a11a84', 'abcdef']);
    expect(parseLiveQuery(new URLSearchParams('lat=91&lon=0'))).toBeNull();
    expect(parseLiveQuery(new URLSearchParams('mi=5'))).toBeNull();
  });
});

describe('/api/live', () => {
  beforeEach(() => resetLiveState());

  it('asks the re-api with the key in x-api-key about the rounded area and returns the selection', async () => {
    const { fn, calls } = stubFetch([['re-api.adsb.lol/?circle=', circle]]);
    const ctx = pagesContext('https://x/api/live?lat=41.97321&lon=-87.90488&mi=5&minft=0&minkt=0&elev=680');
    ctx.env.ADSBLOL_API_KEY = 'test-key';
    const out = await json(await liveFn(ctx));
    expect(calls[0]).toBe('https://re-api.adsb.lol/?circle=41.97,-87.9,4.9');
    expect((fn.mock.calls[0][1] as any).headers['x-api-key']).toBe('test-key');
    expect(out.aircraft.length).toBeGreaterThan(0);
    expect(out.license).toContain('ODbL');
    expect(JSON.stringify(out)).not.toContain('test-key');
  });

  it('is off without a key and says nothing about the upstream on failure', async () => {
    expect((await liveFn(pagesContext('https://x/api/live?lat=1&lon=1'))).status).toBe(503);
    stubFetch([['re-api.adsb.lol', { status: 'x' }]]);
    const ctx = pagesContext('https://x/api/live?lat=10.5&lon=10.5');
    ctx.env.ADSBLOL_API_KEY = 'test-key';
    const res = await liveFn(ctx);
    expect(res.status).toBe(200); // a body without aircraft is simply none in the air
    expect((await json(res)).aircraft).toEqual([]);
  });
});

describe('when adsb.lol says wait (429)', () => {
  beforeEach(() => resetLiveState());

  const ctx = (url: string) => {
    const c = pagesContext(url);
    c.env.ADSBLOL_API_KEY = 'test-key';
    return c;
  };

  it('reads Retry-After in seconds or as a date', () => {
    expect(retryAfterSeconds('30')).toBe(30);
    expect(retryAfterSeconds(null)).toBe(60);
    expect(retryAfterSeconds(new Date(Date.now() + 90_000).toUTCString())).toBeGreaterThanOrEqual(89);
    expect(retryAfterSeconds('999999')).toBe(3600);
  });

  it('serves the last answer marked busy, and asks nothing until the wait is over', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T19:00:00Z'));
    stubFetch([['re-api.adsb.lol', circle]]);
    const url = 'https://x/api/live?lat=41.97&lon=-87.9&mi=5';
    expect((await json(await liveFn(ctx(url)))).busy).toBeUndefined();

    vi.setSystemTime(new Date('2026-10-20T19:00:10Z')); // past the 8 s reuse
    const limited = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    vi.stubGlobal('fetch', limited);
    const busy = await json(await liveFn(ctx(url)));
    expect(busy.busy).toBe(true);
    expect(busy.retryIn).toBe(30);
    expect(busy.aircraft.length).toBeGreaterThan(0);

    vi.setSystemTime(new Date('2026-10-20T19:00:25Z'));
    const again = await liveFn(ctx(url));
    expect((await json(again)).retryIn).toBe(15);
    expect(limited).toHaveBeenCalledTimes(1);

    // another area with nothing to fall back on gets a plain 429
    const other = await liveFn(ctx('https://x/api/live?lat=40.64&lon=-73.78&mi=5'));
    expect(other.status).toBe(429);
    expect((await json(other)).retryIn).toBe(15);
    vi.useRealTimers();
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

describe('names and legend', () => {
  it('names the types seen in the captured traffic, and leaves unknown codes alone', () => {
    const codes = [...new Set(point.ac.map((a: any) => a.t).filter(Boolean))] as string[];
    expect(codes.length).toBeGreaterThan(3);
    expect(codes.filter((c) => !aircraftTypeName(c))).toEqual([]);
    expect(aircraftTypeName('b738')).toBe('Boeing 737-800');
    expect(aircraftTypeName('ZZZZ')).toBeNull();
    expect(aircraftTypeName(undefined)).toBeNull();
  });

  it('shows each altitude band in the color the icons use', () => {
    const legend = liveLegend();
    for (const [ft] of ALTITUDE_BANDS) expect(legend.items.map((i) => i.color)).toContain(altitudeColor(ft));
    expect(legend.note).toContain('ODbL');
  });
});

describe('route and request wording', () => {
  it('names origin and destination by city where the app knows the airport', () => {
    const r = parseRoute('AAL1696', route)!;
    const cities: Record<string, string> = { DFW: 'Dallas-Fort Worth' };
    expect(routePlaces(r, (code) => cities[code] || null)).toBe('Dallas-Fort Worth (DFW) to Charlotte Douglas International Airport (CLT)');
  });

  it('asks for the number of aircraft set', () => {
    expect(liveQuery({ lat: 41.97, lon: -87.9, mi: 5, minFt: 500, minKt: 60, elevFt: 680, max: 8, keep: [] })).toContain('&max=8');
  });
});

describe('multi-leg routes', () => {
  // Routes often go out and back (ORD to MSN to ORD); seen on 2026-10-20 as "Chicago to Chicago".
  const ordAp = { iata: 'ORD', lat: 41.9786, lon: -87.9048 };
  const msnAp = { iata: 'MSN', lat: 43.1399, lon: -89.3375 };
  const outAndBack = { callsign: 'SKW4927', airports: [ordAp, msnAp, ordAp] };
  const toMsn = bearingDegOf([ordAp.lat, ordAp.lon], [msnAp.lat, msnAp.lon]);

  function bearingDegOf(a: [number, number], b: [number, number]) {
    const r = (d: number) => (d * Math.PI) / 180;
    const y = Math.sin(r(b[1] - a[1])) * Math.cos(r(b[0]));
    const x = Math.cos(r(a[0])) * Math.sin(r(b[0])) - Math.sin(r(a[0])) * Math.cos(r(b[0])) * Math.cos(r(b[1] - a[1]));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  it('picks the outbound leg for an aircraft climbing out toward the next stop', () => {
    const pos = pointAhead([ordAp.lat, ordAp.lon], toMsn, 8);
    const leg = routeLeg(outAndBack, pos, toMsn, 1500)!;
    expect(routeLabel(leg)).toBe('ORD to MSN');
  });

  it('picks the inbound leg for an aircraft descending into the airport', () => {
    const pos = pointAhead([ordAp.lat, ordAp.lon], toMsn, 20);
    const leg = routeLeg(outAndBack, pos, (toMsn + 200) % 360, -1000)!; // turning onto final
    expect(routeLabel(leg)).toBe('MSN to ORD');
  });

  it('does not take the near-destination shortcut for a climbing aircraft heading away', () => {
    const pos = pointAhead([ordAp.lat, ordAp.lon], (toMsn + 180) % 360, 10);
    expect(routeLeg(outAndBack, pos, (toMsn + 180) % 360, 2000)).toBeNull();
    expect(routeLeg({ callsign: 'X', airports: [ordAp, ordAp] }, [ordAp.lat, ordAp.lon], 0, -500)).toBeNull();
  });
});
