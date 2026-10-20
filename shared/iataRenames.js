// Airport code changes. Data sources lag behind a code change by months (BTS on-time and T-100
// files, OpenFlights) or keep the old code next to the new one (OurAirports keeps the old ident),
// so every script that reads airport codes maps them to the current code here. That way the
// months before and after a change add up to one airport instead of two.
//
// Shared by scripts/etl_ourairports.js, build_us_routes.js, build_t100.js (through shared/t100.js)
// and build_connections.js.

/**
 * One entry per renamed airport: the old and new IATA and ICAO codes, when each changed, and where
 * that is documented.
 */
export const AIRPORT_RENAMES = [
  {
    // Palm Beach International was renamed President Donald J. Trump International Airport.
    // FAA LID PBI -> DJT and ICAO KPBI -> KDJT with the rename on 2026-07-09 (METARs are filed as
    // KDJT); IATA PBI -> DJT on 2026-08-18. BTS files up to July 2026 still say PBI.
    // https://nbaa.org/aircraft-operations/airports/operators-ensure-compliance-as-palm-beach-airport-changes-name/
    // https://en.wikipedia.org/wiki/Palm_Beach_International_Airport
    iata: { from: 'PBI', to: 'DJT', since: '2026-08-18' },
    icao: { from: 'KPBI', to: 'KDJT', since: '2026-07-09' },
  },
];

const IATA_TO_CURRENT = new Map(AIRPORT_RENAMES.map((r) => [r.iata.from, r.iata.to]));
const ICAO_TO_CURRENT = new Map(AIRPORT_RENAMES.map((r) => [r.icao.from, r.icao.to]));

/** The current IATA code for `code` (unchanged when it was never renamed). */
export function currentIata(code) {
  return IATA_TO_CURRENT.get(code) || code;
}

/** The current ICAO code for `code` (unchanged when it was never renamed). */
export function currentIcao(code) {
  return ICAO_TO_CURRENT.get(code) || code;
}

/** The rename entry for an airport by its current IATA code, or undefined. */
export function renameOf(iata) {
  return AIRPORT_RENAMES.find((r) => r.iata.to === iata);
}
