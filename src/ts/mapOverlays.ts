import type { Airport, RunwayDetail } from './geoMath';
import { formatDistance, clockOptions, UNITS_CHANGED } from './units';
import { stationTemp } from './stationTemp';
import { setLegend } from './legend';
import { FLIGHT_CATEGORY_COLOR, stationWindLegend, stationTempLegend, freezingLevelLegend, aerosolLegend, satelliteLegend } from './legends';
import { fetchTfrs, tfrsCrossed, tfrTypeLabel, tfrPlace, type Tfr } from './tfr';
import { gridFor, fetchFreezingGrid, freezingColor, freezingLabel } from './freezingLayer';
import { satelliteTileUrl, satellitesForRange, satelliteCovers, cloudPixel, coldCoreMask, COLD_CORE_RGBA, viewCos, viewWeight, SATELLITE_MAX_NATIVE_ZOOM, type Satellite } from './satelliteTiles';
import { bearingBetween, destinationPoint, haversineDistanceLatLon } from './geoMath';
import { resolveCode } from './searchParser';
import { pointInPolygon, advisoriesNear } from './hazardGeo';
import { fetchCyclones, stormsAlongRoute, stormTitle, type Cyclone, type StormOnRoute } from './cyclones';
import { fetchFires, type Fire } from './fires';
import { aerosolTileUrl, aerosolDays, AEROSOL_MAX_NATIVE_ZOOM, fillFromYesterday, keepAerosolPixels } from './aerosolTiles';
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

const WX_COLOR = FLIGHT_CATEGORY_COLOR;

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
const MIN_FREEZING_ZOOM = 3;

/** Shows a "zoom in" hint naming whichever zoom-limited layers are on but too far out. */
function updateZoomHint() {
  if (!map) return;
  const z = map.getZoom();
  const needed: string[] = [];
  if (stationsOn && z < MIN_STATION_ZOOM) needed.push('weather stations');
  if (pirepsOn && z < MIN_PIREP_ZOOM) needed.push('pilot reports');
  if (firesOn && z < MIN_FIRE_ZOOM) needed.push('fires');
  if (freezingOn && z < MIN_FREEZING_ZOOM) needed.push('the freezing level');
  setHint(needed.length ? `Zoom in to see ${needed.join(' and ')}` : null);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initOverlays(m: L.Map) {
  if (map) return;
  map = m;

  // Night shading sits just above the base tiles; hazards sit under the airport markers.
  map.createPane('satellite').style.zIndex = '240';
  map.getPane('satellite')!.style.pointerEvents = 'none';
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
      void refreshFreezing();
      noteSatelliteGap();
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
// Weather stations layer: wind arrows, with a ring only when conditions are not VFR, or
// temperatures colored cold to hot, with freezing and fog-risk marks
// ---------------------------------------------------------------------------

let stationLayer: L.LayerGroup | null = null;
let stationsOn = false;
let stationGen = 0;

export type StationMode = 'wind' | 'temp';
let stationMode: StationMode = 'wind';
let lastStations: Station[] = [];

/** Switches what each station shows, redrawing from the last response without a new request. */
export function setStationMode(mode: StationMode) {
  stationMode = mode;
  showStationLegend();
  drawStations();
}

function showStationLegend() {
  setLegend('stations', stationsOn ? (stationMode === 'temp' ? stationTempLegend() : stationWindLegend()) : null);
}

const MAX_STATIONS = 500;

export function setWeatherStations(on: boolean) {
  stationsOn = on;
  showStationLegend();
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
  t?: number; // degrees C
  d?: number; // dewpoint, degrees C
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

function tempIcon(s: Station): L.DivIcon | null {
  const t = stationTemp(s.t, s.d);
  if (!t) return null;
  const marks =
    (t.freezing ? '<span class="wx-mark wx-freezing" title="At or below freezing">\u2744</span>' : '') +
    (t.fogRisk ? '<span class="wx-mark wx-fog" title="Fog risk">fog</span>' : '');
  return L.divIcon({
    className: 'wx-station wx-temp',
    html: `<span class="wx-temp-pill" style="background:${t.color}">${t.label}</span>${marks}`,
    iconSize: [40, 34],
    iconAnchor: [20, 17],
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

    lastStations = (json.stations || []) as Station[];
    drawStations();
  } catch {
    /* offline or upstream hiccup: keep whatever is drawn */
  }
}

function drawStations() {
  if (!map || !stationsOn) return;
  const zoom = map.getZoom();
  if (zoom < MIN_STATION_ZOOM) return;
  if (!stationLayer) stationLayer = L.layerGroup();
  stationLayer.clearLayers();

  let shown = 0;
  for (const s of lastStations) {
    const airport = resolveCode(s.id);
    // Declutter when zoomed out: major airports only (their ring still shows when not VFR).
    const major = !!airport && ['large_airport', 'medium_airport', 'regional'].includes(airport.type);
    if (zoom < 8 && !major) continue;

    const temp = stationTemp(s.t, s.d);
    const icon = stationMode === 'temp' ? tempIcon(s) : stationIcon(s);
    if (!icon) continue; // temperature view: station sent no temperature
    if (++shown > MAX_STATIONS) break;

    const wind = s.ws !== undefined && s.ws >= 1 ? `${s.wd !== undefined ? s.wd + '\u00b0 ' : ''}@ ${s.ws}kt${s.wg ? ' G' + s.wg : ''}` : 'calm';
    const tip =
      stationMode === 'temp' && temp
        ? `${s.id} - ${temp.detail}${temp.freezing ? ', freezing' : ''}${temp.fogRisk ? ', fog risk' : ''}`
        : `${s.id}${s.cat ? ' ' + s.cat : ''} - ${wind}${temp ? `, ${temp.detail}` : ''}`;
    const marker = L.marker([s.lat, s.lon], { icon, keyboard: false });
    marker.bindTooltip(tip, { direction: 'top', offset: [0, -10] });
    marker.on('click', () => {
      if (airport) (window as any).renderSingleAirport?.(airport);
    });
    stationLayer.addLayer(marker);
  }
  if (!map.hasLayer(stationLayer)) stationLayer.addTo(map);
}

// Temperatures follow the weather units setting.
window.addEventListener(UNITS_CHANGED, () => {
  if (satelliteOn) setLegend('satellite', satelliteLegend());
  if (stationMode === 'temp') {
    showStationLegend();
    drawStations();
  }
});

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
  PCPN: { color: '#60a5fa', label: 'Heavy precipitation' },
};

/** Who issued it: "Miami Center" for a CWA, "Oakland Oceanic FIR" for an international SIGMET. */
function issuerLabel(adv: Advisory): string {
  if (!adv.region) return '';
  return adv.type === 'CWA' ? adv.region : `${adv.region} FIR`;
}

/** "Center weather advisory" spelled out, since few readers know "CWA". */
function typeLabel(adv: Advisory): string {
  return adv.type === 'CWA' ? 'Center weather advisory' : adv.type;
}

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
  const sigmet = adv.type === 'SIGMET' || adv.type === 'CWA'; // both drawn solid: short-lived, significant
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
    `<strong>${esc(typeLabel(adv))}: ${esc(advisoryTitle(adv))}</strong>` +
      (adv.region ? `<br>${esc(issuerLabel(adv))}` : '') +
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
  if (announce && list.length === 0) setHint('No active AIRMETs, SIGMETs or center weather advisories', 3500);
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
  tfrs: Tfr[];
}

const ROUTE_PIREP_RADIUS_MI = 50;

/**
 * Finds AIRMET/SIGMET shapes the route passes through and notable pilot reports
 * within ~50 mi of it. `points` is the route sampled densely as [lat, lon].
 */
export async function analyzeRoute(points: Array<[number, number]>): Promise<RouteHazardResult> {
  if (points.length === 0) return { advisories: [], pireps: [], cyclones: [], tfrs: [] };

  const lats = points.map((p) => p[0]);
  const lons = points.map((p) => p[1]);
  const pad = 1;
  const [advisories, boxReports, storms, tfrs] = await Promise.all([
    fetchAdvisories(),
    fetchPirepBox(Math.min(...lats) - pad, Math.min(...lons) - pad, Math.max(...lats) + pad, Math.max(...lons) + pad),
    fetchCyclones(),
    fetchTfrs(),
  ]);

  const crossed = advisories.filter((adv) => points.some(([lat, lon]) => pointInPolygon(lat, lon, adv.coords)));

  const nearby = boxReports.filter((p) => {
    if (!summarizePirep(p)) return false;
    return points.some(([lat, lon]) => haversineDistanceLatLon(lat, lon, p.lat, p.lon) <= ROUTE_PIREP_RADIUS_MI);
  });

  return { advisories: crossed, pireps: nearby, cyclones: stormsAlongRoute(points, storms), tfrs: tfrsCrossed(points, tfrs) };
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
  return [`${typeLabel(adv)}: ${advisoryTitle(adv)}`, alt, until, issuerLabel(adv)].filter(Boolean).join(', ');
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
  for (const t of result.tfrs) for (const poly of tfrPolygons(t, true)) routeHazardLayer.addLayer(poly);
}

// ---------------------------------------------------------------------------
// US temporary flight restrictions (FAA)
// ---------------------------------------------------------------------------

const TFR_COLOR = '#f43f5e';
let tfrLayer: L.LayerGroup | null = null;
let tfrsOn = false;
let tfrTimer: number | undefined;

function tfrPolygons(t: Tfr, strong: boolean): L.Polygon[] {
  return t.rings.map((ring) => {
    const poly = L.polygon(ring, {
      pane: 'hazards',
      color: TFR_COLOR,
      weight: strong ? 3 : 2,
      fillColor: TFR_COLOR,
      fillOpacity: strong ? 0.22 : 0.12,
    });
    poly.bindPopup(
      `<strong>Flight restriction: ${esc(tfrTypeLabel(t.type))}</strong><br>${esc(tfrPlace(t.description))}` +
        `<br><a href="${esc(t.url)}" target="_blank" rel="noopener">FAA details (altitudes, times)</a>`
    );
    return poly;
  });
}

export function setTfrs(on: boolean) {
  tfrsOn = on;
  window.clearInterval(tfrTimer);
  if (!map) return;
  if (!on) {
    tfrLayer?.clearLayers();
    return;
  }
  void refreshTfrs(true);
  tfrTimer = window.setInterval(() => void refreshTfrs(false), 10 * 60 * 1000);
}

async function refreshTfrs(announce: boolean) {
  if (!map || !tfrsOn) return;
  const list = await fetchTfrs();
  if (!map || !tfrsOn) return;
  if (!tfrLayer) tfrLayer = L.layerGroup();
  tfrLayer.clearLayers();
  for (const t of list) for (const poly of tfrPolygons(t, false)) tfrLayer.addLayer(poly);
  if (!map.hasLayer(tfrLayer)) tfrLayer.addTo(map);
  if (announce) setHint(list.length ? 'US flight restrictions (TFRs): most reach only a few thousand feet' : 'No active US flight restrictions', 4000);
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
// Dust and smoke (NASA GIBS, daily OMPS aerosol index), clean-air pixels removed
// ---------------------------------------------------------------------------

let aerosolLayer: L.GridLayer | null = null;

function createAerosolLayer(): L.GridLayer {
  const AerosolLayer = L.GridLayer.extend({ createTile: aerosolTile }) as new (options: L.GridLayerOptions) => L.GridLayer;
  return new AerosolLayer({
    pane: 'hazards',
    tileSize: 256,
    maxNativeZoom: AEROSOL_MAX_NATIVE_ZOOM,
    opacity: 0.85,
    attribution: 'Dust and smoke: NASA GIBS, OMPS (NOAA-20)',
  });
}

/** Loads one day's tile as pixels, or null when it is missing. */
function loadAerosolPixels(day: string, coords: L.Coords): Promise<ImageData | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0, 256, 256);
      resolve(ctx.getImageData(0, 0, 256, 256));
    };
    img.onerror = () => resolve(null);
    img.src = L.Util.template(aerosolTileUrl(day), { x: coords.x, y: coords.y, z: coords.z });
  });
}

/** Today's observations where there are any yet, yesterday's elsewhere, clean air removed. */
function aerosolTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const { today, yesterday } = aerosolDays();
  void Promise.all([loadAerosolPixels(today, coords), loadAerosolPixels(yesterday, coords)]).then(([now, before]) => {
    const merged = now ?? before; // a missing tile just stays empty
    const ctx = canvas.getContext('2d');
    if (merged && ctx) {
      if (now && before) fillFromYesterday(now.data, before.data);
      keepAerosolPixels(merged.data);
      ctx.putImageData(merged, 0, 0);
    }
    done(undefined, canvas);
  });
  return canvas;
}

let aerosolTimer: number | undefined;

export function setAerosol(on: boolean) {
  setLegend('aerosol', on ? aerosolLegend() : null);
  if (!map) return;
  window.clearInterval(aerosolTimer);
  if (!on) {
    if (aerosolLayer && map.hasLayer(aerosolLayer)) map.removeLayer(aerosolLayer);
    return;
  }
  if (!aerosolLayer) aerosolLayer = createAerosolLayer();
  if (!map.hasLayer(aerosolLayer)) aerosolLayer.addTo(map);
  // New passes land through the day, so redraw hourly while the layer is on.
  aerosolTimer = window.setInterval(() => aerosolLayer?.redraw(), 60 * 60 * 1000);
  setHint('Dust and smoke (latest daily pass): yellow is some, red is thick', 5000);
}

// ---------------------------------------------------------------------------
// Freezing level (Open-Meteo model, coarse grid over the view, smoothed by the browser)
// ---------------------------------------------------------------------------

let freezingOn = false;
let freezingGen = 0;
let freezingLayer: L.LayerGroup | null = null;
let freezingTimer: number | undefined;

export function setFreezingLevel(on: boolean) {
  freezingOn = on;
  setLegend('freezing', on ? freezingLevelLegend() : null);
  if (!map) return;
  window.clearInterval(freezingTimer);
  if (!on) {
    freezingGen += 1;
    freezingLayer?.clearLayers();
    updateZoomHint();
    return;
  }
  setHint('Freezing level in thousands of feet: dark blue is low, near the ground', 5000);
  void refreshFreezing();
  // Model values change hourly; the grid cache keeps each point for 30 minutes.
  freezingTimer = window.setInterval(() => void refreshFreezing(), 30 * 60 * 1000);
}

/** One canvas pixel per sample, stretched over the grid so the browser blends between them. */
function freezingImage(values: number[][]): string | null {
  const rows = values.length;
  const cols = values[0]?.length || 0;
  if (!rows || !cols) return null;
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(cols, rows);
  for (let r = 0; r < rows; r++) {
    const src = values[rows - 1 - r]; // canvas rows run north to south
    for (let c = 0; c < cols; c++) {
      const [R, G, B, A] = freezingColor(src[c]);
      const i = (r * cols + c) * 4;
      img.data[i] = R;
      img.data[i + 1] = G;
      img.data[i + 2] = B;
      img.data[i + 3] = Math.round(A * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
}

async function refreshFreezing() {
  updateZoomHint();
  if (!map || !freezingOn) return;
  if (map.getZoom() < MIN_FREEZING_ZOOM) {
    freezingLayer?.clearLayers();
    return;
  }
  const b = map.getBounds();
  const grid = gridFor(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
  if (!grid) return;

  const gen = ++freezingGen;
  const values = await fetchFreezingGrid(grid);
  if (gen !== freezingGen || !map || !freezingOn) return;
  if (!values.some((row) => row.some(Number.isFinite))) return; // nothing to draw yet: keep what is shown

  if (!freezingLayer) freezingLayer = L.layerGroup().addTo(map);
  if (!map.hasLayer(freezingLayer)) freezingLayer.addTo(map);
  freezingLayer.clearLayers();

  const url = freezingImage(values);
  if (url) {
    const half = grid.cell / 2;
    const bounds = L.latLngBounds(
      [grid.lats[0] - half, grid.lons[0] - half],
      [grid.lats[grid.lats.length - 1] + half, grid.lons[grid.lons.length - 1] + half]
    );
    freezingLayer.addLayer(L.imageOverlay(url, bounds, { pane: 'night', className: 'freezing-image', interactive: false }));
  }
  grid.lats.forEach((lat, r) =>
    grid.lons.forEach((lon, c) => {
      const label = freezingLabel(values[r][c]);
      if (!label) return;
      freezingLayer!.addLayer(
        L.marker([lat, lon], {
          icon: L.divIcon({ className: 'freezing-label', html: label, iconSize: [24, 14], iconAnchor: [12, 7] }),
          interactive: false,
          keyboard: false,
          pane: 'night',
        })
      );
    })
  );
}

// ---------------------------------------------------------------------------
// Satellite clouds (NASA GIBS geostationary infrared, newest image), ground cleared
// ---------------------------------------------------------------------------

let satelliteLayer: L.GridLayer | null = null;
let satelliteTimer: number | undefined;
let satelliteOn = false;

function createSatelliteLayer(): L.GridLayer {
  const SatelliteLayer = L.GridLayer.extend({ createTile: satelliteTile }) as new (options: L.GridLayerOptions) => L.GridLayer;
  return new SatelliteLayer({
    pane: 'satellite',
    tileSize: 256,
    maxNativeZoom: SATELLITE_MAX_NATIVE_ZOOM,
    opacity: 0.9,
    attribution: 'Clouds: NASA GIBS, GOES (NOAA) and Himawari (JMA)',
  });
}

function loadSatellitePixels(sat: Satellite, coords: L.Coords): Promise<ImageData | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0, 256, 256);
      resolve(ctx.getImageData(0, 0, 256, 256));
    };
    img.onerror = () => resolve(null);
    img.src = L.Util.template(satelliteTileUrl(sat), { x: coords.x, y: coords.y, z: coords.z });
  });
}

/** Longitude of the left edge of tile column x at zoom z. */
const tileLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
/** Latitude of the top edge of tile row y at zoom z (Web Mercator). */
const tileLat = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

/**
 * Each pixel from the satellite with the most direct view that has data there, faded toward the
 * edge of that view; ground cleared.
 */
function satelliteTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const west = tileLon(coords.x, coords.z);
  const east = tileLon(coords.x + 1, coords.z);
  const sats = satellitesForRange(west, east);
  void Promise.all(sats.map((sat) => loadSatellitePixels(sat, coords))).then((tiles) => {
    const ctx = canvas.getContext('2d');
    const loaded = new Map<Satellite, ImageData>();
    sats.forEach((sat, i) => tiles[i] && loaded.set(sat, tiles[i]!));
    if (ctx && loaded.size) {
      const out = ctx.createImageData(256, 256);
      const list = [...loaded.keys()];
      const data = list.map((sat) => loaded.get(sat)!.data);
      // The coldest storm tops share NASA's gray ramp with warm ground; find them by their surroundings.
      const cores = data.map((d) => coldCoreMask(d));
      // cos(view angle) = cos(lat) * cos(longitude from the satellite): the longitude part per
      // column and satellite once, the latitude part per row.
      const cosLon = list.map((sat) =>
        Float64Array.from({ length: 256 }, (_, x) => viewCos(0, west + ((east - west) * (x + 0.5)) / 256, sat))
      );
      const cosView = new Float64Array(list.length);
      for (let y = 0; y < 256; y++) {
        const cosLat = Math.cos((tileLat(coords.y + (y + 0.5) / 256, coords.z) * Math.PI) / 180);
        for (let x = 0; x < 256; x++) {
          const i = (y * 256 + x) * 4;
          for (let k = 0; k < list.length; k++) cosView[k] = cosLat * cosLon[k][x];
          // Most direct view first; a satellite with no data at this pixel hands over to the next.
          let used = 0;
          while (used < list.length) {
            let best = -1;
            for (let k = 0; k < list.length; k++) if (cosView[k] > -2 && (best < 0 || cosView[k] > cosView[best])) best = k;
            if (best < 0) break;
            const weight = viewWeight(cosView[best]);
            if (weight <= 0) break;
            const d = data[best];
            if (d[i + 3] === 0) {
              cosView[best] = -3; // skip it next round
              used++;
              continue;
            }
            const [r, g, b, a] = cores[best][i / 4] ? COLD_CORE_RGBA : cloudPixel(d[i], d[i + 1], d[i + 2], d[i + 3]);
            out.data[i] = r;
            out.data[i + 1] = g;
            out.data[i + 2] = b;
            out.data[i + 3] = Math.round(a * weight);
            break;
          }
        }
      }
      ctx.putImageData(out, 0, 0);
    }
    done(undefined, canvas);
  });
  return canvas;
}

/** Says so when the middle of the view has no satellite in this source. */
function noteSatelliteGap() {
  if (!map || !satelliteOn) return;
  const c = map.getCenter().wrap();
  if (!satelliteCovers(c.lat, c.lng)) {
    setHint('No satellite cloud images for Europe, Africa or the Middle East in this source', 5000);
  }
}

export function setSatellite(on: boolean) {
  satelliteOn = on;
  setLegend('satellite', on ? satelliteLegend() : null);
  if (!map) return;
  window.clearInterval(satelliteTimer);
  if (!on) {
    if (satelliteLayer && map.hasLayer(satelliteLayer)) map.removeLayer(satelliteLayer);
    return;
  }
  if (!satelliteLayer) satelliteLayer = createSatelliteLayer();
  if (!map.hasLayer(satelliteLayer)) satelliteLayer.addTo(map);
  // A new image every 10 minutes.
  satelliteTimer = window.setInterval(() => satelliteLayer?.redraw(), 10 * 60 * 1000);
  const c = map.getCenter().wrap();
  if (satelliteCovers(c.lat, c.lng)) {
    setHint('Satellite clouds (infrared, latest image): the colder the cloud top, the stronger the storm', 5000);
  } else {
    noteSatelliteGap();
  }
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
