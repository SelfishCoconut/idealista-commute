import test from 'node:test';
import assert from 'node:assert/strict';
import { listingId, parseMapCoords, looksBlocked } from '../lib/idealista.js';

test('listingId reads the numeric id from listing links', () => {
  assert.equal(listingId('/inmueble/112919873/'), '112919873');
  assert.equal(listingId('https://www.idealista.com/inmueble/112919873/mapa'), '112919873');
  assert.equal(listingId('/venta-viviendas/madrid/'), null);
  assert.equal(listingId(undefined), null);
});

// The real /mapa markup could not be inspected (idealista blocks non-browser clients), so these use the common
// shapes the parser is meant to tolerate. Add a saved real page as a fixture when one is available.
test('parseMapCoords accepts the usual coordinate shapes and rejects non-Spanish numbers', () => {
  const at = (html) => parseMapCoords(html);
  assert.deepEqual(at('var ubication = {"latitude":"40.3912","longitude":"-3.6951"};'), { lat: 40.3912, lng: -3.6951, approx: false });
  assert.deepEqual(at('{"longitude": -3.6951, "latitude": 40.3912}'), { lat: 40.3912, lng: -3.6951, approx: false });
  assert.deepEqual(at("latitude: '40.4168', longitude: '-3.7038'"), { lat: 40.4168, lng: -3.7038, approx: false });
  assert.deepEqual(at('{"lat":40.4168,"lng":-3.7038}'), { lat: 40.4168, lng: -3.7038, approx: false });
  assert.deepEqual(at('<div data-lat="40.4168" data-lng="-3.7038"></div>'), { lat: 40.4168, lng: -3.7038, approx: false });
  assert.deepEqual(at('<img src="https://maps.googleapis.com/maps/api/staticmap?center=40.4168,-3.7038&zoom=15">'), { lat: 40.4168, lng: -3.7038, approx: false });
  assert.equal(at('{"latitude":"48.8566","longitude":"2.3522"}'), null); // Paris: not Spain
  assert.equal(at('{"latitude":"-3.7038","longitude":"40.4168"}'), null); // swapped
  assert.equal(at('<html>nothing here</html>'), null);
  assert.equal(at(''), null);
  assert.equal(at('{"latitude":"40.4168","longitude":"-3.7038"} zona aproximada').approx, true); // approximate area wording
});

test('looksBlocked detects bot checks', () => {
  assert.equal(looksBlocked(403, ''), true);
  assert.equal(looksBlocked(200, '<script src="https://geo.captcha-delivery.com/x.js">'), true);
  assert.equal(looksBlocked(200, '<html>mapa</html>'), false);
});

test('photoUrls keeps one (largest) URL per listing photo and ignores non-photo images', async () => {
  const { photoUrls, pickRandom } = await import('../lib/idealista.js');
  const P = (size, n) => `https://img4.idealista.com/blur/${size}/0/id.pro.es.image.master/aa/bb/${n}.jpg`;
  const html = `<img src="${P('WEB_LISTING-M', 1)}"><img data-ondemand-img="${P('WEB_DETAIL-L-L', 1)}">
    <script>{"url":"${P('WEB_DETAIL-L-L', 2).replace(/\//g, '\\/')}"}</script>
    <img src="https://img3.idealista.com/logo/agency.png"><img src="https://example.com/id.pro.es.image.master/x.jpg">`;
  assert.deepEqual(photoUrls(html), [P('WEB_DETAIL-L-L', 1), P('WEB_DETAIL-L-L', 2)]);
  assert.deepEqual(photoUrls(''), []);

  assert.equal(pickRandom([1, 2, 3, 4, 5], 3).length, 3);
  assert.equal(new Set(pickRandom([1, 2, 3, 4, 5], 3)).size, 3);
  assert.deepEqual(pickRandom([1, 2], 3).sort(), [1, 2]); // fewer photos than asked
  assert.deepEqual(pickRandom([], 3), []);
});

test('sightengine.scoreImage: POST body carries the credentials, errors classified', async () => {
  const { scoreImage } = await import('../lib/sightengine.js');
  const creds = { user: 'U', secret: 'S' };
  let seen;
  const ok = async (u, o) => { seen = { u: String(u), o }; return new Response(JSON.stringify({ status: 'success', type: { ai_generated: 0.42 } })); };
  assert.equal(await scoreImage('https://img4.idealista.com/a.jpg', creds, ok), 0.42);
  assert.ok(!seen.u.includes('S') || !/secret/i.test(seen.u)); // nothing secret in the URL
  assert.equal(seen.o.body.get('api_secret'), 'S');
  assert.equal(seen.o.body.get('models'), 'genai');
  const bad = async () => new Response(JSON.stringify({ status: 'failure', error: { type: 'credentials_error', message: 'nope' } }), { status: 401 });
  await assert.rejects(() => scoreImage('x', creds, bad), (e) => e.fatal === true && e.message === 'nope');
  const down = async () => new Response('{}', { status: 500 });
  await assert.rejects(() => scoreImage('x', creds, down), (e) => !e.fatal && e.retryable === true);
});

test('browser mode: lib/google.js is an exact copy of the server module; geocode falls back and fails only when both fail', async () => {
  const fs = await import('node:fs');
  assert.equal(fs.readFileSync(new URL('../lib/google.js', import.meta.url), 'utf8'), fs.readFileSync(new URL('../server/gateway/google.mjs', import.meta.url), 'utf8'),
    'lib/google.js must be a copy of server/gateway/google.mjs (the server dir is not packaged): re-copy it');
  const { geocode } = await import('../lib/direct.js');
  const hit = { lat: 1, lng: 2, label: 'x' };
  assert.deepEqual(await geocode('q', { nominatimFn: async () => null, photonFn: async () => hit }), hit);
  assert.equal(await geocode('q', { nominatimFn: async () => null, photonFn: async () => null }), null);
  assert.deepEqual(await geocode('q', { nominatimFn: async () => { throw new Error('x'); }, photonFn: async () => hit }), hit);
  await assert.rejects(() => geocode('q', { nominatimFn: async () => { throw new Error('x'); }, photonFn: async () => { throw new Error('y'); } }), (e) => e.retryable === true);
});

test('photoUrls falls back to any idealista image when the id.pro. naming is absent, but skips chrome images', async () => {
  const { photoUrls } = await import('../lib/idealista.js');
  const html = `<img src="https://img3.idealista.com/blur/WEB_DETAIL/0/abc/def/12345.jpg"><img src="https://img3.idealista.com/static/logo.png">
    <img src="https://img3.idealista.com/blur/WEB_LISTING-M/0/abc/def/12345.jpg">`;
  assert.deepEqual(photoUrls(html), ['https://img3.idealista.com/blur/WEB_DETAIL/0/abc/def/12345.jpg']);
});
