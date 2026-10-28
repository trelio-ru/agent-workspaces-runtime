import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMcpStartupTrace } from "../host-runtime/scripts/trelio-mcp-startup-trace.mjs";
import { detectAgentRuntimeAttestation } from "../host-runtime/scripts/trelio-runtime-attestation.mjs";

test("removed MCP profiles fail before spawning a host or reading another client", async () => {
  for (const args of [["gigacode"], ["gigacode", "--token"], ["unknown"]]) {
    let spawned = false;
    await assert.rejects(runHostRuntime({ rawArguments: ["mcp", ...args],
      spawnProcess: () => { spawned = true; throw new Error("must not spawn"); },
    }), /TRELIO_MCP_ARGUMENTS_UNSUPPORTED/);
    assert.equal(spawned, false);
  }
});

test("unsupported imported hooks cannot borrow Codex or Claude model evidence", async () => {
  const observed = await detectAgentRuntimeAttestation({
    hookInput: { session_id: "synthetic-session", model: "gpt-6.1-sol",
      effort: { level: "ultra" }, transcript_path: "/must-not-read" },
    environment: { GIGACODE_PROJECT_DIR: "/synthetic-root",
      CODEX_THREAD_ID: "inherited", CLAUDE_CODE_ENTRYPOINT: "inherited" },
  });
  assert.equal(observed.clientFamily, "other");
  assert.equal(observed.source, "unknown");
  assert.equal(observed.evidenceLevel, "unavailable");
  assert.equal(observed.modelId, null);
  assert.equal(observed.effortLevel, null);
});
import { RUNTIME_HOOK_START_TIME_ENV } from "../host-runtime/scripts/trelio-runtime-session-limits.mjs";

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

test("assistant bridge profile selects its own entrypoint and rejects unknown commands before spawn", () => {
  for (const command of ["mcp", "hook", "request", "background", "background-install", "background-status", "background-start", "background-remove"]) {
    const invocation = resolveHostRuntimeInvocation(["bridge", "assistant", command]);
    assert.equal(invocation.profile, "assistant");
    assert.equal(path.basename(invocation.entrypointPath), "trelio-assistant-entry.mjs");
    assert.deepEqual(invocation.arguments, [command]);
  }
  for (const args of [["bridge", "assistant"], ["bridge", "assistant", "login"],
    ["bridge", "assistant", "mcp", "--human"]]) {
    assert.throws(() => resolveHostRuntimeInvocation(args), /ASSISTANT_COMMAND_UNSUPPORTED/);
  }
});

test("assistant hook retains the hook clock and never consumes a human Run cwd handoff", async () => {
  let observed;
  await runHostRuntime({ rawArguments: ["bridge", "assistant", "hook"],
    environment: { TRELIO_PLUGIN_VERSION: "3.2.3", TRELIO_HOST_RUNTIME_VERSION: "3.8.12",
      TRELIO_HOST_RUNTIME_UPDATE_REEXEC: "1", TRELIO_HOST_RUNTIME_BRIDGE_CWD: path.resolve("human-run"),
      [RUNTIME_HOOK_START_TIME_ENV]: "1000" },
    spawnProcess: (_command, args, options) => {
      observed = { args, options };
      const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 0)); return child;
    },
  });
  assert.equal(observed.options.env[RUNTIME_HOOK_START_TIME_ENV], "1000");
  assert.equal(observed.options.env.TRELIO_HOST_RUNTIME_BRIDGE_CWD, undefined);
  assert.notEqual(observed.options.cwd, path.resolve("human-run"));
  assert.deepEqual(observed.args.slice(1), ["hook"]);
});

test("assistant installer policy crosses the signed runtime entry and the managed setup boundary", async () => {
  const { runAssistantEntry } = await import("../host-runtime/scripts/trelio-assistant-entry.mjs");
  for (const enabled of [true, false]) {
    let received, setup, output = "";
    await runHostRuntime({ rawArguments: ["bridge", "assistant", "background-install", `--auto-update-plugin=${enabled ? "on" : "off"}`],
      environment: { TRELIO_PLUGIN_VERSION: "3.2.4", TRELIO_HOST_RUNTIME_VERSION: "3.21.1" },
      spawnProcess: (_command, args) => {
        received = args;
        const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 0)); return child;
      },
    });
    assert.equal(path.basename(received[0]), "trelio-assistant-entry.mjs");
    await runAssistantEntry(received.slice(1), {
      createBackground: async () => async (operation, options) => { setup = { operation, options }; return { installed: true }; },
      output: { write: text => { output += text; } },
    });
    assert.deepEqual(setup, { operation: "install", options: { autoUpdatePlugin: enabled } });
    assert.deepEqual(JSON.parse(output), { installed: true });
  }
  for (const args of [
    ["background-start", "--auto-update-plugin=on"], ["background-install", "--auto-update-plugin=true"],
    ["background-install", "--auto-update-plugin=on", "extra"], ["background-install", "--auto-update-plugin=off", "--auto-update-plugin=on"],
  ]) {
    let spawned = false;
    await assert.rejects(runHostRuntime({ rawArguments: ["bridge", "assistant", ...args],
      spawnProcess: () => { spawned = true; throw Error("must not spawn"); },
    }), /ASSISTANT_COMMAND_UNSUPPORTED/);
    assert.equal(spawned, false);
  }
});

test('Desktop opt-in crosses BOTH entry boundaries separately and rejects duplicate/foreign flags',async()=>{
  const {runAssistantEntry}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  for(const flags of [['--auto-update-codex=on'],['--auto-update-codex=off'],['--auto-update-plugin=on','--auto-update-codex=on']]){
    const route=resolveHostRuntimeInvocation(['bridge','assistant','background-install',...flags]);let actual;
    await runAssistantEntry(route.arguments,{createBackground:async()=>async(operation,options)=>{actual={operation,options};return {};},output:{write:()=>{}}});
    assert.equal(actual.operation,'install');assert.equal(actual.options.autoUpdateCodex,flags[0].endsWith('=off')?false:true);
    assert.equal(actual.options.autoUpdatePlugin,flags.length===2?true:undefined);
  }
  for(const flags of [['--auto-update-codex=true'],['--auto-update-codex=on','--auto-update-codex=off'],['--auto-update-codex=on','extra']]){
    assert.throws(()=>resolveHostRuntimeInvocation(['bridge','assistant','background-install',...flags]),/COMMAND_UNSUPPORTED/);
    await assert.rejects(runAssistantEntry(['background-install',...flags]),/COMMAND_UNSUPPORTED/);
  }
});

test("actual runtime assistant MCP discovers setup and broken hooks deny without human auth", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-assistant-entry-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL("../host-runtime/scripts/trelio-host-runtime-entry.mjs", import.meta.url));
  const env = { ...process.env, HOME: directory, USERPROFILE: directory,
    LOCALAPPDATA: path.join(directory, "local"), XDG_CACHE_HOME: path.join(directory, "cache"),
    CODEX_HOME: path.join(directory, "codex"), TRELIO_PLUGIN_VERSION: "3.2.3", TRELIO_HOST_RUNTIME_VERSION: "3.8.12" };
  const input = [{ jsonrpc: "2.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" }].map(JSON.stringify).join("\n") + "\n";
  const mcp = spawnSync(process.execPath, [entry, "bridge", "assistant", "mcp"], { env, input, encoding: "utf8", timeout: 20_000 });
  assert.equal(mcp.status, 0, mcp.stderr);
  const messages = mcp.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(messages[0].result.serverInfo.name, "trelio-assistant");
  assert.deepEqual(messages[1].result.tools.map(tool => tool.name),
    ["begin_assistant_setup", "finish_assistant_setup", "get_assistant_setup_status", "install_assistant_background", "get_assistant_background_status", "start_assistant_background"]);
  const hook = spawnSync(process.execPath, [entry, "bridge", "assistant", "hook"], { env, input: "invalid", encoding: "utf8", timeout: 20_000 });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(JSON.parse(hook.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(await fs.readdir(directory), [], "discovery/denial must not create private state or mutate human configuration");
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

test("only an exact hook upgrade retains its earlier startup clock", async () => {
  for (const mode of ["hook", "bridge", "mcp"]) {
    for (const recovery of [false, true]) {
      let childEnvironment;
      const before = Date.now();
      await runHostRuntime({ rawArguments: [mode],
        environment: { TRELIO_PLUGIN_VERSION: "3.2.3", TRELIO_HOST_RUNTIME_VERSION: "3.8.12",
          [RUNTIME_HOOK_START_TIME_ENV]: "1000",
          ...(recovery ? { TRELIO_HOST_RUNTIME_UPDATE_REEXEC: "1" } : {}) },
        spawnProcess: (_command, _args, options) => {
          childEnvironment = options.env;
          const child = new EventEmitter();
          queueMicrotask(() => child.emit("exit", 0));
          return child;
        },
      });
      if (mode !== "hook") assert.equal(childEnvironment[RUNTIME_HOOK_START_TIME_ENV], undefined);
      else if (recovery) assert.equal(childEnvironment[RUNTIME_HOOK_START_TIME_ENV], "1000");
      else {
        const startedAt = Number(childEnvironment[RUNTIME_HOOK_START_TIME_ENV]);
        assert.ok(startedAt > 1000 && startedAt <= before);
        assert.ok(startedAt <= Date.now() - process.uptime() * 1_000 + 10);
      }
    }
  }
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
