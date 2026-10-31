/** External Telegram boundary for the private backend's question system stand.
 * Only disposable fixture accounts/text enter this adapter. Native source and
 * package admission still go through the real authenticated HTTP endpoint; the
 * production reader/reply validator and SQLite attempt/positive fences surround
 * this external call. It neither implements company search nor invents a native
 * intake/receipt. No part of this file is included in the runtime package.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {isStableVersionAtLeast} from '../../../host-runtime/scripts/trelio-workspace.mjs';

export const questionProviderPackage=configuration=>async(input,action)=>{
  assert.equal(configuration.schema,'trelio.test.company-context/v1');
  assert.equal(await fs.realpath(process.env.HOME),await fs.realpath(configuration.root));
  const headers={authorization:`Bearer ${configuration.credential}`,
    'content-type':'application/json','x-trelio-agent-workspaces-version':'999.0.0',
    'x-trelio-host-runtime-version':'999.0.0','x-trelio-assistant-source-protocol':'1',
    ...(configuration.managedFingerprint?{'x-trelio-assistant-source-encryption-fingerprint':configuration.managedFingerprint}:{})};
  const response=await fetch(configuration.identity.origin+'/api/digital-assistants/runtime/source-skills/resolve',{
    method:'POST',headers,body:JSON.stringify({...input.scope,expectedReleaseId:null,sourceIntake:input.sourceIntake}),
    signal:input.signal,redirect:'error'});
  assert.equal(response.status,200,'the genuine native package/owner/recipient admission must succeed');
  const resolved=await response.json(),admission=resolved.sourceAdmission.intake;
  assert.equal(admission.intakeId,input.sourceIntake.intakeId);
  assert.equal(admission.eventId,input.intakeExecution.eventId);
  assert.equal(admission.threadId,input.intakeExecution.threadId);
  assert.equal(admission.localAccountId,configuration.source.localAccountId);
  const reference=configuration.reference;
  const engine={
    isStableVersionAtLeast,
    async prepareSkillAccount({runtimeArguments}){
      assert.equal(runtimeArguments[2],configuration.source.localAccountId);
      return {handled:false,account:{id:configuration.source.localAccountId},runtimeArguments};
    },
    async runMaterializedAgentSkill({runtimeArguments,captureMode}){
      // This is the final external invocation, not an earlier mock success.
      // Recheck the production source/pass immediately before calling its
      // durable beforeInvoke fence, exactly as the signed executor does.
      await input.intakeExecution.beforeInvoke();
      if(captureMode==='assistant_source_intake'){
        assert.equal(runtimeArguments[0],'read-reference');
        return {exitCode:0,stdout:JSON.stringify({schemaVersion:1,protocol:'telegram-message-read/v1',
          reference:{...reference,senderNamespace:'telegram_user_id',senderUserId:admission.ownerExternalUserId,
            outgoing:false,forwarded:false,viaBot:false},
          message:{text:configuration.originalText,textTruncated:false,replyContext:null},
          coverage:{textComplete:true,contextIncluded:false,attachmentsContentRead:false},
          readState:{mode:'history-only',marksRead:false,readReceiptsSent:false,viewsRegistered:false}})};
      }
      assert.equal(captureMode,'assistant_source_reply');assert.equal(runtimeArguments[0],'reply-reference');
      assert.equal(admission.kind,'reply_owner');assert.equal(admission.receiptId,input.sourceIntake.replyReceiptId);
      const capture=path.join(configuration.root,'synthetic-provider-sends.jsonl');
      const prior=await fs.readFile(capture,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
      const ordinal=configuration.replyOrdinal??1,rows=prior.trim()?prior.trim().split('\n').map(line=>JSON.parse(line)):[];
      assert.equal(rows.length,ordinal-1,'each admitted reply may invoke the external provider exactly once');
      assert.ok(!rows.some(row=>row.receiptId===admission.receiptId),'a known or unknown send is never replayed');
      const messageId=900+ordinal;
      await fs.writeFile(capture,prior+JSON.stringify({reference,receiptId:admission.receiptId,
        text:input.intakeExecution.replyText,messageId})+'\n',{mode:0o600,flag:ordinal===1?'wx':'w'});
      if(configuration.fault==='lost_send')throw Object.assign(Error('synthetic lost provider result'),{code:'ASSISTANT_OWNER_REPLY_UNCERTAIN'});
      return {exitCode:0,stdout:JSON.stringify({schemaVersion:1,protocol:'telegram-owner-reply/v1',ok:true,sent:true,
        automaticRetryAllowed:false,reference,replyToMessageId:Number(reference.id.split(':')[2]),messageId})};
    },
  };
  return action({engine,profile:{remainingMs:async()=>60000,readIntakeOwner:async()=>admission},
    materialized:{artifact:resolved.artifact,runtimeDirectory:configuration.root},
    resolution:{releaseId:resolved.releaseId,localIdentity:resolved.localIdentity,companyConnection:resolved.companyConnection},
    signal:input.signal});
};
