// Tap a chip or row to see it on the map. Each tappable item carries a FocusTarget: the shapes and
// points to frame, as [lat, lon]. Items register here when a card is drawn and the map side
// (mapOverlays.focusOn) frames and highlights them. No Leaflet here, so tests can check the geometry.

export type LatLon = [number, number];

export interface FocusTarget {
  /** Shown in the popup at the item. */
  title: string;
  /** Outlines and lines (advisory polygons, TFR rings, cyclone cones and tracks, NWS warning areas). */
  shapes: LatLon[][];
  /** Open lines (a cyclone's track). */
  lines?: LatLon[][];
  /** Positions (storm centers, volcanoes, pilot reports, fire detections). */
  points: LatLon[];
  /** NWS forecast zones to fetch on tap, for alerts that name zones instead of drawing an area. */
  zones?: string[];
  /** Where to center when there is nothing else to show (the airport, for a zone that will not load). */
  fallback?: LatLon;
}

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** The box around everything in the target, or null when it has no geometry. */
export function focusBounds(t: FocusTarget): Bounds | null {
  const all = [...t.points, ...t.shapes.flat(), ...(t.lines || []).flat()];
  if (all.length === 0) return t.fallback ? { south: t.fallback[0], west: t.fallback[1], north: t.fallback[0], east: t.fallback[1] } : null;
  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  for (const [lat, lon] of all) {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lon);
    east = Math.max(east, lon);
  }
  // A shape across the antimeridian would span the globe: shift western longitudes east instead.
  if (east - west > 180) {
    const shifted = all.map(([, lon]) => (lon < 0 ? lon + 360 : lon));
    west = Math.min(...shifted);
    east = Math.max(...shifted);
  }
  return { south, west, north, east };
}

/** GeoJSON Polygon or MultiPolygon rings ([lon, lat]) as [lat, lon] outlines (outer rings only). */
export function geoJsonRings(geometry: any): LatLon[][] {
  if (!geometry) return [];
  const flip = (ring: number[][]): LatLon[] => ring.map(([lon, lat]) => [lat, lon]);
  if (geometry.type === 'Polygon') return geometry.coordinates.slice(0, 1).map(flip);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map((poly: number[][][]) => flip(poly[0]));
  if (geometry.type === 'GeometryCollection') return (geometry.geometries || []).flatMap(geoJsonRings);
  return [];
}

/** An NWS alert: its own area when it has one (storm-based warnings), else its forecast zones. */
export function nwsFocus(feature: any, fallback: LatLon): FocusTarget {
  const p = feature?.properties || {};
  const shapes = geoJsonRings(feature?.geometry);
  const zones: string[] = shapes.length ? [] : (p.affectedZones || []).filter((z: string) => /^https:\/\/api\.weather\.gov\/zones\//.test(z)).slice(0, 12);
  return { title: p.headline || p.event || 'Weather alert', shapes, points: [], zones, fallback };
}

const zoneCache = new Map<string, Promise<LatLon[][]>>();

/** Fills in the outlines of an alert's forecast zones (api.weather.gov, cached for the session). */
export async function resolveZones(t: FocusTarget): Promise<FocusTarget> {
  if (!t.zones?.length) return t;
  const lists = await Promise.all(
    t.zones.map((url) => {
      let hit = zoneCache.get(url);
      if (!hit) {
        hit = fetch(url, { headers: { Accept: 'application/geo+json' } })
          .then((res) => (res.ok ? res.json() : null))
          .then((j) => geoJsonRings(j?.geometry))
          .catch(() => []);
        zoneCache.set(url, hit);
      }
      return hit;
    })
  );
  return { ...t, shapes: [...t.shapes, ...lists.flat()], zones: [] };
}

// Registry: a card registers each tappable item and marks it with data-focus="<id>".
const registry = new Map<string, FocusTarget>();
let next = 0;

/** HTML attributes that make an element tappable for this target, or '' without one. */
export function focusAttrs(t: FocusTarget | null | undefined): string {
  if (!t || (!t.shapes.length && !t.points.length && !t.lines?.length && !t.zones?.length)) return '';
  const id = `f${next++}`;
  registry.set(id, t);
  return ` data-focus="${id}" role="button" tabindex="0"`;
}

export const getFocus = (id: string) => registry.get(id);

/** Forget the items of an earlier result (a new search redraws the cards). */
export function clearFocusRegistry() {
  registry.clear();
}
