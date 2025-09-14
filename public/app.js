async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const HOUR_MS = 60 * 60 * 1000;
const LOCALE = 'en-GB';
const TIME_FMT = { hour: '2-digit', minute: '2-digit', hour12: false };
let APP_CFG = null;
let APP_HISTORY = [];
let chartInstance = null;
let selectedDate = null; // Date at local midnight of selected day

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
  return d.toLocaleString(LOCALE);
}

function fmtTimeOnly(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString(LOCALE, TIME_FMT);
}

function dateKey(d) {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function endOfDay(d) {
  const s = startOfDay(d);
  return new Date(s.getTime() + 24 * HOUR_MS);
}

function startOfWeek(d) {
  const day = d.getDay(); // 0=Sun..6=Sat
  const offset = (day + 6) % 7; // Monday-based week
  const s = startOfDay(d);
  return new Date(s.getTime() - offset * 24 * HOUR_MS);
}

function addDays(d, n) { return new Date(d.getTime() + n * 24 * HOUR_MS); }

function shortDayName(d) {
  return d.toLocaleDateString(LOCALE, { weekday: 'short' });
}

function monthDay(d) {
  return d.toLocaleDateString(LOCALE, { month: 'short', day: '2-digit' });
}

function buildChart(ctx, forwardPoints, reversePoints, xMin, xMax) {
  return new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: `${APP_CFG.origin} → ${APP_CFG.destination}`,
          data: forwardPoints,
          parsing: true,
          borderColor: '#2b7cff',
          backgroundColor: 'rgba(43,124,255,0.12)',
          pointRadius: 0,
          tension: 0.2,
        },
        {
          label: `${APP_CFG.destination} → ${APP_CFG.origin}`,
          data: reversePoints,
          parsing: true,
          borderColor: '#ff4d4f',
          backgroundColor: 'rgba(255,77,79,0.12)',
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
              return d.toLocaleTimeString(LOCALE, TIME_FMT);
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
              return d.toLocaleTimeString(LOCALE, TIME_FMT);
            },
          },
        },
      },
    },
  });
}

function renderSelectedDay() {
  const start = startOfDay(selectedDate);
  const end = endOfDay(selectedDate);
  const selKey = dateKey(start);
  const dayHistory = APP_HISTORY.filter((r) => dateKey(new Date(r.timestamp_iso)) === selKey);
  const fwd = dayHistory
    .filter((r) => r.duration_seconds != null && r.origin === APP_CFG.origin && r.destination === APP_CFG.destination)
    .map((r) => ({ x: new Date(r.timestamp_iso).getTime(), y: formatMinutes(r.duration_seconds) }));
  const rev = dayHistory
    .filter((r) => r.duration_seconds != null && r.origin === APP_CFG.destination && r.destination === APP_CFG.origin)
    .map((r) => ({ x: new Date(r.timestamp_iso).getTime(), y: formatMinutes(r.duration_seconds) }));

  const ctx = document.getElementById('etaChart').getContext('2d');
  if (chartInstance) chartInstance.destroy();
  chartInstance = buildChart(ctx, fwd, rev, start.getTime(), end.getTime());

  const tbody = document.querySelector('#samples tbody');
  tbody.innerHTML = '';
  for (const r of dayHistory.slice(-1440).reverse()) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtTime(r.timestamp_iso)}</td>
      <td>${r.duration_seconds == null ? '—' : formatMinutes(r.duration_seconds)}</td>
      <td>${r.distance_meters == null ? '—' : formatKm(r.distance_meters)}</td>
      <td>${r.status}</td>
    `;
    tbody.appendChild(tr);
  }

  // Rebuild table with forward and reverse columns aligned by minute
  {
    const tbody2 = document.querySelector('#samples tbody');
    tbody2.innerHTML = '';
    const toMinute = (ms) => Math.floor(ms / (60 * 1000)) * 60 * 1000;
    const fwdMap = new Map();
    const revMap = new Map();
    for (const p of fwd) fwdMap.set(toMinute(p.x), p.y);
    for (const p of rev) revMap.set(toMinute(p.x), p.y);
    const allTimes = Array.from(new Set([...fwdMap.keys(), ...revMap.keys()])).sort((a, b) => b - a);
    for (const t of allTimes) {
      const tr2 = document.createElement('tr');
      const f = fwdMap.has(t) ? fwdMap.get(t) : '—';
      const r = revMap.has(t) ? revMap.get(t) : '—';
      tr2.innerHTML = `
        <td>${new Date(t).toLocaleString(LOCALE)}</td>
        <td>${f}</td>
        <td>${r}</td>
      `;
      tbody2.appendChild(tr2);
    }
  }
  const currentDayLabel = document.getElementById('currentDayLabel');
  const today = startOfDay(new Date());
  const isToday = start.getTime() === today.getTime();
  const label = selectedDate.toLocaleDateString(LOCALE, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  currentDayLabel.textContent = `${isToday ? 'Today' : 'Selected'}: ${label}`;
}

function renderWeekControls() {
  const weekStart = startOfWeek(selectedDate);
  const weekEnd = addDays(weekStart, 6);
  const weekLabel = document.getElementById('weekLabel');
  weekLabel.textContent = `${monthDay(weekStart)} – ${monthDay(weekEnd)} (${weekStart.getFullYear()})`;

  const container = document.getElementById('weekDays');
  container.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    const btn = document.createElement('button');
    btn.className = 'day-btn secondary';
    btn.dataset.date = startOfDay(d).toISOString();
    btn.textContent = `${shortDayName(d)} ${('0' + d.getDate()).slice(-2)}`;
    if (startOfDay(d).getTime() === startOfDay(selectedDate).getTime()) {
      btn.classList.add('active');
    }
    btn.onclick = () => {
      selectedDate = startOfDay(d);
      renderWeekControls();
      renderSelectedDay();
    };
    container.appendChild(btn);
  }
}

async function loadAll() {
  APP_CFG = await fetchJSON('/api/config');
  document.getElementById('route').textContent = `${APP_CFG.origin} → ${APP_CFG.destination} (${APP_CFG.mode})`;
  // Update table headers to show both directions
  const fwdHdr = document.getElementById('colForward');
  const revHdr = document.getElementById('colReverse');
  if (fwdHdr) fwdHdr.textContent = `${APP_CFG.origin} → ${APP_CFG.destination} (min)`;
  if (revHdr) revHdr.textContent = `${APP_CFG.destination} → ${APP_CFG.origin} (min)`;
  // Removed sample interval message per request.
  // Add colored markers to column headers for direction matching
  (function(){
    const fwdHdr = document.getElementById('colForward');
    const revHdr = document.getElementById('colReverse');
    if (fwdHdr) fwdHdr.innerHTML = `<span class=\"legend-dot fwd\"></span>${APP_CFG.origin} &rarr; ${APP_CFG.destination} (min)`;
    if (revHdr) revHdr.innerHTML = `<span class=\"legend-dot rev\"></span>${APP_CFG.destination} &rarr; ${APP_CFG.origin} (min)`;
  })();

  APP_HISTORY = await fetchJSON('/api/history');
  selectedDate = startOfDay(new Date());

  document.getElementById('prevWeek').onclick = () => {
    selectedDate = addDays(startOfWeek(selectedDate), -7);
    renderWeekControls();
    renderSelectedDay();
  };
  document.getElementById('nextWeek').onclick = () => {
    selectedDate = addDays(startOfWeek(selectedDate), 7);
    renderWeekControls();
    renderSelectedDay();
  };

  renderWeekControls();
  renderSelectedDay();
}

loadAll().catch((e) => {
  console.error(e);
  alert('Failed to load: ' + e.message);
});
