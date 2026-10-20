/** Model-free coordinator. Provider authority and native execution stay behind
 * explicit trusted adapters; SQLite records no messages, secrets or prompts. */
import { createAssistantInbox } from './trelio-assistant-inbox.mjs';
import { createAssistantScheduler } from './trelio-assistant-scheduler.mjs';
import { randomUUID } from 'node:crypto';

export class AssistantCoordinatorError extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}
const fail = code => { throw new AssistantCoordinatorError(code); };
const errorCode = error => typeof error?.code === 'string' && /^ASSISTANT_[A-Z_]{1,100}$/u.test(error.code)
  ? error.code : 'ASSISTANT_COORDINATOR_UNAVAILABLE';
const safeError = error => new AssistantCoordinatorError(errorCode(error), Number.isInteger(error?.status)?error.status:null);
const sameSource = (a,b) => ['origin','assistantId','companyId','provider','accountId','bindingId'].every(key => a[key] === b[key]);
const scopeFor = (source,taskId) => ({ origin:source.origin,assistantId:source.assistantId,companyId:source.companyId,taskId });
const sourceFor = (identity,company) => ({ origin:identity.origin,assistantId:identity.assistantId,companyId:company.companyId,
  provider:'trelio',accountId:company.memberId,bindingId:identity.deviceId });

export const createAssistantCoordinator = ({ database, client, native, workspaceForTask, timeZone,
  now = Date.now, notify = () => {}, watchIntervalMs = 30_000 }) => {
  if (!client?.identity || !native || typeof workspaceForTask !== 'function' || typeof native.ready !== 'function'
    || typeof notify !== 'function' || !Number.isSafeInteger(watchIntervalMs) || watchIntervalMs < 100 || watchIntervalMs > 30_000) fail('ASSISTANT_COORDINATOR_INVALID_INPUT');
  const schedule = createAssistantScheduler({database,now});
  const inbox = createAssistantInbox({database,now,onDeliveryCompleted:schedule.completeInsideInboxTransaction});
  const identity = client.identity;
  // A short transactional coordinator lease fences concurrent service processes.
  // It is separate from the longer delivery lease: after a crash another host
  // can poll/reconcile, while a started/uncertain native turn still blocks work.
  database.exec('CREATE TABLE IF NOT EXISTS assistant_coordinator_lease(singleton INTEGER PRIMARY KEY CHECK(singleton=1),token TEXT NOT NULL,expires_at INTEGER NOT NULL)');
  const token = randomUUID();
  const lifetime = new AbortController();
  const combinedSignal = signal => signal ? AbortSignal.any([signal,lifetime.signal]) : lifetime.signal;
  let closed = false;
  const lease = () => {
    if(closed) fail('ASSISTANT_COORDINATOR_STOPPED');
    database.exec('BEGIN IMMEDIATE');
    try {
      const current = database.prepare('SELECT * FROM assistant_coordinator_lease WHERE singleton=1').get();
      if (current && current.token !== token && current.expires_at > now()) fail('ASSISTANT_COORDINATOR_BUSY');
      database.prepare('INSERT INTO assistant_coordinator_lease VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at').run(token,now()+90_000);
      database.exec('COMMIT');
    } catch(error) { database.exec('ROLLBACK'); throw error; }
  };
  let active = null, polling = false, nextDiscoveryAt = 0;
  const reports = new Map();
  const notices = new Set();
  const emit = code => {
    // An unchanged blocked state must not notify the owner on every 30s tick.
    // Reset only after a completed native pass, not a successful HTTP poll.
    if(notices.has(code)) return;
    if(notices.size>=64) notices.clear(); notices.add(code);
    try { notify({ code }); } catch { /* Notification transport cannot retry native work. */ }
  };
  const findSchedule = (source,taskId) => {
    try { return schedule.get(scopeFor(source,taskId)); }
    catch(error) { if (error.code==='ASSISTANT_SCHEDULE_TASK_REQUIRED') return null; throw error; }
  };
  const apply = (source,binding) => {
    const old=inbox.taskState(source,binding.taskId);
    inbox.applyTaskState(source,{ taskId:binding.taskId,state:binding.state,expectedRevision:old?.revision??0,
      authority:{bindingId:binding.id,revision:binding.revision} });
    let plan=findSchedule(source,binding.taskId);
    if (!plan) return;
    if(old?.authority?.revision!==binding.revision) plan=schedule.touchAuthority(scopeFor(source,binding.taskId),plan.revision);
    if (binding.state==='accepted' && !sameSource(plan.source,source)) plan=schedule.rebindSource(scopeFor(source,binding.taskId),{source,expectedRevision:plan.revision});
    const state=binding.state==='accepted'?'active':binding.state==='done'?'done':binding.state==='revoked'?'revoked':'paused';
    if (plan.state!==state) schedule.setState(scopeFor(source,binding.taskId),{state,expectedRevision:plan.revision});
  };
  const authorize = async ({scope,taskId},signal) => {
    lease();
    const value=await client.task(scope.companyId,taskId,signal);
    lease(); apply(scope,value);
    if(value.hostState==='other_device') fail('ASSISTANT_COORDINATOR_HOST_REVIEW_REQUIRED');
    return value.state==='accepted';
  };
  const syncTasks = async (source,signal) => {
    let after=null;
    for(let page=0;page<101;page++) {
      lease(); const result=await client.tasks(source.companyId,after,signal); lease();
      for(const value of result.bindings) apply(source,value);
      if(result.nextCursor===null) return;
      if(result.nextCursor===after) fail('ASSISTANT_COORDINATOR_INVALID_CURSOR');
      after=result.nextCursor;
    }
    fail('ASSISTANT_COORDINATOR_TASK_LIMIT');
  };
  const pollSource = async (source,signal) => {
    for(let page=0;page<10;page++) {
      lease(); const poll=inbox.claimPoll(source); if(!poll) break;
      let result;
      try { result=await client.poll(source.companyId,poll.cursor,signal); }
      catch(error) {
        inbox.abandonPoll(source,{token:poll.token,retryAfterMs:300_000}); throw error;
      }
      lease();
      for(const event of result.events) apply(source,{id:event.bindingId,taskId:event.taskId,state:event.taskState,revision:event.bindingRevision});
      inbox.commitPage(source,{...poll,nextCursor:result.nextCursor,hasMore:result.hasMore,
        events:result.events.map(({id,revision,taskId,wake})=>({id,revision,taskId,wake}))});
      if(!result.hasMore) break;
    }
    const ack=inbox.claimAcknowledgements(source); if(!ack) return;
    const events=ack.events.map(event=>{
      const authority=inbox.taskState(source,event.task_id)?.authority;
      if(!authority) fail('ASSISTANT_COORDINATOR_AUTHORITY_REQUIRED');
      return {id:event.event_id,revision:event.event_revision,bindingId:authority.bindingId,bindingRevision:authority.revision};
    });
    // A failed/ambiguous read-state acknowledgement is retried idempotently
    // under a later lease. It never resets the cursor or retries task execution.
    await client.acknowledge(source.companyId,events,signal); lease();
    inbox.completeAcknowledgements(source,ack.token);
  };
  const reportSchedules = async signal => {
    for(const plan of schedule.list()) {
      if(inbox.status(plan.source).state!=='active') continue;
      const authority=inbox.taskState(plan.source,plan.taskId)?.authority;if(!authority) continue;
      const key=`${plan.companyId}:${plan.taskId}`, stamp=`${authority.revision}:${plan.reportSequence}`;
      if(reports.get(key)===stamp) continue;
      await client.reportSchedule({companyId:plan.companyId,taskId:plan.taskId,bindingId:authority.bindingId,bindingRevision:authority.revision,
        sequence:plan.reportSequence,threadId:plan.threadId,cadence:plan.cadence,timeZone:plan.timeZone,state:plan.state,
        nextRunAt:plan.nextRunAt,lastCycleAt:plan.lastCycleAt,lastCompletedAt:plan.lastCompletedAt},signal);
      lease();reports.set(key,stamp);
    }
  };
  const pollOnce = async signal => {
    if(closed || polling) return false; polling=true;
    signal=combinedSignal(signal);
    try {
      lease();
      if(nextDiscoveryAt<=now()) {
        await client.heartbeat(signal); const companies=await client.companies(signal); lease();
        const sources=companies.map(company=>sourceFor(identity,company));
        // Only a successful authoritative company inventory permits revocation
        // reconciliation. A timeout/denial is never interpreted as empty.
        for(const old of inbox.listSources()) {
          if(old.state==='revoked' || sources.some(source=>sameSource(source,old.scope))) continue;
          inbox.setSourceState(old.scope,{state:'revoked',expectedRevision:inbox.status(old.scope).revision});
          for(const plan of schedule.list().filter(plan=>sameSource(plan.source,old.scope))) {
            if(plan.state!=='revoked') schedule.setState(scopeFor(old.scope,plan.taskId),{state:'revoked',expectedRevision:plan.revision});
          }
        }
        for(const source of sources) {
          const registered=inbox.register(source);
          if(registered.state==='revoked') fail('ASSISTANT_COORDINATOR_SOURCE_REBIND_REQUIRED');
          await syncTasks(source,signal);
        }
        nextDiscoveryAt=now()+300_000;
      }
      for(const {scope,state} of inbox.listSources()) if(state==='active') {
        try { await pollSource(scope,signal); }
        catch(error) {
          // A provider/company failure must not stop independent companies.
          // Dispatch still does a fresh exact task authorization before start.
          if([401,403].includes(error.status)) throw error;
          emit(errorCode(error));
        }
      }
      await reportSchedules(signal);
      return true;
    } catch(error) { throw safeError(error); } finally { polling=false; }
  };
  const registerChat = (job,threadId) => {
    const existing=findSchedule(job.scope,job.taskId);
    if(existing) {
      if(existing.threadId!==threadId) fail('ASSISTANT_COORDINATOR_THREAD_CONFLICT');
      return existing;
    }
    return schedule.register({scope:scopeFor(job.scope,job.taskId),source:job.scope,threadId,cadence:'every_30_minutes',timeZone});
  };
  const reconcile = async signal => {
    const [job]=inbox.incompleteDeliveries(); if(!job) return false;
    if(job.state==='leased') return true;
    if(job.kind==='provision' && !job.nativeStarted) {
      // Only the host claim is uncertain. The persisted native-start bit proves
      // no CLI invocation crossed its one-use boundary; retry this same claim
      // and original provision ID, never allocate a replacement job/chat.
      if(await native.ready(identity,signal)!==true) fail('ASSISTANT_COORDINATOR_SETUP_REQUIRED');
      await perform(job,signal);return false;
    }
    const threadId=job.kind==='provision'?job.threadId:findSchedule(job.scope,job.taskId)?.threadId;
    if(!threadId) { emit('ASSISTANT_COORDINATOR_PROVISION_REVIEW_REQUIRED'); return true; }
    const result=await native.readDelivery(threadId,job.deliveryId,{signal}); lease();
    if(result.state==='completed') {
      if(job.kind==='provision') registerChat(job,threadId);
      await authorize({scope:job.scope,taskId:job.taskId},signal);
      inbox.completeDelivery(job.deliveryId,result.receipt);
      notices.clear();
      return false;
    }
    if(result.state==='failed') emit('ASSISTANT_COORDINATOR_DELIVERY_REVIEW_REQUIRED');
    return true;
  };
  const perform = async (job,signal) => {
    const controller=new AbortController();
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    let checking=false,started=false;
    const watch=setInterval(()=>{
      if(checking) return; checking=true;
      void (async()=>{
        if(!await authorize({scope:job.scope,taskId:job.taskId},combined)) fail('ASSISTANT_COORDINATOR_TASK_STOPPED');
        if(started) inbox.renewDelivery(job.deliveryId);
      })().catch(()=>controller.abort()).finally(()=>{checking=false;});
    },watchIntervalMs);
    try {
      const cwd=await workspaceForTask(scopeFor(job.scope,job.taskId));
      if(!await authorize({scope:job.scope,taskId:job.taskId},combined)) fail('ASSISTANT_COORDINATOR_TASK_STOPPED');
      const options={signal:combined,startInvocation:()=>{lease();inbox.startDelivery(job.deliveryId);started=true;}};
      let result;
      if(job.kind==='provision') {
        inbox.prepareProvision(job.deliveryId);started=true;
        const authority=inbox.taskState(job.scope,job.taskId).authority;
        const claim=await client.claimTaskHost({companyId:job.scope.companyId,taskId:job.taskId,bindingId:authority.bindingId,
          bindingRevision:authority.revision,provisionId:job.deliveryId},combined);
        if(claim.threadId!==null) {
          // A restored local snapshot may lag the server's already registered
          // chat. Adopt only exact positive native read-back on this host.
          result=await native.readDelivery(claim.threadId,job.deliveryId,{signal:combined});
          if(result.state!=='completed') fail('ASSISTANT_COORDINATOR_PROVISION_REVIEW_REQUIRED');
          options.startInvocation();inbox.bindProvisionedThread(job.deliveryId,claim.threadId);
          result={...result,threadId:claim.threadId};
        } else {
        result=await native.provision({deliveryId:job.deliveryId,cwd},{...options,
          onThreadStarted:threadId=>inbox.bindProvisionedThread(job.deliveryId,threadId)});
        }
        registerChat(job,result.threadId);
      } else {
        const plan=findSchedule(job.scope,job.taskId);
        if(!plan) fail('ASSISTANT_COORDINATOR_THREAD_REQUIRED');
        result=await native.run({threadId:plan.threadId,deliveryId:job.deliveryId,cwd},options);
      }
      if(result.state!=='completed') fail('ASSISTANT_COORDINATOR_DELIVERY_REVIEW_REQUIRED');
      await authorize({scope:job.scope,taskId:job.taskId},combined);
      inbox.completeDelivery(job.deliveryId,result.receipt);
      return {state:'completed',kind:job.kind};
    } catch(error) {
      if(started) inbox.markDeliveryUncertain(job.deliveryId);
      else inbox.abandonUnstartedDelivery(job.deliveryId);
      const code=started?'ASSISTANT_COORDINATOR_DELIVERY_UNCERTAIN':errorCode(error);
      emit(code); throw new AssistantCoordinatorError(code);
    } finally { clearInterval(watch); controller.abort(); }
  };
  const workOnce = async signal => {
    if(closed || active) return null;
    signal=combinedSignal(signal);
    // Set the in-process fence before the first await as well as the cross-host
    // SQLite lease, so a tick and manual kick cannot both provision the task.
    active=(async()=>{
      lease(); if(await reconcile(signal)) return {state:'blocked'};
      // Readiness includes the dedicated assistant MCP/plugin admission. A
      // working executable or human OAuth alone cannot enable business work.
      if(await native.ready(identity,signal)!==true) fail('ASSISTANT_COORDINATOR_SETUP_REQUIRED');
      for(const {scope,state} of inbox.listSources()) if(state==='active') {
        const task=inbox.listTasks(scope).find(task=>task.state==='accepted' && !findSchedule(scope,task.taskId));
        if(task) {
          const job=await inbox.claimDelivery({authorize:input=>authorize(input,signal),provisionTask:{scope,taskId:task.taskId}});
          return job?perform(job,signal):null;
        }
      }
      let job=await inbox.claimDelivery({authorize:input=>authorize(input,signal)});
      if(!job) {
        const due=schedule.nextDue();
        if(due) job=await inbox.claimDelivery({authorize:input=>authorize(input,signal),scheduledTask:{scope:due.source,taskId:due.taskId}});
      }
      return job?perform(job,signal):null;
    })();
    try { return await active; } catch(error) { throw safeError(error); } finally { active=null; }
  };
  return {
    pollOnce,workOnce,
    async setCadence(source,taskId,input,signal) {
      if(!await authorize({scope:source,taskId},signal)) fail('ASSISTANT_COORDINATOR_TASK_STOPPED');
      return schedule.setCadence(scopeFor(source,taskId),input);
    },
    status() { return schedule.list(); },
    async run(signal) {
      if(!signal) fail('ASSISTANT_COORDINATOR_INVALID_INPUT');
      while(!signal.aborted && !closed) {
        try {
          await pollOnce(signal);
          if(!active) void workOnce(signal).catch(error=>emit(errorCode(error)));
        } catch(error) { emit(errorCode(error)); }
        await new Promise(resolve=>{
          const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
          const timer=setTimeout(done,30_000);signal.addEventListener('abort',done,{once:true});
          if(signal.aborted || closed) done();
        });
      }
      if(active) await active.catch(()=>{});
    },
    async close() {
      closed=true;lifetime.abort();
      if(active) await active.catch(()=>{});
      database.prepare('DELETE FROM assistant_coordinator_lease WHERE token=?').run(token);
    },
  };
};
