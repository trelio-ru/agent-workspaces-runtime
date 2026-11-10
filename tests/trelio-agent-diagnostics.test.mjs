import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from 'node:crypto';
import { buildAgentDiagnosticEvent, createAgentDiagnosticReporter, sendAgentDiagnosticBatch } from "../host-runtime/scripts/trelio-agent-diagnostics.mjs";
import { handleLocalMcpMessage } from "../host-runtime/scripts/trelio-remote-mcp.mjs";
import { TrelioLocalContextError, buildStableCompanyMirror, buildTrelioWorkspaceActionInvocation } from "../host-runtime/scripts/trelio-local-context.mjs";
import { ProcessDiagnosticError, PROCESS_DIAGNOSTIC_CODES, parseProcessDiagnostic, skillRuntimeExitError, skillSetupExitError } from "../host-runtime/scripts/trelio-process-diagnostics.mjs";
import { formatBridgeCommandError, runMaterializedAgentSkill, withWorkspaceExecutionProfile } from "../host-runtime/scripts/trelio-workspace.mjs";
import { formatRuntimeHookFailure } from "../host-runtime/scripts/trelio-runtime-session.mjs";

test('protected Telegram setup retains only a reviewed code and bounded wait across the actual bridge frame', () => {
  const payload = {ok:false,code:'TELEGRAM_PASSWORD_INVALID',error:'PRIVATE_FACTOR',
    details:{diagnostic:{retryAfterSeconds:17,category:'PRIVATE_CATEGORY'},path:'PRIVATE_PATH'},nextAction:{url:'PRIVATE_URL'}};
  const project = (value, options={}) => skillSetupExitError(2,{skillId:'telegram-mtproto',stderr:JSON.stringify(value),...options});
  const error = project(payload);
  const parsed = parseProcessDiagnostic('Ошибка: '+formatBridgeCommandError(error));
  assert.deepEqual(parsed,{failureCode:'TRELIO_SKILL_RUNTIME_EXIT_2',operation:'skill_run',exitCode:2,
    providerCode:'TELEGRAM_PASSWORD_INVALID'});
  assert.equal(project({...payload,code:'TELEGRAM_RATE_LIMITED'}).details.retryAfterSeconds,17);
  assert.doesNotMatch(formatBridgeCommandError(error),/PRIVATE/);
  assert.equal(buildAgentDiagnosticEvent('continue_trelio_workspace_action',{operation:'skill_run'},error.diagnosticCode).code,'TRELIO_SKILL_RUNTIME_EXIT_2');
  for(const code of ['TELEGRAM_CODE_INVALID','TELEGRAM_CODE_EXPIRED','TELEGRAM_PHONE_BANNED',
    'TELEGRAM_PHONE_INVALID','TELEGRAM_QR_EXPIRED','TELEGRAM_RATE_LIMITED','TELEGRAM_PASSWORD_CHECK_EXPIRED',
    'TELEGRAM_APP_INVALID','TELEGRAM_SERVICE_UNAVAILABLE','TELEGRAM_SESSION_UNAVAILABLE','TELEGRAM_LOGIN_CANCELLED',
    'TELEGRAM_CODE_UNAVAILABLE','TELEGRAM_LOGIN_METHOD_UNAVAILABLE','TELEGRAM_APP_UPDATE_REQUIRED']){
    assert.equal(project({...payload,code}).details.providerCode,code);
  }
  for(const value of [{...payload,code:['TELEGRAM_PASSWORD_INVALID']},{...payload,code:'TELEGRAM_PASSWORD_INVALID_PRIVATE'},
    {...payload,ok:true},null,[],{error:'PASSWORD_HASH_INVALID'}])assert.equal(project(value).details.providerCode,undefined);
  for(const stderr of ['PRIVATE_TRACEBACK',Buffer.from([0xff]),'x'.repeat(65537)]){
    assert.equal(project(payload,{stderr}).details.providerCode,undefined);
  }
  assert.equal(project(payload,{skillId:'email-imap-smtp'}).details.providerCode,undefined);
  for(const seconds of [-1,true,'17',Number.MAX_SAFE_INTEGER]){
    assert.equal(project({...payload,code:'TELEGRAM_RATE_LIMITED',details:{diagnostic:{retryAfterSeconds:seconds}}}).details.retryAfterSeconds,undefined);
  }
});

test('the actual protected setup child preserves the safe refusal, never its stdout or stderr fields', async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'trelio-setup-diagnostic-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.writeFile(path.join(directory,'main.mjs'),`process.stdout.write('PRIVATE_STDOUT');
    process.stderr.write(JSON.stringify({ok:false,code:'TELEGRAM_PASSWORD_INVALID',error:'PRIVATE_PASSWORD',details:{path:'PRIVATE_PATH'}}));process.exit(2);`);
  let admissions=0,lateChecks=0;
  const profile={kind:'digital_assistant',requireToken:()=>assert.fail('no native HTTP in this executor fixture'),
    prepareRequest:()=>assert.fail('no native HTTP in this executor fixture'),
    authorizeHumanInputSkillSetup:async()=>{admissions++;return 10000;},assertHumanInputSkillSetupCurrent:async()=>{lateChecks++;}};
  const artifact={skillId:'telegram-mtproto',runtimeVersion:'0.0.0',parsedPackage:{entrypoint:{path:'main.mjs',interpreter:'node'},capabilities:[]}};
  const call=()=>withWorkspaceExecutionProfile(profile,()=>runMaterializedAgentSkill({artifact,runtimeDirectory:directory,
    runtimeArguments:['login','--qr'],executionContext:{skillId:artifact.skillId,companyId:randomUUID(),releaseId:randomUUID()},
    captureOutput:true,captureMode:'assistant_skill_setup',timeoutMs:10000}));
  await assert.rejects(call(),error=>{
    assert.equal(error.code,'TRELIO_SKILL_RUNTIME_EXIT_2');
    assert.equal(error.details.providerCode,'TELEGRAM_PASSWORD_INVALID');
    assert.doesNotMatch(formatBridgeCommandError(error),/PRIVATE/);return true;
  });
  assert.equal(admissions,1);assert.equal(lateChecks,1);
  // Complete foreign provider output and an aborted child never acquire a
  // Telegram password diagnosis, even when their text uses a reviewed code.
  artifact.skillId='foreign-provider';
  await assert.rejects(call(),error=>error.code==='TRELIO_SKILL_RUNTIME_EXIT_2'&&error.details.providerCode===undefined);
  assert.equal(admissions,2);assert.equal(lateChecks,2);
});

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
import { buildDiagnosticObservation, isDiagnosticObservation, projectDiagnosticDetail, rememberDiagnosticDetail, readDiagnosticDetail } from "../host-runtime/scripts/trelio-diagnostic-observation.mjs";
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

const generationDetail = { kind:'generation', stage:'candidate', reason:'task_revision_changed', count:1 };
test('closed details reject extra fields/getters and cannot change paired counters', async () => {
  let getters=0;
  assert.equal(projectDiagnosticDetail({kind:'generation',get stage(){getters++;throw Error('PRIVATE');},reason:'unknown'}),null);
  assert.equal(getters,0);
  for(const extra of [{message:'PRIVATE'}, {scopeId:randomUUID()}, {stage:'PRIVATE'}, {count:null}, {count:0}])
    assert.equal(projectDiagnosticDetail({...generationDetail,...extra}),null);
  const bodies=[];
  const reporter=createAgentDiagnosticReporter({origin:'https://fixture.invalid',journal:null,delayMs:60000,
    send:async(_origin,samples)=>{bodies.push(structuredClone(samples));}});
  try{
    for(let i=0;i<2;i++)reporter.record('continue_trelio_local_action',{route:'context'},'LOCAL_CONTEXT_GENERATION_CHANGED',{evidence:generationDetail});
    reporter.record('continue_trelio_local_action',{route:'context'},'LOCAL_CONTEXT_GENERATION_CHANGED');
    await reporter.flush();
    const row=bodies[0][0].outcomes[0];
    assert.equal(row.count,3);assert.equal(row.details[0].count,2);assert.equal(isDiagnosticObservation(bodies[0][0]),true);
    for(const details of [[{...generationDetail,count:4}],[generationDetail,generationDetail],[{...generationDetail,message:'PRIVATE'}]])
      assert.equal(isDiagnosticObservation({...bodies[0][0],outcomes:[{...row,details}]}),false);
    assert.equal(isDiagnosticObservation({...bodies[0][0],outcomes:[{code:'OK',field:'unknown',count:1,details:[generationDetail]}]}),false);
  }finally{reporter.close();}
});

test('details negotiate old v2 without changing UUID/counts, and exact retries remain immutable', async () => {
  for(const advertised of [true,false]){
    const bodies=[];
    const transport=createObservationTransport({readToken:async()=> 'synthetic',fetchImpl:async(url,options)=>{
      if(url.pathname.endsWith('capabilities'))return new Response(JSON.stringify({schemaVersion:2,errorCodes:contract.errorCodes,
        lossReasons:contract.lossReasons,...(advertised?{detailEvidenceVersion:1}:{})}));
      bodies.push(options.body);return new Response(null,{status:204});
    }});
    const sample=buildDiagnosticObservation('continue_trelio_local_action',{route:'context'},'LOCAL_CONTEXT_GENERATION_CHANGED');
    sample.outcomes[0].details=[generationDetail];
    const original=JSON.stringify(sample);
    await transport('https://fixture.invalid',[sample]);await transport('https://fixture.invalid',[sample]);
    assert.equal(new Set(bodies).size,1);assert.equal(JSON.stringify(sample),original);
    const delivered=JSON.parse(bodies[0]).samples[0];
    assert.equal(delivered.id,sample.id);assert.equal(delivered.outcomes[0].count,1);
    assert.deepEqual(delivered.outcomes[0].details,advertised?[generationDetail]:undefined);
    assert.equal(isDiagnosticObservation(delivered),true);
  }
});

test('real finish argument guards retain expected/actual types, nested item stage and closed aliases before any child', async () => {
  const base={schemaVersion:1,operation:'finish',workingDirectory:os.tmpdir(),parameters:{summary:'PRIVATE_SUMMARY'}};
  for(const [change,key,actual,expected,stage] of [
    [{evidence:{}},'evidence','object','array','parameter'],
    [{evidence:'PRIVATE_EVIDENCE'},'evidence','string','array','parameter'],
    [{evidence:[{}]},'evidence','object','string','array_item'],
    [{nextAction:{}},'nextAction','object','string','parameter'],
    [{files:['PRIVATE_PATH']},'files','object','object','unknown_parameter'],
    [{PRIVATE_UNKNOWN:'PRIVATE_VALUE'},'unknown','object','object','unknown_parameter'],
  ]){
    let caught;
    assert.throws(()=>buildTrelioWorkspaceActionInvocation({...base,parameters:{...base.parameters,...change}}),error=>{caught=error;return true;});
    const detail=readDiagnosticDetail(caught);
    assert.deepEqual([detail.kind,detail.key,detail.actualType,detail.expectedType,detail.stage],['input',key,actual,expected,stage]);
    assert.doesNotMatch(JSON.stringify(detail),/PRIVATE/);
    const reports=[];
    await handleLocalMcpMessage({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'continue_trelio_workspace_action',arguments:base}},
      {callTool:async()=>{throw caught;},recordDiagnostic:(...args)=>reports.push(args)});
    assert.equal(reports[0][2],caught.diagnosticCode);assert.deepEqual(reports[0][3].evidence,detail);
  }
});

test('three-attempt mirror conflicts preserve originating backend reason and final assembly stage', async () => {
  let reads=0,builds=0,publishes=0;
  const backend=()=>new TrelioApiError(409,'fixed',null,'LOCAL_CONTEXT_GENERATION_CHANGED',{
    diagnosticEvidence:{kind:'generation',stage:'backend_manifest',reason:'manifest_deadlock'},private:'PRIVATE'});
  await assert.rejects(buildStableCompanyMirror({readManifest:async()=>{reads++;throw backend();},
    buildCandidate:async()=>{builds++;},publish:async()=>{publishes++;}}),error=>{
      assert.deepEqual(readDiagnosticDetail(error),{kind:'generation',stage:'starting_manifest',reason:'manifest_deadlock',count:1});
      assert.equal(error.details.reason,'revision_conflict','public recovery ABI stays unchanged');return true;
    });
  assert.equal(reads,3);assert.equal(builds,0);assert.equal(publishes,0);
  reads=0;
  await assert.rejects(buildStableCompanyMirror({readManifest:async()=>({generation:String(reads++)}),buildCandidate:async()=>({}),
    publish:async()=>assert.fail('never publish a mixed generation')}),error=>{
      assert.deepEqual(readDiagnosticDetail(error),{kind:'generation',stage:'finishing_manifest',reason:'generation_mismatch',count:1});return true;
    });
  assert.equal(reads,6);
  assert.equal(readDiagnosticDetail(new Error('LOCAL_CONTEXT_GENERATION_CHANGED')),undefined);
});

const captureDeliveryLoss=async({readToken=async()=> 'synthetic',failureFetch})=>{
  let failed=true;const delivered=[];
  const transport=createObservationTransport({readToken,fetchImpl:async(url,options)=>{
    if(failed)return failureFetch(url,options);
    if(url.pathname.endsWith('capabilities'))return new Response(JSON.stringify({schemaVersion:2,errorCodes:contract.errorCodes,lossReasons:contract.lossReasons,detailEvidenceVersion:1}));
    delivered.push(JSON.parse(options.body));return new Response(null,{status:204});
  }});
  const reporter=createAgentDiagnosticReporter({origin:'https://fixture.invalid',journal:null,delayMs:60000,retryDelays:[],send:transport});
  try{
    reporter.record('continue_trelio_workspace_action',{operation:'finish'},'OK');await reporter.flush();failed=false;
    reporter.record('continue_trelio_workspace_action',{operation:'finish'},'OK');await reporter.flush();
    return delivered[0].samples.flatMap(sample=>sample.losses);
  }finally{reporter.close();}
};
test('delivery refusals distinguish capabilities/body/schema and HTTP status without reading error prose',async()=>{
  for(const [response,stage,reason,status] of [
    [()=>new Response(null,{status:401}),'capabilities_headers','http_rejected',401],
    [()=>new Response(null,{status:200}),'capabilities_body','body_missing',0],
    [()=>new Response('PRIVATE_NOT_JSON'),'capabilities_body','body_json_invalid',0],
    [()=>new Response('null'),'capabilities_body','capabilities_schema_invalid',0],
    [()=>new Response(JSON.stringify({schemaVersion:2,errorCodes:['DIAGNOSTICS_CODE_UNSUPPORTED'],lossReasons:{private:'PRIVATE'}})),
      'capabilities_body','loss_catalog_invalid',0],
  ]){
    const losses=await captureDeliveryLoss({failureFetch:async()=>response()});
    assert.equal(losses[0].reason,'delivery_rejected');assert.equal(losses[0].count,1);
    assert.deepEqual(losses[0].details,[{kind:'delivery',stage,reason,httpStatus:status,count:1}]);
    assert.doesNotMatch(JSON.stringify(losses),/PRIVATE|Bearer|fixture/);
  }
  const losses=await captureDeliveryLoss({failureFetch:async url=>url.pathname.endsWith('capabilities')
    ?new Response(JSON.stringify({schemaVersion:2,errorCodes:contract.errorCodes,lossReasons:contract.lossReasons,detailEvidenceVersion:1}))
    :new Response('PRIVATE_PROVIDER_BODY',{status:429})});
  assert.deepEqual(losses[0].details,[{kind:'delivery',stage:'observations_body',reason:'http_rejected',httpStatus:429,count:1}]);
});

test('journal expiry/decoding/schema reasons retain only age buckets and survive the actual reporter',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'trelio-detail-journal-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const sample=buildDiagnosticObservation('runtime_hook',{operation:'PreToolUse'},'OK',{boundary:'hook'});
  await writeDiagnosticJournal('fixture',sample,{directory});
  const now=Date.now();await fs.utimes(path.join(directory,sample.id+'.json'),new Date(now-30*3600000),new Date(now-30*3600000));
  await fs.writeFile(path.join(directory,randomUUID()+'.json'),'PRIVATE_INVALID_JSON');
  await fs.writeFile(path.join(directory,randomUUID()+'.json'),JSON.stringify({...sample,message:'PRIVATE_CONTENT'}));
  const read=await readDiagnosticJournal('fixture',{directory,now});
  assert.deepEqual(read.losses,{journal_expired:1,journal_invalid:2});
  assert.deepEqual(read.details.find(row=>row.reason==='journal_expired').details,[{kind:'journal',stage:'entry',reason:'entry_ttl_expired',ageBucket:'24h_to_48h',count:1}]);
  assert.deepEqual(read.details.find(row=>row.reason==='journal_invalid').details.map(d=>d.reason).sort(),['json_invalid','schema_invalid']);
  const samples=[];const reporter=createAgentDiagnosticReporter({origin:'https://fixture.invalid',delayMs:60000,
    journal:{read:async()=>read,acknowledge:async()=>{}},send:async(_o,value)=>samples.push(...structuredClone(value))});
  try{
    reporter.record('continue_trelio_workspace_action',{operation:'status'},'OK');await reporter.flush();
    assert.ok(samples.every(isDiagnosticObservation));assert.doesNotMatch(JSON.stringify(samples),/PRIVATE|trelio-detail-journal|fixture/);
    const health=samples.find(s=>s.boundary==='collector');assert.equal(health.losses.find(x=>x.reason==='journal_invalid').details.length,2);
  }finally{reporter.close();}
});

test('generation evidence crosses the actual bridge HTTP frame with fixed code and no raw payload',async()=>{
  const {parseBridgeHttpDiagnostic}=await import('../host-runtime/scripts/trelio-bridge-http-diagnostics.mjs');
  const native={kind:'generation',stage:'backend_task',reason:'task_revision_changed'};
  const error=new TrelioApiError(409,'fixed',null,'LOCAL_CONTEXT_GENERATION_CHANGED',{diagnosticEvidence:native,private:'PRIVATE_LOCATOR'});
  const frame=formatBridgeCommandError(error);
  assert.doesNotMatch(frame,/PRIVATE/);
  assert.deepEqual(parseBridgeHttpDiagnostic('PRIVATE_EARLIER_TRACE\nОшибка: '+frame).diagnosticEvidence,{...native,count:1});
  assert.equal(parseBridgeHttpDiagnostic('Ошибка: '+frame+'\nlate provider text'),null);
  assert.equal(readDiagnosticDetail(new TrelioApiError(409,'fixed',null,'OTHER',{diagnosticEvidence:native})),undefined);
  assert.equal(readDiagnosticDetail(new TrelioApiError(409,'fixed',null,'LOCAL_CONTEXT_GENERATION_CHANGED',{
    diagnosticEvidence:{...native,token:'PRIVATE'}})),undefined);
});

test('credential and body timeouts retain the phase in the shutdown journal without late HTTP or a second reader',async()=>{
  for(const phase of ['credential','capabilities_body']){
    let release,reads=0,requests=0;const written=[];
    const transport=createObservationTransport({readToken:async()=>{reads++;return phase==='credential'?new Promise(resolve=>{release=resolve;}):'synthetic';},
      fetchImpl:async()=>{requests++;return new Response(new ReadableStream({start(controller){release=()=>controller.close();}}));}});
    const reporter=createAgentDiagnosticReporter({origin:'https://fixture.invalid',delayMs:60000,timeoutMs:5,retryDelays:[],send:transport,
      journal:{read:async()=>({samples:[],losses:{}}),write:async sample=>written.push(structuredClone(sample))}});
    const keep=setInterval(()=>{},1000);
    try{
      reporter.record('continue_trelio_workspace_action',{operation:'finish'},'OK');await reporter.flush();
      assert.equal(reporter.health().losses.delivery_timeout,1);assert.equal(reporter.health().inFlight,true);
      await reporter.flush();assert.equal(reads,1);reporter.close();await sleep(0);
      const detail=written[0].losses.find(row=>row.reason==='delivery_timeout').details[0];
      assert.deepEqual(detail,{kind:'delivery',stage:phase,reason:'timeout',httpStatus:0,count:1});
      assert.ok(isDiagnosticObservation(written[0]));
      release(phase==='credential'?'synthetic':undefined);await sleep(10);
      assert.equal(requests,phase==='credential'?0:1);assert.equal(reads,1);
    }finally{reporter.close();clearInterval(keep);}
  }
});

test('network and credential-read failures retain their distinct closed boundaries',async()=>{
  const network=await captureDeliveryLoss({failureFetch:async()=>{throw new Error('PRIVATE_ENDPOINT_AND_TOKEN');}});
  assert.deepEqual(network[0],{reason:'delivery_transport',count:1,details:[{kind:'delivery',stage:'capabilities_headers',reason:'transport',httpStatus:0,count:1}]});
  let reads=0;
  const credential=await captureDeliveryLoss({readToken:()=>{if(++reads===1)throw new Error('PRIVATE_KEYCHAIN');return 'synthetic';},
    failureFetch:async()=>assert.fail('a failed credential must never start HTTP')});
  assert.equal(reads,2,'one original read per batch, no read recovery');
  assert.deepEqual(credential[0],{reason:'credential_unavailable',count:1,details:[{kind:'delivery',stage:'credential',reason:'credential_read_failed',httpStatus:0,count:1}]});
});

test('detail overflow drops no paired outcomes and keeps every sample inside the unchanged journal byte limit',async()=>{
  const batches=[];const reporter=createAgentDiagnosticReporter({origin:'https://fixture.invalid',journal:null,delayMs:60000,
    send:async(_origin,samples)=>batches.push(structuredClone(samples))});
  try{
    for(const field of ['summary','evidence','nextAction','filePaths','questions'])
      for(const reason of contract.detailEvidence.generationReasons.slice(0,6))
        reporter.record('continue_trelio_local_action',{route:'context'},'LOCAL_CONTEXT_GENERATION_CHANGED',
          {field,evidence:{kind:'generation',stage:'candidate',reason}});
    await reporter.flush();
    const sample=batches[0][0];assert.equal(sample.outcomes.reduce((n,row)=>n+row.count,0),30);
    assert.equal(sample.outcomes.reduce((n,row)=>n+(row.details?.length??0),0),16);
    assert.ok(sample.outcomes.every(row=>(row.details?.length??0)<=4));assert.ok(isDiagnosticObservation(sample));
    assert.ok(Buffer.byteLength(JSON.stringify(sample))<=16384);
  }finally{reporter.close();}
});

test('the actual HTTP retry retains negotiated details, one credential read and frozen UUID/counts',async()=>{
  let reads=0;const bodies=[];
  const transport=createObservationTransport({readToken:async()=>{reads++;return 'synthetic';},fetchImpl:async(url,options)=>{
    if(url.pathname.endsWith('capabilities'))return new Response(JSON.stringify({schemaVersion:2,errorCodes:contract.errorCodes,
      lossReasons:contract.lossReasons,detailEvidenceVersion:1}));
    bodies.push(options.body);return new Response(null,{status:bodies.length===1?503:204});
  }});
  const reporter=createAgentDiagnosticReporter({origin:'https://fixture.invalid',journal:null,delayMs:60000,retryDelays:[0],send:transport});
  const keep=setInterval(()=>{},1000);
  try{
    reporter.record('continue_trelio_local_action',{route:'context'},'LOCAL_CONTEXT_GENERATION_CHANGED',{evidence:generationDetail});
    await reporter.flush();
    assert.equal(reads,1);assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);
    assert.deepEqual(JSON.parse(bodies[0]).samples[0].outcomes[0].details,[generationDetail]);
    assert.equal(reporter.health().losses.delivery_rejected,undefined,'a successful original retry is not a new loss');
  }finally{reporter.close();clearInterval(keep);}
});

test('timeout evidence freezes its original phase before synchronous abort listeners run',async()=>{
  const written=[];
  const reporter=createAgentDiagnosticReporter({origin:'https://fixture.invalid',delayMs:60000,timeoutMs:5,retryDelays:[],
    journal:{read:async()=>({samples:[],losses:{}}),write:async sample=>written.push(structuredClone(sample))},
    send:async(_origin,_samples,{signal,context})=>{
      context.stage='observations_body';context.httpStatus=429;
      await new Promise(resolve=>signal.addEventListener('abort',()=>{
        context.stage='acknowledgement';context.httpStatus=0;resolve();
      },{once:true}));
    }});
  const keep=setInterval(()=>{},1000);
  try{
    reporter.record('continue_trelio_workspace_action',{operation:'finish'},'OK');await reporter.flush();
    reporter.close();await sleep(0);
    assert.deepEqual(written[0].losses.find(row=>row.reason==='delivery_timeout').details,
      [{kind:'delivery',stage:'observations_body',reason:'timeout',httpStatus:429,count:1}]);
  }finally{reporter.close();clearInterval(keep);}
});
