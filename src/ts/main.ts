import { initMap, showSingleAirport, showRoute, showConnectingRoutes, highlightViaRoute, setAirportDatabase, showConnections, resetView, initAirportLayers, showLargeAirports, showMediumAirports, showRegionalAirports, drawAirportRunways, setPreferredRunwayEnd, colorRouteByWind, setApproachTicks, showAllViaOptions, refreshMapSize, showNearby } from './mapRenderer';
import { formatDistance, getDistanceUnit, getClockFormat, getWeatherUnits, setDistanceUnit, setClockFormat, setWeatherUnits, UNITS_CHANGED, type DistanceUnit, type ClockFormat, type WeatherUnits } from './units';
import { nearestAirports, locate } from './nearby';
import { initSheet } from './sheet';
import { haversineDistance } from './geoMath';
import { setWeatherStations, setStationMode, type StationMode, setHazards, setDayNight, setPireps, setCyclones, setFires, setAerosol, setFreezingLevel, setSatellite, setTfrs, setTcf, setTcfStep, setRadar, setRadarMode, setSpc, setSpcDay, highlightRunway } from './mapOverlays';
import type { RadarMode } from './radarTiles';
import type { TcfStep } from './tcf';
import { parseQuery, loadAirports, suggest, type SearchIntent } from './searchParser';
import { createSuggestList, type SuggestItem } from './suggestList';
import { loadRecent, addRecent, clearRecent, loadFavorites, FAVORITES_CHANGED } from './history';
import type { Airport } from './geoMath';
import { renderSingle, renderRoute, renderError, enrichLore, getCachedLore, renderNearby } from './uiRenderer';
import { findConnectingRoutes, isKnownDirect } from './connections';

async function init() {
  // Fetched at runtime (rather than bundled via a JS import) so the ~18 MB
  // airport dictionary is parsed as JSON (fast, native) instead of being
  // inlined into the JS bundle (slow to parse, bloats every page load).
  // The Service Worker precaches this exact URL, so it's still fully
  // available offline after the first successful load.
  const airportsRes = await fetch('/data/airports.json');
  const airportsData = await airportsRes.json();

  // The file stores each airport once; ICAO / FAA-LID keys are string aliases of the
  // primary key. Point them at the same object so every code resolves to one record.
  for (const key in airportsData) {
    const value = airportsData[key];
    if (typeof value === 'string') airportsData[key] = airportsData[value];
  }

  // Load airport database
  loadAirports(airportsData as Record<string, Airport>);
  setAirportDatabase(airportsData as Record<string, Airport>);

  // Initialize map
  initMap('map');

  // Initialize persistent airport background layers (large/medium) once
  initAirportLayers(airportsData as Record<string, Airport>);

  // Wire search input
  const input = document.getElementById('search-input') as HTMLInputElement;
  if (!input) return;
  const clearBtn = document.getElementById('search-clear') as HTMLButtonElement | null;
  const resultsEl = document.getElementById('results-content')!;
  const sheet = initSheet(refreshMapSize);

  // Phones: don't focus the box on launch, or the keyboard covers the app every time it opens.
  const isTouch = window.matchMedia('(pointer: coarse)').matches;
  const focusSearch = () => {
    if (!isTouch) input.focus();
  };

  const EMPTY_STATE = `
    <div class="empty-state">
      <p>Enter an airport code, a city or airport name, or a route.</p>
      <p class="example">Examples: <code>ORD</code>, <code>Chicago</code>, <code>ORD DEN</code>, <code>Chicago Denver</code></p>
    </div>
  `;

  /** Start screen: the usual hint plus one-tap favorites when there are any. */
  function renderEmptyState() {
    resultsEl.innerHTML = EMPTY_STATE;
    const favorites = loadFavorites();
    if (favorites.length === 0) return;
    const bar = document.createElement('div');
    bar.className = 'alt-matches favorites-bar';
    bar.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Favorites:' }));
    for (const code of favorites) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'alt-chip';
      btn.textContent = code;
      btn.addEventListener('click', () => runSearch(code, 'push'));
      bar.append(btn);
    }
    resultsEl.prepend(bar);
  }
  window.addEventListener(FAVORITES_CHANGED, () => {
    if (!currentQuery) renderEmptyState();
  });

  // ---- History / shareable links ------------------------------------------
  // Every view has a URL (?q=ORD+DEN) so it can be shared, and the Android back button
  // returns to the previous search instead of closing the app. Typing only updates the
  // suggestion list; a search (and its history entry) happens when one is picked or on Enter.
  type HistoryMode = 'push' | 'none';
  let currentQuery = '';

  function urlFor(q: string): string {
    return q ? `${location.pathname}?q=${encodeURIComponent(q)}` : location.pathname;
  }

  function recordHistory(q: string, how: HistoryMode) {
    if (how === 'none') return;
    const state = { q };
    if ((history.state?.q ?? '') === q) {
      history.replaceState(state, '', urlFor(q));
    } else {
      history.pushState(state, '', urlFor(q));
    }
  }

  function updateClearButton() {
    if (clearBtn) clearBtn.hidden = input.value.length === 0;
  }

  // One-line summaries for the phone sheet's header (visible even when the sheet is lowered).
  const singleSummary = (a: Airport) => `${a.iata || a.icao} \u2014 ${a.name}`;
  const routeSummary = (o: Airport, d: Airport) =>
    `${o.iata || o.icao} \u2192 ${d.iata || d.icao} \u00b7 ${formatDistance(haversineDistance(o, d))}`;

  /** Runs a search and renders it. `how` controls the history entry. */
  function runSearch(raw: string, how: HistoryMode) {
    const query = raw.trim();
    currentQuery = query;
    if (input.value.trim() !== query) input.value = query;
    updateClearButton();
    recordHistory(query, how);

    // Reset view on every new search (clears previous connections/layers)
    resetView();

    if (!query) {
      sheet.setSummary('Search an airport or route');
      renderEmptyState();
      return;
    }

    const intent: SearchIntent = parseQuery(query);

    if (intent.mode === 'INVALID') {
      renderError(intent.error);
      return;
    }
    if (how === 'push') addRecent(query);
    if (sheet.isPhone()) sheet.setState('half');

    if (intent.mode === 'SINGLE') {
      sheet.setSummary(singleSummary(intent.airport));
      showSingleAirport(intent.airport);
      renderSingle(intent.airport);
      addResultActions(null);
      showAlternatives(intent.alternatives);
      if ((window as any).connectionsEnabled) {
        showConnections(intent.airport);
      }
    } else if (intent.mode === 'ROUTE') {
      sheet.setSummary(routeSummary(intent.origin, intent.destination));
      showRoutePair(intent.origin, intent.destination);
    }
  }

  // ---- Suggestions while typing --------------------------------------------
  const suggestEl = document.getElementById('search-suggest') as HTMLElement;
  const commit = (q: string) => {
    suggestions.hide();
    runSearch(q, 'push');
    if (isTouch) input.blur(); // hide the phone keyboard so the result is visible
  };
  const suggestions = createSuggestList(input, suggestEl, (item: SuggestItem) => (item.action ? item.action() : commit(item.query)));

  function suggestionsFor(text: string): SuggestItem[] {
    if (!text.trim()) return emptyBoxItems();
    return suggest(text).map((s) => ({ query: s.query, title: s.title, detail: s.detail, badge: s.kind === 'route' ? 'Route' : undefined }));
  }

  /** What a recent search resolves to, e.g. "Chicago to Denver" or "Denver International Airport". */
  function describeSearch(q: string): string | undefined {
    const intent = parseQuery(q);
    if (intent.mode === 'SINGLE') return intent.airport.name;
    if (intent.mode === 'ROUTE') return `${intent.origin.city || intent.origin.name} to ${intent.destination.city || intent.destination.name}`;
    return undefined;
  }

  // Shown when the box is focused and empty: favorites first, then recent searches.
  function emptyBoxItems(): SuggestItem[] {
    const favorites = loadFavorites();
    const recent = loadRecent().filter((q) => !favorites.some((f) => f.toUpperCase() === q.trim().toUpperCase()));
    const favItems = favorites.map((code) => ({ query: code, title: code, detail: describeSearch(code), badge: 'Favorite' }));
    if (recent.length === 0) return favItems;
    return [
      ...favItems,
      ...recent.map((q) => ({ query: q, title: q, detail: describeSearch(q), badge: 'Recent' })),
      {
        query: '',
        title: 'Clear recent searches',
        subtle: true,
        action: () => {
          clearRecent();
          suggestions.hide();
        },
      },
    ];
  }

  let debounceTimer: number;
  input.addEventListener('input', () => {
    updateClearButton();
    clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => suggestions.show(suggestionsFor(input.value)), 120);
  });
  input.addEventListener('focus', () => suggestions.show(suggestionsFor(input.value)));
  input.addEventListener('blur', () => suggestions.hide());
  input.addEventListener('keydown', (e) => {
    if (suggestions.handleKey(e)) {
      e.preventDefault();
      return;
    }
    if (e.key !== 'Enter') return;
    clearTimeout(debounceTimer);
    commit(input.value);
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      clearTimeout(debounceTimer);
      suggestions.hide();
      runSearch('', 'push');
      input.focus();
    });
  }

  window.addEventListener('popstate', (e) => {
    const q = (e.state && typeof e.state.q === 'string' ? e.state.q : new URLSearchParams(location.search).get('q')) || '';
    suggestions.hide();
    runSearch(q, 'none');
  });

  // ---- Airports near me -----------------------------------------------------
  const nearBtn = document.getElementById('near-me') as HTMLButtonElement | null;
  async function showAirportsNearMe() {
    suggestions.hide();
    sheet.setSummary('Finding airports near you...');
    if (sheet.isPhone()) sheet.setState('half');
    resultsEl.innerHTML = '<div class="empty-state"><p>Finding your location...</p></div>';
    const where = await locate();
    if (!where.ok) {
      sheet.setSummary('Location unavailable');
      renderError(
        where.reason === 'denied'
          ? 'Location permission was denied. Allow it in your browser site settings to see airports near you.'
          : 'Your location could not be determined right now.'
      );
      return;
    }
    const list = nearestAirports(where.lat, where.lon, Object.values(airportsData) as Airport[]);
    input.value = '';
    updateClearButton();
    currentQuery = '';
    sheet.setSummary('Airports near you');
    showNearby(where, list.map((n) => n.airport));
    renderNearby(list, {});

    // One weather request for the whole area, then add flight categories to the list.
    try {
      const lats = [where.lat, ...list.map((n) => n.airport.lat)];
      const lons = [where.lon, ...list.map((n) => n.airport.lon)];
      const bbox = [Math.min(...lats) - 0.2, Math.min(...lons) - 0.2, Math.max(...lats) + 0.2, Math.max(...lons) + 0.2].map((n) => n.toFixed(2)).join(',');
      const res = await fetch(`/api/metar-bbox?bbox=${bbox}`);
      if (!res.ok || currentQuery) return;
      const json = await res.json();
      const cats: Record<string, string> = {};
      for (const s of json.stations || []) if (s.cat) cats[s.id] = s.cat;
      if (!currentQuery && resultsEl.querySelector('.nearby-list')) renderNearby(list, cats);
    } catch {
      /* weather is a bonus here */
    }
  }
  nearBtn?.addEventListener('click', () => void showAirportsNearMe());
  (window as any).runSearchFor = (q: string) => runSearch(q, 'push');

  // ---- Result toolbar: share (and swap for routes) ------------------------
  function codeOf(a: Airport): string {
    return a.iata || a.icao;
  }

  async function shareCurrent(btn: HTMLButtonElement) {
    const url = `${location.origin}${urlFor(currentQuery)}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: `ZachRoute: ${currentQuery}`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      btn.textContent = 'Link copied';
      setTimeout(() => (btn.textContent = 'Share'), 1800);
    } catch {
      /* share sheet dismissed or clipboard blocked: nothing to do */
    }
  }

  function addResultActions(route: { origin: Airport; destination: Airport } | null) {
    const bar = document.createElement('div');
    bar.className = 'result-actions';
    if (route) {
      const swap = document.createElement('button');
      swap.type = 'button';
      swap.className = 'result-action';
      swap.textContent = `\u21c4 Swap to ${codeOf(route.destination)} \u2192 ${codeOf(route.origin)}`;
      swap.addEventListener('click', () => runSearch(`${codeOf(route.destination)} ${codeOf(route.origin)}`, 'push'));
      bar.append(swap);
    }
    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'result-action';
    share.textContent = 'Share';
    share.addEventListener('click', () => void shareCurrent(share));
    bar.append(share);
    resultsEl.prepend(bar);
  }

  // "Other matches" chips under a name search, so a city with several airports is one tap away.
  function showAlternatives(alternatives?: Airport[]) {
    if (!alternatives || alternatives.length === 0) return;
    const bar = document.createElement('div');
    bar.className = 'alt-matches';
    bar.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Other matches:' }));
    for (const alt of alternatives) {
      const code = codeOf(alt);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'alt-chip';
      btn.textContent = `${code} ${alt.city || alt.name}`;
      btn.title = alt.name;
      btn.addEventListener('click', () => runSearch(code, 'push'));
      bar.append(btn);
    }
    const actions = resultsEl.querySelector('.result-actions');
    if (actions) actions.after(bar);
    else resultsEl.prepend(bar);
  }

  focusSearch();

  // Logo click = full reset
  const brand = document.getElementById('brand-reset');
  if (brand) {
    brand.addEventListener('click', () => {
      runSearch('', 'push');
      focusSearch();
    });
  }

  // Settings flyout menu (anchored to the airplane icon)
  const menuToggle = document.getElementById('menu-toggle') as HTMLButtonElement | null;
  const settingsMenu = document.getElementById('settings-menu') as HTMLElement | null;
  if (menuToggle && settingsMenu) {
    const closeMenu = () => {
      settingsMenu.hidden = true;
      menuToggle.setAttribute('aria-expanded', 'false');
    };
    const openMenu = () => {
      settingsMenu.hidden = false;
      menuToggle.setAttribute('aria-expanded', 'true');
    };
    menuToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (settingsMenu.hidden) openMenu();
      else closeMenu();
    });
    document.addEventListener('click', (e) => {
      if (!settingsMenu.hidden && !settingsMenu.contains(e.target as Node) && e.target !== menuToggle) {
        closeMenu();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });
  }

  // About modal
  const aboutOpenBtn = document.getElementById('about-open');
  const aboutModal = document.getElementById('about-modal') as HTMLElement | null;
  const aboutCloseBtn = document.getElementById('about-close');
  if (aboutOpenBtn && aboutModal) {
    aboutOpenBtn.addEventListener('click', () => {
      settingsMenu && (settingsMenu.hidden = true);
      aboutModal.hidden = false;
    });
  }
  if (aboutCloseBtn && aboutModal) {
    aboutCloseBtn.addEventListener('click', () => {
      aboutModal.hidden = true;
    });
  }
  if (aboutModal) {
    aboutModal.addEventListener('click', (e) => {
      if (e.target === aboutModal) aboutModal.hidden = true;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') aboutModal.hidden = true;
    });
  }

  // The Service Worker is generated + registered by vite-plugin-pwa (see
  // vite.config.ts). This just drops the ~18 MB cache left behind by the old
  // hand-written sw.js, which the Workbox worker doesn't know to clean up.
  if ('caches' in window) {
    caches.delete('zachroute-v2').catch(() => {});
  }

  // Connections toggle state
  const toggleCheckbox = document.getElementById('connections-toggle') as HTMLInputElement | null;
  if (toggleCheckbox) {
    // Initialize from current checkbox state (default off)
    (window as any).connectionsEnabled = toggleCheckbox.checked;

    toggleCheckbox.addEventListener('change', () => {
      (window as any).connectionsEnabled = toggleCheckbox.checked;
      if (!toggleCheckbox.checked) {
        import('./mapRenderer').then(m => m.clearConnections());
      }
    });
  } else {
    (window as any).connectionsEnabled = false;
  }

	  // Large hubs / Medium / Regional airport layer toggles (settings flyout)
  const largeToggle = document.getElementById('large-toggle') as HTMLInputElement | null;
  const mediumToggle = document.getElementById('medium-toggle') as HTMLInputElement | null;
  const regionalToggle = document.getElementById('regional-toggle') as HTMLInputElement | null;

  const LARGE_KEY = 'zachroute:show-large';
  const MEDIUM_KEY = 'zachroute:show-medium';
  const REGIONAL_KEY = 'zachroute:show-regional';

  function restoreAirportToggle(el: HTMLInputElement | null, key: string, showFn: (v: boolean) => void) {
    if (!el) return;
    const saved = localStorage.getItem(key);
    const on = saved === null ? false : saved === 'true';
    el.checked = on;
    if (on) showFn(true);
  }

  restoreAirportToggle(largeToggle, LARGE_KEY, showLargeAirports);
  restoreAirportToggle(mediumToggle, MEDIUM_KEY, showMediumAirports);
  restoreAirportToggle(regionalToggle, REGIONAL_KEY, showRegionalAirports);

  // Weather stations / hazards / day-night map overlays (settings flyout)
  const wxToggle = document.getElementById('wxstations-toggle') as HTMLInputElement | null;
  const hazardToggle = document.getElementById('hazards-toggle') as HTMLInputElement | null;
  const nightToggle = document.getElementById('daynight-toggle') as HTMLInputElement | null;
  const WX_KEY = 'zachroute:show-wxstations';
  const HAZARD_KEY = 'zachroute:show-hazards';
  const NIGHT_KEY = 'zachroute:show-daynight';
  const approachToggle = document.getElementById('approach-toggle') as HTMLInputElement | null;
  const APPROACH_KEY = 'zachroute:show-approach-ticks';
  restoreAirportToggle(approachToggle, APPROACH_KEY, setApproachTicks);
  const pirepToggle = document.getElementById('pireps-toggle') as HTMLInputElement | null;
  const PIREP_KEY = 'zachroute:show-pireps';
  restoreAirportToggle(pirepToggle, PIREP_KEY, setPireps);
  const cycloneToggle = document.getElementById('cyclones-toggle') as HTMLInputElement | null;
  const CYCLONE_KEY = 'zachroute:show-cyclones';
  restoreAirportToggle(cycloneToggle, CYCLONE_KEY, setCyclones);
  const tfrToggle = document.getElementById('tfr-toggle') as HTMLInputElement | null;
  const TFR_KEY = 'zachroute:show-tfrs';
  restoreAirportToggle(tfrToggle, TFR_KEY, setTfrs);
  // Thunderstorm forecast: which step (4, 6 or 8 hours ahead) is restored before the layer turns on.
  const tcfToggle = document.getElementById('tcf-toggle') as HTMLInputElement | null;
  const TCF_KEY = 'zachroute:show-tcf';
  const tcfStepSelect = document.getElementById('tcf-step') as HTMLSelectElement | null;
  const TCF_STEP_KEY = 'zachroute:tcf-step';
  if (tcfStepSelect) {
    let savedStep: string | null = null;
    try {
      savedStep = localStorage.getItem(TCF_STEP_KEY);
    } catch {
      /* convenience only */
    }
    if (savedStep === '1' || savedStep === '2') {
      tcfStepSelect.value = savedStep;
      setTcfStep(Number(savedStep) as TcfStep);
    }
    tcfStepSelect.addEventListener('change', () => {
      try {
        localStorage.setItem(TCF_STEP_KEY, tcfStepSelect.value);
      } catch {
        /* convenience only */
      }
      setTcfStep(Number(tcfStepSelect.value) as TcfStep);
    });
  }
  restoreAirportToggle(tcfToggle, TCF_KEY, setTcf);
  // Severe storm outlook: which day is restored before the layer turns on.
  const spcToggle = document.getElementById('spc-toggle') as HTMLInputElement | null;
  const SPC_KEY = 'zachroute:show-spc';
  const spcDaySelect = document.getElementById('spc-day') as HTMLSelectElement | null;
  const SPC_DAY_KEY = 'zachroute:spc-day';
  if (spcDaySelect) {
    let savedDay: string | null = null;
    try {
      savedDay = localStorage.getItem(SPC_DAY_KEY);
    } catch {
      /* convenience only */
    }
    if (savedDay === '2') {
      spcDaySelect.value = '2';
      setSpcDay(2);
    }
    spcDaySelect.addEventListener('change', () => {
      try {
        localStorage.setItem(SPC_DAY_KEY, spcDaySelect.value);
      } catch {
        /* convenience only */
      }
      setSpcDay(spcDaySelect.value === '2' ? 2 : 1);
    });
  }
  restoreAirportToggle(spcToggle, SPC_KEY, setSpc);
  const fireToggle = document.getElementById('fires-toggle') as HTMLInputElement | null;
  const FIRE_KEY = 'zachroute:show-fires';
  restoreAirportToggle(fireToggle, FIRE_KEY, setFires);
  const aerosolToggle = document.getElementById('aerosol-toggle') as HTMLInputElement | null;
  const AEROSOL_KEY = 'zachroute:show-aerosol';
  restoreAirportToggle(aerosolToggle, AEROSOL_KEY, setAerosol);
  const freezingToggle = document.getElementById('freezing-toggle') as HTMLInputElement | null;
  const FREEZING_KEY = 'zachroute:show-freezing';
  restoreAirportToggle(freezingToggle, FREEZING_KEY, setFreezingLevel);
  const radarToggle = document.getElementById('radar-toggle') as HTMLInputElement | null;
  const RADAR_KEY = 'zachroute:show-radar';
  // What radar shows, restored before the layer turns on.
  const radarModeSelect = document.getElementById('radar-mode') as HTMLSelectElement | null;
  const RADAR_MODE_KEY = 'zachroute:radar-mode';
  if (radarModeSelect) {
    let savedMode: string | null = null;
    try {
      savedMode = localStorage.getItem(RADAR_MODE_KEY);
    } catch {
      /* convenience only */
    }
    if (savedMode === 'tops') {
      radarModeSelect.value = 'tops';
      setRadarMode('tops');
    }
    radarModeSelect.addEventListener('change', () => {
      try {
        localStorage.setItem(RADAR_MODE_KEY, radarModeSelect.value);
      } catch {
        /* convenience only */
      }
      setRadarMode(radarModeSelect.value as RadarMode);
    });
  }
  restoreAirportToggle(radarToggle, RADAR_KEY, setRadar);
  const satelliteToggle = document.getElementById('satellite-toggle') as HTMLInputElement | null;
  const SATELLITE_KEY = 'zachroute:show-satellite';
  restoreAirportToggle(satelliteToggle, SATELLITE_KEY, setSatellite);

  restoreAirportToggle(wxToggle, WX_KEY, setWeatherStations);
  restoreAirportToggle(hazardToggle, HAZARD_KEY, setHazards);
  restoreAirportToggle(nightToggle, NIGHT_KEY, setDayNight);

  function wireOverlayToggle(el: HTMLInputElement | null, key: string, apply: (v: boolean) => void) {
    if (!el) return;
    el.addEventListener('change', () => {
      localStorage.setItem(key, String(el.checked));
      apply(el.checked);
    });
  }
  wireOverlayToggle(wxToggle, WX_KEY, setWeatherStations);

  // What the weather stations show: wind (default) or temperature
  const wxModeSelect = document.getElementById('wxstations-mode') as HTMLSelectElement | null;
  const WX_MODE_KEY = 'zachroute:wxstations-mode';
  if (wxModeSelect) {
    let savedMode: string | null = null;
    try {
      savedMode = localStorage.getItem(WX_MODE_KEY);
    } catch {
      /* convenience only */
    }
    if (savedMode === 'temp') {
      wxModeSelect.value = 'temp';
      setStationMode('temp');
    }
    wxModeSelect.addEventListener('change', () => {
      const mode = wxModeSelect.value as StationMode;
      try {
        localStorage.setItem(WX_MODE_KEY, mode);
      } catch {
        /* convenience only */
      }
      setStationMode(mode);
    });
  }
  wireOverlayToggle(hazardToggle, HAZARD_KEY, setHazards);
  wireOverlayToggle(nightToggle, NIGHT_KEY, setDayNight);
  wireOverlayToggle(pirepToggle, PIREP_KEY, setPireps);
  wireOverlayToggle(cycloneToggle, CYCLONE_KEY, setCyclones);
  wireOverlayToggle(tfrToggle, TFR_KEY, setTfrs);
  wireOverlayToggle(tcfToggle, TCF_KEY, setTcf);
  wireOverlayToggle(spcToggle, SPC_KEY, setSpc);
  wireOverlayToggle(fireToggle, FIRE_KEY, setFires);
  wireOverlayToggle(aerosolToggle, AEROSOL_KEY, setAerosol);
  wireOverlayToggle(freezingToggle, FREEZING_KEY, setFreezingLevel);
  wireOverlayToggle(radarToggle, RADAR_KEY, setRadar);
  wireOverlayToggle(satelliteToggle, SATELLITE_KEY, setSatellite);
  wireOverlayToggle(approachToggle, APPROACH_KEY, setApproachTicks);

  // Units (settings menu). Changing one re-renders the current result in the new units.
  const distanceSelect = document.getElementById('distance-unit') as HTMLSelectElement | null;
  const clockSelect = document.getElementById('clock-format') as HTMLSelectElement | null;
  const weatherSelect = document.getElementById('weather-units') as HTMLSelectElement | null;
  if (distanceSelect) {
    distanceSelect.value = getDistanceUnit();
    distanceSelect.addEventListener('change', () => setDistanceUnit(distanceSelect.value as DistanceUnit));
  }
  if (clockSelect) {
    clockSelect.value = getClockFormat();
    clockSelect.addEventListener('change', () => setClockFormat(clockSelect.value as ClockFormat));
  }
  if (weatherSelect) {
    weatherSelect.value = getWeatherUnits();
    weatherSelect.addEventListener('change', () => setWeatherUnits(weatherSelect.value as WeatherUnits));
  }
  window.addEventListener(UNITS_CHANGED, () => {
    if (currentQuery) runSearch(currentQuery, 'none');
  });

  // Version / build stamp (About and the settings menu) so it's clear which build a device is running.
  const buildDate = new Date(__BUILD_TIME__);
  const buildLabel = isNaN(buildDate.getTime())
    ? ''
    : buildDate.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const aboutVersionEl = document.getElementById('about-version');
  const aboutBuildEl = document.getElementById('about-build');
  const menuVersionEl = document.getElementById('menu-version');
  if (aboutVersionEl) aboutVersionEl.textContent = __APP_VERSION__;
  if (aboutBuildEl) aboutBuildEl.textContent = buildLabel;
  if (menuVersionEl) menuVersionEl.textContent = `v${__APP_VERSION__}`;

  if (largeToggle) {
    largeToggle.addEventListener('change', () => {
      const on = largeToggle.checked;
      localStorage.setItem(LARGE_KEY, String(on));
      showLargeAirports(on);
    });
  }
  if (mediumToggle) {
    mediumToggle.addEventListener('change', () => {
      const on = mediumToggle.checked;
      localStorage.setItem(MEDIUM_KEY, String(on));
      showMediumAirports(on);
    });
  }
  if (regionalToggle) {
    regionalToggle.addEventListener('change', () => {
      const on = regionalToggle.checked;
      localStorage.setItem(REGIONAL_KEY, String(on));
      showRegionalAirports(on);
    });
  }

  // Expose for map marker clicks
  // The card learned which runway end the wind favors: highlight it and aim the approach path.
  (window as any).highlightRunway = (airport: Airport, ident: string | null) => {
    highlightRunway(airport, ident);
    setPreferredRunwayEnd(airport, ident);
  };
  (window as any).colorRouteByWind = colorRouteByWind;
  (window as any).renderSingleAirport = (airport: any) => {
    const code = airport.iata || airport.icao;
    currentQuery = code;
    input.value = code;
    updateClearButton();
    recordHistory(code, 'push');
    sheet.setSummary(singleSummary(airport));
    if (sheet.isPhone()) sheet.setState('half');
    renderSingle(airport);
    addResultActions(null);
    drawAirportRunways([airport]);
    // Optionally auto-fetch lore if none exists
    const hasLore = airport.lore || getCachedLore(airport.iata);
    if (!hasLore && navigator.onLine) {
      setTimeout(() => enrichLore(airport), 300);
    }

    // Handle connections based on toggle state
    if ((window as any).connectionsEnabled) {
      showConnections(airport);
    }
  };

  function showRoutePair(origin: Airport, destination: Airport) {
    if (isKnownDirect(origin, destination)) {
      showRoute(origin, destination);
    } else {
      const via = findConnectingRoutes(origin, destination);
      showConnectingRoutes(origin, destination, via.options, via.depth, via.drawLimit);
    }
    renderRoute(origin, destination);
    addResultActions({ origin, destination });
  }

  // Expose route view for clickable connection markers
  (window as any).renderRouteView = (origin: Airport, destination: Airport) => {
    runSearch(`${codeOf(origin)} ${codeOf(destination)}`, 'push');
  };
  (window as any).highlightViaRoute = highlightViaRoute;
  (window as any).showAllVia = showAllViaOptions;

  // Opened from a shared link (or reloaded on a result): show that search.
  const initialQuery = new URLSearchParams(location.search).get('q');
  if (initialQuery) {
    history.replaceState({ q: initialQuery }, '', urlFor(initialQuery));
    runSearch(initialQuery, 'none');
  } else {
    history.replaceState({ q: '' }, '', location.pathname);
    renderEmptyState();
  }
}

init();