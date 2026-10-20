// Who is flying a Live track aircraft: the airline from the first 3 letters of its callsign
// (DAL1234 is Delta flight 1234), or "Private" for registrations used as callsigns (N123AB).
// The name table (src/data/airline-icao.json, ~42 KB) loads the first time it is needed.
// Regional airlines show as themselves (SkyWest), not the brand they fly for that day.

import { shortAirlineName, shortCarrierName } from './carriers';

export type AirlineTable = Record<string, [string, string]>;

let table: Promise<AirlineTable> | null = null;

/** The airline table, loaded once on demand. */
export function loadAirlines(): Promise<AirlineTable> {
  if (!table) {
    table = import('../data/airline-icao.json')
      .then((m) => (m.default || m) as unknown as AirlineTable)
      .catch(() => ({}) as AirlineTable);
  }
  return table;
}

/** "DAL1234" -> { icao: 'DAL', number: '1234' }; null when it is not an airline-style callsign. */
export function splitCallsign(callsign: string | undefined): { icao: string; number: string } | null {
  const m = (callsign || '').trim().toUpperCase().match(/^([A-Z]{3})(\d{1,4}[A-Z]{0,2})$/);
  return m ? { icao: m[1], number: m[2] } : null;
}

/** A callsign that is the aircraft's registration (N123AB, C-GABC as CGABC, G-ABCD as GABCD). */
export function isRegistrationCallsign(callsign: string | undefined, reg: string | undefined): boolean {
  const cs = (callsign || '').trim().toUpperCase();
  if (!cs) return false;
  if (reg && cs === reg.replace(/-/g, '').toUpperCase()) return true;
  return /^N\d[0-9A-Z]{0,4}$/.test(cs);
}

export interface FlightName {
  /** "Delta 1234", "Private" or the callsign as reported. */
  label: string;
  airline?: string;
  private: boolean;
}

/** The airline's short name: the app's own (Delta) when it has one for the IATA code, else the table's. */
export function airlineShort(entry: [string, string]): string {
  const [name, iata] = entry;
  return (iata && shortAirlineName(iata)) || shortCarrierName(name);
}

export function flightName(callsign: string | undefined, reg: string | undefined, airlines: AirlineTable): FlightName {
  if (isRegistrationCallsign(callsign, reg)) return { label: 'Private', private: true };
  const split = splitCallsign(callsign);
  const entry = split ? airlines[split.icao] : undefined;
  if (split && entry) {
    const airline = airlineShort(entry);
    return { label: `${airline} ${split.number.replace(/^0+(?=\d)/, '')}`, airline, private: false };
  }
  return { label: (callsign || reg || '').trim() || 'Unknown', private: false };
}
