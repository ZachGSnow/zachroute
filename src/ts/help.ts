// The Help panel's content: a few topics on using the app, then one entry per setting, in the
// settings window's order (features.ts), with the colors the map layers draw with (legends.ts).
// Pure (no DOM), so tests can check that every setting has an entry.

import { FEATURES, SECTIONS, type Feature } from './features';
import { legendRowHtml, type LegendSpec } from './legend';
import {
  aerosolLegend,
  airspaceLegend,
  auroraLegend,
  cycloneLegend,
  fireLegend,
  freezingLevelLegend,
  geohazardsLegend,
  hazardLegend,
  pirepLegend,
  radarLegend,
  routeWindLegend,
  satelliteLegend,
  spcLegend,
  stationTempLegend,
  stationWindLegend,
  stormTopsLegend,
  tcfLegend,
  terrainLegend,
  tfrLegend,
} from './legends';
import { severityLegendItems } from './severity';

export interface HelpEntry {
  /** What it shows and how to read it. */
  about: string;
  coverage?: string;
  updates?: string;
  source?: string;
  legends?: () => LegendSpec[];
}

const US = 'United States';
const WORLD = 'Worldwide';

/** One entry for each setting, keyed by feature id. */
export const HELP: Record<string, HelpEntry> = {
  basemap: {
    about: 'Dark and Light are street maps. Satellite is a cloud-free picture of the ground stitched from a year of Sentinel-2 images, with place names on top: it is not live, so weather never shows in it.',
    coverage: WORLD,
    updates: 'Satellite: a new mosaic each year',
    source: 'Stadia Maps (OpenStreetMap data); EOxCloudless 2025 by EOX',
  },
  terrain: {
    about: 'Shaded relief lit from the northwest, so hills and mountains stand out, with high ground tinted.',
    coverage: WORLD,
    updates: 'Static',
    source: 'AWS Open Data terrain tiles (Mapzen, from SRTM, ETOPO1, USGS and others)',
    legends: () => [terrainLegend()],
  },
  daynight: {
    about: 'Shades the part of the world where it is night right now, from the position of the sun.',
    coverage: WORLD,
    updates: 'Follows the clock',
    source: 'Worked out in the app',
  },
  connections: {
    about: 'Draws a line from a searched airport to each of its nonstop destinations. Tap a destination to see that route.',
    coverage: 'US routes current; routes between two foreign airports date from 2017',
    updates: 'Monthly for US routes, as of the last release',
    source: 'US DOT (on-time data and T-100), OpenFlights',
  },
  large: { about: 'Dots for the major hub airports. Tap one to open its card.', coverage: WORLD, source: 'OurAirports' },
  medium: { about: 'Dots for mid-size airports. Tap one to open its card.', coverage: WORLD, source: 'OurAirports' },
  regional: { about: 'Dots for smaller airports with scheduled service. Tap one to open its card.', coverage: WORLD, source: 'OurAirports' },
  approach: {
    about: 'On a searched airport, marks every 2 nautical miles out to 10 on the final approach of the runway the wind favors, with the height above the runway on a normal 3 degree glide path.',
    coverage: WORLD,
    source: 'OurAirports runway ends; wind from the latest METAR',
  },
  radar: {
    about: 'Rain, snow and storms. Plain rain is soft blue; stronger echoes take the severity colors, from Light (30 dBZ) to Extreme (50 dBZ and up). Storm tops (US only) shows how high the storms reach instead, from 20,000 ft to above 50,000 ft.',
    coverage: 'US radar network; RainViewer elsewhere (up to zoom 7)',
    updates: 'Every 5 minutes in the US, every 10 elsewhere',
    source: 'NEXRAD via the Iowa Environmental Mesonet; RainViewer',
    legends: () => [radarLegend(), stormTopsLegend()],
  },
  satellite: {
    about: 'Infrared cloud pictures. The colder a cloud top, the higher it reaches; the coldest tops, where storms are, take the severity colors.',
    coverage: 'Americas, Pacific and Asia from GOES and Himawari; Europe, Africa, the Middle East and India from Meteosat',
    updates: 'Every 10 minutes (Meteosat hourly)',
    source: 'NASA GIBS (NOAA GOES, JMA Himawari); EUMETSAT',
    legends: () => [satelliteLegend()],
  },
  wxstations: {
    about: 'Current conditions at airports that report weather. Wind shows as arrows, with a colored ring when conditions are below VFR; temperature shows as colored dots, marked where it is at or below freezing and where fog is likely.',
    coverage: WORLD,
    updates: 'Hourly reports, plus specials when conditions change',
    source: 'Aviation Weather Center (METARs)',
    legends: () => [stationWindLegend(), stationTempLegend()],
  },
  freezing: {
    about: 'The height where the air drops below freezing, from the forecast model. Low freezing levels, where icing reaches down near the ground, are shaded darkest. Shows from zoom 3.',
    coverage: WORLD,
    updates: 'Hourly model values',
    source: 'Open-Meteo',
    legends: () => [freezingLevelLegend()],
  },
  aerosol: {
    about: 'Dust and smoke in the air from a satellite aerosol index: yellow is light haze, red is thick smoke or dust.',
    coverage: WORLD,
    updates: 'One pass a day, around 13:30 local time',
    source: 'NASA GIBS (OMPS on NOAA-20)',
    legends: () => [aerosolLegend()],
  },
  hazards: {
    about: 'Areas where forecasters warn pilots of turbulence, icing, low cloud, mountains in cloud, strong surface wind and wind shear (US G-AIRMETs), and of thunderstorms, severe turbulence and icing, volcanic ash and tropical cyclones (SIGMETs, worldwide), plus US center weather advisories. Colored by severity; tap a shape for details.',
    coverage: 'SIGMETs worldwide; G-AIRMETs and center weather advisories in the US',
    updates: 'G-AIRMETs every 6 hours; SIGMETs and advisories as issued',
    source: 'Aviation Weather Center',
    legends: () => [hazardLegend()],
  },
  pireps: {
    about: 'What pilots reported in the last 3 hours: turbulence and icing, colored by how bad it was. Zoom in to see them.',
    coverage: WORLD,
    updates: 'As pilots file them',
    source: 'Aviation Weather Center',
    legends: () => [pirepLegend()],
  },
  tcf: {
    about: 'Where thunderstorms are forecast a few hours ahead (choose 4, 6 or 8 hours), colored by how much of the area they cover, from sparse to solid lines.',
    coverage: US,
    updates: 'Every 2 hours',
    source: 'Aviation Weather Center (TFM Convective Forecast)',
    legends: () => [tcfLegend()],
  },
  spc: {
    about: 'The risk of severe thunderstorms (large hail, damaging wind, tornadoes) today or tomorrow, from marginal to high.',
    coverage: US,
    updates: 'Today five times a day, tomorrow twice',
    source: 'NOAA Storm Prediction Center',
    legends: () => [spcLegend()],
  },
  cyclones: {
    about: 'Hurricanes, typhoons and cyclones: where each is now, its track, and the cone it is forecast to stay within.',
    coverage: WORLD,
    updates: 'Advisories every 6 hours',
    source: 'National Hurricane Center (Atlantic and East and Central Pacific); GDACS elsewhere',
    legends: () => [cycloneLegend()],
  },
  geohazards: {
    about: 'Earthquakes of magnitude 4.5 and up from the last day, sized by magnitude, and US volcanoes whose aviation color code is raised. Ash clouds elsewhere show as SIGMETs.',
    coverage: 'Earthquakes worldwide; volcanoes in the US',
    updates: 'Within minutes of a quake; volcano notices as issued',
    source: 'USGS',
    legends: () => [geohazardsLegend()],
  },
  fires: {
    about: 'Fires and other heat sources seen from orbit in the last 24 hours, sized by intensity.',
    coverage: WORLD,
    updates: 'Several satellite passes a day',
    source: 'NASA FIRMS (VIIRS)',
    legends: () => [fireLegend()],
  },
  aurora: {
    about: 'Where the aurora may be seen over the next hour or so, and NOAA\'s radio blackout, radiation storm and geomagnetic storm scales. Under the aurora, HF radio and GPS degrade during storms.',
    coverage: 'High latitudes',
    updates: 'Every few minutes',
    source: 'NOAA Space Weather Prediction Center',
    legends: () => [auroraLegend()],
  },
  airspace: {
    about: 'Controlled airspace around busy airports and special use airspace (prohibited, restricted, military, warning and alert areas). Shows from zoom 7. Not for navigation.',
    coverage: 'US from the FAA; elsewhere from openAIP',
    updates: 'FAA every 56 days; openAIP as of the last release',
    source: 'FAA; openAIP',
    legends: () => [airspaceLegend()],
  },
  tfr: {
    about: 'Temporary flight restrictions, colored by type. Most reach only a few thousand feet, so they matter near airports rather than at cruise.',
    coverage: US,
    updates: 'As issued',
    source: 'FAA',
    legends: () => [tfrLegend()],
  },
  charts: {
    about: 'The aeronautical charts pilots use: VFR sectionals or IFR low enroute charts. Shows from zoom 8 to 12.',
    coverage: US,
    updates: 'Charts every 56 days; the tile service lags',
    source: 'FAA Aeronautical Information Services',
  },
  'live-radius': {
    about: 'How far around you Live track looks, 1 to 15 miles. The circle is drawn where you were when you turned Live track on; to move it, turn Live track off and on again.',
  },
  'live-min-height': { about: 'Aircraft lower than this above the ground at your spot are left out, so planes on runways and in the pattern do not crowd the list. Aircraft reported on the ground are always left out.' },
  'live-min-speed': { about: 'Aircraft slower than this are left out, such as ones taxiing or hovering.' },
  'route-focus': {
    about: 'While a route is shown, hides the full advisory, pilot report, cyclone and TFR layers so only what lies along the route is drawn. Clearing the route brings them back.',
  },
  'route-advisories': { about: 'Outlines the AIRMETs, SIGMETs and center weather advisories the route passes through. Volcanic ash is always drawn.' },
  'route-pireps': { about: 'Dots for notable pilot reports within 50 miles of the route.' },
  'route-cyclones': { about: 'Draws storms the route passes within 150 miles of, or whose forecast cone it crosses.' },
  'route-tfrs': { about: 'Outlines the US flight restrictions the route crosses.' },
  'card-alerts': { about: 'How the alerts at the top of a card start out, and the hazard list on a route. Auto opens them only when one is Severe or Extreme; otherwise they fold behind one line with their count and worst grade.' },
  'card-photo': { about: 'Shows the airport\'s Wikipedia photo near the top of its card.' },
  distance: { about: 'Miles, kilometers or nautical miles for route lengths and distances.' },
  clock: { about: 'A 12 or 24-hour clock for local times.' },
  'weather-units': { about: 'US units (\u00b0F, inHg, miles) or metric (\u00b0C, hPa, km). Wind stays in knots and heights in feet, as aviation uses worldwide.' },
};

// "Start open" settings for folding card sections share one explanation.
for (const f of FEATURES) {
  if (f.id.startsWith('card-open-')) HELP[f.id] = { about: `${f.desc}. When on, this section starts open on every card; tap its header on a card to open or fold it there.` };
}

/** Topics shown before the settings entries. */
export const TOPICS: Array<{ id: string; title: string; html: string }> = [
  {
    id: 'start',
    title: 'Getting started',
    html: `<p>Search for an airport by code (<code>ORD</code>, <code>KORD</code>), city or name, or for a route with two airports (<code>ORD DEN</code>, <code>chicago to denver</code>). The target button lists airports near you.</p>
<p>Every search has its own link: use Share, or copy the address. Install ZachRoute from your browser's menu to use it like an app; airport details keep working offline after the first visit.</p>
<p>The gear opens Settings, where map layers are switched on and off; Help is at the bottom of Settings, next to the version. The radar button turns Live track on and off. The \u24d8 next to a setting opens its entry here.</p>`,
  },
  {
    id: 'airport-card',
    title: 'The airport card',
    html: `<p>From the top: alerts (delays, weather warnings, ash, volcanoes, storms and flight restrictions), the photo, current conditions in plain English, air quality, nearby fires, passenger traffic, local time, the forecast, pilot reports, the forecaster's notes, then runways (the one the wind favors is marked), frequencies, navaids, destinations and history.</p>
<p>Sections with an arrow open and fold. Items with a target mark <span class="help-target">\u2316</span> can be tapped to see them on the map; "Back to airport" returns to the earlier view.</p>`,
  },
  {
    id: 'route-card',
    title: 'The route card',
    html: `<p>Distance, flight time and the time adjusted for forecast winds, the freezing level, a terrain profile for nonstop routes, airlines, traffic, connections when there is no nonstop, and hazards along the way.</p>
<p>The route line is colored by the forecast headwind or tailwind at cruise. It is the great circle between the airports, not an air traffic control routing.</p>
<p>Tap a hazard row to see it on the map with the route still drawn, then "Back to route".</p>`,
  },
  {
    id: 'live',
    title: 'Live track',
    html: `<p>The radar button in the header shows aircraft in the air around you. It finds your location once, draws a circle (1 to 15 miles, set in Settings, Live track) and follows up to 5 aircraft inside it, the closest first, refreshing every 10 seconds. Aircraft on the ground, or below the height and speed you set, are left out.</p>
<p>Each aircraft shows its direction, altitude, speed, type and, when it can be worked out, where it is flying to. Tap one in the list to find it on the map. After 5 minutes Live track pauses until you tap Continue, to keep the data source's load small; the button turns it off.</p>
<p>Your position is rounded to about 1 km before it is sent to adsb.lol, a community network of receivers (data under the ODbL 1.0 license). Coverage depends on nearby receivers, and not every aircraft broadcasts its position.</p>`,
  },
  {
    id: 'severity',
    title: 'Severity colors',
    html: `<p>Hazards across the app share one scale, so the same color means the same thing on every layer: Light, Moderate, Severe and Extreme. Rain on radar is blue.</p>`,
  },
  {
    id: 'limits',
    title: 'Sources and limits',
    html: `<p>Every source and its license is listed in About ZachRoute, at the bottom of Settings. A card loads its data when you search and does not refresh while open; search again for newer data.</p>
<p><strong>For information only. Not for navigation or flight planning.</strong> Always use official aviation sources.</p>`,
  },
];

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function entryHtml(f: Feature, e: HelpEntry): string {
  const facts = [
    e.coverage && `<dt>Where</dt><dd>${esc(e.coverage)}</dd>`,
    e.updates && `<dt>Updates</dt><dd>${esc(e.updates)}</dd>`,
    e.source && `<dt>Source</dt><dd>${esc(e.source)}</dd>`,
  ]
    .filter(Boolean)
    .join('');
  const legends = e.legends ? `<div class="help-legends">${e.legends().map(legendRowHtml).join('')}</div>` : '';
  return `<article class="help-entry" id="help-${f.id}" data-help-entry="${f.id}">
    <h4>${esc(f.label)}</h4>
    <p>${esc(e.about)}</p>${facts ? `<dl class="help-facts">${facts}</dl>` : ''}${legends}
  </article>`;
}

/** The whole Help panel body. */
export function helpHtml(): string {
  const topics = TOPICS.map((t) => {
    const scale = t.id === 'severity' ? `<div class="help-legends">${legendRowHtml({ kind: 'items', title: 'Severity', items: severityLegendItems() })}${legendRowHtml(routeWindLegend(0))}</div>` : '';
    return `<article class="help-entry" id="help-${t.id}" data-help-entry="${t.id}"><h4>${t.title}</h4>${t.html}${scale}</article>`;
  }).join('');
  const sections = SECTIONS.map((s) => {
    const entries = FEATURES.filter((f) => f.section === s.id && HELP[f.id])
      .map((f) => entryHtml(f, HELP[f.id]))
      .join('');
    return entries ? `<section class="help-section"><h3>${s.title}</h3>${entries}</section>` : '';
  }).join('');
  return `<section class="help-section"><h3>Using ZachRoute</h3>${topics}</section>${sections}<p class="help-empty muted" hidden>Nothing matches.</p>`;
}
