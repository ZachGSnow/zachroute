import { describe, expect, it } from 'vitest';
import { decodeRgbaPng, jsonFixture } from './helpers';
import {
  iemDbz,
  iemTopsKft,
  rainviewerDbz,
  radarLevel,
  topsLevel,
  recolorTile,
  levelRgba,
  iemReflectivityLevel,
  rainviewerLevel,
  rainviewerFrame,
  iemTime,
  inUsRadarBox,
  tileInsideUsBox,
  tileTouchesUsBox,
  RAIN_RGBA,
} from '../src/ts/radarTiles';
import { severityColor } from '../src/ts/severity';
import { radarLegend } from '../src/ts/legends';

// Real tiles captured 19 Oct 2026 around 23:30 UTC: IEM NEXRAD reflectivity and echo tops over the
// storms in New Mexico (zoom 5, x 6, y 12), and RainViewer over Europe (zoom 5, x 15, y 11).
function levels(name: string, level: (r: number, g: number, b: number, a: number) => number | null) {
  const { data } = decodeRgbaPng(name);
  const out: Record<string, number> = {};
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const l = String(level(data[i], data[i + 1], data[i + 2], data[i + 3]));
    out[l] = (out[l] || 0) + 1;
  }
  return out;
}

describe('radar color tables', () => {
  it('reads IEM reflectivity colors back to dBZ (0.5 dBZ steps from palette index 105)', () => {
    expect(iemDbz(0x43, 0xd6, 0x7e, 255)).toBe(20);
    expect(iemDbz(13, 158, 17, 255)).toBe(27.5); // index 120
    expect(iemDbz(234, 210, 4, 255)).toBe(39.5); // index 144
    expect(iemDbz(227, 0, 0, 255)).toBe(51.5); // index 168
    expect(iemDbz(98, 187, 216, 255)).toBeUndefined(); // index 96, 15.5 dBZ: not drawn
    expect(iemDbz(227, 0, 0, 0)).toBeUndefined();
  });

  it('reads RainViewer Universal Blue back to whole dBZ', () => {
    expect(rainviewerDbz(0x00, 0xa3, 0xe0, 255)).toBe(20);
    expect(rainviewerDbz(0xff, 0xee, 0x00, 255)).toBe(35);
    expect(rainviewerDbz(0xc1, 0x00, 0x00, 255)).toBe(50);
    expect(rainviewerDbz(0x88, 0xdd, 0xee, 255)).toBeUndefined(); // 15 dBZ: not drawn
    expect(rainviewerDbz(0x00, 0xa3, 0xe0, 120)).toBeUndefined(); // see-through shades are drizzle
  });

  it('reads IEM echo top colors back to thousands of feet', () => {
    expect(iemTopsKft(95, 115, 167, 255)).toBe(2);
    expect(iemTopsKft(255, 0, 0, 255)).toBe(50);
    expect(iemTopsKft(225, 11, 227, 255)).toBe(71);
    expect(iemTopsKft(0, 0, 0, 255)).toBeUndefined();
  });
});

describe('radar levels', () => {
  it('puts radar strength on the ladder', () => {
    expect([undefined, 19.5, 20, 29.5, 30, 39.5, 40, 44.5, 45, 49.5, 50, 70].map(radarLevel)).toEqual([null, null, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('puts storm tops on the ladder', () => {
    expect([undefined, 19, 20, 29, 30, 39, 40, 49, 50, 71].map(topsLevel)).toEqual([null, null, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('draws levels in the severity colors, rain in soft blue', () => {
    expect(levelRgba(0)).toEqual(RAIN_RGBA);
    expect(levelRgba(4).slice(0, 3)).toEqual([0xd9, 0x46, 0xef]);
  });
});

describe('real radar tiles', () => {
  it('decodes the IEM reflectivity tile, with every level present', () => {
    const out = levels('iem-n0q-5-6-12.png', iemReflectivityLevel);
    // "null" is the echoes under 20 dBZ, left out of the table on purpose.
    expect(Object.keys(out).sort()).toEqual(['0', '1', '2', '3', '4', 'null']);
  });

  it('decodes every pixel of the IEM echo tops tile', () => {
    const { data } = decodeRgbaPng('iem-eet-5-6-12.png');
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (!data[i + 3]) continue;
      n++;
      expect(iemTopsKft(data[i], data[i + 1], data[i + 2], data[i + 3])).toBeGreaterThanOrEqual(2);
    }
    expect(n).toBeGreaterThan(1000);
  });

  it('decodes the RainViewer tile', () => {
    const out = levels('rainviewer-5-15-11.png', rainviewerLevel);
    expect(out['0']).toBeGreaterThan(1000);
    expect(out['1']).toBeGreaterThan(0);
  });

  it('redraws a tile in level colors only, clearing what another source covers', () => {
    const { data } = decodeRgbaPng('iem-n0q-5-6-12.png');
    const allowed = new Set([0, 1, 2, 3, 4].map((l) => levelRgba(l as 0).join()));
    const copy = new Uint8ClampedArray(data);
    recolorTile(copy, iemReflectivityLevel);
    let drawn = 0;
    for (let i = 0; i < copy.length; i += 4) {
      if (copy[i + 3] === 0) continue;
      drawn++;
      expect(allowed.has([copy[i], copy[i + 1], copy[i + 2], copy[i + 3]].join())).toBe(true);
    }
    expect(drawn).toBeGreaterThan(1000);

    const half = new Uint8ClampedArray(data);
    recolorTile(half, iemReflectivityLevel, (x) => x < 128);
    for (let y = 0; y < 256; y++) for (let x = 128; x < 256; x++) expect(half[(y * 256 + x) * 4 + 3]).toBe(0);
  });
});

describe('radar sources', () => {
  it('builds the newest RainViewer tile URL: Universal Blue, no smoothing, no snow colors', () => {
    const maps = jsonFixture('rainviewer-weather-maps.json');
    const last = maps.radar.past[maps.radar.past.length - 1];
    expect(rainviewerFrame(maps)).toEqual({ url: `https://tilecache.rainviewer.com${last.path}/256/{z}/{x}/{y}/2/0_0.png`, time: last.time });
    expect(rainviewerFrame({ ...maps, host: 'http://example.com' })).toBeNull();
    expect(rainviewerFrame({ radar: { past: [] } })).toBeNull();
  });

  it('reads the IEM composite time', () => {
    const meta = jsonFixture('iem-n0q-0.json');
    expect(iemTime(meta)).toBe(Date.parse(meta.meta.valid) / 1000);
    expect(iemTime({})).toBeNull();
  });

  it('splits the world between the two sources', () => {
    expect(inUsRadarBox(39.8, -104.7)).toBe(true); // Denver
    expect(inUsRadarBox(51.5, -0.1)).toBe(false); // London
    expect(tileInsideUsBox(35, -100, 40, -95)).toBe(true);
    expect(tileInsideUsBox(45, -70, 55, -60)).toBe(false);
    expect(tileTouchesUsBox(45, -70, 55, -60)).toBe(true);
    expect(tileTouchesUsBox(45, 0, 55, 10)).toBe(false);
  });

  it('has a legend in the same colors', () => {
    const l = radarLegend();
    expect(l.kind === 'items' && l.items.slice(1).map((i) => i.color)).toEqual([1, 2, 3, 4].map((s) => severityColor(s as 1)));
  });
});
