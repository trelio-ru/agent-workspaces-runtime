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
import {spawn} from 'node:child_process';
import {PassThrough} from 'node:stream';
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
      executePlan:plan=>executeAssistantWorkspacePlan(plan,{withProfile:native.withProfile})});}finally{native.close();}`);
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
    managed:()=>native.context(()=>resolveAssistantCompanyEncryptionDevice({identity,companyId,store:native.store,
      lockDirectory:path.join(root,'company-key-locks'),assertCurrent:()=>native.client.readTaskPass(locator)})),
    directory:workspaceId=>path.join(assistantTaskStorageDirectory(directory,{origin:identity.origin,assistantId:identity.assistantId,
      deviceId:identity.deviceId,companyId,taskId}),'workspaces',workspaceId,'workspace'),
    async call(name,args={}){
      await fs.writeFile(path.join(root,'question-system-stage.json'),JSON.stringify({phase:'model_tool',tool:name,
        operation:args.operation??null}),{mode:0o600});
      const result=await send('tools/call',{name,arguments:{...args,taskPass:locator,
        runtimeSessionProof:buildRuntimeSessionProof({state,toolName:name})}});
      assert.equal(result.error,undefined,JSON.stringify(result.error));
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
