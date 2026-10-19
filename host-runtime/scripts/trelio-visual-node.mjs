import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const unavailable = () => Object.assign(new Error('VISUAL_BOOTSTRAP_NODE_REQUIRED'), { code: 'VISUAL_BOOTSTRAP_NODE_REQUIRED' });

/** Some macOS applications embed a hardened Node without permission to load
 * third-party native addons. --version succeeds, but dyld rejects the keyring
 * binding before any vault operation. Do not re-sign the application, alter
 * OS validation or replace the vault with plaintext. Select an installed
 * standalone Node with its own compatible policy for protected-session CLI
 * execution and its host-owned browser worker (including stopped-state vault IO).
 * The MCP process, browser transport and signed worker source stay unchanged.
 *
 * Paths are fixed host discovery roots, never provider/model arguments. Every
 * probe uses static arguments and public executable metadata, under one total
 * deadline. No credentials, profile, scope or URL enter probes or their output.
 * Native stderr is consumed only for closed signing-policy decisions.
 */
export function resolveVisualWorkerNode({
  platform = process.platform, executable = process.execPath, home = os.homedir(),
  cacheHome = process.env.XDG_CACHE_HOME, arch = process.arch, uid = process.getuid?.(),
  run = spawnSync, realpath = fs.realpathSync, stat = fs.statSync, now = Date.now,
} = {}) {
  if (platform !== 'darwin') return executable;
  const deadline = now() + 5000;
  const probe = (file, args) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw unavailable();
    return run(file, args, { shell: false, windowsHide: true, timeout: Math.min(1500, remaining),
      encoding: 'utf8', maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
  };
  const compatibleSignature = file => {
    const result = probe('/usr/bin/codesign', ['-dvv', '--entitlements', ':-', file]);
    if (result.error) return false;
    const text = String(result.stdout || '') + String(result.stderr || '');
    // An explicitly unsigned CLI has no hardened-runtime library validation.
    // Other failures are unknown policy, not evidence of compatibility.
    if (result.status === 1 && /code object is not signed at all/u.test(text)) return true;
    if (result.status !== 0) return false;
    const flags = /flags=0x([0-9a-f]+)\b/iu.exec(text);
    if (!flags) return false;
    const hardened = (Number.parseInt(flags[1], 16) & 0x10000) !== 0;
    return !hardened || /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\s*\/>/u.test(text);
  };
  // Current Node already has execution authority; its >=22 version was checked
  // by the launcher. A compatible current binary needs no substitution.
  if (compatibleSignature(executable)) return executable;
  const cache = typeof cacheHome === 'string' && path.posix.isAbsolute(cacheHome) ? cacheHome : path.posix.join(home, '.cache');
  const candidates = [
    path.posix.join(cache, 'codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'),
    '/opt/homebrew/bin/node', '/usr/local/bin/node',
  ];
  const visited = new Set([executable]);
  for (const candidate of candidates) {
    try {
      const resolved = realpath(candidate);
      if (!path.posix.isAbsolute(resolved) || visited.has(resolved)) continue;
      visited.add(resolved);
      const info = stat(resolved);
      if (!info.isFile() || !(info.mode & 0o111) || (info.mode & 0o022)
        || (Number.isInteger(uid) && info.uid !== uid && info.uid !== 0)) continue;
      if (!compatibleSignature(resolved)) continue;
      const version = probe(resolved, ['-e', 'process.stdout.write(JSON.stringify({major:Number(process.versions.node.split(".")[0]),platform:process.platform,arch:process.arch}))']);
      if (version.error || version.status !== 0) continue;
      const value = JSON.parse(version.stdout);
      if (!Number.isSafeInteger(value.major) || value.major < 22 || value.platform !== 'darwin' || value.arch !== arch) continue;
      return resolved;
    } catch { /* An absent/unverifiable candidate never grants execution authority. */ }
  }
  throw unavailable();
}
