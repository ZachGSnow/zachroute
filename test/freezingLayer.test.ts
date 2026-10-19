import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubBrowser, stubFetch } from './helpers';
import { fetchFreezingGrid, freezingColor, freezingLabel, gridFor, MAX_POINTS, wrapLon } from '../src/ts/freezingLayer';

beforeEach(() => {
  stubBrowser();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('freezing level grid', () => {
  it('uses the finest cell that stays under the point cap, snapped to whole cells', () => {
    const us = gridFor(24.3, -125.2, 49.8, -66.1)!; // the lower 48 at about zoom 4
    expect(us.lats.length * us.lons.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(us.cell).toBe(5);
    expect(us.lats[0]).toBe(20);
    expect(us.lons[0]).toBe(-130);
    expect(us.lats.every((v) => v % us.cell === 0)).toBe(true);

    const city = gridFor(41.5, -88.5, 42.3, -87.4)!; // Chicago area
    expect(city.cell).toBe(0.5);
  });

  it('stays away from the poles and gives up on a whole-world view', () => {
    expect(gridFor(70, -10, 89, 10)!.lats.at(-1)).toBeLessThanOrEqual(75);
    expect(gridFor(80, -10, 89, 10)).toBeNull();
    expect(gridFor(-85, -540, 85, 540)).toBeNull();
  });

  it('folds longitudes past the date line back into -180..180', () => {
    expect(wrapLon(190)).toBe(-170);
    expect(wrapLon(-185)).toBe(175);
    expect(wrapLon(-87.5)).toBe(-87.5);
  });

  it('colors low levels dark and opaque, high levels faint, unknown transparent', () => {
    const low = freezingColor(0);
    const high = freezingColor(20000);
    expect(low[3]).toBeGreaterThan(high[3]);
    expect(low[2]).toBeLessThan(high[2] + 100); // dark blue vs pale blue
    expect(freezingColor(NaN)[3]).toBe(0);
    expect(freezingLabel(8400)).toBe('8');
    expect(freezingLabel(-300)).toBe('0');
    expect(freezingLabel(NaN)).toBe('');
  });
});

describe('freezing level grid from Open-Meteo', () => {
  const grid = { cell: 10, lats: [40, 50], lons: [-100, -90] };
  const reply = (ms: number[]) => ms.map((m) => ({ current: { freezing_level_height: m } }));

  it('requests every point once, then answers from the cache', async () => {
    const { calls } = stubFetch([['current=freezing_level_height', reply([1000, 2000, 3000, 4000])]]);
    const now = Date.UTC(2026, 9, 19, 12);
    const first = await fetchFreezingGrid(grid, now);
    expect(first[0][0]).toBeCloseTo(3280.84, 1);
    expect(first[1][1]).toBeCloseTo(13123.36, 1);
    expect(calls[0]).toContain('latitude=40,40,50,50');
    expect(calls[0]).toContain('longitude=-100,-90,-100,-90');
    await fetchFreezingGrid(grid, now + 60_000);
    expect(calls).toHaveLength(1);
  });

  it('leaves points unknown when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Too many requests', { status: 429 })));
    const values = await fetchFreezingGrid({ cell: 10, lats: [10], lons: [10] });
    expect(Number.isNaN(values[0][0])).toBe(true);
  });
});
