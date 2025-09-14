async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const HOUR_MS = 60 * 60 * 1000;
const LOCALE = 'en-GB';
const TIME_FMT = { hour: '2-digit', minute: '2-digit', hour12: false };

let APP_TRAJECTS = [];
let CURRENT = null; // selected traject { id, origin, destination, mode }
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

function dateKey(d) {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0); }
function endOfDay(d) { const s = startOfDay(d); return new Date(s.getTime() + 24 * HOUR_MS); }
function startOfWeek(d) { const day = d.getDay(); const offset = (day + 6) % 7; const s = startOfDay(d); return new Date(s.getTime() - offset * 24 * HOUR_MS); }
function addDays(d, n) { return new Date(d.getTime() + n * 24 * HOUR_MS); }
function shortDayName(d) { return d.toLocaleDateString(LOCALE, { weekday: 'short' }); }
function monthDay(d) { return d.toLocaleDateString(LOCALE, { month: 'short', day: '2-digit' }); }

function buildChart(ctx, forwardPoints, reversePoints, xMin, xMax) {
  return new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        { label: `${CURRENT ? (CURRENT.name || (CURRENT.origin + ' -> ' + CURRENT.destination)) : ''}`, data: forwardPoints, parsing: true, borderColor: '#2b7cff', backgroundColor: 'rgba(43,124,255,0.12)', pointRadius: 0, tension: 0.2 },
        { label: `${CURRENT ? (CURRENT.name || (CURRENT.origin + ' -> ' + CURRENT.destination)) : ''} (reverse)`, data: reversePoints, parsing: true, borderColor: '#ff4d4f', backgroundColor: 'rgba(255,77,79,0.12)', pointRadius: 0, tension: 0.2 },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        y: { title: { display: true, text: 'Minutes' }, min: 0 },
        x: { type: 'linear', min: xMin, max: xMax, bounds: 'ticks', offset: false, ticks: { maxRotation: 0, stepSize: HOUR_MS, callback: (value) => { const v = Number(value); const rounded = Math.round(v / HOUR_MS) * HOUR_MS; const d = new Date(rounded); return d.toLocaleTimeString(LOCALE, TIME_FMT); } } },
      },
      plugins: { legend: { display: true }, tooltip: { callbacks: { title(items) { if (!items.length) return ''; const v = Number(items[0].parsed.x); const rounded = Math.round(v / HOUR_MS) * HOUR_MS; const d = new Date(rounded); return d.toLocaleTimeString(LOCALE, TIME_FMT); } } } },
    },
  });
}

function renderSelectedDay() {
  const start = startOfDay(selectedDate);
  const end = endOfDay(selectedDate);
  const selKey = dateKey(start);
  const dayHistory = APP_HISTORY.filter((r) => dateKey(new Date(r.timestamp_iso)) === selKey);
  const fwd = dayHistory.filter((r) => r.duration_seconds != null && r.origin === CURRENT.origin && r.destination === CURRENT.destination).map((r) => ({ x: new Date(r.timestamp_iso).getTime(), y: formatMinutes(r.duration_seconds) }));
  const rev = dayHistory.filter((r) => r.duration_seconds != null && r.origin === CURRENT.destination && r.destination === CURRENT.origin).map((r) => ({ x: new Date(r.timestamp_iso).getTime(), y: formatMinutes(r.duration_seconds) }));

  const ctx = document.getElementById('etaChart').getContext('2d');
  if (chartInstance) chartInstance.destroy();
  chartInstance = buildChart(ctx, fwd, rev, start.getTime(), end.getTime());

  const tbody = document.querySelector('#samples tbody');
  tbody.innerHTML = '';
  const toMinute = (ms) => Math.floor(ms / (60 * 1000)) * 60 * 1000;
  const fwdMap = new Map();
  const revMap = new Map();
  const fwdDistMap = new Map();
  const revDistMap = new Map();
  for (const p of fwd) fwdMap.set(toMinute(p.x), p.y);
  for (const p of rev) revMap.set(toMinute(p.x), p.y);
  for (const r of dayHistory.filter((r) => r.origin === CURRENT.origin && r.destination === CURRENT.destination && r.distance_meters != null)) {
    fwdDistMap.set(toMinute(new Date(r.timestamp_iso).getTime()), r.distance_meters);
  }
  for (const r of dayHistory.filter((r) => r.origin === CURRENT.destination && r.destination === CURRENT.origin && r.distance_meters != null)) {
    revDistMap.set(toMinute(new Date(r.timestamp_iso).getTime()), r.distance_meters);
  }
  const allTimes = Array.from(new Set([...fwdMap.keys(), ...revMap.keys()])).sort((a, b) => b - a);
  for (const t of allTimes) {
    const tr = document.createElement('tr');
    const fv = fwdMap.has(t) ? fwdMap.get(t) : '—';
    const rv = revMap.has(t) ? revMap.get(t) : '—';
    const df = fwdDistMap.has(t) ? formatKm(fwdDistMap.get(t)) : '—';
    const dr = revDistMap.has(t) ? formatKm(revDistMap.get(t)) : '—';
    tr.innerHTML = `
      <td>${new Date(t).toLocaleString(LOCALE)}</td>
      <td>${df}</td>
      <td>${fv}</td>
      <td>${dr}</td>
      <td>${rv}</td>
    `;
    tbody.appendChild(tr);
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
    if (startOfDay(d).getTime() === startOfDay(selectedDate).getTime()) btn.classList.add('active');
    btn.onclick = () => { selectedDate = startOfDay(d); renderWeekControls(); renderSelectedDay(); };
    container.appendChild(btn);
  }
}

async function reloadForCurrent() {
  document.getElementById('route').textContent = `${CURRENT.name || (CURRENT.origin + ' -> ' + CURRENT.destination)} (${CURRENT.mode})`;
  const fwdHdr = document.getElementById('colForward');
  const revHdr = document.getElementById('colReverse');
  const distFwdHdr = document.getElementById('colDistFwd');
  const distRevHdr = document.getElementById('colDistRev');
  if (fwdHdr) fwdHdr.innerHTML = `<span class="legend-dot fwd"></span>${CURRENT.name || (CURRENT.origin + ' → ' + CURRENT.destination)} (min)`;
  if (revHdr) revHdr.innerHTML = `<span class="legend-dot rev"></span>${(CURRENT.name || (CURRENT.origin + ' → ' + CURRENT.destination))} (reverse)`;
  if (distFwdHdr) distFwdHdr.innerHTML = `<span class="legend-dot fwd"></span>Distance Fwd (km)`;
  if (distRevHdr) distRevHdr.innerHTML = `<span class="legend-dot rev"></span>Distance Rev (km)`;
  APP_HISTORY = await fetchJSON(`/api/history?id=${encodeURIComponent(CURRENT.id)}`);
  renderSelectedDay();
}

async function loadAll() {
  // Load trajects and set up selector
  APP_TRAJECTS = await fetchJSON('/api/trajects');
  CURRENT = APP_TRAJECTS[0] || null;
  const select = document.getElementById('trajSelect');
  select.innerHTML = '';
  for (const t of APP_TRAJECTS) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name || `${t.origin} -> ${t.destination}`;
    select.appendChild(opt);
  }
  if (CURRENT) select.value = CURRENT.id;
  select.onchange = async () => {
    const id = select.value;
    CURRENT = APP_TRAJECTS.find((t) => t.id === id) || CURRENT;
    await reloadForCurrent();
  };

  selectedDate = startOfDay(new Date());
  if (CURRENT) {
    await reloadForCurrent();
  } else {
    document.getElementById('route').textContent = 'No trajects yet — add one below.';
  }

  document.getElementById('prevWeek').onclick = () => { selectedDate = addDays(startOfWeek(selectedDate), -7); renderWeekControls(); renderSelectedDay(); };
  document.getElementById('nextWeek').onclick = () => { selectedDate = addDays(startOfWeek(selectedDate), 7); renderWeekControls(); renderSelectedDay(); };
  renderWeekControls();
}

// Add traject from form
async function addTrajectFromForm() {
  const origin = document.getElementById('newOrigin').value.trim();
  const destination = document.getElementById('newDestination').value.trim();
  const name = document.getElementById('newName').value.trim();
  const mode = document.getElementById('newMode').value;
  const intervalMinutes = Number(document.getElementById('newInterval').value || 5);
  if (!origin || !destination) { alert('Please provide origin and destination'); return; }
  const payload = { origin, destination, mode, intervalMinutes };
  if (name) payload.name = name;
  const res = await fetch('/api/trajects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch {}
    alert('Failed to add traject: ' + msg);
    return;
  }
  const created = await res.json();
  // refresh list
  APP_TRAJECTS = await fetchJSON('/api/trajects');
  const select = document.getElementById('trajSelect');
  select.innerHTML = '';
  for (const t of APP_TRAJECTS) {
    const opt = document.createElement('option'); opt.value = t.id; opt.textContent = t.name || `${t.origin} -> ${t.destination}`; select.appendChild(opt);
  }
  CURRENT = APP_TRAJECTS.find((t) => t.id === created.id) || APP_TRAJECTS[0];
  select.value = CURRENT.id;
  await reloadForCurrent();
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('addTraject');
  if (btn) btn.onclick = () => { addTrajectFromForm().catch(e => alert(String(e && e.message || e))); };
});

loadAll().catch((e) => { console.error(e); alert('Failed to load: ' + e.message); });
