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
async function stop() {
  if (stopping) return; stopping = true; clearTimeout(timer);
  startupAbort.abort();
  // One bounded in-flight input may take 20s to fail; allow its graceful
  // cleanup and profile flush before the exact-child crash watchdog fires.
  const watchdog = setTimeout(() => { engine?.abort(); process.exit(1); }, 45_000);
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
  server.requestTimeout = 40_000; server.headersTimeout = 5000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writePrivateJsonFile(file, { ...owner, pid: process.pid, port: server.address().port });
  startup = loadVisualDependencies({ signal: startupAbort.signal });
  const dependencies = await startup;
  if (stopping || Date.now() >= owner.deadlineAt) throw new Error('VISUAL_START_CANCELLED');
  const store = new ProtectedVisualStore({ directory: owner.directory, scope: owner.scope, AsyncEntry: dependencies.AsyncEntry });
  const policy = createVisualOriginPolicy(owner);
  engine = new ExtensionVisualBrowser({ dependencies, store, policy, origins: owner.origins, domains: owner.domains, lease: { deadlineAt: owner.deadlineAt }, testHeadless: owner.testHeadless === true });
  current = await engine.call(owner.operation, owner.args);
} catch (error) {
  current = visualStatus('error', /^VISUAL_(?:BOOTSTRAP|DEPENDENCIES)/u.test(error.code || '') ? 'bootstrap_failed' : 'operation_failed');
  // Preserve a failed startup for an explicit close/status decision. Do not
  // retry installation, login or the initial action from another invocation.
  if (!server) process.exitCode = 1;
}
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
