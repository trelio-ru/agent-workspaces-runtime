import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { createAssistantSetup } from '../host-runtime/scripts/trelio-assistant-setup.mjs';
import { runAssistantSetupMcp, runAssistantEntry } from '../host-runtime/scripts/trelio-assistant-entry.mjs';

test('setup projects only pairing code and live identities, with no repeated exchange', async () => {
  const origin='https://assistant.test', enrollmentId=randomUUID(), assistantUserId=randomUUID(), deviceId=randomUUID();
  const values = new Map(), key = input => JSON.stringify(input);
  const store = { get: async input => structuredClone(values.get(key(input)) ?? null),
    put: async (input,value) => values.set(key(input),structuredClone(value)) };
  let exchanges = 0, revoked = false;
  const http = async (operation) => {
    if (operation === 'pair') return { pairingId: randomUUID(), verificationCode:'ABCDEF12', expiresAt:new Date(20000).toISOString() };
    if (operation === 'exchange') { exchanges++; return { assistantUserId,deviceId,credential:`tda_${'b'.repeat(43)}`,expiresAt:new Date(30000).toISOString() }; }
    assert.equal(operation,'heartbeat');
    if(revoked) throw Object.assign(new Error('PRIVATE FAILURE'),{code:'ASSISTANT_ACCESS_DENIED'});
    return {assistantUserId,deviceId};
  };
  const setup = createAssistantSetup({origin,store,http,now:()=>100});
  assert.deepEqual(await setup.status(enrollmentId),{state:'not_started'});
  assert.deepEqual(await setup.begin(enrollmentId,'Fixture'),{state:'waiting_owner',verificationCode:'ABCDEF12',expiresAt:20000});
  assert.ok(!JSON.stringify(await setup.status(enrollmentId)).includes('verifier'));
  const result = await setup.finish(enrollmentId);
  assert.equal(result.assistantId,assistantUserId); assert.equal(result.businessReady,false);
  assert.deepEqual(await setup.finish(enrollmentId),result);
  assert.deepEqual(await setup.status(enrollmentId),result);
  assert.equal(exchanges,1);
  assert.ok(!JSON.stringify(result).includes('tda_'));
  revoked=true;
  await assert.rejects(setup.status(enrollmentId),error=>error.code==='ASSISTANT_ACCESS_DENIED');
  assert.equal(exchanges,1,'revocation never causes re-pair or a second exchange');
});

test('uncertain exchange remains blocked after setup restart', async () => {
  const values=new Map(),key=input=>JSON.stringify(input),enrollmentId=randomUUID();
  const store={get:async input=>structuredClone(values.get(key(input))??null),
    put:async(input,value)=>values.set(key(input),structuredClone(value))};
  let exchanges=0;
  const options={origin:'https://assistant.test',store,now:()=>100,http:async operation=>{
    if(operation==='pair')return {pairingId:randomUUID(),verificationCode:'ABCDEF12',expiresAt:new Date(20000).toISOString()};
    exchanges++;throw new Error('committed response lost');
  }};
  const setup=createAssistantSetup(options);await setup.begin(enrollmentId,'Fixture');
  await assert.rejects(setup.finish(enrollmentId),/RECOVERY_REQUIRED/);
  const restarted=createAssistantSetup(options);
  assert.deepEqual(await restarted.status(enrollmentId),{state:'recovery_required'});
  await assert.rejects(restarted.finish(enrollmentId),/RECOVERY_REQUIRED/);assert.equal(exchanges,1);
});

test('actual stdio frames discover setup without auth I/O and reject unknown fields/tools', async () => {
  const frames=[{jsonrpc:'2.0',id:1,method:'initialize'},
    {jsonrpc:'2.0',method:'notifications/initialized'},
    {jsonrpc:'2.0',id:2,method:'tools/list'},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'human_login',arguments:{}}},
    {jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'get_assistant_setup_status',arguments:{enrollmentId:randomUUID(),credential:'PRIVATE'}}},
    {jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'get_assistant_setup_status',arguments:{enrollmentId:randomUUID()}}}];
  const output=new PassThrough();let raw='',created=0,reads=0;output.on('data',chunk=>raw+=chunk);
  await runAssistantSetupMcp({input:Readable.from(frames.map(frame=>JSON.stringify(frame)+'\n')),output,
    createMcp:async()=>null,createSetup:async()=>{created++;return {status:async()=>{reads++;return {state:'not_started'};}};}});
  const messages=raw.trim().split('\n').map(JSON.parse);
  assert.equal(messages.length,5);
  assert.equal(messages[1].result.tools.length,3);
  assert.equal(messages[2].result.structuredContent.code,'ASSISTANT_CAPABILITY_UNAVAILABLE');
  assert.equal(messages[3].result.structuredContent.code,'ASSISTANT_SETUP_INVALID_INPUT');
  assert.deepEqual(messages[4].result.structuredContent,{state:'not_started'});
  assert.equal(reads,1);assert.equal(created,1);assert.ok(!raw.includes('PRIVATE'));
});

test('oversized frames and unsupported entry commands fail before setup or private access', async () => {
  let created=0;
  await assert.rejects(runAssistantSetupMcp({input:Readable.from(['a'.repeat(131073)]),output:new PassThrough(),
    createSetup:async()=>{created++;}}),/FRAME_TOO_LARGE/);
  await assert.rejects(runAssistantEntry(['mcp','--human-oauth']),/COMMAND_UNSUPPORTED/);
  assert.equal(created,0);
});

test('assistant hook permits setup and blocks task tools without an installed host profile', async () => {
  for(const tool of ['mcp__trelio_assistant__get_task','mcp__plugin_trelio-digital-assistant_trelio-assistant__clear_task_control',
    'mcp__trelio_assistant__begin_assistant_setup']){
    const output=new PassThrough();let raw='';output.on('data',chunk=>raw+=chunk);
    await runAssistantEntry(['hook'],{input:Readable.from([JSON.stringify({hook_event_name:'PreToolUse',tool_name:tool})]),output,createHook:async()=>{throw Object.assign(new Error(),{code:'ASSISTANT_HOST_NOT_CONFIGURED'});}});
    const result=JSON.parse(raw);
    assert.equal(result.hookSpecificOutput?.permissionDecision,tool.endsWith('begin_assistant_setup')?undefined:'deny');
  }
});


test('stdio discovers live backend read schemas, notifies after pairing and keeps failures closed',async()=>{
  let paired=false,proxyCalls=0,setupCalls=0,raw='';const output=new PassThrough();output.on('data',chunk=>raw+=chunk);
  const tool={name:'get_task',description:'backend-owned',inputSchema:{type:'object'}};
  const frames=[{jsonrpc:'2.0',id:1,method:'initialize'},
    {jsonrpc:'2.0',id:2,method:'tools/list'},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'finish_assistant_setup',arguments:{enrollmentId:randomUUID()}}},
    {jsonrpc:'2.0',id:4,method:'tools/list'},
    {jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'get_task',arguments:{taskPass:{passId:'host'},runtimeSessionProof:{nonce:'hook'}}}},
    {jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'get_task'}},
    {jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'human_login',arguments:{}}}];
  await runAssistantSetupMcp({input:Readable.from(frames.map(frame=>JSON.stringify(frame)+'\n')),output,
    createSetup:async()=>({finish:async()=>{setupCalls++;paired=true;return {state:'paired',businessReady:false};}}),
    createMcp:async()=>paired?{listTools:async signal=>{assert.ok(signal);return [tool];},callTool:async(name,args,signal)=>{
      assert.ok(signal);proxyCalls++;assert.equal(name,'get_task');assert.equal(args.runtimeSessionProof.nonce,'hook');
      return {content:[{type:'text',text:'ordinary task content'}],structuredContent:{tasks:[]}};
    }}:null});
  const messages=raw.trim().split('\n').map(JSON.parse);
  assert.equal(messages[0].result.capabilities.tools.listChanged,true);
  assert.equal(messages[1].result.tools.length,3);
  assert.equal(messages[3].method,'notifications/tools/list_changed');
  assert.deepEqual(messages[4].result.tools.at(-1),tool);
  assert.equal(messages[5].result.content[0].text,'ordinary task content');
  assert.equal(messages[6].result.isError,true);assert.equal(messages[7].result.isError,true);
  assert.equal(proxyCalls,1);assert.equal(setupCalls,1);
  raw='';await runAssistantSetupMcp({input:Readable.from([JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})+'\n',
    JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})+'\n']),output,
    createMcp:async()=>{throw new Error('PRIVATE DEVICE DETAIL');}});
  assert.ok(raw.includes('ASSISTANT_SETUP_UNAVAILABLE'));assert.ok(!raw.includes('PRIVATE'));
});
