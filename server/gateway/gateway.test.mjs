import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cache, createServer, makeGeocoder } from './gateway.mjs';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

test('Cache honours TTL and survives a restart (torn line tolerated)', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-')), 'c.jsonl');
  const c = new Cache(f);
  c.set('a', { x: 1 }, 60_000);
  c.set('gone', 1, -1);
  await new Promise((r) => setTimeout(r, 30));
  fs.appendFileSync(f, '{"k":"torn","v":');
  const c2 = new Cache(f);
  assert.deepEqual(c2.get('a'), { x: 1 });
  assert.equal(c2.get('gone'), undefined);
  assert.equal(c2.get('torn'), undefined);
});

test('geocode: miss then hit, upstream called once; fallback to photon; 502 not cached', async () => {
  const calls = [];
  const fetchImpl = async (u, o) => {
    calls.push(String(u));
    assert.match(o.headers['User-Agent'], /idealista-commute-gateway/); // identifies itself (Nominatim policy)
    if (String(u).includes('nominatim')) return json([]); // Nominatim finds nothing
    return json({ features: [{ geometry: { coordinates: [-3.6946, 40.5005] }, properties: { countrycode: 'ES', name: 'Prosperidad', district: 'Fuencarral' } }] });
  };
  const srv = createServer({ geocode: makeGeocoder({ fetchImpl }), cache: new Cache() });
  const base = await listen(srv);
  const q = encodeURIComponent('Prosperidad - Chamartín, Madrid');
  const a = await fetch(`${base}/geocode?q=${q}`);
  assert.equal(a.headers.get('x-cache'), 'MISS');
  assert.deepEqual(await a.json(), { found: true, lat: 40.5005, lng: -3.6946, label: 'Prosperidad, Fuencarral', source: 'photon' });
  const n = calls.length;
  const b = await fetch(`${base}/geocode?q=${q.toLowerCase()}`);
  assert.equal(b.headers.get('x-cache'), 'HIT');
  assert.equal(calls.length, n); // nothing sent upstream the second time
  assert.equal((await fetch(`${base}/geocode`)).status, 400);
  srv.close();

  const down = createServer({ geocode: makeGeocoder({ fetchImpl: async () => json({}, 500) }), cache: new Cache() });
  const b2 = await listen(down);
  assert.equal((await fetch(`${b2}/geocode?q=x`)).status, 502);
  assert.equal((await fetch(`${b2}/geocode?q=x`)).status, 502); // failures are retried, not cached
  down.close();
});

const GOOGLE_OK = { routes: [{ duration: '1500s', legs: [{ steps: [
  { travelMode: 'WALK', staticDuration: '120s', polyline: { encodedPolyline: '_p~iF~ps|U' } },
  { travelMode: 'WALK', staticDuration: '60s', polyline: { encodedPolyline: '_ulLnnqC' } },
  { travelMode: 'TRANSIT', staticDuration: '1200s', polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' }, startLocation: { latLng: { latitude: 1, longitude: 2 } },
    transitDetails: { headsign: 'El Casar', stopCount: 8, stopDetails: { departureStop: { name: 'Legazpi', location: { latLng: { latitude: 40.39, longitude: -3.69 } } }, arrivalStop: { name: 'Moncloa' } },
      transitLine: { nameShort: '3', vehicle: { type: 'SUBWAY' } } } },
  { travelMode: 'WALK', staticDuration: '120s' }] }] }] };

test('route: Google called once per distinct trip (key stays server-side), cached, merged steps, monthly cap, errors', async () => {
  const calls = [];
  const fetchImpl = async (u, o) => {
    calls.push({ u: String(u), o });
    return json(GOOGLE_OK);
  };
  const cache = new Cache();
  const srv = createServer({ googleKey: 'SECRET', monthlyLimit: 2, fetchImpl, cache, geocode: async () => ({ found: false }) });
  const base = await listen(srv);
  const post = (b) => fetch(`${base}/route`, { method: 'POST', body: JSON.stringify(b) });
  const trip = { from: { lat: 40.39121, lng: -3.69512 }, to: { lat: 40.4352, lng: -3.7192 }, arriveBy: '09:00' };

  const a = await post(trip);
  assert.equal(a.headers.get('x-cache'), 'MISS');
  const r = await a.json();
  assert.equal(r.found, true); assert.equal(r.minutes, 25); assert.equal(r.transfers, 0);
  assert.deepEqual(r.steps.map((s) => [s.mode, s.minutes]), [['walk', 3], ['subway', 20], ['walk', 2]]); // two walk steps merged
  assert.match(r.steps[1].text, /Metro 3 · Legazpi → Moncloa · dir\. El Casar · 8 stops/);
  assert.deepEqual(r.steps[1].board, [40.39, -3.69]);
  assert.deepEqual([r.steps[1].label, r.steps[1].line, r.steps[1].from, r.steps[1].to, r.steps[1].stops, r.steps[1].headsign], ['Metro', '3', 'Legazpi', 'Moncloa', 8, 'El Casar']);
  assert.equal(calls[0].o.headers['X-Goog-Api-Key'], 'SECRET');
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  const sent = JSON.parse(calls[0].o.body);
  assert.equal(sent.travelMode, 'TRANSIT');
  assert.equal(sent.origin.location.latLng.latitude, 40.3912); // rounded to 4 dp
  assert.match(sent.arrivalTime, /T0[78]:00:00Z$/); // 09:00 Madrid = 07:00 or 08:00 UTC

  // nearby listing (same 4-dp cell) and a repeat: served from cache, no extra paid call
  assert.equal((await post({ ...trip, from: { lat: 40.391204, lng: -3.695118 } })).headers.get('x-cache'), 'HIT');
  assert.equal(calls.length, 1);
  const h = await (await fetch(`${base}/health`)).json();
  assert.equal(h.routing, 'google'); assert.equal(h.paidCallsThisMonth, 1);

  // second distinct trip uses the last allowed call; the third is refused without calling Google
  assert.equal((await post({ ...trip, to: { lat: 40.5, lng: -3.7 } })).status, 200);
  const over = await post({ ...trip, to: { lat: 40.6, lng: -3.7 } });
  assert.equal(over.status, 429); assert.equal((await over.json()).fatal, true);
  assert.equal(calls.length, 2);
  assert.equal((await post({ from: { lat: 'x' }, to: trip.to })).status, 400);
  assert.equal((await fetch(`${base}/otp/gtfs/v1`, { method: 'POST', body: '{}' })).status, 404);
  srv.close();

  const nokey = createServer({ fetchImpl, cache: new Cache(), geocode: async () => ({ found: false }) });
  const b2 = await listen(nokey);
  const nk = await fetch(`${b2}/route`, { method: 'POST', body: JSON.stringify(trip) });
  assert.equal(nk.status, 503); assert.match((await nk.json()).error, /GOOGLE_API_KEY/);
  nokey.close();

  const bad = createServer({ googleKey: 'k', fetchImpl: async () => json({ error: { message: 'API not enabled' } }, 403), cache: new Cache(), geocode: async () => ({ found: false }) });
  const b3 = await listen(bad);
  for (let i = 0; i < 2; i++) { const e = await fetch(`${b3}/route`, { method: 'POST', body: JSON.stringify(trip) }); assert.equal(e.status, 502); assert.equal((await e.json()).fatal, true); }
  bad.close();

  const none = createServer({ googleKey: 'k', fetchImpl: async () => json({}), cache: new Cache(), geocode: async () => ({ found: false }) });
  const b4 = await listen(none);
  assert.deepEqual(await (await fetch(`${b4}/route`, { method: 'POST', body: JSON.stringify(trip) })).json(), { found: false });
  none.close();
});

test('targetArrival is the next Wednesday at the Madrid wall-clock time, DST-aware', async () => {
  const { targetArrival } = await import('./google.mjs');
  assert.equal(targetArrival('09:00', new Date('2026-11-12T12:00:00Z')), '2026-11-18T08:00:00Z'); // winter: UTC+1
  assert.equal(targetArrival('09:00', new Date('2026-07-01T12:00:00Z')), '2026-07-08T07:00:00Z'); // summer: UTC+2
  assert.equal(targetArrival('18:30', new Date('2026-11-18T05:00:00Z')), '2026-11-25T17:30:00Z'); // today is Wed: next one
});

test('tiles: fetched once with an identifying UA, then served from disk; bad coordinates rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiles-'));
  let n = 0;
  const fetchImpl = async (u, o) => {
    n++;
    assert.equal(String(u), 'https://tile.openstreetmap.org/12/1/2.png');
    assert.match(o.headers['User-Agent'], /idealista-commute-gateway/);
    return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });
  };
  const srv = createServer({ fetchImpl, cache: new Cache(), tileDir: dir, geocode: async () => ({ found: false }) });
  const base = await listen(srv);
  const a = await fetch(`${base}/tile/12/1/2.png`);
  assert.equal(a.headers.get('x-cache'), 'MISS');
  assert.equal(a.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}/tile/12/1/2.png`)).headers.get('x-cache'), 'HIT');
  assert.equal(n, 1);
  assert.equal((await fetch(`${base}/tile/3/9/0.png`)).status, 400); // x out of range
  assert.equal((await fetch(`${base}/tile/18/0/0.png`)).status, 400); // too deep
  assert.equal((await fetch(`${base}/tile/../../etc/passwd`)).status, 404);
  srv.close();
});

test('custom router: used instead of Google, cached, reported in /health', async () => {
  const { default: route, routerName } = await import('../routers/example-router.mjs');
  route.routerName = routerName;
  let calls = 0;
  const router = Object.assign(async (a) => { calls++; return route(a); }, { routerName: 'example' });
  const srv = createServer({ router, cache: new Cache(), geocode: async () => ({ found: false }) });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const body = JSON.stringify({ from: { lat: 40.39, lng: -3.69 }, to: { lat: 40.43, lng: -3.71 }, arriveBy: '09:00' });
    const post = () => fetch(`${base}/route`, { method: 'POST', body }).then((r) => r.json());
    const a = await post(), b = await post();
    assert.equal(a.found, true); assert.equal(a.steps[0].mode, 'walk'); assert.deepEqual(a, b);
    assert.equal(calls, 1);
    assert.equal((await (await fetch(`${base}/health`)).json()).routing, 'example');
  } finally { srv.close(); }
});
