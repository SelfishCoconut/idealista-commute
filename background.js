import { parseAddress, addressCandidates, nextArrival } from './lib/address.js';
import { Throttle, withRetry } from './lib/throttle.js';
import * as backend from './lib/backend.js';
import { buildMapSvg } from './lib/map.js';

const DEFAULTS = {
  serverUrl: '', // empty = http://127.0.0.1:8085 (this machine); or any server speaking docs/backend-api.md
  workAddress: '',
  arriveBy: '09:00',
  citySuffix: 'Madrid, España',
  pinFromMap: true, // read the listing's pin from idealista's /mapa page instead of geocoding its title
  debug: false,
};
const CACHE_TTL = 14 * 24 * 3600 * 1000;

const throttles = new Map(); // one throttle per provider/geocoder id
const inflight = new Map(); // dedupe identical concurrent requests
const th = (k, ms, parallel = false) => (throttles.has(k) ? throttles.get(k) : throttles.set(k, new Throttle(ms, { parallel })).get(k));

async function getSettings() {
  const s = await browser.storage.local.get('settings');
  return { ...DEFAULTS, ...(s.settings || {}) };
}

async function cached(key, producer, { cacheNull = true } = {}) {
  const hit = (await browser.storage.local.get(key))[key];
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.v;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const v = await producer();
    // Failures (producer throws) are never cached. "No result" is cached unless cacheNull is false
    // (geocoding misses are retried next time so a transient glitch can't stick for two weeks).
    if (v !== null || cacheNull) await browser.storage.local.set({ [key]: { ts: Date.now(), v } });
    return v;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function bumpUsage() {
  const month = new Date().toISOString().slice(0, 7);
  const { usage = {} } = await browser.storage.local.get('usage');
  usage.routes ||= {};
  usage.routes[month] = (usage.routes[month] || 0) + 1;
  await browser.storage.local.set({ usage });
}

// Tries the full address, then simpler variants; returns the first hit plus the text that matched.
// Failures (server down) throw and are not cached; misses are not cached either, so a glitch can't stick.
async function geocode(query, s) {
  for (const c of addressCandidates(query, s.citySuffix)) {
    const hit = await cached(`g:${c.toLowerCase()}`, () =>
      th('geo', 20, true).run(() => withRetry(() => backend.geocode(c, s), [1500])), { cacheNull: false });
    if (hit) return { ...hit, matched: c };
  }
  return null;
}

async function commute(title, pin) {
  const s = await getSettings();
  if (!s.workAddress) return { status: 'setup', message: 'Set your work address in the extension options.' };
  const addr = parseAddress(title, s.citySuffix);
  if (!addr) return { status: 'noaddr' };

  const work = await geocode(s.workAddress, s);
  if (!work) return { status: 'error', message: 'Work address not found.' };
  // A pin read from idealista's own map beats any address geocoding (no street-name mix-ups).
  const usePin = pin && Number.isFinite(pin.lat) && Number.isFinite(pin.lng);
  const home = usePin ? { lat: pin.lat, lng: pin.lng } : await geocode(addr, s);
  if (!home) return { status: 'noaddr', address: addr };

  const key = `r5:${home.lat.toFixed(4)},${home.lng.toFixed(4)}:${work.lat.toFixed(4)},${work.lng.toFixed(4)}:${s.arriveBy}`;
  const route = await cached(key, () =>
    th('route', 100, true).run(async () => {
      await bumpUsage();
      const r = await withRetry(() => backend.route({ from: home, to: work, arriveBy: s.arriveBy, serverUrl: s.serverUrl }));
      if (s.debug) console.debug('[idealista-commute] route', addr, r);
      return r;
    }), { cacheNull: false }); // "no route" may be transient or a settings issue; retry next time
  return route
    ? { status: 'ok', address: addr, source: usePin ? (pin.approx ? 'pin-approx' : 'pin') : 'address', ...route,
        home: { lat: home.lat, lng: home.lng }, work: { lat: work.lat, lng: work.lng } }
    : { status: 'noroute', address: addr };
}

// Map tiles come through the server (shared disk cache, one identified client) and are handed to the page
// as data: URLs, so the idealista page never contacts a tile server and its CSP is not an obstacle.
async function mapFor(route) {
  const s = await getSettings();
  return buildMapSvg(route, (z, x, y) => backend.tileDataUrl(s.serverUrl, z, x, y));
}

browser.action.onClicked.addListener(() => browser.runtime.openOptionsPage());

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'openOptions') return browser.runtime.openOptionsPage();
  if (msg?.type === 'tile') return getSettings().then((st) => backend.tileDataUrl(st.serverUrl, msg.z, msg.x, msg.y)).then((url) => ({ url })).catch((e) => ({ error: e.message }));
  if (msg?.type === 'map') return mapFor(msg.route).then((svg) => ({ svg })).catch((e) => ({ error: e.message }));
  if (msg?.type !== 'commute') return;
  return commute(msg.title, msg.pin).catch((e) => ({
    status: 'error',
    fatal: !!e.fatal,
    message: e.message || String(e),
  }));
});
