import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assistantDeliveryMarker, readAssistantCodexDelivery, runAssistantCodexPass, provisionAssistantCodexChat } from '../host-runtime/scripts/trelio-assistant-codex.mjs';

function fakeChild() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
  child.killed = false; child.kill = () => { child.killed = true; return true; }; return child;
}
const nativeRpc = handler => (_executable, args, options) => {
  assert.deepEqual(args,['app-server','--listen','stdio://']); assert.equal(options.shell,false);
  assert.deepEqual(options.stdio,['pipe','pipe','ignore']);
  const child = fakeChild(); let input = '';
  child.stdin.on('data', chunk => {
    input += chunk.toString(); let boundary;
    while ((boundary=input.indexOf('\n'))!==-1) {
      const request=JSON.parse(input.slice(0,boundary)); input=input.slice(boundary+1);
      if (!request.id) continue;
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id:request.id,
        ...(request.method==='initialize' ? { result:{} } : handler(request)) })}\n`));
    }
  });
  return child;
};

test('exact native marker read-back exposes receipt only; quoted/tool text is not acceptance', async () => {
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID();
  const text=assistantDeliveryMarker(deliveryId)+'\nprivate instruction';
  const options = { executable:process.execPath, environment:{}, spawnProcess:nativeRpc(request => {
    if (request.method==='thread/read') return { result:{ thread:{ id:threadId,cwd:process.cwd(),name:'PRIVATE TITLE' } } };
    assert.equal(request.method,'thread/turns/list'); assert.equal(request.params.itemsView,'summary');
    return { result:{ data:[{ id:turnId,status:'completed',items:[
      { type:'agentMessage',text:'PRIVATE OUTPUT' }, { type:'userMessage',content:[{ type:'text',text }] },
    ] }] } };
  }) };
  const result = await readAssistantCodexDelivery(threadId,deliveryId,options);
  assert.equal(result.state,'completed'); assert.equal(result.turnId,turnId);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|private instruction/);
  const spoofed = { ...options, spawnProcess:nativeRpc(request => request.method==='thread/read'
    ? { result:{ thread:{ id:threadId,cwd:process.cwd() } } }
    : { result:{ data:[{ id:turnId,status:'completed',items:[{ type:'agentMessage',text }] }] } }) };
  assert.deepEqual(await readAssistantCodexDelivery(threadId,deliveryId,spoofed),{ state:'uncertain' });
});

test('native read failure stays closed and never copies diagnostic content into the error', async () => {
  const threadId=randomUUID(),deliveryId=randomUUID();
  await assert.rejects(readAssistantCodexDelivery(threadId,deliveryId,{ executable:process.execPath,environment:{},
    spawnProcess:nativeRpc(() => ({ error:{ code:-32600,message:'PRIVATE SECRET DIAGNOSTIC' } })) }),
    error => error.code==='ASSISTANT_CODEX_READ_UNAVAILABLE' && !/PRIVATE/.test(error.message));
});

test('malformed native JSON frames fail closed instead of crashing the coordinator process', async()=>{
  const options={executable:process.execPath,environment:{},spawnProcess:()=>{
    const child=fakeChild();queueMicrotask(()=>child.stdout.write('null\n'));return child;
  }};
  await assert.rejects(readAssistantCodexDelivery(randomUUID(),randomUUID(),options),/READ_UNAVAILABLE/);
});

test('initial native chat persists its ID synchronously and consumes no business instruction', async t=>{
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-provision-test-'));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const threadId=randomUUID(),deliveryId=randomUUID();let started=false,saved=null,input='';
  const options={executable:process.execPath,environment:{},
    startInvocation:()=>{started=true;},onThreadStarted:value=>{assert.equal(started,true);saved=value;},
    readDelivery:async value=>{assert.equal(saved,threadId);assert.equal(value,threadId);return{state:'completed',receipt:'fixture:ready'};},
    spawnProcess:(_executable,args)=>{
      assert.deepEqual(args,['exec','--json','--skip-git-repo-check','-']);
      const child=fakeChild();child.stdin.on('data',chunk=>{input+=chunk.toString();});
      child.stdin.on('end',()=>queueMicrotask(()=>{
        child.stdout.write(`${JSON.stringify({type:'thread.started',thread_id:threadId})}\n${JSON.stringify({type:'turn.completed'})}\n`);
        child.emit('close',0);
      }));return child;
    },
  };
  const result=await provisionAssistantCodexChat({deliveryId,cwd},options);
  assert.equal(result.threadId,threadId);assert.match(input,/Do not use tools/u);
  assert.ok(input.startsWith(assistantDeliveryMarker(deliveryId)+'\n'));
  await assert.rejects(provisionAssistantCodexChat({deliveryId:randomUUID(),cwd},{...options,onThreadStarted:()=>{throw new Error('private disk failure');}}),/DELIVERY_UNCERTAIN/);
});

test('native execution uses the exact chat/cwd, stdin marker, one-use start and positive live read-back', async t => {
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-codex-test-'));
  t.after(() => fs.rm(cwd,{ recursive:true,force:true }));
  const threadId=randomUUID(),deliveryId=randomUUID(),turnId=randomUUID();
  const expectedCwd = await fs.realpath(cwd);
  let starts=0,reads=0,launches=0,input='';
  const options = { executable:process.execPath,environment:{ PATH:process.env.PATH,SHOULD_NOT_PASS:'private' },
    startInvocation:() => { if (starts++) throw new Error('private state error'); },
    readMetadata:async () => ({ threadId,cwd }), readDelivery:async () => ++reads===1 ? { state:'uncertain' }
      : { state:'completed',turnId,receipt:`codex:${threadId}:${turnId}` },
    spawnProcess:(_executable,args,spawnOptions) => {
      launches++; assert.deepEqual(args,['exec','resume',threadId,'--json','--skip-git-repo-check','-']);
      assert.equal(spawnOptions.shell,false); assert.equal(spawnOptions.cwd,expectedCwd);
      assert.equal(spawnOptions.env.SHOULD_NOT_PASS,undefined);
      assert.ok(!args.some(arg => /bypass|ignore-rules|ignore-user-config|approval|sandbox/u.test(arg)));
      const child=fakeChild(); child.stdin.on('data',chunk=>{ input+=chunk.toString(); });
      child.stdin.on('end',()=>queueMicrotask(()=>{
        child.stdout.write(`${JSON.stringify({ type:'thread.started',thread_id:threadId })}\n${JSON.stringify({ type:'turn.completed' })}\n`);
        child.emit('close',0);
      })); return child;
    },
  };
  const result=await runAssistantCodexPass({ threadId,deliveryId,cwd },options);
  assert.equal(result.state,'completed'); assert.equal(launches,1); assert.equal(starts,1);
  assert.ok(input.startsWith(assistantDeliveryMarker(deliveryId)+'\n'));
  // A lost/empty history lookup cannot bypass the durable first-attempt fence.
  reads=0;
  await assert.rejects(runAssistantCodexPass({ threadId,deliveryId,cwd },options), /DELIVERY_NOT_STARTED/);
  assert.equal(launches,1);
});

test('a successful CLI exit/queue claim without exact completed-turn read-back remains uncertain', async t => {
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-codex-test-'));
  t.after(()=>fs.rm(cwd,{ recursive:true,force:true }));
  const threadId=randomUUID(),deliveryId=randomUUID();
  await assert.rejects(runAssistantCodexPass({ threadId,deliveryId,cwd },{
    executable:process.execPath,environment:{},startInvocation:()=>{},readMetadata:async()=>({ threadId,cwd }),
    readDelivery:async()=>({ state:'uncertain' }),spawnProcess:()=>{
      const child=fakeChild();child.stdin.resume();child.stdin.on('end',()=>queueMicrotask(()=>{
        child.stdout.write(`${JSON.stringify({ type:'thread.started',thread_id:threadId })}\n${JSON.stringify({ type:'turn.completed' })}\n`);
        child.emit('close',0);
      }));return child;
    },
  }),/DELIVERY_UNCERTAIN/);
});
