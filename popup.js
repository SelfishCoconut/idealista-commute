// Toolbar popup: the one place the key passphrase is typed. Shows locked / unlocked / no keys.
import { vaultState, unlock, lock } from './lib/vault.js';
import { t, applyI18n } from './lib/i18n.js';

applyI18n();
document.title = t('popupTitle');

const $ = (id) => document.getElementById(id);

async function render() {
  const v = await vaultState();
  const locked = v.exists && !v.unlocked;
  $('state').textContent = !v.exists ? t('popupNone')
    : locked ? t('popupLocked') : t('popupUnlocked');
  $('form').hidden = !locked;
  $('lock').hidden = !(v.exists && v.unlocked);
  $('settings').hidden = locked;
  if (locked) $('passphrase').focus();
}

// ---- address / arrival time (same settings as the options page) ----
async function loadSettings() {
  const { settings = {} } = await browser.storage.local.get('settings');
  $('workAddress').value = settings.workAddress || '';
  $('arriveBy').value = settings.arriveBy || '09:00';
}
$('settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { settings = {} } = await browser.storage.local.get('settings');
  await browser.storage.local.set({ settings: { ...settings, workAddress: $('workAddress').value.trim(), arriveBy: $('arriveBy').value || '09:00' } });
  $('err').textContent = '';
  $('save').textContent = t('popSaved');
  if (page) browser.tabs.reload(page); // results are recomputed for the new address
  setTimeout(() => window.close(), 600);
});

// ---- progress of the idealista tab in front ----
let page = null;
async function poll() {
  let p = null;
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    page = tab?.id ?? null;
    if (page != null) p = await browser.tabs.sendMessage(page, { type: 'getProgress' });
  } catch { p = null; }
  if (!p) page = null;
  $('prog').hidden = false;
  if (!p) { $('bar').hidden = true; $('progText').textContent = t('progNoPage'); $('progSub').textContent = ''; return; }
  $('bar').hidden = false;
  $('bar').max = Math.max(1, p.total); $('bar').value = p.ok + p.failed;
  $('progText').textContent = p.pending || p.status ? (p.status || t('progCounts', p.ok + p.failed, p.total)) : t('progDone');
  $('progSub').textContent = [p.pending ? t('progCounts', p.ok + p.failed, p.total) : '', p.failed ? t('progFailed', p.failed) : '', p.pages ? t('progPages', p.pages) : ''].filter(Boolean).join(' · ');
}
poll(); setInterval(poll, 600);
loadSettings();

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('err').textContent = '';
  try { await unlock($('passphrase').value); $('passphrase').value = ''; await render(); }
  catch (err) { $('err').textContent = err.message; }
});
$('lock').addEventListener('click', async () => { await lock(); await render(); });
$('options').addEventListener('click', (e) => { e.preventDefault(); browser.runtime.openOptionsPage(); window.close(); });

render();
