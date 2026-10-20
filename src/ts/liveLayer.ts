// Live track: the header's radar button. Turning it on finds the viewer once, draws a fixed circle
// (Settings, Live track, radius) and shows up to 5 aircraft in the air inside it from /api/live,
// refreshed every 10 seconds while the page is visible. After 5 minutes it pauses with a banner
// until Continue; turning it off clears everything. Settings changes apply at the next refresh,
// except the radius, which applies the next time it is turned on.

import { readPref } from './prefs';
import { formatDistance } from './units';
import { compassPoint } from './forecast';
import {
  POLL_MS,
  SESSION_MS,
  METERS_PER_MI,
  altitudeColor,
  liveQuery,
  verticalLabel,
  type LiveAircraft,
} from './liveTrack';

type State = 'off' | 'locating' | 'tracking' | 'paused';

let map: L.Map | null = null;
let state: State = 'off';
let center: [number, number] | null = null;
let radiusMi = 5;
let elevFt = 0;
let pollTimer = 0;
let sessionTimer = 0;
let gen = 0;
let tracked: LiveAircraft[] = [];
let layer: L.LayerGroup | null = null;
let aircraftLayer: L.LayerGroup | null = null;
const markers = new Map<string, L.Marker>();

const el = (id: string) => document.getElementById(id) as HTMLElement | null;
const NM_TO_MI = 1.150779;

/** Hooks for the drawing added on top (paths, routes); see liveDraw.ts. */
export interface LiveDrawHooks {
  update(map: L.Map, group: L.LayerGroup, aircraft: LiveAircraft[]): void;
  clear(): void;
  routeLabel(hex: string): string | null;
  typeName(code: string | undefined): string | null;
}

let hooks: LiveDrawHooks | null = null;
export function setLiveDrawHooks(h: LiveDrawHooks) {
  hooks = h;
}

export function initLive(m: L.Map) {
  map = m;
  const button = el('live-toggle');
  button?.addEventListener('click', () => (state === 'off' ? start() : stop()));
  el('live-continue')?.addEventListener('click', () => resume());
  el('live-stop')?.addEventListener('click', () => stop());
  const panel = el('live-panel');
  panel?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.live-stop-inline')) return stop();
    const row = target.closest('[data-live-hex]') as HTMLElement | null;
    if (row) showAircraft(row.dataset.liveHex || '');
  });
  panel?.addEventListener('keydown', (e) => {
    const row = (e.target as HTMLElement).closest('[data-live-hex]') as HTMLElement | null;
    if (row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      showAircraft(row.dataset.liveHex || '');
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (state !== 'tracking') return;
    if (document.hidden) window.clearTimeout(pollTimer);
    else void poll();
  });
}

function setButton() {
  const button = el('live-toggle');
  if (!button) return;
  const on = state !== 'off';
  button.setAttribute('aria-pressed', String(on));
  button.classList.toggle('is-on', on);
  button.title = on ? 'Stop Live track' : 'Live track: aircraft around you';
}

function setPanel(html: string | null) {
  const panel = el('live-panel');
  if (!panel) return;
  panel.hidden = html === null;
  panel.innerHTML = html ?? '';
}

function setBanner(show: boolean) {
  const banner = el('live-banner');
  if (banner) banner.hidden = !show;
}

function locateHere(): Promise<[number, number] | string> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve('Your browser cannot share its location.');
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve([pos.coords.latitude, pos.coords.longitude]),
      (err) => resolve(err.code === err.PERMISSION_DENIED ? 'Location permission was denied. Allow it in your browser site settings to use Live track.' : 'Your location is not available right now.'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  });
}

/** Ground elevation at the viewer, feet (Open-Meteo, about 90 m terrain), or 0 when unknown. */
async function groundFt(lat: number, lon: number): Promise<number> {
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`);
    const m = (await res.json())?.elevation?.[0];
    return Number.isFinite(m) ? m * 3.28084 : 0;
  } catch {
    return 0;
  }
}

async function start() {
  if (!map) return;
  const my = ++gen;
  state = 'locating';
  setButton();
  setPanel(cardHtml('Finding your location\u2026', []));
  const where = await locateHere();
  if (my !== gen) return;
  if (typeof where === 'string') {
    state = 'off';
    setButton();
    setPanel(cardHtml(where, [], true));
    return;
  }
  center = where;
  radiusMi = Math.min(15, Math.max(1, Number(readPref('live-radius-mi', '5')) || 5));
  elevFt = await groundFt(center[0], center[1]);
  if (my !== gen) return;

  layer = L.layerGroup().addTo(map);
  aircraftLayer = L.layerGroup().addTo(map);
  const circle = L.circle(center, { radius: radiusMi * METERS_PER_MI, color: '#38bdf8', weight: 2, dashArray: '6, 6', fillColor: '#38bdf8', fillOpacity: 0.05, interactive: false });
  layer.addLayer(circle);
  layer.addLayer(L.circleMarker(center, { radius: 5, color: '#0f172a', weight: 2, fillColor: '#38bdf8', fillOpacity: 1, interactive: false }));
  map.flyToBounds(circle.getBounds(), { padding: [30, 30], duration: 0.8 });
  resume();
}

function resume() {
  if (!center) return;
  state = 'tracking';
  setButton();
  setBanner(false);
  window.clearTimeout(sessionTimer);
  sessionTimer = window.setTimeout(pause, SESSION_MS);
  void poll();
}

function pause() {
  if (state !== 'tracking') return;
  state = 'paused';
  window.clearTimeout(pollTimer);
  setButton();
  setBanner(true);
}

export function stop() {
  gen += 1;
  state = 'off';
  window.clearTimeout(pollTimer);
  window.clearTimeout(sessionTimer);
  setButton();
  setBanner(false);
  setPanel(null);
  layer?.remove();
  aircraftLayer?.remove();
  layer = aircraftLayer = null;
  markers.clear();
  tracked = [];
  center = null;
  hooks?.clear();
}

async function poll() {
  window.clearTimeout(pollTimer);
  if (state !== 'tracking' || !center || document.hidden) return;
  const my = gen;
  let message: string | null = null;
  try {
    const query = liveQuery({
      lat: center[0],
      lon: center[1],
      mi: radiusMi,
      minFt: Number(readPref('live-min-ft', '500')) || 0,
      minKt: Number(readPref('live-min-kt', '60')) || 0,
      elevFt,
      keep: tracked.map((a) => a.hex),
    });
    const res = await fetch(`/api/live?${query}`);
    if (my !== gen) return;
    if (res.status === 503) {
      message = 'Live track is not set up on this site.';
    } else if (!res.ok) {
      message = 'Live aircraft data is unavailable right now; trying again.';
    } else {
      const body = await res.json();
      if (my !== gen) return;
      tracked = body.aircraft || [];
      draw();
      setPanel(cardHtml(null, tracked, false, body.qualifying));
    }
  } catch {
    message = navigator.onLine ? 'Live aircraft data is unavailable right now; trying again.' : 'You are offline.';
  }
  if (message) setPanel(cardHtml(message, tracked));
  if (state === 'tracking' && my === gen) pollTimer = window.setTimeout(() => void poll(), POLL_MS);
}

function planeIcon(a: LiveAircraft): L.DivIcon {
  const color = altitudeColor(a.altFt);
  const rotate = a.track ?? 0;
  const label = a.callsign || a.reg || a.hex.toUpperCase();
  return L.divIcon({
    className: 'live-plane',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    html:
      `<svg viewBox="0 0 24 24" width="28" height="28" style="transform:rotate(${rotate}deg)" aria-hidden="true">` +
      `<path d="M12 2c.8 0 1.3.9 1.3 2.2v5.3l7.2 4.2v2l-7.2-2.2v4.4l2.2 1.7v1.6L12 20.4l-3.5.8v-1.6l2.2-1.7v-4.4L3.5 15.7v-2l7.2-4.2V4.2C10.7 2.9 11.2 2 12 2z" fill="${color}" stroke="#0f172a" stroke-width="1"/></svg>` +
      `<span class="live-plane-label">${escapeHtml(label)}<br>${Math.round(a.altFt / 100) * 100} ft</span>`,
  });
}

function popupHtml(a: LiveAircraft): string {
  const type = hooks?.typeName(a.type) || a.type || 'Unknown type';
  const route = hooks?.routeLabel(a.hex);
  return (
    `<strong>${escapeHtml(a.callsign || a.reg || a.hex.toUpperCase())}</strong>${a.reg && a.callsign ? ` <span class="muted">${escapeHtml(a.reg)}</span>` : ''}` +
    `<br>${escapeHtml(type)}${route ? `<br>${escapeHtml(route)}` : ''}` +
    `<br>${a.altFt.toLocaleString('en-US')} ft (${a.aglFt.toLocaleString('en-US')} ft above you), ${a.gs} kt` +
    `<br>${verticalLabel(a.rate)}${a.emergency ? `<br><strong>Emergency: ${escapeHtml(a.emergency)}</strong>` : ''}` +
    `<br><small style="color:#64748b">adsb.lol, ODbL</small>`
  );
}

function draw() {
  if (!map || !aircraftLayer) return;
  const seen = new Set<string>();
  for (const a of tracked) {
    seen.add(a.hex);
    let m = markers.get(a.hex);
    if (!m) {
      m = L.marker([a.lat, a.lon], { icon: planeIcon(a), keyboard: false }).bindPopup(popupHtml(a));
      markers.set(a.hex, m);
      aircraftLayer.addLayer(m);
    } else {
      m.setLatLng([a.lat, a.lon]);
      m.setIcon(planeIcon(a));
      m.setPopupContent(popupHtml(a));
    }
  }
  for (const [hex, m] of markers) {
    if (seen.has(hex)) continue;
    aircraftLayer.removeLayer(m);
    markers.delete(hex);
  }
  if (layer) hooks?.update(map, layer, tracked);
}

function showAircraft(hex: string) {
  const m = markers.get(hex);
  if (!map || !m) return;
  map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 11), { duration: 0.6 });
  m.openPopup();
}

const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cardHtml(message: string | null, aircraft: LiveAircraft[], error = false, qualifying?: number): string {
  const radius = formatDistance(radiusMi);
  const head = `<div class="live-head"><strong>\u{1F4E1} Live track</strong><span class="muted">${center ? `within ${radius} of you` : ''}</span><button type="button" id="live-stop-inline" class="live-stop-inline" aria-label="Stop Live track">Stop</button></div>`;
  if (message) return `${head}<div class="live-msg${error ? ' live-msg--error' : ''}">${escapeHtml(message)}</div>`;
  if (!aircraft.length) return `${head}<div class="live-msg">No aircraft in the air within ${radius} right now. Checking every 10 seconds.</div>`;
  const more = qualifying && qualifying > aircraft.length ? `<div class="live-msg muted">Showing the ${aircraft.length} closest of ${qualifying}.</div>` : '';
  const rows = aircraft
    .map((a) => {
      const type = hooks?.typeName(a.type) || a.type || '';
      const route = hooks?.routeLabel(a.hex);
      const name = a.callsign || a.reg || a.hex.toUpperCase();
      const where = `${formatDistance(a.distNm * NM_TO_MI)} ${compassPoint(a.bearing)}`;
      return `<div class="live-row" data-live-hex="${a.hex}" role="button" tabindex="0">
        <span class="live-dot" style="background:${altitudeColor(a.altFt)}"></span>
        <span class="live-main"><strong>${escapeHtml(name)}</strong>${type ? ` <span class="muted">${escapeHtml(type)}</span>` : ''}${route ? `<br><span class="live-route">${escapeHtml(route)}</span>` : ''}</span>
        <span class="live-stats">${a.altFt.toLocaleString('en-US')} ft, ${a.gs} kt<br><span class="muted">${verticalLabel(a.rate)} \u00b7 ${where}</span></span>
      </div>`;
    })
    .join('');
  return `${head}${rows}${more}<div class="live-credit muted">Aircraft data: <a href="https://adsb.lol" target="_blank" rel="noopener">adsb.lol</a> contributors, ODbL 1.0</div>`;
}

export const liveState = () => state;
