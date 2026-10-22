import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFile, copyFile, lstat, mkdtemp, rename, rm, access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { browserCacheHome, resolveNpmInvocation } from './trelio-browser-session.mjs';
import { ensurePrivateDirectory } from './trelio-workspace.mjs';

export const VISUAL_BROWSER_API_VERSION = 1;
export const VISUAL_PLAYWRIGHT_VERSION = '1.64.1';
export const VISUAL_KEYRING_VERSION = '2.1.1';
export const VISUAL_WS_VERSION = '8.22.0';
const source = fileURLToPath(new URL('./visual-browser-dependencies/', import.meta.url));

export function visualChildEnvironment(extra = {}) {
  // Do not inherit loader hooks, tokens, workspace configuration or arbitrary
  // command search paths into package manager, browser or native OS bindings.
  // XAUTHORITY is the desktop's cookie-file path, not the cookie value. Xvfb
  // and X11 desktops require it alongside DISPLAY; dropping it makes an
  // otherwise sandboxed headed Chromium fail before extension bootstrap.
  const names = ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'SYSTEMROOT', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];
  const env = Object.fromEntries(names.filter(name => process.env[name]).map(name => [name, process.env[name]]));
  env.PATH = [path.dirname(process.execPath), ...(process.platform === 'win32' ? [path.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(path.delimiter);
  return { ...env, ...extra };
}

export async function runVisualChild(executable, args, { timeout = 180_000, env = visualChildEnvironment(), cwd, signal } = {}) {
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    let failed = false;
    const error = () => Object.assign(new Error('VISUAL_BOOTSTRAP_FAILED'), { code: 'VISUAL_BOOTSTRAP_FAILED' });
    // Rejection waits for exit so atomic-candidate cleanup cannot race npm's
    // still-open files on Windows. Never signal a PID read from saved state.
    const fail = () => { failed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(fail, timeout);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', fail); };
    signal?.addEventListener('abort', fail, { once: true });
    child.once('error', () => { cleanup(); reject(error()); });
    child.once('exit', code => { cleanup(); code === 0 && !failed ? resolve() : reject(error()); });
  });
}

export async function loadVisualDependencies({ root = path.join(browserCacheHome(), 'visual-browser', `api-1-pw-${VISUAL_PLAYWRIGHT_VERSION}-keyring-${VISUAL_KEYRING_VERSION}-ws-${VISUAL_WS_VERSION}`), install = true, signal } = {}) {
  signal?.throwIfAborted();
  const require = createRequire(path.join(root, 'package.json'));
  const ready = async (candidate = root) => {
    try {
      return JSON.parse(await readFile(path.join(candidate, 'node_modules/playwright-core/package.json'))).version === VISUAL_PLAYWRIGHT_VERSION
        && JSON.parse(await readFile(path.join(candidate, 'node_modules/@napi-rs/keyring/package.json'))).version === VISUAL_KEYRING_VERSION
        && JSON.parse(await readFile(path.join(candidate, 'node_modules/ws/package.json'))).version === VISUAL_WS_VERSION;
    } catch { return false; }
  };
  if (!await ready()) {
    if (!install) throw Object.assign(new Error('VISUAL_DEPENDENCIES_REQUIRED'), { code: 'VISUAL_DEPENDENCIES_REQUIRED' });
    await prepareVisualPrivateDirectory(path.dirname(root));
    // Install into a unique private candidate. Concurrent accounts must never
    // run npm ci over a module tree already loaded by another worker. npm's
    // exact lockfile verifies the vendor tarballs; promotion is atomic.
    const candidate = await mkdtemp(`${root}.candidate-`);
    try {
      await prepareVisualPrivateDirectory(candidate);
      for (const name of ['package.json', 'package-lock.json']) await copyFile(path.join(source, name), path.join(candidate, name));
      const npm = resolveNpmInvocation();
      await runVisualChild(npm.executable, [npm.npmCliPath, 'ci', '--prefix', candidate, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: candidate, signal });
      if (!await ready(candidate)) throw new Error('VISUAL_DEPENDENCIES_REQUIRED');
      try { await rename(candidate, root); }
      catch (error) { if (!await ready()) throw error; }
    } finally { await rm(candidate, { recursive: true, force: true }); }
    if (!await ready()) throw Object.assign(new Error('VISUAL_DEPENDENCIES_REQUIRED'), { code: 'VISUAL_DEPENDENCIES_REQUIRED' });
  }
  // This module is loaded only in a provider-owned worker process, never a
  // long-lived MCP process shared by different runtime versions or accounts.
  const engines = path.join(browserCacheHome(), 'visual-browser', `chromium-${VISUAL_PLAYWRIGHT_VERSION}`);
  process.env.PLAYWRIGHT_BROWSERS_PATH = engines;
  const { chromium } = require('playwright-core');
  const { AsyncEntry } = require('@napi-rs/keyring');
  const { WebSocketServer } = require('ws');
  return { chromium, AsyncEntry, WebSocketServer, root, engines, cli: path.join(root, 'node_modules', 'playwright-core', 'cli.js') };
}

async function assertVisualDirectoryAncestors(directory) {
  // Reject a redirected ancestor before creating anything. Only our own final
  // directory is hardened; shared parents such as ~/.cache retain their ACL.
  let cursor = directory;
  for (;;) {
    try { const value = await lstat(cursor); if (!value.isDirectory() || value.isSymbolicLink()) throw new Error('VISUAL_STORAGE_UNSAFE'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}

export async function prepareVisualPrivateDirectory(directory) {
  await assertVisualDirectoryAncestors(directory);
  await ensurePrivateDirectory(directory);
}

/** An empty lock root has no private contents yet. Its existing PID-owned
 * mutex must serialize DACL hardening before publishing its owner record;
 * contenders only inspect ancestor kinds and create the empty directory.
 * This is not a weaker private-file validator or a provider-facing option. */
export async function prepareVisualLockRoot(directory) {
  await assertVisualDirectoryAncestors(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

export async function ensureVisualChromium(dependencies, { signal } = {}) {
  signal?.throwIfAborted();
  await prepareVisualPrivateDirectory(dependencies.engines);
  try { await access(dependencies.chromium.executablePath()); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Playwright owns its cross-process browser installation lock, temporary
    // download and completed marker. Preserve that installer instead of adding
    // an unverified second browser downloader or a system-browser fallback.
    await runVisualChild(process.execPath, [dependencies.cli, 'install', 'chromium', '--no-shell'], { env: visualChildEnvironment({ PLAYWRIGHT_BROWSERS_PATH: dependencies.engines }), timeout: 300_000, signal });
    await access(dependencies.chromium.executablePath());
  }
  return dependencies.chromium.executablePath();
}
