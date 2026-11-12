// Reference backend for the extension (see docs/backend-api.md). No dependencies (Node >= 22).
//
//   GET  /health            -> { ok, routing, paidCallsThisMonth, monthlyLimit, cache }
//   GET  /geocode?q=TEXT    -> { found, lat, lng, label, source }   (Nominatim, then Photon; cached, throttled)
//   POST /route             -> transit route from a pluggable router (default: Google Routes with the server-side
//                              API key; see ROUTER_MODULE in the README); answers cached, monthly call cap
//   GET  /tile/Z/X/Y.png    -> OpenStreetMap tile, cached on disk (only when TILE_DIR is set)
//
// Why: many people share one server, so a place is looked up on the public geocoders once, ever, and the
// 1 request/second Nominatim limit is respected centrally. Nothing else is proxied (this is not an open proxy).
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fetchGoogleRoute, targetArrival } from './google.mjs';

const DAY = 24 * 3600 * 1000;

export class Cache {
  constructor(file = null) {
    this.map = new Map();
    this.file = file;
    if (file) this.load();
  }
  load() {
    try {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const { k, v, exp } = JSON.parse(line);
          if (exp > Date.now()) this.map.set(k, { v, exp });
        } catch {} // a torn last line after a crash is skipped
      }
      // Compact: rewrite only live entries.
      fs.writeFileSync(this.file, [...this.map].map(([k, e]) => JSON.stringify({ k, v: e.v, exp: e.exp })).join('\n') + (this.map.size ? '\n' : ''));
    } catch {}
  }
  get(k) {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.exp <= Date.now()) { this.map.delete(k); return undefined; }
    return e.v;
  }
  set(k, v, ttlMs) {
    const exp = Date.now() + ttlMs;
    this.map.set(k, { v, exp });
    if (this.file) fs.appendFile(this.file, JSON.stringify({ k, v, exp }) + '\n', () => {});
  }
  get size() { return this.map.size; }
}

class Throttle {
  constructor(ms) { this.ms = ms; this.chain = Promise.resolve(); this.last = 0; }
  run(fn) {
    const r = this.chain.then(async () => {
      const wait = this.last + this.ms - Date.now();
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
      try { return await fn(); } finally { this.last = Date.now(); }
    });
    this.chain = r.catch(() => {});
    return r;
  }
}

// Returns {found:true,...} | {found:false} (every upstream answered, nothing matched) | throws (upstreams failed).
export function makeGeocoder({ fetchImpl = fetch, contact = '' } = {}) {
  const ua = `idealista-commute-gateway/0.1 (self-hosted${contact ? '; ' + contact : ''})`;
  const nomT = new Throttle(1100), phoT = new Throttle(300);

  const nominatim = (q) => nomT.run(async () => {
    const p = new URLSearchParams({ q, format: 'jsonv2', limit: '1', countrycodes: 'es' });
    const r = await fetchImpl('https://nominatim.openstreetmap.org/search?' + p, { headers: { 'User-Agent': ua } });
    if (!r.ok) throw new Error('nominatim ' + r.status);
    const a = await r.json();
    return a.length ? { lat: parseFloat(a[0].lat), lng: parseFloat(a[0].lon), label: a[0].display_name, source: 'nominatim' } : null;
  });
  const photon = (q) => phoT.run(async () => {
    const p = new URLSearchParams({ q, limit: '3', lat: '40.4168', lon: '-3.7038' });
    const r = await fetchImpl('https://photon.komoot.io/api/?' + p, { headers: { 'User-Agent': ua } });
    if (!r.ok) throw new Error('photon ' + r.status);
    const f = ((await r.json()).features || []).find((x) => !x.properties?.countrycode || x.properties.countrycode === 'ES');
    const c = f?.geometry?.coordinates;
    if (!c) return null;
    const pr = f.properties || {};
    return { lat: c[1], lng: c[0], label: [pr.name, pr.district || pr.city].filter(Boolean).join(', '), source: 'photon' };
  });

  return async function geocode(q) {
    let errors = 0;
    for (const up of [nominatim, photon]) {
      try {
        const hit = await up(q);
        if (hit) return { found: true, ...hit };
      } catch { errors++; }
    }
    if (errors === 2) throw new Error('all geocoders failed');
    return { found: false };
  };
}

// Public, credential-less data on a LAN service: allow any origin so browsers/extensions can call it.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

export function createServer({
  googleKey = '', googleEndpoint = undefined, router = null, monthlyLimit = 2000, cache = new Cache(), geocode = makeGeocoder(),
  fetchImpl = fetch, tileDir = null, tileTtl = 14 * DAY, contact = '', geoTtl = 90 * DAY, missTtl = DAY, routeTtl = 7 * DAY, noRouteTtl = DAY,
} = {}) {
  const send = (res, code, obj, extra = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...CORS, ...extra });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req, max = 65536) => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
  // The routing backend: async ({from, to, arriveBy}) => {found, minutes, transfers, steps, provider?}. Swap it by
  // passing `router` (or ROUTER_MODULE in the environment); the default is Google Routes if a key is set.
  const routeFn = router || (googleKey ? (a) => fetchGoogleRoute({ key: googleKey, ...a, fetchImpl, endpoint: googleEndpoint }) : null);
  const routing = router ? (router.routerName || 'custom') : googleKey ? 'google' : null;
  const stats = { geocode: 0, route: 0, hits: 0, misses: 0 };
  const inflight = new Map();
  const month = () => new Date().toISOString().slice(0, 7);
  const used = () => cache.get('u:' + month()) ?? 0; // paid Google calls this month (survives restarts)
  // OSM tile policy: identify the client, cache, keep concurrency low. Tiles are fetched <= 2 at a time.
  const ua = `idealista-commute-gateway/0.1 (self-hosted${contact ? '; ' + contact : ''})`;
  let active = 0; const waiting = [];
  const slot = async () => { if (active >= 2) await new Promise((r) => waiting.push(r)); active++; };
  const release = () => { active--; waiting.shift()?.(); };
  async function tile(z, x, y) {
    const file = path.join(tileDir, `${z}-${x}-${y}.png`);
    try { if (Date.now() - fs.statSync(file).mtimeMs < tileTtl) return { buf: fs.readFileSync(file), hit: true }; } catch {}
    await slot();
    try {
      const r = await fetchImpl(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, { headers: { 'User-Agent': ua } });
      if (!r.ok) throw new Error('tile ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(tileDir, { recursive: true });
      fs.writeFileSync(file + '.part', buf); fs.renameSync(file + '.part', file);
      return { buf, hit: false };
    } finally { release(); }
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, routing, paidCallsThisMonth: used(), monthlyLimit,
          cache: { entries: cache.size, ...stats } });
      }

      if (req.method === 'GET' && url.pathname === '/geocode') {
        const q = (url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim();
        if (!q || q.length > 200) return send(res, 400, { error: 'q required (max 200 chars)' });
        const key = 'g:' + q.toLowerCase();
        const hit = cache.get(key);
        if (hit !== undefined) { stats.hits++; return send(res, 200, hit, { 'X-Cache': 'HIT' }); }
        stats.misses++;
        let out;
        try { out = await geocode(q); } catch { return send(res, 502, { error: 'geocoders unavailable' }); } // not cached
        cache.set(key, out, out.found ? geoTtl : missTtl);
        stats.geocode++;
        return send(res, 200, out, { 'X-Cache': 'MISS' });
      }

      const tm = req.method === 'GET' && tileDir && url.pathname.match(/^\/tile\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/);
      if (tm) {
        const [z, x, y] = tm.slice(1).map(Number);
        if (z < 1 || z > 17 || x >= 2 ** z || y >= 2 ** z) return send(res, 400, { error: 'bad tile' });
        const t = await tile(z, x, y);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'X-Cache': t.hit ? 'HIT' : 'MISS', ...CORS });
        return res.end(t.buf);
      }

      if (req.method === 'POST' && url.pathname === '/route') {
        let q;
        try { q = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        const pt = (p) => (p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180
          ? { lat: Math.round(p.lat * 1e4) / 1e4, lng: Math.round(p.lng * 1e4) / 1e4 } : null); // ~11 m: nearby listings share an answer
        const from = pt(q.from), to = pt(q.to);
        const arriveBy = /^([01]\d|2[0-3]):[0-5]\d$/.test(q.arriveBy || '') ? q.arriveBy : '09:00';
        if (!from || !to) return send(res, 400, { error: 'from and to {lat,lng} required' });
        const when = targetArrival(arriveBy);
        const key = `r2:${from.lat},${from.lng}:${to.lat},${to.lng}:${when}`;
        const hit = cache.get(key);
        if (hit !== undefined) { stats.hits++; return send(res, 200, hit, { 'X-Cache': 'HIT' }); }
        if (!routeFn) return send(res, 503, { error: 'no routing backend configured on the server (set GOOGLE_API_KEY or ROUTER_MODULE)', fatal: true });
        if (used() >= monthlyLimit) return send(res, 429, { error: `monthly paid-call limit (${monthlyLimit}) reached; raise GOOGLE_MONTHLY_LIMIT`, fatal: true });
        stats.misses++;
        let p = inflight.get(key);
        if (!p) {
          p = Promise.resolve(routeFn({ from, to, arriveBy })).finally(() => inflight.delete(key));
          inflight.set(key, p);
        }
        let out;
        try { out = await p; } catch (e) {
          // A rejected key / disabled API / billing problem is not retryable; quota (429) and 5xx are.
          return send(res, e.status === 403 || e.status === 401 ? 502 : e.status || 502, { error: String(e.message).slice(0, 300), fatal: e.status === 403 || e.status === 401 });
        }
        cache.set('u:' + month(), used() + 1, 40 * DAY); // only calls the router answered count
        cache.set(key, out, out.found ? routeTtl : noRouteTtl);
        stats.route++;
        return send(res, 200, out, { 'X-Cache': 'MISS' });
      }

      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 502, { error: String(e.message || e) });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8085);
  const cache = new Cache(process.env.CACHE_FILE || '/cache/cache.jsonl');
  let router = null;
  if (process.env.ROUTER_MODULE) { // custom routing backend: a module whose default export is async ({from,to,arriveBy}) => result
    const mod = await import(process.env.ROUTER_MODULE);
    router = mod.default;
    router.routerName = mod.routerName || 'custom';
  }
  const server = createServer({
    router,
    googleKey: process.env.GOOGLE_API_KEY || '',
    googleEndpoint: process.env.GOOGLE_ENDPOINT || undefined, // tests only: point at a fake Google
    monthlyLimit: Number(process.env.GOOGLE_MONTHLY_LIMIT || 2000),
    cache,
    geocode: makeGeocoder({ contact: process.env.GATEWAY_CONTACT || '' }),
    tileDir: process.env.TILE_DIR || '/cache/tiles',
    contact: process.env.GATEWAY_CONTACT || '',
  });
  server.listen(port, '0.0.0.0', () => console.log(`gateway on :${port}, ${cache.size} cached entries`));
}
