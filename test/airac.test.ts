// AIRAC cycles and when the world airspace build is due. Cycle dates checked against the published
// 2026 schedule (2601 on 22 January, 13 cycles, 2613 on 24 December; 2701 on 21 January 2027).
import { describe, expect, it } from 'vitest';
import { airacCycle, airspaceDue } from '../shared/airac.js';

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe('AIRAC cycles', () => {
  it('numbers each 28-day cycle within the year it takes effect', () => {
    expect(airacCycle(day('2026-01-22'))).toEqual({ id: '2601', effective: '2026-01-22', next: { id: '2602', effective: '2026-02-19' } });
    expect(airacCycle(day('2026-10-20')).id).toBe('2610');
    expect(airacCycle(day('2026-10-28')).next).toEqual({ id: '2611', effective: '2026-10-29' });
    expect(airacCycle(day('2026-10-29')).id).toBe('2611');
    expect(airacCycle(day('2026-12-31'))).toEqual({ id: '2613', effective: '2026-12-24', next: { id: '2701', effective: '2027-01-21' } });
    expect(airacCycle(day('2027-01-21')).id).toBe('2701');
  });
});

describe('when to rebuild world airspace', () => {
  const record = { built: '2026-10-20', airac: '2610' };

  it('skips the rebuild until the next cycle takes effect', () => {
    const r = airspaceDue(record, true, day('2026-10-28'));
    expect(r.due).toBe(false);
    expect(r.reason).toContain('2611');
    expect(r.reason).toContain('2026-10-29');
  });

  it('rebuilds once a newer cycle is in effect', () => {
    const r = airspaceDue(record, true, day('2026-10-29'));
    expect(r.due).toBe(true);
    expect(r.reason).toContain('AIRAC 2611');
  });

  it('rebuilds when this machine has no files or there is no record', () => {
    expect(airspaceDue(record, false, day('2026-10-21')).due).toBe(true);
    expect(airspaceDue(null, true, day('2026-10-21')).due).toBe(true);
  });
});
