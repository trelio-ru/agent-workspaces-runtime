import assert from "node:assert/strict";
import test from "node:test";
import { readSkillSecretSetupCommand, deliverSkillSetupEnvironment, assertAssistantTaskSkillCommand } from "../host-runtime/scripts/trelio-skill-secret-setup.mjs";

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
  for (const descriptor of [
    packageWith([command, command]), packageWith([command], { wildcard: true }),
    packageWith([{ ...command, arguments: ["configure", "*"] }]),
    packageWith([{ ...command, environmentVariable: "NODE_OPTIONS" }]),
    packageWith([{ ...command, environmentVariable: "TRELIO_SKILL_CONNECTION_CONFIG_JSON" }]),
    packageWith([{ ...command, environmentVariable: "TRELIO_ORIGIN" }]),
    { ...packageWith([command]), capabilities: [] },
  ]) assert.throws(() => readSkillSecretSetupCommand(descriptor, ["configure"]));
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
