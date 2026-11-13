// Toolbar popup: the one place the key passphrase is typed. Shows locked / unlocked / no keys.
import { vaultState, unlock, lock } from './lib/vault.js';

const $ = (id) => document.getElementById(id);

async function render() {
  const v = await vaultState();
  const locked = v.exists && !v.unlocked;
  $('state').textContent = !v.exists ? 'No encrypted keys yet. Add them in the options.'
    : locked ? 'Your API keys are locked.' : 'Keys unlocked until the browser closes.';
  $('form').hidden = !locked;
  $('lock').hidden = !(v.exists && v.unlocked);
  if (locked) $('passphrase').focus();
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('err').textContent = '';
  try { await unlock($('passphrase').value); $('passphrase').value = ''; await render(); }
  catch (err) { $('err').textContent = err.message; }
});
$('lock').addEventListener('click', async () => { await lock(); await render(); });
$('options').addEventListener('click', (e) => { e.preventDefault(); browser.runtime.openOptionsPage(); window.close(); });

render();
