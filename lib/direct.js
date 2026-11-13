// "This browser" mode: the extension talks to the public services itself, with the user's own Google key, instead of
// going through a server (docs/backend-api.md). No shared cache: everything is cached in this browser only.
import { Throttle, ProviderError } from './throttle.js';
import { fetchGoogleRoute } from './google.js';
import { parseRoute, dataUrl } from './backend.js';

// Origins the extension must be allowed to reach in this mode (requested when the options are saved).
export const ORIGINS = ['https://routes.googleapis.com/*', 'https://nominatim.openstreetmap.org/*', 'https://photon.komoot.io/*', 'https://tile.openstreetmap.org/*'];

// Nominatim's usage policy: at most 1 request per second. Photon is lenient but kept polite.
const nomT = new Throttle(1100), phoT = new Throttle(300);

const nominatim = (q) => nomT.run(async () => {
  const p = new URLSearchParams({ q, format: 'jsonv2', limit: '1', countrycodes: 'es' });
  const r = await fetch('https://nominatim.openstreetmap.org/search?' + p, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('nominatim ' + r.status);
  const a = await r.json();
  return a.length ? { lat: parseFloat(a[0].lat), lng: parseFloat(a[0].lon), label: a[0].display_name } : null;
});
const photon = (q) => phoT.run(async () => {
  const p = new URLSearchParams({ q, limit: '3', lat: '40.4168', lon: '-3.7038' });
  const r = await fetch('https://photon.komoot.io/api/?' + p, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('photon ' + r.status);
  const f = ((await r.json()).features || []).find((x) => !x.properties?.countrycode || x.properties.countrycode === 'ES');
  const c = f?.geometry?.coordinates;
  if (!c) return null;
  const pr = f.properties || {};
  return { lat: c[1], lng: c[0], label: [pr.name, pr.district || pr.city].filter(Boolean).join(', ') };
});

// -> {lat, lng, label} | null (nothing matched). Throws ProviderError when every geocoder failed (not cached).
export async function geocode(query, { nominatimFn = nominatim, photonFn = photon } = {}) {
  let errors = 0;
  for (const up of [nominatimFn, photonFn]) {
    try { const hit = await up(query); if (hit) return hit; } catch { errors++; }
  }
  if (errors === 2) throw new ProviderError('Geocoders unavailable (OpenStreetMap). Check your connection and the permissions in the options.', { retryable: true });
  return null;
}

// Google Routes with the user's own key -> same result shape as backend.route().
export async function route({ from, to, arriveBy, googleKey }) {
  if (!googleKey) throw new ProviderError('Add your Google Routes API key in the options (or switch to "My server").', { fatal: true });
  let out;
  try { out = await fetchGoogleRoute({ key: googleKey, from, to, arriveBy }); }
  catch (e) {
    if (e.status === 401 || e.status === 403) throw new ProviderError(`Google rejected the key: ${e.message}`, { fatal: true });
    throw new ProviderError(e.message || 'Google Routes failed', { retryable: !e.status || e.status === 429 || e.status >= 500 });
  }
  return parseRoute(out);
}

export const tileDataUrl = async (z, x, y) => dataUrl(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, {});
