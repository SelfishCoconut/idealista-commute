// Takes the store screenshots with a headless Firefox, over WebDriver BiDi (no geckodriver or selenium needed).
//   node tools/screenshots/serve.mjs 8099 &   then   node tools/screenshots/shoot.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:8099/tools/screenshots', ROOT = new URL('../../', import.meta.url).pathname, OUT = join(ROOT, 'store/screenshots');
const results = '/results.html', options = '/../../options.html', popup = '/../../popup.html';
const expand = `document.querySelectorAll('.icm-head.icm-click')[1]?.click(); 0`;
const SHOTS = [
  ['1-resultados-es', `${results}?lang=es`, { w: 1280, h: 1000, wait: 5000, js: expand, after: 3000 }],
  ['2-results-en', `${results}?lang=en`, { w: 1280, h: 1000, wait: 5000, js: expand, after: 3000 }],
  ['3-opciones-es', `${options}?lang=es`, { w: 1280, h: 900, wait: 1200 }],
  ['4-options-en', `${options}?lang=en&state=fresh`, { w: 1280, h: 900, wait: 1200 }],
  ['5-bloqueado-es', `${options}?lang=es&state=locked`, { w: 1280, h: 800, wait: 1200 }],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'ff-shots-'));
const ff = spawn('firefox', ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port=9333'], { stdio: 'ignore' });
let ws, id = 0; const pending = new Map();
for (let i = 0; i < 60 && !ws; i++) {
  await sleep(500);
  try { ws = await new Promise((ok, no) => { const s = new WebSocket('ws://127.0.0.1:9333/session'); s.onopen = () => ok(s); s.onerror = no; }); } catch {}
}
if (!ws) { ff.kill(); throw new Error('Firefox did not start'); }
ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
const send = (method, params = {}) => new Promise((ok, no) => { const i = ++id; pending.set(i, (m) => (m.type === 'error' ? no(new Error(m.message)) : ok(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });

try {
  await send('session.new', { capabilities: {} });
  mkdirSync(OUT, { recursive: true });
  for (const [name, path, o] of SHOTS) {
    const { context } = await send('browsingContext.create', { type: 'tab' });
    await send('browsingContext.setViewport', { context, viewport: { width: o.w, height: o.h } });
    await send('browsingContext.navigate', { context, url: BASE + path, wait: 'complete' });
    await sleep(o.wait);
    if (o.js) { await send('script.evaluate', { expression: o.js, target: { context }, awaitPromise: false }); await sleep(o.after || 500); }
    const { data } = await send('browsingContext.captureScreenshot', { context, origin: o.full ? 'document' : 'viewport' });
    writeFileSync(join(OUT, name + '.png'), Buffer.from(data, 'base64'));
    console.log('saved', name);
    await send('browsingContext.close', { context });
  }
} finally { ws.close(); ff.kill(); }
