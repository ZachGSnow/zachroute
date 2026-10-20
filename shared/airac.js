// AIRAC cycles: the 28-day schedule on which official airspace and navigation data changes take
// effect worldwide. openAIP's exports change every day as contributors edit, but the airspace a
// pilot is held to only changes on these dates, so the world airspace build
// (scripts/openaip_airspace.js) is redone once per cycle, after it takes effect, rather than at
// every release. Cycle 2601 took effect on 22 January 2026; each cycle is numbered YYNN within the
// year it takes effect.

const DAY_MS = 86400000;
const CYCLE_MS = 28 * DAY_MS;
const ANCHOR = Date.UTC(2026, 0, 22); // AIRAC 2601

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

function cycleAt(k) {
  const effective = ANCHOR + k * CYCLE_MS;
  const year = new Date(effective).getUTCFullYear();
  const firstK = Math.ceil((Date.UTC(year, 0, 1) - ANCHOR) / CYCLE_MS);
  const nn = k - firstK + 1;
  return { id: `${String(year).slice(2)}${String(nn).padStart(2, '0')}`, effective: iso(effective) };
}

/**
 * The AIRAC cycle in effect on `date` (a Date or ms; UTC days) and the next one.
 * @returns {{ id: string, effective: string, next: { id: string, effective: string } }}
 */
export function airacCycle(date = new Date()) {
  const t = typeof date === 'number' ? date : date.getTime();
  const k = Math.floor((t - ANCHOR) / CYCLE_MS);
  return { ...cycleAt(k), next: cycleAt(k + 1) };
}

/**
 * Whether the world airspace should be rebuilt: there is no record of a build, the local files are
 * missing, or a newer AIRAC cycle has taken effect since the recorded build.
 * @param {{ airac?: string } | null} record  scripts/airspace-build.json
 * @param {boolean} haveFiles  public/data/airspace/index.json exists on this machine
 * @returns {{ due: boolean, reason: string }}
 */
export function airspaceDue(record, haveFiles, now = new Date()) {
  const current = airacCycle(now);
  if (!haveFiles) return { due: true, reason: 'no airspace files on this machine (public/data/airspace/ is not committed)' };
  if (!record?.airac) return { due: true, reason: 'no record of the last build' };
  if (record.airac !== current.id) {
    return { due: true, reason: `AIRAC ${current.id} took effect on ${current.effective}, after the build for ${record.airac}` };
  }
  return { due: false, reason: `built ${record.built} for AIRAC ${record.airac}; next cycle ${current.next.id} takes effect ${current.next.effective}` };
}
