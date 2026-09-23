import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  isLocalPathInside,
  sameLocalPath,
} from "../host-runtime/scripts/trelio-local-path.mjs";

test("Windows path comparisons accept letter-case differences without widening containment", () => {
  const root = "C:\\Users\\Alice\\Trelio\\Run";

  assert.equal(sameLocalPath(root, "c:\\users\\ALICE\\trelio\\RUN", path.win32), true);
  assert.equal(sameLocalPath(root, "C:\\Users\\Alice\\Trelio\\Run-2", path.win32), false);
  assert.equal(isLocalPathInside(root, "c:\\users\\ALICE\\TRELIO\\run\\workspace", path.win32), true);
  assert.equal(isLocalPathInside(root, "c:\\users\\ALICE\\trelio\\RUN", path.win32), false);
  assert.equal(isLocalPathInside(root, "c:\\users\\ALICE\\trelio\\RUN-2\\file", path.win32), false);
  assert.equal(isLocalPathInside(root, "D:\\Users\\Alice\\Trelio\\Run\\file", path.win32), false);
});

test("POSIX paths remain case-sensitive and missing paths never resolve to cwd", () => {
  assert.equal(sameLocalPath("/tmp/Trelio/Run", "/tmp/trelio/run", path.posix), false);
  assert.equal(isLocalPathInside("/tmp/Trelio/Run", "/tmp/trelio/run/file", path.posix), false);
  assert.equal(sameLocalPath("", process.cwd()), false);
  assert.equal(isLocalPathInside("", process.cwd()), false);
});
