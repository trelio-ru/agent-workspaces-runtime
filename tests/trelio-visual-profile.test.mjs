import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { snapshotVisualProfile, restoreVisualProfile, prepareVisualProfileStartup } from '../host-runtime/scripts/trelio-visual-profile.mjs';
import { prepareVisualPrivateDirectory } from '../host-runtime/scripts/trelio-visual-bootstrap.mjs';

const archive = files => ({ schemaVersion: 2, profile: gzipSync(JSON.stringify(files)).toString('base64') });
const file = (name, value = 'SYNTHETIC_AUTH') => ({ path: name, data: Buffer.from(value).toString('base64') });

test('fresh owned profile seeds ordinary startup preferences without overwriting an accepted profile', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'visual-profile-startup-')));
  try {
    await prepareVisualProfileStartup(root);
    const prefs = path.join(root, 'Default', 'Preferences');
    assert.deepEqual(JSON.parse(await fs.readFile(prefs, 'utf8')), { session: { restore_on_startup: 1 } });
    const existing = '{ "profile": { "name": "SYNTHETIC" }, "session": { "restore_on_startup": 5 } }';
    await fs.writeFile(prefs, existing); await prepareVisualProfileStartup(root);
    assert.equal(await fs.readFile(prefs, 'utf8'), existing);
    await fs.rm(prefs); await fs.mkdir(prefs);
    await assert.rejects(prepareVisualProfileStartup(root), { code: 'VISUAL_STORAGE_CORRUPT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('stopped profile preserves selected auth stores and excludes history, cache and passwords', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'visual-profile-')));
  const input = path.join(root, 'input'), output = path.join(root, 'output');
  try {
    await prepareVisualPrivateDirectory(input);
    await fs.mkdir(path.join(input, 'Default', 'LocalStorage'), { recursive: true });
    await fs.writeFile(path.join(input, 'Local State'), 'SYNTHETIC_KEY');
    await fs.writeFile(path.join(input, 'Default/LocalStorage/000003.log'), 'SYNTHETIC_AUTH');
    for (const name of ['History', 'Login Data', 'Cache']) await fs.writeFile(path.join(input, 'Default', name), 'DO_NOT_COPY');
    const value = await snapshotVisualProfile(input); await restoreVisualProfile(value, output);
    assert.equal(await fs.readFile(path.join(output, 'Default/LocalStorage/000003.log'), 'utf8'), 'SYNTHETIC_AUTH');
    assert.deepEqual((await fs.readdir(path.join(output, 'Default'))), ['LocalStorage']);
    assert.equal(await fs.readFile(path.join(output, 'Local State'), 'utf8'), 'SYNTHETIC_KEY');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('invalid archive paths, duplicates and payloads fail before creating any profile file', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'visual-profile-invalid-')));
  try {
    for (const bad of [file('../state'), file('/Local State'), file('Default/../History'), file('Default\\Cookies'), file('Local State/evil'), file('Default/History'), { path: 'Local State', data: 'not-base64' }]) {
      await assert.rejects(restoreVisualProfile(archive([file('Local State'), bad]), root), { code: 'VISUAL_STORAGE_CORRUPT' });
      assert.deepEqual(await fs.readdir(root), []);
    }
    await assert.rejects(restoreVisualProfile(archive([file('Local State'), file('Local State')]), root), { code: 'VISUAL_STORAGE_CORRUPT' });
    await assert.rejects(restoreVisualProfile({ schemaVersion: 1, profile: '' }, root), { code: 'VISUAL_STORAGE_CORRUPT' });
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('network Cookie migration checkpoint survives alongside its exact database without admitting sibling network data', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'visual-profile-network-')));
  try {
    const input = path.join(root, 'input'), output = path.join(root, 'output');
    await prepareVisualPrivateDirectory(path.join(input, 'Default', 'Network'));
    await fs.writeFile(path.join(input, 'Default/Network/Cookies'), 'SYNTHETIC_COOKIE_DATABASE');
    await fs.writeFile(path.join(input, 'Default/Network/NetworkDataMigrated'), '');
    await fs.writeFile(path.join(input, 'Default/Network/Network Persistent State'), 'DO_NOT_COPY');
    await restoreVisualProfile(await snapshotVisualProfile(input), output);
    assert.deepEqual((await fs.readdir(path.join(output, 'Default/Network'))).sort(), ['Cookies', 'NetworkDataMigrated']);
    assert.equal(await fs.readFile(path.join(output, 'Default/Network/NetworkDataMigrated'), 'utf8'), '');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('profile snapshot rejects a redirected auth-store ancestor', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'visual-profile-link-')));
  try {
    await fs.mkdir(path.join(root, 'outside')); await fs.writeFile(path.join(root, 'outside', 'Cookies'), 'PRIVATE');
    await prepareVisualPrivateDirectory(path.join(root, 'profile')); await fs.symlink(path.join(root, 'outside'), path.join(root, 'profile', 'Default'));
    await assert.rejects(snapshotVisualProfile(path.join(root, 'profile')), { code: 'VISUAL_STORAGE_CORRUPT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
