/**
 * Hook-local cancellation and Windows ACL transport. Reusing a process is not
 * reusing an ACL result: each exact path is still hardened and verified before
 * use. Nothing survives the hook or enters credentials, package state or logs.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const hookScope = new AsyncLocalStorage();
const stageScope = new AsyncLocalStorage();
export const PRIVATE_PROCESS_TIMEOUT_MILLISECONDS = 10_000;

const HOOK_STAGES = new Set([
  "local_state", "hook_setup", "runtime_state_read", "state_lock",
  "runtime_attestation", "bridge_credentials", "runtime_registration", "runtime_state_write",
]);
const ACL_PHASES = new Set([
  "request_dispatch", "path_decode", "identity", "owner_read", "owner_write",
  "dacl_write", "dacl_verify",
]);
const currentStage = () => stageScope.getStore() || "local_state";
const budgetFailure = ({ stage = currentStage(), phase, timeout = "hook" } = {}) => {
  // Diagnostics have a closed vocabulary. No target path, account identity,
  // request input or child text can enter the hook's model-visible reason.
  const hookStage = HOOK_STAGES.has(stage) ? stage : "local_state";
  const operation = ACL_PHASES.has(phase) ? `windows_acl.${phase}` : "local_state";
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

// The fixed script receives only base64 paths and a closed kind, never command
// text. Console I/O avoids PowerShell's formatting/encoding pipeline. Errors
// deliberately omit exception text, paths and any child stdout/stderr.
export const buildPrivateAclWorkerScript = (aclScript) => `
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Invoke-TrelioPrivateAcl {
${aclScript}
}
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = $null
  try {
    if ($line.Length -gt 16384) { throw "Invalid request." }
    $request = ConvertFrom-Json -InputObject $line
    if ($request.id -notmatch '^[0-9]+$' -or
        $request.kind -notin @("directory", "file") -or
        $request.path -notmatch '^[A-Za-z0-9+/]+={0,2}$') {
      throw "Invalid request."
    }
    $env:TRELIO_WINDOWS_PRIVATE_ACL_PATH_BASE64 = $request.path
    $env:TRELIO_WINDOWS_PRIVATE_ACL_KIND = $request.kind
    Invoke-TrelioPrivateAcl -ReportPhase {
      param($phase)
      [Console]::WriteLine((@{id=$request.id; phase=$phase} | ConvertTo-Json -Compress))
    }
    [Console]::WriteLine((@{id=$request.id; ok=$true} | ConvertTo-Json -Compress))
  } catch {
    [Console]::WriteLine((@{id=$request.id; ok=$false} | ConvertTo-Json -Compress))
  } finally {
    Remove-Item Env:TRELIO_WINDOWS_PRIVATE_ACL_PATH_BASE64 -ErrorAction SilentlyContinue
    Remove-Item Env:TRELIO_WINDOWS_PRIVATE_ACL_KIND -ErrorAction SilentlyContinue
  }
}
`;

export const createPrivateAclWorker = ({
  executable, aclScript, environment = process.env, signal,
  spawnProcess = spawn, requestTimeoutMilliseconds = PRIVATE_PROCESS_TIMEOUT_MILLISECONDS,
}) => {
  let child;
  let lines;
  let failure;
  let sequence = 0;
  let closing = false;
  const pending = new Map();
  const fail = (error) => {
    // Process launch/IO/protocol errors are distinct from a consumed budget.
    // Keep only a bounded OS code, never exec arguments or child error text.
    const causeCode = /^[A-Z0-9_]{2,32}$/u.test(error?.code || "") ? error.code : "IO_ERROR";
    const active = pending.values().next().value;
    failure ??= signal?.aborted ? budgetFailure(active) : Object.assign(new Error(
      `Windows ACL process не завершил проверку (${causeCode}).`,
    ), { code: "TRELIO_RUNTIME_HOOK_FAILED" });
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(failure);
    }
    pending.clear();
    child?.kill();
  };
  const start = () => {
    if (child) return;
    if (signal?.aborted) { fail(); throw failure; }
    child = spawnProcess(executable, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(buildPrivateAclWorkerScript(aclScript), "utf16le").toString("base64"),
    ], {
      env: environment, shell: false, windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"], ...(signal ? { signal } : {}),
    });
    child.on("error", fail);
    child.on("close", () => {
      if (!closing || pending.size) fail();
    });
    child.stdin.on("error", fail);
    // readline alone would accumulate an unterminated line indefinitely.
    // The fixed helper emits tiny responses; reject excess data before parsing.
    let lineBytes = 0;
    child.stdout.on("data", (chunk) => {
      for (const byte of chunk) {
        lineBytes = byte === 10 ? 0 : lineBytes + 1;
        if (lineBytes > 256) { fail(); return; }
      }
    });
    lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let reply;
      try {
        if (line.length > 256) throw new Error();
        reply = JSON.parse(line);
      } catch { fail(); return; }
      const entry = pending.get(reply?.id);
      if (!entry) { fail(); return; }
      if (Object.hasOwn(reply, "phase")) {
        // Phase updates describe work, never renew either deadline. A noisy
        // or incompatible child cannot keep the request alive indefinitely.
        if (!ACL_PHASES.has(reply.phase) || Object.hasOwn(reply, "ok")
            || ++entry.phaseCount > ACL_PHASES.size) { fail(); return; }
        entry.phase = reply.phase;
        return;
      }
      if (typeof reply.ok !== "boolean") { fail(); return; }
      clearTimeout(entry.timer);
      pending.delete(reply.id);
      if (reply.ok) entry.resolve();
      else {
        // Access/type failures are not timeout diagnostics. Both paths stop
        // this worker; never silently retry with an ordinary shell command.
        failure = Object.assign(new Error(
          `Windows не подтвердил права локального private path (stage=${entry.stage}; operation=windows_acl.${entry.phase}).`,
        ), { code: "TRELIO_RUNTIME_HOOK_FAILED" });
        entry.reject(failure);
        fail();
      }
    });
  };
  return {
    async harden(targetPath, targetKind) {
      if (failure || closing) throw failure || budgetFailure();
      start();
      if (pending.size >= 128) { fail(); throw failure; }
      const id = String(++sequence);
      await new Promise((resolve, reject) => {
        const entry = {
          resolve, reject, stage: currentStage(), phase: "request_dispatch", phaseCount: 0,
          // A stalled child cannot hold the registration lock until Codex
          // kills the hook. The hook-wide signal also includes queue time.
          timer: setTimeout(() => {
            failure = budgetFailure({ ...entry, timeout: "private_process" });
            fail();
          }, requestTimeoutMilliseconds),
        };
        pending.set(id, entry);
        child.stdin.write(`${JSON.stringify({
          id, kind: targetKind, path: Buffer.from(targetPath, "utf8").toString("base64"),
        })}\n`, (error) => { if (error) fail(); });
      });
    },
    async close() {
      closing = true;
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      // EOF normally ends the loop immediately. Teardown is independently
      // bounded, including an aborted worker, and never leaves a child keeping
      // the hook alive after its one JSON decision has been delivered.
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 500);
        child.once("close", () => { clearTimeout(timer); resolve(); });
        child.stdin.end();
      });
      lines?.close();
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

export const withRuntimeHookPrivateSession = async (timeoutMilliseconds, operation) => {
  const scope = { signal: AbortSignal.timeout(timeoutMilliseconds), worker: null };
  return hookScope.run(scope, async () => {
    try { return await operation(); }
    finally { await scope.worker?.close(); }
  });
};
