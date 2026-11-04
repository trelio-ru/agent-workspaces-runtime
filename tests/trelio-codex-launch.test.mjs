import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectCodexLaunchFolder, synchronizeCodexLaunchFolder, codexLaunchFolderId } from "../host-runtime/scripts/trelio-codex-conversation.mjs";
import { findTrelioWorkingFolderRoot, readWorkingFolderInstructionFile } from "../host-runtime/scripts/trelio-workspace.mjs";

const managed = line => `<!-- trelio-agent-workspaces:start -->\n## Trelio\n${line}\n<!-- trelio-agent-workspaces:end -->\n`;
const canonical = managed("Папка привязана к компании «Company A» (`company-a`). Это контекст работы, а не привязка Git-репозитория.");
const localBridge = { findTrelioWorkingFolderRoot, readWorkingFolderInstructionFile };
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
  const folder = await inspectCodexLaunchFolder(root, { bridge });
  assert.equal(codexLaunchFolderId("twb_one", input.origin, folder), codexLaunchFolderId("twb_one", input.origin, folder));
  assert.notEqual(codexLaunchFolderId("twb_one", input.origin, folder), codexLaunchFolderId("twb_two", input.origin, folder));
});

test("an unbound old folder asks once; private read failure and missing client cwd perform no write", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "trelio-codex-launch-unbound-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let memo = {}, writes = 0;
  const bridge = { ...localBridge, resolveWorkspaceBridgeConfigDirectory: () => root,
    readPrivateJsonFile: async () => memo,
    writePrivateJsonFile: async (_file, value) => { writes++; memo = value; },
    loadToken: () => assert.fail("Unbound folders must not read credentials"),
  };
  const input = { hookInput: { cwd: root }, state, origin: "https://trelio.ru", toolInput: { companySlug: "company-b" } };
  const hint = await synchronizeCodexLaunchFolder(input, { bridge });
  assert.match(hint, /Only an affirmative user answer/u);
  assert.match(hint, /folder_onboarding/u);
  // The context quotes the exact locator as JSON, including Windows escapes.
  assert.ok(hint.includes(JSON.stringify(root)));
  assert.equal(await synchronizeCodexLaunchFolder(input, { bridge }), null);
  assert.equal(writes, 1);
  bridge.readPrivateJsonFile = async () => { throw new Error("private ACL refusal"); };
  await synchronizeCodexLaunchFolder(input, { bridge });
  await synchronizeCodexLaunchFolder({ ...input, hookInput: {} }, { bridge });
  assert.equal(writes, 1);
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
