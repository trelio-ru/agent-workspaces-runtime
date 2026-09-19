import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseRuntimeSessionOption } from "../host-runtime/scripts/trelio-workspace.mjs";
import { pluginDirectory } from "./test-layout.mjs";

const hookScriptPath = fileURLToPath(
  new URL("../host-runtime/scripts/trelio-runtime-session.mjs", import.meta.url),
);
const hookManifestPath = path.join(pluginDirectory, "hooks", "hooks.json");

test("plugin ships the runtime session hook and manifest", async () => {
  await access(hookManifestPath);
  await access(hookScriptPath);
});

test("bridge accepts only an exact runtime-session UUID", () => {
  assert.equal(parseRuntimeSessionOption({
    "runtime-session": "11111111-1111-4111-8111-111111111111",
  }), "11111111-1111-4111-8111-111111111111");
  assert.throws(
    () => parseRuntimeSessionOption({ "runtime-session": "$(touch bad)" }),
    /UUID/u,
  );
});
