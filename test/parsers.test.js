import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAddress, nextArrival } from '../lib/address.js';
import { Throttle, ProviderError, withRetry } from '../lib/throttle.js';

test('parseAddress strips the property type and adds the city', () => {
  assert.equal(parseAddress('Piso en calle de Embajadores, Lavapiés-Embajadores, Madrid'),
    'calle de Embajadores, Lavapiés-Embajadores, Madrid');
  assert.equal(parseAddress('Ático en Argüelles'), 'Argüelles, Madrid, España');
  assert.equal(parseAddress('Casa o chalet en Pozuelo de Alarcón, Madrid'), 'Pozuelo de Alarcón, Madrid');
  assert.equal(parseAddress(''), null);
});

test('parseAddress strips "en venta"/"en alquiler" leftovers', () => {
  assert.equal(parseAddress('Ático en venta en Prosperidad - Chamartín, Madrid'), 'Prosperidad - Chamartín, Madrid');
  assert.equal(parseAddress('Piso en alquiler en calle de Alcalá, Salamanca, Madrid'), 'calle de Alcalá, Salamanca, Madrid');
  assert.equal(parseAddress('Piso en Prosperidad - Chamartín, Madrid'), 'Prosperidad - Chamartín, Madrid');
});

test('addressCandidates offers simpler fallbacks', async () => {
  const { addressCandidates } = await import('../lib/address.js');
  assert.deepEqual(addressCandidates('Prosperidad - Chamartín, Madrid'), [
    'Prosperidad - Chamartín, Madrid',
    'Prosperidad Chamartín, Madrid, España',
    'Prosperidad, Madrid, España',
    'Chamartín, Madrid, España',
  ]);
  const c = addressCandidates('calle de Embajadores, Lavapiés-Embajadores, Madrid');
  assert.equal(c[0], 'calle de Embajadores, Lavapiés-Embajadores, Madrid');
  assert.ok(c.includes('calle de Embajadores, Madrid, España'));
  // Listings in another town must never fall back to "street, Madrid" (that is a different place, 80 km away).
  assert.deepEqual(addressCandidates('Centro, Aranjuez, Madrid, España'), [
    'Centro, Aranjuez, Madrid, España', 'Aranjuez, Madrid, España', 'Aranjuez, España']);
  assert.deepEqual(addressCandidates('calle del Pozo, San Martín de Valdeiglesias, Madrid, España'), [
    'calle del Pozo, San Martín de Valdeiglesias, Madrid, España', 'San Martín de Valdeiglesias, Madrid, España', 'San Martín de Valdeiglesias, España']);
  assert.deepEqual(addressCandidates('San Martín de Valdeiglesias, Madrid, España'), ['San Martín de Valdeiglesias, Madrid, España']);
  assert.deepEqual(addressCandidates(''), []);
});

test('nextArrival skips weekends and past times', () => {
  const sat = new Date(2026, 10, 14, 12, 0); // Sat 14 Nov 2026
  const d = nextArrival('09:00', sat);
  assert.equal(d.getDay(), 1); // Monday
  assert.equal(d.getHours(), 9);
  const monMorning = new Date(2026, 10, 9, 7, 0);
  assert.equal(nextArrival('09:00', monMorning).getDate(), 9);
});

test('Throttle spaces calls; withRetry retries only retryable errors', async () => {
  const t = new Throttle(60);
  const times = [];
  await Promise.all([1, 2, 3].map(() => t.run(async () => times.push(Date.now()))));
  assert.ok(times[1] - times[0] >= 55 && times[2] - times[1] >= 55);

  let n = 0;
  const v = await withRetry(async () => { if (++n < 2) throw new ProviderError('x', { retryable: true }); return 'ok'; }, [1]);
  assert.equal(v, 'ok');
  await assert.rejects(withRetry(async () => { throw new ProviderError('bad key', { fatal: true }); }, [1]), /bad key/);
});

test('normalizeServerUrl accepts bare IPs/hosts and rejects junk', async () => {
  const { normalizeServerUrl, DEFAULT_URL } = await import('../lib/url.js');
  assert.equal(normalizeServerUrl(''), DEFAULT_URL);
  assert.equal(normalizeServerUrl('192.168.1.50'), 'http://192.168.1.50:8085');
  assert.equal(normalizeServerUrl(' http://192.168.1.50:9000/ '), 'http://192.168.1.50:9000');
  assert.equal(normalizeServerUrl('myhost.local'), 'http://myhost.local:8085');
  assert.equal(normalizeServerUrl('https://x.example'), 'https://x.example');
  assert.equal(normalizeServerUrl('ftp://x'), null);
  assert.equal(normalizeServerUrl('http://'), null);
});

test('backend.geocode: hit, miss, unreachable', async () => {
  const { geocode } = await import('../lib/backend.js');
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async (u) => {
      assert.match(String(u), /^http:\/\/192\.168\.1\.50:8085\/geocode\?q=Prosperidad/);
      return new Response(JSON.stringify({ found: true, lat: 40.5, lng: -3.69, label: 'x' }));
    };
    assert.deepEqual(await geocode('Prosperidad', { serverUrl: '192.168.1.50' }), { lat: 40.5, lng: -3.69, label: 'x' });
    globalThis.fetch = async () => new Response(JSON.stringify({ found: false }));
    assert.equal(await geocode('zzz', {}), null);
    globalThis.fetch = async () => { throw new TypeError('network'); };
    await assert.rejects(geocode('x', { serverUrl: '10.0.0.9' }), /not reachable at http:\/\/10\.0\.0\.9:8085/);
  } finally { globalThis.fetch = real; }
});

test('decodePolyline matches the documented example; thin keeps the ends', async () => {
  const { decodePolyline, thin } = await import('../lib/map.js');
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  const many = Array.from({ length: 1000 }, (_, i) => [i, i]);
  const t = thin(many, 100);
  assert.equal(t.length, 100); assert.deepEqual(t[0], [0, 0]); assert.deepEqual(t[99], [999, 999]);
});

test('buildMapSvg frames both points, fetches only the tiles in view, escapes text, survives tile failures', async () => {
  const { buildMapSvg, view, tilesFor } = await import('../lib/map.js');
  const home = { lat: 40.3912, lng: -3.6951 }, work = { lat: 40.4352, lng: -3.7192 };
  const v = view([[home.lat, home.lng], [work.lat, work.lng]]);
  assert.ok(v.z >= 12 && v.z <= 16);
  const n = tilesFor(v).length;
  assert.ok(n >= 1 && n <= 12);
  const asked = [];
  const steps = [{ mode: 'walk', path: [[40.3912, -3.6951], [40.3910, -3.6950]] },
    { mode: 'subway', path: [[40.3910, -3.6950], [40.4352, -3.7192]], board: [40.3910, -3.6950] }];
  const svg = await buildMapSvg({ steps, home, work }, async (z, x, y) => { asked.push([z, x, y]); return 'data:image/png;base64,AAAA'; });
  assert.equal(asked.length, n);
  assert.match(svg, /^<svg[^>]*viewBox="0 0 640 360"/);
  assert.match(svg, /OpenStreetMap contributors/);
  assert.equal((svg.match(/<image /g) || []).length, n);
  const none = await buildMapSvg({ steps: [], home, work }, async () => { throw new Error('down'); });
  assert.ok(!none.includes('<image') && none.includes('Home') && none.includes('Work')); // still draws without tiles
});

test('parseRoute decodes and thins polylines, null when not found', async () => {
  const { parseRoute: parseGateway } = await import('../lib/backend.js');
  const r = parseGateway({ found: true, minutes: 20, transfers: 0, steps: [
    { mode: 'subway', minutes: 20, text: 'Metro 3 (20 min)', polys: ['_p~iF~ps|U_ulLnnqC'], board: [40.1, -3.1] },
    { mode: 'walk', minutes: 2, text: 'Walk 2 min', polys: [] }] });
  assert.equal(r.steps[0].path.length, 2);
  assert.equal(r.steps[0].polys, undefined);
  assert.equal(r.steps[1].path, undefined);
  assert.equal(parseGateway({ found: false }), null);
});
