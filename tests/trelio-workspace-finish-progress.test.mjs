import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import { createFinishProgressParser, createWorkspaceFinishOperations, runWorkspaceFinishProcess } from "../host-runtime/scripts/trelio-workspace-finish-progress.mjs";
import { handleTrelioWorkspaceActionOperation } from "../host-runtime/scripts/trelio-local-context.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const pending = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };

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
