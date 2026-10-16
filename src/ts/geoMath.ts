export interface RunwayDetail {
  ident: string; // e.g. "18C/36C"
  lengthFt: number;
  widthFt?: number;
  surface?: string;
  lighted: boolean;
  closed: boolean;
  leHeadingDegT?: number;
  heHeadingDegT?: number;
  // Runway end coordinates (OurAirports); absent for many small fields
  leLat?: number;
  leLon?: number;
  heLat?: number;
  heLon?: number;
}

export interface NavaidDetail {
  ident: string;
  name: string;
  type: string; // VOR, VOR-DME, VORTAC, NDB, DME, TACAN, ...
  freqKhz?: number;
}

export interface FrequencyDetail {
  type: string; // e.g. "TWR", "GND", "ATIS"
  description: string;
  frequencyMhz: string;
}

export interface Airport {
  iata: string;
  icao: string;
  name: string;
  city: string;
  state?: string;
  regionName?: string;
  country: string;
  countryName?: string;
  lat: number;
  lon: number;
  elevation: number;
  type: string;
  primaryOperator?: string;
  lore?: string;
  airportType?: 'Passenger airport' | 'Cargo airport' | 'Joint use airport' | 'Military airport' | 'General aviation airport';
  runwayCount?: number;
  longestRunwayFeet?: number;
  runways?: RunwayDetail[];
  frequencies?: FrequencyDetail[];
  timeZone?: string;
  wikipediaLink?: string;
  homeLink?: string;
  localCode?: string; // FAA LID when different from IATA/ICAO
  regionCode?: string; // local part of the ISO region, e.g. "KY" for US-KY
  keywords?: string; // OurAirports alternate names / nearby towns, comma separated
  navaids?: NavaidDetail[];
  magVarDeg?: number; // magnetic declination, east positive (World Magnetic Model at build time)
}

const R_EARTH_MILES = 3958.8;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function haversineDistanceLatLon(lat1Deg: number, lon1Deg: number, lat2Deg: number, lon2Deg: number): number {
  const dLat = toRad(lat2Deg - lat1Deg);
  const dLon = toRad(lon2Deg - lon1Deg);
  const lat1 = toRad(lat1Deg);
  const lat2 = toRad(lat2Deg);

  const aa = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
             Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return R_EARTH_MILES * c;
}

export function haversineDistance(a: Airport, b: Airport): number {
  return haversineDistanceLatLon(a.lat, a.lon, b.lat, b.lon);
}

export function initialBearing(a: Airport, b: Airport): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);

  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  let theta = Math.atan2(y, x);
  theta = toDeg(theta);
  return (theta + 360) % 360;
}

export function slerpArc(a: Airport, b: Airport, steps: number = 50): Array<{lat: number; lon: number}> {
  const lat1 = toRad(a.lat);
  const lon1 = toRad(a.lon);
  const lat2 = toRad(b.lat);
  const lon2 = toRad(b.lon);

  const d = Math.acos(Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(lon1 - lon2));
  
  if (d === 0) {
    return [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }];
  }

  const points: Array<{lat: number; lon: number}> = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y));
    const lon = Math.atan2(y, x);
    points.push({ lat: toDeg(lat), lon: toDeg(lon) });
  }
  return points;
}

export function blockTimeMiles(distanceMiles: number): number {
  const taxi = 22;
  let v = 480;
  if (distanceMiles < 300) v = 340;
  else if (distanceMiles < 800) v = 430;
  const airMinutes = (distanceMiles / v) * 60;
  return Math.round(airMinutes) + taxi;
}

/** Block time with a known average headwind (knots; negative = tailwind) along the route. */
export function blockTimeWithHeadwind(distanceMiles: number, headwindKt: number): number {
  const taxi = 22;
  let v = 480;
  if (distanceMiles < 300) v = 340;
  else if (distanceMiles < 800) v = 430;

  const adjustedSpeed = Math.max(v - headwindKt * 1.15078, 60);
  const airMinutes = (distanceMiles / adjustedSpeed) * 60;
  return Math.round(airMinutes) + taxi;
}

/** Headwind component (knots, negative = tailwind) of a wind blowing FROM windDirDeg against a course. */
export function headwindComponentKt(bearingDeg: number, windDirDeg: number, windSpeedKt: number): number {
  return windSpeedKt * Math.cos(toRad(windDirDeg - bearingDeg));
}

/**
 * Adjusts blockTimeMiles' estimate using a single wind (surface or aloft)
 * resolved against the route bearing. METAR/TAF/forecast-model winds are all
 * referenced to true north, like route bearings, so no variation is applied.
 * windComponentKt: positive = tailwind, negative = headwind.
 */
export function windAdjustedBlockTime(
  distanceMiles: number,
  bearingDeg: number,
  windDirDeg: number,
  windSpeedKt: number
): { minutes: number; windComponentKt: number } {
  const headwindKt = headwindComponentKt(bearingDeg, windDirDeg, windSpeedKt);
  return {
    minutes: blockTimeWithHeadwind(distanceMiles, headwindKt),
    windComponentKt: Math.round(-headwindKt),
  };
}

/** Initial bearing between two raw points (degrees true). */
export function bearingBetween(lat1Deg: number, lon1Deg: number, lat2Deg: number, lon2Deg: number): number {
  const lat1 = toRad(lat1Deg);
  const lat2 = toRad(lat2Deg);
  const dLon = toRad(lon2Deg - lon1Deg);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point reached by travelling distanceNm (nautical miles) from a start along a true bearing. */
export function destinationPoint(
  latDeg: number,
  lonDeg: number,
  bearingDeg: number,
  distanceNm: number
): { lat: number; lon: number } {
  const angular = distanceNm / 3440.065;
  const brg = toRad(bearingDeg);
  const lat1 = toRad(latDeg);
  const lon1 = toRad(lonDeg);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(brg));
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: toDeg(lat2), lon: ((toDeg(lon2) + 540) % 360) - 180 };
}
