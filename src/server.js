import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const TRAJECTS_PATH = path.join(DATA_DIR, 'trajects.json');
const CONFIG_PATH = path.join(ROOT, 'config.json');

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw);
    if (!cfg.apiKey || typeof cfg.apiKey !== 'string' || !cfg.apiKey.trim()) {
      throw new Error('config.apiKey is required');
    }
    cfg.mode = cfg.mode || 'driving';
    cfg.intervalMinutes = Number(cfg.intervalMinutes || 1);
    if (!Number.isFinite(cfg.intervalMinutes) || cfg.intervalMinutes <= 0) cfg.intervalMinutes = 5;
    cfg.port = Number(process.env.PORT || cfg.port || 8080);
    return cfg;
  } catch (err) {
    console.error('[config] Failed to load config.json. Create it from config.example.json');
    throw err;
  }
}

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getLogPathFor(fileName) {
  return path.join(DATA_DIR, fileName);
}

function ensureLogFile(fileName) {
  const p = getLogPathFor(fileName);
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, 'timestamp_iso,duration_seconds,distance_meters,status,origin,destination,mode\n', 'utf-8');
  }
  return p;
}

function sanitizeId(id) {
  return String(id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_') || null;
}

function defaultFileForId(id) {
  return `${id}.csv`;
}

function normalizeLocation(v) {
  if (v == null) return null;
  const num = (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  };
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    // Normalize comma+space variations like "lat, lng"
    return s.replace(/\s*,\s*/g, ',');
  }
  if (Array.isArray(v) && v.length === 2) {
    const a = num(v[0]);
    const b = num(v[1]);
    if (a != null && b != null) return `${a},${b}`;
    return null;
  }
  if (typeof v === 'object') {
    const a = num(v.lat ?? v.latitude);
    const b = num(v.lng ?? v.lon ?? v.longitude);
    if (a != null && b != null) return `${a},${b}`;
  }
  // Fallback
  return String(v).trim();
}

function loadTrajectsFromStore(config) {
  ensureDirs();
  if (!fs.existsSync(TRAJECTS_PATH)) {
    fs.writeFileSync(TRAJECTS_PATH, JSON.stringify([], null, 2), 'utf-8');
  }
  try {
    const raw = fs.readFileSync(TRAJECTS_PATH, 'utf-8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) throw new Error('trajects.json must be an array');
    return list.map((t, i) => {
      if (!t || typeof t !== 'object') throw new Error(`trajects[${i}] invalid`);
      const id = sanitizeId(t.id) || `traj${i + 1}`;
      const origin = normalizeLocation(t.origin ?? (t.originLat != null && t.originLng != null ? { lat: t.originLat, lng: t.originLng } : null)) || '';
      const destination = normalizeLocation(t.destination ?? (t.destinationLat != null && t.destinationLng != null ? { lat: t.destinationLat, lng: t.destinationLng } : null)) || '';
      const mode = t.mode || config.mode || 'driving';
      const intervalMinutes = Number(t.intervalMinutes || config.intervalMinutes || 1);
      const file = t.file || defaultFileForId(id);
      const name = String(t.name || '').trim() || `${origin} -> ${destination}`;
      if (!origin || !destination) throw new Error(`trajects[${i}] missing origin/destination`);
      return { id, name, origin, destination, mode, intervalMinutes, file };
    });
  } catch (e) {
    console.error('[store] Failed to load trajects.json', e);
    return [];
  }
}

function saveTrajectsToStore(list) {
  ensureDirs();
  fs.writeFileSync(TRAJECTS_PATH, JSON.stringify(list, null, 2), 'utf-8');
}

function httpsRequestJson({ host, path: reqPath, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path: reqPath, method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : null;
          resolve({ statusCode: res.statusCode, json });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function isLatLngString(s) {
  if (typeof s !== 'string') return false;
  const m = s.trim().match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  return !!m;
}

function toRoutesWaypoint(value) {
  // value is a normalized string like "lat,lng" or an address string
  if (isLatLngString(value)) {
    const [lat, lng] = value.split(',').map((x) => Number(x.trim()));
    return { location: { latLng: { latitude: lat, longitude: lng } } };
  }
  return { address: String(value) };
}

function modeToRoutes(mode) {
  const m = (mode || 'driving').toLowerCase();
  if (m === 'walking') return 'WALK';
  if (m === 'bicycling' || m === 'bicycle' || m === 'cycling') return 'BICYCLE';
  if (m === 'transit') return 'TRANSIT';
  return 'DRIVE';
}

async function computeRoute({ apiKey, origin, destination, mode }) {
  const reqId = Math.random().toString(36).slice(2, 8);
  console.log(`[routes:${reqId}] request: ${origin} -> ${destination} mode=${modeToRoutes(mode)} depart=now(omitted)`);
  const body = {
    origin: toRoutesWaypoint(origin),
    destination: toRoutesWaypoint(destination),
    travelMode: modeToRoutes(mode),
    routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
    trafficModel: 'BEST_GUESS',
    computeAlternativeRoutes: false,
  };
  const headers = {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': apiKey,
    // Limit fields to what we need
    'X-Goog-FieldMask': 'routes.duration,routes.staticDuration,routes.distanceMeters',
  };
  const { statusCode, json } = await httpsRequestJson({
    host: 'routes.googleapis.com',
    path: '/directions/v2:computeRoutes',
    method: 'POST',
    headers,
    body,
  });
  if (statusCode !== 200) {
    const errObj = json && json.error ? json.error : null;
    console.error(`[routes:${reqId}] error status=${statusCode} details=${JSON.stringify(errObj)}`);
    const msg = errObj && errObj.message ? errObj.message : `HTTP ${statusCode}`;
    throw new Error(msg);
  }
  const route = json && Array.isArray(json.routes) && json.routes[0];
  const durStr = route && route.duration; // e.g., "615s"
  const staticDurStr = route && route.staticDuration; // e.g., "580s"
  const dist = route && route.distanceMeters;
  const toSeconds = (s) => {
    if (!s || typeof s !== 'string') return null;
    const m = s.match(/^(\d+)(?:\.(\d+))?s$/);
    if (!m) return null;
    return Number(m[1]);
  };
  return {
    duration_seconds: toSeconds(durStr),
    static_duration_seconds: toSeconds(staticDurStr),
    distance_meters: Number(dist) || null,
  };
}

// Distance Matrix parsing removed; using Routes v2 instead

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function appendLogTo(fileName, entry) {
  const line = [
    csvEscape(entry.timestamp_iso),
    csvEscape(entry.duration_seconds),
    csvEscape(entry.distance_meters),
    csvEscape(entry.status),
    csvEscape(entry.origin),
    csvEscape(entry.destination),
    csvEscape(entry.mode),
  ].join(',') + '\n';
  const p = getLogPathFor(fileName);
  fs.appendFile(p, line, (err) => {
    if (err) console.error('[log] append error', err);
  });
}

async function collectOnce(config) {
  try {
    const parsed = await computeRoute(config);
    const entry = {
      timestamp_iso: new Date().toISOString(),
      duration_seconds: parsed.duration_seconds,
      distance_meters: parsed.distance_meters,
      status: 'OK',
      origin: config.origin,
      destination: config.destination,
      mode: config.mode,
    };
    console.log(`[routes] success: ${config.origin} -> ${config.destination} dur=${entry.duration_seconds}s dist=${entry.distance_meters}m`);
    appendLogTo(config.__file, entry);
    return entry;
  } catch (err) {
    console.error('[routes] failure:', {
      origin: config.origin,
      destination: config.destination,
      mode: config.mode,
      error: String(err && err.message ? err.message : err),
    });
    const entry = {
      timestamp_iso: new Date().toISOString(),
      duration_seconds: '',
      distance_meters: '',
      status: 'ERROR',
      origin: config.origin,
      destination: config.destination,
      mode: config.mode,
      error: String(err && err.message ? err.message : err),
    };
    appendLogTo(config.__file, entry);
    return entry;
  }
}

function readHistory(fileName) {
  try {
    const raw = fs.readFileSync(getLogPathFor(fileName), 'utf-8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const header = lines.shift();
    const cols = header.split(',');
    const idx = Object.fromEntries(cols.map((c, i) => [c, i]));
    const rows = lines.map((line) => {
      // simple CSV split (no embedded commas in our fields except quoted, which is rare here)
      const parts = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
          if (ch === '"' && line[i + 1] === '"') {
            current += '"';
            i++; // skip escaped quote
          } else if (ch === '"') {
            inQuotes = false;
          } else {
            current += ch;
          }
        } else {
          if (ch === ',') {
            parts.push(current);
            current = '';
          } else if (ch === '"') {
            inQuotes = true;
          } else {
            current += ch;
          }
        }
      }
      parts.push(current);
      const obj = {
        timestamp_iso: parts[idx['timestamp_iso']],
        duration_seconds: parts[idx['duration_seconds']] === '' ? null : Number(parts[idx['duration_seconds']]),
        distance_meters: parts[idx['distance_meters']] === '' ? null : Number(parts[idx['distance_meters']]),
        status: parts[idx['status']],
        origin: parts[idx['origin']],
        destination: parts[idx['destination']],
        mode: parts[idx['mode']],
      };
      return obj;
    });
    return rows;
  } catch (err) {
    return [];
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = url.pathname;
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const exts = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
    };
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': exts[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function main() {
  const config = loadConfig();
  ensureDirs();

  let trajects = loadTrajectsFromStore(config);
  const lastByTraject = {};
  const pollers = new Map();

  function startPoller(t) {
    ensureLogFile(t.file);
    lastByTraject[t.id] = lastByTraject[t.id] || { forward: null, reverse: null };
    collectOnce({ ...t, apiKey: config.apiKey, __file: t.file }).then((e) => (lastByTraject[t.id].forward = e)).catch(() => {});
    collectOnce({ ...t, apiKey: config.apiKey, origin: t.destination, destination: t.origin, __file: t.file }).then((e) => (lastByTraject[t.id].reverse = e)).catch(() => {});
    const intervalMs = (Number(t.intervalMinutes) || config.intervalMinutes || 1) * 60 * 1000;
    const handle = setInterval(async () => {
      try { lastByTraject[t.id].forward = await collectOnce({ ...t, apiKey: config.apiKey, __file: t.file }); } catch {}
      try { lastByTraject[t.id].reverse = await collectOnce({ ...t, apiKey: config.apiKey, origin: t.destination, destination: t.origin, __file: t.file }); } catch {}
    }, intervalMs);
    pollers.set(t.id, handle);
  }

  for (const t of trajects) startPoller(t);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/api/trajects') {
      if (req.method === 'GET') {
        const list = loadTrajectsFromStore(config).map((t) => ({ id: t.id, name: t.name, origin: t.origin, destination: t.destination, mode: t.mode, intervalMinutes: t.intervalMinutes }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            // Accept origin/destination as string, [lat,lng], or {lat,lng}
            let origin = normalizeLocation(data.origin);
            let destination = normalizeLocation(data.destination);
            if (!origin && data.originLat != null && data.originLng != null) {
              origin = normalizeLocation({ lat: data.originLat, lng: data.originLng });
            }
            if (!destination && data.destinationLat != null && data.destinationLng != null) {
              destination = normalizeLocation({ lat: data.destinationLat, lng: data.destinationLng });
            }
            const name = String(data.name || '').trim() || `${origin} -> ${destination}`;
            const id = sanitizeId(data.id) || sanitizeId(name) || sanitizeId(`${origin}_${destination}`) || `traj${Date.now()}`;
            const mode = (data.mode || config.mode || 'driving').trim();
            const intervalMinutes = Number(data.intervalMinutes || config.intervalMinutes || 1);
            if (!origin || !destination) throw new Error('origin and destination are required');
            let list = loadTrajectsFromStore(config);
            if (list.find((t) => t.id === id)) throw new Error('id already exists');
            const file = data.file || defaultFileForId(id);
            const t = { id, name, origin, destination, mode, intervalMinutes, file };
            list.push(t);
            saveTrajectsToStore(list);
            trajects = list;
            startPoller(t);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(t));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
          }
        });
        return;
      }
      res.writeHead(405, { 'Allow': 'GET, POST' });
      res.end('Method Not Allowed');
      return;
    }
    if (url.pathname === '/api/eta') {
      const currentTrajects = loadTrajectsFromStore(config);
      const id = url.searchParams.get('id') || currentTrajects[0]?.id;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ last: lastByTraject[id] || null }));
      return;
    }
    if (url.pathname === '/api/history') {
      const currentTrajects = loadTrajectsFromStore(config);
      const id = url.searchParams.get('id') || currentTrajects[0]?.id;
      const t = currentTrajects.find((x) => x.id === id) || currentTrajects[0];
      const rows = readHistory(t.file);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(rows));
      return;
    }
    // Manual collection endpoint removed; server collects on schedule only.

    // static assets
    return serveStatic(req, res);
  });

  server.listen(config.port, () => {
    console.log(`[server] Listening on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
