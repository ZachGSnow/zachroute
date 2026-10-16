import type { Airport, RunwayDetail } from './geoMath';
import { formatDistance, clockOptions } from './units';
import { bearingBetween, destinationPoint, haversineDistanceLatLon } from './geoMath';
import { resolveCode } from './searchParser';
import { pointInPolygon, advisoriesNear } from './hazardGeo';
import { fetchCyclones, stormsAlongRoute, stormTitle, type Cyclone, type StormOnRoute } from './cyclones';
import { fetchFires, type Fire } from './fires';
import { compassPoint } from './forecast';
import { summarizePirep, pirepAgeLabel, pirepAltitudeLabel, type RawPirep, type PirepKind } from './pirepText';

// Map overlays that sit on top of the base map and the route layers:
//   - weather stations (wind arrows for every METAR station in view; a ring only when not VFR)
//   - AIRMET/SIGMET hazard polygons
//   - pilot reports in plain English
//   - day / night shading
//   - runway lines with runway numbers (selected airports always, every visible airport when zoomed in)
//   - hazards and pilot reports along a searched route
// mapRenderer owns the Leaflet map and hands it over via initOverlays().

let map: L.Map | null = null;
let airports: Airport[] = []; // airports with runway coordinates
let places: Airport[] = []; // airports used to say "12 mi SW of Cincinnati"

const WX_COLOR: Record<string, string> = {
  VFR: '#4ade80',
  MVFR: '#38bdf8',
  IFR: '#f87171',
  LIFR: '#e879f9',
};

function hasCoords(r: RunwayDetail): boolean {
  return [r.leLat, r.leLon, r.heLat, r.heLon].every((v) => typeof v === 'number' && Number.isFinite(v));
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Hint chip over the map ("Zoom in to see weather stations")
// ---------------------------------------------------------------------------

let hintTimer: number | undefined;

function setHint(text: string | null, autoClearMs?: number) {
  const el = document.getElementById('map-hint');
  if (!el) return;
  window.clearTimeout(hintTimer);
  if (!text) {
    el.hidden = true;
    return;
  }
  el.textContent = text;
  el.hidden = false;
  if (autoClearMs) hintTimer = window.setTimeout(() => (el.hidden = true), autoClearMs);
}

const MIN_STATION_ZOOM = 5;
const MIN_PIREP_ZOOM = 6;
const MIN_FIRE_ZOOM = 5;

/** Shows a "zoom in" hint naming whichever zoom-limited layers are on but too far out. */
function updateZoomHint() {
  if (!map) return;
  const z = map.getZoom();
  const needed: string[] = [];
  if (stationsOn && z < MIN_STATION_ZOOM) needed.push('weather stations');
  if (pirepsOn && z < MIN_PIREP_ZOOM) needed.push('pilot reports');
  if (firesOn && z < MIN_FIRE_ZOOM) needed.push('fires');
  setHint(needed.length ? `Zoom in to see ${needed.join(' and ')}` : null);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initOverlays(m: L.Map) {
  if (map) return;
  map = m;

  // Night shading sits just above the base tiles; hazards sit under the airport markers.
  map.createPane('night').style.zIndex = '250';
  map.createPane('hazards').style.zIndex = '380';
  map.getPane('night')!.style.pointerEvents = 'none';

  // Runway numbers and approach distance labels only appear when zoomed far enough to read.
  const applyZoomClasses = () => {
    if (!map) return;
    const z = map.getZoom();
    const c = map.getContainer();
    c.classList.toggle('rwy-labels-on', z >= 12);
    c.classList.toggle('app-labels-on', z >= 9);
  };
  map.on('zoomend', applyZoomClasses);
  applyZoomClasses();

  let timer: number | undefined;
  map.on('moveend', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void refreshStations();
      void refreshPireps();
      void refreshFires();
      refreshViewRunways();
    }, 500);
  });
}

export function setOverlayAirports(db: Record<string, Airport>) {
  const seen = new Set<Airport>();
  airports = [];
  places = [];
  for (const key in db) {
    const a = db[key];
    if (!a || typeof a === 'string' || seen.has(a)) continue;
    seen.add(a);
    if (a.runways?.some(hasCoords)) airports.push(a);
    if (a.iata && a.city) places.push(a);
  }
}

/** "12 mi SW of Cincinnati" (or "near Cincinnati") for a point, using the nearest airport with an IATA code. */
function placeNear(lat: number, lon: number): string {
  let best: Airport | null = null;
  let bestScore = Infinity;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  for (const a of places) {
    const dLat = a.lat - lat;
    const dLon = (a.lon - lon) * cosLat;
    const score = dLat * dLat + dLon * dLon;
    if (score < bestScore) {
      bestScore = score;
      best = a;
    }
  }
  if (!best) return '';
  const miles = Math.round(haversineDistanceLatLon(best.lat, best.lon, lat, lon));
  if (miles < 3) return `near ${best.city}`;
  const dir = compassPoint(bearingBetween(best.lat, best.lon, lat, lon));
  return `${formatDistance(miles)} ${dir} of ${best.city}`;
}

// ---------------------------------------------------------------------------
// Weather stations layer: wind arrows, with a ring only when conditions are not VFR
// ---------------------------------------------------------------------------

let stationLayer: L.LayerGroup | null = null;
let stationsOn = false;
let stationGen = 0;

const MAX_STATIONS = 500;

export function setWeatherStations(on: boolean) {
  stationsOn = on;
  if (!map) return;
  if (!on) {
    stationGen += 1;
    stationLayer?.clearLayers();
    updateZoomHint();
    return;
  }
  void refreshStations();
}

interface Station {
  id: string;
  lat: number;
  lon: number;
  cat?: string;
  wd?: number;
  ws?: number;
  wg?: number;
}

function stationIcon(s: Station): L.DivIcon {
  const cat = s.cat || '';
  const nonVfr = !!cat && cat !== 'VFR';
  const color = nonVfr ? WX_COLOR[cat] || '#94a3b8' : '#cbd5e1';
  const windy = s.ws !== undefined && s.ws >= 3 && s.wd !== undefined && !isNaN(s.wd);

  const ring = nonVfr ? `<span class="wx-ring" style="border-color:${color}"></span>` : '';
  let arrow = '';
  if (windy) {
    const size = Math.round(14 + Math.min(s.ws as number, 40) * 0.4);
    const rotate = ((s.wd as number) + 180) % 360; // arrow points the way the wind is blowing
    arrow =
      `<svg class="wx-arrow" width="${size}" height="${size}" viewBox="0 0 24 24" style="transform:rotate(${rotate}deg)">` +
      `<path d="M12 22V3M12 3l-5.5 6.5M12 3l5.5 6.5" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  } else if (!nonVfr) {
    arrow = '<span class="wx-calm"></span>';
  }
  const gust = s.wg !== undefined && s.ws !== undefined && s.wg - s.ws >= 10 ? `<span class="wx-gust">G${s.wg}</span>` : '';

  return L.divIcon({
    className: 'wx-station',
    html: `${ring}${arrow}${gust}`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

async function refreshStations() {
  updateZoomHint();
  if (!map || !stationsOn) return;
  const zoom = map.getZoom();
  if (zoom < MIN_STATION_ZOOM) {
    stationLayer?.clearLayers();
    return;
  }
  if (!navigator.onLine) return;

  const gen = ++stationGen;
  const b = map.getBounds();
  const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((n) => n.toFixed(2)).join(',');

  try {
    const res = await fetch(`/api/metar-bbox?bbox=${bbox}`);
    if (!res.ok) return;
    const json = await res.json();
    if (gen !== stationGen || !map || !stationsOn) return;

    if (!stationLayer) stationLayer = L.layerGroup();
    stationLayer.clearLayers();

    let shown = 0;
    for (const s of (json.stations || []) as Station[]) {
      const airport = resolveCode(s.id);
      // Declutter when zoomed out: major airports only (their ring still shows when not VFR).
      const major = !!airport && ['large_airport', 'medium_airport', 'regional'].includes(airport.type);
      if (zoom < 8 && !major) continue;
      if (++shown > MAX_STATIONS) break;

      const wind = s.ws !== undefined && s.ws >= 1 ? `${s.wd !== undefined ? s.wd + '\u00b0 ' : ''}@ ${s.ws}kt${s.wg ? ' G' + s.wg : ''}` : 'calm';
      const marker = L.marker([s.lat, s.lon], { icon: stationIcon(s), keyboard: false });
      marker.bindTooltip(`${s.id}${s.cat ? ' ' + s.cat : ''} - ${wind}`, { direction: 'top', offset: [0, -10] });
      marker.on('click', () => {
        if (airport) (window as any).renderSingleAirport?.(airport);
      });
      stationLayer.addLayer(marker);
    }
    if (!map.hasLayer(stationLayer)) stationLayer.addTo(map);
  } catch {
    /* offline or upstream hiccup: keep whatever is drawn */
  }
}

// ---------------------------------------------------------------------------
// AIRMET / SIGMET hazards
// ---------------------------------------------------------------------------

interface Advisory {
  type: string;
  hazard: string;
  severity?: number;
  /** Intensity in words for international SIGMETs ("embedded", "severe mountain wave"). */
  detail?: string;
  /** Volcano or tropical cyclone name. */
  name?: string;
  /** FIR that issued an international SIGMET. */
  region?: string;
  validFrom?: number;
  validTo?: number;
  altLow?: number;
  altHigh?: number;
  raw?: string;
  coords: [number, number][];
}

const HAZARD_STYLE: Record<string, { color: string; label: string }> = {
  TURB: { color: '#f59e0b', label: 'Turbulence' },
  ICE: { color: '#67e8f9', label: 'Icing' },
  IFR: { color: '#94a3b8', label: 'Low ceilings / visibility' },
  'MTN OBSCN': { color: '#c4b5fd', label: 'Mountain obscuration' },
  CONVECTIVE: { color: '#ef4444', label: 'Thunderstorms' },
  ASH: { color: '#a8a29e', label: 'Volcanic ash' },
  TC: { color: '#f472b6', label: 'Tropical cyclone' },
};

function hazardStyle(hazard: string) {
  return HAZARD_STYLE[hazard] || { color: '#e2e8f0', label: hazard };
}

/** "Severe turbulence", "Embedded thunderstorms", "Volcanic ash (Mt Ibu)". */
function advisoryTitle(adv: Advisory): string {
  const label = hazardStyle(adv.hazard).label;
  const base = adv.detail ? `${adv.detail[0].toUpperCase()}${adv.detail.slice(1)} ${label.toLowerCase()}` : label;
  return adv.name ? `${base} (${adv.name})` : base;
}

let advisoryCache: { at: number; data: Promise<Advisory[]> } | null = null;

function fetchAdvisories(): Promise<Advisory[]> {
  if (advisoryCache && Date.now() - advisoryCache.at < 4 * 60 * 1000) return advisoryCache.data;
  const data = (async (): Promise<Advisory[]> => {
    if (!navigator.onLine) return [];
    try {
      const res = await fetch('/api/airsigmet');
      if (!res.ok) return [];
      const json = await res.json();
      return (json.advisories || []) as Advisory[];
    } catch {
      return [];
    }
  })();
  advisoryCache = { at: Date.now(), data };
  return data;
}

let hazardLayer: L.LayerGroup | null = null;
let hazardsOn = false;
let hazardTimer: number | undefined;

export function setHazards(on: boolean) {
  hazardsOn = on;
  window.clearInterval(hazardTimer);
  if (!map) return;
  if (!on) {
    hazardLayer?.clearLayers();
    return;
  }
  void refreshHazards(true);
  hazardTimer = window.setInterval(() => void refreshHazards(false), 5 * 60 * 1000);
}

function timeLabel(unixSec?: number): string {
  if (!unixSec) return '';
  return new Date(unixSec * 1000).toLocaleTimeString('en-US', clockOptions());
}

function altitudeLabel(low?: number, high?: number): string {
  if (low === undefined && high === undefined) return '';
  const fmt = (n: number) => (n >= 18000 ? `FL${Math.round(n / 100)}` : `${n.toLocaleString()} ft`);
  if (low !== undefined && high !== undefined) return `${fmt(low)} to ${fmt(high)}`;
  if (high !== undefined) return `up to ${fmt(high)}`;
  return `above ${fmt(low as number)}`;
}

function advisoryPolygon(adv: Advisory, strong: boolean): L.Polygon {
  const style = hazardStyle(adv.hazard);
  const sigmet = adv.type === 'SIGMET';
  const poly = L.polygon(adv.coords, {
    pane: 'hazards',
    color: style.color,
    weight: strong ? 3 : sigmet ? 2.5 : 1.5,
    dashArray: sigmet || strong ? undefined : '5, 5',
    fillColor: style.color,
    fillOpacity: strong ? 0.24 : sigmet ? 0.18 : 0.1,
  });
  const alt = advisoryAltitude(adv);
  poly.bindPopup(
    `<strong>${esc(adv.type)}: ${esc(advisoryTitle(adv))}</strong>` +
      (adv.region ? `<br>${esc(adv.region)} FIR` : '') +
      (alt ? `<br>${esc(alt)}` : '') +
      (adv.validTo ? `<br>Until ${esc(timeLabel(adv.validTo))}` : '') +
      (adv.raw ? `<br><small style="color:#64748b">${esc(String(adv.raw).replace(/\s+/g, ' ').slice(0, 320))}</small>` : '')
  );
  return poly;
}

async function refreshHazards(announce: boolean) {
  if (!map || !hazardsOn) return;
  if (announce) advisoryCache = null; // a fresh toggle-on always asks for current data
  const list = await fetchAdvisories();
  if (!map || !hazardsOn) return;

  if (!hazardLayer) hazardLayer = L.layerGroup();
  hazardLayer.clearLayers();
  for (const adv of list) hazardLayer.addLayer(advisoryPolygon(adv, false));
  if (!map.hasLayer(hazardLayer)) hazardLayer.addTo(map);
  if (announce && list.length === 0) setHint('No active AIRMETs or SIGMETs', 3500);
}

// ---------------------------------------------------------------------------
// Pilot reports on the map, in plain English
// ---------------------------------------------------------------------------

const PIREP_COLOR: Record<PirepKind, string> = {
  turb: '#f59e0b',
  ice: '#67e8f9',
  both: '#f87171',
  vis: '#94a3b8',
};

function pirepMarker(p: RawPirep): L.CircleMarker | null {
  const summary = summarizePirep(p);
  if (!summary) return null;
  const color = summary.severe ? '#ef4444' : PIREP_COLOR[summary.kind];
  const marker = L.circleMarker([p.lat, p.lon], {
    radius: summary.severe ? 7 : 5,
    color: '#0f172a',
    weight: 1.5,
    fillColor: color,
    fillOpacity: 0.95,
  });
  const meta = [pirepAltitudeLabel(p), placeNear(p.lat, p.lon), p.acType, pirepAgeLabel(p.obsTime)].filter(Boolean).join(' &middot; ');
  marker.bindPopup(`<strong>${esc(summary.headline)}</strong><br><small>${meta}</small><br><small style="color:#64748b">Reported by a pilot</small>`);
  return marker;
}

async function fetchPirepBox(minLat: number, minLon: number, maxLat: number, maxLon: number): Promise<RawPirep[]> {
  if (!navigator.onLine) return [];
  try {
    const bbox = [minLat, minLon, maxLat, maxLon].map((n) => n.toFixed(2)).join(',');
    const res = await fetch(`/api/pireps?bbox=${bbox}`);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.reports || []) as RawPirep[];
  } catch {
    return [];
  }
}

let pirepLayer: L.LayerGroup | null = null;
let pirepsOn = false;
let pirepGen = 0;

export function setPireps(on: boolean) {
  pirepsOn = on;
  if (!map) return;
  if (!on) {
    pirepGen += 1;
    pirepLayer?.clearLayers();
    updateZoomHint();
    return;
  }
  void refreshPireps();
}

async function refreshPireps() {
  updateZoomHint();
  if (!map || !pirepsOn) return;
  if (map.getZoom() < MIN_PIREP_ZOOM) {
    pirepLayer?.clearLayers();
    return;
  }
  const gen = ++pirepGen;
  const b = map.getBounds();
  const reports = await fetchPirepBox(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
  if (gen !== pirepGen || !map || !pirepsOn) return;

  if (!pirepLayer) pirepLayer = L.layerGroup();
  pirepLayer.clearLayers();
  for (const p of reports) {
    const m = pirepMarker(p);
    if (m) pirepLayer.addLayer(m);
  }
  if (!map.hasLayer(pirepLayer)) pirepLayer.addTo(map);
}

// ---------------------------------------------------------------------------
// Fire and heat detections (NASA FIRMS, last 24 hours)
// ---------------------------------------------------------------------------

function fireMarker(f: Fire): L.CircleMarker {
  const strong = f.frp >= 100;
  const marker = L.circleMarker([f.lat, f.lon], {
    pane: 'hazards',
    radius: strong ? 6 : f.frp >= 30 ? 4.5 : 3.5,
    color: '#7c2d12',
    weight: 1,
    fillColor: strong ? '#ef4444' : '#fb923c',
    fillOpacity: 0.9,
  });
  const when = new Date(f.time);
  const label = `${when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} ${f.time.slice(11, 16)} UTC`;
  marker.bindPopup(
    `<strong>Fire or heat source</strong><br>${Math.round(f.frp)} MW, seen by satellite ${esc(label)}` +
      `<br><small>${esc(placeNear(f.lat, f.lon))}</small>` +
      '<br><small style="color:#64748b">NASA FIRMS (MODIS). Includes wildfires, field burning and gas flares.</small>'
  );
  return marker;
}

let fireLayer: L.LayerGroup | null = null;
let firesOn = false;
let fireGen = 0;

export function setFires(on: boolean) {
  firesOn = on;
  if (!map) return;
  if (!on) {
    fireGen += 1;
    fireLayer?.clearLayers();
    updateZoomHint();
    return;
  }
  void refreshFires();
}

async function refreshFires() {
  updateZoomHint();
  if (!map || !firesOn) return;
  if (map.getZoom() < MIN_FIRE_ZOOM) {
    fireLayer?.clearLayers();
    return;
  }
  const gen = ++fireGen;
  const b = map.getBounds();
  const fires = await fetchFires(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
  if (gen !== fireGen || !map || !firesOn) return;
  if (!fireLayer) fireLayer = L.layerGroup();
  fireLayer.clearLayers();
  for (const f of fires) fireLayer.addLayer(fireMarker(f));
  if (!map.hasLayer(fireLayer)) fireLayer.addTo(map);
}

// ---------------------------------------------------------------------------
// Hazards and pilot reports along a route
// ---------------------------------------------------------------------------

export type { Advisory };

export interface RouteHazardResult {
  advisories: Advisory[];
  pireps: RawPirep[];
  cyclones: StormOnRoute[];
}

const ROUTE_PIREP_RADIUS_MI = 50;

/**
 * Finds AIRMET/SIGMET shapes the route passes through and notable pilot reports
 * within ~50 mi of it. `points` is the route sampled densely as [lat, lon].
 */
export async function analyzeRoute(points: Array<[number, number]>): Promise<RouteHazardResult> {
  if (points.length === 0) return { advisories: [], pireps: [], cyclones: [] };

  const lats = points.map((p) => p[0]);
  const lons = points.map((p) => p[1]);
  const pad = 1;
  const [advisories, boxReports, storms] = await Promise.all([
    fetchAdvisories(),
    fetchPirepBox(Math.min(...lats) - pad, Math.min(...lons) - pad, Math.max(...lats) + pad, Math.max(...lons) + pad),
    fetchCyclones(),
  ]);

  const crossed = advisories.filter((adv) => points.some(([lat, lon]) => pointInPolygon(lat, lon, adv.coords)));

  const nearby = boxReports.filter((p) => {
    if (!summarizePirep(p)) return false;
    return points.some(([lat, lon]) => haversineDistanceLatLon(lat, lon, p.lat, p.lon) <= ROUTE_PIREP_RADIUS_MI);
  });

  return { advisories: crossed, pireps: nearby, cyclones: stormsAlongRoute(points, storms) };
}

const ASH_RADIUS_MI = 100;

/** Volcanic ash advisories over or within 100 mi of a point, closest first. */
export async function ashNear(lat: number, lon: number): Promise<Array<{ advisory: Advisory; miles: number }>> {
  return advisoriesNear(lat, lon, await fetchAdvisories(), 'ASH', ASH_RADIUS_MI);
}

/** Altitude range of an advisory in words ("surface to FL060"), or ''. */
export function advisoryAltitude(adv: Advisory): string {
  if (adv.altLow === 0) return adv.altHigh !== undefined ? `surface to ${altitudeLabel(undefined, adv.altHigh).replace(/^up to /, '')}` : '';
  return altitudeLabel(adv.altLow, adv.altHigh);
}

/** One-line plain-English description of an advisory for the route stats. */
export function describeAdvisory(adv: Advisory): string {
  const alt = advisoryAltitude(adv);
  const until = adv.validTo ? `until ${timeLabel(adv.validTo)}` : '';
  const region = adv.region ? `${adv.region} FIR` : '';
  return [`${adv.type}: ${advisoryTitle(adv)}`, alt, until, region].filter(Boolean).join(', ');
}

export function describeRoutePirep(p: RawPirep): string | null {
  const summary = summarizePirep(p);
  if (!summary) return null;
  const meta = [pirepAltitudeLabel(p), placeNear(p.lat, p.lon), pirepAgeLabel(p.obsTime)].filter(Boolean).join(', ');
  return meta ? `${summary.headline} - ${meta}` : summary.headline;
}

let routeHazardLayer: L.LayerGroup | null = null;

export function clearRouteHazards() {
  routeHazardLayer?.clearLayers();
}

export function drawRouteHazards(result: RouteHazardResult) {
  if (!map) return;
  if (!routeHazardLayer) routeHazardLayer = L.layerGroup().addTo(map);
  routeHazardLayer.clearLayers();
  for (const adv of result.advisories) routeHazardLayer.addLayer(advisoryPolygon(adv, true));
  for (const p of result.pireps) {
    const m = pirepMarker(p);
    if (m) routeHazardLayer.addLayer(m);
  }
  for (const hit of result.cyclones) for (const layer of stormLayers(hit.storm, true)) routeHazardLayer.addLayer(layer);
}

// ---------------------------------------------------------------------------
// Tropical cyclones worldwide (GDACS): forecast cone, track, current position
// ---------------------------------------------------------------------------

const STORM_COLOR = '#f472b6';

function stormTimeLabel(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString('en-US', clockOptions())}`;
}

function stormPopup(storm: Cyclone): string {
  const source = storm.source ? `${esc(storm.source)} advisory via GDACS` : 'via GDACS';
  const link = storm.report ? `<br><a href="${esc(storm.report)}" target="_blank" rel="noopener">GDACS report</a>` : '';
  return (
    `<strong>${esc(stormTitle(storm))}</strong>` +
    `<br>As of ${esc(stormTimeLabel(storm.asOf))} (${source})` +
    `<br>Impact alert: ${esc(storm.alert)}` +
    (storm.cone ? '<br><small>Shaded: forecast uncertainty cone. Dashed: forecast track.</small>' : '') +
    link +
    '<br><small style="color:#64748b">For information only; follow official advisories.</small>'
  );
}

/** Cone, past track (solid), forecast track (dashed) and a marker at the current position. */
function stormLayers(storm: Cyclone, strong: boolean): L.Layer[] {
  const layers: L.Layer[] = [];
  const popup = stormPopup(storm);
  if (storm.cone) {
    layers.push(
      L.polygon(storm.cone, {
        pane: 'hazards',
        color: STORM_COLOR,
        weight: strong ? 2 : 1,
        dashArray: '4, 4',
        fillColor: STORM_COLOR,
        fillOpacity: strong ? 0.18 : 0.1,
      }).bindPopup(popup)
    );
  }
  const past = storm.track.filter((t) => !t.forecast).map((t) => [t.lat, t.lon] as [number, number]);
  const ahead = storm.track.filter((t) => t.forecast).map((t) => [t.lat, t.lon] as [number, number]);
  if (past.length > 1) layers.push(L.polyline(past, { pane: 'hazards', color: STORM_COLOR, weight: 2, opacity: 0.9 }));
  if (ahead.length > 0) {
    layers.push(L.polyline([[storm.lat, storm.lon], ...ahead], { pane: 'hazards', color: STORM_COLOR, weight: 2, dashArray: '6, 6', opacity: 0.9 }));
  }
  layers.push(
    L.marker([storm.lat, storm.lon], {
      icon: L.divIcon({ className: 'storm-icon', html: '<span aria-hidden="true">🌀</span>', iconSize: [26, 26], iconAnchor: [13, 13] }),
      title: stormTitle(storm),
    }).bindPopup(popup)
  );
  return layers;
}

let cycloneLayer: L.LayerGroup | null = null;
let cyclonesOn = false;
let cycloneTimer: number | undefined;

export function setCyclones(on: boolean) {
  cyclonesOn = on;
  window.clearInterval(cycloneTimer);
  if (!map) return;
  if (!on) {
    cycloneLayer?.clearLayers();
    return;
  }
  void refreshCyclones(true);
  cycloneTimer = window.setInterval(() => void refreshCyclones(false), 30 * 60 * 1000);
}

async function refreshCyclones(announce: boolean) {
  if (!map || !cyclonesOn) return;
  const storms = await fetchCyclones();
  if (!map || !cyclonesOn) return;
  if (!cycloneLayer) cycloneLayer = L.layerGroup();
  cycloneLayer.clearLayers();
  for (const storm of storms) for (const layer of stormLayers(storm, false)) cycloneLayer.addLayer(layer);
  if (!map.hasLayer(cycloneLayer)) cycloneLayer.addTo(map);
  if (announce && storms.length === 0) setHint('No active tropical cyclones', 3500);
}

// ---------------------------------------------------------------------------
// Day / night shading
// ---------------------------------------------------------------------------

let nightPolygon: L.Polygon | null = null;
let nightTimer: number | undefined;

/** Subsolar point (degrees) from the standard low-precision solar position formulas. */
function subsolarPoint(date: Date): { lat: number; lon: number } {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * n) * rad;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / rad;
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  let lon = (ra - gmst) % 360;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return { lat: decl / rad, lon };
}

function nightPoints(date: Date): [number, number][] {
  const rad = Math.PI / 180;
  const sun = subsolarPoint(date);
  let declRad = sun.lat * rad;
  if (Math.abs(declRad) < 1e-4) declRad = declRad < 0 ? -1e-4 : 1e-4;

  const pts: [number, number][] = [];
  // Cover the neighboring world copies too so shading follows when the map is panned across the dateline.
  for (let lon = -360; lon <= 360; lon += 2) {
    const h = (lon - sun.lon) * rad;
    const lat = Math.atan(-Math.cos(h) / Math.tan(declRad)) / rad;
    pts.push([lat, lon]);
  }
  const pole = sun.lat >= 0 ? -90 : 90;
  pts.push([pole, 360], [pole, -360]);
  return pts;
}

function drawNight() {
  if (!map) return;
  const pts = nightPoints(new Date());
  if (!nightPolygon) {
    nightPolygon = L.polygon(pts, {
      pane: 'night',
      stroke: false,
      fillColor: '#020617',
      fillOpacity: 0.42,
      interactive: false,
    });
  } else {
    nightPolygon.setLatLngs(pts);
  }
  if (!map.hasLayer(nightPolygon)) nightPolygon.addTo(map);
}

export function setDayNight(on: boolean) {
  window.clearInterval(nightTimer);
  if (!map) return;
  if (!on) {
    if (nightPolygon) map.removeLayer(nightPolygon);
    return;
  }
  drawNight();
  nightTimer = window.setInterval(drawNight, 5 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Runways (with runway numbers at each end)
// ---------------------------------------------------------------------------

const RUNWAY_COLOR = '#e2e8f0';
const RUNWAY_FAVORED = '#4ade80';
const VIEW_RUNWAY_ZOOM = 11;
const VIEW_RUNWAY_CAP = 150;
const LABEL_OFFSET_NM = 0.12; // push the number just past the runway end

interface RunwayShape {
  ident: string;
  casing: L.Polyline;
  line: L.Polyline;
}

let selectedLayer: L.LayerGroup | null = null;
const selectedShapes = new Map<string, RunwayShape[]>();
let viewLayer: L.LayerGroup | null = null;

/** Text rotation (degrees) that follows the runway axis but never renders upside down. */
function labelRotation(axisBearing: number): number {
  let a = (((axisBearing - 90) % 360) + 360) % 360;
  if (a > 90 && a < 270) a -= 180;
  if (a >= 270) a -= 360;
  return a;
}

function addEndLabel(target: L.LayerGroup, ident: string, end: { lat: number; lon: number }, other: { lat: number; lon: number }) {
  const outward = bearingBetween(other.lat, other.lon, end.lat, end.lon);
  const pos = destinationPoint(end.lat, end.lon, outward, LABEL_OFFSET_NM);
  const rot = labelRotation(outward);
  const icon = L.divIcon({
    className: 'rwy-label',
    html: `<span style="transform:rotate(${rot}deg)">${esc(ident)}</span>`,
    iconSize: [44, 18],
    iconAnchor: [22, 9],
  });
  target.addLayer(L.marker([pos.lat, pos.lon], { icon, interactive: false, keyboard: false }));
}

function buildRunwayShapes(airport: Airport, target: L.LayerGroup, weight: number): RunwayShape[] {
  const shapes: RunwayShape[] = [];
  for (const r of airport.runways || []) {
    if (!hasCoords(r)) continue;
    const le = { lat: r.leLat as number, lon: r.leLon as number };
    const he = { lat: r.heLat as number, lon: r.heLon as number };
    const pts: [number, number][] = [
      [le.lat, le.lon],
      [he.lat, he.lon],
    ];
    const casing = L.polyline(pts, { color: '#0f172a', weight: weight + 3, opacity: 0.85, lineCap: 'butt' });
    const line = L.polyline(pts, { color: RUNWAY_COLOR, weight, opacity: 0.95, lineCap: 'butt' });
    line.bindTooltip(`${airport.iata || airport.icao} ${r.ident} - ${r.lengthFt.toLocaleString()} ft`, { sticky: true });
    target.addLayer(casing);
    target.addLayer(line);

    const [leIdent, heIdent] = r.ident.split('/');
    if (leIdent) addEndLabel(target, leIdent, le, he);
    if (heIdent) addEndLabel(target, heIdent, he, le);

    shapes.push({ ident: r.ident, casing, line });
  }
  return shapes;
}

export function clearAirportRunways() {
  selectedLayer?.clearLayers();
  selectedShapes.clear();
}

/** Draws the runways of the given airports; returns bounds covering them (for zooming), if any have coordinates. */
export function showAirportRunways(list: Airport[]): L.LatLngBounds | null {
  if (!map) return null;
  clearAirportRunways();
  if (!selectedLayer) selectedLayer = L.layerGroup().addTo(map);

  let bounds: L.LatLngBounds | null = null;
  for (const airport of list) {
    const key = airport.icao || airport.iata;
    const shapes = buildRunwayShapes(airport, selectedLayer, 4);
    if (shapes.length === 0) continue;
    selectedShapes.set(key, shapes);
    for (const s of shapes) {
      const b = s.line.getBounds();
      bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
    }
  }
  return bounds;
}

/** Highlights the runway (by either end's identifier, e.g. "35L") that matches the wind best. */
export function highlightRunway(airport: Airport, endIdent: string | null) {
  const shapes = selectedShapes.get(airport.icao || airport.iata);
  if (!shapes) return;
  for (const s of shapes) {
    const favored = !!endIdent && s.ident.split('/').includes(endIdent);
    s.line.setStyle({ color: favored ? RUNWAY_FAVORED : RUNWAY_COLOR, weight: favored ? 5 : 4 });
    if (favored) s.line.bringToFront();
  }
}

function refreshViewRunways() {
  if (!map) return;
  if (map.getZoom() < VIEW_RUNWAY_ZOOM) {
    viewLayer?.clearLayers();
    return;
  }
  if (!viewLayer) viewLayer = L.layerGroup().addTo(map);
  viewLayer.clearLayers();

  const bounds = map.getBounds();
  let count = 0;
  for (const a of airports) {
    if (!bounds.contains([a.lat, a.lon])) continue;
    if (selectedShapes.has(a.icao || a.iata)) continue; // already drawn (and possibly highlighted)
    buildRunwayShapes(a, viewLayer, 3);
    if (++count >= VIEW_RUNWAY_CAP) break;
  }
}
