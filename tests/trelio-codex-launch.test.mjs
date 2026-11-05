import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { inspectCodexLaunchFolder, synchronizeCodexLaunchFolder, codexLaunchFolderId } from "../host-runtime/scripts/trelio-codex-conversation.mjs";
import { findTrelioWorkingFolderRoot, readWorkingFolderInstructionFile } from "../host-runtime/scripts/trelio-workspace.mjs";

const managed = line => `<!-- trelio-agent-workspaces:start -->\n## Trelio\n${line}\n<!-- trelio-agent-workspaces:end -->\n`;
const canonical = managed("Папка привязана к компании «Company A» (`company-a`). Это контекст работы, а не привязка Git-репозитория.");
const localBridge = { findTrelioWorkingFolderRoot, readWorkingFolderInstructionFile };
const execFileAsync = promisify(execFile);
const state = { runtimeSessionId: "11111111-1111-4111-8111-111111111111",
  observation: { clientFamily: "codex" }, expiresAt: new Date(Date.now() + 60_000).toISOString() };

test("actual folder discovery uses the managed company, legacy templates and the parent root", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "trelio-codex-launch-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nested = path.join(root, "workspaces", "workspace", "workspace");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(root, "AGENTS.md"), canonical);
  const found = await inspectCodexLaunchFolder(nested, { bridge: localBridge });
  assert.equal(found.folderPath, root);
  assert.equal(found.company.slug, "company-a");
  await fs.writeFile(path.join(root, "AGENTS.md"), managed("Эта рабочая папка связана с компанией Trelio «Company A» (`company-a`)."));
  assert.equal((await inspectCodexLaunchFolder(root, { bridge: localBridge })).company.slug, "company-a");
  await fs.writeFile(path.join(root, "AGENTS.override.md"), "# Unrelated override\n");
  assert.equal(await inspectCodexLaunchFolder(root, { bridge: localBridge }), null);
  assert.equal(await inspectCodexLaunchFolder("relative", { bridge: localBridge }), null);
});

test("a chat about B in A registers only A; a lost PUT is reconciled through GET without replay", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "trelio-codex-launch-http-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "AGENTS.md"), canonical);
  let registered = null, puts = 0;
  const files = new Map();
  const bridge = { ...localBridge,
    resolveWorkspaceBridgeConfigDirectory: () => root,
    readPrivateJsonFile: async file => files.get(file) ?? {},
    writePrivateJsonFile: async (file, value) => files.set(file, value),
    loadToken: async () => "twb_disposable-fixture",
    resolveBridgeDataPlaneRouting: async input => {
      assert.equal(input.companySlug, "company-a");
      return { encryptionState: "plain", requestOrigin: input.origin };
    },
    request: async (_origin, _token, endpoint, options = {}) => {
      assert.match(endpoint, /\/companies\/company-a\/codex-folders/u);
      if (options.method === "PUT") {
        puts += 1;
        const body = JSON.parse(options.body);
        assert.equal(body.folderPath, root);
        registered = endpoint.split("/").at(-1);
        throw new Error("lost response after commit");
      }
      return { json: async () => ({ folders: registered ? [{ id: registered }] : [] }) };
    },
    ensureCompanyEncryptionContext: () => assert.fail("Plain metadata must not start encryption setup"),
  };
  const input = { hookInput: { cwd: root }, state, origin: "https://trelio.ru", toolInput: { companySlug: "company-b" } };
  assert.equal(await synchronizeCodexLaunchFolder(input, { bridge }), null);
  assert.equal(puts, 1);
  assert.equal(await synchronizeCodexLaunchFolder(input, { bridge }), null);
  assert.equal(puts, 1);
  await synchronizeCodexLaunchFolder(input, { bridge });
  assert.equal(puts, 1);
  assert.equal(await synchronizeCodexLaunchFolder({ ...input, state: { ...state,
    runtimeSessionId: "22222222-2222-4222-8222-222222222222" } }, { bridge }), null);
  assert.equal(puts, 1, "A new chat reuses the registered binding without another write or setup prompt");
  const folder = await inspectCodexLaunchFolder(root, { bridge });
  assert.equal(codexLaunchFolderId("twb_one", input.origin, folder), codexLaunchFolderId("twb_one", input.origin, folder));
  assert.notEqual(codexLaunchFolderId("twb_one", input.origin, folder), codexLaunchFolderId("twb_two", input.origin, folder));
});

test("unbound selected projects stay silent across chats, including folders with real Git history", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "trelio-codex-launch-unbound-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const withGit of [false, true]) {
    await t.test(withGit ? "ordinary Git project" : "ordinary folder", async () => {
      const folder = path.join(root, withGit ? "git-project" : "plain-project");
      await fs.mkdir(folder);
      const instructions = "# Personal project instructions\n\nKeep this selected project as it is.\n";
      await fs.writeFile(path.join(folder, "AGENTS.md"), instructions);
      const git = (...args) => execFileAsync("git", args, { cwd: folder, encoding: "utf8" });
      if (withGit) {
        await git("init", "--initial-branch=main");
        await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
          "-c", `core.hooksPath=${path.join(root, "no-hooks")}`, "commit", "--allow-empty", "-m", "Fixture history");
      }
      const refsBefore = withGit ? (await git("show-ref")).stdout : null;
      const configBefore = withGit ? await fs.readFile(path.join(folder, ".git", "config")) : null;
      let privateCalls = 0;
      const unexpected = () => { privateCalls++; throw new Error("Unbound navigation must stop before private state or setup"); };
      const bridge = { ...localBridge, resolveWorkspaceBridgeConfigDirectory: unexpected,
        readPrivateJsonFile: unexpected, writePrivateJsonFile: unexpected,
        loadToken: unexpected, resolveBridgeDataPlaneRouting: unexpected, request: unexpected };
      // A per-session reminder used to ask again in each new chat. Exercise
      // distinct runtime identities as well as repeated reads in the same chat;
      // task company metadata never authorizes onboarding the selected project.
      for (const runtimeSessionId of [state.runtimeSessionId, "22222222-2222-4222-8222-222222222222"]) {
        const input = { hookInput: { cwd: folder }, state: { ...state, runtimeSessionId },
          origin: "https://trelio.ru", toolInput: { companySlug: "company-b" } };
        assert.equal(await synchronizeCodexLaunchFolder(input, { bridge }), null);
        assert.equal(await synchronizeCodexLaunchFolder(input, { bridge }), null);
        assert.equal(await synchronizeCodexLaunchFolder({ ...input, hookInput: {} }, { bridge }), null);
      }
      assert.equal(privateCalls, 0, "No consent memo, credentials, registration or onboarding for an unbound folder");
      assert.equal(await fs.readFile(path.join(folder, "AGENTS.md"), "utf8"), instructions);
      assert.deepEqual((await fs.readdir(folder)).sort(), withGit ? [".git", "AGENTS.md"] : ["AGENTS.md"]);
      if (withGit) {
        assert.equal((await git("show-ref")).stdout, refsBefore);
        assert.deepEqual(await fs.readFile(path.join(folder, ".git", "config")), configBefore);
      }
    });
  }
});

test("encryption failure never uploads plaintext or starts a different transport", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "trelio-codex-launch-encrypted-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "AGENTS.md"), canonical);
  let puts = 0;
  const bridge = { ...localBridge, resolveWorkspaceBridgeConfigDirectory: () => root,
    readPrivateJsonFile: async () => ({}), writePrivateJsonFile: () => assert.fail("Cannot remember a failed registration"),
    loadToken: async () => "twb_disposable-fixture",
    resolveBridgeDataPlaneRouting: async () => ({ encryptionState: "encrypted", requestOrigin: "https://e2ee.trelio.ru" }),
    request: async (origin, _token, _endpoint, options = {}) => {
      assert.equal(origin, "https://e2ee.trelio.ru");
      if (options.method === "PUT") puts++;
      return { json: async () => ({ folders: [] }) };
    },
    ensureCompanyEncryptionContext: async input => {
      assert.equal(input.existingOnly, true);
      throw new Error("device not unlocked");
    },
  };
  await synchronizeCodexLaunchFolder({ hookInput: { cwd: root }, state,
    origin: "https://trelio.ru", toolInput: {} }, { bridge });
  assert.equal(puts, 0);
});
