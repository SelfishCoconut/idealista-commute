// Options page.
import { normalizeServerUrl, DEFAULT_URL } from './lib/url.js';
import { health } from './lib/backend.js';
import { ORIGIN as SIGHT_ORIGIN } from './lib/sightengine.js';

const $ = (id) => document.getElementById(id);

const dl = (label, value) => {
  const d = document.createElement('div'), t = document.createElement('dt'), v = document.createElement('dd');
  t.textContent = label; v.textContent = value; d.append(t, v);
  return d;
};
function showSource() {
  const key = document.querySelector('input[name=aiSource]:checked').value === 'browser';
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
  showSource(); showPreview();
  const month = new Date().toISOString().slice(0, 7);
  $('usage').replaceChildren(dl('Routes this month', usage.routes?.[month] || 0), dl('Photos scanned here', usage.ai?.[month] || 0));
}
for (const id of ['workAddress', 'arriveBy']) $(id).addEventListener('input', showPreview);
for (const r of document.querySelectorAll('input[name=aiSource]')) r.addEventListener('change', showSource);

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
  const aiSource = document.querySelector('input[name=aiSource]:checked').value;
  const sightUser = $('sightengineUser').value.trim(), sightSecret = $('sightengineSecret').value.trim();
  if (aiSource === 'browser' && !(sightUser && sightSecret)) {
    $('status').textContent = 'Not saved: enter your Sightengine API user and secret, or choose "My server".';
    return;
  }
  const pending = $('serverUrl').value.trim() ? grantServer($('serverUrl').value) : Promise.resolve('');
  // Same click, same tick: the permission prompt for calling Sightengine directly (browser source only).
  const sightPending = aiSource === 'browser' ? browser.permissions.request({ origins: [SIGHT_ORIGIN] }) : Promise.resolve(true);
  const { settings = {} } = await browser.storage.local.get('settings');
  const serverUrl = await pending;
  if (!(await sightPending)) {
    $('status').textContent = 'Not saved: permission to reach api.sightengine.com was refused (choose "My server" instead).';
    return;
  }
  if (serverUrl === null) {
    $('status').textContent = 'Not saved: the server URL is invalid, or the permission to reach it was refused.';
    return;
  }
  const next = {
    ...settings,
    serverUrl: serverUrl === DEFAULT_URL ? '' : serverUrl,
    accessToken: $('accessToken').value.trim(),
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
