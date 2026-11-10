import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { prepareVisualPrivateDirectory } from './trelio-visual-bootstrap.mjs';
import { readPrivateJsonFile, writePrivateJsonFile } from './trelio-workspace.mjs';

const MAX_BYTES = 48 * 1024 * 1024;
const MAX_FILES = 4096;
const invalid = () => Object.assign(new Error('VISUAL_STORAGE_CORRUPT'), { code: 'VISUAL_STORAGE_CORRUPT' });
// Chromium 156 uses LocalStorage/SessionStorage; older profiles used spaces.
// Keep the bounded auth-store allowlist compatible with both layouts.
// NetworkDataMigrated selects the authoritative Cookie database on Windows.
// Omitting it can re-run migration over restored data at the next startup.
const roots = ['Local State', 'Default/Preferences', 'Default/Secure Preferences', 'Default/Cookies', 'Default/Cookies-journal', 'Default/Cookies-wal', 'Default/Cookies-shm', 'Default/Network/Cookies', 'Default/Network/Cookies-journal', 'Default/Network/Cookies-wal', 'Default/Network/Cookies-shm', 'Default/Network/NetworkDataMigrated', 'Default/Local Storage', 'Default/LocalStorage', 'Default/IndexedDB', 'Default/Session Storage', 'Default/SessionStorage', 'Default/WebStorage'];
const directories = new Set(['Default/Local Storage', 'Default/LocalStorage', 'Default/IndexedDB', 'Default/Session Storage', 'Default/SessionStorage', 'Default/WebStorage']);

/** Configure the lifecycle of a newly owned browser profile, not website data.
 * Chromium ignores --restore-last-session for a new Profile and Windows/Linux
 * delete its session cookies when the last window closes. Set the ordinary
 * "continue where you left off" preference before first profile construction.
 * Managed profiles disable browser-level sign-in, separately from website
 * authentication: these profiles are not Chrome Sync/token-service archives.
 * Chromium copies the next-startup setting over `allowed` during startup, so
 * setting only `allowed` does not actually enforce this isolation. Persistent
 * callers keep their prior startup behavior: only visual snapshots need the
 * new-profile session-restore preference for native session cookies. */
export async function prepareVisualProfileStartup(directory, { restoreSessionOnFirstLaunch = true } = {}) {
  if (typeof restoreSessionOnFirstLaunch !== 'boolean') throw invalid();
  const target = path.join(directory, 'Default');
  await prepareVisualPrivateDirectory(target);
  const preferences = path.join(target, 'Preferences');
  try { await fs.writeFile(preferences, JSON.stringify({ ...(restoreSessionOnFirstLaunch ? { session: { restore_on_startup: 1 } } : {}),
    signin: { allowed: false, allowed_on_next_startup: false } }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await fs.lstat(preferences);
    if (!previous.isFile() || previous.isSymbolicLink()) throw invalid();
    // This is a stopped, freshly restored, owned profile. Keep every other
    // preference, including website settings; never change the user's Chrome
    // or copy its refresh tokens/password database into the auth snapshot.
    const value = await readPrivateJsonFile(preferences, { maximumBytes: 4 * 1024 * 1024 });
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.signin !== undefined && (!value.signin || typeof value.signin !== 'object' || Array.isArray(value.signin))) throw invalid();
    if (value.signin?.allowed !== false || value.signin?.allowed_on_next_startup !== false) await writePrivateJsonFile(preferences,
      { ...value, signin: { ...value.signin, allowed: false, allowed_on_next_startup: false } });
  }
}

function permitted(name) {
  return typeof name === 'string' && name.length <= 1024 && !name.includes('\\') && !name.includes(':') && name.split('/').every(part => part && part !== '.' && part !== '..')
    && roots.some(root => name === root || (directories.has(root) && name.startsWith(root + '/')));
}

/** Snapshot only a stopped owned profile. Never read history, page code,
 * cache, downloads, saved passwords or a user's ordinary browser profile. */
export async function snapshotVisualProfile(directory) {
  await prepareVisualPrivateDirectory(directory);
  const files = []; let bytes = 0;
  const checkedParents = new Set([directory]);
  const checkParent = async parent => {
    if (checkedParents.has(parent)) return;
    await checkParent(path.dirname(parent));
    let stat;
    try { stat = await fs.lstat(parent); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
    checkedParents.add(parent);
  };
  const visit = async name => {
    if (!permitted(name)) throw invalid();
    const file = path.join(directory, ...name.split('/'));
    // Several allowlisted stores have a non-allowlisted ancestor (Default or
    // Network). Check those too: lstat of the final file alone follows an
    // ancestor symlink before it can reject a redirected authentication store.
    await checkParent(path.dirname(file));
    let stat;
    try { stat = await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (stat.isSymbolicLink()) throw invalid();
    if (stat.isDirectory()) { for (const child of (await fs.readdir(file)).sort()) await visit(`${name}/${child}`); return; }
    if (!stat.isFile() || files.length >= MAX_FILES || bytes + stat.size > MAX_BYTES) throw invalid();
    const data = await fs.readFile(file); bytes += data.length;
    if (bytes > MAX_BYTES) throw invalid();
    files.push({ path: name, data: data.toString('base64') });
  };
  for (const root of roots) await visit(root);
  const plain = Buffer.from(JSON.stringify(files));
  try { return { schemaVersion: 2, profile: gzipSync(plain).toString('base64') }; }
  finally { plain.fill(0); }
}

export async function restoreVisualProfile(value, directory) {
  await prepareVisualPrivateDirectory(directory);
  if (!value) return;
  if (value.schemaVersion !== 2 || typeof value.profile !== 'string' || value.profile.length > 16 * 1024 * 1024) throw invalid();
  let plain;
  try {
    plain = gunzipSync(Buffer.from(value.profile, 'base64'), { maxOutputLength: MAX_BYTES * 1.5 });
    const files = JSON.parse(plain.toString('utf8'));
    if (!Array.isArray(files) || files.length > MAX_FILES) throw invalid();
    const seen = new Set(); let total = 0;
    // Validate the complete archive before creating any profile file.
    for (const file of files) {
      if (!file || Object.keys(file).sort().join() !== 'data,path' || !permitted(file.path) || seen.has(file.path) || typeof file.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(file.data)) throw invalid();
      seen.add(file.path); total += Buffer.byteLength(file.data, 'base64');
      if (total > MAX_BYTES) throw invalid();
    }
    const prepared = new Set([directory]);
    for (const file of files) {
      const target = path.join(directory, ...file.path.split('/'));
      const parent = path.dirname(target);
      if (!prepared.has(parent)) { await prepareVisualPrivateDirectory(parent); prepared.add(parent); }
      await fs.writeFile(target, Buffer.from(file.data, 'base64'), { flag: 'wx', mode: 0o600 });
    }
  } catch (error) { if (error.code?.startsWith('TRELIO_')) throw error; throw invalid(); }
  finally { plain?.fill(0); }
}
