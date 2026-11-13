// Options page.
import { normalizeServerUrl, DEFAULT_URL } from './lib/url.js';
import { health } from './lib/backend.js';
import { ORIGIN as SIGHT_ORIGIN } from './lib/sightengine.js';
import { ORIGINS as DIRECT_ORIGINS } from './lib/direct.js';

const $ = (id) => document.getElementById(id);

const dl = (label, value) => {
  const d = document.createElement('div'), t = document.createElement('dt'), v = document.createElement('dd');
  t.textContent = label; v.textContent = value; d.append(t, v);
  return d;
};
const backendChoice = () => document.querySelector('input[name=backend]:checked').value;
const sourceChoice = () => document.querySelector('input[name=aiSource]:checked').value;
// The server fields stay visible while either feature still uses the server.
function showBackend() {
  $('browserPanel').hidden = backendChoice() !== 'browser';
  $('serverPanel').hidden = backendChoice() === 'browser' && sourceChoice() === 'browser';
  $('serverWhy').hidden = backendChoice() !== 'browser';
}
function showSource() {
  const key = sourceChoice() === 'browser';
  showBackend();
  $('aiKeyPanel').hidden = !key;
  $('aiServerHint').hidden = key;
}
function showPreview() {
  const w = $('workAddress').value.trim(), t = $('arriveBy').value;
  $('previewCap').textContent = w ? `Example of the row added to each listing, to ${w}${t ? ' by ' + t : ''}` : 'Example of the row added to each listing';
}
function setTest(kind, text) {
  $('testDot').className = 'dot' + (kind ? ' ' + kind : '');
  $('testResult').textContent = text;
}

async function load() {
  const { settings = {}, usage = {} } = await browser.storage.local.get(['settings', 'usage']);
  $('workAddress').value = settings.workAddress || '';
  $('arriveBy').value = settings.arriveBy || '09:00';
  $('citySuffix').value = settings.citySuffix || 'Madrid, España';
  $('serverUrl').value = settings.serverUrl || '';
  $('accessToken').value = settings.accessToken || '';
  $('sightengineUser').value = settings.sightengineUser || '';
  $('sightengineSecret').value = settings.sightengineSecret || '';
  $('sightengineLimit').value = settings.sightengineLimit || 1500;
  $('pinFromMap').checked = settings.pinFromMap !== false;
  // Saved choice; before it existed, a saved key meant "browser".
  const source = settings.aiSource || (settings.sightengineUser && settings.sightengineSecret ? 'browser' : 'server');
  document.querySelector(`input[name=aiSource][value=${source}]`).checked = true;
  $('googleKey').value = settings.googleKey || '';
  $('googleLimit').value = settings.googleLimit || 2000;
  document.querySelector(`input[name=backend][value=${settings.backend === 'browser' ? 'browser' : 'server'}]`).checked = true;
  showBackend(); showSource(); showPreview();
  const month = new Date().toISOString().slice(0, 7);
  $('usage').replaceChildren(dl('Routes this month', usage.routes?.[month] || 0), dl('Photos scanned here', usage.ai?.[month] || 0));
}
for (const id of ['workAddress', 'arriveBy']) $(id).addEventListener('input', showPreview);
for (const r of document.querySelectorAll('input[name=aiSource]')) r.addEventListener('change', showSource);
for (const r of document.querySelectorAll('input[name=backend]')) r.addEventListener('change', showBackend);

// Firefox only shows the permission prompt if this is called straight from the click handler,
// so callers invoke it before any other await. Returns the normalized URL, or null if refused/invalid.
async function grantServer(raw) {
  const url = normalizeServerUrl(raw);
  if (!url) return null;
  if (url === DEFAULT_URL || url === 'http://localhost:8085') return url; // already in host_permissions
  const ok = await browser.permissions.request({ origins: [new URL(url).origin + '/*'] });
  return ok ? url : null;
}

$('test').addEventListener('click', async () => {
  setTest('busy', 'Testing…');
  const url = await grantServer($('serverUrl').value);
  if (!url) { setTest('bad', 'Invalid address, or permission refused'); return; }
  try {
    const j = await health(url);
    const ai = j.aiCheck ? `photo check on (${j.aiCallsThisMonth ?? 0}/${j.aiMonthlyLimit ?? '∞'} this month)` : 'photo check not set up';
    if (j.routing) setTest('ok', `Connected · ${j.routing} routing, ${j.paidCallsThisMonth ?? 0}/${j.monthlyLimit ?? '∞'} calls this month · ${ai}`);
    else setTest('bad', 'Reached the server, but it has no routing backend (set GOOGLE_API_KEY in server/.env)');
  } catch (e) {
    setTest('bad', `Cannot reach ${url}: ${e.message}`);
  }
});

$('save').addEventListener('click', async () => {
  const aiSource = sourceChoice();
  const backend = backendChoice(), googleKey = $('googleKey').value.trim();
  if (backend === 'browser' && !googleKey) {
    $('status').textContent = 'Not saved: enter your Google Routes API key, or choose "My server".';
    return;
  }
  const sightUser = $('sightengineUser').value.trim(), sightSecret = $('sightengineSecret').value.trim();
  if (aiSource === 'browser' && !(sightUser && sightSecret)) {
    $('status').textContent = 'Not saved: enter your Sightengine API user and secret, or choose "My server".';
    return;
  }
  const needServer = backend === 'server' || aiSource === 'server';
  const pending = needServer && $('serverUrl').value.trim() ? grantServer($('serverUrl').value) : Promise.resolve('');
  // Same click, same tick: one permission prompt for every service this browser will call itself.
  const origins = [...(backend === 'browser' ? DIRECT_ORIGINS : []), ...(aiSource === 'browser' ? [SIGHT_ORIGIN] : [])];
  const sightPending = origins.length ? browser.permissions.request({ origins }) : Promise.resolve(true);
  const { settings = {} } = await browser.storage.local.get('settings');
  const serverUrl = await pending;
  if (!(await sightPending)) {
    $('status').textContent = 'Not saved: permission to reach the services you chose to call from this browser was refused (choose "My server" instead).';
    return;
  }
  if (serverUrl === null) {
    $('status').textContent = 'Not saved: the server URL is invalid, or the permission to reach it was refused.';
    return;
  }
  const next = {
    ...settings,
    serverUrl: !needServer ? settings.serverUrl || '' : serverUrl === DEFAULT_URL ? '' : serverUrl, // untouched when nothing uses the server
    accessToken: $('accessToken').value.trim(),
    backend,
    googleKey,
    googleLimit: Math.max(1, Number($('googleLimit').value) || 2000),
    aiSource,
    sightengineUser: sightUser,
    sightengineSecret: sightSecret,
    sightengineLimit: Math.max(1, Number($('sightengineLimit').value) || 1500),
    workAddress: $('workAddress').value.trim(),
    arriveBy: $('arriveBy').value || '09:00',
    citySuffix: $('citySuffix').value.trim(),
    pinFromMap: $('pinFromMap').checked,
  };
  await browser.storage.local.set({ settings: next });
  $('status').textContent = 'Saved. Reload your idealista tab to apply.';
});

$('clear').addEventListener('click', async () => {
  const all = await browser.storage.local.get(null);
  const drop = Object.keys(all).filter((k) => /^(g|r\d*|p|l|ai|aip):/.test(k));
  await browser.storage.local.remove(drop);
  $('status').textContent = `Cleared ${drop.length} cached entries.`;
});

load();
