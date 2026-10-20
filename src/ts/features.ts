// Every setting the app offers, in the order the settings window shows them. The settings
// window is built from this list (settingsPanel.ts), and so is the Help panel, so a new layer
// is one entry here. Map layer inputs are wired by main.ts (which owns their storage keys);
// entries with `pref` are stored by the settings window itself and read through prefs.ts.

export type SectionId = 'map' | 'airports' | 'weather' | 'flight' | 'natural' | 'airspace' | 'live' | 'route' | 'cards' | 'units';

export interface Choice {
  value: string;
  label: string;
}

/** A sub-option of a layer (radar mode, chart kind...), shown while the layer is on. */
export interface FeatureOption {
  input: string;
  label: string;
  choices: Choice[];
}

export interface Feature {
  /** Help anchor, also used as the row's data-feature. */
  id: string;
  section: SectionId;
  label: string;
  /** One short line under the label: what it shows and where. */
  desc: string;
  /** A switch (checkbox input id), a choice of values, or a slider (shown in `unit`). */
  control:
    | { kind: 'switch'; input: string; option?: FeatureOption }
    | { kind: 'choice'; input: string; choices: Choice[] }
    | { kind: 'range'; input: string; min: number; max: number; step: number; unit: 'mi' | 'ft' | 'kt' };
  /** Stored by the settings window under zachroute:<key>, with its default ('true'/'false' for a switch). */
  pref?: { key: string; default: string };
}

export interface Section {
  id: SectionId;
  title: string;
  /** Map layer sections show how many of their switches are on, and "Turn off all layers" covers them. */
  layers: boolean;
  /** A line at the top of the section. */
  note?: string;
}

export const SECTIONS: Section[] = [
  { id: 'map', title: 'Map', layers: true },
  { id: 'airports', title: 'Airports and routes', layers: true },
  { id: 'weather', title: 'Weather', layers: true },
  { id: 'flight', title: 'Flight hazards', layers: true },
  { id: 'natural', title: 'Natural hazards', layers: true },
  { id: 'airspace', title: 'Airspace and charts', layers: true },
  { id: 'live', title: 'Live track', layers: false, note: 'The radar button in the header finds you and follows up to 5 aircraft in the air around you, refreshing every 10 seconds. It pauses after 5 minutes until you continue.' },
  { id: 'route', title: 'On a route', layers: false, note: 'What is drawn on the map along a searched route. The route card lists everything either way.' },
  { id: 'cards', title: 'Airport cards', layers: false, note: 'How cards start out. Tap a section on a card to open or fold it there.' },
  { id: 'units', title: 'Units', layers: false },
];

const sw = (input: string, option?: FeatureOption) => ({ kind: 'switch' as const, input, option });

export const FEATURES: Feature[] = [
  // Map
  {
    id: 'basemap',
    section: 'map',
    label: 'Base map',
    desc: 'Satellite imagery is a cloud-free mosaic, not live',
    control: {
      kind: 'choice',
      input: 'base-map',
      choices: [
        { value: 'dark', label: 'Dark' },
        { value: 'light', label: 'Light' },
        { value: 'satellite', label: 'Satellite' },
      ],
    },
  },
  { id: 'terrain', section: 'map', label: 'Terrain shading', desc: 'Shaded relief, with high ground tinted', control: sw('terrain-toggle') },
  { id: 'daynight', section: 'map', label: 'Day and night', desc: 'Shades where it is night right now', control: sw('daynight-toggle') },

  // Airports and routes
  { id: 'connections', section: 'airports', label: 'Show connections', desc: 'Lines to every nonstop destination of a searched airport', control: sw('connections-toggle') },
  { id: 'large', section: 'airports', label: 'Large hubs', desc: 'Major airports worldwide', control: sw('large-toggle') },
  { id: 'medium', section: 'airports', label: 'Medium airports', desc: 'Mid-size airports worldwide', control: sw('medium-toggle') },
  { id: 'regional', section: 'airports', label: 'Regional airports', desc: 'Smaller airports with scheduled service', control: sw('regional-toggle') },
  { id: 'approach', section: 'airports', label: 'Approach distance ticks', desc: 'Marks every 2 nm out to 10 nm on the runway in use', control: sw('approach-toggle') },

  // Weather
  {
    id: 'radar',
    section: 'weather',
    label: 'Radar',
    desc: 'US radar every 5 min, elsewhere every 10 min',
    control: sw('radar-toggle', {
      input: 'radar-mode',
      label: 'Show',
      choices: [
        { value: 'precip', label: 'Precipitation' },
        { value: 'tops', label: 'Storm tops (US)' },
      ],
    }),
  },
  { id: 'satellite', section: 'weather', label: 'Satellite clouds', desc: 'Infrared, with cold storm tops colored by severity', control: sw('satellite-toggle') },
  {
    id: 'wxstations',
    section: 'weather',
    label: 'Weather stations',
    desc: 'Current conditions at airports',
    control: sw('wxstations-toggle', {
      input: 'wxstations-mode',
      label: 'Show',
      choices: [
        { value: 'wind', label: 'Wind' },
        { value: 'temp', label: 'Temperature' },
      ],
    }),
  },
  { id: 'freezing', section: 'weather', label: 'Freezing level', desc: 'Height where it drops below freezing, hourly', control: sw('freezing-toggle') },
  { id: 'aerosol', section: 'weather', label: 'Dust and smoke', desc: 'Satellite aerosol index, once a day', control: sw('aerosol-toggle') },

  // Flight hazards
  { id: 'hazards', section: 'flight', label: 'AIRMETs, SIGMETs and CWAs', desc: 'Turbulence, icing, storm and ash advisories worldwide', control: sw('hazards-toggle') },
  { id: 'pireps', section: 'flight', label: 'Pilot reports', desc: 'Turbulence and icing reported in the last 3 hours', control: sw('pireps-toggle') },
  {
    id: 'tcf',
    section: 'flight',
    label: 'Thunderstorm forecast (US)',
    desc: 'Where storms are expected, a few hours ahead',
    control: sw('tcf-toggle', {
      input: 'tcf-step',
      label: 'Ahead',
      choices: [
        { value: '0', label: '4 h' },
        { value: '1', label: '6 h' },
        { value: '2', label: '8 h' },
      ],
    }),
  },
  {
    id: 'spc',
    section: 'flight',
    label: 'Severe storm outlook (US)',
    desc: 'Risk of severe storms from the Storm Prediction Center',
    control: sw('spc-toggle', {
      input: 'spc-day',
      label: 'Day',
      choices: [
        { value: '1', label: 'Today' },
        { value: '2', label: 'Tomorrow' },
      ],
    }),
  },
  { id: 'cyclones', section: 'flight', label: 'Tropical cyclones', desc: 'Storm positions, tracks and forecast cones worldwide', control: sw('cyclones-toggle') },

  // Natural hazards
  { id: 'geohazards', section: 'natural', label: 'Earthquakes and volcanoes', desc: 'Quakes of M4.5 and up worldwide, US volcano alerts', control: sw('geohazards-toggle') },
  { id: 'fires', section: 'natural', label: 'Fires', desc: 'Satellite fire detections from the last 24 hours', control: sw('fires-toggle') },
  { id: 'aurora', section: 'natural', label: 'Space weather and aurora', desc: 'Aurora forecast and NOAA storm scales', control: sw('aurora-toggle') },

  // Airspace and charts
  { id: 'airspace', section: 'airspace', label: 'Airspace', desc: 'Controlled and special use airspace', control: sw('airspace-toggle') },
  { id: 'tfr', section: 'airspace', label: 'Flight restrictions (US)', desc: 'Temporary flight restrictions (TFRs) from the FAA', control: sw('tfr-toggle') },
  {
    id: 'charts',
    section: 'airspace',
    label: 'FAA charts (US)',
    desc: 'Aeronautical charts, shown when zoomed in',
    control: sw('charts-toggle', {
      input: 'charts-kind',
      label: 'Chart',
      choices: [
        { value: 'vfr', label: 'VFR sectional' },
        { value: 'ifr', label: 'IFR low enroute' },
      ],
    }),
  },

  // Live track (the header button turns it on and off)
  {
    id: 'live-radius',
    section: 'live',
    label: 'Radius',
    desc: 'How far around you to look. To move the circle, turn Live track off and on',
    control: { kind: 'range', input: 'pref-live-radius-mi', min: 1, max: 15, step: 1, unit: 'mi' },
    pref: { key: 'live-radius-mi', default: '5' },
  },
  {
    id: 'live-min-height',
    section: 'live',
    label: 'Lowest height',
    desc: 'Leave out aircraft lower than this above the ground',
    control: { kind: 'range', input: 'pref-live-min-ft', min: 0, max: 3000, step: 100, unit: 'ft' },
    pref: { key: 'live-min-ft', default: '500' },
  },
  {
    id: 'live-min-speed',
    section: 'live',
    label: 'Lowest speed',
    desc: 'Leave out aircraft slower than this, such as ones taxiing',
    control: { kind: 'range', input: 'pref-live-min-kt', min: 0, max: 200, step: 10, unit: 'kt' },
    pref: { key: 'live-min-kt', default: '60' },
  },

  // On a route
  {
    id: 'route-focus',
    section: 'route',
    label: 'Focus on the route',
    desc: 'Hide the full hazard, pilot report, cyclone and TFR layers while a route is shown',
    control: sw('pref-route-focus'),
    pref: { key: 'route-focus', default: 'true' },
  },
  { id: 'route-advisories', section: 'route', label: 'Advisories', desc: 'AIRMETs, SIGMETs and CWAs the route passes through', control: sw('pref-route-advisories'), pref: { key: 'route-advisories', default: 'true' } },
  { id: 'route-pireps', section: 'route', label: 'Pilot reports', desc: 'Notable reports within 50 mi of the route', control: sw('pref-route-pireps'), pref: { key: 'route-pireps', default: 'true' } },
  { id: 'route-cyclones', section: 'route', label: 'Tropical cyclones', desc: 'Storms near the route or whose cone it crosses', control: sw('pref-route-cyclones'), pref: { key: 'route-cyclones', default: 'true' } },
  { id: 'route-tfrs', section: 'route', label: 'Flight restrictions', desc: 'US TFRs the route crosses', control: sw('pref-route-tfrs'), pref: { key: 'route-tfrs', default: 'true' } },

  // Airport cards
  {
    id: 'card-alerts',
    section: 'cards',
    label: 'Alerts',
    desc: 'Auto opens them when one is Severe or Extreme; also the route hazard list',
    control: {
      kind: 'choice',
      input: 'pref-card-alerts',
      choices: [
        { value: 'auto', label: 'Auto' },
        { value: 'open', label: 'Open' },
        { value: 'folded', label: 'Folded' },
      ],
    },
    pref: { key: 'card-alerts', default: 'auto' },
  },
  { id: 'card-photo', section: 'cards', label: 'Airport photo', desc: 'The Wikipedia photo near the top of the card', control: sw('pref-card-photo'), pref: { key: 'card-photo', default: 'true' } },
  ...(
    [
      ['weather-more', 'Weather details', 'Ceiling, pressure, density altitude and freezing level'],
      ['forecast', 'Forecast periods', 'Each period of the forecast, under its summary'],
      ['pireps', 'Pilot reports', 'Reports near the airport'],
      ['afd', 'Forecaster notes', 'The National Weather Service aviation discussion (US)'],
      ['runways', 'Runways', 'Lengths, surfaces and the end the wind favors'],
      ['frequencies', 'Frequencies', 'Tower, ground, ATIS and more'],
      ['navaids', 'Navaids', 'Nearby radio navigation aids'],
      ['destinations', 'Destinations', 'Every nonstop destination'],
    ] as const
  ).map(
    ([key, label, desc]): Feature => ({
      id: `card-open-${key}`,
      section: 'cards',
      label: `${label} start open`,
      desc,
      control: sw(`pref-card-open-${key}`),
      pref: { key: `card-open-${key}`, default: 'false' },
    })
  ),

  // Units
  {
    id: 'distance',
    section: 'units',
    label: 'Distance',
    desc: 'Route lengths and distances',
    control: {
      kind: 'choice',
      input: 'distance-unit',
      choices: [
        { value: 'mi', label: 'mi' },
        { value: 'km', label: 'km' },
        { value: 'nm', label: 'nm' },
      ],
    },
  },
  {
    id: 'clock',
    section: 'units',
    label: 'Clock',
    desc: 'Local times on cards',
    control: {
      kind: 'choice',
      input: 'clock-format',
      choices: [
        { value: '12h', label: '12-hour' },
        { value: '24h', label: '24-hour' },
      ],
    },
  },
  {
    id: 'weather-units',
    section: 'units',
    label: 'Weather',
    desc: 'Temperature, pressure and visibility',
    control: {
      kind: 'choice',
      input: 'weather-units',
      choices: [
        { value: 'us', label: '\u00b0F, inHg' },
        { value: 'metric', label: '\u00b0C, hPa' },
      ],
    },
  },
];

/** Stored settings, cleared by "Reset all settings". Favorites, recent searches and the sheet stay. */
export function isSettingKey(key: string): boolean {
  if (!key.startsWith('zachroute:')) return false;
  const name = key.slice('zachroute:'.length);
  return (
    name.startsWith('show-') ||
    name.startsWith('route-') ||
    name.startsWith('live-') ||
    name.startsWith('card-') ||
    ['base-map', 'tcf-step', 'spc-day', 'charts-kind', 'radar-mode', 'wxstations-mode', 'distance-unit', 'clock', 'weather-units', 'legend-open', 'settings-open'].includes(name)
  );
}
