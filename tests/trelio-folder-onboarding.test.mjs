import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  TrelioFolderOnboardingError,
  applyTrelioFolderOnboarding,
  prepareTrelioFolderOnboarding,
  prepareTrelioFolderDiagnostic,
} from "../host-runtime/scripts/trelio-folder-onboarding.mjs";

const execFileAsync = promisify(execFile);
const temporaryRoots = new Set();

const makeRoot = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-folder-onboarding-"));
  temporaryRoots.add(root);
  return root;
};

const runGit = async (root, ...argumentsList) => execFileAsync(
  "git",
  argumentsList,
  { cwd: root, encoding: "utf8" },
);

const runGitWithEnvironment = async (root, environment, ...argumentsList) => execFileAsync(
  "git",
  argumentsList,
  {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  },
);

// Codex turn-diff refs intentionally point straight to trees. Building one
// through an isolated temporary index lets the test exercise the real object
// graph without creating a commit, HEAD or user-visible staging state.
const writeTurnDiffTree = async (root) => {
  const indexPath = path.join(root, ".git", "onboarding-test-index");
  const environment = { GIT_INDEX_FILE: indexPath };
  await runGitWithEnvironment(root, environment, "add", "AGENTS.md");
  const { stdout } = await runGitWithEnvironment(root, environment, "write-tree");
  await fs.rm(indexPath, { force: true });
  return stdout.trim();
};

const binding = {
  company: { name: "Тестовая компания", slug: "test-company" },
  project: { name: "Рабочий проект", slug: "work-project" },
};

const configuredRoot = async (instructionTarget = "AGENTS.md") => {
  const root = await makeRoot();
  if (instructionTarget === "AGENTS.override.md") {
    await fs.writeFile(path.join(root, instructionTarget), "# Active\n");
  }
  const prepared = await prepareTrelioFolderOnboarding({ folderPath: root, instructionTarget, ...binding });
  await applyTrelioFolderOnboarding(prepared.plan.apply.arguments.parameters);
  return root;
};

const makeTemplateOutdated = async (root, instructionTarget = "AGENTS.md") => {
  const filePath = path.join(root, instructionTarget);
  const current = await fs.readFile(filePath, "utf8");
  const outdated = current.replace("## Trelio", "## Trelio (old template)");
  await fs.writeFile(filePath, outdated);
  return { current, outdated };
};

test("diagnostics without the client root do not infer a working folder", async () => {
  assert.deepEqual(await prepareTrelioFolderDiagnostic(null, "codex"), {
    status: "not_checked", reasonCode: "CLIENT_WORKING_FOLDER_REQUIRED",
  });
  const root = await makeRoot();
  const before = await fs.readdir(root);
  const missingBinding = await prepareTrelioFolderDiagnostic({ folderPath: root }, "codex");
  assert.equal(missingBinding.status, "setup_required");
  assert.equal(missingBinding.refresh, undefined);
  assert.deepEqual(await fs.readdir(root), before);
  await assert.rejects(prepareTrelioFolderDiagnostic({ folderPath: root, ...binding }, "codex"),
    { code: "TRELIO_FOLDER_ONBOARDING_INVALID_INPUT" });
});

test("diagnostic refresh preserves personal instructions byte for byte and is idempotent", async () => {
  const root = await configuredRoot();
  const { current, outdated } = await makeTemplateOutdated(root);
  const prefix = "# Personal  \r\n\r\n";
  const suffix = "\r\n\r\nKeep this rule  \r\n";
  await fs.writeFile(path.join(root, "AGENTS.md"), prefix + outdated + suffix);
  const claudeBefore = await fs.readFile(path.join(root, "CLAUDE.md"));
  const diagnostic = await prepareTrelioFolderDiagnostic({ folderPath: root }, "codex");
  assert.equal(diagnostic.status, "refresh_available");
  assert.deepEqual(diagnostic.scope, { companySlug: "test-company", projectSlug: "work-project" });
  assert.deepEqual(diagnostic.refresh.changes.map(({ path: filePath }) => filePath), ["AGENTS.md"]);
  assert.equal(diagnostic.refresh.action.arguments.parameters.userExplicitlyRequestedFolderSetup, undefined);
  assert.equal(diagnostic.refresh.action.arguments.parameters.userExplicitlyRequestedInstructionRefresh, true);
  assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), prefix + outdated + suffix);
  const result = await applyTrelioFolderOnboarding(diagnostic.refresh.action.arguments.parameters);
  assert.equal(result.status, "applied");
  assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), prefix + current + suffix);
  assert.deepEqual(await fs.readFile(path.join(root, "CLAUDE.md")), claudeBefore);
  const repeated = await prepareTrelioFolderDiagnostic({ folderPath: root }, "codex");
  assert.equal(repeated.status, "ready");
  assert.equal(repeated.instructions.status, "current");
  assert.equal(repeated.refresh, null);
});

test("diagnostics refresh the existing active override without changing the base file", async () => {
  const root = await configuredRoot("AGENTS.override.md");
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Inactive base\n");
  await makeTemplateOutdated(root, "AGENTS.override.md");
  const diagnostic = await prepareTrelioFolderDiagnostic({ folderPath: root }, "codex");
  assert.equal(diagnostic.instructionTarget, "AGENTS.override.md");
  await applyTrelioFolderOnboarding(diagnostic.refresh.action.arguments.parameters);
  assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "# Inactive base\n");
});

test("instruction refresh rejects rebinding, malformed project scope and concurrent edits", async () => {
  const root = await configuredRoot();
  const { outdated } = await makeTemplateOutdated(root);
  const diagnostic = await prepareTrelioFolderDiagnostic({ folderPath: root }, "codex");
  const parameters = diagnostic.refresh.action.arguments.parameters;
  await assert.rejects(applyTrelioFolderOnboarding({ ...parameters, project: undefined }),
    { code: "TRELIO_FOLDER_ONBOARDING_BINDING_MISMATCH" });
  await fs.appendFile(path.join(root, "AGENTS.md"), "\nConcurrent personal rule\n");
  await assert.rejects(applyTrelioFolderOnboarding(parameters),
    { code: "TRELIO_FOLDER_ONBOARDING_PLAN_STALE" });
  assert.match(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), /Concurrent personal rule/u);
  await fs.writeFile(path.join(root, "AGENTS.md"), outdated.replace("work-project", "invalid.project"));
  await assert.rejects(prepareTrelioFolderDiagnostic({ folderPath: root }, "codex"),
    { code: "TRELIO_FOLDER_ONBOARDING_BINDING_AMBIGUOUS" });
  await fs.writeFile(path.join(root, "AGENTS.md"), "# No binding\n");
  await assert.rejects(applyTrelioFolderOnboarding(parameters),
    { code: "TRELIO_FOLDER_ONBOARDING_BINDING_MISMATCH" });
});

test("Claude diagnostic adds only its missing import and preserves personal whitespace", async () => {
  const root = await configuredRoot();
  const personal = "# Personal  \r\n\r\nMy rule  ";
  await fs.writeFile(path.join(root, "CLAUDE.md"), personal);
  const diagnostic = await prepareTrelioFolderDiagnostic({ folderPath: root }, "claude-code");
  assert.deepEqual(diagnostic.refresh.changes.map(({ path: filePath }) => filePath), ["CLAUDE.md"]);
  await applyTrelioFolderOnboarding(diagnostic.refresh.action.arguments.parameters);
  assert.equal(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8"), personal + "\n@AGENTS.md\n");
  await fs.writeFile(path.join(root, "CLAUDE.md"), "@AGENTS.override.md\n");
  await assert.rejects(prepareTrelioFolderDiagnostic({ folderPath: root }, "claude-code"),
    { code: "TRELIO_FOLDER_ONBOARDING_CLAUDE_IMPORT_CONFLICT" });
});

test("diagnostic service Git requires existing isolation and does not repair the ignore file", async () => {
  const root = await makeRoot();
  await runGit(root, "init");
  const prepared = await prepareTrelioFolderOnboarding({ folderPath: root, ...binding });
  await applyTrelioFolderOnboarding(prepared.plan.apply.arguments.parameters);
  await makeTemplateOutdated(root);
  const ignoreBefore = await fs.readFile(path.join(root, ".gitignore"));
  const diagnostic = await prepareTrelioFolderDiagnostic({ folderPath: root }, "codex");
  await applyTrelioFolderOnboarding(diagnostic.refresh.action.arguments.parameters);
  assert.deepEqual(await fs.readFile(path.join(root, ".gitignore")), ignoreBefore);
  await fs.writeFile(path.join(root, ".gitignore"), "# Missing isolation\n");
  const agentsBefore = await fs.readFile(path.join(root, "AGENTS.md"));
  await assert.rejects(prepareTrelioFolderDiagnostic({ folderPath: root }, "codex"),
    { code: "TRELIO_FOLDER_ONBOARDING_IGNORE_FAILED" });
  assert.equal(await fs.readFile(path.join(root, ".gitignore"), "utf8"), "# Missing isolation\n");
  assert.deepEqual(await fs.readFile(path.join(root, "AGENTS.md")), agentsBefore);
});

test("Cursor diagnostics inspect the root without inventing a Codex binding or refresh", async () => {
  const root = await makeRoot();
  const diagnostic = await prepareTrelioFolderDiagnostic({ folderPath: root }, "cursor");
  assert.equal(diagnostic.status, "ready");
  assert.equal(diagnostic.instructions.status, "not_applicable");
  assert.equal(diagnostic.refresh, undefined);
  assert.deepEqual(await fs.readdir(root), []);
  await runGit(root, "init");
  await assert.rejects(prepareTrelioFolderDiagnostic({ folderPath: root }, "cursor"),
    { code: "TRELIO_FOLDER_ONBOARDING_IGNORE_FAILED" });
  await fs.writeFile(path.join(root, ".gitignore"), "/workspaces/\n");
  const isolated = await prepareTrelioFolderDiagnostic({ folderPath: root }, "cursor");
  assert.equal(isolated.status, "ready");
  assert.equal(isolated.instructions.status, "not_applicable");
  assert.equal(isolated.scope, undefined);
});

test("diagnostics and refresh leave unrelated root materials untouched", async () => {
  const root = await configuredRoot();
  await makeTemplateOutdated(root);
  const diagnostic = await prepareTrelioFolderDiagnostic({ folderPath: root }, "codex");
  const filePath = path.join(root, "user-material.txt");
  const material = "PRIVATE-MATERIAL-CANARY";
  await fs.writeFile(filePath, material);
  const agentsBefore = await fs.readFile(path.join(root, "AGENTS.md"));
  for (const action of [
    () => prepareTrelioFolderDiagnostic({ folderPath: root }, "codex"),
    () => applyTrelioFolderOnboarding(diagnostic.refresh.action.arguments.parameters),
  ]) await assert.rejects(action(), { code: "TRELIO_FOLDER_DIAGNOSTIC_DEDICATED_FOLDER_REQUIRED" });
  assert.equal(await fs.readFile(filePath, "utf8"), material);
  assert.deepEqual(await fs.readFile(path.join(root, "AGENTS.md")), agentsBefore);
});

test.after(async () => {
  await Promise.all([...temporaryRoots].map((root) => fs.rm(root, {
    recursive: true,
    force: true,
  })));
});

test("ordinary folder onboarding prepares and applies one exact reusable plan", async () => {
  const root = await makeRoot();
  const inspection = await prepareTrelioFolderOnboarding({ folderPath: root });
  assert.equal(inspection.inspection.status, "ready");
  assert.equal(inspection.inspection.folder.kind, "ordinary");
  assert.equal(inspection.plan, null);

  const prepared = await prepareTrelioFolderOnboarding({ folderPath: root, ...binding });
  assert.equal(prepared.plan.status, "ready_to_apply");
  assert.equal(prepared.plan.instructionTarget, "AGENTS.md");
  assert.deepEqual(
    prepared.plan.changes.map(({ path: filePath, action }) => [filePath, action]),
    [["AGENTS.md", "create"], ["CLAUDE.md", "create"]],
  );

  const applied = await applyTrelioFolderOnboarding({
    ...prepared.plan.apply.arguments.parameters,
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.nextAction.code, "START_NEW_CLIENT_TASK_OR_SESSION");
  assert.match(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), /test-company/u);
  assert.equal(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");

  const repeated = await prepareTrelioFolderOnboarding({ folderPath: root, ...binding });
  assert.equal(repeated.plan.status, "already_configured");
  assert.equal(repeated.plan.apply, null);
});

test("an active AGENTS.override.md requires an explicit target decision", async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Base\n", "utf8");
  await fs.writeFile(path.join(root, "AGENTS.override.md"), "# Active\n", "utf8");

  const inspected = await prepareTrelioFolderOnboarding({ folderPath: root, ...binding });
  assert.equal(inspected.inspection.status, "instruction_target_required");
  assert.equal(inspected.plan, null);

  await assert.rejects(
    prepareTrelioFolderOnboarding({
      folderPath: root,
      instructionTarget: "AGENTS.md",
      ...binding,
    }),
    (error) => error instanceof TrelioFolderOnboardingError
      && error.code === "TRELIO_FOLDER_ONBOARDING_INACTIVE_TARGET",
  );

  const prepared = await prepareTrelioFolderOnboarding({
    folderPath: root,
    instructionTarget: "AGENTS.override.md",
    ...binding,
  });
  assert.equal(prepared.plan.instructionTarget, "AGENTS.override.md");
  assert.match(prepared.plan.preview.managedBlock, /Тестовая компания/u);
});

test("service Git is preserved and bridge paths are proven ignored", async () => {
  const root = await makeRoot();
  await runGit(root, "init");

  const prepared = await prepareTrelioFolderOnboarding({ folderPath: root, ...binding });
  assert.equal(prepared.inspection.folder.kind, "service_git");
  assert.deepEqual(
    prepared.plan.changes.map(({ path: filePath }) => filePath),
    ["AGENTS.md", "CLAUDE.md", ".gitignore"],
  );
  await applyTrelioFolderOnboarding(prepared.plan.apply.arguments.parameters);

  assert.equal((await runGit(root, "rev-parse", "--git-dir")).stdout.trim(), ".git");
  assert.match(await fs.readFile(path.join(root, ".gitignore"), "utf8"), /^# trelio-agent-workspaces:ignore:start$/mu);
  await fs.mkdir(path.join(root, "workspaces"));
  const returning = await prepareTrelioFolderOnboarding({ folderPath: root, ...binding });
  assert.equal(returning.plan.status, "already_configured");
});

test("service Git accepts only exact Codex turn-diff refs that point to trees", async () => {
  const root = await makeRoot();
  await runGit(root, "init");
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Existing instructions\n", "utf8");
  const tree = await writeTurnDiffTree(root);
  const checkpointRef = [
    "refs/codex/turn-diffs/checkpoints",
    "a".repeat(64),
    "b".repeat(64),
    "1",
    "123e4567-e89b-12d3-a456-426614174000",
  ].join("/");
  await runGit(root, "update-ref", checkpointRef, tree);

  const prepared = await prepareTrelioFolderOnboarding({ folderPath: root, ...binding });
  assert.equal(prepared.inspection.folder.kind, "service_git");
  await applyTrelioFolderOnboarding(prepared.plan.apply.arguments.parameters);
  assert.equal((await runGit(root, "rev-parse", checkpointRef)).stdout.trim(), tree);
});

test("service Git rejects commit objects and orphan objects even without HEAD", async () => {
  const commitRoot = await makeRoot();
  await runGit(commitRoot, "init");
  await fs.writeFile(path.join(commitRoot, "AGENTS.md"), "# Existing instructions\n", "utf8");
  const tree = await writeTurnDiffTree(commitRoot);
  await runGit(
    commitRoot,
    "-c", "user.name=Trelio Test",
    "-c", "user.email=test@example.invalid",
    "commit-tree", tree, "-m", "detached history",
  );
  await assert.rejects(
    prepareTrelioFolderOnboarding({ folderPath: commitRoot }),
    (error) => error?.code === "TRELIO_FOLDER_ONBOARDING_GIT_HISTORY_PRESENT",
  );

  const orphanTreeRoot = await makeRoot();
  await runGit(orphanTreeRoot, "init");
  await fs.writeFile(path.join(orphanTreeRoot, "AGENTS.md"), "# Orphan tree\n", "utf8");
  await writeTurnDiffTree(orphanTreeRoot);
  await assert.rejects(
    prepareTrelioFolderOnboarding({ folderPath: orphanTreeRoot }),
    (error) => error?.code === "TRELIO_FOLDER_ONBOARDING_GIT_HISTORY_PRESENT",
  );

  const orphanRoot = await makeRoot();
  await runGit(orphanRoot, "init");
  const orphanFile = path.join(orphanRoot, ".git", "orphan-source");
  await fs.writeFile(orphanFile, "unreferenced object\n", "utf8");
  await runGit(orphanRoot, "hash-object", "-w", orphanFile);
  await fs.rm(orphanFile);
  await assert.rejects(
    prepareTrelioFolderOnboarding({ folderPath: orphanRoot }),
    (error) => error?.code === "TRELIO_FOLDER_ONBOARDING_GIT_HISTORY_PRESENT",
  );
});

test("service Git rejects history and unmanaged pre-existing Workspace paths", async () => {
  const historyRoot = await makeRoot();
  await runGit(historyRoot, "init");
  await fs.writeFile(path.join(historyRoot, "AGENTS.md"), "# Existing\n", "utf8");
  await runGit(historyRoot, "add", "AGENTS.md");
  await runGit(
    historyRoot,
    "-c", "user.name=Trelio Test",
    "-c", "user.email=test@example.invalid",
    "commit", "-m", "history",
  );
  await assert.rejects(
    prepareTrelioFolderOnboarding({ folderPath: historyRoot }),
    (error) => error?.code === "TRELIO_FOLDER_ONBOARDING_GIT_HISTORY_PRESENT",
  );

  const unmanagedRoot = await makeRoot();
  await runGit(unmanagedRoot, "init");
  await fs.mkdir(path.join(unmanagedRoot, "workspaces"));
  await assert.rejects(
    prepareTrelioFolderOnboarding({ folderPath: unmanagedRoot }),
    (error) => error?.code === "TRELIO_FOLDER_ONBOARDING_GIT_UNSUPPORTED",
  );
});

test("failed apply rolls back every runtime-owned write", async () => {
  const root = await makeRoot();
  await runGit(root, "init");
  const prepared = await prepareTrelioFolderOnboarding({ folderPath: root, ...binding });
  const failingFilesystem = {
    ...fs,
    rename: async (sourcePath, targetPath) => {
      if (path.basename(targetPath) === "AGENTS.md") {
        const error = new Error("simulated instruction activation failure");
        error.code = "EIO";
        throw error;
      }
      return fs.rename(sourcePath, targetPath);
    },
  };

  await assert.rejects(
    applyTrelioFolderOnboarding(
      prepared.plan.apply.arguments.parameters,
      { filesystem: failingFilesystem },
    ),
    /simulated instruction activation failure/u,
  );
  await assert.rejects(fs.access(path.join(root, ".gitignore")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(root, "AGENTS.md")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(root, "CLAUDE.md")), { code: "ENOENT" });
});
