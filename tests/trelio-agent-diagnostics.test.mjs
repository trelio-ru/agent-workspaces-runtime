import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentDiagnosticEvent, createAgentDiagnosticReporter, sendAgentDiagnosticBatch } from "../host-runtime/scripts/trelio-agent-diagnostics.mjs";
import { handleLocalMcpMessage } from "../host-runtime/scripts/trelio-remote-mcp.mjs";
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
