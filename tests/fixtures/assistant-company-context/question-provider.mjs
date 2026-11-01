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
import {spawn} from 'node:child_process';
import {isStableVersionAtLeast} from '../../../host-runtime/scripts/trelio-workspace.mjs';
import {assistantOwnerReplyInput} from '../../../host-runtime/scripts/trelio-assistant-transport.mjs';

/** Cross-repository TEST input, not a runtime/model executable override. The
 * required private gate checks out immutable public provider bytes and owns a
 * disposable SDK venv. Only its external Telegram client is replaced below. */
export const callQuestionTelegram=async(configuration,input)=>{
  assert.ok(path.isAbsolute(configuration.telegramPython));
  assert.ok(path.isAbsolute(configuration.telegramProviderRoot));
  const projected={root:configuration.root,companyId:configuration.companyId,identity:{assistantId:configuration.identity.assistantId},
    source:{localAccountId:configuration.source.localAccountId},ownerExternalUserId:configuration.ownerExternalUserId,
    originalText:configuration.originalText,telegramProviderRoot:configuration.telegramProviderRoot,
    reference:configuration.reference,replyOrdinal:configuration.replyOrdinal,replyMessageOrdinal:configuration.replyMessageOrdinal};
  return new Promise((resolve,reject)=>{
    const child=spawn(configuration.telegramPython,[new URL('./question-telegram.py',import.meta.url).pathname],{
      env:process.env,stdio:['pipe','pipe','ignore'],windowsHide:true});let stdout='',settled=false;
    const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
    child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>16_384)child.kill('SIGKILL');});
    child.once('error',()=>{settled=true;clearTimeout(timer);reject(Error('Synthetic Telegram process startup failed'));});
    child.once('close',code=>{clearTimeout(timer);if(settled)return;
      if(code!==0)return reject(Error(`Synthetic Telegram process failed (${Number.isInteger(code)?code:'signal'})`));
      try{resolve(JSON.parse(stdout));}catch{reject(Error('Synthetic Telegram result invalid'));}});
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify({...input,configuration:projected}));
  });
};

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
      assert.ok(['reply_owner','verify_owner_reply'].includes(admission.kind));assert.equal(admission.receiptId,input.sourceIntake.replyReceiptId);
      assert.equal(input.sourceIntake.replyProtocolVersion,2);
      if(input.intakeExecution.replyDocument?.filePath)await fs.writeFile(path.join(configuration.root,'synthetic-prepared-file.json'),
        JSON.stringify({filePath:input.intakeExecution.replyDocument.filePath}),{mode:0o600});
      const value=await callQuestionTelegram(configuration,{receiptId:admission.receiptId,
        arguments:runtimeArguments.filter((value,index)=>index!==1&&index!==2),
        privateInput:assistantOwnerReplyInput(input.sourceIntake,input.intakeExecution).toString('base64')});
      if(configuration.fault==='lost_send'&&admission.kind==='reply_owner')throw Object.assign(Error('synthetic lost provider result'),{code:'ASSISTANT_OWNER_REPLY_UNCERTAIN'});
      return {exitCode:0,stdout:JSON.stringify({ok:true,...value})};
    },
  };
  return action({engine,profile:{remainingMs:async()=>60000,readIntakeOwner:async()=>admission},
    materialized:{artifact:resolved.artifact,runtimeDirectory:configuration.root},
    resolution:{releaseId:resolved.releaseId,localIdentity:resolved.localIdentity,companyConnection:resolved.companyConnection},
    signal:input.signal});
};
