import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveWorkspaceBridgeConfigDirectory, readPrivateJsonFile, writePrivateJsonFile, assertPrivatePathKind } from './trelio-workspace.mjs';
import { prepareVisualPrivateDirectory, visualChildEnvironment, loadVisualDependencies } from './trelio-visual-bootstrap.mjs';
import { visualStorageScope, ProtectedVisualStore } from './trelio-visual-store.mjs';
import { createVisualOriginPolicy } from './trelio-visual-browser.mjs';
import { visualStatus, validateVisualResult } from './trelio-visual-result.mjs';
import { readBrowserSessionBinding } from './trelio-browser-session.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const busy = () => visualStatus('error', 'session_busy');

/** This binding is supplied by the verified package host, never CLI arguments. */
export function visualSessionBinding(env = process.env) {
  const account = JSON.parse(env.TRELIO_SKILL_ACCOUNT_JSON || 'null');
  let lease;
  try { lease = readBrowserSessionBinding({ environment: env, expectedSessionClass: 'protected-snapshot' }); }
  catch { throw new Error('VISUAL_IDENTITY_INVALID'); }
  const binding = {
    origin: new URL(env.TRELIO_ORIGIN || 'https://trelio.ru').origin,
    skillId: env.TRELIO_SKILL_ID,
    accountId: account?.id,
    companyId: env.TRELIO_SKILL_COMPANY_ID,
    memberId: env.TRELIO_SKILL_MEMBER_ID,
  };
  if (!uuid.test(binding.accountId) || !uuid.test(binding.companyId) || !uuid.test(binding.memberId)
    || lease.manualAssist !== true || lease.startedAt > Date.now() + 5000) throw new Error('VISUAL_IDENTITY_INVALID');
  // The disk session can be reused by this personal account across explicitly
  // bound companies; the live worker stays pinned to one company and member.
  return { ...binding, scope: visualStorageScope(binding), bindingHash: hash(binding), deadlineAt: lease.deadlineAt };
}

function validOwner(owner, binding) {
  return owner?.schemaVersion === 1 && owner.scope === binding.scope && /^[0-9a-f]{64}$/u.test(owner.bindingHash)
    && /^[0-9a-f]{64}$/u.test(owner.token) && Number.isSafeInteger(owner.deadlineAt)
    && Number.isSafeInteger(owner.pid) && owner.pid > 0;
}

async function request(owner, operation, args) {
  const response = await fetch(`http://127.0.0.1:${owner.port}/command`, {
    method: 'POST', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ operation, args }), signal: AbortSignal.timeout(35_000), redirect: 'error',
  });
  if (response.status !== 200 || Number(response.headers.get('content-length') || 0) > 3 * 1024 * 1024) throw new Error('VISUAL_WORKER_UNAVAILABLE');
  const text = await response.text();
  if (Buffer.byteLength(text) > 3 * 1024 * 1024) throw new Error('VISUAL_RESULT_INVALID');
  return validateVisualResult(JSON.parse(text));
}

/**
 * Short-lived provider invocations talk to one private, absolute-lease worker.
 * Its random bearer token is written only through host-private storage and is
 * never returned to MCP, placed in argv, inherited by Chromium or logged.
 */
export async function runVisualSession({ origins, domains = [], operation, args = {}, env = process.env, fixture }) {
  const binding = visualSessionBinding(env);
  const policy = createVisualOriginPolicy({ origins, domains, allowLoopback: Boolean(fixture) });
  if (!args || typeof args !== 'object' || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 32_768) return visualStatus('error', 'invalid_input');
  if (operation === 'navigate' || operation === 'setup') {
    if (typeof args.url !== 'string' || args.url.length > 4096) return visualStatus('error', 'invalid_input');
    try { policy.navigate(args.url); } catch { return visualStatus('error', 'navigation_blocked'); }
  }
  if (fixture && !policy.fixtureOnly) throw new Error('VISUAL_IDENTITY_INVALID');
  // Native tests use an isolated directory and synthetic localhost. An Avito
  // invocation cannot enable fixture controls or select an arbitrary root.
  const configDirectory = fixture?.directory || resolveWorkspaceBridgeConfigDirectory();
  const directory = path.join(configDirectory, 'visual-browser', binding.scope);
  await prepareVisualPrivateDirectory(directory);
  const active = path.join(directory, 'active');
  const file = path.join(active, 'owner.json');
  try { await assertPrivatePathKind(active, 'directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let owner;
  try { owner = await readPrivateJsonFile(file, { maximumBytes: 16_384 }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (owner && Object.keys(owner).length) {
    if (!validOwner(owner, binding)) return busy();
    let dead = false;
    try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') dead = true; else throw error; }
    if (dead || owner.deadlineAt + 60_000 < Date.now()) {
      // Reap only the exact old claim; never delete a session snapshot, an
      // unknown file or somebody else's fresh replacement. No PID is killed.
      // The recovery mutex moves with the old directory. A competing reaper
      // cannot use a stale read to rename a newly created worker's claim.
      const recovery = path.join(active, 'recovery');
      try { await fs.mkdir(recovery, { mode: 0o700 }); }
      catch (error) { if (['EEXIST', 'ENOENT'].includes(error.code)) return busy(); throw error; }
      let moved = false;
      try {
        await prepareVisualPrivateDirectory(recovery);
        if ((await fs.readdir(active)).sort().join() !== 'owner.json,recovery') return busy();
        const current = await readPrivateJsonFile(file, { maximumBytes: 16_384 });
        if (current.token !== owner.token || current.pid !== owner.pid) return busy();
        const abandoned = `${active}.${crypto.randomUUID()}.closed`;
        await fs.rename(active, abandoned); moved = true;
        await fs.unlink(path.join(abandoned, 'owner.json'));
        await fs.rmdir(path.join(abandoned, 'recovery')); await fs.rmdir(abandoned);
      } finally { if (!moved) await fs.rmdir(recovery); }
      owner = null;
    }
  }
  if (owner && Object.keys(owner).length) {
    if (owner.bindingHash !== binding.bindingHash) return busy();
    // Do not slide the original deadline when another CLI invocation arrives.
    if (owner.deadlineAt <= Date.now()) return visualStatus('error', 'lease_expired');
    if (Number.isInteger(owner.port) && owner.port > 0 && owner.port < 65536) {
      try {
        if (operation !== 'disconnect') return await request(owner, operation, args);
        await request(owner, 'close', {});
        for (let i = 0; i < 150; i++) {
          const next = await readPrivateJsonFile(file, { maximumBytes: 16_384 });
          if (!Object.keys(next).length) { owner = null; break; }
          if (next.token !== owner.token) return busy();
          await sleep(100);
        }
        if (owner) return busy();
      }
      catch { return visualStatus('error', 'operation_failed'); }
    } else {
      return visualStatus('preparing');
    }
  }
  if (!owner || !Object.keys(owner).length) {
    const pending = await fs.lstat(active).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (pending) return visualStatus('preparing');
  }
  if (operation === 'disconnect') {
    // Only the selected personal account is deleted. The provider exposes this
    // command solely for an exact human disconnect request, never error recovery.
    const { AsyncEntry } = await loadVisualDependencies();
    const store = new ProtectedVisualStore({ directory: configDirectory, scope: binding.scope, AsyncEntry });
    try { await store.remove(); } finally { store.close(); }
    return visualStatus('not_configured', 'none', { hasStoredSession: false });
  }
  if (operation === 'status' || operation === 'wait' || operation === 'close') {
    try {
      await assertPrivatePathKind(path.join(directory, 'state.enc'), 'file');
      return visualStatus('saved_unverified', 'none', { hasStoredSession: true });
    } catch (error) {
      return error.code === 'ENOENT' ? visualStatus('not_configured') : visualStatus('error', 'storage_unavailable');
    }
  }
  if (!['setup', 'navigate'].includes(operation)) return visualStatus('error', 'session_closed');
  // mkdir is the account-wide exclusive claim, including concurrent commands
  // from different company contexts. An incomplete or abandoned claim is never
  // silently stolen: recovery needs evidence rather than killing a guessed PID.
  try { await fs.mkdir(active, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') return busy(); throw error; }
  await prepareVisualPrivateDirectory(active);
  owner = {
    schemaVersion: 1, scope: binding.scope, bindingHash: binding.bindingHash, deadlineAt: binding.deadlineAt,
    pid: process.pid, token: crypto.randomBytes(32).toString('hex'),
    origins, domains, directory: configDirectory, operation, args,
    ...(fixture ? { allowLoopback: true, testHeadless: fixture.headless === true } : {}),
  };
  await writePrivateJsonFile(file, owner);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./trelio-visual-worker.mjs', import.meta.url)), file], {
    detached: true, shell: false, windowsHide: true, stdio: 'ignore', env: visualChildEnvironment(),
  });
  let spawnError;
  child.once('error', error => { spawnError = error; });
  child.unref();
  // Observe startup without holding an MCP call open for Chromium download.
  // No browser action is repeated if the worker's response is lost.
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(100);
    if (spawnError) {
      const current = await readPrivateJsonFile(file, { maximumBytes: 16_384 });
      if (current.token === owner.token) { await fs.unlink(file); await fs.rmdir(active); }
      return visualStatus('error', 'operation_failed');
    }
    const next = await readPrivateJsonFile(file, { maximumBytes: 16_384 });
    if (next.token !== owner.token) return busy();
    if (next.port) return visualStatus('preparing');
  }
  return visualStatus('preparing');
}

/** Authenticated loopback transport; web pages cannot call it or read tokens. */
export function createVisualControlServer({ token, dispatch }) {
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  return http.createServer(async (req, res) => {
    const deny = () => { res.writeHead(403, { 'content-length': '0' }); res.end(); };
    const authorization = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
    if (req.method !== 'POST' || req.url !== '/command' || req.headers.origin !== undefined
      || req.headers['content-type'] !== 'application/json' || authorization.length !== expectedAuthorization.length
      || !crypto.timingSafeEqual(authorization, expectedAuthorization)
      || !/^127\.0\.0\.1:\d+$/u.test(req.headers.host || '')) return deny();
    let count = 0; const chunks = [];
    try {
      for await (const bytes of req) { count += bytes.length; if (count > 32_768) throw new Error('invalid_input'); chunks.push(bytes); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || Object.keys(value).sort().join() !== 'args,operation' || typeof value.operation !== 'string') throw new Error('invalid_input');
      const result = validateVisualResult(await dispatch(value.operation, value.args));
      const body = JSON.stringify(result);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' }); res.end(body);
    } catch {
      const body = JSON.stringify(visualStatus('error', 'operation_failed'));
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }); res.end(body);
    }
  });
}
