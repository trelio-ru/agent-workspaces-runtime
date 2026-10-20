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
  const catalogue=createAccountCatalogue({directory:engine.resolveWorkspaceBridgeConfigDirectory(),
    scope:accountScope({origin,skillId:scope.skillId,companyId,memberId,connectionId:null}),io:{
      ensureDirectory:engine.ensurePrivateDirectory,read:engine.readPrivateJsonFile,write:engine.writePrivateJsonFile,
      checkDirectory:dir=>engine.assertPrivatePathKind(dir,'directory')}});
  await catalogue.importOnce(async()=>[]);
  const accountId=randomUUID();await catalogue.change({operation:'create',id:accountId,name:'Synthetic',expectedRevision:(await catalogue.list()).revision});
  await fs.writeFile(path.join(sourceDir,'main.mjs'),entry.replace('ACCOUNT_ID',accountId));
  packageBytes=await engine.buildAgentSkillPackage({skillId:scope.skillId,runtimeVersion:'2.99.42',sourceDirectory:sourceDir,
    entrypointPath:'main.mjs',interpreter:'node',capabilities:['network','local-session','local-accounts-v1']});
  const source={...scope,accountId,cursor:previousCursor};
  const projected={schemaVersion:1,baselineOnly:false,events:[event],nextCursor,hasMore:false,
    channelsToSync:['456'],unresolvedDeletionIds:[]};
  const before=resolveCalls;
  assert.deepEqual(await readAssistantSourceMonitor({identity,host,store,source}),projected);
  assert.deepEqual(await readAssistantSourceMonitor({identity,host,store,source}),projected);
  assert.equal(resolveCalls,before+2);assert.equal(downloadCalls,1,'verified cache never bypasses fresh server admission');
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
