/** Public runtime half of the native-backend question system stand.
 * The private backend owns Fastify, PostgreSQL, real ACL and synthetic data.
 * This half owns real private stores, SQLite, factory, serial MCP, request
 * children and encrypted company mirror. Only external Telegram/Codex are
 * deterministic fixtures. The backend consumes this by an explicit source ref.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {openNativeCompanyScenario} from './native-context.mjs';
import {questionProviderPackage} from './question-provider.mjs';
import {openAssistantDatabase,resolveAssistantCompanyEncryptionDevice} from '../../../host-runtime/scripts/trelio-assistant-private.mjs';
import {createAssistantInbox} from '../../../host-runtime/scripts/trelio-assistant-inbox.mjs';
import {buildRuntimeSessionProof} from '../../../host-runtime/scripts/trelio-runtime-session.mjs';
import {readAssistantCodexDelivery} from '../../../host-runtime/scripts/trelio-assistant-codex.mjs';
import {runAssistantSetupMcp,createForwardingAssistantMcp,createAssistantWorkspaceExecutor,
  requestCurrentAssistantRuntime,createAssistantRuntimeHost} from '../../../host-runtime/scripts/trelio-assistant-entry.mjs';

export const createQuestionSystemDriver=async configuration=>{
  const root=await fs.realpath(configuration.root),directory=path.join(root,'native-context');
  // The common helper enables a disposable Keychain ONLY in an unpublished
  // runtime's native test process. Refuse rather than accidentally falling back
  // to the operator's login Keychain when a harness version is misconfigured.
  assert.equal(process.env.TRELIO_HOST_RUNTIME_VERSION,'0.0.0');
  assert.ok(process.env.NODE_TEST_CONTEXT);
  if(process.platform==='darwin')assert.equal(path.resolve(process.env.TRELIO_WORKSPACE_TEST_KEYCHAIN_PATH??''),path.join(root,'fixture.keychain-db'));
  const native=await openNativeCompanyScenario(configuration,{sourcePackage:questionProviderPackage(configuration)});
  native.host.configurationDirectory=directory;
  const {identity,source,credential,ownerIdentityId}=configuration;
  const dbDirectory=path.join(directory,'digital-assistants','runtime',identity.assistantId,identity.deviceId);
  // A recorded, already expired chain is DATA seeded only by the disposable
  // system stand. Timestamp it at initial INSERT rather than rewriting a
  // live lease or changing the native server/proof clock to manufacture expiry.
  let historicalClock=configuration.historicalCancelledReply?Date.now()-40*60000:null;
  const withInbox=async action=>{const opened=await openAssistantDatabase(dbDirectory);
    try{return await action(createAssistantInbox({database:opened.database,now:()=>historicalClock??Date.now()}),opened.database);}finally{await opened.close();}};
  let original=await withInbox(inbox=>{
    const scope={origin:identity.origin,assistantId:identity.assistantId,companyId:source.companyId,
      provider:'telegram',accountId:source.localAccountId,bindingId:source.id};
    inbox.register(scope);inbox.observeExternalSourceRevision(scope,source.revision);
    inbox.commitPage(scope,{...inbox.claimPoll(scope),nextCursor:'synthetic-original',hasMore:false,events:[{
      id:configuration.reference.id,revision:configuration.reference.revision,taskId:null,wake:false,providerWake:true,
      ownerIdentityId,conversationKey:configuration.reference.conversationKey}]});
    const row=inbox.ownerIntakes()[0];inbox.prepareOwnerIntake(row.id);inbox.startOwnerIntakeProvision(row.id);
    inbox.bindOwnerIntakeThread(row.id,randomUUID());inbox.readyOwnerIntake(row.id);
    return inbox.ownerIntake(row.id);
  });
  let pass={schemaVersion:1,kind:'source_intake',assistantId:identity.assistantId,deviceId:identity.deviceId,
    companyId:source.companyId,sourceId:source.id,sourceRevision:source.revision,passId:original.id,
    deliveryId:original.delivery_id,eventId:original.original_event_id,threadId:original.thread_id};
  const keys=generateKeyPairSync('ed25519'),observation={schemaVersion:1,clientFamily:'codex',modelId:'gpt-6.1-sol',
    effortLevel:'high',evidenceLevel:'local_observed',source:'codex_hook',observedAt:new Date().toISOString()};
  let state={runtimeSessionId:randomUUID(),expiresAt:new Date(Date.now()+1800000).toISOString(),observation,
    privateKeyPkcs8:keys.privateKey.export({type:'pkcs8',format:'der'}).toString('base64url')};
  await native.seed({credential,pass,runtime:{schemaVersion:1,passId:pass.passId,threadId:pass.threadId,state}});
  let locator={companyId:source.companyId,sourceId:source.id,intakeId:pass.passId};
  if(!configuration.historicalCancelledReply)await native.context(async()=>{
    const begun=await native.client.beginSourceIntake({...locator,sourceRevision:source.revision,eventId:pass.eventId,
      threadId:pass.threadId,ownerIdentityId,senderExternalUserId:configuration.ownerExternalUserId,
      conversationKey:configuration.reference.conversationKey});
    assert.equal(begun.state,'leased');
    const registered=await native.client.registerIntakeRuntime({...locator,clientSessionId:pass.threadId,observation,
      publicKeySpki:keys.publicKey.export({type:'spki',format:'der'}).toString('base64url')});
    state={...state,runtimeSessionId:registered.runtimeSessionId,expiresAt:registered.expiresAt};
  });
  await native.seed({credential,pass,runtime:{schemaVersion:1,passId:pass.passId,threadId:pass.threadId,state}});
  await withInbox(inbox=>{inbox.rememberIntakePrerequisite(original.id,'a'.repeat(64));inbox.startOwnerIntake(original.id);});
  let historicalRows;
  if(configuration.historicalCancelledReply){
    assert.equal(typeof configuration.seedHistoricalIntakes,'function');
    historicalRows=await withInbox(inbox=>{
      const rootId=original.id,negative=randomUUID();inbox.confirmIntakeModelRead(rootId);
      inbox.startOwnerReplyAbandonment(rootId,negative);inbox.finishOwnerIntake(rootId,{state:'reply_abandoned',receiptId:negative});inbox.settleOwnerIntake(rootId);
      historicalClock++;
      const technical=inbox.retryReadonlyOwnerIntake(rootId,{receiptId:negative,terminalTurnId:randomUUID(),
        previousPrerequisiteKey:'a'.repeat(64),prerequisiteKey:'b'.repeat(64)});
      inbox.startReadonlyIntakeBegin(technical.id);inbox.startOwnerIntake(technical.id);inbox.confirmIntakeModelRead(technical.id);
      const positive=randomUUID();inbox.startOwnerReply(technical.id,positive);inbox.confirmOwnerReply(technical.id,{receiptId:positive,messageId:900});
      inbox.finishOwnerIntake(technical.id,{state:'replied',receiptId:positive});inbox.settleOwnerIntake(technical.id);historicalClock++;
      const cancelled=inbox.retryReadonlyOwnerIntake(technical.id,{receiptId:positive,terminalTurnId:randomUUID(),
        previousPrerequisiteKey:'b'.repeat(64),prerequisiteKey:'c'.repeat(64),technicalReplyCorrection:true});
      inbox.startReadonlyIntakeBegin(cancelled.id);inbox.startOwnerIntake(cancelled.id);inbox.confirmIntakeModelRead(cancelled.id);
      return [rootId,technical.id,cancelled.id].map(id=>inbox.ownerIntake(id));
    });
    // The private fixture applies genuine native SQL transitions and then the
    // ordinary authenticated cancel endpoint. Its positive receipt, not a
    // locally invented outcome, closes this same historical no-send child.
    const cancelled=await configuration.seedHistoricalIntakes({rows:historicalRows,native});
    assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.id,historicalRows.at(-1).id);
    await withInbox(inbox=>{inbox.finishOwnerIntake(cancelled.id,cancelled);inbox.settleOwnerIntake(cancelled.id);});
    historicalRows=await withInbox(inbox=>historicalRows.map(row=>inbox.ownerIntake(row.id)));historicalClock=null;
  }
  const configFile=path.join(root,'question-scenario.json'),loader=path.join(root,'question-loader.mjs');
  const saveConfiguration=()=>fs.writeFile(configFile,JSON.stringify(configuration),{mode:0o600});
  await saveConfiguration();
  await fs.writeFile(loader,`import fs from 'node:fs/promises';
    import {runAssistantEntry} from ${JSON.stringify(new URL('../../../host-runtime/scripts/trelio-assistant-entry.mjs',import.meta.url).href)};
    import {openNativeCompanyScenario} from ${JSON.stringify(new URL('./native-context.mjs',import.meta.url).href)};
    import {questionProviderPackage} from ${JSON.stringify(new URL('./question-provider.mjs',import.meta.url).href)};
    const config=JSON.parse(await fs.readFile(${JSON.stringify(configFile)},'utf8'));
    const native=await openNativeCompanyScenario(config,{sourcePackage:questionProviderPackage(config)});
    native.host.configurationDirectory=${JSON.stringify(directory)};
    try{await runAssistantEntry(['request'],{executeRequest:native.execute});}finally{native.close();}`);
  const children=new Set(),input=new PassThrough(),output=new PassThrough(),responses=[];let buffer='',sequence=0;
  const preparation={started:0,ownedTimeouts:0},preparationByPass=new Map(),modelCalls=[];
  const request=async(raw,options)=>{
    if(['company_context_prepare','company_context_search'].includes(raw.operation)){
      const key=raw.descriptor.intakePass?.intakeId??raw.descriptor.taskPass?.passId;
      assert.ok(key,'the system stand must count actual native passes independently');
      const count=(preparationByPass.get(key)??0)+1;preparationByPass.set(key,count);
      preparation.started++;assert.ok(count<=2,'no third first-sync child for one admitted pass');
    }
    try{
      const result=await requestCurrentAssistantRuntime(raw,{...options,environment:process.env,resolveLoader:async()=>loader,
        spawnProcess:(...args)=>{const child=spawn(...args);children.add(child);child.once('close',()=>children.delete(child));return child;}});
      // A delivered query ends this first-sync episode. Later independent
      // searches retain their own fresh admission and two-child bound.
      if(raw.operation==='company_context_validate'&&result.current===true||raw.operation==='company_context_read')
        preparationByPass.delete(raw.descriptor.intakePass?.intakeId??raw.descriptor.taskPass?.passId);
      return result;
    }
    catch(error){if(['company_context_prepare','company_context_search'].includes(raw.operation)&&error.code==='ASSISTANT_COMPANY_CONTEXT_PREPARATION_TIMED_OUT')preparation.ownedTimeouts++;throw error;}
  };
  const workspace=await createAssistantWorkspaceExecutor({configDirectory:directory,companyPreparationOptions:{waitMs:2}});
  output.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))!==-1){responses.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}});
  const running=runAssistantSetupMcp({input,output,preservePlugin:()=>null,scheduleMaintenance:()=>null,createWorkspace:()=>workspace,
    createMcp:options=>createForwardingAssistantMcp({...options,request,configurationDirectory:directory,createWorkspace:()=>workspace})});
  const send=async(method,params)=>{const id=++sequence;input.write(JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})})+'\n');
    // One external MCP roundtrip can contain several fresh private/native
    // invocations. Use the production ordinary request budget, not one inner
    // private session's 45s as a shorter aggregate fixture deadline.
    const end=Date.now()+180000;while(Date.now()<end){const result=responses.find(row=>row.id===id);if(result)return result;
      await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('the original serial MCP call did not settle');};
  await send('initialize');
  return {native,get original(){return original;},get pass(){return pass;},get locator(){return locator;},withInbox,preparation,
    async managed(){return native.context(()=>resolveAssistantCompanyEncryptionDevice({identity,companyId:source.companyId,
      store:native.store,lockDirectory:path.join(root,'company-key-locks'),assertCurrent:()=>native.client.readSourceIntake(locator)}));},
    async setManagedFingerprint(fingerprint){configuration.managedFingerprint=fingerprint;await saveConfiguration();},
    get historicalRows(){return historicalRows;},
    async recoverTechnicalReply(answer){return this.recoverReadOnlyReply(answer);},
    async recoverCancelledReply(answer){
      assert.ok(historicalRows);
      // Release the OLD retained root only through the actual production host
      // over its positive native terminal receipt. Never remove the slot or
      // flip SQLite settlement bits as a recovery shortcut.
      const host=await createAssistantRuntimeHost({context:native.context,dependencies:{configurationDirectory:directory,
        readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),readStatus:async()=>({structuredContent:{schemaVersion:1,
          assistantUserId:identity.assistantId,deviceId:identity.deviceId,authorizedByUserId:configuration.ownerUserId,businessReady:true,
          availableCapabilities:['task_context','task_mutations','task_pass_outcome','workspace_execution','owner_decisions','background_service']}}),
        native:{provision:async()=>assert.fail('historical settlement must not create a chat'),
          run:async()=>assert.fail('historical settlement must not start a model'),
          readDelivery:async(thread,marker)=>{
            assert.equal(thread,historicalRows[0].thread_id);assert.equal(marker,historicalRows[0].delivery_id);
            return {state:'completed',turnId:randomUUID()};}}}});
      try{await host.coordinator.workOnce();}finally{await host.close();}
      original=historicalRows.at(-1);locator={companyId:source.companyId,sourceId:source.id,intakeId:original.id};
      return this.recoverReadOnlyReply(answer,{continuation:true});
    },
    async recoverReadOnlyReply(answer,{continuation=false}={}){
      const parent=await withInbox(inbox=>inbox.ownerIntake(original.id)),parentPass={...locator};
      assert.equal(parent.state,'complete');assert.equal(parent.outcome_state,continuation?'cancelled':'replied');assert.equal(parent.settled,1);
      assert.equal(await native.context(()=>native.host.readActivePass()),null);
      // The external Codex history is a recorded historical DATA fixture, not
      // a fake backend response. Its successful context/resolve results below
      // came from this very native server. The injected old rate-failure slot
      // exercises the real full-turn decoder; the separate native 241-request
      // RED regression proves the historical security-hook failure itself.
      const argumentsSearch={companySlugs:[configuration.companySlug],queries:['SYNTHETIC_WEEKEND_JOURNEY']};
      const call=(tool,args,result,status='completed')=>({type:'mcpToolCall',server:'trelio-assistant',tool,status,
        arguments:{...args,intakePass:parentPass,runtimeSessionProof:{}},result});
      const contextCall=continuation?call('get_assistant_intake_context',{}, {structuredContent:{schemaVersion:1}}):
        modelCalls.find(item=>item.tool==='get_assistant_intake_context');
      const resolveCall=modelCalls.findLast(item=>item.tool==='resolve_assistant_intake'&&item.result.structuredContent?.state==='replied');
      assert.ok(contextCall&&(continuation||resolveCall));
      const turn={id:randomUUID(),status:'completed',items:[{type:'userMessage',content:[{type:'text',
        text:`TRELIO_ASSISTANT_DELIVERY ${parent.delivery_id}\nSYNTHETIC_ORIGINAL`} ]},contextCall,
        call('search',argumentsSearch,{structuredContent:{schemaVersion:1,state:'preparing',readOnly:true,
          nextCall:{tool:'search',arguments:argumentsSearch}}}),
        call('search',argumentsSearch,{isError:true,structuredContent:{code:continuation?'ASSISTANT_RUNTIME_REQUEST_CANCELLED':'ASSISTANT_TRANSPORT_RATE_LIMITED'}},'failed'),
        ...(continuation?[]:[resolveCall])]};
      const rpc=()=>{
        const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{};let buffered='';
        child.stdin.on('data',chunk=>{buffered+=chunk;let index;
          while((index=buffered.indexOf('\n'))!==-1){const request=JSON.parse(buffered.slice(0,index));buffered=buffered.slice(index+1);
            if(!request.id)continue;
            const result=request.method==='initialize'?{}:request.method==='thread/read'?{thread:{id:parent.thread_id,cwd:root}}:
              (assert.equal(request.method,'thread/turns/list'),assert.equal(request.params.itemsView,'full'),{data:[turn],nextCursor:null});
            queueMicrotask(()=>child.stdout.write(JSON.stringify({id:request.id,result})+'\n'));}});
        return child;
      };
      const historical=await readAssistantCodexDelivery(parent.thread_id,parent.delivery_id,{executable:process.execPath,
        environment:{},spawnProcess:rpc,readOnlyPreparation:parentPass,settledCreationSuccessors:[],
        ...(continuation?{readOnlyContinuation:true}:{technicalReplyCorrection:{receiptId:parent.outcome_receipt,eventId:parent.original_event_id,
          sourceRevision:parent.source_revision,threadId:parent.thread_id}})});
      assert.equal(historical.readOnlyFailure,continuation?'company_context_read_cancelled':'company_context_rate_limited_reply',
        'the real native decoder must certify the complete historical turn');
      await workspace.stop();configuration.replyOrdinal=continuation?1:2;await saveConfiguration();let modelStarts=0;
      // Move only the coordinator's existing injected test clock past its
      // retained five-minute read-only backoff. Native PostgreSQL, runtime
      // proof clocks and every original child/lease deadline stay real. No
      // live clock, journal timestamp or native row is edited by this fixture.
      let offset=Math.max(0,parent.next_check_at-Date.now()+1);
      const openHost=()=>createAssistantRuntimeHost({context:native.context,dependencies:{configurationDirectory:directory,now:()=>Date.now()+offset,
        readHookReadiness:async()=>({fingerprint:(continuation?'d':'b').repeat(64)}),readStatus:async()=>({structuredContent:{schemaVersion:1,
          assistantUserId:identity.assistantId,deviceId:identity.deviceId,authorizedByUserId:configuration.ownerUserId,businessReady:true,
          availableCapabilities:['task_context','task_mutations','task_pass_outcome','workspace_execution','owner_decisions','background_service']}}),
        native:{provision:async()=>assert.fail('one original must keep its existing chat'),
          readDelivery:(thread,marker,options)=>readAssistantCodexDelivery(thread,marker,{...options,executable:process.execPath,
            environment:{},spawnProcess:rpc}),
          run:async(input,options)=>{
            assert.equal(++modelStarts,1);assert.equal(input.threadId,parent.thread_id);
            assert.equal(input.intakeContext.eventId,parent.original_event_id);
            assert.equal(options.replyOnlyRecovery,true);assert.equal(options.technicalReplyCorrection===true,!continuation);
            options.startInvocation();pass=await native.context(()=>native.host.readActivePass());
            original=await withInbox(inbox=>inbox.ownerIntake(pass.passId));locator={companyId:source.companyId,sourceId:source.id,intakeId:pass.passId};
            const pair=generateKeyPairSync('ed25519'),observed={...observation,observedAt:new Date().toISOString()};
            const registered=await native.context(()=>native.client.registerIntakeRuntime({...locator,clientSessionId:pass.threadId,
              observation:observed,publicKeySpki:pair.publicKey.export({type:'spki',format:'der'}).toString('base64url')}));
            state={runtimeSessionId:registered.runtimeSessionId,expiresAt:registered.expiresAt,observation:observed,
              privateKeyPkcs8:pair.privateKey.export({type:'pkcs8',format:'der'}).toString('base64url')};
            await native.seed({credential,pass,runtime:{schemaVersion:1,passId:pass.passId,threadId:pass.threadId,state}});
            await answer();return {state:'completed',threadId:pass.threadId,turnId:randomUUID()};
          }}}});
      let host=await openHost();
      try{await host.coordinator.workOnce().catch(error=>{
        if(!continuation||!configuration.loseContinuationBegin)throw error;
        assert.equal(error.code,'ASSISTANT_TRANSPORT_UNAVAILABLE');
      });}finally{await host.close();}
      if(continuation&&configuration.loseContinuationBegin){
        assert.equal(modelStarts,0,'a lost begin does not invent positive admission');
        assert.deepEqual(native.continuationBeginFaults,{attempts:1,lostCommitted:true});
        const frozen=await withInbox((_inbox,database)=>database.prepare('SELECT id,native_started,readonly_recovery_json FROM assistant_owner_intakes WHERE retry_of_id=?').all(parent.id));
        assert.equal(frozen.length,1);assert.equal(frozen[0].native_started,0);
        assert.equal(JSON.parse(frozen[0].readonly_recovery_json).beginAttempted,true);
        // Reopen the ACTUAL production factory and SQLite connection. Advance
        // only the injected read-only backoff clock, not SQL/proof/lease clocks.
        offset+=300001;host=await openHost();
        try{await host.coordinator.workOnce();}finally{await host.close();}
        assert.deepEqual(native.continuationBeginFaults,{attempts:1,lostCommitted:true},'restart only reads the exact committed child; no second HTTP begin');
      }
      assert.equal(modelStarts,1,'the normal coordinator must reach one fresh model invocation');
      assert.equal(await native.context(()=>native.host.readActivePass()),null);
      return {parent,current:await withInbox(inbox=>inbox.ownerIntake(original.id))};
    },
    async settle({uncertain=false}={}){
      // Restart the actual production host over the SAME SQLite and protected
      // pass. Only the external native turn is synthetic. The coordinator must
      // read the backend's positive receipt before its normal pass release;
      // this helper never edits a completion bit or removes a protected slot.
      const host=await createAssistantRuntimeHost({context:native.context,dependencies:{configurationDirectory:directory,
        native:{provision:async()=>assert.fail('settlement cannot reprovision a chat'),
          run:async()=>assert.fail('settlement cannot start another model turn'),
          readDelivery:async(thread,marker)=>{
            assert.equal(thread,pass.threadId);assert.equal(marker,pass.deliveryId);
            return {state:'completed',threadId:thread,turnId:randomUUID()};}},
        readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),
        readStatus:async()=>({structuredContent:{schemaVersion:1,assistantUserId:identity.assistantId,
          deviceId:identity.deviceId,authorizedByUserId:configuration.ownerUserId,businessReady:true,
          availableCapabilities:['task_context','task_mutations','task_pass_outcome','workspace_execution','owner_decisions','background_service']}})}});
      try{
        if(uncertain)await assert.rejects(host.coordinator.workOnce(),{code:'ASSISTANT_OWNER_REPLY_UNCERTAIN'});
        else await host.coordinator.workOnce();
      }finally{await host.close();}
      const current=await withInbox(inbox=>inbox.ownerIntake(original.id));
      if(uncertain){
        assert.notEqual(current.state,'complete');assert.equal(current.reply_message_id,null);
        assert.equal((await native.context(()=>native.host.readActivePass())).passId,pass.passId);
        return current;
      }
      assert.equal(current.state,'complete');assert.equal(current.outcome_state,'replied');
      assert.equal(await native.context(()=>native.host.readActivePass()),null);
      assert.equal(await native.context(()=>native.store.get({origin:identity.origin,kind:'runtime',id:pass.passId})),null);
      return current;
    },
    async call(name,args={}){
      await fs.writeFile(path.join(root,'question-system-stage.json'),JSON.stringify({phase:'model_tool',tool:name}),{mode:0o600});
      const result=await send('tools/call',{name,arguments:{...args,intakePass:locator,
        runtimeSessionProof:buildRuntimeSessionProof({state,toolName:name})}});
      assert.equal(result.error,undefined,JSON.stringify(result.error));
      modelCalls.push({type:'mcpToolCall',server:'trelio-assistant',tool:name,status:result.result?.isError?'failed':'completed',
        arguments:{...args,intakePass:{...locator},runtimeSessionProof:{}},result:structuredClone(result.result)});
      if(result.result?.isError&&configuration.nativeBackend===true){
        const lines=await fs.readFile(path.join(root,'fixture-diagnostics.jsonl'),'utf8').catch(()=>null);
        if(lines)console.log(lines.trim().split('\n').slice(-12).join('\n'));
      }
      await fs.writeFile(path.join(root,'question-system-stage.json'),JSON.stringify({phase:'tool_settled',tool:name,
        state:result.result?.structuredContent?.state??null,code:result.result?.structuredContent?.code??null}),{mode:0o600});
      return result.result;
    },
    async close(){input.end();await running;for(const child of children){const closed=new Promise(resolve=>child.once('close',resolve));child.kill();await closed;}native.close();},
  };
};
