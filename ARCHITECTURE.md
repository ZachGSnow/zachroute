# Architecture

ZachRoute is a static TypeScript PWA (Vite, Leaflet) plus a handful of Cloudflare Pages Functions.
The browser does all the math and rendering; the functions only proxy, trim and cache upstream
APIs. Build-time scripts turn public datasets into the bundled data.

```
public datasets --(scripts/, build time)--> public/data/airports.json, src/data/*.json
                                                        |
browser (src/ts) <--------------------------------------+
   |   search, cards, map, geometry, decoding
   +--> /api/* (functions/api, Cloudflare Pages Functions) --> upstream APIs
   |        trims responses, caches in KV for minutes
   +--> CORS-enabled APIs called directly (NWS alerts, Open-Meteo, Wikipedia REST)
```

## Source layout

| Path | Role |
|---|---|
| `src/ts/main.ts` | Boot, search box, history and shareable links (`runSearch` is the single entry point), wiring of every setting |
| `src/ts/focusTarget.ts` | Tap to focus: the shapes and points each chip or row frames on the map (NWS areas or zone outlines, storms, TFRs, advisories, reports), their bounds, and the registry behind `data-focus`; `mapOverlays.focusOn` draws the highlight |
| `src/ts/prefs.ts` | Route drawing and airport card choices stored by the settings window: what to draw along a route, route focus, how alerts and card sections start |
| `src/ts/features.ts`, `settingsPanel.ts` | Every setting the app offers (section, label, one-line description, input ids) and the settings window built from it: folding sections, on/off switches, segmented sub-options over hidden selects, turn off all, reset |
| `src/ts/suggestList.ts` | Suggestion dropdown (keyboard, tap, utility rows) |
| `src/ts/history.ts` | Recent searches and favorite airports (device-only `localStorage`) |
| `src/ts/sheet.ts` | Phone bottom sheet: peek / half / full, drag and tap |
| `src/ts/nearby.ts` | Airports near me: geolocation and nearest-airport ranking |
| `src/ts/units.ts` | Display units: distance, 12/24-hour clock, and US or metric weather (temperature, pressure, visibility; default from the device region) |
| `src/ts/searchParser.ts` | Code / name / route parsing and ranking |
| `src/ts/uiRenderer.ts` | Airport card and route panel |
| `src/ts/mapRenderer.ts` | Leaflet map: base map style, routes, connections, connecting itineraries, airport layers |
| `src/ts/baseMap.ts` | Base map tile sources and credits: Stadia dark and light, EOX Sentinel-2 cloudless satellite with Stadia labels |
| `src/ts/mapOverlays.ts` | Weather stations, AIRMET/SIGMET, pilot reports, day/night, runway outlines, hazards along a route, volcanic ash near an airport |
| `src/ts/cyclones.ts` | Tropical cyclones near an airport (center within 300 mi or inside the forecast cone) and along a route (150 mi or through the cone) |
| `src/ts/hazardGeo.ts` | Advisory polygon geometry without Leaflet: point in polygon (antimeridian-aware), distance to a polygon, advisories near a point |
| `src/ts/approach.ts` | Runway-end geometry: extended centerline, 3 degree glide ticks, departure leg, path smoothing |
| `src/ts/forecast.ts`, `pirepText.ts`, `weather.ts`, `advisories.ts` | Plain-English decoding of TAF, PIREP, METAR, FAA status and NWS alerts |
| `src/ts/fires.ts` | Fire detections by map rectangle and the 50-mile summary on the airport card |
| `src/ts/aerosolTiles.ts` | Dust and smoke layer source (NASA GIBS, daily OMPS aerosol index) and the pixel filter that drops clean-air greys so the dark base map stays readable |
| `src/ts/windsAloft.ts` | Cruise-level winds along a route (Open-Meteo) |
| `src/ts/airQuality.ts` | Air quality, haze and smoke at an airport (Open-Meteo air-quality API): AQI bands, haze note, 12-hour worsening check |
| `src/ts/geoMath.ts` | Great circle, bearings, destination points, block time |
| `src/ts/connections.ts`, `carriers.ts` | Nonstop topology, one/two-stop search, airlines per route |
| `functions/api/*.ts` | `weather`, `taf`, `pireps`, `metar-bbox`, `airsigmet`, `cyclones`, `fires`, `faa-status`, `lore` |
| `shared/userAgent.ts` | User-Agent for upstream calls, built from `package.json` |
| `scripts/` | Data pipeline (below), and `capture-screenshots.mjs`, which captures the README screenshots from the running app with headless Chrome or Edge |

## Data pipeline (build time)

1. `scripts/etl_ourairports.js` downloads six OurAirports CSVs and builds `public/data/airports.json`:
   large and medium airports plus anything with an IATA code or in the seed set (about 9,800).
   Each airport is stored once under its IATA code (else ICAO); ICAO and FAA codes are string
   aliases resolved at load time. It joins runways (with end coordinates and true headings),
   frequencies, navaids, region and country names, an IANA time zone (offline, `geo-tz`) and the
   magnetic declination (World Magnetic Model, `geomagnetism`), and the airport's English Wikipedia
   title from Wikidata (`scripts/wikidata_titles.js`: ICAO code first, then IATA, looked up in
   batches of 300; skipped with a warning if Wikidata is down). About 8 MB, fetched at runtime
   rather than bundled so the JS stays small, and precached for offline use.
2. `scripts/build_us_routes.js` downloads four months of US DOT on-time data (spread across
   seasons), keeps each route and airline with at least 8 flights in a month, and writes
   `src/data/us-routes.json`. A route seen in only some months is marked seasonal.
3. `scripts/build_connections.js` merges routes into `connections.json` and `carriers.json`.
   US-to-US pairs come only from the DOT data plus `route_overrides.json`; OpenFlights
   (frozen since 2017) fills in everything else.
4. `scripts/prefetch_wiki_lore.js [HUB]` pre-downloads Wikipedia summaries for a hub and its
   nonstop destinations into `scripts/seed_lore.json`. Other airports load their summary on demand.

The pure parts of each script (`buildRecords`, `countMonth`, `mergeRoutes`) are exported and
tested against real samples of each file format.

## Pages Functions and caching

Each function validates its input, calls one upstream source with an identifying User-Agent,
trims the response to what the client renders, and caches it in the `LORE_KV` namespace:

| Endpoint | Upstream | KV TTL |
|---|---|---|
| `/api/weather?icao=` | aviationweather.gov METAR | 10 min |
| `/api/taf?icao=` | aviationweather.gov TAF | 15 min |
| `/api/pireps?icao=` or `?bbox=` | aviationweather.gov PIREP (bbox mode keeps only notable reports) | 5 min |
| `/api/metar-bbox?bbox=` | aviationweather.gov METAR by area (category, wind, temperature and dewpoint per station) | 5 min |
| `/api/airsigmet` | aviationweather.gov US AIRMET/SIGMET, international SIGMET and US center weather advisories, merged (multi-area SIGMETs split into one polygon each; rings unwrapped across the antimeridian) | 5 min |
| `/api/faa-status` | FAA NAS status XML (closures ignored: the feed mixes partial NOTAM closures with real ones) | 5 min |
| `/api/cyclones` | GDACS event list plus one geometry request per current tropical cyclone, trimmed to position, track and a thinned forecast cone | 30 min |
| `/api/fires?bbox=` | NASA FIRMS MODIS global 24-hour CSV (about 1 MB, cached at the Cloudflare edge); scanned line by line keeping only the rectangle and confidence >= 50, so it stays within a function's CPU budget | 30 min |
| `/api/afd?lat=&lon=` | api.weather.gov: the forecast office for the position (cached 30 days), then the `.AVIATION` section of its latest forecast discussion | 30 min |
| `/api/tfr` | FAA TFR map service (shapes) joined with the FAA TFR list (only active TFRs; several shapes of one TFR merged) | 10 min |
| `/api/lore?iata=&title=&name=&lat=&lon=` | Wikipedia page summary: the article Wikidata or OurAirports links to, else a search by name, then by code, keeping only a hit that is an airport article near the airport (`shared/wikiLore.js`); 404 when none is | 7 days |

Upstream failures return `{available: false}` or an empty list, and the card simply omits that
section. NWS alerts, Open-Meteo and Wikipedia photos send CORS headers, so the browser calls them
directly.

## Search

Codes resolve first (two codes in a row are a route). Then an explicit separator ("to", "->",
" - "). Then a ranked name search where every query word must prefix-match the airport's city,
name, alternate names (OurAirports `keywords`) or location hints (region code, state, country
and common names like "uk"). Hint words narrow the match but are ignored when judging how exact
the name is, so `portland me` is an exact city match for PWM. Ranking adds airport size,
passenger service and the number of nonstop destinations, since the source `type` field alone
does not separate a hub from a nearby field. Two places with no separator (`chicago denver`) try
every split point and keep the one where both sides match best.

## Search box (2.5)

Typing only updates the suggestion list (`suggest` in `searchParser.ts`): an exact code first, then
code prefixes, then name matches; once a first airport is settled ("chicago den", "ord to d"),
route suggestions come first. A search runs, and gets one history entry and one recent-search
entry, only when a suggestion is picked or Enter is pressed. An empty, focused box lists favorites
then recent searches.

## Phone layout (2.5)

At 768 px and narrower the results panel is a bottom sheet. `sheet.ts` sets `--sheet-h` on
`.main-content` (peek 64 px, half 45%, full 100%) and calls `map.invalidateSize()` after the height
transition so Leaflet re-measures. New results open at half; the last position is remembered.

## Map

- **Direct route**: the great circle, joined to a departure leg off the origin runway and the
  destination's 10 nm final approach, smoothed with Chaikin corner cutting. Runway ends start as
  the ones aligned with the route and switch to the wind-favored ends once the cards load
  weather. Drawn as short segments so it can be colored by the headwind interpolated from seven
  Open-Meteo samples. The approach geometry is schematic, not a published procedure.
- **Dust and smoke**: NASA GIBS tiles of the daily OMPS aerosol index, drawn through a canvas
  (GIBS sends CORS headers) that makes grey, white and pale pixels transparent and fades the rest
  by how strongly colored they are, so only real plumes show over the dark base map.
- **Connecting routes**: each itinerary is a chain of great-circle legs unwrapped continuously
  across the dateline. The selected one is styled like a direct route with stop labels and
  per-leg pills; three alternatives are drawn faded, the rest on request.
- **Overlays**: weather stations are wind arrows with a category ring only below VFR, decluttered
  to major airports when zoomed out. Runway outlines and numbers appear by zoom level (CSS classes
  on the map container, no re-render). Hazards along a route are found by sampling the route and
  testing points against AIRMET/SIGMET polygons, so a very narrow advisory can be missed.

## Weather details worth knowing

- METAR and TAF winds are referenced to true north, like OurAirports runway headings and route
  bearings, so the favored-runway and crosswind math needs no magnetic correction. The card also
  shows the wind converted to magnetic, the way a tower or ATIS states it.
- The wind-adjusted block time uses forecast winds at a pressure level picked by trip length
  (250, 500 or 700 hPa, about 34,000, 18,000 and 10,000 ft). It falls back to the origin's surface
  wind when the forecast is unavailable.

## Service worker and updates

`vite-plugin-pwa` generates the service worker at build time with a revisioned precache manifest,
so every deploy produces a new worker; `skipWaiting` and `clientsClaim` make it take over on the
next launch. Lore and weather API responses are network-first with a cache fallback; Leaflet from
unpkg is cache-first (version-pinned). Map tiles and the other API calls are network-only.
`index.html` links the manifest and the generated icons; all three (manifest link, valid icons,
registered worker) are needed for Chrome to offer a real install instead of a shortcut.

## Deployment

Cloudflare Pages, direct upload: `npm run build`, then
`npx wrangler pages deploy dist --project-name=<project> --branch=main`. The project's production
branch is `main`; any other branch name creates a preview. `wrangler.toml` holds the KV namespace
IDs and is not committed (see `wrangler.toml.example`). No secrets are required.
