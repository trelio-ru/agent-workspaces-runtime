/**
 * Read-only Windows startup probe used by the standard installation diagnostic.
 * It never opens a session or asks for a proof. The native worker only emits
 * readiness; no path/request is sent and no private state/ACL/credential is accessed.
 */
import { spawn } from 'node:child_process';
import { get } from 'node:https';
import os from 'node:os';
import { PRIVATE_PROCESS_TIMEOUT_MILLISECONDS, PRIVATE_PROCESS_STARTUP_TIMEOUT_MILLISECONDS } from './trelio-hook-private-session.mjs';

const SAFE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ECONNRESET', 'ECONNREFUSED',
  'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);
const safeCode = (error) => SAFE_CODES.has(error?.code) ? error.code : 'UNCLASSIFIED';

export const probeProcess = ({ executable, args, environment = process.env,
  endInput = false, captureStderr = false, timeoutMs = 15_000, signal, spawnProcess = spawn }) => new Promise((resolve) => {
  const start = performance.now();
  const result = { status: 'waiting', spawnedMs: null, readyMs: null, elapsedMs: null,
    exitCode: null, signal: null, stdoutBytes: 0, stderrBytes: 0 };
  let child, timer, cleanupTimer, line = '', settled = false;
  const elapsed = () => Math.round(performance.now() - start);
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer); clearTimeout(cleanupTimer);
    signal?.removeEventListener('abort', cancel);
    result.elapsedMs = elapsed();
    // Only measurements, closed statuses and OS codes leave this function.
    // Never return raw output, argv, environment, executable or a local path.
    resolve(result);
  };
  const stop = () => {
    clearTimeout(timer); clearTimeout(cleanupTimer);
    child?.kill();
    cleanupTimer = setTimeout(() => {
      child?.stdout?.destroy(); child?.stderr?.destroy(); child?.stdin?.destroy();
      child?.unref(); finish();
    }, 1_000);
  };
  const cancel = () => { result.status = 'cancelled'; stop(); };
  if (signal?.aborted) { result.status = 'cancelled'; finish(); return; }
  // Include synchronous spawn time; Node may not dispatch a timer until the
  // OS returns. The readiness callback also checks elapsed time explicitly.
  timer = setTimeout(() => { result.status = 'timeout'; line = ''; stop(); }, timeoutMs);
  try {
    child = spawnProcess(executable, args, { env: environment, shell: false,
      windowsHide: true, stdio: ['pipe', 'pipe', captureStderr ? 'pipe' : 'ignore'] });
  } catch (error) {
    result.status = 'spawn_error'; result.code = safeCode(error); finish(); return;
  }
  child.once('spawn', () => { result.spawnedMs = elapsed(); });
  child.once('error', (error) => {
    if (settled) return;
    result.status = 'spawn_error'; result.code = safeCode(error); finish();
  });
  child.stdin.on('error', () => {});
  child.stderr?.on('data', (chunk) => { result.stderrBytes += chunk.length; });
  child.stdout.on('data', (chunk) => {
    if (settled) return;
    result.stdoutBytes += chunk.length;
    if (result.status !== 'waiting') return;
    // Ready is fixed ASCII. Keep no more than one bounded line, even if a
    // broken shell prints an error containing a profile path or other data.
    line += chunk.toString('utf8');
    if (line.length > 4_096) { result.status = 'unexpected_output'; line = ''; stop(); return; }
    const lines = line.split('\n'); line = lines.pop();
    for (const item of lines) {
      if (item.trim() !== '{"ready":true}') continue;
      result.readyMs = elapsed(); line = '';
      if (result.readyMs >= timeoutMs) { result.status = 'timeout'; stop(); return; }
      result.status = 'ready';
      clearTimeout(timer);
      child.stdin.end();
      // Closing stdin normally stops the empty production request loop. Bound
      // cleanup too; a successful marker must not leave a diagnostic child.
      cleanupTimer = setTimeout(stop, 500);
      break;
    }
  });
  child.once('close', (code, signal) => {
    if (settled) return;
    result.exitCode = code;
    result.signal = signal === 'SIGTERM' || signal === 'SIGKILL' ? signal : null;
    if (result.status === 'waiting') result.status = 'exited_before_ready';
    finish();
  });
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  if (endInput) child.stdin.end();
});

// A public, unauthenticated request is a separate measurement. It cannot prove
// MCP/OAuth access and never substitutes for the protected user operation.
export const probePublicHttps = ({ timeoutMs = 3_500, signal, requestHttps = get } = {}) => new Promise((resolve) => {
  const start = performance.now();
  const result = { status: 'waiting', dnsMs: null, connectMs: null, tlsMs: null,
    elapsedMs: null, httpStatus: null };
  let finished = false, timer, request;
  const elapsed = () => Math.round(performance.now() - start);
  const finish = () => {
    if (finished) return; finished = true;
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    result.elapsedMs = elapsed(); resolve(result);
  };
  const cancel = () => { result.status = 'cancelled'; request?.destroy(); finish(); };
  if (signal?.aborted) { cancel(); return; }
  try {
    // Fixed public endpoint, no inherited API client, headers or redirect
    // following. A response establishes reachability, never OAuth/MCP access.
    request = requestHttps('https://trelio.ru/api/health', { agent: false }, (response) => {
      if (!finished) {
        result.status = 'http_response'; result.httpStatus = response.statusCode;
        finish();
      }
      response.destroy();
    });
    timer = setTimeout(() => { result.status = 'timeout'; request.destroy(); finish(); }, timeoutMs);
    request.on('socket', (socket) => {
      socket.once('lookup', () => { if (!finished) result.dnsMs = elapsed(); });
      socket.once('connect', () => { if (!finished) result.connectMs = elapsed(); });
      socket.once('secureConnect', () => { if (!finished) result.tlsMs = elapsed(); });
    });
    request.once('error', (error) => {
      if (finished) return;
      result.status = 'network_error'; result.code = safeCode(error); finish();
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  } catch (error) {
    result.status = 'network_error'; result.code = safeCode(error); finish();
  }
});

export const probePublicHttpsWithRetries = async ({ signal, probe = probePublicHttps,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) => {
  const attempts = [];
  for (const delay of [0, 300, 600, 1_000]) {
    if (signal?.aborted) break;
    if (delay) await pause(delay);
    if (signal?.aborted) break;
    const attempt = await probe({ signal }); attempts.push(attempt);
    if (attempt.status === 'cancelled'
        || (attempt.status === 'http_response' && attempt.httpStatus < 500 && attempt.httpStatus !== 429)) break;
  }
  return attempts;
};

export const diagnoseWindowsHookStartup = async ({ executable, args = [],
  platform = process.platform, signal, runProcess = probeProcess,
  networkProbe = probePublicHttpsWithRetries, environment = process.env } = {}) => {
  if (platform !== 'win32') return { status: 'not_applicable' };
  const report = { schemaVersion: 1, status: 'ready', platform,
    osRelease: os.release(), nodeVersion: process.version, nodeArch: process.arch,
    workerKind: 'windows_native',
    hookPrivateProcessTimeoutMs: PRIVATE_PROCESS_TIMEOUT_MILLISECONDS,
    hookStartupTimeoutMs: PRIVATE_PROCESS_STARTUP_TIMEOUT_MILLISECONDS,
    note: 'Readiness only; no ACL request or protected MCP call. A timeout does not identify the cause.',
    probes: {} };
  const run = async (name, options) => {
    report.probes[name] = { timeoutMs: options.timeoutMs,
      ...await runProcess({environment, signal, ...options}) };
  };
  // Doctor launches the same signed native executable as ACL/DPAPI. No shell,
  // compiler, private input or fallback process is needed to observe readiness.
  await run('workerOpenInput', {executable, args, timeoutMs: 25_000});
  await run('nodePipe', {executable:process.execPath,
    args:['-e', 'console.log(JSON.stringify({ready:true}));process.stdin.resume()'], timeoutMs:3_000});
  const baseline = report.probes.workerOpenInput;
  report.status = baseline.status === 'ready' && baseline.exitCode === 0
    && baseline.readyMs < PRIVATE_PROCESS_STARTUP_TIMEOUT_MILLISECONDS
    && report.probes.nodePipe.status === 'ready' && report.probes.nodePipe.exitCode === 0
    ? 'ready' : 'attention';
  // Measure network AFTER synchronous spawn: otherwise a blocked event loop
  // artificially inflates DNS/connect timings with local process startup.
  report.publicHttps = await networkProbe({signal});
  report.networkNote = 'Native Node HTTPS may use a different proxy from desktop MCP. Public reachability is independent of worker readiness; no body, headers, credentials or protected content are collected.';
  return report;
};
