import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough } from "node:stream";
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readCodexConversationTitle, syncRunCodexConversationTitle,resolveCodexExecutable,readWindowsCodexPackagePath,buildCodexEnvironment } from "../host-runtime/scripts/trelio-codex-conversation.mjs";
import { protectLocalActionArguments } from "../host-runtime/scripts/trelio-local-context.mjs";
import { createAgentEncryptionDevice, decryptCompanyPayload } from "../host-runtime/scripts/trelio-company-encryption.mjs";
import { synchronizeRunCodexTitle, retainLoadedCodexPluginInstallation, migrateHumanCodexHookComponent,
  inspectHumanCodexHookComponent, readAssistantPluginPublishedRef, restoreAssistantCodexPluginVersion,
  prepareAssistantCodexPluginRollbackHost, readCodexPluginUpdateInventory, startLoadedCodexPluginPreservation,
  updateCodexPluginMarketplace, readAssistantPluginLatestVersion } from "../host-runtime/scripts/trelio-workspace.mjs";
import {readCodexAssistantMarketplaceSource} from '../host-runtime/scripts/trelio-codex-routing.mjs';
import {maintainAssistantPlugin} from '../host-runtime/scripts/trelio-assistant-setup.mjs';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {provisionAssistantCodexChat,runAssistantCodexPass} from '../host-runtime/scripts/trelio-assistant-codex.mjs';

const id = "11111111-1111-4111-8111-111111111111";
const snapshot = { conversationId: id, title: "Старое название", expectedStateHash: "a".repeat(64) };

test('actual Codex isolated assistant refuses alternate tools across process restart without changing user configuration',
 {skip:!process.env.TRELIO_TEST_CODEX_CLI,timeout:120000},async t=>{
 const executable=process.env.TRELIO_TEST_CODEX_CLI,execute=promisify(execFile);
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'trelio-native-isolation-')));
 const home=path.join(root,'home'),repository=path.join(root,'repository');
 for(const dir of [home,path.join(repository,'.agents/plugins')])await fs.mkdir(dir,{recursive:true});
 const environment=buildCodexEnvironment({...process.env,HOME:home,USERPROFILE:home,CODEX_HOME:home,
   LOCALAPPDATA:path.join(home,'local'),APPDATA:path.join(home,'roaming')});
 let business=false,attempt=0,allowedCalls=0,foreignRequests=0,foreignInitializations=0,modelRequests=0,toolName=null;
 const advertised=[],toolResults=[],foreignPhases=[];let processPhase='setup',sawWorkflow=false;
 // No account or OpenAI request participates: this loopback producer supplies
 // synthetic Responses events to the real native tool registry. Malicious
 // calls deliberately name tools absent from its advertised catalogue.
 const server=http.createServer(async(req,res)=>{
  let source='';for await(const chunk of req)source+=chunk;
  const data=source?JSON.parse(source):{};
  if(req.url.startsWith('/mcp/')){
   if(req.url!=='/mcp/allowed'){
    foreignRequests++;if(data.method==='initialize'||data.method==='tools/call')foreignInitializations++;
    foreignPhases.push({process:processPhase,standalone:req.url==='/mcp/standalone',method:data.method??'stream'});
   }
   if(data.id===undefined){res.writeHead(204);res.end();return;}
   let result={};
   if(data.method==='initialize')result={protocolVersion:data.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}};
   if(data.method==='tools/list')result={tools:['get_assistant_status','use_assistant_workspace_files','use_assistant_browser'].map(name=>({
    name,description:'Synthetic admitted tool',inputSchema:{type:'object',properties:{}},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}))};
   if(data.method==='tools/call'){allowedCalls++;result={content:[{type:'text',text:'synthetic allowed result'}]};}
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:data.id,result}));return;
  }
  if(req.url!=='/v1/responses'){res.writeHead(404,{'Content-Type':'application/json'});res.end('{"error":"synthetic_route"}');return;}
  modelRequests++;
  if(business){
   const input=JSON.stringify(data);
   sawWorkflow ||= input.includes('Synthetic role from the admitted plugin')&&input.includes('Synthetic reference from the admitted plugin');
  }
  for(const row of data.input??[])if(row.type==='function_call_output'){
   const output=JSON.stringify(row.output).toLowerCase();
   toolResults.push(['unknown','unrecognized','invalid','not found','unsupported','not registered','namespace','approval','denied','connection','closed','failed','no such','mcp']
    .filter(word=>output.includes(word)));
  }
  const tools=data.tools??[];
  const names=tools.flatMap(tool=>tool.type==='namespace'?(tool.tools??[]).map(child=>`${tool.name}.${child.name}`):[tool.name??tool.type]);
  advertised.push(names);toolName??=tools.flatMap(tool=>tool.type==='namespace'
   ?(tool.tools??[]).map(child=>({name:child.name,namespace:tool.name})):[{name:tool.name}])
   .find(tool=>tool.name?.includes('get_assistant_status'));
  const rejected=['shell_command','exec_command','mcp__cua_repl__js','mcp__foreign__get_assistant_status'];
  let item;
  if(business&&attempt<=rejected.length){
   const selected=attempt<rejected.length?{name:rejected[attempt]}:toolName;attempt++;
   const name=selected.name;
   item={type:'function_call',id:`synthetic-call-${modelRequests}`,call_id:`call-${modelRequests}`,...selected,
    arguments:JSON.stringify(name==='shell_command'?{command:'synthetic forbidden command'}:name==='exec_command'?{cmd:'synthetic forbidden command'}:{})};
  }else item={id:`synthetic-message-${modelRequests}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'READY',annotations:[]}]};
  const response={id:`synthetic-response-${modelRequests}`,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const events=[['response.created',{response:{...response,status:'in_progress',output:[]}}],
    ['response.output_item.added',{output_index:0,item:item.type==='function_call'?{...item,arguments:''}:item}]];
  if(item.type==='function_call')events.push(['response.function_call_arguments.delta',{item_id:item.id,output_index:0,delta:item.arguments}],
   ['response.function_call_arguments.done',{item_id:item.id,output_index:0,arguments:item.arguments}]);
  events.push(['response.output_item.done',{output_index:0,item}],['response.completed',{response}]);
  for(const [type,fields] of events)
   res.write(`event: ${type}\ndata: ${JSON.stringify({type,...fields})}\n\n`);
  res.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const foreignScript=path.join(root,'foreign.mjs'),foreignSentinel=path.join(root,'foreign-started');
 await fs.writeFile(foreignScript,"import fs from 'node:fs';fs.writeFileSync(process.argv[2],'forbidden');\n");
 const configuration=`model="synthetic-fixture"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="fixture"\nbase_url="${origin}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n[features]\nplugins=true\nhooks=false\napps=true\nshell_tool=true\n[mcp_servers.foreign]\nurl="${origin}/mcp/standalone"\n[mcp_servers.foreign_stdio]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([foreignScript,foreignSentinel])}\n[projects.${JSON.stringify(root)}]\ntrust_level="trusted"\n`;
 await fs.writeFile(path.join(home,'config.toml'),configuration);
 const marketplace='trelio-digital-assistants';
 for(const [name,endpoint] of [['trelio-digital-assistant','allowed'],['unrelated-fixture','foreign']]){
  const plugin=path.join(repository,name);await fs.mkdir(path.join(plugin,'.codex-plugin'),{recursive:true});
  await fs.writeFile(path.join(plugin,'.codex-plugin/plugin.json'),JSON.stringify({name,version:'1.0.0',
   ...(name==='trelio-digital-assistant'?{skills:'./skills/'}:{})}));
  await fs.writeFile(path.join(plugin,'.mcp.json'),JSON.stringify({mcpServers:{[name==='trelio-digital-assistant'?'trelio-assistant':'foreign']:{url:`${origin}/mcp/${endpoint}`}}}));
  if(name==='trelio-digital-assistant'){
   const skill=path.join(plugin,'skills','assistant-task-worker');
   await fs.mkdir(path.join(skill,'references'),{recursive:true});
   await fs.writeFile(path.join(skill,'SKILL.md'),'---\nname: assistant-task-worker\ndescription: Synthetic approved workflow\n---\nSynthetic role from the admitted plugin\n');
   await fs.writeFile(path.join(skill,'references','work-state.md'),'Synthetic reference from the admitted plugin\n');
  }
 }
 await fs.writeFile(path.join(repository,'.agents/plugins/marketplace.json'),JSON.stringify({name:marketplace,plugins:
  ['trelio-digital-assistant','unrelated-fixture'].map(name=>({name,source:{source:'local',path:`./${name}`},policy:{installation:'AVAILABLE',authentication:'ON_USE'}}))}));
 const native=async args=>JSON.parse((await execute(executable,args,{cwd:root,env:environment,timeout:30000})).stdout);
 await native(['plugin','marketplace','add',repository,'--json']);
 const installed=await native(['plugin','add',`trelio-digital-assistant@${marketplace}`,'--json']);
 await native(['plugin','add',`unrelated-fixture@${marketplace}`,'--json']);
 const before=await fs.readFile(path.join(home,'config.toml'));
 // Plugin installation may inspect its newly installed synthetic endpoint.
 // The assertion below measures execution, independently of that fixture setup.
 foreignRequests=0;foreignInitializations=0;modelRequests=0;advertised.length=0;toolName=null;foreignPhases.length=0;
 await fs.rm(foreignSentinel,{force:true});
 const execution={modelId:'synthetic-fixture',effortLevel:'high',revision:1};let threadId=null,starts=0;
 const phases=[];
 const observedSpawn=(...args)=>{
  processPhase=args[1].includes('--disable')?'controlled':'metadata';
  const child=spawn(...args);let pending='';
  child.stdout.on('data',chunk=>{
   pending+=chunk.toString();let at;
   while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);
    let value;try{value=JSON.parse(line);}catch{continue;}
    if(value.result?.config)phases.push({stage:'config',ownEnabled:value.result.config.plugins?.['trelio-digital-assistant@trelio-digital-assistants']?.enabled===true,
     pluginCount:Object.keys(value.result.config.plugins??{}).length});
    if(value.result?.data?.some?.(row=>row?.name==='shell_tool'))phases.push({stage:'features',
     disabled:value.result.data.filter(row=>['shell_tool','apps','multi_agent','code_mode_host'].includes(row.name)).map(row=>row.enabled===false),more:value.result.nextCursor!==null});
    if(value.result?.data?.some?.(row=>row?.name==='trelio-assistant'))phases.push({stage:'server',rows:value.result.data.map(row=>({
     own:row.name==='trelio-assistant',foreign:row.name==='foreign',ownPlugin:row.pluginId==='trelio-digital-assistant@trelio-digital-assistants',
     status:row.runtimeStatus,tools:Object.keys(row.tools??{}).length,error:row.toolsError!==null}))});
    if(value.error)phases.push({stage:'rpc_error',code:value.error.code});
    if(value.id!==undefined&&value.method)phases.push({stage:'native_request',kind:value.method});
    if(value.params?.item?.type==='mcpToolCall')phases.push({stage:'mcp_call',status:value.params.item.status,error:!!value.params.item.error});
    if(phases.length>12)phases.shift();
   }
  });return child;
 };
 const options={executable,environment:{...environment,TRELIO_PLUGIN_ROOT:installed.installedPath},
  spawnProcess:observedSpawn,passTimeoutMs:30000,readExecutionAvailability:async()=>true,
  // Hook trust/proof has its independent native fixture; this fixture has no
  // protected backend/account and must never manufacture approval for one.
  readHookReadiness:async()=>({fingerprint:'a'.repeat(64)}),onThreadStarted:value=>{threadId=value;},
  startInvocation:()=>{starts++;},openDesktop:()=>assert.fail('isolated work cannot use a Desktop queue or browser')};
 let provision;
 try{provision=await provisionAssistantCodexChat({deliveryId:randomUUID(),cwd:root,execution},options);}
 catch(error){assert.fail(JSON.stringify({code:error.code,phases,foreignRequests,modelRequests}));}
 assert.equal(provision.state,'completed');assert.equal(provision.threadId,threadId);
 // A Desktop-style reader has its own App Server. Resume the persisted chat
 // there first, then try to start the assistant from a different process. A
 // local notLoaded report alone cannot authorize taking over the chat.
 const attach=async()=>{
  const child=spawn(executable,['app-server','--listen','stdio://'],{cwd:root,env:environment,stdio:['pipe','pipe','ignore']});
  const closed=new Promise(resolve=>child.once('close',resolve));
  const request=async(id,method,params)=>{
   const result=new Promise((resolve,reject)=>{
    let pending='';const timeout=setTimeout(()=>{child.stdout.off('data',receive);reject(new Error('native ownership probe timed out'));},5000);
    function receive(chunk){
     pending+=chunk.toString();let at;
     while((at=pending.indexOf('\n'))>=0){
      const frame=JSON.parse(pending.slice(0,at));pending=pending.slice(at+1);
      if(frame.id!==id)continue;
      clearTimeout(timeout);child.stdout.off('data',receive);resolve(frame);return;
     }
    }
    child.stdout.on('data',receive);
   });
   child.stdin.write(`${JSON.stringify({id,method,params})}\n`);return result;
  };
  const close=async()=>{child.kill();await closed;};
  try {
   await request(1,'initialize',{clientInfo:{name:'ownership-probe',version:'1'},capabilities:{experimentalApi:true}});
   child.stdin.write('{"method":"initialized"}\n');
   return {request,close};
  }catch(error){await close();throw error;}
 };
 const first=await attach();
 const passInput={threadId,deliveryId:randomUUID(),cwd:root,execution,
  taskContext:{assistantId:randomUUID(),companyId:randomUUID(),taskId:randomUUID()}};
 try {
  const resumed=await first.request(2,'thread/resume',{threadId,cwd:root,excludeTurns:true});
  assert.equal(resumed.result?.thread?.id,threadId);
  const requestsBefore=modelRequests;
  await assert.rejects(runAssistantCodexPass(passInput,options),{code:'ASSISTANT_CODEX_THREAD_BUSY'});
  assert.equal(starts,1,'a competing writer cannot spend another invocation');
  assert.equal(modelRequests,requestsBefore,'a competing writer cannot send a model request');
 } finally {await first.close();}
 // The ordinary native client above can connect its own foreign tools. The
 // assistant execution below must independently deny those same tools.
 foreignRequests=0;foreignInitializations=0;foreignPhases.length=0;
 await fs.rm(foreignSentinel,{force:true});
 // Production stopped its first owned writer. Resume that SAME persisted chat
 // through a new process, with exactly the same restrictions and history.
 business=true;
 let result;
 try{result=await runAssistantCodexPass(passInput,options);}
 catch(error){assert.fail(JSON.stringify({code:error.code,phases}));}
 assert.equal(result.state,'completed');assert.equal(starts,2);
 assert.ok(sawWorkflow,'the model receives both admitted workflow documents without shell');
 assert.ok(toolName,'the permitted signed-plugin MCP tool must actually reach the native model catalogue');
 assert.equal(attempt,5,'all four forbidden tools and the allowed tool were emitted by the synthetic model');
 assert.equal(allowedCalls,1,'only the permitted MCP operation executes '+JSON.stringify({toolName,phases,attempt,foreignRequests,toolResults}));
 assert.equal(foreignInitializations,0,'foreign servers must not initialize or execute '+JSON.stringify(foreignPhases));
 await assert.rejects(fs.stat(foreignSentinel),{code:'ENOENT'},'a foreign stdio executable cannot start');
 for(const names of advertised){
  assert.ok(names.some(name=>name.includes('get_assistant_status')));
  assert.ok(!names.some(name=>/shell|exec_command|cua_repl|foreign|spawn_agent|web_search/.test(name)));
 }
 assert.deepEqual(await fs.readFile(path.join(home,'config.toml')),before,'execution policy cannot rewrite user configuration or trust');
});

for(const liveFailedParent of [false,true])test(liveFailedParent
 ?'actual Codex assistant rollback hands off a live failed-version parent before native downgrade'
 :'actual Codex assistant rollback keeps the newer candidate archived instead of reinstalling it from retention',
 {skip:!process.env.TRELIO_TEST_CODEX_CLI,timeout:120000},async t=>{
 const execute=promisify(execFile),executable=process.env.TRELIO_TEST_CODEX_CLI;
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'trelio-native-rollback-')));
 let preservation=null;const preservationErrors=[];
 t.after(async()=>{await preservation?.close();await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 const home=path.join(root,'home'),repository=path.join(root,'repository'),retentionDirectory=path.join(root,'retention');
 const official='https://github.com/trelio-ru/digital-assistants.git',marketplace='trelio-digital-assistants';
 const plugin='trelio-digital-assistant@trelio-digital-assistants';
 for(const directory of [home,repository])await fs.mkdir(directory);
 const environment={...buildCodexEnvironment({...process.env,HOME:home,USERPROFILE:home,CODEX_HOME:home,
   LOCALAPPDATA:path.join(home,'local'),APPDATA:path.join(home,'roaming')}),GIT_TERMINAL_PROMPT:'0',
   GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(home,'.gitconfig')};
 // The official identity is redirected ONLY inside this synthetic HOME. The
 // native CLI, immutable-ref installs, pruning and inventory are genuine; no
 // network account, model, GUI, real plugin config or hook trust participates.
 await fs.writeFile(path.join(home,'.gitconfig'),`[url "${pathToFileURL(repository).href}"]\n\tinsteadOf = ${official}\n`);
 await fs.writeFile(path.join(home,'config.toml'),'[features]\nplugins=true\nhooks=false\napps=false\n');
 const git=(...args)=>execute('git',['-c',`core.hooksPath=${path.join(root,'no-hooks')}`,...args],{cwd:repository,env:environment});
 const commit=async()=>{await git('add','.');await git('-c','user.name=Synthetic','-c','user.email=fixture@example.invalid',
   '-c','commit.gpgsign=false','commit','-qm','synthetic rollback fixture');};
 const native=async args=>JSON.parse((await execute(executable,args,{cwd:root,env:environment,timeout:30000})).stdout);
 await git('init','-q');await git('branch','-M','main');
 const writeRelease=async version=>{
  await git('checkout','--orphan','distribution-'+version);await git('rm','-rf','--ignore-unmatch','.');
  await fs.mkdir(path.join(repository,'.codex-plugin'),{recursive:true});await fs.mkdir(path.join(repository,'scripts'),{recursive:true});
  await fs.writeFile(path.join(repository,'.gitattributes'),'* -text\n');
  await fs.writeFile(path.join(repository,'.codex-plugin/plugin.json'),JSON.stringify({name:'trelio-digital-assistant',version}));
  await fs.writeFile(path.join(repository,'scripts/trelio-host-runtime-loader.mjs'),'synthetic immutable loader; never executed\n');
  await fs.writeFile(path.join(repository,'package-integrity.json'),JSON.stringify({schemaVersion:1,plugin:'trelio-digital-assistant',
   hookComponent:{pluginId:'trelio-digital-assistant-hooks@trelio-digital-assistants',version:'0.1.1',integritySha256:'a'.repeat(64)}}));
  await commit();await git('tag','plugin-v'+version);
  await git('checkout','--orphan','marketplace-'+version);await git('rm','-rf','--ignore-unmatch','.');
  await fs.mkdir(path.join(repository,'.agents/plugins'),{recursive:true});
  await fs.writeFile(path.join(repository,'.agents/plugins/marketplace.json'),JSON.stringify({name:marketplace,plugins:[
   {name:'trelio-digital-assistant',source:{source:'url',url:official,ref:'plugin-v'+version},policy:{installation:'AVAILABLE',authentication:'ON_USE'}}]}));
  await commit();await git('tag','v'+version);
 };
 for(const version of ['0.1.3','0.1.4'])await writeRelease(version);
 await git('branch','-M','main');
 await native(['plugin','marketplace','add',official,'--ref','v0.1.3','--json']);
 const previous=await native(['plugin','add',plugin,'--json']);assert.equal(previous.version,'0.1.3');
 const options={profile:'assistant',environment,retentionDirectory,
   loadedPluginDirectory:previous.installedPath,loadedPluginVersion:previous.version,
   execFileCommand:(_command,args,settings)=>execute(executable,args,{...settings,cwd:root,env:environment,timeout:30000})};
 const saved=await retainLoadedCodexPluginInstallation(options);
 preservation=startLoadedCodexPluginPreservation({environment:{...environment,TRELIO_PLUGIN_ROOT:previous.installedPath,
  TRELIO_PLUGIN_VERSION:'3.2.3'},retentionDirectory,checkIntervalMs:20,onError:error=>preservationErrors.push(error)});
 await preservation.ready;
 await native(['plugin','marketplace','remove',marketplace,'--json']);
 await native(['plugin','marketplace','add',official,'--ref','main','--json']);
 const candidate=await native(['plugin','add',plugin,'--json']);assert.equal(candidate.version,'0.1.4');
 // Native add really prunes the former cache. Wait only for the live parent's
 // ordinary watcher, never explicitly restore the collection of archives.
 const restoredAt=Date.now()+5000;
 while(true){try{await fs.readFile(path.join(previous.installedPath,'.codex-plugin/plugin.json'));break;}
  catch(error){if(error.code!=='ENOENT'||Date.now()>=restoredAt)throw error;await new Promise(resolve=>setTimeout(resolve,20));}}
 assert.deepEqual(preservationErrors,[]);
 const archived=await retainLoadedCodexPluginInstallation({...options,loadedPluginDirectory:candidate.installedPath,loadedPluginVersion:candidate.version});
 const archivedReceipt=await fs.readFile(path.join(archived.entryDirectory,'metadata.json'));
 let restored;
 if(liveFailedParent){
  await preservation.close();
  let loaded=candidate,stage={schemaVersion:1,assistantId:id,deviceId:id,stage:'rolling_back',
   previousVersion:previous.version,previousTreeSha256:saved.treeSha256,targetVersion:candidate.version,
   targetTreeSha256:archived.treeSha256,desktopGeneration:null,restarts:0,failures:3,failedVersion:candidate.version};
  const errors=[],effects=[];let generation='100:1000',rollbacks=0;
  const caller=()=>({...options,loadedPluginDirectory:loaded.installedPath,loadedPluginVersion:loaded.version});
  const prepare=()=>prepareAssistantCodexPluginRollbackHost({...caller(),version:previous.version,treeSha256:saved.treeSha256});
  const configBefore=await fs.readFile(path.join(home,'config.toml'));
  await assert.rejects(prepareAssistantCodexPluginRollbackHost({...caller(),version:previous.version,treeSha256:'0'.repeat(64)}),
   /receipt is unavailable/);
  const previousLoader=path.join(previous.installedPath,'scripts/trelio-host-runtime-loader.mjs'),originalLoader=await fs.readFile(previousLoader);
  await fs.writeFile(previousLoader,'changed synthetic loader; never executed\n');
  await assert.rejects(prepare(),/другие bytes/);
  assert.equal(await fs.readFile(previousLoader,'utf8'),'changed synthetic loader; never executed\n');
  await fs.writeFile(previousLoader,originalLoader);
  assert.deepEqual(await fs.readFile(path.join(home,'config.toml')),configBefore);
  const preserve=()=>startLoadedCodexPluginPreservation({environment:{...environment,TRELIO_PLUGIN_ROOT:loaded.installedPath,
   TRELIO_PLUGIN_VERSION:'3.2.3'},retentionDirectory,checkIntervalMs:20,onError:error=>errors.push(error)});
  preservation=preserve();await preservation.ready;
  const flow={identity:{assistantId:id,deviceId:id},readState:async()=>structuredClone(stage),
   writeState:async(expected,next)=>{assert.deepEqual(expected,stage);stage=structuredClone(next);},guard:async()=>{},
   inventory:()=>readCodexPluginUpdateInventory({...caller(),receipt:{version:previous.version,treeSha256:saved.treeSha256}}),
   rollbackHost:(version,treeSha256)=>prepareAssistantCodexPluginRollbackHost({...caller(),version,treeSha256}),
   rollback:async(version,treeSha256)=>{rollbacks++;effects.push('native_rollback');
    assert.equal(generation,null);assert.equal(loaded.version,previous.version);
    return restoreAssistantCodexPluginVersion({...caller(),version,treeSha256});},
   upgrade:()=>assert.fail('the failed candidate must not be installed again'),
   desktop:async operation=>{
    if(operation==='close'){assert.equal(stage.stage,'rollback_closing');effects.push('gui_close');generation=null;}
    if(operation==='start'){assert.equal(stage.stage,'verifying');effects.push('gui_start');generation='200:2000';}
    return {state:generation?'running':'stopped',generation};
   },
   // This fixture exercises real Git/CLI/retention and orchestration. Existing
   // native Windows tests independently cover GUI/SCM/hook activation; no
   // synthetic trust decision is written to this isolated Codex configuration.
   hooks:async(_operation,requirement)=>{assert.equal(requirement.version,'0.1.1');return {matches:true};},
   probe:async()=>assert.equal((await flow.inventory()).version,previous.version),
   activateHost:async basis=>{
    if(stage.stage==='rollback_retargeting'){
     assert.equal(generation,null);assert.equal(rollbacks,0);
     assert.equal(basis.version,previous.version);assert.equal(basis.treeSha256,saved.treeSha256);
     assert.equal((await flow.inventory()).version,candidate.version,'native inventory must remain honest before parent handoff');
     effects.push('parent_handoff');await preservation.close();loaded=previous;
     preservation=preserve();await preservation.ready;return {state:'handoff'};
    }
    assert.equal(stage.stage,'retargeting');return {state:'current'};
   }};
  assert.deepEqual(await maintainAssistantPlugin(flow),{state:'host_handoff',blockBusiness:true});
  assert.equal(stage.stage,'rollback_retargeting');assert.equal(rollbacks,0);
  assert.deepEqual(effects,['gui_close','parent_handoff']);
  assert.deepEqual(await maintainAssistantPlugin(flow),{state:'rolled_back',version:previous.version});
  assert.deepEqual(effects,['gui_close','parent_handoff','native_rollback','gui_start']);
  assert.equal(stage.stage,'ready');assert.equal(stage.failedVersion,candidate.version);
  assert.equal(rollbacks,1);assert.deepEqual(errors,[]);
  restored=await flow.inventory();
 }else{
  // A formerly stopped observer cannot restore a pruned old caller. Exercise
  // the real native inventory + protected receipt recovery BEFORE rollback;
  // this must restore only the same old loader, without another plugin add or
  // claiming the still-installed candidate has already been downgraded.
  await preservation.close();preservation=null;
  await fs.rm(previous.installedPath,{recursive:true});
  assert.equal(await prepareAssistantCodexPluginRollbackHost({...options,version:previous.version,treeSha256:saved.treeSha256}),null);
  assert.equal((await readCodexPluginUpdateInventory(options)).version,candidate.version);
  preservation=startLoadedCodexPluginPreservation({environment:{...environment,TRELIO_PLUGIN_ROOT:previous.installedPath,
    TRELIO_PLUGIN_VERSION:'3.2.3'},retentionDirectory,checkIntervalMs:20,onError:error=>preservationErrors.push(error)});
  await preservation.ready;assert.deepEqual(preservationErrors,[]);
  // A verified dormant candidate is not evidence that a caller loaded it.
  restored=await restoreAssistantCodexPluginVersion({...options,version:previous.version,treeSha256:saved.treeSha256});
 }
 assert.equal(restored.version,previous.version);assert.equal(restored.treeSha256,saved.treeSha256);
 const observed=await readCodexPluginUpdateInventory({...options,receipt:{version:previous.version,treeSha256:saved.treeSha256}});
 assert.equal(observed.version,previous.version,'native inventory must still select the actual rollback after retention finalizers');
 assert.equal(observed.desiredVersion,previous.version,'native startup must retain the known-good source, not main');
 assert.deepEqual(await readCodexAssistantMarketplaceSource({environment}),{configured:true,ref:'v'+previous.version});
 // A fresh actual native process refreshes its configured source just as cold
 // discovery does. Its source must stay pinned; no retained failed candidate
 // may become selected merely because Codex starts again.
 await native(['plugin','marketplace','upgrade',marketplace,'--json']);
 assert.equal((await readCodexPluginUpdateInventory(options)).desiredVersion,previous.version);
 await assert.rejects(fs.lstat(candidate.installedPath),{code:'ENOENT'});
 assert.deepEqual(await fs.readFile(path.join(archived.entryDirectory,'metadata.json')),archivedReceipt);
 assert.equal(JSON.parse(await fs.readFile(path.join(archived.pluginDirectory,'.codex-plugin/plugin.json'),'utf8')).version,candidate.version);
 assert.doesNotMatch(await fs.readFile(path.join(home,'config.toml'),'utf8'),/trusted_hash|trusted_content_hash/u);
 if(!liveFailedParent){
  // Genuine native CLI/Git/source-gap acceptance. Public discovery uses the
  // SAME bounded parser over synthetic public-code bytes, not an injected
  // installed-version receipt. All native effects stay inside this HOME.
  const latest=()=>readAssistantPluginLatestVersion({fetchResponse:async()=>new Response(
   await fs.readFile(path.join(repository,'.agents/plugins/marketplace.json')))});
  const published=selection=>readAssistantPluginPublishedRef({...selection,readGit:async(args,settings)=>{
   const result=await execute('git',args,{...settings,cwd:repository,env:environment});return {...result,code:0};
  }});
  const unchangedConfig=await fs.readFile(path.join(home,'config.toml'));
  let intents=[];
  const updater={...options,readLatestVersion:latest,readPublishedRef:published,
   beforeInstall:async version=>{intents.push(version);}};
  assert.equal((await updateCodexPluginMarketplace({...updater,onlyIfNewerThan:candidate.version})).unchanged,true);
  assert.deepEqual(intents,[]);assert.deepEqual(await fs.readFile(path.join(home,'config.toml')),unchangedConfig);
  await writeRelease('0.1.5');await git('branch','-M','main');
  let removeLost=false,targetAdds=0;
  await assert.rejects(updateCodexPluginMarketplace({...updater,onlyIfNewerThan:candidate.version,
   execFileCommand:async(command,args,settings)=>{
    if(args[1]==='add')targetAdds++;
    const result=await options.execFileCommand(command,args,settings);
    if(args[1]==='marketplace'&&args[2]==='remove'){removeLost=true;throw new Error('synthetic lost source-remove result');}
    return result;
   }}),/synthetic lost source-remove/);
  assert.equal(removeLost,true);assert.equal(targetAdds,0);assert.deepEqual(intents,['0.1.5']);
  await assert.rejects(readCodexPluginUpdateInventory(options),/marketplace is absent/);
  assert.deepEqual(await readCodexPluginUpdateInventory({...options,allowMissingMarketplace:true}),{state:'marketplace_absent'});
  // Protected rollback alone consumes the positively observed source gap. It
  // restores old source metadata, not the uncertain newer installation. The
  // already verified old cache must not receive a second native plugin add.
  assert.equal(await prepareAssistantCodexPluginRollbackHost({...options,version:previous.version,
   treeSha256:saved.treeSha256,allowMissingMarketplace:true}),null);
  const recovery=await restoreAssistantCodexPluginVersion({...options,version:previous.version,treeSha256:saved.treeSha256,
   execFileCommand:async(command,args,settings)=>{assert.notEqual(args[1],'add');return options.execFileCommand(command,args,settings);}});
  assert.equal(recovery.version,previous.version);assert.equal(recovery.desiredVersion,previous.version);
  // A real later release, not the failed one, remains independently eligible.
  await writeRelease('0.1.6');await git('branch','-M','main');
  const fixed=await updateCodexPluginMarketplace({...updater,onlyIfNewerThan:'0.1.5'});
  assert.equal(fixed.version,'0.1.6');assert.deepEqual(intents,['0.1.5','0.1.6']);
  assert.deepEqual(await readCodexAssistantMarketplaceSource({environment}),{configured:true,ref:'v0.1.6'});
  assert.equal((await readCodexPluginUpdateInventory({...options,loadedPluginDirectory:fixed.installedPath,loadedPluginVersion:fixed.version})).version,'0.1.6');
  assert.doesNotMatch(await fs.readFile(path.join(home,'config.toml'),'utf8'),/trusted_hash|trusted_content_hash/u);
 }
});

test('actual Codex migrates an existing combined main to independent hooks without a manual companion install or trust write',
 {skip:!process.env.TRELIO_TEST_CODEX_CLI,timeout:120000},async t=>{
 const execute=promisify(execFile),executable=process.env.TRELIO_TEST_CODEX_CLI;
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'trelio-hook-migration-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const home=path.join(root,'home'),repository=path.join(root,'repository'),main=path.join(repository,'plugins/trelio-agent-workspaces');
 const component=path.join(repository,'plugin'),official='https://github.com/trelio-ru/agent-workspaces.git';
 for(const dir of [home,path.join(repository,'.agents/plugins'),path.join(main,'.codex-plugin'),path.join(main,'hooks'),
   path.join(component,'.codex-plugin'),path.join(component,'hooks'),path.join(component,'scripts')])await fs.mkdir(dir,{recursive:true});
 const environment={...buildCodexEnvironment({...process.env,HOME:home,USERPROFILE:home,CODEX_HOME:home,
   LOCALAPPDATA:path.join(home,'local'),APPDATA:path.join(home,'roaming')}),GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1'};
 // Native Codex sees the canonical official Git identity; only this isolated
 // HOME redirects Git transport to its disposable synthetic repository. No
 // production account/network/config/plugin installation is touched.
 await fs.writeFile(path.join(home,'.gitconfig'),`[url "${pathToFileURL(repository).href}"]\n\tinsteadOf = ${official}\n`);
 await fs.writeFile(path.join(home,'config.toml'),'[features]\nplugins=true\nhooks=true\napps=false\n');
 const git=(...args)=>execute('git',['-c',`core.hooksPath=${path.join(root,'no-hooks')}`, ...args],{cwd:repository,env:environment});
 const native=async args=>JSON.parse((await execute(executable,args,{cwd:root,env:environment,timeout:30000})).stdout);
 const hooks={hooks:Object.fromEntries(['SessionStart','PreToolUse','SessionEnd'].map(name=>[name,[{matcher:'*',hooks:[{
   type:'command',command:'echo synthetic-hook-not-trusted',timeout:10}]}]]))};
 const files=new Map([['.gitattributes','* -text\n'],['.codex-plugin/plugin.json',JSON.stringify({
   name:'trelio-agent-workspaces-hooks',version:'0.1.0',hooks:'./hooks/hooks.json'})],['hooks/hooks.json',JSON.stringify(hooks)],
   ...['launch-trelio-node','launch-trelio-node.cmd','resolve-node.ps1','trelio-host-runtime-download.mjs',
    'trelio-host-runtime-loader.mjs','trelio-host-runtime-shell.mjs','trelio-mcp-startup-budget.mjs'].map(name=>[`scripts/${name}`,'synthetic immutable shell\n'])]);
 const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
 for(const [name,bytes]of files)await fs.writeFile(path.join(component,name),bytes);
 const inventory=JSON.stringify({schemaVersion:1,plugin:'trelio-agent-workspaces-hooks',version:'0.1.0',sharedShell:{},
   files:[...files].map(([name,bytes])=>({path:name,mode:0o644,size:Buffer.byteLength(bytes),sha256:digest(bytes)}))});
 await fs.writeFile(path.join(component,'package-integrity.json'),inventory);
 await fs.writeFile(path.join(main,'hooks/hooks.json'),JSON.stringify(hooks));
 const manifest={name:'trelio-agent-workspaces',version:'3.2.4',hooks:'./hooks/hooks.json'};
 const manifestPath=path.join(main,'.codex-plugin/plugin.json');await fs.writeFile(manifestPath,JSON.stringify(manifest));
 await fs.writeFile(path.join(repository,'.gitattributes'),'* -text\n');
 await fs.writeFile(path.join(repository,'.agents/plugins/marketplace.json'),JSON.stringify({name:'trelio-plugins',plugins:[
   {name:'trelio-agent-workspaces',source:{source:'local',path:'./plugins/trelio-agent-workspaces'},policy:{installation:'AVAILABLE',authentication:'ON_USE'}},
   {name:'trelio-agent-workspaces-hooks',source:{source:'git-subdir',url:official,path:'./plugin',ref:'hooks-v0.1.0'},policy:{installation:'AVAILABLE',authentication:'ON_USE'}}]}));
 const commit=async()=>{await git('add','.');await git('-c','user.name=Synthetic','-c','user.email=fixture@example.invalid',
   '-c','commit.gpgsign=false','commit','-qm','synthetic fixture');};
 await git('init','-q');await commit();await git('tag','hooks-v0.1.0');
 await native(['plugin','marketplace','add',official,'--json']);
 const previous=await native(['plugin','add','trelio-agent-workspaces@trelio-plugins','--json']);
 assert.equal(previous.version,'3.2.4');
 manifest.version='3.2.5';manifest.hooks={hooks:{}};
 await fs.writeFile(manifestPath,JSON.stringify(manifest));
 await fs.writeFile(path.join(main,'codex-hook-component.json'),JSON.stringify({
   pluginId:'trelio-agent-workspaces-hooks@trelio-plugins',version:'0.1.0',integritySha256:digest(inventory)}));
 await commit();await native(['plugin','marketplace','upgrade','trelio-plugins','--json']);
 const updated=await native(['plugin','add','trelio-agent-workspaces@trelio-plugins','--json']);
 assert.equal(updated.version,'3.2.5');
 const listed=await native(['plugin','list','--marketplace','trelio-plugins','--json']);
 assert.equal(listed.installed.some(row=>row.name==='trelio-agent-workspaces-hooks'),false,
   'fixture MUST start after a real combined-main upgrade with no companion installed');
 const retentionDirectory=path.join(root,'retention'),entry=await retainLoadedCodexPluginInstallation({
   loadedPluginDirectory:updated.installedPath,loadedPluginVersion:'3.2.5',retentionDirectory});
 const options={entry,environment:{...environment,TRELIO_PLUGIN_ROOT:updated.installedPath,TRELIO_PLUGIN_VERSION:'3.2.5'},
   retentionDirectory,migrationDirectory:path.join(root,'migration'),resolveExecutable:async()=>executable,
   readPublishedRef:args=>readAssistantPluginPublishedRef({...args,readGit:async argv=>{
     const value=await execute('git',argv,{cwd:root,env:environment,timeout:10000});return {stdout:value.stdout,stderr:value.stderr};}})};
 const migrated=await migrateHumanCodexHookComponent(options);
 assert.equal(migrated.status,'installed',JSON.stringify({profile:entry.profile,version:entry.version,
   cacheLeaf:path.basename(entry.installedPath),files:await fs.readdir(entry.installedPath)}));
 const inspect=()=>inspectHumanCodexHookComponent({pluginDirectory:updated.installedPath,environment:options.environment,
   execFileCommand:(_command,args,settings)=>execute(executable,args,{...settings,cwd:root})});
 const verified=await inspect();assert.equal(verified.status,'ready');
 const installed=await native(['plugin','list','--marketplace','trelio-plugins','--json']);
 assert.equal(installed.installed.filter(row=>row.name==='trelio-agent-workspaces-hooks'&&row.enabled).length,1);
 assert.equal((await migrateHumanCodexHookComponent(options)).status,'ready');
 const config=await fs.readFile(path.join(home,'config.toml'),'utf8');
 assert.doesNotMatch(config,/trusted_hash|trusted_content_hash|bypass_hook_trust/u);
 const discovered=await new Promise((resolve,reject)=>{
   const child=spawn(executable,['app-server','--listen','stdio://'],{cwd:root,env:environment,shell:false,windowsHide:true,
     stdio:['pipe','pipe','ignore']});
   let pending='',bytes=0,result,failed=false,initialized=false,failure='no_result';
   // Preserve the first closed failure and whether the native reply arrived.
   // Otherwise an EOF shutdown timeout looks exactly like failed discovery.
   // Never attach native frames/stderr, plugin paths or exception prose.
   const fail=reason=>{if(!failed)failure=reason;failed=true;};
   const timer=setTimeout(()=>{fail('timeout');child.kill();},20000);
   const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
   child.once('error',()=>{fail('spawn');});child.stdin.on('error',()=>{fail('stdin');});
   child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
     bytes+=Buffer.byteLength(chunk);if(bytes>1024*1024){fail('output_limit');child.kill();return;}pending+=chunk;
     let at;while((at=pending.indexOf('\n'))>=0){let message;try{message=JSON.parse(pending.slice(0,at));}
       catch{fail('invalid_json');child.kill();return;}pending=pending.slice(at+1);
       if(message.error){fail('rpc');child.stdin.end();return;}
       if(message.id===1){initialized=true;send({method:'initialized'});send({id:2,method:'hooks/list',params:{cwds:[root]}});}
       if(message.id===2){result=message.result;child.stdin.end();}
     }
   });
   child.once('close',(code,signal)=>{
     clearTimeout(timer);
     // Keep the original strict outcome/deadline: a reply followed by timeout
     // still fails. These facts diagnose that distinction without granting a
     // retry, changing hook trust or treating installation as native discovery.
     if(failed||!result)reject(Error('native hook discovery failed '+JSON.stringify({failure,initialized,resultReceived:Boolean(result),
       exitCode:Number.isInteger(code)?code:null,signal:['SIGTERM','SIGKILL','SIGABRT','SIGSEGV'].includes(signal)?signal:null})));
     else resolve(result);
   });
   send({id:1,method:'initialize',params:{clientInfo:{name:'trelio_hook_migration_fixture',version:'1'},capabilities:{experimentalApi:true}}});
 });
 assert.equal(discovered.data.length,1);
 assert.deepEqual(discovered.data[0].errors,[]);
 assert.equal(discovered.data[0].hooks.length,3);
 for(const hook of discovered.data[0].hooks){
   assert.equal(hook.pluginId,'trelio-agent-workspaces-hooks@trelio-plugins');
   assert.equal(hook.trustStatus,'untrusted');assert.equal(hook.enabled,true);
 }
 // Native manager must also retain an explicit opt-out when cache files have
 // gone: absence in the filesystem is never authority to turn it back on.
 const optedOut=config.replace(/(\[plugins\."trelio-agent-workspaces-hooks@trelio-plugins"\]\r?\n)enabled = true/u,'$1enabled = false');
 assert.notEqual(optedOut,config);
 await fs.writeFile(path.join(home,'config.toml'),optedOut);
 const disabled=await native(['plugin','list','--marketplace','trelio-plugins','--json']);
 assert.equal(disabled.installed.find(row=>row.name==='trelio-agent-workspaces-hooks').enabled,false);
 await fs.rm(verified.installedPath,{recursive:true});
 assert.equal((await migrateHumanCodexHookComponent({...options,migrationDirectory:path.join(root,'fresh-migration')})).status,'disabled');
 });

test('actual Codex initial MCP inventory includes company discovery and accepts lossless local schema definitions without a model turn',
 {skip:!process.env.TRELIO_TEST_CODEX_CLI,timeout:60000},async t=>{
 const executable=process.env.TRELIO_TEST_CODEX_CLI;
 assert.ok(path.isAbsolute(executable));
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'trelio-initial-discovery-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 const server=path.join(root,'server.mjs');
 const transport=pathToFileURL(path.resolve('host-runtime/scripts/trelio-assistant-transport.mjs')).href;
 const entry=pathToFileURL(path.resolve('host-runtime/scripts/trelio-assistant-entry.mjs')).href;
 // Actual facade -> actual bounded device proxy -> synthetic native metadata.
 // No account/login/pass/HTTP/model/GUI work or installed user profile is used.
 // The deliberate metadata pressure exercises real leaf sharing, not an
 // already compact hand-authored $ref fixture or a second implementation.
 await fs.writeFile(server,`import {createAssistantMcpClient} from ${JSON.stringify(transport)};
import {runAssistantSetupMcp} from ${JSON.stringify(entry)};
const origin='https://synthetic.test',assistantId='11111111-1111-4111-8111-111111111111',deviceId='22222222-2222-4222-8222-222222222222';
const scalar={type:'string',format:'uuid',pattern:'^[a-f0-9-]{36}$',description:'Complete synthetic native UUID constraint. '.repeat(7)};
const schema={type:'object',properties:Object.fromEntries(Array.from({length:20},(_,i)=>['field'+i,scalar])),additionalProperties:false};
const definition=name=>({name,description:'Synthetic native tool',inputSchema:schema});
const native=['get_assistant_status','get_task','create_comment','complete_assistant_pass','update_task_title','create_task','prepare_assistant_workspace_run','continue_assistant_workspace_action'].map(definition);
const make=()=>createAssistantMcpClient({origin,assistantId,deviceId,store:{get:async()=>({assistantId,deviceId,credential:'tda_'+'s'.repeat(43),expiresAt:1})},
 httpRequest:async input=>{const reply=result=>({sessionId:'synthetic',message:{jsonrpc:'2.0',id:input.payload?.id,result}});
 if(input.method==='DELETE'||input.payload.method==='notifications/initialized')return reply({});
 if(input.payload.method==='initialize')return reply({protocolVersion:'2025-06-18'});
 if(input.payload.method!=='tools/list')throw Error('NO_TOOL_CALL_OR_MODEL_ALLOWED');
 const view=input.config.headers['x-trelio-assistant-capability-profile'];
 return reply({tools:view==='source_intake'?['get_assistant_status','get_assistant_intake_context','resolve_assistant_intake'].map(definition)
 :view==='company_context'?['get_assistant_status','search','fetch','get_trelio_tool_contract'].map(definition):native});}});
await runAssistantSetupMcp({createMcp:async()=>make(),preservePlugin:()=>null});
`);
 const home=path.join(root,'codex');await fs.mkdir(home);
 await fs.writeFile(path.join(home,'config.toml'),`[mcp_servers.synthetic_assistant]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(server)}]\nstartup_timeout_sec = 20\n`);
 const environment=buildCodexEnvironment({...process.env,HOME:root,USERPROFILE:root,CODEX_HOME:home,
  APPDATA:path.join(root,'AppData'),LOCALAPPDATA:path.join(root,'Local')});
 const observed=await new Promise((resolve,reject)=>{
  const child=spawn(executable,['app-server','--listen','stdio://'],{cwd:root,env:environment,shell:false,windowsHide:true,stdio:['pipe','pipe','ignore']});
  let pending='',bytes=0,sequence=0,waiting=null,done=false;
  const finish=(reason,value)=>{if(done)return;done=true;clearTimeout(timer);
   const cleanup=setTimeout(()=>child.kill(),2000);cleanup.unref();
   child.once('close',()=>{clearTimeout(cleanup);reason?reject(new Error(reason)):resolve(value);});child.stdin.end();child.stdout.resume();};
  const timer=setTimeout(()=>finish('closed initial MCP inventory timeout'),40000);
  const request=(method,params)=>new Promise(yes=>{waiting={id:++sequence,yes};child.stdin.write(JSON.stringify({id:sequence,method,params})+'\n');});
  child.once('error',()=>finish('closed initial MCP launch failure'));
  child.stdin.on('error',()=>finish('closed initial MCP input failure'));
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{if(done)return;bytes+=Buffer.byteLength(chunk);pending+=chunk;
   if(bytes>8*1024*1024)return finish('closed initial MCP output bound');
   let at;while(!done&&(at=pending.indexOf('\n'))>=0){let message;try{message=JSON.parse(pending.slice(0,at));}catch{return finish('closed initial MCP invalid JSON');}
    pending=pending.slice(at+1);if(waiting&&message.id===waiting.id){const q=waiting;waiting=null;if(message.error)return finish('closed initial MCP RPC failure');q.yes(message.result);}}});
  child.once('close',()=>{if(!done){done=true;clearTimeout(timer);reject(new Error('closed initial MCP early exit'));}});
  void(async()=>{await request('initialize',{clientInfo:{name:'trelio_initial_inventory_fixture',version:'1.0.0'}});
   child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
   const result=await request('mcpServerStatus/list',{serverName:'synthetic_assistant',detail:'toolsAndAuthOnly',limit:10});
   const row=result?.data?.find(item=>item.name==='synthetic_assistant');
   if(!row||row.toolsError)return finish('closed initial MCP catalogue failure '+(String(row?.toolsError??'').match(/ASSISTANT_[A-Z_]+/)?.[0]??'unclassified'));
   finish(null,row.tools);
  })().catch(()=>finish('closed initial MCP protocol failure'));
 });
 for(const name of ['search','fetch','get_trelio_tool_contract','get_task','create_comment','get_assistant_intake_context','resolve_assistant_intake'])
  assert.ok(Object.hasOwn(observed,name),`${name} must exist in the INITIAL native client catalogue, without a status call`);
 assert.ok(observed.search.inputSchema.$defs,'native client accepted the actual projected local definitions');
 assert.ok(observed.search.inputSchema.properties.field0.$ref);
});

test('Windows Codex process environment retains only canonical public CMD discovery variables', () => {
  for (const [comspec, pathext] of [['ComSpec','PATHEXT'],['COMSPEC','PathExt'],['comspec','pathext']]) {
    const input={PATH:'C:\\Windows\\System32',USERPROFILE:'C:\\Users\\Fixture',
      [comspec]:'C:\\Windows\\System32\\cmd.exe',[pathext]:'.COM;.EXE;.BAT;.CMD',
      OPENAI_API_KEY:'excluded',TRELIO_TOKEN:'excluded',CODEX_THREAD_ID:'excluded',ARBITRARY:'excluded'};
    assert.deepEqual(buildCodexEnvironment(input,{platform:'win32'}),{
      PATH:input.PATH,USERPROFILE:input.USERPROFILE,ComSpec:input[comspec],PATHEXT:input[pathext]});
    assert.deepEqual(buildCodexEnvironment(input,{platform:'darwin'}),{PATH:input.PATH,USERPROFILE:input.USERPROFILE});
  }
  assert.deepEqual(buildCodexEnvironment({ComSpec:'one',COMSPEC:'other',PATHEXT:'.EXE',pathext:'.CMD'},{platform:'win32'}),{},
    'conflicting aliases never select an arbitrary public interpreter/discovery value');
});

test('actual Windows Codex discovers a synthetic CMD MCP server only with the public process variables',
  {skip:process.platform!=='win32',timeout:90000},async t=>{
  const executable=process.env.TRELIO_TEST_CODEX_CLI;
  assert.ok(executable&&path.isAbsolute(executable),'the native CI wrapper supplies its pinned public Codex binary');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'trelio cmd mcp '));
  t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const launcher=path.join(root,'synthetic-mcp'),server=path.join(root,'server.mjs');
  await fs.writeFile(launcher,'#!/bin/sh\nexit 99\n');
  await fs.writeFile(launcher+'.cmd',`@echo off\r\n"${process.execPath}" "${server}"\r\n`);
  // This fixture advertises exactly one harmless tool and never implements a
  // tool call. End-of-input exits even when its owning CLI connection closes.
  await fs.writeFile(server,`process.stdin.setEncoding('utf8');let pending='';
process.stdin.on('end',()=>process.exit(0));
process.stdin.on('data',chunk=>{pending+=chunk;let n;while((n=pending.indexOf('\\n'))>=0){
const line=pending.slice(0,n);pending=pending.slice(n+1);if(!line.trim())continue;const q=JSON.parse(line);if(q.id===undefined)continue;
const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-cmd-mcp',version:'1.0.0'}}
:q.method==='tools/list'?{tools:[{name:'fixture_ping',description:'Synthetic read-only fixture',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}:{};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');}});
`);
  const inventory=async(environment)=>new Promise((resolve,reject)=>{
    let child,waiting=null,nextId=0,pending='',bytes=0,done=false;
    const finish=(error,value)=>{
      if(done)return;done=true;clearTimeout(timer);
      // Give the CLI EOF so it disposes its own MCP client; the synthetic child
      // also exits on EOF. Never stop another process or expose native stderr.
      const settle=()=>{clearTimeout(cleanup);if(error)reject(new Error(error));else resolve(value);};
      const cleanup=setTimeout(()=>child?.kill(),2000);cleanup.unref();
      if(!child?.pid||child.exitCode!==null){settle();return;}
      child.once('exit',settle);child.stdin.end();child.stdout.resume();
    };
    const timer=setTimeout(()=>finish('closed native MCP fixture timeout'),35000);
    const request=(method,params)=>new Promise((yes,no)=>{waiting={id:++nextId,yes,no};child.stdin.write(JSON.stringify({id:nextId,method,params})+'\n');});
    child=spawn(executable,['app-server','--listen','stdio://'],{cwd:root,env:environment,shell:false,windowsHide:true,stdio:['pipe','pipe','ignore']});
    child.on('error',()=>finish('closed native MCP fixture launch failure'));
    child.on('exit',()=>{if(!done)finish('closed native MCP fixture early exit');});
    child.stdin.on('error',()=>finish('closed native MCP fixture input failure'));child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      if(done)return;bytes+=Buffer.byteLength(chunk);pending+=chunk;
      if(bytes>8*1024*1024)return finish('closed native MCP fixture output bound');
      let n;while(!done&&(n=pending.indexOf('\n'))>=0){
        let value;try{value=JSON.parse(pending.slice(0,n));}catch{return finish('closed native MCP fixture invalid JSON');}pending=pending.slice(n+1);
        if(waiting&&value.id===waiting.id){const current=waiting;waiting=null;if(value.error)return finish('closed native MCP fixture RPC failure');current.yes(value.result);}
      }
    });
    void(async()=>{
      await request('initialize',{clientInfo:{name:'trelio_cmd_mcp_fixture',version:'1.0.0'}});
      child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
      const response=await request('mcpServerStatus/list',{serverName:'synthetic_cmd',detail:'toolsAndAuthOnly',limit:10});
      const row=response?.data?.find(item=>item.name==='synthetic_cmd');
      if(!row)return finish('closed native MCP fixture missing server');
      finish(null,{hasError:typeof row.toolsError==='string',badExeFormat:/\bos error 193\b/i.test(row.toolsError??''),
        toolPresent:Object.hasOwn(row.tools??{},'fixture_ping')});
    })().catch(()=>finish('closed native MCP fixture protocol failure'));
  });
  const source={...process.env,HOME:root,USERPROFILE:root,APPDATA:path.join(root,'AppData'),LOCALAPPDATA:path.join(root,'Local'),
    ComSpec:process.env.ComSpec??process.env.COMSPEC,PATHEXT:process.env.PATHEXT};
  for(const [mode,fixed] of [['legacy',false],['fixed',true]]){
    const home=path.join(root,mode);await fs.mkdir(home);
    await fs.writeFile(path.join(home,'config.toml'),`[mcp_servers.synthetic_cmd]\ncommand = ${JSON.stringify(launcher)}\nstartup_timeout_sec = 20\n`);
    const environment=buildCodexEnvironment({...source,CODEX_HOME:home});
    if(!fixed){delete environment.ComSpec;delete environment.PATHEXT;}
    const observed=await inventory(environment);
    assert.equal(observed.hasError,!fixed,'native startup error is projected only as a closed boolean');
    assert.equal(observed.toolPresent,fixed,'only the fixed sanitized environment reaches synthetic MCP initialize/tools/list');
    if(!fixed)assert.equal(observed.badExeFormat,true,'legacy environment reproduces native Windows error 193');
  }
});

const desktopCopyFixture=()=>{
  const w=path.win32,key=value=>w.normalize(value).toLowerCase(),root='C:\\Program Files\\WindowsApps\\OpenAI.Codex_fixture';
  const environment={PATH:'',LOCALAPPDATA:'C:\\Users\\Fixture\\AppData\\Local',USERPROFILE:'C:\\Users\\Fixture'};
  const names=['codex.exe','codex-code-mode-host.exe','codex-windows-sandbox-setup.exe','codex-command-runner.exe'];
  const bytes=names.map(name=>Buffer.from(`synthetic public vendor ${name}`)),combined=createHash('sha256');
  for(let i=0;i<names.length;i++)combined.update(names[i]).update('\0').update(createHash('sha256').update(bytes[i]).digest('hex')).update('\0');
  const selected=w.join(environment.LOCALAPPDATA,'OpenAI','Codex','bin',combined.digest('hex').slice(0,16));
  const dirs=new Set([root,w.join(root,'app'),w.join(root,'app','resources'),environment.LOCALAPPDATA,
    ...['OpenAI','OpenAI\\Codex','OpenAI\\Codex\\bin'].map(p=>w.join(environment.LOCALAPPDATA,p)),selected].map(key));
  const files=new Map();for(let i=0;i<names.length;i++){files.set(key(w.join(root,'app','resources',names[i])),bytes[i]);files.set(key(w.join(selected,names[i])),bytes[i]);}
  const links=new Set();let lookups=0,reads=0,opens=0;
  const stat=name=>({isFile:()=>files.has(key(name)),isDirectory:()=>dirs.has(key(name)),isSymbolicLink:()=>links.has(key(name)),
    size:files.get(key(name))?.length??0,mtimeMs:1,ctimeMs:1,ino:1,dev:1});
  const filesystem={realpath:async name=>{if(!dirs.has(key(name))&&!files.has(key(name)))throw Error('absent');return w.normalize(name);},
    stat:async name=>stat(name),lstat:async name=>stat(name),open:async name=>{opens++;let position=0;return {read:async(buffer,offset,length)=>{
      reads++;const bytesRead=files.get(key(name)).copy(buffer,offset,position,position+length);position+=bytesRead;return {bytesRead};},close:async()=>{}};},
    readdir:()=>assert.fail('no cache inventory or newest selection'),writeFile:()=>assert.fail('no vendor relocation/install')};
  const readPackagePath=async()=>{lookups++;return root;};
  return {environment,filesystem,readPackagePath,root,selected,names,files,links,key,lookups:()=>lookups,opens:()=>opens,reads:()=>reads};
};

test('desktop copy selection derives the exact vendor ordered four-file hash and verifies existing copy without inventory or writes',async()=>{
  const f=desktopCopyFixture();
  assert.equal(await resolveCodexExecutable(f.environment,{platform:'win32',filesystem:f.filesystem,readPackagePath:f.readPackagePath}),path.win32.join(f.selected,'codex.exe'));
  assert.equal(f.lookups(),2,'native current-user package is read before and after exact hashes');assert.equal(f.opens(),8);
});

test('desktop discovery rejects modified/missing/reparse/retargeted copies and cancels before another file read',async()=>{
  for(const scenario of ['modified','missing','source_link','copy_link','package_change','abort']){
    const f=desktopCopyFixture(),controller=new AbortController();let lookups=0;
    if(scenario==='modified')f.files.set(f.key(path.win32.join(f.selected,'codex.exe')),Buffer.from('other binary'));
    if(scenario==='missing')f.files.delete(f.key(path.win32.join(f.selected,f.names[3])));
    if(scenario==='source_link')f.links.add(f.key(path.win32.join(f.root,'app','resources','codex.exe')));
    if(scenario==='copy_link')f.links.add(f.key(f.selected));
    const readPackagePath=async()=>{lookups++;return scenario==='package_change'&&lookups===2?f.root+'2':f.root;};
    if(scenario==='abort'){const open=f.filesystem.open;f.filesystem.open=async name=>{const handle=await open(name);return {...handle,read:async(...args)=>{
      const result=await handle.read(...args);controller.abort();return result;}};};}
    assert.equal(await resolveCodexExecutable(f.environment,{platform:'win32',filesystem:f.filesystem,readPackagePath,signal:controller.signal}),null,scenario);
    if(scenario==='abort')assert.equal(f.reads(),1);
  }
});

test('fixed AppModel worker protocol exposes only validated available metadata and accepts no path/command selectors',async()=>{
  for(const response of [{schemaVersion:1,state:'available',pathBase64:Buffer.from('C:\\Program Files\\WindowsApps\\Codex_fixture').toString('base64')},
    {schemaVersion:1,state:'unavailable'},{schemaVersion:1,state:'available',pathBase64:'not canonical base64'},
    {schemaVersion:1,state:'available',pathBase64:Buffer.from('C:\\fixture').toString('base64'),canary:'not allowed'}]){
    const spawnProcess=(program,args,settings)=>{assert.equal(program,'signed-native-worker');assert.deepEqual(args,['--codex-package-path']);
      assert.equal(settings.shell,false);assert.deepEqual(settings.stdio,['ignore','pipe','ignore']);assert.equal(settings.env.PATH,'');
      const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{};
      queueMicrotask(()=>{child.stdout.end(JSON.stringify(response)+'\n');child.emit('close',0);});return child;};
    const result=await readWindowsCodexPackagePath({spawnProcess,selectWorker:async()=>({executable:'signed-native-worker'})});
    assert.equal(result,response.state==='available'&&!response.canary&&response.pathBase64!=='not canonical base64'?'C:\\Program Files\\WindowsApps\\Codex_fixture':null);
  }
});

const windowsStandaloneFixture=({modern=true,customHome=false}={})=>{
  const w=path.win32,key=value=>w.normalize(value).toLowerCase();
  const environment={PATH:'',LOCALAPPDATA:'C:\\Users\\Fixture\\AppData\\Local',USERPROFILE:'C:\\Users\\Fixture',
    ...(customHome?{CODEX_HOME:'D:\\Codex profile'}:{})};
  const home=environment.CODEX_HOME??w.join(environment.USERPROFILE,'.codex'),root=w.join(home,'packages','standalone'),releases=w.join(root,'releases');
  const selected=w.join(releases,'0.164.0-x86_64-pc-windows-msvc'),current=w.join(root,'current');
  const visible=w.join(environment.LOCALAPPDATA,'Programs','OpenAI','Codex','bin','codex.exe');
  const executable=w.join(selected,modern?'bin\\codex.exe':'codex.exe');
  const companions=modern?['codex-package.json','bin\\codex.exe','bin\\codex-code-mode-host.exe','codex-path\\rg.exe',
    'codex-resources\\codex-command-runner.exe','codex-resources\\codex-windows-sandbox-setup.exe']
    :['codex.exe','codex-resources\\codex-command-runner.exe','codex-resources\\codex-windows-sandbox-setup.exe','codex-resources\\rg.exe'];
  const directories=new Set([home,root,releases,selected].map(key)),files=new Set(companions.map(name=>key(w.join(selected,name))));
  const resolved=new Map([...directories,...files].map(name=>[name,name]));resolved.set(key(current),selected);resolved.set(key(visible),executable);
  const links=new Set();let reads=0;
  const filesystem={realpath:async name=>{reads++;if(!resolved.has(key(name)))throw Object.assign(new Error('absent'),{code:'ENOENT'});return resolved.get(key(name));},
    stat:async name=>({isFile:()=>files.has(key(name)),isDirectory:()=>directories.has(key(name))}),
    lstat:async name=>({isSymbolicLink:()=>links.has(key(name))}),readdir:()=>assert.fail('resolver must not scan a directory'),
    writeFile:()=>assert.fail('resolver must not change installation/PATH')};
  return {environment,filesystem,root,releases,current,visible,selected,executable,files,resolved,links,key,reads:()=>reads};
};

test('Windows fixed standalone discovery follows only the official selected junction layout with complete companions and keeps PATH priority',async()=>{
  for(const modern of [true,false])for(const customHome of [true,false]){
    const f=windowsStandaloneFixture({modern,customHome});
    assert.equal((await resolveCodexExecutable(f.environment,{platform:'win32',filesystem:f.filesystem,readPackagePath:async()=>null})).toLowerCase(),f.executable.toLowerCase());
    const pathExe='C:\\Tools\\codex.exe';f.environment.PATH='C:\\Tools';f.resolved.set(f.key(pathExe),pathExe);f.files.add(f.key(pathExe));
    assert.equal(await resolveCodexExecutable(f.environment,{platform:'win32',filesystem:f.filesystem,readPackagePath:async()=>null}),pathExe);
  }
});

test('Windows fallback rejects escaped/partial/file-link and concurrently retargeted installs without scanning or launching anything',async()=>{
  for(const scenario of ['escaped','nested','incomplete','file_link','releases_link','retarget','absent','store']){
    const f=windowsStandaloneFixture();let currentReads=0;
    if(scenario==='escaped'||scenario==='store')f.resolved.set(f.key(f.visible),scenario==='store'?'C:\\Program Files\\WindowsApps\\OpenAI.Codex_example\\app\\resources\\codex.exe':'D:\\elsewhere\\codex.exe');
    if(scenario==='nested')f.resolved.set(f.key(f.current),path.win32.join(f.selected,'nested'));
    if(scenario==='incomplete')f.files.delete(f.key(path.win32.join(f.selected,'codex-package.json')));
    if(scenario==='file_link')f.links.add(f.key(f.visible));
    if(scenario==='releases_link')f.links.add(f.key(f.releases));
    if(scenario==='absent')f.resolved.delete(f.key(f.current));
    const realpath=f.filesystem.realpath;f.filesystem.realpath=async name=>{
      if(scenario==='retarget'&&f.key(name)===f.key(f.current)&&++currentReads>1)return path.win32.join(f.releases,'0.165.0-x86_64-pc-windows-msvc');
      return realpath(name);
    };
    assert.equal(await resolveCodexExecutable(f.environment,{platform:'win32',filesystem:f.filesystem,readPackagePath:async()=>null}),null,scenario);
  }
  const f=windowsStandaloneFixture(),controller=new AbortController();controller.abort();
  assert.equal(await resolveCodexExecutable(f.environment,{platform:'win32',filesystem:f.filesystem,readPackagePath:async()=>null,signal:controller.signal}),null);
  assert.equal(f.reads(),0,'an expired original deadline performs no discovery I/O');
});

test('Windows native filesystem accepts only its own synthetic official junctions when the Store app is absent', {skip:process.platform!=='win32'},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'codex-standalone-discovery-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const environment={PATH:'',LOCALAPPDATA:path.join(directory,'Local'),USERPROFILE:path.join(directory,'User')};
  const root=path.join(environment.USERPROFILE,'.codex','packages','standalone'),selected=path.join(root,'releases','0.164.0-x86_64-pc-windows-msvc');
  const files=['codex-package.json','bin/codex.exe','bin/codex-code-mode-host.exe','codex-path/rg.exe',
    'codex-resources/codex-command-runner.exe','codex-resources/codex-windows-sandbox-setup.exe'];
  for(const name of files){await fs.mkdir(path.dirname(path.join(selected,name)),{recursive:true});await fs.writeFile(path.join(selected,name),'synthetic non-executable fixture');}
  const visible=path.join(environment.LOCALAPPDATA,'Programs','OpenAI','Codex','bin');
  await fs.mkdir(path.dirname(visible),{recursive:true});await fs.symlink(selected,path.join(root,'current'),'junction');
  await fs.symlink(path.join(root,'current','bin'),visible,'junction');
  assert.equal((await resolveCodexExecutable(environment)).toLowerCase(),(await fs.realpath(path.join(selected,'bin','codex.exe'))).toLowerCase());
  await fs.rm(path.join(selected,'codex-package.json'));
  assert.equal(await resolveCodexExecutable(environment),null,'a copied CLI alone is not a standalone runtime');
  // These are synthetic regular files and actual OS junctions, not a real
  // installed Codex CLI, account, executable launch or business acceptance.
});

const fakeServer = (respond) => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  const requests = [];
  let killed = false;
  child.kill = () => { killed = true; return true; };
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString());
    requests.push(request);
    queueMicrotask(() => respond(request, child.stdout));
  });
  let options;
  let args;
  const spawnProcess = (_executable, passedArgs, passedOptions) => {
    args = passedArgs;
    options = passedOptions;
    return child;
  };
  return { child, requests, spawnProcess, get killed() { return killed; }, get options() { return options; }, get args() { return args; } };
};
const reply = (output, value) => output.write(`${JSON.stringify(value)}\n`);

test("exact App Server metadata read has no inventory, transcript or model calls", async () => {
  const server = fakeServer((request, output) => {
    if (request.id === 1) reply(output, { id: 1, result: {} });
    if (request.id === 2) {
      const bytes = JSON.stringify({ id: 2, result: { thread: { id, name: "  Новый план  " } } });
      output.write(bytes.slice(0, 9));
      output.write(`${bytes.slice(9)}\n`);
    }
  });
  assert.equal(await readCodexConversationTitle(id, { executable: "/exact/codex", spawnProcess: server.spawnProcess,
    environment: { PATH: "/bin", HOME: "/user", TRELIO_TOKEN: "excluded", OPENAI_API_KEY: "excluded", CODEX_THREAD_ID: "stale" } }), "Новый план");
  assert.deepEqual(server.requests.map((request) => request.method), ["initialize", "initialized", "thread/read"]);
  assert.deepEqual(server.requests[2].params, { threadId: id, includeTurns: false });
  assert.deepEqual(server.options.env, { PATH: "/bin", HOME: "/user" });
  assert.deepEqual(server.args, ["app-server", "--listen", "stdio://"]);
  assert.equal(server.options.shell, false);
  assert.equal(server.options.stdio[2], "ignore");
  assert.equal(server.killed, true);
});

for (const [label, response] of [
  ["wrong exact ID", { thread: { id: "22222222-2222-4222-8222-222222222222", name: "Wrong" } }],
  ["missing name", { thread: { id } }],
  ["empty name", { thread: { id, name: "  " } }],
  ["oversized name", { thread: { id, name: "x".repeat(501) } }],
]) {
  test(`metadata read skips ${label} and cleans up`, async () => {
    const server = fakeServer((request, output) => {
      if (request.id === 1) reply(output, { id: 1, result: {} });
      if (request.id === 2) reply(output, { id: 2, result: response });
    });
    assert.equal(await readCodexConversationTitle(id, { executable: "/exact/codex", spawnProcess: server.spawnProcess }), null);
    assert.equal(server.killed, true);
  });
}

test("timeout, malformed and oversized responses close the optional child", async () => {
  for (const output of [null, "not JSON\n", "x".repeat(256 * 1024 + 1)]) {
    const server = fakeServer((_request, stream) => { if (output) stream.write(output); });
    assert.equal(await readCodexConversationTitle(id, { executable: "/exact/codex", spawnProcess: server.spawnProcess, timeoutMs: 10 }), null);
    assert.equal(server.killed, true);
  }
  const controller = new AbortController();
  const server = fakeServer(() => {});
  const pending = readCodexConversationTitle(id, { executable: "/exact/codex", spawnProcess: server.spawnProcess, signal: controller.signal });
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(server.killed, true);
});

test("missing verified locator never starts title discovery", async () => {
  let reads = 0;
  for (const conversation of [null, { ...snapshot, conversationId: "unsupported" }, { ...snapshot, expectedStateHash: null }]) {
    assert.equal(await syncRunCodexConversationTitle({ readConversation: async () => conversation,
      readTitle: async () => { reads++; }, protectTitle: assert.fail, writeTitle: assert.fail }), false);
  }
  assert.equal(reads, 0);
});

test("unchanged title performs no encryption or write; renamed title carries live CAS", async () => {
  let writes = [];
  const options = { readConversation: async () => snapshot,
    readTitle: async (exactId) => { assert.equal(exactId, id); return snapshot.title; },
    protectTitle: async (title) => title,
    writeTitle: async (body) => { writes.push(body); } };
  assert.equal(await syncRunCodexConversationTitle({ ...options, protectTitle: assert.fail }), false);
  assert.deepEqual(writes, []);
  assert.equal(await syncRunCodexConversationTitle({ ...options, readTitle: async () => " Новое название " }), true);
  assert.deepEqual(writes, [{ ...snapshot, title: "Новое название" }]);
});

test("optional denied/old route/CAS/write errors preserve work without replay", async () => {
  let attempts = 0;
  const options = { readConversation: async () => snapshot, readTitle: async () => "Renamed",
    protectTitle: async (title) => title, writeTitle: async () => { attempts++; throw new Error("Ambiguous write"); } };
  assert.equal(await syncRunCodexConversationTitle(options), false);
  assert.equal(attempts, 1);
  for (const stage of ["readConversation", "readTitle", "protectTitle"]) {
    assert.equal(await syncRunCodexConversationTitle({ ...options, [stage]: async () => { throw new Error("Unavailable"); } }), false);
  }
  assert.equal(attempts, 1);
});

test("encrypted renamed title reaches the writer only as existing field-bound ciphertext", async () => {
  const device = await createAgentEncryptionDevice();
  const companyEncryption = { runtime: { company: { id, slug: "acme" },
    scope: { id: "22222222-2222-4222-8222-222222222222", epoch: 1, publicEncryptionJwk: device.publicEncryptionJwk },
    device: { id: "33333333-3333-4333-8333-333333333333" } }, device };
  const title = "Confidential new title";
  let protectedRequest;
  assert.equal(await syncRunCodexConversationTitle({ readConversation: async () => snapshot,
    readTitle: async () => title, protectTitle: async (value) => {
      protectedRequest = await protectLocalActionArguments({ nativeTool: "sync_codex_conversation_titles",
        arguments: { title: value }, companyEncryption });
      return protectedRequest.value.title;
    }, writeTitle: async (body) => {
      assert.match(body.title, /^~e1:[^:]+:title~$/u);
      assert.equal(JSON.stringify(body).includes(title), false);
      assert.equal(JSON.stringify(protectedRequest.payloads).includes(title), false);
      const payload = protectedRequest.payloads[0];
      assert.equal(payload.entityType, "api.browser_mutation");
      const opened = await decryptCompanyPayload({ encryptedPayload: payload,
        scopePrivateKey: device.privateKeys.encryptionPrivateKey, scopePrivateJwk: device.privateBundle.encryptionPrivateJwk });
      assert.equal(opened.values.title, title);
    } }), true);
});

for (const workspace of [
  { scopeType: "task" },
  { scopeType: "project" },
  { scopeType: "company" },
]) {
  const scopeLabel = workspace.scopeType;

  test(`lifecycle ${scopeLabel} transport retries only GET and carries the exact lease`, async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    let failures = 3;
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), ...options });
      if (!options.method && failures-- > 0) throw new TypeError("fixture transport failure");
      if (options.method === "PUT") return new Response("{}", { status: 503 });
      return Response.json({ conversation: snapshot });
    };
    const metadata = { ...workspace, runId: "22222222-2222-4222-8222-222222222222",
      leaseId: "33333333-3333-4333-8333-333333333333", fencingToken: 7 };
    try {
      await synchronizeRunCodexTitle({ metadata, workspaceOrigin: "https://trelio.example.test", token: "fixture",
        readTitle: async (exactId) => { assert.equal(exactId, id); return "Changed"; } });
      assert.equal(requests.length, 5);
      assert.ok(requests.every((request) => request.url === `https://trelio.example.test/api/agent-workspaces/runs/${metadata.runId}/codex-conversation`));
      assert.deepEqual(JSON.parse(requests[4].body), { conversationId: id, expectedStateHash: snapshot.expectedStateHash,
        title: "Changed", leaseId: metadata.leaseId, fencingToken: metadata.fencingToken });
      requests.length = 0;
      globalThis.fetch = async () => { requests.push({}); return new Response("{}", { status: 404 }); };
      await synchronizeRunCodexTitle({ metadata, workspaceOrigin: "https://trelio.example.test", token: "fixture", readTitle: assert.fail });
      assert.equal(requests.length, 1);
    } finally { globalThis.fetch = originalFetch; }
  });

  test(`lifecycle ${scopeLabel} without a verified conversation never reads a local title or writes`, async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), ...options });
      return Response.json({ conversation: null });
    };
    try {
      await synchronizeRunCodexTitle({ metadata: { ...workspace, runId: id, leaseId: id, fencingToken: 1 },
        workspaceOrigin: "https://trelio.example.test", token: "fixture", readTitle: assert.fail });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, undefined);
      assert.equal(requests[0].url, `https://trelio.example.test/api/agent-workspaces/runs/${id}/codex-conversation`);
    } finally { globalThis.fetch = originalFetch; }
  });

  test(`lifecycle ${scopeLabel} E2EE uploads a signed title payload before sending only its marker`, async () => {
    const originalFetch = globalThis.fetch;
    const device = await createAgentEncryptionDevice();
    const companyEncryption = { runtime: { company: { id, slug: "acme" },
      scope: { id: "22222222-2222-4222-8222-222222222222", epoch: 1, publicEncryptionJwk: device.publicEncryptionJwk },
      device: { id: "33333333-3333-4333-8333-333333333333" } }, device };
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), ...options });
      return options.method ? Response.json({ syncedCount: 1 }) : Response.json({ conversation: { ...snapshot, title: null } });
    };
    try {
      await synchronizeRunCodexTitle({ metadata: { ...workspace, runId: id, leaseId: id, fencingToken: 1 },
        workspaceOrigin: "https://e2ee.trelio.ru", token: "fixture", companyEncryption, readTitle: async () => "Private new title" });
      assert.equal(requests.length, 3);
      assert.equal(requests[1].url, "https://e2ee.trelio.ru/api/agent-workspaces/encryption/payloads");
      assert.equal(requests[2].method, "PUT");
      const payload = JSON.parse(requests[1].body).payloads[0];
      assert.equal(payload.entityType, "api.browser_mutation");
      assert.ok(payload.signature);
      assert.equal(JSON.parse(requests[2].body).title, `~e1:${payload.entityId}:title~`);
      assert.ok(requests.every((request) => !request.body?.includes("Private new title")));
    } finally { globalThis.fetch = originalFetch; }
  });
}
