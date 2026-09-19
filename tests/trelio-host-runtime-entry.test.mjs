import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

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

  const exitCode = await runHostRuntime({
    rawArguments: ["mcp"],
    environment,
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
});
