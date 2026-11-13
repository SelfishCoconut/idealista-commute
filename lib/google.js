// Google Routes API (transit) behind the gateway: the API key lives only on this server, and every answer
// is cached so identical trips are never paid for twice.
const ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
// Only the fields we use: the response (and billing tier) depends on the mask.
const FIELDS = [
  'routes.duration', 'routes.legs.steps.travelMode', 'routes.legs.steps.staticDuration',
  'routes.legs.steps.polyline.encodedPolyline', 'routes.legs.steps.startLocation', 'routes.legs.steps.endLocation',
  'routes.legs.steps.transitDetails',
].join(',');

const secs = (d) => Math.round(parseFloat(String(d || '0').replace('s', '')) || 0);
const KIND = { SUBWAY: ['subway', 'Metro'], BUS: ['bus', 'Bus'], INTERCITY_BUS: ['bus', 'Bus'], TROLLEYBUS: ['bus', 'Bus'],
  HEAVY_RAIL: ['rail', 'Train'], COMMUTER_TRAIN: ['rail', 'Train'], RAIL: ['rail', 'Train'], HIGH_SPEED_TRAIN: ['rail', 'Train'],
  LONG_DISTANCE_TRAIN: ['rail', 'Train'], TRAM: ['tram', 'Tram'], LIGHT_RAIL: ['tram', 'Tram'], MONORAIL: ['tram', 'Tram'] };

// The next Wednesday (a representative weekday: avoids Monday/Friday timetable quirks, and the same answer is
// reused all week) at HH:MM Madrid time, as an ISO instant. Madrid is UTC+1/+2; the offset is looked up, not assumed.
export function targetArrival(arriveBy = '09:00', now = new Date()) {
  const [h, m] = arriveBy.split(':').map(Number);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const parts = (d) => Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  let d = new Date(now.getTime() + 24 * 3600e3);
  while (parts(d).weekday !== 'Wed') d = new Date(d.getTime() + 24 * 3600e3);
  const p = parts(d);
  const guess = Date.UTC(+p.year, +p.month - 1, +p.day, h, m || 0);
  const asMadrid = (t) => { const x = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(t)); const g = (k) => +x.find((y) => y.type === k).value; return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')); };
  const offset = asMadrid(guess) - guess; // ms Madrid is ahead of UTC at that moment
  return new Date(guess - offset).toISOString().replace('.000Z', 'Z');
}

// Google response -> { minutes, transfers, steps:[{mode,minutes,text,polys,board}] } or null.
// Consecutive walking steps are merged; polylines stay encoded (the extension decodes them).
export function parseGoogle(json) {
  const route = json?.routes?.[0];
  if (!route) return null;
  const raw = (route.legs || []).flatMap((l) => l.steps || []);
  const steps = [];
  for (const s of raw) {
    const minutes = Math.max(1, Math.round(secs(s.staticDuration) / 60));
    const poly = s.polyline?.encodedPolyline;
    if (s.travelMode !== 'TRANSIT') {
      const prev = steps[steps.length - 1];
      if (prev?.mode === 'walk') { prev.sec += secs(s.staticDuration); if (poly) prev.polys.push(poly); continue; }
      steps.push({ mode: 'walk', sec: secs(s.staticDuration), polys: poly ? [poly] : [] });
      continue;
    }
    const t = s.transitDetails || {};
    const [mode, label] = KIND[t.transitLine?.vehicle?.type] || ['bus', t.transitLine?.vehicle?.name?.text || 'Transit'];
    const line = t.transitLine?.nameShort || t.transitLine?.name || '';
    const from = t.stopDetails?.departureStop?.name, to = t.stopDetails?.arrivalStop?.name;
    const loc = t.stopDetails?.departureStop?.location?.latLng ?? s.startLocation?.latLng;
    steps.push({
      mode, label, line, from, to, headsign: t.headsign, stops: t.stopCount, sec: secs(s.staticDuration), polys: poly ? [poly] : [],
      text: [`${label} ${line}`.trim(), from && to ? `${from} → ${to}` : '', t.headsign ? `dir. ${t.headsign}` : '',
        t.stopCount ? `${t.stopCount} stops` : ''].filter(Boolean).join(' · '),
      board: loc ? [loc.latitude, loc.longitude] : undefined,
    });
  }
  const out = steps.map(({ sec, text, ...rest }) => {
    const minutes = Math.max(1, Math.round(sec / 60));
    return { ...rest, minutes, text: rest.mode === 'walk' ? `Walk ${minutes} min` : `${text} (${minutes} min)` };
  });
  const rides = out.filter((s) => s.mode !== 'walk').length;
  const total = secs(route.duration) || steps.reduce((a, s) => a + s.sec, 0);
  return { minutes: Math.max(1, Math.round(total / 60)), transfers: Math.max(0, rides - 1), steps: out };
}

export async function fetchGoogleRoute({ key, from, to, arriveBy, fetchImpl = fetch, now = new Date(), endpoint = ENDPOINT }) {
  const wp = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const r = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDS },
    body: JSON.stringify({ origin: wp(from), destination: wp(to), travelMode: 'TRANSIT', arrivalTime: targetArrival(arriveBy, now), languageCode: 'es', units: 'METRIC' }),
  });
  const json = await r.json().catch(() => ({}));
  if (r.status === 400 && /ZERO_RESULTS|no route/i.test(JSON.stringify(json))) return { found: false };
  if (!r.ok) {
    const e = new Error(json?.error?.message || `Google ${r.status}`);
    e.status = r.status; // 403 = key/API not enabled or billing; 429 = quota
    throw e;
  }
  const route = parseGoogle(json);
  return route ? { found: true, provider: 'Google Routes', ...route } : { found: false };
}
