import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
// Private helper module roots are computed at import time. Isolate HOME BEFORE
// importing them, not merely before a later file write/native request.
const fixtureTemp = process.platform === 'win32' && path.isAbsolute(process.env.RUNNER_TEMP || '')
  ? process.env.RUNNER_TEMP : os.tmpdir();
const suiteHome = await fs.realpath(await fs.mkdtemp(path.join(fixtureTemp, 'bc-')));
const originalHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA };
Object.assign(process.env, { HOME: suiteHome, USERPROFILE: suiteHome, LOCALAPPDATA: suiteHome });
const { browserControllerEnabled, parseBrowserControllerArguments, prepareBrowserController,
  openBrowserController, runBrowserControllerCommand } = await import('../host-runtime/scripts/trelio-browser-controller.mjs');
const { buildAgentSkillRuntimeEnvironment, writePrivateJsonFile } = await import('../host-runtime/scripts/trelio-workspace.mjs');
test.after(async () => {
  for (const [name, value] of Object.entries(originalHome)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  await fs.rm(suiteHome, { recursive: true, force: true });
});

const moduleUrl = new URL('../host-runtime/scripts/trelio-browser-controller.mjs', import.meta.url).href;
const policy = { apiVersion: 1, sessionClass: 'protected-snapshot', leaseMs: 60_000, manualAssist: false };
const marker = { path: 'trelio-browser-controller.json', bytes: Buffer.from('{"schemaVersion":1}') };
const artifact = { skillId: 'synthetic-browser', runtimeVersion: '1.0.0',
  parsedPackage: { capabilities: ['browser', 'local-session'], browserSession: policy, files: [marker] } };
const context = { companyId: randomUUID(), projectId: null, releaseId: randomUUID(), runtimeSessionId: randomUUID(),
  codexThreadId: randomUUID(), localIdentity: { memberId: randomUUID() } };
const environment = () => buildAgentSkillRuntimeEnvironment({ artifact, runtimeDirectory: os.tmpdir(), executionContext: context });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settled(env, sessionId, requestId) {
  for (let count = 0; count < 50; count++) {
    const result = await runBrowserControllerCommand({ environment: env, command: { operation: 'poll', sessionId, requestId } });
    if (!['queued', 'running'].includes(result.state)) return result;
    await wait(10);
  }
  assert.fail('synthetic request did not settle');
}

test('signed opt-in and common parser reject inherited authority and unsupported input', () => {
  assert.equal(browserControllerEnabled(artifact.parsedPackage), true);
  assert.equal(browserControllerEnabled({ files: [] }), false);
  assert.throws(() => browserControllerEnabled({ ...artifact.parsedPackage, files: [{ ...marker, bytes: Buffer.from('{"schemaVersion":1,"extra":true}') }] }));
  const env = buildAgentSkillRuntimeEnvironment({ artifact: { ...artifact, parsedPackage: { ...artifact.parsedPackage, files: [] } },
    runtimeDirectory: os.tmpdir(), executionContext: { ...context, runtimeSessionId: null },
    inheritedEnvironment: { TRELIO_BROWSER_CONTROLLER_ENABLED: '1', TRELIO_SKILL_RUNTIME_SESSION_ID: randomUUID(),
      TRELIO_BROWSER_CONTROLLER_ORIGIN: 'https://untrusted.example' } });
  assert.equal(env.TRELIO_BROWSER_CONTROLLER_ENABLED, undefined);
  assert.equal(env.TRELIO_SKILL_RUNTIME_SESSION_ID, undefined);
  assert.equal(env.TRELIO_BROWSER_CONTROLLER_ORIGIN, undefined);
  assert.equal(parseBrowserControllerArguments(['client']), null);
  for (const args of [[], ['browser-controller', 'status', 'bad'], ['browser-controller', 'status', randomUUID(), '--extra'],
    ['browser-controller', 'submit', randomUUID(), randomUUID(), '--input-file', 'relative.json']]) {
    if (args.length) assert.throws(() => parseBrowserControllerArguments(args));
  }
});

test('real child caller survives closed terminal stdin, fresh invocation and cwd changes; exact IDs never replay', async () => {
  // Isolate every private primitive before materialisation, including native
  // Windows ACL. This test never reads a real account/profile or sends HTTP
  // beyond its own loopback. The child owns only a synthetic effect counter.
  const home = await fs.mkdtemp(path.join(suiteHome, 'session-'));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA };
  Object.assign(process.env, { HOME: home, USERPROFILE: home, LOCALAPPDATA: home });
  let child;
  try {
    const env = environment(), descriptor = await prepareBrowserController({ environment: env });
    assert.deepEqual(Object.keys(descriptor).sort(), ['apiVersion', 'deadlineAt', 'moduleUrl', 'ownerFile', 'sessionId']);
    const source = `import fs from 'node:fs/promises';
      import {openBrowserController} from ${JSON.stringify(moduleUrl)};
      const descriptor=JSON.parse(await fs.readFile(process.argv[1],'utf8'));
      let count=0;
      const controller=await openBrowserController(descriptor,{handle:async command=>{
        if(command.action==='fail')throw new Error('private synthetic message');
        if(command.action==='effect'){await new Promise(r=>setTimeout(r,30));count++;}
        return {count};
      },onClose:async()=>{}});
      controller.publish({phase:'synthetic_ready'});
      process.stdout.write('ready\\n');
      await controller.closed;`;
    const bootstrap = path.join(home, 'bootstrap.json');
    await writePrivateJsonFile(bootstrap, descriptor);
    child = spawn(process.execPath, ['--input-type=module', '-e', source, bootstrap],
      { cwd: path.parse(home).root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const ready = await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('synthetic caller exited'); })]);
    assert.equal(ready[0].toString(), 'ready\n');
    // The child has NO stdin. A later short host process can still issue a
    // command from another cwd/session turn without a terminal write operation.
    const inputFile = path.join(home, 'command.json'), requestId = randomUUID();
    await writePrivateJsonFile(inputFile, { action: 'effect' });
    const command = { operation: 'submit', sessionId: descriptor.sessionId, requestId, inputFile };
    await fs.writeFile(inputFile, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
    await assert.rejects(runBrowserControllerCommand({ environment: env, command }));
    await fs.rm(inputFile);
    await assert.rejects(runBrowserControllerCommand({ environment: env, command }));
    await writePrivateJsonFile(inputFile, { action: 'effect' });
    await runBrowserControllerCommand({ environment: env, command });
    await runBrowserControllerCommand({ environment: env, command });
    assert.deepEqual(await settled(env, descriptor.sessionId, requestId), { state: 'completed', result: { count: 1 } });
    await writePrivateJsonFile(inputFile, { action: 'different' });
    assert.equal((await runBrowserControllerCommand({ environment: env, command })).state, 'request_conflict');
    const status = await runBrowserControllerCommand({ environment: env, command: { operation: 'status', sessionId: descriptor.sessionId } });
    assert.equal(status.deadlineAt, descriptor.deadlineAt);
    assert.deepEqual(status.events[0].value, { phase: 'synthetic_ready' });
    const freshSource = `import {runBrowserControllerCommand} from ${JSON.stringify(moduleUrl)};
      process.stdout.write(JSON.stringify(await runBrowserControllerCommand({environment:process.env,
        command:{operation:'status',sessionId:process.argv[1]}})));`;
    const fresh = execFileSync(process.execPath, ['--input-type=module', '-e', freshSource, descriptor.sessionId],
      { cwd: path.parse(home).root, env: { ...env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home }, encoding: 'utf8', timeout: 20_000 });
    assert.equal(JSON.parse(fresh).deadlineAt, descriptor.deadlineAt);
    const owner = JSON.parse(await fs.readFile(descriptor.ownerFile, 'utf8'));
    for (const extra of [{ origin: 'https://untrusted.example' }, { host: 'untrusted.example' }, { authorization: 'Bearer wrong' }]) {
      const statusCode = await new Promise((resolve, reject) => {
        // node:http, rather than fetch, sends the exact synthetic Host header.
        const request = http.request({ hostname: '127.0.0.1', port: owner.port, path: '/command', method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}`, ...extra } }, response => {
          response.resume(); response.once('end', () => resolve(response.statusCode));
        });
        request.once('error', reject); request.end('{"operation":"status","since":0}');
      });
      assert.equal(statusCode, 403);
    }
    for (const changed of ['TRELIO_SKILL_COMPANY_ID', 'TRELIO_SKILL_MEMBER_ID', 'TRELIO_SKILL_RELEASE_ID', 'TRELIO_SKILL_RUNTIME_SESSION_ID']) {
      await assert.rejects(runBrowserControllerCommand({ environment: { ...env, [changed]: randomUUID() }, command }));
    }
    await assert.rejects(runBrowserControllerCommand({ environment: { ...env, TRELIO_BROWSER_CONTROLLER_ORIGIN: 'https://other.example' }, command }));
    await assert.rejects(runBrowserControllerCommand({ environment: { ...env, TRELIO_SKILL_ACCOUNT_JSON: JSON.stringify({
      id: randomUUID(), companyBinding: 'a'.repeat(64) }) }, command }));
    await assert.rejects(openBrowserController(descriptor, { handle: async () => {}, onClose: async () => {} }));
    await writePrivateJsonFile(inputFile, { action: 'fail' });
    const failedId = randomUUID();
    await runBrowserControllerCommand({ environment: env, command: { ...command, requestId: failedId } });
    assert.deepEqual(await settled(env, descriptor.sessionId, failedId), { state: 'outcome_unknown' });
    const ended = once(child, 'exit');
    assert.deepEqual(await runBrowserControllerCommand({ environment: env, command: { operation: 'close', sessionId: descriptor.sessionId } }), { state: 'closed' });
    assert.deepEqual(await ended, [0, null]);
    await assert.rejects(fs.access(descriptor.ownerFile));
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('expired original descriptor cannot be claimed or revived by fresh host lease', async () => {
  const home = await fs.mkdtemp(path.join(suiteHome, 'expiry-'));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA };
  Object.assign(process.env, { HOME: home, USERPROFILE: home, LOCALAPPDATA: home });
  try {
    const env = environment(), descriptor = await prepareBrowserController({ environment: env });
    const owner = JSON.parse(await fs.readFile(descriptor.ownerFile, 'utf8'));
    owner.deadlineAt = Date.now() - 1; await writePrivateJsonFile(descriptor.ownerFile, owner);
    await assert.rejects(openBrowserController({ ...descriptor, deadlineAt: owner.deadlineAt }, { handle: async () => {}, onClose: async () => {} }));
    let refusedCleanup = 0;
    await assert.rejects(openBrowserController(descriptor, { handle: async () => {}, onClose: async () => { refusedCleanup++; } }));
    assert.equal(refusedCleanup, 1, 'even a pre-listen refusal cleans up the new caller once');
    await assert.rejects(runBrowserControllerCommand({ environment: environment(), command: { operation: 'status', sessionId: descriptor.sessionId } }));
  } finally {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('bounded events/results and expiry clean up an awaiting caller without replay', async () => {
  const env = environment(), descriptor = await prepareBrowserController({ environment: env });
  const owner = JSON.parse(await fs.readFile(descriptor.ownerFile, 'utf8'));
  // Synthetic shorter lease only: production providers retain their signed
  // 30-minute policy. Keep enough native I/O margin on hosted Windows.
  owner.deadlineAt = Date.now() + 5000;
  await writePrivateJsonFile(descriptor.ownerFile, owner);
  let effects = 0, cleanup = 0, release;
  const controller = await openBrowserController({ ...descriptor, deadlineAt: owner.deadlineAt }, {
    handle: async command => {
      effects++;
      if (command.action === 'oversize') return 'x'.repeat(262_144);
      await new Promise(resolve => { release = resolve; });
      return { done: true };
    }, onClose: async () => { cleanup++; },
  });
  const inputFile = path.join(suiteHome, 'bounded-command.json');
  try {
    assert.equal(controller.publish({ value: 'x'.repeat(16_384) }), false);
    for (let count = 0; count < 65; count++) controller.publish({ count, value: '"'.repeat(1000) });
    const status = await runBrowserControllerCommand({ environment: env, command: { operation: 'status', sessionId: descriptor.sessionId } });
    assert.equal(status.eventOverflow, true);
    assert.ok(status.events.length > 0 && status.events.length < 64, 'paginate using the real escaped MCP envelope');
    const next = await runBrowserControllerCommand({ environment: env,
      command: { operation: 'status', sessionId: descriptor.sessionId, afterSequence: status.nextSequence } });
    assert.equal(next.events[0].sequence, status.nextSequence + 1);
    await writePrivateJsonFile(inputFile, { action: 'oversize' });
    const requestId = randomUUID();
    await runBrowserControllerCommand({ environment: env, command: { operation: 'submit', sessionId: descriptor.sessionId, requestId, inputFile } });
    assert.deepEqual(await settled(env, descriptor.sessionId, requestId), { state: 'outcome_unknown' });
    await writePrivateJsonFile(inputFile, { action: 'waiting' });
    const waitingId = randomUUID();
    const command = { operation: 'submit', sessionId: descriptor.sessionId, requestId: waitingId, inputFile };
    await runBrowserControllerCommand({ environment: env, command });
    await runBrowserControllerCommand({ environment: env, command });
    assert.equal((await runBrowserControllerCommand({ environment: env,
      command: { operation: 'poll', sessionId: descriptor.sessionId, requestId: waitingId } })).state, 'running');
    assert.deepEqual(await controller.closed, { state: 'closed' });
    assert.equal(cleanup, 1); assert.equal(effects, 2);
    await assert.rejects(runBrowserControllerCommand({ environment: environment(), command }));
  } finally { release?.(); await controller.close(); await fs.rm(inputFile, { force: true }); }
});
