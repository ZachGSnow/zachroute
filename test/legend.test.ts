import { describe, expect, it } from 'vitest';
import { legendRowHtml, LEGEND_ORDER } from '../src/ts/legend';
import { aerosolLegend, freezingLevelLegend, routeWindLegend, stationTempLegend, stationWindLegend, windColor, FLIGHT_CATEGORY_COLOR } from '../src/ts/legends';
import { tempColor } from '../src/ts/stationTemp';

describe('legend rows', () => {
  it('draws a gradient with its labels and escapes text', () => {
    const html = legendRowHtml({ kind: 'gradient', title: 'A <b>', colors: ['#000', '#fff'], labels: ['low', 'high & up'], note: 'n' });
    expect(html).toContain('linear-gradient(90deg, #000, #fff)');
    expect(html).toContain('A &lt;b&gt;');
    expect(html).toContain('high &amp; up');
    expect(html).toContain('lg-note');
  });

  it('draws swatches of each kind', () => {
    const html = legendRowHtml({
      kind: 'items',
      title: 'T',
      items: [
        { color: '#f00', label: 'ring', mark: 'ring' },
        { color: '#0f0', label: 'dashed', mark: 'dash' },
        { color: '#00f', label: 'glyph', mark: 'glyph', glyph: 'G25' },
      ],
    });
    expect(html).toContain('lg-ring');
    expect(html).toContain('lg-dash');
    expect(html).toContain('>G25<');
  });

  it('has a fixed order for every layer', () => {
    expect(new Set(LEGEND_ORDER).size).toBe(LEGEND_ORDER.length);
    expect(LEGEND_ORDER[0]).toBe('route');
  });
});

describe('layer legends use the colors the layers draw with', () => {
  it('route winds', () => {
    const spec = routeWindLegend(-12.4);
    expect(spec.kind === 'gradient' && spec.colors[0]).toBe(windColor(30));
    expect(spec.note).toBe('Average 12kt tailwind');
  });

  it('station wind shows the non-VFR rings', () => {
    const spec = stationWindLegend();
    expect(spec.kind === 'items' && spec.items.filter((i) => i.mark === 'ring').map((i) => i.color)).toEqual([
      FLIGHT_CATEGORY_COLOR.MVFR,
      FLIGHT_CATEGORY_COLOR.IFR,
      FLIGHT_CATEGORY_COLOR.LIFR,
    ]);
  });

  it('station temperature follows the weather units', () => {
    const us = stationTempLegend('us');
    const metric = stationTempLegend('metric');
    expect(us.kind === 'gradient' && us.labels).toEqual(['-22\u00b0F', '32\u00b0F', '68\u00b0F', '104\u00b0F']);
    expect(metric.kind === 'gradient' && metric.labels).toEqual(['-30\u00b0C', '0\u00b0C', '20\u00b0C', '40\u00b0C']);
    expect(us.kind === 'gradient' && us.colors[2]).toBe(tempColor(0));
  });

  it('freezing level and dust have labeled scales', () => {
    const f = freezingLevelLegend();
    expect(f.kind === 'gradient' && f.labels).toEqual(['0', '3', '6', '10', '14+']);
    const a = aerosolLegend();
    expect(a.kind === 'gradient' && a.labels[0]).toBe('1 haze');
  });
});
