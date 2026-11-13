// Keeps API keys encrypted at rest. storage.local only ever holds ciphertext (key "vault"); the decrypted keys live in
// storage.session (memory only, trusted extension contexts only, gone when the browser closes), so the passphrase is
// asked once per browser session. Encryption: PBKDF2-SHA256 -> AES-256-GCM, so a wrong passphrase fails loudly.
export const SECRET_FIELDS = ['googleKey', 'sightengineUser', 'sightengineSecret'];
const ITER = 600000;
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const enc = new TextEncoder();

async function deriveKey(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encrypt(secrets, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt, ITER);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(secrets))));
  return { v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export async function decrypt(blob, pass) {
  const key = await deriveKey(pass, unb64(blob.salt), blob.iter);
  try {
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct))));
  } catch { throw new Error('Wrong passphrase.'); }
}

// --- extension storage glue (browser.* only exists inside the extension) ---
export async function vaultState() {
  const { vault } = await browser.storage.local.get('vault');
  if (!vault) return { exists: false, unlocked: false, secrets: {} };
  const { secrets } = await browser.storage.session.get('secrets');
  return { exists: true, unlocked: !!secrets, secrets: secrets || {} };
}

export async function unlock(pass) {
  const { vault } = await browser.storage.local.get('vault');
  const secrets = await decrypt(vault, pass);
  await browser.storage.session.set({ secrets });
  return secrets;
}

export async function lock() { await browser.storage.session.remove('secrets'); }

// Encrypts and stores the secrets, then removes any plaintext copy from settings. An empty set removes the vault.
export async function saveSecrets(secrets, pass) {
  const { settings = {} } = await browser.storage.local.get('settings');
  for (const f of SECRET_FIELDS) delete settings[f];
  if (!Object.values(secrets).some(Boolean)) {
    await browser.storage.local.set({ settings });
    await browser.storage.local.remove('vault');
    await lock();
    return;
  }
  const vault = await encrypt(secrets, pass);
  await browser.storage.local.set({ settings, vault });
  await browser.storage.session.set({ secrets });
}
