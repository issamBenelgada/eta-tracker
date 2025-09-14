async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const HOUR_MS = 60 * 60 * 1000;

function formatMinutes(seconds) {
  if (seconds == null) return null;
  return Math.round((seconds / 60) * 10) / 10;
}

function formatKm(meters) {
  if (meters == null) return null;
  return Math.round((meters / 1000) * 100) / 100;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString();
}

function fmtTimeOnly(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dateKey(d) {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

function buildChart(ctx, points, xMin, xMax) {
  return new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'ETA (minutes)',
          data: points,
          parsing: true, // uses x/y from objects
          borderColor: '#2b7cff',
          backgroundColor: 'rgba(43,124,255,0.1)',
          pointRadius: 0,
          tension: 0.2,
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        y: { title: { display: true, text: 'Minutes' }, min: 0 },
        x: {
          type: 'linear',
          min: xMin,
          max: xMax,
          bounds: 'ticks',
          offset: false,
          ticks: {
            maxRotation: 0,
            stepSize: HOUR_MS, // 1 hour in ms
            callback: (value) => {
              const v = Number(value);
              const rounded = Math.round(v / HOUR_MS) * HOUR_MS;
              const d = new Date(rounded);
              return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            },
          },
        },
      },
      plugins: {
        legend: { display: true },
        tooltip: {
          callbacks: {
            title(items) {
              if (!items.length) return '';
              const v = Number(items[0].parsed.x);
              const rounded = Math.round(v / HOUR_MS) * HOUR_MS;
              const d = new Date(rounded);
              return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            },
          },
        },
      },
    },
  });
}

async function loadAll() {
  const cfg = await fetchJSON('/api/config');
  document.getElementById('route').textContent = `${cfg.origin} → ${cfg.destination} (${cfg.mode})`;
  document.getElementById('meta').textContent = `Sample every ${cfg.intervalMinutes} min`;

  const history = await fetchJSON('/api/history');
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * HOUR_MS);
  const today = dateKey(now);
  const dayHistory = history.filter((r) => dateKey(new Date(r.timestamp_iso)) === today);
  const points = dayHistory
    .filter((r) => r.duration_seconds != null)
    .map((r) => ({ x: new Date(r.timestamp_iso).getTime(), y: formatMinutes(r.duration_seconds) }));

  const ctx = document.getElementById('etaChart').getContext('2d');
  const chart = buildChart(ctx, points, start.getTime(), end.getTime());

  const tbody = document.querySelector('#samples tbody');
  tbody.innerHTML = '';
  for (const r of history.slice(-30).reverse()) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtTime(r.timestamp_iso)}</td>
      <td>${r.duration_seconds == null ? '—' : formatMinutes(r.duration_seconds)}</td>
      <td>${r.distance_meters == null ? '—' : formatKm(r.distance_meters)}</td>
      <td>${r.status}</td>
    `;
    tbody.appendChild(tr);
  }

  // Manual collection removed; updates occur on server schedule only.
}

loadAll().catch((e) => {
  console.error(e);
  alert('Failed to load: ' + e.message);
});
