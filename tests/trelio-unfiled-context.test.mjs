import { MCP_UNFILED_CONTEXT_RESPONSE_TOOLS } from "../host-runtime/scripts/trelio-unfiled-response-policy.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { readUnfiledResponseContext, validateUnfiledResponseContext } from "../host-runtime/scripts/trelio-unfiled-context.mjs";
import { pluginDirectory } from "./test-layout.mjs";

const workspace = { id: "11111111-1111-4111-8111-111111111111", expiresAt: "2026-11-14T12:00:00Z",
  workspaceUrl: "https://example.test/synthetic/workspaces/catalog/11111111-1111-4111-8111-111111111111/" };
const queue = count => ({ schemaVersion: 1, companySlug: "synthetic", count,
  responseContext: { companySlug: "synthetic", count, ...(count ? { workspace, timeZone: "Europe/Moscow",
    reminder: { count, instruction: "Every final response must ask for a project or deletion in this company." },
    nextCall: { tool: "get_unfiled_workspaces", arguments: { companySlug: "synthetic" } } } : {}) } });

test("fresh existing response context retains only the selected company's contract", async () => {
  let current = queue(2), reads = 0;
  const options = { readQueue: async slug => { reads++; assert.equal(slug, "synthetic"); return current; } };
  const first = await readUnfiledResponseContext("https://example.test", "synthetic", options);
  assert.deepEqual(first, current.responseContext);
  current = queue(0);
  assert.deepEqual(await readUnfiledResponseContext("https://example.test", "synthetic", options), { companySlug: "synthetic", count: 0 });
  assert.equal(reads, 2);
  assert.equal(await readUnfiledResponseContext("https://example.test", undefined, options), undefined);
  assert.equal(reads, 2);
  assert.throws(() => validateUnfiledResponseContext(queue(1), "another"));
  assert.throws(() => validateUnfiledResponseContext({ ...queue(0), responseContext: { ...queue(0).responseContext, reminder: "stale" } }, "synthetic"));
});

test("failed reads are advisory, bounded and never claim an empty queue or block a response", async () => {
  const context = await readUnfiledResponseContext("https://example.test", "synthetic", {
    readQueue: async (_slug, signal) => { assert.ok(signal); throw new Error("PRIVATE_CANARY"); },
  });
  assert.deepEqual(context, { companySlug: "synthetic", status: "unavailable",
    nextCall: { tool: "get_unfiled_workspaces", arguments: { companySlug: "synthetic" } } });
  assert.doesNotMatch(JSON.stringify(context), /count|PRIVATE_CANARY|decision|block/u);
  assert.equal(await readUnfiledResponseContext("https://example.test", "synthetic", {
    bridge: { readExistingBridgeSessionToken: async () => null, request: () => { throw new Error("must not pair"); } },
  }), undefined);
});

test("the unchanged plugin exposes only its original three admission hooks", async () => {
  const manifest = JSON.parse(await readFile(path.join(pluginDirectory, "hooks/hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.hooks).sort(), ["PreToolUse", "SessionEnd", "SessionStart"]);
  const runtime = await readFile(new URL("../host-runtime/scripts/trelio-runtime-session.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(runtime, /runUnfiledQueueHook|last_assistant_message|UserPromptSubmit/u);
});

test("production reader uses one authenticated company route and copies no protected fields", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/agent-workspaces/unfiled-queue?companySlug=synthetic");
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    response.end(JSON.stringify({ ...queue(1), title: "PRIVATE_CANARY" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const runtime = await import("../host-runtime/scripts/trelio-workspace.mjs");
    const context = await readUnfiledResponseContext(origin, "synthetic", {
      bridge: { ...runtime, readExistingBridgeSessionToken: async () => "fixture-token" },
    });
    assert.deepEqual(context, queue(1).responseContext);
    assert.doesNotMatch(JSON.stringify(context), /PRIVATE_CANARY|title|decision/u);
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test("the real existing status command refreshes the queue without changing pinned rules", async t => {
  if (process.platform === "win32") return t.skip("Native Windows private-state transport is covered by its worker gate");
  const run = promisify(execFile);
  const root = await mkdtemp(path.join(os.tmpdir(), "trelio-unfiled-status-"));
  const directory = path.join(root, "workspace");
  let current = queue(1), queueReads = 0;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    if (request.url === "/api/agent-workspaces/encryption/runtime?companySlug=synthetic") {
      return response.end(JSON.stringify({ suite: "trelio-e2ee-v1", state: "plain",
        company: { id: workspace.id, slug: "synthetic" } }));
    }
    assert.equal(request.url, "/api/agent-workspaces/unfiled-queue?companySlug=synthetic");
    queueReads++; response.end(JSON.stringify(current));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await mkdir(directory, { mode: 0o700 });
    await run("git", ["init", "--quiet"], { cwd: directory });
    const config = path.join(root, ".config", "trelio", "workspace-bridge"); await mkdir(config, { recursive: true, mode: 0o700 });
    await writeFile(path.join(config, "credentials.json"), JSON.stringify({ [origin]: { bridgeSessionToken: "fixture-token" } }), { mode: 0o600 });
    await mkdir(path.join(root, "context"), { mode: 0o700 });
    const pinned = path.join(root, "context", "agent-instructions.md"); await writeFile(pinned, "UNCHANGED_PINNED_RULES");
    const profile = path.join(root, "context", "user-profile.md"); await writeFile(profile, "UNCHANGED_PINNED_PROFILE");
    await writeFile(path.join(root, ".trelio-run.json"), JSON.stringify({ workspaceId: workspace.id,
      runId: "22222222-2222-4222-8222-222222222222", origin, workspaceDirectory: directory,
      company: { id: workspace.id, slug: "synthetic" }, objects: [] }), { mode: 0o600 });
    const status = async () => JSON.parse((await run(process.execPath,
      [fileURLToPath(new URL("../host-runtime/scripts/trelio-workspace.mjs", import.meta.url)), "status"], {
        cwd: directory, timeout: 12000, env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: root,
          TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1" },
      })).stdout);
    assert.deepEqual((await status()).unfiledQueue, current.responseContext);
    current = queue(0);
    const empty = await status();
    assert.deepEqual(empty.unfiledQueue, { companySlug: "synthetic", count: 0 });
    assert.equal(empty.dirty, false);
    assert.equal(queueReads, 2);
    assert.equal(await readFile(pinned, "utf8"), "UNCHANGED_PINNED_RULES");
    assert.equal(await readFile(profile, "utf8"), "UNCHANGED_PINNED_PROFILE");
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});


test("shared backend delivery policy excludes poll/proposal DTOs and retains exact entry reads", () => {
  for (const name of ["get_task_changes", "get_task_status_proposal_context", "get_task_comment_proposal_context", "render_task_proposals", "get_registry", "create_comment"]) {
    assert.equal(MCP_UNFILED_CONTEXT_RESPONSE_TOOLS.has(name), false, name);
  }
  for (const name of ["get_task", "get_tasks", "get_task_instruction_page", "get_agent_instructions", "get_workspace", "get_agent_workspace", "fetch", "list_workspaces"]) {
    assert.equal(MCP_UNFILED_CONTEXT_RESPONSE_TOOLS.has(name), true, name);
  }
});
