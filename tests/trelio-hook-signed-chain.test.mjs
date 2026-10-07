import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pluginDirectory } from "./test-layout.mjs";
import {
  resolveWorkspaceBridgeConfigDirectory,
  writePrivateJsonFile,
} from "../host-runtime/scripts/trelio-workspace.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

const runProcess = (program, args, environment, input) => new Promise((resolve, reject) => {
  const child = spawn(program, args, {
    env: environment, shell: false, windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"], timeout: 35_000,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.once("error", reject);
  child.once("close", (code, signal) => resolve({
    code, signal,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  }));
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
});

test("signed package reaches the real hook through the complete configured shell chain", async (t) => {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-signed-hook-"));
  t.after(() => fs.rm(temporaryHome, { recursive: true, force: true }));
  const launcherPluginDirectory = path.join(temporaryHome, "plugin-alias");
  await fs.symlink(pluginDirectory, launcherPluginDirectory, process.platform === "win32" ? "junction" : "dir");
  const packagePath = path.join(temporaryHome, "runtime.skillpkg");
  const built = await runProcess(process.execPath, [
    path.join(repositoryRoot, "scripts/build-host-runtime-package.mjs"),
    "--runtime-version", "0.0.0", "--output", packagePath,
  ], process.env);
  assert.equal(built.code, 0, built.stderr);
  const packageBytes = await fs.readFile(packagePath);
  const signingKey = crypto.generateKeyPairSync("ed25519");
  const descriptor = {
    schemaVersion: 1,
    runtime: {
      runtimeVersion: "0.0.0", minimumRuntimeVersion: "0.0.0", minimumPluginVersion: "3.0.0",
      packageSha256: crypto.createHash("sha256").update(packageBytes).digest("hex"),
      packageSizeBytes: packageBytes.length,
      packageUrl: "/fixture.skillpkg",
      packageSignature: crypto.sign(null, packageBytes, signingKey.privateKey).toString("base64"),
      signingPublicKeySpki: signingKey.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    },
  };
  let downloads = 0;
  const server = createServer((request, response) => {
    if (request.url.startsWith("/api/agent-workspaces/host-runtime/current?")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(descriptor));
    } else if (request.url === "/fixture.skillpkg") {
      downloads += 1;
      response.end(packageBytes);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const hooks = JSON.parse(await fs.readFile(path.join(pluginDirectory, "hooks/hooks.json"), "utf8"));
  const definition = hooks.hooks.PreToolUse[0].hooks[0];
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const windowsPowerShell = path.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const command = process.platform === "win32" ? definition.commandWindows : definition.command;
  const shells = process.platform === "win32" ? [
    { name: "cmd.exe", program: process.env.ComSpec || path.join(systemRoot, "System32/cmd.exe"), args: ["/d", "/s", "/c", command] },
    { name: "Windows PowerShell", program: windowsPowerShell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] },
  ] : [{ name: "POSIX", program: "/bin/sh", args: ["-c", command] }];
  if (process.platform === "win32") {
    const pwsh = spawnSync(path.join(systemRoot, "System32/where.exe"), ["pwsh.exe"], { encoding: "utf8" });
    assert.equal(pwsh.status, 0, "PowerShell 7 must be installed on Windows CI");
    shells.push({ name: "PowerShell 7", program: pwsh.stdout.trim().split(/\r?\n/u)[0], args: ["-NoProfile", "-Command", command] });
  }

  for (const [index, shell] of shells.entries()) {
    await t.test(shell.name, async () => {
      const physicalHome = path.join(temporaryHome, `physical-${index}`);
      const home = path.join(temporaryHome, `home-${index}`);
      await fs.mkdir(physicalHome);
      // Windows junctions do not require Developer Mode/admin symlink rights.
      // An aliased cache parent is supported; package entries themselves must
      // still be real, digest-verified files. This deterministically reproduces
      // argv[1] versus import.meta.url spelling differences on all three OSes.
      await fs.symlink(physicalHome, home, process.platform === "win32" ? "junction" : "dir");
      const sessionId = crypto.randomUUID();
      const runtimeSessionId = crypto.randomUUID();
      const environment = {
        ...process.env,
        HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData/Local"),
        XDG_CONFIG_HOME: path.join(home, ".config"), CODEX_HOME: path.join(home, ".codex"),
        CODEX_THREAD_ID: sessionId, CODEX_MCP_NODE_PATH: process.execPath,
        CLAUDE_PLUGIN_ROOT: launcherPluginDirectory, PLUGIN_ROOT: launcherPluginDirectory,
        TRELIO_ORIGIN: origin, TRELIO_WORKSPACE_ORIGIN: origin,
        TRELIO_HOST_RUNTIME_DISABLE_AUTO_UPDATE: "1",
        TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1",
        CLAUDE_CODE_ENTRYPOINT: "", CLAUDE_EFFORT: "",
      };
      // Only fixture metadata and package bytes are served over loopback. This
      // builds and verifies actual runtime source, rather than replacing the
      // stable loader with a child-process stub as launcher-only tests do.
      const installed = await runProcess(process.execPath, [
        path.join(pluginDirectory, "scripts/trelio-host-runtime-loader.mjs"), "__update",
      ], environment);
      assert.equal(installed.code, 0, installed.stderr);
      const config = resolveWorkspaceBridgeConfigDirectory({ environment, homeDirectory: home });
      const pointerPath = path.join(config, "host-runtimes/current.json");
      const pointerBefore = await fs.readFile(pointerPath, "utf8");
      const nativeRelative = `scripts/native-private-process/bin/${process.arch}/trelio-private-process.exe`;
      if (process.platform === "win32") {
        // File APIs can read a long installed path even when CreateProcess
        // cannot launch its ordinary spelling. Assert delivery separately;
        // the actual hook below must launch the exact installed native bytes.
        const nativeInstalled = path.join(config, "host-runtimes", "0.0.0",
          descriptor.runtime.packageSha256, nativeRelative);
        assert.deepEqual(await fs.readFile(nativeInstalled), await fs.readFile(
          path.join(repositoryRoot, "host-runtime", nativeRelative)));
      }

      // A synthetic pre-registered session isolates proof delivery from OAuth
      // and the service. The real hook still performs its ordinary private-file
      // ACL checks and signs a fresh nonce; no real key, proof or user state is
      // read. Separate admission/pairing tests cover registration itself.
      const signingSession = crypto.generateKeyPairSync("ed25519");
      const stateDigest = crypto.createHash("sha256").update(`${origin}\n${sessionId}`).digest("hex");
      await writePrivateJsonFile(path.join(config, "runtime-sessions", `${stateDigest}.json`), {
        schemaVersion: 1, runtimeSessionId,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        privateKeyPkcs8: signingSession.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
      });
      const input = {
        hook_event_name: "PreToolUse", session_id: sessionId,
        tool_name: "mcp__trelio__get_agent_instructions",
        tool_input: { companySlug: "synthetic-company" },
      };
      const nonces = new Set();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await runProcess(shell.program, shell.args, environment, input);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.signal, null);
        // Windows PowerShell can write a first-use progress record as CLIXML
        // to stderr. Codex reads the successful protocol response from stdout;
        // progress is not a hook failure and must not invalidate a valid proof.
        if (process.platform !== "win32") assert.equal(result.stderr, "");
        assert.doesNotMatch(result.stderr, /TRELIO_|S="error"|not recognized|not found|could not find Node|CouldNotAutoLoadModule/iu);
        assert.ok(result.stdout.trim(), "A successful hook must not silently omit its protocol response");
        const output = JSON.parse(result.stdout).hookSpecificOutput;
        // Never put the full updatedInput/proof in an assertion failure or CI log.
        assert.equal(output.permissionDecision, "allow", output.permissionDecisionReason);
        assert.equal(output.updatedInput.companySlug, input.tool_input.companySlug);
        const proof = output.updatedInput.runtimeSessionProof;
        assert.ok(proof && typeof proof.signature === "string", "One-use proof is required");
        assert.equal(proof.runtimeSessionId, runtimeSessionId);
        assert.equal(crypto.verify(null, Buffer.from([
          "trelio-runtime-proof-v1", runtimeSessionId, "get_agent_instructions", proof.issuedAt, proof.nonce,
        ].join("\n")), signingSession.publicKey, Buffer.from(proof.signature, "base64url")), true);
        assert.equal(nonces.has(proof.nonce), false, "Each invocation must sign a new nonce");
        nonces.add(proof.nonce);
      }
      const rejected = await runProcess(shell.program, shell.args, environment, {
        ...input,
        tool_name: "mcp__trelio_remote_skills__continue_trelio_local_action",
        tool_input: { schemaVersion: 1, route: "action", parameters: { nativeTool: "INVALID" } },
      });
      assert.equal(rejected.code, 0, rejected.stderr);
      const denial = JSON.parse(rejected.stdout).hookSpecificOutput;
      assert.equal(denial.permissionDecision, "deny");
      assert.match(denial.permissionDecisionReason, /TRELIO_HOOK_TOOL_IDENTITY_INVALID/u);
      assert.equal(await fs.readFile(pointerPath, "utf8"), pointerBefore);
    });
  }
  assert.equal(downloads, shells.length);
});
