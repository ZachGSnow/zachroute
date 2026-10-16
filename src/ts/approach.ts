import type { Airport, RunwayDetail } from './geoMath';
import { bearingBetween, destinationPoint } from './geoMath';

// Schematic approach / departure geometry from runway end coordinates.
// This is the extended runway centerline and a 3 degree glide slope, NOT a
// published instrument procedure.

export const APPROACH_NM = 10;
const FEET_PER_NM = 6076.12;
const GLIDE_FT_PER_NM = FEET_PER_NM * Math.tan((3 * Math.PI) / 180); // about 318 ft per nm

export interface LatLon {
  lat: number;
  lon: number;
}

export interface RunwayEnd {
  ident: string; // e.g. "35L"
  headingDegT: number; // direction of travel when landing / taking off from this end
  threshold: LatLon;
  far: LatLon; // the other end of the runway
}

function hasCoords(r: RunwayDetail): boolean {
  return [r.leLat, r.leLon, r.heLat, r.heLon].every((v) => typeof v === 'number' && Number.isFinite(v));
}

function endsOf(r: RunwayDetail): RunwayEnd[] {
  if (!hasCoords(r)) return [];
  const [leIdent, heIdent] = r.ident.split('/');
  const le: LatLon = { lat: r.leLat as number, lon: r.leLon as number };
  const he: LatLon = { lat: r.heLat as number, lon: r.heLon as number };
  const out: RunwayEnd[] = [];
  if (leIdent) {
    out.push({
      ident: leIdent,
      headingDegT: r.leHeadingDegT ?? bearingBetween(le.lat, le.lon, he.lat, he.lon),
      threshold: le,
      far: he,
    });
  }
  if (heIdent) {
    out.push({
      ident: heIdent,
      headingDegT: r.heHeadingDegT ?? bearingBetween(he.lat, he.lon, le.lat, le.lon),
      threshold: he,
      far: le,
    });
  }
  return out;
}

export function allRunwayEnds(airport: Airport): RunwayEnd[] {
  return (airport.runways || []).flatMap(endsOf);
}

export function findRunwayEnd(airport: Airport, ident: string | null): RunwayEnd | null {
  if (!ident) return null;
  return allRunwayEnds(airport).find((e) => e.ident === ident) || null;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** The runway end whose heading best matches a course; ties go to the longer runway. */
export function bestEndForCourse(airport: Airport, courseDeg: number): RunwayEnd | null {
  const ends = allRunwayEnds(airport);
  if (ends.length === 0) return null;
  const lengthOf = (e: RunwayEnd) => (airport.runways || []).find((r) => r.ident.split('/').includes(e.ident))?.lengthFt ?? 0;
  return ends.reduce((best, e) => {
    const d = angleDiff(e.headingDegT, courseDeg);
    const bd = angleDiff(best.headingDegT, courseDeg);
    if (d < bd - 1) return e;
    if (Math.abs(d - bd) <= 1 && lengthOf(e) > lengthOf(best)) return e;
    return best;
  });
}

/** The point `distNm` out along the extended centerline, on the approach side of the threshold. */
export function approachPoint(end: RunwayEnd, distNm: number): LatLon {
  return destinationPoint(end.threshold.lat, end.threshold.lon, (end.headingDegT + 180) % 360, distNm);
}

/** Approach centerline from APPROACH_NM out down to the threshold. */
export function approachLine(end: RunwayEnd): LatLon[] {
  return [approachPoint(end, APPROACH_NM), end.threshold];
}

/** Takeoff roll and straight-out departure: threshold, far end, then APPROACH_NM beyond it. */
export function departureLine(end: RunwayEnd): LatLon[] {
  const beyond = destinationPoint(end.far.lat, end.far.lon, end.headingDegT, APPROACH_NM);
  return [end.threshold, end.far, beyond];
}

export interface ApproachTick {
  distNm: number;
  center: LatLon;
  left: LatLon;
  right: LatLon;
  heightFt: number;
  label: string;
}

/** Distance ticks every 2nm with the height above the runway on a 3 degree glide path. */
export function approachTicks(end: RunwayEnd): ApproachTick[] {
  const ticks: ApproachTick[] = [];
  for (let d = 2; d <= APPROACH_NM; d += 2) {
    const center = approachPoint(end, d);
    const left = destinationPoint(center.lat, center.lon, (end.headingDegT + 270) % 360, 0.3);
    const right = destinationPoint(center.lat, center.lon, (end.headingDegT + 90) % 360, 0.3);
    const heightFt = Math.round((d * GLIDE_FT_PER_NM) / 100) * 100;
    ticks.push({ distNm: d, center, left, right, heightFt, label: `${d} nm \u00b7 ~${heightFt.toLocaleString()} ft` });
  }
  return ticks;
}

/** Chaikin corner cutting: rounds sharp turns while keeping both endpoints fixed. */
export function smoothPath(points: LatLon[], iterations = 2): LatLon[] {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    if (pts.length < 3) return pts;
    const next: LatLon[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      next.push({ lat: 0.75 * a.lat + 0.25 * b.lat, lon: 0.75 * a.lon + 0.25 * b.lon });
      next.push({ lat: 0.25 * a.lat + 0.75 * b.lat, lon: 0.25 * a.lon + 0.75 * b.lon });
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }
  return pts;
}
