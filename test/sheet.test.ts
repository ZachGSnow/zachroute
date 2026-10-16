import { describe, expect, it } from 'vitest';
import { heightsFor, nearestState, tapTarget } from '../src/ts/sheet';

describe('phone results sheet', () => {
  const h = heightsFor(700);

  it('computes the three positions for a container', () => {
    expect(h).toEqual({ peek: 64, half: 315, full: 700 });
  });

  it('snaps a drag to the nearest position', () => {
    expect(nearestState(90, h)).toBe('peek');
    expect(nearestState(280, h)).toBe('half');
    expect(nearestState(520, h)).toBe('full');
    expect(nearestState(690, h)).toBe('full');
  });

  it('toggles between peek and half on a tap', () => {
    expect(tapTarget('peek')).toBe('half');
    expect(tapTarget('half')).toBe('peek');
    expect(tapTarget('full')).toBe('peek');
  });
});
