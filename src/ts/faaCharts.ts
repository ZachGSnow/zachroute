// FAA aeronautical charts (US): the VFR sectional and the IFR low enroute chart, as map tiles from
// the FAA's own tile service. The service serves zoom 8 to 12 only and is refreshed less often
// than the charts' 56-day cycle, so the layer reads its update date and says how old it is.
// No Leaflet here; mapOverlays.ts draws it.

export type FaaChart = 'vfr' | 'ifr';

const SERVICE = 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services';
const LAYERS: Record<FaaChart, string> = { vfr: 'VFR_Sectional', ifr: 'IFR_AreaLow' };

export const FAA_CHART_MIN_ZOOM = 8;
export const FAA_CHART_MAX_NATIVE_ZOOM = 12;
/** FAA charts are reissued every 56 days. */
export const CHART_CYCLE_DAYS = 56;

export function faaChartTileUrl(chart: FaaChart): string {
  return `${SERVICE}/${LAYERS[chart]}/MapServer/tile/{z}/{y}/{x}`;
}

export function faaChartInfoUrl(chart: FaaChart): string {
  return `${SERVICE}/${LAYERS[chart]}/MapServer?f=json`;
}

export function faaChartName(chart: FaaChart): string {
  return chart === 'vfr' ? 'VFR sectional' : 'IFR low enroute';
}

/** "Updated with the latest charts on 07-09-2026." (the service's documentInfo.subject) -> ms, or null. */
export function chartUpdated(info: any): number | null {
  const m = String(info?.documentInfo?.subject || '').match(/(\d{2})-(\d{2})-(\d{4})/);
  return m ? Date.UTC(+m[3], +m[1] - 1, +m[2]) : null;
}

/** "edition of 9 Jul 2026" plus a warning once it is older than one chart cycle. */
export function chartAgeNote(updatedMs: number | null, nowMs = Date.now()): string {
  if (updatedMs === null) return 'edition date unknown; may be out of date';
  const date = new Date(updatedMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const days = Math.floor((nowMs - updatedMs) / 86_400_000);
  return days > CHART_CYCLE_DAYS ? `edition of ${date}, older than the current one` : `edition of ${date}`;
}
