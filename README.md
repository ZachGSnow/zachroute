# ZachRoute

**An offline-first airport and route map for your phone: type a code or a city, get live weather, a plain-English forecast, runways, delays and hazards, and the route between two airports drawn the way it is actually flown.**

[![CI](https://github.com/ZachGSnow/zachroute/actions/workflows/ci.yml/badge.svg)](https://github.com/ZachGSnow/zachroute/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

![Route from ORD to DEN: the line is colored by the cruise headwind, a turbulence SIGMET it crosses is outlined, and pilot reports near the route are listed](docs/screenshot-route.png)

| Airport view: runways with numbers, the wind-favored runway in green | On a phone: ORD to LHR |
|---|---|
| ![Denver International with its runways outlined and the forecast, pilot reports and runway sections of the card](docs/screenshot-airport.png) | ![Phone layout of the ORD to LHR route with a tailwind-colored great circle](docs/screenshot-mobile.png) |

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
  (dewpoint and fog risk, ceiling, altimeter, density altitude, wind as the tower states it).
- Forecast (TAF) decoded into an outlook ("Conditions drop to MVFR around Fri 6 AM") and a period list.
- Recent pilot reports of turbulence or icing nearby, in plain English.
- FAA ground stops, ground delay programs and departure/arrival delays, plus active National
  Weather Service alerts (US).
- Runways with dimensions and surface, the wind-favored runway with headwind/crosswind
  components, frequencies, navaids, local time, sunrise or sunset, airport photo and history.
- Nonstop destinations with the airlines that fly them today (US routes).

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
- Weather advisories (AIRMET/SIGMET) the route passes through and pilot reports near it are
  listed and drawn on the map.

**Map layers** (settings menu): nonstop connections, airport size layers, weather stations
(wind arrows, with a ring only when conditions are below VFR), pilot reports, weather hazards,
day/night shading, approach distance ticks, and runway outlines with runway numbers when zoomed in.

**Phone layout**: the results panel is a bottom sheet. Drag its handle between a one-line peek
(map almost full screen), half (the default for a new result) and full; a tap toggles peek and half.

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
npm test          # Vitest: 64 tests
npm run typecheck
```

Every integration is tested against a real response captured from the source on 2026-10-16
(`test/fixtures/`): aviationweather.gov METAR, TAF, PIREP (by airport and by area), METAR by
area and AIRMET/SIGMET; the FAA NAS status XML; NWS alerts; Open-Meteo winds aloft; Wikipedia
search and summaries; OurAirports CSVs; OpenFlights `routes.dat`; and the US DOT on-time CSV.
Each test was confirmed to fail when its parser is deliberately broken. Writing these tests
found a real bug: the FAA parser's `<Delay` pattern also matched `<Delay_type>`, so general
arrival/departure delays were never parsed.

Not verified against real data: the FAA ground-stop XML block (no ground stop was active when
the fixtures were captured; the parser follows the published `AirportStatus.dtd` element names),
and the map UI itself, which has no automated browser tests and was checked by hand. Stadia
domain authentication was checked by HTTP status (200 from the registered domain, 401 otherwise).

## Data sources and licenses

The code is MIT licensed. The data it uses keeps its own terms:

| Data | Source | License |
|---|---|---|
| Airports, runways, frequencies, navaids | [OurAirports](https://ourairports.com/data/) | Public domain |
| Current US routes and airlines | [US DOT Bureau of Transportation Statistics](https://www.transtats.bts.gov) on-time data | Public domain (US government) |
| International routes (`src/data/connections.json`, partly) | [OpenFlights](https://openflights.org/data.php) `routes.dat` | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) |
| Airport history text (`scripts/seed_lore.json`) and photos | [Wikipedia](https://en.wikipedia.org) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Weather, forecasts, pilot reports, advisories | [Aviation Weather Center](https://aviationweather.gov) | Public domain (US government) |
| Delay programs | [FAA NAS Status](https://nasstatus.faa.gov) | Public domain (US government) |
| Weather alerts | [National Weather Service](https://www.weather.gov) | Public domain (US government) |
| Winds aloft | [Open-Meteo](https://open-meteo.com) | CC BY 4.0, free for non-commercial use |
| Map tiles | [Stadia Maps](https://stadiamaps.com), OpenMapTiles, OpenStreetMap | Per provider terms |

OpenFlights' route file has not been updated since 2017, so it is only used for routes outside
the US. For information only: this app is not for navigation or flight planning.

## License

[MIT](LICENSE), Copyright (c) 2026 Zach Snow. Data licenses above.
