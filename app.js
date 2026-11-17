'use strict';

const API = 'https://creativecommons.tankerkoenig.de/json/list.php';
const PRICES_API = 'https://creativecommons.tankerkoenig.de/json/prices.php'; // Preise für bis zu 10 Tankstellen-IDs
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
  view: store.get('view', 'list'), // 'list' | 'map' | 'fav'
  favs: store.get('favs', {}),      // id -> Stammdaten der Lieblingstankstelle
  favPrices: {},                    // id -> { status, e5, e10, diesel }
  favUpdated: null,
  alarm: store.get('alarm', { enabled: false, e5: null, e10: null, diesel: null }),
  alarmSeen: store.get('alarmSeen', {}), // Sorte -> zuletzt gemeldeter Bestpreis (verhindert Mehrfach-Alarme)
  pos: null,          // { lat, lng, label }
  stations: [],
  updated: null,
  timer: null,
  map: null,         // Leaflet-Karte (wird erst beim ersten Öffnen erzeugt)
  mapLayer: null,
  mapFitKey: '',
  markers: {},
};

// ---------- UI-Initialisierung ----------
function initUI() {
  document.querySelectorAll('[data-fuel]').forEach(b => {
    b.classList.toggle('active', b.dataset.fuel === state.fuel);
    b.addEventListener('click', () => {
      state.fuel = b.dataset.fuel; store.set('fuel', state.fuel);
      document.querySelectorAll('[data-fuel]').forEach(x => x.classList.toggle('active', x === b));
      render();
    });
  });
  document.querySelectorAll('.view-toggle button').forEach(b =>
    b.addEventListener('click', () => setView(b.dataset.view)));
  setView(state.view);

  $('#list').addEventListener('click', e => {
    const btn = e.target.closest('[data-show]');
    if (btn) showOnMap(btn.dataset.show);
    const star = e.target.closest('[data-fav]');
    if (star) { toggleFav(star.dataset.fav); render(); }
  });
  $('#map').addEventListener('click', e => {
    const star = e.target.closest('[data-fav]');
    if (!star) return;
    const on = toggleFav(star.dataset.fav);
    star.outerHTML = starBtn(star.dataset.fav); // Popup offen lassen, nur Stern umschalten
    state.markers[star.dataset.fav]?.getElement()?.querySelector('.pin')?.classList.toggle('fav', on);
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
  $('#alarmBtn').addEventListener('click', openAlarm);
  $('#alarmClose').addEventListener('click', () => { $('#alarmBanner').hidden = true; });
  $('#alarm').addEventListener('close', saveAlarm);
  updateAlarmBtn();
  $('#settings').addEventListener('close', () => {
    if ($('#settings').returnValue !== 'save') return;
    state.apiKey = $('#apiKey').value.trim(); store.set('apiKey', state.apiKey);
    state.refresh = +$('#refresh').value; store.set('refresh', state.refresh);
    scheduleRefresh();
    if (state.pos || favIds().length) load();
    if (!state.pos) locate();
  });

  document.addEventListener('visibilitychange', () => {
    // Beim Zurückkehren in die App sofort aktualisieren, wenn Daten älter als 2 Minuten sind
    if (!document.hidden && (state.pos || favIds().length) && (!state.updated || Date.now() - state.updated > 120000)) load();
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
    p => { setPos({ lat: p.coords.latitude, lng: p.coords.longitude, label: 'deinen Standort' }); load(); },
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
    setPos({ lat: +data[0].lat, lng: +data[0].lon, label: data[0].display_name.split(',').slice(0, 2).join(',') });
    load();
  } catch {
    setStatus('Ortssuche fehlgeschlagen. Bitte Internetverbindung prüfen.', true);
  }
}

// ---------- Preise laden ----------
async function load() {
  if (!state.pos && !favIds().length) return;
  if (!state.apiKey) { setStatus('Bitte zuerst einen Tankerkönig-API-Key in den Einstellungen (⚙️) hinterlegen.', true); openSettings(); return; }
  setStatus('Preise werden geladen …');
  const [near, fav] = await Promise.allSettled([state.pos ? loadNearby() : null, loadFavs()]);
  render();
  checkAlarm();
  scheduleRefresh();
  const err = [near, fav].find(r => r.status === 'rejected');
  if (err) setStatus(`Fehler beim Laden: ${err.reason.message}`, true);
}

async function loadNearby() {
  const { lat, lng } = state.pos;
  // type=all liefert E5, E10 und Diesel in einem Aufruf (Sortierung dann nur nach Entfernung möglich – wir sortieren selbst)
  const url = `${API}?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}&rad=${state.radius}&sort=dist&type=all&apikey=${encodeURIComponent(state.apiKey)}`;
  const data = await (await fetch(url)).json();
  if (!data.ok) throw new Error(data.message || 'Unbekannter API-Fehler');
  state.stations = data.stations || [];
  state.updated = Date.now();
  // Stammdaten der Favoriten auffrischen (z. B. geänderte Marke)
  for (const s of state.stations) if (state.favs[s.id]) state.favs[s.id] = favRecord(s);
  store.set('favs', state.favs);
}

async function loadFavs() {
  const ids = favIds();
  if (!ids.length) return;
  const prices = {};
  for (let i = 0; i < ids.length; i += 10) {
    const url = `${PRICES_API}?ids=${ids.slice(i, i + 10).join(',')}&apikey=${encodeURIComponent(state.apiKey)}`;
    const data = await (await fetch(url)).json();
    if (!data.ok) throw new Error(data.message || 'Unbekannter API-Fehler');
    Object.assign(prices, data.prices);
  }
  state.favPrices = prices;
  state.favUpdated = Date.now();
  if (!state.pos) state.updated = state.favUpdated;
}

function scheduleRefresh() {
  clearInterval(state.timer);
  // Tankerkönig bittet darum, nicht öfter als alle 5 Minuten automatisch abzufragen
  // Mit aktivem Preisalarm wird auch im Hintergrund weiter geprüft
  if (state.refresh > 0) state.timer = setInterval(() => { if (!document.hidden || alarmActive()) load(); }, state.refresh * 60000);
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
  const favView = state.view === 'fav';
  let list = favView ? favStations() : state.stations.filter(s => !state.openOnly || s.isOpen);
  const priced = list.filter(s => typeof s[f] === 'number' && s[f] > 0);

  list.sort((a, b) => {
    if (state.sort === 'dist') return (a.dist ?? 1e9) - (b.dist ?? 1e9);
    const pa = typeof a[f] === 'number' && a[f] > 0 ? a[f] : Infinity;
    const pb = typeof b[f] === 'number' && b[f] > 0 ? b[f] : Infinity;
    return pa - pb || (a.dist ?? 1e9) - (b.dist ?? 1e9);
  });

  const prices = priced.map(s => s[f]);
  const min = Math.min(...prices), max = Math.max(...prices);
  const tier = p => {
    if (!(max > min)) return 'cheap';
    const r = (p - min) / (max - min);
    return r < 0.33 ? 'cheap' : r < 0.66 ? 'mid' : 'exp';
  };

  const time = state.updated ? new Date(state.updated).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
  const cheapest = prices.length ? ` · günstigster ${FUELS[f]}: ${min.toFixed(3).replace('.', ',')} €` : '';
  if (favView) {
    const ft = state.favUpdated ? new Date(state.favUpdated).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
    setStatus(list.length
      ? `${list.length} Lieblingstankstelle${list.length > 1 ? 'n' : ''}${ft ? ` · Stand ${ft} Uhr` : ''}${cheapest}`
      : 'Noch keine Lieblingstankstellen. Tippe in der Liste oder auf der Karte auf ☆, um eine zu speichern.');
  } else if (!list.length) {
    setStatus(`Keine ${state.openOnly ? 'geöffneten ' : ''}Tankstellen im Umkreis von ${state.radius} km um ${state.pos?.label}.`);
  } else {
    setStatus(`${list.length} Tankstellen im Umkreis von ${state.radius} km um ${state.pos?.label} · Stand ${time} Uhr${cheapest}`);
  }

  $('#list').innerHTML = list.map(s => {
    const p = fmtPrice(s[f]);
    const others = Object.keys(FUELS).filter(k => k !== f)
      .map(k => `<span>${FUELS[k]}: ${s[k] > 0 ? s[k].toFixed(3).replace('.', ',') + ' €' : '–'}</span>`).join('');
    const dest = `${s.lat},${s.lng}`;
    return `<li class="station ${s.isOpen ? '' : 'closed'}">
      <div class="name">${starBtn(s.id)}${esc(s.brand || s.name)}<span class="badge ${s.isOpen ? 'open' : ''}">${s.isOpen ? 'geöffnet' : 'geschlossen'}</span>${belowLimit(s, f) ? '<span class="badge alarm">🔔 unter Grenze</span>' : ''}</div>
      <div class="price ${p ? tier(s[f]) : 'na'}">${p ? p + ' €' : 'kein Preis'}</div>
      <div class="addr">${[title(s.street), esc(s.houseNumber || "")].join(" ").trim()}, ${esc(s.postCode || '')} ${title(s.place)}${distTxt(s)}</div>
      <div class="others">${others}</div>
      <div class="actions">
        <a href="https://www.google.com/maps/dir/?api=1&destination=${dest}" target="_blank" rel="noopener">🧭 Route</a>
        ${state.stations.some(x => x.id === s.id) ? `<button type="button" class="link" data-show="${esc(s.id)}">🗺️ Auf Karte zeigen</button>` : ''}
      </div>
    </li>`;
  }).join('');

  if (!favView) state.lastRender = { list, tier, f };
  if (state.view === 'map') renderMap();
}

// ---------- Lieblingstankstellen ----------
const favIds = () => Object.keys(state.favs);
const favRecord = s => ({ id: s.id, name: s.name, brand: s.brand, street: s.street, houseNumber: s.houseNumber,
  postCode: s.postCode, place: s.place, lat: s.lat, lng: s.lng });
const starBtn = id => {
  const on = !!state.favs[id];
  return `<button type="button" class="star${on ? ' on' : ''}" data-fav="${esc(id)}" aria-pressed="${on}"
    title="${on ? 'Aus Favoriten entfernen' : 'Als Lieblingstankstelle speichern'}">${on ? '★' : '☆'}</button>`;
};
const distTxt = s => s.dist != null ? ` · ${s.dist.toFixed(1).replace('.', ',')} km` : '';

function toggleFav(id) {
  if (state.favs[id]) {
    delete state.favs[id];
    delete state.favPrices[id];
  } else {
    const s = state.stations.find(x => x.id === id);
    if (!s) return false;
    state.favs[id] = favRecord(s);
    state.favPrices[id] = { status: s.isOpen ? 'open' : 'closed', e5: s.e5, e10: s.e10, diesel: s.diesel };
  }
  store.set('favs', state.favs);
  return !!state.favs[id];
}

function haversine(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Favoriten mit Live-Preisen (prices.php) zusammenführen – funktioniert auch außerhalb des Suchumkreises
function favStations() {
  return Object.values(state.favs).map(fv => {
    const p = state.favPrices[fv.id] || {};
    const num = v => (typeof v === 'number' && v > 0 ? v : null);
    return { ...fv, e5: num(p.e5), e10: num(p.e10), diesel: num(p.diesel), isOpen: p.status === 'open',
             dist: state.pos ? haversine(state.pos, fv) : null };
  });
}

// ---------- Preisalarm ----------
function setPos(pos) {
  const moved = !state.pos || Math.abs(state.pos.lat - pos.lat) > 0.01 || Math.abs(state.pos.lng - pos.lng) > 0.01;
  state.pos = pos;
  if (moved) { state.alarmSeen = {}; store.set('alarmSeen', {}); }
}

const alarmLimits = () => Object.keys(FUELS).filter(k => state.alarm[k] > 0);
const alarmActive = () => state.alarm.enabled && alarmLimits().length > 0;
const belowLimit = (s, f) => alarmActive() && (!state.alarm.favOnly || !!state.favs[s.id]) && state.alarm[f] > 0 && s.isOpen && s[f] > 0 && s[f] <= state.alarm[f];
const euro = p => p.toFixed(3).replace('.', ',') + ' €';

function updateAlarmBtn() {
  $('#alarmBtn').classList.toggle('on', alarmActive());
  $('#alarmBtn').title = alarmActive()
    ? 'Preisalarm' + (state.alarm.favOnly ? ' (nur Favoriten)' : '') + ': ' + alarmLimits().map(k => `${FUELS[k]} ≤ ${state.alarm[k].toFixed(2).replace('.', ',')} €`).join(', ')
    : 'Preisalarm (aus)';
}

function notifText() {
  if (!('Notification' in window)) return 'Dein Browser unterstützt keine Benachrichtigungen – der Alarm erscheint dann nur in der App.';
  if (Notification.permission === 'denied') return '⚠️ Benachrichtigungen sind blockiert. Erlaube sie in den Browser-Einstellungen, sonst erscheint der Alarm nur in der App.';
  if (Notification.permission === 'default') return 'Beim Speichern fragt der Browser, ob die App dir Benachrichtigungen schicken darf.';
  return '✅ Benachrichtigungen sind erlaubt.';
}

function openAlarm() {
  $('#alarmEnabled').checked = state.alarm.enabled;
  $('#alarmFavOnly').checked = !!state.alarm.favOnly;
  for (const k of Object.keys(FUELS)) $('#alarm-' + k).value = state.alarm[k] > 0 ? state.alarm[k] : '';
  // Vorschlag: aktuelle Sorte mit dem derzeit günstigsten Preis vorbelegen
  const f = state.fuel, cur = state.stations.filter(s => s.isOpen && s[f] > 0).map(s => s[f]);
  if (!state.alarm[f] && cur.length) $('#alarm-' + f).placeholder = 'ab ' + Math.min(...cur).toFixed(3).replace('.', ',');
  $('#notifHint').textContent = notifText();
  $('#alarm').showModal();
}

async function saveAlarm() {
  if ($('#alarm').returnValue !== 'save') return;
  const a = { enabled: $('#alarmEnabled').checked, favOnly: $('#alarmFavOnly').checked };
  for (const k of Object.keys(FUELS)) {
    const v = parseFloat(String($('#alarm-' + k).value).replace(',', '.'));
    a[k] = v > 0 ? Math.round(v * 1000) / 1000 : null;
  }
  // Wer eine Grenze einträgt, will den Alarm in der Regel auch aktiv haben
  if (!state.alarm.enabled && !a.enabled && Object.keys(FUELS).some(k => a[k] && a[k] !== state.alarm[k])) a.enabled = true;
  state.alarm = a; store.set('alarm', a);
  state.alarmSeen = {}; store.set('alarmSeen', {});
  updateAlarmBtn();
  if (alarmActive() && 'Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch {}
  }
  if (a.favOnly && !state.favUpdated) load(); else { render(); checkAlarm(); }
}

function checkAlarm() {
  if (!alarmActive() || !state.updated) return;
  const hits = [];
  for (const k of alarmLimits()) {
    const pool = state.alarm.favOnly ? favStations() : state.stations;
    const ok = pool.filter(s => s.isOpen && s[k] > 0 && s[k] <= state.alarm[k]).sort((a, b) => a[k] - b[k]);
    if (!ok.length) { delete state.alarmSeen[k]; continue; }
    const best = ok[0];
    // Nur melden, wenn neu unter der Grenze oder noch günstiger als beim letzten Alarm
    if (!(state.alarmSeen[k] <= best[k])) hits.push({ k, best, count: ok.length });
    state.alarmSeen[k] = best[k];
  }
  store.set('alarmSeen', state.alarmSeen);
  if (!hits.length) return;

  const lines = hits.map(({ k, best, count }) =>
    `${FUELS[k]} ${euro(best[k])} bei ${state.favs[best.id] ? '★ ' : ''}${best.brand || best.name}, ${title(best.place)}${best.dist != null ? ` (${best.dist.toFixed(1).replace('.', ',')} km)` : ''}` +
    (count > 1 ? ` – ${count} Tankstellen unter ${state.alarm[k].toFixed(2).replace('.', ',')} €` : ''));
  $('#alarmText').innerHTML = '🔔 <b>Preisalarm!</b> ' + lines.map(esc).join('<br>');
  $('#alarmBanner').hidden = false;
  notify('⛽ Preisalarm', lines.join('\n'), hits[0].best.id);
}

async function notify(title, body, tag) {
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, tag: 'preisalarm', renotify: true, icon: 'icons/icon.svg', badge: 'icons/icon.svg', data: { id: tag } };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) { await reg.showNotification(title, opts); return; }
  } catch {}
  try { new Notification(title, opts); } catch {}
}

// ---------- Kartenansicht ----------
function setView(view) {
  state.view = view; store.set('view', view);
  document.querySelectorAll('.view-toggle button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('#list').hidden = view === 'map';
  $('#map').hidden = view !== 'map';
  $('.controls').classList.toggle('fav-mode', view === 'fav');
  if (view === 'map') renderMap(); else if (state.stations.length || state.favUpdated || view === 'fav') render();
  if (view === 'fav' && favIds().length && state.apiKey && (!state.favUpdated || Date.now() - state.favUpdated > 120000)) load();
}

function ensureMap() {
  if (state.map) return state.map;
  if (typeof L === 'undefined') { setStatus('Karte konnte nicht geladen werden.', true); return null; }
  const map = L.map('map', { zoomControl: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(map);
  map.setView([51.16, 10.45], 6); // Deutschland, bis ein Standort da ist
  state.mapLayer = L.layerGroup().addTo(map);
  state.map = map;
  return map;
}

function popupHtml(s, f, tier) {
  const prices = Object.keys(FUELS).map(k =>
    `<tr class="${k === f ? 'sel' : ''}"><td>${FUELS[k]}</td><td>${s[k] > 0 ? s[k].toFixed(3).replace('.', ',') + ' €' : '–'}</td></tr>`).join('');
  return `<div class="popup">
    ${starBtn(s.id)}<strong>${esc(s.brand || s.name)}</strong> <span class="badge ${s.isOpen ? 'open' : ''}">${s.isOpen ? 'geöffnet' : 'geschlossen'}</span><br>
    <small>${[title(s.street), esc(s.houseNumber || '')].join(' ').trim()}, ${esc(s.postCode || '')} ${title(s.place)} · ${s.dist.toFixed(1).replace('.', ',')} km</small>
    <table>${prices}</table>
    <a href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}" target="_blank" rel="noopener">🧭 Route</a>
  </div>`;
}

function renderMap() {
  const map = ensureMap();
  if (!map) return;
  // Container war evtl. versteckt → Größe neu berechnen
  requestAnimationFrame(() => map.invalidateSize());
  state.mapLayer.clearLayers();
  state.markers = {};
  if (!state.pos) return;

  const { lat, lng } = state.pos;
  const circle = L.circle([lat, lng], { radius: state.radius * 1000, color: '#0f766e', weight: 1, fillOpacity: 0.04 }).addTo(state.mapLayer);
  L.circleMarker([lat, lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#2563eb', fillOpacity: 1 })
    .bindTooltip('Suchmittelpunkt').addTo(state.mapLayer);

  const { list = [], tier, f } = state.lastRender || {};
  // Teuerste zuerst einfügen, damit günstige Preise oben liegen
  [...list].reverse().forEach(s => {
    const p = s[f] > 0 ? s[f] : null;
    const cls = !s.isOpen ? 'closed' : p ? tier(p) : 'na';
    const label = p ? `${p.toFixed(3).slice(0, -1).replace('.', ',')}<sup>${p.toFixed(3).slice(-1)}</sup>` : '–';
    const icon = L.divIcon({ className: '', html: `<div class="pin ${cls}${state.favs[s.id] ? ' fav' : ''}">${label}</div>`, iconSize: null, iconAnchor: [0, 0] });
    const m = L.marker([s.lat, s.lng], { icon, title: s.brand || s.name, riseOnHover: true })
      .bindPopup(popupHtml(s, f, tier), { offset: [0, -30] }).addTo(state.mapLayer);
    state.markers[s.id] = m;
  });

  // Nur bei neuem Standort/Umkreis neu zoomen, sonst bleibt der Kartenausschnitt beim Aktualisieren erhalten
  const key = `${lat},${lng},${state.radius}`;
  if (key !== state.mapFitKey) {
    state.mapFitKey = key;
    requestAnimationFrame(() => map.fitBounds(circle.getBounds(), { padding: [10, 10] }));
  }
}

function showOnMap(id) {
  setView('map');
  const m = state.markers[id];
  if (!m) return;
  requestAnimationFrame(() => { state.map.setView(m.getLatLng(), Math.max(state.map.getZoom(), 15)); m.openPopup(); });
}

// ---------- Start ----------
initUI();
scheduleRefresh();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (!state.apiKey) { setStatus('Willkommen! Hinterlege zuerst deinen kostenlosen Tankerkönig-API-Key.'); openSettings(); }
else {
  if (favIds().length) load(); // Favoriten-Preise sofort, auch ohne Standort
  locate();
}
