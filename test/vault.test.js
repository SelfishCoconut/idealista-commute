import test from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt } from '../lib/vault.js';

test('vault round-trips and stores no plaintext', async () => {
  const secrets = { googleKey: 'not-a-real-google-key', sightengineUser: 'u', sightengineSecret: 's3cret' };
  const blob = await encrypt(secrets, 'correct horse');
  assert.ok(!JSON.stringify(blob).includes('not-a-real'));
  assert.deepEqual(await decrypt(blob, 'correct horse'), secrets);
});

test('vault rejects a wrong passphrase', async () => {
  const blob = await encrypt({ googleKey: 'k' }, 'right');
  await assert.rejects(decrypt(blob, 'wrong'), /errWrongPass/);
});

test('two encryptions of the same data differ (fresh salt and iv)', async () => {
  const a = await encrypt({ a: 1 }, 'p'), b = await encrypt({ a: 1 }, 'p');
  assert.notEqual(a.ct, b.ct);
});
