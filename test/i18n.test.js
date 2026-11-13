import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const load = (l) => JSON.parse(readFileSync(new URL(`../_locales/${l}/messages.json`, import.meta.url), 'utf8'));
const es = load('es'), en = load('en');
const files = ['content.js', 'background.js', 'popup.js', 'options.js', 'options.html', 'popup.html', 'manifest.json',
  ...readdirSync(new URL('../lib', import.meta.url)).filter((f) => f.endsWith('.js') && f !== 'i18n.js').map((f) => 'lib/' + f)];
const src = files.map((f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8')).join('\n');

test('Spanish and English define the same messages with the same substitutions', () => {
  assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort());
  for (const k of Object.keys(es)) assert.deepEqual(Object.keys(es[k].placeholders || {}).sort(), Object.keys(en[k].placeholders || {}).sort(), k);
});

test('every message used by the code or the HTML exists', () => {
  const used = new Set([...src.matchAll(/\bt\('(\w+)'/g)].map((m) => m[1]));
  for (const m of src.matchAll(/data-i18n(?:-[a-z-]+)?="(\w+)"/g)) used.add(m[1]);
  for (const m of src.matchAll(/__MSG_(\w+)__/g)) used.add(m[1]);
  for (const k of used) assert.ok(es[k], 'missing message ' + k);
});

test('Spanish is the default locale', () => {
  assert.equal(JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')).default_locale, 'es');
});
