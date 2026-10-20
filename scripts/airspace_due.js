// Says whether the world airspace build is due: `npm run airspace:due`. It is due once a newer
// AIRAC cycle has taken effect since the build recorded in scripts/airspace-build.json, or when this
// machine has no airspace files. `npm run etl:airspace:due` rebuilds only in that case.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { airspaceDue } from '../shared/airac.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RECORD = path.join(ROOT, 'scripts', 'airspace-build.json');
export const INDEX = path.join(ROOT, 'public', 'data', 'airspace', 'index.json');

export function readRecord() {
  try {
    return JSON.parse(fs.readFileSync(RECORD, 'utf8'));
  } catch {
    return null;
  }
}

export function checkDue(now = new Date()) {
  return airspaceDue(readRecord(), fs.existsSync(INDEX), now);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { due, reason } = checkDue();
  console.log(`${due ? 'Airspace rebuild due' : 'Airspace is current'}: ${reason}`);
}
