/** Synthetic signed packages, private fixture roots and native subprocesses.
 * No live account, human OAuth, provider request or production package is read. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,generateKeyPairSync,sign,createHash} from 'node:crypto';

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'trelio-source-reader-'));
for(const key of ['HOME','USERPROFILE','XDG_CONFIG_HOME','XDG_CACHE_HOME','LOCALAPPDATA','CODEX_HOME','TRELIO_CONFIG_HOME']){
  process.env[key]=path.join(directory,key.toLowerCase());
  await fs.mkdir(process.env[key],{recursive:true,mode:0o700});
}
const engine=await import('../host-runtime/scripts/trelio-workspace.mjs');
const {createAssistantSourceRuntimeProfile,readAssistantSourceMonitor,projectAssistantMonitorPage}=
  await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
const {accountScope,createAccountCatalogue}=await import('../host-runtime/scripts/trelio-skill-accounts.mjs');
const origin='https://source.test',assistantId=randomUUID(),deviceId=randomUUID(),companyId=randomUUID(),memberId=randomUUID();
const identity={schemaVersion:1,origin,assistantId,deviceId},scope={companyId,projectId:null,skillId:'telegram-mtproto'};
const credential=`tda_${'k'.repeat(43)}`;
let reads=0,liveIdentity=identity;
const host={readIdentity:async()=>structuredClone(liveIdentity)};
const store={get:async slot=>{
  reads++;assert.deepEqual(slot,{origin,kind:'device',id:assistantId});
  return {assistantId,deviceId,credential,expiresAt:1};
}};
const admission=()=>({schemaVersion:1,assistantUserId:assistantId,deviceId,provider:'telegram',protocol:'telegram-monitor/v1',
  command:'monitor',pollIntervalSeconds:300,maximumDurationMs:60000,
  issuedAt:'2026-10-21T00:00:00.000Z',expiresAt:'2026-10-21T00:02:00.000Z'});
const previousCursor='previous.'+'c'.repeat(64),nextCursor='next.'+'d'.repeat(64);
const event={id:'message:123:5',revision:'a'.repeat(64),kind:'new',chatId:'123',messageId:'5',topicId:null,
  senderUserId:'123',senderNamespace:'telegram_user_id',outgoing:false,forwarded:false,viaBot:false};
const page=()=>({schemaVersion:1,baselineOnly:false,events:[{...event,text:'PRIVATE_BODY',credential:'PRIVATE_PROVIDER'}],
  nextCursor,hasMore:false,channelsToSync:['456'],unresolvedDeletionIds:[],stream:{kind:'account_cloud',chatId:null},
  coverage:{historicalBackfill:false,secretChatsIncluded:false,otherChannelStreamsIncluded:false},
  readState:{readReceiptsSent:false,viewsRegistered:false}});
const prefix='/api/digital-assistants/runtime/source-skills';
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
let artifactId=randomUUID(),releaseId=randomUUID(),packageBytes=Buffer.from('{}');
const payload=()=>({releaseId,company:{id:companyId,slug:'synthetic',name:'Synthetic'},
  localIdentity:{...scope,memberId,connectionId:null},companyConnection:null,
  trust:{level:'platform_verified',artifactLevel:'platform_verified',requiresDeviceConsent:false,consentId:null},
  packageUrl:`${prefix}/package?${new URLSearchParams({...scope,expectedReleaseId:releaseId,artifactId}).toString().replace('projectId=null&','')}`,
  artifact:{id:artifactId,skillId:scope.skillId,runtimeVersion:'2.99.42',packageFormat:'trelio-agent-skill-package/v1',contentProtection:'plain',
    packageSha256:createHash('sha256').update(packageBytes).digest('hex'),packageSizeBytes:packageBytes.length,
    packageSignature:sign(null,packageBytes,privateKey).toString('base64'),signingKeyId:'synthetic-test',
    signingPublicKeySpki:publicKey.export({type:'spki',format:'der'}).toString('base64'),minimumHostVersion:'3.10.1',manifest:{}},
  sourceAdmission:admission()});
// URL parameters are independently constructed, never an arbitrary package URL.
const resolution=()=>{
  const raw=payload();const query=new URLSearchParams({companyId,skillId:scope.skillId,expectedReleaseId:releaseId,artifactId});
  raw.packageUrl=`${prefix}/package?${query}`;return raw;
};
const originalFetch=globalThis.fetch;
let resolveCalls=0,downloadCalls=0,resolveOverride=null,downloadOverride=null;
globalThis.fetch=async(url,options)=>{
  assert.equal(url.origin,origin);assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
  assert.equal(options.headers.get('authorization'),`Bearer ${credential}`);
  assert.equal(options.headers.get('x-trelio-assistant-source-protocol'),'1');
  assert.equal(options.headers.get('cookie'),null);assert.equal(options.headers.get('x-trelio-assistant-pass'),null);
  assert.ok(options.headers.get('x-trelio-host-runtime-version'));
  if(url.pathname===`${prefix}/resolve`){
    resolveCalls++;assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{...scope,expectedReleaseId:null});
    return resolveOverride?.()??new Response(JSON.stringify(resolution()),{headers:{'content-type':'application/json'}});
  }
  assert.equal(url.pathname,`${prefix}/package`);downloadCalls++;
  return downloadOverride?.()??new Response(packageBytes);
};
test.after(async()=>{globalThis.fetch=originalFetch;await fs.rm(directory,{recursive:true,force:true});});

test('source profile fences destinations before credential I/O and never extends its original deadline',async()=>{
  let time=0;const before=reads;
  const profile=await createAssistantSourceRuntimeProfile({identity,host,store,scope,monotonic:()=>time,startedAt:0});
  const token=await profile.requireToken(origin),buildHeaders=()=>new Headers({cookie:'PRIVATE_COOKIE',authorization:'PRIVATE_HUMAN'});
  for(const pathname of ['/api/agent-skills/runtime/package?x=y',`${prefix}/../admin`,`${prefix}/package?x=y`,'https://other.test/']){
    await assert.rejects(profile.prepareRequest({origin,token,pathname,options:{},buildHeaders}),/ORIGIN_DENIED/);
  }
  assert.equal(reads,before);
  time=119000;
  await profile.prepareRequest({origin,token,pathname:`${prefix}/resolve`,options:{method:'POST',body:JSON.stringify({...scope,expectedReleaseId:null})},buildHeaders});
  await profile.bindResolution(engine.normalizeResolvedSkillRuntimeArtifact(resolution(),{transportProfile:'assistant_source'}),admission());
  assert.equal(await profile.remainingMs(),1000);
  time=120000;
  await assert.rejects(profile.requireToken(origin),/DEADLINE/);
  time=0;profile.close();await assert.rejects(profile.requireToken(origin),/DEADLINE/);
  assert.equal(reads,before+1);
});

test('source reader composes real signature/cache/account/executor and resolves afresh on every read',async()=>{
  const sourceDir=path.join(directory,'package');await fs.mkdir(sourceDir);
  const entry=`import assert from 'node:assert/strict';
    const args=process.argv.slice(2);
    if(args[0]==='__trelio_accounts_import'){process.stdout.write(JSON.stringify({schemaVersion:1,accounts:[]}));}
    else {
      assert.equal(args[0],'monitor');assert.equal(process.env.CODEX_THREAD_ID,undefined);
      assert.equal(process.env.TRELIO_SKILL_COMPANY_ID,${JSON.stringify(companyId)});
      const account=JSON.parse(process.env.TRELIO_SKILL_ACCOUNT_JSON);assert.equal(account.id,${JSON.stringify('ACCOUNT_ID')});
      let stdin='';for await(const chunk of process.stdin)stdin+=chunk;assert.equal(stdin,'');
      const fs=await import('node:fs');fs.appendFileSync(${JSON.stringify(path.join(directory,'native-calls'))},'1');
      process.stdout.write(JSON.stringify(${JSON.stringify(page())}));
    }`;
  const makeCatalogue=(root,selectedCompany=companyId)=>createAccountCatalogue({directory:root,
    scope:accountScope({origin,skillId:scope.skillId,companyId:selectedCompany,memberId,connectionId:null}),io:{
      ensureDirectory:engine.ensurePrivateDirectory,read:engine.readPrivateJsonFile,write:engine.writePrivateJsonFile,
      checkDirectory:dir=>engine.assertPrivatePathKind(dir,'directory')}});
  // Both managed profiles must consume an explicitly bound assistant account.
  // A human catalogue with an otherwise identical company/member is a canary:
  // source admission must not import or select it under the daemon's OS user.
  const human=makeCatalogue(engine.resolveWorkspaceBridgeConfigDirectory());
  await human.change({operation:'create',id:randomUUID(),name:'PRIVATE_HUMAN_ACCOUNT',expectedRevision:0});
  const humanAccount=(await human.list()).accounts[0].id,humanRevision=(await human.list()).revision;
  const accountProfile=await createAssistantSourceRuntimeProfile({identity,host,store,scope});
  const accountDirectory=await accountProfile.resolveSkillCatalogueDirectory(engine.resolveWorkspaceBridgeConfigDirectory());
  accountProfile.close();
  await assert.rejects(accountProfile.resolveSkillCatalogueDirectory(engine.resolveWorkspaceBridgeConfigDirectory()),/DEADLINE/);
  const catalogue=makeCatalogue(accountDirectory);
  await catalogue.importOnce(async()=>[]);
  const accountId=randomUUID();await catalogue.change({operation:'create',id:accountId,name:'Synthetic',expectedRevision:(await catalogue.list()).revision});
  await fs.writeFile(path.join(sourceDir,'main.mjs'),entry.replace('ACCOUNT_ID',accountId));
  packageBytes=await engine.buildAgentSkillPackage({skillId:scope.skillId,runtimeVersion:'2.99.42',sourceDirectory:sourceDir,
    entrypointPath:'main.mjs',interpreter:'node',capabilities:['network','local-session','local-accounts-v1']});
  const source={...scope,accountId,cursor:previousCursor};
  const projected={schemaVersion:1,baselineOnly:false,events:[event],nextCursor,hasMore:false,
    channelsToSync:['456'],unresolvedDeletionIds:[]};
  const before=resolveCalls;
  await assert.rejects(readAssistantSourceMonitor({identity,host,store,source:{...source,accountId:humanAccount}}),
    error=>error.code==='ASSISTANT_SOURCE_ACCOUNT_REQUIRED' && !JSON.stringify(error).includes('PRIVATE'));
  await assert.rejects(fs.stat(path.join(directory,'native-calls')),{code:'ENOENT'});
  assert.equal((await human.list()).revision,humanRevision,'source cannot mutate/import the human catalogue');
  const foreign=makeCatalogue(accountDirectory,randomUUID()),foreignAccount=randomUUID();
  await foreign.change({operation:'create',id:foreignAccount,name:'PRIVATE_OTHER_COMPANY',expectedRevision:(await foreign.list()).revision});
  await assert.rejects(readAssistantSourceMonitor({identity,host,store,source:{...source,accountId:foreignAccount}}),/ACCOUNT_REQUIRED/);
  await assert.rejects(fs.stat(path.join(directory,'native-calls')),{code:'ENOENT'});
  assert.deepEqual(await readAssistantSourceMonitor({identity,host,store,source}),projected);
  assert.deepEqual(await readAssistantSourceMonitor({identity,host,store,source}),projected);
  assert.equal(resolveCalls,before+4);assert.equal(downloadCalls,1,'verified cache never bypasses fresh server admission');
  let listed,discoveries=0;
  const localProfile=await createAssistantSourceRuntimeProfile({identity,host,store,scope});
  const prepare=runtimeArguments=>engine.withWorkspaceExecutionProfile(localProfile,()=>engine.prepareSkillAccount({origin,
    artifact:{skillId:scope.skillId},runtimeDirectory:sourceDir,executionContext:{companyId,localIdentity:{memberId,connectionId:null}},
    runtimeArguments,discover:async()=>{discoveries++;throw new Error('PRIVATE_IMPORT_FORBIDDEN');},output:value=>{listed=value;}}));
  await prepare(['account','list']);
  assert.deepEqual(listed.accounts.map(account=>account.id),[accountId]);
  assert.doesNotMatch(JSON.stringify(listed),/PRIVATE_OTHER_COMPANY|PRIVATE_HUMAN_ACCOUNT/);
  assert.equal(discoveries,0);
  const revision=(await catalogue.list()).revision;
  await assert.rejects(prepare(['account','create','--name','Forbidden','--expected-revision',String(revision)]),/SETUP_REQUIRED/);
  assert.equal((await catalogue.list()).revision,revision);
  localProfile.close();
  for(const changedIdentity of [{...identity,assistantId:randomUUID()},{...identity,deviceId:randomUUID()}]){
    const isolated=await createAssistantSourceRuntimeProfile({identity:changedIdentity,
      host:{readIdentity:async()=>changedIdentity},store,scope});
    const isolatedDirectory=await isolated.resolveSkillCatalogueDirectory(engine.resolveWorkspaceBridgeConfigDirectory());
    assert.notEqual(isolatedDirectory,accountDirectory);
    await assert.rejects(engine.withWorkspaceExecutionProfile(isolated,()=>engine.prepareSkillAccount({origin,
      artifact:{skillId:scope.skillId},runtimeDirectory:sourceDir,executionContext:{companyId,localIdentity:{memberId}},
      runtimeArguments:['monitor','--local-account',accountId],discover:async()=>assert.fail('managed source attempted import')})),
    /ACCOUNT_NOT_BOUND/);
    isolated.close();
  }
  // Corrupt executable bytes without changing any remote metadata. Marker and
  // prior successful execution cannot authorize this tampered cache entry.
  const cacheRoot=process.platform==='win32'?path.join(process.env.LOCALAPPDATA,'Trelio','workspace-bridge','cache'):
    path.join(process.env.XDG_CACHE_HOME,'trelio','workspace-bridge');
  const cacheDir=path.join(cacheRoot,'skill-runtimes',scope.skillId,'2.99.42',resolution().artifact.packageSha256);
  await fs.writeFile(path.join(cacheDir,'main.mjs'),'throw new Error("PRIVATE_TAMPERED");');
  assert.deepEqual(await readAssistantSourceMonitor({identity,host,store,source}),projected);
  assert.equal(downloadCalls,2);
  resolveOverride=()=>new Response(JSON.stringify({code:'ASSISTANT_DEVICE_REVOKED',message:'PRIVATE_BACKEND'}),{status:401});
  await assert.rejects(readAssistantSourceMonitor({identity,host,store,source}),error=>error.code==='ASSISTANT_DEVICE_REVOKED' && !JSON.stringify(error).includes('PRIVATE'));
  assert.equal(downloadCalls,2);resolveOverride=null;
  const callsBefore=await fs.readFile(path.join(directory,'native-calls'),'utf8');
  artifactId=randomUUID();
  downloadOverride=()=>new Response(Buffer.from('PRIVATE_CORRUPT_PACKAGE'));
  await assert.rejects(readAssistantSourceMonitor({identity,host,store,source}),/SOURCE_UNAVAILABLE/);
  assert.equal(await fs.readFile(path.join(directory,'native-calls'),'utf8'),callsBefore);
  downloadOverride=null;
  resolveOverride=()=>new Response(JSON.stringify({...resolution(),sourceAdmission:{...admission(),deviceId:randomUUID()}}));
  await assert.rejects(readAssistantSourceMonitor({identity,host,store,source}),/INVALID_RESPONSE/);
  assert.equal(await fs.readFile(path.join(directory,'native-calls'),'utf8'),callsBefore);
  resolveOverride=null;
  const wrong={...source,accountId:randomUUID()};
  await assert.rejects(readAssistantSourceMonitor({identity,host,store,source:wrong}),/SOURCE_/);
});

test('structural projection rejects bad pages, scope swaps, receipts and gaps without losing the old cursor',()=>{
  const options={skillId:scope.skillId,cursor:previousCursor};
  const project=value=>projectAssistantMonitorPage({exitCode:0,stdout:JSON.stringify(value)},options);
  const valid=project(page());assert.ok(!JSON.stringify(valid).includes('PRIVATE'));
  for(const change of [{schemaVersion:2},{events:null},{baselineOnly:true},{nextCursor:''},{hasMore:'false'},
    {readState:{readReceiptsSent:true}},{events:[{...event,senderNamespace:'username'}]},
    {events:[{...event,id:'bad'}]},{events:[event,event]},{stream:{kind:'channel',chatId:'123'}}]){
    assert.throws(()=>project({...page(),...change}),/INVALID_RESPONSE/);
  }
  for(const code of ['TELEGRAM_MONITOR_GAP','TELEGRAM_MONITOR_INVALID_CURSOR']){
    assert.throws(()=>projectAssistantMonitorPage({exitCode:1,stdout:JSON.stringify({code,message:'PRIVATE',nextCursor:'do_not_use'})},options),error=>error.code===code && !JSON.stringify(error).includes('PRIVATE'));
  }
  assert.throws(()=>projectAssistantMonitorPage({exitCode:1,stdout:JSON.stringify({code:'PRIVATE_ERROR',message:'PRIVATE'})},options),/SOURCE_PROVIDER_UNAVAILABLE/);
});

test('profile refuses changed identity and wrong package scope without touching a human credential',async()=>{
  const profile=await createAssistantSourceRuntimeProfile({identity,host,store,scope});
  const token=await profile.requireToken(origin),buildHeaders=()=>new Headers();
  const before=reads;
  liveIdentity={...identity,deviceId:randomUUID()};
  await assert.rejects(profile.prepareRequest({origin,token,pathname:`${prefix}/resolve`,
    options:{method:'POST',body:JSON.stringify({...scope,expectedReleaseId:null})},buildHeaders}),/BINDING_CHANGED/);
  assert.equal(reads,before);liveIdentity=identity;profile.close();
  for(const change of [raw=>{raw.packageUrl=raw.packageUrl.replace(companyId,randomUUID());},
    raw=>{raw.packageUrl+='&artifactId='+artifactId;},raw=>{raw.packageUrl+='&extra=PRIVATE';},
    raw=>{raw.sourceAdmission.maximumDurationMs=120000;},raw=>{raw.sourceAdmission.protocol='arbitrary-command';},
    raw=>{raw.localIdentity.projectId=randomUUID();},raw=>{raw.sourceAdmission.expiresAt='2027-10-21T00:02:00.000Z';}]){
    const p=await createAssistantSourceRuntimeProfile({identity,host,store,scope});
    const t=await p.requireToken(origin);
    await p.prepareRequest({origin,token:t,pathname:`${prefix}/resolve`,options:{method:'POST',body:JSON.stringify({...scope,expectedReleaseId:null})},buildHeaders});
    const raw=resolution();change(raw);
    await assert.rejects(p.bindResolution(engine.normalizeResolvedSkillRuntimeArtifact(raw,{transportProfile:'assistant_source'}),raw.sourceAdmission),/INVALID_RESPONSE/);
    p.close();
  }
});

test('email/MAX wire projections discard content and cannot promote a sender to owner authority',()=>{
  for(const skillId of ['email-imap-smtp','max-web']){
    const raw={schemaVersion:1,baselineOnly:false,nextCursor:'next',hasMore:false,
      coverage:{historicalBackfill:false,bodyContentRead:false,ownerIdentityAvailable:false,earlierEditsIncluded:false,otherChatsIncluded:false},
      readState:{readReceiptsSent:false},events:skillId==='email-imap-smtp'
        ?[{id:'uid:2:3',revision:'b'.repeat(64),kind:'new',uid:'3',uidValidity:'2',subject:'PRIVATE'}]
        :[{id:'message:stable',revision:'b'.repeat(64),kind:'edit',chatId:'chatref',messageId:'stable',senderUserId:null,senderNamespace:null,text:'PRIVATE'}]};
    const run=value=>projectAssistantMonitorPage({exitCode:0,stdout:JSON.stringify(value)},{skillId,cursor:previousCursor});
    assert.ok(!JSON.stringify(run(raw)).includes('PRIVATE'));
    assert.throws(()=>run({...raw,readState:{readReceiptsSent:true}}),/INVALID_RESPONSE/);
    if(skillId==='max-web')assert.throws(()=>run({...raw,events:[{...raw.events[0],senderUserId:'owner',senderNamespace:'username'}]}),/INVALID_RESPONSE/);
    assert.throws(()=>run({...raw,events:[],coverage:{historicalBackfill:false}}),/INVALID_RESPONSE/);
  }
});

test('task skills use the SAME signed package, native command and process engine with fresh pass admission',async()=>{
  const {createAssistantWorkspaceProfile}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const {executeAssistantWorkspacePlan}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const taskIdentity={schemaVersion:1,origin:'https://trelio.ru',assistantId:randomUUID(),deviceId:randomUUID()};
  const pass={schemaVersion:1,assistantId:taskIdentity.assistantId,deviceId:taskIdentity.deviceId,companyId:randomUUID(),taskId:randomUUID(),
    passId:randomUUID(),deliveryId:randomUUID(),threadId:randomUUID(),bindingId:randomUUID(),bindingRevision:1};
  const runtime={schemaVersion:1,passId:pass.passId,threadId:pass.threadId,state:{runtimeSessionId:randomUUID(),
    expiresAt:new Date(Date.now()+300000).toISOString(),privateKeyPkcs8:privateKey.export({type:'pkcs8',format:'der'}).toString('base64url'),
    observation:{schemaVersion:1,clientFamily:'codex',modelId:'gpt-6.1-sol',effortLevel:'high',evidenceLevel:'local_observed',source:'codex_hook'}}};
  let live=true;
  const taskHost={readIdentity:async()=>taskIdentity,readActivePass:async()=>pass};
  const taskStore={get:async slot=>slot.kind==='runtime'?runtime:{assistantId:taskIdentity.assistantId,deviceId:taskIdentity.deviceId,credential,expiresAt:1}};
  const client={readTaskPass:async()=>({...pass,state:live?'leased':'closed',leaseExpiresAt:new Date(Date.now()+300000).toISOString()})};
  const profile=await createAssistantWorkspaceProfile({identity:taskIdentity,client,store:taskStore,host:taskHost,
    lockDirectory:path.join(directory,'task-locks'),lock:(_file,action)=>action()});
  const sourceDir=path.join(directory,'task-package');await fs.mkdir(sourceDir);
  const calls=path.join(directory,'task-native-calls');
  // This executes a real signed Node provider through runWorkspaceCommand.
  // The fixture must not inherit the source reader's chat or any human token.
  await fs.writeFile(path.join(sourceDir,'main.mjs'),`import assert from 'node:assert/strict';import fs from 'node:fs';
    assert.equal(process.env.CODEX_THREAD_ID,${JSON.stringify(pass.threadId)});
    assert.equal(process.env.TRELIO_SKILL_COMPANY_ID,${JSON.stringify(pass.companyId)});
    assert.equal(process.env.TRELIO_MCP_ACCESS_TOKEN,undefined);
    let input='';for await(const chunk of process.stdin)input+=chunk;assert.equal(input,'');
    fs.appendFileSync(${JSON.stringify(calls)},'1');
    if(process.argv[2]==='fail'){process.stderr.write('PRIVATE_PROVIDER_ERROR');process.exit(7);}
    process.stdout.write(JSON.stringify({result:'Прочитано',args:process.argv.slice(2)}));`);
  const bytes=await engine.buildAgentSkillPackage({skillId:'task-runtime-fixture',runtimeVersion:'1.0.0',sourceDirectory:sourceDir,
    entrypointPath:'main.mjs',interpreter:'node',capabilities:['network']});
  const currentRelease=randomUUID(),currentArtifact=randomUUID(),packageHash=createHash('sha256').update(bytes).digest('hex');
  const packageUrl='/api/agent-skills/runtime/package?'+new URLSearchParams({companyId:pass.companyId,skillId:'task-runtime-fixture',expectedReleaseId:currentRelease,artifactId:currentArtifact});
  const dto=()=>({releaseId:currentRelease,company:{id:pass.companyId,slug:'fixture',name:'Fixture'},
    localIdentity:{companyId:pass.companyId,projectId:null,skillId:'task-runtime-fixture',memberId:randomUUID(),connectionId:null},companyConnection:null,
    trust:{level:'platform_verified',artifactLevel:'platform_verified',requiresDeviceConsent:false,consentId:null},packageUrl,
    artifact:{id:currentArtifact,skillId:'task-runtime-fixture',runtimeVersion:'1.0.0',packageFormat:'trelio-agent-skill-package/v1',contentProtection:'plain',
      packageSha256:packageHash,packageSizeBytes:bytes.length,packageSignature:sign(null,bytes,privateKey).toString('base64'),
      signingKeyId:'task-test',signingPublicKeySpki:publicKey.export({type:'spki',format:'der'}).toString('base64'),minimumHostVersion:'3.10.1',manifest:{}}});
  const rules='# Synthetic task platform rules\n',rulesHash=createHash('sha256').update(rules).digest('hex'),revisionId=randomUUID();
  let resolutions=0,downloads=0,denyNextLaunch=false;const nonces=new Set(),savedFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    assert.equal(url.origin,taskIdentity.origin);assert.equal(options.headers.get('authorization'),`Bearer ${credential}`);
    const proof=JSON.parse(options.headers.get('x-trelio-assistant-proof'));
    assert.equal(nonces.has(proof.nonce),false,'every native request has a distinct one-use observed proof');nonces.add(proof.nonce);
    assert.equal(options.headers.get('cookie'),null);
    if(url.pathname==='/api/digital-assistants/runtime/workspace/bridge-compatibility')return new Response(JSON.stringify({supported:true,minimumVersion:'0.0.0',agentRules:{
      status:options.headers.get('x-trelio-agent-rules-sha256')===rulesHash?'current':'update_required',revisionId,version:1,sha256:rulesHash,rulesMarkdown:rules}}));
    if(url.pathname==='/api/agent-skills/runtime/resolve'){
      resolutions++;
      if(denyNextLaunch && resolutions%2===0)return new Response(JSON.stringify({code:'ASSISTANT_OWNER_PAUSED',message:'PRIVATE'}),{status:409});
      return new Response(JSON.stringify(dto()));
    }
    assert.equal(url.pathname,'/api/agent-skills/runtime/package');downloads++;return new Response(bytes);
  };
  const plan={prepared:true,scope:{assistantUserId:taskIdentity.assistantId,deviceId:taskIdentity.deviceId,companyId:pass.companyId,taskId:pass.taskId,passId:pass.passId},
    localAction:{schemaVersion:1,operation:'skill_run',parameters:{companyId:pass.companyId,skillId:'task-runtime-fixture',releaseId:currentRelease,runtimeSessionId:runtime.state.runtimeSessionId,arguments:['read','hello world']}}};
  const run=raw=>engine.withWorkspaceExecutionProfile(profile,()=>executeAssistantWorkspacePlan(raw,{withProfile:action=>action({identity:taskIdentity,client,store:taskStore,host:taskHost})}));
  try{
    const first=await run(plan);assert.deepEqual(JSON.parse(first.stdout),{result:'Прочитано',args:['read','hello world']});
    assert.deepEqual(JSON.parse((await run(plan)).stdout),JSON.parse(first.stdout));
    assert.equal(downloads,1);assert.equal(resolutions,4,'cache hit still resolves before and immediately before provider launch');
    assert.equal(await fs.readFile(calls,'utf8'),'11');
    const failed=structuredClone(plan);failed.localAction.parameters.arguments=['fail'];
    await assert.rejects(run(failed),error=>!JSON.stringify(error).includes('PRIVATE_PROVIDER_ERROR'));
    assert.equal(await fs.readFile(calls,'utf8'),'111','a failed provider is not replayed');
    denyNextLaunch=true;
    await assert.rejects(run(plan));assert.equal(await fs.readFile(calls,'utf8'),'111','late native refusal blocks cached execution');
    denyNextLaunch=false;live=false;
    await assert.rejects(run(plan),/PASS_REVIEW_REQUIRED/);assert.equal(await fs.readFile(calls,'utf8'),'111');live=true;
    for(const change of [{runIdentity:{workspaceId:randomUUID(),runId:randomUUID()}},{localAction:{...plan.localAction,parameters:{...plan.localAction.parameters,directory:'/other'}}}]){
      await assert.rejects(run({...plan,...change}));
    }
    const catalogue=await profile.resolveSkillCatalogueDirectory(engine.resolveWorkspaceBridgeConfigDirectory());
    assert.ok(catalogue.includes(taskIdentity.assistantId));assert.notEqual(catalogue,engine.resolveWorkspaceBridgeConfigDirectory());
    const sourceProfile=await createAssistantSourceRuntimeProfile({identity:taskIdentity,host:taskHost,store:taskStore,
      scope:{companyId:pass.companyId,skillId:'telegram-mtproto'}});
    assert.equal(await sourceProfile.resolveSkillCatalogueDirectory(engine.resolveWorkspaceBridgeConfigDirectory()),catalogue,
      'source reads and task execution share the same managed account catalogue');
    sourceProfile.close();
    const localIdentity={companyId:pass.companyId,memberId:randomUUID(),connectionId:null},accountSkill='task-account-fixture';
    const io={ensureDirectory:engine.ensurePrivateDirectory,read:engine.readPrivateJsonFile,write:engine.writePrivateJsonFile,
      checkDirectory:dir=>engine.assertPrivatePathKind(dir,'directory')};
    const makeCatalogue=(selectedCompany,root=catalogue)=>createAccountCatalogue({directory:root,
      scope:accountScope({origin:taskIdentity.origin,skillId:accountSkill,companyId:selectedCompany,memberId:localIdentity.memberId,connectionId:null}),io});
    const own=makeCatalogue(pass.companyId),other=makeCatalogue(randomUUID());
    const ownAccount=randomUUID();
    await own.change({operation:'create',id:ownAccount,name:'Current company',expectedRevision:0});
    await other.change({operation:'create',id:randomUUID(),name:'FOREIGN_ACCOUNT_LABEL',expectedRevision:1});
    let listed,discoveries=0;
    const prepare=(runtimeArguments)=>engine.withWorkspaceExecutionProfile(profile,()=>engine.prepareSkillAccount({origin:taskIdentity.origin,
      artifact:{skillId:accountSkill},runtimeDirectory:sourceDir,executionContext:{companyId:pass.companyId,localIdentity},runtimeArguments,
      discover:async()=>{discoveries++;throw new Error('HUMAN_IMPORT_FORBIDDEN');},output:value=>{listed=value;}}));
    await prepare(['account','list']);
    assert.deepEqual(listed.accounts.map(account=>account.id),[ownAccount]);
    assert.doesNotMatch(JSON.stringify(listed),/FOREIGN_ACCOUNT_LABEL/);assert.equal(discoveries,0);
    assert.equal((await prepare(['read'])).account.id,ownAccount);
    const revision=(await own.list()).revision;
    await assert.rejects(prepare(['account','create','--name','Forbidden','--expected-revision',String(revision)]),/SETUP_REQUIRED/);
    assert.equal((await own.list()).revision,revision,'task cannot mutate owner account setup');
    // The public executor's monitor boundary remains independent of task mode.
    await assert.rejects(engine.runMaterializedAgentSkill({captureOutput:true,captureMode:'assistant_task',runtimeArguments:['read']}),/MONITOR_INPUT_INVALID|private monitor/);
  }finally{globalThis.fetch=savedFetch;}
});
