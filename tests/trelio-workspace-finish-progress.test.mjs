import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import { createFinishProgressParser, createWorkspaceFinishOperations, createCompanySearchOperations, runWorkspaceFinishProcess } from "../host-runtime/scripts/trelio-workspace-finish-progress.mjs";
import { handleTrelioWorkspaceActionOperation } from "../host-runtime/scripts/trelio-local-context.mjs";
import { createFinishRecoveryMarker, hasFinishRecoveryMarker, reusableFinishHandoff } from "../host-runtime/scripts/trelio-workspace-finish-recovery.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { trelioCallSignal, withTrelioCallBudget } from "../host-runtime/scripts/trelio-hook-private-session.mjs";

const pending = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };

const searchInput = { companySlug: "synthetic", nativeTool: "search", operation: "native_read", arguments: { queries: ["PRIVATE_QUERY"] } };
const searchValue = { generation: "a".repeat(64), result: { provider: "local_company_context", results: [{ title: "PRIVATE_ANSWER" }] } };
const searchOptions = { authorize: async () => ({ binding: "recipient" }), validate: async () => true, initialWaitMs: 2, waitMs: 2 };

test("a new company search waits 15 seconds and its continuation waits 10", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const completion = pending();
  const reader = createCompanySearchOperations({
    authorize: searchOptions.authorize, validate: searchOptions.validate, execute: () => completion.promise,
  });
  t.after(async () => { completion.resolve(searchValue); await reader.close(); });
  const origin = "https://synthetic.invalid";
  const flush = () => new Promise(resolve => setImmediate(resolve));

  let firstReturned = false;
  const first = reader.read(origin, searchInput).then(value => { firstReturned = true; return value; });
  await flush();
  t.mock.timers.tick(14_999);
  await flush();
  assert.equal(firstReturned, false);
  t.mock.timers.tick(1);
  const status = await first;
  assert.equal(status.state, "preparing");

  const pollInput = status.nextCall.arguments.parameters;
  const poll = () => reader.read(origin, pollInput, { operationId: status.operationId });
  let pollReturned = false;
  const second = poll().then(value => { pollReturned = true; return value; });
  await flush();
  t.mock.timers.tick(9_999);
  await flush();
  assert.equal(pollReturned, false);
  t.mock.timers.tick(1);
  assert.equal((await second).operationId, status.operationId);

  completion.resolve(searchValue);
  assert.deepEqual(await poll(), searchValue.result);
});

test("company search shares one isolated preparation, survives short wait cancellation and delivers once", async () => {
  const prepared = pending();
  let executions = 0, admissionReads = 0, querySignal;
  const reader = createCompanySearchOperations({ ...searchOptions,
    authorize: async () => { admissionReads++; return { binding: "recipient" }; },
    execute: async (_origin, _input, _admission, { signal, onProgress }) => {
      executions++; querySignal = signal; onProgress("hydrating");
      assert.equal(trelioCallSignal(), undefined);
      await prepared.promise; signal.throwIfAborted(); return searchValue;
    } });
  const caller = new AbortController();
  const first = await withTrelioCallBudget(signal => reader.read("https://synthetic.invalid", searchInput, { signal }), { signal: caller.signal, timeoutMs: 30 });
  caller.abort();
  assert.equal(first.state, "preparing");
  assert.equal(first.progress.stage, "hydrating");
  assert.equal(querySignal.aborted, false);
  assert.equal(first.results, undefined, "Preparation is never an empty successful result");
  assert.equal(first.nextCall.arguments.parameters.searchOperationId, first.operationId);
  const second = await reader.read("https://synthetic.invalid", searchInput);
  assert.equal(second.operationId, first.operationId);
  assert.deepEqual(first.nextCall.arguments.parameters.arguments, {});
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_QUERY|PRIVATE_ANSWER/u);
  const compactPoll = first.nextCall.arguments.parameters;
  await assert.rejects(reader.read("https://synthetic.invalid", { ...compactPoll, nativeTool: "search_agent_guidance" }, { operationId: first.operationId }), { code: "LOCAL_CONTEXT_SEARCH_UNKNOWN" });
  await assert.rejects(reader.read("https://synthetic.invalid", { ...searchInput, arguments: { queries: ["changed"] } }), { code: "LOCAL_CONTEXT_SEARCH_IN_PROGRESS" });
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(reader.read("https://synthetic.invalid", searchInput, { operationId: first.operationId, signal: cancelled.signal }), { name: "AbortError" });
  prepared.resolve();
  assert.deepEqual(await reader.read("https://synthetic.invalid", searchInput, { operationId: first.operationId }), searchValue.result);
  await assert.rejects(reader.read("https://synthetic.invalid", searchInput, { operationId: first.operationId }), { code: "LOCAL_CONTEXT_SEARCH_UNKNOWN" });
  assert.equal(executions, 1);
  assert.ok(admissionReads >= 5);
  await reader.close();
});

test("company search deadlines never slide across polls and stale recipients cannot receive a result", async () => {
  let binding = "one", launches = 0;
  const reader = createCompanySearchOperations({ ...searchOptions, timeoutMs: 35,
    authorize: async () => ({ binding }), execute: async (_origin, _input, _admission, { signal }) => {
      launches++;
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
  const first = await reader.read("https://synthetic.invalid", searchInput);
  await new Promise(resolve => setTimeout(resolve, 40));
  await assert.rejects(reader.read("https://synthetic.invalid", searchInput, { operationId: first.operationId }), { code: "LOCAL_CONTEXT_SEARCH_TIMEOUT" });
  assert.equal(launches, 1);
  await assert.rejects(reader.read("https://synthetic.invalid", searchInput, { operationId: first.operationId }), { code: "LOCAL_CONTEXT_SEARCH_UNKNOWN" });
  await reader.close();
  const delayed = pending();
  const acl = createCompanySearchOperations({ ...searchOptions, authorize: async () => ({ binding }), execute: () => delayed.promise });
  const running = await acl.read("https://synthetic.invalid", searchInput);
  delayed.resolve(searchValue); binding = "other";
  await assert.rejects(acl.read("https://synthetic.invalid", searchInput, { operationId: running.operationId }), { code: "LOCAL_CONTEXT_SEARCH_ACCESS_CHANGED" });
  await acl.close();
});

test("verified hydration extends observed search past idle, with a fixed overall deadline", async t => {
  let elapsedMs = 0;
  const timers = new Set();
  t.mock.method(performance, "now", () => elapsedMs);
  // Node 22's mock Timeout.refresh is a no-op. Model a refreshed observer
  // deadline on the same clock that the real search uses for idle accounting.
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds, ...args) => {
    const timer = {
      dueAt: elapsedMs + milliseconds,
      fire: () => callback(...args),
      refresh() { this.dueAt = elapsedMs + milliseconds; },
      unref() {},
    };
    timers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", timer => timers.delete(timer));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const advance = async milliseconds => {
    const end = elapsedMs + milliseconds;
    for (;;) {
      const next = [...timers].sort((left, right) => left.dueAt - right.dueAt)[0];
      if (!next || next.dueAt > end) break;
      elapsedMs = next.dueAt;
      timers.delete(next);
      next.fire();
    }
    elapsedMs = end;
    await flush();
  };
  const waitForPreparing = async request => {
    await flush(); // The poll must already be waiting before its clock moves.
    await advance(searchOptions.waitMs);
    return request;
  };

  for (const outcome of ["complete", "idle", "unobserved", "deadline"]) {
    const completion = pending();
    let report;
    const reader = createCompanySearchOperations({ ...searchOptions,
      idleMs: 200, timeoutMs: outcome === "deadline" ? 260 : 2000,
      execute: async (_origin, _input, _admission, { signal, onProgress }) => {
        report = onProgress;
        onProgress("hydrating");
        const aborted = new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        return Promise.race([completion.promise, aborted]);
      },
    });
    try {
      const origin = "https://synthetic.invalid";
      const first = await waitForPreparing(reader.read(origin, searchInput));
      const poll = () => reader.read(origin, first.nextCall.arguments.parameters, { operationId: first.operationId });
      for (let i = 0; i < (["idle", "deadline"].includes(outcome) ? 2 : 3); i++) {
        await advance(65);
        report(outcome === "idle" ? "hydrating" : "hydration_progress");
        if (outcome !== "unobserved") assert.equal((await waitForPreparing(poll())).progress.stage, "hydrating");
      }
      await advance(145);
      if (outcome === "complete") {
        completion.resolve(searchValue);
        assert.deepEqual(await poll(), searchValue.result);
      } else {
        const pattern = { idle: /без подтверждённого прогресса/u, unobserved: /отсутствия запросов/u,
          deadline: /общего лимита/u }[outcome];
        await assert.rejects(poll(), error => error.code === "LOCAL_CONTEXT_SEARCH_TIMEOUT" && pattern.test(error.message));
      }
    } finally { await reader.close(); }
  }
});

test("company search refreshes a stale generation once under the original continuation", async () => {
  const origin = "https://synthetic.invalid";
  const updated = { generation: "b".repeat(64), result: { results: [{ title: "NEW_SNAPSHOT" }] } };
  const oldValidation = pending();
  const validationStarted = pending();
  const concurrentValidation = pending();
  let executions = 0, validations = 0, invalidatedReaders = 0, admissionReads = 0;
  const reader = createCompanySearchOperations({ ...searchOptions,
    authorize: async () => { admissionReads++; return { binding: "recipient" }; },
    execute: async (_origin, input) => {
      assert.deepEqual(input, searchInput, "A compact poll cannot replace the original request");
      if (++executions === 1) return searchValue;
      assert.equal(invalidatedReaders, 1, "Drop the stale warm reader before starting the retry");
      return updated;
    },
    validate: async (_origin, input, value) => {
      assert.deepEqual(input, searchInput);
      if (++validations === 1) {
        validationStarted.resolve();
        return oldValidation.promise;
      }
      if (validations === 2) return concurrentValidation.promise;
      return value.generation === updated.generation;
    },
    closeReader: async () => { invalidatedReaders++; },
  });
  const slowSearch = reader.read(origin, searchInput);
  await validationStarted.promise;
  // An identical direct invocation joins the first validation. Its mismatch
  // starts the only retry while the original validation is still outstanding.
  const concurrent = reader.read(origin, searchInput);
  concurrentValidation.resolve(false);
  const retrying = await concurrent;
  assert.equal(retrying.state, "preparing");
  oldValidation.resolve(true);
  const late = await slowSearch;
  assert.equal(late.operationId, retrying.operationId);
  assert.equal(late.state, "preparing", "A late validation cannot expose the discarded answer");
  assert.doesNotMatch(JSON.stringify(retrying), /PRIVATE_QUERY|PRIVATE_ANSWER/u);
  const poll = retrying.nextCall.arguments.parameters;
  assert.deepEqual(await reader.read(origin, poll, { operationId: retrying.operationId }), updated.result);
  await assert.rejects(reader.read(origin, poll, { operationId: retrying.operationId }), { code: "LOCAL_CONTEXT_SEARCH_UNKNOWN" });
  assert.equal(executions, 2);
  assert.equal(admissionReads, 4);
  await reader.close();
});

test("company search bounds real manifest conflicts and fails closed on access and deadlines", async () => {
  const origin = "https://synthetic.invalid";
  for (const failure of ["mismatch", "optimistic_conflict", "access", "deadline"]) {
    let executions = 0;
    const optimisticConflict = Object.assign(new Error("Native manifest conflict"), { code: "LOCAL_CONTEXT_GENERATION_CHANGED" });
    const reader = createCompanySearchOperations({ ...searchOptions,
      timeoutMs: failure === "deadline" ? 55 : 1000,
      isValidationConflict: error => error === optimisticConflict,
      execute: async (_origin, _input, _admission, { signal }) => {
        if (++executions === 2 && failure === "deadline")
          await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        return searchValue;
      },
      validate: async () => {
        if (failure === "access")
          throw Object.assign(new Error("Recipient changed"), { code: "LOCAL_CONTEXT_SEARCH_ACCESS_CHANGED" });
        if (failure === "optimistic_conflict") throw optimisticConflict;
        return false;
      },
    });
    if (failure === "access") {
      await assert.rejects(reader.read(origin, searchInput), { code: "LOCAL_CONTEXT_SEARCH_ACCESS_CHANGED" });
      assert.equal(executions, 1, "Access changes never start a retry");
    } else {
      const retrying = await reader.read(origin, searchInput);
      assert.equal(retrying.state, "preparing");
      const poll = () => reader.read(origin, retrying.nextCall.arguments.parameters, { operationId: retrying.operationId });
      if (failure === "deadline") {
        await new Promise(resolve => setTimeout(resolve, 60));
        await assert.rejects(poll(), { code: "LOCAL_CONTEXT_SEARCH_TIMEOUT" });
      } else {
        await assert.rejects(poll(), error => failure === "optimistic_conflict"
          ? error === optimisticConflict : error.code === "LOCAL_CONTEXT_GENERATION_CHANGED");
      }
      assert.equal(executions, 2);
      await assert.rejects(poll(), { code: "LOCAL_CONTEXT_SEARCH_UNKNOWN" });
    }
    await reader.close();
  }
});

test("company search rejects oversized answers and duplicate concurrent delivery", async () => {
  const oversized = createCompanySearchOperations({ ...searchOptions, execute: async () => ({ ...searchValue, result: { text: "x".repeat(513 * 1024) } }) });
  await assert.rejects(oversized.read("https://synthetic.invalid", searchInput), { code: "LOCAL_CONTEXT_SEARCH_FAILED" });
  await oversized.close();
  const gate = pending(), both = pending(); let validations = 0;
  const once = createCompanySearchOperations({ ...searchOptions, execute: async () => { await gate.promise; return searchValue; },
    validate: async () => { if (++validations === 2) both.resolve(); await both.promise; return true; } });
  const first = await once.read("https://synthetic.invalid", searchInput);
  gate.resolve();
  const results = await Promise.allSettled([1, 2].map(() => once.read("https://synthetic.invalid", searchInput, { operationId: first.operationId })));
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  await once.close();
});

test("background finish detaches from a short caller budget but every poll remains cancellable", async () => {
  const manager = createWorkspaceFinishOperations({ waitMs: 5 });
  const child = pending();
  const controller = new AbortController();
  const first = await withTrelioCallBudget(signal => manager.start({
    key: "root", scope: "run", fingerprint: "original", pollAction: {}, signal,
    execute: async () => {
      assert.equal(trelioCallSignal(), undefined);
      await child.promise;
      // Check the retained continuation too: clearing only the explicit child
      // signal would still inherit an expired parent through AsyncLocalStorage.
      assert.equal(trelioCallSignal(), undefined);
      return { stdout: "accepted" };
    },
  }), { signal: controller.signal, timeoutMs: 30 });
  controller.abort();
  assert.equal(first.state, "running");
  await new Promise(resolve => setTimeout(resolve, 40));
  const pollAbort = new AbortController();
  const poll = withTrelioCallBudget(signal => manager.poll("root", first.operationId, signal, "run"), { signal: pollAbort.signal });
  pollAbort.abort();
  await assert.rejects(poll, { name: "AbortError" });
  assert.equal(manager.active("root").operationId, first.operationId);
  child.resolve();
  const final = await manager.poll("root", first.operationId, undefined, "run");
  assert.equal(final.state, "completed");
  assert.equal(final.stdout, "accepted");
});

test("progress parser accepts split frames and drops prose, fields and oversized lines", () => {
  const seen = [];
  const parse = createFinishProgressParser((value) => seen.push(value));
  parse("private log\nTRELIO_FINISH_PRO");
  parse('GRESS {"stage":"projection","completedFiles":3,"totalFiles":52,"secret":"CANARY"}\n');
  parse(`TRELIO_FINISH_PROGRESS {"stage":"${"a".repeat(2000)}"}\n`);
  parse('TRELIO_FINISH_PROGRESS {"stage":"unknown","token":"CANARY"}\n');
  parse('TRELIO_FINISH_PROGRESS {"stage":"retry_wait","retryAfterMs":600000}\n');
  assert.deepEqual(seen, [{ stage: "projection", completedFiles: 3, totalFiles: 52 }, { stage: "retry_wait", retryAfterMs: 600000 }]);
});

test("bounded finish exposes progress, joins repeats and keeps running when the MCP wait is cancelled", async () => {
  const manager = createWorkspaceFinishOperations({ waitMs: 5 });
  const child = pending();
  let launches = 0, update;
  const options = { key: "exact-run-root", fingerprint: "same", pollAction: { schemaVersion: 1, operation: "status", workingDirectory: "/fixture" },
    execute: (onProgress) => { launches++; update = onProgress; return child.promise; } };
  const first = await manager.start(options);
  assert.equal(first.state, "running");
  update({ stage: "projection", completedFiles: 34, totalFiles: 52 });
  const second = await manager.start(options);
  assert.equal(second.operationId, first.operationId);
  assert.equal(second.progress.completedFiles, 34);
  const abort = new AbortController();
  const poll = manager.poll(options.key, first.operationId, abort.signal);
  abort.abort();
  await assert.rejects(poll, { name: "AbortError" });
  assert.equal(manager.active(options.key).state, "running");
  await assert.rejects(manager.start({ ...options, fingerprint: "changed handoff" }), { code: "TRELIO_WORKSPACE_FINISH_IN_PROGRESS" });
  child.resolve({ schemaVersion: 1, operation: "finish", stdout: "accepted" });
  const final = await manager.poll(options.key, first.operationId);
  assert.equal(final.state, "completed");
  assert.equal(final.stdout, "accepted");
  assert.equal((await manager.start(options)).operationId, first.operationId);
  assert.equal(launches, 1);
  await assert.rejects(manager.poll("foreign-root", first.operationId), { code: "TRELIO_WORKSPACE_FINISH_UNKNOWN" });
});

test("failed background finish retains the original error and only an explicit finish can retry", async () => {
  const manager = createWorkspaceFinishOperations({ waitMs: 1 });
  const child = pending();
  let launches = 0;
  const input = { key: "root", fingerprint: "same", pollAction: {}, execute: () => { launches++; return child.promise; } };
  const running = await manager.start(input);
  const failure = Object.assign(new Error("synthetic 503"), { code: "AGENT_WORKSPACE_STORAGE_UNAVAILABLE" });
  child.reject(failure);
  await assert.rejects(manager.poll("root", running.operationId), (error) => error === failure);
  await assert.rejects(manager.poll("root", running.operationId), (error) => error === failure);
  assert.equal(launches, 1);
  const result = await manager.start({ ...input, execute: async () => { launches++; return { stdout: "accepted after read-back" }; } });
  assert.equal(result.state, "completed");
  assert.equal(launches, 2);
});

test("workspace action dispatch polls the exact operation without spawning status or another finish", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-finish-dispatch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = pending();
  const calls = [];
  const manager = createWorkspaceFinishOperations({ waitMs: 2 });
  const options = { finishOperations: manager, resolveFinishRunIdentity: async () => ({ workspaceId: "fixture", runId: "run" }), runBridge: async (_origin, args, processOptions) => {
    calls.push(args); assert.equal(processOptions.signal, undefined);
    processOptions.onProgress({ stage: "projection", completedFiles: 2, totalFiles: 3 });
    return child.promise;
  } };
  const action = { schemaVersion: 1, operation: "finish", workingDirectory: root,
    parameters: { summary: "Готово", evidence: ["Проверено"], filePaths: ["result.md"], nextAction: "Проверить результат" } };
  const first = await handleTrelioWorkspaceActionOperation("https://example.test", action, options);
  assert.equal(first.state, "running");
  assert.equal(first.progress.completedFiles, 2);
  const second = await handleTrelioWorkspaceActionOperation("https://example.test", first.nextCall.arguments, options);
  assert.equal(second.operationId, first.operationId);
  await handleTrelioWorkspaceActionOperation("https://example.test", action, options);
  assert.equal(calls.length, 1);
  child.resolve({ stdout: "accepted", stderr: "" });
  assert.equal((await handleTrelioWorkspaceActionOperation("https://example.test", first.nextCall.arguments, options)).state, "completed");
});


test("real finish child exposes progress before exit and survives output beyond execFile maxBuffer", { timeout: 10_000 }, async () => {
  const firstProgress = pending();
  let lastProgress;
  const source = `
    const frame = 'TRELIO_FINISH_PROGRESS {"stage":"projection","completedFiles":34,"totalFiles":52}\\n';
    for (let i = 0; i < 60000; i++) process.stderr.write(frame);
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.stdout.write('accepted');
  `;
  let completed = false;
  const operation = runWorkspaceFinishProcess(process.execPath, ["--input-type=module", "-e", source], {
    onProgress: (progress) => { lastProgress = progress; firstProgress.resolve(); },
  }).then((result) => { completed = true; return result; });
  await firstProgress.promise;
  assert.equal(completed, false);
  const result = await operation;
  assert.equal(lastProgress.completedFiles, 34);
  assert.equal(result.stdout, "accepted");
  assert.ok(result.stderr.length <= 1024 * 1024);
});

test("a rejected CLI finish exits nonzero after cleanup despite a lingering dependency handle", { timeout: 10_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-finish-exit-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const preload = path.join(home, "linger.mjs");
  await fs.writeFile(preload, "setInterval(() => {}, 1000);");
  const bridge = new URL("../host-runtime/scripts/trelio-workspace.mjs", import.meta.url);
  // No metadata exists in this isolated home, so the real CLI refuses before
  // any credential or HTTP read. Its error must settle the child, never turn
  // into a timeout or a successful save merely because the process is alive.
  await assert.rejects(promisify(execFile)(process.execPath,
    // --import takes a module specifier, so a Windows drive path must be a
    // file URL. The executable's entrypoint still takes an ordinary OS path.
    ["--import", pathToFileURL(preload).href, fileURLToPath(bridge), "finish"], {
      cwd: home, timeout: 5000, env: { ...process.env, HOME: home, USERPROFILE: home,
        LOCALAPPDATA: path.join(home, "AppData", "Local"), XDG_CONFIG_HOME: path.join(home, ".config"),
        CODEX_HOME: path.join(home, ".codex"), TRELIO_CONFIG_HOME: path.join(home, "trelio"),
        TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1" },
    }), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.killed, false);
      assert.match(error.stderr, /Ошибка:/u);
      return true;
    });
});


test("two real processes cannot finish the same Run concurrently and the lock releases", { timeout: 10_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-finish-lock-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    LOCALAPPDATA: path.join(home, "AppData", "Local"), XDG_CONFIG_HOME: path.join(home, ".config"),
    CODEX_HOME: path.join(home, ".codex"), TRELIO_CONFIG_HOME: path.join(home, "trelio"),
    TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1" };
  const moduleUrl = new URL("../host-runtime/scripts/trelio-workspace.mjs", import.meta.url).href;
  const source = `
    const { withWorkspaceFinishLock } = await import(${JSON.stringify(moduleUrl)});
    try { await withWorkspaceFinishLock("11111111-1111-4111-8111-111111111111", async () => {
      process.stdout.write("locked\\n");
      if (process.argv[1] === "hold") await new Promise((resolve) => { process.stdin.once("data", resolve); process.stdin.resume(); });
      process.stdin.pause();
    }); } catch (error) { process.stdout.write(error.code); process.exitCode = 1; }
  `;
  const first = spawn(process.execPath, ["--input-type=module", "-e", source, "hold"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const firstClosed = once(first, "close");
  t.after(async () => { first.kill(); await firstClosed; await fs.rm(home, { recursive: true, force: true }); });
  assert.match(String((await once(first.stdout, "data"))[0]), /locked/u);
  const exec = promisify(execFile);
  await assert.rejects(exec(process.execPath, ["--input-type=module", "-e", source], { env }),
    (error) => { assert.equal(error.stdout, "TRELIO_WORKSPACE_FINISH_IN_PROGRESS"); return true; });
  first.stdin.end("release");
  assert.deepEqual(await firstClosed, [0, null]);
  assert.equal((await exec(process.execPath, ["--input-type=module", "-e", source], { env })).stdout, "locked\n");
});


test("a new Run in the same directory cannot receive a previous Run's receipt", async () => {
  const manager = createWorkspaceFinishOperations({ waitMs: 1 });
  let launches = 0;
  const input = { key: "root", scope: "run-a", fingerprint: "same", pollAction: {},
    execute: async () => ({ stdout: `receipt-${++launches}` }) };
  const first = await manager.start(input);
  await assert.rejects(manager.poll("root", first.operationId, undefined, "run-b"), { code: "TRELIO_WORKSPACE_FINISH_UNKNOWN" });
  const second = await manager.start({ ...input, scope: "run-b" });
  assert.notEqual(first.operationId, second.operationId);
  assert.equal(second.stdout, "receipt-2");
});


test("handoff recovery compares the exact decrypted intent, Run, lease and draft", () => {
  const metadata = { workspaceId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222",
    baseHead: "a".repeat(40), draftHead: "b".repeat(40), leaseId: "33333333-3333-4333-8333-333333333333", fencingToken: 7 };
  metadata.finishRecovery = createFinishRecoveryMarker(metadata);
  const requested = { summary: "Prepared result", evidence: [{ check: "passed", count: 2 }],
    filesChanged: ["result.md"], openQuestions: [], nextAction: { instruction: "Review", taskOutcome: "no_status_change" } };
  const checkpoint = { id: "44444444-4444-4444-8444-444444444444", runId: metadata.runId,
    checkpointType: "handoff", candidateHead: metadata.draftHead, summary: requested.summary,
    evidenceJson: [{ count: 2, check: "passed" }], filesChangedJson: [...requested.filesChanged],
    openQuestionsJson: [], nextActionJson: { taskOutcome: "no_status_change", instruction: "Review" } };
  const snapshot = { run: { ...metadata, id: metadata.runId, status: "running" }, latestCheckpoint: checkpoint };
  assert.equal(reusableFinishHandoff({ metadata, snapshot, requested }), checkpoint, "object key order is not semantic");
  for (const mutate of [
    (x) => { delete x.metadata.finishRecovery; },
    (x) => { x.metadata.finishRecovery.runId = "55555555-5555-4555-8555-555555555555"; },
    (x) => { x.snapshot.run.workspaceId = "55555555-5555-4555-8555-555555555555"; },
    (x) => { x.snapshot.run.baseHead = "c".repeat(40); },
    (x) => { x.snapshot.run.draftHead = "c".repeat(40); },
    (x) => { x.snapshot.run.fencingToken += 1; },
    (x) => { x.snapshot.run.leaseId = "55555555-5555-4555-8555-555555555555"; },
    (x) => { x.snapshot.run.status = "accepted"; },
    (x) => { x.snapshot.latestCheckpoint = null; },
    (x) => { x.snapshot.latestCheckpoint.runId = "55555555-5555-4555-8555-555555555555"; },
    (x) => { x.snapshot.latestCheckpoint.candidateHead = "c".repeat(40); },
    (x) => { x.snapshot.latestCheckpoint.checkpointType = "draft"; },
    (x) => { x.snapshot.latestCheckpoint.summary = "TRELIOE1:opaque-marker"; },
    (x) => { x.requested.summary = "Changed result"; },
    (x) => { x.requested.evidence.push("New check"); },
    (x) => { x.requested.filesChanged.push("another.md"); },
    (x) => { x.requested.openQuestions.push("Unresolved"); },
    (x) => { x.requested.nextAction.taskOutcome = "work_completed"; },
  ]) {
    const input = structuredClone({ metadata, snapshot, requested });
    mutate(input);
    assert.equal(reusableFinishHandoff(input), null);
  }
  assert.equal(hasFinishRecoveryMarker({ ...metadata, runId: "55555555-5555-4555-8555-555555555555" }), false);
});


test('shared finish process accepts a bounded assistant envelope on stdin with unchanged human argv ABI',async()=>{
  const source=`let text='';for await(const chunk of process.stdin)text+=chunk;process.stdout.write(JSON.parse(text).note);`;
  const result=await runWorkspaceFinishProcess(process.execPath,['--input-type=module','-e',source],{input:JSON.stringify({note:'Только stdin'})});
  assert.equal(result.stdout,'Только stdin');
});

test('shared child transport retains complete visual-size frames only under the fixed skill output bound',async()=>{
  const source=`process.stdout.write(JSON.stringify({data:'x'.repeat(1500000)}));`;
  const full=await runWorkspaceFinishProcess(process.execPath,['-e',source],{maximumCharacters:3*1024*1024});
  assert.equal(JSON.parse(full.stdout).data.length,1500000);
  const ordinary=await runWorkspaceFinishProcess(process.execPath,['-e',source],{});
  assert.equal(ordinary.stdout.length,1024*1024);
  await assert.rejects(runWorkspaceFinishProcess(process.execPath,['-e','process.exit(99)'],{maximumCharacters:16*1024*1024}),/output bound/);
});

test("bounded child stdout and stderr tails keep whole supplementary characters", async () => {
  // Force the retained suffix to begin on the low half of a pair in the old
  // implementation. Write both real pipes and include a final nonzero exit so
  // the same invariant is exercised in the attached failure diagnostics.
  const source = `const text='prefix💗'+'x'.repeat(1024*1024-1);process.stdout.write(text);process.stderr.write(text);process.exitCode=7;`;
  await assert.rejects(runWorkspaceFinishProcess(process.execPath, ["-e", source], {}), error => {
    for (const output of [error.stdout, error.stderr]) {
      assert.equal(output, "x".repeat(1024 * 1024 - 1));
      assert.equal(output.isWellFormed(), true);
    }
    return true;
  });
});
