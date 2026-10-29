import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes,generateKeyPairSync} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PassThrough} from 'node:stream';

// Native private stores are production-supported on Windows/macOS only.
// Linux retains the independent common HPKE/mirror tests; never call a file
// plaintext substitute a native assistant private-store E2E result.
for(const scenario of [
  {name:'cold',files:3000,stallAttempts:0},
  {name:'owned-timeout-resume',files:16,stallAttempts:1},
  {name:'second-timeout-hard',files:16,stallAttempts:2},
  {name:'ordinary-refusal-hard',files:16,stallAttempts:0,refuse:true},
  {name:'unknown-http-hard',files:16,stallAttempts:0,refuse:true,unknownCode:true},
])test(`owner company composition [${scenario.name}]`,{
  skip:!['win32','darwin'].includes(process.platform),
},async t=>{
  if(process.env.TRELIO_COMPANY_E2E_CHILD!=='1'){
    // Keep the synthetic HOME comparable to the real production LOCALAPPDATA.
    // Nesting the managed UUID namespace below the runner's long profile TEMP
    // adds an artificial Win32 mkdtemp limit (CreateDirectory reserves space
    // below MAX_PATH). Reuse the runner-owned short root, as the real managed
    // inspection fixture does; this changes no production path/ACL operation.
    const temporaryBase=process.platform==='win32'&&path.isAbsolute(process.env.RUNNER_TEMP??'')
      ?await fs.realpath(process.env.RUNNER_TEMP):os.tmpdir();
    const root=await fs.realpath(await fs.mkdtemp(path.join(temporaryBase,'oc-')));
    const keychain=path.join(root,'fixture.keychain-db');
    const env={...process.env,HOME:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root,CODEX_HOME:path.join(root,'.codex'),
      TRELIO_COMPANY_E2E_CHILD:'1',TRELIO_HOST_RUNTIME_VERSION:'0.0.0',TRELIO_PLUGIN_VERSION:'0.0.0',
      TRELIO_WORKSPACE_TEST_KEYCHAIN_PATH:keychain};
    // A disposable Keychain is opened by the SAME no-UI Swift helper. The login
    // Keychain and operator entries never participate. The password is a public
    // fixture constant, contains no user secret and is deleted with this root.
    delete env.NODE_TEST_CONTEXT;
    const execute=promisify(execFile);let stage='create_keychain';
    try{
      if(process.platform==='darwin'){
        await execute('/usr/bin/security',['create-keychain','-p','synthetic-fixture-only',keychain]);
        stage='unlock_keychain';await execute('/usr/bin/security',['unlock-keychain','-p','synthetic-fixture-only',keychain]);
      }
      // Fixture generation, actual first-sync and cleanup have separate work;
      // this outer harness is not the original production preparation clock.
      stage='native_child';const result=await execute(process.execPath,['--test','--test-name-pattern',`\\[${scenario.name}\\]`,fileURLToPath(import.meta.url)],{env,timeout:720000,maxBuffer:1024*1024});
      assert.match(result.stdout,/NATIVE_OWNER_COMPANY_CHAIN_EXECUTED/);
      for(const line of result.stdout.split('\n'))if(line.startsWith('{"fixture":'))console.log(line);
    }catch(error){
      // Only synthetic fixture diagnostics. Do not emit a child environment,
      // Keychain values, private-state files or captured production output.
      throw Error(String(error.stdout??'').slice(-10000)||JSON.stringify({stage,exit:error.code,signal:error.signal??null,stderrBytes:Buffer.byteLength(error.stderr??''),categories:[...new Set(String(error.stderr??'').match(/ERR_[A-Z_]+|MODULE_NOT_FOUND|SyntaxError|TypeError|Keychain|keychain|denied|interaction/g)??[])]}));
    }finally{
      if(process.platform==='darwin')await execute('/usr/bin/security',['delete-keychain',keychain]).catch(()=>{});
      await fs.rm(root,{recursive:true,force:true});
    }
    return;
  }
  const {openNativeCompanyScenario}=await import('./fixtures/assistant-company-context/native-context.mjs');
  const {startCompanyScenarioBackend}=await import('./fixtures/assistant-company-context/backend.mjs');
  const {resolveAssistantCompanyEncryptionDevice}=await import('../host-runtime/scripts/trelio-assistant-private.mjs');
  const {buildRuntimeSessionProof}=await import('../host-runtime/scripts/trelio-runtime-session.mjs');
  const {runAssistantSetupMcp,createForwardingAssistantMcp,createAssistantWorkspaceExecutor,requestCurrentAssistantRuntime}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const root=await fs.realpath(process.env.HOME);
  const identity={schemaVersion:1,origin:'https://trelio.ru',assistantId:randomUUID(),deviceId:randomUUID()};
  const pass={schemaVersion:1,kind:'source_intake',...identity,companyId:randomUUID(),sourceId:randomUUID(),sourceRevision:1,
    passId:randomUUID(),deliveryId:randomUUID(),eventId:randomUUID(),threadId:randomUUID()};delete pass.origin;
  const key=generateKeyPairSync('ed25519'),credential='tda_'+randomBytes(32).toString('base64url');
  // Fixed native owner session covers cold preparation. Polls never move this
  // expiry or a worker's own 45s/10min clock; terminal-intake checks stay live.
  const state={runtimeSessionId:randomUUID(),expiresAt:new Date(Date.now()+30*60_000).toISOString(),
    privateKeyPkcs8:key.privateKey.export({type:'pkcs8',format:'der'}).toString('base64url'),
    observation:{schemaVersion:1,clientFamily:'codex',modelId:'gpt-6.1-sol',effortLevel:'high',evidenceLevel:'local_observed',source:'codex_hook'}};
  const backend=await startCompanyScenarioBackend({identity,pass,credential,root,fileCount:scenario.files,
    stallAttempts:scenario.stallAttempts,refuse:scenario.refuse===true,unknownCode:scenario.unknownCode===true,
    runtimePublicKey:key.publicKey.export({type:'spki',format:'pem'})});
  t.after(()=>backend.close());
  const configuration={schema:'trelio.test.company-context/v1',root,server:backend.url,identity,
    caseName:scenario.name};
  const native=await openNativeCompanyScenario(configuration);
  const configFile=path.join(root,'scenario.json'),loader=path.join(root,'loader.mjs');
  await fs.writeFile(configFile,JSON.stringify(configuration),{mode:0o600});
  const fixtureModule=new URL('./fixtures/assistant-company-context/native-context.mjs',import.meta.url).href;
  const entry=new URL('../host-runtime/scripts/trelio-assistant-entry.mjs',import.meta.url).href;
  await fs.writeFile(loader,`import fs from 'node:fs/promises';import {runAssistantEntry} from ${JSON.stringify(entry)};
    import {openNativeCompanyScenario} from ${JSON.stringify(fixtureModule)};
    const scenario=await openNativeCompanyScenario(JSON.parse(await fs.readFile(${JSON.stringify(configFile)},'utf8')));
    try{await runAssistantEntry(['request'],{executeRequest:scenario.execute});}finally{scenario.close();}`);
  let running;const children=new Set(),input=new PassThrough(),output=new PassThrough(),responses=[];let buffer='';
  try{
    await native.seed({credential,pass,runtime:{schemaVersion:1,passId:pass.passId,threadId:pass.threadId,state}});
    const managed=await native.context(()=>resolveAssistantCompanyEncryptionDevice({identity,companyId:pass.companyId,
      store:native.store,lockDirectory:path.join(root,'company-key-locks'),assertCurrent:()=>native.client.readSourceIntake({companyId:pass.companyId,sourceId:pass.sourceId,intakeId:pass.passId})}));
    await backend.setManagedDevice(managed);
    const {resolveMirrorPaths}=await import('../host-runtime/scripts/trelio-local-context.mjs');
    const paths=await native.withProfile(async()=>resolveMirrorPaths({origin:identity.origin,companyId:pass.companyId}),
      {encryptedCompanyContext:backend.descriptor('search')});
    const request=(raw,options)=>requestCurrentAssistantRuntime(raw,{...options,environment:process.env,resolveLoader:async()=>loader,
      spawnProcess:(...args)=>{const child=spawn(...args);children.add(child);child.once('close',()=>children.delete(child));return child;}});
    const directory=path.join(root,'native-context'),workspace=await createAssistantWorkspaceExecutor({configDirectory:directory,companyPreparationOptions:{waitMs:2}});
    output.on('data',chunk=>{buffer+=chunk;for(;;){const end=buffer.indexOf('\n');if(end<0)break;responses.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}});
    running=runAssistantSetupMcp({input,output,preservePlugin:()=>null,scheduleMaintenance:()=>null,createWorkspace:()=>workspace,
      createMcp:options=>createForwardingAssistantMcp({...options,request,configurationDirectory:directory,createWorkspace:()=>workspace})});
    let sequence=0;
    const send=async(method,params)=>{
      const id=++sequence;input.write(JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})})+'\n');
      const limit=Date.now()+45000;while(Date.now()<limit){const value=responses.find(row=>row.id===id);if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}
      assert.fail('Original serial MCP request did not settle');
    };
    await send('initialize');
    const locator={companyId:pass.companyId,sourceId:pass.sourceId,intakeId:pass.passId};
    const call=(name,args)=>send('tools/call',{name,arguments:{...args,intakePass:locator,runtimeSessionProof:buildRuntimeSessionProof({state,toolName:name})}});
    let search,terminal;
    const coldStarted=Date.now();
    for(let poll=0;poll<1200;poll++){
      const result=await call('search',{queries:['weekend']});backend.assertClean();
      if(result.result?.isError){terminal=result.result;break;}
      assert.equal(result.error,undefined);assert.equal(result.result?.isError,undefined,
        JSON.stringify(result.result)+' '+await fs.readFile(path.join(root,'fixture-diagnostics.jsonl'),'utf8').catch(()=>''));
      if(result.result?.structuredContent?.state==='preparing'){await new Promise(resolve=>setTimeout(resolve,25));continue;}
      search=result.result;break;
    }
    backend.assertClean();
    if(scenario.stallAttempts===2||scenario.refuse){
      assert.ok(terminal,'an ordinary refusal/second owned deadline is terminal, never an empty search');
      const code=terminal.structuredContent.code;
      if(scenario.stallAttempts===2)assert.equal(code,'ASSISTANT_COMPANY_CONTEXT_PREPARATION_TIMED_OUT');
      else assert.equal(code,scenario.unknownCode?'ASSISTANT_COMPANY_CONTEXT_TRELIO_BACKEND_HTTP_403':'ASSISTANT_COMPANY_CONTEXT_ACCESS_DENIED');
      assert.doesNotMatch(code,/INVALID_RESPONSE|SETUP_UNAVAILABLE/u);
      assert.doesNotMatch(JSON.stringify(terminal),/SYNTHETIC_PRIVATE_REFUSAL_CANARY|setupRecovery|statusCode/u);
      const builds=backend.counts.builds;
      for(let repeat=0;repeat<2;repeat++){
        const result=await call('search',{queries:['weekend']});
        assert.equal(result.result.structuredContent.code,code);
      }
      assert.equal(backend.counts.builds,builds,'a retained refusal cannot admit a third/new preparation');
      assert.equal(builds,scenario.stallAttempts||1);
      await assert.rejects(fs.lstat(paths.pointer),{code:'ENOENT'},'an incomplete/failed generation is never published');
      console.log('NATIVE_OWNER_COMPANY_CHAIN_EXECUTED');return;
    }
    assert.ok(search,JSON.stringify({reason:'cold_preparation_did_not_complete',
      terminal:terminal?.structuredContent?.code??null,
      diagnostics:await fs.readFile(path.join(root,'fixture-diagnostics.jsonl'),'utf8').catch(()=>null)}));
    assert.equal((await fs.lstat(paths.pointer)).isFile(),true,'READY requires a complete published generation');
    if(scenario.files===3000)assert.ok(backend.counts.ciphertextBytes>142*1024*1024,'cold input retains representative encrypted volume');
    assert.equal(backend.counts.builds,scenario.stallAttempts+1);
    for(let index=0;index<8;index++)assert.equal(backend.fileHits(index),1,'completed exact-head cache survives a bounded failed child');
    console.log(JSON.stringify({fixture:scenario.name,files:scenario.files,elapsedMs:Date.now()-coldStarted,ciphertextBytes:backend.counts.ciphertextBytes}));
    assert.match(JSON.stringify(search),/Synthetic weekend journey/);
    const exact=await call('fetch',{id:`task:synthetic/${backend.projectSlug}/1`});
    backend.assertClean();
    assert.match(JSON.stringify(exact),/OLD_SYNTHETIC_DESCRIPTION/);
    const current=await call('get_task_activity',{companySlug:'synthetic',projectSlug:backend.projectSlug,taskNumber:1});
    backend.assertClean();
    assert.match(JSON.stringify(current),/CURRENT_SYNTHETIC_PLAN/);
    const filesRead=backend.counts.fileReads;
    const second=await call('search',{queries:[`COLD_VOLUME_CANARY_${scenario.files-1}`]});
    assert.match(JSON.stringify(second),new RegExp(`COLD_VOLUME_CANARY_${scenario.files-1}`));
    assert.equal(backend.counts.fileReads,filesRead,'a second question reuses only the COMPLETE accepted-head mirror');
    backend.setMode('recipient_revoked');
    const changed=await call('search',{queries:['weekend']});
    assert.equal(changed.result.isError,true,'a revoked native recipient cannot borrow the complete warm mirror');
    assert.equal(backend.counts.fileReads,filesRead);
    backend.setMode('ready');backend.setClosed(true);
    const closed=await call('fetch',{id:`task:synthetic/${backend.projectSlug}/1`});
    assert.equal(closed.result.isError,true,'a closed original intake cannot borrow the warm mirror');
    backend.assertClean();assert.ok(backend.counts.nativeAdmissions>=3);assert.ok(backend.counts.exact>0);assert.ok(backend.counts.current>0);
    assert.equal(backend.counts.mutations,0);assert.deepEqual(await native.host.readActivePass(),pass);
    console.log('NATIVE_OWNER_COMPANY_CHAIN_EXECUTED');
  }finally{
    input.end();if(running)await running;
    for(const child of children){const closed=new Promise(resolve=>child.once('close',resolve));child.kill();await closed;}
    native.close();
  }
});
