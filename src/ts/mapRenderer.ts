import type { Airport } from './geoMath';
import { slerpArc, bearingBetween, haversineDistance, blockTimeMiles } from './geoMath';
import connectionsData from '../data/connections.json';
import type { ConnectingDepth, ViaOption } from './connections';
import { airportCode } from './connections';
import { fetchWeather, type WeatherSnapshot } from './weather';
import { initOverlays, setOverlayAirports, showAirportRunways, clearAirportRunways, clearRouteHazards } from './mapOverlays';
import {
  approachLine,
  approachPoint,
  approachTicks,
  bestEndForCourse,
  findRunwayEnd,
  departureLine,
  smoothPath,
  type LatLon,
  type RunwayEnd,
} from './approach';
import type { WindSample } from './windsAloft';

const VIA_PURPLE = '#c084fc';
const VIA_PURPLE_DIM = '#7e22ce';
const VIA_ORANGE = '#f97316';
const VIA_ORANGE_DIM = '#c2410c';

const WX_CATEGORY_COLOR: Record<string, string> = {
  VFR: '#4ade80',
  MVFR: '#38bdf8',
  IFR: '#f87171',
  LIFR: '#e879f9',
};

let map: L.Map | null = null;
let currentLayers: L.Layer[] = [];
let connectionLayers: L.Layer[] = [];
let viaLayers: L.Layer[] = [];
let weatherLayers: L.Layer[] = [];
let weatherGeneration = 0;
const weatherDrawn = new Set<string>();
const weatherAnchors = new Map<string, [number, number]>();
interface ViaItinerary {
  key: string;
  chain: Airport[]; // origin, hubs..., destination
  arcs: [number, number][][]; // one great-circle polyline per leg (longitudes unwrapped)
  legs: L.Polyline[];
  hubMarkers: L.CircleMarker[];
}
let viaItineraries: ViaItinerary[] = [];
let viaLabelLayers: L.Layer[] = [];
let selectedViaKey: string | null = null;
let viaContext: {
  origin: Airport;
  destination: Airport;
  options: ViaOption[];
  depth: ConnectingDepth;
  drawLimit: number;
} | null = null;

/** "Airports near me": the user's position plus the nearby airports, framed together. */
export function showNearby(here: { lat: number; lon: number }, airports: Airport[]) {
  if (!map) return;
  clearLayers();
  clearViaRoutes();
  clearWeather();

  const you = L.circleMarker([here.lat, here.lon], {
    radius: 7,
    color: '#f8fafc',
    weight: 3,
    fillColor: '#38bdf8',
    fillOpacity: 1,
  }).addTo(map);
  you.bindTooltip('You are here', { direction: 'top' });
  currentLayers.push(you);

  const bounds = L.latLngBounds([[here.lat, here.lon]]);
  for (const a of airports) {
    addEndpointMarker(a);
    bounds.extend([a.lat, a.lon]);
  }
  map.flyToBounds(bounds, { padding: [50, 50], maxZoom: 10, duration: 0.8 });
}

/** Re-measures the map after its container changes size (the phone results sheet). */
export function refreshMapSize() {
  map?.invalidateSize();
}

export function initMap(containerId: string): L.Map {
  if (map) return map;

  map = L.map(containerId, {
    zoomControl: true,
    attributionControl: false,
    worldCopyJump: true,
  }).setView([39.5, -98.35], 4);

  // Halo sits under airport circleMarkers (overlayPane 400); wind ticks use markerPane.
  const wxHalo = map.createPane('wxHalo');
  wxHalo.style.zIndex = '350';
  initOverlays(map);

  // Stadia Maps Alidade Smooth Dark. No API key: Stadia authenticates browser
  // requests by domain (*.zachroute.pages.dev is registered in the Stadia
  // dashboard; localhost works without registration). A fork deployed on another
  // domain must register that domain with its own Stadia account.
  L.tileLayer('https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png', {
    maxZoom: 20,
    attribution: '&copy; Stadia Maps &copy; OpenMapTiles &copy; OpenStreetMap contributors',
  }).addTo(map);

  return map;
}

export function clearLayers() {
  currentLayers.forEach((layer) => map?.removeLayer(layer));
  currentLayers = [];
  routeCtx = null;
  singleApproach.clear();
  singleEnds.clear();
  clearAirportRunways();
  clearRouteHazards();
  const legend = document.getElementById('route-legend');
  if (legend) legend.hidden = true;
}

/** Draws runway lines for the given airports; optionally zooms in so the runways fill the view. */
export function drawAirportRunways(list: Airport[], fit = false): boolean {
  clearApproaches();
  const bounds = showAirportRunways(list);
  if (!bounds) return false;
  if (fit && map) map.flyToBounds(bounds, { padding: [50, 50], maxZoom: 13, duration: 0.8 });
  return true;
}

export function clearConnections() {
  connectionLayers.forEach((layer) => map?.removeLayer(layer));
  connectionLayers = [];
}

export function clearViaRoutes() {
  viaLayers.forEach((layer) => map?.removeLayer(layer));
  viaLayers = [];
  viaLabelLayers.forEach((layer) => map?.removeLayer(layer));
  viaLabelLayers = [];
  viaItineraries = [];
  viaContext = null;
  selectedViaKey = null;
  const summary = document.getElementById('route-summary');
  if (summary) summary.hidden = true;
}

export function clearWeather() {
  weatherGeneration += 1;
  weatherLayers.forEach((layer) => map?.removeLayer(layer));
  weatherLayers = [];
  weatherDrawn.clear();
  weatherAnchors.clear();
}

export function resetView() {
  clearLayers();
  clearConnections();
  clearViaRoutes();
  clearWeather();
  // NOTE: airport background layers (large/medium) are left intact - they only
  // disappear when the user explicitly unchecks the toggles in the settings flyout.

  if (map) {
    map.flyTo([39.5, -98.35], 4, { duration: 0.6 });
  }

  // Clear results panel
  const results = document.getElementById('results-content');
  if (results) {
    results.innerHTML = `
      <div class="empty-state">
        <p>Enter an airport code, a city or airport name, or a route.</p>
        <p class="example">Examples: <code>ORD</code>, <code>Chicago</code>, <code>ORD DEN</code>, <code>Chicago Denver</code></p>
      </div>
    `;
  }
}

export function showSingleAirport(airport: Airport) {
  if (!map) return;
  clearLayers();
  clearViaRoutes();
  clearWeather();

  const marker = L.circleMarker([airport.lat, airport.lon], {
    radius: 8,
    color: '#38bdf8',
    weight: 3,
    fillColor: '#38bdf8',
    fillOpacity: 0.3,
  }).addTo(map);

  marker.bindPopup(`<strong>${airport.iata}</strong><br>${airport.name}<br><small style="color:#64748b">Click marker again to load lore</small>`);
  marker.on('click', () => {
    // Re-render the side panel with lore fetch button
    if ((window as any).renderSingleAirport) {
      (window as any).renderSingleAirport(airport);
    }
    // Only draw connections if the global toggle is enabled
    if ((window as any).connectionsEnabled) {
      showConnections(airport);
    }
  });
  currentLayers.push(marker);

  if (!drawAirportRunways([airport], true)) {
    map.flyTo([airport.lat, airport.lon], 9, { duration: 0.8 });
  }
}

/** Shift `lon` by +/-360 degrees so it sits on the short side of `prevLon` (crosses the dateline when that's shorter). */
function unwrapLon(lon: number, prevLon: number): number {
  let shifted = lon;
  while (shifted - prevLon > 180) shifted -= 360;
  while (shifted - prevLon < -180) shifted += 360;
  return shifted;
}

function unwrapLatLngs(points: Array<{ lat: number; lon: number }>): [number, number][] {
  if (points.length === 0) return [];
  const out: [number, number][] = [[points[0].lat, points[0].lon]];
  for (let i = 1; i < points.length; i++) {
    out.push([points[i].lat, unwrapLon(points[i].lon, out[i - 1][1])]);
  }
  return out;
}

function rememberWeatherAnchor(airport: Airport, lon: number) {
  if (!airport.icao) return;
  weatherAnchors.set(airport.icao, [airport.lat, lon]);
}

function windTickIcon(dirDeg: number, speedKt: number): L.DivIcon {
  const length = 10 + Math.min(Math.round(speedKt), 24);
  return L.divIcon({
    className: 'wx-wind-icon',
    iconSize: [48, 48],
    iconAnchor: [24, 24],
    html: `<div class="wx-wind-rot" style="transform: rotate(${dirDeg}deg)"><div class="wx-wind-shaft" style="height:${length}px"></div></div>`,
  });
}

function drawWeatherAt(airport: Airport, wx: WeatherSnapshot) {
  if (!map || !airport.icao) return;
  const pos = weatherAnchors.get(airport.icao) || [airport.lat, airport.lon];
  const color = (wx.flightCategory && WX_CATEGORY_COLOR[wx.flightCategory]) || '#94a3b8';

  // Good (VFR) conditions stay quiet: only a halo when something is worth noticing.
  if (wx.flightCategory !== 'VFR') {
    const halo = L.circleMarker(pos, {
      radius: 14,
      color,
      weight: 3,
      fillColor: color,
      fillOpacity: 0.18,
      opacity: 0.95,
      interactive: false,
      pane: 'wxHalo',
    }).addTo(map);
    weatherLayers.push(halo);
  }

  const windOk =
    wx.windDirDeg !== undefined &&
    !isNaN(wx.windDirDeg) &&
    wx.windSpeedKt !== undefined &&
    wx.windSpeedKt >= 3;
  if (windOk) {
    const tick = L.marker(pos, {
      icon: windTickIcon(wx.windDirDeg!, wx.windSpeedKt!),
      interactive: false,
      keyboard: false,
    }).addTo(map);
    weatherLayers.push(tick);
  }
}

async function paintAirportWeather(airport: Airport) {
  if (!map || !airport.icao || weatherDrawn.has(airport.icao)) return;
  weatherDrawn.add(airport.icao);
  const gen = weatherGeneration;
  const wx = await fetchWeather(airport.icao);
  if (gen !== weatherGeneration || !map) return;
  if (!wx.available) return;
  drawWeatherAt(airport, wx);
}

function paintRouteWeather(airports: Airport[]) {
  const seen = new Set<string>();
  for (const airport of airports) {
    if (!airport.icao || seen.has(airport.icao)) continue;
    seen.add(airport.icao);
    void paintAirportWeather(airport);
  }
}

function addEndpointMarker(airport: Airport, lonOverride?: number) {
  if (!map) return;
  const lon = lonOverride ?? airport.lon;
  rememberWeatherAnchor(airport, lon);

  const marker = L.circleMarker([airport.lat, lon], {
    radius: 7,
    color: '#38bdf8',
    weight: 2,
    fillColor: '#0f172a',
    fillOpacity: 1,
  }).addTo(map);
  marker.bindPopup(`<strong>${airport.iata || airport.icao}</strong>`);
  marker.on('click', () => {
    if ((window as any).renderSingleAirport) {
      (window as any).renderSingleAirport(airport);
    }
    if ((window as any).connectionsEnabled) {
      showConnections(airport);
    }
  });
  currentLayers.push(marker);
}

// ---------------------------------------------------------------------------
// Direct route: great-circle line that leaves along the departure runway and joins
// the destination's final approach, optionally coloured by headwind/tailwind.
// The runway legs are schematic (extended centerline + 3 degree glide), not a
// published procedure.
// ---------------------------------------------------------------------------

const APPROACH_COLOR = '#2dd4bf';
const ROUTE_CYAN = '#38bdf8';

interface RouteCtx {
  origin: Airport;
  destination: Airport;
  originEnd: RunwayEnd | null;
  destEnd: RunwayEnd | null;
  arc: LatLon[];
  segments: L.Polyline[];
  segmentFracs: number[];
  extra: L.Layer[];
  windSamples: WindSample[] | null;
}

let routeCtx: RouteCtx | null = null;
const singleApproach = new Map<string, L.Layer[]>();
const singleEnds = new Map<string, { airport: Airport; end: RunwayEnd }>();
let showTicks = false; // approach distance ticks and the stand-alone approach line are opt-in

function sameAirport(a: Airport, b: Airport): boolean {
  return (a.icao || a.iata) === (b.icao || b.iata);
}

function addTracked<T extends L.Layer>(layer: T, bucket: L.Layer[]): T {
  if (!map) return layer;
  layer.addTo(map);
  currentLayers.push(layer);
  bucket.push(layer);
  return layer;
}

/** Distance ticks (every 2nm, with height on a 3 degree glide) along an approach. */
function drawApproachTicks(end: RunwayEnd, refLon: number, bucket: L.Layer[]) {
  for (const tick of approachTicks(end)) {
    const left: [number, number] = [tick.left.lat, unwrapLon(tick.left.lon, refLon)];
    const right: [number, number] = [tick.right.lat, unwrapLon(tick.right.lon, refLon)];
    addTracked(L.polyline([left, right], { color: APPROACH_COLOR, weight: 2, opacity: 0.95, interactive: false }), bucket);
    const labelIcon = L.divIcon({
      className: 'approach-label',
      html: `<span>${tick.label}</span>`,
      iconSize: [0, 0],
    });
    addTracked(L.marker(right, { icon: labelIcon, interactive: false, keyboard: false }), bucket);
  }
}

function windColor(headwindKt: number): string {
  const t = Math.max(-1, Math.min(1, headwindKt / 30)); // +1 strong headwind, -1 strong tailwind
  const base = [226, 232, 240]; // light gray = little or no wind; distinct from the plain cyan route
  const target = t > 0 ? [248, 113, 113] : [74, 222, 128];
  const k = Math.abs(t);
  const rgb = base.map((c, i) => Math.round(c + (target[i] - c) * k));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function headwindAt(samples: WindSample[], frac: number): number {
  if (frac <= samples[0].frac) return samples[0].headwindKt;
  for (let i = 1; i < samples.length; i++) {
    if (frac <= samples[i].frac) {
      const a = samples[i - 1];
      const b = samples[i];
      const t = (frac - a.frac) / (b.frac - a.frac || 1);
      return a.headwindKt + (b.headwindKt - a.headwindKt) * t;
    }
  }
  return samples[samples.length - 1].headwindKt;
}

function applyWindColors(ctx: RouteCtx) {
  const legend = document.getElementById('route-legend');
  if (!ctx.windSamples) {
    if (legend) legend.hidden = true;
    return;
  }
  const samples = ctx.windSamples;
  ctx.segments.forEach((seg, i) => {
    seg.setStyle({ color: windColor(headwindAt(samples, ctx.segmentFracs[i])) });
  });
  if (legend) {
    const avg = samples.reduce((sum, p) => sum + p.headwindKt, 0) / samples.length;
    const note = legend.querySelector('small');
    if (note) note.textContent = `avg ${Math.round(Math.abs(avg))}kt ${avg >= 0 ? 'headwind' : 'tailwind'}`;
    legend.hidden = false;
  }
}

function buildRoutePath(ctx: RouteCtx): LatLon[] {
  const inner = ctx.arc.slice(1, -1);
  const head: LatLon[] = ctx.originEnd ? departureLine(ctx.originEnd) : [ctx.arc[0]];
  const tail: LatLon[] = ctx.destEnd ? approachLine(ctx.destEnd) : [ctx.arc[ctx.arc.length - 1]];
  const raw = [...head, ...inner, ...tail];
  return ctx.originEnd || ctx.destEnd ? smoothPath(raw, 2) : raw;
}

function drawRoute(ctx: RouteCtx) {
  if (!map) return;
  const old = [...ctx.segments, ...ctx.extra];
  old.forEach((layer) => map?.removeLayer(layer));
  currentLayers = currentLayers.filter((layer) => !old.includes(layer));
  ctx.segments = [];
  ctx.segmentFracs = [];
  ctx.extra = [];

  const path = unwrapLatLngs(buildRoutePath(ctx));
  const last = path.length - 1;
  const chunks = Math.max(1, Math.min(30, last));
  for (let i = 0; i < chunks; i++) {
    const from = Math.floor((i * last) / chunks);
    const to = Math.floor(((i + 1) * last) / chunks);
    const seg = L.polyline(path.slice(from, to + 1), {
      color: ROUTE_CYAN,
      weight: 3,
      dashArray: '6, 6',
      opacity: 0.9,
    });
    addTracked(seg, ctx.segments);
    ctx.segmentFracs.push((from + to) / 2 / last);
  }

  if (ctx.destEnd && showTicks) drawApproachTicks(ctx.destEnd, path[last][1], ctx.extra);
  applyWindColors(ctx);
  raiseEndpoints();
}

export function showRoute(origin: Airport, destination: Airport) {
  if (!map) return;
  clearLayers();
  clearViaRoutes();
  clearWeather();

  const arcRaw = slerpArc(origin, destination, 50);
  const latLngs = unwrapLatLngs(arcRaw);

  // Until the wind is known, pick the runway ends that line up with the route.
  const n = arcRaw.length;
  const finalCourse = bearingBetween(arcRaw[n - 2].lat, arcRaw[n - 2].lon, arcRaw[n - 1].lat, arcRaw[n - 1].lon);
  const initialCourse = bearingBetween(arcRaw[0].lat, arcRaw[0].lon, arcRaw[1].lat, arcRaw[1].lon);

  routeCtx = {
    origin,
    destination,
    originEnd: bestEndForCourse(origin, initialCourse),
    destEnd: bestEndForCourse(destination, finalCourse),
    arc: arcRaw,
    segments: [],
    segmentFracs: [],
    extra: [],
    windSamples: null,
  };

  addEndpointMarker(origin, latLngs[0][1]);
  addEndpointMarker(destination, latLngs[latLngs.length - 1][1]);
  drawAirportRunways([origin, destination]);
  drawRoute(routeCtx);

  const bounds = L.latLngBounds(latLngs);
  map.flyToBounds(bounds, { padding: [40, 40], duration: 0.9 });
  paintRouteWeather([origin, destination]);
}

/** Colours the direct route line green (tailwind) to red (headwind) from cruise-wind samples. */
export function colorRouteByWind(origin: Airport, destination: Airport, samples: WindSample[]) {
  if (!routeCtx || !sameAirport(routeCtx.origin, origin) || !sameAirport(routeCtx.destination, destination)) return;
  if (samples.length < 2) return;
  routeCtx.windSamples = samples;
  applyWindColors(routeCtx);
}

function clearApproaches() {
  for (const layers of singleApproach.values()) {
    layers.forEach((layer) => map?.removeLayer(layer));
    currentLayers = currentLayers.filter((layer) => !layers.includes(layer));
  }
  singleApproach.clear();
  singleEnds.clear();
}

/** Turns the approach distance ticks (and the single-airport approach line) on or off. */
export function setApproachTicks(on: boolean) {
  showTicks = on;
  if (!map) return;
  if (routeCtx) drawRoute(routeCtx);
  if (on) {
    for (const { airport, end } of singleEnds.values()) showApproachOnly(airport, end, false);
  } else {
    for (const layers of singleApproach.values()) {
      layers.forEach((layer) => map?.removeLayer(layer));
      currentLayers = currentLayers.filter((layer) => !layers.includes(layer));
    }
    singleApproach.clear();
  }
}

/** Stand-alone approach (no route line): centerline plus distance ticks for one runway end. */
function showApproachOnly(airport: Airport, end: RunwayEnd, frame = true) {
  if (!map) return;
  const key = airport.icao || airport.iata;
  singleApproach.get(key)?.forEach((layer) => map?.removeLayer(layer));
  const bucket: L.Layer[] = [];
  singleApproach.set(key, bucket);

  const line = approachLine(end).map((p): [number, number] => [p.lat, p.lon]);
  addTracked(L.polyline(line, { color: APPROACH_COLOR, weight: 2.5, dashArray: '6, 6', opacity: 0.95, interactive: false }), bucket);
  drawApproachTicks(end, end.threshold.lon, bucket);

  // In a plain single-airport view, frame the runway plus the first few miles of the approach.
  if (frame && !viaContext) {
    const out = approachPoint(end, 7);
    const bounds = L.latLngBounds([
      [end.threshold.lat, end.threshold.lon],
      [end.far.lat, end.far.lon],
      [out.lat, out.lon],
    ]);
    map.flyToBounds(bounds, { padding: [50, 50], maxZoom: 13, duration: 0.8 });
  }
}

/**
 * Called when an airport card learns which runway end the wind favors. In a direct
 * route view this re-aims the departure (origin) or approach (destination); otherwise
 * it draws that runway's approach path.
 */
export function setPreferredRunwayEnd(airport: Airport, ident: string | null) {
  if (!map || !ident) return;
  const end = findRunwayEnd(airport, ident);
  if (!end) return;

  if (routeCtx) {
    if (sameAirport(routeCtx.origin, airport)) {
      if (routeCtx.originEnd?.ident === ident) return;
      routeCtx.originEnd = end;
      drawRoute(routeCtx);
    } else if (sameAirport(routeCtx.destination, airport)) {
      if (routeCtx.destEnd?.ident === ident) return;
      routeCtx.destEnd = end;
      drawRoute(routeCtx);
    }
    return;
  }
  singleEnds.set(airport.icao || airport.iata, { airport, end });
  if (showTicks) showApproachOnly(airport, end);
}

function raiseEndpoints() {
  currentLayers.forEach((layer) => {
    if ('bringToFront' in layer) (layer as L.Path).bringToFront();
  });
}

// ---------------------------------------------------------------------------
// Connecting routes (one-stop / two-stop)
// The selected itinerary looks like a direct route (curved great-circle legs in the
// route cyan, labeled stops, per-leg distance and time). Alternatives are faded; only
// the first few are drawn until "Show all" is used, so the map stays readable.
// ---------------------------------------------------------------------------

const VIA_VISIBLE_ALTERNATES = 3;

function viaPalette(depth: ConnectingDepth): { color: string; fill: string } {
  return depth === 'two-stop' ? { color: VIA_ORANGE, fill: VIA_ORANGE_DIM } : { color: VIA_PURPLE, fill: VIA_PURPLE_DIM };
}

function viaLegStyle(depth: ConnectingDepth, selected: boolean): L.PolylineOptions {
  if (selected) {
    return { color: ROUTE_CYAN, weight: 3, opacity: 0.95, dashArray: '6, 6' };
  }
  return { color: viaPalette(depth).color, weight: 1.5, opacity: 0.4, dashArray: undefined };
}

function viaHubStyle(depth: ConnectingDepth, selected: boolean): L.CircleMarkerOptions {
  if (selected) {
    return { radius: 6, color: ROUTE_CYAN, weight: 2.5, fillColor: '#0f172a', fillOpacity: 1 };
  }
  const palette = viaPalette(depth);
  return { radius: 3.5, color: palette.color, weight: 1.5, fillColor: palette.fill, fillOpacity: 0.85 };
}

function formatMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Great-circle polyline for each leg of a chain, with longitudes unwrapped continuously across the dateline. */
function buildArcChain(chain: Airport[], steps = 40): [number, number][][] {
  const legs: [number, number][][] = [];
  let prevLon = chain[0].lon;
  for (let i = 0; i < chain.length - 1; i++) {
    const arc = slerpArc(chain[i], chain[i + 1], steps);
    const pts: [number, number][] = [];
    arc.forEach((p, j) => {
      const ref = j === 0 ? prevLon : pts[j - 1][1];
      pts.push([p.lat, unwrapLon(p.lon, ref)]);
    });
    legs.push(pts);
    prevLon = pts[pts.length - 1][1];
  }
  return legs;
}

function drawItinerary(origin: Airport, destination: Airport, option: ViaOption, depth: ConnectingDepth) {
  if (!map) return;

  const chain = [origin, ...option.hubs, destination];
  const arcs = buildArcChain(chain);
  const legs: L.Polyline[] = [];
  const hubMarkers: L.CircleMarker[] = [];

  for (const pts of arcs) {
    const leg = L.polyline(pts, viaLegStyle(depth, false)).addTo(map);
    leg.on('click', () => {
      (window as any).selectViaHub?.(option.key);
    });
    legs.push(leg);
    viaLayers.push(leg);
  }

  option.hubs.forEach((hub, index) => {
    const hubCode = airportCode(hub);
    const lon = arcs[index][arcs[index].length - 1][1];
    rememberWeatherAnchor(hub, lon);
    const hubMarker = L.circleMarker([hub.lat, lon], viaHubStyle(depth, false)).addTo(map as L.Map);
    hubMarker.bindPopup(`<strong>${hubCode}</strong><br>${hub.city || hub.name}`);
    hubMarker.on('click', () => {
      (window as any).selectViaHub?.(option.key);
    });
    hubMarkers.push(hubMarker);
    viaLayers.push(hubMarker);
  });

  viaItineraries.push({ key: option.key, chain, arcs, legs, hubMarkers });
}

/** Per-leg distance/time pills and the stop-code labels for the selected itinerary. */
function drawSelectedDecorations(itinerary: ViaItinerary, option: ViaOption | undefined) {
  if (!map) return;
  viaLabelLayers.forEach((layer) => map?.removeLayer(layer));
  viaLabelLayers = [];

  itinerary.arcs.forEach((pts, i) => {
    const miles = haversineDistance(itinerary.chain[i], itinerary.chain[i + 1]);
    const text = `${Math.round(miles).toLocaleString()} mi \u00b7 ${formatMinutes(blockTimeMiles(miles))}`;
    const mid = pts[Math.floor(pts.length / 2)];
    const icon = L.divIcon({
      className: 'leg-label',
      html: `<span>${text}</span>`,
      iconSize: [0, 0],
    });
    const marker = L.marker(mid, { icon, interactive: false, keyboard: false }).addTo(map as L.Map);
    viaLabelLayers.push(marker);
  });

  const summary = document.getElementById('route-summary');
  if (summary && option) {
    const codes = option.hubs.map(airportCode).join(', ');
    summary.textContent = `via ${codes} \u00b7 ${Math.round(option.viaMiles).toLocaleString()} mi \u00b7 ~${formatMinutes(option.blockMinutes)} flying, before any layover`;
    summary.hidden = false;
  }
}

export function showConnectingRoutes(
  origin: Airport,
  destination: Airport,
  options: ViaOption[],
  depth: ConnectingDepth = 'one-stop',
  drawLimit?: number
) {
  if (!map) return;
  clearLayers();
  clearViaRoutes();
  clearWeather();

  const limit = drawLimit ?? options.length;
  viaContext = { origin, destination, options, depth, drawLimit: limit };

  const drawn = options.slice(0, Math.min(limit, 1 + VIA_VISIBLE_ALTERNATES));
  const destLon = unwrapLon(destination.lon, origin.lon);
  addEndpointMarker(origin);
  addEndpointMarker(destination, destLon);
  drawAirportRunways([origin, destination]);

  const bounds = L.latLngBounds([
    [origin.lat, origin.lon],
    [destination.lat, destLon],
  ]);
  for (const option of drawn) {
    drawItinerary(origin, destination, option, depth);
    for (const pts of viaItineraries[viaItineraries.length - 1].arcs) {
      for (const latLng of pts) bounds.extend(latLng);
    }
  }

  if (drawn.length > 0) {
    highlightViaRoute(drawn[0].key);
  } else {
    raiseEndpoints();
  }

  map.flyToBounds(bounds, { padding: [40, 40], duration: 0.9 });
  const hubs = drawn.flatMap((option) => option.hubs);
  paintRouteWeather([origin, destination, ...hubs]);
}

/** Draws the remaining (faded) alternatives, up to the draw cap. */
export function showAllViaOptions() {
  if (!viaContext) return;
  const ctx = viaContext;
  const selectedKey = selectedViaKey;
  for (const option of ctx.options.slice(0, ctx.drawLimit)) {
    if (viaItineraries.some((it) => it.key === option.key)) continue;
    drawItinerary(ctx.origin, ctx.destination, option, ctx.depth);
  }
  if (selectedKey) highlightViaRoute(selectedKey);
  else raiseEndpoints();
}

export function highlightViaRoute(key: string) {
  if (viaContext && !viaItineraries.some((itinerary) => itinerary.key === key)) {
    const option = viaContext.options.find((candidate) => candidate.key === key);
    if (option) {
      drawItinerary(viaContext.origin, viaContext.destination, option, viaContext.depth);
      paintRouteWeather(option.hubs);
    }
  }

  selectedViaKey = key;
  const depth = viaContext?.depth ?? 'one-stop';
  for (const itinerary of viaItineraries) {
    const selected = itinerary.key === key;
    for (const leg of itinerary.legs) {
      leg.setStyle(viaLegStyle(depth, selected));
      if (selected) leg.bringToFront();
    }
    for (const hubMarker of itinerary.hubMarkers) {
      hubMarker.setStyle(viaHubStyle(depth, selected));
      if (selected) {
        hubMarker.bringToFront();
        const code = airportCode(itinerary.chain[itinerary.hubMarkers.indexOf(hubMarker) + 1]);
        hubMarker.unbindTooltip();
        hubMarker.bindTooltip(code, { permanent: true, direction: 'top', className: 'hub-label', offset: [0, -6] });
      } else {
        hubMarker.unbindTooltip();
      }
    }
  }

  const selectedItinerary = viaItineraries.find((it) => it.key === key);
  if (selectedItinerary) {
    drawSelectedDecorations(selectedItinerary, viaContext?.options.find((o) => o.key === key));
  }
  raiseEndpoints();
}

let allAirports: Record<string, Airport> = {};

export function setAirportDatabase(data: Record<string, Airport>) {
  allAirports = data;
  setOverlayAirports(data);
}

export function showConnections(airport: Airport) {
  if (!map) return;

  const destCodes: string[] = (connectionsData as any)[airport.iata] || (connectionsData as any)[airport.icao] || [];
  if (destCodes.length === 0) return;

  clearConnections();

  for (const code of destCodes) {
    const dest = allAirports[code];
    if (!dest) continue;

    // Great-circle arc (a straight line on the flat map is wrong for long routes)
    const arc = unwrapLatLngs(slerpArc(airport, dest, 24));
    const destLon = arc[arc.length - 1][1];
    const line = L.polyline(arc, {
      color: '#fde047',
      weight: 1.5,
      opacity: 0.6,
    }).addTo(map);

    // Clicking the line should also load the route (same as clicking the destination marker)
    line.on('click', () => {
      clearConnections();
      if ((window as any).renderRouteView) {
        (window as any).renderRouteView(airport, dest);
      }
    });

    connectionLayers.push(line);

    // Small yellow marker at destination
    const marker = L.circleMarker([dest.lat, destLon], {
      radius: 4,
      color: '#fde047',
      weight: 2,
      fillColor: '#fef08c',
      fillOpacity: 0.9,
    }).addTo(map);

    // Clicking the destination marker should load the route view
    marker.on('click', () => {
      clearConnections();
      if ((window as any).renderRouteView) {
        (window as any).renderRouteView(airport, dest);
      }
    });

    	connectionLayers.push(marker);
  }
}

// ---------------------------------------------------------------------------
/** Airport background layers (large / medium / regional) - toggled from settings flyout */
// ---------------------------------------------------------------------------

let largeAirportLayer: L.LayerGroup | null = null;
let mediumAirportLayer: L.LayerGroup | null = null;
let regionalAirportLayer: L.LayerGroup | null = null;

export function initAirportLayers(airports: Record<string, Airport>) {
  if (largeAirportLayer || mediumAirportLayer || regionalAirportLayer) return;

  largeAirportLayer = L.layerGroup();
  mediumAirportLayer = L.layerGroup();
  regionalAirportLayer = L.layerGroup();

  const seen = new Set<Airport>(); // ICAO / LID aliases share one object with the primary key
  for (const code in airports) {
    const ap = airports[code];
    if (!ap || seen.has(ap) || typeof ap.lat !== 'number' || typeof ap.lon !== 'number') continue;
    seen.add(ap);

    const rawType = (ap as any).type;
    let targetLayer: L.LayerGroup | null = null;
    let style: { radius: number; color: string; weight: number; fillOpacity: number } | null = null;

    if (rawType === 'large_airport') {
      targetLayer = largeAirportLayer;
      style = { radius: 6.5, color: '#0284c8', weight: 2, fillOpacity: 0.70 };
    } else if (rawType === 'medium_airport') {
      targetLayer = mediumAirportLayer;
      style = { radius: 5, color: '#14b8a6', weight: 1.5, fillOpacity: 0.60 };
    } else if (rawType === 'regional') {
      targetLayer = regionalAirportLayer;
      style = { radius: 4.5, color: '#6366f1', weight: 1.5, fillOpacity: 0.55 };
    }

    if (!targetLayer || !style) continue;

    const marker = L.circleMarker([ap.lat, ap.lon], {
      radius: style.radius,
      color: style.color,
      weight: style.weight,
      fillColor: style.color,
      fillOpacity: style.fillOpacity,
    });

    marker.on('click', () => {
      if ((window as any).renderSingleAirport) {
        (window as any).renderSingleAirport(ap);
      }
    });

    targetLayer.addLayer(marker);
  }
}

export function showLargeAirports(show: boolean) {
  if (!map || !largeAirportLayer) return;
  if (show) largeAirportLayer.addTo(map);
  else map.removeLayer(largeAirportLayer);
}

export function showMediumAirports(show: boolean) {
  if (!map || !mediumAirportLayer) return;
  if (show) mediumAirportLayer.addTo(map);
  else map.removeLayer(mediumAirportLayer);
}

export function showRegionalAirports(show: boolean) {
  if (!map || !regionalAirportLayer) return;
  if (show) regionalAirportLayer.addTo(map);
  else map.removeLayer(regionalAirportLayer);
}

// Note: airport background layers persist across resetView() unless the user unchecks the toggles.