import type { Airport, RunwayDetail } from './geoMath';
import { formatDistance, clockOptions, UNITS_CHANGED } from './units';
import { stationTemp } from './stationTemp';
import { setLegend } from './legend';
import { FLIGHT_CATEGORY_COLOR, stationWindLegend, stationTempLegend, freezingLevelLegend, aerosolLegend, satelliteLegend, pirepLegend, fireLegend, hazardLegend, cycloneLegend, tfrLegend, tcfLegend, radarLegend, stormTopsLegend, spcLegend, geohazardsLegend, auroraLegend, HAZARD_GLYPH } from './legends';
import { fetchSpcOutlook, spcLevel, spcCategoryName, spcRiskWord, type SpcDay } from './spc';
import { fetchGeohazards, quakeSeverity, quakeRadius, volcanoSeverity, colorCodeLabel } from './geohazards';
import { fetchSpaceWeather, auroraLookup, auroraRgba, scalesLabel } from './spaceWeather';
import {
  IEM_REFLECTIVITY_URL,
  IEM_REFLECTIVITY_TIME_URL,
  IEM_ECHO_TOPS_URL,
  IEM_ECHO_TOPS_TIME_URL,
  iemTopsLevel,
  type RadarMode,
  RAINVIEWER_MAPS_URL,
  IEM_MAX_NATIVE_ZOOM,
  RAINVIEWER_MAX_NATIVE_ZOOM,
  US_RADAR_BOX,
  inUsRadarBox,
  tileInsideUsBox,
  tileTouchesUsBox,
  recolorTile,
  iemReflectivityLevel,
  rainviewerLevel,
  rainviewerFrame,
  iemTime,
} from './radarTiles';
import { fetchTcf, tcfForStep, tcfSeverity, tcfCoverageLabel, TCF_STEP_HOURS, type TcfArea, type TcfStep } from './tcf';
import { severityColor, severityName, fireSeverity, advisorySeverity, cycloneSeverity, tfrSeverity } from './severity';
import { fetchTfrs, tfrsCrossed, tfrTypeLabel, tfrPlace, type Tfr } from './tfr';
import { gridFor, fetchFreezingGrid, freezingColor, freezingLabel } from './freezingLayer';
import {
  satelliteTileUrl,
  satellitesForRange,
  satelliteCovers,
  cloudPixel,
  coldCoreMask,
  COLD_CORE_RGBA,
  viewCos,
  viewWeight,
  SATELLITE_MAX_NATIVE_ZOOM,
  SATELLITES,
  eumetsatTileUrl,
  eumetsatCapabilitiesUrl,
  latestHourlyTime,
  meteosatPixel,
  type Satellite,
} from './satelliteTiles';
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
  map.createPane('radar').style.zIndex = '260';
  map.getPane('radar')!.style.pointerEvents = 'none';
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

/** Plain-English hazard names; the color of a hazard shape is its severity (severity.ts). */
const HAZARD_LABEL: Record<string, string> = {
  TURB: 'Turbulence',
  ICE: 'Icing',
  IFR: 'Low ceilings / visibility',
  'MTN OBSCN': 'Mountain obscuration',
  CONVECTIVE: 'Thunderstorms',
  ASH: 'Volcanic ash',
  TC: 'Tropical cyclone',
  PCPN: 'Heavy precipitation',
  'SFC WND': 'Strong surface wind',
  LLWS: 'Low-level wind shear',
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

function hazardLabel(hazard: string): string {
  return HAZARD_LABEL[hazard] || hazard;
}

/** "Severe turbulence", "Embedded thunderstorms", "Volcanic ash (Mt Ibu)". */
function advisoryTitle(adv: Advisory): string {
  const label = hazardLabel(adv.hazard);
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
  setLegend('hazards', on ? hazardLegend() : null);
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

/**
 * An advisory's shape (color = severity; dashed = AIRMET) and a small glyph for its hazard at the
 * middle of the shape, since the color no longer says what kind it is.
 */
function advisoryLayers(adv: Advisory, strong: boolean): L.Layer[] {
  const level = advisorySeverity(adv);
  const color = severityColor(level);
  const sigmet = adv.type === 'SIGMET' || adv.type === 'CWA'; // both drawn solid: short-lived, significant
  const poly = L.polygon(adv.coords, {
    pane: 'hazards',
    color,
    weight: strong ? 3 : sigmet ? 2.5 : 1.5,
    dashArray: sigmet || strong ? undefined : '5, 5',
    fillColor: color,
    fillOpacity: strong ? 0.24 : sigmet ? 0.18 : 0.1,
  });
  const alt = advisoryAltitude(adv);
  const popup =
    `<strong>${esc(severityName(level))}: ${esc(typeLabel(adv))}: ${esc(advisoryTitle(adv))}</strong>` +
      (adv.region ? `<br>${esc(issuerLabel(adv))}` : '') +
      (alt ? `<br>${esc(alt)}` : '') +
      (adv.validTo ? `<br>Until ${esc(timeLabel(adv.validTo))}` : '') +
      (adv.raw ? `<br><small style="color:#64748b">${esc(String(adv.raw).replace(/\s+/g, ' ').slice(0, 320))}</small>` : '');
  poly.bindPopup(popup);
  const [lat, lon] = ringMiddle(adv.coords);
  const glyph = L.marker([lat, lon], {
    pane: 'hazards',
    icon: L.divIcon({
      className: 'hazard-glyph',
      html: `<span style="--c:${color}">${HAZARD_GLYPH[adv.hazard] || '!'}</span>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    }),
    keyboard: false,
  }).bindPopup(popup);
  return [poly, glyph];
}

/** Average of a ring's points: good enough to place a label inside the small, convex shapes advisories mostly are. */
function ringMiddle(ring: [number, number][]): [number, number] {
  const n = ring.length || 1;
  return [ring.reduce((a, p) => a + p[0], 0) / n, ring.reduce((a, p) => a + p[1], 0) / n];
}

async function refreshHazards(announce: boolean) {
  if (!map || !hazardsOn) return;
  if (announce) advisoryCache = null; // a fresh toggle-on always asks for current data
  const list = await fetchAdvisories();
  if (!map || !hazardsOn) return;

  if (!hazardLayer) hazardLayer = L.layerGroup();
  hazardLayer.clearLayers();
  for (const adv of list) for (const layer of advisoryLayers(adv, false)) hazardLayer.addLayer(layer);
  if (!map.hasLayer(hazardLayer)) hazardLayer.addTo(map);
  if (announce && list.length === 0) setHint('No active AIRMETs, SIGMETs or center weather advisories', 3500);
}

// ---------------------------------------------------------------------------
// Pilot reports on the map, in plain English
// ---------------------------------------------------------------------------

/** Marker shape for each kind of pilot report; the color is its severity. */
export const PIREP_SHAPE: Record<PirepKind, string> = {
  turb: 'diamond',
  ice: 'dot',
  both: 'square',
  vis: 'dot',
};
const LOW_VIS_COLOR = '#94a3b8';

function pirepMarker(p: RawPirep): L.Marker | null {
  const summary = summarizePirep(p);
  if (!summary) return null;
  const color = summary.severity ? severityColor(summary.severity) : LOW_VIS_COLOR;
  const size = summary.severity ? 8 + summary.severity * 2 : 8;
  const marker = L.marker([p.lat, p.lon], {
    icon: L.divIcon({
      className: 'pirep-icon',
      html: `<span class="pirep-mark pirep-${PIREP_SHAPE[summary.kind]}" style="--c:${color};--s:${size}px"></span>`,
      iconSize: [size + 4, size + 4],
      iconAnchor: [(size + 4) / 2, (size + 4) / 2],
    }),
    keyboard: false,
  });
  const level = summary.severity ? `${severityName(summary.severity)}: ` : '';
  const meta = [pirepAltitudeLabel(p), placeNear(p.lat, p.lon), p.acType, pirepAgeLabel(p.obsTime)].filter(Boolean).join(' &middot; ');
  marker.bindPopup(`<strong>${esc(level + summary.headline)}</strong><br><small>${meta}</small><br><small style="color:#64748b">Reported by a pilot</small>`);
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
  setLegend('pireps', on ? pirepLegend() : null);
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

const FIRE_RADIUS = [0, 3.5, 4.5, 6, 7.5];

function fireMarker(f: Fire): L.CircleMarker {
  const level = fireSeverity(f.frp);
  const marker = L.circleMarker([f.lat, f.lon], {
    pane: 'hazards',
    radius: FIRE_RADIUS[level],
    color: '#1c1917',
    weight: 1,
    fillColor: severityColor(level),
    fillOpacity: 0.9,
  });
  const when = new Date(f.time);
  const label = `${when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} ${f.time.slice(11, 16)} UTC`;
  marker.bindPopup(
    `<strong>Fire or heat source: ${esc(severityName(level).toLowerCase())}</strong><br>${Math.round(f.frp)} MW, seen by satellite ${esc(label)}` +
      `<br><small>${esc(placeNear(f.lat, f.lon))}</small>` +
      '<br><small style="color:#64748b">NASA FIRMS (MODIS). Includes wildfires, field burning and gas flares.</small>'
  );
  return marker;
}

let fireLayer: L.LayerGroup | null = null;
let firesOn = false;
let fireGen = 0;

export function setFires(on: boolean) {
  setLegend('fires', on ? fireLegend() : null);
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
  for (const adv of result.advisories) for (const layer of advisoryLayers(adv, true)) routeHazardLayer.addLayer(layer);
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

let tfrLayer: L.LayerGroup | null = null;
let tfrsOn = false;
let tfrTimer: number | undefined;

function tfrPolygons(t: Tfr, strong: boolean): L.Polygon[] {
  const level = tfrSeverity(t.type);
  const color = severityColor(level);
  return t.rings.map((ring) => {
    const poly = L.polygon(ring, {
      pane: 'hazards',
      color,
      weight: strong ? 3 : 2,
      fillColor: color,
      fillOpacity: strong ? 0.22 : 0.12,
    });
    poly.bindPopup(
      `<strong>${esc(severityName(level))}: flight restriction (${esc(tfrTypeLabel(t.type))})</strong><br>${esc(tfrPlace(t.description))}` +
        `<br><a href="${esc(t.url)}" target="_blank" rel="noopener">FAA details (altitudes, times)</a>`
    );
    return poly;
  });
}

export function setTfrs(on: boolean) {
  tfrsOn = on;
  setLegend('tfrs', on ? tfrLegend() : null);
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
// Thunderstorm forecast (AWC TFM Convective Forecast, US, 4/6/8 hours ahead)
// ---------------------------------------------------------------------------

let tcfLayer: L.LayerGroup | null = null;
let tcfOn = false;
let tcfStep: TcfStep = 0;
let tcfTimer: number | undefined;

/** "FL340" for storm tops. */
function topsLabel(feet?: number): string {
  return feet === undefined ? '' : feet >= 18000 ? `FL${Math.round(feet / 100)}` : `${feet.toLocaleString()} ft`;
}

function tcfLayers(a: TcfArea): L.Layer[] {
  const level = tcfSeverity(a);
  const color = severityColor(level);
  const low = a.confidence === 'low';
  const popup =
    `<strong>${esc(severityName(level))}: thunderstorms forecast</strong>` +
    `<br>Coverage: ${esc(tcfCoverageLabel(a))}` +
    `<br>Confidence: ${esc(a.confidence || 'not given')}` +
    (a.tops ? `<br>Tops to ${esc(topsLabel(a.tops))}` : '') +
    `<br>For ${esc(timeLabel(a.validTime))}` +
    `<br><small style="color:#64748b">TFM Convective Forecast, Aviation Weather Center</small>`;
  const shape =
    a.kind === 'line'
      ? L.polyline(a.coords, { pane: 'hazards', color, weight: 5, dashArray: low ? '8, 6' : undefined })
      : L.polygon(a.coords, {
          pane: 'hazards',
          color,
          weight: 2,
          dashArray: low ? '6, 5' : undefined,
          fillColor: color,
          fillOpacity: a.coverage === 'sparse' ? 0.12 : 0.22,
        });
  shape.bindPopup(popup);
  if (!a.tops || a.kind === 'line') return [shape];
  const [lat, lon] = ringMiddle(a.coords);
  const label = L.marker([lat, lon], {
    pane: 'hazards',
    icon: L.divIcon({ className: 'tcf-tops', html: `<span style="--c:${color}">${Math.round(a.tops / 1000)}</span>`, iconSize: [26, 16], iconAnchor: [13, 8] }),
    keyboard: false,
  }).bindPopup(popup);
  return [shape, label];
}

export function setTcf(on: boolean) {
  tcfOn = on;
  setLegend('tcf', on ? tcfLegend() : null);
  window.clearInterval(tcfTimer);
  if (!map) return;
  if (!on) {
    tcfLayer?.clearLayers();
    return;
  }
  void refreshTcf(true);
  // Issued every 2 hours; the server caches 10 minutes.
  tcfTimer = window.setInterval(() => void refreshTcf(false), 10 * 60 * 1000);
}

/** Which forecast to show: 0, 1, 2 for about 4, 6, 8 hours ahead. */
export function setTcfStep(step: TcfStep) {
  tcfStep = step;
  if (tcfOn) void refreshTcf(true);
}

async function refreshTcf(announce: boolean) {
  if (!map || !tcfOn) return;
  const { time, areas } = tcfForStep(await fetchTcf(), tcfStep);
  if (!map || !tcfOn) return;
  if (!tcfLayer) tcfLayer = L.layerGroup();
  tcfLayer.clearLayers();
  for (const a of areas) for (const layer of tcfLayers(a)) tcfLayer.addLayer(layer);
  if (!map.hasLayer(tcfLayer)) tcfLayer.addTo(map);
  if (announce) {
    setHint(
      time ? `Thunderstorms forecast for ${timeLabel(time)} (about ${TCF_STEP_HOURS[tcfStep]} hours ahead)` : 'No thunderstorms forecast over the US',
      4000
    );
  }
}

// ---------------------------------------------------------------------------
// Severe storm outlook (NOAA SPC, US, today or tomorrow)
// ---------------------------------------------------------------------------

let spcLayer: L.LayerGroup | null = null;
let spcOn = false;
let spcDay: SpcDay = 1;
let spcTimer: number | undefined;

/** Soft blue for general (not severe) thunderstorms, as radar draws plain rain. */
const SPC_TSTM_COLOR = 'rgb(96, 165, 250)';

function spcDateLabel(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.toLocaleTimeString('en-US', clockOptions())}`;
}

export function setSpc(on: boolean) {
  spcOn = on;
  setLegend('spc', on ? spcLegend() : null);
  window.clearInterval(spcTimer);
  if (!map) return;
  if (!on) {
    spcLayer?.clearLayers();
    return;
  }
  void refreshSpc(true);
  // SPC updates the day 1 outlook several times a day; the server caches 15 minutes.
  spcTimer = window.setInterval(() => void refreshSpc(false), 15 * 60 * 1000);
}

/** Which outlook to show: today (1) or tomorrow (2). */
export function setSpcDay(day: SpcDay) {
  spcDay = day;
  if (spcOn) void refreshSpc(true);
}

async function refreshSpc(announce: boolean) {
  if (!map || !spcOn) return;
  const day = spcDay;
  const outlook = await fetchSpcOutlook(day);
  if (!map || !spcOn || day !== spcDay) return;
  if (!spcLayer) spcLayer = L.layerGroup();
  spcLayer.clearLayers();
  const when = outlook ? `${spcDateLabel(outlook.validFrom)} to ${spcDateLabel(outlook.validTo)}` : '';
  for (const area of outlook?.areas || []) {
    const level = spcLevel(area.category);
    const color = level === 0 ? SPC_TSTM_COLOR : severityColor(level);
    const popup =
      `<strong>${level === 0 ? '' : `${esc(severityName(level))}: `}${esc(spcCategoryName(area.category))}</strong>` +
      (when ? `<br>${esc(when)}` : '') +
      `<br><small style="color:#64748b">NOAA Storm Prediction Center, day ${day} outlook</small>`;
    for (const poly of area.polygons) {
      spcLayer.addLayer(
        L.polygon(poly, { pane: 'hazards', color, weight: level >= 3 ? 2.5 : 1.5, fillColor: color, fillOpacity: level === 0 ? 0.06 : 0.14 }).bindPopup(popup)
      );
    }
  }
  if (!map.hasLayer(spcLayer)) spcLayer.addTo(map);
  if (announce) {
    // Areas come lowest risk first, so the last is the worst.
    const worst = outlook?.areas[outlook.areas.length - 1]?.category;
    const label = day === 1 ? 'today' : 'tomorrow';
    setHint(
      !outlook
        ? 'Severe storm outlook unavailable right now'
        : !worst || spcLevel(worst) === 0
          ? `No severe storms expected over the US ${label}`
          : `Severe storm outlook for ${label}: up to a ${spcRiskWord(worst)} risk`,
      4000
    );
  }
}

// ---------------------------------------------------------------------------
// Earthquakes (USGS, M4.5+, last day) and US volcanoes at an elevated alert
// ---------------------------------------------------------------------------

let geoLayer: L.LayerGroup | null = null;
let geoOn = false;
let geoTimer: number | undefined;

export function setGeohazards(on: boolean) {
  geoOn = on;
  setLegend('geohazards', on ? geohazardsLegend() : null);
  window.clearInterval(geoTimer);
  if (!map) return;
  if (!on) {
    geoLayer?.clearLayers();
    return;
  }
  void refreshGeohazards(true);
  geoTimer = window.setInterval(() => void refreshGeohazards(false), 10 * 60 * 1000);
}

function quakeAgeLabel(ms: number): string {
  const hours = Math.max(0, Math.round((Date.now() - ms) / 3_600_000));
  return hours < 1 ? 'within the hour' : `${hours} h ago`;
}

async function refreshGeohazards(announce: boolean) {
  if (!map || !geoOn) return;
  const { quakes, volcanoes } = await fetchGeohazards();
  if (!map || !geoOn) return;
  if (!geoLayer) geoLayer = L.layerGroup();
  geoLayer.clearLayers();
  // Smallest first, so the strongest draw on top.
  for (const q of [...quakes].sort((a, b) => a.mag - b.mag)) {
    const level = quakeSeverity(q.mag);
    const color = severityColor(level);
    geoLayer.addLayer(
      L.circleMarker([q.lat, q.lon], { pane: 'hazards', radius: quakeRadius(q.mag), color, weight: 1.5, fillColor: color, fillOpacity: 0.35 }).bindPopup(
        `<strong>${esc(severityName(level))}: magnitude ${q.mag} earthquake</strong><br>${esc(q.place)}` +
          `<br>${esc(quakeAgeLabel(q.time))}${q.depthKm !== undefined ? `, ${q.depthKm} km deep` : ''}` +
          (q.tsunami ? '<br>USGS flags a possible tsunami: check official warnings' : '') +
          (q.url ? `<br><a href="${esc(q.url)}" target="_blank" rel="noopener">USGS event page</a>` : '')
      )
    );
  }
  for (const v of volcanoes) {
    const level = volcanoSeverity(v.colorCode);
    if (level === null) continue;
    const color = severityColor(level);
    geoLayer.addLayer(
      L.marker([v.lat, v.lon], {
        pane: 'hazards',
        icon: L.divIcon({ className: 'hazard-glyph', html: `<span style="--c:${color}">${HAZARD_GLYPH.ASH}</span>`, iconSize: [20, 20], iconAnchor: [10, 10] }),
        keyboard: false,
      }).bindPopup(
        `<strong>${esc(severityName(level))}: ${esc(v.name)} volcano</strong>` +
          `<br>Aviation color code ${esc(colorCodeLabel(v.colorCode))}` +
          (v.alertLevel ? `<br>Alert level ${esc(v.alertLevel)}` : '') +
          (v.observatory ? `<br>${esc(v.observatory)}` : '') +
          (v.url ? `<br><a href="${esc(v.url)}" target="_blank" rel="noopener">Latest notice</a>` : '')
      )
    );
  }
  if (!map.hasLayer(geoLayer)) geoLayer.addTo(map);
  if (announce) {
    const strongest = quakes[0];
    setHint(
      `${quakes.length} earthquake${quakes.length === 1 ? '' : 's'} of M4.5+ in the last day${strongest ? ` (strongest M${strongest.mag})` : ''}; ${volcanoes.length} US volcano${volcanoes.length === 1 ? '' : 'es'} at an elevated alert`,
      5000
    );
  }
}

// ---------------------------------------------------------------------------
// Tropical cyclones worldwide (GDACS): forecast cone, track, current position
// ---------------------------------------------------------------------------

function stormTimeLabel(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString('en-US', clockOptions())}`;
}

function stormPopup(storm: Cyclone): string {
  const nhc = storm.source === 'NHC';
  const source = nhc ? 'National Hurricane Center advisory' : storm.source ? `${esc(storm.source)} advisory via GDACS` : 'via GDACS';
  const link = storm.report ? `<br><a href="${esc(storm.report)}" target="_blank" rel="noopener">${nhc ? 'NHC advisory' : 'GDACS report'}</a>` : '';
  return (
    `<strong>${esc(severityName(cycloneSeverity(storm.category, storm.peakWindKmh)))}: ${esc(stormTitle(storm))}</strong>` +
    (storm.peakWindKmh ? `<br>Strongest winds so far: ${storm.peakWindKmh} km/h (${Math.round(storm.peakWindKmh / 1.852)} kt)` : '') +
    `<br>As of ${esc(stormTimeLabel(storm.asOf))} (${source})` +
    (storm.alert ? `<br>Impact alert (GDACS): ${esc(storm.alert)}` : '') +
    (storm.cone ? '<br><small>Shaded: forecast uncertainty cone. Dashed: forecast track.</small>' : '') +
    link +
    '<br><small style="color:#64748b">For information only; follow official advisories.</small>'
  );
}

/** Cone, past track (solid), forecast track (dashed) and a marker at the current position. */
function stormLayers(storm: Cyclone, strong: boolean): L.Layer[] {
  const layers: L.Layer[] = [];
  const popup = stormPopup(storm);
  const color = severityColor(cycloneSeverity(storm.category, storm.peakWindKmh));
  if (storm.cone) {
    layers.push(
      L.polygon(storm.cone, {
        pane: 'hazards',
        color: color,
        weight: strong ? 2 : 1,
        dashArray: '4, 4',
        fillColor: color,
        fillOpacity: strong ? 0.18 : 0.1,
      }).bindPopup(popup)
    );
  }
  const past = storm.track.filter((t) => !t.forecast).map((t) => [t.lat, t.lon] as [number, number]);
  const ahead = storm.track.filter((t) => t.forecast).map((t) => [t.lat, t.lon] as [number, number]);
  if (past.length > 1) layers.push(L.polyline(past, { pane: 'hazards', color: color, weight: 2, opacity: 0.9 }));
  if (ahead.length > 0) {
    layers.push(L.polyline([[storm.lat, storm.lon], ...ahead], { pane: 'hazards', color: color, weight: 2, dashArray: '6, 6', opacity: 0.9 }));
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
  setLegend('cyclones', on ? cycloneLegend() : null);
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
// Satellite clouds (NASA GIBS and EUMETSAT geostationary infrared), ground cleared
// ---------------------------------------------------------------------------

let satelliteLayer: L.GridLayer | null = null;
let satelliteTimer: number | undefined;
let satelliteOn = false;
/** Newest top-of-the-hour image time of each Meteosat; until known, its area falls to the others. */
const eumetsatTimes = new Map<Satellite, string>();

/** Learns each Meteosat's newest hourly image time; true when any changed. */
async function refreshEumetsatTimes(): Promise<boolean> {
  let changed = false;
  await Promise.all(
    SATELLITES.filter((s) => s.eumetsat).map(async (sat) => {
      try {
        const res = await fetch(eumetsatCapabilitiesUrl(sat.eumetsat!));
        const time = res.ok ? latestHourlyTime(await res.text()) : null;
        if (time && time !== eumetsatTimes.get(sat)) {
          eumetsatTimes.set(sat, time);
          changed = true;
        }
      } catch {
        /* keep the time we had */
      }
    })
  );
  return changed;
}

function createSatelliteLayer(): L.GridLayer {
  const SatelliteLayer = L.GridLayer.extend({ createTile: satelliteTile }) as new (options: L.GridLayerOptions) => L.GridLayer;
  return new SatelliteLayer({
    pane: 'satellite',
    tileSize: 256,
    maxNativeZoom: SATELLITE_MAX_NATIVE_ZOOM,
    opacity: 0.9,
    attribution: 'Clouds: NASA GIBS, GOES (NOAA) and Himawari (JMA); contains EUMETSAT Meteosat data',
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
    if (sat.eumetsat) {
      const time = eumetsatTimes.get(sat);
      if (!time) return resolve(null);
      img.src = eumetsatTileUrl(sat.eumetsat, coords.x, coords.y, coords.z, time);
    } else {
      img.src = L.Util.template(satelliteTileUrl(sat), { x: coords.x, y: coords.y, z: coords.z });
    }
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
      // The coldest storm tops share NASA's gray ramp with warm ground; find them by their
      // surroundings. Meteosat pixels carry their temperature, so they need no such search.
      const cores = list.map((sat, k) => (sat.eumetsat ? null : coldCoreMask(data[k])));
      const pixelLon = Float64Array.from({ length: 256 }, (_, x) => west + ((east - west) * (x + 0.5)) / 256);
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
            const src = list[best].eumetsat;
            const core = cores[best];
            const [r, g, b, a] = src
              ? meteosatPixel(src, d[i], d[i + 3], pixelLon[x])
              : core && core[i / 4]
                ? COLD_CORE_RGBA
                : cloudPixel(d[i], d[i + 1], d[i + 2], d[i + 3]);
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
    setHint('No satellite cloud images this far toward the poles', 5000);
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
  // Meteosat tiles wait for their hourly time; GIBS tiles draw at once and are redrawn with it.
  void refreshEumetsatTimes().then((changed) => {
    if (changed && satelliteOn) satelliteLayer?.redraw();
  });
  if (!map.hasLayer(satelliteLayer)) satelliteLayer.addTo(map);
  // A new GIBS image every 10 minutes, a new Meteosat one every hour.
  satelliteTimer = window.setInterval(() => {
    void refreshEumetsatTimes().finally(() => satelliteLayer?.redraw());
  }, 10 * 60 * 1000);
  const c = map.getCenter().wrap();
  if (satelliteCovers(c.lat, c.lng)) {
    setHint('Satellite clouds (infrared, latest image): the colder the cloud top, the stronger the storm', 5000);
  } else {
    noteSatelliteGap();
  }
}

// ---------------------------------------------------------------------------
// Weather radar (US: NEXRAD via IEM; elsewhere: RainViewer), redrawn on the severity ladder
// ---------------------------------------------------------------------------

let radarOn = false;
let radarMode: RadarMode = 'precip';
let radarTimer: number | undefined;
let usRadarLayer: L.GridLayer | null = null;
let worldRadarLayer: L.GridLayer | null = null;
/** Newest RainViewer frame; null until known (or when the index could not be read). */
let rainviewer: { url: string; time: number } | null = null;
let usRadarTime: number | null = null;

/** One remote tile's pixels, or null when it could not be loaded. */
function loadPixels(url: string): Promise<ImageData | null> {
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
    img.src = url;
  });
}

/** Edges of a tile: south, west, north, east. */
function tileEdges(c: L.Coords): [number, number, number, number] {
  return [tileLat(c.y + 1, c.z), tileLon(c.x, c.z), tileLat(c.y, c.z), tileLon(c.x + 1, c.z)];
}

/** Whether pixel (x, y) of a tile lies inside the US radar box. */
function pixelInUsBox(c: L.Coords): (x: number, y: number) => boolean {
  const [, west, , east] = tileEdges(c);
  const lats = Float64Array.from({ length: 256 }, (_, y) => tileLat(c.y + (y + 0.5) / 256, c.z));
  return (x, y) => inUsRadarBox(lats[y], west + ((east - west) * (x + 0.5)) / 256);
}

/** A grid layer whose tiles are a source tile read back and redrawn by `draw`. */
function radarGridLayer(
  options: L.GridLayerOptions,
  source: (c: L.Coords) => string | null,
  draw: (rgba: Uint8ClampedArray, c: L.Coords) => void
): L.GridLayer {
  const Layer = L.GridLayer.extend({
    createTile(coords: L.Coords, done: L.DoneCallback) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const url = source(coords);
      if (!url) {
        window.setTimeout(() => done(undefined, canvas));
        return canvas;
      }
      void loadPixels(L.Util.template(url, { x: coords.x, y: coords.y, z: coords.z })).then((px) => {
        const ctx = canvas.getContext('2d');
        if (px && ctx) {
          draw(px.data, coords);
          ctx.putImageData(px, 0, 0);
        }
        done(undefined, canvas);
      });
      return canvas;
    },
  }) as new (options: L.GridLayerOptions) => L.GridLayer;
  return new Layer({ pane: 'radar', tileSize: 256, opacity: 0.85, updateWhenZooming: false, ...options });
}

function createUsRadarLayer(): L.GridLayer {
  const [s, w, n, e] = US_RADAR_BOX;
  return radarGridLayer(
    {
      maxNativeZoom: IEM_MAX_NATIVE_ZOOM,
      bounds: L.latLngBounds([s, w], [n, e]),
      attribution: 'Radar: NEXRAD via <a href="https://mesonet.agron.iastate.edu/" target="_blank" rel="noopener">Iowa Environmental Mesonet</a>',
    },
    (c) => (tileTouchesUsBox(...tileEdges(c)) ? (radarMode === 'tops' ? IEM_ECHO_TOPS_URL : IEM_REFLECTIVITY_URL) : null),
    (rgba, c) => recolorTile(rgba, radarMode === 'tops' ? iemTopsLevel : iemReflectivityLevel, pixelInUsBox(c))
  );
}

function createWorldRadarLayer(): L.GridLayer {
  return radarGridLayer(
    {
      maxNativeZoom: RAINVIEWER_MAX_NATIVE_ZOOM,
      // Few spare tiles: RainViewer allows 100 requests a minute per viewer.
      keepBuffer: 1,
      attribution: 'Radar outside the US: <a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>',
    },
    (c) => (rainviewer && !tileInsideUsBox(...tileEdges(c)) ? rainviewer.url : null),
    (rgba, c) => {
      const inUs = pixelInUsBox(c);
      recolorTile(rgba, rainviewerLevel, (x, y) => !inUs(x, y));
    }
  );
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * Learns the newest radar times (and RainViewer's newest frame), then redraws. Storm tops are US
 * only, so RainViewer is left off for them. `redrawUs` forces new US tiles (a mode change).
 */
async function refreshRadar(announce: boolean, redrawUs = !announce) {
  if (!map || !radarOn) return;
  const tops = radarMode === 'tops';
  const [maps, iem] = await Promise.all([
    tops ? null : fetchJson(RAINVIEWER_MAPS_URL),
    fetchJson(tops ? IEM_ECHO_TOPS_TIME_URL : IEM_REFLECTIVITY_TIME_URL),
  ]);
  if (!map || !radarOn || tops !== (radarMode === 'tops')) return;
  const frame = rainviewerFrame(maps);
  const changed = !!frame && frame.url !== rainviewer?.url;
  if (frame) rainviewer = frame;
  usRadarTime = iemTime(iem) ?? (redrawUs ? null : usRadarTime);
  if (!usRadarLayer) usRadarLayer = createUsRadarLayer();
  if (!worldRadarLayer) worldRadarLayer = createWorldRadarLayer();
  if (!map.hasLayer(usRadarLayer)) usRadarLayer.addTo(map);
  else if (redrawUs) usRadarLayer.redraw();
  if (tops) {
    if (map.hasLayer(worldRadarLayer)) map.removeLayer(worldRadarLayer);
  } else if (!map.hasLayer(worldRadarLayer)) worldRadarLayer.addTo(map);
  else if (changed || !announce) worldRadarLayer.redraw();
  if (announce) {
    const c = map.getCenter().wrap();
    const inUs = inUsRadarBox(c.lat, c.lng);
    const t = inUs || tops ? usRadarTime : rainviewer?.time;
    const at = t ? ` as of ${timeLabel(t)}` : '';
    setHint(
      tops
        ? `Storm tops (US)${at}: yellow from 20,000 ft to magenta above 50,000 ft${inUs ? '' : '. Pan to the US to see them'}`
        : `Radar${at}: blue is rain, yellow to magenta is light to extreme`,
      5000
    );
  }
}

export function setRadar(on: boolean) {
  radarOn = on;
  setLegend('radar', on ? (radarMode === 'tops' ? stormTopsLegend() : radarLegend()) : null);
  window.clearInterval(radarTimer);
  if (!map) return;
  if (!on) {
    for (const layer of [usRadarLayer, worldRadarLayer]) if (layer && map.hasLayer(layer)) map.removeLayer(layer);
    return;
  }
  void refreshRadar(true, false);
  // US composites every 5 minutes, RainViewer every 10.
  radarTimer = window.setInterval(() => void refreshRadar(false), 5 * 60 * 1000);
}

/** What the radar layer shows: precipitation (worldwide) or storm tops (US). */
export function setRadarMode(mode: RadarMode) {
  if (mode === radarMode) return;
  radarMode = mode;
  if (!radarOn) return;
  setLegend('radar', mode === 'tops' ? stormTopsLegend() : radarLegend());
  void refreshRadar(true, true);
}

// ---------------------------------------------------------------------------
// Space weather and aurora (NOAA SWPC OVATION, 1-degree grid), drawn per pixel
// ---------------------------------------------------------------------------

let auroraOn = false;
let auroraTimer: number | undefined;
let auroraLayer: L.GridLayer | null = null;
let auroraAt: ((lat: number, lon: number) => number) | null = null;

function createAuroraLayer(): L.GridLayer {
  const Layer = L.GridLayer.extend({
    createTile(coords: L.Coords) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const ctx = canvas.getContext('2d');
      const lookup = auroraAt;
      if (!ctx || !lookup) return canvas;
      // Coarse grid: 64 x 64 samples per tile, each drawn 4 x 4, smooth enough for a 1-degree source.
      const img = ctx.createImageData(64, 64);
      const west = tileLon(coords.x, coords.z);
      const east = tileLon(coords.x + 1, coords.z);
      for (let y = 0; y < 64; y++) {
        const lat = tileLat(coords.y + (y + 0.5) / 64, coords.z);
        if (Math.abs(lat) < 35) continue; // no aurora this close to the equator
        for (let x = 0; x < 64; x++) {
          const [r, g, b, a] = auroraRgba(lookup(lat, west + ((east - west) * (x + 0.5)) / 64));
          const i = (y * 64 + x) * 4;
          img.data[i] = r;
          img.data[i + 1] = g;
          img.data[i + 2] = b;
          img.data[i + 3] = a;
        }
      }
      const small = document.createElement('canvas');
      small.width = small.height = 64;
      small.getContext('2d')?.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(small, 0, 0, 256, 256);
      return canvas;
    },
  }) as new (options: L.GridLayerOptions) => L.GridLayer;
  return new Layer({ pane: 'night', tileSize: 256, maxNativeZoom: 5, attribution: 'Aurora and space weather: NOAA SWPC' });
}

export function setAurora(on: boolean) {
  auroraOn = on;
  setLegend('aurora', on ? auroraLegend() : null);
  window.clearInterval(auroraTimer);
  if (!map) return;
  if (!on) {
    if (auroraLayer && map.hasLayer(auroraLayer)) map.removeLayer(auroraLayer);
    return;
  }
  void refreshAurora(true);
  // OVATION updates every few minutes; the server caches 15.
  auroraTimer = window.setInterval(() => void refreshAurora(false), 15 * 60 * 1000);
}

async function refreshAurora(announce: boolean) {
  if (!map || !auroraOn) return;
  const sw = await fetchSpaceWeather();
  if (!map || !auroraOn) return;
  auroraAt = sw?.aurora ? auroraLookup(sw.aurora.cells) : null;
  if (!auroraLayer) auroraLayer = createAuroraLayer();
  if (!map.hasLayer(auroraLayer)) auroraLayer.addTo(map);
  else auroraLayer.redraw();
  const now = sw ? scalesLabel(sw.now) : undefined;
  setLegend('aurora', auroraLegend(now ? `${now}${sw?.kp !== undefined ? ` (Kp ${sw.kp})` : ''}` : undefined));
  if (announce) {
    const g = sw?.tomorrow?.G ?? 0;
    setHint(
      !sw
        ? 'Space weather unavailable right now'
        : `Space weather now ${now}${g >= 1 ? `; G${g} geomagnetic storm forecast for tomorrow` : ''}. Green: where aurora is likely`,
      5000
    );
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
