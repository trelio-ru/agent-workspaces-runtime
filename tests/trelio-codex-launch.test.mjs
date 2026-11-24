import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { inspectCodexLaunchFolder, synchronizeDesktopLaunchFolder, codexLaunchFolderId, createDeepseekDesktopNavigation, confirmDesktopBrowser, confirmManualCodexBrowser } from "../host-runtime/scripts/trelio-codex-conversation.mjs";
import { createHash, randomUUID } from "node:crypto";
import { findTrelioWorkingFolderRoot, readWorkingFolderInstructionFile } from "../host-runtime/scripts/trelio-workspace.mjs";

const managed = line => `<!-- trelio-agent-workspaces:start -->\n## Trelio\n${line}\n<!-- trelio-agent-workspaces:end -->\n`;
const canonical = managed("Папка привязана к компании «Company A» (`company-a`). Это контекст работы, а не привязка Git-репозитория.");
const localBridge = { findTrelioWorkingFolderRoot, readWorkingFolderInstructionFile };
const execFileAsync = promisify(execFile);

test("browser confirmation uses only a local listener and sends its verifier to the exact challenge", async () => {
  const id = randomUUID();
  const receipt = "A".repeat(43);
  let port, challenge, callback;
  const bridge = {
    loadToken: async () => "twb_fixture",
    request: async (origin, token, endpoint, request) => {
      assert.equal(origin, "https://trelio.ru");
      assert.equal(token, "twb_fixture");
      const input = JSON.parse(request.body);
      if (!endpoint.endsWith("/finish")) {
        assert.equal(input.provider, "mimo-desktop");
        ({ port, codeChallenge: challenge } = input);
        return { json: async () => ({ id }) };
      }
      assert.match(endpoint, new RegExp(`/${id}/finish$`, "u"));
      assert.equal(input.receipt, receipt);
      assert.equal(createHash("sha256").update(input.verifier).digest("base64url"), challenge);
      return { json: async () => ({ connected: true }) };
    },
  };
  assert.deepEqual(await confirmDesktopBrowser("https://trelio.ru", { companySlug: "company-a", provider: "mimo-desktop" }, {
    bridge,
    openBrowser: async url => {
      assert.equal(url, `https://trelio.ru/company-a/agent-work/?confirmComputer=${id}`);
      const base = `http://127.0.0.1:${port}`;
      assert.equal((await fetch(`${base}/wrong?receipt=${receipt}`)).status, 403);
      callback = await fetch(`${base}/trelio-device?receipt=${receipt}`, { redirect: "manual" });
    },
  }), { connected: true });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), "https://trelio.ru/company-a/agent-work/");
});
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

const wizardFixture = async (t, pairedSetup = false) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "trelio-wizard-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const origin = "https://trelio.ru", files = new Map();
  let rows = [], puts = 0, allowed = true, loseResponse = false, memberId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const originalMemberId = memberId;
  const company = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Company A", slug: "company-a" };
  const bridge = { ...localBridge, resolveWorkspaceBridgeConfigDirectory: () => path.join(root, "private"),
    readPrivateJsonFile: async file => files.get(file) ?? {},
    writePrivateJsonFile: async (file, value) => files.set(file, structuredClone(value)),
    loadToken: async () => "twb_wizard-fixture",
    requireToken: async () => "twb_wizard-fixture",
    resolveBridgeDataPlaneRouting: async () => ({ requestOrigin: origin, encryptionState: "plain" }),
    request: async (_origin, _token, endpoint, options = {}) => {
      if (!allowed) throw Object.assign(new Error("native private message"), { code: "ACCESS_DENIED" });
      if (endpoint.includes("/codex-connection")) {
        assert.equal(endpoint.includes("runtimeSessionId="), !pairedSetup);
        return { json: async () => ({ company, memberId, encryptionState: "plain" }) };
      }
      if (options.method === "PUT") {
        puts++;
        const body = JSON.parse(options.body);
        assert.equal(Object.hasOwn(body, "runtimeSessionId"), !pairedSetup);
        rows.push({ id: endpoint.split("/").at(-1), folderPath: body.folderPath, platform: body.platform, projectId: null });
        if (loseResponse) throw new Error("lost mutation response");
        return { json: async () => ({ id: rows.at(-1).id, registered: true }) };
      }
      return { json: async () => ({ folders: rows }) };
    },
  };
  const raw = { schemaVersion: 1, operation: "codex_connection_open", parameters: { companySlug: "company-a",
    ...(pairedSetup ? { memberId: originalMemberId } : { runtimeSessionId: state.runtimeSessionId }) } };
  const open = () => openCodexConnectionWizard(origin, raw, { bridge });
  const first = await open();
  const token = first._meta["trelio/codexConnection"].capabilityToken;
  const action = (action, settings, extra = {}) => handleCodexConnectionAction(origin, { capabilityToken: token, action,
    ...(settings ? { settings } : {}) }, { bridge, ...extra });
  return { root, origin, bridge, open, action, token, company, files, get puts() { return puts; },
    set allowed(value) { allowed = value; }, set loseResponse(value) { loseResponse = value; },
    set memberId(value) { memberId = value; } };
};

test("paired setup picks and registers a folder without a hook, and rejects an account switch", async t => {
  const fixture = await wizardFixture(t, true);
  const chosen = path.join(fixture.root, "Selected folder");
  await fs.mkdir(chosen);
  const pick = await fixture.action("pick", undefined, { chooseFolder: async () => chosen });
  assert.equal(pick._meta["trelio/codexConnection"].folderPath, chosen);
  const result = await fixture.action("connect");
  assert.equal(result.structuredContent.verified, true, JSON.stringify(result.content));
  assert.equal(fixture.puts, 1);
  fixture.memberId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await assert.rejects(fixture.open(), /CODEX_CONNECTION_SCOPE_CHANGED/u);
  assert.equal((await fixture.action("connect")).structuredContent.code, "CODEX_CONNECTION_SCOPE_CHANGED");
  assert.equal(fixture.puts, 1);
});

test("wizard registers a service Git folder with nested Codex snapshot metadata and preserves isolation", async t => {
  const fixture = await wizardFixture(t, true);
  const chosen = path.join(fixture.root, "Codex snapshots");
  await fs.mkdir(chosen);
  const git = (...args) => execFileAsync("git", args, { cwd: chosen, encoding: "utf8" });
  await git("init", "--quiet");
  const indexPath = path.join(chosen, ".git", "snapshot-test-index");
  const snapshotGit = (...args) => execFileAsync("git", args, {
    cwd: chosen, encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: indexPath },
  });
  const config = ".codex/config.toml";
  const cache = ".codex-remote-attachments/turn-id";
  const attachments = new Map([
    [`${cache}/image/1-Фото.JPG`, Buffer.from("synthetic image fixture")],
    [`${cache}/document/report.pdf`, Buffer.from("synthetic PDF fixture")],
    [`${cache}/text/plain text.txt`, Buffer.from("synthetic text fixture")],
    [`${cache}/readme/README`, Buffer.from("synthetic extensionless fixture")],
  ]);
  const configContent = "# Local Codex config\n";
  for (const [file, content] of [[config, configContent], ...attachments]) {
    await fs.mkdir(path.dirname(path.join(chosen, file)), { recursive: true });
    await fs.writeFile(path.join(chosen, file), content);
  }
  // Like Codex turn-diff, stage the native Git status paths in a temporary
  // index and point each capture ref directly at its immutable tree.
  const snapshot = async (ref) => {
    const { stdout } = await git("status", "--no-renames", "--porcelain=v1", "-z", "--untracked-files=normal");
    const records = stdout.split("\0").slice(0, -1);
    assert.ok(records.length > 0 && records.every(line => line.startsWith("?? ")));
    await snapshotGit("add", "--", ...records.map(line => line.slice(3)));
    const tree = (await snapshotGit("write-tree")).stdout.trim();
    await fs.rm(indexPath);
    await git("update-ref", ref, tree);
    return tree;
  };
  const capture = "refs/codex/turn-diffs/captures/1720000000000/123e4567-e89b-12d3-a456-426614174000";
  const base = await snapshot(`${capture}/base`);
  await fs.writeFile(path.join(chosen, "AGENTS.md"), "# Personal instructions\n");
  const head = await snapshot(`${capture}/head`);
  assert.notEqual(base, head);
  const readRepository = async () => ({
    refs: (await git("for-each-ref")).stdout,
    objects: (await git("cat-file", "--batch-all-objects", "--batch-check")).stdout,
    head: await fs.readFile(path.join(chosen, ".git", "HEAD")),
    config: await fs.readFile(path.join(chosen, ".git", "config")),
  });
  const before = await readRepository();

  await fixture.action("pick", undefined, { chooseFolder: async () => chosen });
  const result = await fixture.action("connect");
  assert.equal(result.structuredContent.verified, true, JSON.stringify(result.content));
  assert.equal(fixture.puts, 1);
  assert.deepEqual(await readRepository(), before);
  for (const [file, content] of attachments) {
    assert.deepEqual(await fs.readFile(path.join(chosen, file)), content);
  }
  assert.equal(await fs.readFile(path.join(chosen, config), "utf8"), configContent);

  await fs.mkdir(path.join(chosen, "workspaces"));
  await fs.writeFile(path.join(chosen, "workspaces", ".trelio-run.json"), "synthetic protected data");
  const next = await snapshot(capture.replace("1720000000000", "1720000000001") + "/head");
  const { stdout } = await git("ls-tree", "-r", "--name-only", "-z", next);
  assert.deepEqual(new Set(stdout.split("\0").slice(0, -1)), new Set([
    ".gitignore", "AGENTS.md", "CLAUDE.md", config, ...attachments.keys(),
  ]));
  assert.equal((await git("ls-files", "--stage", "-z")).stdout, "");
  const reopened = await fixture.action("connect");
  assert.equal(reopened.structuredContent.verified, true);
  assert.equal(fixture.puts, 1);
});

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
  assert.equal(result._meta["trelio/codexConnection"].folderPath, chosen);
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

test("manual Codex setup verifies the exact managed folder before opening browser confirmation", async t => {
  const fixture = await wizardFixture(t, true);
  const folderPath = path.join(fixture.root, "manual-setup");
  const child = path.join(folderPath, "nested");
  await fs.mkdir(child, { recursive: true });
  const instructions = path.join(folderPath, "AGENTS.md");
  await fs.writeFile(instructions, canonical);
  const input = { companySlug: "company-a", folderPath };
  let confirmations = 0;
  const dependencies = {
    bridge: fixture.bridge,
    confirmBrowser: async (_origin, scope) => {
      assert.deepEqual(scope, { companySlug: "company-a", provider: "codex" });
      assert.equal(fixture.puts, 1, "Folder registration precedes browser confirmation");
      confirmations++;
      return { connected: true };
    },
  };
  await assert.rejects(confirmManualCodexBrowser(fixture.origin, { ...input, folderPath: child }, dependencies), /BINDING_UNCONFIRMED/u);
  assert.equal(fixture.puts, 0);
  assert.deepEqual(await confirmManualCodexBrowser(fixture.origin, input, dependencies), { connected: true });
  assert.equal(confirmations, 1);
  assert.equal(await fs.readFile(instructions, "utf8"), canonical);
});

test("browser confirmation rereads access after real challenge and loopback revocation failures", async t => {
  for (const phase of ["challenge", "finish"]) await t.test(phase, async t => {
    const fixture = await wizardFixture(t);
    const chosen = path.join(fixture.root, "browser-recovery");
    const settings = { folderPath: chosen, displayName: "Browser recovery", createFolder: true };
    assert.equal((await fixture.action("connect", settings)).structuredContent.verified, true);
    // Establish a previous receipt too: failing to bind another browser must
    // not keep that old success visible as the result of the new attempt.
    assert.equal((await fixture.action("confirm_browser", undefined, {
      confirmBrowser: async () => ({ connected: true }),
    }))._meta["trelio/codexConnection"].browserConfirmed, true);

    const id = randomUUID(), receipt = "B".repeat(43);
    const request = fixture.bridge.request;
    let port, codeChallenge, creates = 0, finishes = 0, callbackStatus;
    fixture.bridge.request = async (origin, token, endpoint, options = {}) => {
      if (endpoint.endsWith("/desktop-connections/challenges")) {
        creates++;
        if (phase === "challenge") {
          // Revoke only AFTER the action's initial liveWizardContext succeeded.
          fixture.allowed = false;
          return request(origin, token, endpoint, options);
        }
        ({ port, codeChallenge } = JSON.parse(options.body));
        return { json: async () => ({ id }) };
      }
      if (endpoint.endsWith("/finish")) {
        finishes++;
        const input = JSON.parse(options.body);
        assert.equal(input.receipt, receipt);
        assert.equal(createHash("sha256").update(input.verifier).digest("base64url"), codeChallenge);
        fixture.allowed = false;
      }
      return request(origin, token, endpoint, options);
    };
    fixture.bridge.openBrowser = async url => {
      assert.equal(new URL(url).searchParams.get("confirmComputer"), id);
      const callback = await fetch(`http://127.0.0.1:${port}/trelio-device?receipt=${receipt}`, { redirect: "manual" });
      callbackStatus = callback.status;
    };
    // Use the production confirmation helper and real localhost HTTP server.
    // Its safe loopback response intentionally omits the backend's ACL error;
    // the wizard must discover current denial through its own final GET.
    const result = await fixture.action("confirm_browser");
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.verified, false);
    assert.equal(result.structuredContent.stage, "folder");
    assert.equal(result.structuredContent.code, "ACCESS_DENIED");
    assert.equal(result._meta["trelio/codexConnection"].browserConfirmed, undefined);
    assert.equal(creates, 1);
    assert.equal(finishes, phase === "finish" ? 1 : 0, "Never replay confirmation after an ambiguous refusal");
    assert.equal(callbackStatus, phase === "finish" ? 400 : undefined);
    assert.equal(fixture.puts, 1, "Access recovery never re-registers the folder");
    assert.ok(!JSON.stringify(result).includes("native private message"));
  });
});

test("browser success cannot retain readiness after its account changes", async t => {
  const fixture = await wizardFixture(t);
  assert.equal((await fixture.action("connect", { folderPath: path.join(fixture.root, "late-account-change"),
    displayName: "Account fence", createFolder: true })).structuredContent.verified, true);
  const result = await fixture.action("confirm_browser", undefined, {
    confirmBrowser: async () => {
      fixture.memberId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      return { connected: true };
    },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.verified, false);
  assert.equal(result.structuredContent.code, "CODEX_CONNECTION_SCOPE_CHANGED");
  assert.equal(result._meta["trelio/codexConnection"].browserConfirmed, undefined);
  assert.equal(fixture.puts, 1);
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
  for (const id of ["title", "company", "setup", "done", "name", "path", "done-path", "display-name", "folder-path", "create", "status", "settings", "modify", "pick", "connect", "main", "confirm-browser", "browser-help"]) {
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
  const existing = path.join(fixture.root, "existing-git-folder");
  await fs.mkdir(existing);
  const git = (...args) => execFileAsync("git", args, { cwd: existing, encoding: "utf8" });
  await git("init", "--quiet");
  // An empty tree has no user data. Exercise the refusal using a
  // nonempty orphan tree, without commits, refs or staged user changes.
  const retainedNote = path.join(existing, "retained-note.txt");
  const noteBytes = "Synthetic original folder contents\n";
  const index = path.join(existing, ".git", "wizard-fixture-index");
  const fixtureGit = (...args) => execFileAsync("git", args, { cwd: existing, encoding: "utf8",
    env: { ...process.env, GIT_INDEX_FILE: index } });
  await fs.writeFile(retainedNote, noteBytes);
  await fixtureGit("add", "--", "retained-note.txt");
  const { stdout } = await fixtureGit("write-tree");
  await fs.rm(index);
  const treeId = stdout.trim();
  elements.get("folder-path").value = existing;
  elements.get("display-name").value = "App fixture"; elements.get("create").checked = true;
  const blocked = elements.get("connect").onclick();
  await elements.get("connect").onclick();
  const calls = messages.filter(message => message.method === "tools/call");
  assert.equal(calls.length, 1);
  assert.equal(elements.get("connect").disabled, true);
  const refusedGit = await handleCodexConnectionAction(fixture.origin, structuredClone(calls[0].params.arguments), { bridge: fixture.bridge });
  receive({ jsonrpc: "2.0", id: calls[0].id, result: refusedGit });
  await blocked;
  assert.equal(refusedGit.structuredContent.code, "TRELIO_FOLDER_ONBOARDING_GIT_HISTORY_PRESENT");
  assert.deepEqual(refusedGit.structuredContent.details.gitBlocker,
    { reason: "orphan_tree", object: { type: "tree", id: treeId } });
  assert.ok(!JSON.stringify(refusedGit.structuredContent).includes(existing));
  assert.equal(elements.get("done").hidden, true);
  assert.equal(elements.get("setup").hidden, false);
  assert.ok(elements.get("status").textContent.includes(treeId));
  assert.match(elements.get("status").textContent, /Автоматического восстановления.*отдельной папке/u);
  assert.equal(fixture.puts, 0);
  await assert.rejects(fs.access(path.join(existing, "AGENTS.md")), { code: "ENOENT" });
  assert.equal(await fs.readFile(retainedNote, "utf8"), noteBytes);
  assert.equal((await git("cat-file", "-t", treeId)).stdout.trim(), "tree");

  // Follow the recovery shown by the App. The original folder is still open
  // for normal Codex work, and the separate folder goes through normal setup.
  elements.get("folder-path").value = path.join(fixture.root, "app-folder");
  const clicked = elements.get("connect").onclick();
  const connect = messages.filter(message => message.method === "tools/call").at(-1);
  const submitted = await handleCodexConnectionAction(fixture.origin, structuredClone(connect.params.arguments), { bridge: fixture.bridge });
  receive({ jsonrpc: "2.0", id: connect.id, result: submitted });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get("done").hidden, false);
  assert.match(elements.get("status").textContent, /Подтвердите привязку/u);
  assert.equal(fixture.puts, 1);
  assert.equal(elements.get("confirm-browser").hidden, false);
  assert.equal(elements.get("confirm-browser").disabled, true);
  const bindRequest = messages.filter(message => message.method === "tools/call").at(-1);
  assert.equal(bindRequest.params.arguments.action, "confirm_browser");
  assert.notEqual(bindRequest.id, connect.id);
  await elements.get("confirm-browser").onclick();
  assert.equal(messages.filter(message => message.method === "tools/call").at(-1).id, bindRequest.id,
    "The pending browser exchange prevents a duplicate confirmation");
  const bound = await handleCodexConnectionAction(fixture.origin, structuredClone(bindRequest.params.arguments), {
    bridge: fixture.bridge,
    confirmBrowser: async (_origin, input) => assert.equal(input.provider, "codex"),
  });
  receive({ jsonrpc: "2.0", id: bindRequest.id, result: bound }); await clicked;
  assert.equal(elements.get("confirm-browser").textContent, "Привязать другой браузер");
  const repeatBinding = elements.get("confirm-browser").onclick();
  const repeat = messages.filter(message => message.method === "tools/call").at(-1);
  const expired = await handleCodexConnectionAction(fixture.origin, structuredClone(repeat.params.arguments), {
    bridge: fixture.bridge, confirmBrowser: async () => {
      throw Object.assign(new Error("timeout"), { code: "DESKTOP_BROWSER_CONFIRMATION_UNCONFIRMED" });
    },
  });
  receive({ jsonrpc: "2.0", id: repeat.id, result: expired }); await repeatBinding;
  assert.equal(elements.get("done").hidden, false);
  assert.match(elements.get("status").textContent, /Привязка не завершена/u);
  assert.equal(elements.get("confirm-browser").textContent, "Привязать к браузеру");
  assert.doesNotMatch(elements.get("browser-help").textContent, /Привязка подтверждена/u);
  assert.equal(fixture.puts, 1, "Browser repair never repeats folder registration");
  const retryBinding = elements.get("confirm-browser").onclick();
  const next = messages.filter(message => message.method === "tools/call").at(-1);
  fixture.allowed = false;
  const refused = await handleCodexConnectionAction(fixture.origin, structuredClone(next.params.arguments), { bridge: fixture.bridge });
  receive({ jsonrpc: "2.0", id: next.id, result: refused }); await retryBinding;
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

test("Harness navigation resolves the requested folder and exact saved session through the local catalogue", async () => {
  const origin = "https://trelio.ru";
  const token = "twb_test-fixture";
  const sessionId = "10000000-0000-4000-8000-000000000001";
  const workspace = name => ({
    workspaceId: `workspace-${name}`, directory: `/Users/test/${name}`, sessionIds: [],
  });
  const first = workspace("A"), second = workspace("B");
  second.sessionIds.push(`session-${sessionId}`);
  const folder = directory => ({ state: "bound", folderPath: directory, company: { slug: "fixture" } });
  let action;
  let canOpenFolder = true;
  let polls = 0;
  const verifiedForBrowser = [];
  const bridge = {
    readExistingBridgeSessionToken: async () => token,
    request: async (_origin, _token, endpoint) => {
      assert.equal(endpoint, "/api/agent-workspaces/deepseek-desktop/next");
      polls += 1;
      return Response.json({ action });
    },
  };
  const navigation = createDeepseekDesktopNavigation({ origin, bridge,
    inspect: async directory => canOpenFolder ? folder(directory) : null,
    register: async ({ folder, readBack }) => {
      if (readBack !== false) verifiedForBrowser.push(folder.folderPath);
      return { registered: true, verified: readBack !== false, id: codexLaunchFolderId(token, origin, folder, "deepseek") };
    },
    confirm: async (_origin, input, { prepareFolder }) => {
      assert.equal(input.provider, "deepseek");
      await prepareFolder({ bridge, token });
      return { connected: true };
    },
  });
  const next = (site = "same-origin") => navigation.route.fetch(new Request(`https://host${navigation.route.path}`, {
    method: "POST", headers: { "x-trelio-desktop-navigation": "1", "sec-fetch-site": site },
    body: JSON.stringify([first, second]),
  }));
  assert.equal((await next("cross-site")).status, 403);
  assert.equal(polls, 0);
  action = { kind: "start", folderId: codexLaunchFolderId(token, origin, folder(second.directory), "deepseek"),
    taskPath: "/fixture/general/tasks/23/" };
  assert.deepEqual((await (await next()).json()).action, { kind: "start", workspaceId: second.workspaceId,
    prompt: "Trelio Agent Workspaces https://trelio.ru/fixture/general/tasks/23/\n\n\u2060" });
  canOpenFolder = false;
  assert.deepEqual(await (await next()).json(), { action: null }, "A stale registered folder cannot be opened");
  action = { kind: "resume", sessionId: `session-${sessionId}` };
  assert.deepEqual((await (await next()).json()).action, action);
  assert.equal(navigation.hasSession(action.sessionId), true);
  action = { kind: "resume", sessionId: "session-10000000-0000-4000-8000-000000000002" };
  assert.deepEqual(await (await next()).json(), { action: null }, "A foreign session cannot be opened or observed");
  assert.equal(navigation.hasSession(action.sessionId), false);
  await assert.rejects(navigation.confirmBrowser("fixture", `session-${sessionId}`), /DESKTOP_BROWSER_FOLDER_UNAVAILABLE/u);
  canOpenFolder = true;
  await assert.rejects(navigation.confirmBrowser("different-company", `session-${sessionId}`), /DESKTOP_BROWSER_FOLDER_UNAVAILABLE/u);
  await assert.rejects(navigation.confirmBrowser("fixture", action.sessionId), /DESKTOP_BROWSER_FOLDER_UNAVAILABLE/u);
  assert.deepEqual(verifiedForBrowser, []);
  assert.deepEqual(await navigation.confirmBrowser("fixture", `session-${sessionId}`), { connected: true });
  assert.deepEqual(verifiedForBrowser, [second.directory], "Confirmation rechecks only the current native folder");
});
