# ETA Tracker

Traffic-aware ETA tracker that periodically queries Google Maps Routes API (computeRoutes) for one or more “trajects” (routes) and logs travel time over time. A lightweight web UI on the same server displays a chart of historical ETAs, with forward (blue) and reverse (red) directions.

## Features

- Multiple trajects: manage from the UI (display name + origin/destination); each traject writes its own CSV in `data/`.
- Traffic-aware durations: Routes API `directions/v2:computeRoutes` with `routingPreference=TRAFFIC_AWARE_OPTIMAL`, `trafficModel=BEST_GUESS`, `departureTime=now`.
- Dual direction logging: logs both origin→destination and destination→origin every interval (default 1 minute).
- Web UI: day view (midnight→midnight), hourly ticks, week navigation, traject selector, recent samples table with both directions.
- Zero server deps: Node.js core only; Chart.js via CDN on the client.

## Setup

1. Ensure Node.js 18+ is installed.
2. Copy `config.example.json` to `config.json` and fill:
   - `apiKey`: Google Maps API key (Routes API enabled).
   - `mode`: e.g. `driving`.
   - `intervalMinutes`: default polling interval (default 1).
   - `port`: HTTP port.

```
cp config.example.json config.json
# edit config.json
```

3. Run the server:

```
node src/server.js
# or
npm start
```

4. Open the UI:

- Visit `http://localhost:8080` (or your configured port).
- Add a traject in the header form (display name optional). You can use plain addresses or coordinates.

## Input formats

Origin and destination accept any of the following:
- Address string, e.g. `1600 Amphitheatre Parkway, Mountain View, CA`.
- Coordinates string `lat,lng`, e.g. `37.422,-122.084`.
- Array `[lat, lng]`.
- Object `{lat, lng}` or `{latitude, longitude}`.

## APIs

- `GET /api/trajects` – List trajects: `{ id, name, origin, destination, mode, intervalMinutes }`.
- `POST /api/trajects` – Add a traject. JSON body supports:
  - `{ name?, origin, destination, mode?, intervalMinutes? }`
  - `origin`/`destination` may be address strings, `"lat,lng"`, `[lat,lng]`, or `{lat,lng}`.
  - Persists to `data/trajects.json` and starts polling immediately.
- `GET /api/eta?id=<trajectId>` – Last collected entries `{ forward, reverse }` for a traject.
- `GET /api/history?id=<trajectId>` – Entire CSV parsed as JSON for a traject.

## Data

- Per‑traject CSV files in `data/`, each with header:
  `timestamp_iso,duration_seconds,distance_meters,status,origin,destination,mode`
- Traject registry at `data/trajects.json`.

## Notes

- Uses Routes API `directions/v2:computeRoutes` with `routingPreference=TRAFFIC_AWARE_OPTIMAL`, `trafficModel=BEST_GUESS`, `departureTime=now`, and reads `routes.duration` (traffic-aware).
- Keep your `config.json` private; `.gitignore` excludes it by default.
- To run as a service, use PM2, systemd, or a Windows Service wrapper.
