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
  "worker_startup", "request_dispatch", "path_decode", "identity", "owner_read", "owner_write",
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
  try {
    if ($line.Length -gt 16384) { throw "Invalid request." }
    $fields = $line.Split([char]9)
    if ($fields.Length -ne 3 -or $fields[0] -notmatch '^[0-9]{1,16}$' -or
        $fields[1] -notin @("directory", "file") -or
        $fields[2] -notmatch '^[A-Za-z0-9+/]+={0,2}$') {
      throw "Invalid request."
    }
    $id = $fields[0]
    $env:TRELIO_WINDOWS_PRIVATE_ACL_PATH_BASE64 = $fields[2]
    $env:TRELIO_WINDOWS_PRIVATE_ACL_KIND = $fields[1]
    Invoke-TrelioPrivateAcl -ReportPhase {
      param($phase)
      # The id is decimal and phases come only from the fixed ACL script.
      $writer.WriteLine('{"id":"' + $id + '","phase":"' + $phase + '"}')
    }
    $writer.WriteLine('{"id":"' + $id + '","ok":true}')
  } catch {
    $writer.WriteLine('{"id":"' + $id + '","ok":false}')
  } finally {
    [Environment]::SetEnvironmentVariable("TRELIO_WINDOWS_PRIVATE_ACL_PATH_BASE64", $null, "Process")
    [Environment]::SetEnvironmentVariable("TRELIO_WINDOWS_PRIVATE_ACL_KIND", $null, "Process")
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
  let ready = false;
  const pending = new Map();
  const dispatch = (entry) => {
    entry.phase = "request_dispatch";
    child.stdin.write(entry.payload, (error) => { if (error) fail(error); });
    // Discard the path from the pending bookkeeping as soon as it is sent.
    entry.payload = undefined;
  };
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
      if (Object.hasOwn(reply ?? {}, "ready")) {
        // Exactly one readiness response, with no request fields. It is not
        // evidence of ACL success and never renews a request/hook deadline.
        if (ready || reply.ready !== true || Object.keys(reply).length !== 1) { fail(); return; }
        ready = true;
        for (const entry of pending.values()) dispatch(entry);
        return;
      }
      const entry = pending.get(reply?.id);
      if (!ready || !entry) { fail(); return; }
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
          resolve, reject, stage: currentStage(), phase: ready ? "request_dispatch" : "worker_startup", phaseCount: 0,
          payload: `${id}\t${targetKind}\t${Buffer.from(targetPath, "utf8").toString("base64")}\n`,
          // A stalled child cannot hold the registration lock until Codex
          // kills the hook. The hook-wide signal also includes queue time.
          timer: setTimeout(() => {
            failure = budgetFailure({ ...entry, timeout: "private_process" });
            fail();
          }, requestTimeoutMilliseconds),
        };
        pending.set(id, entry);
        if (ready) dispatch(entry);
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
