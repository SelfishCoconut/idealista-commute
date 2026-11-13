// Interactive route map. Runs as an extension page inside an iframe that the content script puts under the
// listing's badge (so idealista's own scripts can't touch it). Tiles come from your server (shared disk cache).
import { normalizeServerUrl } from './lib/url.js';
import { t, applyI18n } from './lib/i18n.js';

applyI18n();

let map;
const lat = (p) => [p[0], p[1]];

function draw(route, base) {
  map?.remove();
  map = L.map('map', { zoomControl: true, scrollWheelZoom: true, attributionControl: true });
  // Tiles are fetched by the background page and handed over as data: URLs. Loading http://<server-ip> images
  // directly would be treated as mixed content (this frame sits inside an https idealista page) and show blank.
  const Tiles = L.TileLayer.extend({
    createTile(coords, done) {
      const img = document.createElement('img');
      img.alt = '';
      browser.runtime.sendMessage({ type: 'tile', z: coords.z, x: coords.x, y: coords.y })
        .then((r) => { if (r?.url) img.src = r.url; else done(new Error(r?.error || 'tile failed'), img); })
        .catch((e) => done(e, img));
      img.onload = () => done(null, img);
      return img;
    },
  });
  new Tiles('', { maxZoom: 17, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors · <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener noreferrer">Report a map issue</a>' }).addTo(map);

  const all = [lat([route.home.lat, route.home.lng]), lat([route.work.lat, route.work.lng])];
  const steps = route.steps || [];
  for (const s of steps) {
    if (!s.path?.length) continue;
    s.path.forEach((p) => all.push(lat(p)));
    L.polyline(s.path, { color: '#fff', weight: 9, opacity: 0.85, lineCap: 'round' }).addTo(map);
    L.polyline(s.path, s.mode === 'walk'
      ? { color: '#4b5563', weight: 4, dashArray: '1 8', lineCap: 'round' }
      : { color: s.bg || '#1d4ed8', weight: 5, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(map);
  }
  for (const s of steps) {
    if (s.mode === 'walk' || !s.board) continue;
    const icon = L.divIcon({ className: '', iconSize: [0, 0],
      html: `<div class="icm-ridepin" style="background:${s.bg || '#1d4ed8'};color:${s.fg || '#fff'}">${esc(s.line || '')}</div>` });
    L.marker(s.board, { icon, interactive: false, keyboard: false }).addTo(map);
  }
  for (const [pt, text, color] of [[route.home, t('mapHome'), '#dc2626'], [route.work, t('mapWork'), '#111827']]) {
    const icon = L.divIcon({ className: '', iconSize: [0, 0],
      html: `<div class="icm-pin"><span class="icm-dot" style="background:${color}"></span><span class="icm-lbl">${text}</span></div>` });
    L.marker([pt.lat, pt.lng], { icon, interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
  }
  map.fitBounds(all, { padding: [28, 28], maxZoom: 16 });
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const { settings } = await browser.storage.local.get('settings');
const base = normalizeServerUrl(settings?.serverUrl);
// The embedding page leaves the route in extension storage under this iframe's id, then we confirm we drew it.
const id = location.hash.slice(1);
const route = (await browser.storage.local.get('m:' + id))['m:' + id];
if (route?.home) {
  draw(route, base);
  await browser.storage.local.set({ ['d:' + id]: 1 });
}
