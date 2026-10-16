# ZachRoute

**An offline-first airport and route map for your phone, for anywhere in the world: type a code or a city, get live weather, a plain-English forecast, runways, delays and hazards (thunderstorms, volcanic ash, tropical cyclones, smoke and dust), and the route between two airports drawn the way it is actually flown.**

[![CI](https://github.com/ZachGSnow/zachroute/actions/workflows/ci.yml/badge.svg)](https://github.com/ZachGSnow/zachroute/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

![Guam to Tokyo Narita: the route passes through Typhoon Champi's forecast cone, drawn with its past and forecast track, and the tropical cyclone SIGMETs it crosses are listed](docs/screenshot-route.png)

| Airport view: Palembang, Indonesia, with smoke from nearby fires | On a phone: Jakarta to Bali crosses volcanic ash |
|---|---|
| ![Palembang airport card: very poor visibility, unhealthy air quality with a haze note, and satellite fire detections around the airport on the map](docs/screenshot-airport.png) | ![Phone layout of the Jakarta to Bali route with the volcanic ash warning for Mt Semeru](docs/screenshot-mobile.png) |

![The dust and smoke layer over Africa and the Middle East, with a Saharan dust plume over West Africa](docs/screenshot-dust.png)

## Why

Aviation data is free and public, but it is scattered across a dozen sites and written in
shorthand (`TAF KORD 161120Z 1612/1718 28012KT P6SM BKN035`). I wanted one fast page that answers
"what is happening at this airport and on this route right now" in plain English, works when the
signal drops, and installs on a phone like an app. It started as a companion to a FlightWall
display: see a plane overhead, look up where it is going.

## Features

**Search**
- Airport codes (IATA, ICAO, FAA), city or airport names, and routes: `ORD`, `Chicago`, `ORD DEN`,
  `Chicago to Denver`, `chicago denver`, `portland me`, `london uk`.
- Suggestions appear as you type (airports, and routes once the first airport is settled); the map
  only changes when you pick one or press Enter.
- Focusing the empty search box lists your favorite airports and last 8 searches (kept on the
  device only). Star an airport on its card to make it a favorite; favorites also appear on the
  start screen.
- Ranks the airport you most likely mean (by nonstop destinations) and offers the others in the
  same city as one-tap chips.
- Every result has a shareable link (`?q=ORD+DEN`); the Android back button returns to the
  previous search.

**Airport card**
- Current conditions from the latest METAR in plain English, with a "More details" section
  (dewpoint and fog risk, ceiling, altimeter or QNH, density altitude, wind as the tower states it).
- Forecast (TAF) decoded into an outlook ("Conditions drop to MVFR around Fri 6 AM") and a period list.
- Recent pilot reports of turbulence or icing nearby, in plain English.
- Runways with dimensions and surface, the wind-favored runway with headwind/crosswind
  components, frequencies, navaids, local time, sunrise or sunset, airport photo and history.
- Nonstop destinations with the airlines that fly them today (US routes).

**Hazards and air near an airport** (worldwide unless noted)
- Volcanic ash over or within 100 miles of the airport, from international SIGMETs.
- Tropical cyclones (hurricanes, typhoons, cyclones in every ocean) within 300 miles, or whose
  forecast cone covers the airport, even when the storm is still far away.
- Air quality: the US AQI, or the European AQI at European airports, with PM2.5, a note when
  smoke, dust or haze may reduce visibility, and a heads-up when it is forecast to get worse in the
  next 12 hours.
- Satellite fire and heat detections within 50 miles in the last 24 hours, with the most intense
  one's distance and direction.
- US only: FAA ground stops, ground delay programs and departure/arrival delays, and active
  National Weather Service alerts.

**Airports near me**: the location button lists the 5 closest airports with scheduled-service codes,
with distance, direction and current flight category, and shows them on the map. The position is
used once and not stored; denying permission just shows a message.

**Routes**
- Great-circle distance, block time, and a wind-adjusted block time from forecast winds at
  cruise altitude.
- The route line leaves along the departure runway and joins the destination's final approach,
  and is colored by headwind or tailwind.
- When there is no nonstop, one-stop and two-stop connections are drawn and listed; the selected
  itinerary shows per-leg distance and time.
- Weather advisories the route passes through are listed and drawn: US AIRMETs and SIGMETs, and
  international SIGMETs worldwide (thunderstorms, turbulence, icing, volcanic ash, tropical
  cyclones), each with the flight information region (FIR) that issued it. Volcanic ash gets its
  own warning at the top, since flights avoid it at every altitude.
- Tropical cyclones the route passes within 150 miles of, or through the forecast cone of.
- Pilot reports of turbulence or icing near the route.

**Map layers** (settings menu): nonstop connections, airport size layers, weather stations
(wind arrows, with a ring only when conditions are below VFR), pilot reports, weather hazards,
tropical cyclones (track, forecast track and uncertainty cone), fires detected by satellite in the
last 24 hours, dust and smoke from space (the latest daily pass), day/night shading, approach
distance ticks, and runway outlines with runway numbers when zoomed in.

**Phone layout**: the results panel is a bottom sheet. Drag its handle between a one-line peek
(map almost full screen), half (the default for a new result) and full; a tap toggles peek and half.

**Units**: distances in miles, kilometers or nautical miles, a 12 or 24-hour clock, and weather in US
units (F, inHg, miles) or metric (C, QNH in hPa, visibility in km or metres, read straight from the
METAR where it is reported in metres). Settings menu; miles and 12-hour by default, and weather units
follow the device's region. Wind stays in knots and altitudes in feet, as aviation sources report them
worldwide.

**App**: installs as a PWA, works offline after the first load (the airport database is
precached), and updates itself after a deploy. The About screen shows the version and build time.

## Quick start

Requires Node.js 20 or newer.

```bash
git clone https://github.com/ZachGSnow/zachroute.git
cd zachroute
npm ci
node scripts/etl_ourairports.js     # builds public/data/airports.json (about 8 MB) from OurAirports
npm run dev                          # app at http://localhost:5173 (no /api endpoints)
```

The `/api/*` endpoints (weather, forecast, FAA status, ...) are Cloudflare Pages Functions. To run
them locally:

```bash
cp wrangler.toml.example wrangler.toml
npm run build
npx wrangler pages dev dist          # app plus /api at http://localhost:8788
```

Deploy to your own Cloudflare Pages project:

```bash
npm run build
npx wrangler pages deploy dist --project-name=<your-project> --branch=main
```

## Configuration

| Setting | Where | Notes |
|---|---|---|
| KV namespace IDs | `wrangler.toml` (copy of `wrangler.toml.example`, gitignored) | Create with `npx wrangler kv namespace create LORE_KV` (and `--preview`). KV caches upstream responses for a few minutes; the app works without it. |
| Map tiles | [Stadia Maps](https://stadiamaps.com) dashboard | Tiles use Stadia domain authentication: add your site's domain in the dashboard. `localhost` works without registration. No API key is stored in the code. |
| User-Agent for upstream APIs | `package.json` `name`, `version`, `homepage` | Sent with every request to aviationweather.gov, the FAA and Wikipedia, which ask callers to identify themselves. |
| Route corrections | `scripts/route_overrides.json` | Add or remove nonstop routes the source data gets wrong (small airlines are not in the DOT data). |
| Starter lore set | `node scripts/prefetch_wiki_lore.js [HUB]` | Pre-downloads Wikipedia summaries for a hub and its nonstop destinations (default `ORD`). |

### Refreshing the data

```bash
npm run data   # OurAirports ETL + US DOT routes (downloads about 130 MB) + route merge
```

Run it every few months. The route merge refuses to run without the airport database so US
routes never silently fall back to stale data.

## How it works

A static TypeScript app (Vite, Leaflet) with a small set of Cloudflare Pages Functions that proxy
and trim upstream APIs and cache them in KV. All math (great circles, winds, approach geometry,
search ranking, forecast decoding) runs in the browser. Build-time scripts turn public datasets
into the bundled airport and route data. See [ARCHITECTURE.md](ARCHITECTURE.md) for the design
and the reasoning behind the main decisions.

## Testing

```bash
npm test          # Vitest: 120 tests
npm run typecheck
```

Every integration is tested against a real response captured from the source on 2026-10-16
(`test/fixtures/`): aviationweather.gov METAR, TAF, PIREP (by airport and by area), METAR by
area, AIRMET/SIGMET and international SIGMET; the FAA NAS status XML; NWS alerts; GDACS tropical
cyclones; NASA FIRMS fire detections; Open-Meteo winds aloft and air quality; Wikipedia search and
summaries; OurAirports CSVs; OpenFlights `routes.dat`; and the US DOT on-time CSV. Each test was
confirmed to fail when its parser is deliberately broken. Writing these tests found real bugs: the
FAA parser's `<Delay` pattern also matched `<Delay_type>`, so general arrival/departure delays
were never parsed; and the international SIGMET feed lists some SIGMETs twice.

Not verified against real data: the FAA ground-stop XML block (no ground stop was active when
the fixtures were captured; the parser follows the published `AirportStatus.dtd` element names),
and the map UI itself, which has no automated browser tests and was checked by hand.
Stadia domain authentication was checked by HTTP status (200 from the registered domain, 401
otherwise).

The README screenshots come from the running app: `node scripts/capture-screenshots.mjs` drives
a local Chrome or Edge in headless mode against `npx wrangler pages dev dist` and writes
`docs/screenshot-*.png`.

## Data sources, freshness and licenses

The code is MIT licensed. The data it uses keeps its own terms. Freshness was measured on
2026-10-16; "In the app" is the most the app's own caching adds on top of the source.

| Data | Source | Updates at the source | In the app | License |
|---|---|---|---|---|
| Current weather (METAR) | [Aviation Weather Center](https://aviationweather.gov) | Hourly, plus special reports when conditions change | Up to 10 min | Public domain (US government) |
| Forecasts (TAF) | Aviation Weather Center | Every 6 hours (3 in some countries), plus amendments | Up to 15 min | Public domain (US government) |
| Pilot reports | Aviation Weather Center | As pilots file them; the last 3 hours are shown | Up to 5 min | Public domain (US government) |
| AIRMETs, SIGMETs, international SIGMETs | Aviation Weather Center | AIRMETs every 6 hours; SIGMETs when issued, valid up to 4 hours (6 for ash and cyclones) | Up to 5 min; the map layer redraws every 5 min | Public domain (US government) |
| Delay programs (US) | [FAA NAS Status](https://nasstatus.faa.gov) | Continuously | Up to 5 min | Public domain (US government) |
| Weather alerts (US) | [National Weather Service](https://www.weather.gov) | Real time | Up to 5 min | Public domain (US government) |
| Tropical cyclones (from NHC, JTWC and other agencies) | [GDACS](https://www.gdacs.org), the UN / European Commission Global Disaster Alert and Coordination System | Each storm's advisory every 6 hours, republished by GDACS 1-6 hours later (storms were 5-14 hours past their advisory time when measured) | Up to 30 min | Free to use; provided as is, for information only (credited in the app) |
| Air quality (Copernicus CAMS models) | [Open-Meteo](https://open-meteo.com) | Hourly model values from model runs twice a day: estimates, not station measurements | Up to 30 min | CC BY 4.0, free for non-commercial use; contains Copernicus Atmosphere Monitoring Service information |
| Winds aloft | Open-Meteo | Hourly model values | Up to 15 min | CC BY 4.0, free for non-commercial use |
| Fire and heat detections (MODIS) | [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov) | A few satellite passes per place per day, published about 3 hours later; the app keeps the last 24 hours | Up to 30 min | Free and open (NASA); credited in the app |
| Dust and smoke layer (OMPS aerosol index, NOAA-20) | [NASA GIBS](https://nasa-gibs.github.io/gibs-api-docs/) | One pass per place per day, around 13:30 local time; the app shows today's pass where it has happened and yesterday's elsewhere | Redraws hourly | Free and open (NASA); credited on the map |
| Airport history text and photos | [Wikipedia](https://en.wikipedia.org) | As edited | Up to 7 days | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Airports, runways, frequencies, navaids | [OurAirports](https://ourairports.com/data/) | Nightly | When you run `npm run data` | Public domain |
| Current US routes and airlines | [US DOT Bureau of Transportation Statistics](https://www.transtats.bts.gov) on-time data | Monthly, about 3 months behind | When you run `npm run data` | Public domain (US government) |
| International routes | [OpenFlights](https://openflights.org/data.php) `routes.dat` | Not updated since 2017 | When you run `npm run data` | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) |
| Map tiles | [Stadia Maps](https://stadiamaps.com), OpenMapTiles, OpenStreetMap | Per provider | Not cached | Per provider terms |

An airport card loads its data when you search and does not refresh while it is open; search
again for newer data. The last weather and history seen for an airport stay available offline.
OpenFlights' route file is old, so it is only used for routes outside the US. For information
only: this app is not for navigation or flight planning.

## License

[MIT](LICENSE), Copyright (c) 2026 Zach Snow. Data licenses above.
