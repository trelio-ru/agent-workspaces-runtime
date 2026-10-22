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

for (const clientKind of ["codex", "claude-code", "cursor", "antigravity"]) {
  test(`${clientKind} binds and refreshes the folder without replacing personal instructions`, async () => {
    const root = await makeRoot();
    const personal = "# Personal\n\nKeep my formatting.\n";
    await fs.writeFile(path.join(root, "AGENTS.md"), personal);
    const native = ["cursor", "antigravity"].includes(clientKind);
    const prepared = await prepareTrelioFolderOnboarding({ folderPath: root, clientKind, ...binding });
    assert.deepEqual(prepared.plan.changes.map((change) => change.path), native ? ["AGENTS.md"] : ["AGENTS.md", "CLAUDE.md"]);
    const result = await applyTrelioFolderOnboarding(prepared.plan.apply.arguments.parameters);
    assert.equal(result.status, "applied");
    const current = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    assert.ok(current.startsWith(personal));
    assert.match(current, /`open`.*`workingDirectory`/u);
    assert.equal((current.match(/trelio-agent-workspaces:start/gu) ?? []).length, 1);
    if (native) await assert.rejects(fs.stat(path.join(root, "CLAUDE.md")), { code: "ENOENT" });
    const healthy = await prepareTrelioFolderDiagnostic({ folderPath: root }, clientKind);
    assert.equal(healthy.status, "ready");
    assert.equal(healthy.scope.companySlug, binding.company.slug);
    await makeTemplateOutdated(root);
    const outdated = await prepareTrelioFolderDiagnostic({ folderPath: root }, clientKind);
    await applyTrelioFolderOnboarding(outdated.refresh.action.arguments.parameters);
    assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), current);
  });
}

test("native clients reject a Codex override instead of claiming an unloaded binding", async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, "AGENTS.override.md"), "# Existing override\n");
  for (const clientKind of ["cursor", "antigravity"]) {
    await assert.rejects(prepareTrelioFolderOnboarding({ folderPath: root, clientKind, ...binding }),
      { code: "TRELIO_FOLDER_ONBOARDING_INACTIVE_TARGET" });
  }
  assert.deepEqual(await fs.readdir(root), ["AGENTS.override.md"]);
});

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

// Published onboarding templates predating runtime-owned folder refresh.
// Keep fictional names/slugs; production instruction files never become fixtures.
const legacyCompanySentences = [
  'Эта обычная локальная папка задаёт Trelio-контекст компании «Тестовая компания»\n(`test-company`) и не связывает с Trelio Git-репозиторий.',
  'Эта обычная локальная папка задаёт Trelio-контекст компании «Тестовая компания» (`test-company`) и не связывает с Trelio Git-репозиторий.',
  'Эта рабочая папка связана с компанией Trelio «Тестовая компания» (`test-company`).',
];
const legacyManagedBlock = (companySentence, projectSentence = "") => [
  "<!-- trelio-agent-workspaces:start -->", "## Контекст Trelio", "",
  companySentence, projectSentence, "Старый рабочий текст.", "<!-- trelio-agent-workspaces:end -->",
].filter(Boolean).join("\n");

for (const [index, sentence] of legacyCompanySentences.entries()) {
  for (const projectBound of [false, true]) {
    test(`legacy binding ${index}/${projectBound} refreshes the same scope with original personal bytes`, async () => {
      const root = await makeRoot();
      const target = path.join(root, "AGENTS.md");
      const prefix = "# Personal  \r\n\r\n";
      const suffix = "\r\n\r\nKeep this rule  \r\n";
      const block = legacyManagedBlock(sentence, projectBound ? 'Работа ограничена проектом «Рабочий проект» (`work-project`).' : "")
        .replaceAll("\n", "\r\n");
      const before = prefix + block + suffix;
      await fs.writeFile(target, before);
      const diagnostic = await prepareTrelioFolderDiagnostic({ folderPath: root }, "codex");
      assert.equal(diagnostic.status, "refresh_available");
      assert.deepEqual(diagnostic.scope, { companySlug: "test-company", ...(projectBound ? { projectSlug: "work-project" } : {}) });
      assert.equal(diagnostic.refresh.after, "successful_protected_read_for_exact_scope");
      assert.equal(await fs.readFile(target, "utf8"), before, "diagnosis itself stays read-only");
      const parameters = diagnostic.refresh.action.arguments.parameters;
      await assert.rejects(applyTrelioFolderOnboarding({ ...parameters, company: { name: "Other", slug: "other" } }),
        { code: "TRELIO_FOLDER_ONBOARDING_BINDING_MISMATCH" });
      await applyTrelioFolderOnboarding(parameters);
      const after = await fs.readFile(target, "utf8");
      assert.ok(after.startsWith(prefix));
      assert.ok(after.endsWith(suffix));
      assert.match(after, /Папка привязана к компании «Тестовая компания» \(`test-company`\)/u);
      assert.equal((after.match(/Работа ограничена проектом/gu) ?? []).length, projectBound ? 1 : 0);
      assert.equal((await prepareTrelioFolderDiagnostic({ folderPath: root }, "codex")).status, "ready");
    });
  }
}

test("legacy scope parsing rejects mixed, duplicated and malformed declarations without widening", async () => {
  const canonical = 'Папка привязана к компании «Тестовая компания» (`test-company`). Это контекст работы, а не привязка Git-репозитория.';
  const legacy = legacyCompanySentences[0];
  for (const [company, project] of [
    [legacy + "\n" + canonical, ""], [legacy + "\n" + legacy, ""],
    [legacy.replace("test-company", "invalid.company"), ""],
    [legacy, 'Работа ограничена проектом «Проект» (`invalid.project`).'],
    [legacy, ' Работа ограничена проектом «Проект» (`work-project`).'],
    [legacy, 'Работа ограничена проектом«Проект» (`work-project`).'],
    [legacy + '\n' + canonical.replace('компании «', 'компании«'), ""],
    [legacy, 'Работа ограничена проектом «Проект» (`work-project`).\nРабота ограничена проектом «Другой» (`other`).'],
  ]) {
    const root = await makeRoot();
    const target = path.join(root, "AGENTS.md");
    const before = legacyManagedBlock(company, project);
    await fs.writeFile(target, before);
    await assert.rejects(prepareTrelioFolderDiagnostic({ folderPath: root }, "codex"),
      { code: "TRELIO_FOLDER_ONBOARDING_BINDING_AMBIGUOUS" });
    assert.equal(await fs.readFile(target, "utf8"), before);
  }
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

test("Cursor diagnostics require a real binding and preserve service Git isolation", async () => {
  const root = await makeRoot();
  const diagnostic = await prepareTrelioFolderDiagnostic({ folderPath: root }, "cursor");
  assert.equal(diagnostic.status, "setup_required");
  assert.equal(diagnostic.refresh, undefined);
  assert.deepEqual(await fs.readdir(root), []);
  await runGit(root, "init");
  await assert.rejects(prepareTrelioFolderDiagnostic({ folderPath: root }, "cursor"),
    { code: "TRELIO_FOLDER_ONBOARDING_IGNORE_FAILED" });
  await fs.writeFile(path.join(root, ".gitignore"), "/workspaces/\n");
  const isolated = await prepareTrelioFolderDiagnostic({ folderPath: root }, "cursor");
  assert.equal(isolated.status, "setup_required");
  assert.equal(isolated.scope, undefined);
});

test("an existing exact binding can refresh beside unrelated root materials without opening them", async () => {
  const root = await configuredRoot();
  await makeTemplateOutdated(root);
  const filePath = path.join(root, "user-material.txt");
  const material = "PRIVATE-MATERIAL-CANARY";
  await fs.writeFile(filePath, material);
  const diagnostic = await prepareTrelioFolderDiagnostic({ folderPath: root }, "codex");
  assert.equal(diagnostic.status, "refresh_available");
  await applyTrelioFolderOnboarding(diagnostic.refresh.action.arguments.parameters);
  assert.equal(await fs.readFile(filePath, "utf8"), material);
  assert.equal((await prepareTrelioFolderDiagnostic({ folderPath: root }, "codex")).status, "ready");
  const unbound = await makeRoot();
  await fs.writeFile(path.join(unbound, "user-material.txt"), material);
  await assert.rejects(prepareTrelioFolderDiagnostic({ folderPath: unbound }, "codex"),
    { code: "TRELIO_FOLDER_DIAGNOSTIC_DEDICATED_FOLDER_REQUIRED" });
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
  assert.match(prepared.plan.preview.managedBlock, /direct mcp__trelio\.get_task/u);
  assert.match(prepared.plan.preview.managedBlock, /ALL_TOOLS ≠ direct inventory/u);
  assert.match(prepared.plan.preview.managedBlock, /ready\/CLI ≠ tools модели/u);
  assert.match(prepared.plan.preview.managedBlock, /Нет direct schema – сразу read-only trelio-diagnostics/u);
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

for (const value of ["false", "true"]) {
  test(`service Git preserves the standard core.symlinks=${value} setting`, async () => {
    const root = await makeRoot();
    await runGit(root, "init");
    // Git init probes the filesystem and may persist false on Windows. It is
    // normal repository metadata; onboarding must not rewrite it to proceed.
    await runGit(root, "config", "core.symlinks", value);
    const configBefore = await fs.readFile(path.join(root, ".git", "config"));
    const prepared = await prepareTrelioFolderOnboarding({ folderPath: root, ...binding });
    assert.equal(prepared.inspection.folder.kind, "service_git");
    await applyTrelioFolderOnboarding(prepared.plan.apply.arguments.parameters);
    assert.equal((await prepareTrelioFolderDiagnostic({ folderPath: root }, "codex")).status, "ready");
    assert.deepEqual(await fs.readFile(path.join(root, ".git", "config")), configBefore);
  });
}

test("allowing core.symlinks still rejects unrelated local config before writing", async () => {
  const root = await makeRoot();
  await runGit(root, "init");
  await runGit(root, "config", "core.symlinks", "false");
  await runGit(root, "config", "core.autocrlf", "true");
  const configBefore = await fs.readFile(path.join(root, ".git", "config"));
  await assert.rejects(prepareTrelioFolderOnboarding({ folderPath: root, ...binding }),
    { code: "TRELIO_FOLDER_ONBOARDING_GIT_UNSUPPORTED" });
  assert.deepEqual(await fs.readdir(root), [".git"]);
  assert.deepEqual(await fs.readFile(path.join(root, ".git", "config")), configBefore);
});

test("core.symlinks=false does not admit a physical instruction symlink", {
  skip: process.platform === "win32" ? "Unprivileged Windows cannot reliably create symlinks" : false,
}, async () => {
  const root = await makeRoot();
  const targetRoot = await makeRoot();
  const target = path.join(targetRoot, "instructions.md");
  await fs.writeFile(target, "# Keep this external file\n");
  await runGit(root, "init");
  await runGit(root, "config", "core.symlinks", "false");
  await fs.symlink(target, path.join(root, "AGENTS.md"));
  await assert.rejects(prepareTrelioFolderOnboarding({ folderPath: root, ...binding }),
    { code: "TRELIO_FOLDER_ONBOARDING_UNSAFE_FILE" });
  assert.deepEqual((await fs.readdir(root)).sort(), [".git", "AGENTS.md"]);
  assert.equal(await fs.readFile(target, "utf8"), "# Keep this external file\n");
});

test("core.symlinks=false does not admit symlink modes in Codex trees on any platform", async () => {
  const root = await makeRoot();
  await runGit(root, "init");
  await runGit(root, "config", "core.symlinks", "false");
  const source = path.join(root, ".git", "synthetic-symlink-target");
  await fs.writeFile(source, "external-instructions.md");
  const blob = (await runGit(root, "hash-object", "-w", source)).stdout.trim();
  await fs.rm(source);
  const indexPath = path.join(root, ".git", "onboarding-test-index");
  const environment = { GIT_INDEX_FILE: indexPath };
  // Construct the actual Git symlink object without OS symlink privileges;
  // this negative path also runs on the unprivileged Windows CI account.
  await runGitWithEnvironment(root, environment, "update-index", "--add", "--cacheinfo", `120000,${blob},AGENTS.md`);
  const tree = (await runGitWithEnvironment(root, environment, "write-tree")).stdout.trim();
  await fs.rm(indexPath);
  const ref = "refs/codex/turn-diffs/captures/1720000000000/123e4567-e89b-12d3-a456-426614174000/base";
  await runGit(root, "update-ref", ref, tree);
  await assert.rejects(prepareTrelioFolderOnboarding({ folderPath: root, ...binding }),
    { code: "TRELIO_FOLDER_ONBOARDING_GIT_HISTORY_PRESENT" });
  assert.deepEqual(await fs.readdir(root), [".git"]);
  assert.equal((await runGit(root, "rev-parse", ref)).stdout.trim(), tree);
});

for (const ref of [
  "refs/heads/broken",
  "refs/codex/turn-diffs/captures/1720000000000/123e4567-e89b-12d3-a456-426614174000/base",
]) {
  test(`a broken ${ref} stops preparation and apply before any writes`, async () => {
    const root = await makeRoot();
    await runGit(root, "init");
    const healthyRef = "refs/codex/turn-diffs/captures/1720000000000/123e4567-e89b-12d3-a456-426614174000/head";
    const tree = (await runGit(root, "write-tree")).stdout.trim();
    await runGit(root, "update-ref", healthyRef, tree);
    const prepared = await prepareTrelioFolderOnboarding({ folderPath: root, ...binding });
    const headBefore = await fs.readFile(path.join(root, ".git", "HEAD"));
    const configBefore = await fs.readFile(path.join(root, ".git", "config"));
    const refPath = path.join(root, ".git", ref);
    await fs.mkdir(path.dirname(refPath), { recursive: true });
    const brokenBytes = "not-an-object-id\n";
    await fs.writeFile(refPath, brokenBytes);
    // Real Git exits zero while omitting the broken ref, retaining the healthy
    // one and warning on stderr. A partial list must not prove a ref-safe repo.
    const enumerated = await runGit(root, "for-each-ref");
    assert.match(enumerated.stdout, new RegExp(healthyRef, "u"));
    assert.ok(enumerated.stderr.trim());
    for (const action of [
      () => prepareTrelioFolderOnboarding({ folderPath: root, ...binding }),
      () => applyTrelioFolderOnboarding(prepared.plan.apply.arguments.parameters),
    ]) await assert.rejects(action(), { code: "TRELIO_FOLDER_ONBOARDING_GIT_INSPECTION_FAILED" });
    assert.deepEqual(await fs.readdir(root), [".git"]);
    assert.equal(await fs.readFile(refPath, "utf8"), brokenBytes);
    assert.equal((await runGit(root, "rev-parse", healthyRef)).stdout.trim(), tree);
    assert.deepEqual(await fs.readFile(path.join(root, ".git", "HEAD")), headBefore);
    assert.deepEqual(await fs.readFile(path.join(root, ".git", "config")), configBefore);
  });
}

test("all successful metadata reads fail closed on diagnostics regardless of language", async () => {
  const root = await makeRoot();
  await runGit(root, "init");
  for (const command of ["rev-parse", "remote", "ls-files", "worktree", "config", "for-each-ref", "cat-file"]) {
    const execFileCommand = async (executable, argumentsList, options) => {
      const result = await execFileAsync(executable, argumentsList, options);
      return argumentsList.includes(command)
        ? { ...result, stderr: "Диагностика неполного чтения\n" } : result;
    };
    await assert.rejects(prepareTrelioFolderOnboarding({ folderPath: root, ...binding }, { execFileCommand }),
      { code: "TRELIO_FOLDER_ONBOARDING_GIT_INSPECTION_FAILED" }, command);
    assert.deepEqual(await fs.readdir(root), [".git"]);
  }
});

test("a successful Git probe with diagnostics cannot fall back to ordinary-folder onboarding", async () => {
  const root = await makeRoot();
  const execFileCommand = async (executable, argumentsList, options) => {
    if (options.cwd === await fs.realpath(root) && argumentsList.includes("rev-parse")) {
      return { stdout: "", stderr: "synthetic incomplete Git probe\n" };
    }
    return execFileAsync(executable, argumentsList, options);
  };
  await assert.rejects(prepareTrelioFolderOnboarding({ folderPath: root, ...binding }, { execFileCommand }),
    { code: "TRELIO_FOLDER_ONBOARDING_GIT_INSPECTION_FAILED" });
  assert.deepEqual(await fs.readdir(root), []);
});

const unusualFolderNames = process.platform === "win32"
  ? ["Рабочая папка"]
  : ["Рабочая папка", "Work\nFolder", "Work\rFolder", "Work\tFolder", "Work ", "Work\n",
    "Work\nHEAD 0000000\n\nworktree fake"];
for (const name of unusualFolderNames) {
  test(`service Git handles the literal folder name ${JSON.stringify(name)}`, async () => {
    const parent = await makeRoot();
    const root = path.join(parent, name);
    await fs.mkdir(root);
    await runGit(root, "init");
    const prepared = await prepareTrelioFolderOnboarding({ folderPath: root, ...binding });
    assert.equal(prepared.inspection.folder.kind, "service_git");
    await applyTrelioFolderOnboarding(prepared.plan.apply.arguments.parameters);
    assert.equal((await prepareTrelioFolderDiagnostic({ folderPath: root }, "codex")).status, "ready");
  });
}

test("worktree parsing keeps Git 2.28 commands and rejects extra or incomplete records", async () => {
  const root = await makeRoot();
  await runGit(root, "init");
  const transformOutput = [
    (stdout) => `${stdout}worktree ${root}\nHEAD ${"0".repeat(40)}\nbranch refs/heads/other\n\n`,
    (stdout) => stdout.slice(0, -1),
    (stdout) => stdout.replace(/HEAD [0-9a-f]+\n/u, ""),
    (stdout) => `${stdout.slice(0, -1)}unknown attribute\n\n`,
  ];
  for (const transform of transformOutput) {
    const execFileCommand = async (executable, argumentsList, options) => {
      const result = await execFileAsync(executable, argumentsList, options);
      if (!argumentsList.includes("worktree")) return result;
      // -z is unavailable in Git 2.28; do not hide an increased minimum behind
      // fixtures running a newer developer/hosted Git installation.
      assert.deepEqual(argumentsList.slice(-3), ["worktree", "list", "--porcelain"]);
      return { ...result, stdout: transform(result.stdout) };
    };
    await assert.rejects(prepareTrelioFolderOnboarding({ folderPath: root, ...binding }, { execFileCommand }),
      { code: "TRELIO_FOLDER_ONBOARDING_GIT_UNSUPPORTED" });
    assert.deepEqual(await fs.readdir(root), [".git"]);
  }
});

for (const segmentLength of [32, 64]) {
  test(`service Git preserves ${segmentLength}-hex Codex checkpoints with instruction trees`, async () => {
    const root = await makeRoot();
    await runGit(root, "init");
    await fs.writeFile(path.join(root, "AGENTS.md"), "# Existing instructions\n", "utf8");
    const tree = await writeTurnDiffTree(root);
    const checkpointRef = [
      "refs/codex/turn-diffs/checkpoints",
      "a".repeat(segmentLength),
      "b".repeat(segmentLength),
      "1",
      "123e4567-e89b-12d3-a456-426614174000",
    ].join("/");
    // Mirror the runtime's process-only longpaths option. A real checkpoint ref
    // exceeds MAX_PATH in Windows temp roots; never alter the user's Git config.
    await runGit(root, "-c", "core.longpaths=true", "update-ref", checkpointRef, tree);

    const prepared = await prepareTrelioFolderOnboarding({ folderPath: root, ...binding });
    assert.equal(prepared.inspection.folder.kind, "service_git");
    await applyTrelioFolderOnboarding(prepared.plan.apply.arguments.parameters);
    assert.equal((await runGit(root, "-c", "core.longpaths=true", "rev-parse", checkpointRef)).stdout.trim(), tree);
  });
}

for (const segmentLength of [32, 64]) {
  test(`service Git accepts ${segmentLength}-hex checkpoints and captures sharing one empty tree`, async () => {
    const root = await makeRoot();
    await runGit(root, "init");
    // Reproduce feedback #18 with real Git: no commits, index entries or blobs,
    // and both refs point at the same empty tree. The scope segments are ref
    // identifiers, independent of the 40/64-hex Git object ID stored in the ref.
    const tree = (await runGit(root, "write-tree")).stdout.trim();
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const refs = [
      `refs/codex/turn-diffs/captures/1720000000000/${uuid}/base`,
      `refs/codex/turn-diffs/checkpoints/${"a".repeat(segmentLength)}/${"b".repeat(segmentLength)}/1720000000000/${uuid}`,
    ];
    for (const ref of refs) {
      await runGit(root, "-c", "core.longpaths=true", "update-ref", ref, tree);
    }
    const beforeRefs = (await runGit(root, "-c", "core.longpaths=true", "for-each-ref")).stdout;
    const beforeObjects = (await runGit(root, "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)")).stdout;
    assert.equal(beforeObjects.trim(), `${tree} tree 0`);

    const prepared = await prepareTrelioFolderOnboarding({ folderPath: root, ...binding });
    assert.equal(prepared.inspection.folder.kind, "service_git");
    await applyTrelioFolderOnboarding(prepared.plan.apply.arguments.parameters);
    const diagnostic = await prepareTrelioFolderDiagnostic({ folderPath: root }, "codex");
    assert.equal(diagnostic.status, "ready");
    assert.equal((await runGit(root, "-c", "core.longpaths=true", "for-each-ref")).stdout, beforeRefs);
    assert.equal((await runGit(root, "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)")).stdout, beforeObjects);
  });
}

test("service Git rejects unknown checkpoint widths and malformed ref components", async () => {
  const prefix = "refs/codex/turn-diffs/checkpoints";
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  const validSuffix = `1720000000000/${uuid}`;
  const rejectedRefs = [
    ...[[31, 32], [33, 32], [63, 64], [65, 64], [32, 64], [64, 32]].map(
      ([firstLength, secondLength]) => `${prefix}/${"a".repeat(firstLength)}/${"b".repeat(secondLength)}/${validSuffix}`,
    ),
    `${prefix}/${"A".repeat(32)}/${"b".repeat(32)}/${validSuffix}`,
    `${prefix}/${"a".repeat(32)}/${"g".repeat(32)}/${validSuffix}`,
    `${prefix}/${"a".repeat(32)}/${"b".repeat(32)}/0/${uuid}`,
    `${prefix}/${"a".repeat(32)}/${"b".repeat(32)}/01720000000000/${uuid}`,
    `${prefix}/${"a".repeat(32)}/${"b".repeat(32)}/1720000000000/not-a-uuid`,
    `${prefix}/${"a".repeat(32)}/${"b".repeat(32)}/1720000000000/${uuid}/extra`,
    `refs/codex/snapshots/${validSuffix}`,
  ];
  for (const ref of rejectedRefs) {
    const root = await makeRoot();
    await runGit(root, "init");
    const tree = (await runGit(root, "write-tree")).stdout.trim();
    await runGit(root, "-c", "core.longpaths=true", "update-ref", ref, tree);
    await assert.rejects(
      prepareTrelioFolderOnboarding({ folderPath: root }),
      (error) => error?.code === "TRELIO_FOLDER_ONBOARDING_GIT_HISTORY_PRESENT",
      ref,
    );
  }
});

test("32-hex checkpoint names do not admit commit, tag or forbidden tree content", async () => {
  const ref = `refs/codex/turn-diffs/checkpoints/${"a".repeat(32)}/${"b".repeat(32)}/1/123e4567-e89b-12d3-a456-426614174000`;
  for (const objectKind of ["commit", "tag", "forbidden-tree"]) {
    const root = await makeRoot();
    await runGit(root, "init");
    let objectId = objectKind === "forbidden-tree"
      ? null
      : (await runGit(root, "write-tree")).stdout.trim();
    if (objectKind === "commit") {
      objectId = (await runGit(root, "-c", "user.name=Trelio Test", "-c", "user.email=test@example.invalid", "commit-tree", objectId, "-m", "history")).stdout.trim();
    } else if (objectKind === "tag") {
      await runGit(root, "-c", "user.name=Trelio Test", "-c", "user.email=test@example.invalid", "tag", "-a", "fixture", objectId, "-m", "tagged tree");
      objectId = (await runGit(root, "rev-parse", "refs/tags/fixture")).stdout.trim();
      // Remove the ordinary tag ref so only the allowlisted checkpoint name
      // remains. Its object type must still block onboarding before any write.
      await runGit(root, "update-ref", "-d", "refs/tags/fixture");
    } else {
      const indexPath = path.join(root, ".git", "onboarding-test-index");
      const environment = { GIT_INDEX_FILE: indexPath };
      await fs.writeFile(path.join(root, "private.txt"), "synthetic forbidden content\n");
      await runGitWithEnvironment(root, environment, "add", "private.txt");
      objectId = (await runGitWithEnvironment(root, environment, "write-tree")).stdout.trim();
      await fs.rm(indexPath);
      await fs.rm(path.join(root, "private.txt"));
      // Keep no forbidden root file or orphan tree: the snapshot itself must
      // cause rejection, after the checkpoint name and object type pass.
    }
    await runGit(root, "-c", "core.longpaths=true", "update-ref", ref, objectId);
    await assert.rejects(
      prepareTrelioFolderOnboarding({ folderPath: root, ...binding }),
      (error) => error?.code === "TRELIO_FOLDER_ONBOARDING_GIT_HISTORY_PRESENT",
      objectKind,
    );
    assert.deepEqual(await fs.readdir(root), [".git"]);
  }
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
