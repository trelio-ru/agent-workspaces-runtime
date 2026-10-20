import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createAssistantCoordinator } from '../host-runtime/scripts/trelio-assistant-coordinator.mjs';

const fixture = t => {
  const database=new DatabaseSync(':memory:');t.after(()=>database.close());
  let clock=Date.parse('2026-01-01T09:00:00Z'),cursor=0,starts=0,provisions=0,runs=0,acks=0;
  const assistantId=randomUUID(),deviceId=randomUUID(),companyId=randomUUID(),memberId=randomUUID(),taskId=randomUUID(),bindingId=randomUUID();
  const authority={id:bindingId,taskId,state:'accepted',revision:0};
  const execution={state:'ready',configuration:{modelId:'gpt-6.1-sol',effortLevel:'high',revision:1}};
  const events=[],deliveries=new Map(),notifications=[]; let nativeFailure=false,inventoryFailure=false;
  const businessReceipts=new Map();
  const identity={origin:'https://assistant.test',assistantId,deviceId};
  const client={identity,heartbeat:async()=>({assistantId,deviceId}),
    companies:async()=>{if(inventoryFailure)throw Object.assign(new Error('transport'),{code:'ASSISTANT_TRANSPORT_UNAVAILABLE'});return[{companyId,memberId}];},
    tasks:async()=>({bindings:[{...authority}],nextCursor:null}),task:async()=>({...authority,execution}),
    poll:async(_company,position)=>{
      const start=position===null?0:Number(position); const page=events.slice(start);
      cursor=events.length;return{events:page.map(event=>({...event,bindingId,bindingRevision:authority.revision,taskState:authority.state})),nextCursor:String(cursor),hasMore:false};
    },
    acknowledge:async(_company,values)=>{acks+=values.length;return{acknowledged:values.length};},
    claimTaskHost:async input=>({bindingId:input.bindingId,provisionId:input.provisionId,threadId:null}),
    reportSchedule:async input=>({sequence:input.sequence}),
    readBusinessOutcome:async input=>{
      if(!businessReceipts.has(input.deliveryId)) businessReceipts.set(input.deliveryId,randomUUID());
      return {schemaVersion:1,state:'confirmed',receiptId:businessReceipts.get(input.deliveryId),...input};
    },
  };
  const native={ready:async()=>true,readDelivery:async(_thread,deliveryId)=>deliveries.get(deliveryId)??{state:'uncertain'},
    provision:async({deliveryId,execution:choice},options)=>{
      assert.deepEqual(choice,execution.configuration);
      provisions++;options.startInvocation();starts++;const threadId=randomUUID();options.onThreadStarted(threadId);
      const result={state:'completed',threadId,receipt:`codex:${threadId}:${randomUUID()}`};deliveries.set(deliveryId,result);return result;
    },
    run:async({threadId,deliveryId,taskContext,execution:choice},options)=>{
      assert.deepEqual(choice,execution.configuration);
      assert.deepEqual(taskContext,{assistantId,companyId,taskId});
      runs++;options.startInvocation();starts++;
      const result={state:'completed',receipt:`codex:${threadId}:${randomUUID()}`};deliveries.set(deliveryId,result);
      if(nativeFailure)throw Object.assign(new Error('response lost'),{code:'ASSISTANT_CODEX_DELIVERY_UNCERTAIN'});
      return result;
    },
  };
  const options={database,client,native,workspaceForTask:async()=>process.cwd(),timeZone:'Europe/Moscow',now:()=>clock,notify:value=>notifications.push(value)};
  const coordinator=createAssistantCoordinator(options);
  return {database,coordinator,options,identity,companyId,memberId,taskId,bindingId,authority,execution,events,deliveries,notifications,
    counts:()=>({starts,provisions,runs,acks}),advance:ms=>{clock+=ms;},failNative:value=>{nativeFailure=value;},failInventory:value=>{inventoryFailure=value;}};
};

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
