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
import {withProductionAssistantWorkspace,withProductionAssistantManagedContent,createProductionAssistantMcp,
  executeAssistantCompanyContextRequest,executeAssistantRuntimeRequest,assistantProductionContextSignal} from '../../../host-runtime/scripts/trelio-assistant-entry.mjs';

const SAME_ORIGINS=new Set(['https://trelio.ru','https://e2ee.trelio.ru']);

export const openNativeCompanyScenario=async(configuration,{sourcePackage}={})=>{
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
  const continuationBeginFaults={attempts:0,lostCommitted:false};
  globalThis.fetch=async(input,options={})=>{
    const selected=new URL(input instanceof Request?input.url:input);
    assert.ok(SAME_ORIGINS.has(selected.origin),'fixture cannot contact an external origin');
    // Keep the actual production path/query/body/headers. The synthetic native
    // server independently checks these, recipient/pass/proof and ciphertext
    // bindings. Only the network destination changes to its owned loopback.
    const target=new URL(selected.pathname+selected.search,server);
    const response=await originalFetch(target,{...options,redirect:'error',headers:new Headers(options.headers)});
    if(configuration.loseContinuationBegin&&selected.pathname==='/api/digital-assistants/runtime/source-skills/intake/begin'
      &&options.method==='POST'&&typeof options.body==='string'&&(JSON.parse(options.body).readOnlyRecovery?.readOnlyContinuation===true||JSON.parse(options.body).readOnlyRecovery?.generationReplyCorrection===true||JSON.parse(options.body).readOnlyRecovery?.replyDispatchCorrection===true)){
      continuationBeginFaults.attempts++;
      if(response.ok&&!continuationBeginFaults.lostCommitted){
        // Receive the REAL server's committed native result, then lose only
        // its transport outcome. No handwritten admission/receipt substitutes
        // the backend, and the production HTTP codec must refuse automatic retry.
        await response.arrayBuffer();continuationBeginFaults.lostCommitted=true;
        throw new TypeError('synthetic committed begin transport loss');
      }
    }
    return response;
  };
  const directory=path.join(root,'native-context','digital-assistants');
  const store=createAssistantPrivateStore({directory:path.join(directory,'credentials')});
  const host=createAssistantHostState({directory,store});
  const identity=configuration.identity;
  const client=createAssistantDeviceClient({...identity,http:createAssistantHttp({origin:identity.origin}),store});
  const context=async(action,options={})=>{
    // Keep the production private-session clock for EVERY child. The parent
    // alone injects its planned owned query deadlines and cancels their real
    // pending HTTP bodies. A second shortened child clock would race that
    // provenance and incorrectly time out successful recovered/warm reads.
    const signal=assistantProductionContextSignal(options);
    return withPrivateProcessSession(()=>action(client,host,store),signal);
  };
  const withProfile=(action,options={})=>withProductionAssistantWorkspace(action,{...options,context});
  const httpRequest=async(input,options)=>{
    const response=await remoteMcpHttpRequest(input,{...options,resolveEndpoint:async endpoint=>{
    assert.equal(endpoint,'https://trelio.ru/mcp/assistant');
    return {endpoint:new URL('/mcp/assistant',server),address:'127.0.0.1',family:4};
    }});
    if(configuration.nativeBackend===true&&input.payload?.method==='tools/list'){
      const tools=response.message?.result?.tools;
      await fs.appendFile(path.join(root,'fixture-diagnostics.jsonl'),JSON.stringify({operation:'native_catalogue',
        bytes:Buffer.byteLength(JSON.stringify(tools??[])),toolCount:Array.isArray(tools)?tools.length:null,
        objectSchemas:Array.isArray(tools)&&tools.every(tool=>tool.inputSchema?.type==='object')})+'\n');
    }
    if(configuration.nativeBackend===true&&input.payload?.method==='tools/call'){
      const result=response.message?.result;
      await fs.appendFile(path.join(root,'fixture-diagnostics.jsonl'),JSON.stringify({operation:'native_result',
        tool:input.payload.params?.name,bytes:Buffer.byteLength(JSON.stringify(result??null)),
        contentTypes:Array.isArray(result?.content)?result.content.map(item=>item.type):null,
        contentCount:result?.content?.length??null,structured:typeof result?.structuredContent,
        isError:result?.isError??null,code:result?.structuredContent?.code??null})+'\n');
    }
    return response;
  };
  // The production content protector must share this fixture's SAME native
  // private context too. Its default context deliberately reads the real host
  // namespace, which is absent in an isolated fixture and cannot be borrowed.
  const withManagedContent=(request,send)=>withProductionAssistantManagedContent(request,send,{context,withProfile});
  const proxyFor=options=>createProductionAssistantMcp({...options,context,withProfile,withManagedContent,httpRequest,sourcePackage});
  return {
    store,host,client,context,withProfile,
    execute:async request=>{
      // Count real opened ciphertext generations in this isolated child only.
      // No path/content is logged and the ordinary fd/ACL/crypto reader remains
      // unchanged. This catches an accidental second whole-mirror decrypt in
      // the same fresh managed invocation, including legacy facade requests.
      const originalOpen=fs.open,originalReaddir=fs.readdir;let generationReads=0,scratchInventories=0,slowWarmReads=0;
      fs.readdir=async(file,...rest)=>{
        if(typeof file==='string'&&file.startsWith(root+path.sep)&&/[/\\]search-files-v1$/u.test(file))scratchInventories++;
        return originalReaddir(file,...rest);
      };
      fs.open=async(file,flags,...rest)=>{
        const handle=await originalOpen(file,flags,...rest);
        if(typeof file==='string'&&file.startsWith(root+path.sep)&&typeof flags==='number'&&(flags&3)===0
          &&/[/\\]generations[/\\][0-9a-f]{64}\.json$/u.test(file)){
          generationReads++;
          if(request.operation==='company_context_read'&&configuration.slowLegacyGenerationRead===true)
            await new Promise(resolve=>setTimeout(resolve,24000));
          // Deterministically expose the former blanket ten-second fault
          // clock on an ordinary warm query. Its genuine reader remains under
          // the original production deadline and still checks native ACLs.
          if(generationReads===1&&request.operation==='company_context_search'&&configuration.slowRecoveredWarmSearch===true
            &&request.arguments?.queries?.[0]?.startsWith('COLD_VOLUME_CANARY_')){
            slowWarmReads++;
            await new Promise(resolve=>setTimeout(resolve,12000));
          }
        }
        return handle;
      };
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
      }finally{
        fs.open=originalOpen;fs.readdir=originalReaddir;
        if(['company_context_search','company_context_read'].includes(request.operation))
          await fs.appendFile(path.join(root,'fixture-diagnostics.jsonl'),JSON.stringify({operation:request.operation,generationReads,scratchInventories,slowWarmReads})+'\n');
      }
    },
    continuationBeginFaults,
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
