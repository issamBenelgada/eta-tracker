async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

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

function buildChart(ctx, labels, data) {
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'ETA (minutes)',
          data,
          borderColor: '#2b7cff',
          backgroundColor: 'rgba(43,124,255,0.1)',
          pointRadius: 0,
          tension: 0.2,
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { title: { display: true, text: 'Minutes' }, min: 0 },
        x: { ticks: { maxRotation: 0 } },
      },
      plugins: {
        legend: { display: true },
      },
    },
  });
}

async function loadAll() {
  const cfg = await fetchJSON('/api/config');
  document.getElementById('route').textContent = `${cfg.origin} → ${cfg.destination} (${cfg.mode})`;
  document.getElementById('meta').textContent = `Sample every ${cfg.intervalMinutes} min`;

  const history = await fetchJSON('/api/history');
  const labels = history.map((r) => fmtTime(r.timestamp_iso));
  const data = history.map((r) => (r.duration_seconds == null ? null : formatMinutes(r.duration_seconds)));

  const ctx = document.getElementById('etaChart').getContext('2d');
  const chart = buildChart(ctx, labels, data);

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
