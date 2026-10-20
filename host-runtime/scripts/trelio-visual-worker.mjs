import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readPrivateJsonFile, writePrivateJsonFile } from './trelio-workspace.mjs';
import { loadVisualDependencies } from './trelio-visual-bootstrap.mjs';
import { ProtectedVisualStore } from './trelio-visual-store.mjs';
import { createVisualOriginPolicy } from './trelio-visual-browser.mjs';
import { ExtensionVisualBrowser } from './trelio-visual-extension-browser.mjs';
import { visualStatus } from './trelio-visual-result.mjs';
import { createVisualControlServer } from './trelio-visual-session.mjs';

// This is a host-owned entrypoint, not a provider-selectable executable. Only
// the private descriptor path enters argv; token/session values stay in the
// owner-checked file. No browser or native output is forwarded to the model.
const file = process.argv[2];
let engine, server, timer, owner, current = visualStatus('preparing'), stopping = false;
const startupAbort = new AbortController();
let startup;
let fixtureOnly = false, fixtureWrites = Promise.resolve();
const fixtureEvidence = [];
function fixtureDiagnostic(value) {
  if (!fixtureOnly) return;
  // Only a synthetic localhost owner can enable this file. Never persist a
  // native exception, browser output, URLs, tokens or cookie values. Preserve
  // a short chronological tail so a detached startup has the same closed
  // evidence as the in-process native fixture, including early browser exit.
  const stages = ['startup_dependencies', 'startup_browser', 'startup_failed', 'policy', 'policy_read', 'policy_write', 'window_inventory', 'auth', 'window', 'extension_not_ready', 'extension_not_connected', 'browser_exit', 'native_log', 'native_log_unavailable', 'windows_closed'];
  if (!stages.includes(value.stage)) return;
  const record = { stage: value.stage };
  for (const key of ['sandboxUnavailable', 'displayUnavailable', 'extensionUnavailable']) if (typeof value[key] === 'boolean') record[key] = value[key];
  for (const key of ['exitCode', 'osCryptErrors', 'cookieErrors', 'sqliteErrors', 'networkSandboxErrors']) if (Number.isSafeInteger(value[key])) record[key] = value[key];
  if (['SIGKILL', 'SIGTERM', 'SIGTRAP', 'SIGABRT', 'SIGSEGV', null].includes(value.signal)) record.signal = value.signal;
  fixtureEvidence.push(record); if (fixtureEvidence.length > 32) fixtureEvidence.shift();
  const snapshot = fixtureEvidence.slice();
  fixtureWrites = fixtureWrites.then(() => writePrivateJsonFile(path.join(owner.directory, 'fixture-diagnostic.json'), { evidence: snapshot })).catch(() => {});
}
async function stop() {
  if (stopping) return; stopping = true; clearTimeout(timer);
  startupAbort.abort();
  // One bounded in-flight input may take 40s to fail; allow its graceful
  // cleanup and profile flush before the exact-child crash watchdog fires.
  const watchdog = setTimeout(() => { engine?.abort(); process.exit(1); }, 75_000);
  watchdog.unref();
  try { await startup?.catch(() => {}); await engine?.close(); }
  finally {
    server?.close();
    const latest = await readPrivateJsonFile(file, { maximumBytes: 16_384 });
    if (latest.token === owner.token) { await fs.unlink(file); await fs.rmdir(path.dirname(file)); }
    process.exit(0);
  }
}
try {
  owner = await readPrivateJsonFile(file, { maximumBytes: 16_384 });
  if (owner.schemaVersion !== 1 || !/^[0-9a-f]{64}$/u.test(owner.token) || !Number.isSafeInteger(owner.deadlineAt) || owner.deadlineAt <= Date.now()) throw new Error('invalid_input');
  const policy = createVisualOriginPolicy(owner);
  fixtureOnly = policy.fixtureOnly === true;
  timer = setTimeout(() => { void stop(); }, owner.deadlineAt - Date.now());
  async function dispatch(operation, args) {
    if (operation === 'close') { setTimeout(() => { void stop(); }, 50); return visualStatus('closed'); }
    if (operation === 'wait') {
      // Wait only for the current manual/preparation phase; never invent login
      // readiness from a closed window, and never extend the browser lease.
      if (!args || Object.keys(args).length) return visualStatus('error', 'invalid_input');
      const until = Math.min(Date.now() + 30_000, owner.deadlineAt);
      do {
        current = engine ? await engine.call('status') : current;
        if (!['preparing', 'manual_input_required'].includes(current.state)) break;
        await sleep(250);
      } while (Date.now() < until);
      return current;
    }
    if (!engine) return current;
    return engine.call(operation, args);
  }
  server = createVisualControlServer({ token: owner.token, dispatch });
  server.requestTimeout = 55_000; server.headersTimeout = 5000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writePrivateJsonFile(file, { ...owner, pid: process.pid, port: server.address().port });
  fixtureDiagnostic({ stage: 'startup_dependencies' });
  startup = loadVisualDependencies({ signal: startupAbort.signal });
  const dependencies = await startup;
  if (stopping || Date.now() >= owner.deadlineAt) throw new Error('VISUAL_START_CANCELLED');
  const store = new ProtectedVisualStore({ directory: owner.directory, scope: owner.scope, AsyncEntry: dependencies.AsyncEntry });
  fixtureDiagnostic({ stage: 'startup_browser' });
  // Keep the detached fixture's Chromium flags identical to production. Its
  // closed process/extension events do not require native log-file switches.
  engine = new ExtensionVisualBrowser({ dependencies, store, policy, origins: owner.origins, domains: owner.domains, observationMode: owner.observationMode || 'image', lease: { deadlineAt: owner.deadlineAt }, testHeadless: owner.testHeadless === true, ...(fixtureOnly ? { testDiagnostics: fixtureDiagnostic, testNativeLogging: false } : {}) });
  current = await engine.call(owner.operation, owner.args);
} catch (error) {
  fixtureDiagnostic({ stage: 'startup_failed' });
  current = visualStatus('error', /^VISUAL_(?:BOOTSTRAP|DEPENDENCIES)/u.test(error.code || '') ? 'bootstrap_failed' : 'operation_failed');
  // Preserve a failed startup for an explicit close/status decision. Do not
  // retry installation, login or the initial action from another invocation.
  if (!server) process.exitCode = 1;
}
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
