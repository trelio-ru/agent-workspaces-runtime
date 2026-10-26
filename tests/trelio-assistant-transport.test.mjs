import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, randomBytes, generateKeyPairSync, verify, webcrypto, createHash, createPublicKey } from 'node:crypto';
import fs from 'node:fs/promises';
import { createAssistantHttp, createAssistantDeviceClient, createAssistantPairingClient, AssistantTransportError, createAssistantMcpClient, assistantModelInputSchema, prepareAssistantCompanyEncryption, validateAssistantEncryptedTaskRead, materializeAssistantEncryptedTask, withAssistantManagedContentArguments, validateAssistantNativeInputShape } from '../host-runtime/scripts/trelio-assistant-transport.mjs';
import { buildAgentDeviceRegistrationRecord, verifyCompanyEncryptionRecord, hpkeSeal, encryptCompanyPayload, buildCompanyEncryptedTextMarker, canonicalJson,
  encryptFileToCompanyContainer, decryptCompanyPayload, unlockRememberedAgentEncryptionDevice } from '../host-runtime/scripts/trelio-company-encryption.mjs';

const memoryStore = () => {
  const values=new Map(); const key=input=>JSON.stringify(input);
  return { get:async input=>structuredClone(values.get(key(input))??null),
    put:async(input,value)=>values.set(key(input),structuredClone(value)),remove:async input=>values.delete(key(input)) };
};

test('native MAX selectors are canonical nonzero signed 64-bit IDs, never zero aliases',async()=>{
  const {assistantMaxChatUrl}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  for(const id of ['1','-1','9223372036854775807','-9223372036854775808'])assert.equal(assistantMaxChatUrl(`https://web.max.ru/${id}`),true);
  for(const id of ['0','-0','01','-01','+1','9223372036854775808','-9223372036854775809','1/','1?next=2','@owner'])
    assert.equal(assistantMaxChatUrl(`https://web.max.ru/${id}`),false);
});

test('managed encryption enrollment uses common registration, persists before HTTP and recovers a lost response without a second registration',async()=>{
  const identity={schemaVersion:1,origin:'https://enrollment.test',assistantId:randomUUID(),deviceId:randomUUID()},companyId=randomUUID();
  const store=memoryStore(),credential=`tda_${'e'.repeat(43)}`,cryptoDeviceId=randomUUID();
  await store.put({origin:identity.origin,kind:'device',id:identity.assistantId},{assistantId:identity.assistantId,deviceId:identity.deviceId,credential,expiresAt:1});
  let selectedIdentity=identity,available=true,registered=null,loseResponse=true,envelopeAvailable=false,posts=0,gets=0;
  const input={identity,host:{readIdentity:async()=>selectedIdentity},client:{companies:async()=>available?[{companyId,encryptionState:'encrypted'}]:[]},
    store,companyId,companySlug:'encrypted',lockDirectory:os.tmpdir(),lock:async(_file,action)=>action()};
  const previousFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    url=new URL(url);assert.equal(url.origin,identity.origin);
    assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');
    assert.equal(options.headers.get('authorization'),`Bearer ${credential}`);
    assert.equal(options.headers.get('x-trelio-assistant-encryption-protocol'),'1');
    assert.equal(options.headers.get('cookie'),null);assert.equal(options.headers.get('x-trelio-assistant-proof'),null);
    const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
    if(url.pathname==='/api/digital-assistants/runtime/encryption/devices'){
      assert.equal(options.method,'POST');posts++;
      const body=JSON.parse(options.body);
      const persisted=await store.get({origin:identity.origin,kind:'company_encryption',id:companyId,deviceId:identity.deviceId});
      assert.equal(persisted.record.fingerprint,body.fingerprint,'OS store read-back precedes exposing the fingerprint');
      assert.equal(await verifyCompanyEncryptionRecord(body.publicSigningJwk,buildAgentDeviceRegistrationRecord({companyId,
        userId:identity.assistantId,...body}),body.registrationSignature),true,'the SAME native registration carries a real P-256 proof');
      assert.doesNotMatch(options.body,/trustedUnlockKey|wrappedPrivateBundle|privateKeys|encryptionSecret/);
      registered=body;
      if(loseResponse){loseResponse=false;throw new Error('synthetic response lost after commit');}
      return json({device:{id:cryptoDeviceId,fingerprint:body.fingerprint}});
    }
    assert.equal(url.pathname,'/api/digital-assistants/runtime/encryption/runtime');gets++;
    assert.equal(url.searchParams.get('companySlug'),'encrypted');
    const found=registered&&url.searchParams.get('fingerprint')===registered.fingerprint;
    return json({state:'encrypted',suite:'trelio-e2ee-v1',company:{id:companyId,slug:'encrypted',name:'PUBLIC_NAME'},
      viewer:{userId:identity.assistantId},device:found?{id:cryptoDeviceId,fingerprint:registered.fingerprint}:null,
      // These invalid bytes used to be sufficient for envelope_available.
      // Current setup must attempt real key opening and refuse them.
      scope:found?{id:randomUUID(),epoch:1}:null,envelope:envelopeAvailable?{ciphertext:'CIPHERTEXT_CANARY'}:null,
      accessState:found?envelopeAvailable?'ready':'access_pending':url.searchParams.has('fingerprint')?'registration_required':'device_required'});
  };
  try{
    await assert.rejects(prepareAssistantCompanyEncryption(input));assert.equal(posts,1);
    const recovered=await prepareAssistantCompanyEncryption(input);
    assert.equal(posts,1,'read-back of the SAME persisted fingerprint avoids mutation replay after a lost response');
    assert.equal(recovered.state,'awaiting_company_key');assert.equal(recovered.cryptoDeviceId,cryptoDeviceId);
    assert.equal(recovered.fingerprint,registered.fingerprint);assert.equal(recovered.businessReady,false);
    envelopeAvailable=true;
    await assert.rejects(prepareAssistantCompanyEncryption(input));assert.equal(posts,1);
    available=false;const before=gets;
    await assert.rejects(prepareAssistantCompanyEncryption(input),{code:'ASSISTANT_WORKSPACE_BINDING_CHANGED'});
    assert.equal(gets,before,'removed company authority fails before the encryption HTTP/key path');
    available=true;selectedIdentity={...identity,deviceId:randomUUID()};
    await assert.rejects(prepareAssistantCompanyEncryption(input),{code:'ASSISTANT_WORKSPACE_BINDING_CHANGED'});
    assert.equal(posts,1);
  }finally{globalThis.fetch=previousFetch;}
});

test('managed key readiness opens a real recipient envelope and verifies the common container without persisting scope keys',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-key-readiness-'));
  const previousTmp=Object.fromEntries(['TMPDIR','TMP','TEMP'].map(key=>[key,process.env[key]]));
  for(const key of Object.keys(previousTmp))process.env[key]=root;
  const identity={schemaVersion:1,origin:'https://key-ready.test',assistantId:randomUUID(),deviceId:randomUUID()},companyId=randomUUID();
  const scopeId=randomUUID(),cryptoDeviceId=randomUUID(),store=memoryStore();
  const keyPair=await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const scopePublicEncryptionJwk=await webcrypto.subtle.exportKey('jwk',keyPair.publicKey);
  const scopePrivateEncryptionJwk=await webcrypto.subtle.exportKey('jwk',keyPair.privateKey);
  await store.put({origin:identity.origin,kind:'device',id:identity.assistantId},
    {assistantId:identity.assistantId,deviceId:identity.deviceId,credential:`tda_${'k'.repeat(43)}`,expiresAt:1});
  let registered=null,envelope=null,mode='valid',posts=0,available=true;
  const pass={schemaVersion:1,assistantId:identity.assistantId,deviceId:identity.deviceId,companyId,taskId:randomUUID(),
    passId:randomUUID(),deliveryId:randomUUID(),threadId:randomUUID(),bindingId:randomUUID(),bindingRevision:1};
  // The exact native shape is also consumed by the production hook validator.
  const host={readIdentity:async()=>identity,readActivePass:async()=>pass};
  const client={companies:async()=>available?[{companyId,companySlug:'encrypted',encryptionState:'encrypted'}]:[],
    readTaskPass:async()=>({...pass,state:'leased',leaseExpiresAt:new Date(Date.now()+600000).toISOString()})};
  const mentionMemberId=randomUUID(),mentionGroupId=randomUUID();
  const staged=new Map();let preparations=0,resolves=0,businessCalls=0,customFieldDefinition=null,commentFileDefinition=null;
  const input={identity,host,client,
    store,companyId,companySlug:'encrypted',lockDirectory:root,lock:async(_file,action)=>action()};
  const previousFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    url=new URL(url);assert.equal(url.origin,identity.origin);
    const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
    if(url.pathname==='/api/digital-assistants/runtime/encryption/devices'){
      posts++;registered=JSON.parse(options.body);
      const aad={suite:'trelio-e2ee-v1',companyId,scopeId,scopeEpoch:1,recipientType:'agent_device',recipientId:cryptoDeviceId};
      const plaintext=Buffer.from(JSON.stringify({suite:'trelio-e2ee-v1',version:1,scopePrivateEncryptionJwk}));
      try{
        const sealed=await hpkeSeal({recipientPublicEncryptionJwk:registered.publicEncryptionJwk,plaintext,aad});
        envelope={id:randomUUID(),recipientType:'agent_device',recipientId:cryptoDeviceId,scopeId,scopeEpoch:1,
          hpkeEnc:sealed.enc,ciphertext:sealed.ciphertext,aad};
      }finally{plaintext.fill(0);}
      return json({device:{id:cryptoDeviceId,fingerprint:registered.fingerprint}});
    }
    if(url.pathname.startsWith('/api/digital-assistants/runtime/workspace/encryption/payloads')){
      assert.equal(options.headers.get('x-trelio-assistant-content-preparation'),'1');
      assert.equal(options.headers.get('x-trelio-assistant-proof'),null);
      const body=JSON.parse(options.body),{signature,...preparation}=body.preparation;
      const target=JSON.parse(options.headers.get('x-trelio-assistant-content-target'));
      const active=await host.readActivePass();
      assert.deepEqual(target,active.kind==='source_intake'?{kind:'source_intake',pass:{companyId,sourceId:active.sourceId,intakeId:active.passId}}
        :{kind:'task',pass:{companyId,taskId:pass.taskId,passId:pass.passId}});
      assert.equal(await verifyCompanyEncryptionRecord(registered.publicSigningJwk,{protocol:'assistant-managed-content/v1',
        phase:'preparation',companyId,target,nativeTool:preparation.nativeTool,arguments:preparation.arguments,
        ...(preparation.customField?{customField:preparation.customField}:{}),
        ...(preparation.commentFiles?{commentFiles:preparation.commentFiles}:{}),
        ...(preparation.commentMentions?{commentMentions:preparation.commentMentions}:{}),
        ...(preparation.secretRecipe?{secretRecipe:preparation.secretRecipe}:{}),
        ...(preparation.commentDefinition?{action:{commentDefinition:true}}:preparation.commentFileDefinition?{action:{commentFileDefinition:preparation.commentFileDefinition}}:preparation.customFieldDefinition?{action:{customFieldDefinition:true}}:preparation.actionPreview?{action:{preview:true}}:preparation.ownerActionContent?{action:{content:preparation.ownerActionContent}}:{})},signature),true);
      assert.doesNotMatch(options.body,/MANAGED_QUESTION_CANARY|RICH_BODY_CANARY|FIRST_OPTION_CANARY|FIELD_VALUE_CANARY|SECRET_NUMBER_CANARY|SECRET_CHECKBOX_CANARY|UNKNOWN_OPTION_CANARY|UNKNOWN_USER_CANARY|UNKNOWN_GROUP_CANARY|SECRET_NESTED_CANARY|FILE_NAME_CANARY|DELIVERABLE_PATH_CANARY|ARGV_TEXT_CANARY|PRIVATE_RECIPE_ARGV_CANARY|CANCEL_REASON_CANARY|CANCEL_DIFFERENT_CANARY/);
      if(preparation.commentFileDefinition){
        assert.equal(preparation.nativeTool,'create_comment');
        assert.deepEqual(Object.keys(preparation.arguments).sort(),['clientRequestId','expectedTaskUpdatedAt']);
        assert.equal(body.payloads.length,0,'source discovery has no plaintext path or body and stages nothing');
        assert.equal(preparation.commentFileDefinition.runId,commentFileDefinition.runId);
        assert.equal(preparation.commentFileDefinition.ordinal,0);
        return json(commentFileDefinition);
      }
      if(preparation.commentDefinition){
        assert.ok(['create_comment','update_comment'].includes(preparation.nativeTool));
        assert.equal(body.payloads.length,0,'mention discovery never stages raw comment text');
        return json({schemaVersion:1,commentDefinition:{members:[{memberId:mentionMemberId,displayName:'Exact task member',username:'fixture_owner'}],groupIds:[mentionGroupId]}});
      }
      if(preparation.customFieldDefinition){
        assert.equal(preparation.nativeTool,'update_task_custom_field');
        assert.deepEqual(Object.keys(preparation.arguments).sort(),['clientRequestId','expectedTaskUpdatedAt','fieldId']);
        assert.equal(body.payloads.length,0,'type discovery never stages or accepts a raw value');
        return json({schemaVersion:1,customField:customFieldDefinition});
      }
      if(url.pathname.endsWith('/resolve')){resolves++;return json({payloads:body.entityIds.map(id=>staged.get(id)).filter(Boolean)});}
      preparations++;
      if(body.payloads.some(payload=>staged.has(payload.entityId)))return new Response('{}',{status:409});
      for(const payload of body.payloads){
        assert.equal(payload.writerDeviceId,cryptoDeviceId);staged.set(payload.entityId,payload);
        const opened=await decryptCompanyPayload({encryptedPayload:payload,scopePrivateKey:keyPair.privateKey,scopePrivateJwk:scopePrivateEncryptionJwk});
        assert.ok(opened.values,'SAME payload crypto opens actual business content');
      }
      if(preparation.actionPreview)return json({schemaVersion:1,companyId,recipientDeviceId:cryptoDeviceId,envelopeId:envelope.id,
        scopeId,scopeEpoch:1,context:{snapshot:preparation.arguments.operation==='create_private_secret'?{neutralPrivateMetadata:{name:'Personal secret'}}
          :{control:{id:preparation.arguments.fields.controlId,note:preparation.arguments.reason}},
          requiredActions:[preparation.arguments.operation==='create_private_secret'?'classify_secret':'change_other_control'],
          questionText:`Native preview: ${preparation.arguments.reason}`},encryptedPayloads:[...staged.values()]});
      return json({stored:body.payloads.length});
    }
    assert.equal(url.pathname,'/api/digital-assistants/runtime/encryption/runtime');
    const found=registered&&url.searchParams.get('fingerprint')===registered.fingerprint;
    let selected=found?structuredClone(envelope):null;
    if(found&&mode==='recipient')selected.recipientId=randomUUID();
    if(found&&mode==='epoch')selected.scopeEpoch=2;
    if(found&&mode==='ciphertext'){
      const bytes=Buffer.from(selected.ciphertext,'base64url');bytes[0]^=1;selected.ciphertext=bytes.toString('base64url');
    }
    if(found&&mode==='revoke')available=false;
    return json({state:'encrypted',suite:'trelio-e2ee-v1',requestOrigin:identity.origin,company:{id:companyId,slug:'encrypted',name:'PUBLIC'},
      viewer:{userId:identity.assistantId},device:found?{id:cryptoDeviceId,fingerprint:registered.fingerprint}:null,
      scope:found?{id:scopeId,epoch:1,publicEncryptionJwk:mode==='public_key'?registered.publicEncryptionJwk:scopePublicEncryptionJwk}:null,
      envelope:selected,accessState:found?'ready':url.searchParams.has('fingerprint')?'registration_required':'device_required'});
  };
  try{
    const ready=await prepareAssistantCompanyEncryption(input);
    assert.equal(ready.state,'key_verified');assert.equal(ready.businessReady,false);assert.equal(posts,1);
    assert.deepEqual(await fs.readdir(root),[],'the common self-test removes its exact private canary staging');
    const persisted=await store.get({origin:identity.origin,kind:'company_encryption',id:companyId,deviceId:identity.deviceId});
    for(const value of [ready,persisted]){
      assert.equal(JSON.stringify(value).includes(scopePrivateEncryptionJwk.d),false,'scope private key never enters result or OS device slot');
    }
    const validSkill={schemaVersion:1,operation:'skill_run',parameters:{companyId,skillId:'email-imap-smtp',releaseId:randomUUID(),
      runtimeSessionId:randomUUID(),arguments:['send','--text','PRIVATE_ORIGINAL_CLI_CANARY','--local-account',randomUUID()]}};
    const beforeInvalidSkill=preparations;
    await assert.rejects(withAssistantManagedContentArguments({...input,name:'continue_assistant_workspace_action',
      args:{...validSkill,parameters:{...validSkill.parameters,unpublishedParameter:'PRIVATE_EXTRA_CLI_CANARY'}}},async()=>assert.fail('invalid native shape was dispatched')),
      {code:'ASSISTANT_ENCRYPTED_CONTENT_INVALID'});
    assert.equal(preparations,beforeInvalidSkill,'SAME pure continuation parser refuses extra generic parameters before any staging HTTP');
    const question={clientRequestId:randomUUID(),questionText:'MANAGED_QUESTION_CANARY',options:['FIRST_OPTION_CANARY','Second']};
    const send=async wire=>{
      businessCalls++;
      const {encryptedContent,...business}=wire;
      assert.equal(await verifyCompanyEncryptionRecord(registered.publicSigningJwk,{protocol:'assistant-managed-content/v1',
        phase:'publication',companyId,target:{kind:'task',pass:{companyId,taskId:pass.taskId,passId:pass.passId}},
        nativeTool:'ask_assistant_owner',arguments:business},encryptedContent.signature),true);
      assert.doesNotMatch(JSON.stringify(wire),/MANAGED_QUESTION_CANARY|FIRST_OPTION_CANARY/);
      return {content:[],structuredContent:{managedEncryptedContent:{schemaVersion:1,companyId,recipientDeviceId:cryptoDeviceId,
        envelopeId:envelope.id,scopeId,scopeEpoch:1,context:{questionText:wire.questionText,options:wire.options},encryptedPayloads:[...staged.values()]}}};
    };
    const result=await withAssistantManagedContentArguments({...input,name:'ask_assistant_owner',args:question},send);
    assert.equal(result.structuredContent.questionText,question.questionText);assert.deepEqual(result.structuredContent.options,question.options);
    await withAssistantManagedContentArguments({...input,name:'ask_assistant_owner',args:question},send);
    assert.equal(businessCalls,2,'one domain call per explicit invocation, never replayed by payload collision');
    assert.equal(resolves,1);assert.equal(preparations,2,'existing cipher is compared locally before reuse');
    const readsBefore=preparations;
    await assert.rejects(withAssistantManagedContentArguments({...input,name:'ask_assistant_owner',args:{...question,
      questionText:[...staged.values()][0].entityId?buildCompanyEncryptedTextMarker([...staged.keys()][0],'question_text'):''}},send),
      {code:'ASSISTANT_ENCRYPTED_CONTENT_INVALID'});
    assert.equal(preparations,readsBefore,'borrowed marker never gets a private signature or payload resolve');
    for(const options of [['Other','Second'],['Same','same'],['Only'],['x'.repeat(301),'Second']]){
      await assert.rejects(withAssistantManagedContentArguments({...input,name:'ask_assistant_owner',args:{...question,options}},send),
        {code:'ASSISTANT_ENCRYPTED_CONTENT_INVALID'});
    }
    assert.equal(preparations,readsBefore,'content-dependent choice refinements run before encryption/private I/O');
    // Exercise the actual production composition, not just the crypto helper:
    // deviceClient.identity has no storage schemaVersion, host.readIdentity does.
    const {withProductionAssistantManagedContent}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
    host.configurationDirectory=root;
    const deviceIdentity=createAssistantDeviceClient({...identity,store,http:async()=>assert.fail('fixture native methods are selected below')}).identity;
    assert.equal(Object.hasOwn(deviceIdentity,'schemaVersion'),false);
    const comment=await withProductionAssistantManagedContent({name:'create_comment',args:{clientRequestId:randomUUID(),
      expectedTaskUpdatedAt:new Date().toISOString(),bodyText:'RICH_BODY_CANARY @fixture_owner'}},async wire=>{
      assert.equal(Object.hasOwn(wire,'bodyText'),false,'normalization cannot leave plaintext source aliases in final wire');
      assert.ok(wire.bodyJson.$trelioE2ee);
      assert.deepEqual(wire.encryptedContent.commentMentions,{memberIds:[mentionMemberId],groupIds:[]});
      const {encryptedContent,...business}=wire;
      assert.equal(await verifyCompanyEncryptionRecord(registered.publicSigningJwk,{protocol:'assistant-managed-content/v1',phase:'publication',
        companyId,target:{kind:'task',pass:{companyId,taskId:pass.taskId,passId:pass.passId}},nativeTool:'create_comment',arguments:business,
        commentMentions:encryptedContent.commentMentions},encryptedContent.signature),true);
      return {content:[],structuredContent:{recorded:true}};
    },{context:action=>action({...client,identity:deviceIdentity},host,store)});
    assert.equal(comment.structuredContent.recorded,true);
    const richPayload=[...staged.values()].find(payload=>payload.entityId!==[...staged.keys()][0]);
    const richOpened=await decryptCompanyPayload({encryptedPayload:richPayload,scopePrivateKey:keyPair.privateKey,scopePrivateJwk:scopePrivateEncryptionJwk});
    assert.equal(richOpened.values.body_json.type,'doc');
    const filesRoot=await fs.mkdtemp(path.join(root,'accepted-files-'));
    try{
      const runId=randomUUID(),workspaceId=randomUUID(),projectionId=randomUUID(),manifestFileId=randomUUID(),sourceFileId=randomUUID(),attachmentId=randomUUID();
      const filePath='DELIVERABLE_PATH_CANARY/FILE_NAME_CANARY.txt',workspaceHead='a'.repeat(40);
      const manifest={schemaVersion:1,kind:'agent-workspace-browser-manifest',workspaceId,workspaceHead,projectionId,
        files:[{id:sourceFileId,path:filePath,contentType:'text/plain',sizeBytes:7,plaintextSha256:'b'.repeat(64)}]};
      const sourcePath=path.join(filesRoot,'manifest.json'),destinationPath=path.join(filesRoot,'manifest.trelioe1');
      await fs.writeFile(sourcePath,JSON.stringify(manifest),{mode:0o600});
      await encryptFileToCompanyContainer({sourcePath,destinationPath,scopePublicEncryptionJwk,
        aad:{companyId,scopeId,scopeEpoch:1,entityType:'agent_workspace_browser_manifest',entityId:manifestFileId,entityRevision:1,schemaVersion:1},
        originalName:'manifest',mimeType:'application/json',writerDeviceId:cryptoDeviceId,signingPrivateKey:(await unlockRememberedAgentEncryptionDevice(persisted)).privateKeys.signingPrivateKey});
      const cipher=await fs.readFile(destinationPath);
      commentFileDefinition={schemaVersion:1,runId,workspaceId,workspaceHead,projectionId,projectionFileCount:1,manifestFileId,
        attachmentId,publicUrl:`${identity.origin}/api/companies/encrypted/projects/e-${randomUUID()}/tasks/30/attachments/${attachmentId}/download`,
        ciphertextSha256:createHash('sha256').update(cipher).digest('hex'),ciphertextBase64:cipher.toString('base64')};
      const fileArgs={clientRequestId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString(),bodyText:'RICH_BODY_CANARY',acceptedFiles:[{runId,filePath}]};
      let published=0;
      const publish=async wire=>{
        published++;assert.equal(wire.acceptedFiles,undefined);assert.equal(wire.encryptedFiles,undefined);
        assert.equal(wire.encryptedContent.commentFiles.length,1);
        assert.equal(wire.encryptedContent.commentFiles[0].sourceFileId,sourceFileId);
        assert.match(wire.encryptedContent.commentFiles[0].filePath,/^~e1:/u);
        assert.match(wire.encryptedContent.commentFiles[0].fileName,/^~e1:/u);
        assert.match(wire.encryptedContent.commentFiles[0].contentType,/^~e1:/u);
        assert.doesNotMatch(JSON.stringify(wire),/RICH_BODY_CANARY|FILE_NAME_CANARY|DELIVERABLE_PATH_CANARY/);
        const {encryptedContent,...business}=wire;
        assert.equal(await verifyCompanyEncryptionRecord(registered.publicSigningJwk,{protocol:'assistant-managed-content/v1',phase:'publication',
          companyId,target:{kind:'task',pass:{companyId,taskId:pass.taskId,passId:pass.passId}},nativeTool:'create_comment',arguments:business,
          commentFiles:encryptedContent.commentFiles,commentMentions:encryptedContent.commentMentions},encryptedContent.signature),true);
        const opened=await decryptCompanyPayload({encryptedPayload:staged.get(wire.bodyJson.$trelioE2ee.id),scopePrivateKey:keyPair.privateKey,scopePrivateJwk:scopePrivateEncryptionJwk});
        assert.equal(opened.values.body_json.content[0].content[0].text,'RICH_BODY_CANARY');
        const linked=opened.values.body_json.content.at(-1).content[0];
        assert.equal(linked.text,'FILE_NAME_CANARY.txt');assert.equal(linked.marks[0].attrs.taskAttachmentId,attachmentId);
        assert.equal(linked.marks[0].attrs.href,commentFileDefinition.publicUrl);
        return {content:[],structuredContent:{receiptId:randomUUID()}};
      };
      await withAssistantManagedContentArguments({...input,name:'create_comment',args:fileArgs},publish);
      await withAssistantManagedContentArguments({...input,name:'create_comment',args:fileArgs},publish);
      assert.equal(published,2,'an explicit retry compares persisted ciphertext but does not internally replay a domain request');
      const validProjection=commentFileDefinition.projectionId;commentFileDefinition.projectionId=randomUUID();
      await assert.rejects(withAssistantManagedContentArguments({...input,name:'create_comment',args:fileArgs},async()=>assert.fail('wrong projection reached MCP')));
      commentFileDefinition.projectionId=validProjection;
      for(const filePath of ['WORKSPACE_CONTEXT.md','worklog/private.md','assistants/someone/WORK.md']){
        await assert.rejects(withAssistantManagedContentArguments({...input,name:'create_comment',args:{...fileArgs,acceptedFiles:[{runId,filePath}]}},async()=>assert.fail('private context attachment reached MCP')));
      }
      await assert.rejects(withAssistantManagedContentArguments({...input,name:'create_comment',args:{...fileArgs,encryptedFiles:[]}},publish),{code:'ASSISTANT_CAPABILITY_UNAVAILABLE'});
      assert.equal(published,2);
    }finally{commentFileDefinition=null;await fs.rm(filesRoot,{recursive:true,force:true});}

    assert.equal(richOpened.values.body_json.content[0].content.at(-1).type,'mention');
    assert.equal(richOpened.values.body_json.content[0].content.at(-1).attrs.id,mentionMemberId,
      'the SAME local canonicalizer stores the current native member ID inside encrypted rich text');
    const noForeign=preparations;
    await assert.rejects(withAssistantManagedContentArguments({...input,name:'update_comment',args:{clientRequestId:randomUUID(),
      expectedTaskUpdatedAt:new Date().toISOString(),commentId:randomUUID(),bodyJson:{type:'doc',content:[{type:'mention',attrs:{id:randomUUID(),entityType:'member'}}]}}},
      async()=>assert.fail('foreign mention cannot reach final native publication')));
    assert.equal(preparations,noForeign,'foreign mention node fails before staging its body');
    await withAssistantManagedContentArguments({...input,name:'update_comment',args:{clientRequestId:randomUUID(),
      expectedTaskUpdatedAt:new Date().toISOString(),commentId:randomUUID(),bodyJson:{type:'doc',content:[{type:'paragraph',content:[
        {type:'mention',attrs:{id:mentionGroupId,entityType:'group',label:'Group'}}]}]}}},async wire=>{
      assert.deepEqual(wire.encryptedContent.commentMentions,{memberIds:[],groupIds:[mentionGroupId]},
        'group metadata contains only its exact native ID, never copied member assignments');
      const payload=staged.get(wire.bodyJson.$trelioE2ee.id),opened=await decryptCompanyPayload({encryptedPayload:payload,
        scopePrivateKey:keyPair.privateKey,scopePrivateJwk:scopePrivateEncryptionJwk});
      assert.equal(opened.values.body_json.content[0].content[0].attrs.id,mentionGroupId);
      return {content:[],structuredContent:{recorded:true}};
    });
    const previewed=await withAssistantManagedContentArguments({...input,name:'get_assistant_owner_question',args:{questionId:randomUUID()}},async()=>({content:[],
      structuredContent:{managedEncryptedContent:{schemaVersion:1,companyId,recipientDeviceId:cryptoDeviceId,envelopeId:envelope.id,scopeId,scopeEpoch:1,
        context:{questionText:`Complete document: ${buildCompanyEncryptedTextMarker(richPayload.entityId,'body_json')}`},encryptedPayloads:[richPayload]}}}));
    assert.match(previewed.structuredContent.questionText,/RICH_BODY_CANARY/);assert.doesNotMatch(previewed.structuredContent.questionText,/\[object Object\]/);
    const metadataStages=preparations,secretId=randomUUID();
    const listedSecrets=await withAssistantManagedContentArguments({...input,name:'continue_assistant_workspace_action',
      args:{schemaVersion:1,operation:'secret_list',parameters:{holder:'company',limit:20}}},async wire=>{
        assert.deepEqual(wire.parameters,{holder:'company',limit:20});
        assert.equal(wire.encryptedContent.fingerprint,registered.fingerprint);
        assert.equal(wire.encryptedContent.signature,undefined,'metadata read is not staged or signed as a mutation');
        return {content:[],structuredContent:{managedEncryptedContent:{schemaVersion:1,companyId,recipientDeviceId:cryptoDeviceId,
          envelopeId:envelope.id,scopeId,scopeEpoch:1,context:{secrets:[{id:secretId,
            name:buildCompanyEncryptedTextMarker(richPayload.entityId,'body_plain_text'),fields:[]}]},encryptedPayloads:[richPayload]}}};
      });
    assert.match(listedSecrets.structuredContent.secrets[0].name,/RICH_BODY_CANARY/);
    assert.equal(preparations,metadataStages,'the SAME selected-snapshot hydrator adds no payload write or general resolver');
    await assert.rejects(withAssistantManagedContentArguments({...input,name:'continue_assistant_workspace_action',
      args:{schemaVersion:1,operation:'secret_list',parameters:{holder:'company',query:'SECRET_METADATA_PROSE_CANARY'}}},()=>assert.fail('ignored metadata prose reached native HTTP')),
      {code:'ASSISTANT_ENCRYPTED_CONTENT_INVALID'});

    const planned=await withAssistantManagedContentArguments({...input,name:'request_assistant_action',args:{operation:'clear_task_control',
      fields:{controlId:randomUUID()},clientRequestId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString(),reason:'ACTION_REASON_CANARY'}},async wire=>{
      const {encryptedContent,...business}=wire;
      assert.equal(await verifyCompanyEncryptionRecord(registered.publicSigningJwk,{protocol:'assistant-managed-content/v1',phase:'publication',
        companyId,target:{kind:'task',pass:{companyId,taskId:pass.taskId,passId:pass.passId}},nativeTool:'request_assistant_action',
        arguments:business,action:encryptedContent.action},encryptedContent.signature),true);
      assert.match(encryptedContent.action.snapshot.control.note,/^~e1:/u,'native CAS snapshot keeps its original ciphertext marker');
      const intent=encryptedContent.action.intentJson.$trelioE2ee,opened=await decryptCompanyPayload({encryptedPayload:staged.get(intent.id),
        scopePrivateKey:keyPair.privateKey,scopePrivateJwk:scopePrivateEncryptionJwk});
      assert.equal(opened.values.intent_json.reason,'ACTION_REASON_CANARY');
      assert.equal(opened.values.question_text,'Native preview: ACTION_REASON_CANARY');
      assert.doesNotMatch(JSON.stringify(wire),/ACTION_REASON_CANARY/,'entire final action and original reason are ciphertext before remote MCP');
      return {content:[],structuredContent:{questionId:randomUUID(),state:'pending'}};
    });
    assert.equal(planned.structuredContent.state,'pending');
    const neutralFields={metadataMode:'neutral',cardType:'password',runId:randomUUID(),generatedFields:[{key:'password',generator:'password',length:32}]};
    const neutralAction={operation:'create_private_secret',fields:neutralFields,reason:'NEUTRAL_PRIVATE_PURPOSE_CANARY',
      clientRequestId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString()};
    const plannedPrivate=await withAssistantManagedContentArguments({...input,name:'request_assistant_action',args:neutralAction},async wire=>{
      assert.deepEqual(wire.fields,neutralFields);assert.doesNotMatch(JSON.stringify(wire),/NEUTRAL_PRIVATE_PURPOSE_CANARY/);
      const ref=wire.encryptedContent.action.intentJson.$trelioE2ee;
      const opened=await decryptCompanyPayload({encryptedPayload:staged.get(ref.id),scopePrivateKey:keyPair.privateKey,scopePrivateJwk:scopePrivateEncryptionJwk});
      assert.equal(opened.values.intent_json.reason,neutralAction.reason);
      assert.deepEqual(opened.values.intent_json.fields,neutralFields);return {content:[],structuredContent:{state:'pending'}};
    });
    assert.equal(plannedPrivate.structuredContent.state,'pending');
    const stageCount=preparations;
    for(const fields of [{...neutralFields,name:'TASK_NAME_CANARY'},{...neutralFields,generatedFields:[{key:'password',generator:'password',length:32,executable:'cmd'}]},
      {...neutralFields,publicDescription:'TASK_DESCRIPTION_CANARY'}, {...neutralFields,cardType:'username'}])
      await assert.rejects(withAssistantManagedContentArguments({...input,name:'request_assistant_action',args:{...neutralAction,fields}},()=>assert.fail('no native mutation')));
    assert.equal(preparations,stageCount,'private text/unknown policy slots never reach preparation HTTP');
    const fieldId=randomUUID(),fieldUpdatedAt=new Date().toISOString(),optionId=randomUUID(),memberId=randomUUID();
    for(const [fieldType,value] of [['text','  FIELD_VALUE_CANARY\n  second line  '],['number',42],['checkbox',false],['date','2026-10-24'],
      ['select',[optionId]],['user',memberId],['group',[memberId]],['user_or_group',{entityType:'member',id:memberId}]]){
      customFieldDefinition={id:fieldId,fieldType,updatedAt:fieldUpdatedAt,...(fieldType==='select'?{optionIds:[optionId]}:{})};
      const expectedField={id:fieldId,fieldType,updatedAt:fieldUpdatedAt};
      const result=await withAssistantManagedContentArguments({...input,name:'update_task_custom_field',args:{
        fieldId,value,clientRequestId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString()}},async wire=>{
        const {encryptedContent,...business}=wire;
        assert.deepEqual(encryptedContent.customField,expectedField);
        assert.equal(await verifyCompanyEncryptionRecord(registered.publicSigningJwk,{protocol:'assistant-managed-content/v1',phase:'publication',
          companyId,target:{kind:'task',pass:{companyId,taskId:pass.taskId,passId:pass.passId}},nativeTool:'update_task_custom_field',
          arguments:business,customField:expectedField},encryptedContent.signature),true);
        if(fieldType==='text'){
          assert.match(wire.value,/^~e1:/u);assert.doesNotMatch(JSON.stringify(wire),/FIELD_VALUE_CANARY/);
          const entityId=wire.value.split(':')[1];
          const opened=await decryptCompanyPayload({encryptedPayload:staged.get(entityId),scopePrivateKey:keyPair.privateKey,scopePrivateJwk:scopePrivateEncryptionJwk});
          assert.equal(opened.values.value,value,'SAME field protector and payload codec preserve the original text');
        }else assert.deepEqual(wire.value,value,'structural values stay native, never encrypted prose');
        return {content:[],structuredContent:{recorded:true}};
      });
      assert.equal(result.structuredContent.recorded,true);
    }
    for(const [fieldType,value] of [['number','SECRET_NUMBER_CANARY'],['checkbox','SECRET_CHECKBOX_CANARY'],['date','2026-02-30'],
      ['select','UNKNOWN_OPTION_CANARY'],['user','UNKNOWN_USER_CANARY'],['group',['UNKNOWN_GROUP_CANARY']],
      ['user_or_group',{entityType:'member',id:memberId,note:'SECRET_NESTED_CANARY'}],['text','x'.repeat(256)]]){
      customFieldDefinition={id:fieldId,fieldType,updatedAt:fieldUpdatedAt,...(fieldType==='select'?{optionIds:[optionId]}:{})};
      const before=preparations;
      await assert.rejects(withAssistantManagedContentArguments({...input,name:'update_task_custom_field',args:{fieldId,value,
        clientRequestId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString()}},async()=>assert.fail('malformed value reached business MCP')),
        {code:'ASSISTANT_ENCRYPTED_CONTENT_INVALID'});
      assert.equal(preparations,before,'invalid prose never reaches a payload store or domain call');
    }
    customFieldDefinition={id:randomUUID(),fieldType:'text',updatedAt:fieldUpdatedAt};
    await assert.rejects(withAssistantManagedContentArguments({...input,name:'update_task_custom_field',args:{fieldId,value:'PRIVATE_UNKNOWN_FIELD',
      clientRequestId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString()}},async()=>assert.fail('foreign field reached MCP')),
      {code:'ASSISTANT_MCP_INVALID_RESPONSE'});
    const vector=['send','--account',randomUUID(),'--chat','123','--text','ARGV_TEXT_CANARY \n exact spacing'];
    const vectorArgs={schemaVersion:1,operation:'skill_run',parameters:{companyId,skillId:'signed-fixture',releaseId:randomUUID(),
      runtimeSessionId:randomUUID(),arguments:vector}};
    const protectedVector=await withAssistantManagedContentArguments({...input,name:'continue_assistant_workspace_action',args:vectorArgs},async wire=>{
      const {encryptedContent,...business}=wire;
      assert.equal(await verifyCompanyEncryptionRecord(registered.publicSigningJwk,{protocol:'assistant-managed-content/v1',phase:'publication',
        companyId,target:{kind:'task',pass:{companyId,taskId:pass.taskId,passId:pass.passId}},nativeTool:'continue_assistant_workspace_action',arguments:business},
        encryptedContent.signature),true);
      assert.deepEqual(wire.parameters.arguments,[]);assert.doesNotMatch(JSON.stringify(wire),/ARGV_TEXT_CANARY/);
      const marker=wire.parameters.encryptedArguments.$trelioE2ee??wire.parameters.encryptedArguments[0].$trelioE2ee;
      assert.equal(marker.field,'skill_arguments_json');
      const payload=staged.get(marker.id),opened=await decryptCompanyPayload({encryptedPayload:payload,
        scopePrivateKey:keyPair.privateKey,scopePrivateJwk:scopePrivateEncryptionJwk});
      assert.deepEqual(opened.values.skill_arguments_json,vector,'the exact whole vector uses the SAME payload codec');
      return {content:[],structuredContent:{managedEncryptedContent:{schemaVersion:1,companyId,recipientDeviceId:cryptoDeviceId,
        envelopeId:envelope.id,scopeId,scopeEpoch:1,context:{prepared:true,localAction:{schemaVersion:1,operation:'skill_run',parameters:wire.parameters},
          scope:{companyId,taskId:pass.taskId,passId:pass.passId,assistantUserId:identity.assistantId,deviceId:identity.deviceId}},encryptedPayloads:[payload]}}};
    });
    assert.deepEqual(protectedVector.structuredContent.localAction.parameters,vectorArgs.parameters,
      'ordinary continuation receives the original vector before the SAME signed policy/account/process execution');
    assert.equal(Object.hasOwn(protectedVector.structuredContent.localAction.parameters,'encryptedArguments'),false);
    const {createAssistantWorkspaceExecutor}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
    let executions=0;
    const executor=await createAssistantWorkspaceExecutor({configDirectory:root,runPlan:async plan=>{
      executions++;assert.equal(plan.localAction.operation,'skill_run');
      assert.deepEqual(plan.localAction.parameters.arguments,vector,'SAME continuation validator/executor sees the opened original vector');
      assert.equal(Object.hasOwn(plan.localAction.parameters,'encryptedArguments'),false);
      return {operation:'skill_run',exitCode:0};
    }});
    await executor.execute(protectedVector.structuredContent);assert.equal(executions,1);

    await assert.rejects(withAssistantManagedContentArguments({...input,name:'continue_assistant_workspace_action',args:vectorArgs},async()=>({
      content:[],structuredContent:{prepared:true,localAction:{operation:'skill_run',parameters:{arguments:vector}}}})),{code:'ASSISTANT_MCP_INVALID_RESPONSE'},
      'a plaintext plan or missing native-selected bundle cannot execute');
    for(const args of [{...vectorArgs,operation:'secret_skill_run'},
      {...vectorArgs,parameters:{...vectorArgs.parameters,encryptedArguments:vector}},
      {...vectorArgs,parameters:{...vectorArgs.parameters,arguments:[]}}])
      await assert.rejects(withAssistantManagedContentArguments({...input,name:'continue_assistant_workspace_action',args},async()=>assert.fail('invalid vector reached native MCP')));
    // Isolate the managed carrier between two independently exercised native
    // contracts: actual signed/TRELIOE1 inspector/child (source-reader suite)
    // and actual PostgreSQL P256/grant/consume (backend dispatch suite).
    const command={id:'login',purpose:'authenticate',arguments:['login','PRIVATE_RECIPE_ARGV_CANARY'],bindingKey:'credential',fieldKey:'value',environmentVariable:'TRELIO_SERVICE_PASSWORD'};
    const privateArgs={schemaVersion:1,operation:'secret_skill_prepare',parameters:{secretId:randomUUID(),runId:randomUUID(),fieldKey:command.fieldKey,
      environmentVariable:command.environmentVariable,skill:{companyId,skillId:'signed-fixture',releaseId:randomUUID(),runtimeSessionId:randomUUID(),commandId:command.id}}};
    const common=await import('../host-runtime/scripts/trelio-workspace.mjs');
    const privateSkillPreparation={parameters:{...privateArgs.parameters,encryptionFingerprint:registered.fingerprint},privateRuntime:true,recipe:command};
    let privateCalls=0;
    let inspections=0;host.configurationDirectory=root;
    const protectedPrivate=await withProductionAssistantManagedContent({name:'continue_assistant_workspace_action',args:privateArgs},async wire=>{
      privateCalls++;assert.doesNotMatch(JSON.stringify(wire),/PRIVATE_RECIPE_ARGV_CANARY/);
      assert.equal(Object.hasOwn(wire,'secretRecipe'),false,'host metadata stays inside the existing hidden envelope');
      const {encryptedContent,...business}=wire,recipe=encryptedContent.secretRecipe;
      assert.equal(await verifyCompanyEncryptionRecord(registered.publicSigningJwk,{protocol:'assistant-managed-content/v1',phase:'publication',companyId,
        target:{kind:'task',pass:{companyId,taskId:pass.taskId,passId:pass.passId}},nativeTool:'continue_assistant_workspace_action',arguments:business,secretRecipe:recipe},encryptedContent.signature),true);
      const marker=recipe.command.$trelioE2ee;
      const opened=await decryptCompanyPayload({encryptedPayload:staged.get(marker.id),scopePrivateKey:keyPair.privateKey,scopePrivateJwk:scopePrivateEncryptionJwk});
      assert.deepEqual(opened.values.skill_setup_command_json,command,'whole original recipe uses the existing payload codec');
      return {content:[],structuredContent:{prepared:true,localAction:{schemaVersion:1,operation:'secret_skill_run',runIdentity:{workspaceId:randomUUID(),runId:privateArgs.parameters.runId},
        parameters:{grantId:randomUUID(),fieldKey:command.fieldKey,environmentVariable:command.environmentVariable,
          skill:{...privateArgs.parameters.skill,arguments:recipe.command}}}}};
    },{context:action=>action({...client,identity},host,store),withProfile:async(action,options)=>{
      assert.equal(options.encryptedSkillRead.projectId,null);inspections++;
      return action({identity,preparePrivateSkillArguments:async(parameters,_signal,config)=>{
        assert.equal(config.inspectRecipe,true);assert.deepEqual(parameters,privateArgs.parameters);return privateSkillPreparation;}});
    }});
    assert.deepEqual(protectedPrivate.structuredContent.localAction.parameters.skill.arguments,command.arguments);
    assert.equal(privateCalls,1,'only one native preparation, never a consume or provider launch');assert.equal(inspections,1);
    delete host.configurationDirectory;
    // The production facade owns an empty lock directory; remove that exact
    // fixture directory before the independent no-canary self-test assertions.
    await fs.rm(path.join(root,'digital-assistants'),{recursive:true,force:true});
    const cancellation={runId:randomUUID(),reason:'CANCEL_REASON_CANARY'};
    let cancellationCalls=0,cancellationMarker=null;
    const cancelSend=async wire=>{
      cancellationCalls++;
      assert.doesNotMatch(JSON.stringify(wire),/CANCEL_REASON_CANARY/);
      assert.match(wire.reason,/^~e1:[0-9a-f-]{36}:cancellation_reason~$/u);
      if(cancellationMarker)assert.equal(wire.reason,cancellationMarker,'same Run/intent keeps its immutable opaque audit reference');
      cancellationMarker=wire.reason;
      const {encryptedContent,...argumentsValue}=wire;
      assert.equal(await verifyCompanyEncryptionRecord(registered.publicSigningJwk,{protocol:'assistant-managed-content/v1',
        phase:'publication',companyId,target:{kind:'task',pass:{companyId,taskId:pass.taskId,passId:pass.passId}},
        nativeTool:'cancel_agent_workspace_run',arguments:argumentsValue},encryptedContent.signature),true);
      if(cancellationCalls===1)throw new Error('SYNTHETIC_CANCELLATION_RESPONSE_LOST');
      return {content:[],structuredContent:{run:{id:cancellation.runId,status:'cancelled'}}};
    };
    await assert.rejects(withAssistantManagedContentArguments({...input,name:'cancel_agent_workspace_run',args:cancellation},cancelSend),/RESPONSE_LOST/);
    assert.equal(cancellationCalls,1,'no automatic business retry follows a lost cancellation response');
    await withAssistantManagedContentArguments({...input,name:'cancel_agent_workspace_run',args:cancellation},cancelSend);
    assert.equal(cancellationCalls,2,'explicit recovery opens the SAME selected stored ciphertext and compares the original reason locally');
    const cancellationPayload=staged.get(cancellationMarker.slice(4,40));
    assert.equal(cancellationPayload.entityType,'agent_workspace.cancellation');
    assert.equal(cancellationPayload.aad.entityType,'agent_workspace.cancellation');
    await assert.rejects(withAssistantManagedContentArguments({...input,name:'cancel_agent_workspace_run',
      args:{...cancellation,reason:'CANCEL_DIFFERENT_CANARY'}},cancelSend));
    assert.equal(cancellationCalls,2,'a different reason cannot silently adopt the staged immutable intent');
    const intake={schemaVersion:1,kind:'source_intake',assistantId:identity.assistantId,deviceId:identity.deviceId,companyId,
      sourceId:randomUUID(),sourceRevision:3,passId:randomUUID(),deliveryId:randomUUID(),eventId:randomUUID(),threadId:randomUUID()};
    let intakeState='leased',intakeReads=0;
    host.readActivePass=async()=>intake;
    client.readSourceIntake=async()=>{intakeReads++;return {state:intakeState,threadId:intake.threadId,eventId:intake.eventId,
      sourceRevision:intake.sourceRevision,leaseExpiresAt:new Date(Date.now()+600000).toISOString()};};
    try{
      const result=await withAssistantManagedContentArguments({...input,name:'resolve_assistant_intake',args:{decision:'create_task',
        intakePass:{companyId,sourceId:intake.sourceId,intakeId:intake.passId},clientRequestId:intake.passId,projectId:randomUUID(),
        fields:{title:'New owner goal'}}},async wire=>{
        assert.equal(Object.hasOwn(wire,'taskPass'),false,'taskless intake never constructs a fake task profile');
        assert.deepEqual(wire.intakePass,{companyId,sourceId:intake.sourceId,intakeId:intake.passId});
        assert.match(wire.fields.title,/^~e1:/u);intakeState='created';
        return {content:[],structuredContent:{state:'created',receiptId:randomUUID(),taskId:randomUUID()}};
      });
      assert.equal(result.structuredContent.state,'created');assert.ok(intakeReads>=3,'terminal native read-back is not treated as an executable lease');
      intake.intakeKind='route_existing';intake.eventIds=[intake.eventId,randomUUID()];intakeState='leased';
      const projectId=randomUUID(),taskId=randomUUID();
      client.readSourceIntake=async()=>({state:intakeState,kind:'route_existing',eventIds:intake.eventIds,threadId:intake.threadId,eventId:intake.eventId,
        sourceRevision:intake.sourceRevision,leaseExpiresAt:new Date(Date.now()+600000).toISOString()});
      const context=await withAssistantManagedContentArguments({...input,name:'get_assistant_intake_context',
        args:{intakePass:{companyId,sourceId:intake.sourceId,intakeId:intake.passId}}},async()=>({content:[],structuredContent:{managedEncryptedContent:{
          schemaVersion:1,companyId,recipientDeviceId:cryptoDeviceId,envelopeId:envelope.id,scopeId,scopeEpoch:1,
          context:{kind:'route_existing',projectId,candidates:[{taskId,title:buildCompanyEncryptedTextMarker(richPayload.entityId,'body_plain_text')}],
            creationAuthority:{company:{id:companyId,slug:'encrypted'},viewer:{memberId:randomUUID()},projects:[{id:projectId,slug:'selected-project'}],
              instructions:{company:{compiledMarkdown:'COMPANY_RULES'},projects:[{projectId,snapshot:{compiledMarkdown:`SELECTED_PROJECT ${buildCompanyEncryptedTextMarker(richPayload.entityId,'body_plain_text')}`}}],userProfile:null}}},
          encryptedPayloads:[richPayload]}}}));
      assert.match(context.structuredContent.candidates[0].title,/RICH_BODY_CANARY/);
      assert.equal(context.structuredContent.effectiveInstructions.scope.project.id,projectId);
      assert.match(context.structuredContent.effectiveInstructions.layers[0].markdown,/SELECTED_PROJECT.*RICH_BODY_CANARY/);
      assert.equal(context.structuredContent.creationAuthority,undefined,'SAME selected bundle hydrator exposes authority once, without general payload resolve');
      const beforeTriage=preparations;
      await assert.rejects(withAssistantManagedContentArguments({...input,name:'resolve_assistant_intake',args:{decision:'create_task',clientRequestId:intake.passId,fields:{title:'UNAUTHORIZED_TRIAGE_TITLE'}}},()=>assert.fail('triage cannot stage a new task')),/CAPABILITY_UNAVAILABLE/);
      assert.equal(preparations,beforeTriage,'owner creation fields cannot reach staging under a triage role');

    }finally{host.readActivePass=async()=>pass;}
    for(mode of ['recipient','epoch','ciphertext','public_key','revoke']){
      await assert.rejects(prepareAssistantCompanyEncryption(input));
      assert.equal(posts,1,'malformed keys or revoked authority never reset/re-register the persisted device');
      assert.deepEqual(await fs.readdir(root),[],'failed opening/self-test retains no canary files');
    }
  }finally{
    globalThis.fetch=previousFetch;
    for(const [key,value] of Object.entries(previousTmp)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    await fs.rm(root,{recursive:true,force:true});
  }
});

test('pending registration mode is not available to a human or a caller-provided setup flag',async()=>{
  const previousFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('must not reach HTTP');};
  try{
    for(const options of [{allowPendingRegistration:true},{registrationOnly:true},{allowPendingRegistration:'yes'}]){
      await assert.rejects(ensureCompanyEncryptionContext({origin:'https://key-ready.test',token:'synthetic',
        company:{id:randomUUID(),slug:'encrypted'},...options}),{code:'ASSISTANT_WORKSPACE_PROFILE_DENIED'});
    }
    assert.equal(calls,0);
  }finally{globalThis.fetch=previousFetch;}
});

test('enrollment refuses a foreign company/viewer before creating a managed key and never opens a human form',async()=>{
  const identity={schemaVersion:1,origin:'https://enrollment-denial.test',assistantId:randomUUID(),deviceId:randomUUID()},companyId=randomUUID();
  const store=memoryStore();await store.put({origin:identity.origin,kind:'device',id:identity.assistantId},
    {assistantId:identity.assistantId,deviceId:identity.deviceId,credential:`tda_${'d'.repeat(43)}`,expiresAt:1});
  const input={identity,host:{readIdentity:async()=>identity},client:{companies:async()=>[{companyId,encryptionState:'encrypted'}]},
    store,companyId,companySlug:'encrypted',lockDirectory:os.tmpdir(),lock:async(_file,action)=>action()};
  const previousFetch=globalThis.fetch;let mismatch='company',calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({state:'encrypted',suite:'trelio-e2ee-v1',
    company:{id:mismatch==='company'?randomUUID():companyId,slug:'encrypted'},viewer:{userId:mismatch==='viewer'?randomUUID():identity.assistantId}}),
    {headers:{'content-type':'application/json'}});};
  try{
    for(mismatch of ['company','viewer']){
      await assert.rejects(prepareAssistantCompanyEncryption(input),{code:'ASSISTANT_WORKSPACE_PROFILE_DENIED'});
      assert.equal(await store.get({origin:identity.origin,kind:'company_encryption',id:companyId,deviceId:identity.deviceId}),null);
    }
    assert.equal(calls,2);
    for(const bad of [{companyId:'not-a-uuid'},{companySlug:'bad\nslug'},{companySlug:''}])await assert.rejects(prepareAssistantCompanyEncryption({...input,...bad}),{code:'ASSISTANT_TRANSPORT_INVALID_INPUT'});
    assert.equal(calls,2,'invalid input does not reach HTTP');
  }finally{globalThis.fetch=previousFetch;}
});
test('fixed HTTPS requests omit cookies, refuse redirects and redact raw failures', async () => {
  let count=0;
  const http=createAssistantHttp({ origin:'https://assistant.test',fetchImpl:async(url,options)=>{
    count++; assert.equal(url,'https://assistant.test/api/digital-assistants/runtime/companies');
    assert.equal(options.redirect,'error'); assert.equal(options.credentials,'omit'); assert.equal(options.cache,'no-store');
    assert.equal(options.headers.authorization,`Bearer tda_${'a'.repeat(43)}`);
    return new Response(JSON.stringify({code:'ASSISTANT_DEVICE_REVOKED',message:'PRIVATE SERVER TEXT'}),{status:401,headers:{'content-type':'application/json'}});
  } });
  await assert.rejects(http('companies',undefined,`tda_${'a'.repeat(43)}`),error=>error.code==='ASSISTANT_DEVICE_REVOKED' && error.status===401 && !error.message.includes('PRIVATE'));
  await assert.rejects(http('https://other.test',{},`tda_${'a'.repeat(43)}`),/INVALID_INPUT/); assert.equal(count,1);
  await assert.rejects(http('companies',undefined),/INVALID_INPUT/);
  assert.throws(()=>createAssistantHttp({origin:'https://assistant.test/path'}),/INVALID_INPUT/);
  const broken=createAssistantHttp({origin:'https://assistant.test',fetchImpl:async()=>{throw new Error('PRIVATE URL TOKEN');}});
  await assert.rejects(broken('companies',undefined,`tda_${'a'.repeat(43)}`),error=>error.message==='ASSISTANT_TRANSPORT_UNAVAILABLE');
});

test('native pre-handler rate limiting has a closed distinct result and never retries HTTP',async()=>{
  for(const [status,code,expected] of [[429,'REQUEST_RATE_LIMITED','ASSISTANT_TRANSPORT_RATE_LIMITED'],
    [403,'REQUEST_RATE_LIMITED','ASSISTANT_TRANSPORT_REJECTED'],[429,'OTHER_PRIVATE_CODE','ASSISTANT_TRANSPORT_REJECTED']]){
    let calls=0;
    const http=createAssistantHttp({origin:'https://assistant.test',fetchImpl:async()=>{
      calls++;return new Response(JSON.stringify({code,message:'PRIVATE SERVER TEXT'}),
        {status,headers:{'content-type':'application/json','retry-after':'60'}});
    }});
    await assert.rejects(http('passRead',{companyId:randomUUID(),taskId:randomUUID(),passId:randomUUID()},`tda_${'a'.repeat(43)}`),
      error=>error.code===expected&&error.status===status&&!error.message.includes('PRIVATE'));
    assert.equal(calls,1,'rate limiting does not repeat a request or issue a new pass/proof');
  }
});

test('fixed control-plane task admission carries the current loader version independently of model body fields',async()=>{
  const {getHostRuntimeVersion}=await import('../host-runtime/scripts/trelio-component-versions.mjs');
  const paths=['task','task/claim','schedule','task-pass/begin'];let calls=0;
  const http=createAssistantHttp({origin:'https://assistant.test',fetchImpl:async(url,options)=>{
    assert.equal(url,'https://assistant.test/api/digital-assistants/runtime/'+paths[calls++]);
    assert.equal(options.headers['x-trelio-host-runtime-version'],getHostRuntimeVersion());
    assert.notEqual(options.headers['x-trelio-host-runtime-version'],'999.0.0');
    assert.equal(options.headers.authorization,`Bearer tda_${'a'.repeat(43)}`);
    assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
    return new Response('{}',{headers:{'content-type':'application/json'}});
  }});
  for(const operation of ['task','claim','report','passBegin'])await http(operation,
    {hostRuntimeVersion:'999.0.0','x-trelio-host-runtime-version':'999.0.0'},`tda_${'a'.repeat(43)}`);
  assert.equal(calls,4,'one request per explicit operation, no version negotiation/retry');
});

test('device client loads only its exact private slot and projects server content away', async () => {
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),companyId=randomUUID(),memberId=randomUUID();
  const store=memoryStore(); await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'a'.repeat(43)}`,expiresAt:10000});
  let calls=0;
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,now:()=>100,http:async(operation,_body,credential)=>{
    calls++; assert.equal(operation,'companies'); assert.match(credential,/^tda_/u);
    return {assistantUserId:assistantId,bindingId:deviceId,companies:[{id:companyId,memberId,encryptionState:null,secret:'PRIVATE',slug:'PRIVATE'}]};
  }});
  assert.deepEqual(await client.companies(),[{companyId,memberId,companySlug:'PRIVATE',encryptionState:null,execution:{state:'unconfigured',configuration:null,policyRevisionId:null}}]);
  const other=createAssistantDeviceClient({origin,assistantId,deviceId:randomUUID(),store,http:async()=>{calls++;},now:()=>100});
  await assert.rejects(other.companies(),/DEVICE_REQUIRED/); assert.equal(calls,1);
});

test('owner identity reads use the fixed device-only endpoint and preserve opaque provider ids', async () => {
  const origin='https://assistant.test', assistantId=randomUUID(), deviceId=randomUUID(), ownerUserId=randomUUID();
  const store=memoryStore(), credential=`tda_${'i'.repeat(43)}`;
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential,expiresAt:1});
  let calls=0;
  const bindingId=randomUUID(), externalUserId='900719925474099312345';
  const raw={schemaVersion:1,assistantUserId:assistantId,ownerUserId,bindingRevision:'a'.repeat(64),identities:[
    {bindingId,provider:'telegram',externalUserId,username:'PRIVATE_USERNAME',payload:{token:'PRIVATE_TOKEN'}},
  ],notificationPreferences:{private:'PRIVATE_PREFS'}};
  const signal=new AbortController().signal;
  const http=createAssistantHttp({origin,fetchImpl:async(url,options)=>{
    calls++;
    assert.equal(url,`${origin}/api/digital-assistants/runtime/owner-identities`);
    assert.equal(options.method,'GET'); assert.equal(options.body,undefined);
    assert.equal(options.headers.authorization,`Bearer ${credential}`);
    assert.equal(options.credentials,'omit'); assert.equal(options.redirect,'error');
    assert.equal(options.cache,'no-store'); assert.ok(options.signal);
    return new Response(JSON.stringify(raw),{headers:{'content-type':'application/json'}});
  }});
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,http});
  const result=await client.ownerIdentities(signal);
  assert.deepEqual(result,{schemaVersion:1,assistantUserId:assistantId,ownerUserId,bindingRevision:'a'.repeat(64),
    identities:[{bindingId,provider:'telegram',externalUserId}]});
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.identities)); assert.ok(Object.isFrozen(result.identities[0]));
  assert.throws(()=>{result.identities[0].externalUserId='another';},TypeError);
  // Unlink/relink must be visible immediately. A previously returned result is
  // independent of the next read and never functions as an admission cache.
  raw.identities=[]; raw.bindingRevision='b'.repeat(64);
  const absent=await client.ownerIdentities();
  assert.deepEqual(absent.identities,[]); assert.equal(absent.bindingRevision,'b'.repeat(64));
  assert.equal(result.identities[0].externalUserId,externalUserId); assert.equal(calls,2);
});

test('malformed, ambiguous or unavailable owner bindings never become an empty identity list', async () => {
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),ownerUserId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'j'.repeat(43)}`,expiresAt:1});
  const row={bindingId:randomUUID(),provider:'telegram',externalUserId:'321'};
  const valid={schemaVersion:1,assistantUserId:assistantId,ownerUserId,bindingRevision:'c'.repeat(64),identities:[row]};
  let response=valid,calls=0;
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,http:async()=>{
    calls++; if(response instanceof Error)throw response; return response;
  }});
  const malformed=[null,{}, {...valid,schemaVersion:2},{...valid,assistantUserId:randomUUID()},
    {...valid,ownerUserId:assistantId},{...valid,ownerUserId:'broken'}, {...valid,bindingRevision:'not-a-hash'},
    {...valid,identities:null},{...valid,identities:[row,{...row,bindingId:randomUUID()}]},
    {...valid,identities:[row,{...row,provider:'max'}]},
    ...['email','Telegram','@owner_alias'].map(provider=>({...valid,identities:[{...row,provider}]})),
    ...['',' 321','321\n','x'.repeat(257),321].map(externalUserId=>({...valid,identities:[{...row,externalUserId}]})),
    {...valid,identities:[{...row,bindingId:'bad'}]},
  ];
  for(response of malformed)await assert.rejects(client.ownerIdentities(),error=>error.code==='ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  response=new AssistantTransportError('ASSISTANT_ACCESS_DENIED',403);
  await assert.rejects(client.ownerIdentities(),error=>error.code==='ASSISTANT_ACCESS_DENIED'&&error.status===403);
  assert.equal(calls,malformed.length+1,'no retries, identity guessing, cache fallback or human reauthentication');
  const two={...valid,identities:[row,{bindingId:randomUUID(),provider:'max',externalUserId:'001-AbC'}]};
  response=two;
  assert.equal((await client.ownerIdentities()).identities[1].externalUserId,'001-AbC','opaque ids are not normalized');
  const {ASSISTANT_MCP_TOOLS}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  assert.ok(!ASSISTANT_MCP_TOOLS.includes('ownerIdentities'));
  assert.ok(!ASSISTANT_MCP_TOOLS.includes('get_assistant_owner_identities'));
});

test('source configuration uses one fixed device GET and returns immutable scoped refs, never a login claim', async () => {
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),companyId=randomUUID();
  const slot={origin,kind:'device',id:assistantId},store=memoryStore(),credential=`tda_${'s'.repeat(43)}`;
  await store.put(slot,{assistantId,deviceId,credential,expiresAt:1});
  const row={id:randomUUID(),companyId,deviceId,localAccountId:randomUUID(),projectId:null,
    skillId:'telegram-mtproto',state:'active',revision:0,provisionLocalAccount:false,executionVerified:false};
  const wire={schemaVersion:1,assistantUserId:assistantId,deviceId,companyId,
    sources:[{...row,label:'PRIVATE_LABEL',selectors:{chat:'PRIVATE_CHAT'}}],private:'PRIVATE_EXTRA'};
  let calls=0;
  const http=createAssistantHttp({origin,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,`${origin}/api/digital-assistants/runtime/source-skills/accounts?companyId=${companyId}`);
    assert.equal(options.method,'GET');assert.equal(options.body,undefined);assert.equal(options.headers['content-type'],undefined);
    assert.equal(options.headers.authorization,`Bearer ${credential}`);assert.equal(options.credentials,'omit');
    assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.ok(options.signal);
    return new Response(JSON.stringify(wire),{headers:{'content-type':'application/json'}});
  }});
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,http});
  const result=await client.sourceAccounts(companyId.toUpperCase(),new AbortController().signal);
  assert.deepEqual(result,[row]);assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result[0]));
  assert.throws(()=>{result[0].state='revoked';},TypeError);assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  // A fresh, identity-bound empty list is real absence. It cannot be supplied
  // by a failed request, another company's response or stale admission cache.
  wire.sources=[{...row,provisionLocalAccount:true}];
  assert.equal((await client.sourceAccounts(companyId))[0].provisionLocalAccount,true,'native new-account intent is retained, not inferred');
  wire.sources=[{...row,provisionLocalAccount:undefined}];
  assert.equal((await client.sourceAccounts(companyId))[0].provisionLocalAccount,false,'older references cannot silently authorize creation');
  wire.sources=[];assert.deepEqual(await client.sourceAccounts(companyId),[]);assert.equal(calls,4);
  assert.equal(result[0].state,'active');
  for(const bad of [{companyId,selector:'x'},{companyId:'bad'},undefined])
    await assert.rejects(http('sourceAccounts',bad,credential),/INVALID_INPUT/);
  assert.equal(calls,4,'bad queries never reach fetch');
  let reads=0;
  const invalid=createAssistantDeviceClient({origin,assistantId,deviceId,store:{get:async()=>{reads++;}},http});
  await assert.rejects(invalid.sourceAccounts('bad'),/INVALID_INPUT/);assert.equal(reads,0);
});

test('source config rejects scope/protocol/duplicate errors and never maps refusals to an empty list', async () => {
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),companyId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'u'.repeat(43)}`,expiresAt:1});
  const row={id:randomUUID(),companyId,deviceId,localAccountId:randomUUID(),projectId:randomUUID(),
    skillId:'email-imap-smtp',state:'paused',revision:2,executionVerified:false};
  const valid={schemaVersion:1,assistantUserId:assistantId,companyId,deviceId,sources:[row]};
  let response=valid,calls=0;
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,http:async()=>{
    calls++;if(response instanceof Error)throw response;return response;
  }});
  const malformed=[null,{}, {...valid,schemaVersion:2},
    ...['assistantUserId','deviceId','companyId'].map(key=>({...valid,[key]:randomUUID(),sources:[]})),
    {...valid,sources:null},{...valid,sources:Array.from({length:129},()=>({...row,id:randomUUID()}))},
    {...valid,sources:[row,{...row,id:row.id.toUpperCase()}]},
    ...['id','companyId','deviceId','localAccountId','projectId'].map(key=>({...valid,sources:[{...row,[key]:'bad'}]})),
    ...['companyId','deviceId'].map(key=>({...valid,sources:[{...row,[key]:randomUUID()}]})),
    ...[true,undefined,'false'].map(executionVerified=>({...valid,sources:[{...row,executionVerified}]})),
    ...[null,0,'true',{}].map(provisionLocalAccount=>({...valid,sources:[{...row,provisionLocalAccount}]})),
    ...[null,0,'true',{}].map(interactiveSetupAllowed=>({...valid,sources:[{...row,interactiveSetupAllowed}]})),
    {...valid,sources:[{...row,interactiveSetupAllowed:true}]},
    {...valid,sources:[{...row,skillId:'max-web',provisionLocalAccount:false,interactiveSetupAllowed:true}]},
    ...[-1,1.5,2_147_483_648].map(revision=>({...valid,sources:[{...row,revision}]})),
    {...valid,sources:[{...row,skillId:'arbitrary-provider'}]},{...valid,sources:[{...row,state:'ready'}]},
  ];
  for(response of malformed)await assert.rejects(client.sourceAccounts(companyId),error=>error.code==='ASSISTANT_TRANSPORT_INVALID_RESPONSE');
  for(const [code,status] of [['ASSISTANT_ACCESS_DENIED',403],['ASSISTANT_DEVICE_REQUIRED',401],['ASSISTANT_TRANSPORT_REJECTED',404],['ASSISTANT_TRANSPORT_UNAVAILABLE',null]]){
    response=new AssistantTransportError(code,status);
    await assert.rejects(client.sourceAccounts(companyId),error=>error===response);
  }
  assert.equal(calls,malformed.length+4,'no hidden retry or human auth/account fallback');
  response={...valid,sources:[{...row,provisionLocalAccount:true,interactiveSetupAllowed:true}]};
  assert.equal((await client.sourceAccounts(companyId))[0].interactiveSetupAllowed,true,'separate native email permission survives bounded projection');
  response={...valid,sources:[{...row,skillId:'max-web',provisionLocalAccount:true,interactiveSetupAllowed:true}]};
  assert.equal((await client.sourceAccounts(companyId))[0].interactiveSetupAllowed,true,'MAX still requires a native provisioned source');
  response={...valid,sources:[{...row,skillId:'telegram-mtproto',provisionLocalAccount:true,interactiveSetupAllowed:true}]};
  assert.equal((await client.sourceAccounts(companyId))[0].interactiveSetupAllowed,true,'Telegram still requires its own native login admission after inventory');
  response={...valid,sources:['active','paused','revoked'].map((state,index)=>({...row,id:randomUUID(),state,revision:index}))};
  assert.equal((await client.sourceAccounts(companyId)).length,3,'desired states remain separate from verified execution');
  const {ASSISTANT_MCP_TOOLS}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  assert.ok(!ASSISTANT_MCP_TOOLS.includes('sourceAccounts'),'host-private discovery is not a model tool');
});

test('pairing persists verifier before I/O, handles pending and stages candidate without overwriting active device', async () => {
  const origin='https://assistant.test',enrollmentId=randomUUID(),pairingId=randomUUID(),assistantUserId=randomUUID(),deviceId=randomUUID();
  const store=memoryStore(); let exchanges=0,seenVerifier;
  const client=createAssistantPairingClient({origin,store,now:()=>100,http:async(operation,input)=>{
    const saved=await store.get({origin,kind:'pairing',id:enrollmentId});
    if(operation==='pair') {
      assert.equal(saved.phase,'prepared'); assert.equal(saved.verifier.length,43);
      return {pairingId,assistantUserId,state:'pending',recovery:null,verificationCode:'ABCDEF12',expiresAt:new Date(20000).toISOString()};
    }
    assert.equal(saved.phase,'exchanging'); assert.equal(input.verifier,saved.verifier); seenVerifier=input.verifier;
    if(!exchanges++) throw new AssistantTransportError('ASSISTANT_PAIRING_NOT_APPROVED',409);
    return {assistantUserId,deviceId,credential:`tda_${'b'.repeat(43)}`,expiresAt:new Date(30000).toISOString(),
      activation:{schemaVersion:1,mode:'initial',assistantUserId,replacesAssistantUserId:null,replacesDeviceId:null,authorizationId:pairingId}};
  }});
  const begin=await client.begin(enrollmentId,'Fixture'); assert.equal(begin.verificationCode,'ABCDEF12'); assert.doesNotMatch(JSON.stringify(begin),/verifier/);
  assert.deepEqual(await client.exchange(enrollmentId),{state:'pending'});
  assert.deepEqual(await client.exchange(enrollmentId),{state:'candidate',origin,assistantId:assistantUserId,deviceId});
  assert.ok(!(JSON.stringify(await store.get({origin,kind:'pairing',id:enrollmentId}))).includes(seenVerifier));
  assert.equal(await store.get({origin,kind:'device',id:assistantUserId}),null,'host activation owns the active write');
  assert.match((await store.get({origin,kind:'pairing',id:enrollmentId})).credential,/^tda_/u);
});

test('only exact not-approved exchange is waiting-owner; other known rejections preserve their native reason',async()=>{
  for(const code of ['ASSISTANT_PAIRING_NOT_APPROVED','ASSISTANT_HOST_PASS_REVIEW_REQUIRED','ASSISTANT_HOST_INTAKE_REVIEW_REQUIRED','ASSISTANT_STATE_CHANGED','ASSISTANT_UNKNOWN_CONFLICT']){
    const origin='https://assistant.test',enrollmentId=randomUUID(),pairingId=randomUUID(),assistantUserId=randomUUID(),store=memoryStore();let exchanges=0;
    const client=createAssistantPairingClient({origin,store,now:()=>100,http:async operation=>{
      if(operation==='pair')return {pairingId,assistantUserId,state:'pending',recovery:null,verificationCode:'ABCDEF12',expiresAt:new Date(20000).toISOString()};
      exchanges++;throw new AssistantTransportError(code,409);
    }});
    await client.begin(enrollmentId,'Fixture');
    if(code==='ASSISTANT_PAIRING_NOT_APPROVED')assert.deepEqual(await client.exchange(enrollmentId),{state:'pending'});
    else await assert.rejects(client.exchange(enrollmentId),{code:code==='ASSISTANT_UNKNOWN_CONFLICT'?'ASSISTANT_PAIRING_RECOVERY_REQUIRED':code});
    const saved=await store.get({origin,kind:'pairing',id:enrollmentId});
    assert.equal(saved.phase,code==='ASSISTANT_UNKNOWN_CONFLICT'?'exchanging':'pending');assert.equal(exchanges,1);
  }
});

test('lost exchange response is fenced across restarts and is never blindly repeated', async () => {
  const origin='https://assistant.test',enrollmentId=randomUUID(),assistantUserId=randomUUID(),store=memoryStore(); let exchanges=0;
  const http=async operation=>{
    if(operation==='pair') return {pairingId:randomUUID(),assistantUserId,state:'pending',recovery:null,verificationCode:'ABCDEF12',expiresAt:new Date(20000).toISOString()};
    exchanges++; throw new Error('response lost after server commit');
  };
  const client=createAssistantPairingClient({origin,store,http,now:()=>100}); await client.begin(enrollmentId,'Fixture');
  await assert.rejects(client.exchange(enrollmentId),/RECOVERY_REQUIRED/);
  const restarted=createAssistantPairingClient({origin,store,http,now:()=>100});
  await assert.rejects(restarted.exchange(enrollmentId),/RECOVERY_REQUIRED/); assert.equal(exchanges,1);
});


test('owner renewal recovers the same device after its cached pairing expiry without local re-pairing', async () => {
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  const original={assistantId,deviceId,credential:`tda_${'c'.repeat(43)}`,expiresAt:1};
  const slot={origin,kind:'device',id:assistantId}; await store.put(slot,original);
  let renewed=false,calls=0;
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,http:async(operation,body,credential)=>{
    calls++; assert.equal(operation,'heartbeat'); assert.equal(credential,original.credential);
    if(!renewed) throw new AssistantTransportError('ASSISTANT_ACCESS_DENIED',403);
    return {assistantUserId:assistantId,deviceId};
  }});
  await assert.rejects(client.heartbeat(),error=>error.code==='ASSISTANT_ACCESS_DENIED' && error.status===403);
  assert.deepEqual(await store.get(slot),original,'denial must not delete, replace or locally extend the credential');
  renewed=true;
  assert.deepEqual(await client.heartbeat(),{assistantId,deviceId});
  assert.equal(calls,2,'no hidden retry; only the next explicit polling pass contacts the server');
  assert.deepEqual(await store.get(slot),original,'server renewal needs no private store rewrite or key rotation');
});

test('task-pass and observed-runtime transport retain exact bindings and project away private server fields',async()=>{
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'x'.repeat(43)}`,expiresAt:1});
  const companyId=randomUUID(),taskId=randomUUID(),passId=randomUUID(),bindingId=randomUUID(),deliveryId=randomUUID(),threadId=randomUUID();
  const observation={schemaVersion:1,clientFamily:'codex',modelId:'gpt-6.1-sol',effortLevel:'high',evidenceLevel:'local_observed',source:'codex_hook',observedAt:new Date().toISOString()};
  const sessionId=randomUUID();let mismatch=false;const operations=[];
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,http:async(operation,input)=>{
    operations.push(operation);
    if(operation==='passBegin'||operation==='passRead')return {passId,bindingId,bindingRevision:3,deliveryId,threadId,state:'leased',leaseRevision:0,
      leaseExpiresAt:new Date(Date.now()+60000).toISOString(),execution:{modelId:'gpt-6.1-sol',effortLevel:'high',revision:1},secret:'PRIVATE'};
    if(operation==='passRenew')return {passId,leaseRevision:input.expectedLeaseRevision+1,leaseExpiresAt:new Date(Date.now()+60000).toISOString(),state:'leased',execution:{modelId:'gpt-6.1-sol',effortLevel:'high',revision:1}};
    if(operation==='endRuntime')return {ended:true,secret:'PRIVATE'};
    assert.equal(operation,'registerRuntime');
    return {schemaVersion:1,passId:input.passId,runtimeSessionId:sessionId,conversation:{provider:'codex',conversationId:mismatch?randomUUID():threadId,
      openProtocol:'codex-thread-v1'},expiresAt:new Date(Date.now()+300000).toISOString(),observation:input.observation,runtimeRefreshSupported:true,secret:'PRIVATE'};
  }});
  const begin=await client.beginTaskPass({companyId,taskId,bindingId,bindingRevision:3,deliveryId,threadId});
  assert.equal(begin.passId,passId);assert.ok(!JSON.stringify(begin).includes('PRIVATE'));
  assert.deepEqual(begin.execution,{modelId:'gpt-6.1-sol',effortLevel:'high',revision:1});
  const locator={companyId,taskId,passId};assert.equal((await client.readTaskPass(locator)).threadId,threadId);
  assert.equal((await client.renewTaskPass({...locator,expectedLeaseRevision:0,clientRequestId:randomUUID()})).leaseRevision,1);
  const request={...locator,clientSessionId:threadId,observation,publicKeySpki:'a'.repeat(59)};
  const registered=await client.registerRuntime(request);assert.equal(registered.runtimeSessionId,sessionId);
  assert.ok(!JSON.stringify(registered).includes('PRIVATE'));mismatch=true;
  await assert.rejects(client.registerRuntime(request),/INVALID_RESPONSE/);
  await assert.rejects(client.registerRuntime({...request,observation:{...observation,source:'agent_request'}}),/INVALID_INPUT/);
  assert.deepEqual(await client.endRuntime({...locator,runtimeSessionId:sessionId}),{ended:true});
  assert.deepEqual(operations,['passBegin','passRead','passRenew','registerRuntime','registerRuntime','endRuntime']);
});

test('native discussion mode survives task inventory, exact reads, event and pass projection; unknown modes fail closed',async()=>{
  const origin='https://discussion.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'x'.repeat(43)}`,expiresAt:1});
  const companyId=randomUUID(),taskId=randomUUID(),bindingId=randomUUID(),passId=randomUUID(),deliveryId=randomUUID(),threadId=randomUUID();
  let mode='discussion';
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,http:async operation=>{
    const binding={id:bindingId,taskId,state:'accepted',revision:2,...(mode===undefined?{}:{workMode:mode})};
    if(operation==='tasks')return {bindings:[binding],nextCursor:null};
    if(operation==='task')return {binding,hostState:'this_device',execution:{state:'unconfigured',configuration:null,policyRevisionId:null}};
    if(operation==='poll')return {events:[{id:randomUUID(),revision:'1',taskId,wake:true,bindingId,bindingRevision:2,taskState:'accepted',
      ...(mode===undefined?{}:{workMode:mode})}],nextCursor:'1',hasMore:false};
    assert.ok(['passBegin','passRead'].includes(operation));
    return {passId,bindingId,bindingRevision:2,deliveryId,threadId,state:'leased',leaseRevision:0,
      leaseExpiresAt:new Date(Date.now()+60000).toISOString(),execution:{modelId:'gpt-6.1-sol',effortLevel:'high',revision:1},
      ...(mode===undefined?{}:{workMode:mode})};
  }});
  const reads=[async()=>(await client.tasks(companyId)).bindings[0],()=>client.task(companyId,taskId),
    async()=>(await client.poll(companyId)).events[0],()=>client.beginTaskPass({companyId,taskId,bindingId,bindingRevision:2,deliveryId,threadId}),
    ()=>client.readTaskPass({companyId,taskId,passId})];
  for(const read of reads)assert.equal((await read()).workMode,'discussion');
  mode=undefined;for(const read of reads)assert.equal(Object.hasOwn(await read(),'workMode'),false,'legacy server keeps its existing projection');
  for(mode of [null,'admin','DISCUSSION',{},false])for(const read of reads)await assert.rejects(read(),/INVALID_RESPONSE/);
});

test('discussion completion forwards its exact native reply without opening any material or company key',async()=>{
  const {withAssistantEncryptedMaterial}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const taskPass={companyId:randomUUID(),taskId:randomUUID(),passId:randomUUID()};
  const args={taskPass,clientRequestId:randomUUID(),replyCommentId:randomUUID(),goalState:'completed',noChange:false};
  let sends=0;
  const isolated={withProfile:()=>assert.fail('discussion cannot inspect a Workspace or private managed profile'),
    loadCommon:()=>assert.fail('discussion cannot open a material inspector')};
  const send=async wire=>{sends++;assert.equal(wire,args);return {state:'confirmed',receiptId:randomUUID()};};
  assert.equal((await withAssistantEncryptedMaterial({args},send,isolated)).state,'confirmed');assert.equal(sends,1);
  for(const invalid of [{replyCommentId:'invalid'},{goalState:'active'},{noChange:true},
    {workspaceId:randomUUID()},{workspaceHead:'a'.repeat(40)},{acceptedRunId:randomUUID()},
    {encryptedMaterialWitness:{}},{sourceProcessingProof:{}},{processedSourceReferences:[{eventOrdinal:0}]},
    {processedSourceReferences:{}}]){
    await assert.rejects(withAssistantEncryptedMaterial({args:{...args,...invalid}},send,isolated),/PLAN_INVALID/);
  }
  assert.equal(sends,1,'mixed/fabricated material evidence never reaches native completion');
  const denial=Object.assign(new Error('native task-mode denial'),{code:'ASSISTANT_DISCUSSION_REQUIRED'});
  await assert.rejects(withAssistantEncryptedMaterial({args},async()=>{sends++;throw denial;},isolated),error=>error===denial);
  assert.equal(sends,2,'native rejection is preserved without a retry or material fallback');
  const ordinary={...args};delete ordinary.replyCommentId;
  await assert.rejects(withAssistantEncryptedMaterial({args:ordinary},send,isolated),/PLAN_INVALID/);
});

test('fresh company execution state is projected without accepting local defaults or private metadata',async()=>{
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),companyId=randomUUID(),taskId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'v'.repeat(43)}`,expiresAt:1});
  const selected={id:randomUUID(),modelId:'gpt-6.1-sol',effortLevel:'high',revision:3,secret:'PRIVATE'};
  let execution={state:'ready',configuration:selected,policyRevisionId:randomUUID(),content:'PRIVATE'};
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,http:async()=>({
    binding:{id:randomUUID(),taskId,state:'accepted',revision:2},hostState:'this_device',execution,
  })});
  const projected=await client.task(companyId,taskId);
  assert.deepEqual(projected.execution.configuration,{modelId:selected.modelId,effortLevel:'high',revision:3});
  assert.ok(!JSON.stringify(projected).includes('PRIVATE'));
  execution={...execution,state:'policy_blocked'};
  assert.equal((await client.task(companyId,taskId)).execution.state,'policy_blocked');
  execution={...execution,configuration:{...selected,effortLevel:'high\n--flag'}};
  await assert.rejects(client.task(companyId,taskId),/INVALID_RESPONSE/);
});

test('business outcome read is fixed, exact and strict; pending never implies failure or permits a retry',async()=>{
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'o'.repeat(43)}`,expiresAt:1});
  const expected={assistantId,deviceId,companyId:randomUUID(),taskId:randomUUID(),bindingId:randomUUID(),
    bindingRevision:2,deliveryId:randomUUID(),threadId:randomUUID()};
  let value={schemaVersion:1,state:'pending'},calls=0;
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,http:createAssistantHttp({origin,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,origin+'/api/digital-assistants/runtime/task-pass/outcome');assert.equal(options.method,'POST');
    assert.deepEqual(JSON.parse(options.body),Object.fromEntries(Object.entries(expected).filter(([key])=>!['assistantId','deviceId'].includes(key))));
    return Response.json(value);
  }})});
  assert.deepEqual(await client.readBusinessOutcome(expected),value);assert.equal(calls,1);
  value={schemaVersion:1,state:'confirmed',receiptId:randomUUID(),...expected,
    continuation:{goalState:'waiting_external',cadence:'weekly',timeZone:'Europe/Moscow'}};
  assert.deepEqual(await client.readBusinessOutcome(expected),value);assert.equal(calls,2);
  const good=value;
  for(const bad of [{...good,taskId:randomUUID()},{...good,body:'PRIVATE'},
    {...good,continuation:{...good.continuation,cadence:'every_second'}},{schemaVersion:1,state:'pending',receiptId:randomUUID()}]) {
    value=bad;await assert.rejects(client.readBusinessOutcome(expected),/INVALID_RESPONSE/);
  }
  assert.equal(calls,6,'one request per explicit read; malformed outcomes do not cause a hidden retry');
  const ref={sourceId:randomUUID(),sourceRevision:2,routeId:randomUUID(),eventOrdinal:1};
  value={...good,processedSourceReferences:[ref]};
  assert.deepEqual(await client.readBusinessOutcome(expected),value);
  for(const processedSourceReferences of [[],[ref,ref],[{...ref,eventOrdinal:100}],[{...ref,messageId:'PRIVATE'}],
    [{...ref,eventOrdinal:2},ref]]){
    value={...good,processedSourceReferences};await assert.rejects(client.readBusinessOutcome(expected),/INVALID_RESPONSE/);
  }
  assert.equal(calls,12,'no hidden retries while validating granular committed processing');
  await assert.rejects(client.readBusinessOutcome({...expected,assistantId:randomUUID()}),/INVALID_INPUT/);assert.equal(calls,12);
});


test('native input inventory rejects closed shape mismatches without copying domain schemas',()=>{
  const ref={type:'object',properties:{label:{type:'string'},targets:{type:'array',items:{$ref:'#/$defs/target'}}},
    required:['label','targets'],additionalProperties:false,
    $defs:{target:{oneOf:[{type:'object',properties:{kind:{const:'member'},id:{type:'string'}},required:['kind','id'],additionalProperties:false},
      {type:'object',properties:{kind:{const:'none'},value:{type:'null'}},required:['kind','value'],additionalProperties:false}]}}};
  const good={label:'exact',targets:[{kind:'member',id:'native-id'},{kind:'none',value:null}]};
  validateAssistantNativeInputShape(ref,good);
  const before=structuredClone(ref);
  for(const bad of [{...good,unknown:'PRIVATE_UNKNOWN_ROOT'},{...good,targets:[{...good.targets[0],extra:'PRIVATE_NESTED'}]},
    {...good,targets:[{kind:'member',id:{text:'PRIVATE_ID_OBJECT'}}]}, {...good,targets:{}}, {...good,label:[]},
    {...good,targets:[{kind:'other',id:'native-id'}]}, {label:'missing required targets'}])
    assert.throws(()=>validateAssistantNativeInputShape(ref,bad),{code:'ASSISTANT_MCP_INPUT_INVALID'});
  assert.deepEqual(ref,before,'live native schema is never rewritten or cached as an authorization profile');
  validateAssistantNativeInputShape({type:'object',properties:{parameters:{type:'object',additionalProperties:{type:'string'}}}},
    {parameters:{nativeOpenKey:'valid'}});
  assert.throws(()=>validateAssistantNativeInputShape({type:'object',properties:{parameters:{type:'object',additionalProperties:{type:'string'}}}},
    {parameters:{nativeOpenKey:{text:'not the advertised open value type'}}}),{code:'ASSISTANT_MCP_INPUT_INVALID'});
  for(const schema of [{type:'object',properties:{x:{$ref:'https://foreign.test/schema'}}},
    {type:'object',properties:{x:{$ref:'#/$defs/missing'}}},{type:'object',properties:{x:{type:'string',pattern:'['}}}])
    assert.throws(()=>validateAssistantNativeInputShape(schema,{x:'native'}),{code:'ASSISTANT_MCP_INVALID_RESPONSE'});
  const cycle={type:'object',properties:{x:{$ref:'#/$defs/cycle'}},$defs:{cycle:{$ref:'#/$defs/cycle'}}};
  assert.throws(()=>validateAssistantNativeInputShape(cycle,{x:1}),{code:'ASSISTANT_MCP_INVALID_RESPONSE'});
});

test('fresh native input shape is checked before managed preparation and never retries a mutation',async()=>{
  const origin='https://input-shape.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'s'.repeat(43)}`,expiresAt:1});
  let nativeSchema={type:'object',properties:{bodyMarkdown:{type:'string'},selection:{type:'object',properties:{id:{type:'string',pattern:'^native-[0-9]+$'}},additionalProperties:false}},additionalProperties:false};
  let preparations=0,business=0,catalogs=0,lose=false;const wire=[];
  const proxy=createAssistantMcpClient({origin,assistantId,deviceId,store,
    withWorkspaceArguments:async({args},send)=>{preparations++;return send({...args,bodyMarkdown:'PROTECTED_MARKER'});},
    httpRequest:async(input,{signal})=>{
      assert.ok(signal);wire.push(JSON.stringify(input.payload??{}));
      const reply=result=>({sessionId:'fresh-shape',message:{jsonrpc:'2.0',id:input.payload?.id,result}});
      if(input.method==='DELETE'||input.payload.method==='notifications/initialized')return reply({});
      if(input.payload.method==='initialize')return reply({protocolVersion:'2025-06-18'});
      if(input.payload.method==='tools/list'){catalogs++;return reply({tools:[{name:'create_comment',description:'Exact current native shape',inputSchema:nativeSchema}]});}
      assert.equal(input.payload.method,'tools/call');business++;if(lose)throw new Error('synthetic unknown mutation outcome');
      return reply({content:[]});
    }});
  const canary='PRIVATE_INVALID_SHAPE_CANARY';
  for(const args of [{bodyMarkdown:'ok',unknown:canary},{bodyMarkdown:{unprotected:canary}},
    {bodyMarkdown:'ok',selection:{id:'native-1',unknown:canary}},{bodyMarkdown:'ok',selection:{id:canary}}])
    await assert.rejects(proxy.callTool('create_comment',args),{code:'ASSISTANT_MCP_INPUT_INVALID'});
  assert.equal(preparations,0,'no invalid root/nested shape reaches payload staging');assert.equal(business,0);
  assert.equal(wire.join('').includes(canary),false,'catalogue/initialize contain no caller data');
  await proxy.callTool('create_comment',{bodyMarkdown:'valid private content',selection:{id:'native-1'}});
  assert.equal(preparations,1);assert.equal(business,1);
  nativeSchema={...nativeSchema,properties:{...nativeSchema.properties,newNativeField:{type:'boolean'}}};
  await proxy.callTool('create_comment',{bodyMarkdown:'valid',newNativeField:true});
  assert.equal(business,2,'new native fields need no copied host schema or restart');
  nativeSchema={...nativeSchema,properties:{newNativeField:{type:'boolean'}}};
  await assert.rejects(proxy.callTool('create_comment',{bodyMarkdown:'now removed'}),{code:'ASSISTANT_MCP_INPUT_INVALID'});
  assert.equal(business,2,'a previously advertised field is not cached staging authority');
  lose=true;await assert.rejects(proxy.callTool('create_comment',{newNativeField:true}),{code:'ASSISTANT_MCP_UNAVAILABLE'});
  assert.equal(business,3,'lost mutation result is never replayed');assert.equal(catalogs,8);
});

test('trusted local Workspace recovery errors keep their closed code across the real MCP wrapper',async()=>{
  const origin='https://local-recovery.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'r'.repeat(43)}`,expiresAt:1});
  let code='ASSISTANT_WORKSPACE_BINDING_CHANGED',business=0,preparations=0;
  const client=createAssistantMcpClient({origin,assistantId,deviceId,store,
    withWorkspaceArguments:async()=>{preparations++;throw Object.assign(new Error('PRIVATE EXCEPTION AND PATH'),{code,reason:'expired',payload:{secret:'PRIVATE'}});},
    httpRequest:async input=>{
      const reply=result=>({sessionId:'local-recovery',message:{jsonrpc:'2.0',id:input.payload?.id,result}});
      if(input.method==='DELETE'||input.payload.method==='notifications/initialized')return reply({});
      if(input.payload.method==='initialize')return reply({protocolVersion:'2025-06-18'});
      if(input.payload.method==='tools/list')return reply({tools:[{name:'get_task',description:'Synthetic native schema',inputSchema:{type:'object',properties:{},additionalProperties:false}}]});
      business++;assert.fail('local refusal cannot send or repeat a business call');
    }});
  for(code of ['ASSISTANT_WORKSPACE_BINDING_CHANGED','RUN_NOT_ACTIVE','TRELIO_RUNTIME_HOOK_REQUIRED']){
    await assert.rejects(client.callTool('get_task',{}),error=>error instanceof AssistantTransportError
      &&error.code===code&&error.message===code&&!JSON.stringify(error).includes('PRIVATE')
      &&(code!=='TRELIO_RUNTIME_HOOK_REQUIRED'||error.reason==='expired'));
  }
  code='PRIVATE_UNREVIEWED_CODE';
  await assert.rejects(client.callTool('get_task',{}),{code:'ASSISTANT_MCP_UNAVAILABLE'});
  assert.equal(preparations,4);assert.equal(business,0);
});

test('generic owner action fields reuse their current native operation inventory before staging',async()=>{
  const origin='https://action-shape.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'q'.repeat(43)}`,expiresAt:1});
  let prepares=0,calls=0;const wire=[];
  const proxy=createAssistantMcpClient({origin,assistantId,deviceId,store,
    withWorkspaceArguments:async({args},send)=>{prepares++;return send(args);},httpRequest:async input=>{
      wire.push(JSON.stringify(input.payload??{}));
      const reply=result=>({sessionId:'action-shape',message:{jsonrpc:'2.0',id:input.payload?.id,result}});
      if(input.method==='DELETE'||input.payload.method==='notifications/initialized')return reply({});
      if(input.payload.method==='initialize')return reply({protocolVersion:'2025-06-18'});
      if(input.payload.method==='tools/list')return reply({tools:[
        {name:'request_assistant_action',description:'Native generic request',inputSchema:{type:'object',properties:{
          operation:{enum:['update_task_control']},fields:{type:'object',additionalProperties:{}},reason:{type:'string'},
          clientRequestId:{type:'string'},expectedTaskUpdatedAt:{type:'string'}},additionalProperties:false}},
        {name:'update_task_control',description:'SAME ordinary native operation',inputSchema:{type:'object',properties:{
          controlId:{type:'string'},note:{type:'string'},clientRequestId:{type:'string'},expectedTaskUpdatedAt:{type:'string'},
          ownerDecisionId:{type:'string'},taskPass:{},runtimeSessionProof:{}},required:['controlId','clientRequestId','expectedTaskUpdatedAt'],additionalProperties:false}}]});
      assert.equal(input.payload.method,'tools/call');calls++;return reply({content:[]});
    }});
  const action={operation:'update_task_control',reason:'Native request',clientRequestId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString()};
  const canary='PRIVATE_UNKNOWN_ACTION_FIELD_CANARY';
  for(const fields of [{controlId:'id',unknown:canary},{controlId:'id',note:{plaintext:canary}},
    {controlId:'id',ownerDecisionId:canary},{controlId:'id',taskPass:{secret:canary}},{controlId:'id',clientRequestId:canary}])
    await assert.rejects(proxy.callTool('request_assistant_action',{...action,fields}),{code:'ASSISTANT_MCP_INPUT_INVALID'});
  assert.equal(prepares,0);assert.equal(calls,0);assert.equal(wire.join('').includes(canary),false);
  await proxy.callTool('request_assistant_action',{...action,fields:{controlId:'id',note:'native field'}});
  assert.equal(prepares,1);assert.equal(calls,1,'same native business fields need no host-specific action schema');
});

test('assistant MCP reuses the bounded protocol with its real device profile and no schema copies or hidden retry', async () => {
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  const credential=`tda_${'z'.repeat(43)}`;
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential,expiresAt:1});
  const {buildRemoteMcpRequestHeaders,validateRemoteMcpPublicationConfig}=await import('../host-runtime/scripts/trelio-remote-mcp.mjs');
  const calls=[];let echoed=false,broken=false,receivedArgs;
  const shape={type:'object',properties:{taskPass:{},runtimeSessionProof:{}},additionalProperties:false};
  const client=createAssistantMcpClient({origin,assistantId,deviceId,store,httpRequest:async(input,{signal})=>{
    assert.ok(signal);assert.equal(input.config.endpoint,origin+'/mcp/assistant');assert.equal(input.config.authentication.type,'assistant_device');
    assert.equal(buildRemoteMcpRequestHeaders({...input,body:null}).authorization,`Bearer ${credential}`);
    assert.equal(input.credential,credential);calls.push(input.method??input.payload.method);
    if(broken)throw new Error('PRIVATE HTTP DETAIL');
    const response=result=>({sessionId:'fixture-session',message:{jsonrpc:'2.0',id:input.payload?.id,result}});
    if(input.method==='DELETE')return response({});
    if(input.payload.method==='initialize')return response({protocolVersion:'2025-06-18'});
    if(input.payload.method==='notifications/initialized')return response({});
    if(input.payload.method==='tools/list')return response({tools:[
      {name:'get_assistant_status',description:'Live status',inputSchema:shape,_meta:{private:'DO_NOT_PROXY_METADATA'}},
      {name:'get_task',description:'Live backend schema',inputSchema:shape},
      {name:'human_login',description:'Never delegate this',inputSchema:shape},
      {name:'create_comment',description:'Current assistant backend write',inputSchema:{type:'object'},annotations:{idempotentHint:true}},
      {name:'continue_assistant_workspace_action',description:'Current local action',inputSchema:shape,annotations:{idempotentHint:false}},
      {name:'request_assistant_action',description:'Live sealed owner action',inputSchema:{...shape,properties:{...shape.properties,operation:{type:'string'},fields:{type:'object'},reason:{type:'string'},clientRequestId:{type:'string'},expectedTaskUpdatedAt:{type:'string'}}}},
      ...['update_task_due_date','update_task_assignee','set_task_participants','update_task_custom_field','create_task_relation','delete_task_relation','delete_checklist','delete_attachment'].map(name=>({name,description:'Live native task operation',inputSchema:{type:'object'},annotations:{destructiveHint:name==='delete_checklist'||name==='delete_task_relation'||name==='delete_attachment'}})),
      ...['search_agent_guidance','get_agent_skill','get_agent_procedure'].map(name=>({name,description:'Live native guidance read',inputSchema:{type:'object'}})),
      {name:'clear_task_control',description:'Current native control write',inputSchema:{type:'object'}},
      {name:'delete_workspace',description:'Unsupported; must remain closed',inputSchema:shape},
    ]});
    assert.equal(input.payload.method,'tools/call');receivedArgs=input.payload.params.arguments;
    return response({content:[{type:'text',text:echoed?credential:'native content'}],structuredContent:{schemaVersion:3},_meta:{discard:true}});
  }});
  const tools=await client.listTools();assert.deepEqual(tools.map(tool=>tool.name),['get_assistant_status','get_task','create_comment','continue_assistant_workspace_action','request_assistant_action','update_task_due_date','update_task_assignee','set_task_participants','update_task_custom_field','create_task_relation','delete_task_relation','delete_checklist','delete_attachment','search_agent_guidance','get_agent_skill','get_agent_procedure','clear_task_control']);
  assert.deepEqual(tools[1].inputSchema,{type:'object',properties:{},additionalProperties:false});
  assert.deepEqual(Object.keys(shape.properties),['taskPass','runtimeSessionProof']);
  assert.equal(tools[2].annotations.idempotentHint,true);assert.equal(tools[3].annotations.idempotentHint,false);assert.ok(!JSON.stringify(tools).includes('DO_NOT_PROXY_METADATA'));
  const args={taskPass:{passId:randomUUID()},runtimeSessionProof:{signature:'original'}};
  const resultPromise=client.callTool('get_task',args);args.runtimeSessionProof.signature='changed';
  const result=await resultPromise;assert.equal(receivedArgs.runtimeSessionProof.signature,'original');
  assert.equal(result.content[0].text,'native content');assert.ok(!('_meta' in result));
  assert.deepEqual(calls,['initialize','notifications/initialized','tools/list','DELETE','initialize','notifications/initialized','tools/list','tools/call','DELETE']);
  const count=calls.length;await assert.rejects(client.callTool('delete_workspace',{}),/CAPABILITY_UNAVAILABLE/);assert.equal(calls.length,count);
  assert.equal(tools[2].annotations.readOnlyHint,false);
  assert.equal(tools.find(tool=>tool.name==='delete_checklist').annotations.destructiveHint,true);
  assert.equal(tools.find(tool=>tool.name==='delete_attachment').annotations.destructiveHint,true);
  assert.equal(tools.find(tool=>tool.name==='delete_task_relation').annotations.destructiveHint,true);
  assert.equal(tools[0].annotations.destructiveHint,false);
  const beforeWrite=calls.length;
  const body={bodyMarkdown:'Scoped working update',clientRequestId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString()};
  await client.callTool('create_comment',body);
  assert.deepEqual(receivedArgs,body,'the current backend owns validation; the host adds no human approval flags');
  assert.equal(calls.slice(beforeWrite).filter(name=>name==='tools/call').length,1,'one write is never replayed');
  assert.equal(tools[4].annotations.readOnlyHint,false);
  assert.deepEqual(Object.keys(tools[4].inputSchema.properties).sort(),['clientRequestId','expectedTaskUpdatedAt','fields','operation','reason']);
  const intent={operation:'clear_task_control',fields:{controlId:randomUUID()},reason:'Confirmed outcome',
    clientRequestId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString()};
  await client.callTool('request_assistant_action',intent);assert.deepEqual(receivedArgs,intent);
  const apply={...intent.fields,clientRequestId:intent.clientRequestId,expectedTaskUpdatedAt:intent.expectedTaskUpdatedAt,ownerDecisionId:randomUUID()};
  await client.callTool('clear_task_control',apply);assert.deepEqual(receivedArgs,apply,'no generated human assertion or replacement intent');
  for(const name of ['update_task_due_date','update_task_assignee','set_task_participants','update_task_custom_field','create_task_relation','delete_task_relation','delete_checklist','delete_attachment']) {
    assert.equal(tools.find(tool=>tool.name===name).annotations.readOnlyHint,false);
    const before=calls.filter(method=>method==='tools/call').length;
    await client.callTool(name,apply);assert.deepEqual(receivedArgs,apply);
    assert.equal(calls.filter(method=>method==='tools/call').length,before+1,'live backend validator remains the only domain authority; no hidden retry');
  }
  const attachmentIntent={attachmentId:randomUUID(),ownerDecisionId:randomUUID(),clientRequestId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString()};
  await client.callTool('delete_attachment',attachmentIntent);
  assert.deepEqual(receivedArgs,attachmentIntent,'exact target/owner decision stay backend authority; host never reads bytes or substitutes a human assertion');
  for(const [name,fields]of Object.entries({search_agent_guidance:{query:'follow-up'},get_agent_skill:{skillId:'company-skill',sections:['instructions','execution']},get_agent_procedure:{procedureId:randomUUID()}})){
    assert.equal(tools.find(tool=>tool.name===name).annotations.readOnlyHint,true);
    const input={...args,...fields};await client.callTool(name,input);assert.deepEqual(receivedArgs,input);
  }
  echoed=true;await assert.rejects(client.callTool('get_task',{}),/INVALID_RESPONSE/);
  broken=true;await assert.rejects(client.callTool('get_task',{}),error=>error.code==='ASSISTANT_MCP_UNAVAILABLE'&&!error.message.includes('PRIVATE'));
  assert.equal((await store.get({origin,kind:'device',id:assistantId})).credential,credential,'failure preserves the exact pairing');
  assert.throws(()=>validateRemoteMcpPublicationConfig({schemaVersion:1,endpoint:origin+'/mcp/assistant',transport:'streamable_http',
    protocolVersion:'2025-03-26',authentication:{type:'assistant_device'},headers:{},allowedTools:['get_task']}),
    error=>error.code==='REMOTE_MCP_UNSUPPORTED_AUTH', 'public Remote MCP declarations cannot request the trusted device profile');
});

// New domain fields come from the exact live catalogue. The generic host must
// preserve nested references/options and immutable arguments, rather than copy
// a second schema, synthesize approval flags, or replay a failed business write.
test('assistant MCP preserves live accepted-file and question-choice schemas and forwards each intent once',async()=>{
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'o'.repeat(43)}`,expiresAt:1});
  const fields={
    create_comment:{clientRequestId:{type:'string'},bodyMarkdown:{type:'string'},acceptedFiles:{type:'array',items:{type:'object',properties:{runId:{type:'string'},filePath:{type:'string'}},additionalProperties:false},minItems:1,maxItems:10}},
    ask_assistant_owner:{clientRequestId:{type:'string'},questionText:{type:'string'},options:{type:'array',items:{type:'string'},minItems:2,maxItems:8}},
    create_task_relation:{clientRequestId:{type:'string'},targetTaskId:{type:'string'},relationType:{type:'string'}},
    delete_task_relation:{clientRequestId:{type:'string'},relationId:{type:'string'}},
    cancel_agent_workspace_run:{runId:{type:'string',format:'uuid'},reason:{type:'string',minLength:1,maxLength:2000}},
  };
  const calls=[];let failed=false;
  const client=createAssistantMcpClient({origin,assistantId,deviceId,store,httpRequest:async(input)=>{
    const response=result=>({sessionId:'fixture-session',message:{jsonrpc:'2.0',id:input.payload?.id,result}});
    if(input.method==='DELETE')return response({});
    if(input.payload.method==='initialize')return response({protocolVersion:'2025-06-18'});
    if(input.payload.method==='notifications/initialized')return response({});
    if(input.payload.method==='tools/list')return response({tools:[
      {name:'get_assistant_status',description:'Live status',inputSchema:{type:'object'}},
      ...Object.entries(fields).map(([name,properties])=>({name,description:'Current backend contract',
        inputSchema:{type:'object',properties:{...properties,taskPass:{},runtimeSessionProof:{}},required:[...Object.keys(properties),'taskPass','runtimeSessionProof'],additionalProperties:false}})),
    ]});
    assert.equal(input.payload.method,'tools/call');calls.push(structuredClone(input.payload.params));
    if(failed)throw new Error('uncertain private upstream result');
    return response({content:[{type:'text',text:'committed'}]});
  }});
  const tools=await client.listTools();
  for(const [name,properties]of Object.entries(fields)){
    const tool=tools.find(value=>value.name===name);assert.ok(tool);assert.equal(tool.annotations.readOnlyHint,false);
    assert.deepEqual(tool.inputSchema,{type:'object',properties,required:Object.keys(properties),additionalProperties:false});
  }
  const proof={taskPass:{passId:randomUUID()},runtimeSessionProof:{signature:'hook-owned'}};
  const fileBody={...proof,clientRequestId:randomUUID(),bodyMarkdown:'Accepted deliverable',acceptedFiles:[{runId:randomUUID(),filePath:'deliverables/result.pdf'}]};
  const expected=structuredClone(fileBody),pending=client.callTool('create_comment',fileBody);
  fileBody.acceptedFiles[0].filePath='changed-after-invocation.pdf';await pending;
  assert.deepEqual(calls.at(-1),{name:'create_comment',arguments:expected});
  const question={...proof,clientRequestId:randomUUID(),questionText:'Choose the next step',options:['Prepare a draft','Wait for the supplier']};
  await client.callTool('ask_assistant_owner',question);assert.deepEqual(calls.at(-1),{name:'ask_assistant_owner',arguments:question});
  const relation={...proof,clientRequestId:randomUUID(),targetTaskId:randomUUID(),relationType:'Needs coordination'};
  await client.callTool('create_task_relation',relation);assert.deepEqual(calls.at(-1),{name:'create_task_relation',arguments:relation});
  const cancellation={...proof,runId:randomUUID(),reason:'Abandoned preparation; accepted goal retained'};
  await client.callTool('cancel_agent_workspace_run',cancellation);
  assert.deepEqual(calls.at(-1),{name:'cancel_agent_workspace_run',arguments:cancellation});
  const removal={...proof,clientRequestId:randomUUID(),relationId:randomUUID()};failed=true;
  const before=calls.length;await assert.rejects(client.callTool('delete_task_relation',removal),/MCP_UNAVAILABLE/);
  assert.equal(calls.length,before+1,'uncertain mutation must never be repeated by the host');
  assert.deepEqual(calls.at(-1),{name:'delete_task_relation',arguments:removal});
  const beforeCancel=calls.length;
  await assert.rejects(client.callTool('cancel_agent_workspace_run',cancellation),/MCP_UNAVAILABLE/);
  assert.equal(calls.length,beforeCancel+1,'an uncertain cancellation needs native read-back, never a host retry');
  assert.deepEqual(calls.at(-1),{name:'cancel_agent_workspace_run',arguments:cancellation});
});

test('independent task creation uses live native schemas and one immutable owner-reviewed intent', async () => {
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'q'.repeat(43)}`,expiresAt:1});
  const properties={title:{type:'string',maxLength:1024},statusCode:{type:'string'},
    assigneeMemberIds:{type:'array',items:{type:'string',format:'uuid'},maxItems:200},
    ownerDecisionId:{type:'string',format:'uuid'},clientRequestId:{type:'string',format:'uuid'},
    expectedTaskUpdatedAt:{type:'string'}};
  const wireSchema={type:'object',properties:{...properties,taskPass:{type:'object'},runtimeSessionProof:{type:'object'}},
    required:[...Object.keys(properties),'taskPass','runtimeSessionProof'],additionalProperties:false};
  const calls=[];let enabled=true,uncertain=false;
  const client=createAssistantMcpClient({origin,assistantId,deviceId,store,httpRequest:async input=>{
    const response=result=>({sessionId:'fixture-session',message:{jsonrpc:'2.0',id:input.payload?.id,result}});
    if(input.method==='DELETE')return response({});
    if(input.payload.method==='initialize')return response({protocolVersion:'2025-06-18'});
    if(input.payload.method==='notifications/initialized')return response({});
    if(input.payload.method==='tools/list')return response({tools:[
      {name:'get_assistant_status',description:'Native status',inputSchema:{type:'object'}},
      ...(enabled?[
        {name:'get_task_create_meta',description:'Fresh native project metadata',inputSchema:{type:'object',properties:{taskPass:{},runtimeSessionProof:{}},required:['taskPass','runtimeSessionProof'],additionalProperties:false}},
        {name:'create_task',description:'Exact owner-reviewed native creation',inputSchema:wireSchema},
      ]:[]),
      {name:'create_task_as_owner',description:'Unreviewed capability',inputSchema:{type:'object'}},
    ]});
    assert.equal(input.payload.method,'tools/call');calls.push(structuredClone(input.payload.params));
    if(uncertain)throw new Error('private ambiguous native response');
    return response({content:[{type:'text',text:'Native receipt'}],structuredContent:{task:{id:randomUUID()}}});
  }});
  const tools=await client.listTools();
  assert.equal(tools.find(tool=>tool.name==='get_task_create_meta').annotations.readOnlyHint,true);
  const create=tools.find(tool=>tool.name==='create_task');assert.equal(create.annotations.readOnlyHint,false);
  assert.deepEqual(create.inputSchema,{type:'object',properties,required:Object.keys(properties),additionalProperties:false});
  assert.ok(!tools.some(tool=>tool.name==='create_task_as_owner'));
  const proof={taskPass:{passId:randomUUID()},runtimeSessionProof:{signature:'observed-hook'}};
  await client.callTool('get_task_create_meta',proof);
  assert.deepEqual(calls.at(-1),{name:'get_task_create_meta',arguments:proof},'no guessed company/project locator or human credentials');
  const intent={...proof,title:'Owner-approved follow-up',statusCode:'queue',assigneeMemberIds:[randomUUID()],
    ownerDecisionId:randomUUID(),clientRequestId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString()};
  const expected=structuredClone(intent),pending=client.callTool('create_task',intent);
  intent.title='substituted after invocation';intent.assigneeMemberIds.length=0;await pending;
  assert.deepEqual(calls.at(-1),{name:'create_task',arguments:expected},'native owner decision/fields remain unchanged through asynchronous transport');
  uncertain=true;const before=calls.length;
  await assert.rejects(client.callTool('create_task',expected),error=>error.code==='ASSISTANT_MCP_UNAVAILABLE');
  assert.equal(calls.length,before+1,'unknown creation result requires native receipt read-back, never a second host attempt');
  assert.deepEqual(calls.at(-1),{name:'create_task',arguments:expected});
  enabled=false;
  assert.deepEqual((await client.listTools()).map(tool=>tool.name),['get_assistant_status'],'older backend is not supplemented with copied/default schemas');
});

test('self-repair proxies the dedicated live schema and exact immutable intent without exposing generic restore',async()=>{
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'p'.repeat(43)}`,expiresAt:1});
  // This is intentionally a changed synthetic server contract, not a second
  // production validator. A newly advertised optional native field must survive
  // projection without the generic host maintaining its own recovery schema.
  const properties={operation:{enum:['retract','restore']},workspaceId:{type:'string',format:'uuid'},
    runId:{type:'string',format:'uuid'},expectedHead:{type:'string'},targetHead:{type:'string'},
    correctionRunId:{type:'string',format:'uuid'},errorKind:{type:'string'},agentRecognizedOwnError:{type:'boolean'},reason:{type:'string'},futureNativeField:{type:'boolean'}};
  const required=['operation','workspaceId','runId','expectedHead'];
  const calls=[];let failed=false;
  const client=createAssistantMcpClient({origin,assistantId,deviceId,store,httpRequest:async input=>{
    const response=result=>({sessionId:'fixture-session',message:{jsonrpc:'2.0',id:input.payload?.id,result}});
    if(input.method==='DELETE')return response({});
    if(input.payload.method==='initialize')return response({protocolVersion:'2025-06-18'});
    if(input.payload.method==='notifications/initialized')return response({});
    if(input.payload.method==='tools/list')return response({tools:[
      {name:'get_assistant_status',description:'Status',inputSchema:{type:'object'}},
      {name:'repair_assistant_workspace_result',description:'Current dedicated native repair',
        inputSchema:{type:'object',properties:{...properties,taskPass:{},runtimeSessionProof:{}},
          required:[...required,'taskPass'],additionalProperties:false},
        annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false}},
      {name:'restore_agent_workspace_revision',description:'Human route',inputSchema:{type:'object'}},
      {name:'retract_agent_workspace_run_result',description:'Human route',inputSchema:{type:'object'}},
    ]});
    assert.equal(input.payload.method,'tools/call');calls.push(structuredClone(input.payload.params));
    if(failed)throw new Error('uncertain native result, no replay');
    return response({content:[{type:'text',text:'Inspect native receipt'}],structuredContent:{retracted:true,corrected:false}});
  }});
  const tools=await client.listTools();
  assert.deepEqual(tools.map(tool=>tool.name),['get_assistant_status','repair_assistant_workspace_result']);
  assert.deepEqual(tools[1].inputSchema,{type:'object',properties,required,additionalProperties:false});
  assert.deepEqual(tools[1].annotations,{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false});
  const admission={taskPass:{passId:randomUUID()},runtimeSessionProof:{signature:'hook-owned'}};
  const source={...admission,operation:'retract',workspaceId:randomUUID(),runId:randomUUID(),expectedHead:'a'.repeat(40),
    errorKind:'incorrect_result',agentRecognizedOwnError:true};
  const expected=structuredClone(source),pending=client.callTool('repair_assistant_workspace_result',source);
  source.expectedHead='b'.repeat(40);await pending;
  assert.deepEqual(calls.at(-1),{name:'repair_assistant_workspace_result',arguments:expected});
  const restore={...admission,operation:'restore',workspaceId:expected.workspaceId,runId:expected.runId,
    expectedHead:expected.expectedHead,targetHead:'c'.repeat(40),reason:'Established own error'};
  await client.callTool('repair_assistant_workspace_result',restore);
  assert.deepEqual(calls.at(-1),{name:'repair_assistant_workspace_result',arguments:restore});
  const verified={...expected,expectedHead:'d'.repeat(40),correctionRunId:randomUUID()};
  await client.callTool('repair_assistant_workspace_result',verified);
  assert.deepEqual(calls.at(-1),{name:'repair_assistant_workspace_result',arguments:verified});
  failed=true;const before=calls.length;
  await assert.rejects(client.callTool('repair_assistant_workspace_result',restore),/MCP_UNAVAILABLE/);
  assert.equal(calls.length,before+1,'an uncertain native restore never becomes a second attempt');
  for(const name of ['restore_agent_workspace_revision','retract_agent_workspace_run_result'])
    await assert.rejects(client.callTool(name,restore),/CAPABILITY_UNAVAILABLE/);
  assert.equal(calls.length,before+1,'human routes are refused before remote I/O');
});

test('managed schema fields are hidden in root alternatives while nested business fields and original validators remain intact',()=>{
  const business={type:'object',properties:{taskPass:{type:'string'},runtimeSessionProof:{type:'string'},sourceProcessingProof:{type:'string'}},required:['taskPass','runtimeSessionProof','sourceProcessingProof']};
  const branch={type:'object',properties:{taskPass:{type:'object'},runtimeSessionProof:{type:'object'},sourceProcessingProof:{type:'object'},encryptedMaterialWitness:{type:'object'},parameters:{oneOf:[business]}},required:['taskPass','runtimeSessionProof','sourceProcessingProof','encryptedMaterialWitness','parameters'],additionalProperties:false};
  const source={type:'object',allOf:[{anyOf:[branch,{oneOf:[branch]}]}],$defs:{business}};
  const before=structuredClone(source),result=assistantModelInputSchema(source);
  assert.deepEqual(source,before,'projection must never edit the actual wire validators');
  for(const root of [result.allOf[0].anyOf[0],result.allOf[0].anyOf[1].oneOf[0]]){
    assert.deepEqual(root.required,['parameters']);assert.deepEqual(Object.keys(root.properties),['parameters']);
    assert.deepEqual(root.properties.parameters.oneOf[0],business,'nested native JSON fields retain their domain meaning');
  }
  assert.deepEqual(result.$defs,source.$defs);assert.equal(result.allOf[0].anyOf[0].additionalProperties,false);
});
test('unprojectable root references and excessive root alternatives fail before model discovery',()=>{
  for(const source of [{type:'object',$ref:'#/$defs/root',$defs:{root:{type:'object'}}},{type:'object',anyOf:{}},{type:'object',anyOf:[null]},
    {type:'object',anyOf:Array.from({length:513},()=>({type:'object'}))}]){
    assert.throws(()=>assistantModelInputSchema(source),error=>error.code==='ASSISTANT_MCP_INVALID_RESPONSE');
  }
  let nested={type:'object'};for(let i=0;i<34;i++)nested={type:'object',allOf:[nested]};
  assert.throws(()=>assistantModelInputSchema(nested),error=>error.code==='ASSISTANT_MCP_INVALID_RESPONSE');
});

test('assistant MCP shares one absolute network deadline and never retries a timed-out call',async()=>{
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'d'.repeat(43)}`,expiresAt:1});
  let calls=0;
  const client=createAssistantMcpClient({origin,assistantId,deviceId,store,timeoutMs:100,httpRequest:async(_input,{signal})=>{
    calls++;await new Promise((resolve,reject)=>{if(signal.aborted)reject(new Error('abort'));else signal.addEventListener('abort',()=>reject(new Error('abort')),{once:true});});
  }});
  const keepAlive=setTimeout(()=>{},1000);
  try{await assert.rejects(client.callTool('get_task',{}),/MCP_UNAVAILABLE/);assert.equal(calls,1);}
  finally{clearTimeout(keepAlive);}
});


import { AsyncResource } from 'node:async_hooks';
import path from 'node:path';
import os from 'node:os';
import { request as nativeWorkspaceRequest, requireToken as nativeWorkspaceToken } from '../host-runtime/scripts/trelio-workspace.mjs';
import { ASSISTANT_MCP_READ_TOOLS, createAssistantWorkspaceProfile, assistantTaskStorageDirectory } from '../host-runtime/scripts/trelio-assistant-transport.mjs';
import { withWorkspaceExecutionProfile, currentWorkspaceExecutionProfile,
  ensureCompanyEncryptionContext } from '../host-runtime/scripts/trelio-workspace.mjs';

const workspaceProfileFixture = async ({encryptedTool=null,encryptedInspection=false,workspaceRun=false,encryptedAttachment=false,secretBrowserFill=null,secretGeneration=null,secretSkill=null,remoteMcp=null}={}) => {
  const identity={schemaVersion:1,origin:encryptedTool||encryptedInspection||workspaceRun||encryptedAttachment?'https://trelio.ru':'https://assistant.test',assistantId:randomUUID(),deviceId:randomUUID()};
  const pass={schemaVersion:1,assistantId:identity.assistantId,deviceId:identity.deviceId,companyId:randomUUID(),taskId:randomUUID(),
    passId:randomUUID(),deliveryId:randomUUID(),threadId:randomUUID(),bindingId:randomUUID(),bindingRevision:1};
  const keys=generateKeyPairSync('ed25519'), store=memoryStore(), credential='tda_'+randomBytes(32).toString('base64url');
  const runtime={schemaVersion:1,passId:pass.passId,threadId:pass.threadId,state:{runtimeSessionId:randomUUID(),
    expiresAt:new Date(Date.now()+300_000).toISOString(),privateKeyPkcs8:keys.privateKey.export({type:'pkcs8',format:'der'}).toString('base64url'),
    observation:{schemaVersion:1,clientFamily:'codex',modelId:'gpt-6.1-sol',effortLevel:'high',evidenceLevel:'local_observed',source:'codex_hook'}}};
  await store.put({origin:identity.origin,kind:'device',id:identity.assistantId},{assistantId:identity.assistantId,deviceId:identity.deviceId,credential,expiresAt:1});
  await store.put({origin:identity.origin,kind:'runtime',id:pass.passId},runtime);
  let active=pass, currentIdentity=identity, live=true, contacts=0;
  const host={readIdentity:async()=>currentIdentity,readActivePass:async()=>active};
  const client={readTaskPass:async()=>{contacts++;return {...pass,state:live?'leased':'closed',leaseExpiresAt:new Date(Date.now()+300_000).toISOString()};}};
  const locator={companySlug:'encrypted',projectSlug:`e-${randomUUID()}`,taskNumber:30};
  const descriptor=encryptedTool?{schemaVersion:1,nativeTool:encryptedTool,arguments:encryptedTool==='get_task_sections'
    ? {...locator,sections:['comments']} : {...locator,
      ...(encryptedTool==='search_agent_guidance'?{query:'SYNTHETIC_TITLE'}:{}),
      ...(encryptedTool==='get_agent_procedure'?{procedureId:randomUUID()}:{})},
    ...({get_task_create_meta:'task_create_meta',search_agent_guidance:'guidance_company',get_agent_procedure:'procedure_company'}[encryptedTool]
      ?{contextRead:{get_task_create_meta:'task_create_meta',search_agent_guidance:'guidance_company',get_agent_procedure:'procedure_company'}[encryptedTool]}:{}),
    companyId:pass.companyId,taskId:pass.taskId,passId:pass.passId,
    assistantUserId:identity.assistantId,deviceId:identity.deviceId,requestOrigin:'https://e2ee.trelio.ru'}:null;
  const inspectionDescriptor=encryptedInspection?{schemaVersion:1,companyId:pass.companyId,companySlug:'encrypted',workspaceId:randomUUID(),requestOrigin:'https://e2ee.trelio.ru'}:null;
  const runIdentity=workspaceRun?{workspaceId:randomUUID(),runId:randomUUID()}:null;
  const profile=await createAssistantWorkspaceProfile({identity,store,host,client,workspaceRun:runIdentity,encryptedTaskRead:descriptor,encryptedInspection:inspectionDescriptor,secretBrowserFill,secretGeneration,
    secretSkill:typeof secretSkill==='function'?secretSkill({pass,runtime}):secretSkill,
    remoteMcp:typeof remoteMcp==='function'?remoteMcp({pass,runtime}):remoteMcp,
    lockDirectory:path.join(os.tmpdir(),'synthetic-assistant-workspace-locks'),lock:(_file,action)=>action()});
  return {identity,pass,keys,store,credential,runtime,profile,descriptor,inspectionDescriptor,runIdentity,host,client,contacts:()=>contacts,
    changeIdentity:value=>{currentIdentity=value;},changePass:value=>{active=value;},close:()=>{live=false;}};
};

test('every supported source exact-body command requires the common native read observer',async()=>{
  const f=await workspaceProfileFixture();
  try{
    for(const skillId of ['telegram-mtproto','email-imap-smtp','max-web']){
      await assert.rejects(f.profile.prepareSkillBodyRead({artifact:{skillId},runtimeArguments:['read-reference','synthetic']}),
        {code:'ASSISTANT_SOURCE_READ_REQUIRED'});
    }
    assert.equal(await f.profile.prepareSkillBodyRead({artifact:{skillId:'max-web'},runtimeArguments:['probe']}),null,
      'ordinary separately admitted reads are not guessed exact message proofs');
  }finally{f.close();}
});

test('production content preflight refuses encrypted prose before the real MCP tools/call boundary',async()=>{
  const {withAssistantEncryptedWorkspaceArguments,withAssistantCompanyContentArguments}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const f=await workspaceProfileFixture();let mode='encrypted',inventoryReads=0,remoteCalls=0,loseResponse=false;
  const canary='SYNTHETIC_PRIVATE_COMPANY_CONTENT';
  // Advertise this fixture's actual task-view methods, not the union of all
  // mutually exclusive presentation views (which is not a native catalogue).
  const preflightNames=['get_assistant_status','get_task','create_comment','update_comment','ask_assistant_owner','request_assistant_action',
    'create_task','update_task_title','update_task_description','update_task_custom_field','create_task_control','update_task_control',
    'create_checklist','update_checklist','create_subtask','create_task_relation','cancel_agent_workspace_run','repair_assistant_workspace_result',
    'search_agent_guidance','continue_assistant_workspace_action'];
  f.client.companies=async()=>{inventoryReads++;return [{companyId:f.pass.companyId,encryptionState:mode}];};
  const wire=[],withProfile=action=>action({readCompanyContentMode:f.profile.readCompanyContentMode,preparePrivateSkillArguments:f.profile.preparePrivateSkillArguments,preparePrivateBrowserArguments:f.profile.preparePrivateBrowserArguments,preparePrivateCardArguments:f.profile.preparePrivateCardArguments});
  const client=createAssistantMcpClient({...f.identity,store:f.store,
    withWorkspaceArguments:(input,send)=>withAssistantEncryptedWorkspaceArguments(input,send,{withProfile,
      withManagedContent:(input,send)=>withAssistantCompanyContentArguments(input,send,{withProfile})}),
    httpRequest:async input=>{
      wire.push(JSON.stringify(input.payload??{}));
      const reply=result=>({sessionId:'content-preflight',message:{jsonrpc:'2.0',id:input.payload?.id,result}});
      if(input.method==='DELETE'||input.payload.method==='notifications/initialized')return reply({});
      if(input.payload.method==='initialize')return reply({protocolVersion:'2025-06-18'});
      if(input.payload.method==='tools/list')return reply({tools:preflightNames.map(name=>({name,description:'Native preflight fixture',inputSchema:{type:'object'}}))});
      assert.equal(input.payload.method,'tools/call');remoteCalls++;
      if(loseResponse)throw new Error('SYNTHETIC_LOST_MUTATION_RESULT');
      return reply({content:[{type:'text',text:'native result'}]});
    }});
  const args={clientRequestId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString(),bodyMarkdown:canary};
  for(const name of ['create_comment','update_comment','ask_assistant_owner','request_assistant_action',
    'create_task','update_task_title','update_task_description','update_task_custom_field',
    'create_task_control','update_task_control','create_checklist','update_checklist','create_subtask',
    'create_task_relation','cancel_agent_workspace_run','repair_assistant_workspace_result','search_agent_guidance']){
    await assert.rejects(client.callTool(name,name==='request_assistant_action'?{...args,operation:'update_task_control',fields:{}}:args),{code:'ASSISTANT_ENCRYPTED_CONTENT_REQUIRED'});
  }
  // URLs, Secret metadata and provider argv can also contain protected company
  // text. They must not reach native HTTP merely to receive its capability deny.
  for(const operation of ['skill_run','secret_create','secret_browser_prepare','secret_browser_fill','secret_skill_prepare','secret_skill_run'])
    await assert.rejects(client.callTool('continue_assistant_workspace_action',{schemaVersion:1,operation,parameters:{value:canary}}),
      {code:'ASSISTANT_ENCRYPTED_CONTENT_REQUIRED'});
  assert.equal(remoteCalls,0);assert.equal(wire.join('').includes(canary),false);
  const retirement={operation:'retract',workspaceId:randomUUID(),runId:randomUUID(),expectedHead:'a'.repeat(40),
    errorKind:'incorrect_result',agentRecognizedOwnError:true};
  await client.callTool('repair_assistant_workspace_result',retirement);
  assert.equal(remoteCalls,1,'structural retirement uses the same native tool once, without opening an encryption key');
  for(const changed of [{...retirement,reason:canary},{...retirement,unknown:canary},
    {...retirement,errorKind:canary},{...retirement,expectedHead:canary},
    {...retirement,operation:'restore',reason:canary}]){
    await assert.rejects(client.callTool('repair_assistant_workspace_result',changed),{code:'ASSISTANT_ENCRYPTED_CONTENT_REQUIRED'});
  }
  assert.equal(remoteCalls,1,'no company prose can ride along with the structural exception');
  assert.ok(inventoryReads>0);assert.equal(f.contacts(),2*inventoryReads,'fresh native pass checks bracket each inventory');
  for(const skillId of ['telegram-mtproto','email-imap-smtp','max-web']){
    const provider=skillId==='email-imap-smtp'?'email':skillId==='max-web'?'max':'telegram';
    const selectors=provider==='email'?['--uid','11','--uid-validity','17']
      :['--chat',provider==='max'?'https://web.max.ru/-77':'-77','--message-id','11'];
    const parameters={skillId,arguments:['read-reference',...selectors,'--expected-revision','b'.repeat(64),
      '--expected-conversation-key',`${provider}-conversation/v1.${'a'.repeat(64)}`,'--local-account',randomUUID()]};
    await client.callTool('continue_assistant_workspace_action',{schemaVersion:1,operation:'skill_run',parameters});
    const before=remoteCalls;
    for(const argumentsList of [['send','--text',canary],parameters.arguments.slice(0,-2),
      [...parameters.arguments,'--query',canary]])
      await assert.rejects(client.callTool('continue_assistant_workspace_action',{schemaVersion:1,operation:'skill_run',
        parameters:{...parameters,arguments:argumentsList}}));
    assert.equal(remoteCalls,before,'only exact structural references cross encrypted MCP, no implicit account or prose');
  }
  assert.equal(remoteCalls,4);assert.equal(wire.join('').includes(canary),false);
  mode=null;await client.callTool('create_comment',args);assert.equal(remoteCalls,5,'legacy null mode is the native plain state');
  mode='plain';loseResponse=true;
  await assert.rejects(client.callTool('create_comment',args),{code:'ASSISTANT_MCP_UNAVAILABLE'});
  assert.equal(remoteCalls,6,'a lost response does not replay the original mutation');
  loseResponse=false;mode='encrypted';const before=inventoryReads;
  await client.callTool('get_task',{});assert.equal(remoteCalls,7);assert.equal(inventoryReads,before,'structural native reads retain their existing encrypted materializer');
});

test('structural Workspace parameters use the common parser before any send or key opening',async()=>{
  const {withAssistantCompanyContentArguments}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const runIdentity={workspaceId:randomUUID(),runId:randomUUID()},canary='STRUCTURAL_PARAMETERS_PROSE_CANARY';
  let sent=0;
  const invoke=args=>withAssistantCompanyContentArguments({name:'continue_assistant_workspace_action',args},async wire=>{
    assert.equal(JSON.stringify(wire).includes(canary),false);sent++;return {structuredContent:{}};
  },{withProfile:async()=>assert.fail('a structural call must not acquire an encryption key')});
  for(const operation of ['inspect','open','status','heartbeat']){
    const args={schemaVersion:1,operation,parameters:operation==='inspect'?{workspaceId:runIdentity.workspaceId}
      :operation==='open'?runIdentity:{},...(['status','heartbeat'].includes(operation)?{runIdentity}:{})};
    await assert.rejects(invoke({...args,parameters:{...args.parameters,extra:canary}}),{code:'ASSISTANT_WORKSPACE_PLAN_INVALID'});
    await assert.rejects(invoke({...args,extra:canary}),{code:'ASSISTANT_WORKSPACE_PLAN_INVALID'});
    if(operation==='open')await assert.rejects(invoke({...args,parameters:{...args.parameters,directory:`/${canary}`}}),
      {code:'ASSISTANT_WORKSPACE_PLAN_INVALID'});
    assert.equal(sent,['inspect','open','status','heartbeat'].indexOf(operation));
    await invoke(args);
  }
  assert.equal(sent,4);
});

test('encrypted private preparation sends only signed command coordinates with an owned fingerprint; arbitrary vectors never reach HTTP',async()=>{
  const {withAssistantCompanyContentArguments}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const f=await workspaceProfileFixture();f.client.companies=async()=>[{companyId:f.pass.companyId,encryptionState:'encrypted'}];
  const fingerprint='a'.repeat(43),canary='PRIVATE_AUTH_COMPANY_QUERY_CANARY';
  await f.store.put({origin:f.identity.origin,kind:'company_encryption',id:f.pass.companyId,deviceId:f.identity.deviceId},
    {assistantId:f.identity.assistantId,deviceId:f.identity.deviceId,companyId:f.pass.companyId,record:{fingerprint}});
  const parameters={secretId:randomUUID(),runId:randomUUID(),fieldKey:'value',environmentVariable:'TRELIO_AUTH_TOKEN',
    skill:{companyId:f.pass.companyId,skillId:'auth-fixture',releaseId:randomUUID(),runtimeSessionId:f.runtime.state.runtimeSessionId,commandId:'authenticate'}};
  let calls=0;const wire=[],invoke=p=>withAssistantCompanyContentArguments({name:'continue_assistant_workspace_action',
    args:{schemaVersion:1,operation:'secret_skill_prepare',parameters:p}},async args=>{calls++;wire.push(JSON.stringify(args));return args;},
    {withProfile:action=>action({readCompanyContentMode:f.profile.readCompanyContentMode,preparePrivateSkillArguments:f.profile.preparePrivateSkillArguments})});
  const result=await invoke(parameters);assert.equal(result.parameters.encryptionFingerprint,fingerprint);assert.equal(calls,1);
  for(const changed of [{...parameters,reason:canary},{...parameters,encryptionFingerprint:canary},
    {...parameters,skill:{...parameters.skill,arguments:['authenticate','--query',canary]}},
    {...parameters,skill:{...parameters.skill,commandId:canary}}, {...parameters,skill:{...parameters.skill,companyId:randomUUID()}}])
    await assert.rejects(invoke(changed),/ENCRYPTED_CONTENT_REQUIRED/);
  assert.equal(calls,1);assert.equal(wire.join('').includes(canary),false);
  f.close();await assert.rejects(invoke(parameters),/PASS_REVIEW_REQUIRED/);assert.equal(calls,1);
});

test('private neutral creation and pagination reject complete ignored text envelopes BEFORE HTTP',async()=>{
  const {withAssistantCompanyContentArguments}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const {resolveAssistantCompanyEncryptionDevice}=await import('../host-runtime/scripts/trelio-assistant-private.mjs');
  const f=await workspaceProfileFixture();f.client.companies=async()=>[{companyId:f.pass.companyId,encryptionState:'encrypted'}];
  const managed=await resolveAssistantCompanyEncryptionDevice({identity:f.identity,companyId:f.pass.companyId,store:f.store,
    lockDirectory:path.join(os.tmpdir(),'synthetic-private-neutral-key'),assertCurrent:async()=>{},lock:(_file,action)=>action()});
  let calls=0;const canary='PRIVATE_NEUTRAL_IGNORED_CANARY',wire=[];
  const invoke=args=>withAssistantCompanyContentArguments({name:'continue_assistant_workspace_action',args},async args=>{calls++;wire.push(JSON.stringify(args));return args;},
    {withProfile:action=>action({readCompanyContentMode:f.profile.readCompanyContentMode,preparePrivateCardArguments:f.profile.preparePrivateCardArguments})});
  const base={clientRequestId:randomUUID(),ownerDecisionId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString()};
  const create={schemaVersion:1,operation:'secret_create',parameters:{...base,metadata:{metadataMode:'neutral',cardType:'login'}}};
  const runIdentity={workspaceId:randomUUID(),runId:randomUUID()},neutralPlan={cardType:'password',generatedFields:[{key:'password',generator:'password',length:32}]};
  const generate={schemaVersion:1,operation:'secret_generate',runIdentity,parameters:{...base,runId:runIdentity.runId,neutralPlan}};
  const list={schemaVersion:1,operation:'secret_list',parameters:{offset:0,limit:50}};
  for(const args of [{...list,note:canary},{...list,parameters:{query:canary}}, {...list,parameters:{limit:canary}},
    {...list,taskPass:{companyId:f.pass.companyId,taskId:f.pass.taskId,passId:f.pass.passId,note:canary}},
    {...list,runtimeSessionProof:{signature:canary}},
    {...list,runtimeSessionProof:{schemaVersion:1,runtimeSessionId:randomUUID(),nonce:randomUUID(),issuedAt:`January 1 2026 (${canary})`,signature:'a'.repeat(86)}},
    {...create,parameters:{...create.parameters,expectedTaskUpdatedAt:`January 1 2026 (${canary})`}}, {...create,reason:canary},
    {...create,parameters:{...create.parameters,metadata:{...create.parameters.metadata,name:canary}}},
    {...generate,parameters:{...generate.parameters,neutralPlan:{...neutralPlan,note:canary}}},
    {...generate,runIdentity:{...runIdentity,note:canary}}, {...generate,parameters:{...generate.parameters,reason:canary}}])
    await assert.rejects(invoke(args),/ENCRYPTED_CONTENT_REQUIRED/);
  assert.equal(calls,0,'closed pagination/card/context DTO precedes every HTTP send');
  assert.deepEqual(await invoke(list),list);
  assert.equal((await invoke(create)).parameters.encryptionFingerprint,managed.fingerprint);
  assert.equal((await invoke(generate)).parameters.encryptionFingerprint,managed.fingerprint);
  assert.equal(calls,3);assert.doesNotMatch(wire.join(''),new RegExp(canary));
});

test('encrypted private browser signs normalized native targets and keeps full URL only in local fill plans',async()=>{
  const {withAssistantCompanyContentArguments}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const {resolveAssistantCompanyEncryptionDevice}=await import('../host-runtime/scripts/trelio-assistant-private.mjs');
  const crypto=await import('../host-runtime/scripts/trelio-company-encryption.mjs');
  const f=await workspaceProfileFixture();f.client.companies=async()=>[{companyId:f.pass.companyId,encryptionState:'encrypted'}];
  const managed=await resolveAssistantCompanyEncryptionDevice({identity:f.identity,companyId:f.pass.companyId,store:f.store,
    lockDirectory:path.join(os.tmpdir(),'synthetic-browser-key'),assertCurrent:async()=>{},lock:(_f,fn)=>fn()});
  const canary='PRIVATE_BROWSER_PATH_QUERY_CANARY',targetUrl=`https://example.invalid/account/${canary}?flow=${canary}`;
  const target={targetOrigin:'https://example.invalid',targetUrlSha256:createHash('sha256').update(targetUrl).digest('hex')};
  const runIdentity={workspaceId:randomUUID(),runId:randomUUID()},secretId=randomUUID(),grantId=randomUUID();let calls=0,tamper=false;
  const args={schemaVersion:1,operation:'secret_browser_prepare',parameters:{secretId,runId:runIdentity.runId,
    steps:[{targetUrl,frames:[{targetUrl:targetUrl+'#/frame'}],fields:[{fieldKey:'password',accessibleName:'Clave de acceso'}],submitSelector:'#submit'}]}};
  const withProfile=action=>action({readCompanyContentMode:f.profile.readCompanyContentMode,
    preparePrivateBrowserArguments:f.profile.preparePrivateBrowserArguments,preparePrivateSkillArguments:f.profile.preparePrivateSkillArguments});
  const invoke=input=>withAssistantCompanyContentArguments({name:'continue_assistant_workspace_action',args:input},async wire=>{
    calls++;assert.doesNotMatch(JSON.stringify(wire),new RegExp(canary));
    if(wire.operation==='secret_browser_prepare'){
      assert.equal(wire.parameters.steps[0].frames[0].targetUrlSha256,createHash('sha256').update(targetUrl+'#/frame').digest('hex'));
      assert.equal(wire.parameters.steps[0].fields[0].accessibleName,'Clave de acceso');
    }
    const {encryptedPlan,...parameters}=wire.parameters,record={schemaVersion:1,operation:wire.operation,
      ...(wire.runIdentity?{runIdentity:wire.runIdentity}:{}),parameters};
    assert.equal(encryptedPlan.fingerprint,managed.fingerprint);
    assert.equal(await crypto.verifyCompanyEncryptionRecord(managed.publicSigningJwk,{protocol:'assistant-managed-content/v1',phase:'publication',
      companyId:f.pass.companyId,target:{kind:'task',pass:{companyId:f.pass.companyId,taskId:f.pass.taskId,passId:f.pass.passId}},
      nativeTool:'continue_assistant_workspace_action',arguments:record},encryptedPlan.signature),true);
    const action={schemaVersion:1,operation:'secret_browser_fill',runIdentity,parameters:{grantId,...target,...(tamper?{targetUrlSha256:'a'.repeat(64)}:{})}};
    const value=wire.operation==='secret_browser_prepare'?{prepared:true,grant:{id:grantId,secretId,workspaceId:runIdentity.workspaceId},
      bridge:{action:{arguments:action}}}:{prepared:true,localAction:action};
    return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
  },{withProfile});
  const prepared=await invoke(args);assert.deepEqual(prepared.structuredContent.bridge.action.arguments.parameters,{grantId,targetUrl});
  const fill={schemaVersion:1,operation:'secret_browser_fill',runIdentity,parameters:{grantId,targetUrl}};
  assert.deepEqual((await invoke(fill)).structuredContent.localAction.parameters,{grantId,targetUrl});assert.equal(calls,2);
  for(const invalid of [{...args,reason:canary},{...args,parameters:{...args.parameters,extra:canary}},
    {...args,parameters:{...args.parameters,steps:[{...args.parameters.steps[0],value:canary}]}},
    {...args,parameters:{...args.parameters,steps:[{...args.parameters.steps[0],frames:[{targetUrl:'https://other.invalid/form'}]}]}},
    {...fill,runIdentity:{...runIdentity,extra:canary}}])await assert.rejects(invoke(invalid));
  assert.equal(calls,2,'unknown protected fields never reach native HTTP');
  tamper=true;await assert.rejects(invoke(args),/PLAN_INVALID/);assert.equal(calls,3,'native target mismatch is not replayed');
  const auth={schemaVersion:1,operation:'secret_skill_prepare',reason:canary,parameters:{secretId,runId:runIdentity.runId,
    fieldKey:'password',environmentVariable:'TRELIO_AUTH',skill:{companyId:f.pass.companyId,skillId:'synthetic',releaseId:randomUUID(),
      runtimeSessionId:f.runtime.state.runtimeSessionId,commandId:'authenticate'}}};
  await assert.rejects(invoke(auth),/ENCRYPTED_CONTENT_REQUIRED/);assert.equal(calls,3);
});

test('content mode never falls back to plain on missing inventory, transition, stale pass or changed identity',async()=>{
  const {withAssistantCompanyContentArguments}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const f=await workspaceProfileFixture();let rows=[],sent=0,afterInventory=()=>{};
  f.client.companies=async()=>{afterInventory();return rows;};
  const invoke=()=>withAssistantCompanyContentArguments({name:'create_comment',args:{bodyText:'SYNTHETIC_PRIVATE'}},
    async()=>{sent++;},{withProfile:action=>action({readCompanyContentMode:f.profile.readCompanyContentMode})});
  for(rows of [[],[{companyId:randomUUID(),encryptionState:'plain'}],
    [{companyId:f.pass.companyId,encryptionState:'encrypting'}],[{companyId:f.pass.companyId}],
    [{companyId:f.pass.companyId,encryptionState:'plain'},{companyId:f.pass.companyId,encryptionState:'plain'}]])
    await assert.rejects(invoke(),{code:'ASSISTANT_WORKSPACE_BINDING_CHANGED'});
  f.client.companies=async()=>{throw Object.assign(new Error('synthetic unavailable'),{code:'ASSISTANT_TRANSPORT_UNAVAILABLE'});};
  await assert.rejects(invoke(),{code:'ASSISTANT_TRANSPORT_UNAVAILABLE'});
  f.client.companies=async()=>{f.changeIdentity({...f.identity,deviceId:randomUUID()});return [{companyId:f.pass.companyId,encryptionState:'plain'}];};
  await assert.rejects(invoke(),{code:'ASSISTANT_WORKSPACE_BINDING_CHANGED'});
  f.changeIdentity(f.identity);f.client.companies=async()=>{f.close();return [{companyId:f.pass.companyId,encryptionState:'plain'}];};
  await assert.rejects(invoke(),{code:'ASSISTANT_PASS_REVIEW_REQUIRED'});
  assert.equal(sent,0,'no failed or late authority check exposes prose to send');
});

test('content mode composes the real device client identity with the versioned host journal and retains late fences',async()=>{
  const {readAssistantCompanyContentMode}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const stored={schemaVersion:1,origin:'https://assistant.test',assistantId:randomUUID(),deviceId:randomUUID()};
  const store=memoryStore(),credential=`tda_${'i'.repeat(43)}`,companyId=randomUUID();
  await store.put({origin:stored.origin,kind:'device',id:stored.assistantId},{assistantId:stored.assistantId,deviceId:stored.deviceId,credential,expiresAt:1});
  const pass={schemaVersion:1,assistantId:stored.assistantId,deviceId:stored.deviceId,companyId,taskId:randomUUID(),
    passId:randomUUID(),deliveryId:randomUUID(),threadId:randomUUID(),bindingId:randomUUID(),bindingRevision:2};
  let current=stored,active=pass,mode='plain',state='leased',afterInventory=()=>{},reads=0,inventories=0;
  const host={readIdentity:async()=>current,readActivePass:async()=>active};
  const client=createAssistantDeviceClient({...stored,store,http:async(operation,input,token)=>{
    assert.equal(token,credential);
    if(operation==='companies'){
      inventories++;afterInventory();
      return {assistantUserId:stored.assistantId,bindingId:stored.deviceId,
        companies:[{id:companyId,memberId:randomUUID(),slug:'synthetic',encryptionState:mode}]};
    }
    assert.equal(operation,'passRead');reads++;
    assert.deepEqual(input,{companyId,taskId:pass.taskId,passId:pass.passId});
    return {...pass,state,leaseRevision:1,leaseExpiresAt:new Date(Date.now()+600000).toISOString(),
      execution:{modelId:'gpt-6.1-sol',effortLevel:'xhigh',revision:1}};
  }});
  assert.deepEqual(Object.keys(client.identity),['origin','assistantId','deviceId']);
  for(mode of ['plain','encrypted',null])
    assert.equal((await readAssistantCompanyContentMode({identity:client.identity,host,client})).encryptionState,mode??'plain');
  assert.equal(reads,6);assert.equal(inventories,3,'each real inventory is bracketed by independent native pass reads');
  for(const change of [{origin:'https://foreign.test'},{assistantId:randomUUID()},{deviceId:randomUUID()},{schemaVersion:2}]){
    current={...stored,...change};
    await assert.rejects(readAssistantCompanyContentMode({identity:client.identity,host,client}),{code:'ASSISTANT_WORKSPACE_BINDING_CHANGED'});
  }
  current=stored;mode='encrypted';
  afterInventory=()=>{current={...stored,deviceId:randomUUID()};};
  await assert.rejects(readAssistantCompanyContentMode({identity:client.identity,host,client}),{code:'ASSISTANT_WORKSPACE_BINDING_CHANGED'});
  current=stored;afterInventory=()=>{active={...pass,bindingRevision:3};};
  await assert.rejects(readAssistantCompanyContentMode({identity:client.identity,host,client}),{code:'ASSISTANT_WORKSPACE_BINDING_CHANGED'});
  active=pass;afterInventory=()=>{state='closed';};
  await assert.rejects(readAssistantCompanyContentMode({identity:client.identity,host,client}),{code:'ASSISTANT_PASS_REVIEW_REQUIRED'});
});

test('the SAME content mode preflight uses an intake lease without inventing a task pass',async()=>{
  const {readAssistantCompanyContentMode}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const identity={schemaVersion:1,origin:'https://assistant.test',assistantId:randomUUID(),deviceId:randomUUID()};
  const pass={schemaVersion:1,kind:'source_intake',assistantId:identity.assistantId,deviceId:identity.deviceId,
    companyId:randomUUID(),sourceId:randomUUID(),sourceRevision:3,passId:randomUUID(),deliveryId:randomUUID(),eventId:randomUUID(),threadId:randomUUID()};
  const deviceIdentity=createAssistantDeviceClient({...identity,store:memoryStore(),http:async()=>assert.fail('taskless native methods are selected below')}).identity;
  const host={readIdentity:async()=>identity,readActivePass:async()=>pass};
  let reads=0,closed=false;
  const client={readTaskPass:async()=>assert.fail('taskless intake never borrows a task'),
    readSourceIntake:async locator=>{
      reads++;assert.deepEqual(locator,{companyId:pass.companyId,sourceId:pass.sourceId,intakeId:pass.passId});
      return {state:closed?'closed':'leased',threadId:pass.threadId,eventId:pass.eventId,sourceRevision:pass.sourceRevision,
        leaseExpiresAt:new Date(Date.now()+600000).toISOString()};
    },companies:async()=>[{companyId:pass.companyId,encryptionState:'encrypted'}]};
  assert.equal((await readAssistantCompanyContentMode({identity:deviceIdentity,host,client})).encryptionState,'encrypted');
  assert.equal(reads,2);
  client.companies=async()=>{closed=true;return [{companyId:pass.companyId,encryptionState:'plain'}];};
  await assert.rejects(readAssistantCompanyContentMode({identity:deviceIdentity,host,client}),{code:'ASSISTANT_PASS_REVIEW_REQUIRED'});
  assert.equal(reads,4,'a late source stop cannot release prose through a cached plain mode');
});

test('native encrypted refusal is consumed once by the trusted materializer under the original MCP deadline',async()=>{
  const f=await workspaceProfileFixture({encryptedTool:'get_task'});let writes=0,hydrations=0,mode='valid';
  const descriptor=f.descriptor;
  const base={...f.identity,store:f.store,httpRequest:async input=>{
    const response=result=>({sessionId:'encrypted-read',message:{jsonrpc:'2.0',id:input.payload?.id,result}});
    if(input.method==='DELETE'||input.payload.method==='notifications/initialized')return response({});
    if(input.payload.method==='initialize')return response({protocolVersion:'2025-06-18'});
    if(input.payload.method==='tools/list')return response({tools:[{name:'get_task',description:'Native exact read',inputSchema:{type:'object'}}]});
    assert.equal(input.payload.method,'tools/call');writes++;
    return response({isError:true,content:[{type:'text',text:'ASSISTANT_ENCRYPTED_TASK_READ_REQUIRED'}],
      structuredContent:{code:'ASSISTANT_ENCRYPTED_TASK_READ_REQUIRED',localRead:mode==='foreign'
        ? {...descriptor,deviceId:randomUUID()}:mode==='origin'?{...descriptor,requestOrigin:'https://foreign.test'}:descriptor}});
  }};
  await assert.rejects(createAssistantMcpClient(base).callTool('get_task',{}),{code:'ASSISTANT_CAPABILITY_UNAVAILABLE'});
  const client=createAssistantMcpClient({...base,materializeEncryptedTask:async({descriptor:received,signal})=>{
    hydrations++;assert.deepEqual(received,descriptor);assert.ok(signal);signal.throwIfAborted();
    return {structuredContent:{schemaVersion:3},content:[{type:'text',text:'hydrated'}]};
  }});
  assert.equal((await client.callTool('get_task',{})).content[0].text,'hydrated');
  for(const failure of ['foreign','origin']){mode=failure;await assert.rejects(client.callTool('get_task',{}));}
  assert.equal(writes,4,'one call per explicit request, no automatic MCP replay');assert.equal(hydrations,1);
});

test('managed encryption identity is scoped to the live pass and cannot select another company or human device', async()=>{
  const f=await workspaceProfileFixture();
  const select=scope=>f.profile.resolveCompanyEncryptionDevice(scope);
  await assert.rejects(select({origin:'https://other.test',companyId:f.pass.companyId}),/BINDING_CHANGED/);
  await assert.rejects(select({origin:f.identity.origin,companyId:randomUUID()}),/BINDING_CHANGED/);
  assert.equal(f.contacts(),0,'foreign selection fails before a native request or key access');
  const device=await select({origin:f.identity.origin,companyId:f.pass.companyId});
  assert.ok(device.privateKeys.signingPrivateKey);
  const again=await select({origin:f.identity.origin,companyId:f.pass.companyId});
  assert.equal(again.fingerprint,device.fingerprint);
  f.close();
  await assert.rejects(select({origin:f.identity.origin,companyId:f.pass.companyId}),/PASS_REVIEW_REQUIRED/);
});

test('encrypted guidance keeps original query only in memory across the real MCP proxy and restores it for local ranking',async()=>{
  const {withAssistantCompanyContentArguments}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const f=await workspaceProfileFixture({encryptedTool:'search_agent_guidance'});
  const original={query:'GUIDANCE_QUERY_PRIVATE_CANARY',hints:['GUIDANCE_HINT_PRIVATE_CANARY']};
  let materializations=0,calls=0;const wire=[];
  const client=createAssistantMcpClient({...f.identity,store:f.store,
    withWorkspaceArguments:(input,send)=>withAssistantCompanyContentArguments(input,send,{withProfile:action=>action({readCompanyContentMode:async()=>'encrypted'})}),
    materializeEncryptedTask:async({descriptor})=>{
      materializations++;assert.deepEqual({query:descriptor.arguments.query,hints:descriptor.arguments.hints},original);
      assert.equal(descriptor.contextRead,'guidance_company');return {content:[],structuredContent:{guidance:[]}};
    },httpRequest:async input=>{
      wire.push(JSON.stringify(input.payload??{}));
      const reply=result=>({sessionId:'local-guidance',message:{jsonrpc:'2.0',id:input.payload?.id,result}});
      if(input.method==='DELETE'||input.payload.method==='notifications/initialized')return reply({});
      if(input.payload.method==='initialize')return reply({protocolVersion:'2025-06-18'});
      if(input.payload.method==='tools/list')return reply({tools:[{name:'search_agent_guidance',description:'Synthetic native catalogue',inputSchema:{type:'object'}}]});
      calls++;assert.equal(input.payload.params.arguments.query,'[local guidance]');assert.equal(input.payload.params.arguments.hints,undefined);
      const descriptor=structuredClone(f.descriptor);delete descriptor.arguments.query;
      return reply({isError:true,content:[{type:'text',text:'ASSISTANT_ENCRYPTED_TASK_READ_REQUIRED'}],structuredContent:{
        code:'ASSISTANT_ENCRYPTED_TASK_READ_REQUIRED',localRead:descriptor}});
    }});
  try{await client.callTool('search_agent_guidance',original);assert.equal(calls,1);assert.equal(materializations,1);
    assert.doesNotMatch(wire.join(''),/GUIDANCE_QUERY_PRIVATE_CANARY|GUIDANCE_HINT_PRIVATE_CANARY/);
  }finally{f.close();}
});

test('company read negotiation hides only the closed host branch and keeps original query off MCP HTTP',async()=>{
  const {withAssistantCompanyContentArguments}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const f=await workspaceProfileFixture({encryptedTool:'get_task'});
  const canonical={type:'object',properties:{queries:{type:'array',items:{type:'string'}},companySlugs:{type:'array',items:{type:'string'}},
    taskPass:{},runtimeSessionProof:{}},required:['queries'],additionalProperties:false};
  const local={type:'object',properties:{localContextRead:{type:'boolean',const:true},taskPass:{},runtimeSessionProof:{}},
    required:['localContextRead','taskPass','runtimeSessionProof'],additionalProperties:false};
  const schema={type:'object',anyOf:[canonical,local],additionalProperties:true};
  const projected=assistantModelInputSchema(schema);
  assert.equal(projected.anyOf.length,1);
  assert.deepEqual(Object.keys(projected.anyOf[0].properties),['queries','companySlugs']);
  assert.deepEqual(projected.anyOf[0].required,['queries']);
  assert.equal(schema.anyOf.length,2,'projection never mutates the wire validators');
  assert.throws(()=>assistantModelInputSchema({...schema,anyOf:[canonical,{...local,properties:{...local.properties,arbitrary:{}}}]}),
    {code:'ASSISTANT_MCP_INVALID_RESPONSE'});
  const privateQuery='COMPANY_SOURCE_PRIVATE_QUERY_CANARY',args={queries:[privateQuery],companySlugs:['encrypted'],
    taskPass:{companyId:f.pass.companyId,taskId:f.pass.taskId,passId:f.pass.passId},runtimeSessionProof:{synthetic:true}};
  let calls=0,materialized=0,mode='encrypted';const wire=[];
  const descriptor={schemaVersion:1,nativeTool:'search',companyId:f.pass.companyId,companySlug:'encrypted',taskId:f.pass.taskId,
    passId:f.pass.passId,assistantUserId:f.identity.assistantId,deviceId:f.identity.deviceId,requestOrigin:'https://e2ee.trelio.ru'};
  const client=createAssistantMcpClient({...f.identity,store:f.store,presentationProfile:'company_context',
    withWorkspaceArguments:(input,send)=>withAssistantCompanyContentArguments(input,send,{companyContextRead:true,
      withProfile:action=>action({readCompanyContentMode:async()=>mode})}),
    materializeEncryptedCompanyContext:async input=>{materialized++;assert.deepEqual(input.arguments,args);
      assert.deepEqual(input.descriptor,descriptor);return {content:[],structuredContent:{results:[{title:privateQuery}]}};},
    httpRequest:async input=>{
      wire.push(JSON.stringify(input.payload??{}));
      const reply=result=>({sessionId:'company-read',message:{jsonrpc:'2.0',id:input.payload?.id,result}});
      if(input.method==='DELETE'||input.payload.method==='notifications/initialized')return reply({});
      if(input.payload.method==='initialize')return reply({protocolVersion:'2025-06-18'});
      if(input.payload.method==='tools/list')return reply({tools:[{name:'search',description:'Native canonical search',inputSchema:schema}]});
      calls++;assert.deepEqual(input.payload.params.arguments,{localContextRead:true,taskPass:args.taskPass,runtimeSessionProof:args.runtimeSessionProof});
      return reply({isError:true,content:[{type:'text',text:'ASSISTANT_ENCRYPTED_COMPANY_READ_REQUIRED'}],structuredContent:{
        code:'ASSISTANT_ENCRYPTED_COMPANY_READ_REQUIRED',localRead:descriptor}});
    }});
  try{
    const result=await client.callTool('search',args);assert.match(JSON.stringify(result),new RegExp(privateQuery));
    assert.equal(calls,1);assert.equal(materialized,1);assert.doesNotMatch(wire.join(''),new RegExp(privateQuery));
    await assert.rejects(client.callTool('search',{...args,localContextRead:true}),{code:'ASSISTANT_MCP_INPUT_INVALID'});
    mode='encrypting';await assert.rejects(client.callTool('search',args),{code:'ASSISTANT_ENCRYPTED_CONTENT_REQUIRED'});
    assert.equal(calls,1,'a mode transition never retries with the held plaintext query');
  }finally{f.close();}
});

test('encrypted company source search uses the SAME HPKE mirror with isolated device namespace and fresh recipient',async()=>{
  if(process.env.TRELIO_ASSISTANT_COMPANY_CONTEXT_FIXTURE!=='1'){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-company-read-'));
    const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{fileURLToPath}=await import('node:url');
    const env={...process.env,HOME:root,USERPROFILE:root,LOCALAPPDATA:path.join(root,'AppData','Local'),
      TRELIO_WORKSPACE_DISABLE_KEYCHAIN:'1',TRELIO_ASSISTANT_COMPANY_CONTEXT_FIXTURE:'1'};
    delete env.NODE_TEST_CONTEXT;
    try{
      const child=await promisify(execFile)(process.execPath,['--test','--test-name-pattern','encrypted company source search',fileURLToPath(import.meta.url)],
        {env,timeout:30000,maxBuffer:1024*1024});
      assert.match(child.stdout,/ASSISTANT_COMPANY_CONTEXT_SEARCH_VERIFIED/u);
    }catch(error){
      const lines=String(error.stdout??'').split('\n').filter(line=>/^\s*(?:error: [^|]|code: |at |stack:|TestContext\.|async )/u.test(line));
      throw new Error(lines.slice(0,15).join('\n')||'Managed company source child failed');
    }finally{await fs.rm(root,{recursive:true,force:true});}
    return;
  }
  const common=await import('../host-runtime/scripts/trelio-workspace.mjs');
  const {materializeAssistantEncryptedCompanyContext}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const f=await workspaceProfileFixture({encryptedTool:'get_task'});
  const managed=await f.profile.resolveCompanyEncryptionDevice({origin:f.identity.origin,companyId:f.pass.companyId});
  const descriptor={schemaVersion:1,nativeTool:'search',companyId:f.pass.companyId,companySlug:'encrypted',taskId:f.pass.taskId,
    passId:f.pass.passId,assistantUserId:f.identity.assistantId,deviceId:f.identity.deviceId,requestOrigin:'https://e2ee.trelio.ru'};
  const profile=await createAssistantWorkspaceProfile({identity:f.identity,store:f.store,host:f.host,client:f.client,
    encryptedCompanyContext:descriptor,lockDirectory:path.join(os.tmpdir(),'synthetic-company-locks'),lock:(_path,action)=>action()});
  const scopeId=randomUUID(),cryptoDeviceId=randomUUID(),entityId=randomUUID(),projectId=randomUUID();
  const pair=await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const publicJwk=await webcrypto.subtle.exportKey('jwk',pair.publicKey),privateJwk=await webcrypto.subtle.exportKey('jwk',pair.privateKey);
  const aad={suite:'trelio-e2ee-v1',companyId:f.pass.companyId,scopeId,scopeEpoch:1,recipientType:'agent_device',recipientId:cryptoDeviceId};
  const sealed=await hpkeSeal({recipientPublicEncryptionJwk:managed.publicEncryptionJwk,
    plaintext:Buffer.from(JSON.stringify({suite:'trelio-e2ee-v1',version:1,scopePrivateEncryptionJwk:privateJwk})),aad});
  const envelope={id:randomUUID(),...aad,hpkeEnc:sealed.enc,ciphertext:sealed.ciphertext,aad};
  const header={companyId:f.pass.companyId,scopeId,scopeEpoch:1,entityType:'project',entityId,entityRevision:1,schemaVersion:1,purpose:'content'};
  const canary='Synthetic Company Read Source Canary';
  const payload={...header,...await encryptCompanyPayload({scopePublicEncryptionJwk:publicJwk,aad:header,
    payload:{values:{title:canary,rules:'Synthetic source rules'}}})};
  const marker=field=>buildCompanyEncryptedTextMarker(entityId,field);
  const company={id:f.pass.companyId,slug:'encrypted',name:'Synthetic'},projectSlug=`e-${projectId}`;
  const manifest={schemaVersion:2,provider:'local_company_context',generation:'d'.repeat(64),company,viewer:{memberId:randomUUID(),companyRole:'user'},viewerGroupIds:[],
    projects:[{id:projectId,slug:projectSlug,name:marker('title'),isArchived:false},
      {id:randomUUID(),slug:`e-${randomUUID()}`,name:marker('title'),isArchived:false}],tasks:[],acceptedWorkspaces:[],workspaces:[],contextDocuments:[],
    searchDocuments:[{id:`project:encrypted/${projectSlug}`,type:'project',title:marker('title'),stableKey:`encrypted/${projectSlug}/project`,
      referenceValues:[projectId,projectSlug],fields:[{source:'project',text:marker('title')}],metadata:{projectId,projectSlug},revisionToken:'f'.repeat(64)}],
    instructions:{company:{compiledMarkdown:marker('rules')},projects:[],userProfile:null},agentSkills:{company:[],projects:[]},agentProcedures:[]};
  const rulesMarkdown='Synthetic current platform rules\n',rulesSha=createHash('sha256').update(rulesMarkdown).digest('hex'),rulesId=randomUUID();
  const sourceTaskId=randomUUID(),workspaceId=randomUUID(),workspaceHead='a'.repeat(40),projectionId=randomUUID(),manifestFileId=randomUUID(),fileId=randomUUID();
  const originalName='SOURCE_PRIVATE_FILENAME_CANARY.pdf',filePath=`originals/${originalName}`,original=Buffer.from('ORIGINAL_PRIVATE_BYTES_CANARY\0');
  const cryptoRoot=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-source-containers-'));
  const container=async(id,type,value)=>{
    const sourcePath=path.join(cryptoRoot,`${id}.source`),destinationPath=path.join(cryptoRoot,`${id}.cipher`);
    await fs.writeFile(sourcePath,value,{mode:0o600});
    await encryptFileToCompanyContainer({sourcePath,destinationPath,scopePublicEncryptionJwk:publicJwk,
      aad:{companyId:f.pass.companyId,scopeId,scopeEpoch:1,entityType:type,entityId:id,entityRevision:1,schemaVersion:1},
      originalName:type.endsWith('_file')?originalName:'manifest',mimeType:type.endsWith('_file')?'application/pdf':'application/json',
      writerDeviceId:cryptoDeviceId,signingPrivateKey:managed.privateKeys.signingPrivateKey});
    return fs.readFile(destinationPath);
  };
  const manifestCipher=await container(manifestFileId,'agent_workspace_browser_manifest',JSON.stringify({schemaVersion:1,
    kind:'agent-workspace-browser-manifest',projectionId,workspaceId,workspaceHead,
    files:[{id:fileId,path:filePath,contentType:'application/pdf',sizeBytes:original.length}]}));
  const fileCipher=await container(fileId,'agent_workspace_browser_file',original);
  const exact={schemaVersion:1,company,viewer:{memberId:randomUUID(),companyRole:'user'},viewerGroupIds:[],projects:manifest.projects.slice(0,1),
    tasks:[{id:sourceTaskId,projectId,projectSlug,number:1,revisionToken:'a'.repeat(64),payload:{company,project:manifest.projects[0],
      task:{id:sourceTaskId,title:marker('title'),status:{code:'active',name:'Active'},participants:[],controls:[]}}}],
    instructions:manifest.instructions,workspaces:[],workspaceEntries:[],contextDocuments:[]};
  const previous=globalThis.fetch,requests=[];let mode='valid',manifestReads=0,fileReads=0,activityReads=0;
  globalThis.fetch=async(url,options)=>{
    url=new URL(url);requests.push({path:url.pathname,body:options.body??''});
    assert.equal(options.headers.get('authorization'),`Bearer ${f.credential}`);assert.equal(options.headers.get('cookie'),null);
    const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
    if(url.pathname.endsWith('/bridge-compatibility'))return json({supported:true,minimumVersion:'0.0.0',encryptedDataPlane:{enabled:true,routingVersion:1},
      agentRules:{status:options.headers.get('x-trelio-agent-rules-sha256')===rulesSha?'current':'update_required',revisionId:rulesId,version:1,sha256:rulesSha,rulesMarkdown}});
    if(url.pathname.endsWith('/bridge-routing'))return json({schemaVersion:1,company,encryptionState:'encrypted',encryptedDataPlaneOrigin:descriptor.requestOrigin});
    if(url.pathname==='/api/digital-assistants/runtime/encryption/runtime'){
      const found=url.searchParams.has('fingerprint'),selected={...envelope,...(mode==='recipient'?{id:randomUUID()}: {})};
      return json({state:'encrypted',suite:'trelio-e2ee-v1',company,viewer:{userId:f.identity.assistantId},accessState:found?'ready':'device_required',
        device:found?{id:cryptoDeviceId,fingerprint:managed.fingerprint}:null,scope:found?{id:scopeId,epoch:1,publicEncryptionJwk:publicJwk}:null,envelope:found?selected:null});
    }
    assert.equal(url.origin,descriptor.requestOrigin);
    assert.equal(options.headers.get('x-trelio-assistant-encryption-device'),cryptoDeviceId);
    const binary=/\/files\/([^/]+)\/encrypted-content$/u.exec(url.pathname);
    if(binary){
      fileReads++;assert.ok([manifestFileId,fileId].includes(binary[1]),'only the chosen manifest/file may be fetched');
      const bytes=binary[1]===manifestFileId?manifestCipher:fileCipher;
      return new Response(bytes,{headers:{'content-type':'application/octet-stream','content-length':String(bytes.length),
        'x-trelio-workspace-id':workspaceId,'x-trelio-workspace-head':workspaceHead,
        'x-trelio-ciphertext-sha256':createHash('sha256').update(bytes).digest('hex')}});
    }
    if(url.pathname.endsWith(`/workspaces/${workspaceId}/read-snapshot`))return json({schemaVersion:1,encryptedPayloads:[payload],context:{company,
      workspace:{id:workspaceId,acceptedHead:workspaceHead},agentInstructionsSnapshot:{compiledMarkdown:marker('rules')},userProfileSnapshot:null}});
    if(url.pathname.endsWith(`/workspaces/${workspaceId}`))return json({schemaVersion:1,encryptedPayloads:[],context:{company,
      workspace:{id:workspaceId,acceptedHead:workspaceHead},encryption:{browserProjection:{id:projectionId,manifestFileId,workspaceHead,fileCount:1}}}});
    if(url.pathname.endsWith('/reads/get_task_activity')){
      activityReads++;assert.deepEqual(JSON.parse(options.body).arguments,{companySlug:'encrypted',projectSlug,taskNumber:1,offset:1,limit:1});
      return json({schemaVersion:1,encryptedPayloads:[payload],context:{comments:[{id:randomUUID(),bodyText:marker('rules')}],
        pagination:{offset:1,limit:1,hasMore:true,nextOffset:2}}});
    }
    if(url.pathname.endsWith('/tasks/read')){
      assert.deepEqual(JSON.parse(options.body).tasks,[{projectSlug,taskNumber:1}]);
      return json({schemaVersion:1,encryptedPayloads:[payload],context:exact});
    }
    assert.ok(url.pathname.endsWith('/company-context/encrypted/manifest'));manifestReads++;
    const selected=structuredClone(payload);if(mode==='aad')selected.aad.companyId=randomUUID();
    if(mode==='closed')f.close();
    return json({schemaVersion:1,context:manifest,encryptedPayloads:mode==='missing'?[]:[selected]});
  };
  const run=()=>common.withWorkspaceExecutionProfile(profile,async()=>{
    await profile.prepareCompanyContextRead();
    const root=common.resolveCompanyContextMirrorDirectory();
    assert.match(root,new RegExp(`${f.identity.assistantId}.*${f.identity.deviceId}`));
    return materializeAssistantEncryptedCompanyContext({origin:f.identity.origin,descriptor,name:'search',arguments:{queries:[canary]},
      assertCurrent:profile.prepareCompanyContextRead});
  });
  const read=async(nativeTool,input)=>{
    const selected={...descriptor,nativeTool};
    const sourceProfile=await createAssistantWorkspaceProfile({identity:f.identity,store:f.store,host:f.host,client:f.client,
      encryptedCompanyContext:selected,lockDirectory:path.join(os.tmpdir(),'synthetic-company-locks'),lock:(_path,action)=>action()});
    return common.withWorkspaceExecutionProfile(sourceProfile,async()=>{
      await sourceProfile.prepareCompanyContextRead();
      return materializeAssistantEncryptedCompanyContext({origin:f.identity.origin,descriptor:selected,name:nativeTool,arguments:input,
        assertCurrent:sourceProfile.prepareCompanyContextRead});
    });
  };
  try{
    const result=await run();assert.match(JSON.stringify(result),new RegExp(canary));assert.ok(manifestReads>=2);
    const source=await read('get_task',{companySlug:'encrypted',projectSlug,taskNumber:1});
    assert.match(JSON.stringify(source),new RegExp(canary));assert.match(JSON.stringify(source),/Synthetic source rules/);
    const page=await read('list_projects',{offset:1,limit:1});
    assert.equal(page.structuredContent.items.length,1);assert.equal(page.structuredContent.offset,1);
    assert.doesNotMatch(JSON.stringify(source),/proposalProvider|codexThreadTitleReminder/);
    const activity=await read('get_task_activity',{projectSlug,taskNumber:1,offset:1,limit:1});
    assert.match(JSON.stringify(activity),/Synthetic source rules/);assert.equal(activity.structuredContent.pagination.nextOffset,2);
    assert.equal(activityReads,1);
    const file=await read('get_agent_workspace_file',{workspaceId,workspaceHead,filePath,delivery:'local-file'});
    assert.deepEqual(await fs.readFile(file.structuredContent.localFilePath),original);assert.equal(fileReads,2);
    assert.match(JSON.stringify(file),/Synthetic source rules/,'the source file carries its own read authority, never a new pass');
    assert.doesNotMatch(JSON.stringify(requests),new RegExp(canary));
    assert.doesNotMatch(JSON.stringify(requests),/SOURCE_PRIVATE_FILENAME_CANARY|ORIGINAL_PRIVATE_BYTES_CANARY/);
    assert.deepEqual(await f.host.readActivePass(),f.pass,'source discovery never rebinds the task/pass');
    for(const failure of ['aad','missing','recipient']){mode=failure;await assert.rejects(run());}
    mode='valid';await assert.rejects(common.withWorkspaceExecutionProfile(profile,()=>materializeAssistantEncryptedCompanyContext({origin:f.identity.origin,
      descriptor,name:'search',arguments:{queries:[canary],companySlugs:['foreign']},assertCurrent:profile.prepareCompanyContextRead})),{code:'ASSISTANT_WORKSPACE_BINDING_CHANGED'});
    mode='closed';await assert.rejects(run(),{code:'ASSISTANT_PASS_REVIEW_REQUIRED'});
    console.log('ASSISTANT_COMPANY_CONTEXT_SEARCH_VERIFIED');
  }finally{globalThis.fetch=previous;await fs.rm(cryptoRoot,{recursive:true,force:true});}
});

test('encrypted task reads compose the SAME managed keys, HPKE, native exact projection and selected ciphertext without a mirror',async()=>{
  const common=await import('../host-runtime/scripts/trelio-workspace.mjs');
  for(const nativeTool of ['get_task','get_task_sections','get_task_create_meta','search_agent_guidance','get_agent_procedure']){
    const f=await workspaceProfileFixture({encryptedTool:nativeTool});
    const descriptor=f.profile.encryptedTaskRead,scopeId=randomUUID(),cryptoDeviceId=randomUUID();
    const managed=await f.profile.resolveCompanyEncryptionDevice({origin:f.identity.origin,companyId:f.pass.companyId});
    const pair=await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
    const publicJwk=await webcrypto.subtle.exportKey('jwk',pair.publicKey),privateJwk=await webcrypto.subtle.exportKey('jwk',pair.privateKey);
    const aad={suite:'trelio-e2ee-v1',companyId:f.pass.companyId,scopeId,scopeEpoch:1,recipientType:'agent_device',recipientId:cryptoDeviceId};
    const sealed=await hpkeSeal({recipientPublicEncryptionJwk:managed.publicEncryptionJwk,
      plaintext:Buffer.from(JSON.stringify({suite:'trelio-e2ee-v1',version:1,scopePrivateEncryptionJwk:privateJwk})),aad});
    const envelope={id:randomUUID(),...aad,hpkeEnc:sealed.enc,ciphertext:sealed.ciphertext,aad};
    const taskEntity=randomUUID(),projectId=descriptor.arguments.projectSlug.slice(2);
    const rows=await Promise.all([taskEntity,projectId].map(async entityId=>{
      const header={companyId:f.pass.companyId,scopeId,scopeEpoch:1,entityType:'task',entityId,entityRevision:1,schemaVersion:1,purpose:'content'};
      return {...header,...await encryptCompanyPayload({scopePublicEncryptionJwk:publicJwk,aad:header,
        payload:{values:{title:'SYNTHETIC_TITLE',rules:'SYNTHETIC_RULE',comment:'SYNTHETIC_COMMENT',slug:'synthetic-project'}}})};
    }));
    const marker=field=>buildCompanyEncryptedTextMarker(taskEntity,field);
    const company={id:f.pass.companyId,slug:'encrypted',name:'Synthetic'};
    const project={id:projectId,slug:descriptor.arguments.projectSlug,name:'Synthetic project'};
    let raw=nativeTool==='get_task_sections'?{taskRevision:{id:f.pass.taskId,updatedAt:null},sections:{comments:{comments:[{bodyText:marker('comment')}]}}}
      : {schemaVersion:1,company,viewer:{memberId:randomUUID(),companyRole:'user'},viewerGroupIds:[],projects:[project],
        tasks:[{id:f.pass.taskId,projectId,projectSlug:project.slug,number:30,revisionToken:'synthetic:1',
          payload:{company,project,task:{id:f.pass.taskId,title:marker('title'),status:{code:'active',name:'Active'},participants:[],controls:[]}}}],
        instructions:{company:{compiledMarkdown:marker('rules')},projects:[],userProfile:null},workspaces:[],workspaceEntries:[],contextDocuments:[]};
    if(nativeTool==='get_task_create_meta')raw={...raw,tasks:[],taskCreateMeta:{companySlug:company.slug,project:{...project,name:marker('title')},
      viewer:raw.viewer,defaults:{statusCode:'active',urgency:0},statuses:[],availableMembers:[],availableMemberGroups:[]}};
    if(['search_agent_guidance','get_agent_procedure'].includes(nativeTool))raw={...raw,tasks:[],
      agentSkills:{company:[{id:'synthetic-skill',catalogSlug:'synthetic',title:marker('title'),description:'',enabled:true,searchTerms:[]}],projects:[]},
      agentProcedures:nativeTool==='get_agent_procedure'?[{kind:'procedure',project:null,
        procedure:{id:descriptor.arguments.procedureId,state:'published',publishedRevisionNumber:1},
        revision:{title:marker('title'),description:'',instructionsMarkdown:marker('rules'),searchTerms:[]}}]:[]};
    const previous=globalThis.fetch;let mode='valid',contentReads=0;const paths=[];
    globalThis.fetch=async(url,options)=>{
      url=new URL(url);paths.push(url.pathname);
      assert.equal(options.headers.get('authorization'),`Bearer ${f.credential}`);
      assert.equal(options.headers.get('cookie'),null);assert.equal(options.redirect,'error');
      const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
      if(url.pathname==='/api/digital-assistants/runtime/encryption/runtime'){
        assert.equal(url.origin,f.identity.origin);assert.equal(options.method??'GET','GET');
        assert.equal(options.headers.get('x-trelio-assistant-encryption-protocol'),'1');
        const found=url.searchParams.has('fingerprint');
        const selected=structuredClone(envelope);if(mode==='recipient')selected.recipientId=randomUUID();
        return json({state:'encrypted',suite:'trelio-e2ee-v1',company,viewer:{userId:f.identity.assistantId},
          accessState:found?'ready':'device_required',device:found?{id:cryptoDeviceId,fingerprint:managed.fingerprint}:null,
          scope:found?{id:scopeId,epoch:1,publicEncryptionJwk:publicJwk}:null,envelope:found?selected:null});
      }
      assert.equal(url.origin,'https://e2ee.trelio.ru');assert.equal(options.method,'POST');contentReads++;
      assert.equal(url.pathname,descriptor.paths[0].replace('/api/agent-workspaces','/api/digital-assistants/runtime/workspace'));
      assert.equal(JSON.parse(options.body).recipientDeviceId,cryptoDeviceId);
      if(descriptor.contextRead){
        const body=JSON.parse(options.body);assert.equal(body.contextRead,descriptor.contextRead);
        assert.equal(body.query,undefined);assert.equal(body.hints,undefined);
        if(nativeTool==='get_agent_procedure')assert.equal(body.procedureId,descriptor.arguments.procedureId);
      }
      const selected=structuredClone(rows);
      if(mode==='aad')selected[0].aad.companyId=randomUUID();
      if(mode==='ciphertext')selected[0].ciphertext='AAAA';
      if(mode==='missing')selected.splice(0,1);
      if(mode==='late-close')f.close();
      return json({schemaVersion:1,context:raw,encryptedPayloads:selected});
    };
    const run=()=>withWorkspaceExecutionProfile(f.profile,()=>materializeAssistantEncryptedTask({origin:f.identity.origin,descriptor,
      assertCurrent:f.profile.assertEncryptedTaskReadCurrent}));
    try{
      const result=await run();assert.notEqual(result.isError,true);
      const rendered=JSON.stringify(result);
      assert.match(rendered,nativeTool==='get_task_sections'?/SYNTHETIC_COMMENT/:/SYNTHETIC_TITLE/);
      if(['get_task','get_task_create_meta','get_agent_procedure'].includes(nativeTool))assert.match(rendered,/SYNTHETIC_RULE/);
      assert.doesNotMatch(rendered,/~e1:|wrappedPrivateBundle|scopePrivateEncryptionJwk|hpkeEnc|ciphertextSha256/);
      assert.equal(paths.some(path=>path.includes('manifest')||path.includes('payloads/resolve')),false);
      for(const failure of ['aad','ciphertext','missing','recipient']){
        mode=failure;const before=contentReads;await assert.rejects(run());
        if(mode==='recipient')assert.equal(contentReads,before,'wrong envelope refuses before content I/O');
      }
      mode='late-close';await assert.rejects(run(),{code:'ASSISTANT_PASS_REVIEW_REQUIRED'});
    }finally{globalThis.fetch=previous;}
    await assert.rejects(validateAssistantEncryptedTaskRead({identity:f.identity,pass:f.pass,
      descriptor:{...f.descriptor,passId:randomUUID()}}),{code:'ASSISTANT_MCP_INVALID_RESPONSE'});
    await assert.rejects(validateAssistantEncryptedTaskRead({identity:f.identity,
      descriptor:{...f.descriptor,requestOrigin:'https://arbitrary.test'}}),{code:'ASSISTANT_WORKSPACE_ORIGIN_DENIED'});
  }
});

test('encrypted Workspace inspect open finish composes real Git, managed HPKE, native ciphertext and the SAME readonly cache',async()=>{
  // An actual isolated child is necessary: the common module captures its
  // private config root at import time. Never write synthetic authority/cache
  // into the developer's real HOME or share a human remembered-key profile.
  if(process.env.TRELIO_ASSISTANT_INSPECTION_FIXTURE!=='1'){
    // Short synthetic HOME avoids adding an artificial Windows MAX_PATH limit
    // to the fixed common cache layout. Production path guards stay unchanged.
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ai-')));
    const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{fileURLToPath}=await import('node:url');
    // NODE_TEST_CONTEXT belongs to the outer runner. Inheriting it makes a
    // nested --test process suppress its runner, so exit 0 alone is no proof
    // that the isolated composition executed. Require an end-of-flow sentinel.
    const childEnv={...process.env,HOME:root,USERPROFILE:root,LOCALAPPDATA:path.join(root,'l'),
      TRELIO_WORKSPACE_DISABLE_KEYCHAIN:'1',TRELIO_ASSISTANT_INSPECTION_FIXTURE:'1'};
    delete childEnv.NODE_TEST_CONTEXT;
    try{const result=await promisify(execFile)(process.execPath,['--test','--test-name-pattern','encrypted Workspace inspect open finish',fileURLToPath(import.meta.url)],{
      env:childEnv,timeout:30000,maxBuffer:1024*1024});
      assert.match(result.stdout,/ASSISTANT_ENCRYPTED_INSPECTION_VERIFIED/u);
    }catch(error){
      // Keep synthetic-child failure evidence bounded to its error/stack, not
      // arbitrary assertion objects, headers or the managed private fixture.
      const lines=String(error.stdout??'').split('\n').filter(line=>/^\s*(?:error: [^|]|code: |at |stack:|TestContext\.|async )/u.test(line));
      throw new Error(lines.slice(0,12).join('\n')||'Encrypted Workspace child failed');
    }finally{
      const writable=async directory=>{await fs.chmod(directory,0o700);for(const entry of await fs.readdir(directory,{withFileTypes:true})){
        const item=path.join(directory,entry.name);if(entry.isDirectory())await writable(item);else if(!entry.isSymbolicLink())await fs.chmod(item,0o600);}};
      await writable(root);await fs.rm(root,{recursive:true,force:true});
    }
    return;
  }
  const common=await import('../host-runtime/scripts/trelio-workspace.mjs');
  const {executeAssistantWorkspacePlan}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const f=await workspaceProfileFixture({encryptedInspection:true}),descriptor=f.inspectionDescriptor;
  const scopeId=randomUUID(),cryptoDeviceId=randomUUID(),revisionId=randomUUID(),entityId=randomUUID();
  const managed=await f.profile.resolveCompanyEncryptionDevice({origin:f.identity.origin,companyId:f.pass.companyId});
  const pair=await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const publicJwk=await webcrypto.subtle.exportKey('jwk',pair.publicKey),privateJwk=await webcrypto.subtle.exportKey('jwk',pair.privateKey);
  const aad={suite:'trelio-e2ee-v1',companyId:f.pass.companyId,scopeId,scopeEpoch:1,recipientType:'agent_device',recipientId:cryptoDeviceId};
  const sealed=await hpkeSeal({recipientPublicEncryptionJwk:managed.publicEncryptionJwk,
    plaintext:Buffer.from(JSON.stringify({suite:'trelio-e2ee-v1',version:1,scopePrivateEncryptionJwk:privateJwk})),aad});
  const envelope={id:randomUUID(),...aad,hpkeEnc:sealed.enc,ciphertext:sealed.ciphertext,aad};
  const root=path.join(os.homedir(),'git-fixture');await fs.mkdir(root);
  const git=args=>common.runGit(args,{cwd:root});
  await git(['init','--initial-branch=main']);await git(['config','user.name','Synthetic']);await git(['config','user.email','test@trelio.invalid']);
  await fs.writeFile(path.join(root,'result.md'),'SELECTED_ACCEPTED_FILE');
  await fs.writeFile(path.join(root,'WORKSPACE_CONTEXT.md'),'# Synthetic Workspace context\n');
  await git(['add','--all']);
  await git(['-c','commit.gpgsign=false','commit','-m','Synthetic accepted tree']);
  const head=(await git(['rev-parse','HEAD'])).stdout.trim(),bundle=path.join(os.homedir(),'accepted.bundle'),cipher=path.join(os.homedir(),'accepted.trelioe1');
  await git(['bundle','create',bundle,'refs/heads/main']);
  await encryptFileToCompanyContainer({sourcePath:bundle,destinationPath:cipher,scopePublicEncryptionJwk:publicJwk,
    originalName:'workspace.bundle',mimeType:'application/vnd.git.bundle',aad:{companyId:f.pass.companyId,scopeId,scopeEpoch:1,
      entityType:'agent_workspace_revision',entityId:descriptor.workspaceId,entityRevision:1,schemaVersion:1}});
  const bytes=await fs.readFile(cipher),digest=value=>createHash('sha256').update(value).digest('hex');
  const header={companyId:f.pass.companyId,scopeId,scopeEpoch:1,entityType:'task',entityId,entityRevision:1,schemaVersion:1,purpose:'content'};
  const payload={...header,...await encryptCompanyPayload({scopePublicEncryptionJwk:publicJwk,aad:header,
    payload:{values:{rules:'SELECTED_ASSISTANT_RULES',profile:'SELECTED_ASSISTANT_PROFILE'}}})};
  const rulesMarkdown='Synthetic global platform rules\n',rulesSha=digest(rulesMarkdown),rulesId=randomUUID();
  const company={id:f.pass.companyId,slug:'encrypted',name:'Synthetic'};
  const snapshot={schemaVersion:1,workspace:{id:descriptor.workspaceId,scopeType:'task',scopeKey:`task:${f.pass.taskId}`,acceptedHead:head},company,
    encryption:{state:'encrypted'},agentInstructionsSnapshot:{schemaVersion:2,platform:{revisionId:rulesId,version:1,sha256:rulesSha,rulesMarkdown},
      company:null,project:null,compiledMarkdown:buildCompanyEncryptedTextMarker(entityId,'rules')},
    userProfileSnapshot:{schemaVersion:1,profile:{revisionId:randomUUID(),version:1},compiledMarkdown:buildCompanyEncryptedTextMarker(entityId,'profile')}};
  const savedFetch=globalThis.fetch;let downloads=0,mode='valid',selectedHead=head,selectedCipher=bytes,selectedRevision=revisionId,
    selectedDigest=digest(bytes),selectedFormat=null;const requests=[];
  globalThis.fetch=async(url,options)=>{
    url=new URL(url);requests.push(url.pathname);assert.equal(options.headers.get('authorization'),`Bearer ${f.credential}`);
    assert.equal(options.headers.get('cookie'),null);assert.equal(options.redirect,'error');
    const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
    if(url.pathname.endsWith('/bridge-compatibility'))return json({supported:true,minimumVersion:'0.0.0',agentRules:{
      status:options.headers.get('x-trelio-agent-rules-sha256')===rulesSha?'current':'update_required',revisionId:rulesId,version:1,sha256:rulesSha,rulesMarkdown}});
    if(url.pathname.endsWith('/bridge-routing'))return json({schemaVersion:1,company,encryptionState:'encrypted',encryptedDataPlaneOrigin:descriptor.requestOrigin});
    if(url.pathname==='/api/digital-assistants/runtime/encryption/runtime'){
      assert.equal(url.origin,f.identity.origin,'managed key control plane is canonical, never a content fallback');
      const found=url.searchParams.has('fingerprint');
      return json({state:'encrypted',suite:'trelio-e2ee-v1',company,viewer:{userId:f.identity.assistantId},
        accessState:found?'ready':'device_required',device:found?{id:cryptoDeviceId,fingerprint:managed.fingerprint}:null,
        scope:found?{id:scopeId,epoch:1,publicEncryptionJwk:publicJwk}:null,envelope:found?envelope:null});
    }
    assert.equal(url.origin,descriptor.requestOrigin);assert.equal(options.headers.get('x-trelio-assistant-encryption-device'),cryptoDeviceId);
    if(url.pathname.endsWith('/read-snapshot')){
      if(mode==='invalid-utf8')return new Response(Buffer.from([0xff]));
      if(mode==='oversized')return new Response('{}',{headers:{'content-length':String(32*1024*1024+1)}});
      const body=structuredClone(snapshot);if(mode==='foreign')body.workspace.scopeKey=`task:${randomUUID()}`;
      return json({schemaVersion:1,context:body,encryptedPayloads:mode==='missing'?[]:[payload]});
    }
    assert.equal(url.pathname,`/api/digital-assistants/runtime/workspace/workspaces/${descriptor.workspaceId}/encrypted-bundle`);
    assert.equal(url.searchParams.get('head'),selectedHead);downloads++;
    if(mode==='late-close')f.close();
    return new Response(selectedCipher,{headers:{'x-trelio-e2ee':'v1','x-trelio-workspace-id':descriptor.workspaceId,'x-trelio-accepted-head':selectedHead,
      'x-trelio-encrypted-revision-id':selectedRevision,'x-trelio-scope-id':scopeId,'x-trelio-scope-epoch':'1','x-trelio-ciphertext-sha256':selectedDigest,
      ...(selectedFormat?{'x-trelio-encrypted-bundle-format':selectedFormat}:{})}});
  };
  const plan={prepared:true,scope:{assistantUserId:f.identity.assistantId,deviceId:f.identity.deviceId,companyId:f.pass.companyId,taskId:f.pass.taskId,passId:f.pass.passId},
    encryptedInspection:descriptor,localAction:{schemaVersion:1,operation:'inspect',parameters:{workspaceId:descriptor.workspaceId}}};
  const run=()=>common.withWorkspaceExecutionProfile(f.profile,()=>executeAssistantWorkspacePlan(plan,{withProfile:action=>action(f)}));
  try{
    const result=await run(),directory=result.stdout.trim(),context=path.join(path.dirname(directory),'context');
    assert.equal(await fs.readFile(path.join(directory,'result.md'),'utf8'),'SELECTED_ACCEPTED_FILE');
    assert.equal(await fs.readFile(path.join(context,'agent-instructions.md'),'utf8'),'SELECTED_ASSISTANT_RULES');
    assert.match(await fs.readFile(path.join(context,'user-profile.md'),'utf8'),/SELECTED_ASSISTANT_PROFILE/);
    assert.equal(JSON.parse(await fs.readFile(path.join(context,'index.json'),'utf8')).mode,'read_only_accepted_workspace');
    assert.ok(directory.includes(path.join('digital-assistants','tasks')));assert.equal(downloads,1);
    if(process.platform!=='win32')assert.equal((await fs.stat(directory)).mode&0o222,0);
    await run();assert.equal(downloads,1,'fresh native authority can reuse only the same verified local bytes');
    for(const failure of ['foreign','missing','invalid-utf8','oversized']){mode=failure;await assert.rejects(run());assert.equal(downloads,1);}
    assert.ok(!requests.some(value=>value.includes('payloads/resolve')||value.includes('/runs/')));
    // Compose the writable half with the SAME managed device, native-selected
    // authority payloads and real Git/container materializer. A second profile
    // grants no inspection/history shortcuts and never borrows human auth.
    mode='valid';
    // This is the SECOND encrypted save: seed the accepted base's real v2
    // manifest, not a projection:null fixture that never exercises dedup reads.
    const baseProjectionId=randomUUID(),baseManifestId=randomUUID();
    const baseFiles=await Promise.all(['result.md','WORKSPACE_CONTEXT.md'].map(async filePath=>{
      const body=await fs.readFile(path.join(root,filePath));
      return {id:randomUUID(),path:filePath,name:filePath,contentType:'text/plain; charset=utf-8',sizeBytes:body.length,plaintextSha256:digest(body)};
    }));
    const baseManifest={schemaVersion:1,kind:'agent-workspace-browser-manifest',projectionId:baseProjectionId,
      workspaceId:descriptor.workspaceId,workspaceHead:head,files:baseFiles};
    const manifestPlain=path.join(os.homedir(),'base-manifest.json'),manifestCipher=path.join(os.homedir(),'base-manifest.trelioe1');
    await fs.writeFile(manifestPlain,canonicalJson(baseManifest));
    await encryptFileToCompanyContainer({sourcePath:manifestPlain,destinationPath:manifestCipher,scopePublicEncryptionJwk:publicJwk,
      originalName:'workspace-files.json',mimeType:'application/json',aad:{companyId:company.id,scopeId,scopeEpoch:1,
        entityType:'agent_workspace_browser_manifest',entityId:baseManifestId,entityRevision:1,schemaVersion:1}});
    const baseManifestBytes=await fs.readFile(manifestCipher);
    const baseProjection={id:baseProjectionId,formatVersion:2,workspaceHead:head,manifestFileId:baseManifestId,fileCount:baseFiles.length,
      files:[{id:baseManifestId,kind:'manifest',sizeBytes:baseManifestBytes.length,ciphertextSha256:digest(baseManifestBytes)},
        ...baseFiles.map(file=>({id:file.id,kind:'content',sizeBytes:file.sizeBytes+1024,ciphertextSha256:'b'.repeat(64)}))]};
    let baseManifestReads=0,reusedFileCount=0;
    const runId=randomUUID(),runIdentity={workspaceId:descriptor.workspaceId,runId};
    let nativeRun={id:runId,workspaceId:descriptor.workspaceId,status:'running',baseHead:head,draftHead:null,candidateHead:null,
      leaseId:randomUUID(),fencingToken:1,leaseExpiresAt:new Date(Date.now()+300_000).toISOString(),
      agentInstructionsSnapshotJson:snapshot.agentInstructionsSnapshot,userProfileSnapshotJson:snapshot.userProfileSnapshot,
      contextHeadsJson:[],relatedWorkspaceSnapshotsJson:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    const writerProfile=await createAssistantWorkspaceProfile({identity:f.identity,host:f.host,client:f.client,store:f.store,
      workspaceRun:runIdentity,lockDirectory:path.join(os.tmpdir(),'synthetic-writer-locks'),lock:(_file,action)=>action()});
    const readFetch=globalThis.fetch,uploads=new Map(),storedPayloads=[payload];
    let latestCheckpoint=null,acceptedPublications=0,acceptedRevisionBytes=null,draftTransport=null;
    globalThis.fetch=async(url,options)=>{
      const parsed=new URL(url),base='/api/digital-assistants/runtime/workspace';
      if(parsed.pathname===`${base}/files/${baseManifestId}/encrypted-content`){
        assert.equal(parsed.origin,descriptor.requestOrigin);assert.equal(parsed.search,'');
        assert.equal(options.headers.get('x-trelio-assistant-workspace-run'),runId);
        assert.equal(options.headers.get('x-trelio-assistant-encryption-device'),cryptoDeviceId);
        baseManifestReads++;return new Response(baseManifestBytes);
      }
      const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
      const scoped=context=>json({schemaVersion:1,context,encryptedPayloads:storedPayloads});
      if(parsed.pathname===`${base}/workspaces/${descriptor.workspaceId}`)
        return scoped({workspace:snapshot.workspace,company,runs:[nativeRun],permissions:{canRead:true,canEdit:true,canApprove:true}});
      if(parsed.pathname===`${base}/workspaces/${descriptor.workspaceId}/runs/${runId}`)return scoped({run:nativeRun,latestCheckpoint});
      if(parsed.pathname===`${base}/runs/${runId}/claim`){
        const input=JSON.parse(options.body);assert.equal(input.expectedFencingToken,nativeRun.fencingToken);
        nativeRun={...nativeRun,status:'running',fencingToken:nativeRun.fencingToken+1,leaseId:randomUUID()};return scoped(nativeRun);
      }
      if(parsed.pathname===`${base}/encryption/payloads`){
        const body=JSON.parse(options.body);assert.equal(body.writerDeviceId,cryptoDeviceId);
        assert.equal(JSON.stringify(body).includes('SYNTHETIC_FINISH_PRIVATE_SUMMARY'),false);
        storedPayloads.push(...body.payloads);return json({stored:body.payloads.length});
      }
      if(parsed.pathname===`${base}/runs/${runId}/heartbeat`)return json(nativeRun);
      if(parsed.pathname===`${base}/runs/${runId}/codex-conversation`)return json(null);
      if(parsed.pathname===`${base}/runs/${runId}/checkpoints`){
        const input=JSON.parse(options.body);assert.equal(input.fencingToken,nativeRun.fencingToken);
        assert.equal(input.taskOutcome,'no_status_change');assert.equal(input.summary.includes('SYNTHETIC_FINISH_PRIVATE_SUMMARY'),false);
        latestCheckpoint={...input,id:randomUUID(),createdAt:new Date().toISOString()};return json(latestCheckpoint);
      }
      const storage=`${base}/runs/${runId}/encrypted-storage`;
      if(parsed.pathname===storage)return json({protocolVersion:2,workspaceId:descriptor.workspaceId,baseHead:head,
        limits:{partSizeBytes:8*1024*1024,maxFileBytes:24*1024*1024,maxFiles:10000,maxManifestBytes:8*1024*1024,
          maxContainerBytes:4*1024**4,maxChainLength:128,legacyBundleBytes:100*1024*1024},
        baseRevision:{id:revisionId,head,chainLength:1,scopeId,scopeEpoch:1},projection:baseProjection});
      if(parsed.pathname===storage+'/publication')return json(null);
      if(parsed.pathname===storage+'/uploads'){
        const input=JSON.parse(options.body);assert.equal(input.writerDeviceId,cryptoDeviceId);
        assert.equal(input.fencingToken,nativeRun.fencingToken);
        const upload={...input,state:'uploading',partSizeBytes:8*1024*1024,parts:[],bytes:[]};
        uploads.set(input.uploadId,upload);return json(upload);
      }
      if(parsed.pathname.startsWith(storage+'/uploads/')){
        const [uploadId,operation,index]=parsed.pathname.slice((storage+'/uploads/').length).split('/'),upload=uploads.get(uploadId);
        if(!upload)return new Response(JSON.stringify({code:'NOT_FOUND'}),{status:404,headers:{'content-type':'application/json'}});
        if(operation==='parts'){
          const bytes=Buffer.from(options.body),part={uploadId,partIndex:Number(index),sha256:digest(bytes),sizeBytes:bytes.length};
          assert.equal(part.sha256,options.headers.get('x-trelio-ciphertext-sha256'));
          assert.equal(bytes.includes(Buffer.from('SYNTHETIC_FINISH_PRIVATE_SUMMARY')),false);
          upload.parts.push(part);upload.bytes[Number(index)]=bytes;return json(part);
        }
        if(operation==='complete'){
          assert.equal(digest(Buffer.concat(upload.bytes)),upload.ciphertextSha256);upload.state='ready';
        }
        const {bytes,...status}=upload;return json(status);
      }
      if(parsed.pathname===storage+'/projection'){
        const input=JSON.parse(options.body);assert.ok(uploads.get(input.manifestFileId)?.state==='ready');
        reusedFileCount=input.files.filter(file=>baseFiles.some(original=>original.id===file.id)).length;
        assert.ok(input.files.some(file=>file.id===baseFiles[0].id),'unchanged result.md reuses its exact prior random ID');
        return json({projectionId:input.projectionId,workspaceHead:input.workspaceHead,fileCount:input.files.length-1,state:'staging'});
      }
      if(parsed.pathname===`${base}/runs/${runId}/encrypted-derived-artifacts`){
        const input=JSON.parse(options.body);return json({workspaceHead:input.workspaceHead,artifacts:input.artifacts,
          derivedArtifactsSha256:common.buildEncryptedDerivedArtifactsDigest(input.artifacts)});
      }
      if(parsed.pathname===storage+'/candidate'){
        const input=JSON.parse(options.body),upload=uploads.get(input.uploadId);assert.equal(upload.state,'ready');
        assert.equal(latestCheckpoint.checkpointType,'handoff');assert.notEqual(input.workspaceHead,head);
        acceptedRevisionBytes=Buffer.concat(upload.bytes);acceptedPublications++;
        nativeRun={...nativeRun,candidateHead:input.workspaceHead,status:'accepted',acceptedAt:new Date().toISOString()};
        return json({run:nativeRun});
      }
      if(parsed.pathname===`${base}/runs/${runId}/encrypted-bundle`)
        return draftTransport?new Response(draftTransport.bytes,{headers:draftTransport.headers}):new Response(bytes,{headers:{'x-trelio-e2ee':'v1','x-trelio-workspace-id':descriptor.workspaceId,
          'x-trelio-accepted-head':head,'x-trelio-materialized-head':head,'x-trelio-materialized-source':'base',
          'x-trelio-encrypted-revision-id':revisionId,'x-trelio-scope-id':scopeId,'x-trelio-scope-epoch':'1',
          'x-trelio-ciphertext-sha256':digest(bytes)}});
      return readFetch(url,options);
    };
    const writerPlan={prepared:true,scope:plan.scope,encryptedLifecycle:descriptor,localAction:{schemaVersion:1,operation:'open',
      parameters:{...runIdentity,runtimeSessionId:f.runtime.state.runtimeSessionId}}};
    const opened=await common.withWorkspaceExecutionProfile(writerProfile,()=>executeAssistantWorkspacePlan(writerPlan,{
      withProfile:action=>action({...f,prepareWorkspaceRun:writerProfile.prepareWorkspaceRun})}));
    let writable=path.join(assistantTaskStorageDirectory(common.resolveWorkspaceBridgeConfigDirectory(),{
      origin:f.identity.origin,assistantId:f.identity.assistantId,deviceId:f.identity.deviceId,
      companyId:f.pass.companyId,taskId:f.pass.taskId}),'workspaces',descriptor.workspaceId,'workspace');
    assert.equal(await fs.readFile(path.join(writable,'result.md'),'utf8'),'SELECTED_ACCEPTED_FILE');
    assert.equal(await fs.readFile(path.join(path.dirname(writable),'context','agent-instructions.md'),'utf8'),'SELECTED_ASSISTANT_RULES');
    assert.equal(JSON.parse(await fs.readFile(path.join(path.dirname(writable),'.trelio-run.json'),'utf8')).fencingToken,nativeRun.fencingToken);
    assert.equal(opened.operation,'open');

    // A saved encrypted draft and a later local committed delta are both real
    // material. Reopening an expired own Run must preserve that checkout and
    // materialize the native draft through the SAME common recovery callback.
    // A fresh open from the accepted base alone never exercises this boundary.
    await fs.writeFile(path.join(root,'server-draft.md'),'SYNTHETIC_NATIVE_DRAFT');
    await git(['add','server-draft.md']);await git(['commit','-m','Native portable draft']);
    const draftHead=(await git(['rev-parse','HEAD'])).stdout.trim(),draftId=randomUUID();
    const draftBundle=path.join(os.homedir(),'portable-draft.bundle'),draftCipher=path.join(os.homedir(),'portable-draft.trelioe1');
    await git(['bundle','create',draftBundle,'refs/heads/main','^'+head]);
    await encryptFileToCompanyContainer({sourcePath:draftBundle,destinationPath:draftCipher,scopePublicEncryptionJwk:publicJwk,
      originalName:'workspace.bundle',mimeType:'application/vnd.git.bundle',aad:{companyId:company.id,scopeId,scopeEpoch:1,
        entityType:'agent_workspace_revision',entityId:runId,entityRevision:nativeRun.fencingToken,schemaVersion:1}});
    const draftBytes=await fs.readFile(draftCipher),draftChainHeader=Buffer.from(canonicalJson({schemaVersion:1,companyId:company.id,
      workspaceId:descriptor.workspaceId,revisions:[{id:revisionId,workspaceHead:head,baseHead:null,bundleFormat:'full',parentRevisionId:null,
        scopeId,scopeEpoch:1,ciphertextSha256:digest(bytes),ciphertextSizeBytes:bytes.length},
      {id:draftId,workspaceHead:draftHead,baseHead:head,bundleFormat:'delta',parentRevisionId:revisionId,
        scopeId,scopeEpoch:1,ciphertextSha256:digest(draftBytes),ciphertextSizeBytes:draftBytes.length}]}));
    const chainSize=Buffer.alloc(4);chainSize.writeUInt32BE(draftChainHeader.length);
    const chainBytes=Buffer.concat([Buffer.from('TRELIOH1'),chainSize,draftChainHeader,bytes,draftBytes]);
    draftTransport={bytes:chainBytes,headers:{'x-trelio-e2ee':'v1','x-trelio-workspace-id':descriptor.workspaceId,
      'x-trelio-materialized-source':'draft','x-trelio-materialized-head':draftHead,'x-trelio-accepted-head':head,
      'x-trelio-encrypted-revision-id':draftId,'x-trelio-scope-id':scopeId,'x-trelio-scope-epoch':'1',
      'x-trelio-ciphertext-sha256':digest(draftBytes),'x-trelio-encrypted-bundle-format':'chain-v1',
      'x-trelio-writer-device-id':cryptoDeviceId,'x-trelio-bundle-format':'delta','x-trelio-parent-revision-id':revisionId,
      'x-trelio-revision-ciphertext-size':String(draftBytes.length)}};
    await fs.writeFile(path.join(writable,'local-only.md'),'SYNTHETIC_LOCAL_COMMITTED_DELTA');
    await common.runGit(['add','local-only.md'],{cwd:writable});await common.runGit(['commit','-m','Retained local delta'],{cwd:writable});
    const sourceDirectory=writable,sourceHead=(await common.runGit(['rev-parse','HEAD'],{cwd:writable})).stdout.trim();
    nativeRun={...nativeRun,status:'expired',draftHead};
    const reopened=await common.withWorkspaceExecutionProfile(writerProfile,()=>executeAssistantWorkspacePlan(writerPlan,{
      withProfile:action=>action({...f,prepareWorkspaceRun:writerProfile.prepareWorkspaceRun})}));
    const recovery=JSON.parse(reopened.stdout.trim().split('\n').at(-1)).assistantLocalRecovery;
    assert.equal(recovery.reasonCode,'DIVERGED_HISTORY');
    assert.equal(recovery.sourceFilesMustRemainUntouched,true);
    writable=path.join(recovery.suggestedDirectory,'workspace');
    const registered=await common.readRunRegistry();
    assert.equal(registered.includes(path.dirname(sourceDirectory)),false,'only the proven same-Run source locator is superseded');
    assert.equal(registered.includes(path.dirname(writable)),true);
    assert.equal(await fs.readFile(path.join(writable,'server-draft.md'),'utf8'),'SYNTHETIC_NATIVE_DRAFT');
    assert.equal((await common.runGit(['rev-parse','HEAD'],{cwd:sourceDirectory})).stdout.trim(),sourceHead);
    assert.equal(await fs.readFile(path.join(sourceDirectory,'local-only.md'),'utf8'),'SYNTHETIC_LOCAL_COMMITTED_DELTA');
    assert.equal(JSON.parse(await fs.readFile(path.join(path.dirname(writable),'.trelio-run.json'),'utf8')).fencingToken,nativeRun.fencingToken);
    // The agent, rather than open, chooses the compatible material to carry.
    await fs.copyFile(path.join(sourceDirectory,'local-only.md'),path.join(writable,'local-only.md'));
    await fs.mkdir(path.join(writable,'assistants',f.identity.assistantId),{recursive:true});
    await fs.writeFile(path.join(writable,'assistants',f.identity.assistantId,'WORK.md'),'# Goal\nVerified material result\n');
    await fs.writeFile(path.join(writable,'new-result.md'),'SYNTHETIC_ENCRYPTED_DELIVERABLE');
    let deniedFixtureRoute=null;
    const observedWriterProfile={...writerProfile,async prepareRequest(input){
      try{return await writerProfile.prepareRequest(input);}catch(error){
        deniedFixtureRoute=String(input.options?.method??'GET')+' '+String(input.pathname).split('?')[0]
          .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu,':id');throw error;
      }
    }};
    const finishPlan={...writerPlan,localAction:{schemaVersion:1,operation:'finish',runIdentity,
      parameters:{summary:'SYNTHETIC_FINISH_PRIVATE_SUMMARY result saved',evidence:['Verified exact committed files'],
        nextAction:'Continue only from the accepted material',taskOutcome:'no_status_change'}}};
    let finished;
    try{finished=await common.withWorkspaceExecutionProfile(observedWriterProfile,()=>executeAssistantWorkspacePlan(finishPlan,{
      withProfile:action=>action({...f,prepareWorkspaceRun:writerProfile.prepareWorkspaceRun})}));}
    catch(error){throw new Error((deniedFixtureRoute??'fixture-native')+' '+error.code);}

    assert.equal(finished.operation,'finish');assert.equal(nativeRun.status,'accepted');assert.equal(acceptedPublications,1);
    assert.equal(baseManifestReads,1,'a second save reads the native selected encrypted base manifest once');
    assert.ok(reusedFileCount>=1);
    await common.withWorkspaceExecutionProfile(writerProfile,async()=>{
      for(const pathname of [`/api/agent-workspaces/files/${randomUUID()}/encrypted-content`,
        `/api/agent-workspaces/files/${baseFiles[0].id}/encrypted-content`,
        `/api/agent-workspaces/files/${baseManifestId}/encrypted-content?head=${head}`])
        await assert.rejects(common.request(descriptor.requestOrigin,await writerProfile.requireToken(f.identity.origin),pathname),
          {code:'ASSISTANT_WORKSPACE_ORIGIN_DENIED'});
    });
    assert.ok(acceptedRevisionBytes?.subarray(0,8).equals(Buffer.from('TRELIOE1')));
    assert.equal(acceptedRevisionBytes.includes(Buffer.from('SYNTHETIC_ENCRYPTED_DELIVERABLE')),false);
    const acceptedCipher=path.join(os.homedir(),'accepted-result.trelioe1'),acceptedBundle=path.join(os.homedir(),'accepted-result.bundle');
    await fs.writeFile(acceptedCipher,acceptedRevisionBytes,{mode:0o600});
    const {decryptFileFromCompanyContainer}=await import('../host-runtime/scripts/trelio-company-encryption.mjs');
    const decoded=await decryptFileFromCompanyContainer({sourcePath:acceptedCipher,destinationPath:acceptedBundle,
      scopePrivateKey:pair.privateKey,scopePrivateJwk:privateJwk,expectedCiphertextSha256:digest(acceptedRevisionBytes)});
    assert.equal(decoded.header.aad.companyId,company.id);assert.equal(decoded.header.aad.entityId,runId);
    assert.equal(decoded.header.aad.entityRevision,nativeRun.fencingToken);
    await git(['fetch',acceptedBundle,'+refs/*:refs/remotes/result-proof/*']);
    assert.equal((await git(['show',nativeRun.candidateHead+':new-result.md'])).stdout,'SYNTHETIC_ENCRYPTED_DELIVERABLE');
    assert.match((await git(['show',nativeRun.candidateHead+':assistants/'+f.identity.assistantId+'/WORK.md'])).stdout,/Verified material result/);
    assert.equal(JSON.parse(await fs.readFile(path.join(path.dirname(writable),'.trelio-run.json'),'utf8')).terminalStatus,'accepted');
    globalThis.fetch=readFetch;
    // Fresh accepted read-back, not the editable writer folder, supplies the
    // encrypted business witness. The SAME managed HPKE/container/Git path
    // reads back the candidate we just accepted; only structural facts reach
    // the independent native completion boundary.
    selectedHead=nativeRun.candidateHead;selectedRevision=randomUUID();selectedDigest=digest(acceptedRevisionBytes);selectedFormat='chain-v1';
    // Native v2 stores a full base + delta chain. Return that exact existing
    // transport instead of incorrectly pretending the accepted delta alone is
    // a cloneable full bundle. The common history reader verifies both bodies.
    const chainHeader=Buffer.from(canonicalJson({schemaVersion:1,companyId:company.id,workspaceId:descriptor.workspaceId,revisions:[
      {id:revisionId,workspaceHead:head,baseHead:null,bundleFormat:'full',parentRevisionId:null,
        scopeId,scopeEpoch:1,ciphertextSha256:digest(bytes),ciphertextSizeBytes:bytes.length},
      {id:selectedRevision,workspaceHead:selectedHead,baseHead:head,bundleFormat:'delta',parentRevisionId:revisionId,
        scopeId,scopeEpoch:1,ciphertextSha256:selectedDigest,ciphertextSizeBytes:acceptedRevisionBytes.length}]}));
    const chainLength=Buffer.alloc(4);chainLength.writeUInt32BE(chainHeader.length);
    selectedCipher=Buffer.concat([Buffer.from('TRELIOH1'),chainLength,chainHeader,bytes,acceptedRevisionBytes]);
    snapshot.workspace.acceptedHead=selectedHead;
    const materialProfile=await createAssistantWorkspaceProfile({identity:f.identity,host:f.host,client:f.client,store:f.store,
      materialWorkspaceId:descriptor.workspaceId,lockDirectory:path.join(os.tmpdir(),'synthetic-material-locks'),lock:(_file,action)=>action()});
    const {withAssistantEncryptedMaterial}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
    const {buildRuntimeSessionProof}=await import('../host-runtime/scripts/trelio-runtime-session.mjs');
    const {assistantEncryptedMaterialProofPayload,assistantEncryptedMaterialProofTool}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
    const completion={clientRequestId:randomUUID(),goalState:'waiting_external',cadence:'hourly',timeZone:'Europe/Moscow',
      workspaceId:descriptor.workspaceId,workspaceHead:selectedHead,acceptedRunId:runId,noChange:false,
      runtimeSessionProof:buildRuntimeSessionProof({state:f.runtime.state,toolName:'complete_assistant_pass'})};
    let completionCalls=0;
    const completed=await common.withWorkspaceExecutionProfile(materialProfile,()=>withAssistantEncryptedMaterial({args:completion},async wire=>{
      completionCalls++;
      assert.doesNotMatch(JSON.stringify(wire),/Verified material result|SYNTHETIC_ENCRYPTED_DELIVERABLE|privateKey|WORK\.md/u);
      const {runtimeSessionProof:proof,...facts}=wire.encryptedMaterialWitness;
      assert.equal(facts.cryptoDeviceId,cryptoDeviceId);assert.equal(facts.envelopeId,envelope.id);
      const manifest=assistantEncryptedMaterialProofPayload({...f.pass,...completion,...facts,references:[]});
      const tool=assistantEncryptedMaterialProofTool(digest(manifest));
      assert.equal(verify(null,Buffer.from(['trelio-runtime-proof-v1',proof.runtimeSessionId,tool,proof.issuedAt,proof.nonce].join('\n')),
        createPublicKey({key:Buffer.from(f.runtime.state.privateKeyPkcs8,'base64url'),format:'der',type:'pkcs8'}),Buffer.from(proof.signature,'base64url')),true);
      return {state:'confirmed'};
    },{withProfile:action=>action({...f,prepareWorkspaceMaterial:materialProfile.prepareWorkspaceMaterial})}));
    assert.equal(completed.state,'confirmed');assert.equal(completionCalls,1);
    const inspection=await common.withWorkspaceExecutionProfile(materialProfile,()=>common.inspectAcceptedWorkspace(f.identity.origin,{workspace:descriptor.workspaceId}));
    await common.validateAcceptedAssistantWorkState({inspection,assistantId:f.identity.assistantId,workspaceHead:selectedHead,previousHead:selectedHead});
    await assert.rejects(common.validateAcceptedAssistantWorkState({inspection,assistantId:f.identity.assistantId,workspaceHead:selectedHead,previousHead:head}),
      'old accepted head without this assistant state cannot attest noChange');
    await assert.rejects(withAssistantEncryptedMaterial({args:{...completion,encryptedMaterialWitness:{}}},()=>assert.fail('model witness must not be sent')));
    // Revoke during a fresh ciphertext read, after a previously legitimate
    // cache has been removed. Local materialization cannot publish success.
    mode='late-close';
    const file=path.join(directory,'result.md');if(process.platform!=='win32')await fs.chmod(file,0o600);
    await fs.writeFile(file,'tampered');await assert.rejects(run());
    console.log('ASSISTANT_ENCRYPTED_INSPECTION_VERIFIED');
  }finally{globalThis.fetch=savedFetch;}
});

test('encrypted local Workspace arguments reuse the SAME payload signature and HPKE codecs without publishing a field',async()=>{
  const {sealAssistantWorkspaceArguments,openAssistantWorkspaceArguments}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const f=await workspaceProfileFixture();
  const device=await f.profile.resolveCompanyEncryptionDevice({origin:f.identity.origin,companyId:f.pass.companyId});
  const pair=await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const publicEncryptionJwk=await webcrypto.subtle.exportKey('jwk',pair.publicKey),privateJwk=await webcrypto.subtle.exportKey('jwk',pair.privateKey);
  const cryptoDeviceId=randomUUID(),scopeId=randomUUID();
  const companyEncryption={device,runtime:{state:'encrypted',accessState:'ready',company:{id:f.pass.companyId},
    viewer:{userId:f.identity.assistantId},device:{id:cryptoDeviceId,fingerprint:device.fingerprint},
    scope:{id:scopeId,epoch:1,publicEncryptionJwk},
    envelope:{recipientType:'agent_device',recipientId:cryptoDeviceId,scopeId,scopeEpoch:1}},
    scopePrivateEncryptionKey:{privateKey:pair.privateKey,privateJwk}};
  const binding={operation:'checkpoint',runId:randomUUID(),workspaceId:randomUUID(),fencingToken:3,
    assistantUserId:f.identity.assistantId,deviceId:f.identity.deviceId,companyId:f.pass.companyId,taskId:f.pass.taskId,passId:f.pass.passId};
  const parameters={type:'draft',summary:'SYNTHETIC_PRIVATE_CHECKPOINT',evidence:['SYNTHETIC_PRIVATE_EVIDENCE']};
  const sealed=await sealAssistantWorkspaceArguments({binding,parameters,companyEncryption});
  assert.equal(JSON.stringify(sealed).includes(parameters.summary),false);
  assert.equal(JSON.stringify(sealed).includes(parameters.evidence[0]),false);
  assert.deepEqual(await openAssistantWorkspaceArguments({binding,sealed,companyEncryption}),parameters);
  // Different key ordering is the same binding; a changed pass/Run/action or
  // native fencing token is not. No raw value is carried by a refusal.
  const reordered=Object.fromEntries(Object.entries(binding).reverse());
  assert.deepEqual(await openAssistantWorkspaceArguments({binding:reordered,sealed,companyEncryption}),parameters);
  for(const changed of [{...binding,passId:randomUUID()},{...binding,runId:randomUUID()},
    {...binding,operation:'finish'},{...binding,fencingToken:4}])
    await assert.rejects(openAssistantWorkspaceArguments({binding:changed,sealed,companyEncryption}));
  for(const mutate of [value=>value.payload.signature='invalid',value=>value.payload.ciphertextSha256='0'.repeat(64),
    value=>value.payload.aad.companyId=randomUUID(),value=>value.payload.writerDeviceId=randomUUID(),
    value=>value.payload.unreviewed='extra']){
    const changed=structuredClone(sealed);mutate(changed);
    await assert.rejects(openAssistantWorkspaceArguments({binding,sealed:changed,companyEncryption}));
  }
  await assert.rejects(sealAssistantWorkspaceArguments({binding,parameters,
    companyEncryption:{...companyEncryption,runtime:{...companyEncryption.runtime,viewer:{userId:randomUUID()}}}}));
  await assert.rejects(sealAssistantWorkspaceArguments({binding,parameters:{summary:'x'.repeat(1024*1024+1)},companyEncryption}));
});

test('ordinary continuation protects prose before MCP and restores it only inside the SAME managed pass',async()=>{
  const {withAssistantEncryptedWorkspaceArguments}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const {canonicalJson}=await import('../host-runtime/scripts/trelio-company-encryption.mjs');
  const f=await workspaceProfileFixture({workspaceRun:true});
  const managed=await f.profile.resolveCompanyEncryptionDevice({origin:f.identity.origin,companyId:f.pass.companyId});
  const pair=await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const publicJwk=await webcrypto.subtle.exportKey('jwk',pair.publicKey),privateJwk=await webcrypto.subtle.exportKey('jwk',pair.privateKey);
  const cryptoDeviceId=randomUUID(),scopeId=randomUUID(),company={id:f.pass.companyId,slug:'encrypted',name:'Synthetic'};
  const aad={suite:'trelio-e2ee-v1',companyId:company.id,scopeId,scopeEpoch:1,recipientType:'agent_device',recipientId:cryptoDeviceId};
  const hpke=await hpkeSeal({recipientPublicEncryptionJwk:managed.publicEncryptionJwk,
    plaintext:Buffer.from(JSON.stringify({suite:'trelio-e2ee-v1',version:1,scopePrivateEncryptionJwk:privateJwk})),aad});
  const envelope={id:randomUUID(),...aad,hpkeEnc:hpke.enc,ciphertext:hpke.ciphertext,aad};
  const previous=globalThis.fetch;let remoteCalls=0,mode='valid';
  const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  globalThis.fetch=async url=>{
    url=new URL(url);
    if(url.pathname.endsWith('/bridge-routing'))return json({schemaVersion:1,company,encryptionState:'encrypted',encryptedDataPlaneOrigin:'https://e2ee.trelio.ru'});
    if(url.pathname.endsWith('/encryption/runtime')){
      const found=url.searchParams.has('fingerprint');
      return json({state:'encrypted',suite:'trelio-e2ee-v1',company,viewer:{userId:f.identity.assistantId},accessState:found?'ready':'device_required',
        device:found?{id:cryptoDeviceId,fingerprint:managed.fingerprint}:null,scope:found?{id:scopeId,epoch:1,publicEncryptionJwk:publicJwk}:null,envelope:found?envelope:null});
    }
    assert.equal(url.origin,'https://e2ee.trelio.ru');
    assert.equal(url.pathname,`/api/digital-assistants/runtime/workspace/workspaces/${f.runIdentity.workspaceId}/runs/${f.runIdentity.runId}`);
    return json({schemaVersion:1,context:{run:{id:f.runIdentity.runId,workspaceId:f.runIdentity.workspaceId,status:'running',fencingToken:3}},encryptedPayloads:[]});
  };
  const scope={companyId:f.pass.companyId,taskId:f.pass.taskId,passId:f.pass.passId,assistantUserId:f.identity.assistantId,deviceId:f.identity.deviceId};
  const args={schemaVersion:1,operation:'checkpoint',runIdentity:f.runIdentity,parameters:{type:'draft',summary:'SYNTHETIC_PRIVATE_SUMMARY'}};
  const options={withProfile:action=>withWorkspaceExecutionProfile(f.profile,()=>action({...f,prepareWorkspaceRun:f.profile.prepareWorkspaceRun}))};
  const send=async wire=>{
    remoteCalls++;assert.equal(JSON.stringify(wire).includes(args.parameters.summary),false);
    // Native schema parsing/JSON serialization may rebuild every object in a
    // different key order. Exercise that real boundary instead of echoing the
    // same in-memory fixture DTO and hiding an insertion-order comparison bug.
    const parameters=JSON.parse(canonicalJson(wire.parameters));
    assert.notEqual(JSON.stringify(parameters),JSON.stringify(wire.parameters));
    if(mode==='tamper')parameters.encryptedArguments.payload.signature='invalid';
    if(mode==='extra')parameters.extra='SYNTHETIC_UNEXPECTED_FIELD';
    return {content:[{type:'text',text:'opaque native plan'}],structuredContent:{prepared:true,scope,
      encryptedLifecycle:{schemaVersion:1,companyId:company.id,companySlug:company.slug,requestOrigin:'https://e2ee.trelio.ru',workspaceId:f.runIdentity.workspaceId},
      localAction:{schemaVersion:1,operation:wire.operation,runIdentity:wire.runIdentity,parameters}}};
  };
  try{
    const result=await withAssistantEncryptedWorkspaceArguments({name:'continue_assistant_workspace_action',args},send,options);
    assert.deepEqual(result.structuredContent.localAction.parameters,args.parameters);
    mode='tamper';await assert.rejects(withAssistantEncryptedWorkspaceArguments({name:'continue_assistant_workspace_action',args},send,options));
    assert.equal(remoteCalls,2,'one remote call per explicit request, no mutation retry');
    mode='extra';await assert.rejects(withAssistantEncryptedWorkspaceArguments({name:'continue_assistant_workspace_action',args},send,options));
    assert.equal(remoteCalls,3,'ignoring object order never admits additional fields');
    f.close();await assert.rejects(withAssistantEncryptedWorkspaceArguments({name:'continue_assistant_workspace_action',args},send,options));
    assert.equal(remoteCalls,3,'a closed pass refuses before remote company content I/O');
  }finally{globalThis.fetch=previous;}
});

test('common encryption refuses a managed profile without its own keys after native discovery and before a human unlock',async()=>{
  const original=globalThis.fetch;let requests=0,forms=0;
  globalThis.fetch=async()=>{requests++;return new Response(JSON.stringify({state:'encrypted',suite:'trelio-e2ee-v1',
    company:{id:randomUUID(),slug:'synthetic'},viewer:{userId:randomUUID()}}),{headers:{'content-type':'application/json'}});};
  try{
    const profile={requireToken:async()=>({}),prepareRequest:async({origin,pathname,options})=>({url:new URL(pathname,origin),headers:new Headers(),options})};
    await withWorkspaceExecutionProfile(profile,()=>assert.rejects(ensureCompanyEncryptionContext({
      origin:'https://assistant.test',token:{},company:{slug:'synthetic'},
      collectEncryptionKey:async()=>{forms++;throw new Error('human form must not open');},
    }),error=>error.code==='ASSISTANT_WORKSPACE_PROFILE_DENIED'));
    assert.equal(requests,1);assert.equal(forms,0);
  }finally{globalThis.fetch=original;}
});

test('assistant profile reuses the native HTTP engine with private auth and one-use operation proofs',async()=>{
  const f=await workspaceProfileFixture(), originalFetch=globalThis.fetch, seen=[];
  globalThis.fetch=async(url,options)=>{
    seen.push({url,options});return new Response('{}',{headers:{'content-type':'application/json'}});
  };
  try {
    await withWorkspaceExecutionProfile(f.profile,async()=>{
      const token=await nativeWorkspaceToken(f.identity.origin);
      assert.equal(typeof token,'object');assert.ok(!JSON.stringify(token).includes(f.credential));
      const route='/api/agent-workspaces/runs/'+randomUUID()+'/candidate';
      await nativeWorkspaceRequest(f.identity.origin,token,route,{method:'POST',body:'immutable bundle',
        headers:{authorization:'Bearer UNTRUSTED',cookie:'UNTRUSTED','x-trelio-assistant-pass':'UNTRUSTED','x-trelio-assistant-proof':'UNTRUSTED'}});
      await nativeWorkspaceRequest(f.identity.origin,token,route,{method:'POST',body:'immutable bundle'});
      const nonces=new Set();
      for(const {url,options} of seen){
        assert.equal(url.origin,f.identity.origin);assert.ok(url.pathname.startsWith('/api/digital-assistants/runtime/workspace/'));
        assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.body,'immutable bundle');
        assert.equal(options.headers.get('cookie'),null);
        assert.equal(options.headers.get('authorization'),'Bearer '+f.credential);
        assert.deepEqual(JSON.parse(options.headers.get('x-trelio-assistant-pass')),{companyId:f.pass.companyId,taskId:f.pass.taskId,passId:f.pass.passId});
        const proof=JSON.parse(options.headers.get('x-trelio-assistant-proof'));
        assert.equal(verify(null,Buffer.from(['trelio-runtime-proof-v1',proof.runtimeSessionId,'assistant_workspace_data_plane_candidate',proof.issuedAt,proof.nonce].join('\n')),
          f.keys.publicKey,Buffer.from(proof.signature,'base64url')),true);
        assert.ok(!JSON.stringify(proof).includes('privateKeyPkcs8'));nonces.add(proof.nonce);
      }
      assert.equal(nonces.size,2);assert.equal(f.contacts(),2);
      // Unknown routes/origins are refused before private access and HTTP.
      await assert.rejects(nativeWorkspaceRequest('https://other.test',token,route),/ORIGIN_DENIED/);
      for(const bad of ['/api/agent-workspaces/runs/id/cancel','/api/agent-workspaces/bridge-pairings','/api/agent-workspaces/runs/../candidate']){
        await assert.rejects(nativeWorkspaceRequest(f.identity.origin,token,bad));
      }
      assert.equal(seen.length,2);assert.equal(f.contacts(),2);
      assert.throws(()=>withWorkspaceExecutionProfile({...f.profile},async()=>{}),/profile is unavailable/);
    });
    assert.equal(currentWorkspaceExecutionProfile(),null);
    // A parallel/sequential ordinary call retains its original native path
    // and synthetic human auth, rather than inheriting this device's profile.
    await nativeWorkspaceRequest(f.identity.origin,'synthetic-human','/api/agent-workspaces/bridge-compatibility');
    assert.equal(seen.at(-1).url.pathname,'/api/agent-workspaces/bridge-compatibility');
    assert.equal(seen.at(-1).options.headers.get('authorization'),'Bearer synthetic-human');
  } finally {globalThis.fetch=originalFetch;}
});

test('assistant Workspace request refuses ended sessions, rebind and closed passes before mutation; no retry',async()=>{
  const f=await workspaceProfileFixture(), originalFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('synthetic network failure');};
  const slot={origin:f.identity.origin,kind:'runtime',id:f.pass.passId};
  try {
    await withWorkspaceExecutionProfile(f.profile,async()=>{
      const token=await nativeWorkspaceToken(f.identity.origin), route='/api/agent-workspaces/runs/'+randomUUID()+'/heartbeat';
      await assert.rejects(nativeWorkspaceRequest(f.identity.origin,token,route,{method:'POST'}));
      assert.equal(calls,1,'an uncertain native mutation is not repeated');
      await f.store.put(slot,{...f.runtime,ended:true});
      await assert.rejects(nativeWorkspaceRequest(f.identity.origin,token,route,{method:'POST'}),/SESSION_REQUIRED/);
      assert.equal(calls,1);
      await f.store.put(slot,f.runtime);
      f.changeIdentity({...f.identity,deviceId:randomUUID()});
      await assert.rejects(nativeWorkspaceRequest(f.identity.origin,token,route,{method:'POST'}),/BINDING_CHANGED/);
      f.changeIdentity(f.identity);f.changePass({...f.pass,passId:randomUUID()});
      await assert.rejects(nativeWorkspaceRequest(f.identity.origin,token,route,{method:'POST'}),/BINDING_CHANGED/);
      f.changePass(f.pass);f.close();
      await assert.rejects(nativeWorkspaceRequest(f.identity.origin,token,route,{method:'POST'}),/REVIEW_REQUIRED/);
      assert.equal(calls,1);
    });
  }finally{globalThis.fetch=originalFetch;}
});


test('parallel human requests are isolated and expired child async resources cannot fall back to human auth',async()=>{
  const f=await workspaceProfileFixture(), originalFetch=globalThis.fetch,seen=[];let child;
  globalThis.fetch=async(url,options)=>{seen.push({url,authorization:options.headers.get('authorization')});return new Response('{}');};
  let release,entered;const barrier=new Promise(resolve=>{release=resolve;}), ready=new Promise(resolve=>{entered=resolve;});
  try{
    const pending=withWorkspaceExecutionProfile(f.profile,async()=>{
      child=new AsyncResource('assistant-workspace-fixture');entered();await barrier;
      const token=await nativeWorkspaceToken(f.identity.origin);
      await nativeWorkspaceRequest(f.identity.origin,token,'/api/agent-workspaces/bridge-compatibility');
    });
    await ready;
    await nativeWorkspaceRequest(f.identity.origin,'synthetic-human','/api/agent-workspaces/bridge-compatibility');
    release();await pending;
    assert.equal(seen[0].url.pathname,'/api/agent-workspaces/bridge-compatibility');
    assert.equal(seen[0].authorization,'Bearer synthetic-human');
    assert.ok(seen[1].url.pathname.startsWith('/api/digital-assistants/runtime/workspace/'));
    assert.throws(()=>child.runInAsyncScope(()=>currentWorkspaceExecutionProfile()),/profile is unavailable/);
    assert.equal(currentWorkspaceExecutionProfile(),null);
  }finally{release();child?.emitDestroy();globalThis.fetch=originalFetch;}
});


test('assistant protected bootstrap specializes human-only clauses and never reads the human unfiled vault',async()=>{
  const common=await import('../host-runtime/scripts/trelio-workspace.mjs');
  const {readUnfiledResponseContext}=await import('../host-runtime/scripts/trelio-unfiled-context.mjs');
  const human=common.buildAgentWorkspaceRuntimeAgentsMarkdown();
  assert.equal(human,common.AGENT_WORKSPACE_RUNTIME_AGENTS_MARKDOWN);
  const assistant=common.buildAgentWorkspaceRuntimeAgentsMarkdown('WORKSPACE_CONTEXT.md',{assistant:true});
  assert.ok(assistant.includes('continue_assistant_workspace_action'));assert.ok(assistant.includes('complete_assistant_pass'));
  assert.ok(!assistant.includes('through `continue_trelio_workspace_action`'));
  assert.ok(!assistant.includes('`get_task_review_context`'));assert.ok(assistant.includes('pinned ../context/agent-instructions.md'));
  const profile={kind:'digital_assistant',requireToken:async()=>({}),prepareRequest:async()=>assert.fail('queue attempted HTTP')};
  const result=await common.withWorkspaceExecutionProfile(profile,()=>readUnfiledResponseContext('https://trelio.ru','fixture',{bridge:{
    currentWorkspaceExecutionProfile:common.currentWorkspaceExecutionProfile,
    readExistingBridgeSessionToken:async()=>assert.fail('assistant attempted human vault'),
  }}));
  assert.equal(result,undefined);
});


test('live assistant schema projection hides hook-owned required fields without copying domain validators',async()=>{
  const {assistantModelInputSchema}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const wire={type:'object',additionalProperties:false,required:['clientRequestId','taskPass'],properties:{
    clientRequestId:{type:'string',format:'uuid'},taskPass:{type:'object',required:['passId'],properties:{passId:{type:'string'}}},
    runtimeSessionProof:{type:'object'},parameters:{type:'object',properties:{summary:{type:'string',maxLength:16000}}},
  }};
  const snapshot=structuredClone(wire),model=assistantModelInputSchema(wire);
  assert.deepEqual(model.required,['clientRequestId']);assert.deepEqual(Object.keys(model.properties),['clientRequestId','parameters']);
  assert.deepEqual(model.properties.parameters,wire.properties.parameters);assert.equal(model.additionalProperties,false);
  assert.deepEqual(wire,snapshot,'the current backend schema remains the exact validation authority');
});


test('accepted cache resolver isolates actual assistant/device/task identity and refuses changed binding',async()=>{
  const {resolveWorkspaceInspectionDirectory}=await import('../host-runtime/scripts/trelio-workspace.mjs');
  const f=await workspaceProfileFixture(),g=await workspaceProfileFixture(),config=path.join(os.tmpdir(),'synthetic-config');
  const first=await f.profile.resolveInspectionDirectory(config);
  const {assistantTaskStorageDirectory}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  assert.equal(first,path.join(assistantTaskStorageDirectory(config,{...f.identity,companyId:f.pass.companyId,taskId:f.pass.taskId}),'inspections'));
  assert.notEqual(first,await g.profile.resolveInspectionDirectory(config));
  const human=await resolveWorkspaceInspectionDirectory();
  await withWorkspaceExecutionProfile(f.profile,async()=>assert.notEqual(await resolveWorkspaceInspectionDirectory(),human));
  await assert.rejects(withWorkspaceExecutionProfile({kind:'digital_assistant',requireToken:async()=>{},prepareRequest:async()=>{}},
    resolveWorkspaceInspectionDirectory),error=>error.code==='ASSISTANT_WORKSPACE_PROFILE_DENIED');
  f.changeIdentity({...f.identity,deviceId:randomUUID()});
  await assert.rejects(f.profile.resolveInspectionDirectory(config),error=>error.code==='ASSISTANT_WORKSPACE_BINDING_CHANGED');
});


test('accepted read is exposed as read-only while continuation remains a guarded write boundary',()=>{
  assert.ok(ASSISTANT_MCP_READ_TOOLS.includes('prepare_assistant_workspace_read'));
  assert.ok(!ASSISTANT_MCP_READ_TOOLS.includes('continue_assistant_workspace_action'));
});


test('owner dialogue tools use live backend schemas and poll projection keeps only a validated question UUID', async () => {
  const {ASSISTANT_MCP_READ_TOOLS,ASSISTANT_MCP_TOOLS}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  assert.ok(ASSISTANT_MCP_READ_TOOLS.includes('get_assistant_owner_question'));
  assert.ok(ASSISTANT_MCP_TOOLS.includes('ask_assistant_owner'));
  assert.ok(!ASSISTANT_MCP_READ_TOOLS.includes('ask_assistant_owner'));
  assert.ok(ASSISTANT_MCP_TOOLS.includes('request_assistant_action'));
  assert.ok(!ASSISTANT_MCP_READ_TOOLS.includes('request_assistant_action'));
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),companyId=randomUUID(),questionId=randomUUID();
  const store=memoryStore();await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'a'.repeat(43)}`,expiresAt:10000});
  const event={id:randomUUID(),revision:'1',taskId:randomUUID(),wake:true,bindingId:randomUUID(),bindingRevision:0,taskState:'accepted',ownerQuestionId:questionId};
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,now:()=>100,http:async()=>({events:[{...event,answerText:'PRIVATE ANSWER'}],nextCursor:'1',hasMore:false})});
  assert.deepEqual((await client.poll(companyId)).events,[event]);
  event.ownerQuestionId='PRIVATE QUESTION';await assert.rejects(client.poll(companyId));
});


test('compact task storage binds every identity without a long concatenated cwd',async()=>{
  const {assistantTaskStorageDirectory}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const config=path.join(os.tmpdir(),'synthetic-config'),scope={origin:'https://trelio.ru',assistantId:randomUUID(),deviceId:randomUUID(),companyId:randomUUID(),taskId:randomUUID()};
  const root=assistantTaskStorageDirectory(config,scope);
  assert.equal(path.relative(config,root).split(path.sep).at(-1).length,64);
  for(const key of ['assistantId','deviceId','companyId','taskId'])assert.notEqual(root,assistantTaskStorageDirectory(config,{...scope,[key]:randomUUID()}));
  assert.notEqual(root,assistantTaskStorageDirectory(config,{...scope,origin:'https://other.example'}));
  assert.equal(root,assistantTaskStorageDirectory(config,{...scope,assistantId:scope.assistantId.toUpperCase()}));
});

// The same private local attachment primitive serves both actor profiles. The
// fixture replaces only HTTP/auth plumbing, never filesystem publication/ACL.
test('assistant original file uses fixed binary delivery, exact digest and native private local storage', async () => {
  const fs=await import('node:fs/promises'),{createHash}=await import('node:crypto');
  const common=await import('../host-runtime/scripts/trelio-workspace.mjs');
  const attachments=await import('../host-runtime/scripts/trelio-local-attachments.mjs');
  const {materializeAssistantAttachment}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-original-file-'));
  const bytes=Buffer.from('Exact original bytes\n'),attachmentId=randomUUID(),taskId=randomUUID();
  const descriptor={schemaVersion:1,delivery:'assistant-local-file',taskId,attachmentId,originalName:'../../private.txt',mimeType:'text/plain',
    sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),revision:'b'.repeat(64)};
  let requests=0,publications=0,profile=true,body=bytes,headers={};
  const http={...common,currentWorkspaceExecutionProfile:()=>profile?{kind:'digital_assistant'}:null,
    requireToken:async()=>Object.freeze({}),request:async(origin,_token,pathname,options)=>{
      requests++;assert.equal(origin,'https://assistant.test');
      assert.equal(pathname,`/api/agent-workspaces/scopes/task/${taskId}/attachments/${attachmentId}?revision=${descriptor.revision}`);
      assert.equal(options.maximumErrorResponseBytes,16*1024);
      return new Response(body,{headers:{'content-type':'application/octet-stream','content-length':String(bytes.length),
        'x-trelio-attachment-sha256':descriptor.sha256,'x-trelio-attachment-revision':descriptor.revision,...headers}});
    }};
  const local={...attachments,materializeLocalAttachment:async value=>{publications++;return attachments.materializeLocalAttachment({...value,root});}};
  const input={result:{structuredContent:descriptor,content:[{type:'text',text:'REMOTE_PRIVATE_BYTES_NEVER_FORWARD'}]},
    attachmentId,origin:'https://assistant.test',common:http,attachments:local};
  try{
    const result=await materializeAssistantAttachment(input),file=result.structuredContent;
    assert.equal(file.delivery,'local-file');assert.equal(file.sha256,descriptor.sha256);
    assert.deepEqual(await fs.readFile(file.localFilePath),bytes);
    assert.ok(file.localFilePath.startsWith(root+path.sep));assert.equal(path.basename(file.localFilePath),'attachment.txt');
    if(process.platform!=='win32')assert.equal((await fs.stat(file.localFilePath)).mode&0o777,0o600);
    assert.doesNotMatch(JSON.stringify(result),/REMOTE_PRIVATE_BYTES_NEVER_FORWARD|dataBase64|downloadUrl/);
    assert.equal(publications,1);
    // A wrong/short body or dishonest response metadata never creates a file.
    for(const wrong of [Buffer.from('wrong bytes'),bytes.subarray(0,1)]){
      body=wrong;await assert.rejects(materializeAssistantAttachment(input),/SOURCE_CHANGED/);
    }
    body=bytes;headers={'content-length':'999999999'};
    await assert.rejects(materializeAssistantAttachment(input),/SOURCE_CHANGED/);headers={};
    profile=false;const before=requests;await assert.rejects(materializeAssistantAttachment(input),/PROFILE_DENIED/);
    assert.equal(requests,before,'no active device profile cannot select the human vault');profile=true;
    for(const changes of [{downloadUrl:'https://untrusted.test/file'},{sizeBytes:attachments.LOCAL_ATTACHMENT_MAX_BYTES+1},{attachmentId:randomUUID()}]){
      await assert.rejects(materializeAssistantAttachment({...input,result:{...input.result,structuredContent:{...descriptor,...changes}}}),/DESCRIPTOR_INVALID/);
    }
    assert.equal(publications,1);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('plain company original Workspace file composes actual production MCP callback and common downloader without human keys',async()=>{
  if(process.env.TRELIO_ASSISTANT_PLAIN_FILE_FIXTURE!=='1'){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-plain-file-process-'));
    const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{fileURLToPath}=await import('node:url');
    const childEnv={...process.env,HOME:root,USERPROFILE:root,LOCALAPPDATA:path.join(root,'AppData','Local'),
      TRELIO_WORKSPACE_DISABLE_KEYCHAIN:'1',TRELIO_ASSISTANT_PLAIN_FILE_FIXTURE:'1'};delete childEnv.NODE_TEST_CONTEXT;
    try{const result=await promisify(execFile)(process.execPath,['--test','--test-name-pattern','plain company original Workspace file',fileURLToPath(import.meta.url)],
      {env:childEnv,timeout:30000,maxBuffer:1024*1024});assert.match(result.stdout,/ASSISTANT_PLAIN_SOURCE_FILE_VERIFIED/);
    }catch(error){throw new Error(String(error.stdout??'').split('\n').filter(line=>/error:|code:|not ok|Expected|actual|expected/.test(line)).slice(0,15).join('\n')||'Plain source file child failed');}
    finally{await fs.rm(root,{recursive:true,force:true});}return;
  }
  const common=await import('../host-runtime/scripts/trelio-workspace.mjs');
  const {materializeProductionAssistantCompanyFile}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const f=await workspaceProfileFixture(),workspaceId=randomUUID(),workspaceHead='b'.repeat(40),filePath='sources/original.pdf';
  const bytes=Buffer.from('PLAIN_ORIGINAL_SOURCE_BYTES\0'),rulesMarkdown='Synthetic shared platform rule',rulesId=randomUUID(),
    rulesSha=createHash('sha256').update(rulesMarkdown).digest('hex');
  let mode='plain',stale=false,late=false,fileReads=0,sourceProfiles=0;const requests=[];
  f.client.companies=async()=>[{companyId:f.pass.companyId,encryptionState:mode}];
  const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    url=new URL(url);requests.push(url.pathname);assert.equal(options.headers.get('authorization'),`Bearer ${f.credential}`);
    assert.equal(options.headers.get('cookie'),null);const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
    if(url.pathname.endsWith('/bridge-compatibility'))return json({supported:true,agentRules:{status:options.headers.get('x-trelio-agent-rules-sha256')===rulesSha?'current':'update_required',
      revisionId:rulesId,version:1,sha256:rulesSha,rulesMarkdown}});
    if(url.pathname.endsWith('/read-snapshot'))return json({company:{id:f.pass.companyId,slug:'synthetic'},workspace:{id:workspaceId,acceptedHead:stale?'a'.repeat(40):workspaceHead},
      agentInstructionsSnapshot:{compiledMarkdown:'SOURCE_READ_AUTHORITY'},userProfileSnapshot:null});
    assert.equal(url.pathname,`/api/digital-assistants/runtime/workspace/workspaces/${workspaceId}/file`);
    assert.equal(url.searchParams.get('head'),workspaceHead);assert.equal(url.searchParams.get('path'),filePath);fileReads++;
    if(late)f.close();return new Response(bytes,{headers:{'x-trelio-accepted-head':workspaceHead,'content-type':'application/pdf'}});
  };
  const withProfile=async(action,options={})=>{
    const profile=options.sourceWorkspaceFile?await createAssistantWorkspaceProfile({identity:f.identity,host:f.host,client:f.client,store:f.store,
      sourceWorkspaceFile:options.sourceWorkspaceFile,lockDirectory:os.tmpdir(),lock:(_file,callback)=>callback()}):f.profile;
    if(options.sourceWorkspaceFile)sourceProfiles++;
    return withWorkspaceExecutionProfile(profile,()=>action({identity:f.identity,readCompanyContentMode:profile.readCompanyContentMode,
      assertPlainSourceFileRead:profile.assertPlainSourceFileRead}));
  };
  try{
    const args={workspaceId,workspaceHead,filePath,delivery:'local-file'};
    const nativeResult={content:[],structuredContent:{delivery:'local-file',bridge:{action:{arguments:{schemaVersion:1,operation:'download_file',
      parameters:{workspaceId,workspaceHead,filePath}}}}}};
    const read=(result=nativeResult)=>materializeProductionAssistantCompanyFile({identity:f.identity,result,arguments:args,withProfile});
    const result=await read();
    assert.deepEqual(await fs.readFile(result.structuredContent.localFilePath),bytes);assert.equal(sourceProfiles,1);assert.equal(fileReads,1);
    assert.equal(result.structuredContent.agentInstructionsSnapshot.compiledMarkdown,'SOURCE_READ_AUTHORITY');
    assert.equal(requests.some(value=>value.includes('/encryption/')||value.includes('/payloads/resolve')),false,'plain source never discovers human keys');
    assert.deepEqual(await f.host.readActivePass(),f.pass);
    await assert.rejects(read({...nativeResult,structuredContent:{...nativeResult.structuredContent,bridge:{action:{arguments:{schemaVersion:1,operation:'download_file',parameters:{workspaceId:randomUUID(),workspaceHead,filePath}}}}}}),{code:'ASSISTANT_MCP_INVALID_RESPONSE'});
    stale=true;await assert.rejects(read(),/WORKSPACE_OUTDATED/);assert.equal(fileReads,1);stale=false;
    late=true;await assert.rejects(read(),/PASS_REVIEW_REQUIRED/);
    console.log('ASSISTANT_PLAIN_SOURCE_FILE_VERIFIED');
  }finally{globalThis.fetch=original;f.close();}
});

test('company registry slot reuses the fixed private-file profile and refuses sibling, mode and late-pass changes',async()=>{
  const common=await import('../host-runtime/scripts/trelio-workspace.mjs'),attachments=await import('../host-runtime/scripts/trelio-local-attachments.mjs');
  const {materializeAssistantAttachment}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const f=await workspaceProfileFixture(),root=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-registry-file-'));
  let mode='plain',late=false,requests=0,publications=0;
  f.client.companies=async()=>[{companyId:f.pass.companyId,encryptionState:mode}];
  const selection={registryId:randomUUID(),rowId:randomUUID(),expectedRowRevision:3,columnKey:'documents',documentIndex:0};
  const bytes=Buffer.from('PUBLISHED_ONE_FILE_CANARY'),descriptor={schemaVersion:1,delivery:'assistant-registry-local-file',companyId:f.pass.companyId,
    companySlug:'synthetic',...selection,originalName:'published.txt',mimeType:'text/plain',sizeBytes:bytes.length,
    sha256:createHash('sha256').update(bytes).digest('hex'),revision:'b'.repeat(64)};
  const profile=await createAssistantWorkspaceProfile({identity:f.identity,host:f.host,client:f.client,store:f.store,
    sourceRegistryDocument:descriptor,lockDirectory:root,lock:(_file,action)=>action()});
  const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    requests++;url=new URL(url);assert.equal(url.origin,f.identity.origin);
    assert.equal(url.pathname,`/api/digital-assistants/runtime/workspace/company-context/synthetic/registry-documents/${selection.registryId}/${selection.rowId}/documents/0`);
    assert.equal(url.searchParams.get('rowRevision'),'3');assert.equal(url.searchParams.get('revision'),descriptor.revision);
    assert.equal(JSON.parse(options.headers.get('x-trelio-assistant-pass')).taskId,f.pass.taskId);
    if(late)f.close();
    return new Response(bytes,{headers:{'content-type':'application/octet-stream','content-length':String(bytes.length),
      'x-trelio-attachment-sha256':descriptor.sha256,'x-trelio-attachment-revision':descriptor.revision}});
  };
  const local={...attachments,materializeLocalAttachment:async input=>{publications++;return attachments.materializeLocalAttachment({...input,root});}};
  const run=(changes={})=>withWorkspaceExecutionProfile(profile,()=>materializeAssistantAttachment({origin:f.identity.origin,
    result:{content:[],structuredContent:{...descriptor,...changes}},registryDocument:selection,common,attachments:local,
    assertCurrent:()=>profile.assertCompanyContextCurrent()}));
  try{
    const result=await run();assert.deepEqual(await fs.readFile(result.structuredContent.localFilePath),bytes);assert.equal(publications,1);
    for(const change of [{rowId:randomUUID()},{documentIndex:1},{workspaceId:randomUUID()},{downloadUrl:'https://foreign.test'}])await assert.rejects(run(change));
    const token=await profile.requireToken(f.identity.origin),before=requests;
    await assert.rejects(profile.prepareRequest({origin:f.identity.origin,token,
      pathname:`/api/agent-workspaces/workspaces/${randomUUID()}/read-snapshot`,options:{},buildHeaders:()=>({})}),/ORIGIN_DENIED/);
    mode='encrypted';await assert.rejects(run(),/ENCRYPTED_CONTENT_REQUIRED/);assert.equal(requests,before);mode='plain';
    late=true;await assert.rejects(run(),/PASS_REVIEW_REQUIRED/);assert.equal(publications,1);
  }finally{globalThis.fetch=original;f.close();await fs.rm(root,{recursive:true,force:true});}
});

test('knowledge-page original uses the fixed plain source profile and common private file writer',async()=>{
  const common=await import('../host-runtime/scripts/trelio-workspace.mjs'),attachments=await import('../host-runtime/scripts/trelio-local-attachments.mjs');
  const {materializeAssistantAttachment}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const f=await workspaceProfileFixture(),root=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-knowledge-file-'));
  f.client.companies=async()=>[{companyId:f.pass.companyId,encryptionState:'plain'}];
  const selection={pageId:randomUUID(),attachmentId:randomUUID()},bytes=Buffer.from('KNOWLEDGE_PLAIN_ORIGINAL');
  const descriptor={schemaVersion:1,delivery:'assistant-knowledge-local-file',companyId:f.pass.companyId,companySlug:'synthetic',
    knowledgePageId:selection.pageId,attachmentId:selection.attachmentId,originalName:'knowledge.txt',mimeType:'text/plain',sizeBytes:bytes.length,
    sha256:createHash('sha256').update(bytes).digest('hex'),revision:'c'.repeat(64)};
  const profile=await createAssistantWorkspaceProfile({identity:f.identity,host:f.host,client:f.client,store:f.store,
    sourceAttachment:descriptor,lockDirectory:root,lock:(_file,action)=>action()});
  const original=globalThis.fetch;let reads=0;
  globalThis.fetch=async(url,options)=>{reads++;url=new URL(url);
    assert.equal(url.pathname,`/api/digital-assistants/runtime/workspace/company-context/synthetic/knowledge-pages/${selection.pageId}/attachments/${selection.attachmentId}`);
    assert.equal(JSON.parse(options.headers.get('x-trelio-assistant-pass')).taskId,f.pass.taskId);
    return new Response(bytes,{headers:{'content-type':'application/octet-stream','content-length':String(bytes.length),
      'x-trelio-attachment-sha256':descriptor.sha256,'x-trelio-attachment-revision':descriptor.revision}});};
  const run=knowledgeAttachment=>withWorkspaceExecutionProfile(profile,()=>materializeAssistantAttachment({origin:f.identity.origin,
    result:{content:[],structuredContent:descriptor},attachmentId:selection.attachmentId,knowledgeAttachment,common,
    attachments:{...attachments,materializeLocalAttachment:input=>attachments.materializeLocalAttachment({...input,root})},
    assertCurrent:()=>profile.assertCompanyContextCurrent()}));
  try{const result=await run(selection);assert.deepEqual(await fs.readFile(result.structuredContent.localFilePath),bytes);
    await assert.rejects(run({...selection,pageId:randomUUID()}));assert.equal(reads,1);
    assert.deepEqual(await f.host.readActivePass(),f.pass);
  }finally{globalThis.fetch=original;f.close();await fs.rm(root,{recursive:true,force:true});}
});

test('encrypted original attachment reuses genuine managed HPKE and SAME local-file delivery for both native AAD namespaces',async()=>{
  const common=await import('../host-runtime/scripts/trelio-workspace.mjs');
  const attachments=await import('../host-runtime/scripts/trelio-local-attachments.mjs');
  const {materializeAssistantAttachment}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const f=await workspaceProfileFixture({encryptedAttachment:true}),scopeId=randomUUID(),cryptoDeviceId=randomUUID();
  // Enrollment is NOT performed by download: this memory store represents an
  // already enrolled managed device, independently from its native recipient.
  const managed=await f.profile.resolveCompanyEncryptionDevice({origin:f.identity.origin,companyId:f.pass.companyId});
  const pair=await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const publicJwk=await webcrypto.subtle.exportKey('jwk',pair.publicKey),privateJwk=await webcrypto.subtle.exportKey('jwk',pair.privateKey);
  const envelopeAad={suite:'trelio-e2ee-v1',companyId:f.pass.companyId,scopeId,scopeEpoch:1,recipientType:'agent_device',recipientId:cryptoDeviceId};
  const sealed=await hpkeSeal({recipientPublicEncryptionJwk:managed.publicEncryptionJwk,
    plaintext:Buffer.from(JSON.stringify({suite:'trelio-e2ee-v1',version:1,scopePrivateEncryptionJwk:privateJwk})),aad:envelopeAad});
  const envelope={id:randomUUID(),...envelopeAad,hpkeEnc:sealed.enc,ciphertext:sealed.ciphertext,aad:envelopeAad};
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-encrypted-original-')),source=path.join(root,'source.txt');
  const secret=Buffer.from('PRIVATE_ORIGINAL_ATTACHMENT_CANARY');await fs.writeFile(source,secret,{mode:0o600});
  const savedFetch=globalThis.fetch;let selected,body,mode='valid',downloads=0,writes=0;
  const materializer={...attachments,materializeLocalAttachment:async input=>{writes++;return attachments.materializeLocalAttachment({...input,root:path.join(root,'downloads')});}};
  globalThis.fetch=async(url,options)=>{
    url=new URL(url);assert.equal(options.headers.get('authorization'),`Bearer ${f.credential}`);
    assert.equal(options.headers.get('cookie'),null);assert.equal(options.redirect,'error');
    const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
    if(url.pathname==='/api/digital-assistants/runtime/encryption/runtime'){
      assert.equal(url.origin,f.identity.origin);assert.equal(options.headers.get('x-trelio-assistant-encryption-device'),null);
      const found=url.searchParams.has('fingerprint');
      return json({state:'encrypted',suite:'trelio-e2ee-v1',company:{id:f.pass.companyId,slug:'encrypted',name:'Synthetic'},viewer:{userId:f.identity.assistantId},
        accessState:found?'ready':'device_required',device:found?{id:cryptoDeviceId,fingerprint:managed.fingerprint}:null,
        scope:found?{id:scopeId,epoch:mode==='epoch'?2:1,publicEncryptionJwk:publicJwk}:null,envelope:found?envelope:null});
    }
    assert.equal(url.origin,'https://e2ee.trelio.ru');assert.equal(url.pathname,selected.knowledgePageId?`/api/digital-assistants/runtime/workspace/company-context/encrypted/knowledge-pages/${selected.knowledgePageId}/attachments/${selected.attachmentId}`:`/api/digital-assistants/runtime/workspace/scopes/task/${selected.taskId}/attachments/${selected.attachmentId}`);
    assert.equal(url.searchParams.get('revision'),selected.revision);assert.equal(options.headers.get('x-trelio-assistant-encryption-device'),cryptoDeviceId);
    downloads++;if(mode==='late-close')f.close();
    return new Response(body,{headers:{'content-length':String(body.length),'content-type':'application/octet-stream',
      'x-trelio-attachment-sha256':selected.sha256,'x-trelio-attachment-revision':selected.revision}});
  };
  try{
    for(const entityType of ['file.task_attachments','agent_workspace_browser_file','file.company_page_attachments']){
      const attachmentId=randomUUID(),aad={suite:'trelio-e2ee-v1',companyId:f.pass.companyId,scopeId,scopeEpoch:1,entityType,entityId:randomUUID(),entityRevision:1,schemaVersion:1,purpose:'file'};
      const target=path.join(root,`${attachmentId}.cipher`);
      await encryptFileToCompanyContainer({sourcePath:source,destinationPath:target,scopePublicEncryptionJwk:publicJwk,aad,originalName:'../../PRIVATE_NAME_CANARY.txt',mimeType:'text/plain'});
      body=await fs.readFile(target);selected={schemaVersion:2,delivery:'assistant-encrypted-local-file',companyId:f.pass.companyId,companySlug:'encrypted',
        requestOrigin:'https://e2ee.trelio.ru',...(entityType==='file.company_page_attachments'?{knowledgePageId:randomUUID()}:{taskId:entityType==='agent_workspace_browser_file'?randomUUID():f.pass.taskId}),attachmentId,sizeBytes:body.length,sha256:createHash('sha256').update(body).digest('hex'),revision:'a'.repeat(64),aad};
      // A fresh download profile cannot silently switch its selected source.
      const profile=await createAssistantWorkspaceProfile({identity:f.identity,host:f.host,client:f.client,store:f.store,
        ...(selected.taskId!==f.pass.taskId?{sourceAttachment:selected}:{}),lockDirectory:root,lock:(_file,action)=>action()});
      const run=changes=>withWorkspaceExecutionProfile(profile,()=>materializeAssistantAttachment({origin:f.identity.origin,attachmentId,
        result:{structuredContent:{...selected,...changes},content:[{type:'text',text:'REMOTE_UNTRUSTED_CANARY'}]},common,attachments:materializer,
        ...(selected.knowledgePageId?{knowledgeAttachment:{pageId:selected.knowledgePageId,attachmentId}}:{}),
        prepareEncryptedRead:value=>profile.prepareAttachmentRead(value)}));
      assert.equal(body.includes(secret),false);assert.doesNotMatch(JSON.stringify(selected),/PRIVATE_NAME|PRIVATE_ORIGINAL/);
      const result=await run(),output=result.structuredContent;
      assert.equal(output.delivery,'local-file');assert.deepEqual(await fs.readFile(output.localFilePath),secret);
      assert.equal(output.originalName,'../../PRIVATE_NAME_CANARY.txt');assert.equal(output.mimeType,'text/plain');
      if(selected.taskId!==f.pass.taskId){
        await assert.rejects(f.profile.prepareAttachmentRead(selected),{code:'ASSISTANT_WORKSPACE_BINDING_CHANGED'});
        assert.deepEqual(await f.host.readActivePass(),f.pass,'source file never changes writable task authority');
      }
      assert.doesNotMatch(JSON.stringify(result.content),/REMOTE_UNTRUSTED/);
      for(const key of ['aad','requestOrigin','companySlug','dataBase64','downloadUrl'])assert.equal(Object.hasOwn(output,key),false);
      const before=downloads,publications=writes;
      await assert.rejects(run({aad:{...aad,entityId:randomUUID()}}));assert.equal(writes,publications);
      for(const change of [{unreviewed:'PRIVATE'},{requestOrigin:'https://evil.test'},{aad:{...aad,unknown:'PRIVATE'}},{sizeBytes:26*1024*1024}])await assert.rejects(run(change));
      assert.equal(downloads,before,'invalid descriptors do not perform binary I/O');
      const unrelatedAad={...selected,aad:{...aad,entityId:randomUUID()}};
      const other=await createAssistantWorkspaceProfile({identity:f.identity,host:f.host,client:f.client,store:f.store,
        ...(selected.taskId!==f.pass.taskId?{sourceAttachment:unrelatedAad}:{}),lockDirectory:root,lock:(_file,action)=>action()});
      await assert.rejects(withWorkspaceExecutionProfile(other,()=>materializeAssistantAttachment({origin:f.identity.origin,attachmentId,
        result:{structuredContent:unrelatedAad,content:[]},common,attachments:materializer,
        ...(selected.knowledgePageId?{knowledgeAttachment:{pageId:selected.knowledgePageId,attachmentId}}:{}),prepareEncryptedRead:value=>other.prepareAttachmentRead(value)})),/SOURCE_CHANGED/);
      assert.equal(writes,publications,'a valid digest and ready scope do not admit a different native-selected full header AAD');
      const originalBody=body;body=Buffer.from(body);body[body.length-1]^=1;await assert.rejects(run(),/SOURCE_CHANGED/);body=originalBody;
      assert.equal(writes,publications);mode='epoch';await assert.rejects(run());mode='valid';assert.equal(writes,publications);
      if(entityType==='file.company_page_attachments'){mode='late-close';await assert.rejects(run());assert.equal(writes,publications);}
    }
  }finally{globalThis.fetch=savedFetch;await fs.rm(root,{recursive:true,force:true});}
});

test('MCP original download is hidden without a trusted materializer and returns only its local result',async()=>{
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'d'.repeat(43)}`,expiresAt:1});
  let calls=0,materializations=0,failDownload=false;
  const httpRequest=async input=>{
    const response=result=>({sessionId:'fixture',message:{jsonrpc:'2.0',id:input.payload?.id,result}});
    if(input.method==='DELETE')return response({});
    if(input.payload.method==='initialize')return response({protocolVersion:'2025-06-18'});
    if(input.payload.method==='notifications/initialized')return response({});
    if(input.payload.method==='tools/list')return response({tools:['get_assistant_status','download_attachment'].map(name=>({
      name,description:'Live schema',inputSchema:{type:'object',properties:{attachmentId:{type:'string'},taskPass:{},runtimeSessionProof:{}}}}))});
    calls++;return response({content:[{type:'text',text:'REMOTE_FILE_PLAN'}],structuredContent:{attachmentId:input.payload.params.arguments.attachmentId}});
  };
  const base={origin,assistantId,deviceId,store,httpRequest};
  const closed=createAssistantMcpClient(base);
  assert.deepEqual((await closed.listTools()).map(tool=>tool.name),['get_assistant_status']);
  await assert.rejects(closed.callTool('download_attachment',{attachmentId:randomUUID()}),/CAPABILITY_UNAVAILABLE/);assert.equal(calls,0);
  const delivered={content:[{type:'text',text:'Private local file'}],structuredContent:{delivery:'local-file',localFilePath:'fixture-local-file'}};
  const client=createAssistantMcpClient({...base,materializeAttachment:async({result,attachmentId,signal})=>{
    materializations++;assert.equal(result.structuredContent.attachmentId,attachmentId);assert.ok(signal instanceof AbortSignal);
    if(failDownload)throw new AssistantTransportError('ASSISTANT_ATTACHMENT_SOURCE_CHANGED');return delivered;
  }});
  assert.equal((await client.listTools()).find(tool=>tool.name==='download_attachment').annotations.readOnlyHint,true);
  assert.deepEqual(await client.callTool('download_attachment',{attachmentId:randomUUID()}),delivered);
  failDownload=true;await assert.rejects(client.callTool('download_attachment',{attachmentId:randomUUID()}),/SOURCE_CHANGED/);
  assert.equal(calls,2);assert.equal(materializations,2,'uncertain binary read has no automatic replay');
});


test('source diagnostics are fixed device-only structural calls, strict before private I/O and without retries',async()=>{
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),companyId=randomUUID(),sourceId=randomUUID();
  const store=memoryStore(),credential=`tda_${'h'.repeat(43)}`;let calls=0;
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential,expiresAt:1});
  const valid={revision:0,sourceRevision:2,generation:0,code:'not_checked',lastCheckedAt:null};let output=valid;
  const bodies=[];
  const http=createAssistantHttp({origin,fetchImpl:async(url,options)=>{
    calls++;assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
    assert.equal(options.headers.authorization,`Bearer ${credential}`);
    if(options.method==='GET'){
      assert.equal(url,`${origin}/api/digital-assistants/runtime/source-skills/health?companyId=${companyId}&sourceId=${sourceId}`);
      assert.equal(options.body,undefined);
    }else{assert.equal(url,`${origin}/api/digital-assistants/runtime/source-skills/health`);bodies.push(JSON.parse(options.body));}
    if(output instanceof Error)throw output;
    return new Response(JSON.stringify({...output,body:'PRIVATE_PROVIDER_BODY'}),{headers:{'content-type':'application/json'}});
  }});
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,http});
  assert.deepEqual(await client.readSourceHealth(companyId,sourceId),valid);
  const input={companyId,sourceId,sourceRevision:2,expectedRevision:0,clientRequestId:randomUUID(),code:'ready'};
  output={...valid,revision:1,code:'ready',lastCheckedAt:'2026-01-01T00:00:00Z'};
  assert.deepEqual(await client.reportSourceHealth(input),output);assert.deepEqual(bodies,[input]);
  const acknowledgement={...input,phase:'acknowledgement',code:'acknowledgement_uncertain'};
  output={...output,code:'acknowledgement_uncertain'};
  assert.deepEqual(await client.reportSourceHealth(acknowledgement),output);
  assert.deepEqual(bodies[1],acknowledgement);
  assert.deepEqual(await client.reportSourceHealth(input),output,'healthy reading preserves native ACK diagnostic');
  output={...output,code:'read_failed'};
  assert.deepEqual(await client.reportSourceHealth({...acknowledgement,code:'ready'}),output,'ACK success preserves native read failure');
  const before=calls;
  for(const extra of [{message:'PRIVATE'},{cursor:'PRIVATE'},{code:'authenticated'},{sourceRevision:-1},
    {code:'acknowledgement_uncertain'},{phase:undefined},{phase:'provider'},{phase:'acknowledgement',code:'read_failed'}])
    await assert.rejects(client.reportSourceHealth({...input,...extra}),/INVALID_INPUT/);
  await assert.rejects(client.readSourceHealth('bad',sourceId),/INVALID_INPUT/);assert.equal(calls,before);
  for(output of [{...valid,code:'unknown'},{...valid,code:'ready'},{...valid,lastCheckedAt:'2026-01-01T00:00:00Z'},
    {...valid,sourceRevision:-1},{...valid,revision:NaN}])await assert.rejects(client.readSourceHealth(companyId,sourceId),/INVALID_RESPONSE/);
  output={...valid,revision:9,code:'ready',lastCheckedAt:'2026-01-01T00:00:00Z'};
  await assert.rejects(client.reportSourceHealth(input),/INVALID_RESPONSE/);
  const count=calls;output=new Error('PRIVATE_TRANSPORT');
  await assert.rejects(client.reportSourceHealth(input),error=>error.code==='ASSISTANT_TRANSPORT_UNAVAILABLE'&&!error.message.includes('PRIVATE'));
  assert.equal(calls,count+1,'unknown report outcome is never retried');
});

test('source routing uses fixed device HTTP and projects only exact requested opaque keys/current source generation',async()=>{
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),companyId=randomUUID(),sourceId=randomUUID();
  const store=memoryStore(),credential=`tda_${'r'.repeat(43)}`;await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential,expiresAt:1});
  const conversationKey=`telegram-conversation/v1.${'a'.repeat(64)}`;
  const input={companyId,sourceId,sourceRevision:3,conversationKeys:[conversationKey]};
  const route={id:randomUUID(),sourceId,sourceRevision:3,conversationKey,bindingId:randomUUID(),bindingRevision:2,taskId:randomUUID()};
  let output={schemaVersion:1,sourceId,sourceRevision:3,routes:[{...route,title:'PRIVATE_BODY'}]},calls=0;
  const http=createAssistantHttp({origin,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,`${origin}/api/digital-assistants/runtime/source-skills/routing`);
    assert.equal(options.method,'POST');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    assert.equal(options.headers.authorization,`Bearer ${credential}`);assert.deepEqual(JSON.parse(options.body),input);
    if(output instanceof Error)throw output;
    return new Response(JSON.stringify(output),{status:200,headers:{'content-type':'application/json'}});
  }});
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,http});
  assert.deepEqual(await client.sourceRoutes(input),[route]);
  const before=calls;
  for(const extra of [{messageId:'message:123:4'},{conversationKeys:['PRIVATE']},{conversationKeys:[conversationKey,conversationKey]},
    {conversationKeys:[]},{sourceRevision:-1},{companyId:'unknown'}])await assert.rejects(client.sourceRoutes({...input,...extra}),/INVALID_INPUT/);
  assert.equal(calls,before,'malformed routing never reaches credentials or HTTP');
  for(output of [{schemaVersion:2,sourceId,sourceRevision:3,routes:[route]},
    {schemaVersion:1,sourceId,sourceRevision:2,routes:[]},
    {schemaVersion:1,sourceId,sourceRevision:3,routes:[{...route,conversationKey:`telegram-conversation/v1.${'b'.repeat(64)}`}]},
    {schemaVersion:1,sourceId,sourceRevision:3,routes:[route,route]}])await assert.rejects(client.sourceRoutes(input),/INVALID_RESPONSE/);
  output=new Error('PRIVATE_HTTP');const count=calls;
  await assert.rejects(client.sourceRoutes(input),error=>error.code==='ASSISTANT_TRANSPORT_UNAVAILABLE'&&!error.message.includes('PRIVATE'));
  assert.equal(calls,count+1,'failed lookup is not retried or converted to an empty routing inventory');
});


test('private browser profile admits only its original grant and Run, signs fresh native proofs and isolates fallback storage',async()=>{
  const binding={grantId:randomUUID(),runId:randomUUID(),workspaceId:randomUUID()};
  const f=await workspaceProfileFixture({secretBrowserFill:binding});
  const token=await f.profile.requireToken(f.identity.origin),base=`/api/agent-secrets/checkout-grants/${binding.grantId}`;
  let privateReads=0;
  const get=f.store.get;f.store.get=async scope=>{privateReads++;return get(scope);};
  const buildHeaders=(_token,input)=>new Headers(input);
  const prepare=(pathname,options={},origin=f.identity.origin)=>f.profile.prepareRequest({origin,token,pathname,options,buildHeaders});
  for(const [pathname,options,origin] of [
    [`${base}/browser-fill-context?runId=${randomUUID()}`,{}],
    [`${base}/browser-fill-context?runId=${binding.runId}&runId=${binding.runId}`,{}],
    [`/api/agent-secrets/checkout-grants/${randomUUID()}/consume`,{method:'POST',body:JSON.stringify({runId:binding.runId})}],
    [`${base}/consume`,{method:'POST',body:JSON.stringify({runId:randomUUID()})}],
    [`${base}/consume`,{method:'POST',body:JSON.stringify({runId:binding.runId,value:'MUST_NOT_DELIVER'})}],
    [`${base}/consume?retry=1`,{method:'POST',body:JSON.stringify({runId:binding.runId})}],
    [`${base}/value`,{}],['/api/agent-secrets/generated-save-context',{}],
    [`${base}/consume`,{method:'POST',body:JSON.stringify({runId:binding.runId})},'https://other.test'],
  ])await assert.rejects(prepare(pathname,options,origin),/ORIGIN_DENIED/);
  assert.equal(privateReads,0,'an unknown Secret path/body/Run is denied before credential or signer I/O');
  const nonces=new Set();
  for(const [suffix,method,body,tool] of [
    [`/browser-fill-context?runId=${binding.runId}`,'GET',undefined,'assistant_secret_browser_context'],
    ['/consume','POST',{runId:binding.runId},'assistant_secret_browser_consume'],
    ['/browser-fill-outcome','POST',{runId:binding.runId,outcome:'succeeded'},'assistant_secret_browser_outcome'],
  ]){
    const result=await prepare(base+suffix,{method,...(body?{body:JSON.stringify(body)}:{}),headers:{cookie:'MUST_NOT_FORWARD',authorization:'Bearer HUMAN'}});
    assert.equal(result.url.origin,f.identity.origin);assert.equal(result.url.pathname,base+suffix.split('?')[0]);
    assert.equal(result.headers.get('authorization'),`Bearer ${f.credential}`);assert.equal(result.headers.get('cookie'),null);
    assert.deepEqual(JSON.parse(result.headers.get('x-trelio-assistant-pass')),{companyId:f.pass.companyId,taskId:f.pass.taskId,passId:f.pass.passId});
    const proof=JSON.parse(result.headers.get('x-trelio-assistant-proof'));
    assert.equal(verify(null,Buffer.from(['trelio-runtime-proof-v1',proof.runtimeSessionId,tool,proof.issuedAt,proof.nonce].join('\n')),
      f.keys.publicKey,Buffer.from(proof.signature,'base64url')),true);
    assert.ok(!nonces.has(proof.nonce));nonces.add(proof.nonce);
    assert.equal(result.options.credentials,'omit');assert.equal(result.options.redirect,'error');
  }
  const storage=await f.profile.resolveSecretBrowserStorage({configDirectory:os.tmpdir(),grantId:binding.grantId,runId:binding.runId});
  assert.ok(storage.profileDirectory.includes('secret-browser'));assert.ok(storage.profileDirectory.includes('digital-assistants'));
  assert.notEqual(storage.profileDirectory,path.join(os.tmpdir(),'secret-browser','profile'));
  await assert.rejects(f.profile.resolveSecretBrowserStorage({configDirectory:os.tmpdir(),grantId:randomUUID(),runId:binding.runId}));
  const ordinary=await workspaceProfileFixture();
  await assert.rejects(ordinary.profile.resolveSecretBrowserStorage({configDirectory:os.tmpdir(),...binding}));
  f.close();const before=privateReads;
  await assert.rejects(prepare(`${base}/consume`,{method:'POST',body:JSON.stringify({runId:binding.runId})}),/REVIEW_REQUIRED/);
  assert.equal(privateReads,before,'closed pass never reads the private device or signer');
});


test('company Secret metadata remains structural and rejects ignored holder prose before HTTP',async()=>{
  const {withAssistantCompanyContentArguments}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  let sends=0;
  const send=async args=>{sends++;return args;},withProfile=()=>assert.fail('structural list never opens keys or a browser');
  const input={name:'continue_assistant_workspace_action',args:{schemaVersion:1,operation:'secret_list',parameters:{holder:'company',offset:0,limit:20}}};
  assert.deepEqual(await withAssistantCompanyContentArguments(input,send,{withProfile}),input.args);
  for(const parameters of [{holder:'other'}, {holder:'company',scopeId:randomUUID()}, {holder:'company',name:'COMPANY_SECRET_CANARY'},
    {holder:'company',limit:'20'}])await assert.rejects(withAssistantCompanyContentArguments({...input,args:{...input.args,parameters}},send,{withProfile}),
      {code:'ASSISTANT_ENCRYPTED_CONTENT_REQUIRED'});
  assert.equal(sends,1);
});

test('private signed authentication binds one grant, exact skill vector and fresh device proofs without human fallback',async()=>{
  const {buildTrelioWorkspaceActionInvocation}=await import('../host-runtime/scripts/trelio-local-context.mjs');
  let binding;
  const f=await workspaceProfileFixture({secretSkill:({pass,runtime})=>(binding={
    grantId:randomUUID(),runId:randomUUID(),workspaceId:randomUUID(),companySlug:'fixture',fieldKey:'password',environmentVariable:'TRELIO_SERVICE_PASSWORD',
    skill:{companyId:pass.companyId,skillId:'synthetic-private',releaseId:randomUUID(),
      runtimeSessionId:runtime.state.runtimeSessionId,arguments:['login']},
  })});
  const nativeEncryption=await f.profile.prepareRequest({origin:f.identity.origin,token:await f.profile.requireToken(f.identity.origin),
    pathname:'/api/agent-workspaces/encryption/runtime?companySlug=fixture',options:{},buildHeaders:()=>new Headers()});
  assert.equal(nativeEncryption.url.pathname,'/api/digital-assistants/runtime/encryption/runtime');
  for(const query of ['companySlug=foreign','companySlug=fixture&fingerprint=forged','companySlug=fixture&companySlug=fixture'])
    await assert.rejects(f.profile.prepareRequest({origin:f.identity.origin,token:await f.profile.requireToken(f.identity.origin),
      pathname:'/api/agent-workspaces/encryption/runtime?'+query,options:{},buildHeaders:()=>new Headers()}));
  const expected=buildTrelioWorkspaceActionInvocation({schemaVersion:1,operation:'skill_run',parameters:binding.skill});
  const commandArguments=['trelio-workspace',...expected.argumentsList];
  assert.deepEqual(await f.profile.authorizePrivateSkillCheckout({grantId:binding.grantId,runId:binding.runId,commandArguments}),
    {fieldKey:'password',environmentVariable:'TRELIO_SERVICE_PASSWORD'});
  for(const change of [{grantId:randomUUID()},{runId:randomUUID()},{commandArguments:['powershell','-Command','write-output']},
    {commandArguments:[...commandArguments,'--export']}])
    await assert.rejects(f.profile.authorizePrivateSkillCheckout({grantId:binding.grantId,runId:binding.runId,commandArguments,...change}));
  const token=await f.profile.requireToken(f.identity.origin),base=`/api/agent-secrets/checkout-grants/${binding.grantId}`;
  let reads=0;const get=f.store.get;f.store.get=async input=>{reads++;return get(input);};
  const prepare=(pathname,options={})=>f.profile.prepareRequest({origin:f.identity.origin,token,pathname,options,buildHeaders:(_token,input)=>new Headers(input)});
  for(const [pathname,options] of [
    [`${base}/browser-fill-context?runId=${binding.runId}`,{}],
    [`${base}/browser-fill-context?runId=${binding.runId}&purpose=signed_skill&purpose=signed_skill`,{}],
    [`${base}/consume`,{method:'POST',body:JSON.stringify({runId:binding.runId})}],
    [`${base}/consume`,{method:'POST',body:JSON.stringify({runId:binding.runId,purpose:'signed_skill',ownerApproved:true})}],
    [`${base}/browser-fill-outcome`,{method:'POST',body:JSON.stringify({runId:binding.runId,purpose:'signed_skill'})}],
    ['/api/agent-skills/runtime/setup-secret',{method:'POST',body:'{}'}],
  ])await assert.rejects(prepare(pathname,options));
  assert.equal(reads,0,'unsupported fields/routes fail before signer/credential reads');
  const nonces=new Set();
  for(const [pathname,options,tool] of [
    [`${base}/browser-fill-context?runId=${binding.runId}&purpose=signed_skill`,{},'assistant_secret_skill_context'],
    [`${base}/consume`,{method:'POST',body:JSON.stringify({runId:binding.runId,purpose:'signed_skill'})},'assistant_secret_skill_consume'],
    ['/api/agent-skills/runtime/resolve',{method:'POST',body:JSON.stringify({companyId:binding.skill.companyId,
      skillId:binding.skill.skillId,expectedReleaseId:binding.skill.releaseId})},'assistant-skill:resolve'],
  ]){
    const selected=await prepare(pathname,{...options,headers:{authorization:'Bearer HUMAN',cookie:'HUMAN',
      'x-trelio-assistant-secret-checkout':'FORGED'}});
    const proof=JSON.parse(selected.headers.get('x-trelio-assistant-proof'));
    assert.equal(verify(null,Buffer.from(['trelio-runtime-proof-v1',proof.runtimeSessionId,tool,proof.issuedAt,proof.nonce].join('\n')),
      f.keys.publicKey,Buffer.from(proof.signature,'base64url')),true);
    assert.ok(!nonces.has(proof.nonce));nonces.add(proof.nonce);
    assert.equal(selected.headers.get('authorization'),`Bearer ${f.credential}`);assert.equal(selected.headers.get('cookie'),null);
    assert.equal(selected.headers.get('x-trelio-assistant-secret-checkout'),tool==='assistant-skill:resolve'
      ? JSON.stringify({grantId:binding.grantId,runId:binding.runId}) : null);
  }
  const old=reads;
  await assert.rejects(prepare('/api/agent-skills/runtime/resolve',{method:'POST',body:JSON.stringify({
    companyId:binding.skill.companyId,skillId:'another-skill',expectedReleaseId:binding.skill.releaseId})}));
  assert.equal(reads,old);
  const ordinary=await workspaceProfileFixture();
  await assert.rejects(ordinary.profile.authorizePrivateSkillCheckout({grantId:binding.grantId,runId:binding.runId,commandArguments}));
  const ordinaryToken=await ordinary.profile.requireToken(ordinary.identity.origin);
  const unbound=await ordinary.profile.prepareRequest({origin:ordinary.identity.origin,token:ordinaryToken,
    pathname:'/api/agent-skills/runtime/resolve',options:{method:'POST',body:JSON.stringify({companyId:ordinary.pass.companyId}),
      headers:{'x-trelio-assistant-secret-checkout':'FORGED'}},buildHeaders:(_token,input)=>new Headers(input)});
  assert.equal(unbound.headers.get('x-trelio-assistant-secret-checkout'),null);
  f.close();
  await assert.rejects(f.profile.authorizePrivateSkillCheckout({grantId:binding.grantId,runId:binding.runId,commandArguments}),/REVIEW_REQUIRED/);
});

test('private generation composes native sealed preflight, SAME protected key/password engine and one write without value output',async()=>{
  const common=await import('../host-runtime/scripts/trelio-workspace.mjs');
  const {handleAssistantGeneratedPrivateSecret}=await import('../host-runtime/scripts/trelio-secret-generate.mjs');
  const input={runId:randomUUID(),clientRequestId:randomUUID(),ownerDecisionId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString()};
  const descriptor={...input,workspaceId:randomUUID()},f=await workspaceProfileFixture({secretGeneration:descriptor});
  const scope={assistantUserId:f.identity.assistantId,deviceId:f.identity.deviceId,companyId:f.pass.companyId,taskId:f.pass.taskId};
  const fields=[{key:'password',label:'Password',type:'password',required:true}];
  const prepared={schemaVersion:1,completed:false,...scope,runId:input.runId,secretId:input.clientRequestId,fields,
    generatedFields:[{key:'password',generator:'password',length:32}]};
  const safe={created:true,secret:{id:input.clientRequestId,scopeType:'assistant',currentVersion:1,hasValue:true}};
  let mode='pending',writes=0,keys=0,committed=false,original=null;
  const prior=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    url=new URL(url);assert.equal(options.headers.get('authorization')===`Bearer ${f.credential}`,true);
    const proof=JSON.parse(options.headers.get('x-trelio-assistant-proof'));
    const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
    if(options.method===undefined||options.method==='GET'){
      assert.equal(verify(null,Buffer.from(['trelio-runtime-proof-v1',proof.runtimeSessionId,'assistant_secret_generate_context',proof.issuedAt,proof.nonce].join('\n')),f.keys.publicKey,Buffer.from(proof.signature,'base64url')),true);
      if(mode==='pending')return json({code:'ASSISTANT_OWNER_DECISION_REQUIRED'},403);
      if(committed)return json({completed:true,receipt:{...safe,values:'MUST_NOT_OUTPUT'}});
      if(mode==='foreign')return json({...prepared,companyId:randomUUID()});
      if(mode==='revoked')f.close();
      return json(prepared);
    }
    assert.equal(options.method,'PUT');assert.equal(verify(null,Buffer.from(['trelio-runtime-proof-v1',proof.runtimeSessionId,'assistant_secret_generate_write',proof.issuedAt,proof.nonce].join('\n')),f.keys.publicKey,Buffer.from(proof.signature,'base64url')),true);writes++;
    const body=JSON.parse(options.body);
    assert.equal(body.expectedCurrentVersion,0);assert.equal(body.clientRequestId,input.clientRequestId);
    assert.equal(Object.keys(body.values).join(','),'password');assert.equal(body.values.password.length,32);
    assert.equal(/^[a-f0-9]{64}$/u.test(body.requestFingerprint),true);
    if(original)assert.equal(JSON.stringify(original)===JSON.stringify(body),true,'same native intent derives the same bytes');
    original=body;
    if(mode==='uncertain'){committed=true;throw new Error('Synthetic lost native response');}
    return json({...safe,requestFingerprint:'MUST_NOT_OUTPUT',secret:{...safe.secret,values:'MUST_NOT_OUTPUT'}});
  };
  const invoke=()=>withWorkspaceExecutionProfile(f.profile,async()=>handleAssistantGeneratedPrivateSecret({
    origin:f.identity.origin,input,scope,token:await common.requireToken(f.identity.origin),
    withGenerationKey:action=>{keys++;return f.profile.withSecretGenerationKey(action);}}));
  try{
    await assert.rejects(invoke());assert.equal(keys,0);assert.equal(writes,0);
    mode='foreign';await assert.rejects(invoke());assert.equal(keys,0);assert.equal(writes,0);
    mode='valid';assert.deepEqual(await invoke(),safe);assert.equal(keys,1);assert.equal(writes,1);
    assert.deepEqual(await invoke(),safe);assert.equal(writes,2,'separate explicit invocation, no hidden retry');
    mode='uncertain';await assert.rejects(invoke());assert.equal(writes,3);
    const before=keys;assert.deepEqual(await invoke(),safe);assert.equal(keys,before,'committed read-back precedes deriving material');assert.equal(writes,3);
    committed=false;mode='revoked';await assert.rejects(invoke());assert.equal(writes,3,'revoked pass cannot reach value write');
  }finally{globalThis.fetch=prior;}
  const missing=await workspaceProfileFixture();
  await assert.rejects(missing.profile.withSecretGenerationKey(()=>assert.fail('key leaked without native plan')));
});

test('protected active pass narrows SAME native MCP session view without granting taskless task access',async()=>{
 const origin='https://view.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore(),credential=`tda_${'v'.repeat(43)}`;
 await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential,expiresAt:1});
 let active={kind:'source_intake'},calls=0;const views=[];
 const client=createAssistantMcpClient({origin,assistantId,deviceId,store,readActivePass:async()=>active,httpRequest:async input=>{
  views.push(input.config.headers['x-trelio-assistant-capability-profile']??'task');
  const response=result=>({sessionId:'view-fixture',message:{jsonrpc:'2.0',id:input.payload?.id,result}});
  if(input.method==='DELETE'||input.payload.method==='notifications/initialized')return response({});
  if(input.payload.method==='initialize')return response({protocolVersion:'2025-06-18'});
  if(input.payload.method==='tools/list')return response({tools:(active.kind==='source_intake'
   ?['get_assistant_status','get_assistant_intake_context','resolve_assistant_intake']:['get_assistant_status','get_task'])
    .map(name=>({name,description:'Native bounded view',inputSchema:{type:'object',properties:{intakePass:{},runtimeSessionProof:{}}}}))});
  calls++;return response({content:[],structuredContent:{}});
 }});
 assert.deepEqual((await client.listTools()).map(tool=>tool.name),['get_assistant_intake_context','resolve_assistant_intake']);
 assert.ok(views.every(value=>value==='source_intake'));
 await assert.rejects(client.callTool('get_task',{}),/CAPABILITY_UNAVAILABLE/);assert.equal(calls,0);
 active={kind:'task'};views.length=0;assert.deepEqual((await client.listTools()).map(tool=>tool.name),['get_assistant_status','get_task']);
 assert.ok(views.every(value=>value==='task'));await assert.rejects(client.callTool('resolve_assistant_intake',{}),/CAPABILITY_UNAVAILABLE/);
});


test('managed Remote MCP reuses credential paths and exact native attempt fence without human namespace access',async()=>{
  let input,receipts=0;
  const f=await workspaceProfileFixture({remoteMcp:({pass})=>{
    input={companyId:pass.companyId,projectId:null,skillId:'synthetic-remote',releaseId:randomUUID(),
      toolName:'update_record',arguments:{private:'SYNTHETIC_UNSENT'},ownerDecisionId:randomUUID(),clientRequestId:randomUUID()};
    return {input,consumed:false,authorize:async()=>{receipts++;return {structuredContent:{schemaVersion:1,
      receiptId:randomUUID(),ownerDecisionId:input.ownerDecisionId,attemptAdmitted:true,providerOutcome:'not_observed',replayAllowed:false}};}};
  }});
  const {resolveRemoteMcpCredentialFile}=await import('../host-runtime/scripts/trelio-remote-mcp.mjs');
  const localIdentity={companyId:f.pass.companyId,projectId:null,memberId:randomUUID(),skillId:input.skillId};
  const normal=resolveRemoteMcpCredentialFile(localIdentity,{homeDirectory:'/synthetic-home',environment:{}});
  await withWorkspaceExecutionProfile(f.profile,async()=>{
    const managed=resolveRemoteMcpCredentialFile(localIdentity,{homeDirectory:'/synthetic-home',environment:{}});
    assert.notEqual(managed,normal);assert.ok(managed.includes(f.identity.assistantId));assert.ok(managed.includes(f.identity.deviceId));
    assert.throws(()=>resolveRemoteMcpCredentialFile({...localIdentity,companyId:randomUUID()}),{code:'ASSISTANT_WORKSPACE_PROFILE_DENIED'});
    const selected={releaseId:input.releaseId,localIdentity};
    await f.profile.authorizeRemoteMcpWrite(selected,input.toolName,input.arguments,input);
    await assert.rejects(f.profile.authorizeRemoteMcpWrite(selected,input.toolName,input.arguments,input),{code:'ASSISTANT_REMOTE_MCP_WRITE_DENIED'});
    assert.equal(receipts,1);
  });
  f.close();await assert.rejects(f.profile.assertRemoteMcpCurrent(),{code:'ASSISTANT_PASS_REVIEW_REQUIRED'});
});

test('same selected skill hydrator opens only native Remote MCP config/title with the current managed recipient',async()=>{
  const common=await import('../host-runtime/scripts/trelio-workspace.mjs');
  const {hydrateAssistantEncryptedSkill}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const companyId=randomUUID(),assistantId=randomUUID(),scopeId=randomUUID(),deviceId=randomUUID(),entityId=randomUUID(),envelopeId=randomUUID();
  const pair=await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const publicJwk=await webcrypto.subtle.exportKey('jwk',pair.publicKey),privateJwk=await webcrypto.subtle.exportKey('jwk',pair.privateKey);
  const fields={remote_mcp_config_json:{schemaVersion:1,endpoint:'https://selected.example/mcp',allowedTools:['read_context']},title:'SYNTHETIC_REMOTE_PRIVATE_TITLE'};
  const aad={companyId,scopeId,scopeEpoch:1,entityType:'api.browser_mutation',entityId,entityRevision:1,schemaVersion:1,purpose:'content'};
  const payload={...aad,...await encryptCompanyPayload({scopePublicEncryptionJwk:publicJwk,aad,payload:{values:fields}})};
  const fingerprint='managed-remote-fingerprint';
  const opened={runtime:{company:{id:companyId},viewer:{userId:assistantId},device:{id:deviceId,fingerprint},
    envelope:{id:envelopeId},scope:{id:scopeId,epoch:1}},scopePrivateEncryptionKey:{privateKey:pair.privateKey,privateJwk}};
  const bundle={schemaVersion:1,companyId,recipientDeviceId:deviceId,envelopeId,scopeId,scopeEpoch:1,encryptedPayloads:[payload]};
  const raw={releaseId:randomUUID(),company:{id:companyId,slug:'encrypted'},skill:{id:'synthetic-remote',title:buildCompanyEncryptedTextMarker(entityId,'title')},
    remoteMcp:{contentProtection:'company_e2ee_v1',config:null},assistantEncryption:bundle};
  // Construct markers with the actual shared codec, not an assumed wire shape.
  raw.remoteMcp.config=(await import('../host-runtime/scripts/trelio-company-encryption.mjs')).buildCompanyEncryptedJsonMarker(entityId,'remote_mcp_config_json');
  let current=0;const input={raw,bundle,common,origin:'https://trelio.ru',token:'opaque-test-handle',companyId,assistantId,fingerprint,
    openCompany:async()=>opened,assertCurrent:async()=>{current++;}};
  const result=await hydrateAssistantEncryptedSkill(input);assert.deepEqual(result.rawResolution.remoteMcp.config,fields.remote_mcp_config_json);
  assert.equal(result.rawResolution.skill.title,fields.title);assert.equal(result.rawResolution.assistantEncryption,undefined);assert.equal(current,2);
  await assert.rejects(hydrateAssistantEncryptedSkill({...input,bundle:{...bundle,recipientDeviceId:randomUUID()}}),{code:'ASSISTANT_SOURCE_BINDING_CHANGED'});
  await assert.rejects(hydrateAssistantEncryptedSkill({...input,bundle:{...bundle,encryptedPayloads:[payload,{...payload,entityId:randomUUID()}]}}),{code:'ASSISTANT_MCP_INVALID_RESPONSE'});
});

test('native skill consent is a closed structural receipt with owned encrypted identity before HTTP',async()=>{
  const {withAssistantCompanyContentArguments}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const parameters={skillId:'company-runtime',projectId:null,releaseId:randomUUID(),publicationId:randomUUID(),runtimeArtifactId:randomUUID(),
    packageSha256:'a'.repeat(64),instructionsSha256:'b'.repeat(64),clientRequestId:randomUUID(),ownerDecisionId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString()};
  const base={schemaVersion:1,operation:'skill_consent',parameters};let mode='plain',sent=0,prepared=0;
  const invoke=args=>withAssistantCompanyContentArguments({name:'continue_assistant_workspace_action',args},async wire=>{sent++;return wire;},
    {withProfile:action=>action({readCompanyContentMode:async()=>mode,prepareSkillConsentArguments:async value=>{prepared++;return {...value,encryptionFingerprint:'c'.repeat(43)};}})});
  for(const changed of [{...base,extra:'CONSENT_PRIVATE_CANARY'},{...base,runIdentity:{runId:randomUUID(),workspaceId:randomUUID()}},
    {...base,parameters:{...parameters,deviceId:randomUUID()}},{...base,parameters:{...parameters,extra:'CONSENT_PRIVATE_CANARY'}},
    {...base,parameters:{...parameters,encryptionFingerprint:'d'.repeat(43)}}])await assert.rejects(invoke(changed));
  assert.equal(sent,0);assert.equal(prepared,0);
  assert.deepEqual(await invoke(base),base);assert.equal(sent,1);assert.equal(prepared,0);
  mode='encrypted';const result=await invoke(base);assert.equal(result.parameters.encryptionFingerprint,'c'.repeat(43));
  assert.equal(sent,2);assert.equal(prepared,1);assert.equal(JSON.stringify(result).includes('CONSENT_PRIVATE_CANARY'),false);
});


test('skill consent owner request crosses actual MCP without a fake ordinary tool and rejects nested canaries before tools call',async()=>{
  const f=await workspaceProfileFixture();let calls=0;const canary='PRIVATE_SKILL_CONSENT_NESTED_CANARY';
  const fields={skillId:'company-runtime',projectId:null,releaseId:randomUUID(),publicationId:randomUUID(),runtimeArtifactId:randomUUID(),
    packageSha256:'a'.repeat(64),instructionsSha256:'b'.repeat(64)};
  const client=createAssistantMcpClient({...f.identity,store:f.store,httpRequest:async input=>{
    const reply=result=>({sessionId:'consent-preflight',message:{jsonrpc:'2.0',id:input.payload?.id,result}});
    if(input.method==='DELETE'||input.payload.method==='notifications/initialized')return reply({});
    if(input.payload.method==='initialize')return reply({protocolVersion:'2025-06-18'});
    if(input.payload.method==='tools/list')return reply({tools:[{name:'request_assistant_action',description:'Native owner action',inputSchema:{type:'object'}}]});
    assert.equal(input.payload.method,'tools/call');calls++;assert.equal(JSON.stringify(input.payload).includes(canary),false);
    assert.deepEqual(input.payload.params.arguments.fields,fields);return reply({structuredContent:{questionId:randomUUID()},content:[]});
  }});
  const args={operation:'accept_skill_runtime',fields,reason:'Review exact current package',clientRequestId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString()};
  try{
    for(const extra of [{extra:canary},{deviceId:randomUUID()},{binding:{text:canary}}])
      await assert.rejects(client.callTool('request_assistant_action',{...args,fields:{...fields,...extra}}));
    assert.equal(calls,0);
    await client.callTool('request_assistant_action',args);assert.equal(calls,1);
  }finally{f.close();}
});


test('company NEW Secret profile binds native derived card ID, exact original plan and one-use proofs before any value HTTP',async()=>{
  const common=await import('../host-runtime/scripts/trelio-workspace.mjs');
  const {handleAssistantCompanySecretCreation}=await import('../host-runtime/scripts/trelio-secret-generate.mjs');
  const runId=randomUUID(),input={holder:'company',runId,clientRequestId:randomUUID(),ownerDecisionId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString(),
    plan:{metadataMode:'neutral',cardType:'password',scopeType:'task',runId,valueSource:'generated',generatedFields:[{key:'password',generator:'password',length:24}]}};
  const f=await workspaceProfileFixture({secretGeneration:{...input,workspaceId:randomUUID()}});
  const scope={assistantUserId:f.identity.assistantId,deviceId:f.identity.deviceId,companyId:f.pass.companyId,taskId:f.pass.taskId};
  const cardId=randomUUID(),fields=[{key:'password',label:'Password',type:'password',required:true}];
  const prepared={schemaVersion:1,completed:false,...scope,secretId:cardId,runId,companySlug:'fixture',companyMemberId:randomUUID(),scopeType:'task',scopeId:scope.taskId,
    storageMode:'trelio',encryptionState:'plain',currentVersion:0,generatedSecretStorageSupported:true,valueSource:'generated',metadata:{name:'Company secret',publicDescription:'',templateType:'custom',fields},
    fields,generatedFields:input.plan.generatedFields};
  const receipt={created:true,secret:{id:cardId,holder:'company',companyId:scope.companyId,scopeType:'task',scopeId:scope.taskId,storageMode:'trelio',currentVersion:1,hasValue:true},
    setupPath:`/fixture/agent-secrets/${cardId}/setup/`};
  const prior=globalThis.fetch;let writes=0;
  globalThis.fetch=async(url,options)=>{
    url=new URL(url);const proof=JSON.parse(options.headers.get('x-trelio-assistant-proof'));
    const method=options.method??'GET',tool=method==='GET'?'assistant_secret_generate_context':'assistant_secret_generate_write';
    assert.equal(verify(null,Buffer.from(['trelio-runtime-proof-v1',proof.runtimeSessionId,tool,proof.issuedAt,proof.nonce].join('\n')),f.keys.publicKey,Buffer.from(proof.signature,'base64url')),true);
    if(method==='PUT'){writes++;assert.equal(url.pathname,`/api/agent-secrets/secrets/${cardId}/value-from-bridge`);
      const body=JSON.parse(options.body);assert.equal(body.secretId,cardId);assert.equal(body.plan.valueSource,'generated');
      assert.equal(body.values.password.length,24);assert.equal(body.userExplicitlyRequestedGeneratedPersistentStorage,undefined);}
    return new Response(JSON.stringify(method==='GET'?prepared:{completed:true,receipt}),{headers:{'content-type':'application/json'}});
  };
  try{
    const result=await withWorkspaceExecutionProfile(f.profile,async()=>handleAssistantCompanySecretCreation({origin:f.identity.origin,input,scope,
      token:await common.requireToken(f.identity.origin),withGenerationKey:f.profile.withSecretGenerationKey,onContext:f.profile.selectCompanySecretContext}));
    assert.deepEqual(result,receipt);assert.equal(writes,1);
    const token=await f.profile.requireToken(f.identity.origin);
    await assert.rejects(f.profile.prepareRequest({origin:f.identity.origin,token,pathname:`/api/agent-secrets/secrets/${randomUUID()}/value-from-bridge`,
      options:{method:'PUT',body:JSON.stringify({...input,stage:'save',secretId:randomUUID()})},buildHeaders:(_token,input)=>new Headers(input)}));
    await assert.rejects(f.profile.selectCompanySecretContext({...prepared,companyId:randomUUID()}));
  }finally{globalThis.fetch=prior;}
});

// Generic fields are intentionally a native record. Close this host-created
// operation before preparation HTTP, without inventing an ordinary task alias.
test('human-input setup request rejects model recipes before real MCP and reconciles a lost admission without process work',async()=>{
  const {withAssistantCompanyContentArguments}=await import('../host-runtime/scripts/trelio-assistant-entry.mjs');
  const {normalizeAssistantSkillAccountSetupPlan,normalizeAssistantSkillAccountSetupParameters}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const f=await workspaceProfileFixture();let calls=0;
  const fields={skillId:'public-login',projectId:null,releaseId:randomUUID(),accountId:randomUUID(),commandId:'login'};
  const client=createAssistantMcpClient({...f.identity,store:f.store,httpRequest:async input=>{
    const reply=result=>({sessionId:'setup-preflight',message:{jsonrpc:'2.0',id:input.payload?.id,result}});
    if(input.method==='DELETE'||input.payload.method==='notifications/initialized')return reply({});
    if(input.payload.method==='initialize')return reply({protocolVersion:'2025-06-18'});
    if(input.payload.method==='tools/list')return reply({tools:[{name:'request_assistant_action',description:'Native setup',inputSchema:{type:'object'}}]});
    calls++;assert.deepEqual(input.payload.params.arguments.fields,fields);return reply({structuredContent:{questionId:randomUUID()},content:[]});
  }});
  const request={operation:'setup_skill_account',fields,reason:'Open protected account login',clientRequestId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString()};
  try{
    for(const extra of [{arguments:['login','PRIVATE_CANARY']},{deviceId:randomUUID()},{inspectedCommand:{purpose:'authenticate_existing'}},{extra:'PRIVATE_CANARY'}])
      await assert.rejects(client.callTool('request_assistant_action',{...request,fields:{...fields,...extra}}));
    assert.equal(calls,0);await client.callTool('request_assistant_action',request);assert.equal(calls,1);
    const parameters={...fields,clientRequestId:request.clientRequestId,ownerDecisionId:randomUUID(),expectedTaskUpdatedAt:request.expectedTaskUpdatedAt};
    assert.deepEqual(normalizeAssistantSkillAccountSetupParameters(parameters),parameters);
    const marker={$trelioE2ee:{v:1,id:randomUUID(),field:'skill_setup_command_json'}};
    assert.deepEqual(normalizeAssistantSkillAccountSetupParameters({...parameters,inspectedCommand:marker}).inspectedCommand,marker);
    for(const extra of [{arguments:['login']},{encryptionFingerprint:'c'.repeat(43)},{inspectedCommand:{...marker.$trelioE2ee}},{extra:'PRIVATE_CANARY'}])
      assert.throws(()=>normalizeAssistantSkillAccountSetupParameters({...parameters,...extra}));
    let prepared=0,sent=0,profiles=0;
    const base={schemaVersion:1,operation:'skill_account_setup',parameters};
    const invoke=args=>withAssistantCompanyContentArguments({name:'continue_assistant_workspace_action',args},async wire=>{
      sent++;assert.equal(wire.parameters.encryptionFingerprint,'c'.repeat(43));
      return {content:[],structuredContent:{state:'admitted',reconcileOnly:true,replayAllowed:false,receiptId:randomUUID()}};
    },{withProfile:action=>{profiles++;return action({readCompanyContentMode:async()=>'encrypted',prepareSkillAccountSetupArguments:async value=>{
      prepared++;return {...value,encryptionFingerprint:'c'.repeat(43)};}});}});
    for(const bad of [{...base,extra:'PRIVATE_CANARY'},{...base,runIdentity:{runId:randomUUID(),workspaceId:randomUUID()}},
      {...base,parameters:{...parameters,argv:['PRIVATE_CANARY']}}])await assert.rejects(invoke(bad));
    assert.equal(prepared,0);assert.equal(sent,0);
    const reconciled=await invoke(base);assert.equal(reconciled.structuredContent.reconcileOnly,true);
    assert.equal(sent,1);assert.equal(profiles,1,'a read-back receipt never constructs an execution profile');
    const plan={schemaVersion:1,requestId:parameters.clientRequestId,accountId:fields.accountId,companyId:randomUUID(),projectId:null,memberId:randomUUID(),connectionId:null,connectionConfigSha256:null,
      skillId:fields.skillId,releaseId:fields.releaseId,artifactId:randomUUID(),packageSha256:'a'.repeat(64),commandId:'login',purpose:'authenticate_existing',maximumDurationMs:60000,arguments:['login','--headed']};
    assert.deepEqual(normalizeAssistantSkillAccountSetupPlan(plan),plan);
    for(const changed of [{...plan,argv:['PRIVATE_CANARY']},{...plan,maximumDurationMs:600001},{...plan,purpose:'register_new'},
      {...plan,arguments:['login','https://private.test/secret']}])assert.throws(()=>normalizeAssistantSkillAccountSetupPlan(changed));
  }finally{f.close();}
});

test('private protected input binds exact native plan/card/pass and never exports a value through its task profile',async()=>{
  const common=await import('../host-runtime/scripts/trelio-workspace.mjs');
  const {handleAssistantNewSecretCreation}=await import('../host-runtime/scripts/trelio-secret-generate.mjs');
  const runId=randomUUID(),input={holder:'assistant',runId,clientRequestId:randomUUID(),ownerDecisionId:randomUUID(),expectedTaskUpdatedAt:new Date().toISOString(),
    plan:{metadataMode:'neutral',cardType:'password',runId,valueSource:'protected_input'}};
  const f=await workspaceProfileFixture({secretGeneration:{...input,workspaceId:randomUUID()}});
  const scope={assistantUserId:f.identity.assistantId,deviceId:f.identity.deviceId,companyId:f.pass.companyId,taskId:f.pass.taskId};
  const fields=[{key:'password',label:'Password',type:'password',required:true}];
  const context={schemaVersion:1,completed:false,...scope,secretId:input.clientRequestId,runId,storageMode:'trelio',currentVersion:0,
    protectedInputStorageSupported:true,valueSource:'protected_input',metadata:{name:'Personal secret',templateType:'custom'},fields};
  const receipt={created:true,secret:{id:input.clientRequestId,holder:'assistant',scopeType:'assistant',storageMode:'trelio',currentVersion:1,hasValue:true}};
  let pending=false,saved=false,writes=0;const nonces=new Set(),prior=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    url=new URL(url);const proof=JSON.parse(options.headers.get('x-trelio-assistant-proof'));
    const method=options.method??'GET',tool=method==='GET'?'assistant_secret_generate_context':'assistant_secret_generate_write';
    assert.equal(verify(null,Buffer.from(['trelio-runtime-proof-v1',proof.runtimeSessionId,tool,proof.issuedAt,proof.nonce].join('\n')),f.keys.publicKey,Buffer.from(proof.signature,'base64url')),true);
    assert.equal(nonces.has(proof.nonce),false);nonces.add(proof.nonce);
    if(method==='GET')return new Response(JSON.stringify(saved?{completed:true,receipt}:pending?{pending:true,secretId:input.clientRequestId}:context));
    writes++;const body=JSON.parse(options.body);assert.equal(url.pathname,`/api/agent-secrets/secrets/${input.clientRequestId}/value-from-bridge`);
    assert.equal(body.holder,'assistant');
    if(body.stage==='begin'){pending=true;return new Response(JSON.stringify({started:true,secretId:input.clientRequestId}));}
    assert.equal(body.values.password,'PRIVATE_PROFILE_CAPTURE_CANARY');saved=true;
    return new Response(JSON.stringify({completed:true,receipt}));
  };
  try{
    const result=await withWorkspaceExecutionProfile(f.profile,async()=>handleAssistantNewSecretCreation({origin:f.identity.origin,input,scope,
      token:await common.requireToken(f.identity.origin),withGenerationKey:f.profile.withSecretGenerationKey,onContext:f.profile.selectCompanySecretContext,
      collectValues:async({persistValues})=>persistValues({password:'PRIVATE_PROFILE_CAPTURE_CANARY'})}));
    assert.deepEqual(result,receipt);assert.equal(writes,2);assert.equal(JSON.stringify(result).includes('PRIVATE_PROFILE_CAPTURE_CANARY'),false);
    const token=await f.profile.requireToken(f.identity.origin);
    for(const changed of [{holder:'company'},{plan:{...input.plan,valueSource:'generated'}},{name:'arbitrary-company-metadata'}]){
      await assert.rejects(f.profile.prepareRequest({origin:f.identity.origin,token,pathname:`/api/agent-secrets/secrets/${input.clientRequestId}/value-from-bridge`,
        options:{method:'PUT',body:JSON.stringify({...input,secretId:input.clientRequestId,stage:'save',expectedCurrentVersion:0,requestFingerprint:'a'.repeat(64),values:{password:'synthetic'},...changed})},
        buildHeaders:(_token,input)=>new Headers(input)}));
    }
    assert.equal(writes,2);
  }finally{globalThis.fetch=prior;}
});

test('external signup plan is a closed exact-origin projection and only its admission uses managed continuation',async()=>{
  const {assistantExternalAccountPlan,supportsAssistantManagedContent}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const plan={siteOrigin:'https://signup.example.test',purpose:'Task account',intendedHolder:'company',signupPlan:'Create the free account and verify its home page'};
  assert.equal(assistantExternalAccountPlan(plan),true);
  for(const change of [{siteOrigin:'https://signup.example.test/'},{siteOrigin:'https://user:password@signup.example.test'},{purpose:' '},{signupPlan:' '},{intendedHolder:'owner'},{password:'SECRET_CANARY'},{approved:true}])assert.equal(assistantExternalAccountPlan({...plan,...change}),false);
  assert.equal(supportsAssistantManagedContent('continue_assistant_workspace_action',{operation:'external_account_admit'}),true);
  assert.equal(supportsAssistantManagedContent('continue_assistant_workspace_action',{operation:'signup_and_pay'}),false);
});


test('first outgoing hint drops stale or foreign source authority while retaining the one positive send',async()=>{
  const {createAssistantOutgoingConversationObserver}=await import('../host-runtime/scripts/trelio-assistant-transport.mjs');
  const identity={assistantId:randomUUID(),deviceId:randomUUID()},companyId=randomUUID(),taskId=randomUUID(),accountId=randomUUID(),projectId=randomUUID();
  let pass={schemaVersion:1,...identity,companyId,taskId,passId:randomUUID(),deliveryId:randomUUID(),threadId:randomUUID(),bindingId:randomUUID(),bindingRevision:0};
  let row={id:randomUUID(),companyId,deviceId:identity.deviceId,localAccountId:accountId,projectId,skillId:'telegram-mtproto',state:'active',revision:0};
  let rows=[row],outage=false,closed=false,reads=0;
  const client={readTaskPass:async()=>({...pass,state:closed?'closed':'leased',leaseExpiresAt:new Date(Date.now()+60000).toISOString()}),
    sourceAccounts:async()=>{reads++;if(outage)throw new Error('PRIVATE_NATIVE_HINT_ERROR');return structuredClone(rows);}};
  const observer=createAssistantOutgoingConversationObserver({identity,client,host:{readActivePass:async()=>pass}});
  const input={artifact:{skillId:'telegram-mtproto'},executionContext:{companyId,projectId,account:{id:accountId}},runtimeArguments:['send','--conversation-reference']};
  const positive={stdout:JSON.stringify({sent:true,conversationReference:{available:true,conversationKey:`telegram-conversation/v1.${'a'.repeat(64)}`}})};
  assert.equal(await observer.prepare({...input,runtimeArguments:['send']}),null);assert.equal(reads,0);
  for(const changed of [{companyId:randomUUID()},{deviceId:randomUUID()},{localAccountId:randomUUID()},{projectId:randomUUID()},
    {state:'paused'},{skillId:'email-imap-smtp'}]){
    rows=[{...row,...changed}];const result=JSON.parse((await observer.project(await observer.prepare(input),positive)).stdout);
    assert.equal(result.sent,true);assert.equal(result.assistantSourceConversation.state,'unavailable');
    assert.equal(result.assistantSourceConversation.candidates,undefined);
  }
  rows=[row];const stale=await observer.prepare(input);row={...row,revision:1};rows=[row];
  assert.equal(JSON.parse((await observer.project(stale,positive)).stdout).assistantSourceConversation.state,'unavailable');
  const paused=await observer.prepare(input);closed=true;
  assert.equal(JSON.parse((await observer.project(paused,positive)).stdout).assistantSourceConversation.state,'unavailable');closed=false;
  outage=true;const lost=JSON.parse((await observer.project(await observer.prepare(input),positive)).stdout);
  assert.equal(lost.sent,true);assert.doesNotMatch(JSON.stringify(lost),/PRIVATE_NATIVE_HINT_ERROR/);outage=false;
  const preview={stdout:JSON.stringify({sent:false,prepared:true})};
  assert.deepEqual(await observer.project(await observer.prepare(input),preview),preview);
});

test('triage device transport preserves null-thread company decisions and refuses role/batch swaps before body',async()=>{
 const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),companyId=randomUUID(),sourceId=randomUUID(),intakeId=randomUUID();
 const eventIds=[randomUUID(),randomUUID()],input={companyId,sourceId,intakeId,sourceRevision:2,kind:'route_existing',eventId:eventIds[0],eventIds,
   threadId:null,conversationKey:`email-conversation/v1.${'a'.repeat(64)}`};
 const credential=`tda_${'q'.repeat(43)}`;let reads=0,calls=0,changed=null,projection={schemaVersion:1,kind:'route_existing',id:intakeId,companyId,sourceId,sourceRevision:2,
   eventId:eventIds[0],eventIds,threadId:null,state:'waiting_owner',companySelectionRequired:true,taskId:null,receiptId:randomUUID(),readConfirmed:false,
   execution:null,leaseExpiresAt:new Date(Date.now()+60000).toISOString()};
 const client=createAssistantDeviceClient({origin,assistantId,deviceId,store:{get:async()=>{reads++;return {assistantId,deviceId,credential,expiresAt:1};}},
   http:async(operation,body,token)=>{calls++;assert.equal(operation,'intakeBegin');assert.deepEqual(body,input);assert.equal(token,credential);return {...projection,...changed};}});
 assert.equal((await client.beginSourceIntake(input)).execution,null);assert.equal(calls,1);
 projection={...projection,state:'redirected',redirect:{sourceId:randomUUID(),companyId:randomUUID(),sourceRevision:4},companySelectionRequired:false};
 assert.equal((await client.beginSourceIntake(input)).state,'redirected','structural redirect with no chat/model remains recoverable');
 for(const invalid of [{...input,body:'PRIVATE'},{...input,ownerIdentityId:randomUUID()},{...input,eventIds:[eventIds[1],eventIds[0]]},
   {...input,eventIds:[eventIds[0],eventIds[0]]},{...input,conversationKey:'PRIVATE'}]){
   const before=reads;await assert.rejects(client.beginSourceIntake(invalid),/INVALID_INPUT/);assert.equal(reads,before);
 }
 for(const patch of [{kind:'owner_command'},{eventIds:[randomUUID()]},{state:'leased',execution:null}]){
   changed=patch;await assert.rejects(client.beginSourceIntake(input),/INVALID_RESPONSE/);
 }
});


test('health protocol v2 is fixed host metadata and independent dispatch/auth/hook latches stay closed',async()=>{
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  const credential=`tda_${'x'.repeat(43)}`;await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential,expiresAt:1});
  let revision=3,calls=0,body;
  const state=()=>({revision,code:'dispatch_review_required',generation:1,
    latchedCodes:['codex_auth_required','hook_review_required','dispatch_review_required'],
    compatibility:{minimumPluginVersion:'3.0.0',minimumRuntimeVersion:'3.8.11'}});
  const http=createAssistantHttp({origin,fetchImpl:async(url,options)=>{
    calls++;assert.equal(options.headers['x-trelio-assistant-health-protocol'],'2');
    assert.equal(options.headers.authorization,`Bearer ${credential}`);
    if(options.method==='POST'){body=JSON.parse(options.body);revision++;}
    return new Response(JSON.stringify(state()),{headers:{'content-type':'application/json'}});
  }});
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,http});
  assert.equal((await client.readHealth()).code,'dispatch_review_required');
  const input={expectedRevision:revision,clientRequestId:randomUUID(),code:'ready',clearedReason:'dispatch_review_required'};
  assert.equal((await client.reportHealth(input)).latchedCodes.length,3);assert.deepEqual(body,input);
  await assert.rejects(client.reportHealth({...input,healthProtocol:'2'}),/INVALID_INPUT/);
  await assert.rejects(client.reportHealth({...input,clearedReason:'PRIVATE'}),/INVALID_INPUT/);assert.equal(calls,2);
});

test('device-only terminal continuation uses SAME renew route, exact owner receipt and closed structural projection',async()=>{
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),store=memoryStore();
  await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'x'.repeat(43)}`,expiresAt:1});
  const companyId=randomUUID(),taskId=randomUUID(),passId=randomUUID(),bindingId=randomUUID(),deliveryId=randomUUID(),threadId=randomUUID(),reviewId=randomUUID();
  const base={companyId,taskId,passId,expectedLeaseRevision:3,terminalTurnId:randomUUID(),clientRequestId:randomUUID()};
  let state='waiting_owner',corrupt=null;const calls=[];
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,http:async(operation,input)=>{
    calls.push({...input});assert.equal(operation,'passRenew');
    const value={schemaVersion:1,state,reviewId,invocationId:reviewId,terminalTurnId:base.terminalTurnId,expectedLeaseRevision:3,
      questionPath:'/test/agent-work/',resumed:state==='resumed'?{leaseRevision:4,leaseExpiresAt:new Date(Date.now()+1200000).toISOString()}:null,
      pass:{passId,bindingId,bindingRevision:2,deliveryId,threadId,state:state==='resumed'?'leased':'review_required',leaseRevision:state==='resumed'?4:3,
        leaseExpiresAt:new Date(Date.now()+(state==='resumed'?1200000:-1)).toISOString(),execution:{modelId:'gpt-6.1-sol',effortLevel:'high',revision:1}}};
    return corrupt?corrupt(value):value;
  }});
  assert.equal((await client.continueTaskPass({...base,continuation:'review'})).state,'waiting_owner');
  assert.equal(calls[0].reviewId,undefined);
  state='approved';assert.equal((await client.continueTaskPass({...base,reviewId,continuation:'read'})).state,'approved');
  state='resumed';const receipt=await client.continueTaskPass({...base,reviewId,continuation:'resume'});assert.equal(receipt.pass.deliveryId,deliveryId);
  assert.equal(receipt.pass.threadId,threadId);assert.equal(receipt.pass.leaseRevision,4);
  for(const change of [v=>({...v,invocationId:randomUUID()}),v=>({...v,terminalTurnId:randomUUID()}),
    v=>({...v,resumed:{...v.resumed,leaseRevision:5}}),v=>({...v,untrusted:'PRIVATE_CANARY'}),v=>({...v,pass:{...v.pass,passId:randomUUID()}})]){
    corrupt=change;await assert.rejects(client.continueTaskPass({...base,reviewId,continuation:'read'}),/INVALID_RESPONSE/);
  }
  const count=calls.length;
  await assert.rejects(client.continueTaskPass({...base,continuation:'review',reviewId}),/INVALID_INPUT/);
  await assert.rejects(client.continueTaskPass({...base,continuation:'read'}),/INVALID_INPUT/);
  assert.equal(calls.length,count);
  corrupt=v=>({...v,schemaVersion:2,questionPath:null});
  await assert.rejects(client.continueTaskPass({...base,reviewId,continuation:'read'}),/INVALID_RESPONSE/);
  const automatic=await client.continueTaskPass({...base,reviewId,continuation:'read',automatic:true});
  assert.equal(automatic.schemaVersion,2);assert.equal(automatic.questionPath,null);
  assert.equal(calls.at(-1).automatic,true);assert.equal(automatic.invocationId,reviewId);
  await assert.rejects(client.continueTaskPass({...base,reviewId,continuation:'read',automatic:false}),/INVALID_INPUT/);
});

test('multi-task intake read-back preserves an exact original partition and rejects mixed or incomplete receipts',async()=>{
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),companyId=randomUUID(),sourceId=randomUUID(),intakeId=randomUUID();
  const eventIds=[randomUUID(),randomUUID(),randomUUID()],key=`telegram-conversation/v1.${'a'.repeat(64)}`;
  const routes=eventIds.slice(0,2).map(eventId=>({id:randomUUID(),sourceId,sourceRevision:2,conversationKey:key,
    bindingId:randomUUID(),bindingRevision:0,taskId:randomUUID(),eventIds:[eventId]}));
  const original={schemaVersion:1,kind:'route_existing',id:intakeId,companyId,sourceId,sourceRevision:2,eventId:eventIds[0],eventIds,
    threadId:randomUUID(),state:'routed',taskId:null,receiptId:randomUUID(),readConfirmed:true,routes,ignoredEventIds:[eventIds[2]],
    execution:{modelId:'gpt-6.1-sol',effortLevel:'high',revision:1},leaseExpiresAt:new Date(Date.now()+60000).toISOString()};
  let value=structuredClone(original),calls=0;
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store:{get:async()=>({assistantId,deviceId,credential:`tda_${'x'.repeat(43)}`,expiresAt:1})},
    http:async(operation,body)=>{calls++;assert.equal(operation,'intakeRead');assert.deepEqual(body,{companyId,sourceId,intakeId});return value;}});
  const retained=await client.readSourceIntake({companyId,sourceId,intakeId});
  assert.equal(retained.taskId,null);assert.equal(retained.route,undefined);assert.deepEqual(retained.routes,routes);
  assert.deepEqual(retained.ignoredEventIds,[eventIds[2]]);
  value={...structuredClone(original),kind:undefined,state:'created',taskId:routes[0].taskId,routes:undefined,
    route:{...routes[0],eventIds:[eventIds[0]]},ignoredEventIds:undefined};
  assert.deepEqual((await client.readSourceIntake({companyId,sourceId,intakeId})).route.eventIds,[eventIds[0]],
    'owner-created singular receipts retain exact membership for native route-ID reconciliation');
  for(const patch of [{ignoredEventIds:[]},{ignoredEventIds:[eventIds[0]]},
    {routes:[routes[0],{...routes[1],eventIds:[randomUUID()]}]},
    {routes:[routes[0],{...routes[1],sourceId:randomUUID()}]},
    {routes:[routes[0],{...routes[1],taskId:routes[0].taskId}]}]){
    value={...structuredClone(original),...patch};await assert.rejects(client.readSourceIntake({companyId,sourceId,intakeId}),/INVALID_RESPONSE/);
  }
  assert.equal(calls,7,'each malformed read has one attempt, no mutation or automatic retry');
});
