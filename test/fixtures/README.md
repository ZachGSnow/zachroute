# Test fixtures

Real responses captured from each source on 2026-10-16, trimmed to a few records with the
structure left untouched. They contain only public aviation, weather and geographic data.

| File | Source |
|---|---|
| `awc-metar-kord.json`, `awc-taf-kord.json` | aviationweather.gov `/api/data/metar`, `/taf` for KORD |
| `awc-pirep-kord.json`, `awc-pirep-bbox.json` | aviationweather.gov `/api/data/pirep` by airport and by area |
| `awc-metar-bbox.json`, `awc-airsigmet.json` | aviationweather.gov METAR by area, AIRMET/SIGMET |
| `awc-cwa.json` | aviationweather.gov `/api/data/cwa`: two Center Weather Advisories from Miami Center for thunderstorms, captured 2026-10-19 |
| `awc-gairmet-f00.json`, `awc-gairmet-f03.json` | aviationweather.gov `/api/data/gairmet` with `fore=0` and `fore=3`: the 21:00 and 00:00 UTC snapshots of the 19 Oct 21Z issuance, trimmed to one or two areas of each hazard plus freezing level lines |
| `awc-tcf.json` | aviationweather.gov `/api/data/tcf?format=geojson`: the 19 Oct 23Z TFM Convective Forecast, five sparse, high-confidence areas for 03Z, 05Z and 07Z |
| `iem-n0q-5-6-12.png`, `iem-eet-5-6-12.png`, `iem-n0q-0.json`, `iem-eet-0.json` | Iowa Environmental Mesonet NEXRAD tiles (zoom 5, x 6, y 12: storms over New Mexico), base reflectivity and echo tops, and the reflectivity composite's time sidecar (`iem-eet-0.json` is the echo tops one), captured 2026-10-19 23:30 UTC |
| `rainviewer-5-15-11.png`, `rainviewer-weather-maps.json` | RainViewer radar tile over Europe (zoom 5, Universal Blue, no smoothing) and its frame index, captured 2026-10-19 |
| `eumetsat-mtg-capabilities.xml`, `eumetsat-iodc-5-24-15.png` | view.eumetsat.int: the Meteosat-12 infrared layer's own capabilities (newest image 23:30 UTC), and a Meteosat-9 infrared tile over the Indian Ocean (zoom 5, x 24, y 15) at 22:00 UTC, captured 2026-10-19 |
| `spc-day1-cat.json`, `spc-day2-cat.json` | spc.noaa.gov categorical convective outlooks (GeoJSON), day 1 issued 19:58 UTC (general thunderstorms and a marginal risk) and day 2, captured 2026-10-19 |
| `nhc-current-storms.json`, `nhc-ep1-cone.json`, `nhc-ep1-forecast-points.json`, `nhc-ep1-past-points.json`, `nhc-mapserver-layers.json` | NHC CurrentStorms.json with Tropical Storm Trudy (advisory 26, 21:00 UTC), and her forecast cone, forecast points and best-track points from mapservices.weather.noaa.gov (GeoJSON), plus that service's layer list trimmed to the EP1 and AT1 layers, captured 2026-10-19 |
| `usgs-quakes-4.5-day.json`, `usgs-elevated-volcanoes.json`, `usgs-volcano-311120.json` | USGS M4.5+ day feed (trimmed to the 6 strongest and 6 weakest), the US volcanoes at an elevated alert (Great Sitkin ORANGE, three YELLOW) and Great Sitkin's volcano record, captured 2026-10-19 |
| `awc-isigmet.json` | aviationweather.gov international SIGMET: volcanic ash, tropical cyclone, thunderstorm, turbulence, icing, one multi-area record and two without a usable polygon |
| `faa-status-delays.xml` | nasstatus.faa.gov airport status, captured 2026-10-16 01:00 UTC while delay programs were active |
| `faa-status-closures.xml` | the same feed later that morning (closures only) |
| `faa-tfr-shapes.json`, `faa-tfr-list.json` | FAA TFR map service (WFS GeoJSON) and TFR list, captured 2026-10-19, trimmed to four TFRs (one with two shapes); the hazards TFR is left off the list to stand in for one no longer active |
| `gdacs-events.json` | GDACS current events list: the four active tropical cyclones and one earthquake |
| `gdacs-tc-geometry.json` | GDACS geometry for Typhoon Champi (JTWC, 16 Oct 12:00 UTC): track points, track segments and forecast cone; wind-swath polygons dropped and track-point circles thinned to every 8th vertex |
| `firms-modis-24h.csv` | NASA FIRMS MODIS global 24-hour file: header plus 20 confident and 4 low-confidence detections around Palembang, Indonesia, and 5 elsewhere |
| `nws-points-ord.json`, `nws-office-lot.json`, `nws-afd-list-lot.json`, `nws-afd-lot.json` | api.weather.gov point lookup for ORD (trimmed to the office fields), the Chicago office, its forecast discussion list (first two) and the latest discussion, captured 2026-10-19 |
| `nws-alerts.json` | api.weather.gov active alerts, trimmed to the fields the app reads (event, severity, headline, expires) |
| `open-meteo-aq-del.json`, `-pek.json`, `-syd.json` | air-quality-api.open-meteo.com current and hourly air quality for Delhi (unhealthy, hazy), Beijing (hazy, worse later) and Sydney (good), 18:00 UTC |
| `open-meteo-250hpa-7pts.json` | api.open-meteo.com winds at 250 hPa for seven points between ORD and DEN |
| `open-meteo-250hpa-fzl-7pts.json`, `open-meteo-fzl-anc.json` | The same request with the freezing level added, and the current freezing level over Anchorage, captured 2026-10-19 |
| `wikipedia-search-ord.json`, `wikipedia-summary-ord.json` | Wikipedia search API and REST page summary |
| `wikipedia-search-her-*.json`, `wikipedia-summary-her*.json`, `wikipedia-summary-lhr.json` | The same for Heraklion (HER), captured 2026-10-19: searches by code and by name, the "Her" disambiguation page, the airport's article, and Heathrow's |
| `wikidata-titles-icao.json`, `wikidata-titles-iata.json` | query.wikidata.org SPARQL: English Wikipedia titles for a few ICAO and IATA codes, captured 2026-10-19 |
| `ourairports-*.csv` | OurAirports CSVs, header plus rows for KORD, KDEN, KMDW and EGLL |
| `openflights-routes.dat` | OpenFlights `routes.dat`, a few rows each for ORD, DEN and LHR |
| `bts-ontime-sample.csv` | US DOT BTS on-time performance, July 2026, header plus ORD rows |
| `airports-subset.json` | Output of `scripts/etl_ourairports.js` for the airports the search tests use |
