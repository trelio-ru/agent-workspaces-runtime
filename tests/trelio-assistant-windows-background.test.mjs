import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createAssistantWindowsBackground, runAssistantWindowsBackgroundNative, projectAssistantBackgroundResult,
  quoteAssistantWindowsArgument, ASSISTANT_WINDOWS_BACKGROUND_SCRIPT } from '../host-runtime/scripts/trelio-assistant-setup.mjs';
import { callAssistantSetupTool, runAssistantEntry, ASSISTANT_SETUP_TOOLS } from '../host-runtime/scripts/trelio-assistant-entry.mjs';

const identity = { origin: 'https://trelio.ru', assistantId: randomUUID(), deviceId: randomUUID() };
const registered = () => ({ schemaVersion: 1, state: 'registered', installed: true,
  interactiveUserRequired: true, startsAtUserLogon: true, businessReady: false });

test('background registration selects only the paired identity and loaded shell after live contact', async () => {
  let contacts = 0, calls = 0, actual;
  const manage = createAssistantWindowsBackground({ platform: 'win32', executable: 'C:\\Program Files\\nodejs\\node.exe',
    readIdentity: async () => identity, verifyContact: async () => { contacts++; },
    resolveLoader: async () => 'C:\\Users\\Irina\\plugin with spaces\\loader.mjs',
    runNative: async plan => { calls++; actual = plan; return registered(); },
  });
  assert.deepEqual(await manage('install'), registered());
  assert.equal(contacts, 1); assert.equal(calls, 1);
  assert.equal(actual.assistantId, identity.assistantId); assert.equal(actual.deviceId, identity.deviceId);
  assert.equal(actual.arguments, '"C:\\Users\\Irina\\plugin with spaces\\loader.mjs" bridge assistant background');
  assert.equal(actual.workingDirectory, 'C:\\Program Files\\nodejs');
  await manage('status'); await manage('remove');
  assert.equal(contacts, 1, 'read-only status/removal must work during a network outage or device revocation');
  await manage('start'); assert.equal(contacts, 2);
  assert.equal(quoteAssistantWindowsArgument('C:\\folder\\'), '"C:\\folder\\\\"');
});

test('unpaired, wrong origin, revoked, unsupported OS and rebind failures precede OS mutation', async () => {
  let calls = 0, reads = 0;
  const options = { platform: 'win32', executable: 'C:\\node.exe', readIdentity: async () => { reads++; return identity; },
    verifyContact: async () => {}, resolveLoader: async () => 'C:\\loader.mjs', runNative: async () => { calls++; return registered(); } };
  await assert.rejects(createAssistantWindowsBackground({ ...options, platform: 'linux' })('install'), /PLATFORM_UNSUPPORTED/u);
  assert.equal(reads, 0);
  for (const value of [null, { ...identity, origin: 'https://another.test' }, { ...identity, assistantId: 'owner-selected' }]) {
    await assert.rejects(createAssistantWindowsBackground({ ...options, readIdentity: async () => value })('install'), /HOST_NOT_CONFIGURED/u);
  }
  await assert.rejects(createAssistantWindowsBackground({ ...options, verifyContact: async () => { throw Object.assign(new Error(), { code: 'ASSISTANT_ACCESS_DENIED' }); } })('start'), /./u);
  let current = identity;
  await assert.rejects(createAssistantWindowsBackground({ ...options, readIdentity: async () => current,
    verifyContact: async () => { current = { ...identity, deviceId: randomUUID() }; } })('install'), /REBIND_REQUIRED/u);
  await assert.rejects(createAssistantWindowsBackground(options)('start --as-system'), /INVALID_INPUT/u);
  assert.equal(calls, 0);
});

test('setup tools and exact CLI commands expose no arbitrary principal, identity or executable', async () => {
  const setup = { background: async operation => ({ operation }) };
  for (const [name, operation] of [['install_assistant_background', 'install'], ['get_assistant_background_status', 'status'], ['start_assistant_background', 'start']]) {
    const tool = ASSISTANT_SETUP_TOOLS.find(value => value.name === name);
    assert.deepEqual(tool.inputSchema, { type: 'object', properties: {}, required: [], additionalProperties: false });
    assert.deepEqual(await callAssistantSetupTool(setup, name, {}), { operation });
    for (const args of [null, { user: 'SYSTEM' }, { executable: 'cmd.exe' }, { assistantId: identity.assistantId }]) {
      await assert.rejects(callAssistantSetupTool(setup, name, args), error => error.code === 'ASSISTANT_SETUP_INVALID_INPUT');
    }
    const output = new PassThrough(); let value = ''; output.on('data', chunk => value += chunk);
    await runAssistantEntry([`background-${operation}`], { output, createBackground: async () => setup.background });
    assert.deepEqual(JSON.parse(value), { operation });
  }
  await assert.rejects(runAssistantEntry(['background-install', '--system']), /COMMAND_UNSUPPORTED/u);
});

test('native helper uses constant code, JSON stdin, bounded closed output and no inherited secret environment', async () => {
  let supplied, child;
  const spawnProcess = (executable, args, options) => {
    supplied = { executable, args, options }; child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {};
    let input = ''; child.stdin.on('data', chunk => input += chunk);
    child.stdin.on('finish', () => {
      assert.deepEqual(JSON.parse(input), { operation: 'status' });
      queueMicrotask(() => { child.stdout.write(JSON.stringify(registered())); child.emit('close', 0); });
    });
    return child;
  };
  const result = await runAssistantWindowsBackgroundNative({ operation: 'status' }, { spawnProcess,
    environment: { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\Irina', PRIVATE_TOKEN: 'DO_NOT_COPY' } });
  assert.deepEqual(result, registered());
  assert.equal(supplied.executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(Buffer.from(supplied.args.at(-1), 'base64').toString('utf16le'), ASSISTANT_WINDOWS_BACKGROUND_SCRIPT);
  assert.equal(supplied.options.shell, false);
  assert.equal(supplied.options.env.PRIVATE_TOKEN, undefined);
  assert.ok(!JSON.stringify(supplied).includes('DO_NOT_COPY'));
  for (const value of [{ ...registered(), stdout: 'PRIVATE' }, { ...registered(), businessReady: true },
    { ...registered(), state: 'not_installed' }, { code: 'RAW_PRIVATE_ERROR', message: 'PRIVATE' }]) {
    assert.throws(() => projectAssistantBackgroundResult(value), error => error.code === 'ASSISTANT_BACKGROUND_READBACK_FAILED' && !JSON.stringify(error).includes('PRIVATE'));
  }
  for (const code of ['ASSISTANT_BACKGROUND_CONFLICT', 'ASSISTANT_BACKGROUND_BUSY', 'ASSISTANT_BACKGROUND_ACCESS_DENIED']) {
    assert.throws(() => projectAssistantBackgroundResult({ code }), error => error.code === code);
  }
});

test('abort, timeout and oversized native output terminate one attempt without retry or raw error', async () => {
  for (const mode of ['abort', 'timeout', 'overflow', 'native-error']) {
    const controller = new AbortController(); let calls = 0, killed = false;
    const spawnProcess = () => {
      calls++; const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
      child.kill = () => { killed = true; };
      queueMicrotask(() => {
        if (mode === 'abort') controller.abort();
        if (mode === 'overflow') child.stdout.write('PRIVATE'.repeat(1000));
        if (mode === 'native-error') child.emit('error', new Error('PRIVATE_OS_ERROR'));
      });
      return child;
    };
    await assert.rejects(runAssistantWindowsBackgroundNative({ operation: 'install' }, { spawnProcess,
      environment: { SystemRoot: 'C:\\Windows' }, timeoutMs: 20, signal: controller.signal }),
    error => /^ASSISTANT_BACKGROUND_/u.test(error.code) && !JSON.stringify(error).includes('PRIVATE'));
    assert.equal(calls, 1); assert.equal(killed, true);
  }
});

test('Windows Task Scheduler actually registers, rereads, deduplicates, runs and removes only its own fixture', { skip: process.platform !== 'win32' }, async t => {
  // Hosted Windows only; never an assistant/user VM or live service. A tiny
  // native Node action proves Task Scheduler invocation independently of Codex,
  // backend, credentials and the businessReady gate.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant background Юникод '));
  const loader = path.join(directory, 'fixture loader.mjs'), marker = path.join(directory, 'receipt.json');
  const fixture = { ...identity, assistantId: randomUUID(), deviceId: randomUUID() };
  await fs.writeFile(loader, `import fs from 'node:fs';\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['bridge','assistant','background']))process.exit(9);\nfs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({ready:true}));\n`);
  const controller = createAssistantWindowsBackground({ readIdentity: async () => fixture, verifyContact: async () => {}, resolveLoader: async () => loader });
  const manage = async operation => {
    console.log(`Native fixture step: ${operation}`);
    try { const result = await controller(operation); console.log(`Native fixture result: ${operation} ${result.state}`); return result; }
    catch (error) { throw new Error(`Native fixture ${operation}: ${error.code}`, { cause: error }); }
  };
  t.after(async () => {
    // The fixture exits immediately; a busy task is polled, never killed or
    // unregistered underneath a native action. Random UUIDs isolate runs.
    let removed = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await manage('remove'); removed = true; break; }
      catch (error) { if (error.cause?.code !== 'ASSISTANT_BACKGROUND_BUSY') throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.equal(removed, true, 'a busy native fixture is preserved and reported instead of deleting its action');
    await fs.rm(directory, { recursive: true, force: true });
  });
  assert.equal((await manage('status')).state, 'not_installed');
  assert.equal((await manage('install')).state, 'registered');
  assert.equal((await manage('install')).state, 'registered', 'idempotent install reads the exact definition instead of overwriting it');
  const replacement = { ...fixture, deviceId: randomUUID() };
  const otherDevice = createAssistantWindowsBackground({ readIdentity: async () => replacement,
    verifyContact: async () => {}, resolveLoader: async () => loader });
  await assert.rejects(otherDevice('install'), error => error.code === 'ASSISTANT_BACKGROUND_CONFLICT');
  await manage('start');
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { ready = JSON.parse(await fs.readFile(marker, 'utf8')).ready === true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(ready, true, 'the actual native task must execute, not merely register or return queue acceptance');
  assert.equal((await manage('status')).businessReady, false, 'a positive OS receipt cannot claim business delivery');
});
