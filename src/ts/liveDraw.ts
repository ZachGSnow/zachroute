// Live track drawing on top of the aircraft icons (liveLayer.ts): the path each aircraft has flown
// since tracking started and, when its route is known and fits (routeLeg), the route: a faint
// estimate from the origin to where tracking first saw it, then a line on to the destination with
// a marker. Aircraft without a route get a dotted line one minute ahead instead. Routes are looked
// up once per callsign per tracking session.
//
// Route overview (a button on the card or popup, or tapping a route line) frames the whole leg:
// origin and destination, the flown part muted and the rest bright, the aircraft on it, and a strip
// with distances, a rough time to go, "Weather along this route" (the app's normal route view) and
// "Back to Live track". It asks adsb.lol nothing extra: if the aircraft leaves the Live track
// circle, it stays at its last known position, marked out of range.

import { setLiveDrawHooks, fitLiveCircle, frame, planeIcon, refreshCard, type LiveDrawHooks } from './liveLayer';
import { aircraftTypeName } from './aircraftTypes';
import { slerpArc, type Airport } from './geoMath';
import { formatDistance, clockOptions } from './units';
import {
  altitudeColor,
  extendTrail,
  overviewBounds,
  pointAhead,
  routeLeg,
  routePlaces,
  routeProgress,
  timeToGoLabel,
  type LiveAircraft,
  type LiveRoute,
} from './liveTrack';
import { resolveCode } from './searchParser';

const NM_TO_MI = 1.150779;

const trails = new Map<string, Array<[number, number]>>();
/** Where tracking first saw each aircraft, for the estimated line back to its origin. */
const firstSeen = new Map<string, [number, number]>();
const routes = new Map<string, Promise<LiveRoute | null>>();
const fitting = new Map<string, LiveRoute>();
/** Aircraft whose route lookup has finished, fitting or not. */
const settled = new Set<string>();
let drawn: L.Layer[] = [];
let session = 0;
let lastMap: L.Map | null = null;
let lastGroup: L.LayerGroup | null = null;
let lastAircraft: LiveAircraft[] = [];

// Route overview state
let overviewHex: string | null = null;
let overviewLeg: LiveRoute | null = null;
let overviewPlane: LiveAircraft | null = null;
let overviewSeenAt = 0;
let overviewOut = false;
let overviewLayer: L.LayerGroup | null = null;

const arc = (a: [number, number], b: [number, number], steps = 48): Array<[number, number]> =>
  slerpArc({ lat: a[0], lon: a[1] } as Airport, { lat: b[0], lon: b[1] } as Airport, steps).map((p) => [p.lat, p.lon] as [number, number]);

const end = (leg: LiveRoute, i: 0 | 1): [number, number] => {
  const ap = leg.airports[i === 0 ? 0 : leg.airports.length - 1];
  return [ap.lat, ap.lon];
};

const codeOf = (leg: LiveRoute, i: 0 | 1) => {
  const ap = leg.airports[i === 0 ? 0 : leg.airports.length - 1];
  return ap.iata || ap.icao || '?';
};

const cityOf = (code: string) => resolveCode(code)?.city || null;

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

function airportMarker(pos: [number, number], label: string): L.CircleMarker {
  return L.circleMarker(pos, { radius: 4, color: '#0f172a', weight: 2, fillColor: '#e2e8f0', fillOpacity: 1, interactive: false }).bindTooltip(label, {
    permanent: true,
    direction: 'top',
    offset: [0, -4],
    className: 'live-dest-label',
  });
}

function redraw() {
  const group = lastGroup;
  if (!group) return;
  for (const layer of drawn) group.removeLayer(layer);
  drawn = [];
  for (const a of lastAircraft) {
    const color = altitudeColor(a.altFt);
    const trail = trails.get(a.hex) || [];
    if (trail.length > 1) drawn.push(L.polyline(trail, { color, weight: 2, opacity: 0.8, interactive: false }));
    const leg = fitting.get(a.hex);
    if (leg && overviewHex === null) {
      // Origin to where tracking first saw it (estimated), then on to the destination.
      const seen = firstSeen.get(a.hex) || [a.lat, a.lon];
      drawn.push(L.polyline(arc(end(leg, 0), seen), { color: '#94a3b8', weight: 1.5, opacity: 0.35, dashArray: '4, 6', interactive: false }));
      const ahead = L.polyline(arc([a.lat, a.lon], end(leg, 1)), { color, weight: 2.5, opacity: 0.85, className: 'live-route-line' });
      ahead.on('click', () => openOverview(a.hex));
      ahead.bindTooltip(`Route overview: ${routePlaces(leg, cityOf)}`, { sticky: true });
      drawn.push(ahead);
      drawn.push(airportMarker(end(leg, 1), codeOf(leg, 1)));
    } else if (!leg && a.track != null && a.gs > 0) {
      const ahead = pointAhead([a.lat, a.lon], a.track, a.gs / 60);
      drawn.push(L.polyline([[a.lat, a.lon], ahead], { color, weight: 2, dashArray: '2, 5', opacity: 0.9, interactive: false }));
    }
  }
  for (const layer of drawn) group.addLayer(layer);
}

// ---------------------------------------------------------------------------------------------
// Route overview
// ---------------------------------------------------------------------------------------------

const strip = () => document.getElementById('live-overview');
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function drawOverview(fit: boolean) {
  const map = lastMap;
  if (!map || !overviewLeg || !overviewPlane) return;
  const leg = overviewLeg;
  const a = overviewPlane;
  const pos: [number, number] = [a.lat, a.lon];
  if (!overviewLayer) overviewLayer = L.layerGroup().addTo(map);
  overviewLayer.clearLayers();
  const color = altitudeColor(a.altFt);
  overviewLayer.addLayer(L.polyline(arc(end(leg, 0), pos), { color: '#94a3b8', weight: 3, opacity: 0.6, interactive: false }));
  overviewLayer.addLayer(L.polyline(arc(pos, end(leg, 1)), { color, weight: 3.5, opacity: 0.95, interactive: false }));
  overviewLayer.addLayer(airportMarker(end(leg, 0), `${codeOf(leg, 0)} ${cityOf(codeOf(leg, 0)) || ''}`.trim()));
  overviewLayer.addLayer(airportMarker(end(leg, 1), `${codeOf(leg, 1)} ${cityOf(codeOf(leg, 1)) || ''}`.trim()));
  overviewLayer.addLayer(L.marker(pos, { icon: planeIcon(a, true), interactive: false, zIndexOffset: 1000 }));
  if (fit) frame(map, L.latLngBounds(overviewBounds(leg, pos)), 50, 10);
  renderStrip();
}

function renderStrip() {
  const el = strip();
  if (!el || !overviewLeg || !overviewPlane) return;
  const a = overviewPlane;
  const p = routeProgress(overviewLeg, [a.lat, a.lon]);
  const togo = timeToGoLabel(p.toGoNm, a.gs, a.rate);
  const when = new Date(overviewSeenAt).toLocaleTimeString([], clockOptions());
  const facts = [
    `${formatDistance(p.flownNm * NM_TO_MI)} flown`,
    `${formatDistance(p.toGoNm * NM_TO_MI)} to go`,
    togo && !overviewOut ? `${togo} at current speed` : null,
  ]
    .filter(Boolean)
    .join(' \u00b7 ');
  const name = a.callsign || a.reg || a.hex.toUpperCase();
  el.innerHTML =
    `<div class="live-ov-title"><strong>${esc(name)}</strong> ${esc(routePlaces(overviewLeg, cityOf))}</div>` +
    `<div class="live-ov-facts">${esc(facts)}${overviewOut ? ` <span class="live-ov-out">Out of range, last seen ${esc(when)}</span>` : ''}</div>` +
    `<div class="live-ov-actions"><button type="button" class="live-banner-btn" data-ov="weather">Weather along this route</button>` +
    `<button type="button" class="live-banner-btn live-banner-btn--plain" data-ov="back">Back to Live track</button></div>`;
  el.hidden = false;
}

function openOverview(hex: string) {
  const leg = fitting.get(hex);
  const a = lastAircraft.find((x) => x.hex === hex);
  if (!leg || !a || !lastMap) return;
  overviewHex = hex;
  overviewLeg = leg;
  overviewPlane = a;
  overviewSeenAt = Date.now();
  overviewOut = false;
  lastMap.getContainer().classList.add('live-overview-on');
  redraw();
  drawOverview(true);
}

function closeOverview(back: boolean) {
  const was = overviewHex !== null;
  overviewHex = overviewLeg = overviewPlane = null;
  overviewOut = false;
  overviewLayer?.remove();
  overviewLayer = null;
  lastMap?.getContainer().classList.remove('live-overview-on');
  const el = strip();
  if (el) {
    el.hidden = true;
    el.innerHTML = '';
  }
  if (!was) return;
  redraw();
  if (back) fitLiveCircle();
}

/** The app's normal route view for the leg (weather, hazards, winds), through the search. */
function weatherAlongRoute() {
  if (!overviewLeg) return;
  const origin = resolveCode(codeOf(overviewLeg, 0));
  const destination = resolveCode(codeOf(overviewLeg, 1));
  closeOverview(false);
  const show = (window as any).renderRouteView as ((o: Airport, d: Airport) => void) | undefined;
  if (origin && destination && show) show(origin, destination);
}

document.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('#live-overview [data-ov]') as HTMLElement | null;
  if (!btn) return;
  if (btn.dataset.ov === 'weather') weatherAlongRoute();
  else closeOverview(true);
});

const hooks: LiveDrawHooks = {
  update(map, group, aircraft) {
    const my = session;
    lastMap = map;
    lastGroup = group;
    lastAircraft = aircraft;
    const live = new Set(aircraft.map((a) => a.hex));
    for (const hex of [...trails.keys()]) {
      if (live.has(hex)) continue;
      trails.delete(hex);
      firstSeen.delete(hex);
    }
    for (const a of aircraft) {
      trails.set(a.hex, extendTrail(trails.get(a.hex) || [], [a.lat, a.lon]));
      if (!firstSeen.has(a.hex)) firstSeen.set(a.hex, [a.lat, a.lon]);
    }
    // The overview's aircraft moves while it is in the circle and freezes once it leaves.
    if (overviewHex) {
      const now = aircraft.find((a) => a.hex === overviewHex);
      if (now) {
        overviewPlane = now;
        overviewSeenAt = Date.now();
        overviewOut = false;
      } else {
        overviewOut = true;
      }
      drawOverview(false);
    }
    redraw();
    // Routes arrive later; each is checked against the aircraft's latest position, track and climb.
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
        if (changed) {
          redraw();
          refreshCard(); // the route shows in the card at once
        }
      });
    }
  },
  clear() {
    session += 1;
    closeOverview(false);
    trails.clear();
    firstSeen.clear();
    routes.clear();
    fitting.clear();
    settled.clear();
    drawn = [];
    lastGroup = null;
    lastAircraft = [];
  },
  routeLabel(hex) {
    const r = fitting.get(hex);
    return r ? routePlaces(r, cityOf) : null;
  },
  routeSettled: (hex) => settled.has(hex),
  typeName: aircraftTypeName,
  openOverview,
};

export function initLiveDraw() {
  setLiveDrawHooks(hooks);
}
