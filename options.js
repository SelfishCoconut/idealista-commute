// Options page.
import { normalizeServerUrl, DEFAULT_URL } from './lib/url.js';
import { health } from './lib/backend.js';
import { ORIGIN as SIGHT_ORIGIN } from './lib/sightengine.js';
import { vaultState, unlock, saveSecrets, SECRET_FIELDS } from './lib/vault.js';
import { t, applyI18n } from './lib/i18n.js';
import { ORIGINS as DIRECT_ORIGINS, validTileUrl } from './lib/direct.js';

const $ = (id) => document.getElementById(id);
applyI18n();
document.title = t('optTitle');
let vault = { exists: false, unlocked: false, secrets: {} };
let legacy = false; // keys still sitting unencrypted in settings from before the vault existed

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
  const w = $('workAddress').value.trim(), tm = $('arriveBy').value;
  $('previewCap').textContent = !w ? t('previewCap') : tm ? t('previewCapToBy', w, tm) : t('previewCapTo', w);
}
function setTest(kind, text) {
  $('testDot').className = 'dot' + (kind ? ' ' + kind : '');
  $('testResult').textContent = text;
}

async function load() {
  const { settings = {}, usage = {} } = await browser.storage.local.get(['settings', 'usage']);
  vault = await vaultState();
  const locked = vault.exists && !vault.unlocked;
  // While locked nothing else is shown: the settings stay behind the passphrase.
  $('gate').hidden = !locked; $('app').hidden = locked; $('bar').hidden = locked;
  if (locked) { $('gatePass').focus(); return; }
  // Keys come from the unlocked vault; a plaintext copy in settings is from before encryption existed and gets encrypted on the next save.
  legacy = !vault.exists && SECRET_FIELDS.some((f) => settings[f]);
  const sec = vault.exists ? vault.secrets : settings;
  for (const f of SECRET_FIELDS) { $(f).value = sec[f] || ''; $(f).disabled = locked; }
  $('vaultHint').textContent = locked ? t('vaultLocked')
    : vault.exists ? t('vaultEncrypted')
    : t('vaultNew');
  $('workAddress').value = settings.workAddress || '';
  $('arriveBy').value = settings.arriveBy || '09:00';
  $('citySuffix').value = settings.citySuffix || 'Madrid, España';
  $('serverUrl').value = settings.serverUrl || '';
  $('accessToken').value = settings.accessToken || '';
  $('sightengineLimit').value = settings.sightengineLimit || 1500;
  $('pinFromMap').checked = settings.pinFromMap !== false;
  $('sortAllPages').checked = !!settings.sortAllPages;
  $('sortPages').value = settings.sortPages || 5;
  // Saved choice; before it existed, a saved key meant "browser".
  const source = settings.aiSource || (settings.sightengineUser && settings.sightengineSecret ? 'browser' : 'server');
  document.querySelector(`input[name=aiSource][value=${source}]`).checked = true;
  $('googleLimit').value = settings.googleLimit || 2000;
  $('tileUrl').value = settings.tileUrl || '';
  document.querySelector(`input[name=backend][value=${settings.backend === 'browser' ? 'browser' : 'server'}]`).checked = true;
  showBackend(); showSource(); showPreview();
  const month = new Date().toISOString().slice(0, 7);
  $('usage').replaceChildren(dl(t('usageRoutes'), usage.routes?.[month] || 0), dl(t('usagePhotos'), usage.ai?.[month] || 0));
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
  setTest('busy', t('testBusy'));
  const url = await grantServer($('serverUrl').value);
  if (!url) { setTest('bad', t('testBadUrl')); return; }
  try {
    const j = await health(url);
    const ai = j.aiCheck ? t('testAiOn', j.aiCallsThisMonth ?? 0, j.aiMonthlyLimit ?? '∞') : t('testAiOff');
    if (j.routing) setTest('ok', t('testOk', j.routing, j.paidCallsThisMonth ?? 0, j.monthlyLimit ?? '∞', ai));
    else setTest('bad', t('testNoRouting'));
  } catch (e) {
    setTest('bad', t('testCannot', url, e.message));
  }
});

$('save').addEventListener('click', async () => {
  const aiSource = sourceChoice();
  const locked = vault.exists && !vault.unlocked;
  const backend = backendChoice(), googleKey = locked ? vault.secrets.googleKey || '' : $('googleKey').value.trim();
  if (!locked && backend === 'browser' && !googleKey) {
    $('status').textContent = t('saveNeedGoogle');
    return;
  }
  const sightUser = locked ? '' : $('sightengineUser').value.trim(), sightSecret = locked ? '' : $('sightengineSecret').value.trim();
  if (!locked && aiSource === 'browser' && !(sightUser && sightSecret)) {
    $('status').textContent = t('saveNeedSight');
    return;
  }
  const secrets = { googleKey, sightengineUser: sightUser, sightengineSecret: sightSecret };
  const pass = $('passphrase').value;
  const changed = !locked && SECRET_FIELDS.some((f) => (secrets[f] || '') !== (vault.exists ? vault.secrets[f] || '' : ''));
  if ((changed || legacy) && Object.values(secrets).some(Boolean) && pass.length < 8) {
    $('status').textContent = t('saveNeedPass');
    return;
  }
  const tileUrl = $('tileUrl').value.trim();
  if (backend === 'browser' && tileUrl && !validTileUrl(tileUrl)) {
    $('status').textContent = t('saveBadTile');
    return;
  }
  const needServer = backend === 'server' || aiSource === 'server';
  const pending = needServer && $('serverUrl').value.trim() ? grantServer($('serverUrl').value) : Promise.resolve('');
  // Same click, same tick: one permission prompt for every service this browser will call itself.
  const origins = [...(backend === 'browser' ? [...DIRECT_ORIGINS, ...(tileUrl ? [new URL(tileUrl.replace(/\{[zxy]\}/g, '0')).origin + '/*'] : [])] : []), ...(aiSource === 'browser' ? [SIGHT_ORIGIN] : [])];
  const sightPending = origins.length ? browser.permissions.request({ origins }) : Promise.resolve(true);
  const { settings = {} } = await browser.storage.local.get('settings');
  const serverUrl = await pending;
  if (!(await sightPending)) {
    $('status').textContent = t('savePermRefused');
    return;
  }
  if (serverUrl === null) {
    $('status').textContent = t('saveBadServer');
    return;
  }
  const next = {
    ...settings,
    serverUrl: !needServer ? settings.serverUrl || '' : serverUrl === DEFAULT_URL ? '' : serverUrl, // untouched when nothing uses the server
    accessToken: $('accessToken').value.trim(),
    backend,
    tileUrl,
    googleLimit: Math.max(1, Number($('googleLimit').value) || 2000),
    aiSource,
    sightengineLimit: Math.max(1, Number($('sightengineLimit').value) || 1500),
    workAddress: $('workAddress').value.trim(),
    arriveBy: $('arriveBy').value || '09:00',
    citySuffix: $('citySuffix').value.trim(),
    pinFromMap: $('pinFromMap').checked,
    sortAllPages: $('sortAllPages').checked,
    sortPages: Math.min(20, Math.max(2, Number($('sortPages').value) || 5)),
  };
  for (const f of SECRET_FIELDS) delete next[f]; // never into settings; they go to the encrypted vault
  await browser.storage.local.set({ settings: next });
  if (changed || legacy) {
    try { await saveSecrets(secrets, pass); } catch (e) { $('status').textContent = t('saveKeysFailed', e.message); return; }
    $('passphrase').value = '';
  }
  await load();
  $('status').textContent = t('saved');
});


$('clear').addEventListener('click', async () => {
  const all = await browser.storage.local.get(null);
  const drop = Object.keys(all).filter((k) => /^(g|r\d*|p|l|ai|aip):/.test(k));
  await browser.storage.local.remove(drop);
  $('status').textContent = t('cleared', drop.length);
});

$('gate').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('gateErr').textContent = '';
  try { await unlock($('gatePass').value); $('gatePass').value = ''; await load(); }
  catch (err) { $('gateErr').textContent = err.message; }
});

// Unlocking or locking from the toolbar popup or an idealista tab updates this page too.
browser.storage.onChanged.addListener((_c, area) => { if (area === 'session') load(); });

load();
