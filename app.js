'use strict';

const API = 'https://creativecommons.tankerkoenig.de/json/list.php';
const GEOCODE = 'https://nominatim.openstreetmap.org/search';
const FUELS = { e5: 'Super E5', e10: 'Super E10', diesel: 'Diesel' };

const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('sp.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sp.' + k, JSON.stringify(v)); } catch {} },
};

const state = {
  fuel: store.get('fuel', 'e5'),
  radius: store.get('radius', 5),
  sort: store.get('sort', 'price'),
  openOnly: store.get('openOnly', true),
  apiKey: store.get('apiKey', ''),
  refresh: store.get('refresh', 5),
  pos: null,          // { lat, lng, label }
  stations: [],
  updated: null,
  timer: null,
};

// ---------- UI-Initialisierung ----------
function initUI() {
  document.querySelectorAll('.seg button').forEach(b => {
    b.classList.toggle('active', b.dataset.fuel === state.fuel);
    b.addEventListener('click', () => {
      state.fuel = b.dataset.fuel; store.set('fuel', state.fuel);
      document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('active', x === b));
      render();
    });
  });
  $('#radius').value = String(state.radius);
  $('#sort').value = state.sort;
  $('#openOnly').checked = state.openOnly;

  $('#radius').addEventListener('change', e => { state.radius = +e.target.value; store.set('radius', state.radius); load(); });
  $('#sort').addEventListener('change', e => { state.sort = e.target.value; store.set('sort', state.sort); render(); });
  $('#openOnly').addEventListener('change', e => { state.openOnly = e.target.checked; store.set('openOnly', state.openOnly); render(); });
  $('#locateBtn').addEventListener('click', locate);
  $('#searchForm').addEventListener('submit', e => { e.preventDefault(); searchPlace($('#place').value.trim()); });

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settings').addEventListener('close', () => {
    if ($('#settings').returnValue !== 'save') return;
    state.apiKey = $('#apiKey').value.trim(); store.set('apiKey', state.apiKey);
    state.refresh = +$('#refresh').value; store.set('refresh', state.refresh);
    scheduleRefresh();
    if (state.pos) load(); else locate();
  });

  document.addEventListener('visibilitychange', () => {
    // Beim Zurückkehren in die App sofort aktualisieren, wenn Daten älter als 2 Minuten sind
    if (!document.hidden && state.pos && (!state.updated || Date.now() - state.updated > 120000)) load();
  });
}

function openSettings() {
  $('#apiKey').value = state.apiKey;
  $('#refresh').value = String(state.refresh);
  $('#settings').showModal();
}

function setStatus(msg, isError = false) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

// ---------- Standort ----------
function locate() {
  if (!navigator.geolocation) { setStatus('Dein Browser unterstützt keine Standortbestimmung. Bitte Ort/PLZ eingeben.', true); return; }
  setStatus('Standort wird ermittelt …');
  navigator.geolocation.getCurrentPosition(
    p => { state.pos = { lat: p.coords.latitude, lng: p.coords.longitude, label: 'deinen Standort' }; load(); },
    err => setStatus(err.code === 1
      ? 'Standortzugriff verweigert. Gib stattdessen einen Ort oder eine PLZ ein.'
      : 'Standort konnte nicht ermittelt werden. Bitte Ort/PLZ eingeben.', true),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

async function searchPlace(q) {
  if (!q) { locate(); return; }
  setStatus(`Suche „${q}“ …`);
  try {
    const url = `${GEOCODE}?format=json&limit=1&countrycodes=de&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'de' } });
    const data = await res.json();
    if (!data.length) { setStatus(`„${q}“ wurde nicht gefunden.`, true); return; }
    state.pos = { lat: +data[0].lat, lng: +data[0].lon, label: data[0].display_name.split(',').slice(0, 2).join(',') };
    load();
  } catch {
    setStatus('Ortssuche fehlgeschlagen. Bitte Internetverbindung prüfen.', true);
  }
}

// ---------- Preise laden ----------
async function load() {
  if (!state.pos) return;
  if (!state.apiKey) { setStatus('Bitte zuerst einen Tankerkönig-API-Key in den Einstellungen (⚙️) hinterlegen.', true); openSettings(); return; }
  setStatus('Preise werden geladen …');
  const { lat, lng } = state.pos;
  // type=all liefert E5, E10 und Diesel in einem Aufruf (Sortierung dann nur nach Entfernung möglich – wir sortieren selbst)
  const url = `${API}?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}&rad=${state.radius}&sort=dist&type=all&apikey=${encodeURIComponent(state.apiKey)}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || 'Unbekannter API-Fehler');
    state.stations = data.stations || [];
    state.updated = Date.now();
    render();
    scheduleRefresh();
  } catch (e) {
    setStatus(`Fehler beim Laden: ${e.message}`, true);
  }
}

function scheduleRefresh() {
  clearInterval(state.timer);
  // Tankerkönig bittet darum, nicht öfter als alle 5 Minuten automatisch abzufragen
  if (state.refresh > 0) state.timer = setInterval(() => { if (!document.hidden) load(); }, state.refresh * 60000);
}

// ---------- Darstellung ----------
function fmtPrice(p) {
  if (typeof p !== 'number' || p <= 0) return null;
  const s = p.toFixed(3);                  // z. B. "1.749"
  return `${s.slice(0, -1).replace('.', ',')}<sup>${s.slice(-1)}</sup>`;
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const title = s => esc(String(s ?? '').toLowerCase().replace(/(^|[\s\-.\/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()));

function render() {
  const f = state.fuel;
  let list = state.stations.filter(s => !state.openOnly || s.isOpen);
  const priced = list.filter(s => typeof s[f] === 'number' && s[f] > 0);

  list.sort((a, b) => {
    if (state.sort === 'dist') return a.dist - b.dist;
    const pa = typeof a[f] === 'number' && a[f] > 0 ? a[f] : Infinity;
    const pb = typeof b[f] === 'number' && b[f] > 0 ? b[f] : Infinity;
    return pa - pb || a.dist - b.dist;
  });

  const prices = priced.map(s => s[f]);
  const min = Math.min(...prices), max = Math.max(...prices);
  const tier = p => {
    if (!(max > min)) return 'cheap';
    const r = (p - min) / (max - min);
    return r < 0.33 ? 'cheap' : r < 0.66 ? 'mid' : 'exp';
  };

  const time = state.updated ? new Date(state.updated).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
  if (!list.length) {
    setStatus(`Keine ${state.openOnly ? 'geöffneten ' : ''}Tankstellen im Umkreis von ${state.radius} km um ${state.pos?.label}.`);
  } else {
    const cheapest = prices.length ? ` · günstigster ${FUELS[f]}: ${min.toFixed(3).replace('.', ',')} €` : '';
    setStatus(`${list.length} Tankstellen im Umkreis von ${state.radius} km um ${state.pos?.label} · Stand ${time} Uhr${cheapest}`);
  }

  $('#list').innerHTML = list.map(s => {
    const p = fmtPrice(s[f]);
    const others = Object.keys(FUELS).filter(k => k !== f)
      .map(k => `<span>${FUELS[k]}: ${s[k] > 0 ? s[k].toFixed(3).replace('.', ',') + ' €' : '–'}</span>`).join('');
    const dest = `${s.lat},${s.lng}`;
    return `<li class="station ${s.isOpen ? '' : 'closed'}">
      <div class="name">${esc(s.brand || s.name)}<span class="badge ${s.isOpen ? 'open' : ''}">${s.isOpen ? 'geöffnet' : 'geschlossen'}</span></div>
      <div class="price ${p ? tier(s[f]) : 'na'}">${p ? p + ' €' : 'kein Preis'}</div>
      <div class="addr">${[title(s.street), esc(s.houseNumber || "")].join(" ").trim()}, ${esc(s.postCode || '')} ${title(s.place)} · ${s.dist.toFixed(1).replace('.', ',')} km</div>
      <div class="others">${others}</div>
      <div class="actions">
        <a href="https://www.google.com/maps/dir/?api=1&destination=${dest}" target="_blank" rel="noopener">🧭 Route</a>
        <a href="https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lng}#map=17/${dest.replace(',', '/')}" target="_blank" rel="noopener">🗺️ Karte</a>
      </div>
    </li>`;
  }).join('');
}

// ---------- Start ----------
initUI();
scheduleRefresh();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (!state.apiKey) { setStatus('Willkommen! Hinterlege zuerst deinen kostenlosen Tankerkönig-API-Key.'); openSettings(); }
else locate();
