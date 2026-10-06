import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  HostRuntimeRecoveryError, parseHostRuntimeRecoveryError,
  prepareHostRuntimeUpgrade, resolveHostRuntimeLoader, runHostRuntimeUpdater,
} from "../host-runtime/scripts/trelio-host-runtime-recovery.mjs";
import { recoverHookHostRuntimeUpgrade, formatRuntimeHookFailure } from "../host-runtime/scripts/trelio-runtime-session.mjs";
import { TrelioApiError, recoverBridgeHostRuntimeUpgrade, formatBridgeCommandError } from "../host-runtime/scripts/trelio-workspace.mjs";
import { startHostRuntimeMcpDelegate, handleLocalMcpMessage } from "../host-runtime/scripts/trelio-remote-mcp.mjs";

const gate = () => new TrelioApiError(409, "synthetic gate", null, "AGENT_WORKSPACE_HOST_RUNTIME_UPGRADE_REQUIRED");
const fixture = async (t, source = "") => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pluginRoot = path.join(root, "loaded shell");
  const loader = path.join(pluginRoot, "scripts", "trelio-host-runtime-loader.mjs");
  await fs.mkdir(path.dirname(loader), { recursive: true });
  await fs.writeFile(loader, source);
  return { pluginRoot, loader, environment: { ...process.env, TRELIO_PLUGIN_ROOT: pluginRoot } };
};
const failureIs = (reason, code = "TRELIO_HOST_RUNTIME_RECOVERY_FAILED") => (error) => {
  assert.equal(error.code, code);
  assert.equal(error.details.reason, reason);
  assert.doesNotMatch(JSON.stringify(error), /PRIVATE_CANARY/u);
  return true;
};
const delegateOptions = { initializeParams: { capabilities: {} }, enqueueResponse: async () => {} };

test("all three runtime entrypoints diagnose the deleted exact shell without executing or scanning another version", async (t) => {
  const f = await fixture(t);
  await fs.rm(f.pluginRoot, { recursive: true });
  // An unrelated installed version must not become an implicit fallback.
  await fs.mkdir(path.join(f.pluginRoot, "..", "other-shell"));
  const spawnProcess = () => assert.fail("missing shell must not spawn");
  const expected = failureIs("loaded_plugin_unavailable", "TRELIO_PLUGIN_RESTART_REQUIRED");
  await assert.rejects(recoverHookHostRuntimeUpgrade(gate(), {}, { environment: f.environment, runUpdate: spawnProcess }), expected);
  const bridge = await recoverBridgeHostRuntimeUpgrade(gate(), { environment: f.environment, spawnProcess });
  assert.equal(bridge.handled, false);
  expected(bridge.error);
  assert.equal(JSON.parse(formatBridgeCommandError(bridge.error)).details.originalCode, gate().code);
  assert.match(formatRuntimeHookFailure(bridge.error), /TRELIO_PLUGIN_RESTART_REQUIRED/u);
  await assert.rejects(startHostRuntimeMcpDelegate({ ...delegateOptions, environment: f.environment, spawnProcess }), expected);
});

test("permission, invalid-file and filesystem failures stay distinct from absence across entrypoints", async (t) => {
  const f = await fixture(t);
  for (const osCode of ["EACCES", "EPERM", "EIO"]) {
    const statFile = async () => { throw Object.assign(new Error("PRIVATE_CANARY"), { code: osCode }); };
    const expected = failureIs(osCode === "EIO" ? "loader_inspection_failed" : "loader_access_denied");
    await assert.rejects(recoverHookHostRuntimeUpgrade(gate(), {}, { environment: f.environment, statFile }), expected);
    expected((await recoverBridgeHostRuntimeUpgrade(gate(), { environment: f.environment, statFile })).error);
    await assert.rejects(startHostRuntimeMcpDelegate({ ...delegateOptions, environment: f.environment, statFile }), expected);
  }
  await assert.rejects(resolveHostRuntimeLoader({ environment: f.environment,
    accessFile: async () => { throw Object.assign(new Error("PRIVATE_CANARY"), { code: "EACCES" }); },
  }), failureIs("loader_access_denied"));
  await fs.rm(f.loader);
  await fs.mkdir(f.loader);
  await assert.rejects(resolveHostRuntimeLoader({ environment: f.environment }), failureIs("loader_invalid"));
  // Metadata fixture also covers symlinks without requiring Windows symlink privileges.
  await assert.rejects(resolveHostRuntimeLoader({ environment: f.environment,
    statFile: async () => ({ isFile: () => true, isSymbolicLink: () => true }),
  }), failureIs("loader_invalid"));
  await assert.rejects(resolveHostRuntimeLoader({ environment: {} }), failureIs("shell_identity_unavailable"));
});

test("recovery detects removal both after a successful update and after an ambiguous loader exit", async (t) => {
  for (const fail of [false, true]) {
    const f = await fixture(t);
    await assert.rejects(prepareHostRuntimeUpgrade({ environment: f.environment,
      runUpdate: async () => {
        await fs.rm(f.pluginRoot, { recursive: true });
        if (fail) throw new Error("PRIVATE_CANARY");
      },
    }), failureIs("loaded_plugin_unavailable", "TRELIO_PLUGIN_RESTART_REQUIRED"));
  }
});

test("the hook detects a deletion during replay without emitting the old runtime gate advice", async (t) => {
  const f = await fixture(t);
  await assert.rejects(recoverHookHostRuntimeUpgrade(gate(), {}, {
    environment: f.environment, runUpdate: async () => {},
    runProcess: async () => { await fs.rm(f.pluginRoot, { recursive: true }); return 1; },
  }), failureIs("loaded_plugin_unavailable", "TRELIO_PLUGIN_RESTART_REQUIRED"));
});

test("real updater subprocess uses the stable loader and projects only its bounded diagnostic ABI", async (t) => {
  for (const [diagnostic, reason] of [
    [{ stage: "metadata_headers", reason: "network" }, "update_transport_failed"],
    [{ stage: "package_body", reason: "timeout" }, "update_timeout"],
    [{ stage: "metadata_headers", reason: "http", httpStatus: 503 }, "update_transport_failed"],
    [{ stage: "metadata_headers", reason: "http", httpStatus: 403 }, "update_rejected"],
    [{ stage: "package_body", reason: "response_too_large" }, "update_rejected"],
    [{ stage: "PRIVATE_CANARY", reason: "network" }, "update_failed"],
  ]) {
    const wire = "Trelio host runtime loader failed: " + JSON.stringify({
      code: "TRELIO_HOST_RUNTIME_UPDATE_FAILED", ...diagnostic, url: "PRIVATE_CANARY", message: "PRIVATE_CANARY",
    });
    const f = await fixture(t, `if (process.argv[2] !== "__update" || process.env.TRELIO_HOST_RUNTIME_UPDATE_WAIT_FOR_LOCK !== "1") process.exit(9);\nprocess.stderr.write(${JSON.stringify(wire)}); process.exitCode = 1;`);
    await assert.rejects(prepareHostRuntimeUpgrade({ environment: f.environment }), failureIs(reason));
  }
});

test("unstructured signature failures and oversized output do not authorize restart or expose stderr", async (t) => {
  for (const output of ["signature rejected PRIVATE_CANARY", "PRIVATE_CANARY".repeat(2000)]) {
    const f = await fixture(t, `process.stderr.write(${JSON.stringify(output)}); process.exitCode = 1;`);
    await assert.rejects(prepareHostRuntimeUpgrade({ environment: f.environment }), failureIs("update_failed"));
  }
});

test("updater awaits stderr close after exit and never inherits private output", async (t) => {
  const f = await fixture(t);
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  await assert.rejects(runHostRuntimeUpdater(f.loader, { spawnProcess: (_command, args, options) => {
    assert.deepEqual(args, [f.loader, "__update"]);
    assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe"]);
    queueMicrotask(() => {
      child.emit("exit", 1);
      child.stderr.write('Trelio host runtime loader failed: {"code":"TRELIO_HOST_RUNTIME_UPDATE_FAILED","stage":"metadata_headers","reason":"network"}');
      child.emit("close", 1);
    });
    return child;
  } }), failureIs("update_transport_failed"));
});

test("update timeout kills its child and hook abort retains the original deadline error", async (t) => {
  const f = await fixture(t);
  let killed = 0;
  const child = new EventEmitter();
  child.kill = () => { killed += 1; };
  await assert.rejects(prepareHostRuntimeUpgrade({ environment: f.environment,
    spawnProcess: () => child, timeoutMs: 5,
  }), failureIs("update_timeout"));
  assert.equal(killed, 1);
  const controller = new AbortController();
  const deadline = new Error("synthetic hook deadline");
  await assert.rejects(prepareHostRuntimeUpgrade({ environment: f.environment, signal: controller.signal,
    runUpdate: async () => { controller.abort(deadline); throw new Error("cancelled"); },
  }), (error) => error === deadline);
});

test("recovery errors survive bridge parsing and MCP projection without exposing untrusted fields", async () => {
  const original = new HostRuntimeRecoveryError("loaded_plugin_unavailable", { originalCode: gate().code });
  const encoded = JSON.parse(JSON.stringify(original));
  encoded.message = "PRIVATE_CANARY";
  encoded.details.path = "PRIVATE_CANARY";
  encoded.details.requiredAction = "PRIVATE_CANARY";
  const parsed = parseHostRuntimeRecoveryError(`node: PRIVATE_CANARY\nОшибка: ${JSON.stringify(encoded)}`);
  assert.deepEqual(parsed.toJSON(), original.toJSON());
  assert.equal(parseHostRuntimeRecoveryError(`Ошибка: ${JSON.stringify({ ...encoded, code: "other" })}`), null);
  assert.equal(parseHostRuntimeRecoveryError(`Ошибка: ${"x".repeat(17000)}`), null);
  const response = await handleLocalMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "probe" } }, {
    callTool: async () => { throw gate(); },
    runtimeUpgradeRecovery: async () => { throw original; },
  });
  assert.equal(response.result.isError, true);
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.code, original.code);
  assert.deepEqual(payload.details, original.details);
});

test("only the two pre-operation gates may recover, and hook/bridge reexec is once only", async () => {
  const options = { environment: { TRELIO_HOST_RUNTIME_UPDATE_REEXEC: "1" },
    runUpdate: () => assert.fail("no second update"), spawnProcess: () => assert.fail("no second update") };
  assert.equal(await recoverHookHostRuntimeUpgrade(gate(), {}, options), null);
  assert.equal((await recoverBridgeHostRuntimeUpgrade(gate(), options)).handled, false);
  for (const code of ["FETCH_FAILED", "HTTP_503", "AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED"]) {
    const error = new TrelioApiError(503, "synthetic refusal", null, code);
    assert.equal(await recoverHookHostRuntimeUpgrade(error, {}, options), null);
    assert.equal((await recoverBridgeHostRuntimeUpgrade(error, options)).handled, false);
    let calls = 0;
    await handleLocalMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "probe" } }, {
      callTool: async () => { calls++; throw error; },
      runtimeUpgradeRecovery: async () => assert.fail("ordinary failure must not retry"),
    });
    assert.equal(calls, 1);
  }
});

test("MCP detects shell removal before nested initialize without forwarding an operation", async (t) => {
  const f = await fixture(t);
  let spawns = 0;
  await assert.rejects(startHostRuntimeMcpDelegate({ ...delegateOptions,
    environment: f.environment,
    spawnProcess: (_command, args) => {
      spawns++;
      const child = new EventEmitter();
      child.kill = () => {};
      if (args.at(-1) === "__update") {
        queueMicrotask(() => child.emit("close", 0));
      } else {
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stdin.on("data", (chunk) => {
          assert.equal(JSON.parse(chunk).method, "initialize");
          void fs.rm(f.pluginRoot, { recursive: true }).then(() => child.emit("exit", 1));
        });
      }
      return child;
    },
  }), failureIs("loaded_plugin_unavailable", "TRELIO_PLUGIN_RESTART_REQUIRED"));
  assert.equal(spawns, 2);
});

test("bridge failure after replay checks shell loss but preserves an unknown operation outcome", async (t) => {
  for (const removeShell of [false, true]) {
    const f = await fixture(t);
    const modes = [];
    const recovery = await recoverBridgeHostRuntimeUpgrade(gate(), {
      environment: f.environment, rawArguments: ["finish"],
      spawnProcess: (_command, args) => {
        const child = new EventEmitter();
        modes.push(args[1]);
        if (args[1] === "__update") queueMicrotask(() => child.emit("close", 0));
        else void (async () => {
          await Promise.resolve();
          if (removeShell) await fs.rm(f.pluginRoot, { recursive: true });
          child.emit("exit", 7);
        })();
        return child;
      },
    });
    assert.deepEqual(modes, ["__update", "bridge"]);
    if (removeShell) {
      assert.equal(recovery.handled, false);
      assert.equal(recovery.error.code, "TRELIO_PLUGIN_RESTART_REQUIRED");
      assert.equal(recovery.error.details.operationOutcome, "unknown");
      assert.match(recovery.error.message, /проверьте результат исходной операции/u);
    } else assert.deepEqual(recovery, { handled: true, exitCode: 7 });
  }
});

test("MCP observes an early initialize write rejection and keeps private process errors out of recovery", async (t) => {
  const f = await fixture(t);
  await assert.rejects(startHostRuntimeMcpDelegate({ ...delegateOptions, environment: f.environment,
    spawnProcess: (_command, args) => {
      const child = new EventEmitter();
      child.kill = () => {};
      if (args.at(-1) === "__update") queueMicrotask(() => child.emit("close", 0));
      else {
        child.stdout = new PassThrough();
        child.stdin = { write: (_frame, callback) => {
          const error = new Error("PRIVATE_CANARY");
          child.emit("error", error);
          callback(error);
        } };
      }
      return child;
    },
  }), failureIs("handoff_failed"));
});
