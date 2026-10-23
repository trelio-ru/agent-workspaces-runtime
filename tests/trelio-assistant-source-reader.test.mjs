/** Synthetic signed packages, private fixture roots and native subprocesses.
 * No live account, human OAuth, provider request or production package is read. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,generateKeyPairSync,sign,createHash,webcrypto} from 'node:crypto';

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'trelio-source-reader-'));
for(const key of ['HOME','USERPROFILE','XDG_CONFIG_HOME','XDG_CACHE_HOME','LOCALAPPDATA','CODEX_HOME','TRELIO_CONFIG_HOME']){
  process.env[key]=path.join(directory,key.toLowerCase());
  await fs.mkdir(process.env[key],{recursive:true,mode:0o700});
}
const engine=await import('../host-runtime/scripts/trelio-workspace.mjs');
const {parseAssistantSourceReadReference,createAssistantSourceRuntimeProfile,acknowledgeAssistantSource,projectAssistantSourceAcknowledgement,readAssistantSourceMonitor,projectAssistantMonitorPage,prepareAssistantSourceAccount,configureAssistantEmailSource,configureAssistantTelegramSource,verifyAssistantEmailSource,configureAssistantMaxSource,verifyAssistantMaxSource,readAssistantOwnerIntakeMessage}=
  await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
const {accountScope,createAccountCatalogue}=await import('../host-runtime/scripts/trelio-skill-accounts.mjs');
const origin='https://trelio.ru',assistantId=randomUUID(),deviceId=randomUUID(),companyId=randomUUID(),memberId=randomUUID();
const identity={schemaVersion:1,origin,assistantId,deviceId},scope={companyId,projectId:null,skillId:'telegram-mtproto'};
const credential=`tda_${'k'.repeat(43)}`;
let reads=0,liveIdentity=identity;
const host={readIdentity:async()=>structuredClone(liveIdentity)};
const store={get:async slot=>{
  if(slot.kind==='company_encryption'){assert.deepEqual(slot,{origin,kind:'company_encryption',id:companyId,deviceId});return null;}
  reads++;assert.deepEqual(slot,{origin,kind:'device',id:assistantId});
  return {assistantId,deviceId,credential,expiresAt:1};
}};
let setupFixture=null,ackFixture=null,intakeFixture=null;
const admission=()=>{
  if(intakeFixture)return {schemaVersion:1,assistantUserId:assistantId,deviceId,provider:scope.skillId==='max-web'?'max':'telegram',
    protocol:scope.skillId==='max-web'?'max-message-read/v1':'telegram-message-read/v1',command:'read-reference',pollIntervalSeconds:300,maximumDurationMs:60000,
    issuedAt:'2026-10-21T00:00:00.000Z',expiresAt:'2026-10-21T00:02:00.000Z',intake:intakeFixture.admission};
  if(ackFixture)return {schemaVersion:1,assistantUserId:assistantId,deviceId,provider:scope.skillId==='email-imap-smtp'?'email':scope.skillId==='max-web'?'max':'telegram',
    protocol:scope.skillId==='email-imap-smtp'?'email-read-state/v1':scope.skillId==='max-web'?'max-message-ack/v1':'telegram-message-ack/v1',command:'ack-reference',pollIntervalSeconds:300,maximumDurationMs:60000,
    issuedAt:'2026-10-21T00:00:00.000Z',expiresAt:'2026-10-21T00:02:00.000Z',acknowledgement:ackFixture.admission};
  const max=scope.skillId==='max-web',email=scope.skillId==='email-imap-smtp',operation=setupFixture?.operation;
  const interactive=['configure','login'].includes(operation);
  return {schemaVersion:1,assistantUserId:assistantId,deviceId,provider:max?'max':email?'email':'telegram',
    protocol:operation==='verify_login'?'max-login-verify/v1':operation==='login'?(max?'max-login/v1':'telegram-login/v1'):
      operation==='configure'?'email-configure/v1':max?'max-monitor/v1':email?'email-monitor/v1':'telegram-monitor/v1',
    command:operation==='verify_login'?'probe':operation??'monitor',pollIntervalSeconds:300,
    maximumDurationMs:interactive?600000:60000,
    issuedAt:'2026-10-21T00:00:00.000Z',expiresAt:interactive?'2026-10-21T00:10:00.000Z':'2026-10-21T00:02:00.000Z',
    ...(setupFixture?{accountSetup:{schemaVersion:1,sourceId:setupFixture.id,sourceRevision:setupFixture.revision,
      localAccountId:setupFixture.localAccountId,operation:operation??(setupFixture.bindFromSourceId?'bind':'create'),...(setupFixture.bindingOrigin?{bindingOrigin:setupFixture.bindingOrigin}:{})}}:{})};
};
const previousCursor='previous.'+'c'.repeat(64),nextCursor='next.'+'d'.repeat(64);
const event={id:'message:123:5',revision:'a'.repeat(64),kind:'new',chatId:'123',messageId:'5',topicId:null,
  senderUserId:'123',senderNamespace:'telegram_user_id',outgoing:false,forwarded:false,viaBot:false};
const page=()=>({schemaVersion:1,baselineOnly:false,events:[{...event,text:'PRIVATE_BODY',credential:'PRIVATE_PROVIDER'}],
  nextCursor,hasMore:false,channelsToSync:['456'],unresolvedDeletionIds:[],stream:{kind:'account_cloud',chatId:null},
  coverage:{historicalBackfill:false,secretChatsIncluded:false,otherChannelStreamsIncluded:false},
  readState:{readReceiptsSent:false,viewsRegistered:false}});
const prefix='/api/digital-assistants/runtime/source-skills';
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
let artifactId=randomUUID(),releaseId=randomUUID(),packageBytes=Buffer.from('{}'),providerVersion='2.99.42';
const payload=()=>({releaseId,company:{id:companyId,slug:'synthetic',name:'Synthetic'},
  localIdentity:{...scope,memberId,connectionId:null},companyConnection:null,
  trust:{level:'platform_verified',artifactLevel:'platform_verified',requiresDeviceConsent:false,consentId:null},
  packageUrl:`${prefix}/package?${new URLSearchParams({...scope,expectedReleaseId:releaseId,artifactId}).toString().replace('projectId=null&','')}`,
  artifact:{id:artifactId,skillId:scope.skillId,runtimeVersion:providerVersion,packageFormat:'trelio-agent-skill-package/v1',contentProtection:'plain',
    packageSha256:createHash('sha256').update(packageBytes).digest('hex'),packageSizeBytes:packageBytes.length,
    packageSignature:sign(null,packageBytes,privateKey).toString('base64'),signingKeyId:'synthetic-test',
    signingPublicKeySpki:publicKey.export({type:'spki',format:'der'}).toString('base64'),minimumHostVersion:'3.10.1',manifest:{}},
  sourceAdmission:admission()});
// URL parameters are independently constructed, never an arbitrary package URL.
const resolution=()=>{
  const raw=payload();const query=new URLSearchParams({companyId,skillId:scope.skillId,expectedReleaseId:releaseId,artifactId});
  if(setupFixture){query.set('accountSetupSourceId',setupFixture.id);query.set('accountSetupRevision',String(setupFixture.revision));}
  if(setupFixture?.operation)query.set('accountSetupOperation',setupFixture.operation);
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
    resolveCalls++;assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{...scope,expectedReleaseId:null,
      ...(setupFixture?{accountSetup:{sourceId:setupFixture.id,expectedRevision:setupFixture.revision,
        ...(setupFixture.operation?{operation:setupFixture.operation}:{})}}:{}),...(ackFixture?{sourceAcknowledgement:ackFixture.intent}:{}),...(intakeFixture?{sourceIntake:intakeFixture.intent}:{})});
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
      const result=${JSON.stringify(page())};
      if(args.includes('--chat')){
        const unread=args.includes('--unread-backfill'),account=args.includes('--initial-account-cursor');
        assert.deepEqual(args,['monitor','--chat','-1000000000055',...(unread?['--unread-backfill']:
          [account?'--initial-account-cursor':'--cursor',${JSON.stringify(previousCursor)}]),'--limit','100']);
        result.stream={kind:'channel',chatId:'-1000000000055'};result.channelsToSync=[];
        result.events[0].chatId='-1000000000055';result.events[0].id='message:-1000000000055:5';
        result.hasMore=true;Object.assign(result.coverage,{historicalBackfill:true,[unread?'initialUnreadOnly':'initialAccountInterval']:true,
          snapshotAtomic:false,...(unread?{}:{earlierEditsIncluded:false})});
      }
      process.stdout.write(JSON.stringify(result));
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
  for(const mode of ['unread','account','continued']){
    const child=await readAssistantSourceMonitor({identity,host,store,source:{...source,chat:'-1000000000055',
      cursor:mode==='continued'?previousCursor:null,...(mode==='unread'?{initialUnread:true}:
        mode==='account'?{initialAccountCursor:previousCursor}:{})}});
    assert.equal(child[mode==='unread'?'initialUnreadBackfill':'initialAccountBackfill'],true);
    assert.equal(child.baselineOnly,false);assert.equal(child.hasMore,true);
    assert.equal(child.events[0].id,'message:-1000000000055:5');assert.equal(child.events[0].chatId,'-1000000000055');
    assert.doesNotMatch(JSON.stringify(child),/PRIVATE/);
  }
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

test('native owner setup uses the same signed loader/catalogue, has atomic create replay and never starts a provider',async t=>{
  t.after(()=>{setupFixture=null;resolveOverride=null;});
  const localProfile=await createAssistantSourceRuntimeProfile({identity,host,store,scope});
  const root=await localProfile.resolveSkillCatalogueDirectory(engine.resolveWorkspaceBridgeConfigDirectory());localProfile.close();
  const catalogue=createAccountCatalogue({directory:root,scope:accountScope({origin,skillId:scope.skillId,companyId,memberId,connectionId:null}),io:{
    ensureDirectory:engine.ensurePrivateDirectory,read:engine.readPrivateJsonFile,write:engine.writePrivateJsonFile,
    checkDirectory:dir=>engine.assertPrivatePathKind(dir,'directory')}});
  const source=()=>({...scope,id:randomUUID(),deviceId,localAccountId:randomUUID(),revision:0,state:'active',
    provisionLocalAccount:true,executionVerified:false});
  setupFixture=source();
  const client={identity,sourceAccounts:async selected=>{assert.equal(selected,companyId);return [setupFixture];}};
  const prepare=()=>prepareAssistantSourceAccount({identity,host,store,client,companyId,sourceId:setupFixture.id});
  const calls=await fs.readFile(path.join(directory,'native-calls'),'utf8'),before=await catalogue.list(),resolves=resolveCalls;
  assert.deepEqual(await prepare(),{sourceId:setupFixture.id,localAccountId:setupFixture.localAccountId,
    state:'prepared',replayed:false,loginVerified:false});
  assert.equal(resolveCalls,resolves+2,'materialization is followed by fresh native owner authorization');
  assert.equal((await catalogue.list()).revision,before.revision+1);
  assert.equal((await catalogue.select(setupFixture.localAccountId)).providerRef,null);
  assert.equal((await prepare()).replayed,true);
  assert.equal((await catalogue.list()).revision,before.revision+1,'the same native intent reads back its own committed receipt');
  assert.equal(await fs.readFile(path.join(directory,'native-calls'),'utf8'),calls,'no importer, provider login or monitor process is launched');
  const stable=await catalogue.list();
  setupFixture=source();let phases=0;
  resolveOverride=()=>++phases===1?new Response(JSON.stringify(resolution()),{headers:{'content-type':'application/json'}}):
    new Response(JSON.stringify({code:'ASSISTANT_SOURCE_ACCESS_DENIED'}),{status:403,headers:{'content-type':'application/json'}});
  await assert.rejects(prepare());assert.equal(phases,2);
  assert.deepEqual(await catalogue.list(),stable,'native refusal after materialization cannot create an account');
  resolveOverride=null;setupFixture=source();
  await catalogue.change({operation:'create',id:setupFixture.localAccountId,name:'Unrelated account',expectedRevision:stable.revision});
  await assert.rejects(prepare(),error=>error.code==='ACCOUNT_ID_CONFLICT');
  assert.equal((await catalogue.select(setupFixture.localAccountId)).name,'Unrelated account','an existing UUID without the own receipt cannot be adopted');
  setupFixture=source();
  resolveOverride=()=>new Response(JSON.stringify({...resolution(),sourceAdmission:{...admission(),
    accountSetup:{...admission().accountSetup,operation:'bind'}}}),{headers:{'content-type':'application/json'}});
  await assert.rejects(prepare(),error=>error.code==='ASSISTANT_SOURCE_INVALID_RESPONSE');
  resolveOverride=null;setupFixture=source();setupFixture.provisionLocalAccount=false;
  const start=resolveCalls;await assert.rejects(prepare(),/SETUP_REQUIRED/);assert.equal(resolveCalls,start,'an ordinary reference never requests setup admission');
  assert.equal(await fs.readFile(path.join(directory,'native-calls'),'utf8'),calls);
});

/** Real managed envelope/config around the SAME native setup fixtures. No
 * provider form is automated here: the signed disposable child proves only
 * that protected capture admission receives opened config locally. */
const encryptedSetupFixture=async(t,encrypted)=>{
  if(!encrypted)return {selectedStore:store};
  const {resolveAssistantCompanyEncryptionDevice}=await import('../host-runtime/scripts/trelio-assistant-private.mjs');
  const {hpkeSeal,encryptCompanyPayload,buildCompanyEncryptedTextMarker}=await import('../host-runtime/scripts/trelio-company-encryption.mjs');
  const slots=new Map(),selectedStore={get:slot=>slot.kind==='company_encryption'?Promise.resolve(slots.get(slot.id)??null):store.get(slot),
    put:async(slot,value)=>{assert.equal(slot.kind,'company_encryption');slots.set(slot.id,value);}};
  const managed=await resolveAssistantCompanyEncryptionDevice({identity,companyId,store:selectedStore,
    lockDirectory:path.join(directory,'setup-crypto-locks'),assertCurrent:async()=>{},lock:(_file,action)=>action()});
  const pair=await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const publicJwk=await webcrypto.subtle.exportKey('jwk',pair.publicKey),privateJwk=await webcrypto.subtle.exportKey('jwk',pair.privateKey);
  const scopeId=randomUUID(),recipientDeviceId=randomUUID(),entityId=randomUUID(),connectionId=randomUUID();
  const aad={suite:'trelio-e2ee-v1',companyId,scopeId,scopeEpoch:1,recipientType:'agent_device',recipientId:recipientDeviceId};
  const sealed=await hpkeSeal({recipientPublicEncryptionJwk:managed.publicEncryptionJwk,
    plaintext:Buffer.from(JSON.stringify({suite:'trelio-e2ee-v1',version:1,scopePrivateEncryptionJwk:privateJwk})),aad});
  const envelope={id:randomUUID(),...aad,hpkeEnc:sealed.enc,ciphertext:sealed.ciphertext,aad};
  const header={companyId,scopeId,scopeEpoch:1,entityType:'agent_skill_connection',entityId,entityRevision:1,schemaVersion:1,purpose:'content'};
  const payload={...header,...await encryptCompanyPayload({scopePublicEncryptionJwk:publicJwk,aad:header,
    payload:{values:{config_json:{setup:'ENCRYPTED_SETUP_CONFIG_CANARY'}}}})};
  const runtime={state:'encrypted',suite:'trelio-e2ee-v1',company:{id:companyId,slug:'synthetic',name:'Synthetic'},viewer:{userId:assistantId},
    accessState:'ready',device:{id:recipientDeviceId,fingerprint:managed.fingerprint},scope:{id:scopeId,epoch:1,publicEncryptionJwk:publicJwk},envelope};
  const savedFetch=globalThis.fetch;let mode='valid';
  globalThis.fetch=async(url,options)=>{
    assert.doesNotMatch(String(options.body??''),/ENCRYPTED_SETUP_CONFIG_CANARY|scopePrivateEncryptionJwk/);
    if(url.pathname==='/api/digital-assistants/runtime/encryption/runtime')return new Response(JSON.stringify(runtime));
    const response=await savedFetch(url,options);
    if(url.pathname!==prefix+'/resolve'||!response.ok)return response;
    assert.equal(options.headers.get('x-trelio-assistant-source-encryption-fingerprint'),managed.fingerprint);
    const raw=await response.json(),query=new URL(raw.packageUrl,origin);
    query.searchParams.set('sourceId',setupFixture.id);query.searchParams.set('sourceRevision',String(setupFixture.revision));
    raw.packageUrl=query.pathname+query.search;raw.localIdentity.connectionId=connectionId;
    raw.companyConnection={id:connectionId,status:'configured',configured:true,
      config:buildCompanyEncryptedTextMarker(entityId,'config_json'),secretBindings:[]};
    raw.sourceEncryption={schemaVersion:1,companyId,recipientDeviceId,envelopeId:envelope.id,scopeId,scopeEpoch:1,encryptedPayloads:[payload]};
    if(mode==='recipient')raw.sourceEncryption.recipientDeviceId=randomUUID();
    if(mode==='missing')raw.sourceEncryption.encryptedPayloads=[];
    if(mode==='selection'){query.searchParams.set('sourceId',randomUUID());raw.packageUrl=query.pathname+query.search;}
    assert.doesNotMatch(JSON.stringify(raw),/ENCRYPTED_SETUP_CONFIG_CANARY|scopePrivateEncryptionJwk/);
    return new Response(JSON.stringify(raw));
  };
  t.after(()=>{globalThis.fetch=savedFetch;});
  return {selectedStore,setMode:value=>{mode=value;}};
};

for(const encrypted of [false,true])test(`protected email setup consumes separate native permission and the same signed account/process engine (encrypted=${encrypted})`,async t=>{
  const selected={...scope};
  t.after(()=>{Object.assign(scope,selected);setupFixture=null;resolveOverride=null;});
  scope.skillId='email-imap-smtp';
  setupFixture={...scope,id:randomUUID(),deviceId,localAccountId:randomUUID(),revision:0,state:'active',
    provisionLocalAccount:true,interactiveSetupAllowed:true,executionVerified:false};
  const sourceId=setupFixture.id,accountId=setupFixture.localAccountId;
  const client={identity,sourceAccounts:async()=>[setupFixture]};
  const {selectedStore,setMode}=await encryptedSetupFixture(t,encrypted);
  const configure=()=>configureAssistantEmailSource({identity,host,store:selectedStore,client,companyId,sourceId});
  if(!['darwin','win32'].includes(process.platform)){
    const before=resolveCalls;
    await assert.rejects(configure(),/SETUP_UNAVAILABLE/);
    assert.equal(resolveCalls,before,'unsupported storage cannot open a form or borrow a human account');return;
  }
  const sourceDir=path.join(directory,`email-setup-package-${encrypted}`);await fs.mkdir(sourceDir);
  const marker=path.join(directory,`email-setup-native-calls-${encrypted}`);
  await fs.writeFile(path.join(sourceDir,'main.mjs'),`import assert from 'node:assert/strict';import fs from 'node:fs';
    assert.deepEqual(process.argv.slice(2),['configure','--account',${JSON.stringify(accountId)},'--password-input','browser']);
    assert.equal(JSON.parse(process.env.TRELIO_SKILL_ACCOUNT_JSON).id,${JSON.stringify(accountId)});
    assert.equal(process.env.CODEX_THREAD_ID,undefined);assert.equal(process.env.TRELIO_SECRET_FILE,undefined);
    if(${encrypted})assert.deepEqual(JSON.parse(process.env.TRELIO_SKILL_CONNECTION_CONFIG_JSON),{setup:'ENCRYPTED_SETUP_CONFIG_CANARY'});
    let input='';for await(const chunk of process.stdin)input+=chunk;assert.equal(input,'');
    fs.appendFileSync(${JSON.stringify(marker)},'1');
    process.stdout.write(JSON.stringify({configured:${JSON.stringify(accountId)},passwordInput:'browser',connectionMode:'imap_smtp',
      credentialStore:process.platform==='win32'?'dpapi':'keychain',configPath:'PRIVATE_PATH',email:'PRIVATE_ADDRESS',
      message:'PRIVATE_PROVIDER_DETAIL'}));`);
  artifactId=randomUUID();releaseId=randomUUID();
  packageBytes=await engine.buildAgentSkillPackage({skillId:scope.skillId,runtimeVersion:'2.99.42',sourceDirectory:sourceDir,
    entrypointPath:'main.mjs',interpreter:'node',capabilities:['network','local-session','local-accounts-v1']});
  await prepareAssistantSourceAccount({identity,host,store:selectedStore,client,companyId,sourceId});
  setupFixture.operation='configure';
  const readMarker=()=>fs.readFile(marker,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
  const before=resolveCalls;
  setupFixture.interactiveSetupAllowed=false;
  await assert.rejects(configure(),/SETUP_REQUIRED/);assert.equal(resolveCalls,before);assert.equal(await readMarker(),'');
  setupFixture.interactiveSetupAllowed=true;
  if(encrypted){for(const mode of ['recipient','missing','selection']){
    setMode(mode);await assert.rejects(configure());assert.equal(await readMarker(),'','bad cipher/recipient/source never opens a provider form');
  }setMode('valid');}
  resolveOverride=()=>new Response(JSON.stringify({...resolution(),sourceAdmission:{...admission(),
    accountSetup:{...admission().accountSetup,operation:'create'}}}));
  await assert.rejects(configure(),/INVALID_RESPONSE/);assert.equal(await readMarker(),'','empty-create is not login permission');
  let calls=0;
  resolveOverride=()=>++calls===1?new Response(JSON.stringify(resolution())):
    new Response(JSON.stringify({code:'ASSISTANT_SOURCE_ACCESS_DENIED',message:'PRIVATE'}),{status:403});
  await assert.rejects(configure(),/ACCESS_DENIED/);assert.equal(calls,2);assert.equal(await readMarker(),'','late revocation denies provider launch');
  resolveOverride=null;
  const result=await configure();
  assert.deepEqual(result,{sourceId,localAccountId:accountId,state:'configuration_saved',incomingEnabled:true,connectionVerified:false,
    nextAction:{tool:'verify_assistant_email_source',arguments:{companyId,sourceId}}});
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|credential|password|Path/);
  assert.equal(await readMarker(),'1','one explicit invocation starts precisely one existing provider process');

  // An independently constructed private profile must still refuse terminal,
  // secret, account and argument overrides before interpreter/provider I/O.
  const p=await createAssistantSourceRuntimeProfile({identity,host,store:selectedStore,scope,
    accountSetup:{sourceId,expectedRevision:0,operation:'configure'}});
  const token=await p.requireToken(origin);
  await p.prepareRequest({origin,token,pathname:`${prefix}/resolve`,options:{method:'POST',body:JSON.stringify({...scope,expectedReleaseId:null,
    accountSetup:{sourceId,expectedRevision:0,operation:'configure'}})},buildHeaders:()=>new Headers()});
  const raw=resolution(),normalized=engine.normalizeResolvedSkillRuntimeArtifact(raw,{transportProfile:'assistant_source'});
  await p.bindResolution(normalized,raw.sourceAdmission);
  // Every rejected invocation must stop before path/entrypoint or interpreter
  // I/O, so the normalized native descriptor suffices at this guard boundary.
  const executionContext={...scope,releaseId,localIdentity:normalized.localIdentity,companyConnection:null,account:{id:accountId}};
  for(const args of [['configure','--account',accountId,'--terminal-prompts'],
    ['configure','--account',randomUUID(),'--password-input','browser'],['configure','--account',accountId,'--password-input','browser','--smtp-only']]){
    await assert.rejects(engine.withWorkspaceExecutionProfile(p,()=>engine.runMaterializedAgentSkill({artifact:normalized.artifact,
      runtimeDirectory:sourceDir,executionContext,runtimeArguments:args,captureOutput:true,captureMode:'assistant_source_setup',timeoutMs:5000})),/SETUP_REQUIRED/);
  }
  const validArguments=['configure','--account',accountId,'--password-input','browser'];
  await p.authorizeInteractiveSourceSetup({artifact:normalized.artifact,executionContext,runtimeArguments:validArguments});
  await assert.rejects(p.authorizeInteractiveSourceSetup({artifact:normalized.artifact,executionContext,runtimeArguments:validArguments}),/SETUP_REQUIRED/,
    'one native in-process permission cannot open a second form');
  p.close();assert.equal(await readMarker(),'1');
});

for(const encrypted of [false,true])test(`Telegram QR setup uses the same signed native child and never leaks factors or proves owner identity (encrypted=${encrypted})`,async t=>{
  const savedScope={...scope};t.after(()=>{Object.assign(scope,savedScope);setupFixture=null;resolveOverride=null;});
  scope.skillId='telegram-mtproto';
  setupFixture={...scope,id:randomUUID(),deviceId,localAccountId:randomUUID(),revision:0,state:'active',
    provisionLocalAccount:true,interactiveSetupAllowed:true,executionVerified:false};
  const sourceId=setupFixture.id,accountId=setupFixture.localAccountId;
  const {selectedStore}=await encryptedSetupFixture(t,encrypted);
  let inventoryCalls=0;
  const client={identity,sourceAccounts:async()=>{inventoryCalls++;return [{...setupFixture}];}};
  const configure=()=>configureAssistantTelegramSource({identity,host,store:selectedStore,client,companyId,sourceId});
  if(!['darwin','win32'].includes(process.platform)){
    const before=resolveCalls;await assert.rejects(configure(),/SETUP_UNAVAILABLE/);assert.equal(resolveCalls,before);return;
  }
  const sourceDir=path.join(directory,`telegram-login-package-${encrypted}`);await fs.mkdir(sourceDir);
  const marker=path.join(directory,`telegram-login-native-calls-${encrypted}`);
  await fs.writeFile(path.join(sourceDir,'main.mjs'),`import assert from 'node:assert/strict';import fs from 'node:fs';
    assert.deepEqual(process.argv.slice(2),['login','--account',${JSON.stringify(accountId)},'--qr']);
    assert.equal(JSON.parse(process.env.TRELIO_SKILL_ACCOUNT_JSON).id,${JSON.stringify(accountId)});
    assert.equal(process.env.CODEX_THREAD_ID,undefined);assert.equal(process.env.TRELIO_SECRET_FILE,undefined);
    if(${encrypted})assert.deepEqual(JSON.parse(process.env.TRELIO_SKILL_CONNECTION_CONFIG_JSON),{setup:'ENCRYPTED_SETUP_CONFIG_CANARY'});
    let input='';for await(const chunk of process.stdin)input+=chunk;assert.equal(input,'');
    fs.appendFileSync(${JSON.stringify(marker)},'1');
    process.stdout.write(JSON.stringify({authorized:true,userId:12345,username:'PRIVATE_USERNAME',qr:'PRIVATE_QR',password:'PRIVATE_FACTOR'}));`);
  artifactId=randomUUID();releaseId=randomUUID();
  packageBytes=await engine.buildAgentSkillPackage({skillId:scope.skillId,runtimeVersion:'2.99.42',sourceDirectory:sourceDir,
    entrypointPath:'main.mjs',interpreter:'node',capabilities:['network','local-session','local-accounts-v1']});
  await prepareAssistantSourceAccount({identity,host,store:selectedStore,client,companyId,sourceId});
  setupFixture.operation='login';
  const markerValue=()=>fs.readFile(marker,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
  setupFixture.interactiveSetupAllowed=false;const before=resolveCalls;
  await assert.rejects(configure(),/SETUP_REQUIRED/);assert.equal(resolveCalls,before);assert.equal(await markerValue(),'');
  setupFixture.interactiveSetupAllowed=true;
  resolveOverride=()=>new Response(JSON.stringify({...resolution(),sourceAdmission:{...admission(),protocol:'email-configure/v1'}}));
  await assert.rejects(configure(),/INVALID_RESPONSE/);assert.equal(await markerValue(),'');
  let calls=0;resolveOverride=()=>++calls===1?new Response(JSON.stringify(resolution())):
    new Response(JSON.stringify({code:'ASSISTANT_SOURCE_ACCESS_DENIED'}),{status:403});
  await assert.rejects(configure(),/ACCESS_DENIED/);assert.equal(await markerValue(),'','late denial does not start login');
  resolveOverride=null;
  const result=await configure();
  assert.deepEqual(result,{sourceId,localAccountId:accountId,state:'session_authorized',incomingVerified:false,backgroundVerified:false});
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|userId|username|password|qr|owner/i);
  assert.equal(await markerValue(),'1');
  // Native registration is reread after the successful child. A changed owner
  // intent cannot publish a successful setup receipt; the child is never replayed.
  const read=client.sourceAccounts;let late=0;
  client.sourceAccounts=async()=>{const rows=await read();if(++late===2)rows[0].revision++;return rows;};
  await assert.rejects(configure(),/BINDING_CHANGED/);assert.equal(await markerValue(),'11');
  assert.ok(inventoryCalls>=5);
  const profile=await createAssistantSourceRuntimeProfile({identity,host,store:selectedStore,scope,
    accountSetup:{sourceId,expectedRevision:0,operation:'login'}});
  const token=await profile.requireToken(origin);
  await profile.prepareRequest({origin,token,pathname:`${prefix}/resolve`,options:{method:'POST',body:JSON.stringify({...scope,
    expectedReleaseId:null,accountSetup:{sourceId,expectedRevision:0,operation:'login'}})},buildHeaders:()=>new Headers()});
  const raw=resolution(),normalized=engine.normalizeResolvedSkillRuntimeArtifact(raw,{transportProfile:'assistant_source'});
  await profile.bindResolution(normalized,raw.sourceAdmission);
  const context={...scope,releaseId,localIdentity:normalized.localIdentity,companyConnection:null,account:{id:accountId}};
  for(const runtimeArguments of [['login','--account',accountId,'--qr','--terminal-prompts'],['login','--account',accountId,'--code'],
    ['login','--account',randomUUID(),'--qr'],['login','--account',accountId,'--qr','--qr-timeout','600']])
    await assert.rejects(profile.authorizeInteractiveSourceSetup({artifact:normalized.artifact,executionContext:context,runtimeArguments}),/SETUP_REQUIRED/);
  const exact={artifact:normalized.artifact,executionContext:context,runtimeArguments:['login','--account',accountId,'--qr']};
  await profile.authorizeInteractiveSourceSetup(exact);
  await assert.rejects(profile.authorizeInteractiveSourceSetup(exact),/SETUP_REQUIRED/);profile.close();
  await assert.rejects(createAssistantSourceRuntimeProfile({identity,host,store:selectedStore,scope:{...scope,skillId:'email-imap-smtp'},
    accountSetup:{sourceId,expectedRevision:0,operation:'login'}}),/INVALID_INPUT/);
});

test('email incoming verification reuses one signed passive read, drops its cursor and rechecks live registration',async t=>{
  const savedScope={...scope};
  t.after(()=>{Object.assign(scope,savedScope);setupFixture=null;resolveOverride=null;});
  scope.skillId='email-imap-smtp';
  const row={...scope,id:randomUUID(),deviceId,localAccountId:randomUUID(),revision:0,state:'active',
    provisionLocalAccount:true,executionVerified:false};
  let inventoryReads=0,lateChange=null;
  const client={identity,sourceAccounts:async()=>{inventoryReads++;return [{...row,...(inventoryReads%2===0?lateChange:null)}];}};
  const sourceDir=path.join(directory,'email-incoming-verification');await fs.mkdir(sourceDir);
  const marker=path.join(directory,'verification-native-calls'),failure=path.join(directory,'verification-failure');
  const baseline={schemaVersion:1,baselineOnly:true,events:[],nextCursor:'PRIVATE_CURSOR',hasMore:false,
    coverage:{historicalBackfill:false,bodyContentRead:false},readState:{readReceiptsSent:false}};
  await fs.writeFile(path.join(sourceDir,'main.mjs'),`import assert from 'node:assert/strict';import fs from 'node:fs';
    assert.deepEqual(process.argv.slice(2),['monitor','--conversation-references','--limit','20']);
    assert.equal(JSON.parse(process.env.TRELIO_SKILL_ACCOUNT_JSON).id,${JSON.stringify(row.localAccountId)});
    assert.equal(process.env.CODEX_THREAD_ID,undefined);let input='';for await(const c of process.stdin)input+=c;assert.equal(input,'');
    fs.appendFileSync(${JSON.stringify(marker)},'1');
    if(fs.existsSync(${JSON.stringify(failure)})){process.stdout.write(JSON.stringify({code:'EMAIL_MONITOR_UNAVAILABLE',message:'PRIVATE_FAILURE'}));process.exit(2);}
    process.stdout.write(${JSON.stringify(JSON.stringify({...baseline,private:'PRIVATE_PROVIDER_BODY'}))});`);
  artifactId=randomUUID();releaseId=randomUUID();
  packageBytes=await engine.buildAgentSkillPackage({skillId:scope.skillId,runtimeVersion:'2.99.42',sourceDirectory:sourceDir,
    entrypointPath:'main.mjs',interpreter:'node',capabilities:['network','local-session','local-accounts-v1']});
  setupFixture=row;
  await prepareAssistantSourceAccount({identity,host,store,client:{identity,sourceAccounts:async()=>[row]},companyId,sourceId:row.id});
  setupFixture=null;
  const verify=()=>verifyAssistantEmailSource({identity,host,store,client,companyId,sourceId:row.id});
  const result=await verify();
  assert.deepEqual(result,{sourceId:row.id,localAccountId:row.localAccountId,state:'incoming_verified',
    verification:'imap_inbox_metadata',incomingVerified:true,outgoingVerified:false,queuePositionChanged:false,readStateChanged:false});
  assert.equal(inventoryReads,2);assert.equal(await fs.readFile(marker,'utf8'),'1');
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|cursor|events|body/i,'no baseline can replace a worker checkpoint');
  lateChange={revision:1,state:'paused'};
  await assert.rejects(verify(),{code:'ASSISTANT_SOURCE_BINDING_CHANGED'});
  assert.equal(await fs.readFile(marker,'utf8'),'11','late pause cannot turn the read into a successful verification');
  lateChange=null;row.state='paused';
  await assert.rejects(verify(),{code:'ASSISTANT_SOURCE_SETUP_REQUIRED'});
  assert.equal(await fs.readFile(marker,'utf8'),'11','paused source cannot launch a provider');row.state='active';
  inventoryReads=0;await fs.writeFile(failure,'synthetic');
  await assert.rejects(verify(),error=>error.code==='EMAIL_MONITOR_UNAVAILABLE'&&!JSON.stringify(error).includes('PRIVATE_FAILURE'));
  assert.equal(await fs.readFile(marker,'utf8'),'111','failed verification never repeats configure or monitor');
});

// These are synthetic wire positions, not a substitute IMAP implementation.
// The signed child separately verifies its exact arguments/account below.
const emailPosition=(lastUid,{history=false,...overrides}={})=>Buffer.from(JSON.stringify({v:history?2:1,
  ...(history?{mode:'initial_unread'}:{}),scope:'a'.repeat(64),uidValidity:42,lastUid,
  ...(history?{throughUid:10}:{}),...overrides})).toString('base64url');
const emailHistoryPage=(lastUid=5)=>({schemaVersion:1,baselineOnly:false,
  events:[{id:`uid:42:${lastUid}`,revision:'b'.repeat(64),kind:'new',uid:String(lastUid),uidValidity:'42',text:'PRIVATE_BODY'}],
  nextCursor:emailPosition(lastUid,{history:true}),hasMore:lastUid<10,
  coverage:{historicalBackfill:true,initialUnreadOnly:true,snapshotAtomic:false,bodyContentRead:false,backfillThroughUid:'10'},
  readState:{readReceiptsSent:false}});
const emailInitialPage=()=>({schemaVersion:1,baselineOnly:true,events:[],nextCursor:emailPosition(10),
  initialUnreadCursor:emailPosition(0,{history:true}),hasMore:false,
  coverage:{historicalBackfill:false,initialUnreadBackfillAvailable:true,bodyContentRead:false},readState:{readReceiptsSent:false}});

test('email initial unread projection binds the original finite range and rejects reseeding, false progress and content cursors',()=>{
  const project=(value,cursor=null,extra={})=>projectAssistantMonitorPage({exitCode:0,stdout:JSON.stringify(value)},
    {skillId:'email-imap-smtp',cursor,initialUnread:true,...extra});
  assert.equal(project(emailInitialPage()).initialUnreadCursor,emailPosition(0,{history:true}));
  assert.equal(project(emailHistoryPage(),emailPosition(0,{history:true})).initialUnreadBackfill,true);
  assert.doesNotMatch(JSON.stringify(project(emailHistoryPage(),emailPosition(0,{history:true}))),/PRIVATE_BODY/);
  assert.equal(project(emailHistoryPage(10),emailPosition(5,{history:true})).hasMore,false);
  // An empty original folder is a finite completed history too, never a loop.
  const empty=emailHistoryPage(0);empty.events=[];empty.hasMore=false;empty.coverage.backfillThroughUid='0';
  empty.nextCursor=emailPosition(0,{history:true,throughUid:0});
  assert.equal(project(empty,empty.nextCursor).hasMore,false);
  for(const mutate of [
    p=>delete p.initialUnreadCursor,p=>p.hasMore=true,p=>p.baselineOnly=false,
    p=>p.initialUnreadCursor=emailPosition(1,{history:true}),
    p=>p.initialUnreadCursor=emailPosition(0,{history:true,throughUid:11}),
    p=>p.initialUnreadCursor=emailPosition(0,{history:true,scope:'c'.repeat(64)}),
    p=>p.initialUnreadCursor=emailPosition(0,{history:true,uidValidity:43}),
    p=>p.initialUnreadCursor=emailPosition(0,{history:true,body:'PRIVATE_BODY'}),
    p=>p.nextCursor=emailPosition(10,{uidValidity:0}),
  ]){const value=emailInitialPage();mutate(value);assert.throws(()=>project(value),/INVALID_RESPONSE/);}
  for(const mutate of [
    p=>p.nextCursor=emailPosition(5,{history:true,throughUid:11}),
    p=>p.nextCursor=emailPosition(5,{history:true,scope:'c'.repeat(64)}),
    p=>p.nextCursor=emailPosition(5,{history:true,uidValidity:43}),
    p=>p.nextCursor=emailPosition(5,{history:true,mode:'forward'}),
    p=>p.nextCursor=emailPosition(5,{history:true,credential:'PRIVATE_BODY'}),
    p=>p.nextCursor=emailPosition(5,{history:true,lastUid:2**32}),
    p=>p.nextCursor=emailPosition(0,{history:true}),p=>p.hasMore=false,
    p=>p.initialUnreadCursor=emailPosition(0,{history:true}),
    p=>p.coverage.initialUnreadBackfillAvailable=true,p=>p.coverage.backfillThroughUid='11',
    p=>p.coverage.snapshotAtomic=true,p=>p.coverage.bodyContentRead=true,
    p=>p.readState.readReceiptsSent=true,p=>p.events[0].uid='6',
    p=>{p.events[0].uidValidity='43';p.events[0].id='uid:43:5';},
  ]){const value=emailHistoryPage();mutate(value);assert.throws(()=>project(value,emailPosition(0,{history:true})),/INVALID_RESPONSE/);}
  const behind=emailHistoryPage(3);assert.throws(()=>project(behind,emailPosition(5,{history:true})),/INVALID_RESPONSE/);
  assert.throws(()=>project(emailInitialPage(),null,{initialUnread:false}),/INVALID_RESPONSE/);
  assert.throws(()=>project(emailInitialPage(),null,{chat:'123'}),/INVALID_RESPONSE/);
  assert.throws(()=>project(emailInitialPage(),null,{initialAccountCursor:previousCursor}),/INVALID_RESPONSE/);
  assert.throws(()=>project(emailHistoryPage(),emailPosition(0)),/INVALID_RESPONSE/);
});

test('signed email child uses the same account/executor for finite initial history and refuses old capability before launch',async t=>{
  const savedScope={...scope};
  t.after(()=>{Object.assign(scope,savedScope);providerVersion='2.99.42';setupFixture=null;resolveOverride=null;});
  scope.skillId='email-imap-smtp';
  const accountId=randomUUID(),row={...scope,id:randomUUID(),deviceId,localAccountId:accountId,revision:0,state:'active',
    provisionLocalAccount:true,executionVerified:false};
  const sourceDir=path.join(directory,'email-initial-history'),marker=path.join(directory,'email-initial-child');
  await fs.mkdir(sourceDir);
  await fs.writeFile(path.join(sourceDir,'main.mjs'),`import fs from 'node:fs';import assert from 'node:assert/strict';
    const args=process.argv.slice(2),initial=args.includes('--unread-backfill'),position=args.indexOf('--cursor');
    const cursor=position<0?null:args[position+1];
    assert.deepEqual(args,['monitor',...(cursor?['--cursor',cursor]:[]),...(initial?['--unread-backfill']:[]),
      '--conversation-references','--limit','20']);
    assert.equal(JSON.parse(process.env.TRELIO_SKILL_ACCOUNT_JSON).id,${JSON.stringify(accountId)});
    assert.equal(process.env.CODEX_THREAD_ID,undefined);assert.equal(process.env.TRELIO_SECRET_FILE,undefined);
    let input='';for await(const c of process.stdin)input+=c;assert.equal(input,'');fs.appendFileSync(${JSON.stringify(marker)},'1');
    const out=initial?(cursor?${JSON.stringify(emailHistoryPage(10))}:${JSON.stringify(emailInitialPage())}):
      {...${JSON.stringify(emailInitialPage())},baselineOnly:false,initialUnreadCursor:undefined,
        coverage:{historicalBackfill:false,bodyContentRead:false}};
    process.stdout.write(JSON.stringify(out));`);
  const build=async version=>{providerVersion=version;artifactId=randomUUID();releaseId=randomUUID();
    packageBytes=await engine.buildAgentSkillPackage({skillId:scope.skillId,runtimeVersion:version,sourceDirectory:sourceDir,
      entrypointPath:'main.mjs',interpreter:'node',capabilities:['network','local-session','local-accounts-v1']});};
  await build('2.6.6');setupFixture=row;
  await prepareAssistantSourceAccount({identity,host,store,client:{identity,sourceAccounts:async()=>[row]},companyId,sourceId:row.id});
  setupFixture=null;
  const invoke=(options={})=>readAssistantSourceMonitor({identity,host,store,source:{...scope,accountId,initialUnread:true,...options}});
  const before=resolveCalls;
  const baseline=await invoke();assert.equal(baseline.initialUnreadCursor,emailPosition(0,{history:true}));
  const terminal=await invoke({cursor:baseline.initialUnreadCursor});assert.equal(terminal.hasMore,false);
  assert.equal(terminal.events[0].id,'uid:42:10');assert.equal(resolveCalls-before,2,'each passive invocation resolves afresh, including verified cache hits');
  assert.equal(await fs.readFile(marker,'utf8'),'11');
  await build('2.6.5');
  await assert.rejects(invoke(),{code:'ASSISTANT_SOURCE_HISTORY_CAPABILITY_REQUIRED'});
  await assert.rejects(invoke({accountId:randomUUID()}),{code:'ASSISTANT_SOURCE_HISTORY_CAPABILITY_REQUIRED'});
  assert.equal(await fs.readFile(marker,'utf8'),'11','unsupported history stops before account selection/provider launch');
  assert.equal((await invoke({initialUnread:false,cursor:emailPosition(10)})).baselineOnly,false,'old forward-only accounts remain usable');
  assert.equal(await fs.readFile(marker,'utf8'),'111');
  const beforeInvalid=resolveCalls;
  for(const options of [{chat:'123'},{initialAccountCursor:previousCursor},{cursor:emailPosition(0)},
    {cursor:emailPosition(0,{history:true,secret:'PRIVATE'})}])await assert.rejects(invoke(options),/INVALID_INPUT/);
  assert.equal(resolveCalls,beforeInvalid,'invalid mode/cursor is rejected before network or private account I/O');
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

test('initial unread coverage is accepted only for the exact passive channel and never a silent baseline or final',()=>{
  const chat='-1000000000055',raw={...page(),stream:{kind:'channel',chatId:chat},channelsToSync:[],events:[],hasMore:true,
    coverage:{...page().coverage,historicalBackfill:true,initialUnreadOnly:true,snapshotAtomic:false}};
  const project=(value,options={skillId:scope.skillId,chat,cursor:null,initialUnread:true})=>
    projectAssistantMonitorPage({exitCode:0,stdout:JSON.stringify(value)},options);
  assert.equal(project(raw).initialUnreadBackfill,true);
  assert.equal(project(raw,{skillId:scope.skillId,chat,cursor:previousCursor}).initialUnreadBackfill,true);
  for(const change of [{baselineOnly:true},{hasMore:false},{stream:{kind:'channel',chatId:'-1000000000066'}},
    {coverage:{...raw.coverage,initialUnreadOnly:false}},{coverage:{...raw.coverage,snapshotAtomic:true}},
    {coverage:{...raw.coverage,historicalBackfill:false}},{readState:{readReceiptsSent:true,viewsRegistered:false}}])
    assert.throws(()=>project({...raw,...change}),/INVALID_RESPONSE/);
  assert.throws(()=>project(raw,{skillId:scope.skillId,cursor:null,initialUnread:true}),/INVALID_RESPONSE/);
  assert.throws(()=>project(raw,{skillId:'email-imap-smtp',chat,cursor:null,initialUnread:true}),/INVALID_RESPONSE/);
  assert.throws(()=>project(raw,{skillId:scope.skillId,chat,cursor:previousCursor,initialUnread:true}),/INVALID_RESPONSE/);
  const account={...raw,coverage:{historicalBackfill:true,secretChatsIncluded:false,otherChannelStreamsIncluded:false,
    initialAccountInterval:true,earlierEditsIncluded:false,snapshotAtomic:false}};
  const accountOptions={skillId:scope.skillId,chat,cursor:null,initialAccountCursor:previousCursor};
  assert.equal(project(account,accountOptions).initialAccountBackfill,true);
  assert.throws(()=>project(raw,accountOptions),/INVALID_RESPONSE/,'unread flag cannot replace the original account interval');
  for(const change of [{earlierEditsIncluded:true},{initialUnreadOnly:true},{historicalBackfill:false},{snapshotAtomic:true}])
    assert.throws(()=>project({...account,coverage:{...account.coverage,...change}},accountOptions),/INVALID_RESPONSE/);
  assert.throws(()=>project(account,{...accountOptions,initialUnread:true}),/INVALID_RESPONSE/);
  assert.throws(()=>project(account,{...accountOptions,chat:'123'}),/INVALID_RESPONSE/);
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
    if(skillId==='email-imap-smtp'){
      const key='email-conversation/v1.'+'f'.repeat(64),mapped={...raw,coverage:{...raw.coverage,conversationHeadersRead:true},
        events:[{...raw.events[0],conversationKey:key}]};
      assert.equal(run(mapped).events[0].conversationKey,key);
      assert.throws(()=>run({...mapped,coverage:{...mapped.coverage,conversationHeadersRead:false}}),/INVALID_RESPONSE/);
      assert.throws(()=>run({...mapped,events:[{...mapped.events[0],conversationKey:key.replace('email-','telegram-')}]}),/INVALID_RESPONSE/);
      assert.doesNotMatch(JSON.stringify(run(mapped)),/PRIVATE/);
    }
  }
});

for (const policyVersion of [1,2]) test(`task skills use the SAME signed package, native command and process engine with fresh pass admission (policy v${policyVersion})`,async()=>{
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
  let observedStarts=0,observedCompletions=0;
  const tickets=new WeakSet();
  const sourceReads={prepare:async input=>{
    observedStarts++;assert.equal(input.artifact.skillId,'task-runtime-fixture');
    assert.ok(input.artifact.parsedPackage.files.length);assert.equal(input.executionContext.codexThreadId,pass.threadId);
    const ticket={};tickets.add(ticket);return ticket;
  },commit:async(ticket,result)=>{
    assert.ok(tickets.has(ticket));tickets.delete(ticket);observedCompletions++;
    assert.equal(JSON.parse(result.stdout).result,'Прочитано','only complete native EOF reaches the observer');
  }};
  const profile=await createAssistantWorkspaceProfile({identity:taskIdentity,client,store:taskStore,host:taskHost,sourceReads,
    lockDirectory:path.join(directory,'task-locks'),lock:(_file,action)=>action()});
  const sourceDir=path.join(directory,`task-package-${policyVersion}`);await fs.mkdir(sourceDir);
  await fs.writeFile(path.join(sourceDir,'trelio-assistant-execution.json'),JSON.stringify({schemaVersion:policyVersion,taskCommands:[['read'],['fail']],
    ...(policyVersion===2?{deniedOptions:['--chrome','--timeout-ms']}: {})}));
  const calls=path.join(directory,`task-native-calls-${policyVersion}`);
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
  const taskMemberId=randomUUID();
  const dto=()=>({releaseId:currentRelease,company:{id:pass.companyId,slug:'fixture',name:'Fixture'},
    localIdentity:{companyId:pass.companyId,projectId:null,skillId:'task-runtime-fixture',memberId:taskMemberId,connectionId:null},companyConnection:null,
    trust:{level:'platform_verified',artifactLevel:'platform_verified',requiresDeviceConsent:false,consentId:null},packageUrl,
    artifact:{id:currentArtifact,skillId:'task-runtime-fixture',runtimeVersion:'1.0.0',packageFormat:'trelio-agent-skill-package/v1',contentProtection:'plain',
      packageSha256:packageHash,packageSizeBytes:bytes.length,packageSignature:sign(null,bytes,privateKey).toString('base64'),
      signingKeyId:'task-test',signingPublicKeySpki:publicKey.export({type:'spki',format:'der'}).toString('base64'),minimumHostVersion:'3.10.1',manifest:{}}});
  const rules='# Synthetic task platform rules\n',rulesHash=createHash('sha256').update(rules).digest('hex'),revisionId=randomUUID();
  let resolutions=0,downloads=0,denyNextLaunch=false,consentPending=true;const nonces=new Set(),savedFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    assert.equal(url.origin,taskIdentity.origin);assert.equal(options.headers.get('authorization'),`Bearer ${credential}`);
    const proof=JSON.parse(options.headers.get('x-trelio-assistant-proof'));
    assert.equal(nonces.has(proof.nonce),false,'every native request has a distinct one-use observed proof');nonces.add(proof.nonce);
    assert.equal(options.headers.get('cookie'),null);
    if(url.pathname==='/api/digital-assistants/runtime/workspace/bridge-compatibility')return new Response(JSON.stringify({supported:true,minimumVersion:'0.0.0',agentRules:{
      status:options.headers.get('x-trelio-agent-rules-sha256')===rulesHash?'current':'update_required',revisionId,version:1,sha256:rulesHash,rulesMarkdown:rules}}));
    if(url.pathname==='/api/agent-skills/runtime/resolve'){
      resolutions++;
      if(consentPending){
        assert.equal(options.headers.get('x-trelio-agent-skill-device-consent'),'v1');
        return new Response(JSON.stringify({code:'AGENT_SKILL_DEVICE_CONSENT_REQUIRED',message:'Synthetic native approval required',
          challenge:{skill:{id:'task-runtime-fixture',releaseId:currentRelease}}}),{status:409});
      }
      if(denyNextLaunch && resolutions%2===0)return new Response(JSON.stringify({code:'ASSISTANT_OWNER_PAUSED',message:'PRIVATE'}),{status:409});
      return new Response(JSON.stringify(dto()));
    }
    assert.equal(url.pathname,'/api/agent-skills/runtime/package');downloads++;return new Response(bytes);
  };
  const plan={prepared:true,scope:{assistantUserId:taskIdentity.assistantId,deviceId:taskIdentity.deviceId,companyId:pass.companyId,taskId:pass.taskId,passId:pass.passId},
    localAction:{schemaVersion:1,operation:'skill_run',parameters:{companyId:pass.companyId,skillId:'task-runtime-fixture',releaseId:currentRelease,runtimeSessionId:runtime.state.runtimeSessionId,arguments:['read','hello world']}}};
  const run=raw=>engine.withWorkspaceExecutionProfile(profile,()=>executeAssistantWorkspacePlan(raw,{withProfile:action=>action({identity:taskIdentity,client,store:taskStore,host:taskHost})}));
  try{
    await assert.rejects(run(plan),error=>error.code==='ASSISTANT_SKILL_OWNER_CONSENT_REQUIRED'||error.message.includes('ASSISTANT_SKILL_OWNER_CONSENT_REQUIRED'));
    assert.equal(resolutions,1);assert.equal(downloads,0);assert.equal(observedStarts,0);
    await assert.rejects(fs.readFile(calls),{code:'ENOENT'},'no provider/cache/package access while native consent is missing');
    // The real native owner/action writer is tested in the backend fixture.
    // This signed child boundary resumes only after another fresh resolution.
    consentPending=false;resolutions=0;
    const first=await run(plan);assert.deepEqual(JSON.parse(first.stdout),{result:'Прочитано',args:['read','hello world']});
    assert.deepEqual(JSON.parse((await run(plan)).stdout),JSON.parse(first.stdout));
    assert.equal(downloads,1);assert.equal(resolutions,4,'cache hit still resolves before and immediately before provider launch');
    assert.equal(await fs.readFile(calls,'utf8'),'11');
    const failed=structuredClone(plan);failed.localAction.parameters.arguments=['fail'];
    await assert.rejects(run(failed),error=>!JSON.stringify(error).includes('PRIVATE_PROVIDER_ERROR'));
    assert.equal(await fs.readFile(calls,'utf8'),'111','a failed provider is not replayed');
    assert.equal(observedStarts,3);assert.equal(observedCompletions,2,'failed native output never confirms a body read');
    denyNextLaunch=true;
    await assert.rejects(run(plan));assert.equal(await fs.readFile(calls,'utf8'),'111','late native refusal blocks cached execution');
    denyNextLaunch=false;live=false;
    await assert.rejects(run(plan),/PASS_REVIEW_REQUIRED/);assert.equal(await fs.readFile(calls,'utf8'),'111');live=true;
    for(const args of [['configure','--password-input','browser'],['policy','set','--mode','confirm'],
      ['ack-reference','--confirm'],['__trelio_accounts_import'],['read-more','PRIVATE_SETUP_CANARY']]) {
      const denied=structuredClone(plan);denied.localAction.parameters.arguments=args;
      await assert.rejects(run(denied),error=>error.code==='ASSISTANT_SKILL_COMMAND_DENIED'
        && !JSON.stringify(error).includes('PRIVATE_SETUP_CANARY'));
      assert.equal(await fs.readFile(calls,'utf8'),'111','forbidden command must not launch the signed provider');
    }
    if(policyVersion===2)for(const args of [['read','--chrome','/PRIVATE_EXECUTABLE'],['read','--chrome=/PRIVATE_EXECUTABLE'],
      ['read','--timeout-ms','600000']]) {
      const denied=structuredClone(plan);denied.localAction.parameters.arguments=args;
      await assert.rejects(run(denied),{code:'ASSISTANT_SKILL_COMMAND_DENIED'});
      assert.equal(await fs.readFile(calls,'utf8'),'111','signed options are checked before the provider can use them');
    }
    // The same policy is checked inside the common process engine, before
    // interpreter/path access; a caller cannot skip skillCommand's early guard.
    await assert.rejects(engine.withWorkspaceExecutionProfile(profile,()=>engine.runMaterializedAgentSkill({
      artifact:{parsedPackage:engine.parseAndValidateAgentSkillPackage(bytes)},runtimeDirectory:'/not-an-executable-fixture',
      runtimeArguments:['configure'],executionContext:{},captureOutput:true,captureMode:'assistant_task'})),
      {code:'ASSISTANT_SKILL_COMMAND_DENIED'});
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

for(const mode of ["private-plain","private-encrypted","company-encrypted"])test(`private authentication composes real Run, signed recipe and one-use env without output (${mode})`,async()=>{
  const encryptedCase=mode!=="private-plain",companyCase=mode==="company-encrypted";
  const {createAssistantWorkspaceProfile,assistantTaskStorageDirectory}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const {executeAssistantWorkspacePlan}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const taskIdentity={schemaVersion:1,origin:'https://trelio.ru',assistantId:randomUUID(),deviceId:randomUUID()};
  const pass={schemaVersion:1,assistantId:taskIdentity.assistantId,deviceId:taskIdentity.deviceId,companyId:randomUUID(),taskId:randomUUID(),
    passId:randomUUID(),deliveryId:randomUUID(),threadId:randomUUID(),bindingId:randomUUID(),bindingRevision:1};
  const runtime={schemaVersion:1,passId:pass.passId,threadId:pass.threadId,state:{runtimeSessionId:randomUUID(),
    expiresAt:new Date(Date.now()+300000).toISOString(),privateKeyPkcs8:privateKey.export({type:'pkcs8',format:'der'}).toString('base64url'),
    observation:{schemaVersion:1,clientFamily:'codex',modelId:'gpt-6.1-sol',effortLevel:'high',evidenceLevel:'local_observed',source:'codex_hook'}}};
  const taskHost={readIdentity:async()=>taskIdentity,readActivePass:async()=>pass};
  const cryptoSlots=new Map();
  const taskStore={get:async slot=>slot.kind==='company_encryption'?cryptoSlots.get(slot.id)??null:slot.kind==='runtime'?runtime:
    {assistantId:taskIdentity.assistantId,deviceId:taskIdentity.deviceId,credential,expiresAt:1},
    put:async(slot,value)=>{assert.equal(slot.kind,'company_encryption');cryptoSlots.set(slot.id,value);}};
  const client={readTaskPass:async()=>({...pass,state:'leased',leaseExpiresAt:new Date(Date.now()+300000).toISOString()})};
  const runId=randomUUID(),workspaceId=randomUUID(),grantId=randomUUID(),secretId=randomUUID(),currentRelease=randomUUID(),currentArtifact=randomUUID();
  const skill={companyId:pass.companyId,skillId:'private-auth-fixture',releaseId:currentRelease,runtimeSessionId:runtime.state.runtimeSessionId,arguments:['authenticate']};
  const binding={grantId,runId,workspaceId,companySlug:'fixture',fieldKey:'value',environmentVariable:'TRELIO_TEST_AUTH_TOKEN',skill};
  let managed=null,encryptionRuntime=null,encryptedWire=null,configMarker=null,companySecretWrite=null;
  const value='DISPOSABLE_PRIVATE_AUTH_CANARY';
  if(encryptedCase){
    const {resolveAssistantCompanyEncryptionDevice}=await import('../host-runtime/scripts/trelio-assistant-private.mjs');
    const {hpkeSeal,encryptCompanyPayload,buildCompanyEncryptedTextMarker}=await import('../host-runtime/scripts/trelio-company-encryption.mjs');
    managed=await resolveAssistantCompanyEncryptionDevice({identity:taskIdentity,companyId:pass.companyId,store:taskStore,
      lockDirectory:path.join(directory,'private-auth-crypto-locks'),assertCurrent:async()=>{},lock:(_file,action)=>action()});
    const pair=await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
    const publicJwk=await webcrypto.subtle.exportKey('jwk',pair.publicKey),privateJwk=await webcrypto.subtle.exportKey('jwk',pair.privateKey);
    const scopeId=randomUUID(),recipientDeviceId=randomUUID(),entityId=randomUUID();
    const aad={suite:'trelio-e2ee-v1',companyId:pass.companyId,scopeId,scopeEpoch:1,recipientType:'agent_device',recipientId:recipientDeviceId};
    const sealed=await hpkeSeal({recipientPublicEncryptionJwk:managed.publicEncryptionJwk,
      plaintext:Buffer.from(JSON.stringify({suite:'trelio-e2ee-v1',version:1,scopePrivateEncryptionJwk:privateJwk})),aad});
    const envelope={id:randomUUID(),...aad,hpkeEnc:sealed.enc,ciphertext:sealed.ciphertext,aad};
    const header={companyId:pass.companyId,scopeId,scopeEpoch:1,entityType:'agent_skill_connection',entityId,entityRevision:1,schemaVersion:1,purpose:'content'};
    const payload={...header,...await encryptCompanyPayload({scopePublicEncryptionJwk:publicJwk,aad:header,
      payload:{values:{config_json:{region:'PRIVATE_AUTH_ENCRYPTED_CONFIG_CANARY'}}}})};
    encryptionRuntime={state:'encrypted',suite:'trelio-e2ee-v1',company:{id:pass.companyId,slug:'fixture',name:'Fixture'},
      viewer:{userId:taskIdentity.assistantId},accessState:'ready',device:{id:recipientDeviceId,fingerprint:managed.fingerprint},
      scope:{id:scopeId,epoch:1,publicEncryptionJwk:publicJwk},envelope};
    encryptedWire={schemaVersion:1,companyId:pass.companyId,recipientDeviceId,envelopeId:envelope.id,scopeId,scopeEpoch:1,encryptedPayloads:[payload]};
    configMarker=buildCompanyEncryptedTextMarker(entityId,'config_json');
    if(companyCase)companySecretWrite=await engine.buildCompanyE2eeAgentSecretWrite({
      context:{storageMode:'company_e2ee',encryptionState:'encrypted',secretId,companyId:pass.companyId,currentVersion:0,
        fields:[{key:'value',label:'Value',type:'password',required:true}]},valuePayload:{values:{value}},
      companyEncryption:{runtime:encryptionRuntime,device:managed}});
  }
  const profile=await createAssistantWorkspaceProfile({identity:taskIdentity,client,store:taskStore,host:taskHost,secretSkill:binding,
    sourceReads:{prepare:async()=>assert.fail('authentication is never business body evidence')},
    lockDirectory:path.join(directory,'private-auth-locks'),lock:(_file,action)=>action()});
  const root=path.join(assistantTaskStorageDirectory(engine.resolveWorkspaceBridgeConfigDirectory(),{...taskIdentity,companyId:pass.companyId,taskId:pass.taskId}),'workspaces',workspaceId);
  const cwd=path.join(root,'workspace');await engine.ensurePrivateDirectory(cwd);
  await engine.writePrivateJsonFile(path.join(root,'.trelio-run.json'),{schemaVersion:3,origin:taskIdentity.origin,runId,workspaceId,workspaceDirectory:cwd,
    company:{id:pass.companyId,slug:'fixture'},encryption:{enabled:encryptedCase,...(encryptedCase?{dataPlaneOrigin:'https://e2ee.trelio.ru'}:{})}});
  const sourceDir=path.join(directory,'private-auth-package-'+mode);await fs.mkdir(sourceDir);
  const marker=path.join(directory,'private-auth-child-'+mode);
  await fs.writeFile(path.join(sourceDir,'trelio-secret-setup.json'),JSON.stringify({schemaVersion:2,commands:[{
    id:'authenticate',purpose:'authenticate',arguments:skill.arguments,bindingKey:'service_token',fieldKey:binding.fieldKey,environmentVariable:binding.environmentVariable}]}));
  await fs.writeFile(path.join(sourceDir,'main.mjs'),`import assert from 'node:assert/strict';import fs from 'node:fs';
    assert.deepEqual(process.argv.slice(2),['authenticate']);assert.equal(process.env.CODEX_THREAD_ID,${JSON.stringify(pass.threadId)});
    assert.equal(process.env.TRELIO_TEST_AUTH_TOKEN,${JSON.stringify(value)});
    ${encryptedCase?"assert.equal(JSON.parse(process.env.TRELIO_SKILL_CONNECTION_CONFIG_JSON).region,'PRIVATE_AUTH_ENCRYPTED_CONFIG_CANARY');":''}assert.equal(process.env.TRELIO_MCP_ACCESS_TOKEN,undefined);
    let stdin='';for await(const c of process.stdin)stdin+=c;assert.equal(stdin,'');
    fs.appendFileSync(${JSON.stringify(marker)},'1');console.log(process.env.TRELIO_TEST_AUTH_TOKEN,Buffer.from(process.env.TRELIO_TEST_AUTH_TOKEN).toString('base64'));
    console.error('PRIVATE_PROVIDER_DIAGNOSTIC');`);
  const bytes=await engine.buildAgentSkillPackage({skillId:skill.skillId,runtimeVersion:'1.0.0',sourceDirectory:sourceDir,
    entrypointPath:'main.mjs',interpreter:'node',capabilities:['network','secret-checkout']});
  const packageUrl='/api/agent-skills/runtime/package?'+new URLSearchParams({companyId:pass.companyId,skillId:skill.skillId,expectedReleaseId:currentRelease,artifactId:currentArtifact});
  const dto={releaseId:currentRelease,company:{id:pass.companyId,slug:'fixture',name:'Fixture'},
    localIdentity:{companyId:pass.companyId,projectId:null,skillId:skill.skillId,memberId:randomUUID(),connectionId:null},companyConnection:null,
    trust:{level:'platform_verified',artifactLevel:'platform_verified',requiresDeviceConsent:false,consentId:null},packageUrl,
    artifact:{id:currentArtifact,skillId:skill.skillId,runtimeVersion:'1.0.0',packageFormat:'trelio-agent-skill-package/v1',contentProtection:'plain',
      packageSha256:createHash('sha256').update(bytes).digest('hex'),packageSizeBytes:bytes.length,packageSignature:sign(null,bytes,privateKey).toString('base64'),
      signingKeyId:'private-auth-test',signingPublicKeySpki:publicKey.export({type:'spki',format:'der'}).toString('base64'),minimumHostVersion:'3.10.1',manifest:{}}};
  if(encryptedCase){dto.assistantEncryption=encryptedWire;dto.companyConnection={id:randomUUID(),status:'configured',configured:true,
    config:configMarker,secretBindings:companyCase?[{key:'service_token',status:'active',hasValue:true}]:[]};dto.localIdentity.connectionId=dto.companyConnection.id;}
  const metadata={grantId,runId,secretId,secretVersion:1,storageMode:companyCase?'company_e2ee':'trelio',deliveryMode:'env',executable:'trelio-workspace',fieldKeys:['value'],
    environmentVariable:binding.environmentVariable,expiresAt:new Date(Date.now()+300000).toISOString()};
  const rules='# Synthetic platform rules\n',sha256=createHash('sha256').update(rules).digest('hex'),revisionId=randomUUID();
  let consumed=0,resolutions=0,lateRefusal=false,encrypted=encryptedCase,cryptoMode='valid',fetchFailure,browserMode=false,browserConsumed=0;
  let generation=null,generationWrites=0,generationCommitted=false,generationUncertain=false;const savedFetch=globalThis.fetch,nonces=new Set();
  const fixtureFetch=async(url,options)=>{
    assert.ok([taskIdentity.origin,'https://e2ee.trelio.ru'].includes(url.origin));assert.doesNotMatch(String(options.body??''),/PRIVATE_AUTH_ENCRYPTED_CONFIG_CANARY|scopePrivateEncryptionJwk/);assert.equal(options.headers.get('authorization'),`Bearer ${credential}`);
    const proof=JSON.parse(options.headers.get('x-trelio-assistant-proof'));assert.ok(!nonces.has(proof.nonce));nonces.add(proof.nonce);
    if(url.pathname==='/api/digital-assistants/runtime/workspace/bridge-routing')return new Response(JSON.stringify({schemaVersion:1,
      company:{id:pass.companyId,slug:'fixture',name:'Fixture'},encryptionState:encrypted?'encrypted':'plain',
      encryptedDataPlaneOrigin:encrypted?'https://e2ee.trelio.ru':null}));
    if(url.pathname==='/api/digital-assistants/runtime/workspace/bridge-compatibility')return new Response(JSON.stringify({supported:true,minimumVersion:'0.0.0',agentRules:{
      status:options.headers.get('x-trelio-agent-rules-sha256')===sha256?'current':'update_required',revisionId,version:1,sha256,rulesMarkdown:rules}}));
    if(url.pathname===`/api/digital-assistants/runtime/workspace/workspaces/${workspaceId}/runs/${runId}`)return new Response(JSON.stringify(encryptedCase?{schemaVersion:1,context:{run:{id:runId,workspaceId}},encryptedPayloads:[]}:{run:{id:runId,workspaceId}}));
    if(url.pathname==='/api/digital-assistants/runtime/encryption/runtime'){
      assert.equal(url.searchParams.get('companySlug'),'fixture');assert.equal(options.headers.get('x-trelio-assistant-encryption-protocol'),'1');
      if(encryptedCase){if(!url.searchParams.has('fingerprint'))return new Response(JSON.stringify({state:'encrypted',suite:'trelio-e2ee-v1',company:encryptionRuntime.company,viewer:{userId:taskIdentity.assistantId},accessState:'device_required',device:null,scope:null,envelope:null}));
        assert.equal(url.searchParams.get('fingerprint'),managed.fingerprint);
        const value=structuredClone(encryptionRuntime);if(cryptoMode==='recipient')value.envelope.recipientId=randomUUID();
        return new Response(JSON.stringify(value));}
      return new Response(JSON.stringify({suite:'trelio-e2ee-v1',state:encrypted?'encrypted':'plain',
        company:{id:pass.companyId,slug:'fixture'},viewer:{userId:taskIdentity.assistantId}}));}
    if(generation&&url.pathname==='/api/agent-secrets/generated-save-context'){
      assert.equal(url.origin,taskIdentity.origin);assert.equal(options.headers.get('x-trelio-assistant-source-encryption-fingerprint'),managed.fingerprint);
      assert.deepEqual(JSON.parse(url.searchParams.get('neutralPlan')),generation.neutralPlan);
      if(generationCommitted)return Response.json({completed:true,receipt:generation.receipt});
      return Response.json({schemaVersion:1,completed:false,secretId:generation.clientRequestId,runId,
        assistantUserId:taskIdentity.assistantId,deviceId:taskIdentity.deviceId,companyId:pass.companyId,taskId:pass.taskId,
        fields:[{key:'password',label:'Password',type:'password',required:true}],generatedFields:generation.neutralPlan.generatedFields});
    }
    if(generation&&url.pathname===`/api/agent-secrets/secrets/${generation.clientRequestId}/value-from-bridge`){
      assert.equal(url.origin,taskIdentity.origin);assert.equal(options.headers.get('x-trelio-assistant-source-encryption-fingerprint'),managed.fingerprint);
      const body=JSON.parse(options.body);assert.deepEqual(body.neutralPlan,generation.neutralPlan);
      assert.equal(Object.keys(body.values).join(','),'password');assert.equal(body.values.password.length,32);
      assert.match(body.requestFingerprint,/^[0-9a-f]{64}$/u);generationWrites++;generationCommitted=true;
      if(generationUncertain)throw new Error('Synthetic generation lost response');
      return Response.json(generation.receipt);
    }
    if(url.pathname===`/api/agent-secrets/checkout-grants/${grantId}/browser-fill-context`){
      assert.equal(url.origin,taskIdentity.origin);if(encryptedCase)assert.equal(options.headers.get('x-trelio-assistant-source-encryption-fingerprint'),managed.fingerprint);
      if(browserMode){assert.equal(url.searchParams.has('purpose'),false);return new Response(JSON.stringify({...metadata,
        deliveryMode:'browser',targetOrigin:'https://service.invalid',targetUrlSha256:'b'.repeat(64),browserSteps:[{
          targetOrigin:'https://service.invalid',targetUrlSha256:'b'.repeat(64),fields:[{fieldKey:'value',selector:'#password'}]}]}));}
      assert.equal(url.searchParams.get('purpose'),'signed_skill');return new Response(JSON.stringify(metadata));}
    if(url.pathname==='/api/agent-skills/runtime/resolve'){
      resolutions++;assert.deepEqual(JSON.parse(options.headers.get('x-trelio-assistant-secret-checkout')),{grantId,runId});
      if(lateRefusal && resolutions%2===0)return new Response(JSON.stringify({code:'ASSISTANT_OWNER_PAUSED',message:'private'}),{status:409});
      if(encryptedCase)assert.equal(options.headers.get('x-trelio-assistant-source-encryption-fingerprint'),managed.fingerprint);
      return new Response(JSON.stringify(dto));}
    if(url.pathname==='/api/agent-skills/runtime/package')return new Response(bytes);
    assert.equal(url.pathname,`/api/agent-secrets/checkout-grants/${grantId}/consume`);
    assert.equal(url.origin,taskIdentity.origin);if(encryptedCase)assert.equal(options.headers.get('x-trelio-assistant-source-encryption-fingerprint'),managed.fingerprint);
    if(browserMode){assert.deepEqual(JSON.parse(options.body),{runId});assert.equal(browserConsumed,0);browserConsumed++;}
    else{assert.deepEqual(JSON.parse(options.body),{runId,purpose:'signed_skill'});assert.equal(consumed,0,'the existing one-use native grant cannot replay');consumed++;}
    return new Response(JSON.stringify({...metadata,environmentVariables:null,...(companyCase?{
      companyId:pass.companyId,companyMemberId:dto.localIdentity.memberId,
      fields:[{key:'value',label:'Value',type:'password',required:true}],values:companySecretWrite.values,
      encryptedPayload:companySecretWrite.encryptedPayloads[0]}:{values:{value}})}));
  };
  globalThis.fetch=async(...args)=>{try{return await fixtureFetch(...args);}catch(error){fetchFailure=error;throw error;}};
  const plan={prepared:true,scope:{assistantUserId:taskIdentity.assistantId,deviceId:taskIdentity.deviceId,companyId:pass.companyId,taskId:pass.taskId,passId:pass.passId},
    localAction:{schemaVersion:1,operation:'secret_skill_run',runIdentity:{runId,workspaceId},parameters:{grantId,companySlug:binding.companySlug,fieldKey:binding.fieldKey,environmentVariable:binding.environmentVariable,skill}}};
  let bridgeFailure;
  const run=async()=>{bridgeFailure=null;try{return await engine.withWorkspaceExecutionProfile(profile,()=>executeAssistantWorkspacePlan(plan,{
    withProfile:action=>action({identity:taskIdentity,client,store:taskStore,host:taskHost,prepareWorkspaceRun:profile.prepareWorkspaceRun}),loadCommon:async()=>({...engine,
      runWorkspaceCommand:async(...args)=>{try{return await engine.runWorkspaceCommand(...args);}catch(error){bridgeFailure=error;throw error;}}}),
  }));}catch(error){throw bridgeFailure??error;}};
  try{
    // A native refusal after signature/cache preparation must precede consume.
    if(!encryptedCase){encrypted=true;await assert.rejects(run());assert.equal(consumed,0);assert.equal(resolutions,0,'missing managed recipient cannot reach package/value preparation');encrypted=false;}
    else{cryptoMode='recipient';await assert.rejects(run());assert.equal(consumed,0);assert.equal(resolutions,0);cryptoMode='valid';}
    lateRefusal=true;await assert.rejects(run());assert.equal(fetchFailure,undefined);assert.equal(consumed,0);await assert.rejects(fs.readFile(marker),{code:'ENOENT'});
    lateRefusal=false;const result=await run();assert.equal(consumed,1);assert.equal(await fs.readFile(marker,'utf8'),'1');
    assert.deepEqual(JSON.parse(result.stdout),{schemaVersion:1,state:'command_completed',verificationRequired:true});
    assert.doesNotMatch(JSON.stringify(result),/DISPOSABLE_PRIVATE|PRIVATE_PROVIDER|RElTUE9TQUJM|PRIVATE_AUTH_ENCRYPTED_CONFIG_CANARY/);
    if(encryptedCase&&!companyCase){const token=await profile.requireToken(taskIdentity.origin);
      await assert.rejects(profile.prepareRequest({origin:'https://e2ee.trelio.ru',token,
        pathname:`/api/agent-workspaces/runs/${runId}/heartbeat`,options:{method:'POST',body:'{}'},buildHeaders:()=>new Headers()}),/ORIGIN_DENIED/);
      assert.equal(consumed,1,'private auth never inherits encrypted Workspace write authority');
      // The browser adapter uses that SAME genuine encrypted Run/HPKE key and
      // protected HTTP consumer, but its own exact profile never inherits the
      // signed skill recipe or ordinary Workspace writes. The common browser
      // controller's actual value/URL binding is covered by its process tests.
      browserMode=true;
      const browser=await createAssistantWorkspaceProfile({identity:taskIdentity,client,store:taskStore,host:taskHost,
        secretBrowserFill:{grantId,runId,workspaceId},lockDirectory:path.join(directory,'private-browser-locks'),lock:(_file,action)=>action()});
      await engine.withWorkspaceExecutionProfile(browser,async()=>{
        cryptoMode='recipient';await assert.rejects(browser.prepareWorkspaceRun());assert.equal(browserConsumed,0);cryptoMode='valid';
        const encryption=await browser.prepareWorkspaceRun();assert.equal(encryption.requestOrigin,'https://e2ee.trelio.ru');
        const token=await engine.requireToken(taskIdentity.origin),prefix=`/api/agent-secrets/checkout-grants/${grantId}`;
        const context=await (await engine.request(encryption.requestOrigin,token,`${prefix}/browser-fill-context?runId=${runId}`)).json();
        assert.equal(context.deliveryMode,'browser');assert.equal(context.targetUrlSha256,'b'.repeat(64));
        const delivered=await (await engine.request(encryption.requestOrigin,token,`${prefix}/consume`,{method:'POST',body:JSON.stringify({runId})})).json();
        assert.equal(delivered.values.value,value);assert.equal(browserConsumed,1);
        await assert.rejects(browser.prepareRequest({origin:encryption.requestOrigin,token,
          pathname:`/api/agent-workspaces/runs/${runId}/heartbeat`,options:{method:'POST',body:'{}'},buildHeaders:()=>new Headers()}),/ORIGIN_DENIED/);
      });
      assert.equal(fetchFailure,undefined);
      // Neutral NEW generation adds no metadata store or company marker to
      // the personal pool. The SAME protected generator receives the original
      // exact native policy and recovers its immutable receipt BEFORE key use.
      generation={clientRequestId:randomUUID(),ownerDecisionId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString(),runId,
        neutralPlan:{cardType:'password',generatedFields:[{key:'password',generator:'password',length:32}]}};
      generation.receipt={created:true,secret:{id:generation.clientRequestId,scopeType:'assistant',currentVersion:1,hasValue:true}};
      const generationInput={...generation};delete generationInput.receipt;
      const generator=await createAssistantWorkspaceProfile({identity:taskIdentity,client,store:taskStore,host:taskHost,
        secretGeneration:{...generationInput,workspaceId},lockDirectory:path.join(directory,'private-generation-locks'),lock:(_file,action)=>action()});
      const {handleAssistantGeneratedPrivateSecret}=await import('../host-runtime/scripts/trelio-secret-generate.mjs');let keyUses=0;
      const generate=()=>engine.withWorkspaceExecutionProfile(generator,async()=>{
        const encryption=await generator.prepareWorkspaceRun();
        return handleAssistantGeneratedPrivateSecret({origin:encryption.requestOrigin,token:await engine.requireToken(taskIdentity.origin),input:generationInput,
          scope:{assistantUserId:taskIdentity.assistantId,deviceId:taskIdentity.deviceId,companyId:pass.companyId,taskId:pass.taskId},
          withGenerationKey:action=>{keyUses++;return generator.withSecretGenerationKey(action);}});
      });
      generationUncertain=true;await assert.rejects(generate());assert.equal(generationWrites,1);assert.equal(keyUses,1);
      fetchFailure=undefined;assert.deepEqual(await generate(),generation.receipt);assert.equal(generationWrites,1);assert.equal(keyUses,1);
      assert.equal(fetchFailure,undefined);
    }
  }finally{globalThis.fetch=savedFetch;}
});

// Exercises the production signed loader/catalogue and native child, not an
// injected success function. All paths/accounts/provider output are synthetic.
for(const encrypted of [false,true])test(`MAX handoff is never login proof; independent short probe rechecks native registration and drops private diagnostics (encrypted=${encrypted})`,async t=>{
  const saved={...scope};t.after(()=>{Object.assign(scope,saved);setupFixture=null;resolveOverride=null;});
  scope.skillId='max-web';
  setupFixture={...scope,id:randomUUID(),deviceId,localAccountId:randomUUID(),revision:0,state:'active',
    provisionLocalAccount:true,interactiveSetupAllowed:true,executionVerified:false};
  const sourceId=setupFixture.id,accountId=setupFixture.localAccountId;
  const client={identity,sourceAccounts:async()=>[{...setupFixture}]};
  const {selectedStore}=await encryptedSetupFixture(t,encrypted);
  const input={identity,host,store:selectedStore,client,companyId,sourceId};
  if(!['darwin','win32'].includes(process.platform)){
    const before=resolveCalls;await assert.rejects(configureAssistantMaxSource(input),/SETUP_UNAVAILABLE/);
    await assert.rejects(verifyAssistantMaxSource(input),/SETUP_UNAVAILABLE/);assert.equal(resolveCalls,before);return;
  }
  const sourceDir=path.join(directory,`max-login-package-${encrypted}`);await fs.mkdir(sourceDir);
  const marker=path.join(directory,`max-login-calls-${encrypted}`),output=path.join(directory,`max-login-output-${encrypted}`);
  await fs.writeFile(path.join(sourceDir,'main.mjs'),`import assert from 'node:assert/strict';import fs from 'node:fs';
    const args=process.argv.slice(2);assert.deepEqual(args,args[0]==='probe'?['probe']:['login','--headed','--hold-ms','540000']);
    assert.equal(JSON.parse(process.env.TRELIO_SKILL_ACCOUNT_JSON).id,${JSON.stringify(accountId)});
    assert.equal(process.env.CODEX_THREAD_ID,undefined);assert.equal(process.env.TRELIO_SECRET_FILE,undefined);
    if(${encrypted})assert.deepEqual(JSON.parse(process.env.TRELIO_SKILL_CONNECTION_CONFIG_JSON),{setup:'ENCRYPTED_SETUP_CONFIG_CANARY'});
    let stdin='';for await(const c of process.stdin)stdin+=c;assert.equal(stdin,'');
    fs.appendFileSync(${JSON.stringify(marker)},args[0]+';');
    process.stdout.write(fs.readFileSync(${JSON.stringify(output)},'utf8'));`);
  artifactId=randomUUID();releaseId=randomUUID();
  packageBytes=await engine.buildAgentSkillPackage({skillId:scope.skillId,runtimeVersion:'2.99.42',sourceDirectory:sourceDir,
    entrypointPath:'main.mjs',interpreter:'node',capabilities:['network','local-session','local-accounts-v1']});
  await prepareAssistantSourceAccount(input);
  const handoff={opened:true,sessionVerified:false,handoffCompletion:'window_closed',profile:'PRIVATE_PATH',credential:'PRIVATE_VALUE'};
  await fs.writeFile(output,JSON.stringify(handoff));setupFixture.operation='login';
  const expected={sourceId,localAccountId:accountId,state:'login_handoff_finished',sessionVerified:false,
    incomingVerified:false,backgroundVerified:false,nextAction:{tool:'verify_assistant_max_source',arguments:{companyId,sourceId}}};
  assert.deepEqual(await configureAssistantMaxSource(input),expected);
  await fs.writeFile(output,JSON.stringify({...handoff,handoffCompletion:'hold_expired'}));
  assert.deepEqual(await configureAssistantMaxSource(input),expected,'hold expiration never masquerades as successful authentication');
  setupFixture.operation='verify_login';
  await fs.writeFile(output,JSON.stringify({authenticated:true,searchReady:false,fingerprint:'PRIVATE_UI'}));
  await assert.rejects(verifyAssistantMaxSource(input),/SETUP_UNAVAILABLE/);
  await fs.writeFile(output,JSON.stringify({authenticated:true,searchReady:true,fingerprint:'PRIVATE_UI',ownerUserId:'PRIVATE_OWNER'}));
  const before=resolveCalls;
  const verified=await verifyAssistantMaxSource(input);
  assert.deepEqual(verified,{sourceId,localAccountId:accountId,state:'session_verified',sessionVerified:true,
    incomingVerified:false,backgroundVerified:false});
  assert.doesNotMatch(JSON.stringify(verified),/PRIVATE|profile|fingerprint|owner/);
  assert.equal(resolveCalls,before+2,'probe also re-resolves after materialization');
  const calls=await fs.readFile(marker,'utf8');
  resolveOverride=()=>new Response(JSON.stringify({...resolution(),sourceAdmission:{...admission(),protocol:'max-login/v1'}}));
  await assert.rejects(verifyAssistantMaxSource(input),/INVALID_RESPONSE/);
  assert.equal(await fs.readFile(marker,'utf8'),calls,'login admission cannot launch a probe');resolveOverride=null;
  const read=client.sourceAccounts;let n=0;
  client.sourceAccounts=async()=>{const rows=await read();if(++n===2)rows[0].state='paused';return rows;};
  await assert.rejects(verifyAssistantMaxSource(input),/BINDING_CHANGED/);
  assert.equal(await fs.readFile(marker,'utf8'),calls+'probe;','late pause never replays provider work');client.sourceAccounts=read;
  const profile=await createAssistantSourceRuntimeProfile({identity,host,store:selectedStore,scope,
    accountSetup:{sourceId,expectedRevision:0,operation:'verify_login'}});
  const token=await profile.requireToken(origin);
  await profile.prepareRequest({origin,token,pathname:`${prefix}/resolve`,options:{method:'POST',body:JSON.stringify({...scope,
    expectedReleaseId:null,accountSetup:{sourceId,expectedRevision:0,operation:'verify_login'}})},buildHeaders:()=>new Headers()});
  const raw=resolution(),normalized=engine.normalizeResolvedSkillRuntimeArtifact(raw,{transportProfile:'assistant_source'});
  await profile.bindResolution(normalized,raw.sourceAdmission);
  const context={...scope,releaseId,localIdentity:normalized.localIdentity,companyConnection:null,account:{id:accountId}};
  for(const runtimeArguments of [['login','--headed'],['probe','--headed'],['probe','--timeout-ms','600000'],['probe','--account',accountId]])
    await assert.rejects(profile.authorizeInteractiveSourceSetup({artifact:normalized.artifact,executionContext:context,runtimeArguments}),/SETUP_REQUIRED/);
  const exact={artifact:normalized.artifact,executionContext:context,runtimeArguments:['probe']};
  assert.ok(await profile.authorizeInteractiveSourceSetup(exact)<=60000,'probe cannot borrow the human-input budget');
  await assert.rejects(profile.authorizeInteractiveSourceSetup(exact),/SETUP_REQUIRED/);profile.close();
  await assert.rejects(createAssistantSourceRuntimeProfile({identity,host,store:selectedStore,scope:{...scope,skillId:'telegram-mtproto'},
    accountSetup:{sourceId,expectedRevision:0,operation:'verify_login'}}),/INVALID_INPUT/);
});

test('native account-scoped conversation keys survive the private projection, while old/malformed providers gain no guessed route',()=>{
  const options={skillId:'telegram-mtproto',cursor:previousCursor},key=`telegram-conversation/v1.${'a'.repeat(64)}`;
  const project=value=>projectAssistantMonitorPage({exitCode:0,stdout:JSON.stringify(value)},options);
  assert.equal(project(page()).events[0].conversationKey,undefined);
  const mapped={...page(),events:[{...event,conversationKey:key,text:'PRIVATE_BODY'}]};
  assert.equal(project(mapped).events[0].conversationKey,key);assert.ok(!JSON.stringify(project(mapped)).includes('PRIVATE'));
  for(const conversationKey of ['',null,'message:123','telegram-conversation/v1.'+'A'.repeat(64),`https://other.test/${key}`])
    assert.throws(()=>project({...mapped,events:[{...event,conversationKey}]}),/INVALID_RESPONSE/);
});


test('native committed ACK admission reuses signed account/child execution and fences once at final spawn',async t=>{
  t.after(()=>{ackFixture=null;resolveOverride=null;setupFixture=null;});
  const accountId=randomUUID(),sourceId=randomUUID(),routeId=randomUUID(),receiptIds=[randomUUID(),randomUUID()].sort();
  const source={...scope,id:sourceId,deviceId,localAccountId:accountId,state:'active',revision:0};
  const references=receiptIds.map((receiptId,index)=>({eventKey:String(index+1).repeat(64),id:`message:123:${index+4}`,revision:(index?'b':'a').repeat(64),
    conversationKey:'telegram-conversation/v1.'+'f'.repeat(64),routeId,eventOrdinal:0,receiptId,taskId:randomUUID()}));
  ackFixture={intent:{sourceId,sourceRevision:0,receipts:receiptIds.map(receiptId=>({receiptId,eventOrdinals:[0]}))},admission:{schemaVersion:1,
    sourceId,sourceRevision:0,localAccountId:accountId,slots:receiptIds.map(receiptId=>({receiptId,routeId,eventOrdinal:0}))}};
  const profile=await createAssistantSourceRuntimeProfile({identity,host,store,scope});
  const root=await profile.resolveSkillCatalogueDirectory(engine.resolveWorkspaceBridgeConfigDirectory());profile.close();
  const catalogue=createAccountCatalogue({directory:root,scope:accountScope({origin,skillId:scope.skillId,companyId,memberId,connectionId:null}),io:{
    ensureDirectory:engine.ensurePrivateDirectory,read:engine.readPrivateJsonFile,write:engine.writePrivateJsonFile,
    checkDirectory:dir=>engine.assertPrivatePathKind(dir,'directory')}});
  await catalogue.change({operation:'create',id:accountId,name:'Synthetic ACK',expectedRevision:(await catalogue.list()).revision});
  const sourceDir=path.join(directory,'ack-package'),fence=path.join(directory,'ack-fence'),marker=path.join(directory,'ack-child');
  await fs.mkdir(sourceDir);
  const build=async({failed=false,verifyOnly=false}={})=>{
    const output=failed?{ok:false,error:'PRIVATE_PROVIDER_ERROR',code:'TELEGRAM_ACK_RANGE_INCOMPLETE',
      details:{writeAttempted:false,writeOutcome:'not_attempted',automaticRetryAllowed:false}}:
      {ok:true,schemaVersion:1,protocol:'telegram-message-ack/v1',reference:{...references[1],chatId:'123',messageId:'5'},
        readState:{acknowledged:true,writeAttempted:!verifyOnly,writeOutcome:verifyOnly?'not_attempted':'confirmed',
          automaticRetryAllowed:false,viewsRegistered:false,verifyOnly,snapshotAtomic:false}};
    await fs.writeFile(path.join(sourceDir,'main.mjs'),`import fs from 'node:fs';import assert from 'node:assert/strict';
      assert.equal(fs.readFileSync(${JSON.stringify(fence)},'utf8'),'DURABLE');
      assert.equal(process.env.CODEX_THREAD_ID,undefined);assert.equal(process.env.TRELIO_SECRET_FILE,undefined);
      assert.equal(JSON.parse(process.env.TRELIO_SKILL_ACCOUNT_JSON).id,${JSON.stringify(accountId)});
      assert.deepEqual(process.argv.slice(2),['ack-reference','--chat','123','--message-id','5','--expected-revision',${JSON.stringify(references[1].revision)},
        '--expected-conversation-key',${JSON.stringify(references[0].conversationKey)},...${JSON.stringify(verifyOnly?[]:['--covered-reference','4:'+references[0].revision,'--covered-reference','5:'+references[1].revision])},${JSON.stringify(verifyOnly?'--verify-only':'--confirm')}]);
      let input='';for await(const chunk of process.stdin)input+=chunk;assert.equal(input,'');
      fs.appendFileSync(${JSON.stringify(marker)},'1');
      ${failed?'process.stderr':'process.stdout'}.write(JSON.stringify(${JSON.stringify(output)}));process.exitCode=${failed?2:0};`);
    artifactId=randomUUID();releaseId=randomUUID();
    packageBytes=await engine.buildAgentSkillPackage({skillId:scope.skillId,runtimeVersion:'2.99.42',sourceDirectory:sourceDir,
      entrypointPath:'main.mjs',interpreter:'node',capabilities:['network','local-session','local-accounts-v1']});
  };
  const client={identity,sourceAccounts:async()=>[source]};let started=0,checked=0;
  const invoke=(verifyOnly=false)=>{
    // The synthetic native server echoes a READ-ONLY admission only when that
    // exact narrowed intent was requested. It cannot silently drop the mode.
    if(verifyOnly){ackFixture.intent.verifyOnly=true;ackFixture.admission.verifyOnly=true;}
    else {delete ackFixture.intent.verifyOnly;delete ackFixture.admission.verifyOnly;}
    return acknowledgeAssistantSource({identity,host,store,client,source,references,verifyOnly,
      assertReferences:()=>{checked++;},beforeInvoke:()=>{started++;return fs.writeFile(fence,'DURABLE');}});
  };
  await build();const before=resolveCalls;
  assert.deepEqual(await invoke(),{acknowledged:true,notAttempted:false,code:null});
  assert.equal(started,1);assert.equal(resolveCalls,before+2,'ACK is reauthorized after materialization');assert.ok(checked>=3);
  assert.equal(await fs.readFile(marker,'utf8'),'1');
  await build({verifyOnly:true});assert.deepEqual(await invoke(true),{acknowledged:true,notAttempted:true,code:null});
  const beforeNarrowed=await fs.readFile(marker,'utf8'),beforeNarrowedFence=started;
  resolveOverride=()=>{const raw=resolution();delete raw.sourceAdmission.acknowledgement.verifyOnly;return new Response(JSON.stringify(raw));};
  await assert.rejects(invoke(true),/INVALID_RESPONSE/);
  assert.equal(started,beforeNarrowedFence);assert.equal(await fs.readFile(marker,'utf8'),beforeNarrowed,'missing native read-only binding denies before final spawn');
  resolveOverride=null;
  await build({failed:true});assert.deepEqual(await invoke(),{acknowledged:false,notAttempted:true,code:'TELEGRAM_ACK_RANGE_INCOMPLETE'},
    'complete bounded native stderr can prove no attempt without exposing error prose');
  const count=await fs.readFile(marker,'utf8'),fences=started;
  resolveOverride=()=>new Response(JSON.stringify({...resolution(),sourceAdmission:{...admission(),
    acknowledgement:{...ackFixture.admission,slots:ackFixture.admission.slots.map(row=>({...row,routeId:randomUUID()}))}}}));
  await assert.rejects(invoke(),/INVALID_RESPONSE/);assert.equal(started,fences);assert.equal(await fs.readFile(marker,'utf8'),count);
  resolveOverride=null;let resolves=0;
  resolveOverride=()=>++resolves===1?new Response(JSON.stringify(resolution())):new Response(JSON.stringify({code:'ASSISTANT_SOURCE_ACCESS_DENIED'}),{status:403});
  await assert.rejects(invoke());assert.equal(resolves,2);assert.equal(started,fences);assert.equal(await fs.readFile(marker,'utf8'),count);
  resolveOverride=null;
  for(const referencesOverride of [[{...references[0],id:'message:999:5'},references[0]],[{...references[0],body:'PRIVATE'}]])
    await assert.rejects(acknowledgeAssistantSource({identity,host,store,client,source,references:referencesOverride,verifyOnly:false,
      assertReferences:()=>{},beforeInvoke:()=>assert.fail('invalid refs reached the write fence')}));
});

test('ACK projection refuses partial/mismatched/native-uncertain claims and never reflects provider prose',()=>{
  const target={id:'message:123:5',revision:'a'.repeat(64),conversationKey:'telegram-conversation/v1.'+'f'.repeat(64),chatId:'123',messageId:'5'};
  const raw={ok:true,schemaVersion:1,protocol:'telegram-message-ack/v1',reference:target,readState:{acknowledged:true,writeAttempted:true,
    writeOutcome:'confirmed',automaticRetryAllowed:false,viewsRegistered:false,verifyOnly:false,snapshotAtomic:false}};
  const project=(value,verifyOnly=false,exitCode=0)=>projectAssistantSourceAcknowledgement({exitCode,stdout:JSON.stringify(value)},{target,verifyOnly});
  for(const value of [{...raw,reference:{...target,revision:'b'.repeat(64)}},{...raw,readState:{...raw.readState,writeOutcome:'unknown'}},
    {...raw,readState:{...raw.readState,acknowledged:false}},{...raw,readState:{...raw.readState,viewsRegistered:true}}])
    assert.throws(()=>project(value),/INVALID_RESPONSE/);
  assert.throws(()=>project(raw,true),/INVALID_RESPONSE/);
  const error={ok:false,error:'PRIVATE_RAW_ERROR',code:'TELEGRAM_ACK_OUTCOME_UNKNOWN',details:{writeAttempted:true,writeOutcome:'unknown',automaticRetryAllowed:false}};
  assert.deepEqual(project(error,false,2),{acknowledged:false,notAttempted:false,code:error.code});
  assert.throws(()=>project({...error,details:{...error.details,writeOutcome:'not_attempted'}},false,2),/INVALID_RESPONSE/);
});

test('signed email ACK consumes one original UID/hash and native committed slot; lost outcomes never become a retry',async t=>{
  const savedScope={...scope};
  t.after(()=>{Object.assign(scope,savedScope);ackFixture=null;resolveOverride=null;});
  scope.skillId='email-imap-smtp';
  const accountId=randomUUID(),sourceId=randomUUID(),routeId=randomUUID(),receiptId=randomUUID();
  const source={...scope,id:sourceId,deviceId,localAccountId:accountId,state:'active',revision:0};
  const ref={eventKey:'a'.repeat(64),id:'uid:17:11',revision:'b'.repeat(64),originalSha256:'c'.repeat(64),
    conversationKey:'email-conversation/v1.'+'d'.repeat(64),routeId,eventOrdinal:2,receiptId,taskId:randomUUID()};
  ackFixture={intent:{sourceId,sourceRevision:0,receipts:[{receiptId,eventOrdinals:[2]}]},admission:{schemaVersion:1,
    sourceId,sourceRevision:0,localAccountId:accountId,slots:[{receiptId,routeId,eventOrdinal:2}]}};
  const profile=await createAssistantSourceRuntimeProfile({identity,host,store,scope});
  const root=await profile.resolveSkillCatalogueDirectory(engine.resolveWorkspaceBridgeConfigDirectory());profile.close();
  const catalogue=createAccountCatalogue({directory:root,scope:accountScope({origin,skillId:scope.skillId,companyId,memberId,connectionId:null}),io:{
    ensureDirectory:engine.ensurePrivateDirectory,read:engine.readPrivateJsonFile,write:engine.writePrivateJsonFile,
    checkDirectory:dir=>engine.assertPrivatePathKind(dir,'directory')}});
  await catalogue.change({operation:'create',id:accountId,name:'Synthetic exact email ACK',expectedRevision:(await catalogue.list()).revision});
  const sourceDir=path.join(directory,'email-ack-package'),marker=path.join(directory,'email-ack-native'),fence=path.join(directory,'email-ack-fence');
  await fs.mkdir(sourceDir);
  const raw=(verifyOnly=false)=>({schemaVersion:1,protocol:'email-read-state/v1',
    reference:{id:ref.id,revision:ref.revision},originalSha256:ref.originalSha256,
    readState:{verified:true,seen:true,writeAttempted:!verifyOnly,automaticRetryAllowed:false,readReceiptsSent:false}});
  const build=async({verifyOnly=false,error=null}={})=>{
    const args=['ack-reference','--uid','11','--uid-validity','17','--expected-revision',ref.revision,
      '--expected-original-sha256',ref.originalSha256,verifyOnly?'--verify-only':'--confirm'];
    await fs.writeFile(path.join(sourceDir,'main.mjs'),`import fs from 'node:fs';import assert from 'node:assert/strict';
      assert.equal(fs.readFileSync(${JSON.stringify(fence)},'utf8'),'DURABLE');
      assert.deepEqual(process.argv.slice(2),${JSON.stringify(args)});
      assert.equal(JSON.parse(process.env.TRELIO_SKILL_ACCOUNT_JSON).id,${JSON.stringify(accountId)});
      assert.equal(process.env.CODEX_THREAD_ID,undefined);let input='';for await(const c of process.stdin)input+=c;assert.equal(input,'');
      fs.appendFileSync(${JSON.stringify(marker)},'1');${error?'process.stderr':'process.stdout'}.write(${JSON.stringify(JSON.stringify(error??raw(verifyOnly)))});
      process.exitCode=${error?2:0};`);
    artifactId=randomUUID();releaseId=randomUUID();
    packageBytes=await engine.buildAgentSkillPackage({skillId:scope.skillId,runtimeVersion:'2.99.42',sourceDirectory:sourceDir,
      entrypointPath:'main.mjs',interpreter:'node',capabilities:['network','local-session','local-accounts-v1']});
  };
  const client={identity,sourceAccounts:async()=>[source]};let starts=0;
  const invoke=async(verifyOnly=false)=>{
    if(verifyOnly){ackFixture.intent.verifyOnly=true;ackFixture.admission.verifyOnly=true;}
    else{delete ackFixture.intent.verifyOnly;delete ackFixture.admission.verifyOnly;}
    return acknowledgeAssistantSource({identity,host,store,client,source,references:[ref],verifyOnly,
      assertReferences:()=>{},beforeInvoke:async()=>{starts++;await fs.writeFile(fence,'DURABLE');}});
  };
  await build();const before=resolveCalls;
  assert.deepEqual(await invoke(),{acknowledged:true,notAttempted:false,code:null});assert.equal(resolveCalls,before+2);assert.equal(starts,1);
  await build({verifyOnly:true});assert.deepEqual(await invoke(true),{acknowledged:true,notAttempted:true,code:null});
  const unknown={ok:false,error:'PRIVATE_EMAIL_ACK',code:'EMAIL_ACK_UNVERIFIED',
    readState:{verified:false,writeAttempted:true,writeOutcome:'unknown',automaticRetryAllowed:false}};
  await build({error:unknown});assert.deepEqual(await invoke(),{acknowledged:false,notAttempted:false,code:unknown.code});
  const calls=await fs.readFile(marker,'utf8'),fences=starts;
  resolveOverride=()=>new Response(JSON.stringify({...resolution(),sourceAdmission:{...admission(),protocol:'telegram-message-ack/v1'}}));
  await assert.rejects(invoke(),/INVALID_RESPONSE/);assert.equal(starts,fences);assert.equal(await fs.readFile(marker,'utf8'),calls);
  resolveOverride=null;
  for(const refs of [[{...ref,originalSha256:null}],[ref,{...ref,eventKey:'e'.repeat(64)}],[{...ref,body:'PRIVATE'}]])
    await assert.rejects(acknowledgeAssistantSource({identity,host,store,client,source,references:refs,verifyOnly:false,
      assertReferences:()=>{},beforeInvoke:()=>assert.fail('bad refs reached native spawn')}));
  const project=(value,verifyOnly=false)=>projectAssistantSourceAcknowledgement({exitCode:0,stdout:JSON.stringify(value)},
    {target:{...ref,uid:'11',uidValidity:'17'},verifyOnly});
  for(const value of [{...raw(),originalSha256:'e'.repeat(64)},{...raw(),reference:{...raw().reference,id:'uid:18:11'}},
    {...raw(),readState:{...raw().readState,readReceiptsSent:true}}])assert.throws(()=>project(value),/INVALID_RESPONSE/);
  assert.throws(()=>project(raw(),true),/INVALID_RESPONSE/);
});


test('derived ACK profile preserves short original grant budget and one-use spawn without borrowing setup/task permission',async t=>{
  t.after(()=>{ackFixture=null;resolveOverride=null;});
  const accountId=randomUUID(),sourceId=randomUUID(),receiptId=randomUUID(),routeId=randomUUID();
  const intent={sourceId,sourceRevision:0,receipts:[{receiptId,eventOrdinals:[0]}]};
  ackFixture={intent,admission:{schemaVersion:1,sourceId,sourceRevision:0,localAccountId:accountId,slots:[{receiptId,routeId,eventOrdinal:0}]}};
  const args=['ack-reference','--chat','123','--message-id','5','--expected-revision','a'.repeat(64),
    '--expected-conversation-key','telegram-conversation/v1.'+'f'.repeat(64),'--confirm'];
  let time=0,starts=0;
  const make=()=>createAssistantSourceRuntimeProfile({identity,host,store,scope,sourceAcknowledgement:intent,
    acknowledgementExecution:{accountId,runtimeArguments:args,slots:ackFixture.admission.slots,beforeInvoke:()=>{starts++;}},
    monotonic:()=>time,startedAt:0});
  const profile=await make();
  const token=await profile.requireToken(origin);
  await profile.prepareRequest({origin,token,pathname:prefix+'/resolve',options:{method:'POST',body:JSON.stringify({...scope,
    expectedReleaseId:null,sourceAcknowledgement:intent})},buildHeaders:()=>new Headers()});
  const raw=resolution();raw.sourceAdmission.expiresAt='2026-10-21T00:00:02.000Z';
  const normalized=engine.normalizeResolvedSkillRuntimeArtifact(raw,{transportProfile:'assistant_source'});
  await profile.bindResolution(normalized,raw.sourceAdmission);
  assert.equal(await profile.remainingMs(),2000);
  const context={companyId,projectId:null,releaseId:normalized.releaseId,account:{id:accountId},localIdentity:{memberId,connectionId:null}};
  for(const changed of [['ack-reference','--confirm'],[...args,'--arbitrary-script'],['monitor']])
    await assert.rejects(profile.authorizeSourceAcknowledgement({artifact:normalized.artifact,executionContext:context,runtimeArguments:changed}),/ACK_REQUIRED/);
  assert.equal(starts,0);
  const request={artifact:normalized.artifact,executionContext:context,runtimeArguments:args};
  assert.equal(await profile.authorizeSourceAcknowledgement(request),2000);
  await assert.rejects(profile.authorizeSourceAcknowledgement(request),/ACK_REQUIRED/);
  time=2000;await assert.rejects(profile.startSourceAcknowledgement(),/DEADLINE/);assert.equal(starts,0);
  time=0;profile.close();await assert.rejects(profile.startSourceAcknowledgement(),/DEADLINE/);
  const passive=await createAssistantSourceRuntimeProfile({identity,host,store,scope});
  await assert.rejects(passive.authorizeSourceAcknowledgement(request),/ACK_REQUIRED/);passive.close();
  const beforeNarrowedReads=reads;
  await assert.rejects(createAssistantSourceRuntimeProfile({identity,host,store,scope,sourceAcknowledgement:{...intent,verifyOnly:true},
    acknowledgementExecution:{accountId,runtimeArguments:args,slots:ackFixture.admission.slots,beforeInvoke:()=>assert.fail('write substitution reached provider')}}),/ACK_REQUIRED/);
  assert.equal(reads,beforeNarrowedReads,'a read-only native intent cannot select --confirm, even before private account access');
  await assert.rejects(createAssistantSourceRuntimeProfile({identity,host,store,scope,sourceAcknowledgement:{...intent,verifyOnly:false}}),/INVALID_INPUT/);
  await assert.rejects(createAssistantSourceRuntimeProfile({identity,host,store,scope,sourceAcknowledgement:intent,
    accountSetup:{sourceId,expectedRevision:0}}),/INVALID_INPUT/);
});

// A separate signed package uses exactly the production source profile and
// common local catalogue. The fixture does not grant task or setup permission.
for(const encrypted of [false,true])test(`MAX native source and committed ACK reuse one signed child/account engine with exact range and uncertain read-back (encrypted=${encrypted})`,async t=>{
  const saved={...scope},savedVersion=providerVersion;
  t.after(()=>{Object.assign(scope,saved);providerVersion=savedVersion;ackFixture=null;resolveOverride=null;});
  scope.skillId='max-web';providerVersion='2.11.0';
  const chat='https://web.max.ru/77',accountId=randomUUID(),sourceId=randomUUID(),routeId=randomUUID(),receiptId=randomUUID();
  const source={...scope,id:sourceId,deviceId,localAccountId:accountId,maxChatUrl:chat,state:'active',revision:0};
  const key='max-conversation/v1.'+'f'.repeat(64),revision='a'.repeat(64),maxScope='b'.repeat(64);
  const cursor=(anchorId='11',anchorRevision=revision)=>Buffer.from(JSON.stringify({v:2,scope:maxScope,anchorId,anchorRevision})).toString('base64url');
  const reference={eventKey:'e'.repeat(64),id:'message:77:11',revision,conversationKey:key,routeId,eventOrdinal:0,receiptId,taskId:randomUUID()};
  const event={id:reference.id,revision,kind:'new',chatId:'77',messageId:'11',conversationKey:key,
    senderUserId:'123',senderNamespace:'max_user_id',outgoing:false,forwarded:false,text:'PRIVATE_BODY'};
  const monitor={schemaVersion:1,baselineOnly:false,events:[event],nextCursor:cursor(),hasMore:false,
    coverage:{historicalBackfill:true,initialUnreadOnly:true,snapshotAtomic:false,ownerIdentityAvailable:true,
      nativeMessageVerified:true,earlierEditsIncluded:false,otherChatsIncluded:false},readState:{readReceiptsSent:false}};
  let selectedStore=store,connectionId=null,encryptedWire=null,encryptionRuntime=null,cryptoMode='valid',bodyThread=null;
  const savedFetch=globalThis.fetch;
  if(encrypted){
    // Real managed identity + HPKE company envelope + AEAD field payload, not
    // a fake read slot or a pre-decrypted config passed into a provider.
    const {resolveAssistantCompanyEncryptionDevice}=await import('../host-runtime/scripts/trelio-assistant-private.mjs');
    const {hpkeSeal,encryptCompanyPayload,buildCompanyEncryptedTextMarker}=await import('../host-runtime/scripts/trelio-company-encryption.mjs');
    const slots=new Map();selectedStore={get:async slot=>slot.kind==='company_encryption'?slots.get(slot.id)??null:store.get(slot),
      put:async(slot,value)=>{assert.equal(slot.kind,'company_encryption');slots.set(slot.id,value);}};
    const managed=await resolveAssistantCompanyEncryptionDevice({identity,companyId,store:selectedStore,
      lockDirectory:path.join(directory,'source-crypto-locks'),assertCurrent:async()=>{},lock:(_file,action)=>action()});
    const pair=await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
    const publicJwk=await webcrypto.subtle.exportKey('jwk',pair.publicKey),privateJwk=await webcrypto.subtle.exportKey('jwk',pair.privateKey);
    const scopeId=randomUUID(),recipientDeviceId=randomUUID(),entityId=randomUUID();connectionId=randomUUID();
    const aad={suite:'trelio-e2ee-v1',companyId,scopeId,scopeEpoch:1,recipientType:'agent_device',recipientId:recipientDeviceId};
    const sealed=await hpkeSeal({recipientPublicEncryptionJwk:managed.publicEncryptionJwk,
      plaintext:Buffer.from(JSON.stringify({suite:'trelio-e2ee-v1',version:1,scopePrivateEncryptionJwk:privateJwk})),aad});
    const envelope={id:randomUUID(),...aad,hpkeEnc:sealed.enc,ciphertext:sealed.ciphertext,aad};
    const header={companyId,scopeId,scopeEpoch:1,entityType:'agent_skill_connection',entityId,entityRevision:1,schemaVersion:1,purpose:'content'};
    const payload={...header,...await encryptCompanyPayload({scopePublicEncryptionJwk:publicJwk,aad:header,
      payload:{values:{config_json:{region:'ENCRYPTED_CONFIG_CANARY'},personal_rules:'CURRENT_ASSISTANT_RULE_CANARY'}}})};
    encryptionRuntime={state:'encrypted',suite:'trelio-e2ee-v1',company:{id:companyId,slug:'synthetic',name:'Synthetic'},
      viewer:{userId:assistantId},accessState:'ready',device:{id:recipientDeviceId,fingerprint:managed.fingerprint},
      scope:{id:scopeId,epoch:1,publicEncryptionJwk:publicJwk},envelope};
    encryptedWire={schemaVersion:1,companyId,recipientDeviceId,envelopeId:envelope.id,scopeId,scopeEpoch:1,encryptedPayloads:[payload]};
    globalThis.fetch=async(url,options)=>{
      assert.equal(url.origin,origin);assert.equal(options.headers.get('authorization'),`Bearer ${credential}`);
      assert.equal(options.headers.get('cookie'),null);assert.equal(options.redirect,'error');
      assert.doesNotMatch(String(options.body??''),/ENCRYPTED_CONFIG_CANARY|scopePrivateEncryptionJwk/);
      if(url.pathname==='/api/digital-assistants/runtime/encryption/runtime'){
        const value=structuredClone(encryptionRuntime);if(cryptoMode==='recipient')value.envelope.recipientId=randomUUID();
        return new Response(JSON.stringify(value));
      }
      if(url.pathname==='/api/digital-assistants/runtime/workspace/bridge-compatibility'){
        const rules='# Encrypted source platform rules\n',sha256=createHash('sha256').update(rules).digest('hex');
        return new Response(JSON.stringify({supported:true,minimumVersion:'0.0.0',agentRules:{status:options.headers.get('x-trelio-agent-rules-sha256')===sha256?'current':'update_required',revisionId:scopeId,version:1,sha256,rulesMarkdown:rules}}));
      }
      if(url.pathname===prefix+'/resolve'||url.pathname==='/api/agent-skills/runtime/resolve'){
        resolveCalls++;const body=JSON.parse(options.body);if(resolveOverride)return resolveOverride();
        assert.equal(body.companyId,companyId);assert.equal(options.headers.get('x-trelio-assistant-source-encryption-fingerprint'),managed.fingerprint);
        const taskRead=url.pathname==='/api/agent-skills/runtime/resolve';
        if(!taskRead&&!ackFixture)assert.deepEqual(body.sourceSelection,{sourceId,expectedRevision:0});
        const raw=resolution();raw.companyConnection={id:connectionId,status:'configured',configured:true,
          config:buildCompanyEncryptedTextMarker(entityId,'config_json'),secretBindings:[]};raw.localIdentity.connectionId=connectionId;
        const query=new URL(raw.packageUrl,origin);query.searchParams.set('sourceId',sourceId);query.searchParams.set('sourceRevision','0');
        raw.packageUrl=query.pathname+query.search;raw.sourceEncryption=structuredClone(encryptedWire);
        if(taskRead){
          const proof=JSON.parse(options.headers.get('x-trelio-assistant-proof'));assert.equal(proof.schemaVersion,1);
          delete raw.sourceAdmission;raw.assistantEncryption=raw.sourceEncryption;delete raw.sourceEncryption;
          raw.packageUrl='/api/agent-skills/runtime/package?'+new URLSearchParams({companyId,skillId:scope.skillId,expectedReleaseId:releaseId,artifactId});
          if(options.headers.get('x-trelio-assistant-skill-guidance')==='1')raw.assistantGuidance={content:[],structuredContent:{
            companySlug:'synthetic',projectSlug:null,skill:{id:scope.skillId,title:'MAX fixture',instructions:'Public fixture',
              personalRules:{instructionsMarkdown:buildCompanyEncryptedTextMarker(entityId,'personal_rules')}},
            runtimeExecution:{releaseId,localAction:{server:'trelio-local',tool:'continue_trelio_workspace_action',arguments:{
              schemaVersion:1,operation:'skill_run',parameters:{companyId,skillId:scope.skillId,releaseId}}}},remoteMcpExecution:null}};
        }
        const bundle=raw.sourceEncryption??raw.assistantEncryption;
        if(cryptoMode==='aad')bundle.encryptedPayloads[0].aad.companyId=randomUUID();
        if(cryptoMode==='missing')bundle.encryptedPayloads=[];
        if(cryptoMode==='extra')bundle.encryptedPayloads.push({...payload,entityId:randomUUID()});
        if(cryptoMode==='ciphertext')bundle.encryptedPayloads[0].ciphertext='AAAA';
        assert.doesNotMatch(JSON.stringify(raw),/ENCRYPTED_CONFIG_CANARY|scopePrivateEncryptionJwk/);
        return new Response(JSON.stringify(raw));
      }
      assert.ok([prefix+'/package','/api/agent-skills/runtime/package'].includes(url.pathname));
      if(url.pathname===prefix+'/package')assert.equal(url.searchParams.get('sourceId'),sourceId);
      downloadCalls++;return new Response(packageBytes);
    };
    t.after(()=>{globalThis.fetch=savedFetch;});
  }
  const profile=await createAssistantSourceRuntimeProfile({identity,host,store:selectedStore,scope});
  const root=await profile.resolveSkillCatalogueDirectory(engine.resolveWorkspaceBridgeConfigDirectory());profile.close();
  const catalogue=createAccountCatalogue({directory:root,scope:accountScope({origin,skillId:scope.skillId,companyId,memberId,connectionId}),io:{
    ensureDirectory:engine.ensurePrivateDirectory,read:engine.readPrivateJsonFile,write:engine.writePrivateJsonFile,
    checkDirectory:dir=>engine.assertPrivatePathKind(dir,'directory')}});
  await catalogue.change({operation:'create',id:accountId,name:'Synthetic native MAX',expectedRevision:(await catalogue.list()).revision});
  const sourceDir=path.join(directory,`max-native-package-${encrypted}`),marker=path.join(directory,`max-native-child-${encrypted}`),fence=path.join(directory,`max-native-fence-${encrypted}`);
  await fs.mkdir(sourceDir);
  const build=async({mode='monitor',verifyOnly=false,outcome='confirmed',failure=null}={})=>{
    const args=mode==='read'?['read-reference','--chat',chat,'--message-id','11','--expected-revision',revision,'--expected-conversation-key',key]:mode==='monitor'?['monitor','--chat',chat,'--unread-backfill','--conversation-references','--limit','100']:
      ['ack-reference','--chat',chat,'--message-id','11','--expected-revision',revision,'--expected-conversation-key',key,
        '--covered-reference','11:'+revision,verifyOnly?'--verify-only':'--confirm'];
    const output=mode==='read'?{schemaVersion:1,protocol:'max-message-read/v1',reference:{id:reference.id,revision,conversationKey:key},
      message:{text:'EXACT_BODY_CANARY',textTruncated:false},coverage:{textComplete:true,attachmentsContentRead:false,otherMessagesIncluded:false,contextIncluded:false,nativeMessageVerified:true},
      readState:{marksRead:false,readReceiptsSent:false,mode:'history-only',viewsRegistered:false}}:mode==='monitor'?monitor:failure??{ok:true,schemaVersion:1,protocol:'max-message-ack/v1',
      reference:{id:reference.id,revision,conversationKey:key,chatId:'77',messageId:'11'},readState:{acknowledged:outcome==='confirmed',
        coveredReferencesVerified:true,writeAttempted:!verifyOnly,writeOutcome:verifyOnly?'not_attempted':outcome,
        automaticRetryAllowed:false,viewsRegistered:false,verifyOnly,snapshotAtomic:false}};
    await fs.writeFile(path.join(sourceDir,'main.mjs'),`import fs from 'node:fs';import assert from 'node:assert/strict';
      assert.deepEqual(process.argv.slice(2),${JSON.stringify(args)});
      assert.equal(process.env.CODEX_THREAD_ID,${JSON.stringify(mode==='read'?bodyThread:undefined)});assert.equal(process.env.TRELIO_SECRET_FILE,undefined);
      assert.equal(JSON.parse(process.env.TRELIO_SKILL_ACCOUNT_JSON).id,${JSON.stringify(accountId)});
      ${encrypted?"assert.equal(JSON.parse(process.env.TRELIO_SKILL_CONNECTION_CONFIG_JSON).region,'ENCRYPTED_CONFIG_CANARY');":''}
      ${mode==='ack'?`assert.equal(fs.readFileSync(${JSON.stringify(fence)},'utf8'),'DURABLE');`:''}
      let input='';for await(const c of process.stdin)input+=c;assert.equal(input,'');
      fs.appendFileSync(${JSON.stringify(marker)},'1');${failure?'process.stderr':'process.stdout'}.write(${JSON.stringify(JSON.stringify(output))});
      process.exitCode=${failure?2:0};`);
    await fs.writeFile(path.join(sourceDir,'trelio-assistant-execution.json'),JSON.stringify({schemaVersion:1,taskCommands:[['read-reference']]}));
    artifactId=randomUUID();releaseId=randomUUID();
    packageBytes=await engine.buildAgentSkillPackage({skillId:scope.skillId,runtimeVersion:providerVersion,sourceDirectory:sourceDir,
      entrypointPath:'main.mjs',interpreter:'node',capabilities:['network','local-session','local-accounts-v1']});
  };
  await build();
  const page=await readAssistantSourceMonitor({identity,host,store:selectedStore,source:{...scope,accountId,chat,cursor:null,initialUnread:true,...(encrypted?{sourceId,sourceRevision:0}:{})}});
  assert.equal(page.initialUnreadBackfill,true);assert.equal(page.events[0].senderNamespace,'max_user_id');
  assert.equal(page.events[0].conversationKey,key);assert.doesNotMatch(JSON.stringify(page),/PRIVATE/);
  if(encrypted){
    const before=await fs.readFile(marker,'utf8');
    for(cryptoMode of ['aad','missing','extra','ciphertext','recipient']){
      await assert.rejects(readAssistantSourceMonitor({identity,host,store:selectedStore,source:{...scope,accountId,chat,cursor:null,
        initialUnread:true,sourceId,sourceRevision:0}}));
      assert.equal(await fs.readFile(marker,'utf8'),before,'bad ciphertext or recipient refuses before provider launch');
    }
    cryptoMode='valid';
  }
  if(encrypted){
    const {DatabaseSync}=await import('node:sqlite');
    const {createAssistantInbox}=await import('../host-runtime/scripts/trelio-assistant-inbox.mjs');
    const {createAssistantWorkspaceProfile,createAssistantSourceReadObserver,materializeAssistantEncryptedSkill}=
      await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
    const {executeAssistantWorkspacePlan}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
    const file=path.join(directory,'encrypted-max-inbox.sqlite');let database=new DatabaseSync(file);
    let inbox=createAssistantInbox({database,now:()=>1_000_000});t.after(()=>database.close());
    const canonical={origin,assistantId,companyId,provider:'trelio',accountId:memberId,bindingId:randomUUID()};
    const external={origin,assistantId,companyId,provider:'max',accountId,bindingId:sourceId};
    const bindingId=randomUUID(),route={id:routeId,sourceId,sourceRevision:0,conversationKey:key,bindingId,bindingRevision:1,taskId:reference.taskId};
    inbox.register(canonical);inbox.register(external);inbox.observeExternalSourceRevision(external,0);
    inbox.applyTaskState(canonical,{taskId:reference.taskId,state:'accepted',expectedRevision:0,authority:{bindingId,revision:1}});
    inbox.commitPage(external,{...inbox.claimPoll(external),nextCursor:page.nextCursor,hasMore:false,
      events:page.events.map(row=>({id:row.id,revision:row.revision,taskId:null,wake:false,providerWake:true,conversationKey:row.conversationKey}))});
    inbox.routeExternalEvents(external,{canonicalSource:canonical,sourceRevision:0,eventKeys:inbox.pendingExternalRoutes(external).map(row=>row.event_key),routes:[route]});
    const work=await inbox.claimDelivery({authorize:async()=>true});inbox.startDelivery(work.deliveryId);
    const pass={schemaVersion:1,assistantId,deviceId,companyId,taskId:reference.taskId,passId:randomUUID(),deliveryId:work.deliveryId,
      threadId:randomUUID(),bindingId,bindingRevision:1};bodyThread=pass.threadId;
    const runtime={schemaVersion:1,passId:pass.passId,threadId:pass.threadId,state:{runtimeSessionId:randomUUID(),
      expiresAt:new Date(Date.now()+300000).toISOString(),privateKeyPkcs8:privateKey.export({type:'pkcs8',format:'der'}).toString('base64url'),
      observation:{schemaVersion:1,clientFamily:'codex',modelId:'gpt-6.1-sol',effortLevel:'high',evidenceLevel:'local_observed',source:'codex_hook'}}};
    const taskStore={get:slot=>slot.kind==='runtime'?runtime:selectedStore.get(slot),put:selectedStore.put};
    const taskHost={readIdentity:host.readIdentity,readActivePass:async()=>pass};
    const taskClient={readTaskPass:async()=>({...pass,state:'leased',leaseExpiresAt:new Date(Date.now()+300000).toISOString()}),
      sourceAccounts:async()=>[source],sourceRoutes:async()=>[route]};
    const observer=createAssistantSourceReadObserver({identity,client:taskClient,host:taskHost,withInbox:async action=>action(inbox)});
    await build({mode:'read'});
    const profile=await createAssistantWorkspaceProfile({identity,client:taskClient,host:taskHost,store:taskStore,sourceReads:observer,
      lockDirectory:path.join(directory,'encrypted-task-locks'),lock:(_file,action)=>action()});
    const plan={prepared:true,scope:{assistantUserId:assistantId,deviceId,companyId,taskId:pass.taskId,passId:pass.passId},localAction:{
      schemaVersion:1,operation:'skill_run',parameters:{companyId,skillId:scope.skillId,releaseId,runtimeSessionId:runtime.state.runtimeSessionId,
        arguments:['read-reference','--chat',chat,'--message-id','11','--expected-revision',revision,'--expected-conversation-key',key,'--local-account',accountId]}}};
    const body=await engine.withWorkspaceExecutionProfile(profile,()=>executeAssistantWorkspacePlan(plan,{withProfile:action=>action({identity,client:taskClient,host:taskHost,store:taskStore})}));
    assert.equal(JSON.parse(body.stdout).message.text,'EXACT_BODY_CANARY');
    const selected=[{sourceId,sourceRevision:0,routeId,eventOrdinal:0}];
    assert.deepEqual(await observer.confirmProcessing(pass,selected),selected);
    assert.equal(inbox.claimAcknowledgements(external),null,'actual signed body read is not material processing');
    // The native accepted-material receipt is the independent backend contract;
    // this queue composition accepts only its selected original delivery slots.
    inbox.completeDelivery(work.deliveryId,`assistant:${receiptId}:codex:${pass.threadId}:${randomUUID()}`,{processedSourceReferences:selected});
    database.close();database=new DatabaseSync(file);inbox=createAssistantInbox({database,now:()=>1_000_000});
    const ack=inbox.claimAcknowledgements(external),refs=inbox.externalAcknowledgementReferences(external,{token:ack.token,sourceRevision:0});
    assert.equal(refs.length,1);assert.equal(refs[0].id,reference.id);assert.equal(refs[0].receiptId,receiptId);
    assert.doesNotMatch(JSON.stringify(database.prepare('SELECT * FROM assistant_inbox_events').all()),/EXACT_BODY_CANARY|ENCRYPTED_CONFIG_CANARY|CURRENT_ASSISTANT_RULE_CANARY/);
    const descriptor={schemaVersion:1,nativeTool:'get_agent_skill',companyId,projectId:null,skillId:scope.skillId,releaseId,
      arguments:{sections:['instructions','execution']}};
    const readProfile=await createAssistantWorkspaceProfile({identity,client:taskClient,host:taskHost,store:taskStore,encryptedSkillRead:descriptor,
      lockDirectory:path.join(directory,'encrypted-guidance-locks'),lock:(_file,action)=>action()});
    const skill=await engine.withWorkspaceExecutionProfile(readProfile,()=>materializeAssistantEncryptedSkill({origin,descriptor}));
    assert.match(JSON.stringify(skill),/CURRENT_ASSISTANT_RULE_CANARY/);
    assert.doesNotMatch(JSON.stringify(skill),/~e1:|ciphertext|scopePrivateEncryptionJwk|trelio-local/);
    await build();
  }
  const before=await fs.readFile(marker,'utf8');providerVersion='2.10.2';await build();
  await assert.rejects(readAssistantSourceMonitor({identity,host,store:selectedStore,source:{...scope,accountId,chat,cursor:null,initialUnread:true,...(encrypted?{sourceId,sourceRevision:0}:{})}}),/CAPABILITY_REQUIRED/);
  assert.equal(await fs.readFile(marker,'utf8'),before,'old package cannot start a provider or claim a baseline');providerVersion='2.11.0';
  ackFixture={intent:{sourceId,sourceRevision:0,receipts:[{receiptId,eventOrdinals:[0]}]},admission:{schemaVersion:1,
    sourceId,sourceRevision:0,localAccountId:accountId,slots:[{receiptId,routeId,eventOrdinal:0}]}};
  const client={identity,sourceAccounts:async()=>[source]};let starts=0;
  const invoke=async(verifyOnly=false)=>{
    if(verifyOnly){ackFixture.intent.verifyOnly=true;ackFixture.admission.verifyOnly=true;}
    else{delete ackFixture.intent.verifyOnly;delete ackFixture.admission.verifyOnly;}
    return acknowledgeAssistantSource({identity,host,store:selectedStore,client,source,references:[reference],verifyOnly,
      assertReferences:()=>{},beforeInvoke:async()=>{starts++;await fs.writeFile(fence,'DURABLE');}});
  };
  await build({mode:'ack'});const resolves=resolveCalls;
  assert.deepEqual(await invoke(),{acknowledged:true,notAttempted:false,code:null});assert.equal(resolveCalls,resolves+2);assert.equal(starts,1);
  await build({mode:'ack',outcome:'unknown'});
  assert.deepEqual(await invoke(),{acknowledged:false,notAttempted:false,code:'MAX_ACK_OUTCOME_UNKNOWN'},'complete unknown cannot become a safe retry');
  await build({mode:'ack',verifyOnly:true});
  assert.deepEqual(await invoke(true),{acknowledged:true,notAttempted:true,code:null},'restart reconciliation keeps the same exact covered set');
  const failure={ok:false,error:'PRIVATE_MAX_ERROR',code:'MAX_ACK_COVERAGE_INCOMPLETE',
    details:{writeAttempted:false,writeOutcome:'not_attempted',automaticRetryAllowed:false}};
  await build({mode:'ack',failure});assert.deepEqual(await invoke(),{acknowledged:false,notAttempted:true,code:failure.code});
  const calls=await fs.readFile(marker,'utf8'),fences=starts;
  resolveOverride=()=>new Response(JSON.stringify({...resolution(),sourceAdmission:{...admission(),protocol:'telegram-message-ack/v1'}}));
  await assert.rejects(invoke(),/INVALID_RESPONSE/);assert.equal(starts,fences);assert.equal(await fs.readFile(marker,'utf8'),calls);resolveOverride=null;
  client.sourceAccounts=async()=>[{...source,maxChatUrl:'https://web.max.ru/78'}];
  await assert.rejects(invoke(),/BINDING_CHANGED/);assert.equal(starts,fences);assert.equal(await fs.readFile(marker,'utf8'),calls);
});

test('MAX native projection binds exact numeric chat, native identity and unchanged opaque cursor positions',()=>{
  const chat='https://web.max.ru/77',revision='a'.repeat(64),scope='b'.repeat(64),key='max-conversation/v1.'+'c'.repeat(64);
  const cursor=(anchorId='11',anchorRevision=revision,s=scope)=>Buffer.from(JSON.stringify({v:2,scope:s,anchorId,anchorRevision})).toString('base64url');
  const row={id:'message:77:11',revision,kind:'new',chatId:'77',messageId:'11',conversationKey:key,senderUserId:'123',
    senderNamespace:'max_user_id',outgoing:false,forwarded:false,body:'PRIVATE'};
  const raw={schemaVersion:1,baselineOnly:false,events:[row],nextCursor:cursor(),hasMore:false,
    coverage:{historicalBackfill:true,initialUnreadOnly:true,snapshotAtomic:false,ownerIdentityAvailable:true,
      nativeMessageVerified:true,earlierEditsIncluded:false,otherChatsIncluded:false},readState:{readReceiptsSent:false}};
  const project=value=>projectAssistantMonitorPage({exitCode:0,stdout:JSON.stringify(value)},
    {skillId:'max-web',chat,cursor:null,initialUnread:true,nativeMax:true});
  assert.equal(project(raw).events[0].senderUserId,'123');assert.doesNotMatch(JSON.stringify(project(raw)),/PRIVATE/);
  for(const changed of [{...row,chatId:'78'},{...row,senderNamespace:'username'},{...row,conversationKey:'max-conversation/v1.bad'},
    {...row,outgoing:'false'},{...row,senderUserId:'@owner'}])assert.throws(()=>project({...raw,events:[changed]}),/INVALID_RESPONSE/);
  assert.throws(()=>project({...raw,nextCursor:cursor('12')}),/INVALID_RESPONSE/);
  assert.throws(()=>project({...raw,coverage:{...raw.coverage,nativeMessageVerified:false}}),/INVALID_RESPONSE/);
  const empty={...raw,baselineOnly:true,events:[],nextCursor:cursor(null,null),coverage:{...raw.coverage,historicalBackfill:false}};
  assert.equal(project(empty).baselineOnly,true);
  assert.throws(()=>projectAssistantMonitorPage({exitCode:0,stdout:JSON.stringify({...raw,events:[],nextCursor:cursor('12'),coverage:{...raw.coverage,historicalBackfill:false,initialUnreadOnly:undefined}})},
    {skillId:'max-web',chat,cursor:cursor(),nativeMax:true}),/INVALID_RESPONSE/);
});

test('owner intake rereads one exact signed original, rechecks native owner and never acknowledges or imports',async t=>{
 const saved={...scope};t.after(()=>{Object.assign(scope,saved);intakeFixture=null;resolveOverride=null;});
 for(const provider of ['telegram-mtproto','max-web']){
  scope.skillId=provider;const max=provider==='max-web',sourceId=randomUUID(),accountId=randomUUID(),intakeId=randomUUID(),eventId=randomUUID(),threadId=randomUUID(),ownerIdentityId=randomUUID();
  const source={id:sourceId,...scope,deviceId,localAccountId:accountId,state:'active',revision:0,ownerTaskIntakeAllowed:true,...(max?{maxChatUrl:'https://web.max.ru/77'}:{})};
  const pass={schemaVersion:1,kind:'source_intake',assistantId,deviceId,companyId,sourceId,sourceRevision:0,passId:intakeId,deliveryId:randomUUID(),eventId,threadId};
  const ref={eventId,id:'message:77:8',revision:'b'.repeat(64),conversationKey:`${max?'max':'telegram'}-conversation/v1.${'a'.repeat(64)}`};
  intakeFixture={intent:{intakeId,sourceId,expectedRevision:0},admission:{schemaVersion:1,intakeId,sourceId,sourceRevision:0,localAccountId:accountId,
    eventId,threadId,ownerIdentityId,ownerExternalUserId:'123456',...(max?{maxChatUrl:source.maxChatUrl}:{})}};
  const dir=path.join(directory,`intake-${provider}`);await fs.mkdir(dir);const output=path.join(dir,'output'),marker=path.join(dir,'calls');
  await fs.writeFile(path.join(dir,'main.mjs'),`import assert from 'node:assert/strict';import fs from 'node:fs';
    assert.deepEqual(process.argv.slice(2),${JSON.stringify(['read-reference','--chat',max?source.maxChatUrl:'77','--message-id','8','--expected-revision',ref.revision,'--expected-conversation-key',ref.conversationKey])});
    assert.equal(JSON.parse(process.env.TRELIO_SKILL_ACCOUNT_JSON).id,${JSON.stringify(accountId)});
    assert.equal(process.env.CODEX_THREAD_ID,undefined);fs.appendFileSync(${JSON.stringify(marker)},'read;');process.stdout.write(fs.readFileSync(${JSON.stringify(output)},'utf8'));`);
  artifactId=randomUUID();releaseId=randomUUID();packageBytes=await engine.buildAgentSkillPackage({skillId:provider,runtimeVersion:'2.99.42',sourceDirectory:dir,
    entrypointPath:'main.mjs',interpreter:'node',capabilities:['network','local-session','local-accounts-v1']});
  const profile=await createAssistantSourceRuntimeProfile({identity,host,store,scope});
  const root=await profile.resolveSkillCatalogueDirectory(engine.resolveWorkspaceBridgeConfigDirectory());profile.close();
  const catalogue=createAccountCatalogue({directory:root,scope:accountScope({origin,skillId:provider,companyId,memberId}),io:{ensureDirectory:engine.ensurePrivateDirectory,
    read:engine.readPrivateJsonFile,write:engine.writePrivateJsonFile,checkDirectory:dir=>engine.assertPrivatePathKind(dir,'directory')}});
  await catalogue.change({operation:'create',id:accountId,name:'Synthetic owner intake',expectedRevision:(await catalogue.list()).revision});
  const message={schemaVersion:1,protocol:max?'max-message-read/v1':'telegram-message-read/v1',reference:{...ref,senderNamespace:max?'max_user_id':'telegram_user_id',
    senderUserId:'123456',outgoing:false,forwarded:false,viaBot:false},message:{text:'Prepare the weekly plan',textTruncated:false,replyContext:null,replyText:'UNTRUSTED_QUOTE'},
    coverage:{textComplete:true,contextIncluded:false,attachmentsContentRead:false,nativeMessageVerified:true},readState:{mode:'history-only',marksRead:false,readReceiptsSent:false,viewsRegistered:false}};
  const client={identity,sourceAccounts:async()=>[source],readSourceIntake:async()=>({state:'leased',threadId,eventId,sourceRevision:0,leaseExpiresAt:new Date(Date.now()+60000).toISOString()})};
  const input={identity,client,host:{...host,readActivePass:async()=>pass},store,pass,source,reference:ref};
  await fs.writeFile(output,JSON.stringify(message));assert.deepEqual(await readAssistantOwnerIntakeMessage(input),{text:message.message.text,ownerIdentityId,ownerExternalUserId:'123456'});
  for(const patch of [{senderUserId:'654321'},{outgoing:true},{forwarded:true},...(!max?[{viaBot:true}]:[])]){
    await fs.writeFile(output,JSON.stringify({...message,reference:{...message.reference,...patch}}));
    await assert.rejects(readAssistantOwnerIntakeMessage(input),/OWNER_UNVERIFIED/);
  }
  assert.match(await fs.readFile(marker,'utf8'),/^read;+/);assert.equal((await catalogue.list()).accounts.length>=1,true);
 }
});

test('additional company binding reuses same catalogue, preserves sessions and reads back only its exact native intent',async t=>{
 const saved={...scope};t.after(()=>{Object.assign(scope,saved);setupFixture=null;resolveOverride=null;});scope.skillId='telegram-mtproto';
 const originCompany=randomUUID(),originMember=randomUUID(),accountId=randomUUID();
 const dir=path.join(directory,'bind-package');await fs.mkdir(dir);await fs.writeFile(path.join(dir,'main.mjs'),"throw new Error('A bind must never launch a provider');");
 artifactId=randomUUID();releaseId=randomUUID();packageBytes=await engine.buildAgentSkillPackage({skillId:scope.skillId,runtimeVersion:'2.99.42',sourceDirectory:dir,
   entrypointPath:'main.mjs',interpreter:'node',capabilities:['network','local-session','local-accounts-v1']});
 const profile=await createAssistantSourceRuntimeProfile({identity,host,store,scope}),root=await profile.resolveSkillCatalogueDirectory(engine.resolveWorkspaceBridgeConfigDirectory());profile.close();
 const io={ensureDirectory:engine.ensurePrivateDirectory,read:engine.readPrivateJsonFile,write:engine.writePrivateJsonFile,checkDirectory:dir=>engine.assertPrivatePathKind(dir,'directory')};
 const original=createAccountCatalogue({directory:root,scope:accountScope({origin,skillId:scope.skillId,companyId:originCompany,memberId:originMember}),io});
 await original.change({operation:'create',id:accountId,name:'Preserved account',expectedRevision:(await original.list()).revision});
 setupFixture={...scope,id:randomUUID(),deviceId,localAccountId:accountId,revision:0,state:'active',provisionLocalAccount:false,
  bindFromSourceId:randomUUID(),bindingOrigin:{companyId:originCompany,memberId:originMember,connectionId:null},executionVerified:false};
 const input={identity,host,store,client:{identity,sourceAccounts:async()=>[setupFixture]},companyId,sourceId:setupFixture.id};
 const first=await prepareAssistantSourceAccount(input);assert.equal(first.replayed,false);assert.equal(first.loginVerified,false);
 assert.equal((await prepareAssistantSourceAccount(input)).replayed,true);
 assert.equal((await original.select(accountId)).name,'Preserved account');
 const target=createAccountCatalogue({directory:root,scope:accountScope({origin,skillId:scope.skillId,companyId,memberId}),io});
 assert.equal((await target.select(accountId)).name,'Preserved account');
 const before=await target.list();setupFixture={...setupFixture,id:randomUUID()};
 await assert.rejects(prepareAssistantSourceAccount({...input,sourceId:setupFixture.id}),/ACCOUNT_ID_CONFLICT/);
 assert.deepEqual(await target.list(),before,'another native intent cannot adopt a pre-existing binding');
});


test('the shared pure exact-read parser accepts only native structural selectors and the common account grammar',()=>{
  const before=reads,accountId=randomUUID();
  for(const skillId of ['telegram-mtproto','email-imap-smtp','max-web']){
    const provider=skillId==='email-imap-smtp'?'email':skillId==='max-web'?'max':'telegram';
    const key=`${provider}-conversation/v1.${'a'.repeat(64)}`,revision='b'.repeat(64);
    const chat=provider==='max'?'https://web.max.ru/-77':'-77';
    const args=provider==='email'?['read-reference','--uid','11','--uid-validity','17','--expected-revision',revision,'--expected-conversation-key',key]
      :['read-reference','--chat',chat,'--message-id','11','--expected-revision',revision,'--expected-conversation-key',key];
    const expected={provider,accountId:null,eventId:provider==='email'?'uid:17:11':'message:-77:11',eventRevision:revision,
      conversationKey:key,...(provider==='email'?{}:{chat})};
    assert.deepEqual(parseAssistantSourceReadReference({skillId,arguments:args}),expected);
    assert.ok(Object.isFrozen(parseAssistantSourceReadReference({skillId,arguments:args})));
    for(const raw of [['--local-account',accountId,...args],[...args,'--local-account',accountId]])
      assert.deepEqual(parseAssistantSourceReadReference({skillId,arguments:raw}),{...expected,accountId});
    const wrongKey=[...args];wrongKey[8]=`trelio-conversation/v1.${'a'.repeat(64)}`;
    const prose=[...args];prose[2]='PRIVATE QUERY';
    const wrongRevision=[...args];wrongRevision[6]='PRIVATE BODY';
    const zero=[...args];zero[4]='0';
    const duplicate=[...args];duplicate[3]=duplicate[1];
    for(const invalid of [wrongKey,prose,wrongRevision,zero,duplicate,[...args,'--body','PRIVATE'],
      [...args,'--local-account=PRIVATE'],[...args,'--local-account','PRIVATE'],
      ['--local-account',accountId,...args,'--local-account',accountId]])
      assert.throws(()=>parseAssistantSourceReadReference({skillId,arguments:invalid}),{code:'ASSISTANT_SOURCE_READ_REQUIRED'});
  }
  assert.equal(parseAssistantSourceReadReference({skillId:'other',arguments:['read-reference','PRIVATE']}),null);
  assert.equal(parseAssistantSourceReadReference({skillId:'max-web',arguments:['history','PRIVATE']}),null,
    'unreviewed commands are unavailable, never interpreted as safe queries');
  assert.equal(reads,before,'pure parser performs no native/account/private storage I/O');
});

// Exact native owner/grant effects are exercised in PostgreSQL; this fixture
// composes the genuine managed profile with actual HPKE, signed ciphertext,
// complete temporary inspection and then the SAME signed child after consent.
test('encrypted company runtime is inspected through its exact managed bundle before owner review and executes only after fresh consent',async()=>{
  const {createAssistantWorkspaceProfile,materializeAssistantEncryptedSkill,inspectAssistantSkillConsentForOwner}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const {executeAssistantWorkspacePlan}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const {resolveAssistantCompanyEncryptionDevice}=await import('../host-runtime/scripts/trelio-assistant-private.mjs');
  const crypto=await import('../host-runtime/scripts/trelio-company-encryption.mjs');
  const values=new Map(),nativeStore={get:async slot=>values.get(JSON.stringify(slot))??null,
    put:async(slot,value)=>values.set(JSON.stringify(slot),structuredClone(value))};
  await nativeStore.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential,expiresAt:1});
  const pass={schemaVersion:1,assistantId,deviceId,companyId,taskId:randomUUID(),passId:randomUUID(),deliveryId:randomUUID(),threadId:randomUUID(),bindingId:randomUUID(),bindingRevision:1};
  const runtime={schemaVersion:1,passId:pass.passId,threadId:pass.threadId,state:{runtimeSessionId:randomUUID(),expiresAt:new Date(Date.now()+300000).toISOString(),
    privateKeyPkcs8:privateKey.export({type:'pkcs8',format:'der'}).toString('base64url'),observation:{schemaVersion:1,clientFamily:'codex',modelId:'gpt-6.1-sol',effortLevel:'high',evidenceLevel:'local_observed',source:'codex_hook'}}};
  await nativeStore.put({origin,kind:'runtime',id:pass.passId},runtime);
  let active=true,granted=false,variant='valid',downloads=0,resolveCount=0;const client={readTaskPass:async()=>({...pass,state:active?'leased':'closed',leaseExpiresAt:new Date(Date.now()+300000).toISOString()})};
  const taskHost={readIdentity:async()=>identity,readActivePass:async()=>pass};
  const managed=await resolveAssistantCompanyEncryptionDevice({identity,companyId,store:nativeStore,lockDirectory:path.join(directory,'private-consent-keys'),assertCurrent:async()=>{},lock:(_file,action)=>action()});
  const pair=await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const publicJwk=await webcrypto.subtle.exportKey('jwk',pair.publicKey),privateJwk=await webcrypto.subtle.exportKey('jwk',pair.privateKey);
  const scopeId=randomUUID(),recipientId=randomUUID(),entityId=randomUUID(),currentRelease=randomUUID(),currentArtifact=randomUUID(),publicationId=randomUUID();
  const aad={suite:'trelio-e2ee-v1',companyId,scopeId,scopeEpoch:1,recipientType:'agent_device',recipientId};
  const wrapped=await crypto.hpkeSeal({recipientPublicEncryptionJwk:managed.publicEncryptionJwk,plaintext:Buffer.from(JSON.stringify({suite:'trelio-e2ee-v1',version:1,scopePrivateEncryptionJwk:privateJwk})),aad});
  const envelope={id:randomUUID(),...aad,hpkeEnc:wrapped.enc,ciphertext:wrapped.ciphertext,aad};
  const skillId='encrypted-company-task-fixture',root=path.join(directory,'private-consent-package'),childMarker=path.join(directory,'private-consent-child');await fs.mkdir(root);
  const source=`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(childMarker)},'1');console.log('PRIVATE_COMPANY_CHILD_OK');`;
  await fs.writeFile(path.join(root,'main.mjs'),source);await fs.writeFile(path.join(root,'trelio-assistant-execution.json'),JSON.stringify({schemaVersion:1,taskCommands:[['read']]}));
  const plaintext=await engine.buildAgentSkillPackage({skillId,runtimeVersion:'1.0.0',sourceDirectory:root,entrypointPath:'main.mjs',interpreter:'node',capabilities:['network']});
  const parsed=engine.parseAndValidateAgentSkillPackage(plaintext,skillId),manifest={format:'trelio-agent-skill-package/v1',skill:{id:skillId,runtimeVersion:'1.0.0'},entrypoint:parsed.entrypoint,
    capabilities:[...parsed.capabilities].sort(),files:parsed.files.map(file=>({path:file.path,mode:file.mode,sha256:file.sha256,sizeBytes:file.bytes.length}))};
  const original=path.join(directory,'private-consent-plaintext.skillpkg'),encrypted=path.join(directory,'private-consent-cipher.skillpkg');await fs.writeFile(original,plaintext,{mode:0o600});
  await crypto.encryptFileToCompanyContainer({sourcePath:original,destinationPath:encrypted,scopePublicEncryptionJwk:publicJwk,
    aad:{companyId,scopeId,scopeEpoch:1,entityType:'file.agent_skill_runtime_artifacts',entityId,entityRevision:1,schemaVersion:1},
    originalName:'private.skillpkg',mimeType:'application/vnd.trelio.agent-skill-package+json',writerDeviceId:recipientId,signingPrivateKey:managed.privateKeys.signingPrivateKey});
  const cipher=await fs.readFile(encrypted),packageSha256=createHash('sha256').update(cipher).digest('hex');
  const textMarker=field=>crypto.buildCompanyEncryptedTextMarker(entityId,field),jsonMarker=field=>crypto.buildCompanyEncryptedJsonMarker(entityId,field);
  const fieldAad={companyId,scopeId,scopeEpoch:1,entityType:'agent_skill.publication',entityId,entityRevision:1,schemaVersion:1,purpose:'content'};
  const payload={...fieldAad,...await crypto.encryptCompanyPayload({scopePublicEncryptionJwk:publicJwk,aad:fieldAad,payload:{values:{manifest_json:manifest,title:'PRIVATE_COMPANY_SKILL_TITLE',instructions_markdown:'# Private company instructions',summary:'Private release',change_reason:'Private purpose'}}})};
  const fields={skillId,projectId:null,releaseId:currentRelease,publicationId,runtimeArtifactId:currentArtifact,packageSha256,instructionsSha256:'a'.repeat(64)};
  const descriptor={schemaVersion:1,nativeTool:'get_agent_skill',companyId,projectId:null,skillId,releaseId:currentRelease,arguments:{sections:['instructions','execution']}};
  const raw=()=>({releaseId:currentRelease,company:{id:companyId,slug:'fixture',name:'Fixture'},localIdentity:{companyId,projectId:null,skillId,memberId,connectionId:null},companyConnection:null,
    trust:{level:'company_unverified',artifactLevel:'company_unverified',requiresDeviceConsent:true,consentId:granted?publicationId:null},
    artifact:{id:currentArtifact,skillId,runtimeVersion:'1.0.0',packageFormat:'trelio-company-encrypted-skill-package/v1',contentProtection:'company_e2ee_v1',manifest:jsonMarker('manifest_json'),packageSha256,
      packageSizeBytes:cipher.length,packageSignature:sign(null,cipher,privateKey).toString('base64'),signingKeyId:'fixture',signingPublicKeySpki:publicKey.export({type:'spki',format:'der'}).toString('base64'),minimumHostVersion:'3.10.1'},
    packageUrl:'/api/agent-skills/runtime/package?'+new URLSearchParams({companyId,skillId,expectedReleaseId:currentRelease,artifactId:currentArtifact}),
    consentChallenge:granted?null:{skill:{title:textMarker('title')},publication:{summary:textMarker('summary'),changeReason:textMarker('change_reason')},artifact:{previousManifest:null}},
    assistantEncryption:{schemaVersion:1,companyId,recipientDeviceId:recipientId,envelopeId:envelope.id,scopeId,scopeEpoch:1,encryptedPayloads:[payload]},
    assistantGuidance:{content:[],structuredContent:{skill:{id:skillId,title:textMarker('title'),instructionsMarkdown:textMarker('instructions_markdown')},runtimeExecution:{releaseId:currentRelease,
      localAction:{server:'trelio-local',tool:'continue_trelio_workspace_action',arguments:{schemaVersion:1,operation:'skill_run',parameters:{companyId,skillId,releaseId:currentRelease}}}},
      assistantExecution:{runtimeConsent:granted?{state:'accepted',consentId:publicationId}:{state:'owner_review_required',fields,challenge:{},operation:'accept_skill_runtime',continuation:'skill_consent'}}}}});
  const previous=globalThis.fetch;globalThis.fetch=async(url,options)=>{
    assert.equal(url.origin,origin);assert.equal(options.headers.get('authorization'),`Bearer ${credential}`);assert.equal(options.headers.get('cookie'),null);
    assert.doesNotMatch(String(options.body??''),/PRIVATE_COMPANY_SKILL_TITLE|Private company instructions|scopePrivateEncryptionJwk/);
    if(url.pathname==='/api/digital-assistants/runtime/encryption/runtime')return new Response(JSON.stringify({state:'encrypted',suite:'trelio-e2ee-v1',company:{id:companyId,slug:'fixture',name:'Fixture'},
      viewer:{userId:assistantId},accessState:'ready',device:{id:recipientId,fingerprint:managed.fingerprint},scope:{id:scopeId,epoch:1,publicEncryptionJwk:publicJwk},envelope}));
    if(url.pathname==='/api/digital-assistants/runtime/workspace/bridge-compatibility'){
      const rules='# Private consent fixture',sha256=createHash('sha256').update(rules).digest('hex');
      return new Response(JSON.stringify({supported:true,minimumVersion:'0.0.0',agentRules:{status:options.headers.get('x-trelio-agent-rules-sha256')===sha256?'current':'update_required',revisionId:scopeId,version:1,sha256,rulesMarkdown:rules}}));
    }
    if(url.pathname==='/api/agent-skills/runtime/resolve'){
      resolveCount++;const value=raw();if(variant==='latehash'&&resolveCount%2===0)value.artifact.packageSha256='c'.repeat(64);if(variant==='recipient')value.assistantEncryption.recipientDeviceId=randomUUID();
      if(variant==='scope')value.assistantEncryption.scopeEpoch=2;
      if(variant==='extra')value.assistantEncryption.encryptedPayloads.push({...payload,entityId:randomUUID()});
      return new Response(JSON.stringify(value));
    }
    assert.equal(url.pathname,'/api/agent-skills/runtime/package');downloads++;const bytes=Buffer.from(cipher);if(variant==='cipher')bytes[bytes.length-1]^=1;return new Response(bytes);
  };
  const make=read=>createAssistantWorkspaceProfile({identity,client,host:taskHost,store:nativeStore,...(read?{encryptedSkillRead:descriptor}:{}),lockDirectory:path.join(directory,'private-consent-locks'),lock:(_file,action)=>action()});
  try{
    const profile=await make(true),run=action=>engine.withWorkspaceExecutionProfile(profile,action);
    const view=await run(()=>materializeAssistantEncryptedSkill({origin,descriptor}));
    assert.deepEqual(view.structuredContent.assistantExecution.runtimeConsent.localInspection.capabilities,['network']);assert.equal(downloads,1);
    assert.match(JSON.stringify(view),/PRIVATE_COMPANY_SKILL_TITLE/);assert.doesNotMatch(JSON.stringify(view),/~e1:|scopePrivateEncryptionJwk|ciphertext|trelio-local/);
    await assert.rejects(fs.readFile(childMarker),{code:'ENOENT'});
    const review=await run(()=>inspectAssistantSkillConsentForOwner({origin,companyId,fields}));assert.deepEqual(review.capabilities,['network']);
    await assert.rejects(run(()=>inspectAssistantSkillConsentForOwner({origin,companyId,fields:{...fields,packageSha256:'b'.repeat(64)}})),/CONSENT_CHANGED/);
    for(const changed of ['recipient','scope','extra','cipher']){variant=changed;await assert.rejects(run(()=>materializeAssistantEncryptedSkill({origin,descriptor})));}
    variant='valid';granted=true;
    const live=await make(false),plan={prepared:true,scope:{assistantUserId:assistantId,deviceId,companyId,taskId:pass.taskId,passId:pass.passId},localAction:{schemaVersion:1,operation:'skill_run',
      parameters:{companyId,skillId,releaseId:currentRelease,runtimeSessionId:runtime.state.runtimeSessionId,arguments:['read']}}};
    const executed=await engine.withWorkspaceExecutionProfile(live,()=>executeAssistantWorkspacePlan(plan,{withProfile:action=>action({identity,client,store:nativeStore,host:taskHost})}));
    assert.equal(executed.stdout.trim(),'PRIVATE_COMPANY_CHILD_OK');assert.equal(await fs.readFile(childMarker,'utf8'),'1');
    variant='latehash';resolveCount=0;
    await assert.rejects(engine.withWorkspaceExecutionProfile(live,()=>executeAssistantWorkspacePlan(plan,{withProfile:action=>action({identity,client,store:nativeStore,host:taskHost})})),/AGENT_SKILL_RELEASE_CHANGED/);
    assert.equal(await fs.readFile(childMarker,'utf8'),'1','changed live ciphertext cannot execute the already verified plaintext cache');
    variant='valid';active=false;await assert.rejects(run(()=>materializeAssistantEncryptedSkill({origin,descriptor})));assert.equal(await fs.readFile(childMarker,'utf8'),'1');
  }finally{globalThis.fetch=previous;await fs.rm(root,{recursive:true,force:true});await fs.rm(original,{force:true});await fs.rm(encrypted,{force:true});}
});
