/** Actual common package/account/process engine in an isolated synthetic HOME.
 * Native HTTP data is disposable; no provider, live account or human vault is
 * contacted. This proves composition, not a real Avito/Windows login. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,generateKeyPairSync,sign,createHash,verify,createPublicKey} from 'node:crypto';
import {Readable,PassThrough} from 'node:stream';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'trelio-local-skill-'));
for(const key of ['HOME','USERPROFILE','XDG_CONFIG_HOME','XDG_CACHE_HOME','LOCALAPPDATA','CODEX_HOME','TRELIO_CONFIG_HOME']){
  process.env[key]=path.join(root,key.toLowerCase());await fs.mkdir(process.env[key],{recursive:true,mode:0o700});
}
const common=await import('../host-runtime/scripts/trelio-workspace.mjs');
const {executeAssistantLocalSkillTool,withAssistantLocalSkillProfile,assistantLocalSkillArguments,createAssistantLocalSkillHook,ASSISTANT_SKILL_TOOLS}=
  await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
const {withRuntimeHookPrivateSession}=await import('../host-runtime/scripts/trelio-hook-private-session.mjs');
const {runAssistantEntry}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
const origin='https://interactive-skill.example.test',companyId=randomUUID(),memberId=randomUUID();
const identity={schemaVersion:1,origin,assistantId:randomUUID(),deviceId:randomUUID()};
const credential='tda_'+'s'.repeat(43),prefix='/api/digital-assistants/runtime/source-skills/skills';
let active=null,privateReads=0,begins=0,downloads=0,remoteMode=false,loseBegin=false;
const host={configurationDirectory:root,readIdentity:async()=>identity,readActivePass:async()=>active};
const privateRecords=new Map();
const store={get:async slot=>{
  if(slot.kind==='local_runtime')return structuredClone(privateRecords.get(JSON.stringify(slot))??null);
  privateReads++;if(slot.kind==='company_encryption')return null;
  assert.deepEqual(slot,{origin,kind:'device',id:identity.assistantId});
  return {assistantId:identity.assistantId,deviceId:identity.deviceId,credential,expiresAt:1};
},put:async(slot,value)=>{assert.equal(slot.kind,'local_runtime');privateRecords.set(JSON.stringify(slot),structuredClone(value));}};
const client={companies:async()=>[{companyId,companySlug:'synthetic'}]};
const intents=new Map(),sessions=new Map(),{privateKey,publicKey}=generateKeyPairSync('ed25519');
const releaseId=randomUUID(),artifactId=randomUUID();
const source=path.join(root,'source');await fs.mkdir(source);
await fs.writeFile(path.join(source,'main.mjs'),`const fs=await import('node:fs');
  const args=process.argv.slice(2);if(args[0]==='__trelio_accounts_import')throw Error('must never import human accounts');
  const account=JSON.parse(process.env.TRELIO_SKILL_ACCOUNT_JSON);if(!account.id)throw Error('account required');
  let input='';for await(const chunk of process.stdin)input+=chunk;if(input)throw Error('unexpected stdin');
  fs.appendFileSync(${JSON.stringify(path.join(root,'calls'))},JSON.stringify(args)+'\\n');
  process.stdout.write(JSON.stringify(args[0]==='__trelio_account_remove'?{schemaVersion:1,removed:true,accountId:account.id}:
    {state:args[0]==='setup'?'manual_input_required':'saved_unverified',accountId:account.id}));`);
await fs.writeFile(path.join(source,'trelio-account-removal.json'),'{"schemaVersion":1}');
const packageBytes=await common.buildAgentSkillPackage({skillId:'avito',runtimeVersion:'0.99.0',sourceDirectory:source,
  entrypointPath:'main.mjs',interpreter:'node',capabilities:['local-session','local-accounts-v1']});
const resolution=()=>({releaseId,company:{id:companyId,slug:'synthetic',name:'Synthetic'},
  localIdentity:{companyId,projectId:null,skillId:'avito',memberId,connectionId:null},companyConnection:null,
  trust:{level:'platform_verified',artifactLevel:'platform_verified',requiresDeviceConsent:false,consentId:null},
  packageUrl:'/api/agent-skills/runtime/package?'+new URLSearchParams({companyId,skillId:'avito',expectedReleaseId:releaseId,artifactId}),
  artifact:{id:artifactId,skillId:'avito',runtimeVersion:'0.99.0',packageFormat:'trelio-agent-skill-package/v1',contentProtection:'plain',
    packageSha256:createHash('sha256').update(packageBytes).digest('hex'),packageSizeBytes:packageBytes.length,
    packageSignature:sign(null,packageBytes,privateKey).toString('base64'),signingKeyId:'fixture',
    signingPublicKeySpki:publicKey.export({type:'spki',format:'der'}).toString('base64'),minimumHostVersion:'3.7.0',manifest:{}}});
const originalFetch=globalThis.fetch;
const rules='# Synthetic interactive platform rules\n',rulesHash=createHash('sha256').update(rules).digest('hex'),rulesRevision=randomUUID();
globalThis.fetch=async(url,options)=>{
  url=new URL(url);
  if(url.origin==='https://provider.example.test'){
    assert.equal(new Headers(options.headers).get('authorization'),null,'no human/assistant native credential reaches the provider');
    if(options.method==='DELETE')return new Response(null,{status:204});
    const body=JSON.parse(options.body);
    if(body.method==='notifications/initialized')return new Response(null,{status:202});
    const result=body.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.0.0'}}:
      body.method==='tools/list'?{tools:[{name:'read_echo',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]}:
      {content:[{type:'text',text:'synthetic remote read'}]};
    return Response.json({jsonrpc:'2.0',id:body.id,result},{headers:{'mcp-session-id':'fixture'}});
  }
  assert.equal(url.origin,origin);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
  assert.equal(options.headers.get('authorization'),'Bearer '+credential);
  assert.equal(options.headers.get('cookie'),null);assert.equal(options.headers.get('x-trelio-assistant-pass'),null);
  const body=options.body?JSON.parse(options.body):null;
  if(url.pathname===prefix+'/read')return Response.json({companyId,skill:{id:'avito',instructionsMarkdown:'Use ordinary account list/create, setup, wait. No assistant-only descriptor.',
    currentReleaseId:releaseId,runtimeRelease:remoteMode?null:{releaseId},remoteMcp:remoteMode?{minimumHostVersion:'1.4.3'}:null}});
  if(url.pathname===prefix+'/runtime/register'){
    let session=[...sessions.values()].find(row=>row.publicKeySpki===body.publicKeySpki);
    if(!session){session={...body,runtimeSessionId:randomUUID(),expiresAt:body.previousRuntimeSessionId?sessions.get(body.previousRuntimeSessionId).expiresAt:new Date(Date.now()+300000).toISOString(),
      conversation:{conversationId:body.clientSessionId},runtimeRefreshSupported:true};sessions.set(session.runtimeSessionId,session);}
    return Response.json(session);
  }
  if(url.pathname===prefix+'/runtime/end'){sessions.get(body.runtimeSessionId).ended=true;return Response.json({ended:true});}
  if(url.pathname===prefix+'/prepare'){
    const proof=body.runtimeSessionProof,session=sessions.get(proof?.runtimeSessionId);assert.ok(session);
    assert.equal(verify(null,Buffer.from(['trelio-runtime-proof-v1',proof.runtimeSessionId,'use_assistant_skill',proof.issuedAt,proof.nonce].join('\n')),
      createPublicKey({key:Buffer.from(session.publicKeySpki,'base64url'),type:'spki',format:'der'}),Buffer.from(proof.signature,'base64url')),true);
    let plan=intents.get(body.clientRequestId);
    if(!plan){plan={schemaVersion:1,companyId,projectId:null,skillId:'avito',requestId:body.clientRequestId,deviceId:identity.deviceId,
      memberId,releaseId,runtimeSessionId:session.runtimeSessionId,state:'prepared',taskRequired:false,backgroundEnabled:false};intents.set(plan.requestId,plan);}
    const {attemptId,...modelPlan}=plan;return Response.json({...modelPlan,reconcileOnly:plan.state==='attempted'});
  }
  if(url.pathname===prefix+'/begin'){
    begins++;const plan=intents.get(body.clientRequestId);assert.equal(plan.state,'prepared');
    plan.state='attempted';plan.attemptId=randomUUID();if(loseBegin){loseBegin=false;throw new Error('synthetic lost native reply');}return Response.json(plan);
  }
  const binding=JSON.parse(options.headers.get('x-trelio-assistant-local-skill-setup'));
  const plan=intents.get(binding.requestId);assert.ok(plan);assert.equal(binding.companyId,companyId);
  if(plan.state==='attempted')assert.equal(binding.attemptId,plan.attemptId);
  if(url.pathname===prefix+'/compatibility')return Response.json({supported:true,minimumVersion:'0.0.0',agentRules:{
    status:options.headers.get('x-trelio-agent-rules-sha256')===rulesHash?'current':'update_required',revisionId:rulesRevision,
    version:1,sha256:rulesHash,rulesMarkdown:rules}});
  if(url.pathname==='/api/agent-skills/remote-mcp/resolve')return Response.json({releaseId,skill:{id:'avito',version:'1.0.0',title:'Synthetic remote'},
    localIdentity:{companyId,projectId:null,skillId:'avito',memberId},remoteMcp:{minimumHostVersion:'1.4.3',configFingerprint:'a'.repeat(64),
      config:{schemaVersion:2,transport:'streamable_http',endpoint:'https://provider.example.test/mcp',protocolVersion:'2025-03-26',
        authentication:{type:'none'},toolPolicy:{mode:'all_read_only'},headers:{},credentialHelp:null}}});
  if(url.pathname==='/api/agent-skills/runtime/resolve')return Response.json(resolution());
  assert.equal(url.pathname,'/api/agent-skills/runtime/package');downloads++;return new Response(packageBytes);
};
test.after(async()=>{globalThis.fetch=originalFetch;await fs.rm(root,{recursive:true,force:true});});
let observedEffort='high';
const threadId=randomUUID(),observation=()=>({schemaVersion:1,clientFamily:'codex',modelId:'gpt-6.1-sol',effortLevel:observedEffort,
  evidenceLevel:'local_observed',source:'codex_hook',observedAt:new Date().toISOString()});
const hook=createAssistantLocalSkillHook({identity,host,store,client,common,observe:async()=>observation(),lock:async(_file,action)=>action()});
const observedInput=tool_input=>withRuntimeHookPrivateSession(45000,async()=>{
  const observed=await hook({hook_event_name:'PreToolUse',session_id:threadId,tool_input});return observed.hookSpecificOutput.updatedInput;
});
const use=async(argv,clientRequestId=randomUUID())=>{
  const tool_input={companyId,projectId:null,skillId:'avito',releaseId,clientRequestId,operation:'run',parameters:{arguments:argv}};
  return executeAssistantLocalSkillTool('use_assistant_skill',await observedInput(tool_input),{identity,host,store,client,common});
};

test('ordinary published package works without an assistant setup declaration or task policy',async()=>{
  const listed=await use(['account','list']);const catalogue=listed.structuredContent;
  assert.equal(catalogue.accounts.length,0);
  const created=await use(['account','create','--name','Synthetic account','--expected-revision',String(catalogue.revision)]);
  const accountId=created.structuredContent.accounts[0].id;
  const requestId=randomUUID(),started=await use(['--local-account',accountId,'setup'],requestId);
  assert.equal(JSON.parse(started.content[0].text).state,'manual_input_required');
  const before=begins,repeated=await use(['--local-account',accountId,'setup'],requestId);
  assert.equal(repeated.replayAllowed,false);assert.equal(begins,before);
  const waited=await use(['--local-account',accountId,'wait']);
  assert.equal(JSON.parse(waited.content[0].text).state,'saved_unverified');
  assert.deepEqual((await fs.readFile(path.join(root,'calls'),'utf8')).trim().split('\n').map(JSON.parse),[['setup'],['wait']]);
  assert.ok(downloads>=1);
  assert.equal((await use(['account','list'])).structuredContent.accounts[0].id,accountId,'the SAME managed account survives independent ordinary chat calls');
  const updated=await use(['account','update','--id',accountId,'--name','Renamed account','--expected-revision',String(created.structuredContent.revision)]);
  assert.equal(updated.structuredContent.accounts[0].name,'Renamed account');
  const selected=await use(['account','default','--id',accountId,'--expected-revision',String(updated.structuredContent.revision)]);
  assert.equal(selected.structuredContent.accounts[0].default,true);
});

test('invalid arguments and active background/intake reject before private storage/provider I/O',async()=>{
  const base={companyId,projectId:null,skillId:'avito',releaseId,clientRequestId:randomUUID(),operation:'run',parameters:{arguments:['status']}};
  for(const bad of [{...base,passId:randomUUID()},{...base,parameters:{arguments:[],token:'private'}},{...base,operation:'run',parameters:{arguments:['x\0y']}}])
    assert.throws(()=>assistantLocalSkillArguments('use_assistant_skill',bad),/INVALID_INPUT/);
  const before=privateReads;active={kind:'source_intake'};
  await assert.rejects(use(['status']),/TASK_ACTIVE/);assert.equal(privateReads,before);active=null;
});

test('host browser-controller commands require the same signed opt-in before any provider invocation',async()=>{
  const before=await fs.readFile(path.join(root,'calls'),'utf8');
  await assert.rejects(use(['browser-controller','status',randomUUID()]),error=>error.code==='BROWSER_CONTROLLER_COMMAND_DENIED');
  assert.equal(await fs.readFile(path.join(root,'calls'),'utf8'),before);
});

test('private HTTP profile refuses foreign paths, duplicate query fields and caller identity headers',async()=>{
  const input=await observedInput({companyId,projectId:null,skillId:'avito',releaseId,clientRequestId:randomUUID(),operation:'run',parameters:{arguments:['status']}});
  await withAssistantLocalSkillProfile({identity,host,store,client,companyId,common,configure:true},async context=>{
    const plan=await context.requestJson('/prepare',{companyId,projectId:null,skillId:'avito',expectedReleaseId:releaseId,clientRequestId:input.clientRequestId,runtimeSessionProof:input.runtimeSessionProof});context.setPlan(plan);
    const profile=context.profile,token=context.token,before=privateReads;
    const options={method:'GET'},buildHeaders=()=>new Headers({'cookie':'private','x-trelio-assistant-source-encryption-fingerprint':'forged'});
    for(const pathname of ['https://foreign.example.test/api/agent-skills/runtime/package','/api/agent-secrets/checkout',
      '/api/agent-skills/runtime/package?companyId='+companyId+'&companyId='+companyId])
      await assert.rejects(profile.prepareRequest({origin,token,pathname,options,buildHeaders}),/ORIGIN_DENIED/);
    assert.equal(privateReads,before);
    const prepared=await profile.prepareRequest({origin,token,pathname:'/api/agent-workspaces/bridge-compatibility',options,buildHeaders});
    assert.equal(prepared.headers.get('cookie'),null);assert.equal(prepared.headers.get('x-trelio-assistant-source-encryption-fingerprint'),null);
  });
});

test('ordinary chat Remote MCP uses the same native declaration and protocol engine without a human admission cache',async()=>{
  remoteMode=true;
  try{
    const input=await observedInput({companyId,projectId:null,skillId:'avito',releaseId,clientRequestId:randomUUID(),operation:'doctor_remote',parameters:{}});
    await withAssistantLocalSkillProfile({identity,host,store,client,companyId,common,configure:true},async context=>{
      const plan=await context.requestJson('/prepare',{companyId,projectId:null,skillId:'avito',expectedReleaseId:releaseId,clientRequestId:input.clientRequestId,runtimeSessionProof:input.runtimeSessionProof});context.setPlan(plan);
      await context.beginRemote();
      const remote=await import('../host-runtime/scripts/trelio-remote-mcp.mjs');
      const resolved=await remote.resolveRemoteMcpDeclaration(origin,{companyId,projectId:null,skillId:'avito',releaseId});
      const methods=[];
      const result=await remote.doctorWithCredential(resolved,null,{httpRequest:async request=>{
        const method=request.method==='DELETE'?'DELETE':request.payload.method;methods.push(method);
        return {sessionId:'fixture',message:['DELETE','notifications/initialized'].includes(method)?null:
          {jsonrpc:'2.0',id:request.payload.id,result:method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{}}:
            {tools:[{name:'read_echo',inputSchema:{type:'object'},annotations:{readOnlyHint:true,destructiveHint:false}}]}}};
      }});
      assert.equal(result.ok,true);assert.deepEqual(result.tools.map(row=>row.name),['read_echo']);
      assert.deepEqual(methods,['initialize','notifications/initialized','tools/list','DELETE']);
    });
  }finally{remoteMode=false;}
});

test('lost native begin is durable and cannot replay the ordinary provider command',async()=>{
  const account=(await use(['account','list'])).structuredContent.accounts[0].id;
  const before=await fs.readFile(path.join(root,'calls'),'utf8'),requestId=randomUUID();loseBegin=true;
  await assert.rejects(use(['--local-account',account,'setup'],requestId));
  const repeated=await use(['--local-account',account,'setup'],requestId);
  assert.equal(repeated.state,'attempt_already_recorded');assert.equal(repeated.replayAllowed,false);
  assert.equal(await fs.readFile(path.join(root,'calls'),'utf8'),before);
});

test('ordinary chat removes only its exact managed account after the same signed erasure receipt',async()=>{
  const listed=(await use(['account','list'])).structuredContent;
  const created=(await use(['account','create','--name','Disposable account','--expected-revision',String(listed.revision)])).structuredContent;
  const account=created.accounts.find(row=>row.name==='Disposable account');assert.ok(account);
  const before=begins;
  const removed=(await use(['account','remove','--id',account.id,'--expected-revision',String(created.revision),'--confirm'])).structuredContent;
  assert.equal(removed.removed,true);assert.equal(removed.localSessionRemoved,true);assert.equal(begins,before+1);
  assert.equal(removed.accounts.some(row=>row.id===account.id),false);
  assert.deepEqual(JSON.parse((await fs.readFile(path.join(root,'calls'),'utf8')).trim().split('\n').at(-1)),['__trelio_account_remove']);
});

test('interactive signed Secret setup uses the common process environment but never returns its stdout',async()=>{
  const provider=path.join(root,'secret-provider');await fs.mkdir(provider);
  await fs.writeFile(path.join(provider,'main.mjs'),"process.stdout.write(JSON.stringify({credential:process.env.TRELIO_FIXTURE_PASSWORD}));\n");
  const command={id:'authenticate',purpose:'authenticate',arguments:['authenticate'],bindingKey:'login',fieldKey:'password',environmentVariable:'TRELIO_FIXTURE_PASSWORD'};
  await fs.writeFile(path.join(provider,'trelio-secret-setup.json'),JSON.stringify({schemaVersion:2,commands:[command]}));
  const bytes=await common.buildAgentSkillPackage({skillId:'secret-fixture',runtimeVersion:'1.0.0',sourceDirectory:provider,
    entrypointPath:'main.mjs',interpreter:'node',capabilities:['local-session','secret-checkout']});
  // Materialization/signature/account composition is covered above. This
  // exact process boundary deliberately gives a synthetic value to a provider
  // that echoes it, proving capture cannot expose it even after a zero exit.
  const artifact={id:randomUUID(),skillId:'secret-fixture',runtimeVersion:'1.0.0',parsedPackage:common.parseAndValidateAgentSkillPackage(bytes,'secret-fixture')};
  let deliveries=0,attempts=0,checks=0;
  const profile={kind:'digital_assistant',interactiveLocal:true,requireToken:async()=>assert.fail('no HTTP'),prepareRequest:async()=>assert.fail('no HTTP'),
    authorizeInteractiveSkillCommand:async()=>{attempts++;return 60000;},assertInteractiveSkillCurrent:async()=>{checks++;}};
  const result=await common.withWorkspaceExecutionProfile(profile,()=>common.runMaterializedAgentSkill({artifact,runtimeDirectory:provider,
    runtimeArguments:['authenticate'],executionContext:{companyId,projectId:null,releaseId,localIdentity:{memberId}},
    captureOutput:true,captureMode:'assistant_interactive',timeoutMs:60000,
    prepareSetupEnvironment:async()=>{deliveries++;return {TRELIO_FIXTURE_PASSWORD:'SYNTHETIC_PRIVATE_FACTOR'};}}));
  assert.deepEqual(JSON.parse(result.stdout),{schemaVersion:1,state:'command_completed',verificationRequired:true});
  assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE_FACTOR|credential/);assert.equal(deliveries,1);assert.equal(attempts,1);assert.equal(checks,1);
});

test('actual hook entry replaces model proof, preserves ordinary args and refreshes without renewing expiry',async()=>{
  const tool_input={companyId,projectId:null,skillId:'avito',releaseId,clientRequestId:randomUUID(),operation:'run',parameters:{arguments:['status']},
    runtimeSessionProof:{modelAuthored:'must be replaced'}};
  const before=[...privateRecords.values()][0].state,output=new PassThrough();let text='';output.on('data',chunk=>text+=chunk);
  observedEffort='max';
  await runAssistantEntry(['hook'],{input:Readable.from([JSON.stringify({hook_event_name:'PreToolUse',session_id:threadId,
    tool_name:'mcp__trelio_assistant__use_assistant_skill',tool_input})]),output,createLocalSkillHook:async()=>hook});
  const decision=JSON.parse(text).hookSpecificOutput;assert.equal(decision.permissionDecision,'allow');
  assert.deepEqual(decision.updatedInput.parameters,tool_input.parameters);
  const proof=decision.updatedInput.runtimeSessionProof,session=sessions.get(proof.runtimeSessionId);
  assert.equal(session.observation.effortLevel,'max');assert.equal(session.expiresAt,before.expiresAt);
  assert.equal(verify(null,Buffer.from(['trelio-runtime-proof-v1',proof.runtimeSessionId,'use_assistant_skill',proof.issuedAt,proof.nonce].join('\n')),
    createPublicKey({key:Buffer.from(session.publicKeySpki,'base64url'),format:'der',type:'spki'}),Buffer.from(proof.signature,'base64url')),true);
  assert.doesNotMatch(text,/privateKey|publicKey|modelAuthored/);
  await withRuntimeHookPrivateSession(45000,()=>hook({hook_event_name:'SessionEnd',session_id:threadId}));
  assert.equal([...privateRecords.values()][0].ended,true);assert.equal(session.ended,true);
});

test('ordinary-chat discovery stays bounded and does not advertise attestation or credentials as model arguments',async()=>{
  const {get_encoding}=await import('tiktoken');const encoding=get_encoding('o200k_base');
  try{
    const serialized=JSON.stringify(ASSISTANT_SKILL_TOOLS);
    assert.ok(Buffer.byteLength(serialized)<=9000);assert.ok(encoding.encode(serialized).length<=2000);
    assert.equal(ASSISTANT_SKILL_TOOLS.length,2);
    for(const tool of ASSISTANT_SKILL_TOOLS){assert.equal(tool.inputSchema.additionalProperties,false);
      for(const key of ['runtimeSessionProof','observation','credential','password'])assert.equal(tool.inputSchema.properties[key],undefined);}
  }finally{encoding.free();}
});
