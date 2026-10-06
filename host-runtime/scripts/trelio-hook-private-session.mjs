/**
 * Hook-local cancellation and Windows ACL transport. Reusing a process is not
 * reusing an ACL result: each exact path is still hardened and verified before
 * use. Nothing survives the hook or enters credentials, package state or logs.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const hookScope = new AsyncLocalStorage();
export const PRIVATE_PROCESS_TIMEOUT_MILLISECONDS = 10_000;

const budgetFailure = () => Object.assign(new Error(
  "истёк внутренний срок hook при проверке локального состояния; повторите запрос в текущей задаче",
), { code: "TRELIO_RUNTIME_HOOK_FAILED" });

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
    Invoke-TrelioPrivateAcl
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
    failure ??= signal?.aborted ? budgetFailure() : Object.assign(new Error(
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
      if (!entry || typeof reply.ok !== "boolean") { fail(); return; }
      clearTimeout(entry.timer);
      pending.delete(reply.id);
      if (reply.ok) entry.resolve();
      else {
        // Access/type failures are not timeout diagnostics. Both paths stop
        // this worker; never silently retry with an ordinary shell command.
        failure = new Error("Windows не подтвердил права локального private path.");
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
        pending.set(id, {
          resolve, reject,
          // A stalled child cannot hold the registration lock until Codex
          // kills the hook. The hook-wide signal also includes queue time.
          timer: setTimeout(() => { failure = budgetFailure(); fail(); }, requestTimeoutMilliseconds),
        });
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
