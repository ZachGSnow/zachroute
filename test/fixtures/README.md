# Test fixtures

Real responses captured from each source on 2026-10-16, trimmed to a few records with the
structure left untouched. They contain only public aviation, weather and geographic data.

| File | Source |
|---|---|
| `awc-metar-kord.json`, `awc-taf-kord.json` | aviationweather.gov `/api/data/metar`, `/taf` for KORD |
| `awc-pirep-kord.json`, `awc-pirep-bbox.json` | aviationweather.gov `/api/data/pirep` by airport and by area |
| `awc-metar-bbox.json`, `awc-airsigmet.json` | aviationweather.gov METAR by area, AIRMET/SIGMET |
| `faa-status-delays.xml` | nasstatus.faa.gov airport status, captured 2026-10-16 01:00 UTC while delay programs were active |
| `faa-status-closures.xml` | the same feed later that morning (closures only) |
| `nws-alerts.json` | api.weather.gov active alerts, trimmed to the fields the app reads (event, severity, headline, expires) |
| `open-meteo-250hpa-7pts.json` | api.open-meteo.com winds at 250 hPa for seven points between ORD and DEN |
| `wikipedia-search-ord.json`, `wikipedia-summary-ord.json` | Wikipedia search API and REST page summary |
| `ourairports-*.csv` | OurAirports CSVs, header plus rows for KORD, KDEN, KMDW and EGLL |
| `openflights-routes.dat` | OpenFlights `routes.dat`, a few rows each for ORD, DEN and LHR |
| `bts-ontime-sample.csv` | US DOT BTS on-time performance, July 2026, header plus ORD rows |
| `airports-subset.json` | Output of `scripts/etl_ourairports.js` for the airports the search tests use |
