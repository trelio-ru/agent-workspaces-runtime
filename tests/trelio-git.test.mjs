import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  collectGitCandidates,
  isSupportedGitVersion,
  parseGitVersion,
  resolveGitExecutable,
  verifyGitRuntime,
} from "../host-runtime/scripts/trelio-git.mjs";
import { pluginDirectory } from "./test-layout.mjs";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.resolve(
  testDirectory,
  "../host-runtime/scripts/trelio-workspace.mjs",
);

const createNotFoundError = (filePath) => {
  const error = new Error(`Missing virtual file: ${filePath}`);
  error.code = "ENOENT";
  return error;
};

const normalizeVirtualPath = (filePath, platform) => (
  platform === "win32"
    ? path.win32.normalize(filePath).toLowerCase()
    : path.posix.normalize(filePath)
);

/**
 * Resolver behavior for another OS must remain testable without fabricating an
 * executable for the current kernel. The virtual filesystem proves candidate
 * ordering and absolute-path handling; a separate real smoke test below still
 * exercises the host's actual Git process and repository operations.
 */
const createVirtualFilesystem = (filePaths, platform) => {
  const files = new Map(
    filePaths.map((filePath) => [normalizeVirtualPath(filePath, platform), filePath]),
  );
  const resolveFile = (filePath) => {
    const resolved = files.get(normalizeVirtualPath(filePath, platform));
    if (!resolved) {
      throw createNotFoundError(filePath);
    }
    return resolved;
  };

  return {
    stat: async (filePath) => {
      resolveFile(filePath);
      return { isFile: () => true };
    },
    realpath: async (filePath) => resolveFile(filePath),
  };
};

const createVersionExecutor = (versions, platform) => async (executable, args) => {
  assert.deepEqual(args, ["--version"]);
  const version = versions.get(normalizeVirtualPath(executable, platform));
  if (!version) {
    const error = new Error(`Virtual executable failed: ${executable}`);
    error.code = "ENOEXEC";
    throw error;
  }
  return { stdout: `git version ${version}\n`, stderr: "" };
};

test("Git version parser accepts Apple and Git for Windows suffixes", () => {
  assert.deepEqual(parseGitVersion("git version 2.39.5 (Apple Git-154)"), {
    major: 2,
    minor: 39,
    patch: 5,
    text: "2.39.5",
  });
  assert.deepEqual(parseGitVersion("git version 2.51.0.windows.1"), {
    major: 2,
    minor: 51,
    patch: 0,
    text: "2.51.0",
  });
  assert.equal(isSupportedGitVersion(parseGitVersion("git version 2.28.0")), true);
  assert.equal(isSupportedGitVersion(parseGitVersion("git version 2.27.9")), false);
});

test("macOS Git resolver uses Homebrew absolute path when Codex PATH is stale", async () => {
  const platform = "darwin";
  const gitPath = "/opt/homebrew/bin/git";
  const filesystem = createVirtualFilesystem([gitPath], platform);
  const execFileCommand = createVersionExecutor(
    new Map([[normalizeVirtualPath(gitPath, platform), "2.50.1"]]),
    platform,
  );

  const result = await resolveGitExecutable({
    platform,
    environment: { PATH: "/Applications/Codex.app/Contents/MacOS" },
    filesystem,
    execFileCommand,
  });

  assert.equal(result.status, "ready");
  assert.equal(result.gitPath, gitPath);
  assert.equal(result.source, "homebrew");
  assert.equal(result.processPathReady, false);
});

test("Git resolver ignores a private Codex runtime executable from process PATH", async () => {
  const platform = "darwin";
  const privateGitPath = "/pkg/env/global/bin/git";
  const filesystem = createVirtualFilesystem([privateGitPath], platform);

  const result = await resolveGitExecutable({
    platform,
    environment: { PATH: "/pkg/env/global/bin:/Applications/Codex.app/Contents/MacOS" },
    filesystem,
    execFileCommand: async () => {
      throw new Error("Private Codex Git must not be inspected or executed.");
    },
  });

  assert.equal(result.status, "not_found");
  assert.equal(result.code, "TRELIO_GIT_REQUIRED");
  assert.equal(result.install.strategy, "xcode-command-line-tools");
});

test("macOS Git resolver rejects an xcrun stub and selects native installation", async () => {
  const platform = "darwin";
  const gitStubPath = "/usr/bin/git";
  const filesystem = createVirtualFilesystem([gitStubPath], platform);
  const execFileCommand = async () => {
    const error = new Error("xcrun requires Command Line Tools");
    error.code = 1;
    throw error;
  };

  const result = await resolveGitExecutable({
    platform,
    environment: { PATH: "/usr/bin" },
    filesystem,
    execFileCommand,
  });

  assert.equal(result.status, "not_found");
  assert.equal(result.code, "TRELIO_GIT_REQUIRED");
  assert.equal(result.install.strategy, "xcode-command-line-tools");
  assert.deepEqual(result.install.args, ["--install"]);
});

test("Windows Git resolver reads durable machine PATH without an app restart", async () => {
  const platform = "win32";
  const gitPath = "D:\\Developer\\Git\\cmd\\git.exe";
  const filesystem = createVirtualFilesystem([gitPath], platform);
  const execFileCommand = createVersionExecutor(
    new Map([[normalizeVirtualPath(gitPath, platform), "2.51.0.windows.1"]]),
    platform,
  );

  const result = await resolveGitExecutable({
    platform,
    environment: {
      Path: "C:\\Program Files\\Codex",
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
    },
    machinePath: "D:\\Developer\\Git\\cmd",
    userPath: "",
    filesystem,
    execFileCommand,
  });

  assert.equal(result.status, "ready");
  assert.equal(result.gitPath, gitPath);
  assert.equal(result.source, "machine-path");
  assert.equal(result.processPathReady, false);
});

test("Windows Git resolver finds the standard Git for Windows installation", async () => {
  const platform = "win32";
  const gitPath = "C:\\Program Files\\Git\\cmd\\git.exe";
  const filesystem = createVirtualFilesystem([gitPath], platform);
  const execFileCommand = createVersionExecutor(
    new Map([[normalizeVirtualPath(gitPath, platform), "2.49.0.windows.1"]]),
    platform,
  );

  const result = await resolveGitExecutable({
    platform,
    environment: {
      Path: "C:\\Program Files\\Codex",
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
    },
    machinePath: "",
    userPath: "",
    filesystem,
    execFileCommand,
  });

  assert.equal(result.status, "ready");
  assert.equal(result.gitPath, gitPath);
  assert.equal(result.source, "program-files");
});

test("Windows Git resolver returns an exact winget installation plan", async () => {
  const platform = "win32";
  const wingetPath = "C:\\Users\\Ada\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe";
  const filesystem = createVirtualFilesystem([wingetPath], platform);

  const result = await resolveGitExecutable({
    platform,
    environment: {
      Path: "C:\\Program Files\\Codex",
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
    },
    machinePath: "",
    userPath: "",
    filesystem,
    execFileCommand: async () => {
      throw new Error("No Git candidate should execute.");
    },
  });

  assert.equal(result.status, "not_found");
  assert.equal(result.install.strategy, "winget");
  assert.equal(result.install.executable, wingetPath);
  assert.deepEqual(result.install.args.slice(0, 4), ["install", "--id", "Git.Git", "-e"]);
  assert.match(result.install.displayCommand, /^winget install --id Git\.Git -e/u);
});

test("Git candidate collection ignores ambient process PATH on both platforms", () => {
  const macCandidates = collectGitCandidates({
    platform: "darwin",
    environment: { PATH: ".:/pkg/env/global/bin:/usr/local/bin" },
  });
  assert.equal(
    macCandidates.some((candidate) => candidate.path === "/pkg/env/global/bin/git"),
    false,
  );

  const windowsCandidates = collectGitCandidates({
    platform: "win32",
    environment: { Path: ".;C:\\CodexPrivateTools" },
    machinePath: "",
    userPath: "",
  });
  assert.equal(
    windowsCandidates.some(
      (candidate) => candidate.path.toLowerCase() === "c:\\codexprivatetools\\git.exe",
    ),
    false,
  );
});

test("real Git runtime completes init, add and commit on the current OS", async () => {
  const result = await verifyGitRuntime();

  assert.equal(result.status, "ready", JSON.stringify(result));
  assert.equal(result.smokeTest, "ready");
  assert.equal(path.isAbsolute(result.gitPath), true);
});

test("bridge doctor exposes machine-readable local prerequisite status", async (context) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "trelio-doctor-recovery-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, undefined);
    if (request.url === "/mcp") { response.writeHead(405).end(); return; }
    const origin = `http://127.0.0.1:${server.address().port}`;
    response.writeHead(200).end(JSON.stringify(request.url.includes("protected-resource")
      ? { resource: `${origin}/mcp` } : { issuer: origin }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const pluginManifest = JSON.parse(await readFile(
    path.join(pluginDirectory, ".codex-plugin", "plugin.json"),
    "utf8",
  ));
  const { stdout } = await execFileAsync(
    process.execPath,
    [bridgePath, "doctor", "--json", "--origin", `http://127.0.0.1:${server.address().port}`],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: path.join(home, ".codex"),
        XDG_CONFIG_HOME: path.join(home, ".config"),
        APPDATA: path.join(home, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(home, "AppData", "Local"),
        TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1",
        // Production loader supplies the exact installed shell root. Tests do
        // the same explicitly now that runtime and plugin sources are separate.
        TRELIO_PLUGIN_ROOT: pluginDirectory,
        TRELIO_PLUGIN_VERSION: pluginManifest.version,
        TRELIO_HOST_RUNTIME_VERSION: "3.7.2",
      },
    },
  );
  const report = JSON.parse(stdout.trim());

  assert.equal(report.status, "ready", JSON.stringify(report));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.publicService.state, "available");
  assert.equal(report.connectionRecovery.connectionRetried, false);
  assert.equal(report.connectionRecovery.restartRequired, false);
  // This is the old, already-published shell command, with no new flags or
  // local MCP available. It must return an actionable client continuation,
  // not just anonymous reachability and another instruction to run doctor.
  assert.equal(report.readVerification.readResult, "not_checked");
  assert.equal(report.readVerification.state, "client_read_required");
  assert.deepEqual(report.readVerification.nextCall, { toolName: "list_companies", arguments: {} });
  assert.equal(report.clientRecoveryByKind.clientKind, "not_checked");
  const recovery = report.clientRecoveryByKind.codex;
  assert.deepEqual(recovery.userOptions, ["toggle_trelio_plugin", "fully_quit_and_reopen_application"]);
  assert.ok(recovery.evidence.accepted.includes("direct_schema_absent_in_current_turn"));
  assert.equal(recovery.connectionRetried, false);
  assert.equal(recovery.archiveRecoveryAllowed, false);
  assert.equal(recovery.sameThreadFallback.automatic, false);
  assert.ok(recovery.verification.checks.includes("safe_direct_read_in_target_thread"));
  assert.equal(report.connectionRecovery.clientInspection, "clientRecoveryByKind");
  assert.equal(report.node.status, "ready");
  assert.equal(report.git.status, "ready");
  assert.equal(report.git.smokeTest, "ready");
  assert.equal(report.plugin.status, "ready");
  assert.equal(report.plugin.loadedVersion, pluginManifest.version);
  assert.equal(report.hostRuntime.loadedVersion, "3.7.2");
  assert.equal(report.plugin.hooks.status, "ready");
  assert.equal(report.plugin.hooks.preToolUseScope, "trelio_mcp");
  assert.equal(report.plugin.hooks.approvalStatus, "client_managed_unknown");
  assert.equal(typeof report.plugin.hooks.definitionSha256, "string");
  assert.equal(report.runtimeSessions.activeCount >= 0, true);
  assert.equal(typeof report.connection.deviceSessionConfigured, "boolean");
  assert.doesNotMatch(JSON.stringify(report), /bridgeSessionToken|privateKeyPkcs8|pairingId/u);
});

test("workspace bridge never invokes a bare Git command", async () => {
  const source = await readFile(bridgePath, "utf8");

  assert.doesNotMatch(source, /run\(\s*["']git["']/u);
  assert.match(source, /verifyGitRuntime/u);
  assert.match(source, /core\.hooksPath=\$\{GIT_DISABLED_HOOKS_PATH\}/u);
  assert.match(source, /GIT_CONFIG_GLOBAL: GIT_DISABLED_GLOBAL_CONFIG_PATH/u);
  assert.match(source, /core\.longpaths=true/u);
});
