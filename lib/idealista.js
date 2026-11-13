// Helpers for idealista pages. Loaded by the content script through a dynamic import (web-accessible).
const SPAIN = { lat: [27, 44.5], lng: [-19, 5.5] }; // includes the Canary Islands; rejects swapped/garbage numbers
const ok = (lat, lng) => lat >= SPAIN.lat[0] && lat <= SPAIN.lat[1] && lng >= SPAIN.lng[0] && lng <= SPAIN.lng[1];

export function listingId(href) {
  const m = /\/inmueble\/(\d+)/.exec(href || '');
  return m ? m[1] : null;
}

const N = '(-?\\d{1,3}\\.\\d{3,})';
// Most specific first. The first hit that lies inside Spain wins.
const PATTERNS = [
  [new RegExp(`"latitude"\\s*:\\s*"?${N}"?[\\s\\S]{0,120}?"longitude"\\s*:\\s*"?${N}`, 'i'), 'lat-lng'],
  [new RegExp(`"longitude"\\s*:\\s*"?${N}"?[\\s\\S]{0,120}?"latitude"\\s*:\\s*"?${N}`, 'i'), 'lng-lat'],
  [new RegExp(`\\blatitude\\b["']?\\s*[:=]\\s*["']?${N}[\\s\\S]{0,120}?\\blongitude\\b["']?\\s*[:=]\\s*["']?${N}`, 'i'), 'lat-lng'],
  [new RegExp(`"lat"\\s*:\\s*"?${N}"?[\\s\\S]{0,60}?"(?:lng|lon)"\\s*:\\s*"?${N}`, 'i'), 'lat-lng'],
  [new RegExp(`data-lat(?:itude)?=["']${N}["'][\\s\\S]{0,120}?data-(?:lng|lon|longitude)=["']${N}["']`, 'i'), 'lat-lng'],
  [new RegExp(`[?&](?:center|ll|q|markers)=(?:[^&"']*?:)?${N}(?:,|%2C)${N}`, 'i'), 'lat-lng'],
  [new RegExp(`(?:LatLng|latLng)\\(\\s*${N}\\s*,\\s*${N}`), 'lat-lng'],
];

// Returns { lat, lng, approx } from the HTML of an idealista /inmueble/<id>/mapa page, or null.
// `approx` is true when the page speaks of an approximate area/circle instead of an exact pin.
// NOTE: written without access to the live page (idealista blocks non-browser clients), so it is deliberately
// tolerant; check test/idealista.test.js and send a saved /mapa page if a listing's pin is not found.
export function parseMapCoords(html) {
  if (!html) return null;
  for (const [re, order] of PATTERNS) {
    const m = re.exec(html);
    if (!m) continue;
    const [a, b] = [parseFloat(m[1]), parseFloat(m[2])];
    const [lat, lng] = order === 'lat-lng' ? [a, b] : [b, a];
    if (ok(lat, lng)) return { lat, lng, approx: /aproxim|approximate|"radius"|\bcircle\b|zona aproximada/i.test(html) };
  }
  return null;
}

// idealista serves a bot-check instead of the page when it is suspicious; stop asking if we see it.
export const looksBlocked = (status, html) =>
  status === 403 || status === 429 || /captcha-delivery|datadome|geo\.captcha/i.test(String(html).slice(0, 4000));

// ---- listing photos (for the AI-generated check) ----------------------------------------------------------
// Photos live on idealista's image hosts (img3.idealista.com/.../id.pro.es.image.master/...jpg). The page lists each
// in several sizes (thumbnails, gallery, full), in markup and in inline JSON, so every URL is collected from the raw
// HTML and the largest variant of each photo is kept. Written without access to the live page: deliberately tolerant.
const IMG_RE = /https?:\/\/img\d*\.idealista\.com\/[^"'\s\\)<>,]+?\.(?:jpe?g|webp|png)/gi;
const BIG = /DETAIL|FULL|XL|-L-L|ORIGINAL/i;
const SMALL = /THUMB|-S\b|WEB_LISTING|-M\b|MAP/i;

export function photoUrls(html) {
  const text = String(html || '').replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const best = new Map(); // photo identity (path after "id.pro.") -> best URL seen
  for (const m of text.matchAll(IMG_RE)) {
    const url = m[0].replace(/^http:/i, 'https:');
    const id = /id\.pro\.[^/]*\/(.+)$/i.exec(url)?.[1]; // only real listing photos; skips logos, avatars, map tiles
    if (!id) continue;
    const rank = (u) => (BIG.test(u) ? 2 : SMALL.test(u) ? 0 : 1);
    if (!best.has(id) || rank(url) > rank(best.get(id))) best.set(id, url);
  }
  return [...best.values()];
}

// Up to n distinct items chosen at random (Fisher-Yates on a copy). `rnd` is injectable for tests.
export function pickRandom(list, n = 3, rnd = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}
