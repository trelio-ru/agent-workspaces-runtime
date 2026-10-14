import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { buildUnfiledQueueResponseSuffix, runUnfiledQueueHook, readUnfiledCompanyBinding, UNFILED_QUEUE_UNAVAILABLE_NOTICE } from "../host-runtime/scripts/trelio-unfiled-queue.mjs";

const fixtureQueue = (count = 1) => ({ schemaVersion: 1, companySlug: "synthetic", timeZone: "Europe/Moscow", count,
  workspaces: count ? [{ id: "11111111-1111-4111-8111-111111111111", expiresAt: "2026-11-13T23:00:00.000Z" }] : [] });
const dependencies = (queue) => ({ origin: "https://example.test", bridge: {}, readBinding: async () => ({ companySlug: "synthetic" }), readQueue: async () => queue });

test("empty queues inject no instruction at either turn boundary", async () => {
  for (const hook_event_name of ["UserPromptSubmit", "Stop"]) assert.deepEqual(await runUnfiledQueueHook({ hook_event_name }, dependencies(fixtureQueue(0))), {});
});

test("every nonempty response is checked against fresh queue, including a Stop continuation", async () => {
  const queue = fixtureQueue();
  const suffix = buildUnfiledQueueResponseSuffix(queue, { origin: "https://example.test", companySlug: "synthetic" });
  assert.match(suffix, /14\.11\.26/u); // Same instant in the actor's timezone.
  const start = await runUnfiledQueueHook({ hook_event_name: "UserPromptSubmit" }, dependencies(queue));
  assert.equal(start.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.ok(start.hookSpecificOutput.additionalContext.includes(suffix));
  for (const stop_hook_active of [false, true]) {
    const blocked = await runUnfiledQueueHook({ hook_event_name: "Stop", stop_hook_active, last_assistant_message: "Готово" }, dependencies(queue));
    assert.equal(blocked.decision, "block");
    assert.deepEqual(await runUnfiledQueueHook({ hook_event_name: "Stop", stop_hook_active, last_assistant_message: `Готово\n\n${suffix}` }, dependencies(queue)), {});
  }
  const stale = await runUnfiledQueueHook({ hook_event_name: "Stop", last_assistant_message: suffix }, dependencies(fixtureQueue(0)));
  assert.equal(stale.decision, "block"); assert.match(stale.reason, /теперь пуста/u);
  // Transfer/delete removes the obligation immediately, even in the same turn.
  assert.deepEqual(await runUnfiledQueueHook({ hook_event_name: "Stop", last_assistant_message: "Перенёс" }, dependencies(fixtureQueue(0))), {});
  assert.deepEqual(await runUnfiledQueueHook({ hook_event_name: "Stop", last_assistant_message: `Пример: ${suffix}\nДальше текст` }, dependencies(fixtureQueue(0))), {});
  // Missing response text on an older client permits only one correction;
  // the runtime must not loop forever or claim that it verified that response.
  assert.equal((await runUnfiledQueueHook({ hook_event_name: "Stop" }, dependencies(queue))).decision, "block");
  assert.deepEqual(await runUnfiledQueueHook({ hook_event_name: "Stop", stop_hook_active: true }, dependencies(queue)), {});
});

test("outage and inconsistent snapshots do not masquerade as an empty queue or leak exceptions", async () => {
  const result = await runUnfiledQueueHook({ hook_event_name: "Stop", last_assistant_message: "Готово" }, {
    ...dependencies(null), readQueue: async () => { throw new Error("private title and credential"); },
  });
  assert.equal(result.decision, "block");
  assert.ok(result.reason.includes(UNFILED_QUEUE_UNAVAILABLE_NOTICE));
  assert.doesNotMatch(JSON.stringify(result), /private|credential/u);
  assert.throws(() => buildUnfiledQueueResponseSuffix({ ...fixtureQueue(), companySlug: "another" }, { origin: "https://example.test", companySlug: "synthetic" }));
  assert.throws(() => buildUnfiledQueueResponseSuffix({ ...fixtureQueue(), count: 0 }, { origin: "https://example.test", companySlug: "synthetic" }));
});

test("only the selected company's queue is read; unrelated folders are silent", async () => {
  let reads = 0;
  const options = { ...dependencies(fixtureQueue()), readQueue: async slug => { reads++; assert.equal(slug, "synthetic"); return fixtureQueue(); } };
  await runUnfiledQueueHook({ hook_event_name: "UserPromptSubmit" }, options);
  assert.equal(reads, 1);
  assert.deepEqual(await runUnfiledQueueHook({ hook_event_name: "Stop" }, { ...options, readBinding: async () => null }), {});
  assert.equal(reads, 1);
  assert.throws(() => buildUnfiledQueueResponseSuffix({ ...fixtureQueue(), companySlug: "other" }, { origin: "https://example.test", companySlug: "synthetic" }));
});

test("company binding uses only bounded managed scope or exact Run metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trelio-unfiled-binding-"));
  const agents = path.join(root, "AGENTS.md");
  const block = "<!-- trelio-agent-workspaces:start -->\nПапка привязана к компании «Synthetic» (`synthetic`). Это контекст работы, а не привязка Git-репозитория.\n<!-- trelio-agent-workspaces:end -->";
  try {
    assert.equal(await readUnfiledCompanyBinding(root), null);
    await writeFile(agents, "Mention `other` in arbitrary text");
    assert.equal(await readUnfiledCompanyBinding(root), null);
    await writeFile(agents, block);
    const child = path.join(root, "workspaces", "one", "workspace"); await mkdir(child, { recursive: true });
    assert.deepEqual(await readUnfiledCompanyBinding(child), { companySlug: "synthetic" });
    await writeFile(path.join(root, "workspaces", "one", ".trelio-run.json"), JSON.stringify({ company: { slug: "run-company" } }));
    assert.deepEqual(await readUnfiledCompanyBinding(child), { companySlug: "run-company" });
    await writeFile(agents, `${block}\n${block}`); await assert.rejects(readUnfiledCompanyBinding(root));
    await writeFile(agents, "x".repeat(65537)); await assert.rejects(readUnfiledCompanyBinding(root));
    await rm(agents); await symlink(path.join(root, "missing"), agents); await assert.rejects(readUnfiledCompanyBinding(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real unpaired hook is silent in any folder without starting pairing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trelio-unfiled-hook-"));
  try {
    for (const hook_event_name of ["UserPromptSubmit", "Stop"]) {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [new URL("../host-runtime/scripts/trelio-runtime-session.mjs", import.meta.url).pathname], {
          env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: root, TRELIO_WORKSPACE_CONFIG_DIR: root, TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1" }, stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "", stderr = "";
        child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
        child.on("error", reject); child.on("exit", code => resolve({ code, stdout, stderr }));
        child.stdin.end(JSON.stringify({ hook_event_name, cwd: root, session_id: "synthetic" }));
      });
      assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), {});
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("real turn hook uses a bounded authenticated queue read and rechecks after deletion", async () => {
  if (process.platform === "win32") return; // DPAPI real-worker coverage owns Windows credential storage.
  const root = await mkdtemp(path.join(os.tmpdir(), "trelio-unfiled-live-hook-"));
  let queue = fixtureQueue(), reads = 0;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer synthetic-queue-token");
    assert.equal(request.url, "/api/agent-workspaces/unfiled-queue?companySlug=synthetic");
    reads++; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(queue));
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await writeFile(path.join(root, ".trelio-run.json"), JSON.stringify({ company: { slug: "synthetic" } }));
    const config = path.join(root, ".config", "trelio", "workspace-bridge"); await mkdir(config, { recursive: true, mode: 0o700 });
    await writeFile(path.join(config, "credentials.json"), JSON.stringify({ [origin]: { bridgeSessionToken: "synthetic-queue-token" } }), { mode: 0o600 });
    const run = (hook_event_name, last_assistant_message = "Готово") => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [new URL("../host-runtime/scripts/trelio-runtime-session.mjs", import.meta.url).pathname], {
        env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: root, TRELIO_WORKSPACE_CONFIG_DIR: config,
          TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1", TRELIO_WORKSPACE_ORIGIN: origin }, stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
      child.on("error", reject); child.on("exit", code => { assert.equal(code, 0, stderr); resolve(JSON.parse(stdout)); });
      child.stdin.end(JSON.stringify({ hook_event_name, last_assistant_message, cwd: root, session_id: "synthetic" }));
    });
    assert.ok((await run("UserPromptSubmit")).hookSpecificOutput.additionalContext.includes("Неразобранные: 1"));
    assert.equal((await run("Stop")).decision, "block");
    const suffix = buildUnfiledQueueResponseSuffix(queue, { origin, companySlug: "synthetic" });
    assert.deepEqual(await run("Stop", suffix), {});
    queue = fixtureQueue(0);
    assert.deepEqual(await run("Stop"), {});
    assert.equal(reads, 4, "No cached queue or last-turn shortcut");
  } finally {
    await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
  }
});
