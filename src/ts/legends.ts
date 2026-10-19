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

export function satelliteLegend(units: WeatherUnits = getWeatherUnits()): LegendSpec {
  const t = (c: number) => `${Math.round(units === 'metric' ? c : cToF(c))}${DEG}`;
  return {
    kind: 'gradient',
    title: `Satellite clouds: cloud-top temperature (${DEG}${units === 'metric' ? 'C' : 'F'})`,
    colors: CLOUD_TOPS.map(([c]) => c),
    labels: ['cloud', t(-40), t(-55), t(-65), `${t(-75)} and colder`],
    note: 'Colder tops are taller, stronger storms; magenta marks the strongest cores',
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
