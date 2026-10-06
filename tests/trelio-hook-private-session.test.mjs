import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertRuntimeHookBudget, createPrivateAclWorker, privateProcessOptions,
  runtimeHookSignal, scopedPrivateAclWorker, withRuntimeHookPrivateSession,
} from "../host-runtime/scripts/trelio-hook-private-session.mjs";
import { hardenWindowsPrivatePath } from "../host-runtime/scripts/trelio-workspace.mjs";

// This child only implements the value-free IPC protocol. It never starts
// PowerShell or reads a credential, and works on every supported CI platform.
const fixtureSource = `
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  const mode = Buffer.from(request.path, 'base64').toString('utf8');
  if (mode === 'stall') return;
  if (mode === 'invalid') { console.log('not-json'); return; }
  if (mode === 'exit') { process.exit(1); return; }
  console.log(JSON.stringify({ id: request.id, ok: mode !== 'deny' }));
});
`;
const fixtureSpawner = (state) => (executable, args, options) => {
  state.starts++;
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ["pipe", "pipe", "ignore"]);
  assert.equal(args[args.length - 2], "-EncodedCommand");
  const child = spawn(process.execPath, ["-e", fixtureSource], options);
  state.children.push(child);
  return child;
};
const fixtureOptions = (state) => ({
  executable: "synthetic-powershell", aclScript: "# fixed synthetic ACL implementation",
  spawnProcess: fixtureSpawner(state),
});
const assertStopped = async (state) => {
  for (const child of state.children) {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once("close", resolve));
    }
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  }
};

test("one hook reuses one ACL process but verifies every path, and closes it before returning", async () => {
  const state = { starts: 0, children: [] };
  await withRuntimeHookPrivateSession(5_000, async () => {
    const first = scopedPrivateAclWorker(fixtureOptions(state));
    for (let index = 0; index < 20; index++) {
      const worker = scopedPrivateAclWorker(fixtureOptions(state));
      assert.equal(worker, first);
      await worker.harden("synthetic path Ж ' $()", index % 2 ? "file" : "directory");
    }
    // Even a previously successful path must still reach the child. An error
    // on that same transport is rejected, not hidden by a cached ACL result.
    await assert.rejects(first.harden("deny", "file"), /Windows не подтвердил/u);
  });
  assert.equal(state.starts, 1);
  await assertStopped(state);
  await withRuntimeHookPrivateSession(5_000, async () => {
    await scopedPrivateAclWorker(fixtureOptions(state)).harden("new-hook", "file");
  });
  assert.equal(state.starts, 2);
  await assertStopped(state);
});

test("hook-wide deadline cancels a stalled ACL child and leaves the next hook usable", async () => {
  const state = { starts: 0, children: [] };
  await withRuntimeHookPrivateSession(100, async () => {
    await assert.rejects(
      scopedPrivateAclWorker(fixtureOptions(state)).harden("stall", "directory"),
      { code: "TRELIO_RUNTIME_HOOK_FAILED" },
    );
    assert.throws(assertRuntimeHookBudget, { code: "TRELIO_RUNTIME_HOOK_FAILED" });
  });
  await assertStopped(state);
  await withRuntimeHookPrivateSession(5_000, async () => {
    await scopedPrivateAclWorker(fixtureOptions(state)).harden("retry", "file");
  });
  await assertStopped(state);
});

test("a single ACL request has its own bound and cannot silently respawn after failure", async () => {
  const state = { starts: 0, children: [] };
  const worker = createPrivateAclWorker({ ...fixtureOptions(state), requestTimeoutMilliseconds: 100 });
  try {
    await assert.rejects(worker.harden("stall", "directory"));
    await assert.rejects(worker.harden("retry", "directory"));
    assert.equal(state.starts, 1);
  } finally { await worker.close(); }
  await assertStopped(state);
});

for (const mode of ["invalid", "exit"]) {
  test(`ACL worker ${mode} response is a failure with no child output disclosure`, async () => {
    const state = { starts: 0, children: [] };
    const worker = createPrivateAclWorker(fixtureOptions(state));
    try {
      await assert.rejects(worker.harden(mode, "file"), (error) => {
        assert.equal(error.stdout, undefined);
        assert.equal(error.stderr, undefined);
        assert.doesNotMatch(error.message, /not-json|synthetic-powershell/u);
        return true;
      });
    } finally { await worker.close(); }
    await assertStopped(state);
  });
}

test("private subprocesses receive both a local timeout and the exact non-sliding hook signal", async () => {
  assert.equal(runtimeHookSignal(), undefined);
  assert.equal(privateProcessOptions().timeout, 10_000);
  await withRuntimeHookPrivateSession(5_000, async () => {
    const signal = runtimeHookSignal();
    assert.equal(privateProcessOptions().signal, signal);
    assert.equal(privateProcessOptions().signal, signal);
  });
  assert.equal(runtimeHookSignal(), undefined);
});

test("Windows hook ACL transport executes the original owner-only verification for special paths", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trelio-hook-acl-worker-"));
  const directory = path.join(root, "spaces Ж ' $() ; [path]");
  const file = path.join(directory, "private.json");
  try {
    await mkdir(directory);
    await writeFile(file, "{}\n");
    await withRuntimeHookPrivateSession(8_000, async () => {
      // Repeated calls are real descriptor checks inside the same process.
      await hardenWindowsPrivatePath(directory, "directory");
      await hardenWindowsPrivatePath(file, "file");
      await hardenWindowsPrivatePath(file, "file");
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
