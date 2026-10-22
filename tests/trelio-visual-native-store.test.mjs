import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadVisualDependencies } from '../host-runtime/scripts/trelio-visual-bootstrap.mjs';
import { ProtectedVisualStore, visualStorageScope } from '../host-runtime/scripts/trelio-visual-store.mjs';

// Opt-in on a real logged-in desktop. Mock store tests do not establish that
// macOS Keychain, Windows Credential Manager or Linux Secret Service works.
test('native OS vault retains a synthetic encrypted snapshot after key buffers close', { skip: process.env.TRELIO_VISUAL_NATIVE_TEST !== '1', timeout: 60_000 }, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trelio-visual-native-')));
  const { AsyncEntry } = await loadVisualDependencies({ root: fileURLToPath(new URL('../host-runtime/scripts/visual-browser-dependencies/', import.meta.url)), install: false });
  const scope = visualStorageScope({ origin: 'https://example.test', skillId: 'synthetic-visual-fixture', accountId: randomUUID() });
  const make = () => new ProtectedVisualStore({ directory, scope, AsyncEntry });
  const store = make();
  try {
    await store.write({ schemaVersion: 1, cookies: [{ name: 'fixture', value: 'SYNTHETIC_ONLY' }], origins: [] });
    await store.writeCredentials({ login: 'SYNTHETIC_LOGIN', password: 'SYNTHETIC_PASSWORD', totp: 'SYNTHETIC_SEED' });
    store.close();
    const next = make();
    try {
      assert.equal((await next.read()).cookies[0].value, 'SYNTHETIC_ONLY');
      assert.doesNotMatch(await fs.readFile(next.file, 'utf8'), /SYNTHETIC_ONLY/);
      assert.equal((await next.readCredentials()).password, 'SYNTHETIC_PASSWORD');
      assert.doesNotMatch(await fs.readFile(next.credentialsFile, 'utf8'), /SYNTHETIC/);
      await next.forgetCredentials();
      assert.equal(await next.readCredentials(), null);
      assert.equal((await next.read()).cookies[0].value, 'SYNTHETIC_ONLY', 'forgetting a credential retains authenticated session');
    } finally { next.close(); }
  } finally { await store.remove(); await fs.rm(directory, { recursive: true, force: true }); }
});
