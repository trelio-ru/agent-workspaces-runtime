import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMcpStartupTrace } from "../host-runtime/scripts/trelio-mcp-startup-trace.mjs";

import {
  resolveHostRuntimeInvocation,
  runHostRuntime,
} from "../host-runtime/scripts/trelio-host-runtime-entry.mjs";

test("host runtime keeps one stable three-mode entrypoint", () => {
  const bridge = resolveHostRuntimeInvocation(["bridge", "doctor", "--json"]);
  assert.equal(path.basename(bridge.entrypointPath), "trelio-workspace.mjs");
  assert.deepEqual(bridge.arguments, ["doctor", "--json"]);

  const hook = resolveHostRuntimeInvocation(["hook"]);
  assert.equal(path.basename(hook.entrypointPath), "trelio-runtime-session.mjs");
  assert.deepEqual(hook.arguments, []);

  const mcp = resolveHostRuntimeInvocation(["mcp"]);
  assert.equal(path.basename(mcp.entrypointPath), "trelio-remote-mcp.mjs");
  assert.deepEqual(mcp.arguments, []);

  assert.throws(() => resolveHostRuntimeInvocation(["unknown"]), /bridge, hook/u);
});

test("host runtime rejects a production launch without exact component versions", async () => {
  let spawned = false;

  await assert.rejects(
    runHostRuntime({
      rawArguments: ["bridge", "doctor", "--json"],
      environment: {},
      spawnProcess: () => {
        spawned = true;
        return new EventEmitter();
      },
    }),
    /TRELIO_PLUGIN_VERSION and TRELIO_HOST_RUNTIME_VERSION/u,
  );
  assert.equal(spawned, false);
});

test("host runtime passes exact plugin and runtime versions to every child mode", async () => {
  const environment = {
    TRELIO_PLUGIN_VERSION: "2.4.0",
    TRELIO_HOST_RUNTIME_VERSION: "2.4.1",
  };
  let observed = null;
  const phases = [];

  const exitCode = await runHostRuntime({
    rawArguments: ["mcp"],
    environment,
    startupTrace: (stage) => phases.push(stage),
    spawnProcess: (command, argumentsList, options) => {
      observed = { command, argumentsList, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(observed.command, process.execPath);
  assert.equal(path.basename(observed.argumentsList[0]), "trelio-remote-mcp.mjs");
  assert.deepEqual(observed.options.env, environment);
  assert.deepEqual(phases, ["runtime_entry", "mcp_spawn"]);
});

test("MCP startup trace is opt-in, closed and content-free even on stderr failure", () => {
  const lines = [];
  const options = { write: line => lines.push(line), now: () => 123, uptime: () => 0.25 };
  createMcpStartupTrace({ ...options, environment: {} })("stdio_start");
  assert.deepEqual(lines, []);
  const trace = createMcpStartupTrace({ ...options, environment: { TRELIO_MCP_STARTUP_TRACE: "1" } });
  trace("private-path-or-message");
  trace("stdio_start");
  assert.deepEqual(lines.map(JSON.parse), [{ type: "trelio_mcp_startup", stage: "stdio_start",
    pid: process.pid, parentPid: process.ppid, timestampMs: 123, elapsedMs: 250 }]);
  assert.doesNotThrow(() => createMcpStartupTrace({ environment: { TRELIO_MCP_STARTUP_TRACE: "1" },
    write: () => { throw new Error("closed stderr"); } })("stdio_start"));
});


test("bridge runtime recovery preserves the Run cwd once without affecting MCP or hook", async () => {
  const directory = path.resolve("synthetic workspace with spaces");
  for (const mode of ["bridge", "hook", "mcp"]) {
    let options;
    await runHostRuntime({
      rawArguments: [mode, ...(mode === "bridge" ? ["status"] : [])],
      environment: { TRELIO_PLUGIN_VERSION: "3.2.3", TRELIO_HOST_RUNTIME_VERSION: "3.8.12",
        TRELIO_HOST_RUNTIME_UPDATE_REEXEC: "1", TRELIO_HOST_RUNTIME_BRIDGE_CWD: directory },
      spawnProcess: (_command, _args, input) => {
        options = input;
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("exit", 0));
        return child;
      },
    });
    assert.equal(options.cwd === directory, mode === "bridge");
    assert.equal(options.env.TRELIO_HOST_RUNTIME_BRIDGE_CWD, undefined);
  }
  for (const directory of ["relative", "", "/bad\0path"]) {
    await assert.rejects(runHostRuntime({ rawArguments: ["bridge", "finish"],
      environment: { TRELIO_PLUGIN_VERSION: "3.2.3", TRELIO_HOST_RUNTIME_VERSION: "3.8.12",
        TRELIO_HOST_RUNTIME_UPDATE_REEXEC: "1", TRELIO_HOST_RUNTIME_BRIDGE_CWD: directory },
      spawnProcess: () => assert.fail("invalid cwd must fail before bridge starts"),
    }), /absolute local directory/u);
  }
});


test("actual upgraded bridge finds Run metadata despite the loader package cwd", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-handoff-cwd-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspaceDirectory = path.join(directory, "run with spaces", "workspace");
  await fs.mkdir(workspaceDirectory, { recursive: true });
  // An intentionally invalid ID stops before token/network access. RUN_ID_MISSING
  // proves the actual bridge found this exact metadata; NOT_FOUND was the bug.
  await fs.writeFile(path.join(workspaceDirectory, "..", ".trelio-run.json"),
    JSON.stringify({ runId: "synthetic-invalid-run-id" }));
  const entrypoint = fileURLToPath(new URL("../host-runtime/scripts/trelio-host-runtime-entry.mjs", import.meta.url));
  const environment = { ...process.env, HOME: directory, USERPROFILE: directory,
    LOCALAPPDATA: path.join(directory, "local"), XDG_CACHE_HOME: path.join(directory, "cache"),
    CODEX_HOME: path.join(directory, "codex"), TRELIO_WORKSPACE_DISABLE_KEYCHAIN: "1",
    TRELIO_PLUGIN_VERSION: "3.2.3", TRELIO_HOST_RUNTIME_VERSION: "3.8.12",
    TRELIO_HOST_RUNTIME_UPDATE_REEXEC: "1", TRELIO_HOST_RUNTIME_BRIDGE_CWD: workspaceDirectory };
  for (const handoff of [false, true]) {
    const env = { ...environment };
    if (!handoff) delete env.TRELIO_HOST_RUNTIME_BRIDGE_CWD;
    await assert.rejects(promisify(execFile)(process.execPath, [entrypoint, "bridge", "status"], {
      // The stable loader changes cwd to the signed package on every launch.
      cwd: path.dirname(path.dirname(entrypoint)), env, timeout: 20_000,
    }), error => {
      assert.match(error.stderr, handoff ? /RUN_ID_MISSING/u : /RUN_METADATA_NOT_FOUND/u);
      assert.doesNotMatch(error.stderr, /BRIDGE_SESSION|token|Keychain/u);
      return true;
    });
  }
});
