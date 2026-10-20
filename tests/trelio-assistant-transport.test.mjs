import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createAssistantHttp, createAssistantDeviceClient, createAssistantPairingClient, AssistantTransportError } from '../host-runtime/scripts/trelio-assistant-transport.mjs';

const memoryStore = () => {
  const values=new Map(); const key=input=>JSON.stringify(input);
  return { get:async input=>structuredClone(values.get(key(input))??null),
    put:async(input,value)=>values.set(key(input),structuredClone(value)),remove:async input=>values.delete(key(input)) };
};
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
  assert.deepEqual(await client.companies(),[{companyId,memberId,encryptionState:null}]);
  const other=createAssistantDeviceClient({origin,assistantId,deviceId:randomUUID(),store,http:async()=>{calls++;},now:()=>100});
  await assert.rejects(other.companies(),/DEVICE_REQUIRED/); assert.equal(calls,1);
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
