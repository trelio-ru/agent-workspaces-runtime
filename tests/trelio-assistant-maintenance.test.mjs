import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { assistantHealthCompatibility, assistantHealthFailure, assistantHealthyBoundary, maintainAssistantHost, requestCurrentAssistantRuntime, reportAssistantMaintenanceFailure } from '../host-runtime/scripts/trelio-assistant-entry.mjs';
import { runAssistantEntry } from '../host-runtime/scripts/trelio-assistant-entry.mjs';

const versions={pluginVersion:'3.2.3',hostRuntimeVersion:'5.0.0'};
const snapshot=()=>({revision:0,generation:0,code:'ready',latchedCodes:[],compatibility:{minimumPluginVersion:'3.2.3',minimumRuntimeVersion:'4.9.0'}});
const fixture=()=>{
  let state=snapshot();const reports=[];
  return {reports,get state(){return state;},set state(value){state={...value,latchedCodes:[...new Set([...(value.latchedCodes??[]),...(['codex_auth_required','hook_review_required'].includes(value.code)?[value.code]:[])])]};},
    client:{readHealth:async()=>structuredClone(state),reportHealth:async input=>{
      assert.equal(input.expectedRevision,state.revision);assert.match(input.clientRequestId,/^[a-f0-9-]{36}$/u);
      const latched=new Set(state.latchedCodes);if(['codex_auth_required','hook_review_required'].includes(input.code))latched.add(input.code);
      if(input.clearedReason)latched.delete(input.clearedReason);
      const code=input.code==='ready'?(latched.has('codex_auth_required')?'codex_auth_required':latched.has('hook_review_required')?'hook_review_required':'ready'):input.code;
      reports.push(input);state={...state,revision:state.revision+1,code,latchedCodes:[...latched]};return state;
    }},
  };
};

test('optional releases do not block; real shared minimum is checked without relying on model errors',()=>{
  assert.equal(assistantHealthCompatibility(snapshot(),versions),null);
  assert.equal(assistantHealthCompatibility({...snapshot(),compatibility:{minimumPluginVersion:'3.2.4',minimumRuntimeVersion:'4.9.0'}},versions),'plugin_update_required');
  assert.equal(assistantHealthCompatibility({...snapshot(),compatibility:{minimumPluginVersion:'3.2.3',minimumRuntimeVersion:'5.0.1'}},versions),'runtime_update_failed');
  assert.throws(()=>assistantHealthCompatibility({...snapshot(),compatibility:{minimumPluginVersion:'garbage'}},versions),/INVALID_RESPONSE/);
  assert.equal(assistantHealthFailure(new Error('Please reinstall plugin PRIVATE')),null,'never infer a cause from prose');
  for(const code of ['__proto__','constructor','toString'])assert.equal(assistantHealthFailure({code}),null,'health identity is a closed own-key map');
});

test('maintenance has no model turn, retries only signed update and cannot clear an unrelated auth/trust failure',async()=>{
  const f=fixture();let probes=0,updates=0;
  const options={client:f.client,versions,update:async()=>{updates++;},probe:async()=>{probes++;}};
  await maintainAssistantHost(options);assert.equal(f.state.code,'ready');
  f.state={...f.state,code:'hook_review_required'};await maintainAssistantHost(options);
  assert.equal(f.state.code,'hook_review_required','metadata success is not hook approval');
  f.state={...f.state,code:'codex_auth_required'};await maintainAssistantHost(options);assert.equal(f.state.code,'codex_auth_required');
  await maintainAssistantHost({...options,update:async()=>{throw new Error('PRIVATE update log');}});
  assert.equal(f.state.code,'runtime_update_failed');assert.ok(f.state.latchedCodes.includes('codex_auth_required'));
  await maintainAssistantHost(options);assert.equal(f.state.code,'codex_auth_required','the newer updater error did not erase native login');
  f.state={...snapshot(),revision:f.state.revision,code:'runtime_update_failed'};
  await maintainAssistantHost(options);assert.equal(f.state.code,'ready');
  assert.equal(updates,5);assert.equal(probes,6);
  assert.ok(!JSON.stringify(f.reports).includes('PRIVATE'));
});

test('confirmed plugin floor requests owner action even if updater fails; unknown network error never reports recovery',async()=>{
  const f=fixture();f.state={...f.state,compatibility:{minimumPluginVersion:'3.3.0',minimumRuntimeVersion:'4.9.0'}};
  await maintainAssistantHost({client:f.client,versions,update:async()=>{throw new Error();},probe:async()=>assert.fail('obsolete plugin must not probe business')});
  assert.equal(f.state.code,'plugin_update_required');
  f.state={...snapshot(),code:'connection_lost'};
  const before=f.reports.length;
  await assert.rejects(maintainAssistantHost({client:f.client,versions,update:async()=>{},probe:async()=>{throw Object.assign(new Error(),{code:'ASSISTANT_TRANSPORT_UNAVAILABLE'});}}));
  assert.equal(f.reports.length,before);
});

test('current-runtime request uses the exact loader, bounded stdin/UTF-8 output, and never retries the tool',async()=>{
  let calls=0,received;
  const result=await requestCurrentAssistantRuntime({operation:'call',name:'get_task',arguments:{note:'Привет'}},{
    environment:{TRELIO_PLUGIN_ROOT:'/fixture/plugin'},resolveLoader:async()=>'/fixture/plugin/scripts/trelio-host-runtime-loader.mjs',
    spawnProcess:(executable,args,options)=>{
      calls++;assert.equal(executable,process.execPath);assert.deepEqual(args,['/fixture/plugin/scripts/trelio-host-runtime-loader.mjs','bridge','assistant','request']);
      assert.equal(options.shell,false);assert.deepEqual(options.stdio,['pipe','pipe','ignore']);
      const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{};
      let input='';child.stdin.on('data',chunk=>input+=chunk);child.stdin.on('finish',()=>queueMicrotask(()=>{
        received=JSON.parse(input);const bytes=Buffer.from(JSON.stringify({value:{text:'Привет'}}));
        const split=bytes.indexOf(Buffer.from('П'))+1;child.stdout.write(bytes.subarray(0,split));child.stdout.write(bytes.subarray(split));child.emit('close',0);
      }));return child;
    },
  });
  assert.deepEqual(result,{text:'Привет'});assert.equal(received.arguments.note,'Привет');assert.equal(calls,1);
  await assert.rejects(requestCurrentAssistantRuntime({operation:'call',name:'get_task',arguments:{},command:'PRIVATE'},{resolveLoader:async()=>assert.fail('invalid input touched loader')}),/REQUEST_INVALID/);
});

test('worker preserves one response and never exposes raw exceptions or copies credentials',async()=>{
  const output=new PassThrough();let raw='';output.on('data',chunk=>raw+=chunk);
  await runAssistantEntry(['request'],{input:Readable.from([JSON.stringify({operation:'list'})]),output,
    executeRequest:async()=>{throw new Error('PRIVATE CREDENTIAL');}});
  assert.ok(!raw.includes('PRIVATE'));assert.equal(JSON.parse(raw).failure,'ASSISTANT_SETUP_UNAVAILABLE');
});

test('the longer private worker wait is reserved for the fixed protected setup tools, never general commands',async()=>{
  let spawns=0;
  const options={timeoutMs:11*60_000,resolveLoader:async()=>'/fixture/loader.mjs',spawnProcess:()=>{
    spawns++;const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{};
    child.stdin.resume();child.stdin.on('finish',()=>queueMicrotask(()=>{child.stdout.write(JSON.stringify({value:{state:'configuration_saved'}}));child.emit('close',0);}));return child;
  }};
  await assert.rejects(requestCurrentAssistantRuntime({operation:'call',name:'get_task',arguments:{}},options),/REQUEST_INVALID/);
  assert.equal(spawns,0);
  for(const name of ['configure_assistant_email_source','configure_assistant_telegram_source','configure_assistant_max_source']){
    const before=spawns;
    const result=await requestCurrentAssistantRuntime({operation:'call',name,arguments:{}},options);
    assert.equal(result.state,'configuration_saved');assert.equal(spawns,before+1);
    await assert.rejects(requestCurrentAssistantRuntime({operation:'call',name,arguments:{}},
      {...options,timeoutMs:11*60_000+1}),/REQUEST_INVALID/);
    assert.equal(spawns,before+1);
  }
});

test('a failed worker invocation is not retried or replaced with a human profile',async()=>{
  let spawns=0;
  await assert.rejects(requestCurrentAssistantRuntime({operation:'call',name:'get_task',arguments:{}},{
    resolveLoader:async()=>'/fixture/loader.mjs',spawnProcess:()=>{
      spawns++;const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{};
      child.stdin.resume();child.stdin.on('finish',()=>queueMicrotask(()=>{
        child.stdout.write(JSON.stringify({failure:'ASSISTANT_ACCESS_DENIED'}));child.emit('close',0);
      }));return child;
    },
  }),{code:'ASSISTANT_ACCESS_DENIED'});
  assert.equal(spawns,1);
});

test('a vanished exact loaded shell reports restart through the protected control plane without another loader',async()=>{
  const f=fixture();
  await reportAssistantMaintenanceFailure({code:'TRELIO_PLUGIN_RESTART_REQUIRED',message:'PRIVATE path'},f.client);
  assert.equal(f.state.code,'plugin_restart_required');
  assert.ok(!JSON.stringify(f.reports).includes('PRIVATE'));
  await maintainAssistantHost({client:f.client,versions,update:async()=>{},probe:async()=>{}});
  assert.equal(f.state.code,'ready','a new worker through the valid loaded shell confirms restart recovery');
  const before=f.reports.length;
  await reportAssistantMaintenanceFailure({code:'UNKNOWN',message:'Please reinstall'},f.client);
  assert.equal(f.reports.length,before);
});

test('only a successful protected read clears hook review; metadata cannot clear native login',()=>{
  const current={code:'plugin_update_required',latchedCodes:['hook_review_required','codex_auth_required']};
  assert.deepEqual(assistantHealthyBoundary(current,{operation:'list'}),{code:'ready'});
  assert.deepEqual(assistantHealthyBoundary(current,{operation:'call',name:'get_assistant_status'}),{code:'ready'});
  assert.deepEqual(assistantHealthyBoundary(current,{operation:'call',name:'prepare_assistant_source_account'}),{code:'ready'});
  assert.deepEqual(assistantHealthyBoundary(current,{operation:'call',name:'configure_assistant_email_source'}),{code:'ready'});
  assert.deepEqual(assistantHealthyBoundary(current,{operation:'call',name:'verify_assistant_email_source'}),{code:'ready'});
  assert.deepEqual(assistantHealthyBoundary(current,{operation:'call',name:'get_task'}),{code:'ready',clearedReason:'hook_review_required'});
});
