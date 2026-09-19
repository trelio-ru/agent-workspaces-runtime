import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  formatBridgeCommandError,
  resolveRegisteredWorkspaceRootDirectory,
  resolveWorkspaceBridgeConfigDirectory,
} from "../host-runtime/scripts/trelio-workspace.mjs";
import {
  WorkspaceActiveRunRequiredError,
  WorkspaceDirectoryRequiredError,
  WorkspaceLayoutMigrationBlockedError,
  WorkspaceLocalRecoveryRequiredError,
  WorkspaceRunReclaimRequiredError,
  WORKSPACE_ACTIVE_RUN_REQUIRED,
  WORKSPACE_DIRECTORY_REQUIRED,
  WORKSPACE_LAYOUT_MIGRATION_BLOCKED,
  WORKSPACE_LOCAL_RECOVERY_REQUIRED,
  WORKSPACE_RUN_RECLAIM_REQUIRED,
  parseWorkspaceActiveRunRequiredError,
  parseWorkspaceDirectoryRequiredError,
  parseWorkspaceLayoutMigrationBlockedError,
  parseWorkspaceLocalRecoveryRequiredError,
  parseWorkspaceRunReclaimRequiredError,
} from "../host-runtime/scripts/trelio-workspace-directory.mjs";
import {
  buildTrelioWorkspaceActionInvocation,
  handleTrelioWorkspaceActionOperation,
} from "../host-runtime/scripts/trelio-local-context.mjs";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const firstRun = "22222222-2222-4222-8222-222222222222";
const secondRun = "33333333-3333-4333-8333-333333333333";
const newRun = "44444444-4444-4444-8444-444444444444";
const origin = "https://example.test";
const testAgentRulesMarkdown = "# Platform rules\n\nUse exact typed actions.\n";
const testAgentRulesSha256 = createHash("sha256")
  .update(testAgentRulesMarkdown, "utf8")
  .digest("hex");

// The v3 bridge refuses to start without a verified platform-rules snapshot.
// Keep this fixture faithful to the current handshake so directory-recovery
// tests cannot accidentally exercise a removed pre-rules client contract.
const buildTestBridgeCompatibility = (request) => {
  const rulesAreCurrent = (
    request.headers["x-trelio-agent-rules-sha256"] === testAgentRulesSha256
  );
  return {
    supported: true,
    minimumVersion: "3.0.0",
    agentRules: {
      status: rulesAreCurrent ? "current" : "update_required",
      revisionId: "10000000-0000-4000-8000-000000000001",
      version: 1,
      sha256: testAgentRulesSha256,
      ...(rulesAreCurrent ? {} : { rulesMarkdown: testAgentRulesMarkdown }),
    },
  };
};

const fixture = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-directory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roots = [];
  const add = async (name, runId, overrides = {}) => {
    const directory = path.join(root, name);
    await fs.mkdir(path.join(directory, "workspace", "artifacts"), { recursive: true });
    await fs.writeFile(path.join(directory, ".trelio-run.json"), JSON.stringify({
      workspaceId, runId, origin, workspaceDirectory: path.join(directory, "workspace"),
      privateMetadata: "synthetic-private-metadata-must-not-be-returned",
      ...overrides,
    }));
    roots.push(directory);
    return directory;
  };
  const first = await add("first root", firstRun);
  const second = await add("second root", secondRun);
  const resolve = (overrides = {}) => resolveRegisteredWorkspaceRootDirectory({
    workspaceId, origin, runId: newRun, startDirectory: root, ...overrides,
  }, { readRegistry: async () => roots });
  return { root, roots, first, second, add, resolve };
};

test("directory recovery keeps ambiguity without choosing a root or exposing private metadata", async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.first, ".trelio-run.json"), "utf8");
  await assert.rejects(f.resolve(), (error) => {
    assert.equal(error.code, WORKSPACE_DIRECTORY_REQUIRED);
    assert.deepEqual(error.details, {
      workspaceId, requiredAction: "select_directory", parameter: "parameters.directory",
      candidates: [
        { directory: f.first, runId: firstRun },
        { directory: f.second, runId: secondRun },
      ],
      omittedCandidateCount: 0,
    });
    assert.equal(JSON.stringify(error).includes("synthetic-private"), false);
    return true;
  });
  assert.equal(await fs.readFile(path.join(f.first, ".trelio-run.json"), "utf8"), before);
});

test("directory recovery prefers exact Run over another root's cwd and preserves legacy single-root reuse", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.resolve({ runId: firstRun, startDirectory: f.second }), f.first);
  f.roots.splice(1);
  assert.equal(await f.resolve(), f.first);
});

test("directory recovery selects only a unique containing root, never an onboarding folder or path prefix", async (t) => {
  const f = await fixture(t);
  for (const startDirectory of [f.second, path.join(f.second, "workspace", "artifacts")]) {
    assert.equal(await f.resolve({ startDirectory }), f.second);
  }
  const sibling = `${f.second}-other`;
  await fs.mkdir(sibling);
  await assert.rejects(f.resolve({ startDirectory: sibling }), { code: WORKSPACE_DIRECTORY_REQUIRED });
  await assert.rejects(f.resolve({ startDirectory: f.root }), { code: WORKSPACE_DIRECTORY_REQUIRED });
  await assert.rejects(f.resolve({ startDirectory: path.join(f.root, "missing") }), { code: WORKSPACE_DIRECTORY_REQUIRED });
});

test("directory recovery selects the canonical root of an exact managed working-folder binding", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "AGENTS.md"), [
    "<!-- trelio-agent-workspaces:start -->",
    "## Trelio",
    "",
    "Папка привязана к тестовой компании.",
    "<!-- trelio-agent-workspaces:end -->",
    "",
  ].join("\n"));
  const canonical = await f.add(path.join("workspaces", workspaceId), newRun);

  assert.equal(
    await f.resolve({ runId: null, startDirectory: f.root }),
    canonical,
    "a new Run should not need one failed open to discover its canonical managed root",
  );
  assert.equal(
    await f.resolve({ runId: firstRun, startDirectory: f.root }),
    f.first,
    "an exact existing Run remains stronger than the canonical new-Run root",
  );
});

test("directory recovery preserves duplicate-Run and nested-root ambiguity", async (t) => {
  const f = await fixture(t);
  const duplicate = await f.add("same run", firstRun);
  await assert.rejects(f.resolve({ runId: firstRun }), { code: WORKSPACE_DIRECTORY_REQUIRED });
  assert.equal(await f.resolve({ runId: firstRun, startDirectory: duplicate }), duplicate);
  const nested = await f.add(path.join("second root", "nested"), newRun);
  await assert.rejects(f.resolve({ runId: null, startDirectory: nested }), { code: WORKSPACE_DIRECTORY_REQUIRED });
});

test("directory recovery ignores missing, corrupt, wrong-scope and invalid-Run registry entries", async (t) => {
  const f = await fixture(t);
  f.roots.splice(1);
  f.roots.push(f.first, path.join(f.root, "missing"));
  const corrupt = await f.add("corrupt", newRun);
  await fs.writeFile(path.join(corrupt, ".trelio-run.json"), "{");
  await f.add("wrong workspace", newRun, { workspaceId: secondRun });
  await f.add("wrong origin", newRun, { origin: "https://other.test" });
  await f.add("wrong path", newRun, { workspaceDirectory: f.first });
  await f.add("invalid run", "invalid");
  assert.equal(await f.resolve(), f.first);
});

test("directory recovery resolves filesystem aliases without following a symlink registry root", {
  skip: process.platform === "win32" ? "Creating symlinks requires separate Windows privileges" : false,
}, async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root, "alias");
  await fs.symlink(f.second, alias);
  assert.equal(await f.resolve({ startDirectory: path.join(alias, "workspace") }), f.second);
  f.roots.push(alias);
  assert.equal(await f.resolve({ runId: secondRun }), f.second);
});

test("directory recovery serializes a bounded exact envelope for CLI and MCP", () => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    directory: path.resolve(os.tmpdir(), `candidate ${index}`), runId: firstRun,
  }));
  const error = new WorkspaceDirectoryRequiredError(workspaceId, candidates);
  assert.equal(error.details.candidates.length, 10);
  assert.equal(error.details.omittedCandidateCount, 20);
  const stderr = `Ошибка: ${formatBridgeCommandError(error, "open")}\n`;
  assert.deepEqual(parseWorkspaceDirectoryRequiredError(stderr, workspaceId)?.toJSON(), error.toJSON());
  assert.equal(parseWorkspaceDirectoryRequiredError(stderr, secondRun), null);
  assert.equal(parseWorkspaceDirectoryRequiredError("unrelated child error", workspaceId), null);
  for (const mutate of [
    (payload) => { payload.code = "UNRELATED"; },
    (payload) => { payload.details.parameter = "parameters.dir"; },
    (payload) => { payload.details.candidates[0].directory = "relative"; },
    (payload) => { payload.details.candidates[0] = null; },
    (payload) => { payload.details.omittedCandidateCount = -1; },
  ]) {
    const payload = error.toJSON();
    const copy = structuredClone(payload);
    mutate(copy);
    assert.equal(parseWorkspaceDirectoryRequiredError(`Ошибка: ${JSON.stringify(copy)}`, workspaceId), null);
  }
});

test("local change recovery preserves bounded source evidence and an exact safe next root", async () => {
  const sourceDirectory = path.resolve(os.tmpdir(), "source terminal run");
  const suggestedDirectory = path.resolve(os.tmpdir(), "target recovery run");
  const changes = Array.from({ length: 250 }, (_, index) => `?? artifacts/file-${index}.md`);
  const error = new WorkspaceLocalRecoveryRequiredError({
    workspaceId,
    sourceRunId: firstRun,
    targetRunId: newRun,
    sourceRunStatus: "accepted",
    sourceDirectory,
    sourceWorkspaceDirectory: path.join(sourceDirectory, "workspace"),
    suggestedDirectory,
    lastSavedDraftHead: "a".repeat(40),
    changes,
  });
  assert.equal(error.details.changes.length, 200);
  assert.equal(error.details.omittedChangeCount, 50);
  assert.equal(JSON.stringify(error).includes("privateMetadata"), false);
  const stderr = `Ошибка: ${formatBridgeCommandError(error, "open")}\n`;
  assert.deepEqual(
    parseWorkspaceLocalRecoveryRequiredError(stderr, workspaceId, newRun)?.toJSON(),
    error.toJSON(),
  );
  assert.equal(parseWorkspaceLocalRecoveryRequiredError(stderr, workspaceId, secondRun), null);

  let calls = 0;
  await assert.rejects(handleTrelioWorkspaceActionOperation(origin, {
    schemaVersion: 1,
    operation: "open",
    parameters: { workspaceId, runId: ` ${newRun} ` },
  }, {
    runBridge: async () => {
      calls += 1;
      throw Object.assign(new Error("child failed"), { stderr });
    },
  }), (actual) => {
    assert.equal(actual.code, WORKSPACE_LOCAL_RECOVERY_REQUIRED);
    assert.deepEqual(actual.details, error.details);
    assert.equal(Object.hasOwn(actual.details, "stderr"), false);
    return true;
  });
  assert.equal(calls, 1, "recovery must not move files or retry open automatically");
});

test("legacy layout blockers preserve the exact root and bounded entries for the agent", async () => {
  const rootDirectory = path.resolve(os.tmpdir(), "legacy workspace root");
  const blockingEntries = Array.from({ length: 25 }, (_, index) => ({
    name: index === 0 ? ".DS_Store" : `unexpected-${index}.txt`,
    entryType: index === 0 ? "directory" : "file",
    reasonCode: index === 0
      ? "SYSTEM_METADATA_NOT_REGULAR_FILE"
      : "UNRECOGNIZED_ENTRY",
  }));
  const error = new WorkspaceLayoutMigrationBlockedError({
    workspaceId,
    rootDirectory,
    blockingEntries,
  });
  assert.equal(error.details.blockingEntries.length, 20);
  assert.equal(error.details.omittedBlockingEntryCount, 5);
  assert.equal(error.details.automaticChangesPerformed, false);
  const stderr = `Ошибка: ${formatBridgeCommandError(error, "open")}\n`;
  assert.deepEqual(
    parseWorkspaceLayoutMigrationBlockedError(stderr, workspaceId)?.toJSON(),
    error.toJSON(),
  );

  let calls = 0;
  await assert.rejects(handleTrelioWorkspaceActionOperation(origin, {
    schemaVersion: 1,
    operation: "open",
    parameters: { workspaceId, runId: newRun },
  }, {
    runBridge: async () => {
      calls += 1;
      throw Object.assign(new Error("child failed"), { stderr });
    },
  }), (actual) => {
    assert.equal(actual.code, WORKSPACE_LAYOUT_MIGRATION_BLOCKED);
    assert.deepEqual(actual.details, error.details);
    assert.equal(Object.hasOwn(actual.details, "stderr"), false);
    return true;
  });
  assert.equal(calls, 1, "a blocked migration must not retry or mutate the local root");

  for (const mutate of [
    (payload) => { payload.details.rootDirectory = "relative"; },
    (payload) => { payload.details.automaticChangesPerformed = true; },
    (payload) => { payload.details.blockingEntries[0].name = "nested/file"; },
    (payload) => { payload.details.blockingEntries[0].reasonCode = "UNKNOWN"; },
    (payload) => { payload.details.omittedBlockingEntryCount = -1; },
  ]) {
    const copy = structuredClone(error.toJSON());
    mutate(copy);
    assert.equal(
      parseWorkspaceLayoutMigrationBlockedError(
        `Ошибка: ${JSON.stringify(copy)}`,
        workspaceId,
      ),
      null,
    );
  }
});

test("expired local Run recovery preserves the exact existing Run without retrying target open", async () => {
  const error = new WorkspaceRunReclaimRequiredError({
    workspaceId,
    sourceRunId: firstRun,
    targetRunId: newRun,
  });
  const stderr = `Ошибка: ${formatBridgeCommandError(error, "open")}\n`;
  const parsed = parseWorkspaceRunReclaimRequiredError(stderr, workspaceId, newRun);
  assert.equal(parsed?.code, WORKSPACE_RUN_RECLAIM_REQUIRED);
  assert.deepEqual(parsed?.details, {
    requiredAction: "prepare_and_open_existing_run",
    workspaceId,
    runId: firstRun,
    targetRunId: newRun,
    operation: "open",
    reasonCode: "LOCAL_EXPIRED_RUN_REQUIRES_REVIEW",
  });
  assert.equal(parseWorkspaceRunReclaimRequiredError(stderr, workspaceId, secondRun), null);

  let calls = 0;
  await assert.rejects(handleTrelioWorkspaceActionOperation(origin, {
    schemaVersion: 1,
    operation: "open",
    parameters: { workspaceId, runId: newRun },
  }, {
    runBridge: async () => {
      calls += 1;
      throw Object.assign(new Error("child failed"), { stderr });
    },
  }), (actual) => {
    assert.equal(actual.code, WORKSPACE_RUN_RECLAIM_REQUIRED);
    assert.deepEqual(actual.details, parsed.details);
    return true;
  });
  assert.equal(calls, 1, "target open must stop until the exact expired Run is prepared");
});

test("active Run recovery is semantic, bounded and distinct from layout migration", () => {
  const error = new WorkspaceActiveRunRequiredError("READ_ONLY_INSPECTION");
  const stderr = `Ошибка: ${formatBridgeCommandError(error, "secret")}\n`;
  const parsed = parseWorkspaceActiveRunRequiredError(stderr, "secret_exec");
  assert.equal(parsed?.code, WORKSPACE_ACTIVE_RUN_REQUIRED);
  assert.deepEqual(parsed?.details, {
    requiredAction: "prepare_and_open_workspace_run",
    reasonCode: "READ_ONLY_INSPECTION",
    automaticChangesPerformed: false,
    operation: "secret_exec",
  });
  assert.equal(Object.hasOwn(parsed.details, "rootDirectory"), false);
  assert.equal(parseWorkspaceActiveRunRequiredError(stderr, ""), null);

  for (const mutate of [
    (payload) => { payload.code = WORKSPACE_LAYOUT_MIGRATION_BLOCKED; },
    (payload) => { payload.details.reasonCode = "UNRECOGNIZED_ENTRY"; },
    (payload) => { payload.details.automaticChangesPerformed = true; },
  ]) {
    const copy = error.toJSON();
    mutate(copy);
    assert.equal(
      parseWorkspaceActiveRunRequiredError(`Ошибка: ${JSON.stringify(copy)}`, "secret_exec"),
      null,
    );
  }
});

test("MCP preserves directory recovery once and accepts its exact directory field", async (t) => {
  const f = await fixture(t);
  const error = await f.resolve().catch((value) => value);
  let calls = 0;
  const input = { schemaVersion: 1, operation: "open", parameters: { workspaceId: ` ${workspaceId} `, runId: newRun } };
  await assert.rejects(handleTrelioWorkspaceActionOperation(origin, input, {
    runBridge: async () => {
      calls += 1;
      throw Object.assign(new Error("child failed"), {
        stderr: `Ошибка: ${formatBridgeCommandError(error, "open")}\n`,
      });
    },
  }), (actual) => {
    assert.equal(actual.code, WORKSPACE_DIRECTORY_REQUIRED);
    assert.deepEqual(actual.details, error.details);
    assert.equal(Object.hasOwn(actual.details, "stderr"), false);
    return true;
  });
  assert.equal(calls, 1, "failure must never start an automatic mutation retry");
  const directory = error.details.candidates[0].directory;
  const invocation = buildTrelioWorkspaceActionInvocation({
    ...input, parameters: { ...input.parameters, directory },
  });
  assert.deepEqual(invocation.argumentsList.slice(-2), ["--dir", directory]);
  assert.throws(() => buildTrelioWorkspaceActionInvocation({
    ...input, parameters: { ...input.parameters, dir: directory },
  }), (actual) => actual.code === "TRELIO_WORKSPACE_ACTION_INVALID_INPUT"
    && actual.message.includes("parameters.directory"));
});

test("real bridge reports ambiguity before claim and cwd selection still rejects an unfinished Run", {
  timeout: 60_000,
}, async (t) => {
  const f = await fixture(t);
  const requests = [];
  const company = { id: workspaceId, slug: "synthetic-company" };
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/agent-workspaces/bridge-compatibility") {
      response.end(JSON.stringify(buildTestBridgeCompatibility(request)));
    } else if (request.url.startsWith("/api/agent-workspaces/bridge-routing?")) {
      response.end(JSON.stringify({
        schemaVersion: 1,
        company,
        encryptionState: "plain",
      }));
    } else if (request.url === `/api/agent-workspaces/workspaces/${workspaceId}`) {
      response.end(JSON.stringify({
        company, workspace: { id: workspaceId, acceptedHead: "a".repeat(40) },
        runs: [{ id: firstRun, status: "running" }, { id: secondRun, status: "running" }],
      }));
    } else if (request.url.startsWith("/api/agent-workspaces/encryption/runtime?")) {
      response.end(JSON.stringify({ suite: "trelio-e2ee-v1", state: "plain", company }));
    } else {
      response.statusCode = 500;
      response.end(JSON.stringify({ message: "Unexpected test request" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const testOrigin = `http://127.0.0.1:${server.address().port}`;
  const homeDirectory = path.join(f.root, "home");
  const environment = {
    ...process.env, HOME: homeDirectory, USERPROFILE: homeDirectory,
    LOCALAPPDATA: path.join(homeDirectory, "AppData", "Local"),
  };
  const config = resolveWorkspaceBridgeConfigDirectory({ environment, homeDirectory });
  await fs.mkdir(config, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(config, "credentials.json"),
    JSON.stringify({ [testOrigin]: { accessToken: "synthetic-directory-test-token" } }), { mode: 0o600 });
  await fs.writeFile(path.join(config, "runs.json"), JSON.stringify({ schemaVersion: 1, roots: f.roots }));
  for (const directory of f.roots) {
    const metadataPath = path.join(directory, ".trelio-run.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    metadata.origin = testOrigin;
    await fs.writeFile(metadataPath, JSON.stringify(metadata));
    // preflight проверяет filesystem identity до server terminal state;
    // полноценный Git не нужен: активный прежний Run должен остановить путь раньше.
    await fs.mkdir(path.join(directory, "workspace", ".git"));
    await fs.writeFile(path.join(directory, "workspace", "draft.txt"), "keep local draft");
  }
  const bridge = fileURLToPath(new URL("../host-runtime/scripts/trelio-workspace.mjs", import.meta.url));
  const run = (cwd, directory) => handleTrelioWorkspaceActionOperation(testOrigin, {
    schemaVersion: 1, operation: "open",
    parameters: { workspaceId, runId: newRun, ...(directory ? { directory } : {}) },
    workingDirectory: cwd,
  }, {
    runBridge: (requestOrigin, args, options) => promisify(execFile)(process.execPath,
      [bridge, ...args, "--origin", requestOrigin], {
        ...options, env: environment, encoding: "utf8", timeout: 20_000,
      }),
  });
  await assert.rejects(run(f.root), { code: WORKSPACE_DIRECTORY_REQUIRED });
  assert.deepEqual(requests.map(({ url }) => url), [
    "/api/agent-workspaces/bridge-compatibility",
    "/api/agent-workspaces/bridge-compatibility",
    `/api/agent-workspaces/bridge-routing?workspaceId=${workspaceId}`,
  ]);
  for (const invoke of [() => run(path.join(f.second, "workspace")), () => run(f.root, f.second)]) {
    await assert.rejects(invoke(), (error) => error.code === "TRELIO_WORKSPACE_ACTION_FAILED"
      && /незавершённый Agent Run/u.test(error.message));
  }
  assert.ok(requests.every(({ method }) => method === "GET"), "selection must not claim or start a Run");
  for (const directory of f.roots) {
    assert.equal(await fs.readFile(path.join(directory, "workspace", "draft.txt"), "utf8"), "keep local draft");
  }
});
