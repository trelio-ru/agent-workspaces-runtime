#!/usr/bin/env node
/** Maintainer-only acceptance launcher, deliberately outside the signed payload.
 * It composes the SAME verified runtime exports; it never installs a plugin,
 * edits its cache pointer, supplies a credential or fabricates native readiness.
 * Every fresh request/Workspace child rereads this exact public configuration
 * hash and asks the installed shell verifier for the pinned signed package. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {isIP} from 'node:net';
import {fileURLToPath,pathToFileURL} from 'node:url';

const SELF=fileURLToPath(import.meta.url);
const fail=()=>{throw Object.assign(new Error('ASSISTANT_QA_PILOT_UNAVAILABLE'),{code:'ASSISTANT_QA_PILOT_UNAVAILABLE'});};
const contained=(parent,child)=>{const relative=path.relative(parent,child);return !relative||!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative);};
export const normalizeAssistantQaConfiguration=value=>{
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join(',')!==
    'configurationDirectory,origin,packageSha256,pluginRoot,runtimeVersion,schemaVersion'
    ||value.schemaVersion!==1||!/^\d+\.\d+\.\d+$/u.test(value.runtimeVersion??'')
    ||!/^[a-f0-9]{64}$/u.test(value.packageSha256??''))fail();
  const [major,minor]=value.runtimeVersion.split('.').map(Number);
  if(major<3||major===3&&minor<18)fail();
  const origin=new URL(value.origin);
  if(origin.origin!==value.origin||origin.protocol!=='https:'||origin.username||origin.password
    ||['trelio.ru','www.trelio.ru','e2ee.trelio.ru'].includes(origin.hostname.replace(/\.$/u,'')))fail();
  if(isIP(origin.hostname.replace(/^\[|\]$/gu,''))&&!['127.0.0.1','[::1]'].includes(origin.hostname))fail();
  for(const key of ['configurationDirectory','pluginRoot'])if(typeof value[key]!=='string'||!path.isAbsolute(value[key])||value[key].includes('\0'))fail();
  return Object.freeze({...value,configurationDirectory:path.resolve(value.configurationDirectory),pluginRoot:path.resolve(value.pluginRoot)});
};

export const readAssistantQaConfiguration=async(file,sha256)=>{
  if(!path.isAbsolute(file??'')||!/^[a-f0-9]{64}$/u.test(sha256??''))fail();
  const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>16_384)fail();
  const bytes=await fs.readFile(file);
  if(createHash('sha256').update(bytes).digest('hex')!==sha256)fail();
  return normalizeAssistantQaConfiguration(JSON.parse(bytes.toString('utf8')));
};

/** Use the installed shell's signature/tree verifier, not a copied package
 * parser or a caller-provided runtime path. Pinning prevents a concurrent update
 * from silently changing this acceptance candidate between child invocations. */
export const loadAssistantQaRuntime=async configuration=>{
  const loader=await import(pathToFileURL(path.join(configuration.pluginRoot,'scripts','trelio-host-runtime-loader.mjs')).href);
  const selected=await loader.selectHostRuntime();
  if(!selected||selected.runtimeVersion!==configuration.runtimeVersion||selected.packageSha256!==configuration.packageSha256)fail();
  const shell=await import(pathToFileURL(path.join(configuration.pluginRoot,'scripts','trelio-host-runtime-shell.mjs')).href);
  // These are the SAME loader-supplied public component versions, never an
  // origin redirect, device identity, credential or runtime-proof override.
  process.env.TRELIO_PLUGIN_ROOT=configuration.pluginRoot;
  process.env.TRELIO_PLUGIN_VERSION=shell.PLUGIN_VERSION;
  process.env.TRELIO_HOST_RUNTIME_VERSION=selected.runtimeVersion;
  const module=async name=>import(pathToFileURL(path.join(selected.runtimeDirectory,'scripts',name)).href);
  const [entry,transport,privateRuntime,hook,setup,common,session,finish]=await Promise.all([
    module('trelio-assistant-entry.mjs'),module('trelio-assistant-transport.mjs'),module('trelio-assistant-private.mjs'),
    module('trelio-assistant-hook.mjs'),module('trelio-assistant-setup.mjs'),module('trelio-workspace.mjs'),
    module('trelio-hook-private-session.mjs'),module('trelio-workspace-finish-progress.mjs')]);
  if(entry.ASSISTANT_MAINTAINER_QA_COMPOSITION_VERSION!==1)fail();
  return {entry,transport,privateRuntime,hook,setup,common,session,finish};
};

/** Trusted JS composition only. Configuration never enters native tool args,
 * request JSON, model instructions or provider environment. The isolated state
 * still uses CurrentUser DPAPI/keyring and the ordinary immutable origin slot. */
export const createAssistantQaPilot=async({configuration,configurationFile,configurationSha256,
  modules,spawnProcess=spawn,launcher=SELF}={})=>{
  configuration=normalizeAssistantQaConfiguration(configuration);
  if(!path.isAbsolute(configurationFile??'')||!/^[a-f0-9]{64}$/u.test(configurationSha256??'')||!path.isAbsolute(launcher))fail();
  const {entry,transport,privateRuntime,hook,setup,common,session,finish}=modules??await loadAssistantQaRuntime(configuration);
  const config=configuration.configurationDirectory,origin=configuration.origin;
  const production=common.resolveWorkspaceBridgeConfigDirectory();
  if(contained(production,config)||contained(config,production))fail();
  await session.withPrivateProcessSession(()=>common.assertPrivatePathKind(configurationFile,'file'),AbortSignal.timeout(45_000));
  const directory=path.join(config,'digital-assistants');
  const privateContext=async(action,{signal,interactiveSourceSetup=false,requirePilot=true}={})=>session.withPrivateProcessSession(async()=>{
    const store=privateRuntime.createAssistantPrivateStore({directory:path.join(directory,'credentials')});
    const host=Object.freeze({...hook.createAssistantHostState({directory,store}),configurationDirectory:config});
    const identity=await host.readIdentity();if(!identity)return null;
    if(identity.origin!==origin)fail();
    const client=transport.createAssistantDeviceClient({...identity,store,http:transport.createAssistantHttp({origin})});
    if(requirePilot){
      const proxy=transport.createAssistantMcpClient({...identity,store});
      const status=await proxy.callTool('get_assistant_status',{},signal);
      if(status?.structuredContent?.stage!=='non-production-pilot'||!entry.assistantCoordinatorReadiness(status,identity))fail();
    }
    // Same profile/private worker is bounded by the ORIGINAL invocation clock;
    // the status request is part of it, not a new lease or source permission.
    return action(client,host,store);
  },signal?AbortSignal.any([signal,AbortSignal.timeout(interactiveSourceSetup?660_000:45_000)]):AbortSignal.timeout(interactiveSourceSetup?660_000:45_000));
  const withProfile=(action,options={})=>entry.withProductionAssistantWorkspace(action,{...options,context:privateContext});
  const managed=(request,send)=>entry.withProductionAssistantManagedContent(request,send,{context:privateContext,withProfile});
  const nativeMcp=(options={})=>entry.createProductionAssistantMcp({...options,context:privateContext,withProfile,withManagedContent:managed});
  const prefix=['--configuration',configurationFile,'--sha256',configurationSha256];
  // Existing request/finish runners retain their frame limits, deadlines,
  // abort/read-back and no-replay rules. Only the trusted launcher is different.
  const wrapArguments=args=>[launcher,...prefix,...args.slice(1)];
  const spawnWorker=(executable,args,options)=>spawnProcess(executable,wrapArguments(args),options);
  const request=(value,options={})=>entry.requestCurrentAssistantRuntime(value,{...options,
    resolveLoader:async()=>launcher,spawnProcess:spawnWorker});
  const runPlan=(plan,options={})=>entry.runAssistantWorkspaceProcess(plan,{...options,expectedOrigin:origin,
    resolveLoader:async()=>launcher,runProcess:(executable,args,processOptions)=>finish.runWorkspaceFinishProcess(executable,wrapArguments(args),processOptions)});
  const createWorkspace=()=>entry.createAssistantWorkspaceExecutor({runPlan,configDirectory:config,expectedOrigin:origin});
  const forwardingMcp=(options={})=>entry.createForwardingAssistantMcp({...options,request,createWorkspace,configurationDirectory:config});
  const createHost=()=>entry.createAssistantRuntimeHost({context:privateContext,dependencies:{configurationDirectory:config,
    // This is a REAL native MCP read, not an injected readiness result.
    readStatus:async signal=>(await nativeMcp()).callTool('get_assistant_status',{},signal)}});
  const background=()=>setup.createAssistantWindowsBackground({expectedOrigin:origin,
    loaderArguments:prefix,resolveLoader:async()=>launcher,
    readIdentity:()=>privateContext(client=>client.identity,{requirePilot:false}),
    verifyContact:()=>privateContext(client=>client.heartbeat())});
  const createSetup=()=>entry.createProductionAssistantSetup({expectedOrigin:origin,configurationDirectory:config,createBackground:background});
  const executeRequest=value=>entry.executeAssistantRuntimeRequest(value,{context:privateContext,proxyFor:nativeMcp,
    requestRuntime:request,upgradeRuntime:async()=>{await loadAssistantQaRuntime(configuration);},
    backgroundTick:()=>entry.runAssistantBackgroundTick({createHost})});
  const runBackground=options=>entry.runAssistantBackground({...options,request,
    readHost:()=>privateContext(async(client,host)=>({identity:client.identity,activation:await host.readActivation()})),
    verifyRegistration:async()=>process.platform==='win32'?background()('status'):null,
    reportFailure:error=>privateContext(client=>entry.reportAssistantMaintenanceFailure(error,client))});
  return Object.freeze({origin,configurationDirectory:config,context:privateContext,withProfile,createMcp:nativeMcp,
    async run(args,options={}){
      return entry.runAssistantEntry(args,{...options,createSetup,createMcp:forwardingMcp,
        createHook:()=>entry.createProductionAssistantHook({context:privateContext}),createBackground:background,
        maintenanceRequest:request,executeRequest,runBackground,
        executePlan:plan=>entry.executeAssistantWorkspacePlan(plan,{withProfile,expectedOrigin:origin})});
    }});
};

if(process.argv[1]&&path.resolve(process.argv[1])===SELF){
  const [, ,flag,file,hashFlag,hash,...raw]=process.argv;
  try{
    if(flag!=='--configuration'||hashFlag!=='--sha256')fail();
    const configuration=await readAssistantQaConfiguration(file,hash);
    const pilot=await createAssistantQaPilot({configuration,configurationFile:file,configurationSha256:hash});
    const args=raw[0]==='bridge'&&raw[1]==='assistant'?raw.slice(2):raw;
    await pilot.run(args);
  }catch{
    // Paths, native errors, provider output and configuration bytes are not a
    // diagnostic interface. Preserve hook deny/exit-0 on failed composition.
    if(raw.at(-1)==='hook')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'ASSISTANT_QA_PILOT_UNAVAILABLE'}})+'\n');
    else{process.stderr.write('ASSISTANT_QA_PILOT_UNAVAILABLE\n');process.exitCode=1;}
  }
}
