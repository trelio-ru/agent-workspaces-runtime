import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { inspectCodexLaunchFolder, synchronizeDesktopLaunchFolder, codexLaunchFolderId } from "../host-runtime/scripts/trelio-codex-conversation.mjs";
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
  assert.equal(await synchronizeDesktopLaunchFolder(input, { bridge }), null);
  assert.equal(puts, 1);
  assert.equal(await synchronizeDesktopLaunchFolder(input, { bridge }), null);
  assert.equal(puts, 1);
  await synchronizeDesktopLaunchFolder(input, { bridge });
  assert.equal(puts, 1);
  assert.equal(await synchronizeDesktopLaunchFolder({ ...input, state: { ...state,
    runtimeSessionId: "22222222-2222-4222-8222-222222222222" } }, { bridge }), null);
  assert.equal(puts, 1, "A new chat reuses the registered binding without another write or setup prompt");
  const folder = await inspectCodexLaunchFolder(root, { bridge });
  assert.equal(codexLaunchFolderId("twb_one", input.origin, folder), codexLaunchFolderId("twb_one", input.origin, folder));
  assert.notEqual(codexLaunchFolderId("twb_one", input.origin, folder), codexLaunchFolderId("twb_two", input.origin, folder));
});

test("Claude Desktop folders require the confirmed native locator and use a separate registry", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "trelio-claude-launch-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "AGENTS.md"), canonical);
  const endpoints = [];
  const bridge = { ...localBridge,
    resolveWorkspaceBridgeConfigDirectory: () => root,
    readPrivateJsonFile: async () => ({}),
    writePrivateJsonFile: async () => {},
    loadToken: async () => "twb_disposable-fixture",
    resolveBridgeDataPlaneRouting: async ({ origin }) => ({ requestOrigin: origin, encryptionState: "plain" }),
    request: async (_origin, _token, endpoint, options = {}) => {
      endpoints.push([options.method ?? "GET", endpoint, options.body]);
      return { json: async () => ({ folders: [] }) };
    },
  };
  const origin = "https://trelio.ru";
  const claudeState = { ...state, observation: { clientFamily: "claude-code" } };
  await synchronizeDesktopLaunchFolder({ origin, state: claudeState, hookInput: { cwd: root } }, { bridge });
  assert.deepEqual(endpoints, [], "A CLI session cannot register a Desktop path");
  await synchronizeDesktopLaunchFolder({ origin, state: { ...claudeState,
    claudeDesktopSessionId: "local_11111111-1111-4111-8111-111111111111",
  }, hookInput: { cwd: root } }, { bridge });
  assert.deepEqual(endpoints.map(([method]) => method), ["GET", "PUT"]);
  const folder = await inspectCodexLaunchFolder(root, { bridge });
  const id = codexLaunchFolderId("twb_disposable-fixture", origin, folder, "claude");
  assert.notEqual(id, codexLaunchFolderId("twb_disposable-fixture", origin, folder));
  assert.equal(endpoints[1][1], `/api/agent-workspaces/companies/company-a/claude-folders/${id}`);
  assert.equal(JSON.parse(endpoints[1][2]).runtimeSessionId, state.runtimeSessionId);
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
        assert.equal(await synchronizeDesktopLaunchFolder(input, { bridge }), null);
        assert.equal(await synchronizeDesktopLaunchFolder(input, { bridge }), null);
        assert.equal(await synchronizeDesktopLaunchFolder({ ...input, hookInput: {} }, { bridge }), null);
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
  await synchronizeDesktopLaunchFolder({ hookInput: { cwd: root }, state,
    origin: "https://trelio.ru", toolInput: {} }, { bridge });
  assert.equal(puts, 0);
});

// These cases exercise the actual planner/apply and navigation writer together.
// Only the remote server, private state store and human native dialog are fakes.
import { openCodexConnectionWizard, handleCodexConnectionAction, chooseCodexConnectionFolder,
  registerAndVerifyCodexLaunchFolder, codexConnectionAppResource, runCodexFolderPickerProcess } from "../host-runtime/scripts/trelio-codex-conversation.mjs";
import vm from "node:vm";

const wizardFixture = async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "trelio-wizard-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const origin = "https://trelio.ru", files = new Map();
  let rows = [], puts = 0, allowed = true, loseResponse = false;
  const company = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Company A", slug: "company-a" };
  const bridge = { ...localBridge, resolveWorkspaceBridgeConfigDirectory: () => path.join(root, "private"),
    readPrivateJsonFile: async file => files.get(file) ?? {},
    writePrivateJsonFile: async (file, value) => files.set(file, structuredClone(value)),
    loadToken: async () => "twb_wizard-fixture",
    resolveBridgeDataPlaneRouting: async () => ({ requestOrigin: origin, encryptionState: "plain" }),
    request: async (_origin, _token, endpoint, options = {}) => {
      if (!allowed) throw Object.assign(new Error("native private message"), { code: "ACCESS_DENIED" });
      if (endpoint.includes("codex-connection?")) return { json: async () => ({ company,
        memberId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", encryptionState: "plain" }) };
      if (options.method === "PUT") {
        puts++;
        const body = JSON.parse(options.body);
        rows.push({ id: endpoint.split("/").at(-1), folderPath: body.folderPath, platform: body.platform, projectId: null });
        if (loseResponse) throw new Error("lost mutation response");
        return { json: async () => ({ id: rows.at(-1).id, registered: true }) };
      }
      return { json: async () => ({ folders: rows }) };
    },
  };
  const raw = { schemaVersion: 1, operation: "codex_connection_open", parameters: { companySlug: "company-a", runtimeSessionId: state.runtimeSessionId } };
  const open = () => openCodexConnectionWizard(origin, raw, { bridge });
  const first = await open();
  const token = first._meta["trelio/codexConnection"].capabilityToken;
  const action = (action, settings) => handleCodexConnectionAction(origin, { capabilityToken: token, action,
    ...(settings ? { settings } : {}) }, { bridge });
  return { root, origin, bridge, open, action, token, company, files, get puts() { return puts; },
    set allowed(value) { allowed = value; }, set loseResponse(value) { loseResponse = value; } };
};

test("wizard creates a chosen folder, preserves existing text, registers and reads back before ready", async t => {
  const fixture = await wizardFixture(t);
  const chosen = path.join(fixture.root, "Моя команда & проект");
  fixture.loseResponse = true;
  const result = await fixture.action("connect", { folderPath: chosen, displayName: "Моя команда", createFolder: true });
  assert.equal(result.structuredContent.verified, true, JSON.stringify(result.content));
  assert.equal(fixture.puts, 1);
  const binding = await inspectCodexLaunchFolder(chosen, { bridge: fixture.bridge });
  assert.equal(binding.company.slug, "company-a");
  assert.ok((await fs.readFile(path.join(chosen, "CLAUDE.md"), "utf8")).includes("AGENTS.md"));
  assert.ok(!JSON.stringify({ content: result.content, structuredContent: result.structuredContent }).includes(chosen), "Private paths/names stay outside model content");
  assert.equal(new URL(result._meta["trelio/codexConnection"].openUrl).searchParams.get("path"), chosen);
  const instruction = path.join(chosen, "AGENTS.md");
  const humanText = "# My existing human rules\n\n" + await fs.readFile(instruction, "utf8");
  await fs.writeFile(instruction, humanText);
  await fixture.action("connect");
  assert.equal(await fs.readFile(instruction, "utf8"), humanText);
  assert.equal(fixture.puts, 1, "Retry reconciles the same immutable registration");
  const reopened = (await fixture.open())._meta["trelio/codexConnection"];
  assert.equal(reopened.folderPath, chosen);
  assert.equal(reopened.displayName, "Моя команда");
  assert.equal(reopened.stage, "folder", "A previous receipt cannot claim current readiness without a new check");
  fixture.allowed = false;
  const denied = await fixture.action("connect");
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.verified, false);
  assert.ok(!JSON.stringify(denied).includes("native private message"));
});

test("wizard refuses another company's binding and a repository; denied setup writes no instructions", async t => {
  const fixture = await wizardFixture(t);
  const chosen = path.join(fixture.root, "existing"); await fs.mkdir(chosen);
  const original = managed("Папка привязана к компании «Other» (`other-company`). Это контекст работы, а не привязка Git-репозитория.");
  await fs.writeFile(path.join(chosen, "AGENTS.md"), original);
  const settings = { folderPath: chosen, displayName: "New", createFolder: false };
  assert.equal((await fixture.action("connect", settings)).isError, true);
  assert.equal(await fs.readFile(path.join(chosen, "AGENTS.md"), "utf8"), original);
  await fs.rm(path.join(chosen, "AGENTS.md"));
  await execFileAsync("git", ["init", "--quiet", chosen]);
  await fs.writeFile(path.join(chosen, "source.js"), "real project");
  const refused = await fixture.action("connect", settings);
  assert.equal(refused.isError, true);
  await assert.rejects(fs.access(path.join(chosen, "AGENTS.md")));
  assert.equal(fixture.puts, 0);
  await assert.rejects(handleCodexConnectionAction("https://other.example", { capabilityToken: fixture.token, action: "state" }, { bridge: fixture.bridge }), /EXPIRED/u);
  await assert.rejects(handleCodexConnectionAction(fixture.origin, { capabilityToken: "unknown", action: "connect" }, { bridge: fixture.bridge }), /EXPIRED/u);
});

test("explicit encrypted registration protects before PUT and requires locally hydrated read-back", async () => {
  const folder = { folderPath: "/Private/Canary", company: { slug: "company-a", name: "Company A" }, project: null };
  let row = null, puts = 0;
  const bridge = {
    resolveBridgeDataPlaneRouting: async () => ({ requestOrigin: "https://encrypted.example", encryptionState: "encrypted" }),
    ensureCompanyEncryptionContext: async () => ({ ready: true }),
    hydrateAgentCompanyEncryptedJson: async ({ value }) => ({ ...value, folderPath: folder.folderPath }),
    request: async (origin, token, endpoint, options = {}) => {
      assert.equal(origin, "https://encrypted.example");
      if (options.method === "PUT") {
        puts++; assert.ok(!options.body.includes("Canary"));
        row = { id: endpoint.split("/").at(-1), folderPath: "~e1:opaque:folder_path~", platform: process.platform, projectId: null };
        return { json: async () => ({ registered: true, id: row.id }) };
      }
      return { json: async () => ({ folders: row ? [row] : [] }) };
    },
  };
  const local = { protectLocalActionArguments: async () => ({ value: { folderPath: "~e1:opaque:folder_path~" }, payloads: [], expectedPayloadValues: {} }),
    uploadLocalActionPayloads: async () => {} };
  const result = await registerAndVerifyCodexLaunchFolder({ origin: "https://trelio.ru", token: "twb_fixture", folder, state, interactive: true }, { bridge, local });
  assert.equal(result.verified, true); assert.equal(puts, 1);
  bridge.hydrateAgentCompanyEncryptedJson = async ({ value }) => value;
  await assert.rejects(registerAndVerifyCodexLaunchFolder({ origin: "https://trelio.ru", token: "twb_fixture", folder, state }, { bridge, local }), /READBACK_FAILED/u);
});

test("native folder dialog uses fixed code on macOS/Windows/Linux and preserves path whitespace", async () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const expected = platform === "win32" ? "C:\\Users\\Моя команда " : "/home/Моя команда ";
    const actual = await chooseCodexConnectionFolder({ platform, environment: { SystemRoot: "C:\\Windows" },
      filesystem: { access: async () => {} }, run: async (command, args, options) => {
        assert.equal(options.shell, false); assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]); assert.ok(args.every(arg => !arg.includes(expected)));
        return { stdout: expected + "\n" };
      } });
    assert.equal(actual, expected);
  }
  assert.equal(await chooseCodexConnectionFolder({ platform: "darwin", run: async () => { throw { stderr: "cancel (-128)" }; } }), null);
  const html = codexConnectionAppResource().text;
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/u)[1]);
  assert.doesNotMatch(html, /fetch\(|localStorage|Позже|window\.location/u);
  assert.match(html, /event\.source !== window\.parent/u);
});

test("wizard App handles real host RPC, disables duplicate actions and renders verified/error results", async t => {
  const fixture = await wizardFixture(t);
  const listeners = {}, messages = [], elements = new Map();
  for (const id of ["title", "company", "setup", "done", "name", "path", "done-path", "display-name", "folder-path", "create", "status", "settings", "modify", "pick", "connect", "recheck", "open", "main"]) {
    elements.set(id, { hidden: id === "settings", value: "", checked: false, textContent: "", disabled: false,
      setAttribute() {}, focus() {}, reportValidity: () => true });
  }
  const parent = { postMessage: value => messages.push(value) };
  const window = { parent, addEventListener: (name, callback) => { listeners[name] = callback; } };
  const document = { getElementById: id => elements.get(id), documentElement: { scrollHeight: 700 },
    querySelector: () => elements.get("main"), querySelectorAll: () => [...elements.values()] };
  const context = vm.createContext({ window, document, Map, Error, setTimeout, clearTimeout });
  vm.runInContext(codexConnectionAppResource().text.match(/<script>([\s\S]*?)<\/script>/u)[1], context);
  const receive = data => listeners.message({ source: parent, data });
  receive({ jsonrpc: "2.0", id: messages[0].id, result: { hostCapabilities: { openLinks: {} } } });
  await new Promise(resolve => setImmediate(resolve));
  const opened = await fixture.open();
  receive({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: opened });
  assert.equal(elements.get("setup").hidden, false);
  elements.get("folder-path").value = path.join(fixture.root, "app-folder");
  elements.get("display-name").value = "App fixture"; elements.get("create").checked = true;
  const clicked = elements.get("connect").onclick();
  await elements.get("connect").onclick();
  const calls = messages.filter(message => message.method === "tools/call");
  assert.equal(calls.length, 1);
  assert.equal(elements.get("connect").disabled, true);
  const submitted = await handleCodexConnectionAction(fixture.origin, structuredClone(calls[0].params.arguments), { bridge: fixture.bridge });
  receive({ jsonrpc: "2.0", id: calls[0].id, result: submitted });
  await clicked;
  assert.equal(elements.get("done").hidden, false);
  assert.equal(elements.get("connect").disabled, false);
  const recheck = elements.get("recheck").onclick();
  const next = messages.filter(message => message.method === "tools/call").at(-1);
  fixture.allowed = false;
  const refused = await handleCodexConnectionAction(fixture.origin, structuredClone(next.params.arguments), { bridge: fixture.bridge });
  receive({ jsonrpc: "2.0", id: next.id, result: refused }); await recheck;
  assert.equal(elements.get("done").hidden, true);
  assert.equal(elements.get("setup").hidden, false);
  assert.match(elements.get("status").textContent, /ACCESS_DENIED/u);
});


test("native picker child receives EOF without input and refuses partial early-exit output", async () => {
  const options = { timeout: 3000, maxBuffer: 16384, shell: false };
  const result = await runCodexFolderPickerProcess(process.execPath,
    ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('EOF'))"], options);
  assert.equal(result.stdout, "EOF");
  await assert.rejects(runCodexFolderPickerProcess(process.execPath,
    ["-e", "process.stdout.write('partial');process.exitCode=7"], options), error => error.code === 7);
  await assert.rejects(runCodexFolderPickerProcess(process.execPath,
    ["-e", "process.stdout.write('x'.repeat(20000))"], options), /OUTPUT_LIMIT/u);
});
