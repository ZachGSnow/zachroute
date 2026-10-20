// Live track drawing on top of the aircraft icons (liveLayer.ts): the path each aircraft has flown
// since tracking started, a line one minute ahead along its track, and, when adsb.lol knows the
// flight's route and it fits what the aircraft is doing (routeFits), a dashed great circle to the
// destination. Routes are looked up once per callsign per tracking session.

import { setLiveDrawHooks, type LiveDrawHooks } from './liveLayer';
import { aircraftTypeName } from './aircraftTypes';
import { slerpArc, type Airport } from './geoMath';
import { altitudeColor, extendTrail, pointAhead, routeLeg, routePlaces, type LiveAircraft, type LiveRoute } from './liveTrack';
import { resolveCode } from './searchParser';

const trails = new Map<string, Array<[number, number]>>();
const routes = new Map<string, Promise<LiveRoute | null>>();
const fitting = new Map<string, LiveRoute>();
/** Aircraft whose route lookup has finished, fitting or not. */
const settled = new Set<string>();
let drawn: L.Layer[] = [];
let session = 0;

function lookUpRoute(a: LiveAircraft): Promise<LiveRoute | null> {
  const callsign = a.callsign;
  if (!callsign) return Promise.resolve(null);
  let hit = routes.get(callsign);
  if (!hit) {
    hit = fetch(`/api/live-route?callsign=${encodeURIComponent(callsign)}&lat=${a.lat.toFixed(2)}&lon=${a.lon.toFixed(2)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => (body?.route as LiveRoute) || null)
      .catch(() => null);
    routes.set(callsign, hit);
  }
  return hit;
}

function redraw(map: L.Map, group: L.LayerGroup, aircraft: LiveAircraft[]) {
  for (const layer of drawn) group.removeLayer(layer);
  drawn = [];
  for (const a of aircraft) {
    const color = altitudeColor(a.altFt);
    const trail = trails.get(a.hex) || [];
    if (trail.length > 1) drawn.push(L.polyline(trail, { color, weight: 2, opacity: 0.8, interactive: false }));
    if (a.track != null && a.gs > 0) {
      const ahead = pointAhead([a.lat, a.lon], a.track, a.gs / 60);
      drawn.push(L.polyline([[a.lat, a.lon], ahead], { color, weight: 2, dashArray: '2, 5', opacity: 0.9, interactive: false }));
    }
    const route = fitting.get(a.hex);
    if (route) {
      const dest = route.airports[route.airports.length - 1];
      const arc = slerpArc({ lat: a.lat, lon: a.lon } as Airport, { lat: dest.lat, lon: dest.lon } as Airport, 40).map((p) => [p.lat, p.lon] as [number, number]);
      drawn.push(L.polyline(arc, { color: '#e2e8f0', weight: 1.5, dashArray: '8, 8', opacity: 0.7, interactive: false }));
    }
  }
  for (const layer of drawn) group.addLayer(layer);
  void map;
}

const hooks: LiveDrawHooks = {
  update(map, group, aircraft) {
    const my = session;
    const live = new Set(aircraft.map((a) => a.hex));
    for (const hex of [...trails.keys()]) if (!live.has(hex)) trails.delete(hex);
    for (const a of aircraft) trails.set(a.hex, extendTrail(trails.get(a.hex) || [], [a.lat, a.lon]));
    redraw(map, group, aircraft);
    // Routes arrive later; each is checked against the aircraft's latest position and track.
    for (const a of aircraft) {
      void lookUpRoute(a).then((route) => {
        if (my !== session) return;
        // Only the leg the aircraft is on is shown and drawn.
        const leg = routeLeg(route, [a.lat, a.lon], a.track, a.rate);
        const had = fitting.get(a.hex);
        settled.add(a.hex);
        if (leg) fitting.set(a.hex, leg);
        else fitting.delete(a.hex);
        const changed = !!leg !== !!had || (leg && had && leg.airports[1] !== had.airports[1]);
        if (changed) redraw(map, group, aircraft);
      });
    }
  },
  clear() {
    session += 1;
    trails.clear();
    routes.clear();
    fitting.clear();
    settled.clear();
    drawn = [];
  },
  routeLabel(hex) {
    const r = fitting.get(hex);
    return r ? routePlaces(r, (code) => resolveCode(code)?.city || null) : null;
  },
  routeSettled: (hex) => settled.has(hex),
  typeName: aircraftTypeName,
};

export function initLiveDraw() {
  setLiveDrawHooks(hooks);
}
