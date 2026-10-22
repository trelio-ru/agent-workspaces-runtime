import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createAssistantInbox } from '../host-runtime/scripts/trelio-assistant-inbox.mjs';
import { createAssistantCoordinator } from '../host-runtime/scripts/trelio-assistant-coordinator.mjs';

const fixture = t => {
  const database=new DatabaseSync(':memory:');t.after(()=>database.close());
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
    companies:async()=>{if(inventoryFailure)throw Object.assign(new Error('transport'),{code:'ASSISTANT_TRANSPORT_UNAVAILABLE'});return[{companyId,memberId}];},
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
        leaseExpiresAt:new Date(clock+1200000).toISOString(),state:'leased',execution:execution.configuration});
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
      const {ownerQuestionIds,...task}=taskContext; assert.deepEqual(task,{assistantId,companyId,taskId});
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
    events:[],nextCursor:'baseline',hasMore:false,channelsToSync:[],unresolvedDeletionIds:[]}),reads=0;
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
    return {events:source.cursor===null?[]:[{id:'uid:2:3',revision:'a'.repeat(64),subject:'PRIVATE_SUBJECT'}],nextCursor:'mail-next',hasMore:false};});
  try{
    await f.coordinator.pollOnce();assert.equal(f.reads(),1);
    f.advance(300000);await f.coordinator.pollOnce();assert.equal(f.reads(),2);
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

test('MAX source does not guess a conversation and one busy source cannot consume the whole coordinator tick',async t=>{
  const f=await externalFixture(t);
  try{
    f.row.skillId='max-web';await f.coordinator.pollOnce();assert.equal(f.reads(),0);
    assert.ok(f.notifications.some(value=>value.code==='ASSISTANT_COORDINATOR_SOURCE_STREAM_REQUIRED'));
    f.row.skillId='telegram-mtproto';const rows=Array.from({length:6},()=>({...f.row,id:randomUUID(),localAccountId:randomUUID()}));
    f.rows(rows);f.advance(300000);f.read(async()=>({events:[],nextCursor:'more',hasMore:true,channelsToSync:[],unresolvedDeletionIds:[]}));
    await f.coordinator.pollOnce();assert.equal(f.reads(),4,'one page from at most four oldest due registrations');
    // No time advance: the two never-polled rows retain due=0 and must win.
    f.read(async()=>({events:[],nextCursor:'end',hasMore:false}));
    await f.coordinator.pollOnce();assert.equal(f.reads(),8);
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

test('native known-conversation routing wakes only the existing canonical task chat and never ACKs an unread body',async t=>{
  const f=await externalFixture(t),key=`telegram-conversation/v1.${'a'.repeat(64)}`,unknown=`telegram-conversation/v1.${'b'.repeat(64)}`;
  const route={id:randomUUID(),sourceId:f.row.id,sourceRevision:0,conversationKey:key,bindingId:f.bindingId,bindingRevision:0,taskId:f.taskId};
  let routingCalls=0;
  f.options.client.sourceRoutes=async input=>{
    routingCalls++;assert.equal(input.companyId,f.companyId);assert.equal(input.sourceId,f.row.id);
    assert.equal(input.sourceRevision,0);assert.ok(input.conversationKeys.every(value=>value===key||value===unknown));
    return input.conversationKeys.includes(key)?[route]:[];
  };
  try{
    await f.coordinator.pollOnce();await f.coordinator.workOnce();
    const threadId=f.coordinator.status()[0].threadId;
    f.read(async()=>({schemaVersion:1,baselineOnly:false,nextCursor:'messages',hasMore:false,channelsToSync:[],unresolvedDeletionIds:[],events:[
      {id:'message:123:1',revision:'c'.repeat(64),kind:'new',outgoing:false,conversationKey:key},
      {id:'message:124:1',revision:'d'.repeat(64),kind:'new',outgoing:false,conversationKey:unknown},
      {id:'message:123:2',revision:'e'.repeat(64),kind:'new',outgoing:true,conversationKey:key}]}));
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


test('production composition ACK waits for exact read and committed selection; a lost write resumes read-only in the same inbox',async t=>{
  let mode='unknown',calls=[],f;
  const acknowledgeSource=async input=>{
    calls.push(input.verifyOnly);input.assertReferences();input.beforeInvoke();
    assert.equal(f.database.prepare('SELECT ack_started FROM assistant_inbox_events').get().ack_started,1,'durable fence precedes ONE native invocation');
    assert.equal(input.references.length,1);assert.equal(input.references[0].id,'message:123:1');
    if(mode==='unknown')throw Object.assign(new Error('PRIVATE_PROVIDER_LOST'),{code:'ASSISTANT_SOURCE_UNAVAILABLE'});
    return {acknowledged:mode==='confirmed',notAttempted:true,code:null};
  };
  f=await externalFixture(t,{acknowledgeSource});
  const key='telegram-conversation/v1.'+'a'.repeat(64),route={id:randomUUID(),sourceId:f.row.id,sourceRevision:0,
    conversationKey:key,bindingId:f.bindingId,bindingRevision:0,taskId:f.taskId};
  f.options.client.sourceRoutes=async()=>[route];
  const outcome=f.options.client.readBusinessOutcome;let selected=false;
  f.options.client.readBusinessOutcome=async input=>({...await outcome(input),...(selected?{
    processedSourceReferences:[{sourceId:f.row.id,sourceRevision:0,routeId:route.id,eventOrdinal:0}]}:{})});
  f.options.native.run=async(input,options)=>{
    options.startInvocation();const ref=input.taskContext.sourceReferences[0];
    const event=f.database.prepare('SELECT event_key FROM assistant_inbox_events WHERE event_id=?').get(ref.eventId);
    f.inbox.recordExternalRead(f.scope(),{deliveryId:input.deliveryId,eventKey:event.event_key,sourceRevision:0,routeId:route.id});
    const result={state:'completed',receipt:`codex:${input.threadId}:${randomUUID()}`};f.deliveries.set(input.deliveryId,result);return result;
  };
  try{
    await f.coordinator.pollOnce();await f.coordinator.workOnce();
    const thread=f.coordinator.status()[0].threadId;
    f.read(async()=>({baselineOnly:false,nextCursor:'message',hasMore:false,channelsToSync:[],unresolvedDeletionIds:[],
      events:[{id:'message:123:1',revision:'b'.repeat(64),kind:'new',outgoing:false,conversationKey:key}]}));
    f.advance(300000);await f.coordinator.pollOnce();assert.deepEqual(calls,[]);
    await f.coordinator.workOnce();await f.coordinator.pollOnce();assert.deepEqual(calls,[],'body read with omitted processing is never ACK eligible');
    selected=true;f.advance(1800000);await f.coordinator.workOnce();await f.coordinator.pollOnce();
    assert.deepEqual(calls,[false]);assert.equal(f.database.prepare('SELECT acked FROM assistant_inbox_events').get().acked,0);
    await f.restart();mode='not-read';f.advance(300001);await f.coordinator.pollOnce();assert.deepEqual(calls,[false,true]);
    assert.equal(f.database.prepare('SELECT ack_started FROM assistant_inbox_events').get().ack_started,1,'a verify-only no-write result never clears the older unknown write');
    f.authority.state='done';f.authority.revision++;mode='confirmed';f.advance(300001);await f.coordinator.pollOnce();
    assert.deepEqual(calls,[false,true,true]);assert.equal(f.database.prepare('SELECT acked FROM assistant_inbox_events').get().acked,1);
    assert.equal(f.coordinator.status()[0].threadId,thread);assert.equal(f.counts().provisions,1);assert.equal(f.counts().acks,0,'native Trelio ACK never receives Telegram IDs');
    assert.ok(!JSON.stringify(f.notifications).includes('PRIVATE_PROVIDER'));
  }finally{await f.coordinator.close();}
});


test('one positive conversation never completes a legacy mixed uncertain ACK token',async t=>{
  let f,allRead=false,calls=0;
  const acknowledgeSource=async input=>{
    calls++;assert.equal(input.verifyOnly,true);input.assertReferences();input.beforeInvoke();
    return {acknowledged:allRead||input.references[0].id==='message:123:1',notAttempted:true,code:null};
  };
  f=await externalFixture(t,{acknowledgeSource});
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
    allRead=true;f.advance(300001);await f.coordinator.pollOnce();assert.equal(calls,4);
    assert.equal(f.database.prepare('SELECT sum(acked) AS n FROM assistant_inbox_events').get().n,2);
    assert.equal(f.counts().provisions,1);
  }finally{await f.coordinator.close();}
});
