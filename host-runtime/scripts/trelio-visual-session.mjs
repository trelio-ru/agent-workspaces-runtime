import { collectCredentialThroughLoopback } from './trelio-remote-mcp.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveWorkspaceBridgeConfigDirectory, readPrivateJsonFile, writePrivateJsonFile, assertPrivatePathKind, renderLocalFormPage, parseAgentSecretTotpValue, deriveAgentSecretTotp } from './trelio-workspace.mjs';
import { prepareVisualPrivateDirectory, prepareVisualLockRoot, visualChildEnvironment, loadVisualDependencies } from './trelio-visual-bootstrap.mjs';
import { visualStorageScope, ProtectedVisualStore } from './trelio-visual-store.mjs';
import { createVisualOriginPolicy } from './trelio-visual-browser.mjs';
import { validVisualArguments, visualStatus, validateVisualResult } from './trelio-visual-result.mjs';
import { readBrowserSessionBinding } from './trelio-browser-session.mjs';
import { resolveVisualWorkerNode } from './trelio-visual-node.mjs';
import { withMirrorRetentionLock } from './trelio-mirror-retention.mjs';
import { normalizeBrowserMailSpec, validateBrowserMailJournal } from './trelio-browser-session.mjs';
export { BROWSER_MAIL_AUTH_API } from './trelio-browser-session.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const busy = () => visualStatus('error', 'session_busy');

/** Serialize ONLY the small owner descriptor, never browser/network work.
 * Windows MoveFileEx can refuse replacement while a reader has the original
 * file open, despite delete sharing. The parent startup poll and child publish
 * must therefore share the SAME PID-owned private directory mutex used by
 * mirror readers. Age cannot evict a paused live reader. Its empty root is
 * outside `active`, so recovery/shutdown can remove that exact claim directory.
 * No failed write, ACL operation, browser action or credential input is retried.
 */
export async function withVisualOwnerFileLock(file, action) {
  if (!path.isAbsolute(file) || path.basename(file) !== 'owner.json'
      || path.basename(path.dirname(file)) !== 'active' || typeof action !== 'function') {
    throw new Error('VISUAL_IDENTITY_INVALID');
  }
  const root = path.join(path.dirname(path.dirname(file)), 'owner-control');
  await prepareVisualLockRoot(root);
  let entered = false;
  const result = await withMirrorRetentionLock(root, async () => {
    entered = true;
    return action();
  }, { waitMs: 5000 });
  // Busy is a refusal, never an empty descriptor or permission to rerun work.
  if (!entered) throw new Error('VISUAL_OWNER_BUSY');
  return result;
}
export const readVisualOwner = file => withVisualOwnerFileLock(file,
  () => readPrivateJsonFile(file, { maximumBytes: 65_536 }));

export const publishVisualWorkerOwner = (file, original, update) => withVisualOwnerFileLock(file, async () => {
  const current = await readPrivateJsonFile(file, { maximumBytes: 65_536 });
  // The mutex does not confer ownership. Recheck the COMPLETE original claim
  // and its absolute lease after waiting, immediately before the one write.
  if (hash(current) !== hash(original) || Object.hasOwn(original, 'port') || original.deadlineAt <= Date.now()
      || !Number.isSafeInteger(update.pid) || update.pid <= 0
      || !Number.isInteger(update.port) || update.port < 1 || update.port > 65535
      || Object.keys(update).sort().join() !== 'pid,port') throw new Error('VISUAL_IDENTITY_INVALID');
  await writePrivateJsonFile(file, { ...original, pid: update.pid, port: update.port });
});

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
    body: JSON.stringify({ operation, args }), signal: AbortSignal.timeout(50_000), redirect: 'error',
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
export async function runVisualSession({ origins, domains = [], operation, args = {}, observationMode = 'image', attachmentDownloads = false, authentication = null, env = process.env, fixture }) {
  if (!['image', 'text'].includes(observationMode) || typeof attachmentDownloads !== 'boolean' || (operation === 'download-attachment' && !attachmentDownloads)) return visualStatus('error', 'invalid_input');
  if (['wait', 'close', 'disconnect'].includes(operation) ? !args || Object.keys(args).length : !validVisualArguments(operation, args)) return visualStatus('error', 'invalid_input');
  const binding = visualSessionBinding(env);
  const policy = createVisualOriginPolicy({ origins, domains, allowLoopback: Boolean(fixture) });
  authentication = normalizeVisualAuthentication(authentication, { origins, fixtureOnly: policy.fixtureOnly });
  const authenticationFingerprint = authentication ? visualAuthenticationFingerprint(authentication) : null;
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
  try { owner = await readVisualOwner(file); }
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
        const recovered = await withVisualOwnerFileLock(file, async () => {
          const current = await readPrivateJsonFile(file, { maximumBytes: 65_536 });
          if (current.token !== owner.token || current.pid !== owner.pid) return false;
          const abandoned = `${active}.${crypto.randomUUID()}.closed`;
          await fs.rename(active, abandoned); moved = true;
          await fs.unlink(path.join(abandoned, 'owner.json'));
          await fs.rmdir(path.join(abandoned, 'recovery')); await fs.rmdir(abandoned);
          return true;
        });
        if (!recovered) return busy();
      } finally { if (!moved) await fs.rmdir(recovery); }
      owner = null;
    }
  }
  if (owner && Object.keys(owner).length) {
    if (owner.bindingHash !== binding.bindingHash) return busy();
    // Upgrading a provider may reuse its saved auth but must not silently
    // reuse an older live worker with a different content-disclosure mode.
    // Cleanup/status remain available so the exact owner can finish it safely.
    if (((owner.observationMode || 'image') !== observationMode || (owner.attachmentDownloads === true) !== attachmentDownloads) && !['status', 'wait', 'close', 'ready', 'disconnect'].includes(operation)) return visualStatus('error', 'observation_mode_mismatch');
    if ((owner.authenticationFingerprint || null) !== authenticationFingerprint && !['status', 'wait', 'close', 'disconnect'].includes(operation)) return visualStatus('error', 'observation_mode_mismatch');
    // Do not slide the original deadline when another CLI invocation arrives.
    if (owner.deadlineAt <= Date.now()) return visualStatus('error', 'lease_expired');
    if (Number.isInteger(owner.port) && owner.port > 0 && owner.port < 65536) {
      try {
        if (operation !== 'disconnect') return await request(owner, operation, args);
        await request(owner, 'close', {});
        for (let i = 0; i < 150; i++) {
          const next = await readVisualOwner(file);
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
  if (!['setup', 'navigate', 'credentials-setup', 'credentials-status', 'credentials-forget'].includes(operation)) return visualStatus('error', 'session_closed');
  if (operation.startsWith('credentials-') && !authentication) return visualStatus('error', 'invalid_input');
  let workerExecutable;
  try { workerExecutable = resolveVisualWorkerNode(); }
  catch { return visualStatus('error', 'bootstrap_failed'); }
  // mkdir is the account-wide exclusive claim, including concurrent commands
  // from different company contexts. An incomplete or abandoned claim is never
  // silently stolen: recovery needs evidence rather than killing a guessed PID.
  try { await fs.mkdir(active, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') return busy(); throw error; }
  await prepareVisualPrivateDirectory(active);
  owner = {
    schemaVersion: 1, scope: binding.scope, bindingHash: binding.bindingHash, deadlineAt: binding.deadlineAt,
    pid: process.pid, token: crypto.randomBytes(32).toString('hex'),
    origins, domains, directory: configDirectory, operation, args, observationMode, attachmentDownloads, authentication, authenticationFingerprint,
    mailIdentity: { origin: binding.origin, companyId: binding.companyId, memberId: binding.memberId, scope: binding.scope },
    ...(fixture ? { allowLoopback: true, testHeadless: fixture.headless === true } : {}),
  };
  await withVisualOwnerFileLock(file, () => writePrivateJsonFile(file, owner));
  const child = spawn(workerExecutable, [fileURLToPath(new URL('./trelio-visual-worker.mjs', import.meta.url)), file], {
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
      await withVisualOwnerFileLock(file, async () => {
        const current = await readPrivateJsonFile(file, { maximumBytes: 65_536 });
        if (current.token === owner.token) { await fs.unlink(file); await fs.rmdir(active); }
      });
      return visualStatus('error', 'operation_failed');
    }
    const next = await readVisualOwner(file);
    if (next.token !== owner.token) return busy();
    if (next.port) return visualStatus('preparing');
  }
  return visualStatus('preparing');
}

/** Authenticated loopback transport; web pages cannot call it or read tokens. */
export function createVisualControlServer({ token, dispatch, mailDispatch }) {
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  return http.createServer(async (req, res) => {
    const deny = () => { res.writeHead(403, { 'content-length': '0' }); res.end(); };
    const authorization = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
    const privateMail = req.url === '/authentication-mail' && typeof mailDispatch === 'function';
    if (req.method !== 'POST' || req.url !== '/command' && !privateMail || req.headers.origin !== undefined
      || req.headers['content-type'] !== 'application/json' || authorization.length !== expectedAuthorization.length
      || !crypto.timingSafeEqual(authorization, expectedAuthorization)
      || !/^127\.0\.0\.1:\d+$/u.test(req.headers.host || '')) return deny();
    let count = 0; const chunks = [];
    try {
      for await (const bytes of req) { count += bytes.length; if (count > 32_768) throw new Error('invalid_input'); chunks.push(bytes); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (privateMail) {
        // A separate private pipe endpoint; these matcher/receipt messages
        // must never pass through ordinary visual result/MCP projection.
        const result = await mailDispatch(value);
        const body = JSON.stringify(result);
        if (Buffer.byteLength(body) > 16384) throw Error('invalid_input');
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' }); res.end(body); return;
      }
      if (!value || Object.keys(value).sort().join() !== 'args,operation' || typeof value.operation !== 'string') throw new Error('invalid_input');
      const result = validateVisualResult(await dispatch(value.operation, value.args));
      const body = JSON.stringify(result);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' }); res.end(body);
    } catch {
      const body = JSON.stringify(privateMail ? { ok: false, code: 'authentication_mail_unavailable' } : visualStatus('error', 'operation_failed'));
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }); res.end(body);
    }
  });
}


const fail = code => { throw Object.assign(new Error(code), { code }); };
export const VISUAL_AUTHENTICATION_API = 'trelio.protected-browser-auth/v1';
// Additive capability: legacy v1 recipes keep their exact normalization and
// credential fingerprint. A provider must check this export before declaring
// value-free navigation between private credential forms.
export const VISUAL_AUTHENTICATION_TRANSITIONS_API = 'trelio.protected-browser-auth-transitions/v1';
export const VISUAL_AUTHENTICATION_SETUP_API = 'trelio.protected-browser-auth-setup/v1';
export const VISUAL_AUTHENTICATION_COMPATIBILITY_API = 'trelio.protected-browser-auth-compatibility/v1';
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const selector = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value);
const id = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/u.test(value);

/** A signed provider declares selectors once in source, not in CLI/MCP args.
 * Credential delivery binds exact secret-bearing forms independently of the
 * executable recipe. Adding a non-secret factor must not discard a password;
 * changing its destination, selectors or guards still requires local setup.
 * Wildcard navigation domains never authorize credential delivery origins.
 */
export function normalizeVisualAuthentication(value, policy) {
  if (value === undefined || value === null) return null;
  if (Buffer.byteLength(JSON.stringify(value)) > 16_384) fail('invalid_input');
  if (!exact(value, ['steps', 'success', 'setup', 'credentialCompatibility']) || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 8 || !Array.isArray(value.success) || value.success.length < 1 || value.success.length > 8) fail('invalid_input');
  const origin = raw => {
    if (typeof raw !== 'string' || !policy.origins?.includes(raw)) fail('navigation_blocked');
    const url = new URL(raw);
    if (url.origin !== raw || url.username || url.password || (url.protocol !== 'https:' && !policy.fixtureOnly)) fail('navigation_blocked');
    return raw;
  };
  const steps = value.steps.map(step => {
    if (step?.factor !== undefined && !['totp', 'email'].includes(step.factor)) fail('invalid_input');
    const factor = step?.factor ? { factor: step.factor } : {};
    if (step?.action === 'follow') {
      if (!exact(step, ['id', 'origin', 'challenge', 'action', 'target', 'path', 'manual', 'factor'])
        || !id(step.id) || !selector(step.challenge) || !selector(step.target)
        || typeof step.path !== 'string' || step.path.length > 1024
        || !step.path.startsWith('/') || step.path.startsWith('//') || /[\x00-\x20\x7f?#\\]/u.test(step.path)) fail('invalid_input');
      const boundOrigin = origin(step.origin), destination = new URL(step.path, boundOrigin);
      // An exact pathname is signed, while opaque SSO query parameters stay
      // in the provider-owned link and never enter model-facing observations.
      if (destination.origin !== boundOrigin || destination.pathname !== step.path) fail('invalid_input');
      const manual = step.manual ?? [];
      if (!Array.isArray(manual) || manual.length > 8 || !manual.every(selector)) fail('invalid_input');
      return { id: step.id, origin: boundOrigin, challenge: step.challenge, action: 'follow', target: step.target, path: step.path, manual: manual.slice(), ...factor };
    }
    if (!exact(step, ['id', 'origin', 'challenge', 'fields', 'submit', 'manual', 'factor', 'mail']) || !id(step.id) || !selector(step.challenge) || (step.submit !== null && !selector(step.submit)) || !exact(step.fields, ['login', 'password', 'totp', 'emailOtp']) || !Object.keys(step.fields).length) fail('invalid_input');
    const fields = {};
    for (const key of ['login', 'password', 'totp', 'emailOtp']) if (Object.hasOwn(step.fields, key)) {
      const list = Array.isArray(step.fields[key]) ? step.fields[key] : [step.fields[key]];
      if (!list.length || list.length > (['totp', 'emailOtp'].includes(key) ? 8 : 1) || !list.every(selector) || new Set(list).size !== list.length) fail('invalid_input');
      fields[key] = list.slice();
    }
    // A saved TOTP cannot satisfy an SMS/push challenge. Its recipe must name
    // an actual TOTP-specific rendered challenge, never just a generic OTP box.
    const manual = step.manual ?? [];
    if (!Array.isArray(manual) || manual.length > 8 || !manual.every(selector)) fail('invalid_input');
    if (fields.emailOtp ? step.factor !== 'email' || Object.keys(fields).length !== 1 || !step.mail : step.mail !== undefined) fail('invalid_input');
    return { id: step.id, origin: origin(step.origin), challenge: step.challenge, fields, submit: step.submit, manual: manual.slice(), ...factor,
      ...(fields.emailOtp ? { mail: normalizeBrowserMailSpec(step.mail) } : {}) };
  });
  // This private API is for a credential workflow, not an arbitrary signed
  // click runner. Transitions never create a credential-free execution mode.
  if (steps.every(step => step.action === 'follow')) fail('invalid_input');
  if (steps.filter(step => step.fields?.emailOtp).length > 1) fail('invalid_input');
  if (new Set(steps.map(step => step.id)).size !== steps.length) fail('invalid_input');
  const success = value.success.map(item => {
    if (!exact(item, ['origin', 'selector']) || !selector(item.selector)) fail('invalid_input');
    return { origin: origin(item.origin), selector: item.selector };
  });
  let setup;
  if (value.setup !== undefined) {
    // Presentation belongs to the signed provider, never model arguments or
    // page prose. Only links to its already-approved exact HTTPS origins are
    // allowed. Opening a link is a human action, not a host navigation step.
    const text = item => typeof item === 'string' && item.trim().length > 0
      && item.length <= 1000 && !/[\x00-\x1f\x7f]/u.test(item);
    if (!exact(value.setup, ['paragraphs', 'links']) || !Array.isArray(value.setup.paragraphs)
      || value.setup.paragraphs.length < 1 || value.setup.paragraphs.length > 4
      || !value.setup.paragraphs.every(text) || !Array.isArray(value.setup.links)
      || value.setup.links.length > 4) fail('invalid_input');
    setup = { paragraphs: value.setup.paragraphs.slice(), links: value.setup.links.map(item => {
      if (!exact(item, ['label', 'url']) || !text(item.label) || !text(item.url)) fail('invalid_input');
      let url; try { url = new URL(item.url); } catch { fail('invalid_input'); }
      origin(url.origin);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) fail('invalid_input');
      return { label: item.label, url: url.href };
    }) };
  }
  const result = { steps, success, ...(setup ? { setup } : {}) };
  if (value.credentialCompatibility !== undefined) {
    // Old records contain only a full recipe hash, not enough information to
    // infer a safe destination. The signed provider may carry exact previous
    // recipes as evidence; a hash assertion alone is deliberately insufficient.
    const compatibility = value.credentialCompatibility;
    if (!exact(compatibility, ['previousRecipes']) || !Array.isArray(compatibility.previousRecipes)
      || compatibility.previousRecipes.length < 1 || compatibility.previousRecipes.length > 4) fail('invalid_input');
    const previousRecipes = compatibility.previousRecipes.map(previous => {
      if (!exact(previous, ['steps', 'success', 'setup'])) fail('invalid_input');
      const normalized = normalizeVisualAuthentication(previous, policy);
      if (!normalized || credentialDeliveryFingerprint(normalized) !== credentialDeliveryFingerprint(result)) fail('invalid_input');
      return normalized;
    });
    const fingerprints = previousRecipes.map(visualAuthenticationFingerprint);
    if (new Set(fingerprints).size !== fingerprints.length) fail('invalid_input');
    result.credentialCompatibility = { previousRecipes };
  }
  return result;
}

// Static setup copy cannot change credential destinations, invalidate a saved
// login or clear an unknown-outcome fence. Legacy field/follow fingerprints
// remain byte-identical; all executable recipe fields stay in this digest.
export const visualAuthenticationFingerprint = ({ setup: _presentation, credentialCompatibility: _evidence, ...definition }) => crypto.createHash('sha256').update(JSON.stringify(definition)).digest('hex');

/** Only delivery of reusable stored secrets belongs in this digest. Keep the
 * entire exact secret-bearing step (including manual guards, submit and IDs),
 * except the choice-of-factor tag: tagging an unchanged TOTP form or adding an
 * email/follow step does not redirect any saved value. Order stays significant.
 * OTP mail matchers never authorize delivery of login/password/TOTP material.
 */
function credentialDeliveryFingerprint(definition) {
  return hash(definition.steps.filter(step => ['login', 'password', 'totp'].some(key => step.fields?.[key]))
    .map(({ factor: _factor, ...step }) => step));
}

function validateCredentials(value, definition) {
  if (!exact(value, ['schemaVersion', 'fingerprint', 'deliveryFingerprint', 'login', 'password', 'totp', 'attempt'])
    || ![1, 2].includes(value.schemaVersion) || !/^[0-9a-f]{64}$/u.test(value.fingerprint)
    || (value.schemaVersion === 1 ? Object.hasOwn(value, 'deliveryFingerprint') : !/^[0-9a-f]{64}$/u.test(value.deliveryFingerprint))) fail('authentication_setup_required');
  const fingerprint = visualAuthenticationFingerprint(definition), deliveryFingerprint = credentialDeliveryFingerprint(definition);
  const sameRecipe = value.fingerprint === fingerprint;
  if (value.schemaVersion === 2 ? value.deliveryFingerprint !== deliveryFingerprint
    : !sameRecipe && !definition.credentialCompatibility?.previousRecipes.some(previous => visualAuthenticationFingerprint(previous) === value.fingerprint)) fail('authentication_setup_required');
  for (const field of ['login', 'password', 'totp']) if (typeof value[field] !== 'string' || Buffer.byteLength(value[field]) > 4096 || /[\x00\r\n]/u.test(value[field])) fail('authentication_setup_required');
  const uses = field => definition.steps.some(step => step.fields && Object.hasOwn(step.fields, field));
  if ((uses('login') && !value.login) || (uses('password') && !value.password)) fail('authentication_setup_required');
  if (value.totp) {
    let parsed;
    try { parsed = parseAgentSecretTotpValue(value.totp); }
    catch { fail('authentication_setup_required'); }
    finally { parsed?.secret.fill(0); }
  }
  if (value.attempt !== null && (!exact(value.attempt, ['id', 'state', 'steps', 'mail']) || !/^[0-9a-f-]{36}$/u.test(value.attempt.id) || !['pending', 'complete'].includes(value.attempt.state) || !Array.isArray(value.attempt.steps) || value.attempt.steps.length > 8 || !value.attempt.steps.every(key => id(key) && (!sameRecipe || definition.steps.some(step => step.id === key))))) fail('authentication_setup_required');
  if (value.attempt && Object.hasOwn(value.attempt, 'mail')) validateBrowserMailJournal(value.attempt.mail);
  // Read/status must not rewrite a record or race its ACK callback. Upgrade
  // only this private in-memory copy. authenticate checks the original pending
  // attempt/unknown ACK before its existing owner-serialized durable write;
  // all fences are preserved byte-for-byte and never cleared by compatibility.
  value.schemaVersion = 2; value.fingerprint = fingerprint; value.deliveryFingerprint = deliveryFingerprint;
  return value;
}

export async function hasVisualAuthenticationCredentials(store, definition) {
  const value = await store.readCredentials();
  if (!value) return false;
  try { validateCredentials(value, definition); return true; }
  finally { value.login = ''; value.password = ''; value.totp = ''; }
}

/** Fields are entered by the human in the host's existing guarded loopback
 * collector. The completion callback writes encrypted bytes before reporting
 * success. There is no credential-returning API, terminal mode or model input.
 */
export async function configureVisualAuthentication({ store, definition, signal, openBrowserFn, handoffTimeoutMs, setupTimeoutMs }) {
  await store.prepare();
  const fingerprint = visualAuthenticationFingerprint(definition);
  const uses = field => definition.steps.some(step => step.fields && Object.hasOwn(step.fields, field));
  const field = (name, label, help) => ({ name, label, type: name === 'login' ? 'text' : 'password', maxLength: 4096, required: name !== 'totp', ...(help ? { help } : {}) });
  await collectCredentialThroughLoopback('https://trelio.ru', {}, {
    signal, ...(openBrowserFn ? { openBrowserFn } : {}), ...(handoffTimeoutMs ? { handoffTimeoutMs } : {}), ...(setupTimeoutMs ? { setupTimeoutMs } : {}), allowCancel: true,
    renderForm: ({ nonce, errorMessage }) => renderLocalFormPage({
      title: 'Данные входа',
      sections: [
        { paragraphs: ['Сохранение только на этом устройстве. Агент и Trelio не получат значения.', `Адреса входа: ${[...new Set(definition.steps.map(step => step.origin))].join(', ')}`] },
        ...(definition.setup ? [definition.setup] : []),
        { ...(errorMessage ? { notice: { tone: 'error', text: 'Проверьте поля. Данные не сохранены; повторите ввод или отмените настройку.' } } : {}), fields: [
          ...(uses('login') ? [field('login', 'Логин')] : []),
          ...(uses('password') ? [field('password', 'Пароль')] : []),
          ...(uses('totp') ? [field('totp', 'TOTP-секрет (необязательно)', 'Заранее включите TOTP у сервиса. Введите Base32-секрет или ссылку otpauth://totp, а не текущий код. Совместное хранение с паролем уменьшает независимость второго фактора. Можно оставить пустым и вводить код вручную.')] : []),
        ] },
        { notice: { tone: 'warning', text: 'Сохранять данные в браузере не нужно – подключение будет сохранено отдельно на этом устройстве. Если браузер предложит сохранить данные, выберите «Нет, спасибо».' } },
      ],
      form: { action: '/credential', nonce, actions: [
        { label: 'Сохранить на устройстве', name: 'decision', value: 'save' },
        { label: 'Отмена', name: 'decision', value: 'cancel', variant: 'secondary', formNoValidate: true },
      ] },
    }),
    parseSubmission: form => {
      const allowed = ['nonce', 'decision', ...['login', 'password', 'totp'].filter(uses)];
      if ([...form.keys()].some(key => !allowed.includes(key) || form.getAll(key).length !== 1) || form.get('decision') !== 'save') fail('invalid_input');
      return validateCredentials({ schemaVersion: 1, fingerprint, login: form.get('login') || '', password: form.get('password') || '', totp: (form.get('totp') || '').trim(), attempt: null }, definition);
    },
    doctorCredential: async () => {},
    persistCredential: async (_origin, _resolved, credentials) => { signal?.throwIfAborted(); await store.writeCredentials(credentials); },
    successMessage: 'Данные входа зашифрованы и сохранены на устройстве. Эту вкладку можно закрыть.',
    successTitle: 'Сохранено',
  });
}

/** Only closed structural observations cross the private browser boundary.
 * Persist the attempt BEFORE the first secret dispatch; timeout, crash, reload
 * or another CLI cannot replay it. A verified success may reconcile a pending
 * result without resubmitting. Human replacement explicitly clears the fence.
 */
export async function authenticateVisualBrowser({ store, definition, send, active, wait = sleep, now = Date.now, method = 'totp', prepareMail, requestMailCode, afterAuthentication }) {
  if (!['totp', 'email'].includes(method) || method === 'email'
    && (typeof requestMailCode !== 'function' || typeof prepareMail !== 'function'
      || !definition.steps.some(step => step.fields?.emailOtp))
    || afterAuthentication !== undefined && typeof afterAuthentication !== 'function') fail('invalid_input');
  const methodArguments = method === 'email' ? { method } : {};
  const observe = async () => {
    active();
    const value = await send('authentication-probe', method === 'email' ? methodArguments : undefined);
    if (!exact(value, ['state', 'stepId', 'documentId']) || !['success', 'challenge', 'unknown'].includes(value.state) || (value.state === 'challenge' && (!definition.steps.some(step => step.id === value.stepId) || typeof value.documentId !== 'string' || !/^[0-9a-f-]{36}$/u.test(value.documentId)))) fail('authentication_unknown');
    return value;
  };
  let credentials, authenticated = false;
  try {
    const initial = await observe();
    if (initial.state === 'success') {
      // Reuse a proven active session without accessing the credential vault.
      // A previous pending fence is reconciled only if credentials are needed
      // again; it cannot authorize a replay merely from this success result.
      authenticated = true;
      return { state: 'saved_unverified', reason: 'none' };
    }
    if (initial.state !== 'challenge') return { state: 'manual_input_required', reason: 'authentication_required' };
    if (method === 'email' && definition.steps.find(step => step.id === initial.stepId)?.fields?.emailOtp)
      return { state: 'manual_input_required', reason: 'authentication_required' };
    credentials = validateCredentials(await store.readCredentials(), definition);
    if (credentials.attempt?.state === 'pending') fail('authentication_unknown');
    if (['pending', 'unknown'].includes(credentials.attempt?.mail?.acknowledgement)) fail('authentication_unknown');
    const attempt = { id: crypto.randomUUID(), state: 'pending', steps: [] };
    credentials.attempt = attempt;
    await store.writeCredentials(credentials);
    const requestedAt = now(), until = requestedAt + (method === 'email' ? 120_000 : 30_000);
    if (method === 'email') {
      if (typeof prepareMail !== 'function') fail('invalid_input');
      await prepareMail({ credentials, requestedAt, expiresAt: until });
      // A human/site navigation during mailbox preparation revokes the old
      // challenge rather than resuming a password on a different document.
      active(); const fresh = await observe();
      if (fresh.state !== 'challenge' || fresh.stepId !== initial.stepId || fresh.documentId !== initial.documentId) fail('authentication_unknown');
    }
    let probe = initial;
    while (now() < until) {
      active();
      if (probe.state === 'success') {
        attempt.state = 'complete'; await store.writeCredentials(credentials);
        authenticated = true;
        return { state: 'saved_unverified', reason: 'none' };
      }
      const step = definition.steps.find(item => item.id === probe.stepId);
      if (probe.state === 'challenge' && step && !attempt.steps.includes(step.id)) {
        if (step.action === 'follow') {
          // Fence this value-free input in the SAME durable attempt before
          // dispatch. A lost click response cannot replay this transition or
          // restart the earlier password step in another invocation.
          attempt.steps.push(step.id); await store.writeCredentials(credentials); active();
          const value = await send('authentication-follow', { stepId: step.id, documentId: probe.documentId, ...methodArguments });
          if (!exact(value, ['state']) || value.state !== 'submitted') fail('authentication_unknown');
          await wait(200); active(); probe = await observe(); continue;
        }
        if (step.fields.totp && credentials.totp) {
          const parsed = parseAgentSecretTotpValue(credentials.totp);
          const remaining = parsed.periodSeconds * 1000 - now() % (parsed.periodSeconds * 1000); parsed.secret.fill(0);
          if (remaining < 5000) {
            // Restart the WHOLE challenge after waiting, not just a field loop:
            // no partially filled/missing code may reach the submission path.
            await wait(remaining + 50); active(); probe = await observe(); continue;
          }
        }
        const values = {};
        for (const key of Object.keys(step.fields)) {
          if (key === 'emailOtp') {
            if (method !== 'email' || !requestMailCode) fail('authentication_required');
            values.emailOtp = await requestMailCode({ step, documentId: probe.documentId, credentials,
              requestedAt, expiresAt: until, persist: () => store.writeCredentials(credentials) });
            // Mail arrival can outlive navigation. Re-probe the whole signed
            // challenge and exact document before consuming the code locally.
            active(); const fresh = await observe();
            if (fresh.state !== 'challenge' || fresh.stepId !== step.id || fresh.documentId !== probe.documentId) {
              values.emailOtp = ''; fail('authentication_unknown');
            }
            continue;
          }
          if (!credentials[key]) return { state: 'manual_input_required', reason: 'authentication_required' };
          if (key === 'totp') {
            values.totp = deriveAgentSecretTotp(credentials.totp, now());
          } else values[key] = credentials[key];
        }
        // No old document token survives a time-window wait or navigation.
        if (probe.state !== 'challenge' || probe.stepId !== step.id) continue;
        attempt.steps.push(step.id); await store.writeCredentials(credentials); active();
        let value;
        try { value = await send('authentication-fill', { stepId: step.id, documentId: probe.documentId, values, ...methodArguments }); }
        finally { for (const key of Object.keys(values)) values[key] = ''; }
        if (!exact(value, ['state']) || value.state !== 'submitted') fail('authentication_unknown');
      }
      await wait(200); active(); probe = await observe();
      // Unknown after submission can be a normal redirect/SPA loading state.
      // Wait only within this attempt; never choose another field or method.
    }
    return { state: 'manual_input_required', reason: 'authentication_unknown' };
  } finally {
    // The mail broker persists its structural outcome through this SAME
    // credentials object before we erase the in-memory secret strings. A late
    // callback must not accidentally overwrite saved credentials with blanks.
    try { if (afterAuthentication) await afterAuthentication(authenticated); }
    finally { if (credentials) { credentials.login = ''; credentials.password = ''; credentials.totp = ''; } }
  }
}

/** Fixed isolated-world credential adapter. Materialized with a SIGNED recipe,
 * never caller JS/selectors or values. Secret values arrive only in a private
 * extension message, stay in RAM/the provider form and are never observations.
 * Top-frame origin, document token, uniqueness, form destination and the whole
 * challenge are checked again immediately before each field and submission.
 */
export function installVisualAuthentication(definition) {
  if (window.top !== window) return;
  const documentId = crypto.randomUUID(), spent = new Set();
  const visible = element => {
    if (!(element instanceof HTMLElement) || element.hidden || element.closest('[hidden],[inert]')) return false;
    const css = getComputedStyle(element), rect = element.getBoundingClientRect();
    return css.display !== 'none' && css.visibility === 'visible' && css.opacity !== '0' && rect.width > 0 && rect.height > 0;
  };
  const unique = selector => {
    const nodes = [...document.querySelectorAll(selector)].filter(visible);
    return nodes.length === 1 ? nodes[0] : null;
  };
  const sensitive = () => [...document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code" i]')].some(visible);
  const challenge = step => {
    if (location.origin !== step.origin || !unique(step.challenge) || step.manual.some(selector => [...document.querySelectorAll(selector)].some(visible))) return null;
    if (step.action === 'follow') {
      // Do not navigate away from a live password/OTP form. This operation
      // follows one observed same-origin anchor in its existing top frame;
      // forms, popup targets, downloads and arbitrary buttons are unsupported.
      if (sensitive()) return null;
      const target = unique(step.target);
      if (!(target instanceof HTMLAnchorElement) || target.hasAttribute('download')
        || (target.target && target.target !== '_self')) return null;
      const url = new URL(target.href, location.href);
      if (url.origin !== step.origin || url.pathname !== step.path || url.username || url.password || url.hash) return null;
      return { target };
    }
    const submit = step.submit === null ? null : unique(step.submit);
    if (step.submit !== null && (!(submit instanceof HTMLButtonElement || submit instanceof HTMLInputElement) || submit.disabled)) return null;
    const fields = [];
    for (const [key, selectors] of Object.entries(step.fields)) for (const selector of selectors) {
      const input = unique(selector);
      if (!(input instanceof HTMLInputElement) || input.disabled || input.readOnly || !['text', 'email', 'tel', 'password', 'number'].includes(input.type) || (key === 'password' && input.type !== 'password')) return null;
      fields.push({ key, input });
    }
    if (new Set(fields.map(item => item.input)).size !== fields.length) return null;
    // A same-origin form action is necessary but does not sandbox the site's
    // own JavaScript. Only explicitly trusted provider origins may be signed.
    const form = fields[0]?.input.form;
    if (!form || fields.some(item => item.input.form !== form) || (submit && submit.form !== form) || new URL(submit?.formAction || form.action, location.href).origin !== step.origin || (submit?.formTarget || form.target || '_self') !== '_self' || (submit?.getAttribute('formmethod') || form.method).toLowerCase() !== 'post') return null;
    return { fields, submit };
  };
  const probe = (method = 'totp') => {
    if (!definition) return { state: 'unknown' };
    if (!sensitive() && definition.success.some(item => location.origin === item.origin && unique(item.selector))) return { state: 'success' };
    if (!['totp', 'email'].includes(method)) return { state: 'unknown' };
    const matches = definition.steps.filter(step => (!step.factor || step.factor === method) && challenge(step));
    return matches.length === 1 ? { state: 'challenge', stepId: matches[0].id, documentId } : { state: 'unknown' };
  };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    try {
      if (message?.kind === 'authentication-guard') { respond({ blocked: sensitive() || Boolean(definition?.steps.some(step => challenge(step))) }); return; }
      if (!definition) return;
      if (message?.kind === 'authentication-probe') { respond(probe(message.method)); return; }
      if (message?.kind === 'authentication-follow') {
        const current = probe(message.method), step = definition.steps.find(step => step.id === message.stepId);
        if (!step || step.action !== 'follow' || current.state !== 'challenge'
          || current.stepId !== step.id || message.documentId !== documentId || spent.has(step.id)
          || Object.hasOwn(message, 'values')) throw Error();
        const controls = challenge(step);
        if (!controls) throw Error();
        // Burn the document-local token before the provider's event handler
        // runs. Recheck the target immediately before the single click.
        spent.add(step.id);
        if (!controls.target.isConnected || challenge(step)?.target !== controls.target) throw Error();
        controls.target.click(); respond({ state: 'submitted' }); return;
      }
      if (message?.kind !== 'authentication-fill') return;
      const current = probe(message.method), step = definition.steps.find(item => item.id === message.stepId);
      if (!step || step.action === 'follow' || current.state !== 'challenge' || current.stepId !== step.id || message.documentId !== documentId || spent.has(step.id) || !message.values || Object.keys(message.values).sort().join() !== Object.keys(step.fields).sort().join()) throw Error();
      for (const [key, value] of Object.entries(message.values)) if (typeof value !== 'string' || !value || value.length > 4096 || (['totp', 'emailOtp'].includes(key) && !/^\d{6}(?:\d{2})?$/u.test(value))) throw Error();
      const controls = challenge(step);
      if (!controls) throw Error();
      // Fence BEFORE setting the first character. Even an event handler that
      // throws, navigates, submits early or replaces a field cannot replay it.
      spent.add(step.id);
      const indexes = {};
      for (const { key, input } of controls.fields) {
        if (location.origin !== step.origin || !input.isConnected || !challenge(step)?.fields.some(item => item.input === input)) throw Error();
        const value = message.values[key], parts = step.fields[key].length;
        if (parts > 1 && value.length !== parts) throw Error();
        const index = indexes[key] || 0; indexes[key] = index + 1;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, parts > 1 ? value[index] : value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const final = challenge(step);
      if (!final || final.submit !== controls.submit || location.origin !== step.origin) throw Error();
      // A TOTP last-character handler may already submit. No click is made if
      // it replaced/detached the form. Such an uncertain result stays fenced.
      // null is a signed declaration that the provider auto-submits on input.
      // Never add an extra click to such a challenge (including segmented OTP).
      controls.submit?.click(); respond({ state: 'submitted' });
    } catch { respond({ state: 'unknown' }); }
    finally {
      if (message?.values) for (const key of Object.keys(message.values)) message.values[key] = '';
    }
  });
}
