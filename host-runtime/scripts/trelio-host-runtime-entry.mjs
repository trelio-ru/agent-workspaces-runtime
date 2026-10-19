#!/usr/bin/env node

/**
 * Единый entrypoint independently released Trelio host runtime.
 *
 * Stable plugin shell знает только этот маленький контракт. Runtime package
 * может менять внутренние bridge, hook и MCP implementation без изменения
 * plugin manifest и без удаления Codex plugin cache, откуда уже работают
 * открытые задачи.
 */
import { startMirrorCacheMaintenance } from "./trelio-mirror-retention.mjs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireTrelioComponentVersions } from "./trelio-component-versions.mjs";
import { isDirectModuleInvocation } from "./trelio-local-path.mjs";
import { createMcpStartupTrace } from "./trelio-mcp-startup-trace.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const MODE_ENTRYPOINTS = Object.freeze({
  bridge: "trelio-workspace.mjs",
  hook: "trelio-runtime-session.mjs",
  mcp: "trelio-remote-mcp.mjs",
});

export const resolveHostRuntimeInvocation = (rawArguments) => {
  const [mode, ...argumentsAfterMode] = rawArguments;
  const entrypointName = MODE_ENTRYPOINTS[mode];

  if (!entrypointName) {
    throw new Error("Trelio host runtime ожидает mode bridge, hook или mcp.");
  }

  return {
    mode,
    entrypointPath: path.join(SCRIPT_DIRECTORY, entrypointName),
    arguments: argumentsAfterMode,
  };
};

export const runHostRuntime = async ({
  rawArguments = process.argv.slice(2),
  spawnProcess = spawn,
  environment = process.env,
  startupTrace = createMcpStartupTrace({ environment }),
} = {}) => {
  const invocation = resolveHostRuntimeInvocation(rawArguments);
  // A downloaded runtime is meaningful only together with the exact shell and
  // runtime releases selected by the signed loader. Rejecting an incomplete
  // launch here keeps every child mode from inventing a stale fallback version.
  requireTrelioComponentVersions(environment);
  if (invocation.mode === "mcp") startupTrace("runtime_entry");

  // The signed loader selects/verifies the runtime from its own immutable
  // directory. A bridge hard-gate replay must still run inside the original
  // Workspace: cwd is part of that invocation, not the downloaded package.
  // Consume the host-only handoff exactly once and only for bridge recovery;
  // hook/MCP and ordinary startup retain the established package cwd. Run ACL,
  // origin, metadata and fencing remain validated by the bridge itself.
  const handoffDirectory = environment.TRELIO_HOST_RUNTIME_BRIDGE_CWD;
  const bridgeHandoff = invocation.mode === "bridge"
    && environment.TRELIO_HOST_RUNTIME_UPDATE_REEXEC === "1"
    && handoffDirectory !== undefined;
  if (bridgeHandoff && (typeof handoffDirectory !== "string"
    || !path.isAbsolute(handoffDirectory) || handoffDirectory.includes("\0"))) {
    throw new Error("TRELIO_HOST_RUNTIME_BRIDGE_CWD must be an absolute local directory.");
  }
  const childEnvironment = { ...environment };
  delete childEnvironment.TRELIO_HOST_RUNTIME_BRIDGE_CWD;

  return await new Promise((resolve, reject) => {
    // Запускаем exact Node, которым stable shell уже был запущен. Это не
    // зависит от PATH и не допускает смены runtime между loader и payload.
    const child = spawnProcess(
      process.execPath,
      [invocation.entrypointPath, ...invocation.arguments],
      {
        cwd: bridgeHandoff ? handoffDirectory : path.resolve(SCRIPT_DIRECTORY, ".."),
        env: childEnvironment,
        shell: false,
        stdio: "inherit",
        windowsHide: true,
      },
    );
    // Marks spawn returning, not child readiness or successful initialize.
    if (invocation.mode === "mcp") startupTrace("mcp_spawn");

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
};

if (isDirectModuleInvocation(import.meta.url)) {
  Promise.resolve().then(() => {
    // Reject invalid modes/versions before even optional cache maintenance.
    resolveHostRuntimeInvocation(process.argv.slice(2));
    requireTrelioComponentVersions(process.env);
    startMirrorCacheMaintenance();
    return runHostRuntime();
  })
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`Trelio host runtime failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
