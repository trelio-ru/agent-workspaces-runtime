import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveHostRuntimeInvocation } from "../host-runtime/scripts/trelio-host-runtime-entry.mjs";

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
