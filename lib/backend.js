// The extension's only network dependency (besides idealista itself): ONE backend server that speaks the
// small HTTP contract documented in docs/backend-api.md. The reference implementation is server/, but any
// server implementing the contract works: change the "Server URL" in the options and nothing else.
import { ProviderError } from './throttle.js';
import { normalizeServerUrl } from './url.js';
import { decodePolyline, thin } from './map.js';

const baseOf = (serverUrl) => {
  const base = normalizeServerUrl(serverUrl);
  if (!base) throw new ProviderError('Invalid server URL in options.', { fatal: true });
  return base;
};

// Optional shared secret (ACCESS_TOKEN on the server), sent as a bearer token on every call except /health.
const auth = (token) => (token ? { Authorization: 'Bearer ' + token } : {});

// GET /geocode?q=TEXT -> {lat, lng, label} | null (no match). Throws ProviderError if the server is unreachable.
export async function geocode(query, { serverUrl, accessToken } = {}) {
  const base = baseOf(serverUrl);
  let res;
  try {
    // Long timeout: many listings may queue behind the server's polite 1 lookup/second to public geocoders.
    res = await fetch(`${base}/geocode?q=${encodeURIComponent(query)}`, { headers: auth(accessToken), signal: AbortSignal.timeout(120000) });
  } catch {
    throw new ProviderError(`Server not reachable at ${base}. Is it running? Check the server URL in the options.`, { fatal: true });
  }
  if (!res.ok) throw new ProviderError(`Server geocoding failed (${res.status})`, { retryable: res.status >= 500 });
  const j = await res.json();
  return j.found ? { lat: j.lat, lng: j.lng, label: j.label || '' } : null;
}

// POST /route -> {minutes, transfers, steps:[{mode,minutes,text,path?}], provider} | null (no route found).
export async function route({ from, to, arriveBy, serverUrl, accessToken }) {
  const base = baseOf(serverUrl);
  let res;
  try {
    res = await fetch(base + '/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(accessToken) },
      body: JSON.stringify({ from: { lat: from.lat, lng: from.lng }, to: { lat: to.lat, lng: to.lng }, arriveBy }),
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    throw new ProviderError(`Server not reachable at ${base}. Is it running? Check the server URL in the options.`, { fatal: true });
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new ProviderError(j.error || `Server ${res.status}`, { fatal: !!j.fatal, retryable: res.status >= 500 && !j.fatal });
  }
  return parseRoute(await res.json());
}

// GET /tile/Z/X/Y.png -> data: URL (so the idealista page never contacts a tile server).
export async function tileDataUrl(serverUrl, z, x, y, accessToken) {
  const r = await fetch(`${baseOf(serverUrl)}/tile/${z}/${x}/${y}.png`, { headers: auth(accessToken), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('tile ' + r.status);
  const bytes = new Uint8Array(await r.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return 'data:image/png;base64,' + btoa(bin);
}

// GET /health -> { ok, routing, ... }
export async function health(serverUrl) {
  return (await fetch(baseOf(serverUrl) + '/health', { signal: AbortSignal.timeout(8000) })).json();
}

// Server answer -> result. Polylines are decoded and thinned here to keep stored results small.
export function parseRoute(j) {
  if (!j?.found) return null;
  return {
    minutes: j.minutes,
    transfers: j.transfers,
    provider: j.provider || 'your server',
    steps: j.steps.map(({ polys, ...s }) => {
      const path = (polys || []).flatMap(decodePolyline);
      return path.length ? { ...s, path: thin(path) } : s;
    }),
  };
}
