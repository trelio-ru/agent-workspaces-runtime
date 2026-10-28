import { randomUUID } from 'node:crypto';
/** Pure projection of the documented App Server account/rateLimits/read DTO.
 * Never forward account IDs, balance/reset credits, provider prose or labels.
 * Primary/secondary are slots, not durations: either may be the weekly window.
 */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw Object.assign(new Error('ASSISTANT_CODEX_USAGE_UNAVAILABLE'), {code:'ASSISTANT_CODEX_USAGE_UNAVAILABLE'}); };
export const normalizeAssistantCodexUsage = value => {
  if(!object(value)||!object(value.rateLimits))invalid();
  const byId=value.rateLimitsByLimitId;
  if(byId!=null&&!object(byId))invalid();
  const entries=byId==null?[[value.rateLimits.limitId??'codex',value.rateLimits]]:Object.entries(byId);
  if(entries.length>16)invalid();
  const windows=[];
  for(const [limitId,bucket] of entries){
    if(!/^[a-zA-Z0-9._:-]{1,80}$/u.test(limitId)||!object(bucket))invalid();
    for(const slot of ['primary','secondary']){
      const window=bucket[slot];if(window==null)continue;
      if(!object(window)||!Number.isInteger(window.usedPercent)||window.usedPercent<0)invalid();
      const duration=window.windowDurationMins??null,reset=window.resetsAt??null;
      if(duration!==null&&(!Number.isSafeInteger(duration)||duration<=0||duration>525600)
        ||reset!==null&&(!Number.isSafeInteger(reset)||reset<0||reset>253402300799))invalid();
      windows.push({limitId,slot,remainingPercent:Math.max(0,100-window.usedPercent),windowDurationMins:duration,resetsAt:reset});
    }
  }
  // Only the ordinary Codex bucket establishes a device-wide pause. A separate
  // model bucket may be empty while another selected model remains usable.
  const bucket=byId==null?value.rateLimits:byId.codex;
  let state='unknown';
  if(bucket){
    const reached=bucket.rateLimitReachedType;
    const hard=['workspace_owner_credits_depleted','workspace_member_credits_depleted',
      'workspace_owner_usage_limit_reached','workspace_member_usage_limit_reached'].includes(reached);
    const credits=bucket.credits;
    const paid=object(credits)&&(credits.hasCredits===true||credits.unlimited===true);
    const empty=object(credits)&&credits.hasCredits===false&&credits.unlimited===false;
    if(bucket.spendControlReached===true||hard)state='blocked';
    else if(paid||value.ordinaryUsageAllowed===true)state='available';
    else if(empty&&(value.ordinaryUsageAllowed===false||reached==='rate_limit_reached'))state='blocked';
    // A reset time or 100% usage is advisory. It never authorizes recovery,
    // a credit purchase/reset, a model change or a replay of a failed action.
  }
  return {state,windows};
};

export const validateAssistantCodexUsage = value => {
  if(!object(value)||Object.keys(value).sort().join(',')!=='state,windows'
    ||!['available','blocked','unknown','unsupported'].includes(value.state)||!Array.isArray(value.windows)||value.windows.length>32)invalid();
  const keys=new Set();
  const windows=value.windows.map(window=>{
    if(!object(window)||Object.keys(window).sort().join(',')!=='limitId,remainingPercent,resetsAt,slot,windowDurationMins'
      ||typeof window.limitId!=='string'||!/^[a-zA-Z0-9._:-]{1,80}$/u.test(window.limitId)
      ||!['primary','secondary'].includes(window.slot)||!Number.isFinite(window.remainingPercent)||window.remainingPercent<0||window.remainingPercent>100
      ||window.windowDurationMins!==null&&(!Number.isSafeInteger(window.windowDurationMins)||window.windowDurationMins<=0||window.windowDurationMins>525600)
      ||window.resetsAt!==null&&(!Number.isSafeInteger(window.resetsAt)||window.resetsAt<0||window.resetsAt>253402300799))invalid();
    const key=`${window.limitId}:${window.slot}`;if(keys.has(key))invalid();keys.add(key);
    return {...window};
  });
  return {state:value.state,windows};
};

/** The existing supervisor calls this without a model. Unknown/malformed/native
 * read failures preserve the last accepted observation and every block fence.
 * A CAS/report failure never repeats a POST or changes business execution.
 */
export const maintainAssistantCodexUsage = async ({client,readUsage,signal}) => {
  const current=await client.readCodexUsage(signal);
  let snapshot;
  try{snapshot=validateAssistantCodexUsage(await readUsage(signal));}catch{return current;}
  try{return await client.reportCodexUsage({expectedRevision:current.revision,clientRequestId:randomUUID(),snapshot},signal);}
  catch{return {...current,blocked:current.blocked||snapshot.state==='blocked'};}

};
