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
import { PROCESS_DIAGNOSTIC_CODES, ProcessDiagnosticError, parseProcessDiagnostic,
  processDiagnosticCauseCode } from './trelio-process-diagnostics.mjs';

// This is a host-owned entrypoint, not a provider-selectable executable. Only
// the private descriptor path enters argv; token/session values stay in the
// owner-checked file. No browser or native output is forwarded to the model.
const file = process.argv[2];
let engine, server, timer, owner, current = visualStatus('preparing'), stopping = false;
const startupAbort = new AbortController();
let startup;
let startupPhase = 'owner_read';
let fixtureOnly = false, fixtureWrites = Promise.resolve();
const fixtureEvidence = [];
function fixtureDiagnostic(value) {
  if (!fixtureOnly) return;
  // Only a synthetic localhost owner can enable this file. Never persist a
  // native exception, browser output, URLs, tokens or cookie values. Preserve
  // a short chronological tail so a detached startup has the same closed
  // evidence as the in-process native fixture, including early browser exit.
  const stages = ['startup_dependencies', 'startup_browser', 'startup_failed', 'policy', 'policy_read', 'policy_write', 'window_inventory', 'auth', 'window', 'extension_not_ready', 'extension_not_connected', 'browser_exit', 'native_log', 'native_log_unavailable', 'windows_closed', 'browser_quit', 'browser_stop_timeout', 'close_queue', 'close_manual', 'close_browser', 'close_snapshot', 'shutdown_start', 'shutdown_claim', 'shutdown_complete'];
  if (!stages.includes(value.stage)) return;
  const record = { stage: value.stage };
  for (const key of ['sandboxUnavailable', 'displayUnavailable', 'extensionUnavailable']) if (typeof value[key] === 'boolean') record[key] = value[key];
  for (const key of ['exitCode', 'osCryptErrors', 'cookieErrors', 'sqliteErrors', 'networkSandboxErrors']) if (Number.isSafeInteger(value[key])) record[key] = value[key];
  if (['SIGKILL', 'SIGTERM', 'SIGTRAP', 'SIGABRT', 'SIGSEGV', null].includes(value.signal)) record.signal = value.signal;
  if (['accepted', 'refused', 'not_found', 'helper_failed'].includes(value.state)) record.state = value.state;
  // Reuse the common closed subprocess categories. Never persist an Error,
  // message, stack, filesystem path, descriptor or arbitrary cause string.
  if (['owner_read','policy','control_server','control_listen','owner_publish','dependencies','browser'].includes(value.startupPhase)) record.startupPhase = value.startupPhase;
  if (PROCESS_DIAGNOSTIC_CODES.includes(value.failureCode)) record.failureCode = value.failureCode;
  if (value.causeCode === 'UNKNOWN' || processDiagnosticCauseCode({code:value.causeCode}) === value.causeCode) record.causeCode = value.causeCode;
  if (value.error instanceof ProcessDiagnosticError) {
    // The SAME canonical parser strips even a typed error's message before
    // copying its allowed native operation/phase/timeout/cause dimensions.
    const closed = parseProcessDiagnostic('Ошибка: ' + JSON.stringify(value.error.toJSON()));
    if (closed) record.process = closed;
  }
  fixtureEvidence.push(record); if (fixtureEvidence.length > 32) fixtureEvidence.shift();
  const snapshot = fixtureEvidence.slice();
  fixtureWrites = fixtureWrites.then(() => writePrivateJsonFile(path.join(owner.directory, 'fixture-diagnostic.json'), { evidence: snapshot })).catch(() => {});
}
async function stop() {
  if (stopping) return; stopping = true; clearTimeout(timer);
  fixtureDiagnostic({ stage: 'shutdown_start' });
  startupAbort.abort();
  // One bounded in-flight input may take 40s to fail; allow its graceful
  // cleanup and profile flush before the exact-child crash watchdog fires.
  const watchdog = setTimeout(() => { engine?.abort(); process.exit(1); }, 75_000);
  watchdog.unref();
  try { await startup?.catch(() => {}); await engine?.close(); }
  finally {
    server?.close();
    fixtureDiagnostic({ stage: 'shutdown_claim' });
    const latest = await readPrivateJsonFile(file, { maximumBytes: 65_536 });
    if (latest.token === owner.token) { await fs.unlink(file); await fs.rmdir(path.dirname(file)); }
    fixtureDiagnostic({ stage: 'shutdown_complete' });
    // Fixture-only evidence must settle before process.exit; production has
    // no diagnostic writer and retains the same shutdown/watchdog budget.
    await fixtureWrites;
    process.exit(0);
  }
}
try {
  owner = await readPrivateJsonFile(file, { maximumBytes: 65_536 });
  if (owner.schemaVersion !== 1 || !/^[0-9a-f]{64}$/u.test(owner.token) || !Number.isSafeInteger(owner.deadlineAt) || owner.deadlineAt <= Date.now()) throw new Error('invalid_input');
  startupPhase = 'policy';
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
  startupPhase = 'control_server';
  server = createVisualControlServer({ token: owner.token, dispatch });
  server.requestTimeout = 55_000; server.headersTimeout = 5000;
  startupPhase = 'control_listen';
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  startupPhase = 'owner_publish';
  await writePrivateJsonFile(file, { ...owner, pid: process.pid, port: server.address().port });
  startupPhase = 'dependencies';
  fixtureDiagnostic({ stage: 'startup_dependencies' });
  startup = loadVisualDependencies({ signal: startupAbort.signal });
  const dependencies = await startup;
  if (stopping || Date.now() >= owner.deadlineAt) throw new Error('VISUAL_START_CANCELLED');
  const store = new ProtectedVisualStore({ directory: owner.directory, scope: owner.scope, AsyncEntry: dependencies.AsyncEntry });
  fixtureDiagnostic({ stage: 'startup_browser' });
  // Keep the detached fixture's Chromium flags identical to production. Its
  // closed process/extension events do not require native log-file switches.
  startupPhase = 'browser';
  engine = new ExtensionVisualBrowser({ dependencies, store, policy, origins: owner.origins, domains: owner.domains, authentication: owner.authentication || null, observationMode: owner.observationMode || 'image', attachmentDownloads: owner.attachmentDownloads === true, lease: { deadlineAt: owner.deadlineAt }, testHeadless: owner.testHeadless === true, ...(fixtureOnly ? { testDiagnostics: fixtureDiagnostic, testNativeLogging: false } : {}) });
  current = await engine.call(owner.operation, owner.args);
} catch (error) {
  fixtureDiagnostic({ stage: 'startup_failed', startupPhase, error, failureCode:error.diagnosticCode,
    causeCode:processDiagnosticCauseCode(error) });
  current = visualStatus('error', /^VISUAL_(?:BOOTSTRAP|DEPENDENCIES)/u.test(error.code || '') ? 'bootstrap_failed' : 'operation_failed');
  // Preserve a failed startup for an explicit close/status decision. Do not
  // retry installation, login or the initial action from another invocation.
  if (!server) process.exitCode = 1;
}
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
