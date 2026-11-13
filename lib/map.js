// Draws the home -> work route as an inline SVG over OpenStreetMap tiles. No dependencies; tiles arrive as
// data: URLs fetched by the background script (through the gateway), so the page never contacts a tile server.
import { t } from './i18n.js';
const TILE = 256;
const W = 640, H = 360, PAD = 36;

// Google encoded polyline (precision 5) -> [[lat, lng], ...]
export function decodePolyline(str) {
  const out = [];
  let i = 0, lat = 0, lng = 0;
  const next = () => {
    let r = 0, shift = 0, b;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << shift; shift += 5; } while (b >= 32 && i <= str.length);
    return r & 1 ? ~(r >> 1) : r >> 1;
  };
  while (i < str.length) { lat += next(); lng += next(); out.push([lat / 1e5, lng / 1e5]); }
  return out;
}

// Keep stored routes small: at most `max` points, always keeping both ends.
export function thin(pts, max = 150) {
  if (pts.length <= max) return pts;
  const step = (pts.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, k) => pts[Math.round(k * step)]);
}

const px = (lat, lng, z) => {
  const n = 2 ** z * TILE, s = Math.sin((lat * Math.PI) / 180);
  return [((lng + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
};

// Largest zoom at which all points fit in the view, and the view's top-left pixel at that zoom.
export function view(points) {
  let z = 17;
  for (; z > 3; z--) {
    const p = points.map(([a, b]) => px(a, b, z));
    const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
    if (Math.max(...xs) - Math.min(...xs) <= W - 2 * PAD && Math.max(...ys) - Math.min(...ys) <= H - 2 * PAD) break;
  }
  const p = points.map(([a, b]) => px(a, b, z));
  const cx = (Math.max(...p.map((q) => q[0])) + Math.min(...p.map((q) => q[0]))) / 2;
  const cy = (Math.max(...p.map((q) => q[1])) + Math.min(...p.map((q) => q[1]))) / 2;
  return { z, left: cx - W / 2, top: cy - H / 2 };
}

export function tilesFor({ z, left, top }) {
  const out = [], max = 2 ** z;
  for (let x = Math.floor(left / TILE); x <= Math.floor((left + W) / TILE); x++)
    for (let y = Math.floor(top / TILE); y <= Math.floor((top + H) / TILE); y++)
      if (y >= 0 && y < max) out.push({ z, x: ((x % max) + max) % max, tx: x, y });
  return out;
}

const COLOR = { walk: '#6b7280', subway: '#1d4ed8', rail: '#15803d', bus: '#c2410c', tram: '#a21caf' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// route: {steps:[{mode,path,board}], home:{lat,lng}, work:{lat,lng}}; fetchTile(z,x,y) -> data URL or null.
export async function buildMapSvg({ steps = [], home, work }, fetchTile) {
  const pts = [[home.lat, home.lng], [work.lat, work.lng], ...steps.flatMap((s) => s.path || [])];
  const v = view(pts);
  const tiles = tilesFor(v);
  const imgs = await Promise.all(tiles.map(async (t) => {
    try { return { t, url: await fetchTile(t.z, t.x, t.y) }; } catch { return { t, url: null }; }
  }));
  const P = ([a, b]) => { const [x, y] = px(a, b, v.z); return [x - v.left, y - v.top]; };
  const d = (path) => path.map((q, i) => (i ? 'L' : 'M') + P(q).map((n) => n.toFixed(1)).join(' ')).join('');
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="icm-map" role="img" aria-label="${esc(t('mapTitle'))}">`;
  svg += `<rect width="${W}" height="${H}" fill="#e8e6e1"/>`;
  for (const { t, url } of imgs) {
    if (url) svg += `<image href="${esc(url)}" x="${(t.tx * TILE - v.left).toFixed(1)}" y="${(t.y * TILE - v.top).toFixed(1)}" width="${TILE}" height="${TILE}"/>`;
  }
  const drawn = steps.filter((s) => s.path?.length > 1);
  for (const s of drawn) { // white casing under each line so it reads on any map colour
    svg += `<path d="${d(s.path)}" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>`;
  }
  for (const s of drawn) {
    svg += `<path d="${d(s.path)}" fill="none" stroke="${COLOR[s.mode] || '#111'}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"${s.mode === 'walk' ? ' stroke-dasharray="1 7"' : ''}/>`;
  }
  if (!drawn.length) svg += `<path d="${d([[home.lat, home.lng], [work.lat, work.lng]])}" stroke="#6b7280" stroke-width="3" stroke-dasharray="6 6" fill="none"/>`;
  steps.forEach((s, i) => { // numbered dots where each ride starts, matching the list
    if (s.mode === 'walk' || !s.board) return;
    const [x, y] = P(s.board);
    svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="${COLOR[s.mode] || '#111'}" stroke="#fff" stroke-width="2"/>` +
      `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="11" font-weight="700" text-anchor="middle" fill="#fff" font-family="sans-serif">${i + 1}</text>`;
  });
  for (const [pt, label, fill] of [[[home.lat, home.lng], t('mapHome'), '#dc2626'], [[work.lat, work.lng], t('mapWork'), '#111827']]) {
    const [x, y] = P(pt);
    svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8" fill="${fill}" stroke="#fff" stroke-width="3"/>` +
      `<text x="${(x + 12).toFixed(1)}" y="${(y - 10).toFixed(1)}" font-size="13" font-weight="700" fill="#111" stroke="#fff" stroke-width="3" paint-order="stroke" font-family="sans-serif">${esc(label)}</text>`;
  }
  svg += `<text x="${W - 4}" y="${H - 5}" font-size="10" text-anchor="end" fill="#333" stroke="#fff" stroke-width="2" paint-order="stroke" font-family="sans-serif">© OpenStreetMap contributors</text></svg>`;
  return svg;
}
