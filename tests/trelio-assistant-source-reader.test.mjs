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
const {createAssistantSourceRuntimeProfile,acknowledgeAssistantSource,projectAssistantSourceAcknowledgement,readAssistantSourceMonitor,projectAssistantMonitorPage,prepareAssistantSourceAccount,configureAssistantEmailSource,configureAssistantTelegramSource,verifyAssistantEmailSource,configureAssistantMaxSource,verifyAssistantMaxSource}=
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
let setupFixture=null,ackFixture=null;
const admission=()=>{
  if(ackFixture)return {schemaVersion:1,assistantUserId:assistantId,deviceId,provider:'telegram',
    protocol:'telegram-message-ack/v1',command:'ack-reference',pollIntervalSeconds:300,maximumDurationMs:60000,
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
      localAccountId:setupFixture.localAccountId,operation:operation??'create'}}:{})};
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
        ...(setupFixture.operation?{operation:setupFixture.operation}:{})}}:{}),...(ackFixture?{sourceAcknowledgement:ackFixture.intent}:{})});
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

test('protected email setup consumes separate native permission and the same signed account/process engine',async t=>{
  const selected={...scope};
  t.after(()=>{Object.assign(scope,selected);setupFixture=null;resolveOverride=null;});
  scope.skillId='email-imap-smtp';
  setupFixture={...scope,id:randomUUID(),deviceId,localAccountId:randomUUID(),revision:0,state:'active',
    provisionLocalAccount:true,interactiveSetupAllowed:true,executionVerified:false};
  const sourceId=setupFixture.id,accountId=setupFixture.localAccountId;
  const client={identity,sourceAccounts:async()=>[setupFixture]};
  const configure=()=>configureAssistantEmailSource({identity,host,store,client,companyId,sourceId});
  if(!['darwin','win32'].includes(process.platform)){
    const before=resolveCalls;
    await assert.rejects(configure(),/SETUP_UNAVAILABLE/);
    assert.equal(resolveCalls,before,'unsupported storage cannot open a form or borrow a human account');return;
  }
  const sourceDir=path.join(directory,'email-setup-package');await fs.mkdir(sourceDir);
  const marker=path.join(directory,'email-setup-native-calls');
  await fs.writeFile(path.join(sourceDir,'main.mjs'),`import assert from 'node:assert/strict';import fs from 'node:fs';
    assert.deepEqual(process.argv.slice(2),['configure','--account',${JSON.stringify(accountId)},'--password-input','browser']);
    assert.equal(JSON.parse(process.env.TRELIO_SKILL_ACCOUNT_JSON).id,${JSON.stringify(accountId)});
    assert.equal(process.env.CODEX_THREAD_ID,undefined);assert.equal(process.env.TRELIO_SECRET_FILE,undefined);
    let input='';for await(const chunk of process.stdin)input+=chunk;assert.equal(input,'');
    fs.appendFileSync(${JSON.stringify(marker)},'1');
    process.stdout.write(JSON.stringify({configured:${JSON.stringify(accountId)},passwordInput:'browser',connectionMode:'imap_smtp',
      credentialStore:process.platform==='win32'?'dpapi':'keychain',configPath:'PRIVATE_PATH',email:'PRIVATE_ADDRESS',
      message:'PRIVATE_PROVIDER_DETAIL'}));`);
  artifactId=randomUUID();releaseId=randomUUID();
  packageBytes=await engine.buildAgentSkillPackage({skillId:scope.skillId,runtimeVersion:'2.99.42',sourceDirectory:sourceDir,
    entrypointPath:'main.mjs',interpreter:'node',capabilities:['network','local-session','local-accounts-v1']});
  await prepareAssistantSourceAccount({identity,host,store,client,companyId,sourceId});
  setupFixture.operation='configure';
  const readMarker=()=>fs.readFile(marker,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
  const before=resolveCalls;
  setupFixture.interactiveSetupAllowed=false;
  await assert.rejects(configure(),/SETUP_REQUIRED/);assert.equal(resolveCalls,before);assert.equal(await readMarker(),'');
  setupFixture.interactiveSetupAllowed=true;
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
  const p=await createAssistantSourceRuntimeProfile({identity,host,store,scope,
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

test('Telegram QR setup uses the same signed native child and never leaks factors or proves owner identity',async t=>{
  const savedScope={...scope};t.after(()=>{Object.assign(scope,savedScope);setupFixture=null;resolveOverride=null;});
  scope.skillId='telegram-mtproto';
  setupFixture={...scope,id:randomUUID(),deviceId,localAccountId:randomUUID(),revision:0,state:'active',
    provisionLocalAccount:true,interactiveSetupAllowed:true,executionVerified:false};
  const sourceId=setupFixture.id,accountId=setupFixture.localAccountId;
  let inventoryCalls=0;
  const client={identity,sourceAccounts:async()=>{inventoryCalls++;return [{...setupFixture}];}};
  const configure=()=>configureAssistantTelegramSource({identity,host,store,client,companyId,sourceId});
  if(!['darwin','win32'].includes(process.platform)){
    const before=resolveCalls;await assert.rejects(configure(),/SETUP_UNAVAILABLE/);assert.equal(resolveCalls,before);return;
  }
  const sourceDir=path.join(directory,'telegram-login-package');await fs.mkdir(sourceDir);
  const marker=path.join(directory,'telegram-login-native-calls');
  await fs.writeFile(path.join(sourceDir,'main.mjs'),`import assert from 'node:assert/strict';import fs from 'node:fs';
    assert.deepEqual(process.argv.slice(2),['login','--account',${JSON.stringify(accountId)},'--qr']);
    assert.equal(JSON.parse(process.env.TRELIO_SKILL_ACCOUNT_JSON).id,${JSON.stringify(accountId)});
    assert.equal(process.env.CODEX_THREAD_ID,undefined);assert.equal(process.env.TRELIO_SECRET_FILE,undefined);
    let input='';for await(const chunk of process.stdin)input+=chunk;assert.equal(input,'');
    fs.appendFileSync(${JSON.stringify(marker)},'1');
    process.stdout.write(JSON.stringify({authorized:true,userId:12345,username:'PRIVATE_USERNAME',qr:'PRIVATE_QR',password:'PRIVATE_FACTOR'}));`);
  artifactId=randomUUID();releaseId=randomUUID();
  packageBytes=await engine.buildAgentSkillPackage({skillId:scope.skillId,runtimeVersion:'2.99.42',sourceDirectory:sourceDir,
    entrypointPath:'main.mjs',interpreter:'node',capabilities:['network','local-session','local-accounts-v1']});
  await prepareAssistantSourceAccount({identity,host,store,client,companyId,sourceId});
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
  const profile=await createAssistantSourceRuntimeProfile({identity,host,store,scope,
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
  await assert.rejects(createAssistantSourceRuntimeProfile({identity,host,store,scope:{...scope,skillId:'email-imap-smtp'},
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
    assert.deepEqual(process.argv.slice(2),['monitor','--limit','100']);
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

// Exercises the production signed loader/catalogue and native child, not an
// injected success function. All paths/accounts/provider output are synthetic.
test('MAX handoff is never login proof; independent short probe rechecks native registration and drops private diagnostics',async t=>{
  const saved={...scope};t.after(()=>{Object.assign(scope,saved);setupFixture=null;resolveOverride=null;});
  scope.skillId='max-web';
  setupFixture={...scope,id:randomUUID(),deviceId,localAccountId:randomUUID(),revision:0,state:'active',
    provisionLocalAccount:true,interactiveSetupAllowed:true,executionVerified:false};
  const sourceId=setupFixture.id,accountId=setupFixture.localAccountId;
  const client={identity,sourceAccounts:async()=>[{...setupFixture}]};
  const input={identity,host,store,client,companyId,sourceId};
  if(!['darwin','win32'].includes(process.platform)){
    const before=resolveCalls;await assert.rejects(configureAssistantMaxSource(input),/SETUP_UNAVAILABLE/);
    await assert.rejects(verifyAssistantMaxSource(input),/SETUP_UNAVAILABLE/);assert.equal(resolveCalls,before);return;
  }
  const sourceDir=path.join(directory,'max-login-package');await fs.mkdir(sourceDir);
  const marker=path.join(directory,'max-login-calls'),output=path.join(directory,'max-login-output');
  await fs.writeFile(path.join(sourceDir,'main.mjs'),`import assert from 'node:assert/strict';import fs from 'node:fs';
    const args=process.argv.slice(2);assert.deepEqual(args,args[0]==='probe'?['probe']:['login','--headed','--hold-ms','540000']);
    assert.equal(JSON.parse(process.env.TRELIO_SKILL_ACCOUNT_JSON).id,${JSON.stringify(accountId)});
    assert.equal(process.env.CODEX_THREAD_ID,undefined);assert.equal(process.env.TRELIO_SECRET_FILE,undefined);
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
  const profile=await createAssistantSourceRuntimeProfile({identity,host,store,scope,
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
  await assert.rejects(createAssistantSourceRuntimeProfile({identity,host,store,scope:{...scope,skillId:'telegram-mtproto'},
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
