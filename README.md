# ETA Tracker

Periodic tracker that queries Google Maps Distance Matrix for a route and logs travel time over time. A lightweight web UI on the same server displays a chart of historical ETAs.

## Features

- Headless poller: collects ETA every N minutes and appends to `data/eta-log.csv`.
- Simple HTTP server: serves API (`/api/history`, `/api/eta`) and static UI.
- Zero dependencies: Node.js core only; Chart.js via CDN on the client.

## Setup

1. Ensure Node.js 18+ is installed.
2. Copy `config.example.json` to `config.json` and fill:
   - `apiKey`: Google Maps API key with Distance Matrix enabled.
   - `origin` / `destination`: human-readable or lat,lng.
   - `mode`: e.g. `driving`.
   - `intervalMinutes`: polling interval.
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

## APIs

- `GET /api/config` – Safe config for UI (no API key).
- `GET /api/eta` – Last collected entry.
- `GET /api/history` – Entire CSV parsed as JSON.
  

## Data

- CSV at `data/eta-log.csv` with header:
  `timestamp_iso,duration_seconds,distance_meters,status,origin,destination,mode`

## Notes

- The server uses Distance Matrix `departure_time=now` and prefers `duration_in_traffic` when available.
- Keep your `config.json` private; `.gitignore` excludes it by default.
- To run as a service, use PM2, systemd, or a Windows Service wrapper.
