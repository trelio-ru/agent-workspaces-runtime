import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {randomUUID} from "node:crypto";
import { readSkillSecretSetupCommand, readSkillHumanInputSetupCommand, readSkillHumanInputSetupCommands, deliverSkillSetupEnvironment, assertAssistantTaskSkillCommand } from "../host-runtime/scripts/trelio-skill-secret-setup.mjs";

const command = { id: "configure", arguments: ["configure"], bindingKey: "service_token",
  fieldKey: "value", environmentVariable: "TRELIO_TEST_SETUP_TOKEN" };
const packageWith = (commands, extra = {}) => ({ capabilities: ["secret-checkout"], files: [{
  path: "trelio-secret-setup.json", bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, commands, ...extra })),
}] });

test('assistant command policy is signed bytes only, exact positional prefixes and fail-closed for legacy packages', () => {
  const policy = {schemaVersion:1,taskCommands:[['read'],['policy','show']]};
  const packaged = value => ({files:[{path:'trelio-assistant-execution.json',bytes:Buffer.from(JSON.stringify(value))}]});
  for (const args of [['read'],['read','--uid','11'],['policy','show','--account','own']])
    assert.doesNotThrow(()=>assertAssistantTaskSkillCommand(packaged(policy),args));
  for (const args of [['configure'],['policy','set'],['--help','read'],['Read'],['read-more'],[],['read',null]])
    assert.throws(()=>assertAssistantTaskSkillCommand(packaged(policy),args),{code:'ASSISTANT_SKILL_COMMAND_DENIED'});
  assert.throws(()=>assertAssistantTaskSkillCommand({files:[],taskCommands:[['configure']]},['configure']),
    {code:'ASSISTANT_SKILL_COMMAND_UNAVAILABLE'},'unsigned metadata is never a fallback');
  for(const value of [{...policy,schemaVersion:2},{...policy,allowSetup:true},{...policy,taskCommands:[]},
    {...policy,taskCommands:[['read'],['read']]},{...policy,taskCommands:[['*']]},
    {...policy,taskCommands:[['read','a','b','c']]}, {...policy,taskCommands:Array(65).fill(['read'])}])
    assert.throws(()=>assertAssistantTaskSkillCommand(packaged(value),['read']),{code:'ASSISTANT_SKILL_COMMAND_POLICY_INVALID'});
  for(const bytes of [Buffer.from('{'),Buffer.from([0xff]),Buffer.alloc(8193)])
    assert.throws(()=>assertAssistantTaskSkillCommand({files:[{path:'trelio-assistant-execution.json',bytes}]},['read']),
      {code:'ASSISTANT_SKILL_COMMAND_POLICY_INVALID'});
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
