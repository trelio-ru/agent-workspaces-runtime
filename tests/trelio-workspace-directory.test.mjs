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
import { handleToolCall } from "../host-runtime/scripts/trelio-remote-mcp.mjs";
import {
  formatBridgeCommandError,
  resolveRegisteredWorkspaceRootDirectory,
  resolveWorkspaceBridgeConfigDirectory,
  runGit as runBridgeGit,
  mergeWorkspaceSnapshots,
} from "../host-runtime/scripts/trelio-workspace.mjs";
import {
  WorkspaceActiveRunRequiredError,
  WorkspaceDraftRecoveryRequiredError,
  WorkspaceDirectoryRequiredError,
  WorkspaceLayoutMigrationBlockedError,
  WorkspaceLocalRecoveryRequiredError,
  WorkspaceRunReclaimRequiredError,
  WORKSPACE_ACTIVE_RUN_REQUIRED,
  WORKSPACE_DRAFT_RECOVERY_REQUIRED,
  WORKSPACE_DIRECTORY_REQUIRED,
  WORKSPACE_LAYOUT_MIGRATION_BLOCKED,
  WORKSPACE_LOCAL_RECOVERY_REQUIRED,
  WORKSPACE_RUN_RECLAIM_REQUIRED,
  parseWorkspaceActiveRunRequiredError,
  parseWorkspaceDraftRecoveryRequiredError,
  parseWorkspaceDirectoryRequiredError,
  parseWorkspaceLayoutMigrationBlockedError,
  parseWorkspaceLocalRecoveryRequiredError,
  parseWorkspaceRunReclaimRequiredError,
  workspaceRecoveryDirectory,
  isWorkspaceRecoveryDirectory,
  workspaceParallelDirectory,
  WorkspaceMergeRequiredError,
  parseWorkspaceMergeError,
} from "../host-runtime/scripts/trelio-workspace-directory.mjs";
import {
  TRELIO_WORKSPACE_ACTION_TOOL,
  buildTrelioWorkspaceActionInvocation,
  handleTrelioWorkspaceActionOperation,
} from "../host-runtime/scripts/trelio-local-context.mjs";

const workspaceId = "11111111-1111-4111-8111-111111111111";

test("parallel branches have stable independent locators and a closed merge continuation", () => {
  const source = path.resolve(os.tmpdir(), "parallel", workspaceId);
  const runId = "22222222-2222-4222-8222-222222222222";
  const parallel = workspaceParallelDirectory(source, workspaceId, runId);
  assert.equal(workspaceParallelDirectory(parallel, workspaceId, runId), parallel);
  assert.equal(path.basename(parallel).length, 45);
  assert.notEqual(parallel, workspaceRecoveryDirectory(source, workspaceId, runId));
  const error = new WorkspaceMergeRequiredError({ workspaceId, sourceRunId: runId,
    sourceHead: "a".repeat(40), baseHead: "b".repeat(40), acceptedHead: "c".repeat(40) });
  const parsed = parseWorkspaceMergeError("Ошибка: " + JSON.stringify(error));
  assert.equal(parsed.details.nextCall.tool, "prepare_agent_workspace_run");
  assert.equal(parsed.details.nextCall.arguments.startNewRun, true);
  const tampered = JSON.parse(JSON.stringify(error));
  tampered.details.nextCall = { tool: "arbitrary_mutation" };
  assert.equal(parseWorkspaceMergeError(JSON.stringify(tampered)).details.nextCall.tool, "prepare_agent_workspace_run");
  tampered.details.sourceHead = "unknown";
  assert.equal(parseWorkspaceMergeError(JSON.stringify(tampered)), null);
  const invocation = buildTrelioWorkspaceActionInvocation({ schemaVersion: 1, operation: "merge",
    runIdentity: { workspaceId, runId }, parameters: { sourceRunId: workspaceId, sourceHead: "a".repeat(40) } });
  assert.deepEqual(invocation.argumentsList, ["merge", "--source-run", workspaceId, "--source-head", "a".repeat(40)]);
});

const mergeFixture = async (t, { base, ours, theirs }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-three-way-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const initial = path.join(root, "initial");
  await fs.mkdir(initial);
  const git = (cwd, args) => runBridgeGit(args, { cwd });
  await git(initial, ["init", "--initial-branch=trelio-candidate"]);
  await git(initial, ["config", "user.name", "Synthetic"]);
  await git(initial, ["config", "user.email", "test@trelio.invalid"]);
  const write = async (directory, files) => {
    for (const [name, bytes] of Object.entries(files)) {
      const target = path.join(directory, name);
      if (bytes === null) { await fs.unlink(target); continue; }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    }
    await git(directory, ["add", "--all"]);
    await git(directory, ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Synthetic branch"]);
    return (await git(directory, ["rev-parse", "HEAD"])).stdout.trim();
  };
  const baseHead = await write(initial, { "WORKSPACE_CONTEXT.md": "# Synthetic context\n", ...base });
  const metadata = [];
  for (const [name, files] of [["source", theirs], ["target", ours]]) {
    const directory = path.join(root, name, "workspace");
    await fs.mkdir(path.dirname(directory));
    await git(root, ["clone", "--no-hardlinks", initial, directory]);
    await git(directory, ["config", "user.name", "Synthetic"]);
    await git(directory, ["config", "user.email", "test@trelio.invalid"]);
    const head = await write(directory, files);
    metadata.push({ workspaceDirectory: directory, baseHead: name === "source" ? baseHead : head,
      draftHead: head, objects: [] });
  }
  return { source: metadata[0], target: metadata[1] };
};

test("three-way merge preserves both branches, literal paths, deletions and disjoint text edits", async t => {
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const fixture = await mergeFixture(t, { base: { "shared.md": lines, "delete.md": "old\n" },
    ours: { "shared.md": lines.replace("line 10", "accepted line 10"), "accepted.md": "accepted\n" },
    theirs: { "shared.md": lines.replace("line 1\n", "source line 1\n"), "delete.md": null, "[new] файл.md": "source\n" } });
  const sourceBefore = await runBridgeGit(["status", "--porcelain"], { cwd: fixture.source.workspaceDirectory });
  const result = await mergeWorkspaceSnapshots(fixture);
  assert.deepEqual(result.conflicts, []);
  assert.equal(await fs.readFile(path.join(fixture.target.workspaceDirectory, "shared.md"), "utf8"),
    lines.replace("line 10", "accepted line 10").replace("line 1\n", "source line 1\n"));
  assert.equal(await fs.readFile(path.join(fixture.target.workspaceDirectory, "accepted.md"), "utf8"), "accepted\n");
  assert.equal(await fs.readFile(path.join(fixture.target.workspaceDirectory, "[new] файл.md"), "utf8"), "source\n");
  await assert.rejects(fs.stat(path.join(fixture.target.workspaceDirectory, "delete.md")), { code: "ENOENT" });
  assert.equal((await runBridgeGit(["status", "--porcelain"], { cwd: fixture.source.workspaceDirectory })).stdout, sourceBefore.stdout);
  assert.equal((await runBridgeGit(["rev-parse", "HEAD"], { cwd: fixture.target.workspaceDirectory })).stdout.trim(), fixture.target.baseHead);
});

test("real content conflicts preserve complete source and target without honoring merge=union", async t => {
  const fixture = await mergeFixture(t, { base: { "shared.md": "base\n", ".gitattributes": "* merge=union\n" },
    ours: { "shared.md": "accepted\n" }, theirs: { "shared.md": "source\n", "other.md": "source addition\n" } });
  const result = await mergeWorkspaceSnapshots(fixture);
  assert.deepEqual(result.conflicts, ["shared.md"]);
  assert.equal(await fs.readFile(path.join(fixture.target.workspaceDirectory, "shared.md"), "utf8"), "accepted\n");
  assert.equal(await fs.readFile(path.join(fixture.source.workspaceDirectory, "shared.md"), "utf8"), "source\n");
  await assert.rejects(fs.stat(path.join(fixture.target.workspaceDirectory, "other.md")), { code: "ENOENT" });
});

test("merge refuses dirty targets and conflicting binary edits", async t => {
  const fixture = await mergeFixture(t, { base: { "data.bin": Buffer.from([0, 1, 2]) },
    ours: { "data.bin": Buffer.from([0, 3, 2]) }, theirs: { "data.bin": Buffer.from([0, 1, 4]) } });
  assert.deepEqual((await mergeWorkspaceSnapshots(fixture)).conflicts, ["data.bin"]);
  await fs.writeFile(path.join(fixture.target.workspaceDirectory, "unsaved.md"), "preserve\n");
  await assert.rejects(mergeWorkspaceSnapshots(fixture), /changed during merge/u);
  assert.equal(await fs.readFile(path.join(fixture.target.workspaceDirectory, "unsaved.md"), "utf8"), "preserve\n");
});

test("late merge admission refusal preserves the target and external object pointers stay atomic", async t => {
  const fixture = await mergeFixture(t, { base: { "result.md": "base\n" },
    ours: { "accepted.md": "accepted\n" }, theirs: { "result.md": "source\n" } });
  await assert.rejects(mergeWorkspaceSnapshots({ ...fixture, beforeApply: async () => { throw new Error("Synthetic revoked fence"); } }), /revoked fence/u);
  assert.equal(await fs.readFile(path.join(fixture.target.workspaceDirectory, "result.md"), "utf8"), "base\n");
  const bytes = [Buffer.from([0, 1, 2]), Buffer.from([0, 3, 2]), Buffer.from([0, 1, 4])];
  const objects = bytes.map(value => ({ filePath: "object.bin", sha256: createHash("sha256").update(value).digest("hex"),
    sizeBytes: value.length, contentType: "application/octet-stream" }));
  const pointer = object => `version https://trelio.ru/spec/workspace-object/v1\noid sha256:${object.sha256}\nsize ${object.sizeBytes}\ncontent-type ${object.contentType}\n`;
  const pointers = await mergeFixture(t, { base: { "object.bin": pointer(objects[0]) },
    ours: { "object.bin": pointer(objects[1]) }, theirs: { "object.bin": pointer(objects[2]) } });
  for (const [row, index] of [[pointers.source, 2], [pointers.target, 1]]) {
    row.objects = [objects[index]];
    await fs.writeFile(path.join(row.workspaceDirectory, "object.bin"), bytes[index]);
    await runBridgeGit(["update-index", "--skip-worktree", "object.bin"], { cwd: row.workspaceDirectory });
  }
  assert.deepEqual((await mergeWorkspaceSnapshots(pointers)).conflicts, ["object.bin"]);
});

test("native merge command rechecks the target fence and checkpoints the combined draft through real pipes", { timeout: 30_000 }, async t => {
  const f = await mergeFixture(t, { base: { "result.md": "base\n" },
    ours: { "accepted.md": "accepted\n" }, theirs: { "result.md": "source\n" } });
  const sourceRunId = "22222222-2222-4222-8222-222222222222";
  const targetRunId = "33333333-3333-4333-8333-333333333333";
  const memberId = "44444444-4444-4444-8444-444444444444";
  const company = { id: workspaceId, slug: "synthetic-merge" };
  let targetReads = 0, revoke = true, savedHead = null, checkpoints = 0;
  let serverError = null;
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/agent-workspaces/bridge-compatibility") return response.end(JSON.stringify(buildTestBridgeCompatibility(request)));
      if (request.url.startsWith("/api/agent-workspaces/bridge-routing?")) return response.end(JSON.stringify({ schemaVersion: 1, company, encryptionState: "plain" }));
      if (request.url.startsWith("/api/agent-workspaces/encryption/runtime?")) return response.end(JSON.stringify({ suite: "trelio-e2ee-v1", state: "plain", company }));
      if (request.url.endsWith("/heartbeat")) return response.end(JSON.stringify({ leaseExpiresAt: new Date(Date.now() + 3600_000).toISOString() }));
      const match = request.url.match(/\/workspaces\/[^/]+\/runs\/([^/]+)$/u);
      if (match) {
        const target = match[1] === targetRunId;
        if (target) targetReads++;
        return response.end(JSON.stringify({ run: { id: match[1], workspaceId, status: "running", initiatedByMemberId: memberId,
          baseHead: target ? f.target.baseHead : f.source.baseHead, draftHead: target ? savedHead : f.source.draftHead,
          leaseId: targetRunId, fencingToken: target && revoke && targetReads > 1 ? 2 : 1,
          leaseExpiresAt: new Date(Date.now() + 3600_000).toISOString() }, latestCheckpoint: null }));
      }
      if (request.url.endsWith("/draft")) {
        assert.ok(bytes.length > 0);
        savedHead = (await runBridgeGit(["rev-parse", "HEAD"], { cwd: f.target.workspaceDirectory })).stdout.trim();
        return response.end(JSON.stringify({ run: { draftHead: savedHead }, draft: { head: savedHead } }));
      }
      if (request.url.endsWith("/checkpoints")) {
        assert.equal(JSON.parse(bytes).checkpointType, "draft"); checkpoints++;
        return response.end(JSON.stringify({ id: memberId, createdAt: new Date().toISOString() }));
      }
      response.statusCode = 404; response.end();
    } catch (error) { serverError = error; response.statusCode = 500; response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const home = path.join(path.dirname(path.dirname(f.source.workspaceDirectory)), "home");
  const environment = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData", "Local"),
    TRELIO_CONFIG_HOME: path.join(home, "trelio"), TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1" };
  const config = resolveWorkspaceBridgeConfigDirectory({ environment, homeDirectory: home });
  await fs.mkdir(config, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(config, "credentials.json"), JSON.stringify({ [origin]: { accessToken: "synthetic-merge-token" } }), { mode: 0o600 });
  const metadata = (row, runId) => ({ ...row, schemaVersion: 3, origin, company, workspaceId, runId,
    leaseId: targetRunId, fencingToken: 1, scopeType: "project", contexts: [], contextHeads: {} });
  await fs.writeFile(path.join(path.dirname(f.source.workspaceDirectory), ".trelio-run.json"), JSON.stringify(metadata(f.source, sourceRunId)));
  await fs.writeFile(path.join(path.dirname(f.target.workspaceDirectory), ".trelio-run.json"), JSON.stringify(metadata(f.target, targetRunId)));
  await fs.writeFile(path.join(config, "runs.json"), JSON.stringify({ schemaVersion: 1,
    roots: [path.dirname(f.source.workspaceDirectory), path.dirname(f.target.workspaceDirectory)] }));
  const bridge = fileURLToPath(new URL("../host-runtime/scripts/trelio-workspace.mjs", import.meta.url));
  const invoke = () => promisify(execFile)(process.execPath, [bridge, "merge", "--origin", origin,
    "--source-run", sourceRunId, "--source-head", f.source.draftHead], {
    cwd: f.target.workspaceDirectory, env: environment, encoding: "utf8", timeout: 10_000 });
  await assert.rejects(invoke(), /lost its active lease or fence/u);
  assert.equal(checkpoints, 0);
  assert.equal(await fs.readFile(path.join(f.target.workspaceDirectory, "result.md"), "utf8"), "base\n");
  revoke = false; targetReads = 0;
  await invoke();
  assert.equal(checkpoints, 1);
  assert.ok(savedHead);
  assert.equal(await fs.readFile(path.join(f.target.workspaceDirectory, "result.md"), "utf8"), "source\n");
  assert.equal(await fs.readFile(path.join(f.target.workspaceDirectory, "accepted.md"), "utf8"), "accepted\n");
  assert.equal((await runBridgeGit(["status", "--porcelain"], { cwd: f.source.workspaceDirectory })).stdout, "");
  await invoke();
  assert.equal(checkpoints, 1, "reopening the exact merge never overwrites or re-checkpoints its result");
  assert.ifError(serverError);
});

test("recovery retention recognizes exact historical and compact roots without adopting custom names", () => {
  const runId = "22222222-2222-4222-8222-222222222222";
  const parent = path.resolve(os.tmpdir(), "recovery-retention");
  for (const name of [
    workspaceId + "-recovery-22222222",
    workspaceId + "-recovery-22222222-recovery-22222222",
    "recovery-" + runId,
    path.basename(workspaceRecoveryDirectory(path.join(parent, workspaceId), workspaceId, runId)),
    path.basename(workspaceParallelDirectory(path.join(parent, workspaceId), workspaceId, runId)),
  ]) assert.equal(isWorkspaceRecoveryDirectory(path.join(parent, name), workspaceId, runId), true);
  for (const name of [workspaceId, "my-recovery", workspaceId + "-recovery-unknown", "r-short",
    runId + "-recovery-22222222", "recovery-" + workspaceId]) {
    assert.equal(isWorkspaceRecoveryDirectory(path.join(parent, name), workspaceId, runId), false);
  }
  assert.equal(isWorkspaceRecoveryDirectory(parent, "unknown", runId), false);
});

test("repeated recovery keeps a full identity digest and does not accumulate Windows path suffixes", () => {
  const runId = "22222222-2222-4222-8222-222222222222";
  const parent = path.resolve(os.tmpdir(), "owned-task", "workspaces");
  const legacy = path.join(parent, workspaceId + "-recovery-22222222-recovery-22222222");
  const first = workspaceRecoveryDirectory(legacy, workspaceId, runId);
  const second = workspaceRecoveryDirectory(first, workspaceId, runId);
  assert.equal(path.dirname(first), parent);
  assert.equal(path.dirname(second), parent);
  assert.equal(path.basename(first).length, 45);
  assert.equal(path.basename(second).length, 45);
  assert.notEqual(first, second, "a source already opened for recovery is a different immutable source");
  assert.equal(workspaceRecoveryDirectory(legacy, workspaceId, runId), first);
  assert.notEqual(workspaceRecoveryDirectory(legacy, runId, runId), first);
  assert.notEqual(workspaceRecoveryDirectory(legacy, workspaceId, workspaceId), first);
  assert.throws(() => workspaceRecoveryDirectory("relative", workspaceId, runId));
  assert.throws(() => workspaceRecoveryDirectory(legacy, "unknown", runId));
});

test("compact recovery permits real Git metadata reads beside a long retained source", async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-recovery-path-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  // The old nested Windows checkout was 236 characters before .git's own
  // metadata suffix. Do not depend on that Git version emitting a warning:
  // prove the replacement actually works while retaining the original bytes.
  const source = path.join(parent, "s".repeat(Math.max(1, 226 - parent.length - 1)));
  await fs.mkdir(source);await fs.writeFile(path.join(source, "retained.md"), "retained synthetic source\n");
  const recovery = workspaceRecoveryDirectory(source, workspaceId, "22222222-2222-4222-8222-222222222222");
  const checkout = path.join(recovery, "workspace");await fs.mkdir(checkout, { recursive: true });
  await runBridgeGit(["init", "--initial-branch=main"], { cwd: checkout });
  await runBridgeGit(["config", "user.name", "Synthetic"], { cwd: checkout });
  await runBridgeGit(["config", "user.email", "test@trelio.invalid"], { cwd: checkout });
  await fs.writeFile(path.join(checkout, "result.md"), "synthetic replacement\n");
  await runBridgeGit(["add", "result.md"], { cwd: checkout });
  await runBridgeGit(["-c", "commit.gpgsign=false", "commit", "-m", "Synthetic recovery"], { cwd: checkout });
  const head = (await runBridgeGit(["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
  assert.equal((await runBridgeGit(["cat-file", "-e", head + "^{commit}"], { cwd: checkout })).stderr, "");
  assert.equal(await fs.readFile(path.join(source, "retained.md"), "utf8"), "retained synthetic source\n");
});
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

test("generated parallel roots keep custom selection deterministic after the old anchor is cleaned", async t => {
  const f = await fixture(t);
  f.roots.splice(1, 1);
  const thirdRun = "55555555-5555-4555-8555-555555555555";
  const second = await f.add(path.basename(workspaceParallelDirectory(f.first, workspaceId, secondRun)), secondRun);
  const third = await f.add(path.basename(workspaceParallelDirectory(f.first, workspaceId, thirdRun)), thirdRun);
  assert.equal(await f.resolve(), f.first, "only the proven original anchor is reusable");
  f.roots.splice(0, 1);
  assert.equal(await f.resolve(), workspaceParallelDirectory(second, workspaceId, newRun),
    "derive a new independent locator when all remaining roots are proven siblings");
  assert.notEqual(await f.resolve(), second);
  assert.notEqual(await f.resolve(), third);
});

test("directory recovery prefers exact Run over another root's cwd and preserves legacy single-root reuse", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.resolve({ runId: firstRun, startDirectory: f.second }), f.first);
  assert.equal(await f.resolve({ runId: firstRun, exactRunOnly: true }), f.first);
  assert.equal(await f.resolve({ runId: newRun, exactRunOnly: true }), null,
    "an exact recovery lookup must never reuse another Run's registered root");
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

test("Windows resolves a registered Run when metadata spells its directory with different casing", {
  skip: process.platform !== "win32",
}, async (t) => {
  const f = await fixture(t);
  f.roots.splice(1);
  const metadataPath = path.join(f.first, ".trelio-run.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  metadata.workspaceDirectory = metadata.workspaceDirectory.toUpperCase();
  await fs.writeFile(metadataPath, JSON.stringify(metadata));

  assert.equal(await f.resolve({ runId: firstRun }), f.first);
  const operations = [
    { operation: "status", parameters: {} },
    { operation: "checkpoint", parameters: { type: "draft", summary: "Сохранить изменения" } },
    {
      operation: "finish",
      parameters: {
        summary: "Передать подготовленный результат",
        evidence: ["Проверено"],
        nextAction: "Принять результат",
      },
    },
  ];
  for (const { operation, parameters } of operations) {
    let bridgeCwd = null;
    await handleTrelioWorkspaceActionOperation(origin, {
      schemaVersion: 1,
      operation,
      parameters,
      runIdentity: { workspaceId, runId: firstRun },
      workingDirectory: path.join(f.first, "workspace"),
    }, {
      resolveRunRootDirectory: (input) => resolveRegisteredWorkspaceRootDirectory(input, {
        readRegistry: async () => f.roots,
      }),
      runBridge: async (_origin, _arguments, options) => {
        bridgeCwd = options.cwd;
        return { stdout: "ok", stderr: "" };
      },
    });
    assert.equal(bridgeCwd, path.join(f.first, "workspace"));
  }
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
  assert.equal(calls, 1, "a noncanonical suggested path must not authorize automatic open");
});

test("ordinary open recovers terminal, legacy and same-Run drafts once and retains reconciliation evidence", async () => {
  const sourceDirectory = path.resolve(os.tmpdir(), "owned recovery source");
  const legacyContainer = path.resolve(os.tmpdir(), "Trelio Workspaces", workspaceId);
  const legacySource = path.join(legacyContainer, firstRun);
  const recoveries = [
    ...["accepted", "cancelled"].map(sourceRunStatus => new WorkspaceLocalRecoveryRequiredError({
      workspaceId, sourceRunId: firstRun, targetRunId: newRun, sourceRunStatus,
      sourceDirectory, sourceWorkspaceDirectory: path.join(sourceDirectory, "workspace"),
      suggestedDirectory: workspaceRecoveryDirectory(sourceDirectory, workspaceId, newRun),
      lastSavedDraftHead: null, changes: ["?? saved-duplicate.md", "?? useful-local.md"],
    })),
    new WorkspaceLocalRecoveryRequiredError({
      workspaceId, sourceRunId: firstRun, targetRunId: newRun, sourceRunStatus: "accepted",
      sourceDirectory: legacySource, sourceWorkspaceDirectory: path.join(legacySource, "workspace"),
      suggestedDirectory: workspaceRecoveryDirectory(legacyContainer, workspaceId, newRun),
      lastSavedDraftHead: null, changes: ["?? useful-local.md"],
    }),
    new WorkspaceDraftRecoveryRequiredError({
      workspaceId, runId: newRun, reasonCode: "DIVERGED_HISTORY",
      sourceDirectory, sourceWorkspaceDirectory: path.join(sourceDirectory, "workspace"),
      suggestedDirectory: workspaceRecoveryDirectory(sourceDirectory, workspaceId, newRun),
      baseHead: "a".repeat(40), localHead: "b".repeat(40), serverDraftHead: "c".repeat(40),
      changes: ["M WORKSPACE_CONTEXT.md"],
    }),
  ];
  for (const recovery of recoveries) {
    const input = { schemaVersion: 1, operation: "open", workingDirectory: sourceDirectory,
      parameters: { workspaceId, runId: newRun, runtimeSessionId: secondRun } };
    const originalInput = structuredClone(input);
    const signal = new AbortController().signal;
    const calls = [];
    const result = await handleTrelioWorkspaceActionOperation(origin, input, {
      signal,
      runBridge: async (actualOrigin, args, options) => {
        assert.equal(actualOrigin, origin);
        assert.equal(options.signal, signal);
        assert.equal(options.cwd, sourceDirectory);
        calls.push(args);
        if (calls.length === 1) throw Object.assign(new Error("positive source refusal"), {
          stderr: "Ошибка: " + formatBridgeCommandError(recovery, "open"),
        });
        assert.equal(args[args.indexOf("--dir") + 1], recovery.details.suggestedDirectory);
        assert.deepEqual(args.filter((_, index) => index !== args.indexOf("--dir")
          && index !== args.indexOf("--dir") + 1), calls[0]);
        return { stdout: path.join(recovery.details.suggestedDirectory, "workspace"), stderr: "" };
      },
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(input, originalInput);
    assert.equal(result.operation, "open");
    assert.deepEqual(result.recovery, {
      code: recovery.code, ...recovery.details, nextAction: result.recovery.nextAction,
    });
    assert.match(result.recovery.nextAction, /continue the authorized save/u);
    assert.match(result.recovery.nextAction, /only about a substantive conflict/u);
    const delivered = await handleToolCall(origin, TRELIO_WORKSPACE_ACTION_TOOL.name, input, {
      workspaceActionOperation: async () => result,
    });
    assert.deepEqual(JSON.parse(delivered.content[0].text), result,
      "the actual MCP projection must deliver recovery evidence and the save instruction");

    let repeated = 0;
    await assert.rejects(handleTrelioWorkspaceActionOperation(origin, input, {
      runBridge: async () => { repeated++; throw Object.assign(new Error("second refusal"), {
        stderr: "Ошибка: " + formatBridgeCommandError(recovery, "open"),
      }); },
    }), { code: recovery.code });
    assert.equal(repeated, 2, "the recovery cannot recursively reopen");

    let failed = 0;
    await assert.rejects(handleTrelioWorkspaceActionOperation(origin, input, {
      runBridge: async () => { failed++; throw Object.assign(new Error("unknown open outcome"),
        failed === 1 ? { stderr: "Ошибка: " + formatBridgeCommandError(recovery, "open") } : {}); },
    }), { code: "TRELIO_WORKSPACE_ACTION_FAILED" });
    assert.equal(failed, 2, "an unknown recovery-open outcome must never be retried");
  }
});

test("trusted local recovery reopens only the common suggested root once with the original binding", async () => {
  const sourceDirectory = path.resolve(os.tmpdir(), "synthetic owned source");
  const suggestedDirectory = `${sourceDirectory}-recovery-${newRun.slice(0, 8)}`;
  const errors = [
    new WorkspaceLocalRecoveryRequiredError({workspaceId, sourceRunId:firstRun,
      targetRunId:newRun, sourceRunStatus:"cancelled", sourceDirectory,
      sourceWorkspaceDirectory:path.join(sourceDirectory,"workspace"), suggestedDirectory,
      lastSavedDraftHead:null, changes:["?? WORK.md"]}),
    new WorkspaceDraftRecoveryRequiredError({workspaceId, runId:newRun,
      reasonCode:"DIVERGED_HISTORY", sourceDirectory,
      sourceWorkspaceDirectory:path.join(sourceDirectory,"workspace"), suggestedDirectory,
      baseHead:"a".repeat(40), localHead:"b".repeat(40), serverDraftHead:"c".repeat(40), changes:["M WORK.md"]}),
  ];
  for (const recovery of errors) {
    const calls = [], signal = new AbortController().signal;
    const input = {schemaVersion:1, operation:"open", parameters:{workspaceId,runId:newRun,
      runtimeSessionId:firstRun, directory:sourceDirectory}};
    let selected=0;
    const result = await handleTrelioWorkspaceActionOperation(origin,input,{
      signal,selectOpenRecovery:async actual=>{selected++;assert.deepEqual(actual.toJSON(),recovery.toJSON());return true;},
      runBridge:async (_origin,args,options)=>{
        calls.push(args);assert.equal(options.signal,signal);
        assert.equal(args[args.indexOf("--run")+1],newRun);
        assert.equal(args[args.indexOf("--runtime-session")+1],firstRun);
        if(calls.length===1)throw Object.assign(new Error("synthetic refusal"),{stderr:'Ошибка: '+formatBridgeCommandError(recovery,"open")});
        assert.equal(args[args.indexOf("--dir")+1],suggestedDirectory);
        return {stdout:"synthetic opened",stderr:""};
      },
    });
    assert.equal(result.stdout,"synthetic opened");assert.equal(calls.length,2);assert.equal(selected,1);
    let repeated=0;
    await assert.rejects(handleTrelioWorkspaceActionOperation(origin,input,{
      selectOpenRecovery:async()=>true,runBridge:async()=>{repeated++;throw Object.assign(new Error("same refusal"),{
        stderr:'Ошибка: '+formatBridgeCommandError(recovery,"open")});},
    }),error=>error.code===recovery.code);
    assert.equal(repeated,2,"a second recovery refusal cannot recursively reopen");
  }
  let launches=0,callbacks=0;
  await assert.rejects(handleTrelioWorkspaceActionOperation(origin,{schemaVersion:1,operation:"open",
    parameters:{workspaceId,runId:newRun,directory:sourceDirectory}}, {
    selectOpenRecovery:async()=>{callbacks++;return true;},runBridge:async()=>{launches++;throw new Error("network outcome unknown");},
  }));
  assert.equal(launches,1);assert.equal(callbacks,0,"unknown outcomes never enter recovery selection");
});

test("Windows recovery accepts a source Workspace path with different letter case", {
  skip: process.platform !== "win32",
}, () => {
  const sourceDirectory = path.resolve(os.tmpdir(), "Case Sensitive Run");
  const error = new WorkspaceLocalRecoveryRequiredError({
    workspaceId,
    sourceRunId: firstRun,
    targetRunId: newRun,
    sourceRunStatus: "accepted",
    sourceDirectory,
    sourceWorkspaceDirectory: path.join(sourceDirectory, "workspace").toUpperCase(),
    suggestedDirectory: `${sourceDirectory}-recovery`,
    lastSavedDraftHead: null,
    changes: ["M artifacts/notes.md"],
  });
  const stderr = `Ошибка: ${formatBridgeCommandError(error, "open")}\n`;
  assert.ok(parseWorkspaceLocalRecoveryRequiredError(stderr, workspaceId, newRun));
});

test("same-Run draft recovery preserves both histories and exposes one exact reconciliation route", async () => {
  const sourceDirectory = path.resolve(os.tmpdir(), "source active run");
  const suggestedDirectory = path.resolve(os.tmpdir(), "server draft recovery");
  const changes = Array.from({ length: 250 }, (_, index) => `M\tartifacts/file-${index}.md`);
  const error = new WorkspaceDraftRecoveryRequiredError({
    workspaceId,
    runId: newRun,
    reasonCode: "DIVERGED_HISTORY",
    sourceDirectory,
    sourceWorkspaceDirectory: path.join(sourceDirectory, "workspace"),
    suggestedDirectory,
    baseHead: "a".repeat(40),
    localHead: "b".repeat(40),
    serverDraftHead: "c".repeat(40),
    changes,
  });
  assert.equal(error.details.changes.length, 200);
  assert.equal(error.details.omittedChangeCount, 50);
  assert.equal(error.details.automaticChangesPerformed, false);
  assert.equal(error.details.sourceFilesMustRemainUntouched, true);

  const stderr = `Ошибка: ${formatBridgeCommandError(error, "open")}\n`;
  assert.deepEqual(
    parseWorkspaceDraftRecoveryRequiredError(stderr, workspaceId, newRun)?.toJSON(),
    error.toJSON(),
  );
  assert.equal(parseWorkspaceDraftRecoveryRequiredError(stderr, workspaceId, secondRun), null);

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
    assert.equal(actual.code, WORKSPACE_DRAFT_RECOVERY_REQUIRED);
    assert.deepEqual(actual.details, error.details);
    assert.equal(Object.hasOwn(actual.details, "stderr"), false);
    return true;
  });
  assert.equal(calls, 1, "noncanonical older envelopes remain available for explicit recovery");
  assert.match(
    TRELIO_WORKSPACE_ACTION_TOOL.description,
    /Open recovers once.*save without moving source.*only on semantic conflict/u,
  );

  for (const mutate of [
    (payload) => { payload.details.reasonCode = "UNKNOWN"; },
    (payload) => { payload.details.localHead = "not-a-head"; },
    (payload) => { payload.details.suggestedDirectory = payload.details.sourceDirectory; },
    (payload) => { payload.details.automaticChangesPerformed = true; },
    (payload) => { payload.details.omittedChangeCount = -1; },
  ]) {
    const copy = structuredClone(error.toJSON());
    mutate(copy);
    assert.equal(
      parseWorkspaceDraftRecoveryRequiredError(
        `Ошибка: ${JSON.stringify(copy)}`,
        workspaceId,
        newRun,
      ),
      null,
    );
  }
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

test("unfinished local Run recovery preserves identity, strips unknown details and never retries", async () => {
  const error = new WorkspaceRunReclaimRequiredError({
    workspaceId, sourceRunId: firstRun, targetRunId: newRun,
    reasonCode: "LOCAL_UNFINISHED_RUN_REQUIRES_REVIEW",
  });
  const payload = error.toJSON();
  payload.details.privateMetadata = "PRIVATE_CANARY";
  const stderr = `Ошибка: ${JSON.stringify(payload)}\n`;
  const parsed = parseWorkspaceRunReclaimRequiredError(stderr, workspaceId, newRun);
  assert.equal(parsed?.details.runId, firstRun);
  assert.equal(parsed?.details.reasonCode, "LOCAL_UNFINISHED_RUN_REQUIRES_REVIEW");
  assert.match(parsed.message, /prepare_agent_workspace_run\(runId\)/u);
  assert.doesNotMatch(JSON.stringify(parsed), /PRIVATE_CANARY|истёкший/u);
  for (const mutate of [
    (value) => { value.details.reasonCode = "PRIVATE_CANARY"; },
    (value) => { value.details.runId = "not-a-run"; },
    (value) => { value.details.workspaceId = secondRun; },
    (value) => { value.details.targetRunId = secondRun; },
    (value) => { value.details.requiredAction = "cancel_run"; },
  ]) {
    const copy = structuredClone(payload);
    mutate(copy);
    assert.equal(parseWorkspaceRunReclaimRequiredError(`Ошибка: ${JSON.stringify(copy)}`, workspaceId, newRun), null);
  }
  let calls = 0;
  await assert.rejects(handleTrelioWorkspaceActionOperation(origin, {
    schemaVersion: 1, operation: "open", parameters: { workspaceId, runId: newRun },
  }, { runBridge: async () => {
    calls++;
    throw Object.assign(new Error("child failed"), { stderr });
  } }), actual => {
    assert.equal(actual.code, WORKSPACE_RUN_RECLAIM_REQUIRED);
    assert.deepEqual(actual.details, parsed.details);
    assert.equal(Object.hasOwn(actual.details, "stderr"), false);
    return true;
  });
  assert.equal(calls, 1, "recovery cannot claim, cancel or repeat a new open automatically");
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
  // A default path may branch only after the exact source status is known.
  // This fixture deliberately refuses that read: never infer authority from
  // the overview or hide its 500 by taking over/starting another Run.
  await assert.rejects(run(path.join(f.second, "workspace")), { code: "TRELIO_WORKSPACE_ACTION_FAILED" });
  for (const invoke of [() => run(f.root, f.second)]) {
    await assert.rejects(invoke(), (error) => {
      assert.equal(error.code, WORKSPACE_RUN_RECLAIM_REQUIRED);
      assert.equal(error.details.reasonCode, "LOCAL_UNFINISHED_RUN_REQUIRES_REVIEW");
      assert.equal(error.details.runId, secondRun);
      assert.equal(error.details.targetRunId, newRun);
      assert.match(error.message, /незавершённый Agent Run/u);
      assert.equal(Object.hasOwn(error.details, "stderr"), false);
      return true;
    });
  }
  assert.ok(requests.every(({ method }) => method === "GET"), "selection must not claim or start a Run");
  for (const directory of f.roots) {
    assert.equal(await fs.readFile(path.join(directory, "workspace", "draft.txt"), "utf8"), "keep local draft");
  }
});
