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
    assert.equal(attempts, 1);
    reporter.close();
    reporter.record("continue_trelio_workspace_action", {}, "UNKNOWN");
    await reporter.flush();
    assert.equal(attempts, 1);
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
    assert.equal(batches[0][0].outcomes[0].count, 4);
    await reporter.flush();
    assert.equal(batches[2][0].outcomes[0].count, 1);
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
  assert.equal(reports[0].code, "TRELIO_WORKSPACE_INPUT_INVALID_VALUE");
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
  assert.equal(reports.length, 2);
  assert.equal(reports[1].code, "REMOTE_MCP_PROVIDER_ERROR");
});

// Regression for the observed amplification bug: timeout must not start four
// parallel protected-store reads, and a late read must never initiate HTTP.
import { createObservationTransport } from "../host-runtime/scripts/trelio-diagnostic-reporter.mjs";
import { buildDiagnosticObservation, isDiagnosticObservation } from "../host-runtime/scripts/trelio-diagnostic-observation.mjs";
import { writeDiagnosticJournal, readDiagnosticJournal, acknowledgeDiagnosticJournal } from "../host-runtime/scripts/trelio-diagnostic-journal.mjs";
import { recordRuntimeHookDiagnostic } from "../host-runtime/scripts/trelio-runtime-session.mjs";
import { TrelioApiError } from "../host-runtime/scripts/trelio-workspace.mjs";
import contract from "../host-runtime/scripts/trelio-agent-diagnostics-contract.json" with { type: "json" };
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test("late credential read is single-flight and cannot fetch after timeout or shutdown", async () => {
  let reads = 0, requests = 0, release;
  const transport = createObservationTransport({ readToken: async () => { reads++; return new Promise(resolve => { release = resolve; }); },
    fetchImpl: async () => { requests++; throw Error("must not fetch"); } });
  const reporter = createAgentDiagnosticReporter({ origin: "https://fixture.invalid", journal: null,
    send: transport, timeoutMs: 5, delayMs: 60000, retryDelays: [0, 0, 0] });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    reporter.record("continue_trelio_workspace_action", {operation: "open"}, "UNKNOWN");
    await reporter.flush();
    for (let i = 0; i < 3; i++) await reporter.flush();
    assert.equal(reads, 1); assert.equal(reporter.health().inFlight, true);
    release("synthetic"); await sleep(20);
    assert.equal(requests, 0); assert.equal(reporter.health().inFlight, false);
    assert.equal(reporter.health().losses.delivery_timeout, 1);
  } finally { reporter.close(); clearInterval(keepAlive); }
});
test("one credential read and exact immutable paired samples across three network retries", async () => {
  let reads = 0, posts = 0; const bodies = [];
  const transport = createObservationTransport({ readToken: async () => { reads++; return "synthetic"; },
    fetchImpl: async (url, options) => {
      if (url.pathname.endsWith("capabilities")) return new Response(JSON.stringify({schemaVersion: 2, errorCodes: contract.errorCodes}));
      posts++; bodies.push(options.body);
      return new Response(null, {status: posts < 4 ? 503 : 204});
    } });
  const reporter = createAgentDiagnosticReporter({ origin: "https://fixture.invalid", journal: null,
    send: transport, delayMs: 60000, retryDelays: [0, 0, 0] });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    reporter.record("continue_trelio_workspace_action", {operation: "open"});
    reporter.record("continue_trelio_workspace_action", {operation: "open"}, "UNKNOWN");
    await reporter.flush();
    assert.equal(reads, 1); assert.equal(posts, 4); assert.equal(new Set(bodies).size, 1);
    assert.deepEqual(JSON.parse(bodies[0]).samples[0].outcomes.map(r => [r.code,r.count]), [["OK",1],["UNKNOWN",1]]);
  } finally { reporter.close(); clearInterval(keepAlive); }
});
test("catalog negotiation downgrades unknown codes without dropping the batch or its denominator", async () => {
  let body;
  const transport = createObservationTransport({ readToken: async () => "synthetic", fetchImpl: async (url, options) => {
    if (url.pathname.endsWith("capabilities")) return new Response(JSON.stringify({ schemaVersion: 2, errorCodes: ["UNKNOWN", "DIAGNOSTICS_CODE_UNSUPPORTED"] }));
    body = JSON.parse(options.body); return new Response(null, {status: 204});
  } });
  const sample = buildDiagnosticObservation("continue_trelio_workspace_action", {operation: "open"}, "TRELIO_WINDOWS_PRIVATE_ACL_FAILED");
  sample.outcomes.push({code: "OK",field:"unknown",count:9});
  await transport("https://fixture.invalid", [sample]);
  assert.deepEqual(body.samples[0].outcomes.map(r=>r.code), ["DIAGNOSTICS_CODE_UNSUPPORTED","OK"]);
  assert.deepEqual(body.samples[0].losses, [{reason:"catalog_mismatch",count:1}]);
  assert.equal(isDiagnosticObservation(body.samples[0]),true);
});
test("missing effort is a data-loss signal alongside success and safely negotiates older servers", async () => {
  for (const advertised of [true, false]) {
    let body;
    const transport = createObservationTransport({ readToken: async () => "synthetic", fetchImpl: async (url, options) => {
      if (url.pathname.endsWith("capabilities")) return new Response(JSON.stringify({ schemaVersion: 2,
        errorCodes: contract.errorCodes, ...(advertised ? { lossReasons: contract.lossReasons } : {}) }));
      body = JSON.parse(options.body); return new Response(null, { status: 204 });
    } });
    const sample = buildDiagnosticObservation("runtime_hook", { operation: "PreToolUse" }, "OK", { boundary: "hook" });
    sample.losses = [{ reason: "effort_observation_unavailable", count: 1 }];
    await transport("https://fixture.invalid", [sample]);
    assert.deepEqual(body.samples[0].outcomes, [{ code: "OK", field: "unknown", count: 1 }]);
    assert.deepEqual(body.samples[0].losses, [{ reason: advertised ? "effort_observation_unavailable" : "catalog_mismatch", count: 1 }]);
    assert.equal(body.samples[0].id, sample.id);
    assert.equal(isDiagnosticObservation(body.samples[0]), true);
  }
});
test("journal is bounded content-free input, rejects pollution, expires records and acknowledges exact UUIDs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trelio-diagnostic-test-"));
  try {
    const sample = buildDiagnosticObservation("runtime_hook", {operation:"PreToolUse"}, "TRELIO_WINDOWS_PRIVATE_DPAPI_FAILED", {boundary:"hook"});
    assert.equal(await writeDiagnosticJournal("fixture", {...sample, message:"PRIVATE_CANARY"}, {directory}), "journal_invalid");
    assert.equal(await writeDiagnosticJournal("fixture", sample, {directory}), "queued");
    let read = await readDiagnosticJournal("fixture", {directory}); assert.deepEqual(read.samples,[sample]);
    assert.doesNotMatch(JSON.stringify(read),/PRIVATE_CANARY/);
    await acknowledgeDiagnosticJournal("fixture", read.samples, {directory});
    assert.equal((await readDiagnosticJournal("fixture", {directory})).samples.length,0);
    await writeDiagnosticJournal("fixture",sample,{directory});
    await fs.utimes(path.join(directory,sample.id+".json"),new Date(0),new Date(0));
    read=await readDiagnosticJournal("fixture",{directory}); assert.equal(read.losses.journal_expired,1);
    for (let i=0;i<256;i++) await fs.writeFile(path.join(directory,"foreign-"+i),"");
    assert.equal(await writeDiagnosticJournal("fixture",sample,{directory}),"journal_full");
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});
test("hook failures can be recorded with no credential access and never replace the hook result", async () => {
  const samples=[];
  await recordRuntimeHookDiagnostic("PreToolUse","TRELIO_WINDOWS_PRIVATE_PROCESS_START_FAILED", {origin:"https://fixture.invalid",write:async(_origin,s)=>samples.push(s)});
  assert.equal(samples[0].boundary,"hook"); assert.equal(samples[0].outcomes[0].code,"TRELIO_WINDOWS_PRIVATE_PROCESS_START_FAILED");
  await recordRuntimeHookDiagnostic("SessionEnd","OK",{write:async()=>{throw Error("PRIVATE_CANARY");}});
});
test("HTTP failures keep closed backend codes or an exact status class without reading payloads", async () => {
  const reports=[];
  const request={jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"continue_trelio_workspace_action",arguments:{operation:"open"}}};
  for (const [status, code, expected] of [[503,"PRIVATE_CANARY","TRELIO_BACKEND_HTTP_5XX"],[409,"LEASE_EXPIRED","LEASE_EXPIRED"],[401,null,"TRELIO_BACKEND_HTTP_401"]]) {
    await handleLocalMcpMessage(request,{callTool:async()=>{throw new TrelioApiError(status,"PRIVATE_CANARY",null,code);},recordDiagnostic:(_tool,_args,code)=>reports.push(code)});
    assert.equal(reports.at(-1),expected);
  }
});
