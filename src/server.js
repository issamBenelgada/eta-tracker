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
const LOG_PATH = path.join(DATA_DIR, 'eta-log.csv');
const CONFIG_PATH = path.join(ROOT, 'config.json');

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw);
    const required = ['apiKey', 'origin', 'destination'];
    for (const k of required) {
      if (!cfg[k] || typeof cfg[k] !== 'string' || !cfg[k].trim()) {
        throw new Error(`config.${k} is required`);
      }
    }
    cfg.mode = cfg.mode || 'driving';
    cfg.intervalMinutes = Number(cfg.intervalMinutes || 5);
    if (!Number.isFinite(cfg.intervalMinutes) || cfg.intervalMinutes <= 0) {
      cfg.intervalMinutes = 5;
    }
    cfg.port = Number(process.env.PORT || cfg.port || 8080);
    return cfg;
  } catch (err) {
    console.error('[config] Failed to load config.json. Create it from config.example.json');
    throw err;
  }
}

function ensureDirsAndLog() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOG_PATH)) {
    fs.writeFileSync(
      LOG_PATH,
      'timestamp_iso,duration_seconds,distance_meters,status,origin,destination,mode\n',
      'utf-8'
    );
  }
}

function buildDistanceMatrixUrl({ apiKey, origin, destination, mode }) {
  const params = new URLSearchParams({
    origins: origin,
    destinations: destination,
    departure_time: 'now',
    mode: mode || 'driving',
    key: apiKey,
  });
  return `https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`;
}

function httpsJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve({ statusCode: res.statusCode, json });
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function parseDistanceMatrixResponse(json) {
  // See: https://developers.google.com/maps/documentation/distance-matrix
  const status = json.status || 'UNKNOWN';
  const row = json.rows && json.rows[0];
  const el = row && row.elements && row.elements[0];
  const elStatus = el && el.status;
  const distance = el && el.distance && el.distance.value; // meters
  const duration = el && el.duration && el.duration.value; // seconds
  const durationTraffic = el && el.duration_in_traffic && el.duration_in_traffic.value; // seconds
  return {
    apiStatus: status,
    elementStatus: elStatus,
    distance_meters: Number(distance) || null,
    duration_seconds: Number(durationTraffic || duration) || null,
  };
}

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function appendLog(entry) {
  const line = [
    csvEscape(entry.timestamp_iso),
    csvEscape(entry.duration_seconds),
    csvEscape(entry.distance_meters),
    csvEscape(entry.status),
    csvEscape(entry.origin),
    csvEscape(entry.destination),
    csvEscape(entry.mode),
  ].join(',') + '\n';
  fs.appendFile(LOG_PATH, line, (err) => {
    if (err) console.error('[log] append error', err);
  });
}

async function collectOnce(config) {
  const url = buildDistanceMatrixUrl(config);
  try {
    const { statusCode, json } = await httpsJson(url);
    if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);
    const parsed = parseDistanceMatrixResponse(json);
    const entry = {
      timestamp_iso: new Date().toISOString(),
      duration_seconds: parsed.duration_seconds,
      distance_meters: parsed.distance_meters,
      status: parsed.elementStatus || parsed.apiStatus || 'UNKNOWN',
      origin: config.origin,
      destination: config.destination,
      mode: config.mode,
    };
    appendLog(entry);
    return entry;
  } catch (err) {
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
    appendLog(entry);
    return entry;
  }
}

function readHistory() {
  try {
    const raw = fs.readFileSync(LOG_PATH, 'utf-8');
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
  ensureDirsAndLog();

  let lastEntries = { forward: null, reverse: null };

  // initial collection (non-blocking) for both directions
  collectOnce({ ...config }).then((e) => (lastEntries.forward = e)).catch(() => {});
  collectOnce({ ...config, origin: config.destination, destination: config.origin })
    .then((e) => (lastEntries.reverse = e))
    .catch(() => {});

  // schedule periodic collection for both directions
  const intervalMs = config.intervalMinutes * 60 * 1000;
  setInterval(async () => {
    try { lastEntries.forward = await collectOnce({ ...config }); } catch {}
    try { lastEntries.reverse = await collectOnce({ ...config, origin: config.destination, destination: config.origin }); } catch {}
  }, intervalMs);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/api/config') {
      // do not leak API key
      const safe = {
        origin: config.origin,
        destination: config.destination,
        mode: config.mode,
        intervalMinutes: config.intervalMinutes,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(safe));
      return;
    }
    if (url.pathname === '/api/eta') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ last: lastEntries }));
      return;
    }
    if (url.pathname === '/api/history') {
      const rows = readHistory();
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
