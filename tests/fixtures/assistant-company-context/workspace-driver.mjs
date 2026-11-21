/** Native-backend half supplies a synthetic owner-assigned task. This driver
 * replaces only the external model's choices: device binding, observed proof,
 * serial MCP, fresh request/workspace processes, Git/HPKE, heartbeat, checkpoint
 * and acceptance all use the production factories and common command engine.
 * It cannot contact a live origin or use an operator's private store.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {spawn,fork} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {openNativeCompanyScenario} from './native-context.mjs';
import {buildRuntimeSessionProof} from '../../../host-runtime/scripts/trelio-runtime-session.mjs';
import {resolveAssistantCompanyEncryptionDevice} from '../../../host-runtime/scripts/trelio-assistant-private.mjs';
import {assistantTaskStorageDirectory} from '../../../host-runtime/scripts/trelio-assistant-transport.mjs';
import {runAssistantSetupMcp,createForwardingAssistantMcp,createAssistantWorkspaceExecutor,
  requestCurrentAssistantRuntime,runAssistantWorkspaceProcess} from '../../../host-runtime/scripts/trelio-assistant-entry.mjs';

export const createWorkspaceSystemDriver=async configuration=>{
  const root=await fs.realpath(configuration.root),directory=path.join(root,'native-context');
  assert.equal(configuration.nativeBackend,true);assert.equal(process.env.TRELIO_HOST_RUNTIME_VERSION,'0.0.0');
  assert.ok(process.env.NODE_TEST_CONTEXT);
  if(process.platform==='darwin')assert.equal(path.resolve(process.env.TRELIO_WORKSPACE_TEST_KEYCHAIN_PATH??''),path.join(root,'fixture.keychain-db'));
  const native=await openNativeCompanyScenario(configuration);native.host.configurationDirectory=directory;
  const {identity,credential,taskId,companyId}=configuration;
  await native.context(async()=>{
    await native.host.saveIdentity(identity);
    await native.store.put({origin:identity.origin,kind:'device',id:identity.assistantId},
      {assistantId:identity.assistantId,deviceId:identity.deviceId,credential,expiresAt:1});
  });
  // Only the external native chat/observed model is synthetic. The native
  // owner-assignment binding, host claim, schedule, task-pass and registration
  // are real backend operations; no DB lease or accepted Run is fabricated.
  const threadId=randomUUID(),deliveryId=randomUUID(),pair=generateKeyPairSync('ed25519');
  const observation={schemaVersion:1,clientFamily:'codex',modelId:'gpt-6.1-sol',effortLevel:'high',
    evidenceLevel:'local_observed',source:'codex_hook',observedAt:new Date().toISOString()};
  let pass,state;
  await native.context(async()=>{
    const binding=await native.client.task(companyId,taskId);assert.equal(binding.state,'accepted');
    await native.client.claimTaskHost({companyId,taskId,bindingId:binding.id,bindingRevision:binding.revision,provisionId:randomUUID()});
    await native.client.reportSchedule({companyId,taskId,bindingId:binding.id,bindingRevision:binding.revision,
      sequence:0,threadId,cadence:'hourly',timeZone:'UTC',state:'active',nextRunAt:Date.now()+3600000,lastCycleAt:null,lastCompletedAt:null});
    const begun=await native.client.beginTaskPass({companyId,taskId,bindingId:binding.id,bindingRevision:binding.revision,deliveryId,threadId});
    assert.equal(begun.state,'leased');
    pass={schemaVersion:1,assistantId:identity.assistantId,deviceId:identity.deviceId,companyId,taskId,
      passId:begun.passId,deliveryId,threadId,bindingId:binding.id,bindingRevision:binding.revision};
    const registered=await native.client.registerRuntime({companyId,taskId,passId:pass.passId,clientSessionId:threadId,
      observation,publicKeySpki:pair.publicKey.export({type:'spki',format:'der'}).toString('base64url')});
    state={runtimeSessionId:registered.runtimeSessionId,expiresAt:registered.expiresAt,observation,
      privateKeyPkcs8:pair.privateKey.export({type:'pkcs8',format:'der'}).toString('base64url')};
  });
  await native.seed({credential,pass,runtime:{schemaVersion:1,passId:pass.passId,threadId,state}});
  const configFile=path.join(root,'workspace-scenario.json'),loader=path.join(root,'workspace-loader.mjs');
  await fs.writeFile(configFile,JSON.stringify(configuration),{mode:0o600});
  await fs.writeFile(loader,`import fs from 'node:fs/promises';
    import {runAssistantEntry,executeAssistantWorkspacePlan} from ${JSON.stringify(new URL('../../../host-runtime/scripts/trelio-assistant-entry.mjs',import.meta.url).href)};
    import {openNativeCompanyScenario} from ${JSON.stringify(new URL('./native-context.mjs',import.meta.url).href)};
    const config=JSON.parse(await fs.readFile(${JSON.stringify(configFile)},'utf8'));
    const native=await openNativeCompanyScenario(config);native.host.configurationDirectory=${JSON.stringify(directory)};
    const mode=process.argv.at(-1);if(!['request','workspace'].includes(mode))throw Error('SYNTHETIC_MODE_DENIED');
    try{await runAssistantEntry([mode],{executeRequest:native.execute,
      executePlan:async plan=>{
        try{return await executeAssistantWorkspacePlan(plan,{withProfile:native.withProfile});}
        catch(error){
          if(process.env.TRELIO_TEST_ASSISTANT_OBSERVED_BROWSER==='1'&&plan.localAction?.operation==='secret_browser_fill'){
            const output=error?.details?.stderr??error?.message??'';
            const reason=[['private_profile','TRELIO_WORKSPACE_PROFILE_DENIED'],['missing_target','exact --target'],
              ['incorrect_profile','target does not match the protected browser profile'],['native_grant','checkout grant'],
              ['native_context','Browser context'],['changed_after_preflight','изменился после preflight'],
              ['binding_changed','ASSISTANT_WORKSPACE_BINDING_CHANGED'],['client_origin','ASSISTANT_WORKSPACE_ORIGIN_DENIED']]
              .find(([,text])=>output.includes(text))?.[0]??'unclassified';
            const code=/^[A-Z_]{1,100}$/u.test(error.code??'')?error.code:'FIXTURE_BROWSER_EXECUTION_FAILED';
            await fs.appendFile(JSON.parse(await fs.readFile(${JSON.stringify(configFile)},'utf8')).root+'/fixture-diagnostics.jsonl',
              JSON.stringify({operation:'observed_browser_execution_refused',code,reason})+'\\n');
          }
          throw error;
        }
      }});}finally{native.close();}`);
  const children=new Set(),controllers=new Set(),input=new PassThrough(),output=new PassThrough(),responses=[];
  let buffer='',sequence=0;
  const request=(raw,options)=>requestCurrentAssistantRuntime(raw,{...options,environment:process.env,resolveLoader:async()=>loader,
    spawnProcess:(...args)=>{const child=spawn(...args);children.add(child);child.once('close',()=>children.delete(child));return child;}});
  const workspace=await createAssistantWorkspaceExecutor({configDirectory:directory,finishOptions:{waitMs:2},
    runPlan:async(raw,options)=>{
      const controller=new AbortController();controllers.add(controller);
      try{return await runAssistantWorkspaceProcess(raw,{...options,resolveLoader:async()=>loader,
        signal:options?.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal});}
      finally{controllers.delete(controller);}
    }});
  output.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))!==-1){responses.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}});
  const running=runAssistantSetupMcp({input,output,preservePlugin:()=>null,scheduleMaintenance:()=>null,createWorkspace:()=>workspace,
    createMcp:options=>createForwardingAssistantMcp({...options,request,configurationDirectory:directory,createWorkspace:()=>workspace})});
  const send=async(method,params)=>{
    const id=++sequence;input.write(JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})})+'\n');
    const end=Date.now()+180000;
    while(Date.now()<end){const response=responses.find(row=>row.id===id);if(response)return response;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.fail('one original Workspace MCP request did not settle under its ordinary budget');
  };
  await send('initialize');
  const locator={companyId,taskId,passId:pass.passId};
  return {native,pass,locator,
    async openSyntheticLoginForm({value}){
      // Chromium on macOS needs the native login environment to start its
      // extension. Keep the original OS HOME in this separate fixture child,
      // and keep the entire assistant/Keychain/Run stand on its disposable HOME.
      // The child owns only the synthetic profile, never a user's browser.
      assert.ok(path.isAbsolute(process.env.TRELIO_TEST_ASSISTANT_NATIVE_BROWSER_HOME??''));
      const file=fileURLToPath(import.meta.url);
      const child=fork(file,['observed-browser-fixture'],{execArgv:[],
        env:{...process.env,HOME:process.env.TRELIO_TEST_ASSISTANT_NATIVE_BROWSER_HOME},
        stdio:['ignore','ignore','ignore','ipc']});
      let exit;
      const exited=new Promise(resolve=>child.once('exit',(code,signal)=>{
        exit={code,signal};resolve(exit);
      }));
      let busy=false;
      const call=(operation, parameters={})=>new Promise((resolve,reject)=>{
        assert.equal(busy,false);busy=true;
        const finish=error=>{
          clearTimeout(timer);child.removeListener('message',received);child.removeListener('exit',ended);busy=false;
          if(error)reject(error);
        };
        const ended=()=>finish(Error('BROWSER_FIXTURE_EXITED'));
        const received=message=>{
          if(message.operation!==operation)return;
          finish(message.error?Error(message.error):null);
          if(!message.error)resolve(message.result);
        };
        const timer=setTimeout(()=>finish(Error('BROWSER_FIXTURE_TIMEOUT')),60_000);
        child.on('message',received);child.once('exit',ended);
        child.send({operation,parameters},error=>{if(error)finish(error);});
      });
      try{
        const port=await call('open',{value,root,directory,identity,companyId,assistantMemberId:configuration.assistantMemberId,state:{
          runtimeSessionId:state.runtimeSessionId,expiresAt:state.expiresAt,
        }});
        assert.ok(Number.isInteger(port)&&port>0&&port<=65535);
        await fs.writeFile(path.join(root,'synthetic-browser-port'),String(port),{mode:0o600,flag:'wx'});
      }catch(error){child.kill();await exited;throw error;}
      return {observe:()=>call('observe'),valuesReceived:()=>call('values'),async stop(){
        // This child has only IPC, with no output stream to drain. Join its
        // exit after the shutdown reply, and terminate only our owned child
        // if the bounded request failed. Never wait for a second IPC close.
        try{
          await call('stop');
          if(!exit){
            const {once}=await import('node:events');
            if(!exit)await once(child,'exit',{signal:AbortSignal.timeout(10_000)});
          }
        }
        catch(error){if(!exit)child.kill();await exited;throw error;}
        assert.deepEqual(await exited,{code:0,signal:null},'the disposable browser child must exit cleanly');
      }};
    },
    async listTools(){
      const response=await send('tools/list');
      assert.equal(response.error,undefined,JSON.stringify(response.error));
      return response.result.tools;
    },
    managed:()=>native.context(()=>resolveAssistantCompanyEncryptionDevice({identity,companyId,store:native.store,
      lockDirectory:path.join(root,'company-key-locks'),assertCurrent:()=>native.client.readTaskPass(locator)})),
    directory:workspaceId=>path.join(assistantTaskStorageDirectory(directory,{origin:identity.origin,assistantId:identity.assistantId,
      deviceId:identity.deviceId,companyId,taskId}),'workspaces',workspaceId,'workspace'),
    async call(name,args={}){
      await fs.writeFile(path.join(root,'question-system-stage.json'),JSON.stringify({phase:'model_tool',tool:name,
        operation:args.operation??null}),{mode:0o600});
      const dispatch=input=>send('tools/call',{name,arguments:{...input,taskPass:locator,
        runtimeSessionProof:buildRuntimeSessionProof({state,toolName:name})}});
      let result=await dispatch(args);
      if(name==='continue_assistant_workspace_action'&&args.operation==='open'){
        // Real native authorization/proof on each wait. A two-millisecond
        // fixture wait makes the opening cross this boundary on all OSes.
        const deadline=Date.now()+180_000;
        while(result.result?.structuredContent?.state==='running'){
          const {operation,nextCall}=result.result.structuredContent;
          assert.equal(operation,'open');assert.equal(nextCall.tool,name);assert.equal(nextCall.arguments.operation,'status');
          assert.ok(Date.now()<deadline,'original open did not settle');
          await new Promise(resolve=>setTimeout(resolve,20));
          result=await dispatch(nextCall.arguments);
        }
      }
      assert.equal(result.error,undefined,JSON.stringify(result.error));
      if(name==='continue_assistant_workspace_action'&&args.operation==='checkpoint'
        &&args.parameters?.type==='draft'&&result.result?.isError!==true){
        // The intermediate receipt must survive the genuine encrypted native
        // checkpoint, isolated worker and serial model-facing transport.
        const receipt=result.result?.structuredContent?.taskDraftCheckpoint;
        assert.ok(receipt,'the actual native draft must return an immutable locator');
        assert.deepEqual({workspaceId:receipt.workspaceId,runId:receipt.runId},args.runIdentity);
        assert.match(receipt.checkpointId,/^[a-f0-9-]{36}$/u);
        assert.match(receipt.draftHead,/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
      }
      await fs.writeFile(path.join(root,'question-system-stage.json'),JSON.stringify({phase:'tool_settled',tool:name,
        operation:args.operation??null,state:result.result?.structuredContent?.state??null,code:result.result?.structuredContent?.code??null}),{mode:0o600});
      return result.result;
    },
    async close(){
      // Fixture-only abort owns no live job. Stop disposable children before
      // closing their HTTP backend, retaining an assertion failure as failure.
      for(const controller of controllers)controller.abort();
      await workspace.stop();input.end();await running;
      for(const child of children){const closed=new Promise(resolve=>child.once('close',resolve));child.kill();await closed;}
      native.close();
    },
  };
};

const openSyntheticLoginForm=async({value,root,directory,identity,companyId,assistantMemberId,state})=>{
  // The optional browser stand uses a disposable HTTPS form and the
  // actual extension worker. Only provider content is synthetic; the
  // resulting fill still uses the native task pass, real grant and signed
  // request/Workspace processes above. No service URL enters this driver.
  const [{createServer},{createHash,X509Certificate},{execFile},{promisify},
    {ExtensionVisualBrowser},{loadVisualDependencies},{createVisualOriginPolicy},
    {assistantVisualBrowserAccountId,createVisualControlServer,visualSessionBinding},
    {browserExecutionDirectory},{writePrivateJsonFile},{ownFixtureHttpServer}]=await Promise.all([
    import('node:https'),import('node:crypto'),import('node:child_process'),import('node:util'),
    import('../../../host-runtime/scripts/trelio-visual-extension-browser.mjs'),
    import('../../../host-runtime/scripts/trelio-visual-bootstrap.mjs'),
    import('../../../host-runtime/scripts/trelio-visual-browser.mjs'),
    import('../../../host-runtime/scripts/trelio-visual-session.mjs'),
    import('../../../host-runtime/scripts/trelio-browser-session.mjs'),
    import('../../../host-runtime/scripts/trelio-workspace.mjs'),import('../visual-owned-http.mjs'),
  ]);
  const browserDirectory=await fs.mkdtemp(path.join(root,'login-'));
  const keyFile=path.join(browserDirectory,'local.key'),certFile=path.join(browserDirectory,'local.pem');
  await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1',
    '-keyout',keyFile,'-out',certFile],{windowsHide:true,timeout:30_000});
  const [key,cert]=await Promise.all([fs.readFile(keyFile),fs.readFile(certFile)]);
  const testTlsSpki=createHash('sha256').update(new X509Certificate(cert).publicKey.export({type:'spki',format:'der'})).digest('base64');
  const stopSignal=new AbortController(),received=[];
  const form=createServer({key,cert},(request,response)=>{
    response.setHeader('Content-Type','text/html; charset=utf-8');
    if(request.url==='/check'&&request.method==='POST'){
      let body='';request.on('data',part=>{body+=part;});
      request.on('end',()=>{
        received.push(new URLSearchParams(body).get('account')===value);
        response.end('<!doctype html><title>Fixture</title><p>VERIFIED NATIVE FORM</p>');
      });
      return;
    }
    response.end('<!doctype html><title>Fixture</title><form method="post" action="/check"><label>Account <input id="account" name="account" required></label><button id="submit">Continue</button></form>');
  });
  const formListener=ownFixtureHttpServer(form,stopSignal.signal);
  let browser,redirectListener,controlListener;
  const stop=async()=>{
    // Keep the owned form reachable while Chromium closes the selected
    // document and freezes the session. Disposing the listener first can
    // abort that navigation while the extension is taking its final snapshot.
    try{await browser?.close();}
    finally{
      await Promise.all([controlListener?.stop(),redirectListener?.stop(),formListener.stop()]);
    }
  };
  try{
    await formListener.listen();
    const targetOrigin=`https://127.0.0.1:${form.address().port}`;
    const redirect=createServer({key,cert},(_request,response)=>{
      response.writeHead(302,{Location:targetOrigin+'/login?FLOW_STAYS_LOCAL=1'});response.end();
    });
    redirectListener=ownFixtureHttpServer(redirect,stopSignal.signal);await redirectListener.listen();
    const siteOrigin=`https://127.0.0.1:${redirect.address().port}`;
    const deadlineAt=Math.min(Date.now()+120_000,Date.parse(state.expiresAt));
    const dependencies=await loadVisualDependencies({root:fileURLToPath(new URL('../../../host-runtime/scripts/visual-browser-dependencies/',import.meta.url)),install:false});
    // This test is reproducible offline. Seed its separate public engine
    // cache from the same Playwright build before starting native work.
    await fs.access(dependencies.chromium.executablePath());
    browser=new ExtensionVisualBrowser({dependencies,store:{directory:browserDirectory,async read(){},async prepare(){},async write(){},close(){}},
      origins:[siteOrigin],externalNavigation:true,presentation:'hidden',observationMode:'text',lease:{deadlineAt},testTlsSpki,
      policy:createVisualOriginPolicy({origins:[siteOrigin],externalNavigation:true,allowLoopback:true})});
    browser.enableAssistantBrowserSecrets();
    const token=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
    const control=createVisualControlServer({token,dispatch:async()=>assert.fail('no ordinary action through the Secret channel'),
      secretDispatch:message=>browser.secretBrowserCall(message)});
    controlListener=ownFixtureHttpServer(control,stopSignal.signal);await controlListener.listen();
    const memberId=assistantMemberId, runtimeSessionId=state.runtimeSessionId;
    const env={TRELIO_ORIGIN:identity.origin,TRELIO_SKILL_ID:'assistant-browser',
      TRELIO_SKILL_ACCOUNT_JSON:JSON.stringify({id:assistantVisualBrowserAccountId({...identity,companyId},siteOrigin)}),
      TRELIO_SKILL_COMPANY_ID:companyId,TRELIO_SKILL_MEMBER_ID:memberId,TRELIO_SKILL_RUNTIME_SESSION_ID:runtimeSessionId,
      TRELIO_BROWSER_SESSION_POLICY_JSON:JSON.stringify({apiVersion:1,sessionClass:'protected-snapshot',manualAssist:true,leaseMs:120_000}),
      TRELIO_BROWSER_SESSION_STARTED_AT:String(deadlineAt-120_000),TRELIO_BROWSER_SESSION_DEADLINE_AT:String(deadlineAt)};
    const binding=visualSessionBinding(env);
    const active=path.join(browserExecutionDirectory(path.join(directory,'visual-browser',binding.scope),env),'active');
    await fs.mkdir(active,{recursive:true,mode:0o700});
    await writePrivateJsonFile(path.join(active,'owner.json'),{schemaVersion:1,token,pid:process.pid,scope:binding.scope,bindingHash:binding.bindingHash,
      port:control.address().port,deadlineAt,executionOwner:binding.executionOwner,origins:[siteOrigin],presentation:'hidden',
      externalNavigation:true,assistantBrowserSecrets:true,mailIdentity:{origin:identity.origin,companyId,memberId}});
    return {port:control.address().port,received,stop,async observe(){
      const page=await browser.call('navigate',{url:siteOrigin+'/entry'});
      assert.equal(page.state,'ready',page.reason);
      return {siteOrigin,targetOrigin,sessionId:page.sessionId,frameId:page.frameId};
    }};
  }catch(error){await stop().catch(()=>browser?.abort());throw error;}
};

// This entry is only a disposable fixture child. Its public engine and
// auth-free browser profile are separate from the assistant's native stores.
if(process.argv.at(-1)==='observed-browser-fixture'){
  assert.ok(process.send&&process.env.NODE_TEST_CONTEXT&&process.env.TRELIO_QUESTION_SYSTEM_CHILD==='1');
  let browser,active=false;
  process.once('disconnect',()=>{void browser?.stop().catch(()=>{});});
  process.on('message',async({operation,parameters})=>{
    try{
      assert.equal(active,false);active=true;
      let result;
      if(operation==='open'){assert.equal(browser,undefined);browser=await openSyntheticLoginForm(parameters);result=browser.port;}
      else if(operation==='observe')result=await browser.observe();
      else if(operation==='values')result=browser.received;
      else if(operation==='stop'){await browser.stop();browser=null;}
      else throw Error('BROWSER_FIXTURE_ACTION_DENIED');
      process.send({operation,result},error=>{
        if(error)process.exitCode=1;
        if(operation==='stop'&&process.connected)process.disconnect();
      });
    }catch(error){
      const code=error.code??error.message;
      process.send({operation,error:/^[a-z][a-z0-9_]{1,80}$/iu.test(code??'')?code:'BROWSER_FIXTURE_ACTION_FAILED'});
    }finally{active=false;}
  });
}
