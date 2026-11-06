import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import { pathToFileURL } from "node:url";

import {
  isLocalPathInside,
  isDirectModuleInvocation,
  sameLocalPath,
  nodeChildEnvironment,
} from "../host-runtime/scripts/trelio-local-path.mjs";

test("Node child mode comes only from the observed Electron interpreter, never ambient flags", () => {
  const environment = { HOME: "/home/test", ELECTRON_RUN_AS_NODE: "0", electron_run_as_node: "forged" };
  const identity = { currentExecutable: "/app/Harness", electronVersion: "44.7.0", pathApi: path.posix };
  assert.deepEqual(nodeChildEnvironment(environment, "/app/Harness", identity), {
    HOME: "/home/test", ELECTRON_RUN_AS_NODE: "1",
  });
  for (const [executable, electronVersion] of [["/standalone/node", "44.7.0"], ["/app/Harness", null],
    ["/app/Harness", ""], ["Harness", "44.7.0"]]) {
    assert.deepEqual(nodeChildEnvironment(environment, executable, { ...identity, electronVersion }), { HOME: "/home/test" });
  }
  assert.equal(environment.ELECTRON_RUN_AS_NODE, "0", "parent environment is never mutated");
  assert.deepEqual(nodeChildEnvironment({ electron_run_as_node: "0" }, "c:\\app\\HARNESS.exe", {
    currentExecutable: "C:\\App\\Harness.exe", electronVersion: "44.7.0", pathApi: path.win32,
  }), { ELECTRON_RUN_AS_NODE: "1" });
});

test("Windows path comparisons accept letter-case differences without widening containment", () => {
  const root = "C:\\Users\\Alice\\Trelio\\Run";

  assert.equal(sameLocalPath(root, "c:\\users\\ALICE\\trelio\\RUN", path.win32), true);
  assert.equal(sameLocalPath(root, "C:\\Users\\Alice\\Trelio\\Run-2", path.win32), false);
  assert.equal(isLocalPathInside(root, "c:\\users\\ALICE\\TRELIO\\run\\workspace", path.win32), true);
  assert.equal(isLocalPathInside(root, "c:\\users\\ALICE\\trelio\\RUN", path.win32), false);
  assert.equal(isLocalPathInside(root, "c:\\users\\ALICE\\trelio\\RUN-2\\file", path.win32), false);
  assert.equal(isLocalPathInside(root, "D:\\Users\\Alice\\Trelio\\Run\\file", path.win32), false);
});

test("main-module guard accepts an exact directory alias but never another imported file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-main-module-"));
  try {
    const actual = path.join(root, "actual");
    const alias = path.join(root, "alias");
    await fs.mkdir(actual);
    await fs.symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
    const modulePath = path.join(actual, "entry.mjs");
    await fs.writeFile(modulePath, "export const fixture = true;\n");
    const moduleUrl = pathToFileURL(await fs.realpath(modulePath)).href;
    assert.equal(isDirectModuleInvocation(moduleUrl, modulePath), true);
    assert.equal(isDirectModuleInvocation(moduleUrl, path.join(alias, "entry.mjs")), true);
    await fs.writeFile(path.join(root, "entry.mjs"), "export const other = true;\n");
    assert.equal(isDirectModuleInvocation(moduleUrl, path.join(root, "entry.mjs")), false);
    assert.equal(isDirectModuleInvocation(moduleUrl, path.join(root, "missing.mjs")), false);
    assert.equal(isDirectModuleInvocation(moduleUrl, ""), false);
    assert.equal(isDirectModuleInvocation("https://example.test/entry.mjs", modulePath), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("POSIX paths remain case-sensitive and missing paths never resolve to cwd", () => {
  assert.equal(sameLocalPath("/tmp/Trelio/Run", "/tmp/trelio/run", path.posix), false);
  assert.equal(isLocalPathInside("/tmp/Trelio/Run", "/tmp/trelio/run/file", path.posix), false);
  assert.equal(sameLocalPath("", process.cwd()), false);
  assert.equal(isLocalPathInside("", process.cwd()), false);
});
