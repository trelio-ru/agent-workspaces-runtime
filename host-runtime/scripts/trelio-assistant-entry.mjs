#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveHostRuntimeLoader, prepareHostRuntimeUpgrade } from './trelio-host-runtime-recovery.mjs';
import { requireTrelioComponentVersions } from './trelio-component-versions.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ASSISTANT_MCP_READ_TOOLS } from './trelio-assistant-transport.mjs';
import { StringDecoder } from 'node:string_decoder';
import { isDirectModuleInvocation } from './trelio-local-path.mjs';
import { createAssistantSetup } from './trelio-assistant-setup.mjs';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
const enrollment = { type: 'string', pattern: UUID };
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const ASSISTANT_SETUP_TOOLS = Object.freeze([
  { name: 'begin_assistant_setup', description: 'Begin protected computer enrollment using the owner-provided locator. Returns a pairing code for review on the owner device, never credentials.',
    inputSchema: schema({ enrollmentId: enrollment, deviceName: { type: 'string', minLength: 1, maxLength: 120 } }) },
  { name: 'finish_assistant_setup', description: 'Check owner approval and complete the one-use protected exchange. A lost exchange requires a new enrollment; never blindly retry it.',
    inputSchema: schema({ enrollmentId: enrollment }) },
  { name: 'get_assistant_setup_status', description: 'Read local setup state and, for a paired device, verify live server contact. Does not imply task execution or background service readiness.',
    inputSchema: schema({ enrollmentId: enrollment }), annotations: { readOnlyHint: true, idempotentHint: true } },
]);
const codes = new Set(['begin_assistant_setup', 'finish_assistant_setup', 'get_assistant_setup_status']);
const safeError = error => /^(?:ASSISTANT_|DIGITAL_ASSISTANTS_)[A-Z_]{1,100}$/u.test(error?.code ?? '')
  ? error.code : 'ASSISTANT_SETUP_UNAVAILABLE';

export const callAssistantSetupTool = async (setup, name, args) => {
  if (!codes.has(name)) throw Object.assign(new Error(), { code: 'ASSISTANT_CAPABILITY_UNAVAILABLE' });
  const expected = name === 'begin_assistant_setup' ? ['enrollmentId', 'deviceName'] : ['enrollmentId'];
  if (!args || Object.getPrototypeOf(args) !== Object.prototype
    || Object.keys(args).length !== expected.length || Object.keys(args).some(key => !expected.includes(key))
    || typeof args.enrollmentId !== 'string' || !new RegExp(UUID, 'u').test(args.enrollmentId)
    || (name === 'begin_assistant_setup' && (typeof args.deviceName !== 'string'
      || !args.deviceName.trim() || args.deviceName.length > 120 || /[\x00-\x1f\x7f]/u.test(args.deviceName)))) {
    throw Object.assign(new Error(), { code: 'ASSISTANT_SETUP_INVALID_INPUT' });
  }
  if (name === 'begin_assistant_setup') return setup.begin(args.enrollmentId, args.deviceName);
  if (name === 'finish_assistant_setup') return setup.finish(args.enrollmentId);
  return setup.status(args.enrollmentId);
};

/** This profile never imports/starts the human local MCP, reads its OAuth, or
 * migrates Codex configuration. Setup primitives load only for an actual
 * setup call; paired schema discovery uses the separate protected read adapter. */
export const createProductionAssistantSetup = async () => {
  const [{ createAssistantPrivateStore }, { createAssistantHttp }, common, { withPrivateProcessSession }, { createAssistantHostState }] = await Promise.all([
    import('./trelio-assistant-private.mjs'), import('./trelio-assistant-transport.mjs'), import('./trelio-workspace.mjs'),
    import('./trelio-hook-private-session.mjs'), import('./trelio-assistant-hook.mjs'),
  ]);
  const origin = 'https://trelio.ru';
  const store = createAssistantPrivateStore({ directory: path.join(common.resolveWorkspaceBridgeConfigDirectory(), 'digital-assistants', 'credentials') });
  const hostState = createAssistantHostState({ directory: path.join(common.resolveWorkspaceBridgeConfigDirectory(), 'digital-assistants'), store });
  const setup = createAssistantSetup({ origin, store, http: createAssistantHttp({ origin }) });
  // As in the common bridge, share one native worker only inside this tool
  // invocation. A long-lived MCP must not retain its ACL results or pipes.
  return Object.fromEntries(Object.entries(setup).map(([name, action]) => [name,
    (...args) => withPrivateProcessSession(async () => {
      const result = await action(...args);
      if (result.state === 'paired') await hostState.saveIdentity({ origin, assistantId: result.assistantId, deviceId: result.deviceId });
      return result;
    })]));
};

/** The host identity is selected by completed protected pairing, never tool
 * arguments or an inherited human thread. Every invocation gets its own native
 * ACL/DPAPI lifetime and the common non-sliding hook clock. */
export const createProductionAssistantHook = async () => {
  const [{ createAssistantPrivateStore }, { createAssistantHttp, createAssistantDeviceClient }, common,
    { createAssistantHostState, createAssistantTaskHook }] = await Promise.all([
    import('./trelio-assistant-private.mjs'), import('./trelio-assistant-transport.mjs'), import('./trelio-workspace.mjs'),
    import('./trelio-assistant-hook.mjs'),
  ]);
  const directory = path.join(common.resolveWorkspaceBridgeConfigDirectory(), 'digital-assistants');
  const store = createAssistantPrivateStore({ directory: path.join(directory, 'credentials') });
  const hostState = createAssistantHostState({ directory, store });
  const identity = await hostState.readIdentity();
  if (!identity) throw Object.assign(new Error(), { code: 'ASSISTANT_HOST_NOT_CONFIGURED' });
  if (identity.origin !== 'https://trelio.ru') throw Object.assign(new Error(), { code: 'ASSISTANT_HOST_STATE_INVALID' });
  const client = createAssistantDeviceClient({ ...identity, store, http: createAssistantHttp({ origin: identity.origin }) });
  return createAssistantTaskHook({ identity, client, store, readActivePass: hostState.readActivePass,
    lockDirectory: path.join(directory, 'runtime-locks') });
};

/** Schema discovery before enrollment needs no credential/private worker.
 * A present structural host journal switches to the ordinary protected path;
 * ACL/I/O/corruption errors are not treated as an unconfigured installation. */
export const createProductionAssistantMcp = async () => {
  const common = await import('./trelio-workspace.mjs');
  const directory = path.join(common.resolveWorkspaceBridgeConfigDirectory(), 'digital-assistants');
  try { await fs.lstat(path.join(directory, 'identity.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const [{ createAssistantPrivateStore }, { createAssistantHostState }, { createAssistantMcpClient }] = await Promise.all([
    import('./trelio-assistant-private.mjs'), import('./trelio-assistant-hook.mjs'), import('./trelio-assistant-transport.mjs'),
  ]);
  const store = createAssistantPrivateStore({ directory: path.join(directory, 'credentials') });
  const host = createAssistantHostState({ directory, store });
  const identity = await host.readIdentity();
  if (!identity || identity.origin !== 'https://trelio.ru') throw Object.assign(new Error(), { code: 'ASSISTANT_HOST_STATE_INVALID' });
  return createAssistantMcpClient({ ...identity, store });
};

// Long-lived stdio is deliberately only a facade. A fresh child resolves the
// current signed implementation for each invocation without reconnecting Codex.
export const createForwardingAssistantMcp = async () => {
  // Preserve secret-free pre-enrollment discovery. A source-only or not-yet
  // paired installation must not require a loader, private worker or network.
  const common=await import('./trelio-workspace.mjs');
  try {await fs.lstat(path.join(common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants','identity.json'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  return {listTools:signal=>requestCurrentAssistantRuntime({operation:'list'},{signal}),
    callTool:(name,args,signal)=>requestCurrentAssistantRuntime({operation:'call',name,arguments:args},{signal})};
};

/** Bounded JSON-lines MCP facade for setup and declared read capabilities. No raw incoming body, transport
 * exception or store envelope is returned/logged. Calls are serialized, so two
 * exchanges from this client cannot race its one-use private journal. */
export const runAssistantSetupMcp = async ({ input = process.stdin, output = process.stdout,
  createSetup = createProductionAssistantSetup, createMcp = createForwardingAssistantMcp } = {}) => {
  let setup, initialized = false, busy = false, maintenance = null, maintenanceController = null;
  const controller=new AbortController();
  const tick=()=>{
    if(busy || maintenance || controller.signal.aborted)return;
    maintenanceController=new AbortController();
    const signal=AbortSignal.any([controller.signal,maintenanceController.signal]);
    maintenance=requestCurrentAssistantRuntime({operation:'health'},{signal}).catch(error=>
      signal.aborted?undefined:reportAssistantMaintenanceFailure(error).catch(()=>undefined)).finally(()=>{maintenance=null;maintenanceController=null;});
  };
  const timer=createMcp===createForwardingAssistantMcp?setInterval(()=>{if(initialized)tick();},300_000):null;
  timer?.unref();
  const reply = value => output.write(JSON.stringify(value) + '\n');
  const withProxy = async action => {
    const { withPrivateProcessSession, runtimeHookSignal } = await import('./trelio-hook-private-session.mjs');
    // One deadline covers journal/DPAPI, initialization, request, body and
    // cleanup. A long-lived stdio process never caches a private worker/token.
    return withPrivateProcessSession(async () => action(await createMcp(), runtimeHookSignal()), AbortSignal.timeout(45_000));
  };
  const dispatch = async message => {
    const requestId = message?.id;
    const hasId = typeof requestId === 'string' && requestId.length <= 128 || Number.isSafeInteger(requestId);
    if (!hasId) return; // Notifications, including cancellation, have no response.
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return reply({ jsonrpc: '2.0', id: requestId, error: { code: -32600, message: 'Invalid request' } });
    }
    const respond = result => reply({ jsonrpc: '2.0', id: requestId, result });
    if (message.method === 'initialize' && !initialized) {
      initialized = true;
      return respond({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'trelio-assistant', version: '1.0.0' },
        instructions: 'This computer uses assistant device pairing, not human OAuth. Setup/contact alone does not authorize task work.' });
    }
    if (message.method === 'ping') return respond({});
    if (!initialized) return reply({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message: 'Initialize first' } });
    if (message.method === 'tools/list') {
      try { return respond({ tools: [...ASSISTANT_SETUP_TOOLS, ...await withProxy((proxy, signal) => proxy ? proxy.listTools(signal) : [])] }); }
      catch (error) { return reply({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message: safeError(error) } }); }
    }
    if (message.method === 'tools/call') {
      try {
        // Validate before touching private storage. Unknown tools cannot cause
        // an auth read or be delegated to another MCP implementation.
        if (ASSISTANT_MCP_READ_TOOLS.includes(message.params?.name)
          || createMcp===createForwardingAssistantMcp && !codes.has(message.params?.name)
            && /^[a-z][a-z0-9_]{0,99}$/u.test(message.params?.name ?? '')) {
          if (!message.params.arguments || Object.getPrototypeOf(message.params.arguments) !== Object.prototype) {
            throw Object.assign(new Error(), { code: 'ASSISTANT_TASK_INPUT_INVALID' });
          }
          return respond(await withProxy((proxy, signal) => {
            if (!proxy) throw Object.assign(new Error(), { code: 'ASSISTANT_HOST_NOT_CONFIGURED' });
            return proxy.callTool(message.params.name, message.params.arguments, signal);
          }));
        }
        if (!codes.has(message.params?.name)) throw Object.assign(new Error(), { code: 'ASSISTANT_CAPABILITY_UNAVAILABLE' });
        // The adapter is constructed once but every paired status revalidates
        // the protected slot and live device. It contains no cached authority.
        setup ??= await createSetup();
        const result = await callAssistantSetupTool(setup, message.params.name, message.params.arguments);
        respond({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
        if (message.params.name === 'finish_assistant_setup' && result.state === 'paired') {
          reply({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        }
        return;
      } catch (error) {
        const result = { code: safeError(error) };
        return respond({ isError: true, content: [{ type: 'text', text: result.code }], structuredContent: result });
      }
    }
    return reply({ jsonrpc: '2.0', id: requestId, error: { code: -32601, message: 'Method not found' } });
  };
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const consume = async text => {
    pending += text;
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (Buffer.byteLength(line) > 131_072) throw new Error('ASSISTANT_MCP_FRAME_TOO_LARGE');
      let parsed; try { parsed = JSON.parse(line); } catch {
        reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue;
      }
      // Work has priority over safe metadata/download maintenance. Cancelling
      // that child does not authorize replay of any business request.
      if(maintenance){maintenanceController?.abort();await maintenance;}
      busy=true;try {await dispatch(parsed);} finally {busy=false;}
    }
    if (Buffer.byteLength(pending) > 131_072) throw new Error('ASSISTANT_MCP_FRAME_TOO_LARGE');
  };
  try {
    for await (const chunk of input) await consume(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    await consume(decoder.end());
    if (pending.trim()) await consume('\n');
  } finally {
    if(timer)clearInterval(timer);controller.abort();await maintenance;
  }
};

export const runAssistantEntry = async (args, options = {}) => {
  if (args.length !== 1 || !['mcp', 'hook', 'request'].includes(args[0])) throw new Error('ASSISTANT_COMMAND_UNSUPPORTED');
  if (args[0] === 'mcp') return runAssistantSetupMcp(options);
  if (args[0] === 'request') {
    let bytes=0;const chunks=[];
    for await (const chunk of options.input ?? process.stdin) {
      const part=Buffer.from(chunk);bytes+=part.length;if(bytes>131072)throw new Error('ASSISTANT_MCP_FRAME_TOO_LARGE');chunks.push(part);
    }
    const body=Buffer.concat(chunks).toString('utf8');
    const output=options.output ?? process.stdout;
    try {
      const request=JSON.parse(body);
      output.write(JSON.stringify({value:await (options.executeRequest ?? executeAssistantRuntimeRequest)(validateAssistantRuntimeRequest(request))})+'\n');
    } catch(error) {output.write(JSON.stringify({failure:safeError(error)})+'\n');}
    return;
  }
  let bytes = 0, text = '';
  for await (const chunk of options.input ?? process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 131_072) throw new Error('ASSISTANT_MCP_FRAME_TOO_LARGE');
    text += chunk.toString();
  }
  let event; try { event = JSON.parse(text); } catch { throw new Error('ASSISTANT_HOOK_INVALID_INPUT'); }
  const tool = String(event.tool_name ?? '');
  const name = tool.split(/__|[:./-]/u).at(-1);
  const assistantTool = /^(?:mcp__)?trelio[-_]assistant__|^mcp__plugin_trelio-digital-assistant_trelio-assistant__|^(?:mcp[:./-])?trelio-assistant[:./-]/u.test(tool);
  let decision = {};
  if (event.hook_event_name === 'PreToolUse' && assistantTool && !codes.has(name) && name !== 'get_assistant_status') {
    const { withRuntimeHookPrivateSession } = await import('./trelio-hook-private-session.mjs');
    const { resolveRuntimeHookStartedAt, runtimeHookRemainingMilliseconds } = await import('./trelio-runtime-session-limits.mjs');
    try {
      decision = await withRuntimeHookPrivateSession(runtimeHookRemainingMilliseconds(event.hook_event_name,
        { startedAt: resolveRuntimeHookStartedAt() }), async () => {
        const hook = await (options.createHook ?? createProductionAssistantHook)();
        return hook(event, name);
      });
    } catch (error) {
      const suppliedCode = error?.diagnosticCode ?? error?.code;
      const code = /^(?:ASSISTANT_|TRELIO_)[A-Z_]{1,100}$/u.test(suppliedCode ?? '')
        ? suppliedCode : 'ASSISTANT_HOOK_UNAVAILABLE';
      decision = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: code } };
    }
  } else if (event.hook_event_name === 'SessionStart' && event.source === 'compact') {
    const { TRELIO_COMPACTION_RECOVERY_CONTEXT } = await import('./trelio-context-recovery.mjs');
    decision = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: TRELIO_COMPACTION_RECOVERY_CONTEXT } };
  } else if (event.hook_event_name === 'SessionEnd') {
    const { withRuntimeHookPrivateSession } = await import('./trelio-hook-private-session.mjs');
    const { resolveRuntimeHookStartedAt, runtimeHookRemainingMilliseconds } = await import('./trelio-runtime-session-limits.mjs');
    try { await withRuntimeHookPrivateSession(runtimeHookRemainingMilliseconds('SessionEnd',
      { startedAt: resolveRuntimeHookStartedAt() }), async () => {
      const hook = await (options.createHook ?? createProductionAssistantHook)(); await hook(event);
    }); } catch { /* No grant or retry is issued by a failed end notification. */ }
  }

  (options.output ?? process.stdout).write(JSON.stringify(decision) + '\n');
};

/** Model-free maintenance and a stable stdio -> current signed runtime ABI.
 * Never install/update/trust the plugin, restart Codex, copy human OAuth, or
 * retry a business invocation. The shell remains the sole package verifier. */

const fail = code => { throw Object.assign(new Error(code), {code}); };
const reasons = new Set(['ready','not_checked','plugin_update_required','plugin_restart_required','mcp_reconnect_required','runtime_update_failed','codex_auth_required','hook_review_required','connection_lost']);
export const assistantHealthFailure = error => ({
  AGENT_WORKSPACE_PLUGIN_UPGRADE_REQUIRED:'plugin_update_required',
  TRELIO_PLUGIN_RESTART_REQUIRED:'plugin_restart_required',
  ASSISTANT_PLUGIN_UPDATE_REQUIRED:'plugin_update_required',
  ASSISTANT_RUNTIME_UPDATE_REQUIRED:'runtime_update_failed',
  AGENT_WORKSPACE_HOST_RUNTIME_UPGRADE_REQUIRED:'runtime_update_failed',
  ASSISTANT_MCP_RECONNECT_REQUIRED:'mcp_reconnect_required',
  ASSISTANT_CODEX_AUTH_REQUIRED:'codex_auth_required',
  ASSISTANT_HOOK_REVIEW_REQUIRED:'hook_review_required',
}[error?.code] ?? null);
const version = value => typeof value === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/u.test(value);
const atLeast = (actual, minimum) => {
  if (!version(actual) || !version(minimum)) fail('ASSISTANT_HEALTH_INVALID_RESPONSE');
  const a=actual.split('.').map(Number),b=minimum.split('.').map(Number);
  for(let i=0;i<3;i++) if(a[i]!==b[i]) return a[i]>b[i];
  return true;
};
export const assistantHealthCompatibility = (state, versions) => {
  if(!state || !reasons.has(state.code) || !Number.isSafeInteger(state.revision) || state.revision<0
    || !version(state.compatibility?.minimumPluginVersion)
    || state.compatibility.minimumRuntimeVersion!==null && !version(state.compatibility.minimumRuntimeVersion)) fail('ASSISTANT_HEALTH_INVALID_RESPONSE');
  if(!atLeast(versions.pluginVersion,state.compatibility.minimumPluginVersion)) return 'plugin_update_required';
  if(state.compatibility.minimumRuntimeVersion && !atLeast(versions.hostRuntimeVersion,state.compatibility.minimumRuntimeVersion)) return 'runtime_update_failed';
  return null;
};

/** A successful metadata poll cannot claim that ChatGPT login or hook trust
 * was repaired. Those latches clear only at their own successful boundary. */
export const assistantHealthyBoundary = (current,request) => ({code:'ready',
  ...((current.code==='hook_review_required' || current.latchedCodes?.includes('hook_review_required'))
    && request.operation==='call' && request.name!=='get_assistant_status' ? {clearedReason:'hook_review_required'} : {}),
});

export const maintainAssistantHost = async ({client,probe,update,versions,signal}) => {
  let updateFailed=false;
  try { await update(); } catch { updateFailed=true; }
  const current=await client.readHealth(signal);
  let code=assistantHealthCompatibility(current,versions);
  if(!code) {
    try { await probe(signal); }
    catch(error) { code=assistantHealthFailure(error); if(!code) throw error; }
  }
  code ??= updateFailed ? 'runtime_update_failed' : 'ready';
  return client.reportHealth({expectedRevision:current.revision,clientRequestId:randomUUID(),code},signal);
};

/** Each business call selects the current immutable package through the exact
 * installed loader. The long-lived facade does not import a new module into an
 * active invocation, tear down stdio, or replay the request after an error.
 * Secrets/content travel only inside protected runtime or bounded stdin pipes. */
const validateAssistantRuntimeRequest = request => {
  if(!request || !['list','call','health','health_check'].includes(request.operation)
    || Object.keys(request).some(key=>!['operation','name','arguments'].includes(key))
    || request.operation==='call' && (typeof request.name!=='string' || !/^[a-z][a-z0-9_]{0,99}$/u.test(request.name)
      || !request.arguments || Object.getPrototypeOf(request.arguments)!==Object.prototype)
    || request.operation!=='call' && Object.keys(request).length!==1) fail('ASSISTANT_REQUEST_INVALID');
  return request;
};

export const requestCurrentAssistantRuntime = async (request, {environment=process.env,spawnProcess=spawn,
  resolveLoader=resolveHostRuntimeLoader,signal,timeoutMs=120_000}={}) => {
  validateAssistantRuntimeRequest(request);
  if(!Number.isSafeInteger(timeoutMs) || timeoutMs<50 || timeoutMs>180_000)fail('ASSISTANT_REQUEST_INVALID');
  const input=JSON.stringify(request);
  if(Buffer.byteLength(input)>131072) fail('ASSISTANT_MCP_FRAME_TOO_LARGE');
  const loader=await resolveLoader({environment});
  return new Promise((resolve,reject)=>{
    let child,done=false,bytes=0,output='';const decoder=new StringDecoder('utf8');
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);child?.kill?.();error?reject(error):resolve(value);};
    const abort=()=>finish(Object.assign(new Error(),{code:'ASSISTANT_RUNTIME_REQUEST_UNAVAILABLE'}));
    const timer=setTimeout(abort,timeoutMs);
    if(signal?.aborted)return abort();signal?.addEventListener('abort',abort,{once:true});
    try {
      child=spawnProcess(process.execPath,[loader,'bridge','assistant','request'],{
        env:environment,shell:false,windowsHide:true,stdio:['pipe','pipe','ignore'],
      });
      child.on('error',abort);child.stdin.on('error',abort);
      child.stdout.on('data',chunk=>{
        bytes+=chunk.length;if(bytes>768*1024)return abort();output+=decoder.write(chunk);
      });
      child.once('close',code=>{
        if(code!==0)return abort();
        try {
          const value=JSON.parse(output+decoder.end());
          if(value?.failure && /^(?:ASSISTANT_|DIGITAL_ASSISTANTS_)[A-Z_]{1,100}$/u.test(value.failure)) {
            return finish(Object.assign(new Error(value.failure),{code:value.failure}));
          }
          if(!value || Object.getPrototypeOf(value)!==Object.prototype || Object.keys(value).join(',')!=='value')return abort();
          finish(null,value.value);
        } catch { abort(); }
      });
      child.stdin.end(input);
    } catch { abort(); }
  });
};

const productionContext = async action => {
  const [{createAssistantPrivateStore},{createAssistantHostState},{createAssistantDeviceClient,createAssistantHttp},common,
    {withPrivateProcessSession}]=await Promise.all([
    import('./trelio-assistant-private.mjs'),import('./trelio-assistant-hook.mjs'),import('./trelio-assistant-transport.mjs'),
    import('./trelio-workspace.mjs'),import('./trelio-hook-private-session.mjs'),
  ]);
  return withPrivateProcessSession(async()=>{
    const directory=path.join(common.resolveWorkspaceBridgeConfigDirectory(),'digital-assistants');
    const store=createAssistantPrivateStore({directory:path.join(directory,'credentials')});
    const host=createAssistantHostState({directory,store});
    const identity=await host.readIdentity();
    if(!identity)return null;
    if(identity.origin!=='https://trelio.ru')fail('ASSISTANT_HOST_STATE_INVALID');
    return action(createAssistantDeviceClient({...identity,store,http:createAssistantHttp({origin:identity.origin})}),host);
  },AbortSignal.timeout(45_000));
};

/** The old plugin cache can disappear while this facade is still alive. A
 * diagnostic device report does not need that missing loader; use the retained
 * protected control plane, never another plugin path or a business fallback. */
export const reportAssistantMaintenanceFailure = async (error, client = null) => {
  const code=assistantHealthFailure(error);
  if(!code)return;
  const report=async connection=>{
    const current=await connection.readHealth();
    return connection.reportHealth({expectedRevision:current.revision,clientRequestId:randomUUID(),code});
  };
  return client?report(client):productionContext(report);
};

export const executeAssistantRuntimeRequest = async request => {
  validateAssistantRuntimeRequest(request);
  if(request.operation==='health') {
    const canUpdate=await productionContext(async (_client,host)=>!await host.readActivePass());
    if(canUpdate===null)return null;
    try {
      if(canUpdate)await prepareHostRuntimeUpgrade({timeoutMs:30_000});
      // Downloading is not activation. A new worker selected by the verified
      // pointer proves the actual loaded version before reporting recovery.
      return await requestCurrentAssistantRuntime({operation:'health_check'});
    } catch(error) {
      const direct=assistantHealthFailure(error);
      return productionContext(client=>maintainAssistantHost({client,versions:requireTrelioComponentVersions(),
        update:async()=>{throw new Error();},probe:async()=>{if(direct)fail(error.code);},
      }));
    }
  }
  if(request.operation==='health_check') {
    return productionContext(client=>maintainAssistantHost({client,
      versions:requireTrelioComponentVersions(),update:async()=>{},
      probe:async signal=>{const proxy=await createProductionAssistantMcp();if(!proxy)fail('ASSISTANT_HOST_NOT_CONFIGURED');await proxy.listTools(signal);},
    }));
  }
  if(!['list','call'].includes(request.operation))fail('ASSISTANT_REQUEST_INVALID');
  // Validate the exact tool before any credential read, as in ordinary MCP.
  const {ASSISTANT_MCP_READ_TOOLS}=await import('./trelio-assistant-transport.mjs');
  if(request.operation==='call' && !ASSISTANT_MCP_READ_TOOLS.includes(request.name))fail('ASSISTANT_CAPABILITY_UNAVAILABLE');
  return productionContext(async client=>{
    const current=await client.readHealth();
    const blocked=assistantHealthCompatibility(current,requireTrelioComponentVersions());
    if(blocked) {
      await client.reportHealth({expectedRevision:current.revision,clientRequestId:randomUUID(),code:blocked});
      fail(blocked==='plugin_update_required'?'ASSISTANT_PLUGIN_UPDATE_REQUIRED':'ASSISTANT_RUNTIME_UPDATE_REQUIRED');
    }
    const proxy=await createProductionAssistantMcp();
    if(!proxy)return request.operation==='list'?[]:fail('ASSISTANT_HOST_NOT_CONFIGURED');
    try {
      const result=await (request.operation==='list'?proxy.listTools():proxy.callTool(request.name,request.arguments));
      const code=result?.isError?assistantHealthFailure(result.structuredContent):null;
      if(code)await client.reportHealth({expectedRevision:current.revision,clientRequestId:randomUUID(),code}).catch(()=>undefined);
      if(!result?.isError) {
        const boundary=assistantHealthyBoundary(current,request);
        // Confirm contact during long active passes too. A lost diagnostic
        // response cannot discard or replay the successful business result.
        await client.reportHealth({expectedRevision:current.revision,clientRequestId:randomUUID(),...boundary}).catch(()=>undefined);
      }
      return result;
    } catch(error) {
      const code=assistantHealthFailure(error);
      if(code)await client.reportHealth({expectedRevision:current.revision,clientRequestId:randomUUID(),code}).catch(()=>undefined);
      throw error; // Never repeat the original business invocation.
    }
  }).then(result=>result ?? (request.operation==='list'?[]:fail('ASSISTANT_HOST_NOT_CONFIGURED')));
};

if (isDirectModuleInvocation(import.meta.url)) {
  runAssistantEntry(process.argv.slice(2)).catch(() => {
    if (process.argv[2] === 'hook') {
      // Preserve the common JSON-deny/exit-0 contract across Windows shells.
      // Broken input cannot silently turn a protected hook into permission.
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
        permissionDecision: 'deny', permissionDecisionReason: 'ASSISTANT_HOOK_UNAVAILABLE' } }) + '\n');
    } else { process.stderr.write('ASSISTANT_ENTRY_UNAVAILABLE\n'); process.exitCode = 1; }
  });
}
