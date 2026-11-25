import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {randomUUID} from "node:crypto";
import { reviewedHistoricalOwnerAnswerSkills, readSkillSecretSetupCommand, readSkillHumanInputSetupCommand, readSkillHumanInputSetupCommands, deliverSkillSetupEnvironment, assertAssistantTaskSkillCommand } from "../host-runtime/scripts/trelio-skill-secret-setup.mjs";

const command = { id: "configure", arguments: ["configure"], bindingKey: "service_token",
  fieldKey: "value", environmentVariable: "TRELIO_TEST_SETUP_TOKEN" };
const packageWith = (commands, extra = {}) => ({ capabilities: ["secret-checkout"], files: [{
  path: "trelio-secret-setup.json", bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, commands, ...extra })),
}] });

test('explicit assistant command policy is signed bytes only and matches exact positional prefixes', () => {
  const policy = {schemaVersion:1,taskCommands:[['read'],['policy','show']]};
  const packaged = value => ({files:[{path:'trelio-assistant-execution.json',bytes:Buffer.from(JSON.stringify(value))}]});
  for (const args of [['read'],['read','--uid','11'],['policy','show','--account','own']])
    assert.doesNotThrow(()=>assertAssistantTaskSkillCommand(packaged(policy),args));
  for (const args of [['configure'],['policy','set'],['--help','read'],['Read'],['read-more'],[],['read',null]])
    assert.throws(()=>assertAssistantTaskSkillCommand(packaged(policy),args),{code:'ASSISTANT_SKILL_COMMAND_DENIED'});
  for(const value of [{...policy,schemaVersion:2},{...policy,allowSetup:true},{...policy,taskCommands:[]},
    {...policy,taskCommands:[['read'],['read']]},{...policy,taskCommands:[['*']]},
    {...policy,taskCommands:[['read','a','b','c']]}, {...policy,taskCommands:Array(65).fill(['read'])}])
    assert.throws(()=>assertAssistantTaskSkillCommand(packaged(value),['read']),{code:'ASSISTANT_SKILL_COMMAND_POLICY_INVALID'});
  for(const bytes of [Buffer.from('{'),Buffer.from([0xff]),Buffer.alloc(8193)])
    assert.throws(()=>assertAssistantTaskSkillCommand({files:[{path:'trelio-assistant-execution.json',bytes}]},['read']),
      {code:'ASSISTANT_SKILL_COMMAND_POLICY_INVALID'});
});

test('ordinary skill commands need no assistant policy and provide no effect witness', () => {
  const ordinary = {files:[],readOnlyCommands:[['search']]};
  assert.equal(assertAssistantTaskSkillCommand(ordinary,['search','apartment']),'unknown');
  assert.equal(assertAssistantTaskSkillCommand(ordinary,['guides']),'unknown');
  for (const argv of [[],['read',null],['__trelio_accounts_import'],['__trelio_account_remove'],
    ['monitor'],['ack-reference'],['source-original'],['reply-reference'],['unsubscribe-reference']]) {
    assert.throws(()=>assertAssistantTaskSkillCommand(ordinary,argv),{code:'ASSISTANT_SKILL_COMMAND_DENIED'});
  }
  const browser = {...ordinary,browserSession:{sessionClass:'protected-snapshot'}};
  assert.equal(assertAssistantTaskSkillCommand(browser,['submit-search','--frameId','current']),'unknown');
  for (const command of ['disconnect','show-login','credentials-setup','credentials-forget']) {
    assert.throws(()=>assertAssistantTaskSkillCommand(browser,[command]),{code:'ASSISTANT_SKILL_COMMAND_DENIED'});
  }
  assert.throws(()=>assertAssistantTaskSkillCommand(packageWith([command]),command.arguments),
    {code:'ASSISTANT_SKILL_COMMAND_DENIED'},'ordinary execution cannot consume a signed setup command');
});

test('v2 signed option restrictions close native overrides without changing v1', () => {
  const policy = {schemaVersion:2,taskCommands:[['read']],deniedOptions:['--chrome','--timeout-ms']};
  const packaged = value => ({files:[{path:'trelio-assistant-execution.json',bytes:Buffer.from(JSON.stringify(value))}]});
  assert.doesNotThrow(()=>assertAssistantTaskSkillCommand(packaged(policy),['read','--chat','123']));
  for(const option of policy.deniedOptions)for(const args of [['read',option,'PRIVATE_VALUE'],['read',`${option}=PRIVATE_VALUE`]])
    assert.throws(()=>assertAssistantTaskSkillCommand(packaged(policy),args),error=>error.code==='ASSISTANT_SKILL_COMMAND_DENIED'
      && !error.message.includes('PRIVATE_VALUE'));
  for(const deniedOptions of [[],['--chrome','--chrome'],['--chrome=*'],['-c'],['--Chrome'],Array(33).fill('--chrome'),null])
    assert.throws(()=>assertAssistantTaskSkillCommand(packaged({...policy,deniedOptions}),['read']),
      {code:'ASSISTANT_SKILL_COMMAND_POLICY_INVALID'});
  assert.throws(()=>assertAssistantTaskSkillCommand(packaged({...policy,schemaVersion:3}),['read']),
    {code:'ASSISTANT_SKILL_COMMAND_POLICY_INVALID'});
  assert.throws(()=>assertAssistantTaskSkillCommand(packaged({...policy,schemaVersion:1}),['read']),
    {code:'ASSISTANT_SKILL_COMMAND_POLICY_INVALID'},'v1 does not ignore an unrecognized restriction field');
});

test('a signed read declaration cannot admit extra commands or mask an overlapping effect', () => {
  const policy = {schemaVersion:3,taskCommands:[['history'],['history','clear'],['publish']],
    deniedOptions:['--ack'],readOnlyCommands:[['history']]};
  const packaged = value => ({files:[{path:'trelio-assistant-execution.json',bytes:Buffer.from(JSON.stringify(value))}]});
  assert.equal(assertAssistantTaskSkillCommand(packaged(policy),['history','--limit','10']),'read_only');
  assert.equal(assertAssistantTaskSkillCommand(packaged(policy),['history','clear']),'unknown');
  assert.equal(assertAssistantTaskSkillCommand(packaged(policy),['publish']),'unknown');
  assert.throws(()=>assertAssistantTaskSkillCommand(packaged(policy),['history','--ack=yes']),
    {code:'ASSISTANT_SKILL_COMMAND_DENIED'});
  for (const readOnlyCommands of [[['unlisted']],[['history'],['history']],['history'],null]) {
    assert.throws(()=>assertAssistantTaskSkillCommand(packaged({...policy,readOnlyCommands}),['history']),
      {code:'ASSISTANT_SKILL_COMMAND_POLICY_INVALID'});
  }
  const legacy = {schemaVersion:1,taskCommands:policy.taskCommands};
  assert.equal(assertAssistantTaskSkillCommand(packaged(legacy),['history']),'unknown');
});

test('the native child marks only the completed signed read, independent of provider stdout', async t => {
  const {withWorkspaceExecutionProfile,runMaterializedAgentSkill}=await import('../host-runtime/scripts/trelio-workspace.mjs');
  const runtimeDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-task-skill-effect-'));
  t.after(()=>fs.rm(runtimeDirectory,{recursive:true,force:true}));
  const executionContext={companyId:randomUUID(),releaseId:randomUUID(),runtimeSessionId:randomUUID(),projectId:null};
  const profile={kind:'digital_assistant',requireToken:async()=>({}),prepareRequest:async()=>assert.fail('unexpected HTTP'),
    resolveSkillRuntimeChat:async()=>randomUUID()};
  // Both commands print the same lookalike. The result bit must come from the
  // signed declaration, never from stdout or a partial/failed child result.
  await fs.writeFile(path.join(runtimeDirectory,'main.mjs'),
    "console.log(JSON.stringify({taskReadOnly:true})); if(process.argv.includes('--fail'))process.exit(2);");
  const provider=(skillId,taskCommands,readOnlyCommands)=>({skillId,runtimeVersion:'1.0.0',
    parsedPackage:{capabilities:[],entrypoint:{path:'main.mjs',interpreter:'node'},
      files:[{path:'trelio-assistant-execution.json',bytes:Buffer.from(JSON.stringify(
        {schemaVersion:3,taskCommands,deniedOptions:[],readOnlyCommands}))}]}});
  await withWorkspaceExecutionProfile(profile,async()=>{
    const run=(artifact,runtimeArguments)=>runMaterializedAgentSkill({artifact,runtimeDirectory,
      runtimeArguments,executionContext,captureOutput:true,captureMode:'assistant_task'});
    for (const [skillId,read,write] of [['synthetic-messages','history','send'],['synthetic-catalogue','inventory','publish']]) {
      const artifact=provider(skillId,[[read],[write]],[[read]]);
      const readResult=await run(artifact,[read]);
      const writeResult=await run(artifact,[write]);
      assert.equal(readResult.taskReadOnly,true);
      assert.equal(writeResult.taskReadOnly,undefined);
      assert.equal(readResult.stdout,writeResult.stdout);
      await assert.rejects(run(artifact,[read,'--fail']));
    }
  });
});

test("setup declaration permits only complete signed argument vectors", () => {
  assert.deepEqual(readSkillSecretSetupCommand(packageWith([command]), ["configure"]), command);
  assert.equal(readSkillSecretSetupCommand(packageWith([command]), ["configure", "--export"]), null);
  assert.equal(readSkillSecretSetupCommand(packageWith([command]), ["query"]), null);
  const authentication={...command,purpose:"authenticate"};
  assert.deepEqual(readSkillSecretSetupCommand(packageWith([authentication],{schemaVersion:2}),["configure"]),authentication);
  for(const invalid of [packageWith([authentication]),packageWith([command],{schemaVersion:2}),
    packageWith([{...authentication,purpose:"create_account"}],{schemaVersion:2})])
    assert.throws(()=>readSkillSecretSetupCommand(invalid,["configure"]));
  for (const descriptor of [
    packageWith([command, command]), packageWith([command], { wildcard: true }),
    packageWith([{ ...command, arguments: ["configure", "*"] }]),
    packageWith([{ ...command, environmentVariable: "NODE_OPTIONS" }]),
    packageWith([{ ...command, environmentVariable: "TRELIO_SKILL_CONNECTION_CONFIG_JSON" }]),
    packageWith([{ ...command, environmentVariable: "TRELIO_ORIGIN" }]),
    { ...packageWith([command]), capabilities: [] },
  ]) assert.throws(() => readSkillSecretSetupCommand(descriptor, ["configure"]));
});

test("private authentication reuses the real signed child engine and never returns credential-bearing output",async()=>{
  const {withWorkspaceExecutionProfile,runMaterializedAgentSkill}=await import("../host-runtime/scripts/trelio-workspace.mjs");
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"private-skill-child-"));
  const value="DISPOSABLE-PRIVATE-FIELD-CANARY",auth={...command,purpose:"authenticate"};
  const parsed={...packageWith([auth],{schemaVersion:2}),entrypoint:{path:"main.mjs",interpreter:"node"}};
  const artifact={skillId:"synthetic-private-auth",runtimeVersion:"1.0.0",parsedPackage:parsed};
  const executionContext={companyId:randomUUID(),projectId:null,releaseId:randomUUID(),runtimeSessionId:randomUUID()};
  // The child deliberately echoes both raw and encoded forms. Output filtering
  // must not rely on substring redaction or a provider promise about its logs.
  await fs.writeFile(path.join(directory,"main.mjs"),"const value=process.env.TRELIO_TEST_SETUP_TOKEN; if(!value)process.exit(9); console.log(value,Buffer.from(value).toString('base64'));");
  let consumed=0;
  const profile={kind:"digital_assistant",requireToken:async()=>({}),prepareRequest:async()=>assert.fail("unexpected native HTTP"),
    resolveSkillRuntimeChat:async()=>randomUUID(),authorizePrivateSkillCheckout:async()=>({})};
  const input={artifact,runtimeDirectory:directory,runtimeArguments:["configure"],executionContext,
    captureOutput:true,captureMode:"assistant_task",privateSecretSetup:{fieldKey:"value",environmentVariable:auth.environmentVariable},
    prepareSetupEnvironment:async()=>{consumed++;return {[auth.environmentVariable]:value};}};
  try{
    await withWorkspaceExecutionProfile(profile,async()=>{
      const result=await runMaterializedAgentSkill(input);
      assert.deepEqual(JSON.parse(result.stdout),{schemaVersion:1,state:"command_completed",verificationRequired:true});
      assert.equal(consumed,1);assert.ok(!JSON.stringify(result).includes(value));
      assert.ok(!JSON.stringify(result).includes(Buffer.from(value).toString("base64")));
      const before=consumed;
      for(const change of [
        {runtimeArguments:["configure","--export"]},
        {privateSecretSetup:{fieldKey:"other",environmentVariable:auth.environmentVariable}},
        {privateSecretSetup:{fieldKey:"value",environmentVariable:"NODE_OPTIONS"}},
        {artifact:{...artifact,parsedPackage:{...parsed,files:packageWith([command]).files}}},
        {captureMode:"monitor",runtimeArguments:["monitor"]},
      ])await assert.rejects(runMaterializedAgentSkill({...input,...change}));
      assert.equal(consumed,before,"an invalid declaration/mode never consumes the private field");
      // Setup still cannot acquire this path through the ordinary task caller.
      await assert.rejects(runMaterializedAgentSkill({...input,privateSecretSetup:null,prepareSetupEnvironment:null}));
    });
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test("human-input declaration is exact signed existing-account auth, never ordinary task or Secret authority", () => {
  const human = { id: "login", purpose: "authenticate_existing", arguments: ["login", "--qr"], maximumDurationMs: 300_000 };
  const descriptor = { schemaVersion: 2, commands: [], humanInputCommands: [human] };
  const fixture = (value, capabilities = ["local-session"]) => ({ capabilities, files: [{
    path: "trelio-secret-setup.json", bytes: Buffer.from(JSON.stringify(value)),
  }] });
  assert.deepEqual(readSkillHumanInputSetupCommand(fixture(descriptor), "login"), human);
  const all = readSkillHumanInputSetupCommands(fixture(descriptor));
  assert.deepEqual(all,[human]);all[0].arguments[0]="changed";
  assert.deepEqual(readSkillHumanInputSetupCommands(fixture(descriptor)),[human],"discovery cannot mutate the signed recipe");
  assert.equal(readSkillHumanInputSetupCommand(fixture(descriptor), "missing"), null);
  assert.equal(readSkillSecretSetupCommand(fixture(descriptor), human.arguments), null);
  const taskPackage = fixture(descriptor);
  taskPackage.files.push({ path: "trelio-assistant-execution.json", bytes: Buffer.from(JSON.stringify({
    schemaVersion: 1, taskCommands: [["login"], ["read"]],
  })) });
  assert.throws(() => assertAssistantTaskSkillCommand(taskPackage, human.arguments), { code: "ASSISTANT_SKILL_COMMAND_DENIED" });
  assert.doesNotThrow(() => assertAssistantTaskSkillCommand(taskPackage, ["read"]));
  const secret = { ...command, purpose: "authenticate" };
  assert.deepEqual(readSkillSecretSetupCommand(fixture({ ...descriptor, commands: [secret] }, ["local-session", "secret-checkout"]), secret.arguments), secret);
  for (const invalid of [
    fixture(descriptor, []), fixture({ ...descriptor, schemaVersion: 1 }), fixture({ ...descriptor, commands: [secret] }),
    fixture({ schemaVersion: 2, commands: [] }), fixture({ ...descriptor, humanInputCommands: [] }),
    fixture({ ...descriptor, humanInputCommands: [human, human] }),
    fixture({ ...descriptor, commands: [secret], humanInputCommands: [{ ...human, id: secret.id }] }, ["local-session", "secret-checkout"]),
    fixture({ ...descriptor, commands: [secret], humanInputCommands: [{ ...human, arguments: secret.arguments }] }, ["local-session", "secret-checkout"]),
    ...[{ purpose: "create_account" }, { value: "MODEL_VALUE" }, { environmentVariable: "NODE_OPTIONS" },
      { arguments: ["login", "*"] }, { maximumDurationMs: 59_999 }, { maximumDurationMs: 600_001 },
      { maximumDurationMs: 60_000.5 }].map(change => fixture({ ...descriptor, humanInputCommands: [{ ...human, ...change }] })),
  ]) assert.throws(() => readSkillHumanInputSetupCommand(invalid, "login"));
});

test("setup delivery rejects changed identity/config/env and never retries or leaks an error value", async () => {
  const inputs = { origin: "https://example.test", token: "fixture-token", command,
    companyId: "company", projectId: null, skillId: "synthetic-skill", releaseId: "release", runtimeSessionId: "session",
    resolution: { companyConnection: { id: "connection", configured: true, config: { baseUrl: "https://example.com/" } },
      localIdentity: { memberId: "member", connectionId: "connection" },
      artifact: { id: "artifact", packageSha256: "a".repeat(64) } } };
  let calls = 0;
  for (const override of [{}, { connectionId: "other" }, { memberId: "other" }, { configSha256: "0".repeat(64) },
    { environmentVariable: "TRELIO_ORIGIN" }, { packageSha256: "b".repeat(64) }]) {
    const request = async (_origin, _token, _path, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.secretId, undefined);
      assert.equal(body.runId, undefined);
      return { json: async () => ({ schemaVersion: 1, companyId: inputs.companyId, memberId: "member", releaseId: "release",
        artifactId: "artifact", packageSha256: "a".repeat(64), connectionId: "connection", configSha256: body.configSha256,
        commandId: command.id, environmentVariable: command.environmentVariable, value: "fixture-sensitive-value", ...override }) };
    };
    if (!Object.keys(override).length) {
      assert.deepEqual(await deliverSkillSetupEnvironment({ ...inputs, request }), { TRELIO_TEST_SETUP_TOKEN: "fixture-sensitive-value" });
    } else await assert.rejects(deliverSkillSetupEnvironment({ ...inputs, request }), (error) => {
      assert.ok(!error.message.includes("fixture-sensitive-value"));
      return true;
    });
  }
  assert.equal(calls, 6);
});

const courtSkill = {skillId:'gas-pravosudie',releaseId:'d4f7679b-a03d-4e42-9d48-37a4688b95e2'};
const courtPackageSha256 = '32e6733b6e6e948a0fb8e27018a8788121f0e18f72f118d5c18d229fb906ed7e';

// All session, task, device and case locators in this fixture are generated.
// Exercise a complete authenticated native history without opening a browser.
const courtVisitFixture = () => {
  const pass = {companyId:randomUUID(),taskId:randomUUID(),passId:randomUUID()};
  const projectId = randomUUID(), runtimeSessionId = randomUUID(), sessionId = randomUUID();
  const seed = {companyId:pass.companyId,projectId,runtimeSessionId,...courtSkill,arguments:[]};
  const scope = {taskPass:pass,runtimeSessionProof:{runtimeSessionId}};
  const item = (tool,args,value,status='completed') => ({type:'mcpToolCall',server:'trelio-assistant',tool,
    arguments:{...args,...scope},status,result:{structuredContent:value,
      content:status==='failed'?[{type:'text',text:value.code}]:[]}});
  const select = item('get_agent_skill',{skillId:courtSkill.skillId},{skill:{id:courtSkill.skillId,version:'4.1.11',
    runtimeRelease:{releaseId:courtSkill.releaseId,runtimeVersion:'1.0.16',trustLevel:'platform_verified',packageSha256:courtPackageSha256}},
    runtimeExecution:{releaseId:courtSkill.releaseId,localAction:{arguments:{parameters:{...seed}}}}});
  const run = (argv,output) => {
    const args = {schemaVersion:1,operation:'skill_run',parameters:{...seed,arguments:argv}};
    return output === null ? item('continue_assistant_workspace_action',args,{code:'TRELIO_WORKSPACE_ACTION_FAILED'},'failed')
      : item('continue_assistant_workspace_action',args,{schemaVersion:1,operation:'skill_run',stdout:JSON.stringify(output)});
  };
  const wait = ['wait','--session',sessionId,'--after-phase','starting','--timeout-seconds','30'];
  const origin = 'https://court.sudrf.ru';
  const address = origin+'/modules.php?name=sud_delo&srv_num=1&name_op=case&case_id=1&case_uid='+randomUUID()+'&delo_id=1';
  const items = [select,run(['doctor'],{osPrompt:false,runtimeReady:true,runtimeVersion:'1.0.16'}),
    run(['start'],{phase:'starting',sessionId,requiredAction:'Дождитесь ready; браузер откроется без активации окна.',continuation:{arguments:wait}}),
    run(wait,{phase:'ready',sessionId,requiredAction:null,wait:{changed:true,timedOut:false}}),
    run(['page','--session',sessionId,'--navigate',address],{ok:true}),
    run(['snapshot','--session',sessionId],{origin,text:'',controls:[],truncated:true}),
    run(['page','--help'],null),run(['--help'],null),run(['stop','--session',sessionId],{phase:'closed',sessionId})];
  return {pass,items,run};
};

test('retained court visit binds its immutable selection, scoped original and exact closed session', () => {
  const {items,pass} = courtVisitFixture();
  assert.equal(reviewedHistoricalOwnerAnswerSkills(items,pass),true);
  assert.equal(reviewedHistoricalOwnerAnswerSkills([{tool:'unrelated'}],pass),true);
  assert.equal(reviewedHistoricalOwnerAnswerSkills(items.slice(1),pass),false);
  assert.equal(reviewedHistoricalOwnerAnswerSkills(items.slice(0,-1),pass),false);
  assert.equal(reviewedHistoricalOwnerAnswerSkills(items,{...pass,passId:randomUUID()}),false);
  for (const mutate of [
    r=>{ r[0].result.structuredContent.skill.runtimeRelease.packageSha256 = '0'.repeat(64); },
    r=>{ r[0].result.structuredContent.skill.runtimeRelease.trustLevel = 'company_unverified'; },
    r=>{ delete r[0].result.structuredContent.runtimeExecution; },
    r=>{ r[1].arguments.parameters.releaseId = randomUUID(); },
    r=>{ r[1].arguments.parameters.projectId = randomUUID(); },
    r=>{ r[2].arguments.parameters.runtimeSessionId = randomUUID(); },
    r=>{ r[2].arguments.parameters.stdin = '{}'; },
    r=>{ r[2].result.structuredContent.stdout = JSON.stringify({phase:'starting',sessionId:randomUUID()}); },
    r=>{ r[3].arguments.parameters.arguments[2] = randomUUID(); },
    r=>{ r[3].result.structuredContent.stdout = JSON.stringify({phase:'ready',sessionId:randomUUID()}); },
    r=>{ r[4].arguments.parameters.guidePart = 1; },
    r=>{ r[4].arguments.parameters.arguments.push('--confirm'); },
    r=>{ r[4].result.structuredContent.stdout = ''; },
    r=>{ r[5].result.structuredContent.stdout = JSON.stringify({origin:'https://other.example',truncated:true,controls:[],text:''}); },
    r=>{ r[6].arguments.parameters.arguments = ['stop','--help']; },
    r=>{ r[7].result.content = [{type:'text',text:'different_failure'}]; },
    r=>{ r[7].result.structuredContent.extra = true; },
    r=>{ r[8].result.structuredContent.stdout = JSON.stringify({phase:'closed',sessionId:randomUUID()}); },
  ]) {
    const altered = structuredClone(items);
    mutate(altered);
    assert.equal(reviewedHistoricalOwnerAnswerSkills(altered,pass),false);
  }
});

test('retained court history rejects arbitrary navigation, malformed guide pages and any extra provider effect', () => {
  const {items,pass,run} = courtVisitFixture();
  const url = items[4].arguments.parameters.arguments[4];
  for (const unsafe of [url.replace('court.sudrf.ru','unknown.example'),url.replace('case_id=1','case_id=1&confirm=1'),
    url.replace('name_op=case','name_op=submit'),url.replace('case_id=1','case_id=1&case_id=2'),
    url.replace('modules.php','modules.php/other'),url+'#unexpected',url.replace('//court.','//user@court.')]) {
    const altered = structuredClone(items);
    altered[4].arguments.parameters.arguments[4] = unsafe;
    assert.equal(reviewedHistoricalOwnerAnswerSkills(altered,pass),false);
  }
  const guide = run(['guides'],{schemaVersion:1,part:0,count:4,text:'not signed',nextGuidePart:1});
  for (const extra of [guide,run(['script','--help'],null),run(['page','--help','--confirm'],null),
    run(['prepare-sign-in'],{ok:true}),run(['account','list'],{ok:true})])
    assert.equal(reviewedHistoricalOwnerAnswerSkills([...items,extra],pass),false);
});
