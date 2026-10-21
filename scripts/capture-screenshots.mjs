// Captures the README screenshots from the running app with a local Chrome or Edge in headless
// mode, driven over the DevTools protocol (no extra dependencies; needs Node 22+ for WebSocket).
//
//   npm run build && npx wrangler pages dev dist      # app plus /api at http://localhost:8788
//   node scripts/capture-screenshots.mjs [baseUrl]    # writes docs/screenshot-*.png
//   SHOT=live node scripts/capture-screenshots.mjs https://zachroute.pages.dev   # one shot
//
// Each shot starts from a fresh browser profile (no favorites or recent searches), turns on the
// map layers and settings it needs through the same localStorage keys the settings window uses,
// opens a search link (or none), runs its steps (open Settings, start Live track at a fixed
// position near an airport, open a route overview) and waits for the live data to load. Live
// track uses a fixed public position (beside O'Hare), never the machine's own location. Set
// BROWSER to a Chrome or Edge executable to override the auto-detected one.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:8788';
const OUT = path.resolve(import.meta.dirname, '..', 'docs');
const PORT = 9333;

const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
/** Beside O'Hare, under the departure and arrival paths: a public spot, not anyone's location. */
const NEAR_ORD = { latitude: 41.955, longitude: -87.84, accuracy: 20 };
const startLive = `document.getElementById('live-toggle').click()`;
const openFirstOverview = `document.querySelector('#live-panel [data-overview]')?.click()`;

const SHOTS = [
  {
    file: 'screenshot-route.png',
    query: process.env.ROUTE || 'GUM TPE',
    layers: { 'zachroute:show-cyclones': 'true', 'zachroute:card-alerts': 'open' },
    viewport: DESKTOP,
    zoomOut: 1,
    // bring the hazards along the route into view
    scrollTo: '.route-hazards',
  },
  {
    file: 'screenshot-live.png',
    query: '',
    layers: { 'zachroute:live-radius-mi': '10', 'zachroute:live-max': '6' },
    viewport: DESKTOP,
    geo: NEAR_ORD,
    steps: [{ js: startLive, wait: 32000 }],
  },
  {
    file: 'screenshot-overview.png',
    query: '',
    layers: { 'zachroute:live-radius-mi': '10', 'zachroute:live-max': '6' },
    viewport: DESKTOP,
    geo: NEAR_ORD,
    steps: [
      { js: startLive, wait: 32000 },
      { js: openFirstOverview, wait: 6000 },
    ],
  },
  {
    file: 'screenshot-settings.png',
    query: 'SFO',
    layers: { 'zachroute:show-radar': 'true', 'zachroute:show-hazards': 'true', 'zachroute:settings-open': '["weather","live"]' },
    viewport: DESKTOP,
    zoomOut: 3,
    steps: [{ js: `document.getElementById('menu-toggle').click()`, wait: 1500 }],
  },
  {
    file: 'screenshot-satellite.png',
    query: 'SFO',
    layers: { 'zachroute:base-map': 'satellite' },
    viewport: DESKTOP,
    zoomOut: 0,
  },
  {
    file: 'screenshot-mobile.png',
    query: '',
    layers: { 'zachroute:live-radius-mi': '10', 'zachroute:live-max': '5' },
    viewport: PHONE,
    geo: NEAR_ORD,
    steps: [{ js: startLive, wait: 32000 }],
  },
  {
    file: 'screenshot-dust.png',
    query: 'CAI',
    layers: { 'zachroute:show-aerosol': 'true' },
    viewport: DESKTOP,
    zoomOut: 10,
  },
];

function findBrowser() {
  const candidates = [
    process.env.BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('No Chrome or Edge found; set BROWSER to its executable.');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal DevTools protocol client over one page target. */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return { send, close: () => ws.close() };
}

async function evaluate(cdp, expression) {
  const { result } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return result.value;
}

async function capture(browser, shot) {
  const profile = mkdtempSync(path.join(tmpdir(), 'zachroute-shot-'));
  const proc = spawn(
    browser,
    [`--headless=new`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', 'about:blank'],
    { stdio: 'ignore' }
  );
  try {
    let targets;
    for (let i = 0; i < 50 && !targets; i++) {
      await sleep(200);
      targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).catch(() => undefined);
    }
    const page = targets.find((t) => t.type === 'page');
    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', shot.viewport);
    if (shot.geo) {
      await cdp.send('Browser.grantPermissions', { origin: new URL(BASE).origin, permissions: ['geolocation'] });
      await cdp.send('Emulation.setGeolocationOverride', shot.geo);
    }
    if (shot.viewport.mobile) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

    // Settings live in localStorage on the app's origin: open it once, set them, then search.
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await sleep(2500);
    await evaluate(cdp, `(() => { ${Object.entries(shot.layers).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(' ')} return true; })()`);
    const search = shot.query ? `?q=${encodeURIComponent(shot.query).replace(/%20/g, '+')}` : '';
    await cdp.send('Page.navigate', { url: `${BASE}/${search}` });
    await sleep(shot.query ? 15000 : 4000); // card, weather, winds aloft, hazards, air quality, fires and storms load in parallel
    for (const step of shot.steps || []) {
      await evaluate(cdp, `(${'() => { ' + step.js + '; return true; }'})()`);
      await sleep(step.wait);
    }
    if (shot.scrollTo) {
      await evaluate(cdp, `document.querySelector(${JSON.stringify(shot.scrollTo)})?.scrollIntoView({ block: 'center' }), true`);
      await sleep(500);
    }

    for (let i = 0; i < shot.zoomOut; i++) {
      await evaluate(cdp, `document.querySelector('.leaflet-control-zoom-out')?.click(), true`);
      await sleep(700);
    }
    if (shot.zoomOut) await sleep(5000); // tiles and zoom-limited layers for the new view

    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT, shot.file), Buffer.from(data, 'base64'));
    console.log(`wrote docs/${shot.file}`);
    await cdp.send('Browser.close').catch(() => undefined);
    cdp.close();
  } finally {
    // Wait for the browser to exit so the profile folder is no longer in use.
    if (proc.exitCode === null) {
      const exited = new Promise((r) => proc.once('exit', r));
      await Promise.race([exited, sleep(5000)]);
      if (proc.exitCode === null) proc.kill();
    }
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      console.warn(`could not remove the temporary profile ${profile}`);
    }
  }
}

const browser = findBrowser();
const only = process.env.SHOT;
for (const shot of SHOTS) {
  if (!only || shot.file.includes(only)) await capture(browser, shot);
}
