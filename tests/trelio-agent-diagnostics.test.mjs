import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentDiagnosticEvent, createAgentDiagnosticReporter, sendAgentDiagnosticBatch } from "../host-runtime/scripts/trelio-agent-diagnostics.mjs";
import { handleLocalMcpMessage } from "../host-runtime/scripts/trelio-remote-mcp.mjs";
import { TrelioLocalContextError } from "../host-runtime/scripts/trelio-local-context.mjs";
import { ProcessDiagnosticError, PROCESS_DIAGNOSTIC_CODES, parseProcessDiagnostic, skillRuntimeExitError } from "../host-runtime/scripts/trelio-process-diagnostics.mjs";
import { formatBridgeCommandError } from "../host-runtime/scripts/trelio-workspace.mjs";
import { formatRuntimeHookFailure } from "../host-runtime/scripts/trelio-runtime-session.mjs";

test("every process category and local recovery code is admitted by the closed telemetry catalog", () => {
  for (const code of [...PROCESS_DIAGNOSTIC_CODES, "TRELIO_WORKSPACE_LOCAL_RECOVERY_REQUIRED"]) {
    assert.equal(buildAgentDiagnosticEvent("continue_trelio_workspace_action", {}, code).code, code);
  }
});

test("bridge diagnostic frame preserves inner exits and filters arbitrary fields and earlier provider frames", () => {
  for (const exitCode of [1, 2, 3, 4, 5, 6, 7, 3221225781]) {
    const error = skillRuntimeExitError(exitCode);
    const frame = "Ошибка: " + formatBridgeCommandError(error);
    const parsed = parseProcessDiagnostic("PRIVATE_CANARY\n" + frame + "\n");
    assert.equal(parsed.exitCode, exitCode);
    assert.equal(parsed.failureCode, exitCode <= 6 ? `TRELIO_SKILL_RUNTIME_EXIT_${exitCode}` : "TRELIO_SKILL_RUNTIME_EXIT_OTHER");
    assert.equal(parseProcessDiagnostic(frame + "\nОшибка: legacy failure\n"), null);
    assert.equal(parseProcessDiagnostic("x".repeat(65536) + frame), null);
  }
  const payload = { code: "TRELIO_RUNTIME_HOOK_FAILED", message: "PRIVATE_CANARY", details: {
    failureCode: "TRELIO_WINDOWS_PRIVATE_ACL_FAILED", operation: "windows_acl.dacl_verify",
    hookStage: "PRIVATE_CANARY", causeCode: "PRIVATE_CANARY", exitCode: "PRIVATE_CANARY", signal: "PRIVATE_CANARY",
    token: "PRIVATE_CANARY", path: "PRIVATE_CANARY",
  } };
  assert.deepEqual(parseProcessDiagnostic("Ошибка: " + JSON.stringify(payload)), {
    failureCode: "TRELIO_WINDOWS_PRIVATE_ACL_FAILED", operation: "windows_acl.dacl_verify",
  });
  payload.code = "PRIVATE_CANARY";
  assert.equal(parseProcessDiagnostic("Ошибка: " + JSON.stringify(payload)), null);
});

test("dispatcher retains Windows helper public ABI while reporting the exact fixed category", async () => {
  const reports = [];
  const error = new ProcessDiagnosticError("TRELIO_WINDOWS_PRIVATE_PROCESS_START_FAILED", "Не удалось запустить helper.",
    { hookStage: "bridge_credentials", operation: "windows_dpapi.worker_startup", causeCode: "ENOENT", token: "PRIVATE_CANARY" });
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "continue_trelio_workspace_action", arguments: { schemaVersion: 1, operation: "open", parameters: {} },
  } };
  const result = await handleLocalMcpMessage(request, {
    callTool: async () => { throw error; }, recordDiagnostic: (...args) => reports.push(buildAgentDiagnosticEvent(...args)),
  });
  assert.match(JSON.stringify(result.result), /TRELIO_RUNTIME_HOOK_FAILED/u);
  assert.equal(reports[0].code, "TRELIO_WINDOWS_PRIVATE_PROCESS_START_FAILED");
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(reports), /PRIVATE_CANARY/u);
  const hookReason = formatRuntimeHookFailure(error);
  assert.match(hookReason, /TRELIO_WINDOWS_PRIVATE_PROCESS_START_FAILED/u);
  assert.match(hookReason, /windows_dpapi.worker_startup/u);
  assert.doesNotMatch(hookReason, /PRIVATE_CANARY/u);
});
test("unresponsive telemetry is bounded and closing the reporter never waits for it", async () => {
  let attempts = 0;
  const reporter = createAgentDiagnosticReporter({
    delayMs: 60000, timeoutMs: 5, retryDelays: [0, 0, 0],
    send: () => { attempts++; return new Promise(() => {}); },
  });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    reporter.record("continue_trelio_workspace_action", { operation: "skill_run" }, "UNKNOWN");
    await reporter.flush();
    assert.equal(attempts, 4);
    reporter.close();
    reporter.record("continue_trelio_workspace_action", {}, "UNKNOWN");
    await reporter.flush();
    assert.equal(attempts, 4);
  } finally { reporter.close(); clearInterval(keepAlive); }
});

test("unknown fields and values cannot become telemetry content", () => {
  const secret = "PRIVATE /Users/person/file";
  const event = buildAgentDiagnosticEvent(secret, { operation: secret, args: [secret] }, secret, {
    TRELIO_PLUGIN_VERSION: secret, TRELIO_HOST_RUNTIME_VERSION: secret,
  });
  assert.equal(JSON.stringify(event).includes(secret), false);
  assert.deepEqual({ ...event, id: null }, {
    id: null, tool: "unknown", operation: "unknown", code: "UNKNOWN",
    pluginVersion: "0.0.0", runtimeVersion: "0.0.0", count: 1,
  });
});
test("duplicates coalesce; ambiguous retries reuse frozen IDs and never grow their count", async () => {
  const batches = [];
  const reporter = createAgentDiagnosticReporter({
    delayMs: 60000, retryDelays: [0, 0, 0],
    send: async (_origin, batch) => {
      batches.push(structuredClone(batch));
      if (batches.length === 1) {
        reporter.record("continue_trelio_workspace_action", { operation: "skill_run" }, "TRELIO_WORKSPACE_ACTION_INVALID_INPUT");
        throw new Error("lost response");
      }
    },
  });
  // Keep the test loop alive while deliberately unref'ed retry timers run.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    for (let i = 0; i < 4; i++) reporter.record("continue_trelio_workspace_action", { operation: "skill_run" }, "TRELIO_WORKSPACE_ACTION_INVALID_INPUT");
    await reporter.flush();
    assert.deepEqual(batches[0], batches[1]);
    assert.equal(batches[0][0].count, 4);
    await reporter.flush();
    assert.equal(batches[2][0].count, 1);
    assert.notEqual(batches[2][0].id, batches[0][0].id);
  } finally { reporter.close(); clearInterval(keepAlive); }
});
test("missing session never requests login; old/rejected endpoint is terminal; 5xx can retry", async () => {
  let requests = 0;
  await sendAgentDiagnosticBatch("https://example.invalid", [], {
    readToken: async () => null, fetchImpl: async () => { requests++; },
  });
  assert.equal(requests, 0);
  for (const status of [401, 403, 404, 429, 204]) {
    await sendAgentDiagnosticBatch("https://example.invalid", [], {
      readToken: async () => "synthetic-token",
      fetchImpl: async (url, options) => {
        requests++; assert.equal(url.pathname, "/api/agent-workspaces/diagnostics/errors");
        assert.equal(options.redirect, "error");
        return { status };
      },
    });
  }
  await assert.rejects(sendAgentDiagnosticBatch("https://example.invalid", [], {
    readToken: async () => "synthetic-token", fetchImpl: async () => ({ status: 503 }),
  }));
});
test("host reports local validation errors without changing the actual MCP result", async () => {
  const reports = [];
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "continue_trelio_workspace_action",
    arguments: { schemaVersion: 1, operation: "skill_run", parameters: {}, workingDirectory: "/private/canary" },
  } };
  const response = await handleLocalMcpMessage(request, { recordDiagnostic: (...args) => {
    reports.push(buildAgentDiagnosticEvent(...args));
  } });
  assert.equal(response.result.isError, true);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].code, "TRELIO_WORKSPACE_ACTION_INVALID_INPUT");
  assert.equal(reports[0].operation, "skill_run");
  assert.equal(JSON.stringify(reports).includes("/private/canary"), false);
  const again = await handleLocalMcpMessage(request, { recordDiagnostic: () => { throw new Error("telemetry failed"); } });
  assert.deepEqual(again, response);
});

test("dispatcher uses the fixed child category while preserving local recovery and ignoring returned provider errors", async () => {
  const reports = [];
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "continue_trelio_workspace_action",
    arguments: { schemaVersion: 1, operation: "skill_run", parameters: {} },
  } };
  const error = new TrelioLocalContextError("TRELIO_WORKSPACE_ACTION_FAILED", "PRIVATE_CANARY", {
    stdout: "PRIVATE_CANARY", failureCode: "MAX_ASSIST_SNAPSHOT_STALE",
  });
  error.diagnosticCode = "MAX_ASSIST_SNAPSHOT_STALE";
  const recordDiagnostic = (...args) => reports.push(buildAgentDiagnosticEvent(...args));
  const result = await handleLocalMcpMessage(request, {
    callTool: async () => { throw error; }, recordDiagnostic,
  });
  assert.equal(result.result.isError, true);
  assert.match(JSON.stringify(result.result), /TRELIO_WORKSPACE_ACTION_FAILED/u);
  assert.match(JSON.stringify(result.result), /PRIVATE_CANARY/u);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].code, "MAX_ASSIST_SNAPSHOT_STALE");
  assert.equal(JSON.stringify(reports).includes("PRIVATE_CANARY"), false);
  const providerResult = { isError: true, content: [{ type: "text", text: "PRIVATE_CANARY" }] };
  const returned = await handleLocalMcpMessage(request, {
    callTool: async () => providerResult, recordDiagnostic,
  });
  assert.deepEqual(returned.result, providerResult);
  assert.equal(reports.length, 1, "successful transport carrying provider isError is outside telemetry");
});
