import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
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
  assert.equal(observed.options.env, environment);
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
