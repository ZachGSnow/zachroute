import type { Airport, RunwayDetail } from './geoMath';
import { formatDistance, formatTemp, formatPressure, formatVisibility, tempSpread, fogSpread, getWeatherUnits, metarVisibilityMetric, hourOptions } from './units';
import { haversineDistance, initialBearing, blockTimeMiles, windAdjustedBlockTime, blockTimeWithHeadwind, slerpArc } from './geoMath';
import {
  fetchWeather,
  categoryInfo,
  categoryDot,
  relativeTimeLabel,
  favoredRunwayEnd,
  decodeWxPhenomena,
  weatherEmoji,
  crosswindComponents,
  densityAltitudeFt,
  trueToMagnetic,
  type WeatherSnapshot,
  type FavoredRunwayEnd,
} from './weather';
import { localTimeLabel, nextDaylightEventLabel, moonPhaseLabel, isDaytime, utcOffsetMinutes } from './timeUtils';
import { resolveCode } from './searchParser';
import { fetchTaf, decodeTaf, compassPoint } from './forecast';
import { faaDelayChips, nwsAlertChips, fetchPirepLines, type Chip } from './advisories';
import { fetchCyclones, stormsNearPoint, stormTitle } from './cyclones';
import { fetchAirQuality, aqiScaleFor, aqiCategory, aqiValue, hazeNote, worseningAhead } from './airQuality';
import { fetchCruiseWind } from './windsAloft';
import { fetchAirportPhoto } from './wikiPhoto';
import { carriersFor, carrierNames, carrierDataNote } from './carriers';
import { isFavorite, toggleFavorite } from './history';
import { analyzeRoute, drawRouteHazards, describeAdvisory, describeRoutePirep, ashNear, advisoryAltitude, type Advisory } from './mapOverlays';
import {
  airportCode,
  destinationCodesFor,
  findConnectingRoutes,
  isKnownDirect,
  type ConnectingDepth,
  type ViaOption,
} from './connections';

const resultsContent = document.getElementById('results-content')!;
const BULLET = '\u00b7';

const LORE_CACHE_KEY = (iata: string) => `zachroute:lore:${iata}`;

function getCachedLore(iata: string): string | null {
  return localStorage.getItem(LORE_CACHE_KEY(iata));
}

function setCachedLore(iata: string, lore: string) {
  localStorage.setItem(LORE_CACHE_KEY(iata), lore);
}

export async function enrichLore(iata: string, cardElement?: HTMLElement) {
  const target = cardElement || resultsContent;

  const cached = getCachedLore(iata);
  if (cached) {
    const loreDiv = target.querySelector('.lore');
    if (loreDiv) loreDiv.textContent = cached;
    return;
  }

  if (!navigator.onLine) {
    const loreDiv = target.querySelector('.lore');
    if (loreDiv) loreDiv.innerHTML = '<em class="muted">Offline \u2014 no cached lore for this airport</em>';
    return;
  }

  try {
    const res = await fetch(`/api/lore?iata=${iata}`);
    if (!res.ok) throw new Error('Lore fetch failed');
    const data = await res.json();
    if (data.extract) {
      setCachedLore(iata, data.extract);
      const loreDiv = target.querySelector('.lore');
      if (loreDiv) loreDiv.textContent = data.extract;
    }
  } catch (e) {
    const loreDiv = target.querySelector('.lore');
    if (loreDiv) loreDiv.innerHTML = '<em class="error-text">Failed to fetch lore</em>';
  }
}

// ---------------------------------------------------------------------------
// Expandable sections (used for runway lists > 4, frequencies, and destinations)
// ---------------------------------------------------------------------------

let expandableIdCounter = 0;

function expandableSection(label: string, innerHtml: string): string {
  const id = `exp-${expandableIdCounter++}`;
  return `
    <div class="expandable">
      <button type="button" class="expandable-toggle" data-target="${id}">${label}</button>
      <div class="expandable-content" id="${id}" hidden>${innerHtml}</div>
    </div>
  `;
}

function wireExpandables(root: ParentNode) {
  root.querySelectorAll('.expandable-toggle').forEach((btnEl) => {
    const btn = btnEl as HTMLButtonElement;
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.onclick = () => {
      const targetId = btn.dataset.target!;
      const content = root.querySelector(`#${targetId}`) as HTMLElement | null;
      if (!content) return;
      const willShow = Boolean(content.hidden);
      content.hidden = !willShow;
      btn.classList.toggle('is-open', willShow);
    };
  });
}

// ---------------------------------------------------------------------------
// Runways
// ---------------------------------------------------------------------------

function buildRunwaysHtml(
  airport: Airport,
  favored: FavoredRunwayEnd | null,
  windDirDeg?: number,
  windSpeedKt?: number
): string {
  const runways = airport.runways;
  if (!runways || runways.length === 0) {
    return `<div class="detail-block"><div class="detail-heading">Runways</div><div class="muted">n/a</div></div>`;
  }

  const rows = runways
    .map((r) => {
      const isFavored = !!favored && r.ident.split('/').includes(favored.ident);
      const dims = `${r.lengthFt.toLocaleString()} ft${r.widthFt ? ' \u00d7 ' + r.widthFt + ' ft' : ''}`;
      const extras = [r.surface, r.lighted ? 'lighted' : null].filter(Boolean).join(', ');

      let favoredBadge = '';
      if (isFavored) {
        let windNote = '';
        if (favored && windDirDeg !== undefined && windSpeedKt !== undefined) {
          const { headwindKt, crosswindKt } = crosswindComponents(favored.headingDegT, windDirDeg, windSpeedKt);
          const windLabel = headwindKt >= 0 ? `${headwindKt}kt headwind` : `${Math.abs(headwindKt)}kt tailwind`;
          windNote = ` \u2014 💨 ${windLabel}, ${crosswindKt}kt crosswind`;
        }
        favoredBadge = `<span class="favored-badge">★ favored${windNote}</span>`;
      }

      return `<div class="detail-row"><span>${r.ident} \u2014 ${dims}${extras ? ', ' + extras : ''}</span>${favoredBadge}</div>`;
    })
    .join('');

  const footnote = favored
    ? `<div class="detail-footnote">★ favored \u2014 best aligned with current wind</div>`
    : '';

  if (runways.length > 4) {
    return expandableSection(`Runways (${runways.length})`, rows + footnote);
  }

  return `<div class="detail-block"><div class="detail-heading">Runways</div>${rows}${footnote}</div>`;
}

// ---------------------------------------------------------------------------
// Frequencies
// ---------------------------------------------------------------------------

const FREQUENCY_LABELS: Record<string, string> = {
  TWR: 'Tower',
  GND: 'Ground',
  ATIS: 'ATIS',
  AWOS: 'Weather (AWOS)',
  ASOS: 'Weather (ASOS)',
  CLD: 'Clearance Delivery',
  APP: 'Approach',
  DEP: 'Departure',
  'A/D': 'Approach / Departure',
  CTAF: 'CTAF',
  UNIC: 'Unicom',
  UNICOM: 'Unicom',
  RDO: 'Radio',
  RCO: 'Remote Comm Outlet',
};

function frequencyLabel(type: string, description: string): string {
  return FREQUENCY_LABELS[type.toUpperCase()] || description || type;
}

function buildFrequenciesHtml(airport: Airport): string {
  const freqs = airport.frequencies;
  if (!freqs || freqs.length === 0) return '';

  const rows = freqs
    .map(
      (f) =>
        `<div class="detail-row"><span>${frequencyLabel(f.type, f.description)}</span><span class="mono">${f.frequencyMhz}</span></div>`
    )
    .join('');

  return expandableSection(`Frequencies (${freqs.length})`, rows);
}

// ---------------------------------------------------------------------------
// Navaids (VOR / NDB / DME ...) associated with the airport
// ---------------------------------------------------------------------------

function navaidFrequencyLabel(type: string, freqKhz?: number): string {
  if (freqKhz === undefined || isNaN(freqKhz)) return '';
  // VOR-family and TACAN are published in MHz; NDBs in kHz.
  if (/VOR|TACAN|DME/i.test(type) && !/NDB/i.test(type)) return `${(freqKhz / 1000).toFixed(2)} MHz`;
  return `${freqKhz} kHz`;
}

function buildNavaidsHtml(airport: Airport): string {
  const navaids = airport.navaids;
  if (!navaids || navaids.length === 0) return '';
  const rows = navaids
    .map((n) => {
      const freq = navaidFrequencyLabel(n.type, n.freqKhz);
      return `<div class="detail-row"><span>${n.ident} - ${n.name} (${n.type})</span><span class="mono">${freq}</span></div>`;
    })
    .join('');
  return expandableSection(`Navaids (${navaids.length})`, rows);
}

// ---------------------------------------------------------------------------
// Destinations (direct connections, clickable)
// ---------------------------------------------------------------------------

function buildDestinationsHtml(airport: Airport): string {
  const codes = destinationCodesFor(airport);
  if (codes.length === 0) return '';

  const resolved = codes.map((code) => ({ code, dest: resolveCode(code) }));
  resolved.sort((a, b) => {
    const nameA = a.dest?.city || a.code;
    const nameB = b.dest?.city || b.code;
    return nameA.localeCompare(nameB);
  });

  const rows = resolved
    .map(({ code, dest }) => {
      if (!dest) {
        return `<div class="detail-row destination-row destination-row--unresolved"><span>${code}</span></div>`;
      }
      const destCode = dest.iata || dest.icao;
      const label = [dest.city, destCode].filter(Boolean).join(' \u2014 ');
      const names = carrierNames(carriersFor(airport, dest), 3);
      const airlines = names ? `<span class="dest-carriers" title="${carrierDataNote()}">${names}</span>` : '';
      return `<button type="button" class="detail-row destination-row" data-dest-code="${destCode}"><span>${label}</span>${airlines}</button>`;
    })
    .join('');

  const label = `${codes.length} direct destination${codes.length === 1 ? '' : 's'}`;
  return expandableSection(label, `<div class="destinations-list">${rows}</div>`);
}

function wireDestinationsList(cardEl: HTMLElement, airport: Airport) {
  cardEl.querySelectorAll('.destination-row[data-dest-code]').forEach((btnEl) => {
    const btn = btnEl as HTMLButtonElement;
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.onclick = () => {
      const code = btn.dataset.destCode!;
      const dest = resolveCode(code);
      if (!dest) return;
      (window as any).renderRouteView?.(airport, dest);
    };
  });
}

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

function weatherPlaceholderHtml(): string {
  return `<span class="muted">Checking current conditions\u2026</span>`;
}

function weatherContentHtml(wx: WeatherSnapshot, elevationFt: number, daytime: boolean, magVarDeg?: number): string {
  if (!wx.available) {
    return `<div class="muted">Current conditions: n/a</div>`;
  }

  const cat = categoryInfo(wx.flightCategory);
  const dot = categoryDot(wx.flightCategory);
  const emoji = weatherEmoji(wx, daytime);
  const catHtml = cat
    ? `${dot}${emoji} ${cat.label}${
        wx.flightCategory ? ` <span class="muted">(${wx.flightCategory})</span>` : ''
      }`
    : `${emoji}`;

  const bits: string[] = [];
  if (wx.windDirDeg !== undefined && wx.windSpeedKt !== undefined) {
    const gust = wx.windGustKt !== undefined ? `, gusting ${wx.windGustKt}kt` : '';
    bits.push(`💨 Wind ${wx.windDirDeg}\u00b0 @ ${wx.windSpeedKt}kt${gust}`);
  }
  if (wx.visibility) {
    const vis = (getWeatherUnits() === 'metric' && metarVisibilityMetric(wx.rawText)) || formatVisibility(wx.visibility);
    bits.push(`👁️ Vis ${vis}`);
  }
  if (wx.tempF !== undefined) bits.push(`🌡️ ${formatTemp(wx.tempF, wx.tempC)}`);

  const detailLine = bits.length ? `<div class="weather-detail">${bits.join(' \u2022 ')}</div>` : '';
  const updated = relativeTimeLabel(wx.observedIso);
  const updatedLine = updated ? `<div class="weather-updated muted">Observed ${updated}</div>` : '';

  const moreRows: string[] = [];
  if (wx.dewpointF !== undefined) {
    let spreadNote = '';
    if (wx.tempF !== undefined) {
      const spread = tempSpread(wx.tempF, wx.dewpointF, wx.tempC, wx.dewpointC);
      if (spread <= fogSpread()) spreadNote = ` (${spread}\u00b0 spread \u2014 fog risk)`;
    }
    moreRows.push(`<div class="detail-row"><span>💧 Dewpoint ${formatTemp(wx.dewpointF, wx.dewpointC)}${spreadNote}</span></div>`);
  }
  if (wx.windDirDeg !== undefined && wx.windSpeedKt !== undefined && wx.windSpeedKt >= 3 && magVarDeg !== undefined) {
    const mag = String(trueToMagnetic(wx.windDirDeg, magVarDeg)).padStart(3, '0');
    moreRows.push(
      `<div class="detail-row"><span>🧭 As tower/ATIS will say it: wind ${mag}\u00b0 magnetic (METAR uses true north; local variation ${Math.abs(magVarDeg).toFixed(1)}\u00b0${magVarDeg < 0 ? 'W' : 'E'})</span></div>`
    );
  }
  const phenomena = decodeWxPhenomena(wx.weatherPhenomena);
  if (phenomena) {
    moreRows.push(`<div class="detail-row"><span>${emoji} Weather: ${phenomena}</span></div>`);
  }
  if (wx.ceilingFt !== undefined) {
    const coverLabel = wx.ceilingCover === 'OVC' ? 'overcast' : 'broken';
    moreRows.push(
      `<div class="detail-row"><span>☁️ Ceiling ${wx.ceilingFt.toLocaleString()} ft ${coverLabel}</span></div>`
    );
  }
  if (wx.altimeterInHg !== undefined) {
    moreRows.push(`<div class="detail-row"><span>📊 ${formatPressure(wx.altimeterInHg, wx.altimeterHpa)}</span></div>`);
  }
  if (wx.tempF !== undefined) {
    const da = densityAltitudeFt(elevationFt, wx.tempF);
    moreRows.push(`<div class="detail-row"><span>⛰️ Density altitude \u2248 ${da.toLocaleString()} ft</span></div>`);
  }

  const moreHtml = moreRows.length ? expandableSection(`More details (${moreRows.length})`, moreRows.join('')) : '';

  return `<div class="weather-line">${catHtml}</div>${detailLine}${updatedLine}${moreHtml}`;
}

// ---------------------------------------------------------------------------
// Local time / sunrise-sunset / moon phase
// ---------------------------------------------------------------------------

function daylightEventWithEmoji(lat: number, lon: number, timeZone?: string): string | null {
  const label = nextDaylightEventLabel(lat, lon, timeZone);
  if (!label) return null;
  const emoji = label.startsWith('Sunrise') ? '🌅' : '🌇';
  return `${emoji} ${label}`;
}

function timeLineHtml(airport: Airport): string {
  const time = localTimeLabel(airport.timeZone);
  const sun = daylightEventWithEmoji(airport.lat, airport.lon, airport.timeZone);
  const moon = moonPhaseLabel();
  const parts = [time ? `Local time ${time}` : null, sun, moon].filter(Boolean);
  if (parts.length === 0) return '';
  return `<div class="subhead">${parts.join(' \u2022 ')}</div>`;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function linksRowHtml(airport: Airport): string {
  const links: string[] = [];
  if (airport.homeLink) {
    links.push(`<a href="${airport.homeLink}" target="_blank" rel="noopener">🌐 Website</a>`);
  }
  if (airport.icao) {
    links.push(
      `<a href="https://skyvector.com/airport/${airport.icao}" target="_blank" rel="noopener">🗺 Airport diagram</a>`
    );
  }
  if (airport.wikipediaLink) {
    links.push(`<a href="${airport.wikipediaLink}" target="_blank" rel="noopener">Wikipedia \u2197</a>`);
  }
  if (links.length === 0) return '';
  return `<div class="links-row">${links.join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Facility card (shared by single-airport and route views)
// ---------------------------------------------------------------------------

function buildFacilityCard(airport: Airport): string {
  const typePill = airport.airportType
    ? `<span class="type-pill">${airport.airportType}</span>`
    : `<span class="type-pill">n/a</span>`;

  const elevationText = airport.elevation ? `${airport.elevation.toLocaleString()} ft elevation` : 'n/a';
  const locationLine = [airport.city, airport.state, airport.countryName || airport.country].filter(Boolean).join(', ');

  const initialLore = airport.lore || getCachedLore(airport.iata) || '';

  return `
    <div class="facility-card" data-iata="${airport.iata}" data-icao="${airport.icao}">
      <div class="card-title-row">
        <h3>${airport.iata || airport.icao} \u2014 ${airport.name} ${typePill}</h3>
        ${favButtonHtml(airport)}
      </div>
      <div class="subhead">${locationLine} \u2022 ${elevationText}</div>
      ${airport.primaryOperator ? `<div class="subhead">Primary operator: ${airport.primaryOperator}</div>` : ''}
      <div class="alerts-block"></div>
      <div class="photo-block"></div>

      <div class="weather-block">${weatherPlaceholderHtml()}</div>
      <div class="aq-block"></div>
      ${timeLineHtml(airport)}
      <div class="forecast-block"></div>
      <div class="pirep-block"></div>

      <div class="runways-block">${buildRunwaysHtml(airport, null)}</div>
      ${buildFrequenciesHtml(airport)}
      ${buildNavaidsHtml(airport)}
      ${buildDestinationsHtml(airport)}

      ${linksRowHtml(airport)}

      <div class="lore">${initialLore || '<em class="muted">No lore cached</em>'}</div>
      ${
        initialLore
          ? ''
          : `<button class="lore-btn" data-iata="${airport.iata}">Fetch lore</button>`
      }
    </div>
  `;
}

function wireLoreButton(cardEl: HTMLElement, airport: Airport) {
  const btn = cardEl.querySelector('.lore-btn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Fetching\u2026';
    btn.classList.add('is-loading');
    await enrichLore(airport.iata, cardEl);
    btn.textContent = 'Updated';
    btn.classList.remove('is-loading');
    btn.classList.add('is-success');
    setTimeout(() => {
      btn.style.display = 'none';
    }, 1500);
  };
}

function chipsHtml(chips: Chip[]): string {
  return chips
    .map((c) => `<span class="chip chip-${c.level}"${c.title ? ` title="${c.title.replace(/"/g, '&quot;')}"` : ''}>${c.text}</span>`)
    .join('');
}

/** A chip for each volcanic ash advisory over or near the airport (worldwide, from SIGMETs). */
async function ashChips(airport: Airport): Promise<Chip[]> {
  if (!navigator.onLine) return [];
  // A volcano often has two SIGMETs (the observed cloud and its forecast position): keep the closest.
  const seen = new Set<string>();
  const near = (await ashNear(airport.lat, airport.lon)).filter(({ advisory }) => {
    const key = advisory.name || advisory.coords.join();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return near.slice(0, 2).map(({ advisory, miles }) => {
    const where = miles < 1 ? 'over the airport' : `${formatDistance(miles)} away`;
    const alt = advisoryAltitude(advisory);
    return {
      level: 'alert',
      text: `🌋 Volcanic ash ${where}${advisory.name ? ` (${advisory.name})` : ''}`,
      title: [alt && `Ash cloud ${alt}`, advisory.region && `${advisory.region} FIR`].filter(Boolean).join(', ') || undefined,
    };
  });
}

/** A chip for each tropical cyclone near the airport or forecast to pass over it (worldwide, GDACS). */
async function cycloneChips(airport: Airport): Promise<Chip[]> {
  if (!navigator.onLine) return [];
  const near = stormsNearPoint(airport.lat, airport.lon, await fetchCyclones());
  return near.slice(0, 2).map(({ storm, miles, bearing, inCone }) => {
    const where = miles < 30 ? 'over the airport' : `${formatDistance(miles)} ${compassPoint(bearing)}`;
    const path = inCone && miles >= 30 ? ', airport in forecast path' : '';
    return {
      level: miles <= 150 || (inCone && storm.category === 'HU') ? 'alert' : 'warn',
      text: `🌀 ${stormTitle(storm)} ${where}${path}`,
      title: `As of ${new Date(storm.asOf).toUTCString().replace(':00 GMT', ' UTC')}${storm.source ? `, ${storm.source} via GDACS` : ''}`,
    };
  });
}

async function fillAlerts(cardEl: HTMLElement, airport: Airport) {
  const el = cardEl.querySelector('.alerts-block') as HTMLElement | null;
  if (!el) return;
  const [ash, storms, delays, alerts] = await Promise.all([ashChips(airport), cycloneChips(airport), faaDelayChips(airport), nwsAlertChips(airport)]);
  if (!el.isConnected) return;
  const chips = [...ash, ...storms, ...delays, ...alerts];
  if (chips.length === 0) return;
  el.innerHTML = `<div class="chips">${chipsHtml(chips)}</div>`;
}

async function fillPhoto(cardEl: HTMLElement, airport: Airport) {
  const el = cardEl.querySelector('.photo-block') as HTMLElement | null;
  if (!el || !airport.wikipediaLink) return;
  const url = await fetchAirportPhoto(airport.wikipediaLink);
  if (!url || !el.isConnected) return;
  el.innerHTML = `<img class="airport-photo" src="${url}" alt="${airport.name}" loading="lazy" referrerpolicy="no-referrer" /><div class="photo-credit muted">Photo via Wikipedia</div>`;
  const img = el.querySelector('img');
  img?.addEventListener('error', () => {
    el.innerHTML = '';
  });
}

async function fillForecast(cardEl: HTMLElement, airport: Airport) {
  const el = cardEl.querySelector('.forecast-block') as HTMLElement | null;
  if (!el || !airport.icao) return;
  const taf = await fetchTaf(airport.icao);
  if (!el.isConnected) return;
  const decoded = decodeTaf(taf, airport.timeZone);
  if (!decoded) return;
  const headline = decoded.headline ? `<div class="forecast-headline">${decoded.headline}</div>` : '';
  const body = expandableSection(`Forecast (${decoded.count} periods)`, decoded.rows.join(''));
  el.innerHTML = `${headline}${body}`;
  wireExpandables(el);
}

async function fillPireps(cardEl: HTMLElement, airport: Airport) {
  const el = cardEl.querySelector('.pirep-block') as HTMLElement | null;
  if (!el) return;
  const lines = await fetchPirepLines(airport);
  if (!el.isConnected || lines.length === 0) return;
  const rows = lines
    .map((l) => `<div class="detail-row${l.severe ? ' pirep-severe' : ''}"><span>${l.severe ? '⚠️ ' : ''}${l.text}</span></div>`)
    .join('');
  el.innerHTML = expandableSection(`Pilot reports (${lines.length})`, rows);
  wireExpandables(el);
}

function favButtonHtml(airport: Airport): string {
  const on = isFavorite(airport.iata || airport.icao);
  const label = on ? 'Remove from favorites' : 'Add to favorites';
  return `<button type="button" class="fav-btn${on ? ' is-on' : ''}" aria-pressed="${on}" aria-label="${label}" title="${label}">${on ? '\u2605' : '\u2606'}</button>`;
}

function wireFavButton(cardEl: HTMLElement, airport: Airport) {
  const btn = cardEl.querySelector('.fav-btn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.onclick = () => {
    const on = toggleFavorite(airport.iata || airport.icao);
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', String(on));
    const label = on ? 'Remove from favorites' : 'Add to favorites';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.textContent = on ? '\u2605' : '\u2606';
  };
}

const AQ_DOTS = ['🟢', '🟡', '🟠', '🔴', '🟣', '🟤'];

/** Air quality line, plus a haze note and a "getting worse" line when they apply. */
async function fillAirQuality(cardEl: HTMLElement, airport: Airport) {
  const el = cardEl.querySelector('.aq-block') as HTMLElement | null;
  if (!el) return;
  const aq = await fetchAirQuality(airport.lat, airport.lon);
  if (!aq || !el.isConnected) return;

  const scale = aqiScaleFor(airport.country);
  const scaleName = scale === 'eu' ? 'European AQI' : 'US AQI';
  const value = aqiValue(aq, scale);
  const lines: string[] = [];
  if (value !== undefined) {
    const cat = aqiCategory(value, scale);
    const pm = aq.pm25 !== undefined ? ` \u2022 PM2.5 ${Math.round(aq.pm25)} \u00b5g/m\u00b3` : '';
    lines.push(`${AQ_DOTS[cat.level]} Air quality: ${cat.label} <span class="muted">(${scaleName} ${Math.round(value)})</span>${pm}`);
  }
  const haze = hazeNote(aq);
  if (haze) lines.push(`🌫️ ${haze}`);
  const ahead = worseningAhead(aq, scale);
  if (ahead) {
    const at = new Date(ahead.hour.time).toLocaleTimeString('en-US', { ...hourOptions(), timeZone: airport.timeZone || undefined });
    lines.push(`<span class="muted">Forecast to reach ${ahead.category.label.toLowerCase()} (${Math.round(ahead.value)}) around ${at}</span>`);
  }
  if (lines.length === 0) return;
  el.innerHTML = lines.map((l) => `<div class="aq-line">${l}</div>`).join('');
}

async function wireFacilityCard(cardEl: HTMLElement, airport: Airport) {
  wireExpandables(cardEl);
  wireFavButton(cardEl, airport);
  wireLoreButton(cardEl, airport);
  wireDestinationsList(cardEl, airport);

  // Independent, best-effort extras: each fills its own block when (and if) its data arrives.
  void fillAlerts(cardEl, airport);
  void fillPhoto(cardEl, airport);
  void fillForecast(cardEl, airport);
  void fillPireps(cardEl, airport);
  void fillAirQuality(cardEl, airport);

  const weatherEl = cardEl.querySelector('.weather-block');
  if (!weatherEl || !airport.icao) return;

  const wx = await fetchWeather(airport.icao);
  if (!weatherEl.isConnected) return; // panel was replaced by a newer search while we waited

  const daytime = isDaytime(airport.lat, airport.lon);
  weatherEl.innerHTML = weatherContentHtml(wx, airport.elevation, daytime, airport.magVarDeg);
  wireExpandables(weatherEl as HTMLElement);

  const windIsMeaningful = wx.windSpeedKt !== undefined && wx.windSpeedKt >= 3;
  const favored = windIsMeaningful ? favoredRunwayEnd(airport.runways as RunwayDetail[] | undefined, wx.windDirDeg) : null;

  const runwaysEl = cardEl.querySelector('.runways-block');
  if (runwaysEl && favored && runwaysEl.isConnected) {
    runwaysEl.innerHTML = buildRunwaysHtml(airport, favored, wx.windDirDeg, wx.windSpeedKt);
    wireExpandables(runwaysEl);
  }
  (window as any).highlightRunway?.(airport, favored ? favored.ident : null);
}

// ---------------------------------------------------------------------------
// Route-view stats helpers
// ---------------------------------------------------------------------------

function formatBlockTime(minutes: number): string {
  return `~${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function detourLabel(ratio: number): string {
  const extraPct = Math.round((ratio - 1) * 100);
  if (extraPct <= 0) return 'same as direct';
  return `+${extraPct}% vs direct`;
}

function viaPathLabel(origin: Airport, destination: Airport, option: ViaOption): string {
  const codes = [airportCode(origin), ...option.hubs.map(airportCode), airportCode(destination)];
  return codes.join(' \u2192 ');
}

function viaCityLabel(option: ViaOption): string {
  return option.hubs.map((hub) => hub.city || airportCode(hub)).join(', ');
}

function depthLabel(depth: ConnectingDepth, count: number): string {
  if (depth === 'two-stop') return `${count} two-stop`;
  if (depth === 'one-stop') return `${count} one-stop`;
  return `${count}`;
}

function viaRowHtml(origin: Airport, destination: Airport, option: ViaOption, selected: boolean, depth: ConnectingDepth): string {
  return `
    <button type="button" class="via-row via-row--${depth}${selected ? ' via-row--selected' : ''}" data-via-key="${option.key}">
      <span class="via-path">${viaPathLabel(origin, destination, option)}</span>
      <span class="via-meta">via ${viaCityLabel(option)} \u00b7 ${detourLabel(option.detourRatio)} \u00b7 ${formatDistance(option.viaMiles)} \u00b7 ${formatBlockTime(option.blockMinutes)}</span>
    </button>
  `;
}

function viaConnectionsHtml(
  origin: Airport,
  destination: Airport,
  options: ViaOption[],
  totalFound: number,
  selectedKey: string | null,
  depth: ConnectingDepth
): string {
  if (options.length === 0) {
    return `
      <div class="via-block">
        <div class="via-empty muted">No one-stop or two-stop in the connections data</div>
        <div class="via-footnote muted">Three or more stops are not searched. Based on published connections, not live schedules.</div>
      </div>
    `;
  }

  const extra = totalFound > options.length ? ` of ${totalFound}` : '';
  const rows = options
    .map((option) => viaRowHtml(origin, destination, option, option.key === selectedKey, depth))
    .join('');
  const selected = options.find((option) => option.key === selectedKey) || options[0];

  return `
    <div class="via-block via-block--${depth}">
      <div class="expandable">
        <button type="button" class="expandable-toggle is-open" data-target="via-connections">Possible connections (${depthLabel(depth, options.length)}${extra})</button>
        <div class="expandable-content" id="via-connections">
          <div class="via-list">${rows}</div>
          ${options.length > 4 ? `<button type="button" class="via-showall">Show all ${options.length} options on the map</button>` : ''}
          <div class="via-selected-stats">
            Combined via ${viaCityLabel(selected)}: ${formatDistance(selected.viaMiles)} \u00b7 ${formatBlockTime(selected.blockMinutes)}
          </div>
          <div class="via-footnote muted">In the connections data \u2014 not live schedules.${depth === 'two-stop' ? ' Three or more stops are not searched.' : ''}</div>
        </div>
      </div>
    </div>
  `;
}

function wireViaList(options: ViaOption[]) {
  const list = resultsContent.querySelector('.via-list');
  if (!list) return;

  const showAll = resultsContent.querySelector('.via-showall') as HTMLButtonElement | null;
  if (showAll) {
    showAll.onclick = () => {
      (window as any).showAllVia?.();
      showAll.remove();
    };
  }

  list.querySelectorAll('.via-row[data-via-key]').forEach((btnEl) => {
    const btn = btnEl as HTMLButtonElement;
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.onclick = () => updateViaSelection(options, btn.dataset.viaKey!);
  });
}

function updateViaSelection(options: ViaOption[], key: string) {
  resultsContent.querySelectorAll('.via-row').forEach((rowEl) => {
    const row = rowEl as HTMLButtonElement;
    row.classList.toggle('via-row--selected', row.dataset.viaKey === key);
  });

  const selected = options.find((option) => option.key === key);
  const statsEl = resultsContent.querySelector('.via-selected-stats');
  if (selected && statsEl) {
    statsEl.textContent = `Combined via ${viaCityLabel(selected)}: ${formatDistance(selected.viaMiles)} \u00b7 ${formatBlockTime(selected.blockMinutes)}`;
  }

  (window as any).highlightViaRoute?.(key);
  if (selected && routeEnds) {
    void wireRouteHazards(routePoints(routeEnds.origin, routeEnds.destination, selected));
  }
}

function bindViaSelection(options: ViaOption[]) {
  (window as any).selectViaHub = (key: string) => {
    updateViaSelection(options, key);
  };
}

function elevationChangeLabel(origin: Airport, destination: Airport): string {
  const diff = destination.elevation - origin.elevation;
  const sign = diff > 0 ? '+' : '';
  const originCode = origin.iata || origin.icao;
  const destCode = destination.iata || destination.icao;
  return `${originCode} ${origin.elevation.toLocaleString()} ft \u2192 ${destCode} ${destination.elevation.toLocaleString()} ft (${sign}${diff.toLocaleString()} ft)`;
}

function timeDifferenceLabel(origin: Airport, destination: Airport): string {
  if (!origin.timeZone || !destination.timeZone) return 'n/a';
  const originOffset = utcOffsetMinutes(origin.timeZone);
  const destOffset = utcOffsetMinutes(destination.timeZone);
  if (originOffset === null || destOffset === null) return 'n/a';

  const diffMinutes = destOffset - originOffset;
  if (diffMinutes === 0) return 'Same time zone';

  const hours = Math.abs(diffMinutes) / 60;
  const hoursLabel = Number.isInteger(hours) ? `${hours}` : hours.toFixed(1);
  const destCode = destination.iata || destination.icao;
  return `${destCode} is ${hoursLabel} hour${hours === 1 ? '' : 's'} ${diffMinutes > 0 ? 'ahead' : 'earlier'}`;
}

async function wireWindAdjustedBlockTime(origin: Airport, destination: Airport, distanceMiles: number, bearingDeg: number) {
  const valueEl = resultsContent.querySelector('.wind-adjusted-value');
  if (!valueEl) return;

  // Preferred: forecast winds at cruise level along the route. Fallback: origin surface wind.
  const cruise = await fetchCruiseWind(origin, destination, distanceMiles);
  if (!valueEl.isConnected) return;
  if (cruise) {
    const minutes = blockTimeWithHeadwind(distanceMiles, cruise.headwindKt);
    const kt = Math.round(Math.abs(cruise.headwindKt));
    const label = cruise.headwindKt <= 0 ? 'tailwind' : 'headwind';
    valueEl.textContent = `${formatBlockTime(minutes)} (est. ${kt}kt ${label} at ${cruise.levelLabel})`;
    (window as any).colorRouteByWind?.(origin, destination, cruise.samples);
    return;
  }

  if (!origin.icao) return;
  const wx = await fetchWeather(origin.icao);
  if (!valueEl.isConnected) return;

  const windIsMeaningful = wx.available && wx.windDirDeg !== undefined && wx.windSpeedKt !== undefined && wx.windSpeedKt >= 3;
  if (!windIsMeaningful) {
    const row = valueEl.closest('.stats-row');
    if (row) row.remove();
    return;
  }

  const { minutes, windComponentKt } = windAdjustedBlockTime(distanceMiles, bearingDeg, wx.windDirDeg!, wx.windSpeedKt!);
  const label = windComponentKt >= 0 ? 'tailwind' : 'headwind';
  valueEl.textContent = `${formatBlockTime(minutes)} (est. ${Math.abs(windComponentKt)}kt ${label}, surface wind only)`;
}

// ---------------------------------------------------------------------------
// Hazards along the route (AIRMET/SIGMET shapes it crosses, notable pilot reports near it)
// ---------------------------------------------------------------------------

let routeEnds: { origin: Airport; destination: Airport } | null = null;
let routeHazardGen = 0;

/** The route sampled densely as [lat, lon]: the great circle for a direct, or each leg of an itinerary. */
function routePoints(origin: Airport, destination: Airport, via?: ViaOption | null): Array<[number, number]> {
  const chain = via ? [origin, ...via.hubs, destination] : [origin, destination];
  const out: Array<[number, number]> = [];
  for (let i = 0; i < chain.length - 1; i++) {
    for (const p of slerpArc(chain[i], chain[i + 1], via ? 60 : 200)) out.push([p.lat, p.lon]);
  }
  return out;
}

/** "Volcanic ash along the route (Mt Ibu, surface to FL060). ..." */
function ashBanner(ash: Advisory[]): string {
  const names = [...new Set(ash.map((a) => a.name).filter(Boolean))].join(', ');
  const alt = ash.length === 1 ? advisoryAltitude(ash[0]) : '';
  const detail = [names, alt].filter(Boolean).join(', ');
  return `🌋 <strong>Volcanic ash along the route</strong>${detail ? ` (${detail})` : ''}. Flights route around ash clouds, so expect reroutes or delays.`;
}

async function wireRouteHazards(points: Array<[number, number]>) {
  const gen = ++routeHazardGen;
  const el = resultsContent.querySelector('.route-hazards') as HTMLElement | null;
  if (!el) return;
  if (!navigator.onLine) {
    el.innerHTML = '<span class="muted">Hazard check unavailable offline</span>';
    return;
  }
  el.innerHTML = '<span class="muted">Checking hazards along the route\u2026</span>';

  const result = await analyzeRoute(points);
  if (gen !== routeHazardGen || !el.isConnected) return;
  drawRouteHazards(result);

  if (result.advisories.length === 0 && result.pireps.length === 0 && result.cyclones.length === 0) {
    el.innerHTML = '<div class="route-hazard-ok">✅ No current AIRMETs/SIGMETs, tropical cyclones or notable pilot reports along the route</div>';
    return;
  }

  const parts: string[] = [];
  const ash = result.advisories.filter((a) => a.hazard === 'ASH');
  if (ash.length > 0) parts.push(`<div class="route-hazard-ash">${ashBanner(ash)}</div>`);
  if (result.cyclones.length > 0) {
    const rows = result.cyclones
      .map(({ storm, miles, crossesCone }) => {
        const how = crossesCone ? 'passes through its forecast cone' : `passes ${formatDistance(miles)} from its center`;
        return `<div class="route-hazard-row">${stormTitle(storm)}: the route ${how}</div>`;
      })
      .join('');
    parts.push(`<div class="route-hazard-head">🌀 Tropical cyclone${result.cyclones.length === 1 ? '' : 's'} near the route (drawn on the map)</div>${rows}`);
  }
  if (result.advisories.length > 0) {
    // Ash first: it is the one advisory flights do not fly through at any altitude.
    const ordered = [...ash, ...result.advisories.filter((a) => a.hazard !== 'ASH')];
    const rows = ordered.map((a) => `<div class="route-hazard-row">${describeAdvisory(a)}</div>`).join('');
    parts.push(`<div class="route-hazard-head">⚠️ Route passes through ${result.advisories.length} weather advisor${result.advisories.length === 1 ? 'y' : 'ies'} (outlined on the map)</div>${rows}`);
  }
  const pirepLines = result.pireps
    .map(describeRoutePirep)
    .filter((t): t is string => !!t)
    .slice(0, 5);
  if (pirepLines.length > 0) {
    const rows = pirepLines.map((t) => `<div class="route-hazard-row">${t}</div>`).join('');
    parts.push(`<div class="route-hazard-head">📣 Pilot reports near the route (${result.pireps.length}, dots on the map)</div>${rows}`);
  }
  el.innerHTML = parts.join('');
}

// ---------------------------------------------------------------------------
// Public render entry points
// ---------------------------------------------------------------------------

export function renderSingle(airport: Airport) {
  resultsContent.innerHTML = buildFacilityCard(airport);

  const cardEl = resultsContent.querySelector('.facility-card') as HTMLElement | null;
  if (cardEl) wireFacilityCard(cardEl, airport);
}

export function renderRoute(origin: Airport, destination: Airport) {
  const dist = haversineDistance(origin, destination);
  const bearing = initialBearing(origin, destination);
  const block = blockTimeMiles(dist);
  const direct = isKnownDirect(origin, destination);
  const viaResult = direct ? null : findConnectingRoutes(origin, destination);
  const selectedKey = viaResult && viaResult.options.length > 0 ? viaResult.options[0].key : null;
  const directAirlines = direct ? carrierNames(carriersFor(origin, destination), 4) : '';

  const statsHtml = `
    <div class="stats">
      <div class="stats-row"><span class="stats-label">📏 Distance</span><span class="stats-value">${formatDistance(dist)}</span></div>
      <div class="stats-row"><span class="stats-label">\u23f1️ Block time</span><span class="stats-value">${formatBlockTime(block)}</span></div>
      ${direct ? `<div class="stats-row"><span class="stats-label">🌬️ Wind-adjusted</span><span class="stats-value wind-adjusted-value">\u2026</span></div>` : ''}
      <div class="stats-row"><span class="stats-label">✅ Known direct route</span><span class="stats-value">${direct ? 'Yes' : 'No'}</span></div>
      ${directAirlines ? `<div class="stats-row"><span class="stats-label">✈️ Airlines</span><span class="stats-value" title="${carrierDataNote()}">${directAirlines}</span></div>` : ''}
      ${viaResult ? viaConnectionsHtml(origin, destination, viaResult.options, viaResult.totalFound, selectedKey, viaResult.depth) : ''}
      <div class="stats-row"><span class="stats-label">⛰️ Elevation change</span><span class="stats-value">${elevationChangeLabel(origin, destination)}</span></div>
      <div class="stats-row"><span class="stats-label">🕐 Local time difference</span><span class="stats-value">${timeDifferenceLabel(origin, destination)}</span></div>
      <div class="route-hazards"></div>
    </div>
  `;

  resultsContent.innerHTML = statsHtml + buildFacilityCard(origin) + buildFacilityCard(destination);

  const cards = resultsContent.querySelectorAll('.facility-card');
  const originCard = cards[0] as HTMLElement | undefined;
  const destCard = cards[1] as HTMLElement | undefined;
  if (originCard) wireFacilityCard(originCard, origin);
  if (destCard) wireFacilityCard(destCard, destination);

  wireExpandables(resultsContent);
  routeEnds = { origin, destination };
  const shownOption = viaResult ? viaResult.options.find((o) => o.key === selectedKey) : null;
  void wireRouteHazards(routePoints(origin, destination, shownOption));
  if (viaResult) {
    wireViaList(viaResult.options);
    bindViaSelection(viaResult.options);
  } else {
    (window as any).selectViaHub = undefined;
    wireWindAdjustedBlockTime(origin, destination, dist, bearing);
  }
}

/** List for "Airports near me": distance, direction and the current flight category. */
export function renderNearby(list: Array<{ airport: Airport; miles: number; bearingDeg: number }>, categories: Record<string, string>) {
  const rows = list
    .map(({ airport, miles, bearingDeg }) => {
      const code = airport.iata || airport.icao;
      const cat = categories[airport.icao];
      const catHtml = cat ? `<span class="muted">${categoryDot(cat)} ${cat}</span>` : '';
      return (
        `<button type="button" class="detail-row destination-row nearby-row" data-code="${code}">` +
        `<span><strong>${code}</strong> ${airport.name}<br><span class="muted">${formatDistance(miles)} ${compassPoint(bearingDeg)} ${BULLET} ${airport.city || ''}</span></span>` +
        `${catHtml}</button>`
      );
    })
    .join('');
  resultsContent.innerHTML = `<div class="facility-card"><h3>Airports near you</h3><div class="nearby-list">${rows}</div><div class="detail-footnote">Closest airports with scheduled-service codes. Your location is used once and not stored.</div></div>`;
  resultsContent.querySelectorAll('.nearby-row').forEach((el) => {
    (el as HTMLButtonElement).onclick = () => (window as any).runSearchFor?.((el as HTMLElement).dataset.code);
  });
}

export function renderError(message: string) {
  resultsContent.innerHTML = `<div class="empty-state"><p class="error-text">${message}</p></div>`;
}
