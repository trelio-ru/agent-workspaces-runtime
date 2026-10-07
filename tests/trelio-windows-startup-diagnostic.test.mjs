import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { diagnoseWindowsHookStartup, probeProcess, probePublicHttps, probePublicHttpsWithRetries } from '../host-runtime/scripts/trelio-hook-startup-diagnostic.mjs';
import { diagnoseLocalPrerequisites, WINDOWS_PRIVATE_ACL_SCRIPT, resolveWindowsPowerShellExecutable } from '../host-runtime/scripts/trelio-workspace.mjs';

test('startup diagnostic returns only measurements and bounds stdout/stderr without disclosing them', async () => {
  const output = await probeProcess({executable: process.execPath, captureStderr: true,
    args: ['-e', 'console.error("private-path-token");console.log("private-path-token");console.log(JSON.stringify({ready:true}));process.stdin.resume()']});
  assert.equal(output.status, 'ready');
  assert.ok(output.readyMs >= 0);
  assert.ok(output.stdoutBytes > 0); assert.ok(output.stderrBytes > 0);
  assert.equal(output.exitCode, 0);
  assert.doesNotMatch(JSON.stringify(output), /private-path-token/);
});

test('startup diagnostic holds stdin open for baseline, closes it only for the EOF control, and reaps timeout child', async () => {
  let child;
  const options = {executable: process.execPath, timeoutMs: 400,
    args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({ready:true})))'],
    spawnProcess: (program, args, config) => {
      assert.equal(config.windowsHide, true); assert.equal(config.shell, false);
      assert.deepEqual(config.stdio, ['pipe','pipe','ignore']);
      child = spawn(program, args, config); return child;
    }};
  const held = await probeProcess(options);
  assert.equal(held.status, 'timeout');
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  const ended = await probeProcess({...options,endInput:true});
  assert.equal(ended.status, 'ready'); assert.equal(ended.exitCode, 0);
});

test('startup diagnostic fails closed on excessive output without preserving child text', async () => {
  const result = await probeProcess({executable: process.execPath,
    args:['-e','process.stdout.write("private".repeat(1000));process.stdin.resume()']});
  assert.equal(result.status, 'unexpected_output');
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('startup diagnostic cancels and reaps a child without waiting for the private process deadline', async () => {
  const controller = new AbortController();
  let child;
  const result = await probeProcess({ executable: process.execPath,
    args: ['-e', 'process.stdin.resume()'], signal: controller.signal,
    spawnProcess: (...args) => {
      child = spawn(...args); child.once('spawn', () => controller.abort()); return child;
    } });
  assert.equal(result.status, 'cancelled');
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('public HTTPS records stages and status without reading response data or following redirects', async () => {
  let destroyed = false;
  const result = await probePublicHttps({ requestHttps: (url, options, callback) => {
    assert.equal(url, 'https://trelio.ru/api/health');
    assert.deepEqual(options, { agent: false });
    const request = new EventEmitter(); request.destroy = () => {};
    queueMicrotask(() => {
      const socket = new EventEmitter(); request.emit('socket', socket);
      for (const event of ['lookup', 'connect', 'secureConnect']) socket.emit(event);
      callback({ statusCode: 302, destroy() { destroyed = true; },
        get headers() { throw Error('do not read headers'); },
        on() { throw Error('do not collect a body'); } });
    });
    return request;
  } });
  assert.equal(destroyed, true); assert.equal(result.httpStatus, 302);
  for (const key of ['dnsMs', 'connectMs', 'tlsMs']) assert.ok(result[key] >= 0);
});

test('public network timeout destroys the request and raw error text cannot escape', async () => {
  let destroyed = false;
  const timeout = await probePublicHttps({ timeoutMs: 10, requestHttps: () => {
    const request = new EventEmitter(); request.destroy = () => { destroyed = true; }; return request;
  } });
  assert.equal(timeout.status, 'timeout'); assert.equal(destroyed, true);
  const error = await probePublicHttps({ requestHttps: () => {
    throw Object.assign(Error('private proxy path'), { code: 'ENOTFOUND' });
  } });
  assert.equal(error.code, 'ENOTFOUND'); assert.doesNotMatch(JSON.stringify(error), /private/);
});

test('public probe retries transport, rate-limit and server failures only with bounded pauses', async () => {
  const delays = []; let attempts = 0;
  const result = await probePublicHttpsWithRetries({ pause: async ms => delays.push(ms), probe: async () => {
    attempts++;
    return attempts === 1 ? { status: 'network_error', code: 'ECONNRESET' }
      : { status: 'http_response', httpStatus: attempts === 2 ? 503 : attempts === 3 ? 429 : 200 };
  } });
  assert.equal(result.length, 4); assert.deepEqual(delays, [300, 600, 1000]);
  assert.equal((await probePublicHttpsWithRetries({ probe: async () => ({ status:'http_response', httpStatus:403 }) })).length, 1);
});

test('standard Windows diagnosis separates startup and network, uses no ACL input and bounds comparisons', async () => {
  const calls = [];
  const report = await diagnoseWindowsHookStartup({ platform: 'win32', executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    aclScript: 'throw "ACL must never run"', environment: { PSModulePath: 'private', PsModulePath: 'other-private' },
    networkProbe: async () => [{status:'http_response',httpStatus:200}],
    runProcess: async options => {
      calls.push(options);
      return calls.length === 1 ? { status:'ready',readyMs:11000,exitCode:0 }
        : { status:'ready',readyMs:2,exitCode:0 };
    } });
  assert.equal(report.status, 'attention', 'a worker ready after the real hook deadline remains blocked');
  assert.equal(calls.length, 6);
  assert.equal(calls[0].timeoutMs, 15000);
  assert.equal(calls[0].endInput, undefined); assert.equal(calls[0].captureStderr, undefined);
  assert.equal(calls[3].captureStderr, true); assert.equal(calls[4].endInput, true);
  assert.deepEqual(Object.keys(calls[5].environment), ['PSModulePath']);
  assert.equal(calls[5].environment.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  for (const call of calls) assert.equal(call.input, undefined);
  assert.doesNotMatch(JSON.stringify(report), /other-private|ACL must never|C:\\\\Windows/);
});

test('failed startup skips private state inspection, without claiming empty sessions or missing pairing', async () => {
  const report = await diagnoseLocalPrerequisites({ includeHookStartup:true,
    hookStartupDiagnosis:async () => ({status:'attention',probes:{workerOpenInput:{status:'timeout'}}}) });
  assert.equal(report.runtimeSessions.status, 'not_checked');
  assert.equal(report.runtimeSessions.activeCount, undefined);
  assert.equal(report.connection.status, 'not_checked');
  assert.equal(report.connection.deviceSessionConfigured, undefined);
  assert.ok(report.issues.includes('WINDOWS_HOOK_STARTUP_NOT_READY'));
});

test('non-Windows standard diagnosis creates no worker or network request', async () => {
  const result = await diagnoseWindowsHookStartup({platform:'linux',
    runProcess:async()=>{throw Error('unexpected process');},
    networkProbe:async()=>{throw Error('unexpected network');}});
  assert.deepEqual(result, {status:'not_applicable'});
});

test('Windows report probes the actual installed worker without any ACL request or business network', {
  skip: process.platform !== 'win32',
}, async () => {
  const report = await diagnoseWindowsHookStartup({executable:resolveWindowsPowerShellExecutable(),
    aclScript:WINDOWS_PRIVATE_ACL_SCRIPT, networkProbe:async()=>[]});
  assert.deepEqual(report.publicHttps, []);
  for (const [name, result] of Object.entries(report.probes)) {
    assert.equal(result.status, 'ready', name + ': ' + JSON.stringify(result));
    assert.equal(result.exitCode, 0, name);
  }
  // The worker's readiness response is its only output: no request/ACL phase
  // ran. Hook registration, credential reads and actual private paths are absent.
  for (const name of Object.keys(report.probes).filter(name => name.startsWith('worker'))) {
    assert.ok(report.probes[name].stdoutBytes <= 16, name);
  }
  assert.doesNotMatch(JSON.stringify(report), /runtimeSessionProof|Bearer|C:\\\\Users/);
  // Force only the comparison branch while still executing every real probe.
  // This covers EOF/stderr/module-path behavior even on a fast hosted machine.
  let first = true;
  const comparisons = await diagnoseWindowsHookStartup({executable:resolveWindowsPowerShellExecutable(),
    aclScript:WINDOWS_PRIVATE_ACL_SCRIPT, networkProbe:async()=>[], runProcess:async options => {
      const result = await probeProcess(options);
      if (first) { first = false; return {...result,readyMs:11000}; }
      return result;
    }});
  assert.equal(comparisons.status, 'attention');
  for (const name of ['workerPipedError','workerClosedInput','workerLocalModules']) {
    assert.equal(comparisons.probes[name].status, 'ready', name);
    assert.equal(comparisons.probes[name].exitCode, 0, name);
    assert.ok(comparisons.probes[name].stdoutBytes <= 16, name);
  }
});
