/**
 * Invocation-local cancellation and Windows ACL/DPAPI transport. Reusing a process is not
 * reusing an ACL result: each exact path is still hardened and verified before
 * use. The transport closes with its hook/bridge invocation; no result is cached.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const hookScope = new AsyncLocalStorage();
const stageScope = new AsyncLocalStorage();
export const PRIVATE_PROCESS_TIMEOUT_MILLISECONDS = 10_000;
// Startup is bounded once, independently of each operation. Production uses
// the signed native helper, with no shell/CLR initialization. The enclosing
// hook still has its original non-sliding 22/8/2-second deadline.
export const PRIVATE_PROCESS_STARTUP_TIMEOUT_MILLISECONDS = 20_000;
export const windowsPrivateWorkerOptions = (arch = process.arch) => {
  if (!["x64", "ia32", "arm64"].includes(arch)) throw new Error("Unsupported Windows private worker architecture.");
  return {
    executable: fileURLToPath(new URL(`./native-private-process/bin/${arch}/trelio-private-process.exe`, import.meta.url)),
    args: [],
  };
};
const MAX_PRIVATE_VALUE_BYTES = 1024 * 1024;
const MAX_PRIVATE_REPLY_BYTES = 1_400_000;

const HOOK_STAGES = new Set([
  "local_state", "hook_setup", "runtime_state_read", "state_lock",
  "runtime_attestation", "bridge_credentials", "runtime_registration", "runtime_state_write",
]);
const ACL_PHASES = new Set([
  "worker_startup", "request_dispatch", "path_decode", "identity", "owner_read", "owner_write",
  "dacl_write", "dacl_verify",
]);
const currentStage = () => stageScope.getStore() || "local_state";
const budgetFailure = ({ stage = currentStage(), phase, kind, timeout = "hook" } = {}) => {
  // Diagnostics have a closed vocabulary. No target path, account identity,
  // request input or child text can enter the hook's model-visible reason.
  const hookStage = HOOK_STAGES.has(stage) ? stage : "local_state";
  const family = kind === "protect" || kind === "unprotect" ? "windows_dpapi" : "windows_acl";
  const operation = ACL_PHASES.has(phase) || phase === "protect" || phase === "unprotect"
    ? `${family}.${phase}` : "local_state";
  const timeoutKind = timeout === "private_process" ? timeout : "hook";
  return Object.assign(new Error(
    `истёк внутренний срок hook (stage=${hookStage}; operation=${operation}; timeout=${timeoutKind})`,
  ), { code: "TRELIO_RUNTIME_HOOK_FAILED", hookStage, operation, timeoutKind });
};

export const withRuntimeHookStage = (stage, operation) => {
  if (!HOOK_STAGES.has(stage)) throw new Error("Unknown runtime hook stage.");
  return stageScope.run(stage, async () => {
    assertRuntimeHookBudget();
    const result = await operation();
    // In particular, retain the attestation/read stage when an OS operation
    // returns only after the signal expired. Never report the later caller.
    assertRuntimeHookBudget();
    return result;
  });
};

export const runtimeHookSignal = () => hookScope.getStore()?.signal;
export const assertRuntimeHookBudget = () => {
  if (runtimeHookSignal()?.aborted) throw budgetFailure();
};

export const privateProcessOptions = () => {
  assertRuntimeHookBudget();
  return {
    timeout: PRIVATE_PROCESS_TIMEOUT_MILLISECONDS,
    ...(runtimeHookSignal() ? { signal: runtimeHookSignal() } : {}),
  };
};

// The helper owns the redirected pipes, not Console.In/Out or the console code
// page shared with its launcher. Fixed ASCII framing needs no PowerShell JSON
// cmdlets/module discovery. UTF-8 paths are base64 data, never executable text.
// Readiness is flushed before the first request; the parent must not feed a
// process that has not yet entered this protocol.
export const buildPrivateAclWorkerScript = (aclScript) => `
$ErrorActionPreference = "Stop"
$PSModuleAutoLoadingPreference = "None"
$encoding = [System.Text.UTF8Encoding]::new($false, $true)
$writer = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $encoding, 1024)
$writer.AutoFlush = $true
$reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $encoding, $false, 1024)
function Invoke-TrelioPrivateAcl {
${aclScript}
}
$writer.WriteLine('{"ready":true}')
while ($null -ne ($line = $reader.ReadLine())) {
  $id = "0"
  $inputBytes = $null
  $outputBytes = $null
  $entropy = $null
  $fields = $null
  try {
    if ($line.Length -gt 1400000) { throw "Invalid request." }
    $fields = $line.Split([char]9)
    if ($fields.Length -lt 3 -or $fields[0] -notmatch '^[0-9]{1,16}$') { throw "Invalid request." }
    $id = $fields[0]
    if ($fields[1] -eq "protect" -or $fields[1] -eq "unprotect") {
      if ($fields.Length -ne 4 -or $fields[2] -notmatch '^[A-Za-z0-9+/]+={0,2}$' -or
          $fields[3] -notmatch '^[A-Za-z0-9+/]+={0,2}$') { throw "Invalid request." }
      # Load the built-in framework assembly directly. Add-Type/module discovery
      # and a second PowerShell startup must not consume the hook budget.
      $null = [Reflection.Assembly]::Load("System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a")
      $entropy = [Convert]::FromBase64String($fields[2])
      $inputBytes = [Convert]::FromBase64String($fields[3])
      if ($entropy.Length -ne 32 -or $inputBytes.Length -eq 0 -or $inputBytes.Length -gt 1048576) {
        throw "Invalid request."
      }
      if ($fields[1] -eq "protect") {
        $outputBytes = [Security.Cryptography.ProtectedData]::Protect($inputBytes, $entropy,
          [Security.Cryptography.DataProtectionScope]::CurrentUser)
      } else {
        $outputBytes = [Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $entropy,
          [Security.Cryptography.DataProtectionScope]::CurrentUser)
      }
      if ($outputBytes.Length -eq 0 -or $outputBytes.Length -gt 1048576) { throw "Invalid result." }
      $writer.WriteLine('{"id":"' + $id + '","ok":true,"value":"' + [Convert]::ToBase64String($outputBytes) + '"}')
    } else {
      if ($line.Length -gt 16384 -or $fields.Length -ne 3 -or $fields[1] -notin @("directory", "file") -or
          $fields[2] -notmatch '^[A-Za-z0-9+/]+={0,2}$') { throw "Invalid request." }
      $env:TRELIO_WINDOWS_PRIVATE_ACL_PATH_BASE64 = $fields[2]
      $env:TRELIO_WINDOWS_PRIVATE_ACL_KIND = $fields[1]
      Invoke-TrelioPrivateAcl -ReportPhase {
        param($phase)
        $writer.WriteLine('{"id":"' + $id + '","phase":"' + $phase + '"}')
      }
      $writer.WriteLine('{"id":"' + $id + '","ok":true}')
    }
  } catch {
    # Neither exceptions nor partial plaintext may enter stderr or errors.
    $writer.WriteLine('{"id":"' + $id + '","ok":false}')
  } finally {
    if ($inputBytes -ne $null) { [Array]::Clear($inputBytes, 0, $inputBytes.Length) }
    if ($outputBytes -ne $null) { [Array]::Clear($outputBytes, 0, $outputBytes.Length) }
    if ($entropy -ne $null) { [Array]::Clear($entropy, 0, $entropy.Length) }
    $line = $null
    $fields = $null
    [Environment]::SetEnvironmentVariable("TRELIO_WINDOWS_PRIVATE_ACL_PATH_BASE64", $null, "Process")
    [Environment]::SetEnvironmentVariable("TRELIO_WINDOWS_PRIVATE_ACL_KIND", $null, "Process")
  }
}
`;

export const createPrivateAclWorker = ({
  executable, args, aclScript, environment = process.env, signal,
  spawnProcess = spawn, requestTimeoutMilliseconds = PRIVATE_PROCESS_TIMEOUT_MILLISECONDS,
  startupTimeoutMilliseconds = PRIVATE_PROCESS_STARTUP_TIMEOUT_MILLISECONDS,
}) => {
  let child, failure, startupTimer, startupDeadline;
  let sequence = 0, closing = false, ready = false;
  let output = Buffer.alloc(0);
  const pending = new Map();
  const fail = (error) => {
    // Never retain child output or the caller's plaintext in an Error. Only
    // closed machine codes and operation identity cross this boundary.
    const causeCode = /^[A-Z0-9_]{2,32}$/u.test(error?.code || "") ? error.code : "IO_ERROR";
    const active = pending.values().next().value;
    failure ??= signal?.aborted ? budgetFailure(active) : Object.assign(new Error(
      `Windows private process не завершил проверку (${causeCode}).`,
    ), { code: "TRELIO_RUNTIME_HOOK_FAILED" });
    clearTimeout(startupTimer);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.payload?.fill(0);
      entry.payload = undefined;
      entry.reject(failure);
    }
    pending.clear(); output.fill(0); output = Buffer.alloc(0);
    child?.kill();
  };
  const dispatch = (entry) => {
    entry.phase = entry.kind === "protect" || entry.kind === "unprotect" ? entry.kind : "request_dispatch";
    // The operation receives its own bound only after readiness. No progress
    // message renews it, and the enclosing hook deadline always wins.
    entry.timer = setTimeout(() => {
      failure = budgetFailure({ ...entry, timeout: "private_process" }); fail();
    }, requestTimeoutMilliseconds);
    const payload = entry.payload;
    entry.payload = undefined;
    child.stdin.write(payload, (error) => { payload.fill(0); if (error) fail(error); });
  };
  const acceptLine = (line) => {
    let reply;
    try { reply = JSON.parse(line.toString("utf8")); } catch { fail(); return; }
    if (Object.hasOwn(reply ?? {}, "ready")) {
      if (ready || reply.ready !== true || Object.keys(reply).length !== 1) { fail(); return; }
      // A synchronous OS spawn can delay JS timers. Late output must not win
      // a race against the already-expired absolute startup deadline.
      if (performance.now() >= startupDeadline) {
        failure = budgetFailure({ ...pending.values().next().value, phase: "worker_startup", timeout: "private_process" });
        fail(); return;
      }
      ready = true; clearTimeout(startupTimer);
      for (const entry of pending.values()) dispatch(entry);
      return;
    }
    const entry = pending.get(reply?.id);
    if (!ready || !entry) { fail(); return; }
    if (Object.hasOwn(reply, "phase")) {
      if (!ACL_PHASES.has(reply.phase) || Object.hasOwn(reply, "ok") || Object.hasOwn(reply, "value")
          || entry.kind === "protect" || entry.kind === "unprotect" || ++entry.phaseCount > ACL_PHASES.size) {
        fail(); return;
      }
      entry.phase = reply.phase; return;
    }
    const dpapi = entry.kind === "protect" || entry.kind === "unprotect";
    if (typeof reply.ok !== "boolean" || Object.keys(reply).length !== (dpapi && reply.ok ? 3 : 2)
        || (dpapi && reply.ok && (typeof reply.value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(reply.value)))) {
      fail(); return;
    }
    if (!dpapi && Object.hasOwn(reply, "value")) { fail(); return; }
    if (!reply.ok) {
      failure = Object.assign(new Error(dpapi ? `Windows DPAPI не выполнил операцию ${entry.kind}.`
        : `Windows не подтвердил права локального private path (stage=${entry.stage}; operation=windows_acl.${entry.phase}).`),
      { code: "TRELIO_RUNTIME_HOOK_FAILED" });
      fail(); return;
    }
    let value;
    if (dpapi) {
      value = Buffer.from(reply.value, "base64");
      if (!value.length || value.length > MAX_PRIVATE_VALUE_BYTES || value.toString("base64") !== reply.value) {
        value.fill(0); fail(); return;
      }
    }
    clearTimeout(entry.timer); pending.delete(reply.id); entry.resolve(value);
  };
  const start = () => {
    if (child) return;
    if (signal?.aborted) { fail(); throw failure; }
    // Arm BEFORE spawn: synchronous process creation is part of the startup
    // allowance too. It is not repeated per pending request or readiness frame.
    startupDeadline = performance.now() + startupTimeoutMilliseconds;
    startupTimer = setTimeout(() => {
      failure = budgetFailure({ ...pending.values().next().value, phase: "worker_startup", timeout: "private_process" }); fail();
    }, startupTimeoutMilliseconds);
    try {
      // Legacy PowerShell script transport remains available only to explicit
      // comparison/compatibility tests. Production passes the signed native
      // executable with an empty argv, and never falls back after a failure.
      child = spawnProcess(executable, args ?? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", Buffer.from(buildPrivateAclWorkerScript(aclScript), "utf16le").toString("base64")], {
        env: environment, shell: false, windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"], ...(signal ? { signal } : {}),
      });
    } catch (error) { fail(error); throw failure; }
    child.on("error", fail);
    child.on("close", () => { if (!closing || pending.size) fail(); });
    child.stdin.on("error", fail);
    child.stdout.on("data", (chunk) => {
      if (failure || closing) { chunk.fill(0); return; }
      const limit = [...pending.values()].some(e => e.kind === "protect" || e.kind === "unprotect")
        ? MAX_PRIVATE_REPLY_BYTES : 256;
      // Bound each unterminated frame, including before JSON parsing. A
      // plaintext reply buffer is wiped after consumption, never logged.
      let offset = 0;
      while (offset < chunk.length && !failure) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        if (output.length + end - offset > limit) { fail(); break; }
        const next = Buffer.concat([output, chunk.subarray(offset, end)]);
        output.fill(0); output = next;
        if (newline >= 0) {
          acceptLine(output); output.fill(0); output = Buffer.alloc(0);
        }
        offset = newline < 0 ? chunk.length : newline + 1;
      }
      chunk.fill(0);
    });
  };
  const request = async (kind, tail) => {
    if (failure || closing) throw failure || budgetFailure();
    if (pending.size >= 128) { fail(); throw failure; }
    const id = String(++sequence);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, kind, stage: currentStage(), phase: ready ? "request_dispatch" : "worker_startup", phaseCount: 0,
        payload: Buffer.from(`${id}\t${kind}\t${tail}\n`, "utf8") };
      pending.set(id, entry);
      try { start(); if (ready) dispatch(entry); } catch { /* start already rejected every pending entry */ }
    });
  };
  return {
    async harden(targetPath, targetKind) {
      if (typeof targetPath !== "string" || !targetPath.length || !["file", "directory"].includes(targetKind)) {
        throw new Error("Invalid private path request.");
      }
      await request(targetKind, Buffer.from(targetPath, "utf8").toString("base64"));
    },
    async dpapi(mode, entropy, input) {
      if (!["protect", "unprotect"].includes(mode) || !Buffer.isBuffer(entropy) || entropy.length !== 32
          || !Buffer.isBuffer(input) || !input.length || input.length > MAX_PRIVATE_VALUE_BYTES) {
        throw new Error("Invalid private DPAPI request.");
      }
      return request(mode, `${entropy.toString("base64")}\t${input.toString("base64")}`);
    },
    async close() {
      closing = true; clearTimeout(startupTimer);
      if (pending.size) fail();
      output.fill(0); output = Buffer.alloc(0);
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 500);
        child.once("close", () => { clearTimeout(timer); resolve(); });
        child.stdin.end();
      });
    },
  };
};

export const scopedPrivateAclWorker = (options) => {
  const scope = hookScope.getStore();
  if (!scope) return null;
  assertRuntimeHookBudget();
  scope.worker ??= createPrivateAclWorker({ ...options, signal: scope.signal });
  return scope.worker;
};

// A standalone bridge command may perform many private reads too. Reuse the
// transport only inside that invocation, with bounded startup/requests and no
// cached ACL/token result. Nested calls preserve the enclosing hook deadline.
export const withPrivateProcessSession = async (operation, signal) => {
  if (hookScope.getStore()) return operation();
  const scope = { signal, worker: null };
  return hookScope.run(scope, async () => {
    try { return await operation(); }
    finally { await scope.worker?.close(); }
  });
};

export const withRuntimeHookPrivateSession = (timeoutMilliseconds, operation) =>
  withPrivateProcessSession(operation, AbortSignal.timeout(timeoutMilliseconds));
