import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, randomBytes, generateKeyPairSync, verify, webcrypto, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createAssistantHttp, createAssistantDeviceClient, createAssistantPairingClient, AssistantTransportError, createAssistantMcpClient, assistantModelInputSchema, prepareAssistantCompanyEncryption, validateAssistantEncryptedTaskRead, materializeAssistantEncryptedTask } from '../host-runtime/scripts/trelio-assistant-transport.mjs';
import { buildAgentDeviceRegistrationRecord, verifyCompanyEncryptionRecord, hpkeSeal, encryptCompanyPayload, buildCompanyEncryptedTextMarker,
  encryptFileToCompanyContainer } from '../host-runtime/scripts/trelio-company-encryption.mjs';

const memoryStore = () => {
  const values=new Map(); const key=input=>JSON.stringify(input);
  return { get:async input=>structuredClone(values.get(key(input))??null),
    put:async(input,value)=>values.set(key(input),structuredClone(value)),remove:async input=>values.delete(key(input)) };
};

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
  const input={identity,host:{readIdentity:async()=>identity},client:{companies:async()=>available?[{companyId,encryptionState:'encrypted'}]:[]},
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
        envelope={recipientType:'agent_device',recipientId:cryptoDeviceId,scopeId,scopeEpoch:1,
          hpkeEnc:sealed.enc,ciphertext:sealed.ciphertext,aad};
      }finally{plaintext.fill(0);}
      return json({device:{id:cryptoDeviceId,fingerprint:registered.fingerprint}});
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
    return json({state:'encrypted',suite:'trelio-e2ee-v1',company:{id:companyId,slug:'encrypted',name:'PUBLIC'},
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

test('device client loads only its exact private slot and projects server content away', async () => {
  const origin='https://assistant.test',assistantId=randomUUID(),deviceId=randomUUID(),companyId=randomUUID(),memberId=randomUUID();
  const store=memoryStore(); await store.put({origin,kind:'device',id:assistantId},{assistantId,deviceId,credential:`tda_${'a'.repeat(43)}`,expiresAt:10000});
  let calls=0;
  const client=createAssistantDeviceClient({origin,assistantId,deviceId,store,now:()=>100,http:async(operation,_body,credential)=>{
    calls++; assert.equal(operation,'companies'); assert.match(credential,/^tda_/u);
    return {assistantUserId:assistantId,bindingId:deviceId,companies:[{id:companyId,memberId,encryptionState:null,secret:'PRIVATE',slug:'PRIVATE'}]};
  }});
  assert.deepEqual(await client.companies(),[{companyId,memberId,encryptionState:null,execution:{state:'unconfigured',configuration:null,policyRevisionId:null}}]);
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

test('pairing persists verifier before I/O, handles pending and erases it after protected device save', async () => {
  const origin='https://assistant.test',enrollmentId=randomUUID(),pairingId=randomUUID(),assistantUserId=randomUUID(),deviceId=randomUUID();
  const store=memoryStore(); let exchanges=0,seenVerifier;
  const client=createAssistantPairingClient({origin,store,now:()=>100,http:async(operation,input)=>{
    const saved=await store.get({origin,kind:'pairing',id:enrollmentId});
    if(operation==='pair') {
      assert.equal(saved.phase,'prepared'); assert.equal(saved.verifier.length,43);
      return {pairingId,verificationCode:'ABCDEF12',expiresAt:new Date(20000).toISOString()};
    }
    assert.equal(saved.phase,'exchanging'); assert.equal(input.verifier,saved.verifier); seenVerifier=input.verifier;
    if(!exchanges++) throw new AssistantTransportError('ASSISTANT_STATE_CHANGED',409);
    return {assistantUserId,deviceId,credential:`tda_${'b'.repeat(43)}`,expiresAt:new Date(30000).toISOString()};
  }});
  const begin=await client.begin(enrollmentId,'Fixture'); assert.equal(begin.verificationCode,'ABCDEF12'); assert.doesNotMatch(JSON.stringify(begin),/verifier/);
  assert.deepEqual(await client.exchange(enrollmentId),{state:'pending'});
  assert.deepEqual(await client.exchange(enrollmentId),{state:'ready',origin,assistantId:assistantUserId,deviceId});
  assert.ok(!(JSON.stringify(await store.get({origin,kind:'pairing',id:enrollmentId}))).includes(seenVerifier));
  assert.match((await store.get({origin,kind:'device',id:assistantUserId})).credential,/^tda_/u);
});

test('lost exchange response is fenced across restarts and is never blindly repeated', async () => {
  const origin='https://assistant.test',enrollmentId=randomUUID(),store=memoryStore(); let exchanges=0;
  const http=async operation=>{
    if(operation==='pair') return {pairingId:randomUUID(),verificationCode:'ABCDEF12',expiresAt:new Date(20000).toISOString()};
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
      {name:'create_comment',description:'Current assistant backend write',inputSchema:shape,annotations:{idempotentHint:true}},
      {name:'continue_assistant_workspace_action',description:'Current local action',inputSchema:shape,annotations:{idempotentHint:false}},
      {name:'request_assistant_action',description:'Live sealed owner action',inputSchema:{...shape,properties:{...shape.properties,operation:{type:'string'},fields:{type:'object'}}}},
      ...['update_task_due_date','update_task_assignee','set_task_participants','update_task_custom_field','create_task_relation','delete_task_relation','delete_checklist','delete_attachment'].map(name=>({name,description:'Live native task operation',inputSchema:shape,annotations:{destructiveHint:name==='delete_checklist'||name==='delete_task_relation'||name==='delete_attachment'}})),
      ...['search_agent_guidance','get_agent_skill','get_agent_procedure'].map(name=>({name,description:'Live native guidance read',inputSchema:shape})),
      {name:'delete_workspace',description:'Unsupported; must remain closed',inputSchema:shape},
    ]});
    assert.equal(input.payload.method,'tools/call');receivedArgs=input.payload.params.arguments;
    return response({content:[{type:'text',text:echoed?credential:'native content'}],structuredContent:{schemaVersion:3},_meta:{discard:true}});
  }});
  const tools=await client.listTools();assert.deepEqual(tools.map(tool=>tool.name),['get_assistant_status','get_task','create_comment','continue_assistant_workspace_action','request_assistant_action','update_task_due_date','update_task_assignee','set_task_participants','update_task_custom_field','create_task_relation','delete_task_relation','delete_checklist','delete_attachment','search_agent_guidance','get_agent_skill','get_agent_procedure']);
  assert.deepEqual(tools[1].inputSchema,{type:'object',properties:{},additionalProperties:false});
  assert.deepEqual(Object.keys(shape.properties),['taskPass','runtimeSessionProof']);
  assert.equal(tools[2].annotations.idempotentHint,true);assert.equal(tools[3].annotations.idempotentHint,false);assert.ok(!JSON.stringify(tools).includes('DO_NOT_PROXY_METADATA'));
  const args={taskPass:{passId:randomUUID()},runtimeSessionProof:{signature:'original'}};
  const resultPromise=client.callTool('get_task',args);args.runtimeSessionProof.signature='changed';
  const result=await resultPromise;assert.equal(receivedArgs.runtimeSessionProof.signature,'original');
  assert.equal(result.content[0].text,'native content');assert.ok(!('_meta' in result));
  assert.deepEqual(calls,['initialize','notifications/initialized','tools/list','DELETE','initialize','notifications/initialized','tools/call','DELETE']);
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
  assert.deepEqual(Object.keys(tools[4].inputSchema.properties).sort(),['fields','operation']);
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
    create_comment:{acceptedFiles:{type:'array',items:{type:'object',properties:{runId:{type:'string'},filePath:{type:'string'}},additionalProperties:false},minItems:1,maxItems:10}},
    ask_assistant_owner:{options:{type:'array',items:{type:'string'},minItems:2,maxItems:8}},
    create_task_relation:{targetTaskId:{type:'string'},relationType:{type:'string'}},
    delete_task_relation:{relationId:{type:'string'}},
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
    correctionRunId:{type:'string',format:'uuid'},futureNativeField:{type:'boolean'}};
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
  const branch={type:'object',properties:{taskPass:{type:'object'},runtimeSessionProof:{type:'object'},sourceProcessingProof:{type:'object'},parameters:{oneOf:[business]}},required:['taskPass','runtimeSessionProof','sourceProcessingProof','parameters'],additionalProperties:false};
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
import { ASSISTANT_MCP_READ_TOOLS, createAssistantWorkspaceProfile } from '../host-runtime/scripts/trelio-assistant-transport.mjs';
import { withWorkspaceExecutionProfile, currentWorkspaceExecutionProfile,
  ensureCompanyEncryptionContext } from '../host-runtime/scripts/trelio-workspace.mjs';

const workspaceProfileFixture = async ({encryptedTool=null,encryptedInspection=false,secretBrowserFill=null,secretGeneration=null,secretSkill=null}={}) => {
  const identity={schemaVersion:1,origin:encryptedTool||encryptedInspection?'https://trelio.ru':'https://assistant.test',assistantId:randomUUID(),deviceId:randomUUID()};
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
    ? {...locator,sections:['comments']} : locator,companyId:pass.companyId,taskId:pass.taskId,passId:pass.passId,
    assistantUserId:identity.assistantId,deviceId:identity.deviceId,requestOrigin:'https://e2ee.trelio.ru'}:null;
  const inspectionDescriptor=encryptedInspection?{schemaVersion:1,companyId:pass.companyId,companySlug:'encrypted',workspaceId:randomUUID(),requestOrigin:'https://e2ee.trelio.ru'}:null;
  const profile=await createAssistantWorkspaceProfile({identity,store,host,client,encryptedTaskRead:descriptor,encryptedInspection:inspectionDescriptor,secretBrowserFill,secretGeneration,
    secretSkill:typeof secretSkill==='function'?secretSkill({pass,runtime}):secretSkill,
    lockDirectory:path.join(os.tmpdir(),'synthetic-assistant-workspace-locks'),lock:(_file,action)=>action()});
  return {identity,pass,keys,store,credential,runtime,profile,descriptor,inspectionDescriptor,host,client,contacts:()=>contacts,
    changeIdentity:value=>{currentIdentity=value;},changePass:value=>{active=value;},close:()=>{live=false;}};
};

test('native encrypted refusal is consumed once by the trusted materializer under the original MCP deadline',async()=>{
  const f=await workspaceProfileFixture({encryptedTool:'get_task'});let writes=0,hydrations=0,mode='valid';
  const descriptor=f.descriptor;
  const base={...f.identity,store:f.store,httpRequest:async input=>{
    const response=result=>({sessionId:'encrypted-read',message:{jsonrpc:'2.0',id:input.payload?.id,result}});
    if(input.method==='DELETE'||input.payload.method==='notifications/initialized')return response({});
    if(input.payload.method==='initialize')return response({protocolVersion:'2025-06-18'});
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

test('encrypted task reads compose the SAME managed keys, HPKE, native exact projection and selected ciphertext without a mirror',async()=>{
  const common=await import('../host-runtime/scripts/trelio-workspace.mjs');
  for(const nativeTool of ['get_task','get_task_sections']){
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
    const raw=nativeTool==='get_task_sections'?{taskRevision:{id:f.pass.taskId,updatedAt:null},sections:{comments:{comments:[{bodyText:marker('comment')}]}}}
      : {schemaVersion:1,company,viewer:{memberId:randomUUID(),companyRole:'user'},viewerGroupIds:[],projects:[project],
        tasks:[{id:f.pass.taskId,projectId,projectSlug:project.slug,number:30,revisionToken:'synthetic:1',
          payload:{company,project,task:{id:f.pass.taskId,title:marker('title'),status:{code:'active',name:'Active'},participants:[],controls:[]}}}],
        instructions:{company:{compiledMarkdown:marker('rules')},projects:[],userProfile:null},workspaces:[],workspaceEntries:[],contextDocuments:[]};
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
      assert.match(rendered,nativeTool==='get_task'?/SYNTHETIC_TITLE/:/SYNTHETIC_COMMENT/);
      if(nativeTool==='get_task')assert.match(rendered,/SYNTHETIC_RULE/);
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

test('encrypted accepted Workspace inspector composes real Git, managed HPKE, native ciphertext and the SAME readonly cache',async()=>{
  // An actual isolated child is necessary: the common module captures its
  // private config root at import time. Never write synthetic authority/cache
  // into the developer's real HOME or share a human remembered-key profile.
  if(process.env.TRELIO_ASSISTANT_INSPECTION_FIXTURE!=='1'){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-inspect-process-'));
    const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{fileURLToPath}=await import('node:url');
    // NODE_TEST_CONTEXT belongs to the outer runner. Inheriting it makes a
    // nested --test process suppress its runner, so exit 0 alone is no proof
    // that the isolated composition executed. Require an end-of-flow sentinel.
    const childEnv={...process.env,HOME:root,USERPROFILE:root,LOCALAPPDATA:path.join(root,'AppData','Local'),
      TRELIO_WORKSPACE_DISABLE_KEYCHAIN:'1',TRELIO_ASSISTANT_INSPECTION_FIXTURE:'1'};
    delete childEnv.NODE_TEST_CONTEXT;
    try{const result=await promisify(execFile)(process.execPath,['--test','--test-name-pattern','encrypted accepted Workspace inspector',fileURLToPath(import.meta.url)],{
      env:childEnv,timeout:30000,maxBuffer:1024*1024});
      assert.match(result.stdout,/ASSISTANT_ENCRYPTED_INSPECTION_VERIFIED/u);
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
  await fs.writeFile(path.join(root,'result.md'),'SELECTED_ACCEPTED_FILE');await git(['add','--all']);
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
  const savedFetch=globalThis.fetch;let downloads=0,mode='valid';const requests=[];
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
    assert.equal(url.searchParams.get('head'),head);downloads++;
    if(mode==='late-close')f.close();
    return new Response(bytes,{headers:{'x-trelio-e2ee':'v1','x-trelio-workspace-id':descriptor.workspaceId,'x-trelio-accepted-head':head,
      'x-trelio-encrypted-revision-id':revisionId,'x-trelio-scope-id':scopeId,'x-trelio-scope-epoch':'1','x-trelio-ciphertext-sha256':digest(bytes)}});
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
    // Revoke during a fresh ciphertext read, after a previously legitimate
    // cache has been removed. Local materialization cannot publish success.
    mode='late-close';
    const file=path.join(directory,'result.md');if(process.platform!=='win32')await fs.chmod(file,0o600);
    await fs.writeFile(file,'tampered');await assert.rejects(run());
    console.log('ASSISTANT_ENCRYPTED_INSPECTION_VERIFIED');
  }finally{globalThis.fetch=savedFetch;}
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
