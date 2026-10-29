/**
 * Synthetic backend boundary for the composed owner-intake regression.
 *
 * This file is test-only and never enters a signed package. It replaces the
 * remote server's DATA, not the production MCP client, managed Workspace
 * profile, private store, clocks, request framing or mirror implementation.
 * Every child must use a completely disposable OS/config home. Nothing can
 * contact a real Trelio host or inherit an operator's account/keyring roots.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {createAssistantPrivateStore} from '../../../host-runtime/scripts/trelio-assistant-private.mjs';
import {createAssistantHostState} from '../../../host-runtime/scripts/trelio-assistant-hook.mjs';
import {createAssistantDeviceClient,createAssistantHttp} from '../../../host-runtime/scripts/trelio-assistant-transport.mjs';
import {remoteMcpHttpRequest} from '../../../host-runtime/scripts/trelio-remote-mcp.mjs';
import {withPrivateProcessSession} from '../../../host-runtime/scripts/trelio-hook-private-session.mjs';
import {withProductionAssistantWorkspace,createProductionAssistantMcp,
  executeAssistantCompanyContextRequest,executeAssistantRuntimeRequest,assistantProductionContextSignal} from '../../../host-runtime/scripts/trelio-assistant-entry.mjs';

const SAME_ORIGINS=new Set(['https://trelio.ru','https://e2ee.trelio.ru']);

export const openNativeCompanyScenario=async configuration=>{
  assert.equal(configuration.schema,'trelio.test.company-context/v1');
  assert.ok(['cold','owned-timeout-resume','second-timeout-hard','ordinary-refusal-hard','unknown-http-hard'].includes(configuration.caseName));
  const root=await fs.realpath(configuration.root);
  // CODEX_HOME alone does not isolate private journals/DPAPI caches. Refuse
  // before constructing any production private reader unless ALL OS roots are
  // owned by this one fixture. The parent creates this root with mkdtemp.
  for(const name of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA'])
    assert.equal(await fs.realpath(process.env[name]),root,`isolated ${name} required`);
  assert.equal(path.resolve(process.env.CODEX_HOME),path.join(root,'.codex'));
  const server=new URL(configuration.server);
  assert.equal(server.protocol,'http:');assert.equal(server.hostname,'127.0.0.1');
  assert.ok(Number(server.port)>0);assert.equal(server.pathname,'/');
  assert.equal(server.username,'');assert.equal(server.password,'');
  assert.equal(configuration.identity.origin,'https://trelio.ru');
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input,options={})=>{
    const selected=new URL(input instanceof Request?input.url:input);
    assert.ok(SAME_ORIGINS.has(selected.origin),'fixture cannot contact an external origin');
    // Keep the actual production path/query/body/headers. The synthetic native
    // server independently checks these, recipient/pass/proof and ciphertext
    // bindings. Only the network destination changes to its owned loopback.
    const target=new URL(selected.pathname+selected.search,server);
    return originalFetch(target,{...options,redirect:'error',headers:new Headers(options.headers)});
  };
  const directory=path.join(root,'native-context','digital-assistants');
  const store=createAssistantPrivateStore({directory:path.join(directory,'credentials')});
  const host=createAssistantHostState({directory,store});
  const identity=configuration.identity;
  const client=createAssistantDeviceClient({...identity,http:createAssistantHttp({origin:identity.origin}),store});
  const context=async(action,options={})=>{
    // Same invocation-local private session as the production factory. Tests
    // may cancel an original signal; no clock is extended/replaced on failure.
    // Only failure fixtures shorten the injected factory's original clock;
    // the volume case uses the exact production budgets. There is no model
    // request field/environment override and no resumed clock on one worker.
    const signal=configuration.caseName==='cold'?assistantProductionContextSignal(options):
      assistantProductionContextSignal(options,milliseconds=>AbortSignal.timeout(options.companyReadPreparation?10000:milliseconds));
    return withPrivateProcessSession(()=>action(client,host,store),signal);
  };
  const withProfile=(action,options={})=>withProductionAssistantWorkspace(action,{...options,context});
  const httpRequest=(input,options)=>remoteMcpHttpRequest(input,{...options,resolveEndpoint:async endpoint=>{
    assert.equal(endpoint,'https://trelio.ru/mcp/assistant');
    return {endpoint:new URL('/mcp/assistant',server),address:'127.0.0.1',family:4};
  }});
  const proxyFor=options=>createProductionAssistantMcp({...options,context,withProfile,httpRequest});
  return {
    store,host,client,context,withProfile,
    execute:async request=>{
      try{return await executeAssistantRuntimeRequest(request,{context,proxyFor,
        companyContextOperation:raw=>executeAssistantCompanyContextRequest(raw,{withProfile})});}
      catch(error){
        // Fixture setup diagnostics contain only source locations and closed
        // error categories. Do not serialize messages, values or OS paths.
        await fs.appendFile(path.join(root,'fixture-diagnostics.jsonl'),JSON.stringify({operation:request.operation,
          name:['Error','TypeError','RangeError','AssertionError','AssistantTransportError'].includes(error.name)?error.name:'Error',
          code:/^(?:ASSISTANT_|TRELIO_)[A-Z_]+$/u.test(error.code??'')?error.code:null,
          // Native filesystem categories are diagnostic only. Never emit the
          // Error message/path or use these categories to retry an operation.
          errno:['ENOENT','ENAMETOOLONG','EACCES','EPERM','EBUSY'].includes(error.code)?error.code:null,
          syscall:['mkdir','mkdtemp','open','rename','unlink','rmdir'].includes(error.syscall)?error.syscall:null,
          frames:String(error.stack??'').split('\n').slice(1,5)
            .map(line=>line.match(/([a-zA-Z0-9_-]+\.mjs:\d+:\d+)/u)?.[1]??'native')})+'\n');
        throw error;
      }
    },
    // Only the parent seeds a synthetic, independently generated identity and
    // observed session. Children read it through the real protected store.
    async seed({credential,pass,runtime}){
      await context(async()=>{
        await host.saveIdentity(identity);
        await store.put({origin:identity.origin,kind:'device',id:identity.assistantId},
          {assistantId:identity.assistantId,deviceId:identity.deviceId,credential,expiresAt:1});
        await store.put({origin:identity.origin,kind:'runtime',id:pass.passId},runtime);
        await host.activatePass(pass);
      });
    },
    close(){globalThis.fetch=originalFetch;},
  };
};
