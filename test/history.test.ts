import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubBrowser } from './helpers';
import { addRecent, clearRecent, loadRecent, MAX_RECENT } from '../src/ts/history';

describe('recent searches', () => {
  beforeEach(() => {
    stubBrowser();
  });

  it('keeps the newest first and moves a repeat to the top', () => {
    addRecent('ORD');
    addRecent('ORD DEN');
    addRecent('ord'); // same search, different case
    expect(loadRecent()).toEqual(['ord', 'ORD DEN']);
  });

  it(`keeps at most ${MAX_RECENT}`, () => {
    for (let i = 0; i < 12; i++) addRecent(`Q${i}`);
    const list = loadRecent();
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0]).toBe('Q11');
  });

  it('ignores blanks and can be cleared', () => {
    addRecent('   ');
    expect(loadRecent()).toEqual([]);
    addRecent('DEN');
    clearRecent();
    expect(loadRecent()).toEqual([]);
  });

  it('survives unavailable or corrupt storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => '{not json',
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(loadRecent()).toEqual([]);
    expect(() => addRecent('ORD')).not.toThrow();
  });
});
