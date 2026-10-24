/** Model-free coordinator. Provider authority and native execution stay behind
 * explicit trusted adapters; SQLite records no messages, secrets or prompts. */
import { createAssistantInbox, readAssistantInboxDispatchSummary, assistantDeliveryFailure } from './trelio-assistant-inbox.mjs';
import { createAssistantScheduler } from './trelio-assistant-scheduler.mjs';
import { assistantExecutionConfiguration } from './trelio-assistant-codex.mjs';
import { validateAssistantPassOutcome, sameAssistantSourceRegistration as sameRegistration, assistantMaxChatUrl, ASSISTANT_SOURCE_MONITOR_ERROR_CODES } from './trelio-assistant-transport.mjs';
import { validateAssistantActivePass } from './trelio-assistant-hook.mjs';
import { randomUUID, createHash } from 'node:crypto';

export class AssistantCoordinatorError extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}
const fail = code => { throw new AssistantCoordinatorError(code); };
const errorCode = error => typeof error?.code === 'string' && (/^ASSISTANT_[A-Z_]{1,100}$/u.test(error.code)||ASSISTANT_SOURCE_MONITOR_ERROR_CODES.includes(error.code))
  ? error.code : 'ASSISTANT_COORDINATOR_UNAVAILABLE';
const safeError = error => new AssistantCoordinatorError(errorCode(error), Number.isInteger(error?.status)?error.status:null);
const sameSource = (a,b) => ['origin','assistantId','companyId','provider','accountId','bindingId'].every(key => a[key] === b[key]);
const scopeFor = (source,taskId) => ({ origin:source.origin,assistantId:source.assistantId,companyId:source.companyId,taskId });
const sourceFor = (identity,company) => ({ origin:identity.origin,assistantId:identity.assistantId,companyId:company.companyId,
  provider:'trelio',accountId:company.memberId,bindingId:identity.deviceId });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const externalProviders=Object.freeze({'telegram-mtproto':'telegram','email-imap-smtp':'email','max-web':'max'});
const EMAIL_INITIAL_UNREAD_STREAM='email-initial-unread/v1';
const externalSourceFor=(identity,row)=>({origin:identity.origin,assistantId:identity.assistantId,companyId:row.companyId,
  provider:externalProviders[row.skillId],accountId:row.localAccountId,bindingId:row.id});

/** Presentation only: native company execution remains authority at every
 * launch. Missing model selection blocks even an empty initial queue. Failed
 * or incomplete reads never become an empty/idle snapshot. No IDs, labels,
 * cursor, pass, notification or provider content leave this aggregate. */
export const assistantDispatchDiagnostics = ({companies=null,summary=null,now=Date.now(),active=false}={}) => {
  const counts=['pendingEvents','acceptedTasks','waitingOwnerTasks','unprovisionedTasks','uncertainDeliveries'];
  const result={schemaVersion:1,state:'unknown',reasons:['not_checked'],checkedAt:new Date(now).toISOString(),
    ...Object.fromEntries(counts.map(key=>[key,null])),failure:null};
  if(!Array.isArray(companies)||companies.length>256||new Set(companies.map(row=>row?.companyId)).size!==companies.length)return result;
  const reasons=[];
  for(const row of companies){
    if(!uuid.test(row?.companyId??'')||!uuid.test(row?.memberId??''))return result;
    if(row.execution?.state==='unconfigured')reasons.push('model_selection_required');
    else if(row.execution?.state==='policy_blocked')reasons.push('model_policy_blocked');
    else if(row.execution?.state==='ready'){
      try{assistantExecutionConfiguration(row.execution.configuration);}catch{return result;}
    }else return result;
  }
  if(!companies.length)reasons.push('configuration_required');
  const complete=summary&&Object.keys(summary).sort().join(',')===[...counts,'failure'].sort().join(',')
    &&counts.every(key=>Number.isSafeInteger(summary[key])&&summary[key]>=0&&summary[key]<=50_000);
  if(complete){
    let failure=null;
    try{
      if(summary.failure!==null){
        if(!summary.failure||Object.keys(summary.failure).sort().join(',')!=='code,stage')return result;
        failure=assistantDeliveryFailure(summary.failure.code,summary.failure.stage);
      }
    }catch{return result;}
    Object.assign(result,Object.fromEntries(counts.map(key=>[key,summary[key]])),{failure});
    if(summary.uncertainDeliveries)reasons.push('delivery_uncertain');
    if(summary.waitingOwnerTasks)reasons.push('waiting_owner');
  }else reasons.push('not_checked');
  result.reasons=[...new Set(reasons)];
  result.state=reasons.some(reason=>reason!=='not_checked')?'blocked':!complete?'unknown':active?'active'
    :summary.pendingEvents||summary.unprovisionedTasks?'queued':'idle';
  return Object.freeze(result);
};

export const createAssistantCoordinator = ({ database, client, native, workspaceForTask, timeZone,
  passHost = null, workspaceForIntake = null, readSourceMonitor = null, acknowledgeSource = null, sourceHealth = null, now = Date.now, notify = () => {}, watchIntervalMs = 30_000 }) => {
  if (!client?.identity || !native || typeof workspaceForTask !== 'function' || typeof native.ready !== 'function'
    || typeof notify !== 'function' || !Number.isSafeInteger(watchIntervalMs) || watchIntervalMs < 100 || watchIntervalMs > 30_000) fail('ASSISTANT_COORDINATOR_INVALID_INPUT');
  if(passHost!==null && ['readActivePass','activatePass','releasePass'].some(key=>typeof passHost[key]!=='function')) fail('ASSISTANT_COORDINATOR_INVALID_INPUT');
  if(sourceHealth!==null&&(!sourceHealth||typeof sourceHealth.read!=='function'||typeof sourceHealth.report!=='function'))fail('ASSISTANT_COORDINATOR_INVALID_INPUT');
  if(readSourceMonitor!==null && (typeof readSourceMonitor!=='function' || typeof client.sourceAccounts!=='function')) fail('ASSISTANT_COORDINATOR_INVALID_INPUT');
  if(acknowledgeSource!==null && (typeof acknowledgeSource!=='function'||typeof client.sourceAccounts!=='function'))fail('ASSISTANT_COORDINATOR_INVALID_INPUT');
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
  let active = null, polling = false, nextDiscoveryAt = 0, externalInventoryComplete=false;
  // This map contains only the current invocation's native structural refs.
  // Persistent positions/events use the SAME inbox as Trelio. A failed source
  // inventory never becomes authoritative absence or permits stale polling.
  const externalRegistrations=new Map();
  const reports = new Map();
  const notices = new Set();
  let blockedCompanies = new Set();
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
  // Presentation only, refreshed from native task/binding responses before
  // admission. The protected pass ABI and native domain permissions stay exact;
  // this bounded metadata never grants access or becomes a second task journal.
  const taskWorkModes=new Map();
  const modeKey=(source,taskId)=>`${source.companyId}:${taskId}`;
  const apply = (source,binding) => {
    const mode=binding.workMode??'task';
    if(!['task','discussion'].includes(mode))fail('ASSISTANT_COORDINATOR_SOURCE_CHANGED');
    if(taskWorkModes.size>=10_000&&!taskWorkModes.has(modeKey(source,binding.taskId)))fail('ASSISTANT_COORDINATOR_SOURCE_CHANGED');
    taskWorkModes.set(modeKey(source,binding.taskId),mode);
    const old=inbox.taskState(source,binding.taskId);
    inbox.applyTaskState(source,{ taskId:binding.taskId,state:binding.state,expectedRevision:old?.revision??0,
      authority:{bindingId:binding.id,revision:binding.revision} });
    let plan=findSchedule(source,binding.taskId);
    if (!plan) return;
    if(old?.authority?.revision!==binding.revision) plan=schedule.touchAuthority(scopeFor(source,binding.taskId),plan.revision);
    if (binding.state==='accepted' && !sameSource(plan.source,source)) plan=schedule.rebindSource(scopeFor(source,binding.taskId),{source,expectedRevision:plan.revision});
    // A completed personal goal is sticky during ordinary source polls. A new
    // explicit mention may still run in the same chat and commit a new goal;
    // rediscovering an accepted task alone must not resurrect its cycle.
    const state=binding.state==='accepted'?(plan.state==='done'?'done':mode==='discussion'?'paused':'active'):binding.state==='done'?'done':binding.state==='revoked'?'revoked':'paused';
    if (plan.state!==state) schedule.setState(scopeFor(source,binding.taskId),{state,expectedRevision:plan.revision});
  };
  const authorize = async ({scope,taskId},signal,{captureExecution=null,captureBinding=null,requireModel=true,allowTaskDone=false,job=null}={}) => {
    lease();
    const value=await client.task(scope.companyId,taskId,signal);
    lease(); apply(scope,value);
    if(value.hostState==='other_device') fail('ASSISTANT_COORDINATOR_HOST_REVIEW_REQUIRED');
    if(job)await verifyExternalDelivery(job,value,signal);
    if(captureBinding) captureBinding(value);
    // Only completion/recovery of an already started exact pass opts in. New
    // claims/launches still require accepted task authority and model policy.
    if(value.state==='done' && allowTaskDone) return true;
    if(value.state!=='accepted') return false;
    // A completed native/business receipt may still be reconciled while new
    // launches are blocked. This never performs another native invocation.
    if(!requireModel) return true;
    if(value.execution?.state!=='ready') {
      blockedCompanies.add(scope.companyId);
      emit(value.execution?.state==='policy_blocked'?'ASSISTANT_COORDINATOR_MODEL_POLICY_BLOCKED':'ASSISTANT_COORDINATOR_MODEL_SELECTION_REQUIRED');
      return false;
    }
    const execution=assistantExecutionConfiguration(value.execution.configuration);
    if(captureExecution) captureExecution(execution);
    return true;
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
      for(const event of result.events) apply(source,{id:event.bindingId,taskId:event.taskId,state:event.taskState,revision:event.bindingRevision,
        ...(event.workMode===undefined?{}:{workMode:event.workMode})});
      inbox.commitPage(source,{...poll,nextCursor:result.nextCursor,hasMore:result.hasMore,
        events:result.events.map(({id,revision,taskId,wake,ownerQuestionId})=>({id,revision,taskId,wake,
          ...(ownerQuestionId === undefined ? {} : {ownerQuestionId})}))});
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
  const syncExternalSources=async(companyId,signal)=>{
    const rows=await client.sourceAccounts(companyId,signal);lease();
    const refs=rows.map(row=>({row,scope:externalSourceFor(identity,row)}));
    for(const old of inbox.listSources()){
      if(old.scope.companyId!==companyId || old.scope.provider==='trelio' || old.state==='revoked'
        || refs.some(({scope})=>sameSource(scope,old.scope)))continue;
      // Only this successful exact source inventory, never the company/task
      // inventory, can retire an absent external registration in this device DB.
      inbox.setSourceState(old.scope,{state:'revoked',expectedRevision:inbox.status(old.scope).revision});
    }
    for(const {row,scope} of refs){
      const existing=inbox.register(scope);
      if(existing.state==='revoked' && row.state!=='revoked')fail('ASSISTANT_COORDINATOR_SOURCE_REBIND_REQUIRED');
      if(existing.state!==row.state)inbox.setSourceState(scope,{state:row.state,expectedRevision:existing.revision});
      inbox.observeExternalSourceRevision(scope,row.revision);
    }
    for(const {row} of refs)if(row.state==='active')externalRegistrations.set(row.id,row);
  };
  // Telegram cloud deletions carry native message IDs but no peer. Provider
  // policy permits only an exact prior account reference, never guessing from
  // sender/title/another account or a channel's independent message numbering.
  // This is deletion metadata, not content-read/owner/sending/ACK evidence.
  const resolveCloudDeletions=(source,result)=>{
    const ids=result.unresolvedDeletionIds??[];
    if(!Array.isArray(ids)||ids.length>100||ids.some(id=>typeof id!=='string'||!/^[1-9]\d{0,18}$/u.test(id))
      ||new Set(ids).size!==ids.length)fail('ASSISTANT_COORDINATOR_SOURCE_REFERENCE_REQUIRED');
    if(!ids.length)return [];
    if(source.provider!=='telegram')fail('ASSISTANT_COORDINATOR_SOURCE_REFERENCE_REQUIRED');
    const known=inbox.findEventRefsBySuffix(source,ids.map(id=>`:${id}`));
    return ids.map(messageId=>{
      const matches=known.filter(({id})=>{
        const match=/^message:(-?[1-9]\d{0,18}):([1-9]\d{0,18})$/u.exec(id);
        // Marked channel IDs are <= -10^12. Their local numbering must never
        // satisfy an unqualified cloud deletion, even with the same suffix.
        return match&&match[2]===messageId&&BigInt(match[1])>-1000000000000n;
      });
      if(matches.length!==1)fail('ASSISTANT_COORDINATOR_SOURCE_REFERENCE_REQUIRED');
      const id=matches[0].id;
      return {id,revision:createHash('sha256').update(JSON.stringify(['telegram-cloud-delete/v1',source,
        id,result.nextCursor])).digest('hex')};
    });
  };
  // Report an ACK observation independently of passive reading. The SAME
  // journal supplies only closed facts: no queue bit grants provider execution.
  // Report/CAS failures do not replay work or discard its original fence; a
  // later poll can reconcile a durably confirmed completion after a lost report.
  const observeAcknowledgementHealth=async(row,signal,observation=null)=>{
    if(!sourceHealth||!['telegram-mtproto','email-imap-smtp','max-web'].includes(row.skillId))return;
    try{
      const code=inbox.externalAcknowledgementHealth(externalSourceFor(identity,row));if(code===null)return;
      const snapshot=observation??await sourceHealth.read(row,signal);lease();
      if(snapshot?.sourceRevision!==row.revision||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0)
        fail('ASSISTANT_COORDINATOR_SOURCE_CHANGED');
      await sourceHealth.report(row,{expectedRevision:snapshot.revision,sourceRevision:row.revision,
        clientRequestId:randomUUID(),code,phase:'acknowledgement'},signal);lease();
    }catch{emit('ASSISTANT_COORDINATOR_SOURCE_HEALTH_UNAVAILABLE');}
  };
  const pollExternalSource=async(row,signal,streamId=null)=>{
    const source=externalSourceFor(identity,row);
    // One page per source per coordinator tick: a large backlog cannot occupy
    // the worker indefinitely before another company or native task gets time.
    lease();const poll=streamId===null?inbox.claimPoll(source):inbox.claimStreamPoll(source,streamId);if(!poll)return;
    let observation=null;
    // Capture the native CAS BEFORE reading the provider. A later report uses
    // that exact snapshot once; report failures never replay a provider read or
    // overwrite its committed page/outcome. Nothing is inferred from prose.
    const report=async code=>{
      if(!observation||!code)return;
      try{await sourceHealth.report(row,{expectedRevision:observation.revision,sourceRevision:row.revision,
        clientRequestId:randomUUID(),code},signal);}
      catch{emit('ASSISTANT_COORDINATOR_SOURCE_HEALTH_UNAVAILABLE');}
    };
    try{
      const current=await client.sourceAccounts(row.companyId,signal);lease();
      if(!sameRegistration(row,current.find(value=>value.id===row.id)))fail('ASSISTANT_COORDINATOR_SOURCE_CHANGED');
      if(sourceHealth)try{
        const snapshot=await sourceHealth.read(row,signal);lease();
        if(snapshot?.sourceRevision!==row.revision||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0)
          fail('ASSISTANT_COORDINATOR_SOURCE_CHANGED');
        observation=snapshot;
      }catch{emit('ASSISTANT_COORDINATOR_SOURCE_HEALTH_UNAVAILABLE');}
      lease(); // Diagnostic failure cannot hide expiry of the original poll lease.
      // A native owner-selected MAX account is its root stream. Numeric child
      // IDs come only from complete signed native inventory, never a title,
      // username or model target. Existing exact-chat registrations stay exact.
      const max=row.skillId==='max-web',maxAccount=max&&row.maxChatUrl==null;
      if(max&&(maxAccount?streamId!==null&&!assistantMaxChatUrl(`https://web.max.ru/${streamId}`):!assistantMaxChatUrl(row.maxChatUrl)||streamId!==null))fail('ASSISTANT_COORDINATOR_SOURCE_STREAM_REQUIRED');
      if(streamId!==null && poll.cursor===null && typeof poll.initialCursor!=='string')fail('ASSISTANT_COORDINATOR_SOURCE_STREAM_REQUIRED');
      const email=row.skillId==='email-imap-smtp';
      const initialEmail=email&&streamId===null&&poll.cursor===null;
      if(email&&streamId!==null&&streamId!==EMAIL_INITIAL_UNREAD_STREAM)fail('ASSISTANT_COORDINATOR_SOURCE_STREAM_REQUIRED');
      // The forward position and the original history seed share one journal
      // commit. Only a never-started email source requests a new seed. Child
      // pages use that ORIGINAL seed until their own first committed cursor;
      // no restart, source resume or provider upgrade resets a forward cursor.
      // Native linked ID is observed before AND after the signed metadata
      // read. A username, quoted author or saved inbox label supplies no owner
      // candidate. Only its structural binding UUID is persisted with refs.
      const ownerBefore=row.ownerTaskIntakeAllowed===true&&['telegram-mtproto','max-web'].includes(row.skillId)
        ?await client.ownerIdentities(signal):null;
      const result=await readSourceMonitor({companyId:row.companyId,projectId:row.projectId,skillId:row.skillId,sourceId:row.id,sourceRevision:row.revision,
        accountId:row.localAccountId,cursor:email&&streamId!==null?poll.cursor??poll.initialCursor:poll.cursor,
        ...(max?{...(maxAccount?streamId===null?{}:{chat:`https://web.max.ru/${streamId}`,...(poll.cursor===null?{initialAccountCursor:poll.initialCursor}:{})}:{chat:row.maxChatUrl,...(poll.cursor===null?{initialUnread:true}:{})})}:email?(initialEmail||streamId!==null?{initialUnread:true}:{}):streamId===null?{}:{chat:streamId,
          ...(poll.cursor===null?{initialAccountCursor:poll.initialCursor}:{})})},signal);lease();
      // A native Channel constructor supplies a positive channel ID, not an
      // untyped chat number. Apply Telethon's documented marked representation
      // only to this typed hint; never guess a peer from an incoming message.
      const channelHints=result.channelsToSync??[];
      if(!Array.isArray(channelHints) || channelHints.length>100 || new Set(channelHints).size!==channelHints.length
        || channelHints.some(value=>typeof value!=='string'||!/^[1-9]\d{0,18}$/u.test(value))
        || channelHints.length && (row.skillId!=='telegram-mtproto'||streamId!==null||typeof poll.cursor!=='string'))fail('ASSISTANT_COORDINATOR_SOURCE_STREAM_REQUIRED');
      const streams=channelHints.map(channelId=>{
        const marked=-1000000000000n-BigInt(channelId);
        if(marked<=-9223372036854775808n)fail('ASSISTANT_COORDINATOR_SOURCE_STREAM_REQUIRED');
        return {id:String(marked),revision:createHash('sha256').update(JSON.stringify(['telegram-channel-signal/v1',source,
          channelId,result.nextCursor])).digest('hex'),initialCursor:poll.cursor};
      });
      const maxHints=result.conversationsToSync??[];
      if(!Array.isArray(maxHints)||maxHints.length>1000||new Set(maxHints).size!==maxHints.length
        ||maxHints.length&&(!maxAccount||streamId!==null)||maxHints.some(chatId=>!assistantMaxChatUrl(`https://web.max.ru/${chatId}`)))fail('ASSISTANT_COORDINATOR_SOURCE_STREAM_REQUIRED');
      if(maxAccount&&streamId===null){
        if(result.baselineOnly!==true||result.events?.length||typeof result.initialAccountCursor!=='string'
          ||result.initialAccountCursor.length>2048)fail('ASSISTANT_COORDINATOR_SOURCE_STREAM_REQUIRED');
        for(const chatId of maxHints)streams.push({id:chatId,revision:createHash('sha256').update(JSON.stringify([
          'max-conversation-signal/v1',source,chatId,result.nextCursor])).digest('hex'),initialCursor:result.initialAccountCursor});
      }else if(result.initialAccountCursor!==undefined)fail('ASSISTANT_COORDINATOR_SOURCE_STREAM_REQUIRED');
      if(initialEmail){
        if(result.baselineOnly!==true||!Array.isArray(result.events)||result.events.length
          ||typeof result.initialUnreadCursor!=='string'||!result.initialUnreadCursor.length
          ||result.initialUnreadCursor.length>2048)fail('ASSISTANT_COORDINATOR_SOURCE_STREAM_REQUIRED');
        streams.push({id:EMAIL_INITIAL_UNREAD_STREAM,revision:createHash('sha256')
          .update(JSON.stringify([EMAIL_INITIAL_UNREAD_STREAM,source,result.initialUnreadCursor])).digest('hex'),
          initialCursor:result.initialUnreadCursor});
      }else if(result.initialUnreadCursor!==undefined)fail('ASSISTANT_COORDINATOR_SOURCE_STREAM_REQUIRED');
      if(streamId!==null && ((maxAccount?result.baselineOnly!==(poll.cursor===null&&result.events?.length===0):result.baselineOnly!==false) || (result.unresolvedDeletionIds??[]).length
        || (email?result.initialUnreadBackfill!==true:maxAccount?poll.cursor===null&&result.initialAccountBackfill!==true:row.skillId!=='telegram-mtproto'
          || poll.cursor===null && result.initialAccountBackfill!==true)))fail('ASSISTANT_COORDINATOR_SOURCE_STREAM_REQUIRED');
      const deletions=resolveCloudDeletions(source,result);
      if(!Array.isArray(result.events)||result.events.length+deletions.length>100)fail('ASSISTANT_COORDINATOR_SOURCE_REFERENCE_REQUIRED');
      if(typeof result.nextCursor==='string' && result.nextCursor.length>2048)fail('ASSISTANT_COORDINATOR_SOURCE_CURSOR_LIMIT');
      const after=await client.sourceAccounts(row.companyId,signal);lease();
      if(!sameRegistration(row,after.find(value=>value.id===row.id)))fail('ASSISTANT_COORDINATOR_SOURCE_CHANGED');
      // Polling is not routing, owner-command authority or content handling.
      // Keep new refs unrouted and non-waking. No provider ACK is attempted;
      // body read, native mapping and committed processing remain required.
      const ownerAfter=ownerBefore?await client.ownerIdentities(signal):null;lease();
      if(ownerBefore&&ownerAfter.bindingRevision!==ownerBefore.bindingRevision)fail('ASSISTANT_COORDINATOR_SOURCE_CHANGED');
      const owner=ownerAfter?.identities.find(item=>item.provider===externalProviders[row.skillId]);
      const page={...poll,nextCursor:result.nextCursor,hasMore:result.hasMore,
        events:[...result.events,...deletions].map(({id,revision,conversationKey,kind,outgoing,forwarded,viaBot,senderNamespace,senderUserId})=>({id,revision,taskId:null,wake:false,
          ...(owner&&senderNamespace===(row.skillId==='max-web'?'max_user_id':'telegram_user_id')&&senderUserId===owner.externalUserId&&kind==='new'&&outgoing===false&&forwarded===false&&(row.skillId==='max-web'||viaBot===false)&&conversationKey
            ?{ownerIdentityId:owner.bindingId}:{}),
          ...(conversationKey?{conversationKey,providerWake:row.skillId==='email-imap-smtp'||kind!=='delete' && outgoing===false}:{})}))};
      if(streamId===null)inbox.commitPage(source,{...page,streams});
      else inbox.commitStreamPage(source,{...page,streamId});
      // An unrelated successful account/page cannot hide an outstanding child
      // history/login failure. Only all committed stream generations being
      // caught up permits the existing native source health to recover.
      if(!inbox.hasPendingStreams(source))await report('ready');
      await observeAcknowledgementHealth(row,signal);
    }catch(error){
      // Read-only recovery retains both position and queued events. Neither
      // a provider gap nor changed owner configuration resets the source.
      if(streamId===null)inbox.abandonPoll(source,{token:poll.token,retryAfterMs:300_000});
      else inbox.abandonStreamPoll(source,{streamId,token:poll.token,generation:poll.generation,retryAfterMs:300_000});
      const code=error?.code;
      const reason=code==='ASSISTANT_COORDINATOR_SOURCE_CHANGED'?null:
        ['ACCOUNT_NOT_FOUND','ACCOUNT_NOT_BOUND','ASSISTANT_SOURCE_SETUP_REQUIRED','ASSISTANT_COORDINATOR_SOURCE_STREAM_REQUIRED',
          'ASSISTANT_SOURCE_HISTORY_CAPABILITY_REQUIRED'].includes(code)?'setup_required':
        /^(?:TELEGRAM|EMAIL|MAX)_MONITOR_(?:SCOPE_CHANGED|UIDVALIDITY_CHANGED)$/u.test(code??'')?'scope_changed':
        /^(?:TELEGRAM|EMAIL|MAX)_MONITOR_(?:GAP|REFERENCE_UNAVAILABLE)$/u.test(code??'')||['ASSISTANT_COORDINATOR_SOURCE_CURSOR_LIMIT','ASSISTANT_COORDINATOR_SOURCE_REFERENCE_REQUIRED','ASSISTANT_INBOX_REFERENCE_AMBIGUOUS'].includes(code)?'history_gap':'read_failed';
      await report(reason);await observeAcknowledgementHealth(row,signal);throw error;
    }
  };
  const canonicalSourceFor=companyId=>{
    const sources=inbox.listSources().filter(value=>value.state==='active'&&value.scope.provider==='trelio'
      &&value.scope.origin===identity.origin&&value.scope.assistantId===identity.assistantId&&value.scope.companyId===companyId);
    if(sources.length!==1)fail('ASSISTANT_COORDINATOR_SOURCE_CHANGED');
    return sources[0].scope;
  };
  const routeExternalSource=async(row,signal,pending=inbox.pendingExternalRoutes(externalSourceFor(identity,row)))=>{
    if(!['telegram-mtproto','email-imap-smtp','max-web'].includes(row.skillId)||typeof client.sourceRoutes!=='function')return;
    const source=externalSourceFor(identity,row);
    if(!pending.length)return;
    const routes=await client.sourceRoutes({companyId:row.companyId,sourceId:row.id,sourceRevision:row.revision,
      conversationKeys:[...new Set(pending.map(event=>event.conversation_key))]},signal);lease();
    const canonicalSource=canonicalSourceFor(row.companyId);
    // Native lookup selects only accepted current task bindings on THIS host.
    // Refresh the existing task projection, never register/rebind a second
    // source with the scheduler or provision a chat from a conversation key.
    for(const taskId of new Set(routes.map(route=>route.taskId))){
      const binding=await client.task(row.companyId,taskId,signal);lease();
      if(binding.hostState==='other_device')fail('ASSISTANT_COORDINATOR_HOST_REVIEW_REQUIRED');
      apply(canonicalSource,binding);
    }
    const current=await client.sourceAccounts(row.companyId,signal);lease();
    if(!sameRegistration(row,current.find(value=>value.id===row.id)))fail('ASSISTANT_COORDINATOR_SOURCE_CHANGED');
    inbox.routeExternalEvents(source,{canonicalSource,sourceRevision:row.revision,
      eventKeys:pending.map(event=>event.event_key),routes});
    // Absence is known only after this successful fresh native route lookup.
    // Read-only errors never enqueue a competing classification/model turn.
    const preferredFor=event=>{
      const maxChat=row.skillId==='max-web'?/^message:(-?[1-9]\d{0,18}):/u.exec(event.event_id)?.[1]:null;
      return externalInventoryComplete?[...externalRegistrations.values()].filter(candidate=>candidate.state==='active'
        &&candidate.skillId===row.skillId&&candidate.localAccountId===row.localAccountId
        &&(row.skillId!=='max-web'||maxChat&&(candidate.maxChatUrl==null||candidate.maxChatUrl===`https://web.max.ru/${maxChat}`)))
        .sort((a,b)=>a.id.localeCompare(b.id))[0]:null;
    };
    // Company-scoped keys cannot dedup follow-ups across company registrations.
    // Choose ONE source for local intake cost only, from a complete successful
    // inventory. Native company selection still asks the owner and alone grants
    // the selected scope; this preference grants no body/task/source authority.
    if(typeof client.beginSourceIntake==='function')inbox.queueExistingTaskIntakes(source,{sourceRevision:row.revision,
      eventKeys:pending.filter(event=>preferredFor(event)?.id===row.id&&!routes.some(route=>route.conversationKey===event.conversation_key)).map(event=>event.event_key)});
  };
  const verifyExternalDelivery=async(job,binding,signal)=>{
    const external=job.events.filter(event=>JSON.parse(event.event_scope_json).provider!=='trelio');
    if(!external.length)return;
    if(typeof client.sourceRoutes!=='function')fail('ASSISTANT_COORDINATOR_SOURCE_CHANGED');
    const rows=await client.sourceAccounts(job.scope.companyId,signal);lease();
    for(const sourceId of new Set(external.map(event=>JSON.parse(event.event_scope_json).bindingId))){
      const events=external.filter(event=>JSON.parse(event.event_scope_json).bindingId===sourceId),row=rows.find(value=>value.id===sourceId);
      if(!row||row.state!=='active'||!['telegram-mtproto','email-imap-smtp','max-web'].includes(row.skillId)
        ||events.some(event=>!sameSource(externalSourceFor(identity,row),JSON.parse(event.event_scope_json))
          ||event.route_source_revision!==row.revision||!event.conversation_key))fail('ASSISTANT_COORDINATOR_SOURCE_CHANGED');
      const routes=await client.sourceRoutes({companyId:row.companyId,sourceId:row.id,sourceRevision:row.revision,
        routeIds:[...new Set(events.map(event=>event.route_id))]},signal);lease();
      if(events.some(event=>!routes.some(route=>route.id===event.route_id&&route.conversationKey===event.conversation_key
        &&route.taskId===job.taskId&&route.bindingId===binding.id&&route.bindingRevision===binding.revision)))
        fail('ASSISTANT_COORDINATOR_SOURCE_CHANGED');
    }
  };
  const acknowledgeExternalSource=async(row,signal)=>{
    const source=externalSourceFor(identity,row);
    const current=await client.sourceAccounts(row.companyId,signal);lease();
    if(!sameRegistration(row,current.find(value=>value.id===row.id)))fail('ASSISTANT_COORDINATOR_SOURCE_CHANGED');
    const ack=inbox.claimAcknowledgements(source);if(!ack)return;
    // Capture CAS before native work, independently of whether it can report.
    // Missing diagnostics cannot block or duplicate an admitted provider action.
    let observation=null;
    if(sourceHealth)try{
      const snapshot=await sourceHealth.read(row,signal);lease();
      if(snapshot?.sourceRevision!==row.revision||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0)
        fail('ASSISTANT_COORDINATOR_SOURCE_CHANGED');
      observation=snapshot;
    }catch{emit('ASSISTANT_COORDINATOR_SOURCE_HEALTH_UNAVAILABLE');}
    try{
      const read=()=>inbox.externalAcknowledgementReferences(source,{token:ack.token,sourceRevision:row.revision,verifyOnly:ack.reconcileOnly});
      const references=read(),snapshot=JSON.stringify(references),groups=new Map();
      for(const ref of references){
        // Email ACK is exact-UID, never a whole thread/range write. Fresh
        // leases contain one UID; legacy unknown groups verify every UID.
        const key=source.provider==='email'?ref.eventKey:ref.conversationKey;
        if(!groups.has(key))groups.set(key,[]);groups.get(key).push(ref);
      }
      if(!ack.reconcileOnly&&groups.size!==1)fail('ASSISTANT_COORDINATOR_SOURCE_CHANGED');
      const assertReferences=()=>{lease();if(JSON.stringify(read())!==snapshot)fail('ASSISTANT_COORDINATOR_SOURCE_CHANGED');};
      // A legacy uncertain token may span several conversations. All are
      // verified read-only; no one positive chat can complete the whole token.
      // Fresh tokens are already one conversation before their write fence.
      for(const selected of groups.values()){
        const result=await acknowledgeSource({source:row,references:selected,verifyOnly:ack.reconcileOnly,assertReferences,
          beforeInvoke:()=>{assertReferences();if(!ack.reconcileOnly)inbox.startExternalAcknowledgements(source,ack.token);}},signal);
        assertReferences();
        if(!result||typeof result.acknowledged!=='boolean'||typeof result.notAttempted!=='boolean')fail('ASSISTANT_COORDINATOR_SOURCE_CHANGED');
        if(!result.acknowledged){
          inbox.deferExternalAcknowledgements(source,{token:ack.token,retryAfterMs:300_000,
            notAttempted:!ack.reconcileOnly&&result.notAttempted});
          if(result.code)emit(errorCode(result));return;
        }
      }
      inbox.completeAcknowledgements(source,ack.token);
    }catch(error){
      // A failed/native-unknown write never clears the original attempt bit.
      // Expiry/pause may already have invalidated this lease; retain that exact
      // fence and let a future current source do read-only reconciliation.
      try{inbox.deferExternalAcknowledgements(source,{token:ack.token,retryAfterMs:300_000});}catch{}
      throw error;
    }finally{
      // Even failed/unknown writes have a durable diagnostic, while successful
      // polling has no authority to erase it. With no initial CAS, do not invent
      // revision zero or report from a stale pre-provider observation.
      if(observation)await observeAcknowledgementHealth(row,signal,observation);
    }
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
          // This inventory is authoritative only for Trelio. It says nothing
          // about a separately registered mailbox or messenger stream. Never
          // revoke another provider because it is absent from a Trelio list.
          if(old.scope.provider!=='trelio' || old.state==='revoked' || sources.some(source=>sameSource(source,old.scope))) continue;
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
        if(readSourceMonitor){
          externalRegistrations.clear();externalInventoryComplete=false;let complete=true;
          for(const company of companies){
            try{await syncExternalSources(company.companyId,signal);}
            catch(error){complete=false;emit(errorCode(error));}
          }
          externalInventoryComplete=complete;
        }
        nextDiscoveryAt=now()+300_000;
      }
      // The native notification client and its ACK endpoint understand only
      // Trelio IDs. External sources need their own reviewed reader/ACK adapter;
      // a generic SQLite row cannot silently select the Trelio transport.
      for(const {scope,state} of inbox.listSources()) if(scope.provider==='trelio' && state==='active') {
        try { await pollSource(scope,signal); }
        catch(error) {
          // A provider/company failure must not stop independent companies.
          // Dispatch still does a fresh exact task authorization before start.
          if([401,403].includes(error.status)) throw error;
          emit(errorCode(error));
        }
      }
      // Oldest persisted due position wins across restarts; no in-memory
      // round-robin cursor can repeatedly starve later accounts after a crash.
      const externalDue=[...externalRegistrations.values()].flatMap(row=>{
        const source=externalSourceFor(identity,row),status=inbox.status(source);
        if(status.state!=='active')return [];
        return [...(status.nextPollAt<=now()?[{row,streamId:null,nextPollAt:status.nextPollAt}]:[]),
          ...inbox.dueStreamPolls(source).map(stream=>({row,...stream}))];
      }).sort((left,right)=>left.nextPollAt-right.nextPollAt||left.row.id.localeCompare(right.row.id)
        || (left.streamId??'').localeCompare(right.streamId??'')).slice(0,4);
      for(const {row,streamId} of externalDue){
        try{await pollExternalSource(row,signal,streamId);}
        catch(error){emit(errorCode(error));}
      }
      // Routing is its own native read. A failed lookup neither rolls back an
      // already committed provider page nor masquerades as an empty inventory.
      const routingDue=[...externalRegistrations.values()].flatMap(row=>{
        if(!['telegram-mtproto','email-imap-smtp','max-web'].includes(row.skillId)||inbox.status(externalSourceFor(identity,row)).state!=='active')return [];
        const pending=inbox.pendingExternalRoutes(externalSourceFor(identity,row));return pending.length?[{row,pending}]:[];
      }).sort((a,b)=>a.pending[0].route_checked_at-b.pending[0].route_checked_at||a.row.id.localeCompare(b.row.id)).slice(0,4);
      for(const {row,pending} of routingDue){
        try{await routeExternalSource(row,signal,pending);}catch(error){
          try{inbox.deferExternalRouting(externalSourceFor(identity,row),{sourceRevision:row.revision,eventKeys:pending.map(value=>value.event_key)});}
          catch{/* A changed/paused source cannot receive this old local backoff. */}
          emit(errorCode(error));
        }
      }
      const acknowledgementDue=acknowledgeSource?[...externalRegistrations.values()].flatMap(row=>{
        if(!['telegram-mtproto','email-imap-smtp','max-web'].includes(row.skillId))return [];
        const ordinal=inbox.externalAcknowledgementDue(externalSourceFor(identity,row));return ordinal===null?[]:[{row,ordinal}];
      }).sort((a,b)=>a.ordinal-b.ordinal).slice(0,4):[];
      for(const {row} of acknowledgementDue){
        try{await acknowledgeExternalSource(row,signal);}catch(error){emit(errorCode(error));}
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
    const plan=schedule.register({scope:scopeFor(job.scope,job.taskId),source:job.scope,threadId,cadence:'every_30_minutes',timeZone});
    // A mention-only discussion has a permanent chat but no periodic work.
    // Pause just the timer immediately, before any native schedule report.
    // The accepted inbox binding and its first queued mention remain runnable.
    return taskWorkModes.get(modeKey(job.scope,job.taskId))==='discussion'
      ?schedule.setState(scopeFor(job.scope,job.taskId),{state:'paused',expectedRevision:plan.revision}):plan;
  };
  const completedReceipt = async (job,threadId,nativeReceipt,signal) => {
    if(job.kind==='provision') return {receipt:nativeReceipt,outcome:null};
    if(typeof client.readBusinessOutcome!=='function' || !passHost) fail('ASSISTANT_COORDINATOR_SETUP_REQUIRED');
    const pass=validateAssistantActivePass(await passHost.readActivePass(),identity);
    if(pass.companyId!==job.scope.companyId || pass.taskId!==job.taskId || pass.deliveryId!==job.deliveryId
      || pass.threadId!==threadId) fail('ASSISTANT_COORDINATOR_HOST_REVIEW_REQUIRED');
    const expected={assistantId:identity.assistantId,deviceId:identity.deviceId,companyId:job.scope.companyId,
      taskId:job.taskId,bindingId:pass.bindingId,bindingRevision:pass.bindingRevision,deliveryId:job.deliveryId,threadId};
    // A native turn can end while waiting for a reply, on a tool denial, or
    // before any Workspace save. Only a trusted live backend outcome for this
    // exact pass can acknowledge its source events. This adapter is supplied
    // by the host, never a model-authored "success" boolean or file content.
    let outcome;
    try { outcome=validateAssistantPassOutcome(await client.readBusinessOutcome(expected,signal),expected); }
    catch { fail('ASSISTANT_COORDINATOR_BUSINESS_OUTCOME_REQUIRED'); }
    lease();
    const nativeParts=typeof nativeReceipt==='string'?nativeReceipt.split(':'):[];
    if(outcome.state!=='confirmed'
      || nativeParts.length!==3 || nativeParts[0]!=='codex' || nativeParts[1]!==threadId || !uuid.test(nativeParts[2])) {
      fail('ASSISTANT_COORDINATOR_BUSINESS_OUTCOME_REQUIRED');
    }
    return {receipt:`assistant:${outcome.receiptId}:${nativeReceipt}`,outcome};
  };
  const commitCompletion = async (job,threadId,nativeReceipt,signal) => {
    const result=await completedReceipt(job,threadId,nativeReceipt,signal);
    let binding;
    if(!await authorize({scope:job.scope,taskId:job.taskId},signal,{requireModel:false,
      allowTaskDone:job.kind!=='provision',captureBinding:value=>{binding=value;}})) fail('ASSISTANT_COORDINATOR_TASK_STOPPED');
    // Schedule decision and event processing share the same SQLite commit.
    // Only afterwards may the protected pass journal/key be released. If that
    // release fails, the next reconcile reads this completed row and receipt.
    inbox.completeDelivery(job.deliveryId,result.receipt,result.outcome?{
      continuation:result.outcome.continuation,bindingState:binding.state,
      ...(result.outcome.processedSourceReferences?{processedSourceReferences:result.outcome.processedSourceReferences}:{})}:null);
    if(result.outcome) await passHost.releasePass(result.outcome);
  };
  const intakeSource=async(row,signal)=>{
    const selected=(await client.sourceAccounts(row.scope.companyId,signal)).find(source=>source.id===row.scope.bindingId);lease();
    if(!selected||selected.state!=='active'||row.kind!=='route_existing'&&selected.ownerTaskIntakeAllowed!==true||selected.revision!==row.source_revision
      ||!sameSource(externalSourceFor(identity,selected),row.scope))fail('ASSISTANT_INTAKE_CHANGED');
    return selected;
  };
  const intakeLocator=row=>({companyId:row.scope.companyId,sourceId:row.scope.bindingId,intakeId:row.id});
  const settleIntake=async(row,outcome,signal)=>{
    if(outcome.id!==row.id||outcome.eventId!==row.original_event_id||outcome.threadId!==row.thread_id||!uuid.test(outcome.receiptId??'')
      ||row.kind==='route_existing'&&(outcome.kind!=='route_existing'||JSON.stringify(outcome.eventIds)!==JSON.stringify(row.eventIds)))
      fail('ASSISTANT_INTAKE_CHANGED');
    if(['pending','ready','started','uncertain','waiting_owner'].includes(row.state))inbox.finishOwnerIntake(row.id,outcome);
    row=inbox.ownerIntake(row.id);
    const activePass=await passHost.readActivePass();
    if(activePass){
      if(activePass.kind!=='source_intake'||activePass.passId!==row.id)fail('ASSISTANT_COORDINATOR_HOST_REVIEW_REQUIRED');
      await passHost.releasePass(outcome);
    }
    if(['waiting_owner','ignored','cancelled'].includes(outcome.state))return;
    if(outcome.state==='redirected'){
      const target=outcome.redirect;
      if(!target||target.sourceId===row.scope.bindingId)fail('ASSISTANT_INTAKE_CHANGED');
      const current=(await client.sourceAccounts(target.companyId,signal)).find(source=>source.id===target.sourceId);lease();
      if(!current||current.state!=='active'||current.revision!==target.sourceRevision||row.kind!=='route_existing'&&current.ownerTaskIntakeAllowed!==true
        ||current.localAccountId!==row.scope.accountId||externalProviders[current.skillId]!==row.scope.provider)fail('ASSISTANT_INTAKE_CHANGED');
      const scope=externalSourceFor(identity,current);inbox.register(scope);inbox.observeExternalSourceRevision(scope,current.revision);
      inbox.redirectOwnerIntake(row.id,{scope,sourceRevision:current.revision,receiptId:outcome.receiptId});
      inbox.settleOwnerIntake(row.id);return;
    }
    if(!['created','routed'].includes(outcome.state)||!outcome.route||!uuid.test(outcome.taskId??''))fail('ASSISTANT_INTAKE_CHANGED');
    const companies=await client.companies(signal),company=companies.find(value=>value.companyId===row.scope.companyId);lease();
    if(!company)fail('ASSISTANT_INTAKE_CHANGED');
    const canonical=sourceFor(identity,company);inbox.register(canonical);
    const binding=await client.task(row.scope.companyId,outcome.taskId,signal);lease();apply(canonical,binding);
    if(binding.state!=='accepted'||binding.id!==outcome.route.bindingId||binding.revision!==outcome.route.bindingRevision)
      fail('ASSISTANT_INTAKE_CHANGED');
    // The original event route is installed only AFTER the ordinary task host
    // has provisioned its permanent chat. No fabricated task/chat is created by
    // this router, and no other message in the owner conversation is claimed.
    if(!findSchedule(canonical,outcome.taskId))return;
    const routes=await client.sourceRoutes({companyId:row.scope.companyId,sourceId:row.scope.bindingId,
      sourceRevision:row.source_revision,routeIds:[outcome.route.id]},signal);lease();
    if(routes.length!==1||routes[0].taskId!==outcome.taskId)fail('ASSISTANT_INTAKE_CHANGED');
    inbox.routeExternalEvents(row.scope,{canonicalSource:canonical,sourceRevision:row.source_revision,eventKeys:row.kind==='route_existing'?row.originals.map(event=>event.event_key):[row.event_key],routes,intakeId:row.id});
    inbox.settleOwnerIntake(row.id);
  };
  const deferredIntake=row=>Object.freeze({state:'deferred',kind:'source_intake',intakeId:row.id});
  const blockedIntake=()=>{emit('ASSISTANT_INTAKE_REVIEW_REQUIRED');return {state:'blocked',kind:'source_intake'};};
  const nativeIntakeStopped=async(row,signal)=>{
    // Native domain cancellation revokes mutation authority, but cannot prove
    // that an orphaned Codex invocation stopped after a host crash. Only this
    // exact original turn marker permits releasing the global pass and
    // starting unrelated native work, including after an owned adapter abort.
    const result=await native.readDelivery(row.thread_id,row.delivery_id,{signal});lease();
    return ['completed','failed'].includes(result.state);
  };
  const workIntake=async(signal,visited)=>{
    if(!passHost||typeof workspaceForIntake!=='function')return null;
    const saved=await passHost.readActivePass();
    if(saved&&saved.kind!=='source_intake')return null;
    const candidates=inbox.ownerIntakes(),rowSaved=saved?inbox.ownerIntake(saved.passId):null;
    // Preserve a closed receipt's read-only ACL/transport backoff across ticks.
    // Otherwise its previously accepted task could immediately re-enter normal
    // provision and fail the SAME fresh read ahead of other companies. This
    // defers new work only; it never changes task authority or native fences.
    for(const candidate of candidates)if(candidate.state==='complete'&&candidate.next_check_at>now())
      blockedCompanies.add(candidate.scope.companyId);
    if(rowSaved&&visited.has(rowSaved.id))fail('ASSISTANT_COORDINATOR_HOST_REVIEW_REQUIRED');
    let row=rowSaved??candidates.find(value=>!visited.has(value.id)&&(['started','uncertain'].includes(value.state)
      ||value.state==='provisioning'&&value.native_started===1||value.next_check_at<=now()));
    if(!row)return null;
    if(await native.ready(identity,signal)!==true)fail('ASSISTANT_COORDINATOR_SETUP_REQUIRED');
    row=inbox.ownerIntake(row.id);
    if(row.state==='provisioning'&&row.native_started===1){
      // An unknown tool-free provision is still a real native invocation.
      // Recover its exact original marker BEFORE source/policy backoff; a new
      // policy cannot turn uncertainty into permission to start another chat.
      if(!row.thread_id){emit('ASSISTANT_INTAKE_PROVISION_REVIEW_REQUIRED');return {state:'blocked',kind:'source_intake'};}
      const result=await native.readDelivery(row.thread_id,row.provision_id,{signal});lease();
      if(result.state!=='completed'){emit('ASSISTANT_INTAKE_PROVISION_REVIEW_REQUIRED');return {state:'blocked',kind:'source_intake'};}
      inbox.readyOwnerIntake(row.id);row=inbox.ownerIntake(row.id);
    }
    if(saved&&row.native_started===1&&['complete','waiting_owner'].includes(row.state)
      &&!await nativeIntakeStopped(row,signal))return blockedIntake();
    if(row.state==='waiting_owner'){
      try{await intakeSource(row,signal);}catch(error){
        // The old question cannot survive a stopped generation. Close that
        // exact native lease; only its positive cancelled receipt may seed a
        // later owner-resumed generation. Unknown never becomes a new attempt.
        try{const closed=await client.cancelSourceIntake(intakeLocator(row),signal);lease();
          if(!['created','routed','ignored','redirected','cancelled'].includes(closed.state))throw error;
          await settleIntake(row,closed,signal);
        }catch(closing){if(saved)throw closing;inbox.deferOwnerIntake(row.id);}
        return deferredIntake(row);
      }
    }
    if(row.state==='complete'||row.state==='waiting_owner'){
      let outcome;try{outcome=await client.readSourceIntake(intakeLocator(row),signal);lease();}
      catch(error){if(saved)throw error;inbox.deferOwnerIntake(row.id);return deferredIntake(row);}
      if(outcome.state==='leased'&&row.state==='waiting_owner'){
        inbox.resumeOwnerIntake(row.id);row=inbox.ownerIntake(row.id);
      }else{
        try{await settleIntake(row,outcome,signal);}
        catch(error){
          // A positive created receipt is immutable even if its later task
          // binding was revoked or a fresh ACL/network read failed. With no
          // remaining native pass, defer that receipt once rather than block
          // every other company or recreate/route/ACK the original command.
          if(await passHost.readActivePass())throw error;
          blockedCompanies.add(row.scope.companyId);inbox.deferOwnerIntake(row.id);emit(errorCode(error));return deferredIntake(row);
        }
        if(outcome.state==='waiting_owner')inbox.deferOwnerIntake(row.id);return deferredIntake(row);
      }
    }
    let source;
    try{source=await intakeSource(row,signal);}
    catch(error){
      if(saved?.passId===row.id||['started','uncertain'].includes(row.state)){
        const outcome=await client.cancelSourceIntake(intakeLocator(row),signal);lease();
        if(!['created','routed','ignored','redirected','cancelled'].includes(outcome.state)||!uuid.test(outcome.receiptId??''))throw error;
        if(row.native_started===1&&!await nativeIntakeStopped(row,signal))return blockedIntake();
        inbox.finishOwnerIntake(row.id,outcome);if(saved)await passHost.releasePass(outcome);
        // Source revocation does not prove an old native process stopped.
        // A started invocation needs exact terminal read-back; a never-started
        // preparation does not invent a marker. Continue without further task
        // ACL/route reads. Original refs stay unprocessed/unacked.
        if(['created','routed','redirected'].includes(outcome.state))inbox.settleOwnerIntake(row.id);
      }else if(row.state==='ready'||row.kind==='route_existing'&&row.state==='pending'&&row.frozen){
        try{const closed=await client.cancelSourceIntake(intakeLocator(row),signal);lease();
          if(!['created','routed','ignored','redirected','cancelled'].includes(closed.state))throw error;
          inbox.finishOwnerIntake(row.id,closed);if(['created','routed','redirected'].includes(closed.state))inbox.settleOwnerIntake(row.id);
        }catch{inbox.deferOwnerIntake(row.id);}
      }else inbox.deferOwnerIntake(row.id);
      return deferredIntake(row);
    }
    if(['started','uncertain'].includes(row.state)){
      const outcome=await client.readSourceIntake(intakeLocator(row),signal);lease();
      const nativeResult=await native.readDelivery(row.thread_id,row.delivery_id,{signal});lease();
      if(['completed','failed'].includes(nativeResult.state)&&outcome.state!=='leased'){
        await settleIntake(row,outcome,signal);return deferredIntake(row);
      }
      if(Date.parse(outcome.leaseExpiresAt)<=now()){
        const closed=await client.cancelSourceIntake(intakeLocator(row),signal);lease();
        if(closed.state!=='cancelled')fail('ASSISTANT_INTAKE_REVIEW_REQUIRED');
        if(!['completed','failed'].includes(nativeResult.state))return blockedIntake();
        await settleIntake(row,closed,signal);emit('ASSISTANT_INTAKE_REVIEW_REQUIRED');return deferredIntake(row);
      }
      return blockedIntake();
    }
    let selection=null;
    if(row.kind==='route_existing'&&row.state==='pending'){
      // Select the company under the native account/owner engine BEFORE even a
      // tool-free Codex chat exists. Unknown begin is safe only as exact native
      // receipt read-back/idempotent admission, never a model or provider retry.
      row=inbox.freezeExistingTaskIntake(row.id);
      selection=await client.beginSourceIntake({...intakeLocator(row),kind:'route_existing',sourceRevision:row.source_revision,
        eventId:row.original_event_id,eventIds:row.eventIds,threadId:null,conversationKey:row.conversation_key,
        ...(row.redirect_from_intake_id?{redirectFromIntakeId:row.redirect_from_intake_id}:{})},signal);lease();
      if(selection.state!=='leased'){await settleIntake(row,selection,signal);return deferredIntake(row);}
      if(Date.parse(selection.leaseExpiresAt)<=now()){
        const closed=await client.cancelSourceIntake(intakeLocator(row),signal);lease();
        await settleIntake(row,closed,signal);return deferredIntake(row);
      }
    }
    const company=(await client.companies(signal)).find(value=>value.companyId===row.scope.companyId);lease();
    if(company?.execution?.state!=='ready'){
      // No native turn/pass has started. Preserve this original event and
      // back off only its row; another company's due intake/task may proceed.
      blockedCompanies.add(row.scope.companyId);inbox.deferOwnerIntake(row.id);
      emit('ASSISTANT_COORDINATOR_MODEL_POLICY_BLOCKED');return deferredIntake(row);
    }
    let execution=assistantExecutionConfiguration(selection?.execution??company.execution.configuration);
    const cwd=await workspaceForIntake({companyId:row.scope.companyId,sourceId:row.scope.bindingId});
    if(row.state==='pending'){inbox.prepareOwnerIntake(row.id);row=inbox.ownerIntake(row.id);}
    if(row.state==='provisioning'){
      if(row.native_started)fail('ASSISTANT_COORDINATOR_HOST_REVIEW_REQUIRED');
      const result=await native.provision({deliveryId:row.provision_id,cwd,execution},{signal,
        startInvocation:()=>{lease();inbox.startOwnerIntakeProvision(row.id);},onThreadStarted:threadId=>inbox.bindOwnerIntakeThread(row.id,threadId)});
      if(result.state!=='completed')fail('ASSISTANT_INTAKE_PROVISION_REVIEW_REQUIRED');
      inbox.readyOwnerIntake(row.id);row=inbox.ownerIntake(row.id);
    }
    if(row.state!=='ready')fail('ASSISTANT_INTAKE_CHANGED');
    let owner;
    if(row.kind!=='route_existing'){
      owner=(await client.ownerIdentities(signal)).identities.find(value=>value.provider===row.scope.provider);lease();
      if(!owner||owner.bindingId!==row.owner_identity_id)fail('ASSISTANT_INTAKE_OWNER_UNVERIFIED');
    }
    const admitted=await client.beginSourceIntake({...intakeLocator(row),sourceRevision:row.source_revision,eventId:row.original_event_id,
      threadId:row.thread_id,conversationKey:row.conversation_key,...(row.kind==='route_existing'
        ?{kind:'route_existing',eventIds:row.eventIds,...(row.redirect_from_intake_id?{redirectFromIntakeId:row.redirect_from_intake_id}:{})}
        :{ownerIdentityId:owner.bindingId,senderExternalUserId:owner.externalUserId})},signal);lease();
    if(admitted.state!=='leased'||admitted.threadId!==row.thread_id||Date.parse(admitted.leaseExpiresAt)<=now())fail('ASSISTANT_INTAKE_REVIEW_REQUIRED');
    execution=assistantExecutionConfiguration(admitted.execution);
    const pass=validateAssistantActivePass({schemaVersion:1,kind:'source_intake',assistantId:identity.assistantId,deviceId:identity.deviceId,
      companyId:row.scope.companyId,sourceId:source.id,sourceRevision:source.revision,passId:row.id,deliveryId:row.delivery_id,
      eventId:row.original_event_id,threadId:row.thread_id,...(row.kind==='route_existing'?{intakeKind:'route_existing',eventIds:row.eventIds}:{})},identity);
    await passHost.activatePass(pass);
    let started=false,watching=false,cancelledOutcome=null;
    const settleOwnedCancellation=async()=>{
      // The native CLI adapter may reject immediately after requesting kill;
      // that promise alone is not proof of child/turn termination. Reconcile
      // the original marker with the independent outer signal before release.
      // Before the synchronous durable start CAS there is no model invocation;
      // a cancelled preparation can close without inventing a turn marker.
      if(started&&!await nativeIntakeStopped(inbox.ownerIntake(row.id),signal)){
        if(started&&inbox.ownerIntake(row.id).state==='started')inbox.uncertainOwnerIntake(row.id);
        return blockedIntake();
      }
      await settleIntake(inbox.ownerIntake(row.id),cancelledOutcome,signal);
      return {state:'cancelled',kind:'source_intake'};
    };
    const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const watch=setInterval(()=>{if(watching)return;watching=true;
      void client.readSourceIntake(intakeLocator(row),combined).then(value=>{
        // Explicit native cancellation is the one closed outcome that stops a
        // running intake immediately. Created/waiting/ignored still need its
        // ordinary final marker; only this positive original receipt releases
        // the pass after the exact original native terminal read-back.
        if(value.state==='cancelled'){
          if(!uuid.test(value.receiptId??''))fail('ASSISTANT_INTAKE_CHANGED');
          cancelledOutcome=value;controller.abort();
        }else if(value.state==='leased'&&Date.parse(value.leaseExpiresAt)<=now())controller.abort();
      }).catch(()=>controller.abort()).finally(()=>{watching=false;});},watchIntervalMs);
    try{
      const result=await native.run({threadId:row.thread_id,deliveryId:row.delivery_id,cwd,execution,
        intakeContext:{assistantId:identity.assistantId,companyId:row.scope.companyId,sourceId:source.id,sourceRevision:source.revision,
          intakeId:row.id,eventId:row.original_event_id,...(row.kind==='route_existing'?{intakeKind:'route_existing',eventIds:row.eventIds}:{})}}, {signal:combined,startInvocation:()=>{lease();inbox.startOwnerIntake(row.id);started=true;}});
      if(cancelledOutcome)return settleOwnedCancellation();
      const outcome=await client.readSourceIntake(intakeLocator(row),combined);lease();
      if(result.state!=='completed'||outcome.state==='leased')fail('ASSISTANT_INTAKE_REVIEW_REQUIRED');
      await settleIntake(inbox.ownerIntake(row.id),outcome,combined);return {state:'completed',kind:'source_intake'};
    }catch(error){
      if(cancelledOutcome)return settleOwnedCancellation();
      if(started&&inbox.ownerIntake(row.id).state==='started')inbox.uncertainOwnerIntake(row.id);
      throw error;
    }finally{clearInterval(watch);controller.abort();}
  };
  const reconcile = async signal => {
    const saved=passHost?await passHost.readActivePass():null;
    if(saved) {
      const pass=validateAssistantActivePass(saved,identity);
      if(pass.kind==='source_intake')return true;
      const row=inbox.readDelivery(pass.deliveryId);
      if(row.taskId!==pass.taskId || row.scope.companyId!==pass.companyId || row.scope.assistantId!==identity.assistantId
        || row.kind!=='task') fail('ASSISTANT_COORDINATOR_HOST_REVIEW_REQUIRED');
      if(row.state==='complete') {
        const nativeResult=await native.readDelivery(pass.threadId,pass.deliveryId,{signal});lease();
        if(nativeResult.state!=='completed') fail('ASSISTANT_COORDINATOR_DELIVERY_REVIEW_REQUIRED');
        const result=await completedReceipt(row,pass.threadId,nativeResult.receipt,signal);
        if(row.receipt!==result.receipt) fail('ASSISTANT_COORDINATOR_BUSINESS_OUTCOME_REQUIRED');
        await passHost.releasePass(result.outcome);
      }
    }
    const [job]=inbox.incompleteDeliveries(); if(!job) return false;
    if(job.state==='leased') return true;
    if(!job.nativeStarted) {
      // Only the host/pass claim is uncertain. The persisted native-start bit proves
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
      await commitCompletion(job,threadId,result.receipt,signal);
      notices.clear();
      return false;
    }
    if(result.state==='failed') emit('ASSISTANT_COORDINATOR_DELIVERY_REVIEW_REQUIRED');
    return true;
  };
  const perform = async (job,signal) => {
    const controller=new AbortController();
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    let checking=false,started=false,taskPass=null,failureStage='native_claim';
    const watch=setInterval(()=>{
      if(checking) return; checking=true;
      void (async()=>{
        let watchedBinding;
        if(!await authorize({scope:job.scope,taskId:job.taskId},combined,{job,allowTaskDone:job.kind!=='provision' && started,
          captureBinding:value=>{watchedBinding=value;}})) fail('ASSISTANT_COORDINATOR_TASK_STOPPED');
        if(started && watchedBinding.state==='accepted') inbox.renewDelivery(job.deliveryId);
        if(taskPass) {
          const live=await client.readTaskPass({companyId:job.scope.companyId,taskId:job.taskId,passId:taskPass.passId},combined);
          if(live.state==='closed') return;
          if(live.state!=='leased') fail('ASSISTANT_PASS_REVIEW_REQUIRED');
          if(watchedBinding.state==='accepted' && Date.parse(live.leaseExpiresAt)-now()<300_000) await client.renewTaskPass({companyId:job.scope.companyId,
            taskId:job.taskId,passId:taskPass.passId,expectedLeaseRevision:live.leaseRevision,clientRequestId:randomUUID()},combined);
        }
      })().catch(()=>controller.abort()).finally(()=>{checking=false;});
    },watchIntervalMs);
    try {
      let execution;
      if(!await authorize({scope:job.scope,taskId:job.taskId},combined,{job,captureExecution:value=>{execution=value;}})) fail('ASSISTANT_COORDINATOR_TASK_STOPPED');
      const cwd=await workspaceForTask(scopeFor(job.scope,job.taskId));
      if(!await authorize({scope:job.scope,taskId:job.taskId},combined,{job,captureExecution:value=>{execution=value;}})) fail('ASSISTANT_COORDINATOR_TASK_STOPPED');
      const options={signal:combined,startInvocation:()=>{lease();inbox.startDelivery(job.deliveryId);started=true;failureStage='native_started';}};
      let result;
      if(job.kind==='provision') {
        inbox.prepareProvision(job.deliveryId);started=true;
        const authority=inbox.taskState(job.scope,job.taskId).authority;
        const claim=await client.claimTaskHost({companyId:job.scope.companyId,taskId:job.taskId,bindingId:authority.bindingId,
          bindingRevision:authority.revision,provisionId:job.deliveryId},combined);
        if(claim.threadId!==null) {
          // A restored local snapshot may lag the server's already registered
          // chat. Adopt only exact positive native read-back on this host.
          failureStage='readback';result=await native.readDelivery(claim.threadId,job.deliveryId,{signal:combined});
          if(result.state!=='completed') fail('ASSISTANT_COORDINATOR_PROVISION_REVIEW_REQUIRED');
          options.startInvocation();inbox.bindProvisionedThread(job.deliveryId,claim.threadId);
          result={...result,threadId:claim.threadId};
        } else {
        failureStage='native_preflight';
        result=await native.provision({deliveryId:job.deliveryId,cwd,execution},{...options,
          onThreadStarted:threadId=>inbox.bindProvisionedThread(job.deliveryId,threadId)});
        }
        registerChat(job,result.threadId);
      } else {
        if(!passHost || ['beginTaskPass','readTaskPass','renewTaskPass','readBusinessOutcome'].some(key=>typeof client[key]!=='function')) fail('ASSISTANT_COORDINATOR_SETUP_REQUIRED');
        const plan=findSchedule(job.scope,job.taskId);
        if(!plan) fail('ASSISTANT_COORDINATOR_THREAD_REQUIRED');
        inbox.prepareTaskPass(job.deliveryId);started=true;
        const authority=inbox.taskState(job.scope,job.taskId).authority;
        const admitted=await client.beginTaskPass({companyId:job.scope.companyId,taskId:job.taskId,bindingId:authority.bindingId,
          bindingRevision:authority.revision,deliveryId:job.deliveryId,threadId:plan.threadId},combined);lease();
        if(admitted.state!=='leased' || admitted.bindingId!==authority.bindingId || admitted.bindingRevision!==authority.revision
          || admitted.deliveryId!==job.deliveryId || admitted.threadId!==plan.threadId
          || !Number.isFinite(Date.parse(admitted.leaseExpiresAt)) || Date.parse(admitted.leaseExpiresAt)<=now()) fail('ASSISTANT_PASS_REVIEW_REQUIRED');
        taskPass=validateAssistantActivePass({schemaVersion:1,assistantId:identity.assistantId,deviceId:identity.deviceId,companyId:job.scope.companyId,taskId:job.taskId,
          passId:admitted.passId,deliveryId:job.deliveryId,threadId:plan.threadId,bindingId:authority.bindingId,bindingRevision:authority.revision},identity);
        // Origin belongs to host identity, not the exact pass ABI.
        await passHost.activatePass(taskPass);
        execution=assistantExecutionConfiguration(admitted.execution);
        failureStage='native_preflight';
        result=await native.run({threadId:plan.threadId,deliveryId:job.deliveryId,cwd,execution,
          taskContext:{assistantId:identity.assistantId,companyId:job.scope.companyId,taskId:job.taskId,
            ...(admitted.workMode==='discussion'?{workMode:'discussion'}:{}),
            ...(job.events.some(event=>event.conversation_key)?{sourceReferences:job.events.filter(event=>event.conversation_key).map(event=>{
              const source=JSON.parse(event.event_scope_json);
              return {sourceId:source.bindingId,sourceRevision:event.route_source_revision,routeId:event.route_id,eventOrdinal:event.event_ordinal,provider:source.provider,
                accountId:source.accountId,eventId:event.event_id,eventRevision:event.event_revision,conversationKey:event.conversation_key,
                ...(inbox.sourceIntakeKind({eventKey:event.event_key,routeId:event.route_id,sourceRevision:event.route_source_revision})==='route_existing'?{intakeKind:'route_existing'}:{})};
            })}:{}),
            // Only current delivery refs enter stdin. Full answers are read
            // by the task worker under fresh backend pass/owner/assignment ACL.
            ...(job.events.some(event=>event.owner_question_id) ? {ownerQuestionIds:[...new Set(job.events
              .flatMap(event=>event.owner_question_id?[event.owner_question_id]:[]))]} : {})}},options);
      }
      failureStage='readback';
      if(result.state!=='completed') fail('ASSISTANT_COORDINATOR_DELIVERY_REVIEW_REQUIRED');
      const threadId=job.kind==='provision'?result.threadId:findSchedule(job.scope,job.taskId)?.threadId;
      await commitCompletion(job,threadId,result.receipt,combined);
      return {state:'completed',kind:job.kind};
    } catch(error) {
      if(started) {
        if(inbox.readDelivery(job.deliveryId).state!=='complete') inbox.markDeliveryUncertain(job.deliveryId,assistantDeliveryFailure(error?.code,failureStage));
      } else inbox.abandonUnstartedDelivery(job.deliveryId);
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
      blockedCompanies=new Set();
      lease();
      const saved=passHost?await passHost.readActivePass():null;
      if(saved?.kind!=='source_intake'&&await reconcile(signal))return {state:'blocked'};
      // Read-only waiting/policy/source recovery owns no native invocation.
      // Walk the bounded existing page so its oldest row cannot starve every
      // later company on each five-minute worker. Unknown/started work still
      // returns blocked and preserves the protected active-pass fence.
      const visitedIntakes=new Set();
      for(let attempt=0;attempt<100;attempt++){
        const intake=await workIntake(signal,visitedIntakes);
        // A positive created receipt may still await ordinary task provision.
        // Inspect it once on THIS worker, then allow that provision instead of
        // rereading the same zero-backoff receipt up to the page limit.
        if(intake?.state==='deferred'){visitedIntakes.add(intake.intakeId);continue;}
        if(intake)return intake;
        break;
      }
      if(await reconcile(signal)) return {state:'blocked'};
      // Readiness includes the dedicated assistant MCP/plugin admission. A
      // working executable or human OAuth alone cannot enable business work.
      if(await native.ready(identity,signal)!==true) fail('ASSISTANT_COORDINATOR_SETUP_REQUIRED');
      const claim = async input => {
        const before=blockedCompanies.size;
        try { return await inbox.claimDelivery({...input,excludeCompanyIds:[...blockedCompanies],authorize:value=>authorize(value,signal)}); }
        catch(error) {
          // A policy-blocked first candidate must not starve another company.
          // No delivery was allocated, events acknowledged or schedule changed.
          if(error.code==='ASSISTANT_INBOX_ACCESS_DENIED' && blockedCompanies.size>before) return undefined;
          throw error;
        }
      };
      for(const {scope,state} of inbox.listSources()) if(scope.provider==='trelio' && state==='active' && !blockedCompanies.has(scope.companyId)) {
        for(const task of inbox.listTasks(scope).filter(task=>task.state==='accepted' && !findSchedule(scope,task.taskId))) {
          const job=await claim({provisionTask:{scope,taskId:task.taskId}});
          if(job) return perform(job,signal);
          if(blockedCompanies.has(scope.companyId)) break;
        }
      }
      for(let attempt=0;attempt<=256;attempt++) {
        const job=await claim({});
        if(job) return perform(job,signal);
        if(job===null) break;
      }
      for(let attempt=0;attempt<=256;attempt++) {
        const due=schedule.nextDue([...blockedCompanies]);
        if(!due) break;
        const job=await claim({scheduledTask:{scope:due.source,taskId:due.taskId}});
        if(job) return perform(job,signal);
        if(job===null) break;
      }
      return null;
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
    async dispatchStatus(signal) {
      // This is deliberately not pollOnce/syncTasks: status cannot advance a
      // cursor, claim a delivery, process/ACK an event or alter model choices.
      try{
        const companies=await client.companies(combinedSignal(signal));
        const summary=readAssistantInboxDispatchSummary({database,identity,companies});
        return assistantDispatchDiagnostics({companies,summary,now:now(),active:active!==null});
      }catch{return assistantDispatchDiagnostics({now:now()});}
    },
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
