// Options page.
import { normalizeServerUrl, DEFAULT_URL } from './lib/url.js';
import { health } from './lib/backend.js';

const $ = (id) => document.getElementById(id);

async function load() {
  const { settings = {}, usage = {} } = await browser.storage.local.get(['settings', 'usage']);
  $('workAddress').value = settings.workAddress || '';
  $('arriveBy').value = settings.arriveBy || '09:00';
  $('citySuffix').value = settings.citySuffix || 'Madrid, España';
  $('serverUrl').value = settings.serverUrl || '';
  $('debug').checked = !!settings.debug;
  $('pinFromMap').checked = settings.pinFromMap !== false;
  const month = new Date().toISOString().slice(0, 7);
  $('usage').textContent = 'Route requests this month: ' +
    (usage.routes?.[month] || 0) + ' (this browser; cached answers are free)';
}

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
  const out = $('testResult');
  out.textContent = 'Testing…';
  const pending = grantServer($('serverUrl').value);
  const url = await pending;
  if (!url) { out.textContent = '✗ invalid address, or permission refused'; return; }
  try {
    const j = await health(url);
    out.textContent = j.routing
      ? `✓ connected (routing: ${j.routing}, ${j.paidCallsThisMonth ?? 0}/${j.monthlyLimit ?? '∞'} paid calls this month, ${j.cache?.entries ?? 0} cached entries)`
      : '✗ reached the server but it has no routing backend configured (set GOOGLE_API_KEY in server/.env)';
  } catch (e) {
    out.textContent = `✗ cannot reach ${url}: ${e.name}: ${e.message}`;
  }
});

$('save').addEventListener('click', async () => {
  const pending = $('serverUrl').value.trim() ? grantServer($('serverUrl').value) : Promise.resolve('');
  const { settings = {} } = await browser.storage.local.get('settings');
  const serverUrl = await pending;
  if (serverUrl === null) {
    $('status').textContent = 'Not saved: the server URL is invalid, or the permission to reach it was refused.';
    return;
  }
  const next = {
    ...settings,
    serverUrl: serverUrl === DEFAULT_URL ? '' : serverUrl,
    workAddress: $('workAddress').value.trim(),
    arriveBy: $('arriveBy').value || '09:00',
    citySuffix: $('citySuffix').value.trim(),
    debug: $('debug').checked,
    pinFromMap: $('pinFromMap').checked,
  };
  await browser.storage.local.set({ settings: next });
  $('status').textContent = 'Saved. Reload your idealista tab.';
});

$('clear').addEventListener('click', async () => {
  const all = await browser.storage.local.get(null);
  const drop = Object.keys(all).filter((k) => /^(g|r\d*|p|l):/.test(k));
  await browser.storage.local.remove(drop);
  $('status').textContent = `Cleared ${drop.length} cached entries.`;
});

load();
