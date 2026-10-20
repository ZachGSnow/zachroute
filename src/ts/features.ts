// Every setting the app offers, in the order the settings window shows them. The settings
// window is built from this list (settingsPanel.ts), and so is the Help panel, so a new layer
// is one entry here. Input ids are the ones main.ts wires up; storage keys belong to main.ts.

export type SectionId = 'map' | 'airports' | 'weather' | 'flight' | 'natural' | 'airspace' | 'units';

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
  /** A switch (checkbox input id) or, for units, a choice of values. */
  control: { kind: 'switch'; input: string; option?: FeatureOption } | { kind: 'choice'; input: string; choices: Choice[] };
}

export interface Section {
  id: SectionId;
  title: string;
  /** Layer sections show how many of their switches are on. */
  counts: boolean;
}

export const SECTIONS: Section[] = [
  { id: 'map', title: 'Map', counts: true },
  { id: 'airports', title: 'Airports and routes', counts: true },
  { id: 'weather', title: 'Weather', counts: true },
  { id: 'flight', title: 'Flight hazards', counts: true },
  { id: 'natural', title: 'Natural hazards', counts: true },
  { id: 'airspace', title: 'Airspace and charts', counts: true },
  { id: 'units', title: 'Units', counts: false },
];

const sw = (input: string, option?: FeatureOption) => ({ kind: 'switch' as const, input, option });

export const FEATURES: Feature[] = [
  // Map
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
    ['tcf-step', 'spc-day', 'charts-kind', 'radar-mode', 'wxstations-mode', 'distance-unit', 'clock', 'weather-units', 'legend-open', 'settings-open'].includes(name)
  );
}
