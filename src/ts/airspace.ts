// Airspace, fetched as 4 x 4 degree cells so neighbouring views share cached answers: the US live
// from the FAA (/api/airspace), the rest of the world from openAIP cell files built with the site
// (public/data/airspace/, see scripts/openaip_airspace.js). Areas are de-duplicated across cells
// and each kind gets the usual chart style. No Leaflet here; mapOverlays.ts draws it.

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
  /** Where it came from, and for openAIP the build date of the cell files. */
  source?: 'FAA' | 'openAIP';
  built?: string;
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
  'CLASS-A': { color: '#94a3b8', fill: 0.02, weight: 1, label: 'Class A' },
  B: { color: '#3b82f6', fill: 0.05, weight: 2, label: 'Class B' },
  C: { color: '#c026d3', fill: 0.05, weight: 2, label: 'Class C' },
  D: { color: '#3b82f6', dash: '6 4', fill: 0.03, weight: 1.5, label: 'Class D' },
  'CLASS-E': { color: '#94a3b8', dash: '6 4', fill: 0.02, weight: 1, label: 'Class E' },
  CTL: { color: '#60a5fa', dash: '3 4', fill: 0.02, weight: 1, label: 'Controlled airspace' },
  // Restricted and danger areas are often stacked in slices (Paris has eleven), so they are
  // outlines with only a faint fill; prohibited areas are rarer and get a stronger one.
  P: { color: '#ef4444', fill: 0.15, weight: 2, label: 'Prohibited area' },
  R: { color: '#ef4444', fill: 0.015, weight: 1.2, label: 'Restricted area' },
  'D-AREA': { color: '#fb923c', fill: 0.015, weight: 1.2, label: 'Danger area' },
  W: { color: '#fb923c', fill: 0.05, weight: 1.5, label: 'Warning area' },
  MOA: { color: '#fb923c', dash: '4 4', fill: 0.04, weight: 1.5, label: 'Military operations area' },
  A: { color: '#facc15', dash: '4 4', fill: 0.04, weight: 1.5, label: 'Alert area' },
};

export function airspaceStyle(kind: string): AirspaceStyle {
  return STYLES[kind] || { color: '#94a3b8', fill: 0.03, weight: 1, label: 'Airspace' };
}

/** Wider, more restrictive areas first, so smaller ones stay clickable on top. */
const ORDER = ['CLASS-A', 'CLASS-E', 'CTL', 'MOA', 'W', 'A', 'D-AREA', 'R', 'P', 'B', 'C', 'D'];

/** Areas from several cells, each once, in drawing order. */
export function mergeCells(cells: AirspaceArea[][]): AirspaceArea[] {
  const seen = new Map<string, AirspaceArea>();
  for (const list of cells) for (const a of list) if (!seen.has(a.id)) seen.set(a.id, a);
  return [...seen.values()].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

const cache = new Map<string, Promise<AirspaceArea[]>>();
let worldIndex: Promise<{ built?: string; cells: Set<string> }> | null = null;

/** Which openAIP cell files exist (so empty ocean cells are never asked for), and their build date. */
function openAipIndex(): Promise<{ built?: string; cells: Set<string> }> {
  if (!worldIndex) {
    worldIndex = fetch('/data/airspace/index.json')
      .then((res) => (res.ok ? res.json() : null))
      .then((j) => ({ built: j?.built, cells: new Set<string>(Array.isArray(j?.cells) ? j.cells : []) }))
      .catch(() => ({ cells: new Set<string>() }));
    void worldIndex.then((i) => i.cells.size === 0 && (worldIndex = null));
  }
  return worldIndex;
}

async function getAreas(url: string): Promise<AirspaceArea[]> {
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.areas || []) as AirspaceArea[];
  } catch {
    return [];
  }
}

/** One cell: the FAA's US airspace (the server answers at once away from the US) plus openAIP's elsewhere. */
export function fetchAirspaceCell([lat, lon]: [number, number]): Promise<AirspaceArea[]> {
  const key = `${lat},${lon}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = (async () => {
      if (!navigator.onLine) return [];
      const index = await openAipIndex();
      const name = `${lat}_${lon}`;
      const [faa, world] = await Promise.all([
        getAreas(`/api/airspace?cell=${key}`),
        index.cells.has(name) ? getAreas(`/data/airspace/${name}.json`) : Promise.resolve([]),
      ]);
      return [...faa.map((a) => ({ ...a, source: 'FAA' as const })), ...world.map((a) => ({ ...a, source: 'openAIP' as const, built: index.built }))];
    })();
    cache.set(key, hit);
    // A failed cell is retried on the next look rather than remembered as empty.
    void hit.then((a) => a.length === 0 && cache.delete(key));
  }
  return hit;
}
