// Airspace (from /api/airspace): the view is fetched as 4 x 4 degree cells so neighbouring views
// share cached answers, areas are de-duplicated across cells, and each kind gets the usual chart
// style. No Leaflet here; mapOverlays.ts draws it.

export interface Limit {
  value?: number;
  ref: 'MSL' | 'AGL' | 'FL' | 'SFC' | 'UNL' | 'NOTAM';
}

export interface AirspaceArea {
  id: string;
  kind: string;
  name: string;
  lower: Limit;
  upper: Limit;
  times?: string;
  polygons: [number, number][][][];
}

export const CELL_DEG = 4;
export const MIN_AIRSPACE_ZOOM = 7;
/** More cells than this means the view is too large to draw airspace usefully. */
const MAX_CELLS = 30;

/** South-west corners of the cells covering a box (longitudes wrapped into -180..176). */
export function cellsFor(south: number, west: number, north: number, east: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const lat0 = Math.max(-88, Math.floor(south / CELL_DEG) * CELL_DEG);
  const lat1 = Math.min(84, Math.floor(north / CELL_DEG) * CELL_DEG);
  const lon0 = Math.floor(west / CELL_DEG) * CELL_DEG;
  const lon1 = Math.floor(east / CELL_DEG) * CELL_DEG;
  for (let lat = lat0; lat <= lat1; lat += CELL_DEG) {
    for (let lon = lon0; lon <= lon1; lon += CELL_DEG) {
      const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
      out.push([lat, wrapped]);
      if (out.length > MAX_CELLS) return [];
    }
  }
  return out;
}

/** "surface", "3,000 ft above ground", "4,700 ft", "FL180", "unlimited", "by NOTAM". */
export function describeLimit(l: Limit): string {
  switch (l.ref) {
    case 'SFC':
      return 'surface';
    case 'UNL':
      return 'unlimited';
    case 'NOTAM':
      return 'by NOTAM';
    case 'FL':
      return `FL${String(l.value ?? 0).padStart(3, '0')}`;
    case 'AGL':
      return `${(l.value ?? 0).toLocaleString('en-US')} ft above ground`;
    default:
      return `${(l.value ?? 0).toLocaleString('en-US')} ft`;
  }
}

export interface AirspaceStyle {
  color: string;
  dash?: string;
  fill: number;
  weight: number;
  label: string;
}

/** Chart conventions: class B blue, C magenta, D dashed blue; special use by how restrictive it is. */
const STYLES: Record<string, AirspaceStyle> = {
  B: { color: '#3b82f6', fill: 0.05, weight: 2, label: 'Class B' },
  C: { color: '#c026d3', fill: 0.05, weight: 2, label: 'Class C' },
  D: { color: '#3b82f6', dash: '6 4', fill: 0.03, weight: 1.5, label: 'Class D' },
  P: { color: '#ef4444', fill: 0.18, weight: 2, label: 'Prohibited area' },
  R: { color: '#ef4444', fill: 0.08, weight: 1.5, label: 'Restricted area' },
  'D-AREA': { color: '#fb923c', fill: 0.06, weight: 1.5, label: 'Danger area' },
  W: { color: '#fb923c', fill: 0.05, weight: 1.5, label: 'Warning area' },
  MOA: { color: '#fb923c', dash: '4 4', fill: 0.04, weight: 1.5, label: 'Military operations area' },
  A: { color: '#facc15', dash: '4 4', fill: 0.04, weight: 1.5, label: 'Alert area' },
};

export function airspaceStyle(kind: string): AirspaceStyle {
  return STYLES[kind] || { color: '#94a3b8', fill: 0.03, weight: 1, label: 'Airspace' };
}

/** Wider, more restrictive areas first, so smaller ones stay clickable on top. */
const ORDER = ['MOA', 'W', 'A', 'D-AREA', 'R', 'P', 'B', 'C', 'D'];

/** Areas from several cells, each once, in drawing order. */
export function mergeCells(cells: AirspaceArea[][]): AirspaceArea[] {
  const seen = new Map<string, AirspaceArea>();
  for (const list of cells) for (const a of list) if (!seen.has(a.id)) seen.set(a.id, a);
  return [...seen.values()].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

const cache = new Map<string, Promise<AirspaceArea[]>>();

export function fetchAirspaceCell([lat, lon]: [number, number]): Promise<AirspaceArea[]> {
  const key = `${lat},${lon}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = (async () => {
      if (!navigator.onLine) return [];
      try {
        const res = await fetch(`/api/airspace?cell=${key}`);
        if (!res.ok) return [];
        const json = await res.json();
        return (json.areas || []) as AirspaceArea[];
      } catch {
        return [];
      }
    })();
    cache.set(key, hit);
    // A failed cell is retried on the next look rather than remembered as empty.
    void hit.then((a) => a.length === 0 && cache.delete(key));
  }
  return hit;
}
