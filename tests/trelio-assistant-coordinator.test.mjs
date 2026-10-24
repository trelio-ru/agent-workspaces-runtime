import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAssistantInbox } from '../host-runtime/scripts/trelio-assistant-inbox.mjs';
import { createAssistantCoordinator } from '../host-runtime/scripts/trelio-assistant-coordinator.mjs';
import { createAssistantOutgoingConversationObserver } from '../host-runtime/scripts/trelio-assistant-transport.mjs';

const fixture = (t,{database=new DatabaseSync(':memory:'),ownsDatabase=true}={}) => {
  if(ownsDatabase)t.after(()=>database.close());
  let clock=Date.parse('2026-01-01T09:00:00Z'),cursor=0,starts=0,provisions=0,runs=0,acks=0;
  const assistantId=randomUUID(),deviceId=randomUUID(),companyId=randomUUID(),memberId=randomUUID(),taskId=randomUUID(),bindingId=randomUUID();
  const authority={id:bindingId,taskId,state:'accepted',revision:0};
  const execution={state:'ready',configuration:{modelId:'gpt-6.1-sol',effortLevel:'high',revision:1}};
  const events=[],deliveries=new Map(),notifications=[]; let nativeFailure=false,inventoryFailure=false;
  const businessReceipts=new Map();
  const passes=new Map();let activePass=null;
  const continuation={goalState:'active',cadence:'every_30_minutes',timeZone:'Europe/Moscow'};
  const identity={origin:'https://assistant.test',assistantId,deviceId};
  const client={identity,heartbeat:async()=>({assistantId,deviceId}),
    companies:async()=>{if(inventoryFailure)throw Object.assign(new Error('transport'),{code:'ASSISTANT_TRANSPORT_UNAVAILABLE'});return[{companyId,memberId,execution}];},
    tasks:async()=>({bindings:[{...authority}],nextCursor:null}),task:async()=>({...authority,execution}),
    poll:async(_company,position)=>{
      const start=position===null?0:Number(position); const page=events.slice(start);
      cursor=events.length;return{events:page.map(event=>({...event,bindingId,bindingRevision:authority.revision,taskState:authority.state})),nextCursor:String(cursor),hasMore:false};
    },
    acknowledge:async(_company,values)=>{acks+=values.length;return{acknowledged:values.length};},
    claimTaskHost:async input=>({bindingId:input.bindingId,provisionId:input.provisionId,threadId:null}),
    reportSchedule:async input=>({sequence:input.sequence}),
    beginTaskPass:async input=>{
      if(!passes.has(input.deliveryId)) passes.set(input.deliveryId,{...input,passId:randomUUID(),leaseRevision:0,
        leaseExpiresAt:new Date(clock+1200000).toISOString(),state:'leased',execution:execution.configuration,
        ...(authority.workMode?{workMode:authority.workMode}:{})});
      return passes.get(input.deliveryId);
    },
    readTaskPass:async input=>[...passes.values()].find(pass=>pass.passId===input.passId),
    renewTaskPass:async input=>{
      const pass=[...passes.values()].find(pass=>pass.passId===input.passId);
      assert.equal(pass.leaseRevision,input.expectedLeaseRevision);
      Object.assign(pass,{leaseRevision:pass.leaseRevision+1,leaseExpiresAt:new Date(clock+1200000).toISOString()});return pass;
    },
    readBusinessOutcome:async input=>{
      if(!businessReceipts.has(input.deliveryId)) businessReceipts.set(input.deliveryId,randomUUID());
      if(passes.has(input.deliveryId)) passes.get(input.deliveryId).state='closed';
      return {schemaVersion:1,state:'confirmed',receiptId:businessReceipts.get(input.deliveryId),...input,continuation:{...continuation}};
    },
  };
  const passHost={readActivePass:async()=>activePass,activatePass:async pass=>{
    if(activePass) assert.deepEqual(pass,activePass);activePass=pass;
  },releasePass:async outcome=>{
    assert.equal(outcome.deliveryId,activePass.deliveryId);assert.equal(outcome.threadId,activePass.threadId);activePass=null;
  }};
  const native={ready:async()=>true,readDelivery:async(_thread,deliveryId)=>deliveries.get(deliveryId)??{state:'uncertain'},
    provision:async({deliveryId,execution:choice},options)=>{
      assert.deepEqual(choice,execution.configuration);
      provisions++;options.startInvocation();starts++;const threadId=randomUUID();options.onThreadStarted(threadId);
      const result={state:'completed',threadId,receipt:`codex:${threadId}:${randomUUID()}`};deliveries.set(deliveryId,result);return result;
    },
    run:async({threadId,deliveryId,taskContext,execution:choice},options)=>{
      assert.deepEqual(choice,execution.configuration);
      const {ownerQuestionIds,...task}=taskContext; assert.deepEqual(task,{assistantId,companyId,taskId,
        ...(authority.workMode==='discussion'?{workMode:'discussion'}:{})});
      if(ownerQuestionIds) assert.ok(ownerQuestionIds.every(id=>/^[0-9a-f-]{36}$/u.test(id)));
      runs++;options.startInvocation();starts++;
      const result={state:'completed',receipt:`codex:${threadId}:${randomUUID()}`};deliveries.set(deliveryId,result);
      if(nativeFailure)throw Object.assign(new Error('response lost'),{code:'ASSISTANT_CODEX_DELIVERY_UNCERTAIN'});
      return result;
    },
  };
  const options={database,client,native,passHost,workspaceForTask:async()=>process.cwd(),timeZone:'Europe/Moscow',now:()=>clock,notify:value=>notifications.push(value)};
  const coordinator=createAssistantCoordinator(options);
  return {database,coordinator,options,identity,companyId,memberId,taskId,bindingId,authority,execution,events,deliveries,notifications,continuation,passes,
    activePass:()=>activePass,
    counts:()=>({starts,provisions,runs,acks}),advance:ms=>{clock+=ms;},failNative:value=>{nativeFailure=value;},failInventory:value=>{inventoryFailure=value;}};
};

test('missing model is blocked before events and retains the original mention through a real SQLite reopen until owner configuration',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-model-dispatch-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'inbox.sqlite');let database=new DatabaseSync(file),coordinator;
  const f=fixture(t,{database,ownsDatabase:false});coordinator=f.coordinator;
  const chosen={...f.execution.configuration};f.execution.state='unconfigured';f.execution.configuration=null;
  try{
    let diagnostic=await coordinator.dispatchStatus();
    assert.equal(diagnostic.state,'blocked');assert.deepEqual(diagnostic.reasons,['model_selection_required']);
    assert.equal(diagnostic.pendingEvents,0,'an initialized empty inbox still has an explicit model block');
    const original={id:randomUUID(),revision:'original-mention',taskId:f.taskId,wake:true};f.events.push(original);
    await coordinator.pollOnce();assert.equal(await coordinator.workOnce(),null);
    diagnostic=await coordinator.dispatchStatus();
    assert.equal(diagnostic.state,'blocked');assert.equal(diagnostic.pendingEvents,1);assert.equal(diagnostic.unprovisionedTasks,1);
    assert.deepEqual(f.counts(),{starts:0,provisions:0,runs:0,acks:1});
    const saved={...database.prepare('SELECT event_key,event_id,event_revision,processed FROM assistant_inbox_events').get()};
    assert.equal(saved.event_id,original.id);assert.equal(saved.processed,0);
    await coordinator.close();database.close();database=new DatabaseSync(file);
    coordinator=createAssistantCoordinator({...f.options,database});
    assert.equal((await coordinator.dispatchStatus()).pendingEvents,1,'a new coordinator reads the SAME original durable event');
    f.execution.state='ready';f.execution.configuration=chosen;
    assert.equal((await coordinator.dispatchStatus()).state,'queued','ready permits ordinary work; status itself cannot claim it');
    assert.deepEqual(f.counts(),{starts:0,provisions:0,runs:0,acks:1});
    await coordinator.pollOnce();assert.equal((await coordinator.workOnce()).kind,'provision');
    assert.equal((await coordinator.workOnce()).state,'completed');
    const completed={...database.prepare('SELECT event_key,event_id,event_revision,processed FROM assistant_inbox_events').get()};
    assert.deepEqual(completed,{...saved,processed:1});assert.equal(f.events.length,1,'no replacement mention is required');
    f.advance(300000);await coordinator.pollOnce();
    assert.deepEqual(f.counts(),{starts:2,provisions:1,runs:1,acks:1});
    assert.equal((await coordinator.dispatchStatus()).pendingEvents,0);
  }finally{await coordinator.close();database.close();}
});

test('dispatch diagnostics distinguish policy, missing company configuration and unknown inventory without exporting IDs',async t=>{
  const f=fixture(t);
  try{
    f.execution.state='policy_blocked';
    assert.deepEqual((await f.coordinator.dispatchStatus()).reasons,['model_policy_blocked']);
    f.failInventory(true);const unknown=await f.coordinator.dispatchStatus();
    assert.equal(unknown.state,'unknown');assert.equal(unknown.pendingEvents,null);assert.deepEqual(unknown.reasons,['not_checked']);
    f.failInventory(false);f.options.client.companies=async()=>[];
    const empty=await f.coordinator.dispatchStatus();assert.equal(empty.state,'blocked');assert.deepEqual(empty.reasons,['configuration_required']);
    assert.ok(!JSON.stringify(empty).includes(f.companyId));assert.ok(!JSON.stringify(empty).includes(f.taskId));
  }finally{await f.coordinator.close();}
});

test('dispatch never calls a retained native outcome active or turns unknown references/future timers into queued work',async t=>{
  const f=fixture(t);
  try{
    await f.coordinator.pollOnce();assert.equal((await f.coordinator.dispatchStatus()).state,'queued');
    await f.coordinator.workOnce();
    assert.equal((await f.coordinator.dispatchStatus()).state,'idle','a future cycle alone is not currently queued work');
    const source=f.database.prepare('SELECT source_key FROM assistant_inbox_sources').get().source_key;
    f.database.prepare(`INSERT INTO assistant_inbox_events(event_key,source_key,event_id,event_revision,task_id,wake)
      VALUES(?,?,?,?,NULL,0)`).run(randomUUID(),source,randomUUID(),'unknown');
    assert.equal((await f.coordinator.dispatchStatus()).state,'idle','unrouted unknown refs grant no queued task');
    f.events.push({id:randomUUID(),revision:'mention',taskId:f.taskId,wake:true});f.advance(300000);
    await f.coordinator.pollOnce();f.failNative(true);
    await assert.rejects(f.coordinator.workOnce(),{code:'ASSISTANT_COORDINATOR_DELIVERY_UNCERTAIN'});
    let result=await f.coordinator.dispatchStatus();assert.equal(result.state,'blocked');
    assert.equal(result.uncertainDeliveries,1);assert.deepEqual(result.reasons,['delivery_uncertain']);
    const before={...f.counts()};f.options.client.companies=async()=>[];
    result=await f.coordinator.dispatchStatus();assert.equal(result.state,'blocked');
    assert.equal(result.uncertainDeliveries,1,'removed company inventory cannot erase the global native fence');
    assert.deepEqual(result.reasons,['configuration_required','delivery_uncertain']);assert.deepEqual(f.counts(),before);
  }finally{await f.coordinator.close();}
});

test('the SAME uncertain delivery row retains a closed original claim/preflight/native cause without changing its retry fence',async t=>{
  for(const [stage,code] of [['native_claim','ASSISTANT_SCOPE_REQUIRED'],['native_preflight','ASSISTANT_CODEX_MODEL_UNAVAILABLE'],
    ['native_started','ASSISTANT_CODEX_READ_UNAVAILABLE'],['native_preflight','ASSISTANT_PRIVATE_CANARY_NOT_A_REAL_CODE']]){
    const f=fixture(t);
    if(stage==='native_claim')f.options.client.claimTaskHost=async()=>{throw Object.assign(new Error('PRIVATE RAW CAUSE'),{code});};
    else f.options.native.provision=async(_input,options)=>{
      if(stage==='native_started')options.startInvocation();
      throw Object.assign(new Error('PRIVATE RAW CAUSE'),{code});
    };
    try{
      await f.coordinator.pollOnce();
      await assert.rejects(f.coordinator.workOnce(),{code:'ASSISTANT_COORDINATOR_DELIVERY_UNCERTAIN'});
      const status=await f.coordinator.dispatchStatus(),failure=status.failure;
      assert.deepEqual(failure,{code:code.endsWith('NOT_A_REAL_CODE')?'ASSISTANT_COORDINATOR_UNAVAILABLE':code,stage});
      const saved=f.database.prepare('SELECT state,native_started,failure_code,failure_stage FROM assistant_inbox_deliveries').get();
      assert.equal(saved.state,'uncertain');assert.equal(saved.native_started,stage==='native_started'?1:0);
      assert.equal(saved.failure_code,failure.code);assert.equal(saved.failure_stage,stage);
      const before={...saved};await f.coordinator.dispatchStatus();
      assert.deepEqual({...f.database.prepare('SELECT state,native_started,failure_code,failure_stage FROM assistant_inbox_deliveries').get()},before);
      assert.ok(!JSON.stringify(status).includes('PRIVATE'));assert.equal(f.counts().starts,0);
    }finally{await f.coordinator.close();}
  }
});

test('real SQLite coordinator provisions one chat and wakes only on a mention or due cycle', async t=>{
  const f=fixture(t);await f.coordinator.pollOnce();
  assert.equal((await f.coordinator.workOnce()).kind,'provision');
  const threadId=f.coordinator.status()[0].threadId;
  assert.equal(await f.coordinator.workOnce(),null);
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:false});f.advance(300000);
  await f.coordinator.pollOnce();assert.equal(await f.coordinator.workOnce(),null);
  assert.equal(f.counts().acks,1);assert.equal(f.counts().runs,0);
  f.events.push({id:randomUUID(),revision:'2',taskId:f.taskId,wake:true});f.advance(300000);
  await f.coordinator.pollOnce();assert.equal((await f.coordinator.workOnce()).state,'completed');
  assert.equal(f.coordinator.status()[0].threadId,threadId);
  assert.equal(f.coordinator.status()[0].lastCycleAt,null);
  f.advance(30*60000);await f.coordinator.pollOnce();await f.coordinator.workOnce();
  assert.ok(f.coordinator.status()[0].lastCycleAt);assert.equal(f.counts().provisions,1);assert.equal(f.counts().runs,2);
  assert.equal(await f.coordinator.workOnce(),null);
});

test('a mention-only discussion uses the permanent chat without enabling a timer, including across restart',async t=>{
  const f=fixture(t),reports=[],observed=[];
  f.authority.workMode='discussion';f.continuation.goalState='completed';
  f.options.client.reportSchedule=async input=>{reports.push(input);return {sequence:input.sequence};};
  const run=f.options.native.run;
  f.options.native.run=async(input,options)=>{observed.push(input);return run(input,options);};
  f.events.push({id:randomUUID(),revision:'mention-1',taskId:f.taskId,wake:true});
  await f.coordinator.pollOnce();assert.equal((await f.coordinator.workOnce()).kind,'provision');
  const initial=f.coordinator.status()[0],threadId=initial.threadId;
  assert.equal(initial.state,'paused');assert.equal(initial.nextRunAt,null);
  assert.equal((await f.coordinator.workOnce()).state,'completed','first queued mention runs despite the paused timer');
  assert.equal(observed[0].taskContext.workMode,'discussion');assert.equal(f.activePass(),null);
  assert.equal(f.coordinator.status()[0].state,'done');assert.equal(f.coordinator.status()[0].nextRunAt,null);
  await f.coordinator.close();const restarted=createAssistantCoordinator(f.options);
  f.advance(24*60*60000);
  await restarted.pollOnce();assert.equal(await restarted.workOnce(),null,'restart and elapsed time cannot invent discussion work');
  f.events.push({id:randomUUID(),revision:'ordinary-comment',taskId:f.taskId,wake:false});f.advance(300000);
  await restarted.pollOnce();assert.equal(await restarted.workOnce(),null);
  f.events.push({id:randomUUID(),revision:'mention-2',taskId:f.taskId,wake:true});f.advance(300000);
  await restarted.pollOnce();assert.equal((await restarted.workOnce()).state,'completed');
  assert.equal(restarted.status()[0].threadId,threadId);assert.equal(restarted.status()[0].nextRunAt,null);
  assert.deepEqual(f.counts(),{starts:3,provisions:1,runs:2,acks:3});
  assert.ok(reports.length>0);assert.ok(reports.every(report=>report.state!=='active'&&report.nextRunAt===null),
    'no transient active schedule is reported before or after the first reply');
  await restarted.close();
});

test('an ordinary native poll cannot turn an existing paused discussion into a recurring timer',async t=>{
  const f=fixture(t),reports=[];f.authority.workMode='discussion';
  f.options.client.reportSchedule=async report=>{reports.push(report);return {sequence:report.sequence};};
  try{
    await f.coordinator.pollOnce();assert.equal((await f.coordinator.workOnce()).kind,'provision');
    assert.equal(f.coordinator.status()[0].state,'paused');
    f.events.push({id:randomUUID(),revision:'ordinary-before-reply',taskId:f.taskId,wake:false,workMode:'discussion'});
    f.advance(300000);await f.coordinator.pollOnce();
    assert.equal(f.coordinator.status()[0].state,'paused');assert.equal(f.coordinator.status()[0].nextRunAt,null);
    assert.equal(await f.coordinator.workOnce(),null,'ordinary discussion notifications cannot invent periodic work');
    assert.ok(reports.every(report=>report.state!=='active'&&report.nextRunAt===null));
    assert.equal(f.counts().runs,0);
  }finally{await f.coordinator.close();}
});

test('the next wake uses the company owner choice in the same permanent chat', async t=>{
  const f=fixture(t);await f.coordinator.pollOnce();await f.coordinator.workOnce();
  const threadId=f.coordinator.status()[0].threadId;
  f.execution.configuration={...f.execution.configuration,effortLevel:'max',revision:2};
  const observed=[];const run=f.options.native.run;
  f.options.native.run=async(input,options)=>{observed.push(input);return run(input,options);};
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:true});f.advance(300000);
  await f.coordinator.pollOnce();await f.coordinator.workOnce();
  assert.equal(observed.length,1);assert.equal(observed[0].threadId,threadId);
  assert.deepEqual(observed[0].execution,f.execution.configuration);
  assert.equal(f.counts().provisions,1);
});

test('a company policy block preserves its queued mention while another company provisions and works', async t=>{
  const f=fixture(t), companyB=randomUUID(),memberB=randomUUID(),taskB=randomUUID(),bindingB=randomUUID();
  const second={id:bindingB,taskId:taskB,state:'accepted',revision:0};
  const executionB={state:'ready',configuration:{...f.execution.configuration}};
  const eventsB=[];
  f.options.client.companies=async()=>[{companyId:f.companyId,memberId:f.memberId},{companyId:companyB,memberId:memberB}];
  f.options.client.tasks=async companyId=>({bindings:[companyId===companyB?second:f.authority],nextCursor:null});
  f.options.client.task=async companyId=>({...(companyId===companyB?second:f.authority),
    execution:companyId===companyB?executionB:f.execution});
  f.options.client.poll=async(companyId,position)=>{
    const events=companyId===companyB?eventsB:f.events, authority=companyId===companyB?second:f.authority;
    return {events:events.slice(Number(position??0)).map(event=>({...event,bindingId:authority.id,bindingRevision:0,taskState:'accepted'})),
      nextCursor:String(events.length),hasMore:false};
  };
  f.execution.state='policy_blocked';
  await f.coordinator.pollOnce();assert.equal((await f.coordinator.workOnce()).kind,'provision');
  assert.equal(f.coordinator.status().length,1);assert.equal(f.coordinator.status()[0].companyId,companyB);
  assert.equal(f.counts().provisions,1);
  f.execution.state='ready';await f.coordinator.workOnce();
  assert.equal(f.counts().provisions,2);
  f.execution.state='policy_blocked';
  // Commit A first so its oldest queued mention really is the head candidate.
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:true});f.advance(300000);await f.coordinator.pollOnce();
  eventsB.push({id:randomUUID(),revision:'1',taskId:taskB,wake:true});f.advance(300000);await f.coordinator.pollOnce();
  let runs=0;
  f.options.native.run=async(input,options)=>{
    assert.equal(input.taskContext.companyId,companyB);assert.equal(input.taskContext.taskId,taskB);
    assert.deepEqual(input.execution,executionB.configuration);runs++;options.startInvocation();
    const result={state:'completed',receipt:`codex:${input.threadId}:${randomUUID()}`};f.deliveries.set(input.deliveryId,result);return result;
  };
  assert.equal((await f.coordinator.workOnce()).state,'completed');assert.equal(runs,1);
  const events=f.database.prepare('select task_id,processed from assistant_inbox_events').all();
  assert.equal(events.find(row=>row.task_id===f.taskId).processed,0);
  assert.equal(events.find(row=>row.task_id===taskB).processed,1);
  assert.equal(f.coordinator.status().find(row=>row.companyId===f.companyId).lastCompletedAt,null);
  const unchanged=f.coordinator.status().find(row=>row.companyId===f.companyId).nextRunAt;
  f.advance(30*60000);
  assert.equal((await f.coordinator.workOnce()).state,'completed');assert.equal(runs,2);
  assert.equal(f.coordinator.status().find(row=>row.companyId===f.companyId).nextRunAt,unchanged);
  assert.ok(f.coordinator.status().find(row=>row.companyId===companyB).lastCycleAt);
});

test('a completed native turn cannot acknowledge work without an exact durable business outcome', async t=>{
  const f=fixture(t);await f.coordinator.pollOnce();await f.coordinator.workOnce();
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:true});f.advance(300000);await f.coordinator.pollOnce();
  const confirmed=f.options.client.readBusinessOutcome;
  f.options.client.readBusinessOutcome=async input=>({...await confirmed(input),companyId:randomUUID()});
  await assert.rejects(f.coordinator.workOnce(),/UNCERTAIN/);
  assert.equal(f.counts().runs,1);
  assert.equal(f.database.prepare('SELECT processed FROM assistant_inbox_events').get().processed,0);
  await assert.rejects(f.coordinator.workOnce(),/BUSINESS_OUTCOME_REQUIRED/);
  assert.equal(f.counts().runs,1,'reconciliation does not replay a completed native invocation');
  f.options.client.readBusinessOutcome=confirmed;
  assert.equal(await f.coordinator.workOnce(),null);
  assert.equal(f.database.prepare('SELECT processed FROM assistant_inbox_events').get().processed,1);
  const receipt=f.database.prepare("SELECT external_receipt FROM assistant_inbox_deliveries WHERE kind<>'provision'").get().external_receipt;
  assert.match(receipt,/^assistant:[0-9a-f-]{36}:codex:/u);
});

test('missing business adapter blocks native work instead of silently accepting a native receipt', async t=>{
  const f=fixture(t);await f.coordinator.pollOnce();await f.coordinator.workOnce();
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:true});f.advance(300000);await f.coordinator.pollOnce();
  delete f.options.client.readBusinessOutcome;
  await assert.rejects(f.coordinator.workOnce(),/SETUP_REQUIRED/);
  assert.equal(f.counts().runs,0);
  assert.equal(f.database.prepare('SELECT processed FROM assistant_inbox_events').get().processed,0);
});

test('accepted continuation changes the recurring cadence and a completed goal stays stopped through rediscovery', async t=>{
  const f=fixture(t);await f.coordinator.pollOnce();await f.coordinator.workOnce();
  const thread=f.coordinator.status()[0].threadId;
  f.continuation.cadence='daily';f.continuation.goalState='waiting_external';
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:true});f.advance(300000);
  await f.coordinator.pollOnce();await f.coordinator.workOnce();
  let plan=f.coordinator.status()[0];assert.equal(plan.cadence,'daily');
  assert.equal(plan.nextRunAt-plan.lastCompletedAt,86400000);
  f.continuation.goalState='completed';
  f.events.push({id:randomUUID(),revision:'2',taskId:f.taskId,wake:true});f.advance(300000);
  await f.coordinator.pollOnce();await f.coordinator.workOnce();
  assert.equal(f.coordinator.status()[0].state,'done');assert.equal(f.coordinator.status()[0].nextRunAt,null);
  f.advance(40*86400000);await f.coordinator.pollOnce();assert.equal(await f.coordinator.workOnce(),null);
  assert.equal(f.coordinator.status()[0].state,'done','accepted task inventory alone cannot revive a completed personal goal');
  f.continuation.goalState='active';
  f.events.push({id:randomUUID(),revision:'3',taskId:f.taskId,wake:true});f.advance(300000);
  await f.coordinator.pollOnce();await f.coordinator.workOnce();
  plan=f.coordinator.status()[0];assert.equal(plan.state,'active');assert.equal(plan.threadId,thread);assert.equal(f.counts().provisions,1);
});

test('crash after SQLite completion but before protected journal release recovers without another launch', async t=>{
  const f=fixture(t);await f.coordinator.pollOnce();await f.coordinator.workOnce();
  const release=f.options.passHost.releasePass;let crash=true;
  f.options.passHost.releasePass=async receipt=>{if(crash){crash=false;throw new Error('synthetic journal release lost');}return release(receipt);};
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:true});f.advance(300000);await f.coordinator.pollOnce();
  await assert.rejects(f.coordinator.workOnce(),/UNCERTAIN/);
  assert.equal(f.database.prepare('select processed from assistant_inbox_events').get().processed,1);
  assert.ok(f.activePass());assert.equal(f.counts().runs,1);
  await f.coordinator.close();
  const next=createAssistantCoordinator(f.options);
  assert.equal(await next.workOnce(),null);assert.equal(f.activePass(),null);assert.equal(f.counts().runs,1);await next.close();
});

test('lost server pass-claim response repeats only that exact claim before the durable native-start boundary', async t=>{
  const f=fixture(t);await f.coordinator.pollOnce();await f.coordinator.workOnce();
  const begin=f.options.client.beginTaskPass;let lost=true;
  f.options.client.beginTaskPass=async input=>{const result=await begin(input);if(lost){lost=false;throw new Error('synthetic lost response');}return result;};
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:true});f.advance(300000);await f.coordinator.pollOnce();
  await assert.rejects(f.coordinator.workOnce(),/UNCERTAIN/);
  assert.equal(f.counts().runs,0);assert.equal(f.passes.size,1);
  const passId=[...f.passes.values()][0].passId;
  assert.equal(await f.coordinator.workOnce(),null);
  assert.equal(f.counts().runs,1);assert.equal(f.passes.size,1);assert.equal([...f.passes.values()][0].passId,passId);
});

test('a SQLite failure rolls back accepted continuation and inbox processing together; recovery does not rerun Codex', async t=>{
  const f=fixture(t);await f.coordinator.pollOnce();await f.coordinator.workOnce();
  f.continuation.cadence='weekly';
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:true});f.advance(300000);await f.coordinator.pollOnce();
  const before=f.coordinator.status()[0];
  f.database.exec("CREATE TRIGGER synthetic_completion_failure BEFORE UPDATE OF processed ON assistant_inbox_events WHEN NEW.processed=1 BEGIN SELECT RAISE(ABORT,'synthetic crash'); END");
  await assert.rejects(f.coordinator.workOnce(),/UNCERTAIN/);
  assert.deepEqual(f.coordinator.status()[0],before);
  assert.equal(f.database.prepare('SELECT processed FROM assistant_inbox_events').get().processed,0);assert.ok(f.activePass());
  f.database.exec('DROP TRIGGER synthetic_completion_failure');
  assert.equal(await f.coordinator.workOnce(),null);
  assert.equal(f.counts().runs,1);assert.equal(f.coordinator.status()[0].cadence,'weekly');assert.equal(f.activePass(),null);
});

test('a task completed by its own pass can reconcile the original receipt but cannot launch another pass', async t=>{
  const f=fixture(t);await f.coordinator.pollOnce();await f.coordinator.workOnce();
  const run=f.options.native.run;
  f.options.native.run=async(...args)=>{const result=await run(...args);f.authority.state='done';f.authority.revision++;return result;};
  f.continuation.goalState='completed';
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:true});f.advance(300000);await f.coordinator.pollOnce();
  assert.equal((await f.coordinator.workOnce()).state,'completed');assert.equal(f.activePass(),null);
  assert.equal(f.coordinator.status()[0].state,'done');assert.equal(f.counts().runs,1);
  f.advance(86400000);await f.coordinator.pollOnce();assert.equal(await f.coordinator.workOnce(),null);
});

test('long native work renews the same backend pass by CAS while retaining the protected hook identity', async t=>{
  const f=fixture(t);await f.coordinator.pollOnce();await f.coordinator.workOnce();await f.coordinator.close();
  const begin=f.options.client.beginTaskPass;
  f.options.client.beginTaskPass=async input=>{
    const pass=await begin(input);pass.leaseExpiresAt=new Date(Date.parse(pass.leaseExpiresAt)-1140000).toISOString();return pass;
  };
  const run=f.options.native.run;
  f.options.native.run=async(input,options)=>{
    const active=f.activePass();assert.equal(active.deliveryId,input.deliveryId);assert.equal(active.threadId,input.threadId);
    const result=await run(input,options);
    await new Promise(resolve=>setTimeout(resolve,280));return result;
  };
  const next=createAssistantCoordinator({...f.options,watchIntervalMs:100});
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:true});f.advance(300000);await next.pollOnce();
  assert.equal((await next.workOnce()).state,'completed');
  assert.equal([...f.passes.values()][0].leaseRevision,1);assert.equal(f.counts().runs,1);assert.equal(f.activePass(),null);
  await next.close();
});

test('revocation after the native turn ends still prevents business acknowledgement', async t=>{
  const f=fixture(t);await f.coordinator.pollOnce();await f.coordinator.workOnce();
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:true});f.advance(300000);await f.coordinator.pollOnce();
  const run=f.options.native.run;
  f.options.native.run=async(...args)=>{const result=await run(...args);f.authority.state='paused';f.authority.revision++;return result;};
  await assert.rejects(f.coordinator.workOnce(),/UNCERTAIN/);
  assert.equal(f.database.prepare('SELECT processed FROM assistant_inbox_events').get().processed,0);
  await assert.rejects(f.coordinator.workOnce(),/TASK_STOPPED/);
  assert.equal(f.counts().runs,1);
});

test('a pending owner decision prevents provisioning, delivery and read acknowledgement', async t=>{
  const f=fixture(t);f.authority.state='waiting_owner';
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:true});
  await f.coordinator.pollOnce();assert.equal(await f.coordinator.workOnce(),null);
  assert.deepEqual(f.counts(),{starts:0,provisions:0,runs:0,acks:0});
  f.authority.state='accepted';f.authority.revision++;f.advance(300000);
  await f.coordinator.pollOnce();await f.coordinator.workOnce();await f.coordinator.workOnce();
  assert.equal(f.counts().runs,1);assert.equal(f.counts().provisions,1);
});

test('a lost native response is reconciled in the same chat after host restart, never replayed', async t=>{
  const f=fixture(t);await f.coordinator.pollOnce();await f.coordinator.workOnce();
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:true});f.advance(300000);await f.coordinator.pollOnce();
  f.failNative(true);await assert.rejects(f.coordinator.workOnce(),/UNCERTAIN/);
  assert.equal(f.counts().runs,1);const original=f.coordinator.status()[0].threadId;
  f.coordinator.close();const restarted=createAssistantCoordinator(f.options);
  await restarted.pollOnce();assert.equal(await restarted.workOnce(),null);
  assert.equal(f.counts().runs,1);assert.equal(restarted.status()[0].threadId,original);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM assistant_inbox_events WHERE processed=1").get().n,1);
});

test('an unknown native provision blocks duplicate chats even when the ID response was lost', async t=>{
  const f=fixture(t);f.options.native.provision=async(_input,options)=>{options.startInvocation();throw new Error('lost first ID');};
  await f.coordinator.pollOnce();await assert.rejects(f.coordinator.workOnce(),/DELIVERY_UNCERTAIN/);
  assert.equal((await f.coordinator.workOnce()).state,'blocked');
  assert.equal(f.coordinator.status().length,0);
  assert.ok(f.notifications.some(value=>value.code==='ASSISTANT_COORDINATOR_PROVISION_REVIEW_REQUIRED'));
});

test('concurrent coordinator instances cannot both start; failed inventory is not a company removal', async t=>{
  const f=fixture(t);await f.coordinator.pollOnce();await f.coordinator.workOnce();
  const second=createAssistantCoordinator(f.options);await assert.rejects(second.pollOnce(),/COORDINATOR_BUSY/);
  f.failInventory(true);f.advance(300000);await assert.rejects(f.coordinator.pollOnce(),/TRANSPORT_UNAVAILABLE/);
  assert.equal(f.coordinator.status()[0].state,'active');
  assert.equal(f.database.prepare('SELECT state FROM assistant_inbox_sources').get().state,'active');
  f.failInventory(false);f.authority.state='done';f.authority.revision++;
  await f.coordinator.pollOnce();assert.equal(f.coordinator.status()[0].state,'done');
  f.advance(40*24*3600000);assert.equal(await f.coordinator.workOnce(),null);
});

test('live revocation before native invocation stops the task without consuming its event', async t=>{
  const f=fixture(t);await f.coordinator.pollOnce();await f.coordinator.workOnce();
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:true});f.advance(300000);await f.coordinator.pollOnce();
  f.authority.state='revoked';f.authority.revision++;
  await assert.rejects(f.coordinator.workOnce(),/ACCESS_DENIED/);
  assert.equal(f.counts().runs,0);assert.equal(f.coordinator.status()[0].state,'revoked');
  assert.equal(f.database.prepare('SELECT processed FROM assistant_inbox_events').get().processed,0);
});

test('an ambiguous server host claim resumes the same durable provision before the native-start boundary', async t=>{
  const f=fixture(t);const attempts=[];
  f.options.client.claimTaskHost=async input=>{
    attempts.push(input.provisionId);
    if(attempts.length===1) throw new Error('claim response lost');
    return{bindingId:input.bindingId,provisionId:input.provisionId,threadId:null};
  };
  await f.coordinator.pollOnce();await assert.rejects(f.coordinator.workOnce(),/UNCERTAIN/);
  assert.equal(f.counts().provisions,0);
  const row=f.database.prepare('SELECT native_started,state FROM assistant_inbox_deliveries').get();
  assert.equal(row.native_started,0);assert.equal(row.state,'uncertain');
  await f.coordinator.close();const restarted=createAssistantCoordinator(f.options);
  await restarted.pollOnce();await restarted.workOnce();
  assert.equal(attempts.length,2);assert.equal(attempts[0],attempts[1]);assert.equal(f.counts().provisions,1);
  assert.equal(restarted.status().length,1);
});

test('another valid device host blocks native business work even with an accepted task binding', async t=>{
  const f=fixture(t);await f.coordinator.pollOnce();await f.coordinator.workOnce();
  f.options.client.task=async()=>({...f.authority,hostState:'other_device'});
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:true});f.advance(300000);await f.coordinator.pollOnce();
  await assert.rejects(f.coordinator.workOnce(),/HOST_REVIEW_REQUIRED/);assert.equal(f.counts().runs,0);
});


test('owner answer refs wake the existing chat and survive a lost pre-launch claim without copying answer text', async t => {
  const f=fixture(t); await f.coordinator.pollOnce(); await f.coordinator.workOnce();
  const threadId=f.coordinator.status()[0].threadId, questionId=randomUUID(), contexts=[];
  const run=f.options.native.run;
  f.options.native.run=async(input,options)=>{contexts.push(input.taskContext);return run(input,options);};
  const begin=f.options.client.beginTaskPass; let claims=0;
  f.options.client.beginTaskPass=async input=>{const result=await begin(input);if(++claims===1)throw new Error('lost');return result;};
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:true,ownerQuestionId:questionId});
  f.advance(300000);await f.coordinator.pollOnce();
  await assert.rejects(f.coordinator.workOnce(),/DELIVERY_UNCERTAIN/);
  f.advance(90001); // The departed host retains its short lease until expiry.
  const restarted=createAssistantCoordinator(f.options);await restarted.workOnce();
  assert.equal(contexts.length,1);assert.deepEqual(contexts[0].ownerQuestionIds,[questionId]);
  assert.equal(restarted.status()[0].threadId,threadId);assert.equal(f.counts().provisions,1);
  f.advance(300000);await restarted.pollOnce();assert.equal(await restarted.workOnce(),null);
  assert.equal(f.counts().runs,1);
});

test('Trelio inventory and notification ACK do not revoke or poll external provider rows',async t=>{
  const f=fixture(t),inbox=createAssistantInbox({database:f.database});
  const external=[];
  for(const provider of ['telegram','email','max']){
    const scope={origin:f.identity.origin,assistantId:f.identity.assistantId,companyId:f.companyId,
      provider,accountId:randomUUID(),bindingId:randomUUID()};
    inbox.register(scope);external.push(scope);
  }
  // Any accidental call with an external cursor is a real test failure, not a
  // permissive mock that returns an empty notification page for every provider.
  const poll=f.options.client.poll;let polls=0;
  f.options.client.poll=async(...args)=>{polls++;assert.equal(args[1],null);return poll(...args);};
  await f.coordinator.pollOnce();
  assert.equal(polls,1);assert.equal(f.counts().acks,0);
  for(const source of external){
    const status=inbox.status(source);assert.equal(status.state,'active');assert.equal(status.cursorRevision,0);
    assert.equal(status.nextPollAt,0,'independent poller retains its own clock');
  }
  // Removing this company from Trelio inventory revokes only its Trelio source.
  f.options.client.companies=async()=>[];f.advance(300000);await f.coordinator.pollOnce();
  for(const source of external)assert.equal(inbox.status(source).state,'active');
});

// The real coordinator and SQLite are used here. Provider I/O is the same
// trusted injected boundary as the native notification client above; synthetic
// private text is a canary that must never become queue data or a task wake.
const externalFixture=async (t,{sourceHealth=null,acknowledgeSource=null}={})=>{
  const f=fixture(t);await f.coordinator.close();
  const row={id:randomUUID(),companyId:f.companyId,deviceId:f.identity.deviceId,localAccountId:randomUUID(),projectId:null,
    skillId:'telegram-mtproto',state:'active',revision:0,executionVerified:false};
  let rows=[row],inventoryFailure=false,read=async source=>({schemaVersion:1,baselineOnly:source.cursor===null,
    events:[],nextCursor:'baseline',hasMore:false,channelsToSync:[],unresolvedDeletionIds:[],
    ...(source.skillId==='email-imap-smtp'&&source.initialUnread?
      source.cursor===null?{initialUnreadCursor:'email-initial-seed'}:{initialUnreadBackfill:true}:{})}),reads=0;
  f.options.client.sourceAccounts=async companyId=>{
    assert.equal(companyId,f.companyId);
    if(inventoryFailure)throw Object.assign(new Error('PRIVATE_SOURCE_ERROR'),{code:'ASSISTANT_SOURCE_UNAVAILABLE'});
    return structuredClone(rows);
  };
  const options={...f.options,sourceHealth,acknowledgeSource,readSourceMonitor:async(source,signal)=>{reads++;return read(source,signal);}};
  let coordinator=createAssistantCoordinator(options);
  const inbox=createAssistantInbox({database:f.database,now:f.options.now});
  const scope=()=>({origin:f.identity.origin,assistantId:f.identity.assistantId,companyId:f.companyId,
    provider:row.skillId==='email-imap-smtp'?'email':row.skillId==='max-web'?'max':'telegram',accountId:row.localAccountId,bindingId:row.id});
  return {...f,row,inbox,scope,get coordinator(){return coordinator;},read:value=>{read=value;},rows:value=>{rows=value;},
    failSources:value=>{inventoryFailure=value;},reads:()=>reads,position:()=>f.database.prepare('SELECT scope_json,cursor FROM assistant_inbox_sources').all().find(value=>JSON.parse(value.scope_json).bindingId===row.id)?.cursor,restart:async()=>{await coordinator.close();coordinator=createAssistantCoordinator(options);}};
};

test('native source refs poll every five minutes into durable unrouted SQLite refs without model starts or read ACKs',async t=>{
  const f=await externalFixture(t);
  try{
    await f.coordinator.pollOnce();await f.coordinator.workOnce();
    assert.equal(f.position(),'baseline');assert.equal(f.reads(),1);
    f.read(async source=>{assert.equal(source.cursor,'baseline');return {schemaVersion:1,baselineOnly:false,
      events:[{id:'message:123:5',revision:'a'.repeat(64),text:'PRIVATE_MESSAGE',senderUserId:'123',taskId:f.taskId,wake:true}],
      nextCursor:'next',hasMore:false,channelsToSync:[],unresolvedDeletionIds:[]};});
    await f.coordinator.pollOnce();assert.equal(f.reads(),1,'30-second coordinator ticks do not repeat a five-minute source read');
    f.advance(300000);await f.coordinator.pollOnce();
    const stored=f.database.prepare('SELECT event_id,event_revision,task_id,wake,processed,acked FROM assistant_inbox_events').all();
    assert.deepEqual(stored.map(row=>({...row})),[{event_id:'message:123:5',event_revision:'a'.repeat(64),task_id:null,wake:0,processed:0,acked:0}]);
    assert.equal(f.position(),'next');assert.equal(await f.coordinator.workOnce(),null);
    assert.equal(f.counts().runs,0);assert.equal(f.counts().acks,0);
    await f.restart();f.advance(300000);f.read(async source=>{assert.equal(source.cursor,'next');return {schemaVersion:1,baselineOnly:false,
      events:[{id:'message:123:5',revision:'a'.repeat(64)}],nextCursor:'next',hasMore:false,channelsToSync:[],unresolvedDeletionIds:[]};});
    await f.coordinator.pollOnce();assert.equal(f.database.prepare('SELECT count(*) AS n FROM assistant_inbox_events').get().n,1);
    assert.equal(f.counts().provisions,1,'a restarted source does not create another task chat');
  }finally{await f.coordinator.close();}
});

test('initial unread email keeps the original seed and independent forward position through real SQLite restart',async t=>{
  const f=await externalFixture(t);f.row.skillId='email-imap-smtp';const requests=[];
  f.read(async source=>{requests.push({...source});assert.equal(source.initialUnread,true);assert.equal(source.cursor,null);
    return {baselineOnly:true,events:[],nextCursor:'forward-10',initialUnreadCursor:'history-0:10',hasMore:false};});
  try{
    await f.coordinator.pollOnce();await f.coordinator.workOnce();
    let stream=f.database.prepare('SELECT * FROM assistant_inbox_streams').get();
    assert.equal(f.position(),'forward-10');assert.equal(stream.initial_cursor,'history-0:10');assert.equal(stream.cursor,null);
    assert.equal(stream.stream_id,'email-initial-unread/v1');
    await f.restart();
    f.read(async source=>{requests.push({...source});assert.equal(source.initialUnread,true);assert.equal(source.cursor,'history-0:10');
      assert.equal(source.chat,undefined);assert.equal(source.initialAccountCursor,undefined);
      return {baselineOnly:false,initialUnreadBackfill:true,events:[{id:'uid:17:5',revision:'a'.repeat(64),body:'PRIVATE_BODY'}],
        nextCursor:'history-5:10',hasMore:true};});
    await f.coordinator.pollOnce();
    assert.equal(f.position(),'forward-10');assert.equal(f.database.prepare('SELECT cursor FROM assistant_inbox_streams').get().cursor,'history-5:10');
    await f.restart();f.advance(300000);
    f.read(async source=>{requests.push({...source});
      if(source.initialUnread){assert.equal(source.cursor,'history-5:10');return {baselineOnly:false,initialUnreadBackfill:true,
        events:[{id:'uid:17:8',revision:'b'.repeat(64)}],nextCursor:'history-10:10',hasMore:false};}
      assert.equal(source.cursor,'forward-10');return {baselineOnly:false,events:[{id:'uid:17:11',revision:'c'.repeat(64),subject:'PRIVATE_SUBJECT'}],
        nextCursor:'forward-11',hasMore:false};});
    await f.coordinator.pollOnce();assert.equal(f.position(),'forward-11');
    stream=f.database.prepare('SELECT * FROM assistant_inbox_streams').get();
    assert.equal(stream.initial_cursor,'history-0:10');assert.equal(stream.completed_generation,stream.signal_generation);
    assert.deepEqual(f.database.prepare('SELECT event_id,task_id,wake,processed,acked FROM assistant_inbox_events ORDER BY event_id').all().map(row=>({...row})),
      ['uid:17:11','uid:17:5','uid:17:8'].map(event_id=>({event_id,task_id:null,wake:0,processed:0,acked:0})));
    assert.equal(await f.coordinator.workOnce(),null);assert.equal(f.counts().runs,0);assert.equal(f.counts().acks,0);
    await f.restart();f.advance(300000);
    f.read(async source=>{requests.push({...source});assert.equal(source.initialUnread,undefined);assert.equal(source.cursor,'forward-11');
      return {baselineOnly:false,events:[{id:'uid:17:11',revision:'c'.repeat(64)}],nextCursor:'forward-11',hasMore:false};});
    await f.coordinator.pollOnce();assert.equal(requests.length,5,'a final historical stream stays asleep after restart');
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM assistant_inbox_events').get().n,3);
    // An unexpected seed in a later forward response is not a reset command.
    f.advance(300000);f.read(async()=>({baselineOnly:false,events:[],nextCursor:'lost',initialUnreadCursor:'replacement',hasMore:false}));
    await f.coordinator.pollOnce();assert.equal(f.position(),'forward-11');
    assert.equal(f.database.prepare('SELECT initial_cursor FROM assistant_inbox_streams').get().initial_cursor,'history-0:10');
    assert.ok(!JSON.stringify(f.database.prepare('SELECT * FROM assistant_inbox_events').all()).includes('PRIVATE'));
  }finally{await f.coordinator.close();}
});

test('initial email seed and forward cursor roll back together on SQLite failure or a late source pause',async t=>{
  const f=await externalFixture(t);f.row.skillId='email-imap-smtp';
  f.read(async()=>({baselineOnly:true,events:[],nextCursor:'forward-10',initialUnreadCursor:'history-0:10',hasMore:false}));
  try{
    f.inbox.register(f.scope());
    // Abort precisely after the stream INSERT. This proves both operations use
    // the SAME SQLite transaction rather than two superficially adjacent writes.
    const key=f.database.prepare('SELECT source_key FROM assistant_inbox_sources').get().source_key;
    assert.match(key,/^[a-f0-9]{64}$/);
    f.database.exec(`CREATE TEMP TRIGGER fail_email_baseline BEFORE UPDATE OF cursor ON assistant_inbox_sources
      WHEN NEW.source_key='${key}' BEGIN SELECT RAISE(ABORT,'synthetic baseline failure'); END;`);
    await f.coordinator.pollOnce();assert.equal(f.position(),null);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM assistant_inbox_streams').get().n,0);
    f.database.exec('DROP TRIGGER fail_email_baseline');f.advance(300000);
    f.read(async()=>{f.row.state='paused';f.row.revision++;return {baselineOnly:true,events:[],nextCursor:'lost',
      initialUnreadCursor:'lost-seed',hasMore:false};});
    await f.coordinator.pollOnce();assert.equal(f.position(),null);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM assistant_inbox_streams').get().n,0);
    f.row.state='active';f.row.revision++;f.advance(300000);
    f.read(async()=>({baselineOnly:true,events:[],nextCursor:'forward-10',initialUnreadCursor:'history-0:10',hasMore:false}));
    await f.coordinator.pollOnce();assert.equal(f.position(),'forward-10');
    assert.equal(f.database.prepare('SELECT initial_cursor FROM assistant_inbox_streams').get().initial_cursor,'history-0:10');
    assert.equal(f.counts().runs,0);assert.equal(f.counts().acks,0);
  }finally{await f.coordinator.close();}
});

test('failed source inventories retain positions and cannot revoke or continue polling stale registrations',async t=>{
  const f=await externalFixture(t);
  try{
    await f.coordinator.pollOnce();f.failSources(true);f.advance(300000);
    await f.coordinator.pollOnce();assert.equal(f.reads(),1);assert.equal(f.inbox.status(f.scope()).state,'active');
    assert.equal(f.position(),'baseline');assert.ok(f.notifications.some(value=>value.code==='ASSISTANT_SOURCE_UNAVAILABLE'));
    f.failSources(false);f.advance(300000);await f.coordinator.pollOnce();assert.equal(f.reads(),2);
    f.rows([]);f.advance(300000);await f.coordinator.pollOnce();assert.equal(f.inbox.status(f.scope()).state,'revoked');
    assert.equal(f.reads(),2,'only the successful exact empty inventory retires the registration');
  }finally{await f.coordinator.close();}
});

test('an unavailable company source does not stop another company account from reaching the durable inbox',async t=>{
  const f=await externalFixture(t),companyB=randomUUID(),memberB=randomUUID();
  const second={...f.row,id:randomUUID(),companyId:companyB,skillId:'email-imap-smtp'};
  f.options.client.companies=async()=>[{companyId:f.companyId,memberId:f.memberId},{companyId:companyB,memberId:memberB}];
  const tasks=f.options.client.tasks,poll=f.options.client.poll;
  f.options.client.tasks=async company=>company===companyB?{bindings:[],nextCursor:null}:tasks(company);
  f.options.client.poll=async(company,cursor)=>company===companyB?{events:[],nextCursor:'0',hasMore:false}:poll(company,cursor);
  f.options.client.sourceAccounts=async company=>{
    if(company===f.companyId)throw Object.assign(new Error('PRIVATE_FIRST_COMPANY'),{code:'ASSISTANT_SOURCE_UNAVAILABLE'});
    assert.equal(company,companyB);return [second];
  };
  f.read(async source=>{assert.equal(source.companyId,companyB);assert.equal(source.accountId,second.localAccountId);
    return source.initialUnread?{baselineOnly:source.cursor===null,events:[],nextCursor:'mail-next',hasMore:false,
      ...(source.cursor===null?{initialUnreadCursor:'mail-history'}:{initialUnreadBackfill:true})}:
      {events:[{id:'uid:2:3',revision:'a'.repeat(64),subject:'PRIVATE_SUBJECT'}],nextCursor:'mail-next',hasMore:false};});
  try{
    await f.coordinator.pollOnce();assert.equal(f.reads(),1);
    f.advance(300000);await f.coordinator.pollOnce();assert.equal(f.reads(),3,'forward and the separate history stream both get bounded turns');
    const stored=f.database.prepare('SELECT e.event_id,e.task_id,e.wake,s.scope_json FROM assistant_inbox_events e JOIN assistant_inbox_sources s USING(source_key)').get();
    assert.equal(stored.event_id,'uid:2:3');assert.equal(stored.task_id,null);assert.equal(stored.wake,0);
    assert.equal(JSON.parse(stored.scope_json).companyId,companyB);assert.equal(f.counts().acks,0);
    assert.ok(!JSON.stringify(stored).includes('PRIVATE'));
  }finally{await f.coordinator.close();}
});

test('changed owner registration after provider read rolls back page acceptance and preserves the original cursor',async t=>{
  const f=await externalFixture(t);
  try{
    await f.coordinator.pollOnce();f.advance(300000);
    f.read(async()=>{f.row.state='paused';f.row.revision++;return {events:[{id:'uncommitted',revision:'1'}],nextCursor:'lost',hasMore:false};});
    await f.coordinator.pollOnce();assert.equal(f.position(),'baseline');
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM assistant_inbox_events').get().n,0);
    assert.ok(f.notifications.some(value=>value.code==='ASSISTANT_COORDINATOR_SOURCE_CHANGED'));
    f.advance(300000);await f.coordinator.pollOnce();assert.equal(f.inbox.status(f.scope()).state,'paused');
    f.row.state='active';f.row.revision++;f.read(async()=>({events:[],nextCursor:'resumed',hasMore:false}));
    f.advance(300000);await f.coordinator.pollOnce();assert.equal(f.position(),'resumed');
  }finally{await f.coordinator.close();}
});

test('invalid stream hints, unknown deletions and oversized cursor refuse advancement instead of losing provider events',async t=>{
  for(const extra of [{channelsToSync:['not-a-native-channel']},{unresolvedDeletionIds:['5']},{nextCursor:'x'.repeat(2049)}]){
    const f=await externalFixture(t);
    try{
      await f.coordinator.pollOnce();f.advance(300000);
      f.read(async()=>({events:[{id:'not-yet-durable',revision:'1'}],nextCursor:'do-not-advance',hasMore:false,...extra}));
      await f.coordinator.pollOnce();assert.equal(f.position(),'baseline');
      assert.equal(f.database.prepare('SELECT count(*) AS n FROM assistant_inbox_events').get().n,0);
      assert.equal(f.counts().acks,0);assert.equal(f.inbox.status(f.scope()).nextPollAt,f.options.now()+300000);
    }finally{await f.coordinator.close();}
  }
});

test('MAX account discovery uses native hints and one busy source cannot consume the whole coordinator tick',async t=>{
  const f=await externalFixture(t);
  try{
    f.row.skillId='max-web';f.read(async source=>{assert.equal(source.chat,undefined);assert.equal(source.initialUnread,undefined);return {baselineOnly:true,events:[],nextCursor:'max-complete',initialAccountCursor:'max-complete',conversationsToSync:[],hasMore:false};});
    await f.coordinator.pollOnce();assert.equal(f.reads(),1);assert.equal(f.position(),'max-complete');
    f.row.skillId='telegram-mtproto';const rows=Array.from({length:6},()=>({...f.row,id:randomUUID(),localAccountId:randomUUID()}));
    f.rows(rows);f.advance(300000);f.read(async()=>({events:[],nextCursor:'more',hasMore:true,channelsToSync:[],unresolvedDeletionIds:[]}));
    await f.coordinator.pollOnce();assert.equal(f.reads(),5,'one page from at most four oldest due registrations');
    // No time advance: the two never-polled rows retain due=0 and must win.
    f.read(async()=>({events:[],nextCursor:'end',hasMore:false}));
    await f.coordinator.pollOnce();assert.equal(f.reads(),9);
    assert.equal(rows.filter(row=>f.inbox.status({...f.scope(),accountId:row.localAccountId,bindingId:row.id}).cursorRevision>0).length,6);
  }finally{await f.coordinator.close();}
});


test('source health snapshots precede provider reads; reports never replay work, lose positions or clear global health',async t=>{
  let revision=0,readFailure=false,reportFailure=false,phase='idle';const reports=[];
  const sourceHealth={read:async row=>{
    phase='snapshot';if(readFailure)throw Object.assign(new Error('PRIVATE_HEALTH'),{code:'ASSISTANT_TRANSPORT_UNAVAILABLE'});
    return {revision,sourceRevision:row.revision,code:'not_checked'};
  },report:async(row,value)=>{
    assert.equal(value.expectedRevision,revision);assert.equal(value.sourceRevision,row.revision);
    assert.equal(phase,'provider');reports.push({...value,sourceId:row.id});
    if(reportFailure)throw Object.assign(new Error('PRIVATE_REPORT'),{code:'ASSISTANT_SOURCE_HEALTH_CHANGED'});
    revision++;
  }};
  const f=await externalFixture(t,{sourceHealth});
  try{
    f.read(async()=>{assert.equal(phase,'snapshot');phase='provider';return {events:[],nextCursor:'baseline',hasMore:false};});
    await f.coordinator.pollOnce();assert.equal(reports.length,1);assert.equal(reports[0].code,'ready');
    f.advance(300000);reportFailure=true;
    f.read(async()=>{phase='provider';throw Object.assign(new Error('PRIVATE_PROVIDER'),{code:'EMAIL_MONITOR_GAP'});});
    await f.coordinator.pollOnce();assert.equal(reports.length,2);assert.equal(reports[1].code,'history_gap');
    assert.equal(f.reads(),2);assert.equal(f.position(),'baseline');
    assert.ok(f.notifications.some(value=>value.code==='EMAIL_MONITOR_GAP'),'original provider reason survives diagnostic failure');
    f.advance(300000);f.read(async()=>{phase='provider';return {events:[{id:'mail:1',revision:'1'}],nextCursor:'committed',hasMore:false};});
    await f.coordinator.pollOnce();assert.equal(f.reads(),3);assert.equal(f.position(),'committed');
    assert.equal(f.database.prepare('SELECT processed FROM assistant_inbox_events').get().processed,0);
    assert.equal(f.counts().acks,0);assert.equal(reports[2].code,'ready');
    // Failure to read diagnostic CAS cannot block or duplicate the independent
    // signed reader. It also cannot synthesize a blind write from revision=0.
    f.advance(300000);readFailure=true;
    await f.coordinator.pollOnce();assert.equal(f.reads(),4);assert.equal(reports.length,3);
    readFailure=false;reportFailure=false;f.advance(300000);
    f.read(async()=>{phase='provider';f.row.state='paused';f.row.revision++;return {events:[],nextCursor:'late',hasMore:false};});
    await f.coordinator.pollOnce();assert.equal(reports.length,3,'late owner change never reports recovery');
    assert.equal(f.position(),'committed');assert.ok(!JSON.stringify(f.notifications).includes('PRIVATE'));
  }finally{await f.coordinator.close();}
});

test('native cloud deletions resolve only exact durable account references and survive restart without wake or ACK',async t=>{
  const f=await externalFixture(t);
  try{
    await f.coordinator.pollOnce();await f.coordinator.workOnce();f.advance(300000);
    f.read(async()=>({events:[{id:'message:123:5',revision:'a'.repeat(64)}],nextCursor:'known',hasMore:false}));
    await f.coordinator.pollOnce();assert.equal(f.position(),'known');f.advance(300000);
    const deleted={events:[],nextCursor:'deleted',hasMore:false,unresolvedDeletionIds:['5']};
    f.read(async()=>deleted);await f.coordinator.pollOnce();assert.equal(f.position(),'deleted');
    const rows=()=>f.database.prepare('SELECT event_id,event_revision,task_id,wake,processed,acked FROM assistant_inbox_events ORDER BY rowid').all();
    assert.equal(rows().length,2);assert.equal(rows()[1].event_id,'message:123:5');assert.match(rows()[1].event_revision,/^[a-f0-9]{64}$/u);
    assert.notEqual(rows()[1].event_revision,'a'.repeat(64));assert.equal(rows()[1].task_id,null);
    assert.ok(rows().every(row=>!row.wake&&!row.processed&&!row.acked));
    await f.restart();f.advance(300000);await f.coordinator.pollOnce();assert.equal(rows().length,2,'exact page replay has the same metadata revision');
    assert.equal(await f.coordinator.workOnce(),null);assert.equal(f.counts().runs,0);assert.equal(f.counts().acks,0);
  }finally{await f.coordinator.close();}
});

test('ambiguous, unjournaled, channel-numbered and mixed-overflow deletions retain the original account position',async t=>{
  for(const kind of ['ambiguous','unknown','channel','oversized']){
    const f=await externalFixture(t);
    try{
      await f.coordinator.pollOnce();f.advance(300000);
      const ids=kind==='ambiguous'?['message:123:5','message:456:5']:kind==='channel'?['message:-1000000000123:5']:
        kind==='unknown'?['message:123:25']:['message:123:5'];
      f.read(async()=>({events:ids.map(id=>({id,revision:'a'.repeat(64)})),nextCursor:'before-delete',hasMore:false}));
      await f.coordinator.pollOnce();f.advance(300000);
      f.read(async()=>({events:kind==='oversized'?Array.from({length:100},(_,n)=>({id:`message:123:${n+100}`,revision:'b'.repeat(64)})):[],
        nextCursor:'must-not-commit',hasMore:false,unresolvedDeletionIds:['5']}));
      await f.coordinator.pollOnce();assert.equal(f.position(),'before-delete',kind);
      assert.equal(f.database.prepare('SELECT count(*) AS n FROM assistant_inbox_events').get().n,ids.length);
      assert.ok(f.notifications.some(value=>value.code==='ASSISTANT_COORDINATOR_SOURCE_REFERENCE_REQUIRED'),kind);
      assert.equal(f.counts().acks,0);assert.equal(f.counts().runs,0);
    }finally{await f.coordinator.close();}
  }
});

test('Telegram channel hints survive restart, initial unread catch-up and final idle without waking or acknowledging',async t=>{
  const f=await externalFixture(t),chat='-1000000000123';
  try{
    await f.coordinator.pollOnce();await f.coordinator.workOnce();f.advance(300000);
    f.read(async source=>{assert.equal(source.chat,undefined);return {baselineOnly:false,events:[],
      nextCursor:'account-hint-1',hasMore:false,channelsToSync:['123']};});
    await f.coordinator.pollOnce();assert.equal(f.position(),'account-hint-1');
    assert.equal(f.inbox.hasPendingStreams(f.scope()),true,'hint commits with account cursor before any channel I/O');
    const calls=[];
    f.read(async source=>{calls.push({...source});assert.equal(source.chat,chat);
      assert.equal(source.initialAccountCursor,'baseline');assert.equal(source.initialUnread,undefined);assert.equal(source.cursor,null);
      return {baselineOnly:false,initialAccountBackfill:true,events:[{id:`message:${chat}:9`,revision:'a'.repeat(64)}],
        nextCursor:'initial-unread-page',hasMore:true};});
    await f.coordinator.pollOnce();await f.restart();f.advance(1);
    f.read(async source=>{calls.push({...source});assert.equal(source.chat,chat);assert.equal(source.initialAccountCursor,undefined);
      assert.equal(source.cursor,'initial-unread-page');return {baselineOnly:false,initialAccountBackfill:true,
        events:[],nextCursor:'original-pts',hasMore:true};});
    await f.coordinator.pollOnce();f.advance(1);
    f.read(async source=>{calls.push({...source});assert.equal(source.cursor,'original-pts');return {baselineOnly:false,
      events:[{id:`message:${chat}:10`,revision:'b'.repeat(64)}],nextCursor:'channel-final',hasMore:false};});
    await f.coordinator.pollOnce();assert.equal(f.inbox.hasPendingStreams(f.scope()),false);
    const count=f.reads();await f.coordinator.pollOnce();f.advance(30000);await f.coordinator.pollOnce();
    assert.equal(f.reads(),count,'a final channel is not polled again without a new native account hint');
    f.advance(300000);
    f.read(async source=>{assert.equal(source.chat,undefined);return {baselineOnly:false,events:[],
      nextCursor:'account-hint-2',hasMore:false,channelsToSync:['123']};});
    await f.coordinator.pollOnce();f.advance(1);
    f.read(async source=>{calls.push({...source});assert.equal(source.cursor,'channel-final');assert.equal(source.initialAccountCursor,undefined);
      return {baselineOnly:false,events:[{id:`message:${chat}:9`,revision:'a'.repeat(64)}],nextCursor:'channel-final-2',hasMore:false};});
    await f.coordinator.pollOnce();assert.equal(f.inbox.hasPendingStreams(f.scope()),false);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM assistant_inbox_events').get().n,2);
    assert.equal(f.counts().runs,0);assert.equal(f.counts().acks,0);
    assert.ok(f.database.prepare('SELECT task_id,wake,processed,acked FROM assistant_inbox_events').all()
      .every(row=>row.task_id===null&&!row.wake&&!row.processed&&!row.acked));
    assert.equal(calls.length,4);assert.equal(f.counts().provisions,1);
  }finally{await f.coordinator.close();}
});

test('a legacy baseline or changed owner registration cannot advance a channel cursor or hide pending source recovery',async t=>{
  let revision=0;const reports=[];
  const f=await externalFixture(t,{sourceHealth:{read:async row=>({revision,sourceRevision:row.revision,code:'not_checked'}),
    report:async(_row,value)=>{reports.push(value.code);revision++;}}});
  try{
    await f.coordinator.pollOnce();f.advance(300000);
    f.read(async()=>({baselineOnly:false,events:[],nextCursor:'with-channel',hasMore:false,channelsToSync:['123']}));
    await f.coordinator.pollOnce();assert.deepEqual(reports,['ready'],'account success does not clear a pending channel');
    f.advance(1);f.read(async()=>({baselineOnly:true,events:[],nextCursor:'silent-baseline',hasMore:false}));
    await f.coordinator.pollOnce();assert.equal(reports.at(-1),'setup_required');
    assert.equal(f.database.prepare('SELECT cursor FROM assistant_inbox_streams').get().cursor,null);
    f.advance(300000);
    f.read(async source=>source.chat?{baselineOnly:false,initialAccountBackfill:true,events:[],nextCursor:'unread',hasMore:true}
      :{baselineOnly:false,events:[],nextCursor:'account-fresh',hasMore:false});
    await f.coordinator.pollOnce();assert.equal(reports.filter(value=>value==='ready').length,1,
      'another successful account page cannot hide the unresolved child incident');
    f.advance(1);f.read(async()=>{f.row.revision++;f.row.state='paused';return {baselineOnly:false,
      events:[{id:'must-not-commit',revision:'1'}],nextCursor:'changed',hasMore:false};});
    await f.coordinator.pollOnce();assert.equal(f.database.prepare('SELECT cursor FROM assistant_inbox_streams').get().cursor,'unread');
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM assistant_inbox_events').get().n,0);
    assert.equal(f.counts().acks,0);assert.equal(f.counts().runs,0);
  }finally{await f.coordinator.close();}
});

for(const provider of ['telegram','email'])test(`${provider} native routes reuse the canonical task chat and never ACK an unread body`,async t=>{
  const f=await externalFixture(t),key=`${provider}-conversation/v1.${'a'.repeat(64)}`,unknown=`${provider}-conversation/v1.${'b'.repeat(64)}`;
  if(provider==='email')f.row.skillId='email-imap-smtp';
  const route={id:randomUUID(),sourceId:f.row.id,sourceRevision:0,conversationKey:key,bindingId:f.bindingId,bindingRevision:0,taskId:f.taskId};
  let routingCalls=0;
  f.options.client.sourceRoutes=async input=>{
    routingCalls++;assert.equal(input.companyId,f.companyId);assert.equal(input.sourceId,f.row.id);
    assert.equal(input.sourceRevision,0);
    if(input.routeIds){assert.deepEqual(input.routeIds,[route.id]);return [route];}
    assert.ok(input.conversationKeys.every(value=>value===key||value===unknown));
    return input.conversationKeys.includes(key)?[route]:[];
  };
  try{
    await f.coordinator.pollOnce();await f.coordinator.workOnce();
    if(provider==='email')await f.coordinator.pollOnce(); // Complete the independently due empty initial history.
    const threadId=f.coordinator.status()[0].threadId;
    f.read(async()=>({schemaVersion:1,baselineOnly:false,nextCursor:'messages',hasMore:false,channelsToSync:[],unresolvedDeletionIds:[],events:[
      {id:provider==='email'?'uid:17:11':'message:123:1',revision:'c'.repeat(64),kind:'new',outgoing:false,conversationKey:key},
      {id:provider==='email'?'uid:17:12':'message:124:1',revision:'d'.repeat(64),kind:'new',outgoing:false,conversationKey:unknown},
      {id:provider==='email'?'uid:17:13':'message:123:2',revision:'e'.repeat(64),kind:'new',outgoing:true,conversationKey:key}]}));
    f.advance(300_000);await f.coordinator.pollOnce();
    let runs=0;
    f.options.native.run=async(input,options)=>{
      assert.equal(input.threadId,threadId);assert.equal(input.taskContext.sourceReferences.length,2);
      for(const ref of input.taskContext.sourceReferences){assert.equal(ref.sourceId,f.row.id);assert.equal(ref.accountId,f.row.localAccountId);assert.equal(ref.conversationKey,key);}
      runs++;options.startInvocation();const result={state:'completed',receipt:`codex:${threadId}:${randomUUID()}`};f.deliveries.set(input.deliveryId,result);return result;
    };
    await f.coordinator.workOnce();assert.equal(runs,1);assert.equal(f.counts().provisions,1);
    assert.equal(f.coordinator.status().length,1);assert.equal(f.coordinator.status()[0].source.provider,'trelio');
    assert.equal(await f.coordinator.workOnce(),null);
    assert.equal(f.inbox.claimAcknowledgements(f.scope()),null,'native/business completion is not an actual body read');
    f.advance(300_000);await f.coordinator.pollOnce();assert.equal(await f.coordinator.workOnce(),null,'replayed metadata cannot cause another wake');
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM assistant_inbox_events').get().n,3);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM assistant_inbox_events WHERE processed=1 OR acked=1').get().n,0);
    assert.ok(routingCalls>=2,'live route authority is rechecked immediately before native work');
  }finally{await f.coordinator.close();}
});

test('route/source revocation immediately before native launch blocks delivery without a second chat, ACK or stale source adoption',async t=>{
  const f=await externalFixture(t),key=`telegram-conversation/v1.${'a'.repeat(64)}`;
  const route={id:randomUUID(),sourceId:f.row.id,sourceRevision:0,conversationKey:key,bindingId:f.bindingId,bindingRevision:0,taskId:f.taskId};
  f.options.client.sourceRoutes=async()=>[route];
  try{
    await f.coordinator.pollOnce();await f.coordinator.workOnce();
    f.read(async()=>({baselineOnly:false,events:[{id:'message:123:1',revision:'b'.repeat(64),kind:'new',outgoing:false,conversationKey:key}],
      nextCursor:'pending',hasMore:false,channelsToSync:[],unresolvedDeletionIds:[]}));
    f.advance(300_000);await f.coordinator.pollOnce();
    f.options.client.sourceRoutes=async()=>[];
    await assert.rejects(f.coordinator.workOnce(),/SOURCE_CHANGED/);
    assert.equal(f.counts().runs,0);assert.equal(f.counts().provisions,1);
    assert.equal(f.inbox.claimAcknowledgements(f.scope()),null);
    f.row.revision=1;f.advance(300_000);await f.coordinator.pollOnce();
    assert.equal(await f.coordinator.workOnce(),null);
    assert.equal(f.position(),'pending','source changes retain the native cursor');
    assert.equal(f.database.prepare('SELECT task_id FROM assistant_inbox_events').get().task_id,null);
  }finally{await f.coordinator.close();}
});

test('routing outage cannot roll back a committed provider page or become authoritative absence',async t=>{
  const f=await externalFixture(t),key=`telegram-conversation/v1.${'a'.repeat(64)}`;
  f.options.client.sourceRoutes=async()=>{throw Object.assign(new Error('PRIVATE_BODY'),{code:'ASSISTANT_TRANSPORT_UNAVAILABLE'});};
  try{
    await f.coordinator.pollOnce();await f.coordinator.workOnce();
    f.read(async()=>({baselineOnly:false,events:[{id:'message:123:1',revision:'b'.repeat(64),kind:'new',outgoing:false,conversationKey:key}],
      nextCursor:'retained',hasMore:false,channelsToSync:[],unresolvedDeletionIds:[]}));
    f.advance(300_000);await f.coordinator.pollOnce();
    assert.equal(f.position(),'retained');assert.equal(f.database.prepare('SELECT count(*) AS n FROM assistant_inbox_events').get().n,1);
    assert.equal(await f.coordinator.workOnce(),null);assert.equal(f.inbox.claimAcknowledgements(f.scope()),null);
    assert.ok(!JSON.stringify(f.notifications).includes('PRIVATE_BODY'));
  }finally{await f.coordinator.close();}
});


for(const scenario of ['telegram','email','email-history','max'])test(`${scenario} committed processing ACK survives a lost write with read-only recovery`,async t=>{
  const history=scenario==='email-history',provider=history?'email':scenario;
  const eventId=provider==='email'?`uid:17:${history?5:11}`:'message:123:1';
  let mode='unknown',calls=[],f;
  let healthRevision=0,healthRead='ready',healthAck='ready',reportFailure=false,healthReadFailure=false;const healthReports=[];
  const sourceHealth={read:async row=>{
    if(healthReadFailure)throw Object.assign(new Error('PRIVATE_HEALTH_READ'),{code:'ASSISTANT_TRANSPORT_UNAVAILABLE'});
    return {revision:healthRevision,sourceRevision:row.revision};
  },report:async(row,value)=>{
    assert.equal(value.expectedRevision,healthRevision);assert.equal(value.sourceRevision,row.revision);
    healthReports.push({...value});
    if(value.phase==='acknowledgement')healthAck=value.code;else healthRead=value.code;
    healthRevision++;
    if(reportFailure&&value.phase==='acknowledgement')throw Object.assign(new Error('PRIVATE_HEALTH_LOST'),{code:'ASSISTANT_TRANSPORT_UNAVAILABLE'});
  }};
  const acknowledgeSource=async input=>{
    calls.push(input.verifyOnly);input.assertReferences();input.beforeInvoke();
    assert.equal(f.database.prepare('SELECT ack_started FROM assistant_inbox_events').get().ack_started,1,'durable fence precedes ONE native invocation');
    assert.equal(input.references.length,1);assert.equal(input.references[0].id,eventId);
    if(provider==='email')assert.equal(input.references[0].originalSha256,'f'.repeat(64));
    if(mode==='unknown')throw Object.assign(new Error('PRIVATE_PROVIDER_LOST'),{code:'ASSISTANT_SOURCE_UNAVAILABLE'});
    return {acknowledged:mode==='confirmed',notAttempted:true,code:null};
  };
  f=await externalFixture(t,{acknowledgeSource,sourceHealth});if(provider==='email')f.row.skillId='email-imap-smtp';
  if(provider==='max'){f.row.skillId='max-web';f.row.maxChatUrl='https://web.max.ru/123';}
  const key=provider+'-conversation/v1.'+'a'.repeat(64),route={id:randomUUID(),sourceId:f.row.id,sourceRevision:0,
    conversationKey:key,bindingId:f.bindingId,bindingRevision:0,taskId:f.taskId};
  f.options.client.sourceRoutes=async()=>[route];
  const outcome=f.options.client.readBusinessOutcome;let selected=false;
  f.options.client.readBusinessOutcome=async input=>({...await outcome(input),...(selected?{
    processedSourceReferences:[{sourceId:f.row.id,sourceRevision:0,routeId:route.id,eventOrdinal:0}]}:{})});
  f.options.native.run=async(input,options)=>{
    options.startInvocation();const ref=input.taskContext.sourceReferences[0];
    const event=f.database.prepare('SELECT event_key FROM assistant_inbox_events WHERE event_id=?').get(ref.eventId);
    f.inbox.recordExternalRead(f.scope(),{deliveryId:input.deliveryId,eventKey:event.event_key,sourceRevision:0,routeId:route.id,...(provider==='email'?{originalSha256:'f'.repeat(64)}:{})});
    const result={state:'completed',receipt:`codex:${input.threadId}:${randomUUID()}`};f.deliveries.set(input.deliveryId,result);return result;
  };
  try{
    await f.coordinator.pollOnce();await f.coordinator.workOnce();
    if(provider==='email'&&!history)await f.coordinator.pollOnce();
    const thread=f.coordinator.status()[0].threadId;
    f.read(async source=>({baselineOnly:false,nextCursor:history&&source.initialUnread?'history-end':'message',hasMore:false,
      ...(history&&source.initialUnread?{initialUnreadBackfill:true}:{}),channelsToSync:[],unresolvedDeletionIds:[],
      events:history&&!source.initialUnread?[]:[{id:eventId,revision:'b'.repeat(64),kind:'new',outgoing:false,conversationKey:key}]}));
    f.advance(300000);await f.coordinator.pollOnce();assert.deepEqual(calls,[]);
    await f.coordinator.workOnce();await f.coordinator.pollOnce();assert.deepEqual(calls,[],'body read with omitted processing is never ACK eligible');
    selected=true;f.advance(1800000);await f.coordinator.workOnce();await f.coordinator.pollOnce();
    assert.deepEqual(calls,[false]);assert.equal(f.database.prepare('SELECT acked FROM assistant_inbox_events').get().acked,0);
    assert.equal(healthAck,'acknowledgement_uncertain');assert.equal(healthRead,'ready');
    f.row.state='paused';f.row.revision=1;f.advance(300001);await f.coordinator.pollOnce();assert.deepEqual(calls,[false]);
    f.row.state='active';f.row.revision=2;
    await f.restart();mode='not-read';healthReadFailure=true;f.advance(300001);await f.coordinator.pollOnce();assert.deepEqual(calls,[false,true]);
    assert.equal(healthAck,'acknowledgement_uncertain','passive success and verify-only false cannot clear the unknown write');
    assert.equal(f.database.prepare('SELECT ack_started FROM assistant_inbox_events').get().ack_started,1,'a verify-only no-write result never clears the older unknown write');
    healthReadFailure=false;f.authority.state='done';f.authority.revision++;mode='confirmed';reportFailure=true;f.advance(300001);await f.coordinator.pollOnce();
    assert.deepEqual(calls,[false,true,true]);assert.equal(f.database.prepare('SELECT acked FROM assistant_inbox_events').get().acked,1);
    assert.equal(f.database.prepare('SELECT route_source_revision FROM assistant_inbox_events').get().route_source_revision,0,'resume never revives the old route');
    assert.equal(f.database.prepare('SELECT ack_verified_revision FROM assistant_inbox_sources WHERE configuration_revision=2').get().ack_verified_revision,2);
    assert.equal(f.coordinator.status()[0].threadId,thread);assert.equal(f.counts().provisions,1);assert.equal(f.counts().acks,0,'native Trelio ACK never receives Telegram IDs');
    assert.equal(healthAck,'ready');const reported=healthReports.length;
    await f.restart();reportFailure=false;f.advance(300001);await f.coordinator.pollOnce();
    assert.deepEqual(calls,[false,true,true],'reconciling a lost diagnostic never repeats the provider action');
    assert.ok(healthReports.slice(reported).some(value=>value.phase==='acknowledgement'&&value.code==='ready'),
      'positive completion in the SAME journal survives restart even when no ACK remains due');
    assert.ok(f.notifications.some(value=>value.code==='ASSISTANT_COORDINATOR_SOURCE_HEALTH_UNAVAILABLE'));
    assert.ok(!JSON.stringify(f.notifications).includes('PRIVATE_PROVIDER'));
  }finally{await f.coordinator.close();}
});


test('one positive conversation never completes a legacy mixed uncertain ACK token',async t=>{
  let f,allRead=false,calls=0;
  let healthRevision=0;const observations=[];
  const sourceHealth={read:async row=>({revision:healthRevision,sourceRevision:row.revision}),report:async(_row,value)=>{
    assert.equal(value.expectedRevision,healthRevision++);if(value.phase)observations.push(value.code);
  }};
  const acknowledgeSource=async input=>{
    calls++;assert.equal(input.verifyOnly,true);input.assertReferences();input.beforeInvoke();
    return {acknowledged:allRead||input.references[0].id==='message:123:1',notAttempted:true,code:null};
  };
  f=await externalFixture(t,{acknowledgeSource,sourceHealth});
  const keys=['a','b'].map(n=>'telegram-conversation/v1.'+n.repeat(64));
  const routes=keys.map(conversationKey=>({id:randomUUID(),sourceId:f.row.id,sourceRevision:0,conversationKey,
    bindingId:f.bindingId,bindingRevision:0,taskId:f.taskId}));
  f.options.client.sourceRoutes=async()=>routes;
  const outcome=f.options.client.readBusinessOutcome;
  f.options.client.readBusinessOutcome=async input=>({...await outcome(input),processedSourceReferences:routes.map((route,eventOrdinal)=>({
    sourceId:f.row.id,sourceRevision:0,routeId:route.id,eventOrdinal}))});
  f.options.native.run=async(input,options)=>{
    options.startInvocation();for(const ref of input.taskContext.sourceReferences){
      const event=f.database.prepare('SELECT event_key FROM assistant_inbox_events WHERE event_id=?').get(ref.eventId);
      f.inbox.recordExternalRead(f.scope(),{deliveryId:input.deliveryId,eventKey:event.event_key,sourceRevision:0,routeId:ref.routeId});
    }
    const result={state:'completed',receipt:`codex:${input.threadId}:${randomUUID()}`};f.deliveries.set(input.deliveryId,result);return result;
  };
  try{
    await f.coordinator.pollOnce();await f.coordinator.workOnce();
    f.read(async()=>({baselineOnly:false,nextCursor:'mixed',hasMore:false,channelsToSync:[],unresolvedDeletionIds:[],
      events:keys.map((conversationKey,index)=>({id:`message:${123+index}:1`,revision:'b'.repeat(64),kind:'new',outgoing:false,conversationKey}))}));
    f.advance(300000);await f.coordinator.pollOnce();await f.coordinator.workOnce();
    const first=f.inbox.claimAcknowledgements(f.scope());f.inbox.startExternalAcknowledgements(f.scope(),first.token);
    const second=f.inbox.claimAcknowledgements(f.scope());assert.equal(second.events.length,1);
    // Reconstruct an older persisted attempt that could contain both chats.
    // New claims above are one conversation; only migration/recovery sees this.
    f.database.prepare('UPDATE assistant_inbox_events SET ack_token=?,ack_attempt_token=?,ack_started=1').run(first.token,first.token);
    f.advance(120001);await f.coordinator.pollOnce();assert.equal(calls,2);
    assert.equal(f.database.prepare('SELECT sum(acked) AS n FROM assistant_inbox_events').get().n,0);
    assert.equal(observations.at(-1),'acknowledgement_uncertain');assert.ok(!observations.includes('ready'));
    allRead=true;f.advance(300001);await f.coordinator.pollOnce();assert.equal(calls,4);
    assert.equal(f.database.prepare('SELECT sum(acked) AS n FROM assistant_inbox_events').get().n,2);
    assert.equal(observations.at(-1),'ready','only ALL original conversations being positive can clear the source incident');
    assert.equal(f.counts().provisions,1);
  }finally{await f.coordinator.close();}
});

test('owner command intake composes SAME SQLite/native provision, per-event task routing and restart dedup',async t=>{
  const database=new DatabaseSync(':memory:');
  let clock=Date.now(),poll=0,created=0,active=null,provisions=0,intakeTurns=0,intakeReads=0;
  const identity={origin:'https://assistant.test',assistantId:randomUUID(),deviceId:randomUUID()},companyId=randomUUID(),memberId=randomUUID();
  const ownerIdentityId=randomUUID(),accountId=randomUUID(),sourceId=randomUUID(),key=`telegram-conversation/v1.${'f'.repeat(64)}`;
  const execution={modelId:'gpt-6.1-sol',effortLevel:'high',revision:1};
  const row={id:sourceId,companyId,deviceId:identity.deviceId,localAccountId:accountId,projectId:null,skillId:'telegram-mtproto',
    state:'active',revision:0,ownerTaskIntakeAllowed:true,executionVerified:false};
  const tasks=new Map(),intakes=new Map(),turns=new Map();
  const client={identity,heartbeat:async()=>{},companies:async()=>[{companyId,memberId,execution:{state:'ready',configuration:execution}}],
    tasks:async()=>({bindings:[...tasks.values()],nextCursor:null}),task:async(_company,id)=>({...tasks.get(id),execution:{state:'ready',configuration:execution}}),
    poll:async()=>({events:[],nextCursor:'0',hasMore:false}),acknowledge:async()=>({acknowledged:0}),sourceAccounts:async()=>[{...row}],
    ownerIdentities:async()=>({bindingRevision:'a'.repeat(64),identities:[{provider:'telegram',bindingId:ownerIdentityId,externalUserId:'123'}]}),
    sourceRoutes:async input=>{
      if(input.conversationKeys)return []; // Never a whole-owner-dialog route.
      return [...intakes.values()].filter(value=>value.route&&input.routeIds.includes(value.route.id))
        .map(value=>({...value.route,taskId:value.taskId}));
    },
    beginSourceIntake:async input=>{
      assert.equal(input.ownerIdentityId,ownerIdentityId);assert.equal(input.senderExternalUserId,'123');
      if(!intakes.has(input.intakeId))intakes.set(input.intakeId,{schemaVersion:1,id:input.intakeId,companyId,sourceId,
        sourceRevision:0,eventId:input.eventId,threadId:input.threadId,state:'leased',leaseExpiresAt:new Date(clock+1800000).toISOString(),
        taskId:null,receiptId:null,execution,readConfirmed:false});
      return structuredClone(intakes.get(input.intakeId));
    },readSourceIntake:async input=>{intakeReads++;return structuredClone(intakes.get(input.intakeId));},
    claimTaskHost:async input=>({bindingId:input.bindingId,provisionId:input.provisionId,threadId:null}),reportSchedule:async input=>({sequence:input.sequence}),
  };
  const native={ready:async()=>true,readDelivery:async(_thread,id)=>turns.get(id)??{state:'uncertain'},
    provision:async(input,options)=>{provisions++;options.startInvocation();const threadId=randomUUID();options.onThreadStarted(threadId);
      const result={state:'completed',threadId,receipt:`codex:${threadId}:${randomUUID()}`};turns.set(input.deliveryId,result);return result;},
    run:async(input,options)=>{
      assert.ok(input.intakeContext,'the fixture stops before normal task business work');intakeTurns++;options.startInvocation();
      const current=intakes.get(input.intakeContext.intakeId),taskId=randomUUID(),bindingId=randomUUID();created++;
      tasks.set(taskId,{id:bindingId,taskId,state:'accepted',revision:0});
      Object.assign(current,{state:'created',taskId,receiptId:randomUUID(),readConfirmed:true,route:{id:randomUUID(),sourceId,
        sourceRevision:0,bindingId,bindingRevision:0,conversationKey:key}});
      const result={state:'completed',receipt:`codex:${input.threadId}:${randomUUID()}`};turns.set(input.deliveryId,result);return result;
    }};
  const options={database,client,native,passHost:{readActivePass:async()=>active,activatePass:async pass=>{assert.equal(active,null);active=pass;},
    releasePass:async outcome=>{assert.equal(outcome.id,active.passId);active=null;}},workspaceForTask:async()=>process.cwd(),workspaceForIntake:async()=>process.cwd(),
    timeZone:'Europe/Moscow',now:()=>clock,readSourceMonitor:async()=>({schemaVersion:1,baselineOnly:poll===0,nextCursor:String(poll++),hasMore:false,
      events:poll===1?[]:[{id:`message:123:${poll}`,revision:String(poll).repeat(64),conversationKey:key,kind:'new',outgoing:false,
        forwarded:false,viaBot:false,senderNamespace:'telegram_user_id',senderUserId:'123'}]})};
  let coordinator=createAssistantCoordinator(options);t.after(async()=>{await coordinator.close();database.close();});
  await coordinator.pollOnce();clock+=300000;await coordinator.pollOnce();
  assert.equal(database.prepare('SELECT count(*) AS n FROM assistant_owner_intakes').get().n,1);
  assert.equal((await coordinator.workOnce()).kind,'source_intake');assert.equal(created,1);assert.equal(active,null);
  const firstTask=[...tasks.keys()][0];
  const readsBefore=intakeReads;
  assert.equal((await coordinator.workOnce()).kind,'provision','native task enters ordinary permanent chat provision');
  assert.equal(intakeReads-readsBefore,1,'created receipt without a task chat is read only once before ordinary provision');
  await coordinator.workOnce().catch(error=>assert.match(error.code,/SETUP_REQUIRED|UNAVAILABLE/u)); // Task business is deliberately not mocked as success.
  const event=database.prepare('SELECT * FROM assistant_inbox_events WHERE task_id=?').get(firstTask);
  assert.ok(event?.route_id);assert.equal(event.processed,0);assert.equal(event.acked,0,'creating a task never earns ACK');
  await coordinator.close();coordinator=createAssistantCoordinator(options);
  const countBefore=created;await coordinator.workOnce().catch(()=>{});assert.equal(created,countBefore,'restart never repeats native create');
  // A second independent command in the SAME private owner conversation gets
  // another task, while reusing the restricted intake chat. No conversation
  // route can hijack it into the first task.
  clock+=300000;await coordinator.pollOnce();
  await coordinator.workOnce().catch(()=>{});
  assert.equal(created,2);assert.equal(intakeTurns,2);assert.equal(provisions,2,'one intake chat plus first permanent task chat');
  assert.equal(new Set([...intakes.values()].map(value=>value.threadId)).size,1);
  assert.equal(database.prepare('SELECT count(*) AS n FROM assistant_owner_intakes WHERE outcome_state=\'created\'').get().n,2);
});


for(const firstState of ['policy_blocked','waiting_owner','unknown_provision','unknown_provision_no_thread',
  'created_revoked','created_changed','created_denied','created_network'])test(`${firstState} owner intake retains its event while another company intake and ordinary task proceed`,async t=>{
  const f=fixture(t);await f.coordinator.close();
  const companyB=randomUUID(),memberB=randomUUID(),taskB=randomUUID(),bindingB=randomUUID(),ownerId=randomUUID();
  const second={id:bindingB,taskId:taskB,state:'accepted',revision:0},account=randomUUID(),receipts=new Map();
  f.execution.state='policy_blocked';
  const execution={...f.execution.configuration};
  f.options.client.companies=async()=>[{companyId:f.companyId,memberId:f.memberId,execution:f.execution},
    {companyId:companyB,memberId:memberB,execution:{state:'ready',configuration:execution}}];
  f.options.client.tasks=async id=>({bindings:[id===companyB?second:f.authority],nextCursor:null});
  f.options.client.task=async id=>{
    if(id===f.companyId&&['created_denied','created_network'].includes(firstState))throw Object.assign(new Error('fixture'),
      {code:firstState==='created_denied'?'ASSISTANT_ACCESS_DENIED':'ASSISTANT_TRANSPORT_UNAVAILABLE',status:firstState==='created_denied'?403:503});
    return {...(id===companyB?second:f.authority),execution:id===companyB?{state:'ready',configuration:execution}:f.execution};
  };
  if(firstState==='created_revoked')f.authority.state='revoked';
  if(firstState==='created_changed')f.authority.revision=1;
  const sources=[f.companyId,companyB].map(companyId=>({id:randomUUID(),companyId,deviceId:f.identity.deviceId,
    localAccountId:account,projectId:null,skillId:'telegram-mtproto',state:'active',revision:0,ownerTaskIntakeAllowed:true}));
  f.options.client.sourceAccounts=async companyId=>sources.filter(row=>row.companyId===companyId);
  f.options.client.ownerIdentities=async()=>({bindingRevision:'a'.repeat(64),identities:[{provider:'telegram',bindingId:ownerId,externalUserId:'123'}]});
  f.options.client.beginSourceIntake=async input=>{assert.equal(input.companyId,companyB);
    const value={schemaVersion:1,id:input.intakeId,companyId:companyB,sourceId:input.sourceId,sourceRevision:0,
      eventId:input.eventId,threadId:input.threadId,state:'leased',leaseExpiresAt:'2099-01-01T00:00:00.000Z',
      taskId:null,receiptId:null,execution,readConfirmed:false};receipts.set(input.intakeId,value);return value;};
  let firstReads=0;
  f.options.client.readSourceIntake=async input=>{if(input.companyId===f.companyId)firstReads++;return receipts.get(input.intakeId);};
  f.options.client.sourceRoutes=async()=>{throw new Error('invalid created binding must never reach route/ACK');};
  let active=null,intakeRuns=0;
  f.options.passHost={readActivePass:async()=>active,activatePass:async pass=>{assert.equal(active,null);active=pass;},
    releasePass:async receipt=>{assert.equal(receipt.id,active.passId);active=null;}};
  f.options.workspaceForIntake=async()=>process.cwd();
  f.options.native.run=async(input,options)=>{assert.equal(input.intakeContext.companyId,companyB);options.startInvocation();intakeRuns++;
    const value=receipts.get(input.intakeContext.intakeId);Object.assign(value,{state:'ignored',receiptId:randomUUID(),readConfirmed:true});
    const result={state:'completed',receipt:`codex:${input.threadId}:${randomUUID()}`};f.deliveries.set(input.deliveryId,result);return result;};
  const inbox=createAssistantInbox({database:f.database,now:f.options.now});
  for(const [index,row]of sources.entries()){
    const source={...f.identity,companyId:row.companyId,provider:'telegram',accountId:account,bindingId:row.id};delete source.deviceId;
    inbox.register(source);inbox.observeExternalSourceRevision(source,0);
    const poll=inbox.claimPoll(source);
    inbox.commitPage(source,{...poll,nextCursor:'1',hasMore:false,events:[{id:`message:123:${index+1}`,revision:'a'.repeat(64),
      taskId:null,wake:false,providerWake:true,ownerIdentityId:ownerId,conversationKey:`telegram-conversation/v1.${'b'.repeat(64)}`}]});
    f.advance(1);
  }
  let recovering=null;
  if(firstState==='waiting_owner'||firstState.startsWith('unknown_provision')||firstState.startsWith('created_')){
    const pending=inbox.ownerIntakes().find(row=>row.scope.companyId===f.companyId);
    inbox.prepareOwnerIntake(pending.id);inbox.startOwnerIntakeProvision(pending.id);
    if(firstState!=='unknown_provision_no_thread')inbox.bindOwnerIntakeThread(pending.id,randomUUID());
    if(firstState.startsWith('unknown_provision')){recovering=inbox.ownerIntake(pending.id);inbox.deferOwnerIntake(pending.id);}
    else{inbox.readyOwnerIntake(pending.id);inbox.startOwnerIntake(pending.id);
    const row=inbox.ownerIntake(pending.id),receiptId=randomUUID(),state=firstState.startsWith('created_')?'created':'waiting_owner';
    inbox.finishOwnerIntake(row.id,{state,receiptId});
    receipts.set(row.id,{schemaVersion:1,id:row.id,companyId:f.companyId,sourceId:row.scope.bindingId,sourceRevision:0,
      eventId:row.original_event_id,threadId:row.thread_id,state,leaseExpiresAt:'2099-01-01T00:00:00.000Z',
      taskId:state==='created'?f.taskId:null,receiptId,execution,readConfirmed:true,
      ...(state==='created'?{route:{id:randomUUID(),bindingId:f.authority.id,bindingRevision:0}}:{})});
    f.advance(300000); // The oldest unanswered/closed receipt is due on this worker.
    }
  }
  let recoveryReads=0;const read=f.options.native.readDelivery;
  f.options.native.readDelivery=async(thread,id,options)=>{if(id===recovering?.provision_id)recoveryReads++;return read(thread,id,options);};
  const coordinator=createAssistantCoordinator(f.options);try{await coordinator.pollOnce();
  if(recovering){
    assert.equal((await coordinator.workOnce()).state,'blocked');assert.equal(intakeRuns,0);assert.equal(f.counts().provisions,0);
    assert.equal(inbox.ownerIntake(recovering.id).native_started,1,'policy change cannot erase the original unknown invocation');
    assert.equal(recoveryReads,recovering.thread_id?1:0);
    if(!recovering.thread_id)return; // No read-back target means no automatic replacement chat.
    f.deliveries.set(recovering.provision_id,{state:'completed',threadId:recovering.thread_id,receipt:`codex:${recovering.thread_id}:${randomUUID()}`});
  }
  assert.equal((await coordinator.workOnce()).kind,'source_intake');assert.equal(intakeRuns,1);assert.equal(active,null);
  const retained=inbox.ownerIntakes().find(row=>row.scope.companyId===f.companyId);
  assert.equal(retained.state,firstState==='waiting_owner'?'waiting_owner':firstState.startsWith('created_')?'complete':recovering?'ready':'pending');
  assert.equal(retained.native_started,firstState==='waiting_owner'||firstState.startsWith('created_')?1:0);
  assert.equal(typeof retained.thread_id,firstState==='waiting_owner'||firstState.startsWith('created_')||recovering?'string':'object');
  if(recovering)assert.equal(recoveryReads,2,'only exact positive read-back permits the other company to continue');
  assert.ok(retained.next_check_at>0);
  if(firstState.startsWith('created_')){
    assert.equal(firstReads,1,'positive created receipt with lost binding is deferred once, never recreated');
    assert.ok(f.notifications.some(value=>value.code===(firstState==='created_denied'?'ASSISTANT_ACCESS_DENIED'
      :firstState==='created_network'?'ASSISTANT_TRANSPORT_UNAVAILABLE':'ASSISTANT_INTAKE_CHANGED')),'typed ACL/transport cause survives the shared followup');
    assert.equal(retained.settled,0,'inaccessible positive receipt remains available for later exact reconciliation');
  }
  assert.equal((await coordinator.workOnce()).kind,'provision');
  assert.equal(coordinator.status().length,1);assert.equal(coordinator.status()[0].companyId,companyB);
  assert.equal(f.database.prepare('SELECT processed FROM assistant_inbox_events WHERE source_key=?').get(retained.source_key).processed,0);
  }finally{await coordinator.close();}
});


for(const nativeState of ['failed','completed','unknown','not_started'])test(`positive native cancellation dominates ${nativeState} owned turn and releases only its exact receipt`,async t=>{
 const f=fixture(t);await f.coordinator.close();const sourceId=randomUUID(),accountId=randomUUID(),ownerId=randomUUID();
 const row={id:sourceId,companyId:f.companyId,deviceId:f.identity.deviceId,localAccountId:accountId,projectId:null,
  skillId:'telegram-mtproto',state:'active',revision:0,ownerTaskIntakeAllowed:true};let outcome,active=null,stopped=false;
 f.options.client.companies=async()=>[{companyId:f.companyId,memberId:f.memberId,execution:f.execution}];
 f.options.client.tasks=async()=>({bindings:[],nextCursor:null});f.options.client.sourceAccounts=async()=>[row];
 f.options.client.ownerIdentities=async()=>({bindingRevision:'a'.repeat(64),identities:[{provider:'telegram',bindingId:ownerId,externalUserId:'123'}]});
 f.options.client.beginSourceIntake=async input=>(outcome={schemaVersion:1,id:input.intakeId,companyId:f.companyId,sourceId,sourceRevision:0,
  eventId:input.eventId,threadId:input.threadId,state:'leased',leaseExpiresAt:'2099-01-01T00:00:00.000Z',taskId:null,receiptId:null,
  execution:f.execution.configuration,readConfirmed:false});
 f.options.client.readSourceIntake=async()=>structuredClone(outcome);
 f.options.passHost={readActivePass:async()=>active,activatePass:async value=>{active=value;},
  releasePass:async value=>{assert.equal(value.id,active.passId);assert.equal(value.receiptId,outcome.receiptId);active=null;}};
 f.options.workspaceForIntake=async()=>process.cwd();f.options.watchIntervalMs=100;
 f.options.native.run=async(input,options)=>{if(nativeState!=='not_started')options.startInvocation();Object.assign(outcome,{state:'cancelled',receiptId:randomUUID()});
  await new Promise(resolve=>options.signal.addEventListener('abort',()=>{stopped=true;resolve();},{once:true}));
  if(!['unknown','not_started'].includes(nativeState))f.deliveries.set(input.deliveryId,{state:nativeState,receipt:`codex:${input.threadId}:${randomUUID()}`});
  return {state:nativeState==='unknown'?'failed':nativeState};};
 const inbox=createAssistantInbox({database:f.database,now:f.options.now}),source={origin:f.identity.origin,assistantId:f.identity.assistantId,
  companyId:f.companyId,provider:'telegram',accountId,bindingId:sourceId};
 inbox.register(source);inbox.observeExternalSourceRevision(source,0);
 inbox.commitPage(source,{...inbox.claimPoll(source),nextCursor:'1',hasMore:false,events:[{id:'message:123:1',revision:'a'.repeat(64),
  taskId:null,wake:false,providerWake:true,ownerIdentityId:ownerId,conversationKey:`telegram-conversation/v1.${'a'.repeat(64)}`}]});
 const coordinator=createAssistantCoordinator(f.options);try{
  await coordinator.pollOnce();assert.equal((await coordinator.workOnce()).state,nativeState==='unknown'?'blocked':'cancelled');assert.equal(stopped,true);
  if(nativeState==='unknown'){
    assert.ok(active,'an aborted adapter is not a native terminal marker');
    const original=inbox.ownerIntake(active.passId);assert.equal(original.state,'uncertain');
    assert.equal((await coordinator.workOnce()).state,'blocked');
    f.deliveries.set(original.delivery_id,{state:'failed',receipt:`codex:${original.thread_id}:${randomUUID()}`});
    assert.equal(await coordinator.workOnce(),null,'only the exact native terminal read-back releases cancellation');
  }
  assert.equal(active,null);
  if(nativeState==='not_started')assert.equal(f.deliveries.size,1,'only the completed tool-free provision exists, no model turn invented');
  const closed=f.database.prepare('SELECT state,outcome_state,outcome_receipt FROM assistant_owner_intakes').get();
  assert.equal(closed.state,'complete');assert.equal(closed.outcome_state,'cancelled');assert.equal(closed.outcome_receipt,outcome.receiptId);
  assert.equal(await coordinator.workOnce(),null);assert.equal(f.counts().provisions,1,'cancelled original is not provisioned again');
  assert.deepEqual({...f.database.prepare('SELECT processed,acked FROM assistant_inbox_events').get()},{processed:0,acked:0});
 }finally{await coordinator.close();}
});


for(const recovery of ['source_paused','lease_expired','release_pending'])test(`${recovery} after restart retains the original pass until exact native terminal read-back`,async t=>{
  const f=fixture(t);await f.coordinator.close();
  const companyA=randomUUID(),memberA=randomUUID(),sourceId=randomUUID(),accountId=randomUUID(),ownerId=randomUUID();
  const source={origin:f.identity.origin,assistantId:f.identity.assistantId,companyId:companyA,provider:'telegram',accountId,bindingId:sourceId};
  const sourceRow={id:sourceId,companyId:companyA,deviceId:f.identity.deviceId,localAccountId:accountId,projectId:null,
    skillId:'telegram-mtproto',state:recovery==='source_paused'?'paused':'active',revision:0,ownerTaskIntakeAllowed:true};
  f.options.client.companies=async()=>[{companyId:companyA,memberId:memberA,execution:f.execution},
    {companyId:f.companyId,memberId:f.memberId,execution:f.execution}];
  f.options.client.tasks=async companyId=>({bindings:companyId===f.companyId?[f.authority]:[],nextCursor:null});
  f.options.client.sourceAccounts=async companyId=>companyId===companyA?[sourceRow]:[];
  f.options.workspaceForIntake=async()=>process.cwd();
  const inbox=createAssistantInbox({database:f.database,now:f.options.now});
  inbox.register(source);inbox.observeExternalSourceRevision(source,0);
  inbox.commitPage(source,{...inbox.claimPoll(source),nextCursor:'1',hasMore:false,events:[{id:'message:123:1',revision:'a'.repeat(64),
    taskId:null,wake:false,providerWake:true,ownerIdentityId:ownerId,conversationKey:`telegram-conversation/v1.${'a'.repeat(64)}`}]});
  let row=inbox.ownerIntakes()[0];inbox.prepareOwnerIntake(row.id);inbox.startOwnerIntakeProvision(row.id);
  inbox.bindOwnerIntakeThread(row.id,randomUUID());inbox.readyOwnerIntake(row.id);inbox.startOwnerIntake(row.id);
  inbox.uncertainOwnerIntake(row.id);row=inbox.ownerIntake(row.id);
  let active={schemaVersion:1,kind:'source_intake',assistantId:f.identity.assistantId,deviceId:f.identity.deviceId,companyId:companyA,
    sourceId,sourceRevision:0,passId:row.id,deliveryId:row.delivery_id,eventId:row.original_event_id,threadId:row.thread_id};
  let outcome={schemaVersion:1,id:row.id,companyId:companyA,sourceId,sourceRevision:0,eventId:row.original_event_id,
    threadId:row.thread_id,state:'leased',leaseExpiresAt:new Date(f.options.now()-1).toISOString(),taskId:null,receiptId:null,
    execution:f.execution.configuration,readConfirmed:true};
  if(recovery==='release_pending'){
    Object.assign(outcome,{state:'cancelled',receiptId:randomUUID()});inbox.finishOwnerIntake(row.id,outcome);
  }
  let terminal=false,nativeReads=0,cancellations=0,releases=0;
  f.options.native.readDelivery=async(thread,id)=>{
    assert.equal(thread,row.thread_id);assert.equal(id,row.delivery_id);nativeReads++;
    return terminal?{state:'failed',receipt:`codex:${thread}:${randomUUID()}`}:{state:'running'};
  };
  f.options.client.readSourceIntake=async()=>structuredClone(outcome);
  f.options.client.cancelSourceIntake=async()=>{cancellations++;Object.assign(outcome,{state:'cancelled',receiptId:outcome.receiptId??randomUUID()});return structuredClone(outcome);};
  f.options.passHost={readActivePass:async()=>active,activatePass:async()=>{throw new Error('old pass must not be replaced');},
    releasePass:async value=>{assert.equal(value.id,row.id);assert.equal(value.receiptId,outcome.receiptId);assert.equal(terminal,true);releases++;active=null;}};
  let coordinator=createAssistantCoordinator(f.options);
  try{
    await coordinator.pollOnce();assert.equal((await coordinator.workOnce()).state,'blocked');
    assert.equal(f.counts().provisions,0);assert.equal(releases,0);assert.equal(active.passId,row.id);
    assert.equal(inbox.ownerIntake(row.id).state,recovery==='release_pending'?'complete':'uncertain');
    assert.equal(nativeReads,1);assert.equal(cancellations,recovery==='release_pending'?0:1);
    // A fresh coordinator sees the SAME positive backend cancellation, but it
    // still cannot substitute that domain receipt for the original live turn.
    await coordinator.close();coordinator=createAssistantCoordinator(f.options);
    assert.equal((await coordinator.workOnce()).state,'blocked');assert.equal(releases,0);assert.equal(f.counts().provisions,0);
    terminal=true;
    assert.equal((await coordinator.workOnce()).kind,'provision','only terminal read-back releases unrelated task work');
    assert.equal(releases,1);assert.equal(active,null);assert.equal(f.counts().provisions,1);
    const closed=inbox.ownerIntake(row.id);assert.equal(closed.state,'complete');assert.equal(closed.outcome_state,'cancelled');
    assert.equal(closed.outcome_receipt,outcome.receiptId);
    assert.deepEqual({...f.database.prepare('SELECT processed,acked FROM assistant_inbox_events WHERE event_key=?').get(row.event_key)},
      {processed:0,acked:0});
  }finally{await coordinator.close();}
});


for(const provider of ['telegram','email','max'])test(`${provider} first outgoing source hint binds before a reply resumes the SAME permanent chat`,async t=>{
  const f=await externalFixture(t),key=`${provider}-conversation/v1.${'f'.repeat(64)}`;
  f.row.skillId={telegram:'telegram-mtproto',email:'email-imap-smtp',max:'max-web'}[provider];
  if(provider==='max')f.row.maxChatUrl='https://web.max.ru/123';
  let bound=null,sends=0,replies=0;
  f.options.client.sourceRoutes=async input=>bound&&(input.routeIds?.includes(bound.id)||input.conversationKeys?.includes(key))?[bound]:[];
  const observer=createAssistantOutgoingConversationObserver({identity:f.identity,client:f.options.client,
    host:{readActivePass:async()=>f.activePass()},now:f.options.now});
  try{
    await f.coordinator.pollOnce();await f.coordinator.workOnce();
    const threadId=f.coordinator.status()[0].threadId;
    f.options.native.run=async(input,options)=>{
      assert.equal(input.threadId,threadId);options.startInvocation();
      if(!bound){
        const ticket=await observer.prepare({artifact:{skillId:f.row.skillId},executionContext:{companyId:f.companyId,projectId:null,account:{id:f.row.localAccountId}},
          runtimeArguments:['send','--chat',provider==='max'?f.row.maxChatUrl:'123','--conversation-reference']});
        sends++;
        const response=await observer.project(ticket,{stdout:JSON.stringify({sent:true,conversationReference:{available:true,conversationKey:key}})});
        const hint=JSON.parse(response.stdout).assistantSourceConversation;
        assert.equal(hint.state,'ready');assert.deepEqual(hint.candidates,[{sourceId:f.row.id,sourceRevision:0}]);
        // Runtime fixture stands in for the ALREADY separately PG-tested native
        // bind: only its exact provider/native coordinates enter this route.
        bound={id:randomUUID(),sourceId:hint.candidates[0].sourceId,sourceRevision:0,conversationKey:hint.conversationKey,
          bindingId:f.bindingId,bindingRevision:0,taskId:f.taskId};
      }else{
        replies++;assert.equal(input.taskContext.sourceReferences.length,1);
        assert.equal(input.taskContext.sourceReferences[0].conversationKey,key);
      }
      const result={state:'completed',receipt:`codex:${threadId}:${randomUUID()}`};f.deliveries.set(input.deliveryId,result);return result;
    };
    f.events.push({id:randomUUID(),revision:'first-outgoing',taskId:f.taskId,wake:true});f.advance(300000);
    await f.coordinator.pollOnce();await f.coordinator.workOnce();assert.equal(sends,1);assert.ok(bound);
    f.read(async()=>({schemaVersion:1,baselineOnly:false,nextCursor:'reply',hasMore:false,channelsToSync:[],unresolvedDeletionIds:[],
      events:[{id:provider==='email'?'uid:17:11':'message:123:5',revision:'a'.repeat(64),kind:'new',outgoing:false,conversationKey:key}]}));
    f.advance(300000);await f.coordinator.pollOnce();await f.coordinator.workOnce();
    assert.equal(replies,1);assert.equal(sends,1);assert.equal(f.counts().provisions,1);
    assert.equal(f.coordinator.status()[0].threadId,threadId);
    assert.equal(f.inbox.claimAcknowledgements(f.scope()),null,'route/hint is not read or processing proof');
  }finally{await f.coordinator.close();}
});

for(const provider of ['telegram','email','max'])test(`${provider} existing-task triage freezes a batch, selects company before chat and routes without ACK`,async t=>{
  const database=new DatabaseSync(':memory:');let clock=Date.now(),active=null,provisions=0,triageTurns=0,wait=true;
  const identity={origin:'https://assistant.test',assistantId:randomUUID(),deviceId:randomUUID()},companyId=randomUUID(),memberId=randomUUID();
  const sourceId=randomUUID(),accountId=randomUUID(),taskId=randomUUID(),bindingId=randomUUID(),key=`${provider}-conversation/v1.${'8'.repeat(64)}`;
  const skillId={telegram:'telegram-mtproto',email:'email-imap-smtp',max:'max-web'}[provider];
  const execution={modelId:'gpt-6.1-sol',effortLevel:'high',revision:1};
  const source={id:sourceId,companyId,deviceId:identity.deviceId,localAccountId:accountId,projectId:null,skillId,state:'active',revision:0,
    ...(provider==='max'?{maxChatUrl:'https://web.max.ru/123'}:{})};
  const intake=new Map(),markers=new Map(),begins=[];
  const client={identity,heartbeat:async()=>{},companies:async()=>[{companyId,memberId,execution:{state:'ready',configuration:execution}}],
    tasks:async()=>({bindings:[{id:bindingId,taskId,state:'accepted',revision:0}],nextCursor:null}),
    task:async()=>({id:bindingId,taskId,state:'accepted',revision:0,execution:{state:'ready',configuration:execution}}),
    poll:async()=>({events:[],nextCursor:'0',hasMore:false}),acknowledge:async()=>({acknowledged:0}),sourceAccounts:async()=>[{...source}],
    sourceRoutes:async input=>input.conversationKeys?[]:[...intake.values()].filter(value=>value.route&&input.routeIds.includes(value.route.id))
      .map(value=>({...value.route,taskId})),
    beginSourceIntake:async input=>{
      begins.push(structuredClone(input));assert.equal(input.kind,'route_existing');assert.equal(input.ownerIdentityId,undefined);
      if(!intake.has(input.intakeId)){
        assert.equal(input.threadId,null);assert.equal(provisions,0,'native company selection precedes tool-free chat');
        intake.set(input.intakeId,{schemaVersion:1,kind:'route_existing',id:input.intakeId,companyId,sourceId,sourceRevision:0,
          eventId:input.eventId,eventIds:input.eventIds,threadId:null,state:'waiting_owner',companySelectionRequired:true,
          leaseExpiresAt:new Date(clock+1800000).toISOString(),taskId:null,receiptId:randomUUID(),readConfirmed:false,execution:null});
      }
      const result=intake.get(input.intakeId);if(input.threadId!==null){assert.equal(wait,false);result.threadId=input.threadId;}
      return structuredClone(result);
    },readSourceIntake:async input=>structuredClone(intake.get(input.intakeId)),
    claimTaskHost:async input=>({bindingId:input.bindingId,provisionId:input.provisionId,threadId:null}),reportSchedule:async input=>({sequence:input.sequence})};
  const native={ready:async()=>true,readDelivery:async(_thread,id)=>markers.get(id)??{state:'uncertain'},
    provision:async(input,options)=>{provisions++;options.startInvocation();const threadId=randomUUID();options.onThreadStarted(threadId);
      const result={state:'completed',threadId,receipt:'fixture-provision'};markers.set(input.deliveryId,result);return result;},
    run:async(input,options)=>{
      if(!input.intakeContext)throw Object.assign(new Error(),{code:'ASSISTANT_FIXTURE_TASK_BOUNDARY'});
      options.startInvocation();triageTurns++;assert.equal(input.intakeContext.intakeKind,'route_existing');
      assert.equal(input.intakeContext.eventIds.length,2);assert.deepEqual(active.eventIds,input.intakeContext.eventIds);
      const current=intake.get(input.intakeContext.intakeId);Object.assign(current,{state:'routed',taskId,receiptId:randomUUID(),readConfirmed:true,
        route:{id:randomUUID(),sourceId,sourceRevision:0,bindingId,bindingRevision:0,conversationKey:key}});
      const result={state:'completed',receipt:'fixture-triage'};markers.set(input.deliveryId,result);return result;
    }};
  const options={database,client,native,passHost:{readActivePass:async()=>active,activatePass:async pass=>{assert.equal(active,null);active=pass;},
    releasePass:async outcome=>{assert.equal(outcome.id,active.passId);active=null;}},workspaceForTask:async()=>process.cwd(),workspaceForIntake:async()=>process.cwd(),
    timeZone:'Europe/Moscow',now:()=>clock};
  let coordinator=createAssistantCoordinator(options);t.after(async()=>{await coordinator.close();database.close();});
  await coordinator.pollOnce();
  const inbox=createAssistantInbox({database,now:()=>clock}),scope={origin:identity.origin,assistantId:identity.assistantId,companyId,provider,accountId,bindingId:sourceId};
  inbox.register(scope);inbox.observeExternalSourceRevision(scope,0);
  const poll=inbox.claimPoll(scope),events=[1,2].map(i=>({id:provider==='email'?`uid:12:${i}`:`message:123:${i}`,revision:String(i).repeat(64),
    taskId:null,wake:false,providerWake:true,conversationKey:key}));
  inbox.commitPage(scope,{...poll,nextCursor:'2',hasMore:false,events});
  inbox.queueExistingTaskIntakes(scope,{sourceRevision:0,eventKeys:inbox.pendingExternalRoutes(scope).map(row=>row.event_key)});
  await coordinator.workOnce();assert.equal(provisions,1,'ordinary accepted task may provision while the source waits');assert.equal(triageTurns,0);assert.equal(active,null);
  const original=inbox.ownerIntakes()[0];assert.equal(original.frozen,1);assert.equal(original.state,'waiting_owner');
  const selected=intake.get(original.id);wait=false;Object.assign(selected,{state:'leased',execution,receiptId:null});delete selected.companySelectionRequired;
  clock+=300001;assert.equal((await coordinator.workOnce()).kind,'source_intake');assert.equal(triageTurns,1);assert.equal(provisions,2,'one permanent task chat and one selected-company triage chat');
  assert.equal(begins[0].threadId,null);assert.ok(begins.at(-1).threadId);assert.equal(active,null);
  await coordinator.workOnce().catch(error=>assert.match(error.code,/BOUNDARY|SETUP_REQUIRED|UNAVAILABLE/u));
  const routed=database.prepare('SELECT * FROM assistant_inbox_events WHERE source_key=?').all(original.source_key);
  assert.equal(routed.length,2);assert.ok(routed.every(row=>row.task_id===taskId&&row.route_id&&row.processed===0&&row.acked===0));
  await coordinator.close();coordinator=createAssistantCoordinator(options);
  await coordinator.workOnce().catch(()=>{});assert.equal(triageTurns,1,'restart never reclassifies a frozen original batch');
});

test('complete native inventory chooses one local triage queue per physical account; frozen follow-ups cannot create cross-company questions',async t=>{
 for(const incomplete of [false,true]){
  const database=new DatabaseSync(':memory:');let clock=Date.now(),sequence=1;
  const identity={origin:'https://assistant.test',assistantId:randomUUID(),deviceId:randomUUID()},companies=[randomUUID(),randomUUID()],accountId=randomUUID();
  const rows=companies.map((companyId,index)=>({id:`00000000-0000-4000-8000-00000000000${index+1}`,companyId,deviceId:identity.deviceId,localAccountId:accountId,
    projectId:null,skillId:'telegram-mtproto',state:'active',revision:0}));
  const client={identity,heartbeat:async()=>{},companies:async()=>companies.map(companyId=>({companyId,memberId:randomUUID()})),
    tasks:async()=>({bindings:[],nextCursor:null}),poll:async()=>({events:[],nextCursor:'0',hasMore:false}),acknowledge:async()=>({acknowledged:0}),
    sourceAccounts:async companyId=>{if(incomplete&&companyId===companies[1])throw Object.assign(new Error(),{code:'ASSISTANT_TRANSPORT_UNAVAILABLE'});return rows.filter(row=>row.companyId===companyId);},
    sourceRoutes:async()=>[],beginSourceIntake:async()=>assert.fail('polling must not invoke a model/native intake')};
  const options={database,client,native:{ready:async()=>assert.fail('polling cannot start Codex')},workspaceForTask:async()=>process.cwd(),timeZone:'Europe/Moscow',now:()=>clock,
    readSourceMonitor:async input=>({schemaVersion:1,baselineOnly:false,nextCursor:String(sequence),hasMore:false,
      events:[{id:`message:123:${sequence}`,revision:String(sequence).repeat(64),kind:'new',outgoing:false,
        conversationKey:`telegram-conversation/v1.${(input.sourceId===rows[0].id?'a':'b').repeat(64)}`}]})};
  const coordinator=createAssistantCoordinator(options);
  try{
    await coordinator.pollOnce();const inbox=createAssistantInbox({database,now:()=>clock});
    if(incomplete){assert.equal(inbox.ownerIntakes().length,0,'partial inventory never becomes a singleton company choice');continue;}
    assert.equal(inbox.ownerIntakes().length,1);const row=inbox.ownerIntakes()[0];assert.equal(row.scope.bindingId,rows[0].id);
    inbox.freezeExistingTaskIntake(row.id);sequence=2;clock+=300001;await coordinator.pollOnce();
    assert.equal(inbox.ownerIntakes().length,1,'second-company scoped key cannot create another follow-up classification');
    assert.equal(inbox.ownerIntake(row.id).eventIds.length,1,'frozen batch remains immutable');
  }finally{await coordinator.close();database.close();}
 }
});


test('MAX complete account sync persists original child seed, seen-elsewhere events and restart dedup in SAME SQLite streams',async t=>{
  const f=await externalFixture(t),chat='77',url='https://web.max.ru/77';f.row.skillId='max-web';
  const position=time=>Buffer.from(JSON.stringify({v:3,scope:'f'.repeat(64),startedAt:time})).toString('base64url');
  try{
    f.read(async source=>{assert.equal(source.chat,undefined);assert.equal(source.cursor,null);return {baselineOnly:true,events:[],
      nextCursor:position(100),initialAccountCursor:position(100),conversationsToSync:[chat],hasMore:false};});
    await f.coordinator.pollOnce();assert.equal(f.position(),position(100));assert.equal(f.inbox.hasPendingStreams(f.scope()),true);
    await f.restart();f.advance(1);
    f.read(async source=>{assert.equal(source.chat,url);assert.equal(source.initialAccountCursor,position(100));assert.equal(source.initialUnread,undefined);
      assert.equal(source.cursor,null);return {baselineOnly:false,initialAccountBackfill:true,events:[{id:'message:77:11',revision:'a'.repeat(64)}],nextCursor:'native-history-1',hasMore:true};});
    await f.coordinator.pollOnce();await f.restart();f.advance(1);
    f.read(async source=>{assert.equal(source.chat,url);assert.equal(source.cursor,'native-history-1');assert.equal(source.initialAccountCursor,undefined);
      return {baselineOnly:false,events:[{id:'message:77:12',revision:'b'.repeat(64)}],nextCursor:'native-history-2',hasMore:false};});
    await f.coordinator.pollOnce();assert.equal(f.inbox.hasPendingStreams(f.scope()),false);
    // Native account changes, rather than an unread counter, reactivate the
    // exact same stream after a message was read on another device.
    f.advance(300000);f.read(async source=>{assert.equal(source.chat,undefined);assert.equal(source.cursor,position(100));
      return {baselineOnly:true,events:[],nextCursor:position(200),initialAccountCursor:position(100),conversationsToSync:[chat],hasMore:false};});
    await f.coordinator.pollOnce();await f.restart();f.advance(1);
    f.read(async source=>{assert.equal(source.cursor,'native-history-2');assert.equal(source.initialAccountCursor,undefined);
      return {baselineOnly:false,events:[{id:'message:77:12',revision:'b'.repeat(64)},{id:'message:77:13',revision:'c'.repeat(64)}],nextCursor:'native-history-3',hasMore:false};});
    await f.coordinator.pollOnce();assert.equal(f.database.prepare('SELECT count(*) n FROM assistant_inbox_events').get().n,3);
    assert.equal(f.database.prepare('SELECT initial_cursor FROM assistant_inbox_streams').get().initial_cursor,position(100));
    assert.ok(f.database.prepare('SELECT task_id,wake,processed,acked FROM assistant_inbox_events').all().every(r=>r.task_id===null&&!r.wake&&!r.processed&&!r.acked));
    assert.equal(f.counts().runs,0);assert.equal(f.counts().acks,0);
  }finally{await f.coordinator.close();}
});

test('MAX partial inventory, wrong child seed or paused registration cannot advance account or child cursor',async t=>{
  const f=await externalFixture(t);f.row.skillId='max-web';
  try{
    for(const result of [{baselineOnly:false,events:[],nextCursor:'bad',hasMore:false},
      {baselineOnly:true,events:[],nextCursor:'bad',initialAccountCursor:'seed',conversationsToSync:['77','77'],hasMore:false},
      {baselineOnly:true,events:[],nextCursor:'bad',initialAccountCursor:'seed',conversationsToSync:['not-a-native-id'],hasMore:false}]){
      f.read(async()=>result);await f.coordinator.pollOnce();assert.equal(f.position(),null);f.advance(300000);
    }
    f.read(async()=>({baselineOnly:true,events:[],nextCursor:'account',initialAccountCursor:'original',conversationsToSync:['77'],hasMore:false}));
    await f.coordinator.pollOnce();f.advance(1);
    f.read(async()=>({baselineOnly:true,events:[],nextCursor:'silent-child',hasMore:false}));await f.coordinator.pollOnce();
    assert.equal(f.database.prepare('SELECT cursor FROM assistant_inbox_streams').get().cursor,null);
    f.advance(300000);f.read(async()=>{f.row.revision++;f.row.state='paused';return {baselineOnly:true,initialAccountBackfill:true,events:[],nextCursor:'changed',hasMore:false};});
    await f.coordinator.pollOnce();assert.equal(f.position(),'account');assert.equal(f.database.prepare('SELECT count(*) n FROM assistant_inbox_events').get().n,0);
    assert.equal(f.counts().acks,0);
  }finally{await f.coordinator.close();}
});


test('coexisting MAX account root and exact-chat sources select one triage queue from actual native chat coverage',async()=>{
  const database=new DatabaseSync(':memory:');let clock=Date.now(),sequence=1;
  const identity={origin:'https://assistant.test',assistantId:randomUUID(),deviceId:randomUUID()},companyId=randomUUID(),accountId=randomUUID();
  const rows=[null,'https://web.max.ru/123'].map((maxChatUrl,index)=>({id:`00000000-0000-4000-8000-00000000000${index+1}`,
    companyId,deviceId:identity.deviceId,localAccountId:accountId,projectId:null,skillId:'max-web',state:'active',revision:0,maxChatUrl}));
  const key='max-conversation/v1.'+'f'.repeat(64);
  const client={identity,heartbeat:async()=>{},companies:async()=>[{companyId,memberId:randomUUID()}],tasks:async()=>({bindings:[],nextCursor:null}),
    poll:async()=>({events:[],nextCursor:'0',hasMore:false}),acknowledge:async()=>({acknowledged:0}),sourceAccounts:async()=>rows,
    sourceRoutes:async()=>[],beginSourceIntake:async()=>assert.fail('polling cannot start native intake')};
  const coordinator=createAssistantCoordinator({database,client,native:{ready:async()=>assert.fail('polling cannot start Codex')},workspaceForTask:async()=>process.cwd(),timeZone:'Europe/Moscow',now:()=>clock,
    readSourceMonitor:async input=>input.chat===undefined?{baselineOnly:true,events:[],nextCursor:'account-'+sequence,initialAccountCursor:'seed',conversationsToSync:['123'],hasMore:false}:
      {baselineOnly:false,initialAccountBackfill:true,nextCursor:'child-'+sequence,hasMore:false,events:[{id:`message:123:${sequence}`,revision:String(sequence).repeat(64),kind:'new',outgoing:false,conversationKey:key}]}});
  try{
    await coordinator.pollOnce();clock++;await coordinator.pollOnce();const inbox=createAssistantInbox({database,now:()=>clock});
    assert.equal(inbox.ownerIntakes().length,1);const row=inbox.ownerIntakes()[0];assert.equal(row.scope.bindingId,rows[0].id);
    inbox.freezeExistingTaskIntake(row.id);sequence=2;clock+=300001;await coordinator.pollOnce();clock++;await coordinator.pollOnce();
    assert.equal(inbox.ownerIntakes().length,1,'exact-chat copy cannot create a competing frozen follow-up');
    assert.equal(inbox.ownerIntake(row.id).eventIds.length,1);
  }finally{await coordinator.close();database.close();}
});


test('dispatch recovery requires native/business receipt plus durable completion, released pass and no retained uncertainty',async t=>{
  const f=fixture(t);let recoveries=0;
  f.options.onBusinessConfirmed=async()=>{
    recoveries++;assert.equal(f.activePass(),null);
    assert.equal(f.database.prepare("select count(*) n from assistant_inbox_deliveries where state in ('started','uncertain')").get().n,0);
    assert.equal(f.database.prepare('select count(*) n from assistant_inbox_events where processed=0').get().n,0);
  };
  await f.coordinator.close();let next=createAssistantCoordinator(f.options);
  await next.pollOnce();await next.workOnce();assert.equal(recoveries,0,'tool-free READY provisioning never clears an incident');
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:true});f.advance(300001);await next.pollOnce();
  f.failNative(true);await assert.rejects(next.workOnce(),/UNCERTAIN/);assert.equal(recoveries,0);
  await next.close();next=createAssistantCoordinator(f.options);
  // Restart reconciles the original positive native marker/business receipt.
  // No fresh mention/turn is needed and a rejected health report is inert.
  await next.workOnce();assert.equal(recoveries,1);assert.equal(f.counts().runs,1);
  f.options.onBusinessConfirmed=async()=>{throw new Error('synthetic health CAS/network refusal');};
  await next.close();next=createAssistantCoordinator(f.options);
  f.failNative(false);f.events.push({id:randomUUID(),revision:'2',taskId:f.taskId,wake:true});f.advance(300001);
  await next.pollOnce();await next.workOnce();assert.equal(f.counts().runs,2);
  assert.equal(f.activePass(),null,'health failure cannot reopen/replay an already committed pass');
  await next.close();
});


test('another retained device delivery suppresses dispatch recovery even after this task committed',async t=>{
  const f=fixture(t);let recoveries=0;f.options.onBusinessConfirmed=async()=>{recoveries++;};
  await f.coordinator.close();const next=createAssistantCoordinator(f.options);
  await next.pollOnce();await next.workOnce();
  const release=f.options.passHost.releasePass;
  f.options.passHost.releasePass=async receipt=>{
    await release(receipt);
    // Model a second coordinator's already retained fence using the SAME inbox
    // APIs, after the first delivery's local commit. It cannot earn recovery.
    const inbox=createAssistantInbox({database:f.database});
    const pending=await inbox.claimDelivery({authorize:async()=>true,
      scheduledTask:{scope:next.status()[0].source,taskId:f.taskId}});
    inbox.prepareTaskPass(pending.deliveryId);inbox.markDeliveryUncertain(pending.deliveryId);
  };
  f.events.push({id:randomUUID(),revision:'1',taskId:f.taskId,wake:true});f.advance(300001);
  await next.pollOnce();await next.workOnce();assert.equal(f.counts().runs,1);assert.equal(recoveries,0);
  assert.equal((await next.dispatchStatus()).reasons.includes('delivery_uncertain'),true);
  await next.close();
});


test('expired pre-native pass recovery retains SAME SQLite intent across lost response/reopen and launches once',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-pre-native-recovery-'));
  const file=path.join(directory,'inbox.sqlite');let database=new DatabaseSync(file),coordinator;
  const f=fixture(t,{database,ownsDatabase:false});coordinator=f.coordinator;
  const originalRun=f.options.native.run;let attempts=0,nativePreflights=0;const requests=[];
  f.options.native.run=async(input,options)=>{
    nativePreflights++;
    if(nativePreflights===1)throw Object.assign(new Error('closed fixture preflight'),{code:'ASSISTANT_CODEX_UNAVAILABLE'});
    assert.equal(options.requireAbsentMarker,true);
    await options.beforeInvocation();return originalRun(input,options);
  };
  let receipt=null;
  f.options.passHost.recoverPass=async(input,expected)=>{
    assert.deepEqual(expected,f.activePass());requests.push({...input});
    if(!receipt){
      const pass=f.passes.get(expected.deliveryId);assert.equal(pass.leaseRevision,input.expectedLeaseRevision);
      Object.assign(pass,{state:'leased',leaseRevision:input.expectedLeaseRevision+1,leaseExpiresAt:new Date(Date.parse(pass.leaseExpiresAt)+3600000).toISOString()});
      receipt={...pass};throw Object.assign(new Error('closed lost response'),{code:'ASSISTANT_TRANSPORT_UNAVAILABLE'});
    }
    assert.deepEqual(input,requests[0]);return receipt;
  };
  try{
    const original={id:randomUUID(),revision:'original',taskId:f.taskId,wake:true};f.events.push(original);
    await coordinator.pollOnce();await coordinator.workOnce();
    await assert.rejects(coordinator.workOnce(),/DELIVERY_UNCERTAIN/);
    const pass=[...f.passes.values()][0],deliveryId=pass.deliveryId,passId=pass.passId,threadId=pass.threadId;
    assert.equal(database.prepare(`SELECT native_started FROM assistant_inbox_deliveries WHERE kind='task'`).get().native_started,0);
    f.advance(21*60_000);pass.state='review_required';
    await assert.rejects(coordinator.workOnce(),/DELIVERY_UNCERTAIN/);
    const stored=database.prepare(`SELECT pass_recovery_json,delivery_id FROM assistant_inbox_deliveries WHERE kind='task'`).get();
    assert.deepEqual(JSON.parse(stored.pass_recovery_json),{passId,expectedLeaseRevision:0,clientRequestId:requests[0].clientRequestId});
    assert.equal(f.counts().runs,0);assert.equal(database.prepare('SELECT processed FROM assistant_inbox_events').get().processed,0);
    await coordinator.close();database.close();database=new DatabaseSync(file);coordinator=createAssistantCoordinator({...f.options,database});
    await coordinator.workOnce();
    assert.equal(requests.length,2);assert.deepEqual(requests[1],requests[0]);assert.equal(f.counts().runs,1);
    assert.equal(f.passes.size,1);assert.equal(f.passes.get(deliveryId).passId,passId);assert.equal(f.passes.get(deliveryId).threadId,threadId);
    assert.equal(database.prepare(`SELECT count(*) AS n FROM assistant_inbox_deliveries WHERE kind='task'`).get().n,1);
    assert.equal(database.prepare('SELECT processed FROM assistant_inbox_events').get().processed,1);
    assert.equal(database.prepare(`SELECT native_started FROM assistant_inbox_deliveries WHERE kind='task'`).get().native_started,1);
  }finally{await coordinator.close();database.close();await fs.rm(directory,{recursive:true,force:true});}
});

for(const changed of ['native_started','coordinator_lease','protected_pass','model_revision'])
test(`pre-native recovery refuses ${changed} changing while native renew is in flight`,async t=>{
  const f=fixture(t),originalRun=f.options.native.run;let preflights=0,renewals=0;
  f.options.native.run=async(input,options)=>{
    if(++preflights===1)throw Object.assign(new Error('closed preflight fixture'),{code:'ASSISTANT_CODEX_UNAVAILABLE'});
    await options.beforeInvocation();return originalRun(input,options);
  };
  f.options.passHost.recoverPass=async(input,expected)=>{
    renewals++;const pass=f.passes.get(expected.deliveryId);
    Object.assign(pass,{state:'leased',leaseRevision:input.expectedLeaseRevision+1,leaseExpiresAt:'2026-01-01T10:00:00Z'});
    if(changed==='native_started')createAssistantInbox({database:f.database,now:()=>Date.parse('2026-01-01T09:21:00Z')}).startDelivery(expected.deliveryId);
    if(changed==='coordinator_lease')f.database.prepare('UPDATE assistant_coordinator_lease SET token=?,expires_at=?').run(randomUUID(),Date.parse('2026-01-01T10:00:00Z'));
    if(changed==='protected_pass')f.options.passHost.readActivePass=async()=>({...expected,passId:randomUUID()});
    if(changed==='model_revision')f.execution.configuration={...f.execution.configuration,revision:2};
    return {...pass};
  };
  try{
    f.events.push({id:randomUUID(),revision:'original',taskId:f.taskId,wake:true});
    await f.coordinator.pollOnce();await f.coordinator.workOnce();await assert.rejects(f.coordinator.workOnce(),/DELIVERY_UNCERTAIN/);
    const pass=[...f.passes.values()][0];f.advance(21*60000);pass.state='review_required';
    await assert.rejects(f.coordinator.workOnce(),/DELIVERY_UNCERTAIN/);
    assert.equal(renewals,1);assert.equal(f.counts().runs,0,'stale worker cannot cross its native launch boundary');
    assert.equal(f.database.prepare('SELECT processed FROM assistant_inbox_events').get().processed,0);
    const row=f.database.prepare("SELECT native_started,state,pass_recovery_json FROM assistant_inbox_deliveries WHERE kind='task'").get();
    assert.equal(row.state,'uncertain');assert.equal(row.native_started,changed==='native_started'?1:0);assert.ok(row.pass_recovery_json);
    assert.equal(f.passes.size,1);
  }finally{await f.coordinator.close();}
});
