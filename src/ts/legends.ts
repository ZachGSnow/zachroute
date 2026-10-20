// Legend contents for each map layer, built from the colors the layers draw with so the two
// cannot drift apart. Pure (no Leaflet, no DOM); legend.ts shows them.

import type { LegendSpec } from './legend';
import { tempColor } from './stationTemp';
import { freezingColor } from './freezingLayer';
import { getWeatherUnits, type WeatherUnits } from './units';
import { severityLegendItems } from './severity';

/** Flight category colors, the usual aviation convention. */
export const FLIGHT_CATEGORY_COLOR: Record<string, string> = {
  VFR: '#4ade80',
  MVFR: '#38bdf8',
  IFR: '#f87171',
  LIFR: '#e879f9',
};

/** Route line color for the headwind (+) or tailwind (-) component, knots. */
export function windColor(headwindKt: number): string {
  const t = Math.max(-1, Math.min(1, headwindKt / 30)); // +1 strong headwind, -1 strong tailwind
  const base = [226, 232, 240]; // light gray = little or no wind; distinct from the plain cyan route
  const target = t > 0 ? [248, 113, 113] : [74, 222, 128];
  const k = Math.abs(t);
  const rgb = base.map((c, i) => Math.round(c + (target[i] - c) * k));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

const DEG = '\u00b0';

export function routeWindLegend(avgHeadwindKt: number): LegendSpec {
  return {
    kind: 'gradient',
    title: 'Route: cruise winds',
    colors: [windColor(30), windColor(0), windColor(-30)],
    labels: ['Headwind 30kt+', 'calm', 'Tailwind 30kt+'],
    note: `Average ${Math.round(Math.abs(avgHeadwindKt))}kt ${avgHeadwindKt >= 0 ? 'headwind' : 'tailwind'}`,
  };
}

export function stationWindLegend(): LegendSpec {
  return {
    kind: 'items',
    title: 'Weather stations: wind',
    items: [
      { color: FLIGHT_CATEGORY_COLOR.MVFR, label: 'MVFR', mark: 'ring' },
      { color: FLIGHT_CATEGORY_COLOR.IFR, label: 'IFR', mark: 'ring' },
      { color: FLIGHT_CATEGORY_COLOR.LIFR, label: 'LIFR', mark: 'ring' },
      { color: '#cbd5e1', label: 'arrow: where the wind blows, longer is stronger', mark: 'glyph', glyph: '\u2191' },
      { color: '#fdba74', label: 'gusts', mark: 'glyph', glyph: 'G25' },
    ],
    note: 'No ring: good flying conditions (VFR)',
  };
}

const cToF = (c: number) => (c * 9) / 5 + 32;

export function stationTempLegend(units: WeatherUnits = getWeatherUnits()): LegendSpec {
  const stops = [-30, -15, 0, 10, 20, 30, 40];
  const shown = [-30, 0, 20, 40];
  const label = (c: number) => `${Math.round(units === 'metric' ? c : cToF(c))}${DEG}${units === 'metric' ? 'C' : 'F'}`;
  return {
    kind: 'gradient',
    title: 'Weather stations: temperature',
    colors: stops.map(tempColor),
    labels: shown.map(label),
    items: [
      { color: '#e0f2fe', label: 'at or below freezing', mark: 'glyph', glyph: '\u2744' },
      { color: '#cbd5e1', label: 'temperature near dewpoint: fog risk', mark: 'glyph', glyph: 'fog' },
    ],
  };
}

const rgba = (c: number[]) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.max(c[3], 0.35)})`;

export function freezingLevelLegend(): LegendSpec {
  return {
    kind: 'gradient',
    title: 'Freezing level (thousands of ft)',
    colors: [0, 3000, 6000, 10000, 14000].map((ft) => rgba(freezingColor(ft))),
    labels: ['0', '3', '6', '10', '14+'],
    note: 'Low (dark blue): any cloud near the ground can ice',
  };
}

/**
 * Cloud-top colors of the satellite layer, from NASA's band 13 colormap, with the temperatures
 * they stand for (C). The coldest cores, which NASA draws in gray, are recolored magenta.
 */
const CLOUD_TOPS: Array<[string, number]> = [
  ['#ffffff', -15],
  ['#00cce3', -25],
  ['#1aff00', -42],
  ['#ffe600', -52],
  ['#e60000', -62],
  ['#d946ef', -75],
];

/**
 * Labeled by storm strength rather than temperature: the colors run from mild to very cold tops,
 * and in degrees the red end read as "hot". The temperatures go in the note.
 */
export function satelliteLegend(units: WeatherUnits = getWeatherUnits()): LegendSpec {
  const t = (c: number) => `${Math.round(units === 'metric' ? c : cToF(c))}${DEG}${units === 'metric' ? 'C' : 'F'}`;
  return {
    kind: 'gradient',
    title: 'Satellite clouds: storm strength',
    colors: CLOUD_TOPS.map(([c]) => c),
    labels: ['cloud', 'tall', 'strong', 'very strong', 'extreme'],
    note: `Measured from cloud-top temperature: the colder the top, the higher and stronger the storm (about ${t(-40)} to ${t(-75)} and colder)`,
  };
}

/** NASA's OMPS aerosol index colors (GIBS colormap) at 1, 2, 3, 4 and 5; below about 1 is not drawn. */
export const AEROSOL_LEGEND_COLORS = ['rgb(230, 230, 77)', 'rgb(234, 232, 0)', 'rgb(228, 115, 0)', 'rgb(225, 9, 0)', 'rgb(170, 0, 29)'];

export function aerosolLegend(): LegendSpec {
  return {
    kind: 'gradient',
    title: 'Dust and smoke (aerosol index)',
    colors: AEROSOL_LEGEND_COLORS,
    labels: ['1 haze', '2', '3 thick', '4+ very thick'],
    note: 'Latest daily satellite pass',
  };
}

export function pirepLegend(): LegendSpec {
  return {
    kind: 'items',
    title: 'Pilot reports',
    items: [
      ...severityLegendItems(),
      { color: '#cbd5e1', label: 'turbulence', mark: 'diamond' },
      { color: '#cbd5e1', label: 'icing', mark: 'dot' },
      { color: '#cbd5e1', label: 'both', mark: 'square' },
      { color: '#94a3b8', label: 'low visibility', mark: 'dot' },
    ],
    note: 'Color is how bad it was; shape is what the pilot reported',
  };
}

export function fireLegend(): LegendSpec {
  const [light, moderate, severe, extreme] = severityLegendItems();
  return {
    kind: 'items',
    title: 'Fires and heat (fire radiative power)',
    items: [
      { ...light, label: 'Light, under 30 MW' },
      { ...moderate, label: 'Moderate, 30-100 MW' },
      { ...severe, label: 'Severe, 100-500 MW' },
      { ...extreme, label: 'Extreme, 500 MW+' },
    ],
    note: 'Satellite detections in the last 24 hours',
  };
}

/** Glyph drawn in the middle of each advisory shape for its hazard. */
export const HAZARD_GLYPH: Record<string, string> = {
  CONVECTIVE: '\u26a1',
  TURB: '\u2248',
  ICE: '\u2744',
  IFR: '\u2601',
  'MTN OBSCN': '\u25b2',
  ASH: '\u{1f30b}',
  TC: '\u{1f300}',
  PCPN: '\u2602',
  'SFC WND': '\u219d',
  LLWS: '\u21af',
};

export function hazardLegend(): LegendSpec {
  return {
    kind: 'items',
    title: 'Weather hazards (AIRMET, SIGMET, CWA)',
    items: [
      ...severityLegendItems([1, 2, 3, 4], 'line'),
      { color: '#e2e8f0', label: 'thunderstorms', mark: 'glyph', glyph: HAZARD_GLYPH.CONVECTIVE },
      { color: '#e2e8f0', label: 'turbulence', mark: 'glyph', glyph: HAZARD_GLYPH.TURB },
      { color: '#e2e8f0', label: 'icing', mark: 'glyph', glyph: HAZARD_GLYPH.ICE },
      { color: '#e2e8f0', label: 'low cloud', mark: 'glyph', glyph: HAZARD_GLYPH.IFR },
      { color: '#e2e8f0', label: 'volcanic ash', mark: 'glyph', glyph: HAZARD_GLYPH.ASH },
      { color: '#e2e8f0', label: 'mountains in cloud', mark: 'glyph', glyph: HAZARD_GLYPH['MTN OBSCN'] },
      { color: '#e2e8f0', label: 'strong surface wind', mark: 'glyph', glyph: HAZARD_GLYPH['SFC WND'] },
      { color: '#e2e8f0', label: 'low-level wind shear', mark: 'glyph', glyph: HAZARD_GLYPH.LLWS },
    ],
    note: 'Dashed: AIRMET (moderate, forecast area). Solid: SIGMET or center weather advisory',
  };
}

/** Radar on the ladder; rain under 30 dBZ in soft blue (radarTiles.ts RAIN_RGBA). */
export function radarLegend(): LegendSpec {
  const [light, moderate, severe, extreme] = severityLegendItems([1, 2, 3, 4], 'dot');
  return {
    kind: 'items',
    title: 'Radar',
    items: [
      { color: 'rgb(96, 165, 250)', label: 'rain (20-30 dBZ)', mark: 'dot' },
      { ...light, label: 'Light: 30-40 dBZ' },
      { ...moderate, label: 'Moderate: 40-45' },
      { ...severe, label: 'Severe: 45-50' },
      { ...extreme, label: 'Extreme: 50+ (hail possible)' },
    ],
    note: 'US: NEXRAD, about 1 km detail. Elsewhere: RainViewer, coarser (zoom 7). Airliners keep about 20 nm from 40+',
  };
}

export function stormTopsLegend(): LegendSpec {
  const [light, moderate, severe, extreme] = severityLegendItems([1, 2, 3, 4], 'dot');
  return {
    kind: 'items',
    title: 'Storm tops (US radar)',
    items: [
      { ...light, label: 'Light: 20,000-30,000 ft' },
      { ...moderate, label: 'Moderate: 30,000-40,000 ft' },
      { ...severe, label: 'Severe: 40,000-50,000 ft' },
      { ...extreme, label: 'Extreme: above 50,000 ft' },
    ],
    note: 'Highest radar echo (NEXRAD echo tops). Tops above your cruise altitude cannot be flown over',
  };
}

/** SPC outlook on the ladder; general thunderstorms in the soft blue radar uses for plain rain. */
export function spcLegend(): LegendSpec {
  const [light, moderate, severe, extreme] = severityLegendItems([1, 2, 3, 4], 'line');
  return {
    kind: 'items',
    title: 'Severe storm outlook (US, SPC)',
    items: [
      { color: 'rgb(96, 165, 250)', label: 'thunderstorms, not severe', mark: 'line' },
      { ...light, label: 'Light: marginal risk' },
      { ...moderate, label: 'Moderate: slight risk' },
      { ...severe, label: 'Severe: enhanced risk' },
      { ...extreme, label: 'Extreme: moderate or high risk' },
    ],
    note: 'Where severe storms (large hail, damaging wind, tornadoes) are expected today or tomorrow',
  };
}

export function geohazardsLegend(): LegendSpec {
  const [light, moderate, severe, extreme] = severityLegendItems([1, 2, 3, 4], 'dot');
  return {
    kind: 'items',
    title: 'Earthquakes and volcanoes',
    items: [
      { ...light, label: 'Light: M4.5-5.4; volcano YELLOW' },
      { ...moderate, label: 'Moderate: M5.5-6.4; volcano ORANGE' },
      { ...severe, label: 'Severe: M6.5-7.4' },
      { ...extreme, label: 'Extreme: M7.5+; volcano RED' },
      { color: '#e2e8f0', label: 'volcano (aviation color code)', mark: 'glyph', glyph: HAZARD_GLYPH.ASH },
    ],
    note: 'Earthquakes worldwide in the last day, sized by magnitude. Volcanoes: US observatories (ash elsewhere shows as SIGMETs)',
  };
}

/** Aurora chance in green (spaceWeather.ts auroraRgba), with the current NOAA scales in the note. */
export function auroraLegend(scales?: string): LegendSpec {
  return {
    kind: 'items',
    title: 'Space weather and aurora',
    items: [
      { color: 'rgba(74, 222, 128, 0.35)', label: 'aurora possible (10-50%)', mark: 'dot' },
      { color: 'rgba(74, 222, 128, 0.9)', label: 'aurora likely (50%+)', mark: 'dot' },
    ],
    note: `Under the aurora, HF radio and GPS degrade in storms.${scales ? ` NOAA scales now: ${scales}` : ''}`,
  };
}

export function tcfLegend(): LegendSpec {
  const [, moderate, severe, extreme] = severityLegendItems([1, 2, 3, 4], 'line');
  return {
    kind: 'items',
    title: 'Thunderstorm forecast (US, TCF)',
    items: [
      { ...moderate, label: 'Moderate: sparse (25-39% of the area)' },
      { ...severe, label: 'Severe: medium (40-74%)' },
      { ...extreme, label: 'Extreme: solid (75%+) or a line of storms' },
      { color: '#e2e8f0', label: 'low confidence', mark: 'dash' },
    ],
    note: 'Where storms are expected 4, 6 or 8 hours ahead. Numbers: storm tops in thousands of feet',
  };
}

export function cycloneLegend(): LegendSpec {
  const [light, moderate, severe, extreme] = severityLegendItems([1, 2, 3, 4], 'line');
  return {
    kind: 'items',
    title: 'Tropical cyclones',
    items: [
      { ...light, label: 'Light: depression' },
      { ...moderate, label: 'Moderate: tropical storm' },
      { ...severe, label: 'Severe: hurricane / typhoon' },
      { ...extreme, label: 'Extreme: has reached Category 3+' },
    ],
    note: 'Shaded: forecast cone. Dashed: forecast track',
  };
}

export function tfrLegend(): LegendSpec {
  const [light, moderate, severe] = severityLegendItems([1, 2, 3], 'line');
  return {
    kind: 'items',
    title: 'US flight restrictions (TFRs)',
    items: [
      { ...light, label: 'Light: drones, to 400 ft' },
      { ...moderate, label: 'Moderate: hazards, air shows, stadiums' },
      { ...severe, label: 'Severe: security, VIP, space launch' },
    ],
    note: 'Most reach only a few thousand feet, well below cruise',
  };
}
